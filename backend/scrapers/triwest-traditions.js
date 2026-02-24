import {
  launchBrowser, delay, upsertMediaAsset, upsertSkuAttribute,
  appendLog, addJobError, downloadImage, resolveImageExtension, preferProductShot
} from './base.js';

const BASE_URL = 'https://www.traditionsflooring.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_ERRORS = 30;

/**
 * Traditions enrichment scraper for Tri-West.
 *
 * Scrapes traditionsflooring.com for product images, descriptions, and specs.
 * Enriches EXISTING Tri-West SKUs — never creates new products.
 * Tech: Unknown (small brand)
 *
 * Runs AFTER triwest-catalog.js populates SKUs in the DB.
 */
export async function run(pool, job, source) {
  const config = source.config || {};
  const delayMs = config.delay_ms || 2000;
  const vendor_id = source.vendor_id;
  const brandPrefix = 'Traditions';

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
 * Attempts to find product on Traditions site.
 * Returns { images: [], description: string, specs: {} } or null.
 */
async function findProductOnSite(page, group, delayMs) {
  try {
    const searchTerms = [
      group.name,
      group.collection.replace(/^Traditions\s*/i, '').trim(),
      group.skus[0]?.variant_name
    ].filter(Boolean);

    // Strategy 1: Navigate to products/collections
    try {
      await page.goto(BASE_URL, { waitUntil: 'networkidle2', timeout: 10000 });
      await delay(1000);

      // Look for product links
      const productLinks = await page.$$eval('a[href*="product"], a[href*="collection"], a[href*="floor"], a[href*="catalog"]', links =>
        links.map(a => ({ text: a.textContent.trim(), href: a.href }))
      );

      if (productLinks.length > 0) {
        for (const term of searchTerms) {
          const match = productLinks.find(link =>
            link.text.toLowerCase().includes(term.toLowerCase()) ||
            link.href.toLowerCase().includes(term.toLowerCase().replace(/\s+/g, '-'))
          );

          if (match) {
            await page.goto(match.href, { waitUntil: 'networkidle2', timeout: 10000 });
            await delay(1000);

            const data = await extractProductData(page, group.name);
            if (data) return data;
          }
        }
      }
    } catch (navErr) {
      // Navigation failed
    }

    // Strategy 2: Try search
    try {
      const hasSearch = await page.$('input[type="search"], input[name*="search"], input[id*="search"]');
      if (hasSearch) {
        await page.type('input[type="search"], input[name*="search"], input[id*="search"]', searchTerms[0]);
        await Promise.race([
          page.waitForNavigation({ timeout: 5000 }),
          page.keyboard.press('Enter')
        ]);
        await delay(1000);

        const data = await extractProductData(page, group.name);
        if (data) return data;
      }
    } catch (searchErr) {
      // Search failed
    }

    // Strategy 3: Generic extraction
    const genericData = await extractProductData(page, group.name);
    return genericData;

  } catch (err) {
    return null;
  }
}

/**
 * Extracts product data from current page.
 */
async function extractProductData(page, productName) {
  try {
    const images = await page.$$eval('img', imgs =>
      imgs
        .map(img => img.src || img.dataset.src || img.dataset.image)
        .filter(src => src &&
          src.startsWith('http') &&
          !src.includes('logo') &&
          !src.includes('icon') &&
          !src.includes('banner') &&
          !src.includes('nav') &&
          !src.includes('menu') &&
          (src.includes('.jpg') || src.includes('.jpeg') || src.includes('.png') || src.includes('.webp'))
        )
    );

    const description = await page.evaluate(() => {
      const selectors = ['.product-description', '.description', 'p', 'article p', '.product-details', '.content'];
      for (const sel of selectors) {
        const elem = document.querySelector(sel);
        if (elem && elem.textContent.trim().length > 50) {
          return elem.textContent.trim();
        }
      }
      return null;
    });

    const specs = {};
    try {
      const specText = await page.evaluate(() => document.body.innerText);

      // Generic flooring specs extraction
      const thicknessMatch = specText.match(/thickness[:\s]+([0-9/.]+\s*(?:mm|inch|in))/i);
      if (thicknessMatch) specs.thickness = thicknessMatch[1].trim();

      const widthMatch = specText.match(/width[:\s]+([0-9/.]+\s*(?:mm|inch|in|"))/i);
      if (widthMatch) specs.width = widthMatch[1].trim();

      const lengthMatch = specText.match(/length[:\s]+([0-9/.]+\s*(?:mm|inch|in|ft|'))/i);
      if (lengthMatch) specs.length = lengthMatch[1].trim();

      const wearMatch = specText.match(/wear\s+layer[:\s]+([0-9.]+\s*(?:mm|mil))/i);
      if (wearMatch) specs.wear_layer = wearMatch[1].trim();

      const finishMatch = specText.match(/finish[:\s]+([a-z\s]+)/i);
      if (finishMatch) specs.finish = finishMatch[1].trim();

      const installMatch = specText.match(/installation[:\s]+([a-z\s]+)/i);
      if (installMatch) specs.installation_method = installMatch[1].trim();

      const speciesMatch = specText.match(/species[:\s]+([a-z\s]+)/i);
      if (speciesMatch) specs.species = speciesMatch[1].trim();
    } catch (specErr) {
      // Specs extraction failed
    }

    if (images.length === 0 && !description && Object.keys(specs).length === 0) {
      return null;
    }

    return {
      images: images.length > 0 ? images : null,
      description,
      specs: Object.keys(specs).length > 0 ? specs : null
    };
  } catch (err) {
    return null;
  }
}
