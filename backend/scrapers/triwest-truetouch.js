import {
  launchBrowser, delay, upsertMediaAsset, upsertSkuAttribute,
  appendLog, addJobError, downloadImage, resolveImageExtension, preferProductShot
} from './base.js';

const BASE_URL = 'https://www.truetouchfloors.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_ERRORS = 30;

/**
 * True Touch enrichment scraper for Tri-West.
 *
 * Scrapes truetouchfloors.com for product images, descriptions, and specs.
 * Enriches EXISTING Tri-West SKUs — never creates new products.
 * Tech: Squarespace
 *
 * Runs AFTER triwest-catalog.js populates SKUs in the DB.
 */
export async function run(pool, job, source) {
  const config = source.config || {};
  const delayMs = config.delay_ms || 2000;
  const vendor_id = source.vendor_id;
  const brandPrefix = 'True Touch';

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
 * Find a product on truetouchfloors.com and extract images/specs.
 * Returns { images: string[], description: string, specs: object } or null.
 *
 * True Touch is a Squarespace site. Collection-based structure.
 * Category pages: /wpc-flooring, /spc-flooring, /real-hardwood-flooring, etc.
 * Collection URLs: /{collection-slug} (e.g., /evolv, /momentum, /longboard)
 * Images: images.squarespace-cdn.com
 */
async function findProductOnSite(page, productGroup, delayMs) {
  const colorName = productGroup.name;
  const collection = productGroup.collection;

  // Strip brand prefix from collection to get the collection slug
  const collectionName = collection.replace(/^True\s*Touch\s*/i, '').trim();
  const collectionSlug = collectionName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  const colorSlug = colorName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

  try {
    // Strategy 1: Try direct color slug page
    let found = await tryPage(page, `${BASE_URL}/${colorSlug}`, delayMs);
    if (found) return found;

    // Strategy 2: Try collection slug page (products may be shown on collection page)
    found = await tryPage(page, `${BASE_URL}/${collectionSlug}`, delayMs);
    if (found) return found;

    // Strategy 3: Try combined collection-color slug
    found = await tryPage(page, `${BASE_URL}/${collectionSlug}-${colorSlug}`, delayMs);
    if (found) return found;

    // Strategy 4: Browse category pages to find product links
    return await findProductViaCategories(page, productGroup, delayMs);
  } catch {
    return null;
  }
}

/** Try loading a specific page and extracting product data */
async function tryPage(page, url, delayMs) {
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 15000 });
    await delay(delayMs);

    const is404 = await page.evaluate(() => {
      const body = document.body?.textContent || '';
      return document.title.includes('Page Not Found') ||
             body.includes('page not found') ||
             document.querySelector('.sqs-error-page') !== null;
    });

    if (is404) return null;

    return await extractTrueTouchData(page);
  } catch {
    return null;
  }
}

/** Extract product data from a True Touch page */
async function extractTrueTouchData(page) {
  const data = await page.evaluate(() => {
    const images = [];

    // Squarespace images
    document.querySelectorAll('img[src*="squarespace-cdn"], img[data-src*="squarespace-cdn"]').forEach(img => {
      const src = img.src || img.dataset.src || img.dataset.image;
      if (src && !src.includes('logo') && !src.includes('favicon') && !src.includes('icon')) {
        images.push(src.split('?')[0] + '?format=1500w');
      }
    });

    // Background images in Squarespace blocks
    document.querySelectorAll('[data-image], .sqs-image-shape-container-element').forEach(el => {
      const bgUrl = el.dataset.image || el.dataset.src;
      if (bgUrl && bgUrl.includes('squarespace-cdn')) {
        images.push(bgUrl.split('?')[0] + '?format=1500w');
      }
    });

    // Extract specs from text content
    const specs = {};
    const textContent = document.body?.innerText || '';
    const lines = textContent.split('\n').map(l => l.trim()).filter(Boolean);

    for (const line of lines) {
      const lower = line.toLowerCase();
      const match = line.match(/^(thickness|width|length|wear\s*layer|finish|edge|construction|warranty|species|material|size|plank\s*size)[:\s-]+(.+)/i);
      if (match) {
        const label = match[1].toLowerCase().trim();
        const value = match[2].trim();
        if (label.includes('thickness')) specs.thickness = value;
        if (label.includes('width') || label.includes('size')) specs.size = value;
        if (label.includes('wear')) specs.wear_layer = value;
        if (label.includes('finish')) specs.finish = value;
        if (label.includes('edge')) specs.edge = value;
        if (label.includes('species') || label.includes('material')) specs.material = value;
        if (label.includes('construction')) specs.construction = value;
        if (label.includes('warranty')) specs.warranty = value;
      }
      // Also match dimension patterns like "7" x 48""
      if (!specs.size && lower.match(/\d+["″]?\s*x\s*\d+["″]/)) {
        const dimMatch = line.match(/(\d+["″]?\s*x\s*\d+["″]?[^,.\n]*)/i);
        if (dimMatch) specs.size = dimMatch[1].trim();
      }
    }

    // Description
    const descEl = document.querySelector('.sqs-block-content p, .sqs-layout p, article p');
    const description = descEl ? descEl.textContent.trim().slice(0, 2000) : null;

    return {
      images: [...new Set(images)],
      description,
      specs: Object.keys(specs).length > 0 ? specs : null,
    };
  });

  if (data.images.length === 0 && !data.description && !data.specs) return null;
  return data;
}

/** Browse category pages to find product links */
async function findProductViaCategories(page, productGroup, delayMs) {
  const colorName = productGroup.name.toLowerCase();
  const categoryPaths = ['/wpc-flooring', '/spc-flooring', '/real-hardwood-flooring', '/monotech-waterproof-wood-flooring', '/waterproof-laminate-flooring'];

  for (const cat of categoryPaths) {
    try {
      await page.goto(`${BASE_URL}${cat}`, { waitUntil: 'networkidle2', timeout: 15000 });
      await delay(delayMs);

      const productUrl = await page.evaluate((name) => {
        const links = document.querySelectorAll('a[href]');
        for (const a of links) {
          const text = (a.textContent || '').toLowerCase();
          const href = (a.getAttribute('href') || '').toLowerCase();
          if (text.includes(name) || href.includes(name.replace(/\s+/g, '-'))) {
            return a.href;
          }
        }
        return null;
      }, colorName);

      if (productUrl) {
        await page.goto(productUrl, { waitUntil: 'networkidle2', timeout: 15000 });
        await delay(delayMs);
        return await extractTrueTouchData(page);
      }
    } catch {
      continue;
    }
  }

  return null;
}
