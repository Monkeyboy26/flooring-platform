import {
  launchBrowser, delay, upsertMediaAsset, upsertSkuAttribute,
  appendLog, addJobError, downloadImage, resolveImageExtension, preferProductShot
} from './base.js';

const BASE_URL = 'https://www.provenzafloors.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_ERRORS = 30;

/**
 * Provenza enrichment scraper for Tri-West.
 *
 * Scrapes provenzafloors.com for product images, descriptions, and specs.
 * Enriches EXISTING Tri-West SKUs — never creates new products.
 * Tech: Custom
 *
 * Runs AFTER triwest-catalog.js populates SKUs in the DB.
 */
export async function run(pool, job, source) {
  const config = source.config || {};
  const delayMs = config.delay_ms || 2000;
  const vendor_id = source.vendor_id;
  const brandPrefix = 'Provenza';

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
 * Find a product on provenzafloors.com and extract images/specs.
 * Returns { images: string[], description: string, specs: object } or null.
 *
 * Provenza product detail URL pattern:
 *   /hardwood/detail?sku={SKU}&color={Color}&collection={Collection}
 *   /waterprooflvp/detail?sku={SKU}&color={Color}&collection={Collection}
 *
 * Images hosted on Google Cloud Storage:
 *   storage.googleapis.com/provenza-web/images/products/hardwood/{collection-slug}/detail/
 *   Provenza-{Collection}-{SKU}-{Color}.jpg, _04.jpg, _05.jpg, _06.jpg
 *
 * jQuery-based site; detail pages load product data client-side.
 * Description in narrative form, no structured spec table.
 */
async function findProductOnSite(page, productGroup, delayMs) {
  const firstSku = productGroup.skus[0];
  const vendorSku = firstSku.vendor_sku || '';
  // Strip brand prefix from collection: "Provenza Old World" → "Old World"
  const collection = productGroup.collection.replace(/^Provenza\s*/i, '').trim();
  const colorName = productGroup.name;

  if (!vendorSku) return null;

  // Determine flooring category for URL path
  const categories = ['hardwood', 'waterprooflvp', 'maxcorelaminate', 'wallchic', 'colournation'];

  let loaded = false;
  for (const category of categories) {
    try {
      const url = `${BASE_URL}/${category}/detail?sku=${encodeURIComponent(vendorSku)}&color=${encodeURIComponent(colorName)}&collection=${encodeURIComponent(collection)}`;
      const response = await page.goto(url, { waitUntil: 'networkidle2', timeout: 15000 });
      await delay(delayMs);

      // Check if the page loaded a real product (not a 404 or redirect to homepage)
      const pageUrl = page.url();
      if (pageUrl.includes('/detail') && response && response.status() === 200) {
        loaded = true;
        break;
      }
    } catch { /* try next category */ }
  }

  if (!loaded) {
    // Fallback: try without color param (some URLs omit it)
    try {
      const url = `${BASE_URL}/hardwood/detail?sku=${encodeURIComponent(vendorSku)}&collection=${encodeURIComponent(collection)}`;
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 15000 });
      await delay(delayMs);
      loaded = page.url().includes('/detail');
    } catch { /* give up */ }
  }

  if (!loaded) return null;

  // Wait for client-side rendering (jQuery + Angular-style templates)
  // Detail pages use {{ selectTile.tileDetail.description }} expressions
  await page.waitForSelector('img[src*="storage.googleapis.com"], img[src*="provenza"]', { timeout: 5000 }).catch(() => null);
  // Extra delay for Angular template rendering
  await delay(1500);

  const data = await page.evaluate(() => {
    // 1. Images from Google Cloud Storage
    const images = [];
    const seen = new Set();
    document.querySelectorAll('img').forEach(img => {
      const src = img.src || img.dataset?.src || '';
      if (src.includes('storage.googleapis.com/provenza-web') && !src.includes('emblem') && !src.includes('logo')) {
        // Prefer detail images over lightbox
        const clean = src.replace('/lightbox/', '/detail/').replace('_lb.jpg', '.jpg');
        if (!seen.has(clean)) {
          seen.add(clean);
          images.push(clean);
        }
      }
    });
    // Also look for background images in style attributes
    document.querySelectorAll('[style*="storage.googleapis.com"]').forEach(el => {
      const match = el.style.backgroundImage?.match(/url\(['"]?(https:\/\/storage[^'")\s]+)['"]?\)/);
      if (match && !seen.has(match[1])) {
        seen.add(match[1]);
        images.push(match[1]);
      }
    });

    // 2. Description — rendered from Angular template {{ selectTile.tileDetail.description }}
    //    Located in #tabs-1 (Details tab) after client-side rendering
    let description = null;
    const descEl = document.querySelector('#tabs-1 p, .tabs-1 p, [class*="detail"] p, [class*="description"] p');
    if (descEl) {
      const text = descEl.textContent.trim();
      // Skip if still an unrendered template expression
      if (text.length > 20 && !text.includes('{{')) {
        description = text.slice(0, 2000);
      }
    }
    // Fallback: grab any substantial paragraph near the product info
    if (!description) {
      document.querySelectorAll('p').forEach(p => {
        const text = p.textContent.trim();
        if (text.length > 50 && !text.includes('cookie') && !text.includes('©') && !text.includes('{{') && !description) {
          description = text.slice(0, 2000);
        }
      });
    }

    // 3. Specs — Provenza does NOT display specs on detail pages (only in PDFs).
    //    Best-effort extraction in case any page has inline spec data.
    const specs = {};
    document.querySelectorAll('li, .spec-item, [class*="spec"]').forEach(el => {
      const text = el.textContent.trim().toLowerCase();
      if (text.includes('{{')) return; // Skip unrendered templates
      if (text.includes('thickness') && text.includes('"')) {
        specs.thickness = el.textContent.replace(/.*thickness[:\s]*/i, '').trim();
      }
      if (text.includes('width') && text.includes('"')) {
        specs.size = el.textContent.replace(/.*width[:\s]*/i, '').trim();
      }
      if (text.includes('species') || text.includes('wood type')) {
        specs.material = el.textContent.replace(/.*(?:species|wood type)[:\s]*/i, '').trim();
      }
      if (text.includes('finish') && !text.includes('finish warranty')) {
        specs.finish = el.textContent.replace(/.*finish[:\s]*/i, '').trim();
      }
    });

    return { images, description, specs: Object.keys(specs).length > 0 ? specs : null };
  });

  if (data.images.length === 0 && !data.description && !data.specs) return null;
  return data;
}
