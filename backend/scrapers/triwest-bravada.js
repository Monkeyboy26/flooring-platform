import {
  launchBrowser, delay, upsertMediaAsset, upsertSkuAttribute,
  appendLog, addJobError, preferProductShot, filterImageUrls,
  extractLargeImages, collectSiteWideImages,
  extractSpecPDFs, normalizeTriwestName
} from './base.js';

const BASE_URL = 'https://www.bravadahardwood.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_ERRORS = 30;
const BATCH_SIZE = 15;

/**
 * Bravada enrichment scraper for Tri-West.
 *
 * Scrapes bravadahardwood.com for product images, descriptions, and specs.
 * Enriches EXISTING Tri-West SKUs — never creates new products.
 * Tech: Squarespace
 *
 * Runs AFTER import-triwest-832.cjs populates SKUs in the DB.
 */
export async function run(pool, job, source) {
  const config = source.config || {};
  const delayMs = config.delay_ms || 2000;
  const vendor_id = source.vendor_id;
  const brandPrefix = 'Bravada';

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
          continue;
        }

        // Update description if we found one and DB is empty
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

        // Upsert specs as SKU attributes
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
 * Find a product on bravadahardwood.com and extract images/specs.
 * Returns { images: string[], description: string, specs: object, specPdfs: array } or null.
 *
 * Bravada is a Squarespace site with a JSON API at /store?format=json.
 * Product URLs: /store/{slug} (e.g., /store/cayenne-bcew001)
 * Images: images.squarespace-cdn.com with ?format=1500w sizing
 * Specs in excerpt HTML: <strong>LABEL</strong> Value<br>
 * Only ~14 products total — small catalog.
 */
async function findProductOnSite(page, productGroup, delayMs, siteWideImages) {
  const rawColorName = productGroup.name;
  const colorName = normalizeTriwestName(rawColorName).toLowerCase();
  const rawCollection = productGroup.collection.replace(/^Bravada\s*/i, '').trim();
  const collectionName = normalizeTriwestName(rawCollection).toLowerCase();
  const firstSku = productGroup.skus[0] || {};
  const vendorSku = (firstSku.vendor_sku || '').toLowerCase();

  try {
    // Navigate to the product store page and search for our product
    await page.goto(`${BASE_URL}/store?format=json`, {
      waitUntil: 'networkidle2',
      timeout: 15000,
    });
    await delay(delayMs);

    // Parse the JSON response from the Squarespace API
    const jsonText = await page.evaluate(() => document.body?.innerText || '');
    let storeData;
    try {
      storeData = JSON.parse(jsonText);
    } catch {
      // If JSON parse fails, try the HTML product page approach
      return await findProductViaHtml(page, productGroup, delayMs, siteWideImages);
    }

    if (!storeData?.items?.length) return await findProductViaHtml(page, productGroup, delayMs, siteWideImages);

    // Find matching product by SKU code, color name, or collection name
    const match = storeData.items.find(item => {
      const title = (item.title || '').toLowerCase();
      const urlId = (item.urlId || '').toLowerCase();
      if (vendorSku && (title.includes(vendorSku) || urlId.includes(vendorSku))) return true;
      if (colorName && title.includes(colorName)) return true;
      if (collectionName && title.includes(collectionName)) return true;
      return false;
    });

    if (!match) return await findProductViaHtml(page, productGroup, delayMs, siteWideImages);

    // Navigate to the matched product page to extract spec PDFs
    let pdfs = [];
    if (match.fullUrl || match.urlId) {
      try {
        const productUrl = match.fullUrl || `${BASE_URL}/store/${match.urlId}`;
        await page.goto(productUrl, { waitUntil: 'networkidle2', timeout: 15000 });
        await delay(delayMs);
        pdfs = await extractSpecPDFs(page);
      } catch { /* spec PDFs are optional */ }
    }

    // Extract images from the Squarespace item
    const images = [];
    if (match.items) {
      for (const img of match.items) {
        if (img.assetUrl) {
          images.push(img.assetUrl + '?format=1500w');
        }
      }
    }

    // Parse specs from the excerpt HTML (format: <strong>LABEL</strong> Value<br>)
    const specs = {};
    const excerpt = match.excerpt || '';
    const specMatches = excerpt.matchAll(/<strong>([^<]+)<\/strong>\s*([^<]+)/gi);
    for (const m of specMatches) {
      const label = m[1].trim().toLowerCase();
      const value = m[2].trim();
      if (!value) continue;
      if (label.includes('size')) specs.thickness = value;
      if (label.includes('species')) specs.material = value;
      if (label.includes('finish')) specs.finish = value;
      if (label.includes('grade')) specs.grade = value;
      if (label.includes('wear layer')) specs.wear_layer = value;
      if (label.includes('sq ft')) specs.sqft_per_carton = value;
    }

    // Build a description from the title and category
    const categories = match.categories || [];
    const description = categories.length > 0
      ? `${match.title} from the ${categories.join(', ')} collection by Bravada Hardwood.`
      : null;

    return {
      images,
      description,
      specs: Object.keys(specs).length > 0 ? specs : null,
      pdfs: pdfs.length > 0 ? pdfs : null,
    };
  } catch {
    return await findProductViaHtml(page, productGroup, delayMs, siteWideImages);
  }
}

