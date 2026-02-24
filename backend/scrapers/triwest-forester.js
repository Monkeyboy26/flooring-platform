import {
  launchBrowser, delay, upsertMediaAsset, upsertSkuAttribute,
  appendLog, addJobError, downloadImage, resolveImageExtension, preferProductShot
} from './base.js';

const BASE_URL = 'https://www.paramountflooring.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_ERRORS = 30;

/**
 * Forester enrichment scraper for Tri-West.
 *
 * Scrapes paramountflooring.com for product images, descriptions, and specs.
 * Enriches EXISTING Tri-West SKUs — never creates new products.
 * Tech: Custom (Paramount Flooring parent site)
 *
 * Runs AFTER triwest-catalog.js populates SKUs in the DB.
 */
export async function run(pool, job, source) {
  const config = source.config || {};
  const delayMs = config.delay_ms || 2000;
  const vendor_id = source.vendor_id;
  const brandPrefix = 'Forester';

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
 * Searches Paramount site for Forester products and extracts images/specs.
 * Strategy: Navigate to Forester collection page, extract from product listings.
 */
async function findProductOnSite(page, group, delayMs) {
  const searchName = group.name.trim();

  // Try common Forester product page paths
  const foresterPaths = [
    '/products/solid-hardwood/forester/',
    '/products/forester/',
    '/forester/',
    '/collections/forester/',
  ];

  let foresterPageFound = false;

  for (const path of foresterPaths) {
    try {
      await page.goto(`${BASE_URL}${path}`, { waitUntil: 'networkidle2', timeout: 30000 });
      await delay(delayMs);

      const notFound = await page.evaluate(() => {
        const text = document.body.innerText.toLowerCase();
        return text.includes('404') || text.includes('not found');
      });

      if (!notFound) {
        foresterPageFound = true;
        break;
      }
    } catch (err) {
      continue;
    }
  }

  // Fallback: search for Forester in products
  if (!foresterPageFound) {
    try {
      await page.goto(`${BASE_URL}/products/`, { waitUntil: 'networkidle2', timeout: 30000 });
      await delay(delayMs);

      // Look for Forester link
      const foresterLink = await page.evaluate(() => {
        const links = Array.from(document.querySelectorAll('a'));
        for (const link of links) {
          const text = link.innerText.toLowerCase();
          if (text.includes('forester')) {
            return link.href;
          }
        }
        return null;
      });

      if (foresterLink) {
        await page.goto(foresterLink, { waitUntil: 'networkidle2', timeout: 30000 });
        await delay(delayMs);
        foresterPageFound = true;
      }
    } catch (err) {
      // Continue anyway
    }
  }

  if (!foresterPageFound) {
    return null;
  }

  // Now search for the specific product on the Forester page
  const productData = await page.evaluate((name) => {
    const images = [];
    const specs = {};
    let description = null;

    // Find product card or section matching the name
    const allElements = Array.from(document.querySelectorAll('*'));
    let productSection = null;

    for (const el of allElements) {
      const text = el.innerText?.toLowerCase() || '';
      if (text.includes(name.toLowerCase()) && el.querySelector('img')) {
        productSection = el;
        break;
      }
    }

    if (productSection) {
      // Extract images from product section
      productSection.querySelectorAll('img').forEach(img => {
        let src = img.src || img.dataset.src;
        if (src && !src.includes('logo') && !src.includes('icon') && !images.includes(src)) {
          images.push(src);
        }
      });

      // Extract description
      const descEl = productSection.querySelector('.description, [class*="desc"], p');
      if (descEl) {
        description = descEl.innerText.trim();
      }
    }

    // If no specific product section found, collect all Forester images
    if (images.length === 0) {
      document.querySelectorAll('img').forEach(img => {
        let src = img.src || img.dataset.src;
        const alt = img.alt?.toLowerCase() || '';
        if (src && !src.includes('logo') && !src.includes('icon') &&
            (alt.includes('forester') || alt.includes(name.toLowerCase())) &&
            !images.includes(src)) {
          images.push(src);
        }
      });
    }

    // Extract specs from page content
    const text = document.body.innerText.toLowerCase();

    // Material (Forester is primarily Hard Maple)
    if (text.includes('hard maple')) specs.material = 'Hard Maple';
    else if (text.includes('maple')) specs.material = 'Maple';
    else if (text.includes('hardwood')) specs.material = 'Hardwood';

    // Construction
    if (text.includes('solid')) specs.construction = 'Solid';

    // Finish
    if (text.includes('urethane')) specs.finish = 'Urethane';
    else if (text.includes('oil-based')) specs.finish = 'Oil-Based';
    else if (text.includes('water-based')) specs.finish = 'Water-Based';

    // Width
    const widthMatch = text.match(/(\d+\.?\d*)\s*(?:inch|in|")\s*wide/i);
    if (widthMatch) {
      specs.width = `${widthMatch[1]}"`;
    }

    // Thickness
    const thickMatch = text.match(/(\d+\/\d+)\s*(?:inch|in|")\s*thick/i);
    if (thickMatch) {
      specs.thickness = `${thickMatch[1]}"`;
    }

    // Origin (Canadian)
    if (text.includes('canadian') || text.includes('canada')) {
      specs.origin = 'Canada';
    }

    return {
      images,
      description,
      specs: Object.keys(specs).length > 0 ? specs : null
    };
  }, searchName);

  return productData.images.length > 0 || productData.description ? productData : null;
}
