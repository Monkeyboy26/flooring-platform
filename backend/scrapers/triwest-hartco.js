import {
  launchBrowser, delay, upsertMediaAsset, upsertSkuAttribute,
  appendLog, addJobError, downloadImage, resolveImageExtension, preferProductShot
} from './base.js';

const BASE_URL = 'https://www.hartco.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_ERRORS = 30;

/**
 * Hartco enrichment scraper for Tri-West.
 *
 * Scrapes hartco.com for product images, descriptions, and specs.
 * Enriches EXISTING Tri-West SKUs — never creates new products.
 * Tech: AEM CMS, Handlebars/Ractive templates
 *
 * Runs AFTER triwest-catalog.js populates SKUs in the DB.
 */
export async function run(pool, job, source) {
  const config = source.config || {};
  const delayMs = config.delay_ms || 2000;
  const vendor_id = source.vendor_id;
  const brandPrefix = 'Hartco';

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
 * Find a product on hartco.com and extract images/specs.
 * Returns { images: string[], description: string, specs: object } or null.
 *
 * Hartco is an AHF Products brand (sibling of Bruce/Armstrong).
 * Same Handlebars/Ractive template system as Bruce.
 * Product pages: /en-us/products/{category}/{collection}/{sku}.html
 * Search: /en-us/search-results.html?searchTerm={term}
 * Products rendered as .card elements with img.product.
 * Image CDN: /cdn/content/sites/4/{file}?size=detail
 * Specs in table rows with th/td pairs.
 */
async function findProductOnSite(page, productGroup, delayMs) {
  const firstSku = productGroup.skus[0];
  const vendorSku = firstSku.vendor_sku || '';
  const colorName = productGroup.name;
  const searchTerm = vendorSku || colorName;

  try {
    await page.goto(`${BASE_URL}/en-us/search-results.html?searchTerm=${encodeURIComponent(searchTerm)}`, {
      waitUntil: 'networkidle2',
      timeout: 20000,
    });
    await delay(delayMs);

    // Wait for client-side rendering of product cards
    await page.waitForSelector('.card a, .browse-products .card', { timeout: 8000 }).catch(() => null);

    // Find the best matching product detail link
    const detailUrl = await page.evaluate((name, sku) => {
      const cards = document.querySelectorAll('.card');
      const nameLower = name.toLowerCase();
      const skuLower = sku.toLowerCase();

      for (const card of cards) {
        const text = card.textContent.toLowerCase();
        const link = card.querySelector('a[href*="/en-us/"]');
        if (link && skuLower && text.includes(skuLower)) return link.href;
      }
      for (const card of cards) {
        const text = card.textContent.toLowerCase();
        const link = card.querySelector('a[href*="/en-us/"]');
        if (link && text.includes(nameLower)) return link.href;
      }
      const firstLink = document.querySelector('.card a[href*="/en-us/products/"], .card a[href*=".html"]');
      return firstLink ? firstLink.href : null;
    }, colorName, vendorSku);

    if (!detailUrl) return null;

    await page.goto(detailUrl, { waitUntil: 'networkidle2', timeout: 20000 });
    await delay(delayMs);
  } catch {
    return null;
  }

  const data = await page.evaluate(() => {
    const images = [];
    const seen = new Set();
    document.querySelectorAll('img[src*="/cdn/"], img[src*="?size="]').forEach(img => {
      const src = img.src || img.dataset?.src || '';
      if (src && !src.includes('logo') && !src.includes('icon') && !src.includes('nav')) {
        const clean = src.replace(/\?size=\w+/, '?size=detail');
        if (!seen.has(clean)) {
          seen.add(clean);
          images.push(clean);
        }
      }
    });
    document.querySelectorAll('[data-src*="/cdn/"], [data-image*="/cdn/"]').forEach(el => {
      const src = el.dataset.src || el.dataset.image || '';
      if (src && !seen.has(src)) {
        seen.add(src);
        images.push(src.includes('?') ? src : src + '?size=detail');
      }
    });

    let description = null;
    document.querySelectorAll('script[type="application/ld+json"]').forEach(s => {
      try {
        const d = JSON.parse(s.textContent);
        if (d['@type'] === 'Product' && d.description) {
          description = d.description.trim().slice(0, 2000);
        }
      } catch { }
    });
    if (!description) {
      const descEl = document.querySelector('.product-description, [class*="description"] p, .detail-content p');
      if (descEl) description = descEl.textContent.trim().slice(0, 2000);
    }

    const specs = {};
    document.querySelectorAll('tr').forEach(row => {
      const th = row.querySelector('th, td:first-child');
      const td = row.querySelector('td:last-child');
      if (th && td && th !== td) {
        const label = th.textContent.trim().toLowerCase();
        const value = td.textContent.trim();
        if (!label || !value) return;
        if (label.includes('thickness') && !label.includes('veneer')) specs.thickness = value;
        if (label.includes('width') || label.includes('plank width')) specs.size = value;
        if (label.includes('surface') || label.includes('finish') || label.includes('texture')) specs.finish = value;
        if (label.includes('species') || label.includes('wood type')) specs.material = value;
        if (label.includes('edge')) specs.edge = value;
        if (label.includes('construction')) specs.construction = value;
        if (label.includes('installation')) specs.installation = value;
        if (label.includes('janka')) specs.janka_hardness = value;
      }
    });
    document.querySelectorAll('dl').forEach(dl => {
      const dts = dl.querySelectorAll('dt');
      const dds = dl.querySelectorAll('dd');
      for (let i = 0; i < Math.min(dts.length, dds.length); i++) {
        const label = dts[i].textContent.trim().toLowerCase();
        const value = dds[i].textContent.trim();
        if (label.includes('thickness')) specs.thickness = value;
        if (label.includes('width')) specs.size = value;
        if (label.includes('finish')) specs.finish = value;
        if (label.includes('species')) specs.material = value;
        if (label.includes('edge')) specs.edge = value;
      }
    });

    return { images, description, specs: Object.keys(specs).length > 0 ? specs : null };
  });

  if (data.images.length === 0 && !data.description && !data.specs) return null;
  return data;
}