/** Fallback: navigate to the store page as HTML and scrape the DOM */
async function findProductViaHtml(page, productGroup, delayMs, siteWideImages) {
  const rawColorName = productGroup.name;
  const colorName = normalizeTriwestName(rawColorName);
  const rawCollection = productGroup.collection.replace(/^Bravada\s*/i, '').trim();
  const collectionName = normalizeTriwestName(rawCollection);
  try {
    await page.goto(`${BASE_URL}/store`, { waitUntil: 'networkidle2', timeout: 15000 });
    await delay(delayMs);

    // Look for a product link matching our color name or collection name
    const productUrl = await page.evaluate((color, collection) => {
      const links = document.querySelectorAll('a[href*="/store/"]');
      // First pass: match on color name
      for (const a of links) {
        if (a.textContent.toLowerCase().includes(color.toLowerCase())) {
          return a.href;
        }
      }
      // Second pass: match on collection name
      if (collection) {
        for (const a of links) {
          if (a.textContent.toLowerCase().includes(collection.toLowerCase())) {
            return a.href;
          }
        }
      }
      return null;
    }, colorName, collectionName);

    if (!productUrl) return null;

    await page.goto(productUrl, { waitUntil: 'networkidle2', timeout: 15000 });
    await delay(delayMs);

    // Extract spec PDFs from the detail page
    const pdfs = await extractSpecPDFs(page);

    // Extract large images using utility (filters site-wide images)
    const largeImgs = await extractLargeImages(page, siteWideImages, 150);
    const utilityImages = largeImgs.map(img => img.src);

    const sqspImages = await page.evaluate(() => {
      const images = [];
      document.querySelectorAll('.ProductItem-gallery img, img[data-image]').forEach(img => {
        const src = img.src || img.dataset?.src || img.dataset?.image;
        if (src && src.includes('squarespace-cdn') && !src.includes('logo')) {
          images.push(src.split('?')[0] + '?format=1500w');
        }
      });
      return images;
    });

    const descEl = await page.$eval('.ProductItem-details-excerpt, .product-excerpt',
      el => el.textContent.trim().slice(0, 2000)
    ).catch(() => null);

    // Merge: utility-extracted first, then Squarespace-specific ones not already present
    const allImageUrls = [...utilityImages];
    for (const url of sqspImages) {
      if (!allImageUrls.some(u => u.split('?')[0] === url.split('?')[0])) {
        allImageUrls.push(url);
      }
    }

    if (allImageUrls.length === 0 && !descEl && pdfs.length === 0) return null;
    return { images: allImageUrls, description: descEl, specs: null, pdfs: pdfs.length > 0 ? pdfs : null };
  } catch {
    return null;
  }
}
