import {
  launchBrowser, delay, upsertMediaAsset, upsertSkuAttribute,
  appendLog, addJobError, preferProductShot, filterImageUrls,
  extractLargeImages, collectSiteWideImages,
  extractSpecPDFs, normalizeTriwestName
} from './base.js';

const BASE_URL = 'https://www.congoleum.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_ERRORS = 30;
const BATCH_SIZE = 15;

/**
 * Congoleum enrichment scraper for Tri-West.
 *
 * Scrapes congoleum.com for product images, descriptions, and specs.
 * Enriches EXISTING Tri-West SKUs — never creates new products.
 * Tech: WordPress
 *
 * Runs AFTER import-triwest-832.cjs populates SKUs in the DB.
 */
export async function run(pool, job, source) {
  const config = source.config || {};
  const delayMs = config.delay_ms || 2000;
  const vendor_id = source.vendor_id;
  const brandPrefix = 'Congoleum';

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

    // Check which products already have a primary image — skip those
    const existingImages = await pool.query(`
      SELECT DISTINCT ma.product_id
      FROM media_assets ma
      JOIN products p ON p.id = ma.product_id
      WHERE p.vendor_id = $1 AND ma.asset_type = 'primary'
    `, [vendor_id]);
    const alreadyHaveImages = new Set(existingImages.rows.map(r => r.product_id));

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

    // Filter to products that still need enrichment
    const toEnrich = [...productGroups.entries()].filter(([, g]) => !alreadyHaveImages.has(g.product_id));
    const skippedExisting = productGroups.size - toEnrich.length;

    await appendLog(pool, job.id, `Grouped into ${productGroups.size} products (${skippedExisting} already have images, ${toEnrich.length} to enrich, ${skuResult.rows.length} with SKUs)`);

    browser = await launchBrowser();
    let page = await browser.newPage();
    await page.setUserAgent(USER_AGENT);
    await page.setViewport({ width: 1440, height: 900 });

    // Collect site-wide images to exclude
    await appendLog(pool, job.id, `Collecting site-wide images from ${BASE_URL}...`);
    const siteWideImages = await collectSiteWideImages(page, BASE_URL);
    await appendLog(pool, job.id, `Found ${siteWideImages.size} site-wide images to exclude`);
    pagesSinceLaunch++;

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
          continue;
        }

        if (productData.description && !group.skus[0]?.description_long) {
          await pool.query(
            'UPDATE products SET description_long = $1 WHERE id = $2 AND description_long IS NULL',
            [productData.description, group.product_id]
          );
        }

        // Filter junk, deduplicate, then sort product shots first
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

        if (productData.specs && group.skus.length > 0) {
          for (const sku of group.skus) {
            for (const [attrSlug, value] of Object.entries(productData.specs)) {
              if (value) await upsertSkuAttribute(pool, sku.sku_id, attrSlug, value);
            }
            skusEnriched++;
          }
        } else {
          skusEnriched += group.skus.length;
        }
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
 * Find product on Congoleum.com and extract images, description, specs.
 * Congoleum uses WordPress with product pages at /{product-type}/{collection-name}/.
 *
 * Strategy:
 * 1. Build URL from collection slug: /{product-type}/{collection-slug}/
 * 2. If 404, fallback to WordPress search: /?s={term}
 * 3. Extract:
 *    - Images from /wp-content/uploads/ in content area
 *    - Description from page text/content
 *    - Specs from text content (thickness, width, wear layer)
 *    - PDFs from page links
 */
async function findProductOnSite(page, group, delayMs, siteWideImages) {
  const normalized = normalizeTriwestName(group.collection.replace(/^Congoleum\s+/i, ''));
  const collectionSlug = normalized
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  // Try common product type paths
  const productTypes = ['sheet-vinyl', 'luxury-vinyl', 'resilient-flooring', 'vinyl-flooring', 'lvt', 'vinyl-plank', 'vinyl-tile'];
  let foundPage = false;

  for (const type of productTypes) {
    const guessUrl = `${BASE_URL}/${type}/${collectionSlug}/`;
    try {
      const response = await page.goto(guessUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
      if (response && response.status() === 200) {
        foundPage = true;
        await delay(delayMs);
        break;
      }
    } catch {
      continue;
    }
  }

  // Fallback to WordPress search
  if (!foundPage) {
    const searchTerm = normalized;
    const searchUrl = `${BASE_URL}/?s=${encodeURIComponent(searchTerm)}`;
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await delay(delayMs);

    // Click first meaningful search result (skip self-links, nav items)
    const firstLink = await page.$('.entry-title a, .search-results a, article a, .post a');
    if (!firstLink) {
      return null;
    }

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }),
      firstLink.click()
    ]);
    await delay(delayMs);
  }

  // Extract images using extractLargeImages for better filtering
  const largeImgs = await extractLargeImages(page, siteWideImages, 150);
  const utilityImages = largeImgs.map(img => img.src);

  // Also grab WordPress upload images
  const wpImages = await page.$$eval(
    'img[src*="/wp-content/uploads/"]',
    imgs => imgs
      .map(img => img.src)
      .filter(src => !src.includes('logo') && !src.includes('icon'))
  ).catch(() => []);

  // Merge: utility-extracted first, then WP-specific ones not already present
  const allImageUrls = [...utilityImages];
  for (const url of wpImages) {
    if (!allImageUrls.some(u => u.split('?')[0] === url.split('?')[0])) {
      allImageUrls.push(url);
    }
  }

  // Extract description from main content area
  const description = await page.$eval(
    '.entry-content, .product-description, article .content, main',
    el => {
      const paragraphs = el.querySelectorAll('p');
      for (const p of paragraphs) {
        const text = p.textContent.trim();
        if (text.length > 50) {
          return text.slice(0, 2000);
        }
      }
      return null;
    }
  ).catch(() => null);

  // Extract spec PDFs
  const pdfs = await extractSpecPDFs(page).catch(() => []);

  // Extract specs from page text
  const specs = {};
  const pageText = await page.$eval('body', el => el.textContent).catch(() => '');

  const thicknessMatch = pageText.match(/thickness[:\s]+([0-9.]+\s*(?:mm|mil))/i);
  const widthMatch = pageText.match(/width[:\s]+([0-9.]+\s*(?:in|ft|"|'))/i);
  const wearLayerMatch = pageText.match(/wear\s+layer[:\s]+([0-9.]+\s*mil)/i);

  if (thicknessMatch) specs.thickness = thicknessMatch[1];
  if (widthMatch) specs.size = widthMatch[1];
  if (wearLayerMatch) specs.wear_layer = wearLayerMatch[1];

  if (allImageUrls.length === 0 && !description && Object.keys(specs).length === 0 && pdfs.length === 0) return null;
  return {
    images: allImageUrls,
    description,
    specs: Object.keys(specs).length > 0 ? specs : null,
    pdfs: pdfs.length > 0 ? pdfs : null,
  };
}
