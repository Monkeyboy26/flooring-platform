import {
  launchBrowser, delay, upsertMediaAsset, upsertSkuAttribute,
  appendLog, addJobError, downloadImage, resolveImageExtension, preferProductShot
} from './base.js';

const BASE_URL = 'https://www.citywidelvt.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_ERRORS = 30;

/**
 * Citywide LVT enrichment scraper for Tri-West.
 *
 * Scrapes citywidelvt.com for product images, descriptions, and specs.
 * Enriches EXISTING Tri-West SKUs — never creates new products.
 * Tech: Squarespace Commerce
 *
 * Runs AFTER triwest-catalog.js populates SKUs in the DB.
 */
export async function run(pool, job, source) {
  const config = source.config || {};
  const delayMs = config.delay_ms || 2000;
  const vendor_id = source.vendor_id;
  const brandPrefix = 'Citywide';

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
    // Load existing TW SKUs for this brand
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

    // Group SKUs by product (collection + name)
    const productGroups = new Map();
    for (const row of skuResult.rows) {
      const key = `${row.collection}||${row.name}`;
      if (!productGroups.has(key)) {
        productGroups.set(key, { product_id: row.product_id, name: row.name, collection: row.collection, skus: [] });
      }
      productGroups.get(key).skus.push(row);
    }

    await appendLog(pool, job.id, `Grouped into ${productGroups.size} products`);

    // Launch browser
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setUserAgent(USER_AGENT);
    await page.setViewport({ width: 1440, height: 900 });

    // Navigate to brand website
    await appendLog(pool, job.id, `Navigating to ${BASE_URL}...`);
    await page.goto(BASE_URL, { waitUntil: 'networkidle2', timeout: 30000 });
    await delay(2000);

    // Scrape product pages and enrich
    let processed = 0;
    for (const [key, group] of productGroups) {
      processed++;

      try {
        const productData = await findProductOnSite(page, group, delayMs);

        if (!productData) {
          skusSkipped += group.skus.length;
          continue;
        }

        // Update description if we found one and DB is empty
        if (productData.description && !group.skus[0]?.description_long) {
          await pool.query(
            'UPDATE products SET description_long = $1 WHERE id = $2 AND description_long IS NULL',
            [productData.description, group.product_id]
          );
        }

        // Upsert images (product-level)
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

        // Upsert specs as SKU attributes
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
 * Find a product on citywidelvt.com and extract images/specs.
 * Returns { images: string[], description: string, specs: object } or null.
 *
 * Citywide is a Squarespace Commerce site.
 * Product URLs: /citywide-products/{name-slug}-{code} (e.g., /citywide-products/wilshireboulevard-cw12001)
 * Pad variants: /citywide-pad/{name-slug}-{code}pad
 * Images: images.squarespace-cdn.com
 * Specs from description text: Dimensions, Gauge, Wear Layer, Finish, Coverage, etc.
 */
async function findProductOnSite(page, productGroup, delayMs) {
  const colorName = productGroup.name;
  const firstSku = productGroup.skus[0];
  const vendorSku = (firstSku.vendor_sku || '').toLowerCase();

  try {
    // Try Squarespace Commerce JSON endpoint first
    const jsonData = await trySquarespaceJson(page, productGroup, delayMs);
    if (jsonData) return jsonData;

    // Build slug: remove spaces, lowercase. E.g., "Wilshire Boulevard" → "wilshireboulevard"
    const nameSlug = colorName.toLowerCase().replace(/[^a-z0-9]+/g, '');
    // Extract code from vendor SKU (e.g., "CW12001")
    const code = vendorSku.replace(/[^a-z0-9]/g, '');

    // Try direct product URL with code
    const productUrl = code
      ? `${BASE_URL}/citywide-products/${nameSlug}-${code}`
      : `${BASE_URL}/citywide-products/${nameSlug}`;

    await page.goto(productUrl, { waitUntil: 'networkidle2', timeout: 15000 });
    await delay(delayMs);

    const is404 = await page.evaluate(() => {
      return document.title.includes('Page Not Found') || document.querySelector('.sqs-error-page') !== null;
    });

    if (is404) {
      return await findProductViaBrowse(page, productGroup, delayMs);
    }

    return await extractCitywideData(page, colorName);
  } catch {
    return await findProductViaBrowse(page, productGroup, delayMs);
  }
}

/** Try Squarespace Commerce JSON API */
async function trySquarespaceJson(page, productGroup, delayMs) {
  const colorName = productGroup.name.toLowerCase();
  const vendorSku = (productGroup.skus[0].vendor_sku || '').toLowerCase();

  try {
    await page.goto(`${BASE_URL}/citywide-products?format=json`, {
      waitUntil: 'networkidle2',
      timeout: 15000,
    });
    await delay(delayMs);

    const jsonText = await page.evaluate(() => document.body?.innerText || '');
    let data;
    try { data = JSON.parse(jsonText); } catch { return null; }

    if (!data?.items?.length) return null;

    const match = data.items.find(item => {
      const title = (item.title || '').toLowerCase();
      const urlId = (item.urlId || '').toLowerCase();
      if (vendorSku && (title.includes(vendorSku) || urlId.includes(vendorSku))) return true;
      if (colorName && title.includes(colorName)) return true;
      return false;
    });

    if (!match) return null;

    const images = [];
    if (match.assetUrl) images.push(match.assetUrl + '?format=1500w');
    if (match.items) {
      for (const img of match.items) {
        if (img.assetUrl) images.push(img.assetUrl + '?format=1500w');
      }
    }

    // Parse specs from excerpt/body
    const specs = parseCitywideSpecs(match.excerpt || match.body || '');
    const description = match.excerpt
      ? match.excerpt.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 2000)
      : null;

    return {
      images: [...new Set(images)],
      description,
      specs: Object.keys(specs).length > 0 ? specs : null,
    };
  } catch {
    return null;
  }
}

/** Parse Citywide spec text (HTML or plain) */
function parseCitywideSpecs(html) {
  const text = html.replace(/<[^>]+>/g, '\n').replace(/&[a-z]+;/g, ' ');
  const specs = {};
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  for (const line of lines) {
    const lower = line.toLowerCase();
    if (lower.includes('item code') || lower.includes('item #')) {
      const val = line.replace(/.*?[:#]\s*/i, '').trim();
      if (val) specs.item_number = val;
    }
    if (lower.includes('dimension') || lower.match(/\d+"\s*x\s*\d+"/)) {
      const dimMatch = line.match(/(\d+["″]?\s*x\s*\d+["″]?)/i);
      if (dimMatch) specs.size = dimMatch[1];
    }
    if (lower.includes('gauge') || lower.includes('total thickness')) {
      const val = line.replace(/.*?[:#]\s*/i, '').trim();
      if (val) specs.thickness = val;
    }
    if (lower.includes('wear layer')) {
      const val = line.replace(/.*?[:#]\s*/i, '').trim();
      if (val) specs.wear_layer = val;
    }
    if (lower.includes('finish')) {
      const val = line.replace(/.*?[:#]\s*/i, '').trim();
      if (val) specs.finish = val;
    }
    if (lower.includes('coverage') || lower.includes('sq ft') || lower.includes('sqft')) {
      const val = line.replace(/.*?[:#]\s*/i, '').trim();
      if (val) specs.sqft_per_carton = val;
    }
    if (lower.includes('warranty')) {
      const val = line.replace(/.*?[:#]\s*/i, '').trim();
      if (val) specs.warranty = val;
    }
  }

  return specs;
}

/** Extract product data from a Citywide product page */
async function extractCitywideData(page, colorName) {
  const data = await page.evaluate(() => {
    const images = [];
    document.querySelectorAll('.ProductItem-gallery img, img[src*="squarespace-cdn"], img[data-src*="squarespace-cdn"]').forEach(img => {
      const src = img.src || img.dataset.src;
      if (src && src.includes('squarespace-cdn') && !src.includes('logo') && !src.includes('favicon')) {
        images.push(src.split('?')[0] + '?format=1500w');
      }
    });

    const descEl = document.querySelector('.ProductItem-details-excerpt, .product-description, .ProductItem-details');
    const descText = descEl ? descEl.innerText.trim().slice(0, 2000) : null;

    return { images: [...new Set(images)], descText };
  });

  const specs = parseCitywideSpecs(data.descText || '');

  if (data.images.length === 0 && !data.descText) return null;
  return {
    images: data.images,
    description: data.descText,
    specs: Object.keys(specs).length > 0 ? specs : null,
  };
}

/** Fallback: browse product listing to find matching product */
async function findProductViaBrowse(page, productGroup, delayMs) {
  const colorName = productGroup.name;
  try {
    await page.goto(`${BASE_URL}/citywide-products`, { waitUntil: 'networkidle2', timeout: 15000 });
    await delay(delayMs);

    const productUrl = await page.evaluate((name) => {
      const nameLower = name.toLowerCase();
      const links = document.querySelectorAll('a[href*="/citywide-products/"]');
      for (const a of links) {
        const text = (a.textContent || '').toLowerCase();
        const href = (a.getAttribute('href') || '').toLowerCase();
        if (text.includes(nameLower) || href.includes(nameLower.replace(/\s+/g, ''))) {
          return a.href;
        }
      }
      return null;
    }, colorName);

    if (!productUrl) return null;

    await page.goto(productUrl, { waitUntil: 'networkidle2', timeout: 15000 });
    await delay(delayMs);

    return await extractCitywideData(page, colorName);
  } catch {
    return null;
  }
}
