import {
  launchBrowser, delay, upsertMediaAsset, upsertSkuAttribute,
  appendLog, addJobError, downloadImage, resolveImageExtension, preferProductShot
} from './base.js';

const BASE_URL = 'https://www.stantoncarpet.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_ERRORS = 30;

/**
 * Stanton enrichment scraper for Tri-West.
 *
 * Scrapes stantoncarpet.com for product images, descriptions, and specs.
 * Enriches EXISTING Tri-West SKUs — never creates new products.
 * Tech: LANSA + WordPress, Brandfolder CDN
 *
 * Runs AFTER triwest-catalog.js populates SKUs in the DB.
 */
export async function run(pool, job, source) {
  const config = source.config || {};
  const delayMs = config.delay_ms || 2000;
  const vendor_id = source.vendor_id;
  const brandPrefix = 'Stanton';

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
 * Find a product on stantoncarpet.com and extract images/specs.
 * Returns { images: string[], description: string, specs: object } or null.
 *
 * Stanton Carpet (covers carpet, hardwood, LVP, laminate).
 * LANSA backend (IBM AS/400) + WordPress frontend.
 * Server-rendered HTML — no heavy client-side rendering.
 *
 * Hardwood products: /finehardwood (listing page)
 * Product detail: /product/{STYLE_NAME}/{COLOR_NAME}
 * Search: /search/all or /search/{brand}
 * Images: Brandfolder CDN at cdn.bfldr.com/PMOA7OGQ/
 * Main image: img#main-product-image
 * Specs: ul.list-group.product-details-list
 * Title: h1.h1.title
 * Brands: Stanton, Stanton Hard Surface, Antrim, Rosecore, Crescent, Cavan
 */
async function findProductOnSite(page, productGroup, delayMs) {
  const firstSku = productGroup.skus[0];
  const vendorSku = firstSku.vendor_sku || '';
  const colorName = productGroup.name;
  // Strip brand prefix: "Stanton Whatever" → "Whatever"
  const collection = productGroup.collection.replace(/^Stanton\s*/i, '').trim();

  // Build product URL — LANSA uses UPPERCASE style/color names
  // Both /product/ and /products/ work; LANSA paths are case-insensitive
  const styleSlug = collection.replace(/\s+/g, ' ').trim().toUpperCase();
  const colorSlug = colorName.replace(/\s+/g, ' ').trim().toUpperCase();

  let loaded = false;

  // Attempt 1: Direct product URL (try both /products/ and /product/)
  if (styleSlug && colorSlug) {
    for (const prefix of ['/products/', '/product/']) {
      if (loaded) break;
      try {
        const url = `${BASE_URL}${prefix}${encodeURIComponent(styleSlug)}/${encodeURIComponent(colorSlug)}`;
        const response = await page.goto(url, { waitUntil: 'networkidle2', timeout: 15000 });
        await delay(delayMs);
        const pageUrl = page.url();
        if (response && response.status() === 200 && (pageUrl.includes('/product') || pageUrl.includes('/products'))) {
          const hasProduct = await page.evaluate(() => !!document.querySelector('img#main-product-image, .prddtl-main-image, h1.title'));
          if (hasProduct) loaded = true;
        }
      } catch { /* try next */ }
    }
  }

  // Attempt 2: Try with just style name (some pages list all colors)
  if (!loaded && styleSlug) {
    try {
      const url = `${BASE_URL}/products/${encodeURIComponent(styleSlug)}`;
      const response = await page.goto(url, { waitUntil: 'networkidle2', timeout: 15000 });
      await delay(delayMs);
      if (response && response.status() === 200 && page.url().includes('/product')) {
        loaded = true;
      }
    } catch { /* try fallback */ }
  }

  // Attempt 3: Browse finehardwood page and find matching link
  if (!loaded) {
    try {
      await page.goto(`${BASE_URL}/finehardwood`, { waitUntil: 'networkidle2', timeout: 15000 });
      await delay(delayMs);

      const productUrl = await page.evaluate((color, style) => {
        const colorLower = color.toLowerCase();
        const styleLower = style.toLowerCase();
        const links = document.querySelectorAll('a[href*="/product/"]');
        for (const a of links) {
          const text = a.textContent.toLowerCase();
          const href = a.getAttribute('href') || '';
          if (text.includes(colorLower) || href.toLowerCase().includes(colorLower.replace(/\s+/g, '%20'))) {
            return a.href;
          }
        }
        for (const a of links) {
          const text = a.textContent.toLowerCase();
          if (text.includes(styleLower)) return a.href;
        }
        return null;
      }, colorName, collection);

      if (productUrl) {
        await page.goto(productUrl, { waitUntil: 'networkidle2', timeout: 15000 });
        await delay(delayMs);
        loaded = true;
      }
    } catch { /* give up */ }
  }

  if (!loaded) return null;

  const data = await page.evaluate(() => {
    // 1. Images — Brandfolder CDN at cdn.bfldr.com/PMOA7OGQ/
    const images = [];
    const seen = new Set();

    // Primary product image (LANSA selector: img#main-product-image.prddtl-main-image)
    const mainImg = document.querySelector('img#main-product-image, img.prddtl-main-image');
    if (mainImg) {
      const src = mainImg.src || mainImg.dataset?.src || '';
      if (src && src.includes('cdn.bfldr.com')) {
        seen.add(src);
        images.push(src);
      }
    }

    // Room scene images from owl-carousel slider
    document.querySelectorAll('.room-scenes-slider img, .owl-carousel .item img').forEach(img => {
      const src = img.src || img.dataset?.src || '';
      if (src && src.includes('cdn.bfldr.com') && !seen.has(src)) {
        seen.add(src);
        images.push(src);
      }
    });

    // All other Brandfolder CDN images on the page
    document.querySelectorAll('img[src*="cdn.bfldr.com"]').forEach(img => {
      const src = img.src || '';
      if (!seen.has(src) && !src.includes('Logo') && !src.includes('logo') && !src.includes('Icon') && !src.includes('Stanton_Logo')) {
        seen.add(src);
        images.push(src);
      }
    });

    // Available color swatch images (smaller, but useful as alternates)
    document.querySelectorAll('#WL_AVAILABLECOLORS_NOT_SWATCH img.item-image').forEach(img => {
      const src = img.src || '';
      if (src && src.includes('cdn.bfldr.com') && !seen.has(src)) {
        seen.add(src);
        images.push(src);
      }
    });

    // 2. Description from product page
    let description = null;
    const titleEl = document.querySelector('h1.title, h1.h1.title, .product-title h1');
    const descEl = document.querySelector('.product-description, [class*="description"] p, .product-info p');
    if (descEl) {
      description = descEl.textContent.trim().slice(0, 2000);
    } else if (titleEl) {
      // Use title + any subtitle as description fallback
      const subtitle = document.querySelector('h2, .product-subtitle');
      description = titleEl.textContent.trim() + (subtitle ? '. ' + subtitle.textContent.trim() : '');
    }

    // 3. Specs from product-details-list (LANSA renders with span class pairs)
    const specs = {};
    document.querySelectorAll('ul.list-group.product-details-list li.list-group-item').forEach(li => {
      // LANSA format: <span class="prod-dtl-list-item-span-a">Label:</span>
      //               <span class="prod-dtl-list-item-span-b">Value</span>
      const labelEl = li.querySelector('.prod-dtl-list-item-span-a');
      const valueEl = li.querySelector('.prod-dtl-list-item-span-b');
      if (labelEl && valueEl) {
        const label = labelEl.textContent.replace(/:$/, '').trim().toLowerCase();
        const value = valueEl.textContent.trim();
        if (!value) return;
        if (label.includes('construction')) specs.construction = value;
        if (label.includes('width')) specs.size = value;
        if (label.includes('fiber') || label.includes('species') || label.includes('material')) specs.material = value;
        if (label.includes('finish')) specs.finish = value;
        if (label.includes('edge')) specs.edge = value;
        if (label.includes('wear layer')) specs.wear_layer = value;
        if (label.includes('grade')) specs.grade = value;
        if (label.includes('pattern repeat')) specs.pattern_repeat = value;
        if (label.includes('collection')) specs.collection = value;
      } else {
        // Fallback: colon-split text content
        const text = li.textContent.trim();
        const colonSplit = text.split(':');
        if (colonSplit.length >= 2) {
          const label = colonSplit[0].trim().toLowerCase();
          const value = colonSplit.slice(1).join(':').trim();
          if (label.includes('construction')) specs.construction = value;
          if (label.includes('width')) specs.size = value;
          if (label.includes('fiber') || label.includes('species')) specs.material = value;
          if (label.includes('finish')) specs.finish = value;
        }
      }
    });

    return { images, description, specs: Object.keys(specs).length > 0 ? specs : null };
  });

  if (data.images.length === 0 && !data.description && !data.specs) return null;
  return data;
}
