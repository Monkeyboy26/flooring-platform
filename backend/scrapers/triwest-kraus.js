import {
  launchBrowser, delay, upsertMediaAsset, upsertSkuAttribute,
  appendLog, addJobError, preferProductShot, filterImageUrls,
  extractLargeImages, collectSiteWideImages,
  extractSpecPDFs, normalizeTriwestName
} from './base.js';

const BASE_URL = 'https://krausflooring.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_ERRORS = 30;
const BATCH_SIZE = 15;

/**
 * Kraus enrichment scraper for Tri-West.
 *
 * Scrapes krausflooring.com for product images, descriptions, and specs.
 * Enriches EXISTING Tri-West SKUs — never creates new products.
 * Tech: WordPress + WooCommerce
 *
 * Runs AFTER import-triwest-832.cjs populates SKUs in the DB.
 */
export async function run(pool, job, source) {
  const config = source.config || {};
  const delayMs = config.delay_ms || 2000;
  const vendor_id = source.vendor_id;
  const brandPrefix = 'Kraus';

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
 * Find product on Krausflooring.com and extract images, description, specs.
 * Kraus uses WordPress + WooCommerce with BeRocket filtering.
 *
 * Strategy:
 * 1. Build WooCommerce product URL: /product/{slug}/
 * 2. If 404, fallback to WooCommerce search: /?s={term}&post_type=product
 * 3. Extract:
 *    - Images from .woocommerce-product-gallery
 *    - Description from .woocommerce-product-details__short-description or .product-description
 *    - Specs from WooCommerce additional information table
 */
async function findProductOnSite(page, group, delayMs, siteWideImages) {
  const normalized = normalizeTriwestName(group.name);
  const productSlug = normalized
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  // Also try collection-based slug
  const collectionSlug = group.collection
    .replace(/^Kraus\s+/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  // Try direct product URLs
  const slugsToTry = [...new Set([productSlug, collectionSlug])];
  let foundPage = false;

  for (const slug of slugsToTry) {
    const productUrl = `${BASE_URL}/product/${slug}/`;
    try {
      const response = await page.goto(productUrl, { waitUntil: 'networkidle2', timeout: 20000 });
      if (response && response.status() === 200) {
        foundPage = true;
        await delay(delayMs);
        break;
      }
    } catch {
      continue;
    }
  }

  // Fallback to WooCommerce product search
  if (!foundPage) {
    const searchTerms = [normalized, group.collection.replace(/^Kraus\s+/i, '')];
    for (const searchTerm of searchTerms) {
      const searchUrl = `${BASE_URL}/?s=${encodeURIComponent(searchTerm)}&post_type=product`;
      try {
        await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 20000 });
        await delay(delayMs);

        const firstProduct = await page.$('.woocommerce-loop-product__link, .product a, a[href*="/product/"]');
        if (firstProduct) {
          await Promise.all([
            page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }),
            firstProduct.click()
          ]);
          await delay(delayMs);
          foundPage = true;
          break;
        }
      } catch {
        continue;
      }
    }
  }

  if (!foundPage) return null;

  const productData = { images: [], specs: {} };

  // Extract images using extractLargeImages + WooCommerce gallery
  const largeImgs = await extractLargeImages(page, siteWideImages, 150);
  const utilityImages = largeImgs.map(img => img.src);

  const galleryImages = await page.$$eval(
    '.woocommerce-product-gallery img, .product-images img, img[src*="/wp-content/uploads/"]',
    imgs => imgs
      .map(img => img.src || img.getAttribute('data-large_image'))
      .filter(src => src && !src.includes('logo') && !src.includes('icon') && !src.includes('placeholder'))
  ).catch(() => []);

  productData.images = [...new Set([...utilityImages, ...galleryImages])];

  // Extract description
  const description = await page.$eval(
    '.woocommerce-product-details__short-description, .product-description, .entry-content > p:first-of-type',
    el => el.textContent.trim()
  ).catch(() => null);

  if (description) {
    productData.description = description;
  }

  // Extract spec PDFs
  const specPdfs = await extractSpecPDFs(page).catch(() => []);
  productData.pdfs = specPdfs;

  // Extract specs from WooCommerce additional information table
  const specs = await page.$$eval(
    '.woocommerce-product-attributes tr, table.shop_attributes tr',
    rows => {
      const result = {};
      for (const row of rows) {
        const th = row.querySelector('th');
        const td = row.querySelector('td');
        if (th && td) {
          const key = th.textContent.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_');
          const value = td.textContent.trim();
          result[key] = value;
        }
      }
      return result;
    }
  ).catch(() => {});

  // Map WooCommerce specs to attribute slugs (use underscores)
  if (specs) {
    if (specs.thickness) productData.specs['thickness'] = specs.thickness;
    if (specs.width) productData.specs['width'] = specs.width;
    if (specs.length) productData.specs['length'] = specs.length;
    if (specs.wear_layer) productData.specs['wear_layer'] = specs.wear_layer;
    if (specs.surface || specs.finish) productData.specs['finish'] = specs.surface || specs.finish;
    if (specs.species) productData.specs['species'] = specs.species;
    if (specs.edge || specs.edge_profile) productData.specs['edge_profile'] = specs.edge || specs.edge_profile;
    if (specs.construction) productData.specs['construction'] = specs.construction;
    if (specs.installation || specs.installation_method) {
      productData.specs['installation_method'] = specs.installation || specs.installation_method;
    }
    if (specs.core_type) productData.specs['core_type'] = specs.core_type;
  }

  return productData.images.length > 0 || productData.description || Object.keys(productData.specs).length > 0 || productData.pdfs?.length > 0
    ? productData
    : null;
}
