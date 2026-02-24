import {
  launchBrowser, delay, upsertMediaAsset, upsertSkuAttribute,
  appendLog, addJobError, downloadImage, resolveImageExtension, preferProductShot
} from './base.js';

const BASE_URL = 'https://shawfloors.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_ERRORS = 30;

/**
 * Shaw enrichment scraper for Tri-West.
 *
 * Scrapes shawfloors.com for product images, descriptions, and specs.
 * Enriches EXISTING Tri-West SKUs — never creates new products.
 * Tech: React SSR, Widen DAM images
 *
 * Runs AFTER triwest-catalog.js populates SKUs in the DB.
 */
export async function run(pool, job, source) {
  const config = source.config || {};
  const delayMs = config.delay_ms || 2000;
  const vendor_id = source.vendor_id;
  const brandPrefix = 'Shaw';

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
 * Find a product on shawfloors.com and extract images/specs.
 * Returns { images: string[], description: string, specs: object } or null.
 *
 * Shaw uses React SSR with JSON-LD structured data and Widen DAM images.
 * Search URL: /search?query={term} — client-rendered, needs waitForSelector.
 * Product detail URLs end with /{style-color} (e.g., /sw707-07067).
 * Images: shawfloors.widen.net/content/{hash}/jpeg/{sku}_main, _room, _angled
 * Specs: table rows with td pairs on product detail pages.
 */
async function findProductOnSite(page, productGroup, delayMs) {
  const firstSku = productGroup.skus[0];
  const vendorSku = firstSku.vendor_sku || '';

  // Search by vendor SKU (most precise) or fall back to product name
  const searchTerm = vendorSku || productGroup.name;

  try {
    await page.goto(`${BASE_URL}/en-us/search?query=${encodeURIComponent(searchTerm)}`, {
      waitUntil: 'networkidle2',
      timeout: 20000,
    });
    await delay(delayMs);

    // Wait for search results to render (React client-side)
    await page.waitForSelector('a[href*="/en-us/"]', { timeout: 8000 }).catch(() => null);

    // Find the first product detail link from search results
    const detailUrl = await page.evaluate(() => {
      const categories = ['/hardwood/', '/vinyl/', '/laminate/', '/tile-stone/'];
      const links = document.querySelectorAll('a[href*="/en-us/"]');
      for (const a of links) {
        const href = a.getAttribute('href') || '';
        if (categories.some(c => href.includes(c)) && href.match(/\/[a-z0-9]+-\d+\/?$/)) {
          return href.startsWith('http') ? href : 'https://shawfloors.com' + href;
        }
      }
      // Broader fallback: any product-looking link
      for (const a of links) {
        const href = a.getAttribute('href') || '';
        if (categories.some(c => href.includes(c)) && !href.endsWith('/hardwood') && !href.endsWith('/vinyl')) {
          return href.startsWith('http') ? href : 'https://shawfloors.com' + href;
        }
      }
      return null;
    });

    if (!detailUrl) return null;

    // Navigate to product detail page
    await page.goto(detailUrl, { waitUntil: 'networkidle2', timeout: 20000 });
    await delay(delayMs);
  } catch {
    return null;
  }

  // Extract data from product detail page
  const data = await page.evaluate(() => {
    // 1. JSON-LD for description
    let description = null;
    const ldScripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (const s of ldScripts) {
      try {
        const d = JSON.parse(s.textContent);
        if (d['@type'] === 'Product' && d.description) {
          description = d.description.trim().slice(0, 2000);
          break;
        }
      } catch { /* skip malformed JSON-LD */ }
    }

    // 2. Images — Widen DAM + shawinc CDN
    const images = [];
    const seen = new Set();
    // Direct img tags with Widen/shawinc URLs
    document.querySelectorAll('img[src*="widen.net"], img[src*="shawinc.com"]').forEach(img => {
      const src = img.src || img.dataset?.src;
      if (src && !src.includes('logo') && !src.includes('icon') && !src.includes('nav')) {
        const clean = src.split('?')[0];
        if (!seen.has(clean)) {
          seen.add(clean);
          images.push(src);
        }
      }
    });
    // Also mine embedded React props for Widen URLs not yet in DOM
    document.querySelectorAll('script').forEach(s => {
      const text = s.textContent || '';
      const matches = text.matchAll(/https:\/\/shawfloors\.widen\.net\/content\/[a-z0-9]+\/(?:jpeg|webp)\/[a-z0-9_]+/gi);
      for (const m of matches) {
        if (!seen.has(m[0])) {
          seen.add(m[0]);
          images.push(m[0]);
        }
      }
    });

    // 3. Specs — Shaw uses table rows with 2 td cells
    const specs = {};
    document.querySelectorAll('tr').forEach(row => {
      const cells = row.querySelectorAll('td');
      if (cells.length >= 2) {
        const label = cells[0].textContent.trim().toLowerCase();
        const value = cells[1].textContent.trim();
        if (!label || !value) return;
        if (label.includes('thickness') && !label.includes('veneer')) specs.thickness = value;
        if (label.includes('plank width') || (label.includes('width') && !label.includes('plank'))) specs.size = value;
        if (label.includes('surface') || label.includes('texture')) specs.finish = value;
        if (label.includes('species')) specs.material = value;
        if (label.includes('edge')) specs.edge = value;
        if (label.includes('construction')) specs.construction = value;
        if (label.includes('installation method')) specs.installation = value;
      }
    });

    return { images, description, specs: Object.keys(specs).length > 0 ? specs : null };
  });

  if (data.images.length === 0 && !data.description && !data.specs) return null;
  return data;
}
