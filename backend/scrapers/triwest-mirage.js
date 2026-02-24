import {
  launchBrowser, delay, upsertMediaAsset, upsertSkuAttribute,
  appendLog, addJobError, downloadImage, resolveImageExtension, preferProductShot
} from './base.js';

const BASE_URL = 'https://www.miragefloors.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_ERRORS = 30;

/**
 * Mirage enrichment scraper for Tri-West.
 *
 * Scrapes miragefloors.com for product images, descriptions, and specs.
 * Enriches EXISTING Tri-West SKUs — never creates new products.
 * Tech: Vue.js / Custom, WebP images
 *
 * Runs AFTER triwest-catalog.js populates SKUs in the DB.
 */
export async function run(pool, job, source) {
  const config = source.config || {};
  const delayMs = config.delay_ms || 2000;
  const vendor_id = source.vendor_id;
  const brandPrefix = 'Mirage';

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
 * Find a product on miragefloors.com and extract images/specs.
 * Returns { images: string[], description: string, specs: object } or null.
 *
 * Mirage Hardwood Floors — client-rendered site (Vue.js / custom).
 * Product URLs: /en-us/hardwood-flooring-{species}-{color}-{finish}
 * Collection pages: /en-us/hardwood-flooring (browse by species/collection)
 * Images: WebP from miragefloors.com/static/vb/ CDN
 * Vue Select dropdowns for color variant selection.
 * Specs in structured sections on product detail pages.
 *
 * Strategy: Build a product URL slug from color name + collection,
 * or search via site search, then extract from rendered detail page.
 */
async function findProductOnSite(page, productGroup, delayMs) {
  const firstSku = productGroup.skus[0];
  const vendorSku = firstSku.vendor_sku || '';
  const colorName = productGroup.name;
  // Strip brand prefix: "Mirage Sweet Memories" → "Sweet Memories"
  const collection = productGroup.collection.replace(/^Mirage\s*/i, '').trim();

  // Try to build a URL slug from color name (Mirage uses kebab-case slugs)
  const colorSlug = colorName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const collectionSlug = collection.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  let loaded = false;

  // Attempt 1: Direct product URL with collection and color
  const candidateUrls = [
    `${BASE_URL}/en-us/hardwood-flooring-${collectionSlug}-${colorSlug}`,
    `${BASE_URL}/en-us/engineered-hardwood-flooring-${collectionSlug}-${colorSlug}`,
    `${BASE_URL}/en-us/${collectionSlug}-${colorSlug}`,
  ];

  for (const url of candidateUrls) {
    try {
      const response = await page.goto(url, { waitUntil: 'networkidle2', timeout: 12000 });
      await delay(delayMs);
      if (response && response.status() === 200 && !page.url().includes('/404') && !page.url().endsWith('/en-us/')) {
        loaded = true;
        break;
      }
    } catch { /* try next */ }
  }

  // Attempt 2: Browse collection page and find color link
  if (!loaded) {
    try {
      await page.goto(`${BASE_URL}/en-us/hardwood-flooring`, { waitUntil: 'networkidle2', timeout: 15000 });
      await delay(delayMs);

      // Wait for client-side rendering
      await page.waitForSelector('a[href*="/en-us/"]', { timeout: 8000 }).catch(() => null);

      const productUrl = await page.evaluate((color, coll) => {
        const colorLower = color.toLowerCase();
        const collLower = coll.toLowerCase();
        const links = document.querySelectorAll('a[href*="/en-us/"]');
        // Match by color name in link text or href
        for (const a of links) {
          const href = a.getAttribute('href') || '';
          const text = a.textContent.toLowerCase();
          if ((text.includes(colorLower) || href.toLowerCase().includes(colorLower.replace(/\s+/g, '-'))) &&
              !href.includes('blog') && !href.includes('faq') && !href.includes('dealer')) {
            return href.startsWith('http') ? href : null;
          }
        }
        // Match by collection in link text
        for (const a of links) {
          const text = a.textContent.toLowerCase();
          const href = a.getAttribute('href') || '';
          if (text.includes(collLower) && !href.includes('blog')) {
            return href.startsWith('http') ? href : null;
          }
        }
        return null;
      }, colorName, collection);

      if (productUrl) {
        await page.goto(productUrl, { waitUntil: 'networkidle2', timeout: 15000 });
        await delay(delayMs);
        loaded = true;
      }
    } catch { /* fall through */ }
  }

  if (!loaded) return null;

  // Wait for images to load on the detail page
  await page.waitForSelector('img[src*="/static/vb/"], img[src*="miragefloors"], img[src*=".webp"]', { timeout: 5000 }).catch(() => null);

  const data = await page.evaluate(() => {
    // 1. Images — Mirage serves WebP from /static/vb/ CDN
    const images = [];
    const seen = new Set();
    document.querySelectorAll('img').forEach(img => {
      const src = img.src || img.dataset?.src || img.dataset?.lazySrc || '';
      if (src && (src.includes('/static/vb/') || src.includes('miragefloors.com')) &&
          !src.includes('logo') && !src.includes('icon') && !src.includes('nav') &&
          !src.includes('flag') && !src.includes('social')) {
        const clean = src.split('?')[0];
        if (!seen.has(clean)) {
          seen.add(clean);
          images.push(src);
        }
      }
    });
    // Background images in style attributes
    document.querySelectorAll('[style*="/static/vb/"]').forEach(el => {
      const match = el.style.backgroundImage?.match(/url\(['"]?(https?:\/\/[^'")]+)['"]?\)/);
      if (match && !seen.has(match[1].split('?')[0])) {
        seen.add(match[1].split('?')[0]);
        images.push(match[1]);
      }
    });

    // 2. Description
    let description = null;
    const descEl = document.querySelector('[class*="description"] p, .product-description, .product-info p, article p');
    if (descEl) description = descEl.textContent.trim().slice(0, 2000);
    // Fallback: meta description
    if (!description) {
      const meta = document.querySelector('meta[name="description"]');
      if (meta?.content && meta.content.length > 30) description = meta.content.trim().slice(0, 2000);
    }

    // 3. Specs — Mirage uses structured spec sections
    const specs = {};
    document.querySelectorAll('tr, li, .spec-row, [class*="spec"]').forEach(el => {
      const text = el.textContent.trim().toLowerCase();
      if (text.includes('thickness') && text.includes('"')) {
        specs.thickness = el.textContent.replace(/.*thickness[:\s]*/i, '').trim();
      }
      if (text.includes('width') && (text.includes('"') || text.includes('mm'))) {
        specs.size = el.textContent.replace(/.*width[:\s]*/i, '').trim();
      }
      if (text.includes('species') || text.includes('wood type')) {
        specs.material = el.textContent.replace(/.*(?:species|wood type)[:\s]*/i, '').trim();
      }
      if (text.includes('finish') && !text.includes('unfinished')) {
        specs.finish = el.textContent.replace(/.*finish[:\s]*/i, '').trim();
      }
      if (text.includes('edge')) {
        specs.edge = el.textContent.replace(/.*edge[:\s]*/i, '').trim();
      }
      if (text.includes('construction')) {
        specs.construction = el.textContent.replace(/.*construction[:\s]*/i, '').trim();
      }
    });
    // Also try table-based specs
    document.querySelectorAll('table tr').forEach(row => {
      const cells = row.querySelectorAll('td, th');
      if (cells.length >= 2) {
        const label = cells[0].textContent.trim().toLowerCase();
        const value = cells[1].textContent.trim();
        if (label.includes('thickness')) specs.thickness = value;
        if (label.includes('width')) specs.size = value;
        if (label.includes('species')) specs.material = value;
        if (label.includes('finish')) specs.finish = value;
        if (label.includes('grade')) specs.grade = value;
      }
    });

    return { images, description, specs: Object.keys(specs).length > 0 ? specs : null };
  });

  if (data.images.length === 0 && !data.description && !data.specs) return null;
  return data;
}
