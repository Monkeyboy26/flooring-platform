import {
  launchBrowser, delay, upsertMediaAsset, upsertSkuAttribute,
  appendLog, addJobError, downloadImage, resolveImageExtension, preferProductShot
} from './base.js';

const BASE_URL = 'https://elysiumtile.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_ERRORS = 30;

/**
 * Elysium enrichment scraper for Tri-West.
 *
 * Scrapes elysiumtile.com for product images, descriptions, and specs.
 * Enriches EXISTING Tri-West SKUs — never creates new products.
 * Tech: Custom PHP
 *
 * Runs AFTER triwest-catalog.js populates SKUs in the DB.
 */
export async function run(pool, job, source) {
  const config = source.config || {};
  const delayMs = config.delay_ms || 2000;
  const vendor_id = source.vendor_id;
  const brandPrefix = 'Elysium';

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
 * Searches Elysium site for product and extracts images/specs.
 * Strategy: Use autocomplete endpoint or build product URL from name.
 */
async function findProductOnSite(page, group, delayMs) {
  const searchName = group.name.trim();

  // Try autocomplete endpoint first
  try {
    const autocompleteUrl = `${BASE_URL}/autocomplete.php?q=${encodeURIComponent(searchName)}`;
    const response = await page.goto(autocompleteUrl, { waitUntil: 'networkidle2', timeout: 15000 });
    const json = await response.json();

    if (json && json.length > 0) {
      const match = json.find(item =>
        item.name && item.name.toLowerCase().includes(searchName.toLowerCase())
      );

      if (match && match.url) {
        await page.goto(match.url, { waitUntil: 'networkidle2', timeout: 30000 });
        await delay(delayMs);
        return await extractProductData(page);
      }
    }
  } catch (err) {
    // Fallback to direct URL construction
  }

  // Build product URL from name (query-based)
  const productUrl = `${BASE_URL}/product?id=${encodeURIComponent(searchName)}`;

  try {
    await page.goto(productUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    await delay(delayMs);

    // Check if product page loaded successfully
    const notFound = await page.evaluate(() => {
      const text = document.body.innerText.toLowerCase();
      return text.includes('not found') || text.includes('no product');
    });

    if (notFound) {
      return null;
    }

    return await extractProductData(page);
  } catch (err) {
    return null;
  }
}

/**
 * Extracts product images, description, and specs from Elysium product page.
 */
async function extractProductData(page) {
  return await page.evaluate(() => {
    const images = [];
    const specs = {};

    // Extract images from product detail page
    document.querySelectorAll('img[src*="/static/images/product/"]').forEach(img => {
      let src = img.src;
      if (!src.includes('logo') && !src.includes('icon') && !images.includes(src)) {
        images.push(src);
      }
    });

    // Look for gallery or lightbox images
    document.querySelectorAll('a[href*="/static/images/product/"]').forEach(link => {
      let href = link.href;
      if (!href.includes('logo') && !href.includes('icon') && !images.includes(href)) {
        images.push(href);
      }
    });

    // Extract description
    const descEl = document.querySelector('.product-description, .description, [class*="desc"]');
    const description = descEl ? descEl.innerText.trim() : null;

    // Extract specs from page content
    const text = document.body.innerText.toLowerCase();

    // Material
    if (text.includes('porcelain')) specs.material = 'Porcelain';
    else if (text.includes('ceramic')) specs.material = 'Ceramic';
    else if (text.includes('glass')) specs.material = 'Glass';
    else if (text.includes('stone')) specs.material = 'Stone';

    // Finish
    if (text.includes('polished')) specs.finish = 'Polished';
    else if (text.includes('matte')) specs.finish = 'Matte';
    else if (text.includes('honed')) specs.finish = 'Honed';
    else if (text.includes('glossy')) specs.finish = 'Glossy';

    // Color (look for common color keywords)
    const colors = ['white', 'black', 'gray', 'grey', 'beige', 'brown', 'blue', 'green'];
    for (const color of colors) {
      if (text.includes(color)) {
        specs.color = color.charAt(0).toUpperCase() + color.slice(1);
        break;
      }
    }

    // Size extraction
    const sizeMatch = text.match(/(\d+)\s*[x×]\s*(\d+)/);
    if (sizeMatch) {
      specs.size = `${sizeMatch[1]}x${sizeMatch[2]}`;
    }

    // PEI rating for tile
    const peiMatch = text.match(/pei\s*[:\-]?\s*(\d)/i);
    if (peiMatch) {
      specs.pei_rating = peiMatch[1];
    }

    return {
      images,
      description,
      specs: Object.keys(specs).length > 0 ? specs : null
    };
  });
}
