import {
  launchBrowser, delay, upsertMediaAsset, upsertSkuAttribute,
  appendLog, addJobError, downloadImage, resolveImageExtension, preferProductShot
} from './base.js';

const BASE_URL = 'https://www.californiaclassicsfloors.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_ERRORS = 30;

/**
 * California Classics enrichment scraper for Tri-West.
 *
 * Scrapes californiaclassicsfloors.com for product images, descriptions, and specs.
 * Enriches EXISTING Tri-West SKUs — never creates new products.
 * Tech: ASP.NET WebForms
 *
 * Runs AFTER triwest-catalog.js populates SKUs in the DB.
 */
export async function run(pool, job, source) {
  const config = source.config || {};
  const delayMs = config.delay_ms || 2000;
  const vendor_id = source.vendor_id;
  const brandPrefix = 'California Classics';

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
 * Find a product on californiaclassicsfloors.com and extract images/specs.
 * Returns { images: string[], description: string, specs: object } or null.
 *
 * California Classics is an ASP.NET WebForms site.
 * Product URLs: /hardwood-flooring/{Collection}/{Species}/{Color}-flooring.aspx
 * Collection URLs: /hardwood-flooring/{Collection}-hardwood-flooring.aspx
 * Images: self-hosted — #imgRollClient (main), .flexslider (carousel), #owl-example (thumbnails)
 * Specs: unstructured <li> text — parse "5/8" thick x 9.4" wide" patterns
 * Collections: Louvre, Mediterranean, Mediterranean 9.5, Timeless Classics, Taverne
 */
async function findProductOnSite(page, productGroup, delayMs) {
  const colorName = productGroup.name;
  const collection = productGroup.collection;
  const collectionName = collection.replace(/^California\s*Classics\s*/i, '').trim();

  // Build ASP.NET URL: /hardwood-flooring/{Collection}/{Species}/{Color}-flooring.aspx
  // Species is typically "French Oak" or "European White Oak" — we'll try common ones
  const colorUrlPart = colorName.replace(/\s+/g, '-');
  const collectionUrlPart = collectionName.replace(/\s+/g, '-');

  try {
    // Strategy 1: Navigate to collection page and find product link
    const found = await findCalClassicsViaCollection(page, productGroup, delayMs, collectionUrlPart);
    if (found) return found;

    // Strategy 2: Try common species in the URL pattern
    const species = ['French-Oak', 'European-White-Oak', 'White-Oak', 'Oak', 'Walnut', 'Hickory'];
    for (const sp of species) {
      const url = `${BASE_URL}/hardwood-flooring/${collectionUrlPart}/${sp}/${colorUrlPart}-flooring.aspx`;
      const result = await tryCalClassicsPage(page, url, delayMs);
      if (result) return result;
    }

    // Strategy 3: Try without species segment
    const result = await tryCalClassicsPage(page, `${BASE_URL}/hardwood-flooring/${collectionUrlPart}/${colorUrlPart}-flooring.aspx`, delayMs);
    if (result) return result;

    return null;
  } catch {
    return null;
  }
}

/** Try loading a California Classics page */
async function tryCalClassicsPage(page, url, delayMs) {
  try {
    const resp = await page.goto(url, { waitUntil: 'networkidle2', timeout: 15000 });
    if (!resp || resp.status() >= 400) return null;
    await delay(delayMs);

    // Check for valid product page
    const hasContent = await page.evaluate(() => {
      return document.querySelector('#imgRollClient, .flexslider, #owl-example, img[src*="swatch"], img[src*="rooms_"]') !== null;
    });

    if (!hasContent) return null;

    return await extractCalClassicsData(page);
  } catch {
    return null;
  }
}

/** Extract product data from a California Classics product page */
async function extractCalClassicsData(page) {
  const data = await page.evaluate(() => {
    const images = [];
    const baseUrl = window.location.origin;

    // Main zoomable image (#imgRollClient)
    const mainImg = document.querySelector('#imgRollClient');
    if (mainImg) {
      const src = mainImg.src || mainImg.dataset.src;
      if (src) images.push(new URL(src, baseUrl).href);
    }

    // Flexslider carousel images
    document.querySelectorAll('.flexslider img, .flex-slides img').forEach(img => {
      const src = img.src || img.dataset.src;
      if (src) images.push(new URL(src, baseUrl).href);
    });

    // Owl carousel thumbnails
    document.querySelectorAll('#owl-example img, .owl-carousel img').forEach(img => {
      const src = img.src || img.dataset.src;
      if (src) images.push(new URL(src, baseUrl).href);
    });

    // Room scene and swatch images
    document.querySelectorAll('img[src*="swatch_"], img[src*="rooms_"], img[src*="NewStyleImage"]').forEach(img => {
      const src = img.src || img.dataset.src;
      if (src) images.push(new URL(src, baseUrl).href);
    });

    // General content images
    document.querySelectorAll('.content-area img, .product-detail img, article img').forEach(img => {
      const src = img.src || img.dataset.src;
      if (src && !src.includes('logo') && !src.includes('icon') && !src.includes('btn_') && !src.includes('nav_')) {
        images.push(new URL(src, baseUrl).href);
      }
    });

    // Extract specs from <li> elements (unstructured text)
    const specs = {};
    const allText = document.body?.innerText || '';

    // Parse dimension patterns like '5/8" thick x 9.4" wide'
    const thicknessMatch = allText.match(/(\d+\/\d+"?\s*(?:thick|Thick))/);
    if (thicknessMatch) specs.thickness = thicknessMatch[1].trim();

    const widthMatch = allText.match(/(\d+\.?\d*"?\s*(?:wide|Wide))/);
    if (widthMatch) specs.size = widthMatch[1].trim();

    // Parse from list items
    document.querySelectorAll('li, .spec-item, .product-spec').forEach(li => {
      const text = li.textContent.trim();
      const lower = text.toLowerCase();

      if (lower.includes('thick') && !specs.thickness) {
        const m = text.match(/(\d+\/\d+"?\s*thick)/i);
        if (m) specs.thickness = m[1];
      }
      if (lower.includes('wide') && !specs.size) {
        const m = text.match(/(\d+\.?\d*"?\s*wide)/i);
        if (m) specs.size = m[1];
      }
      if (lower.includes('species') || lower.includes('wood')) {
        const m = text.match(/(?:species|wood)[:\s-]+(.+)/i);
        if (m) specs.material = m[1].trim();
      }
      if (lower.includes('finish')) {
        const m = text.match(/finish[:\s-]+(.+)/i);
        if (m) specs.finish = m[1].trim();
      }
      if (lower.includes('grade')) {
        const m = text.match(/grade[:\s-]+(.+)/i);
        if (m) specs.grade = m[1].trim();
      }
      if (lower.includes('warranty')) {
        const m = text.match(/warranty[:\s-]+(.+)/i);
        if (m) specs.warranty = m[1].trim();
      }
      if (lower.includes('sq') && lower.includes('ft') && lower.includes('carton')) {
        const m = text.match(/([\d.]+)\s*(?:sq\.?\s*ft)/i);
        if (m) specs.sqft_per_carton = m[1];
      }
    });

    // Description
    const descEl = document.querySelector('.product-description, .content-area p, article p');
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

/** Browse collection page to find product links */
async function findCalClassicsViaCollection(page, productGroup, delayMs, collectionUrlPart) {
  const colorName = productGroup.name;
  try {
    const collectionUrl = `${BASE_URL}/hardwood-flooring/${collectionUrlPart}-hardwood-flooring.aspx`;
    await page.goto(collectionUrl, { waitUntil: 'networkidle2', timeout: 15000 });
    await delay(delayMs);

    const productUrl = await page.evaluate((name) => {
      const nameLower = name.toLowerCase();
      const links = document.querySelectorAll('a[href*="flooring.aspx"], a[href*="/hardwood-flooring/"]');
      for (const a of links) {
        const text = (a.textContent || '').toLowerCase();
        const href = (a.getAttribute('href') || '').toLowerCase();
        if (text.includes(nameLower) || href.includes(nameLower.replace(/\s+/g, '-').toLowerCase())) {
          return a.href;
        }
      }
      return null;
    }, colorName);

    if (!productUrl) return null;

    await page.goto(productUrl, { waitUntil: 'networkidle2', timeout: 15000 });
    await delay(delayMs);

    return await extractCalClassicsData(page);
  } catch {
    return null;
  }
}
