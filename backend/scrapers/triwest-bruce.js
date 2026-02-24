import {
  launchBrowser, delay, upsertMediaAsset, upsertSkuAttribute,
  appendLog, addJobError, downloadImage, resolveImageExtension, preferProductShot
} from './base.js';

const BASE_URL = 'https://www.bruce.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_ERRORS = 30;

/**
 * Bruce enrichment scraper for Tri-West.
 *
 * Scrapes bruce.com for product images, descriptions, and specs.
 * Enriches EXISTING Tri-West SKUs — never creates new products.
 * Tech: AEM CMS (AHF Products family)
 *
 * Runs AFTER triwest-catalog.js populates SKUs in the DB.
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
 * Find product on Bruce.com and extract images, description, specs.
 * Bruce uses AEM CMS (AHF Products family) with JSON-LD schema.org data.
 *
 * Strategy:
 * 1. Search by vendor SKU first using /en-us/search-results.html?searchTerm={sku}
 * 2. If no results, search by color name
 * 3. Navigate to product detail page (/en-us/products/{category}/{collection}/{sku}.html)
 * 4. Extract:
 *    - Images from img[src*="/cdn/content/sites/2/"] with ?size=detail
 *    - Description from JSON-LD schema.org Product data or .product-description
 *    - Specs from table rows with th/td pairs
 */
async function findProductOnSite(page, group, delayMs) {
  const sampleSku = group.skus[0];
  let searchTerm = sampleSku.vendor_sku || sampleSku.variant_name || group.name;

  // Try searching by vendor SKU first
  const searchUrl = `${BASE_URL}/en-us/search-results.html?searchTerm=${encodeURIComponent(searchTerm)}`;
  await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 30000 });
  await delay(delayMs);

  // Look for product links in search results
  let productLink = await page.$eval(
    'a[href*="/en-us/products/"]',
    el => el.href
  ).catch(() => null);

  // If no results, try searching by color/product name
  if (!productLink) {
    searchTerm = sampleSku.variant_name || group.name;
    const fallbackUrl = `${BASE_URL}/en-us/search-results.html?searchTerm=${encodeURIComponent(searchTerm)}`;
    await page.goto(fallbackUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    await delay(delayMs);

    productLink = await page.$eval(
      'a[href*="/en-us/products/"]',
      el => el.href
    ).catch(() => null);
  }

  if (!productLink) {
    return null;
  }

  // Navigate to product detail page
  await page.goto(productLink, { waitUntil: 'networkidle2', timeout: 30000 });
  await delay(delayMs);

  const productData = { images: [], specs: {} };

  // Extract images from CDN
  const images = await page.$$eval(
    'img[src*="/cdn/content/sites/2/"]',
    imgs => imgs.map(img => {
      const src = img.src;
      // Ensure high-res version with ?size=detail
      if (src.includes('?')) {
        return src.replace(/\?.*$/, '?size=detail');
      }
      return src + '?size=detail';
    })
  ).catch(() => []);

  productData.images = [...new Set(images)]; // Remove duplicates

  // Extract description from JSON-LD schema.org
  const jsonLdDescription = await page.$eval(
    'script[type="application/ld+json"]',
    script => {
      try {
        const data = JSON.parse(script.textContent);
        return data.description || null;
      } catch {
        return null;
      }
    }
  ).catch(() => null);

  if (jsonLdDescription) {
    productData.description = jsonLdDescription;
  } else {
    // Fallback to .product-description selector
    productData.description = await page.$eval(
      '.product-description',
      el => el.textContent.trim()
    ).catch(() => null);
  }

  // Extract specs from table rows with th/td pairs
  const specs = await page.$$eval(
    'table tr',
    rows => {
      const result = {};
      for (const row of rows) {
        const th = row.querySelector('th');
        const td = row.querySelector('td');
        if (th && td) {
          const key = th.textContent.trim().toLowerCase();
          const value = td.textContent.trim();
          result[key] = value;
        }
      }
      return result;
    }
  ).catch(() => {});

  // Map specs to attribute slugs
  if (specs) {
    if (specs.thickness) productData.specs['thickness'] = specs.thickness;
    if (specs.width) productData.specs['width'] = specs.width;
    if (specs.surface || specs.finish) productData.specs['surface-finish'] = specs.surface || specs.finish;
    if (specs.species) productData.specs['species'] = specs.species;
    if (specs.edge) productData.specs['edge-profile'] = specs.edge;
    if (specs.construction) productData.specs['construction'] = specs.construction;
    if (specs.installation) productData.specs['installation-method'] = specs.installation;
    if (specs.janka) productData.specs['janka-rating'] = specs.janka;
  }

  return productData.images.length > 0 || productData.description || Object.keys(productData.specs).length > 0
    ? productData
    : null;
}
