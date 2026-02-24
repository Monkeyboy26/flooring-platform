import {
  launchBrowser, delay, upsertMediaAsset, upsertSkuAttribute,
  appendLog, addJobError, downloadImage, resolveImageExtension, preferProductShot
} from './base.js';

const BASE_URL = 'https://www.grandpacifichardwood.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_ERRORS = 30;

/**
 * Grand Pacific enrichment scraper for Tri-West.
 *
 * Scrapes grandpacifichardwood.com for product images, descriptions, and specs.
 * Enriches EXISTING Tri-West SKUs — never creates new products.
 * Tech: Squarespace
 *
 * Runs AFTER triwest-catalog.js populates SKUs in the DB.
 */
export async function run(pool, job, source) {
  const config = source.config || {};
  const delayMs = config.delay_ms || 2000;
  const vendor_id = source.vendor_id;
  const brandPrefix = 'Grand Pacific';

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
 * Find a product on grandpacifichardwood.com and extract images/specs.
 * Returns { images: string[], description: string, specs: object } or null.
 *
 * Grand Pacific is a Squarespace site. Small catalog (~27 products).
 * Product URLs: /{color-slug} (e.g., /stingray, /rip-tide, /beach-hut)
 * Images: images.squarespace-cdn.com
 * Specs: structured text — Species, Thickness, Width, Length, Veneer, Finish, etc.
 */
async function findProductOnSite(page, productGroup, delayMs) {
  const colorName = productGroup.name;
  const slug = colorName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

  try {
    // Try direct product page by slug
    await page.goto(`${BASE_URL}/${slug}`, {
      waitUntil: 'networkidle2',
      timeout: 15000,
    });
    await delay(delayMs);

    // Check if we landed on a valid product page (not 404)
    const is404 = await page.evaluate(() => {
      const body = document.body?.textContent || '';
      return body.includes('page not found') || body.includes('404') || document.title.includes('Page Not Found');
    });

    if (is404) {
      // Fallback: browse the homepage and find a matching product link
      return await findProductViaNavigation(page, productGroup, delayMs);
    }

    return await extractProductData(page, colorName);
  } catch {
    return await findProductViaNavigation(page, productGroup, delayMs);
  }
}

/** Extract product data from a Grand Pacific product page */
async function extractProductData(page, colorName) {
  const data = await page.evaluate((name) => {
    const images = [];
    // Squarespace product images
    document.querySelectorAll('img[src*="squarespace-cdn"], img[data-src*="squarespace-cdn"]').forEach(img => {
      const src = img.src || img.dataset.src || img.dataset.image;
      if (src && !src.includes('logo') && !src.includes('favicon')) {
        images.push(src.split('?')[0] + '?format=1500w');
      }
    });
    // Also check noscript and background images
    document.querySelectorAll('[data-image], [style*="background-image"]').forEach(el => {
      const bgUrl = el.dataset.image || (el.style.backgroundImage || '').match(/url\(["']?([^"')]+)/)?.[1];
      if (bgUrl && bgUrl.includes('squarespace-cdn') && !bgUrl.includes('logo')) {
        images.push(bgUrl.split('?')[0] + '?format=1500w');
      }
    });

    // Extract specs from page text — Grand Pacific uses structured text blocks
    const specs = {};
    const textContent = document.body?.innerText || '';
    const lines = textContent.split('\n').map(l => l.trim()).filter(Boolean);

    for (const line of lines) {
      const lower = line.toLowerCase();
      // Match "Label: Value" or "Label - Value" patterns
      const match = line.match(/^(species|thickness|width|length|veneer|finish|construction|warranty|item\s*number|grade)[:\s-]+(.+)/i);
      if (match) {
        const label = match[1].toLowerCase().trim();
        const value = match[2].trim();
        if (label.includes('species')) specs.material = value;
        if (label.includes('thickness')) specs.thickness = value;
        if (label.includes('width')) specs.size = value;
        if (label.includes('length')) specs.length = value;
        if (label.includes('veneer')) specs.veneer = value;
        if (label.includes('finish')) specs.finish = value;
        if (label.includes('construction')) specs.construction = value;
        if (label.includes('warranty')) specs.warranty = value;
        if (label.includes('item')) specs.item_number = value;
      }
    }

    // Extract description from the page
    const descEl = document.querySelector('.sqs-block-content p, .sqs-layout p, article p');
    const description = descEl ? descEl.textContent.trim().slice(0, 2000) : null;

    // Deduplicate images
    const unique = [...new Set(images)];
    return { images: unique, description, specs: Object.keys(specs).length > 0 ? specs : null };
  }, colorName);

  if (data.images.length === 0 && !data.description && !data.specs) return null;
  return data;
}

/** Fallback: navigate pages to find matching product */
async function findProductViaNavigation(page, productGroup, delayMs) {
  const colorName = productGroup.name;
  try {
    await page.goto(BASE_URL, { waitUntil: 'networkidle2', timeout: 15000 });
    await delay(delayMs);

    // Find a link whose text matches the color name
    const productUrl = await page.evaluate((name) => {
      const nameLower = name.toLowerCase();
      const links = document.querySelectorAll('a[href]');
      for (const a of links) {
        const text = (a.textContent || '').trim().toLowerCase();
        const href = a.getAttribute('href') || '';
        if (text.includes(nameLower) || href.includes(nameLower.replace(/\s+/g, '-'))) {
          return a.href;
        }
      }
      return null;
    }, colorName);

    if (!productUrl) return null;

    await page.goto(productUrl, { waitUntil: 'networkidle2', timeout: 15000 });
    await delay(delayMs);

    return await extractProductData(page, colorName);
  } catch {
    return null;
  }
}
