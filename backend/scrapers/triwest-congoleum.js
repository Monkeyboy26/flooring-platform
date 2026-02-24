import {
  launchBrowser, delay, upsertMediaAsset, upsertSkuAttribute,
  appendLog, addJobError, downloadImage, resolveImageExtension, preferProductShot
} from './base.js';

const BASE_URL = 'https://www.congoleum.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_ERRORS = 30;

/**
 * Congoleum enrichment scraper for Tri-West.
 *
 * Scrapes congoleum.com for product images, descriptions, and specs.
 * Enriches EXISTING Tri-West SKUs — never creates new products.
 * Tech: WordPress
 *
 * Runs AFTER triwest-catalog.js populates SKUs in the DB.
 */
export async function run(pool, job, source) {
  const config = source.config || {};
  const delayMs = config.delay_ms || 2000;
  const vendor_id = source.vendor_id;
  const brandPrefix = 'Congoleum';

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
 * Find product on Congoleum.com and extract images, description, specs.
 * Congoleum uses WordPress with product pages at /{product-type}/{collection-name}/.
 *
 * Strategy:
 * 1. Build URL from collection slug: /{product-type}/{collection-slug}/
 * 2. If 404, fallback to WordPress search: /?s={term}
 * 3. Extract:
 *    - Images from /wp-content/uploads/ in content area
 *    - Description from page text/content
 *    - Specs from text content (WordPress doesn't have structured spec tables)
 */
async function findProductOnSite(page, group, delayMs) {
  const collectionSlug = group.collection
    .replace(/^Congoleum\s+/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  // Try common product type paths
  const productTypes = ['sheet-vinyl', 'luxury-vinyl', 'resilient-flooring', 'vinyl-flooring'];
  let foundPage = false;

  for (const type of productTypes) {
    const guessUrl = `${BASE_URL}/${type}/${collectionSlug}/`;
    try {
      const response = await page.goto(guessUrl, { waitUntil: 'networkidle2', timeout: 30000 });
      if (response && response.status() === 200) {
        foundPage = true;
        await delay(delayMs);
        break;
      }
    } catch {
      continue;
    }
  }

  // Fallback to WordPress search
  if (!foundPage) {
    const searchTerm = group.collection.replace(/^Congoleum\s+/i, '');
    const searchUrl = `${BASE_URL}/?s=${encodeURIComponent(searchTerm)}`;
    await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    await delay(delayMs);

    // Click first search result
    const firstLink = await page.$('a[href*="' + BASE_URL + '"]');
    if (!firstLink) {
      return null;
    }

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }),
      firstLink.click()
    ]);
    await delay(delayMs);
  }

  const productData = { images: [], specs: {} };

  // Extract images from WordPress uploads
  const images = await page.$$eval(
    'img[src*="/wp-content/uploads/"]',
    imgs => imgs
      .map(img => img.src)
      .filter(src => !src.includes('logo') && !src.includes('icon'))
  ).catch(() => []);

  productData.images = [...new Set(images)]; // Remove duplicates

  // Extract description from main content area
  const description = await page.$eval(
    '.entry-content, .product-description, article .content, main',
    el => {
      // Get first paragraph that's substantial
      const paragraphs = el.querySelectorAll('p');
      for (const p of paragraphs) {
        const text = p.textContent.trim();
        if (text.length > 50) {
          return text;
        }
      }
      return null;
    }
  ).catch(() => null);

  if (description) {
    productData.description = description;
  }

  // WordPress sites rarely have structured spec tables, but try to extract key info from text
  const pageText = await page.$eval(
    'body',
    el => el.textContent
  ).catch(() => '');

  // Look for common flooring specs in text
  const thicknessMatch = pageText.match(/thickness[:\s]+([0-9.]+\s*(?:mm|mil))/i);
  const widthMatch = pageText.match(/width[:\s]+([0-9.]+\s*(?:in|ft))/i);
  const wearLayerMatch = pageText.match(/wear\s+layer[:\s]+([0-9.]+\s*mil)/i);

  if (thicknessMatch) productData.specs['thickness'] = thicknessMatch[1];
  if (widthMatch) productData.specs['width'] = widthMatch[1];
  if (wearLayerMatch) productData.specs['wear-layer'] = wearLayerMatch[1];

  return productData.images.length > 0 || productData.description || Object.keys(productData.specs).length > 0
    ? productData
    : null;
}
