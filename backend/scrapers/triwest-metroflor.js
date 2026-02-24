import {
  launchBrowser, delay, upsertMediaAsset, upsertSkuAttribute,
  appendLog, addJobError, downloadImage, resolveImageExtension, preferProductShot
} from './base.js';

const BASE_URL = 'https://www.metroflor.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_ERRORS = 30;

/**
 * Metroflor enrichment scraper for Tri-West.
 *
 * Scrapes metroflor.com for product images, descriptions, and specs.
 * Enriches EXISTING Tri-West SKUs — never creates new products.
 * Tech: Shopify (FloorTitan theme)
 *
 * Runs AFTER triwest-catalog.js populates SKUs in the DB.
 */
export async function run(pool, job, source) {
  const config = source.config || {};
  const delayMs = config.delay_ms || 2000;
  const vendor_id = source.vendor_id;
  const brandPrefix = 'Metroflor';

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
 * Find a product on metroflor.com and extract images/specs.
 * Returns { images: string[], description: string, specs: object } or null.
 *
 * Metroflor is a Shopify store (FloorTitan theme).
 * Product URLs: /products/metroflor-in-{collection}-in-{color}
 * Images: cdn.shopify.com/s/files/1/0628/9073/7734/
 * Key insight: Shopify /{handle}.json endpoint returns structured product data.
 */
async function findProductOnSite(page, productGroup, delayMs) {
  const colorName = productGroup.name;
  const collection = productGroup.collection;
  const collectionName = collection.replace(/^Metroflor\s*/i, '').trim();

  // Build Shopify handle: "metroflor-in-{collection}-in-{color}"
  const collectionSlug = collectionName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  const colorSlug = colorName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

  try {
    // Strategy 1: Try Shopify JSON API with constructed handle
    const handle = `metroflor-in-${collectionSlug}-in-${colorSlug}`;
    let result = await tryShopifyJson(page, handle, delayMs);
    if (result) return result;

    // Strategy 2: Try simpler handle without "metroflor-in-" prefix
    result = await tryShopifyJson(page, `${collectionSlug}-${colorSlug}`, delayMs);
    if (result) return result;

    // Strategy 3: Try just the color name
    result = await tryShopifyJson(page, colorSlug, delayMs);
    if (result) return result;

    // Strategy 4: Fallback to searching the Shopify site
    return await findMetroflorViaSearch(page, productGroup, delayMs);
  } catch {
    return null;
  }
}

/** Try fetching product data via Shopify .json endpoint */
async function tryShopifyJson(page, handle, delayMs) {
  try {
    await page.goto(`${BASE_URL}/products/${handle}.json`, {
      waitUntil: 'networkidle2',
      timeout: 10000,
    });
    await delay(delayMs / 2);

    const jsonText = await page.evaluate(() => document.body?.innerText || '');
    let data;
    try { data = JSON.parse(jsonText); } catch { return null; }

    if (!data?.product) return null;

    const product = data.product;

    // Extract images
    const images = (product.images || []).map(img => img.src).filter(Boolean);

    // Extract specs from body_html
    const specs = parseMetroflorSpecs(product.body_html || '');

    // Description from body_html (strip HTML)
    const description = product.body_html
      ? product.body_html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 2000)
      : null;

    if (images.length === 0 && !description && !specs) return null;

    return {
      images,
      description,
      specs: Object.keys(specs).length > 0 ? specs : null,
    };
  } catch {
    return null;
  }
}

/** Parse specs from Shopify product body HTML */
function parseMetroflorSpecs(html) {
  const text = html.replace(/<[^>]+>/g, '\n').replace(/&[a-z]+;/g, ' ').replace(/&#\d+;/g, ' ');
  const specs = {};
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  for (const line of lines) {
    const match = line.match(/^(thickness|width|length|wear\s*layer|finish|edge|material|species|size|dimensions?|construction|sqft|sq\s*ft|warranty)[:\s-]+(.+)/i);
    if (match) {
      const label = match[1].toLowerCase().trim();
      const value = match[2].trim();
      if (label.includes('thickness')) specs.thickness = value;
      if (label.includes('width') || label.includes('size') || label.includes('dimension')) specs.size = value;
      if (label.includes('length')) specs.length = value;
      if (label.includes('wear')) specs.wear_layer = value;
      if (label.includes('finish')) specs.finish = value;
      if (label.includes('edge')) specs.edge = value;
      if (label.includes('material') || label.includes('species')) specs.material = value;
      if (label.includes('construction')) specs.construction = value;
      if (label.includes('sqft') || label.includes('sq ft')) specs.sqft_per_carton = value;
      if (label.includes('warranty')) specs.warranty = value;
    }
  }

  return specs;
}

/** Fallback: search Shopify store for the product */
async function findMetroflorViaSearch(page, productGroup, delayMs) {
  const colorName = productGroup.name;
  try {
    // Shopify search endpoint
    await page.goto(`${BASE_URL}/search?q=${encodeURIComponent(colorName)}&type=product`, {
      waitUntil: 'networkidle2',
      timeout: 15000,
    });
    await delay(delayMs);

    const productUrl = await page.evaluate((name) => {
      const nameLower = name.toLowerCase();
      const links = document.querySelectorAll('a[href*="/products/"]');
      for (const a of links) {
        const text = (a.textContent || '').toLowerCase();
        const href = (a.getAttribute('href') || '').toLowerCase();
        if (text.includes(nameLower) || href.includes(nameLower.replace(/\s+/g, '-'))) {
          return a.href;
        }
      }
      // If no text match, return the first product link from search results
      const first = document.querySelector('a[href*="/products/"]');
      return first ? first.href : null;
    }, colorName);

    if (!productUrl) return null;

    // Extract handle from URL and try JSON API
    const handleMatch = productUrl.match(/\/products\/([^?#/]+)/);
    if (handleMatch) {
      const result = await tryShopifyJson(page, handleMatch[1], delayMs);
      if (result) return result;
    }

    // Fallback: scrape DOM
    await page.goto(productUrl, { waitUntil: 'networkidle2', timeout: 15000 });
    await delay(delayMs);

    return page.evaluate(() => {
      const images = [];
      document.querySelectorAll('.product__media img, .product-single__photo img, img[src*="cdn.shopify"]').forEach(img => {
        const src = img.src || img.dataset.src;
        if (src && src.includes('cdn.shopify') && !src.includes('logo')) {
          images.push(src);
        }
      });

      const descEl = document.querySelector('.product-single__description, .product__description, [class*="product-description"]');
      const description = descEl ? descEl.textContent.trim().slice(0, 2000) : null;

      return {
        images: [...new Set(images)],
        description,
        specs: null,
      };
    });
  } catch {
    return null;
  }
}
