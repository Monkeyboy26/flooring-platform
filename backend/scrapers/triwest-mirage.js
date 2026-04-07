import {
  launchBrowser, delay, upsertMediaAsset, upsertSkuAttribute,
  appendLog, addJobError, preferProductShot, filterImageUrls,
  extractLargeImages, collectSiteWideImages,
  extractSpecPDFs, normalizeTriwestName
} from './base.js';

const BASE_URL = 'https://www.miragefloors.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_ERRORS = 30;
const BATCH_SIZE = 15;

/**
 * Mirage enrichment scraper for Tri-West.
 *
 * Scrapes miragefloors.com for product images, descriptions, and specs.
 * Enriches EXISTING Tri-West SKUs — never creates new products.
 * Tech: Vue.js / Custom, WebP images
 *
 * Runs AFTER import-triwest-832.cjs populates SKUs in the DB.
 */
export async function run(pool, job, source) {
  const config = source.config || {};
  const delayMs = config.delay_ms || 2000;
  const vendor_id = source.vendor_id;
  const brandPrefix = 'Mirage';

  let browser = null;
  let errorCount = 0;
  let skusEnriched = 0;
  let skusSkipped = 0;
  let imagesAdded = 0;
  let pdfsAdded = 0;
  let pagesSinceLaunch = 0;

  async function logError(msg) {
    errorCount++;
    if (errorCount <= MAX_ERRORS) {
      try { await addJobError(pool, job.id, msg); } catch { }
    }
  }

  try {
    // Load existing TW products for this brand (includes SKU-less products from DNav)
    const prodResult = await pool.query(`
      SELECT p.id AS product_id, p.name, p.collection, p.description_long
      FROM products p
      WHERE p.vendor_id = $1 AND p.collection LIKE $2
    `, [vendor_id, `${brandPrefix}%`]);

    // Also load SKU data for products that have it
    const skuResult = await pool.query(`
      SELECT s.id AS sku_id, s.vendor_sku, s.internal_sku, s.variant_name, s.product_id
      FROM skus s
      JOIN products p ON p.id = s.product_id
      WHERE p.vendor_id = $1 AND p.collection LIKE $2
    `, [vendor_id, `${brandPrefix}%`]);

    await appendLog(pool, job.id, `Found ${prodResult.rows.length} ${brandPrefix} products (${skuResult.rows.length} SKUs) to enrich`);

    if (prodResult.rows.length === 0) {
      await appendLog(pool, job.id, `No ${brandPrefix} products found — run import-triwest-832 first`);
      return;
    }

    // Build SKU lookup by product_id
    const skusByProduct = new Map();
    for (const row of skuResult.rows) {
      if (!skusByProduct.has(row.product_id)) skusByProduct.set(row.product_id, []);
      skusByProduct.get(row.product_id).push(row);
    }

    // Group products by collection + name
    const productGroups = new Map();
    for (const row of prodResult.rows) {
      const key = `${row.collection}||${row.name}`;
      if (!productGroups.has(key)) {
        productGroups.set(key, {
          product_id: row.product_id, name: row.name, collection: row.collection,
          skus: skusByProduct.get(row.product_id) || [],
        });
      }
    }

    // Check which products already have a primary image — skip those
    const existingImages = await pool.query(`
      SELECT DISTINCT ma.product_id
      FROM media_assets ma
      JOIN products p ON p.id = ma.product_id
      WHERE p.vendor_id = $1 AND ma.asset_type = 'primary'
    `, [vendor_id]);
    const alreadyHaveImages = new Set(existingImages.rows.map(r => r.product_id));

    // Filter to products that still need enrichment
    const toEnrich = [...productGroups.entries()].filter(([, g]) => !alreadyHaveImages.has(g.product_id));
    const skippedExisting = productGroups.size - toEnrich.length;

    await appendLog(pool, job.id, `Grouped into ${productGroups.size} products (${skippedExisting} already have images, ${toEnrich.length} to enrich)`);

    // Launch browser
    browser = await launchBrowser();
    let page = await browser.newPage();
    await page.setUserAgent(USER_AGENT);
    await page.setViewport({ width: 1440, height: 900 });

    // Collect site-wide images to exclude
    await appendLog(pool, job.id, `Collecting site-wide images from ${BASE_URL}...`);
    const siteWideImages = await collectSiteWideImages(page, BASE_URL);
    await appendLog(pool, job.id, `Found ${siteWideImages.size} site-wide images to exclude`);
    pagesSinceLaunch++;

    // Scrape product pages and enrich
    let processed = 0;
    for (const [key, group] of toEnrich) {
      processed++;

      // Recycle browser periodically to avoid memory leaks
      if (pagesSinceLaunch >= BATCH_SIZE) {
        await appendLog(pool, job.id, `Recycling browser after ${BATCH_SIZE} pages...`);
        try { await page.close(); } catch { }
        try { await browser.close(); } catch { }
        await delay(5000);
        browser = await launchBrowser();
        page = await browser.newPage();
        await page.setUserAgent(USER_AGENT);
        await page.setViewport({ width: 1440, height: 900 });
        pagesSinceLaunch = 0;
      }

      try {
        const productData = await findProductOnSite(page, group, delayMs, siteWideImages);
        pagesSinceLaunch++;

        if (!productData) {
          skusSkipped++;
          if (processed % 50 === 0) {
            await appendLog(pool, job.id, `Progress: ${processed}/${toEnrich.length} products, ${imagesAdded} images, ${pdfsAdded} PDFs (${skusSkipped} unmatched)`);
          }
          continue;
        }

        // Update description if we found one and DB is empty
        if (productData.description && !group.skus[0]?.description_long) {
          await pool.query(
            'UPDATE products SET description_long = $1 WHERE id = $2 AND description_long IS NULL',
            [productData.description, group.product_id]
          );
        }

        if (productData.images && productData.images.length > 0) {
          const filtered = filterImageUrls(productData.images, { maxImages: 8 });
          const sorted = preferProductShot(filtered, group.name);
          for (let i = 0; i < sorted.length; i++) {
            const urlLower = sorted[i].toLowerCase();
            const isLifestyle = urlLower.includes('room') || urlLower.includes('scene')
              || urlLower.includes('lifestyle') || urlLower.includes('installed');
            const assetType = i === 0 ? 'primary'
              : (isLifestyle || i > 2) ? 'lifestyle'
              : 'alternate';
            await upsertMediaAsset(pool, {
              product_id: group.product_id,
              sku_id: null,
              asset_type: assetType,
              url: sorted[i],
              original_url: sorted[i],
              sort_order: i,
            });
            imagesAdded++;
          }
        }

        // Upsert spec PDFs
        if (productData.pdfs && productData.pdfs.length > 0) {
          for (let i = 0; i < productData.pdfs.length; i++) {
            await upsertMediaAsset(pool, {
              product_id: group.product_id,
              sku_id: null,
              asset_type: 'spec_pdf',
              url: productData.pdfs[i].url,
              original_url: productData.pdfs[i].url,
              sort_order: i,
            });
            pdfsAdded++;
          }
        }

        // Upsert specs as SKU attributes (if product has SKUs)
        if (productData.specs && group.skus.length > 0) {
          for (const sku of group.skus) {
            for (const [attrSlug, value] of Object.entries(productData.specs)) {
              if (value) await upsertSkuAttribute(pool, sku.sku_id, attrSlug, value);
            }
          }
        }
        skusEnriched++;
      } catch (err) {
        await logError(`${group.collection} / ${group.name}: ${err.message}`);
        skusSkipped++;
      }

      if (processed % 10 === 0) {
        await appendLog(pool, job.id, `Progress: ${processed}/${toEnrich.length} products, ${imagesAdded} images, ${pdfsAdded} PDFs`);
      }
    }

    await appendLog(pool, job.id,
      `Complete. Products: ${toEnrich.length} enriched (${skippedExisting} skipped), SKUs enriched: ${skusEnriched}, Skipped: ${skusSkipped}, Images: ${imagesAdded}, PDFs: ${pdfsAdded}, Errors: ${errorCount}`,
      { products_found: productGroups.size, products_updated: skusEnriched }
    );

  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

/**
 * Find a product on miragefloors.com and extract images/specs.
 *
 * Vue.js site with WebP images from /static/vb/ CDN.
 * Increased SPA wait times (6s+ instead of 2s).
 * Uses extractLargeImages for dimension filtering + site-wide exclusion.
 */
async function findProductOnSite(page, productGroup, delayMs, siteWideImages) {
  const rawColorName = productGroup.name;
  const colorName = normalizeTriwestName(rawColorName);
  const rawCollection = productGroup.collection.replace(/^Mirage\s*/i, '').trim();
  const collection = normalizeTriwestName(rawCollection);

  const colorSlug = colorName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const collectionSlug = collection.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  let loaded = false;

  // Attempt 1: Direct product URL patterns
  const candidateUrls = [
    `${BASE_URL}/en-us/hardwood-flooring-${collectionSlug}-${colorSlug}`,
    `${BASE_URL}/en-us/engineered-hardwood-flooring-${collectionSlug}-${colorSlug}`,
    `${BASE_URL}/en-us/${collectionSlug}-${colorSlug}`,
    `${BASE_URL}/en-us/hardwood-flooring-${colorSlug}`,
    `${BASE_URL}/en-us/${collectionSlug}/${colorSlug}`,
    `${BASE_URL}/en-us/flooring-${colorSlug}`,
  ];

  // Skip products that are clearly accessories/trim (no detail pages on miragefloors.com)
  const skipPatterns = /underlay|quarter|reducer|stairnose|threshold|qtr\s*rnd|sq\s*ns|square\s*sn|nosing|t-?mold/i;
  if (skipPatterns.test(rawColorName) || skipPatterns.test(rawCollection)) return null;

  // Try only the 2 most likely URL patterns (avoid excessive page loads)
  const topUrls = [
    `${BASE_URL}/en-us/hardwood-flooring-${collectionSlug}-${colorSlug}`,
    `${BASE_URL}/en-us/engineered-hardwood-flooring-${collectionSlug}-${colorSlug}`,
  ];

  for (const url of topUrls) {
    try {
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 12000 });
      await delay(Math.max(delayMs, 4000));
      if (response && response.status() === 200 && !page.url().includes('/404') && !page.url().endsWith('/en-us/')) {
        loaded = true;
        break;
      }
    } catch { /* try next */ }
  }

  if (!loaded) return null;

  // Wait for images to fully render
  await page.waitForSelector('img[src*="/static/vb/"], img[src*="miragefloors"], img[src*=".webp"]', { timeout: 8000 }).catch(() => null);
  await delay(2000); // Extra time for lazy-loaded images

  // Extract spec PDFs from the detail page
  const specPdfs = await extractSpecPDFs(page);

  // Use extractLargeImages for filtered results
  const largeImages = await extractLargeImages(page, siteWideImages, 100);

  // Also grab Mirage CDN images + background images
  const mirageImages = await page.evaluate(() => {
    const results = [];
    const seen = new Set();
    document.querySelectorAll('img').forEach(img => {
      const src = img.src || img.dataset?.src || img.dataset?.lazySrc || '';
      if (src && (src.includes('/static/vb/') || src.includes('miragefloors.com')) &&
          !src.includes('logo') && !src.includes('icon') && !src.includes('nav') && !src.includes('flag')) {
        const clean = src.split('?')[0];
        if (!seen.has(clean)) { seen.add(clean); results.push(src); }
      }
    });
    document.querySelectorAll('[style*="/static/vb/"]').forEach(el => {
      const match = el.style.backgroundImage?.match(/url\(['"]?(https?:\/\/[^'")]+)['"]?\)/);
      if (match && !seen.has(match[1].split('?')[0])) {
        seen.add(match[1].split('?')[0]);
        results.push(match[1]);
      }
    });
    return results;
  });

  const allImages = largeImages.map(img => img.src);
  for (const url of mirageImages) {
    if (!allImages.some(u => u.split('?')[0] === url.split('?')[0])) allImages.push(url);
  }

  const extra = await page.evaluate(() => {
    let description = null;
    const descEl = document.querySelector('[class*="description"] p, .product-description, .product-info p, article p');
    if (descEl) description = descEl.textContent.trim().slice(0, 2000);
    if (!description) {
      const meta = document.querySelector('meta[name="description"]');
      if (meta?.content && meta.content.length > 30) description = meta.content.trim().slice(0, 2000);
    }

    const specs = {};
    document.querySelectorAll('tr, li, .spec-row, [class*="spec"]').forEach(el => {
      const text = el.textContent.trim().toLowerCase();
      if (text.includes('thickness') && text.includes('"')) specs.thickness = el.textContent.replace(/.*thickness[:\s]*/i, '').trim();
      if (text.includes('width') && (text.includes('"') || text.includes('mm'))) specs.size = el.textContent.replace(/.*width[:\s]*/i, '').trim();
      if (text.includes('species') || text.includes('wood type')) specs.material = el.textContent.replace(/.*(?:species|wood type)[:\s]*/i, '').trim();
      if (text.includes('finish') && !text.includes('unfinished')) specs.finish = el.textContent.replace(/.*finish[:\s]*/i, '').trim();
      if (text.includes('edge')) specs.edge = el.textContent.replace(/.*edge[:\s]*/i, '').trim();
      if (text.includes('construction')) specs.construction = el.textContent.replace(/.*construction[:\s]*/i, '').trim();
    });
    document.querySelectorAll('table tr').forEach(row => {
      const cells = row.querySelectorAll('td, th');
      if (cells.length >= 2) {
        const label = cells[0].textContent.trim().toLowerCase();
        const value = cells[1].textContent.trim();
        if (label.includes('thickness')) specs.thickness = value;
        if (label.includes('width')) specs.size = value;
        if (label.includes('species')) specs.material = value;
        if (label.includes('finish')) specs.finish = value;
        if (label.includes('grade')) specs.grade = value;
      }
    });

    return { description, specs: Object.keys(specs).length > 0 ? specs : null };
  });

  if (allImages.length === 0 && !extra.description && !extra.specs && specPdfs.length === 0) return null;
  return { images: allImages, ...extra, pdfs: specPdfs };
}
