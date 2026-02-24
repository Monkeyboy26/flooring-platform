import {
  launchBrowser, delay, upsertMediaAsset, upsertSkuAttribute,
  appendLog, addJobError, downloadImage, resolveImageExtension, preferProductShot
} from './base.js';

const BASE_URL = 'https://krausflooring.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_ERRORS = 30;

/**
 * Kraus enrichment scraper for Tri-West.
 *
 * Scrapes krausflooring.com for product images, descriptions, and specs.
 * Enriches EXISTING Tri-West SKUs — never creates new products.
 * Tech: WordPress + WooCommerce
 *
 * Runs AFTER triwest-catalog.js populates SKUs in the DB.
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

  async function logError(msg) {
    errorCount++;
    if (errorCount <= MAX_ERRORS) {
      try { await addJobError(pool, job.id, msg); } catch { }
    }
  }

  try {
    const skuResult = await pool.query(`
      SELECT s.id AS sku_id, s.vendor_sku, s.internal_sku, s.variant_name,
             p.id AS product_id, p.name, p.collection, p.description_long
      FROM skus s
      JOIN products p ON p.id = s.product_id
      WHERE p.vendor_id = $1 AND p.collection LIKE $2
    `, [vendor_id, `${brandPrefix}%`]);

    await appendLog(pool, job.id, `Found ${skuResult.rows.length} ${brandPrefix} SKUs to enrich`);

    if (skuResult.rows.length === 0) {
      await appendLog(pool, job.id, `No ${brandPrefix} SKUs found — run triwest-catalog first`);
      return;
    }

    const productGroups = new Map();
    for (const row of skuResult.rows) {
      const key = `${row.collection}||${row.name}`;
      if (!productGroups.has(key)) {
        productGroups.set(key, { product_id: row.product_id, name: row.name, collection: row.collection, skus: [] });
      }
      productGroups.get(key).skus.push(row);
    }

    await appendLog(pool, job.id, `Grouped into ${productGroups.size} products`);

    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setUserAgent(USER_AGENT);
    await page.setViewport({ width: 1440, height: 900 });

    await appendLog(pool, job.id, `Navigating to ${BASE_URL}...`);
    await page.goto(BASE_URL, { waitUntil: 'networkidle2', timeout: 30000 });
    await delay(2000);

    let processed = 0;
    for (const [key, group] of productGroups) {
      processed++;

      try {
        const productData = await findProductOnSite(page, group, delayMs);

        if (!productData) {
          skusSkipped += group.skus.length;
          continue;
        }

        if (productData.description && !group.skus[0]?.description_long) {
          await pool.query(
            'UPDATE products SET description_long = $1 WHERE id = $2 AND description_long IS NULL',
            [productData.description, group.product_id]
          );
        }

        if (productData.images && productData.images.length > 0) {
          const sorted = preferProductShot(productData.images, group.name);
          for (let i = 0; i < Math.min(sorted.length, 8); i++) {
            const assetType = i === 0 ? 'primary' : (sorted[i].includes('room') || sorted[i].includes('scene') ? 'lifestyle' : 'alternate');
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

        if (productData.specs) {
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
        skusSkipped += group.skus.length;
      }

      if (processed % 10 === 0) {
        await appendLog(pool, job.id, `Progress: ${processed}/${productGroups.size} products, ${imagesAdded} images added`);
      }
    }

    await appendLog(pool, job.id,
      `Complete. Products: ${productGroups.size}, SKUs enriched: ${skusEnriched}, Skipped: ${skusSkipped}, Images: ${imagesAdded}, Errors: ${errorCount}`,
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
async function findProductOnSite(page, group, delayMs) {
  const productSlug = group.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  // Try direct product URL
  const productUrl = `${BASE_URL}/product/${productSlug}/`;
  let foundPage = false;

  try {
    const response = await page.goto(productUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    if (response && response.status() === 200) {
      foundPage = true;
      await delay(delayMs);
    }
  } catch {
    // Will try search fallback
  }

  // Fallback to WooCommerce product search
  if (!foundPage) {
    const searchTerm = group.name;
    const searchUrl = `${BASE_URL}/?s=${encodeURIComponent(searchTerm)}&post_type=product`;
    await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    await delay(delayMs);

    // Click first product result
    const firstProduct = await page.$('.woocommerce-loop-product__link, .product a, a[href*="/product/"]');
    if (!firstProduct) {
      return null;
    }

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }),
      firstProduct.click()
    ]);
    await delay(delayMs);
  }

  const productData = { images: [], specs: {} };

  // Extract images from WooCommerce product gallery
  const galleryImages = await page.$$eval(
    '.woocommerce-product-gallery img, .product-images img, img[src*="/wp-content/uploads/"]',
    imgs => imgs
      .map(img => img.src || img.getAttribute('data-large_image'))
      .filter(src => src && !src.includes('logo') && !src.includes('icon') && !src.includes('placeholder'))
  ).catch(() => []);

  productData.images = [...new Set(galleryImages)]; // Remove duplicates

  // Extract description from WooCommerce short description or product description
  const description = await page.$eval(
    '.woocommerce-product-details__short-description, .product-description, .entry-content > p:first-of-type',
    el => el.textContent.trim()
  ).catch(() => null);

  if (description) {
    productData.description = description;
  }

  // Extract specs from WooCommerce additional information table
  const specs = await page.$$eval(
    '.woocommerce-product-attributes tr, table.shop_attributes tr',
    rows => {
      const result = {};
      for (const row of rows) {
        const th = row.querySelector('th');
        const td = row.querySelector('td');
        if (th && td) {
          const key = th.textContent.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');
          const value = td.textContent.trim();
          result[key] = value;
        }
      }
      return result;
    }
  ).catch(() => {});

  // Map WooCommerce specs to attribute slugs
  if (specs) {
    if (specs.thickness) productData.specs['thickness'] = specs.thickness;
    if (specs.width) productData.specs['width'] = specs.width;
    if (specs.length) productData.specs['length'] = specs.length;
    if (specs['wear-layer']) productData.specs['wear-layer'] = specs['wear-layer'];
    if (specs.surface || specs.finish) productData.specs['surface-finish'] = specs.surface || specs.finish;
    if (specs.species) productData.specs['species'] = specs.species;
    if (specs.edge || specs['edge-profile']) productData.specs['edge-profile'] = specs.edge || specs['edge-profile'];
    if (specs.construction) productData.specs['construction'] = specs.construction;
    if (specs.installation || specs['installation-method']) {
      productData.specs['installation-method'] = specs.installation || specs['installation-method'];
    }
    if (specs['core-type']) productData.specs['core-type'] = specs['core-type'];
  }

  return productData.images.length > 0 || productData.description || Object.keys(productData.specs).length > 0
    ? productData
    : null;
}
