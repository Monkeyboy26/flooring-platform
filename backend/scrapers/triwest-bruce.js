import {
  launchBrowser, delay, upsertMediaAsset, upsertSkuAttribute,
  appendLog, addJobError, preferProductShot, filterImageUrls,
  extractLargeImages, collectSiteWideImages,
  extractSpecPDFs, normalizeTriwestName
} from './base.js';

const BASE_URL = 'https://www.bruce.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_ERRORS = 30;
const BATCH_SIZE = 15;

/**
 * Bruce enrichment scraper for Tri-West.
 *
 * Scrapes bruce.com for product images, descriptions, and specs.
 * Enriches EXISTING Tri-West SKUs — never creates new products.
 * Tech: AEM CMS (AHF Products family)
 *
 * Runs AFTER import-triwest-832.cjs populates SKUs in the DB.
 */
export async function run(pool, job, source) {
  const config = source.config || {};
  const delayMs = config.delay_ms || 2000;
  const vendor_id = source.vendor_id;
  const brandPrefix = 'Bruce';

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

    await appendLog(pool, job.id, `Grouped into ${productGroups.size} products (${skippedExisting} already have images, ${toEnrich.length} to enrich)`);

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

        const firstSku = group.skus[0] || {};
        if (productData.description && !firstSku.description_long) {
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

        // Upsert spec PDFs (extracted inside findProductOnSite)
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
 * Find product on Bruce.com (AEM CMS, AHF Products family).
 * Uses extractLargeImages for filtering + AHF CDN pattern.
 */
async function findProductOnSite(page, group, delayMs, siteWideImages) {
  const sampleSku = group.skus[0] || {};
  const vendorSku = sampleSku?.vendor_sku || '';
  const colorName = group.name;
  const normalizedName = normalizeTriwestName(colorName);
  const searchTerms = [vendorSku, normalizedName, colorName].filter(Boolean);

  let productLink = null;

  for (const searchTerm of searchTerms) {
    try {
      const searchUrl = `${BASE_URL}/en-us/search-results.html?searchTerm=${encodeURIComponent(searchTerm)}`;
      await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 30000 });
      await delay(delayMs);

      // Wait for client-side rendering (AEM/Ractive sites need longer)
      await page.waitForSelector('a[href*="/en-us/products/"]', { timeout: 12000 }).catch(() => null);

      productLink = await page.$eval('a[href*="/en-us/products/"]', el => el.href).catch(() => null);
      if (productLink) break;
    } catch { /* try next search term */ }
  }

  if (!productLink) return null;

  await page.goto(productLink, { waitUntil: 'networkidle2', timeout: 30000 });
  await delay(delayMs);

  // Use extractLargeImages for dimension-filtered results
  const largeImages = await extractLargeImages(page, siteWideImages, 150);

  // Also grab CDN images specifically (may be lazy-loaded)
  const cdnImages = await page.$$eval(
    'img[src*="/cdn/content/sites/2/"]',
    imgs => imgs.map(img => {
      const src = img.src;
      return src.includes('?') ? src.replace(/\?size=\w+/, '?size=detail') : src + '?size=detail';
    })
  ).catch(() => []);

  const allImages = largeImages.map(img => img.src);
  for (const url of [...new Set(cdnImages)]) {
    if (!allImages.some(u => u.split('?')[0] === url.split('?')[0])) allImages.push(url);
  }

  // JSON-LD description
  const description = await page.$eval('script[type="application/ld+json"]', script => {
    try {
      const data = JSON.parse(script.textContent);
      return data.description?.trim().slice(0, 2000) || null;
    } catch { return null; }
  }).catch(() => null) ||
  await page.$eval('.product-description', el => el.textContent.trim().slice(0, 2000)).catch(() => null);

  // Specs from table rows
  const specs = {};
  const rawSpecs = await page.$$eval('table tr', rows => {
    const result = {};
    for (const row of rows) {
      const th = row.querySelector('th');
      const td = row.querySelector('td');
      if (th && td) result[th.textContent.trim().toLowerCase()] = td.textContent.trim();
    }
    return result;
  }).catch(() => ({}));

  if (rawSpecs.thickness) specs.thickness = rawSpecs.thickness;
  if (rawSpecs.width) specs.size = rawSpecs.width;
  if (rawSpecs.surface || rawSpecs.finish) specs.finish = rawSpecs.surface || rawSpecs.finish;
  if (rawSpecs.species) specs.material = rawSpecs.species;
  if (rawSpecs.edge) specs.edge = rawSpecs.edge;
  if (rawSpecs.construction) specs.construction = rawSpecs.construction;
  if (rawSpecs.installation) specs.installation = rawSpecs.installation;
  if (rawSpecs.janka) specs.janka_hardness = rawSpecs.janka;
  if (rawSpecs['wear layer']) specs.wear_layer = rawSpecs['wear layer'];

  // Extract spec PDFs while on the detail page
  const pdfs = await extractSpecPDFs(page).catch(() => []);

  if (allImages.length === 0 && !description && Object.keys(specs).length === 0 && pdfs.length === 0) return null;
  return { images: allImages, description, specs: Object.keys(specs).length > 0 ? specs : null, pdfs: pdfs.length > 0 ? pdfs : null };
}
