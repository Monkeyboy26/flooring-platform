import {
  launchBrowser, delay, upsertMediaAsset, upsertSkuAttribute,
  appendLog, addJobError, downloadImage, resolveImageExtension, preferProductShot
} from './base.js';

const BASE_URL = 'https://www.us.quick-step.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_ERRORS = 30;

/**
 * Quick-Step enrichment scraper for Tri-West.
 *
 * Scrapes us.quick-step.com for product images, descriptions, and specs.
 * Enriches EXISTING Tri-West SKUs — never creates new products.
 * Tech: Angular SPA (Mohawk/Unilin)
 *
 * Runs AFTER triwest-catalog.js populates SKUs in the DB.
 */
export async function run(pool, job, source) {
  const config = source.config || {};
  const delayMs = config.delay_ms || 2000;
  const vendor_id = source.vendor_id;
  const brandPrefix = 'Quick-Step';

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
 * Find a product on us.quick-step.com and extract images/specs.
 * Returns { images: string[], description: string, specs: object } or null.
 *
 * Quick-Step is an Angular SPA (Mohawk/Unilin).
 * Product URLs: /en-us/laminate/{collection}/{color-name}--{sku}
 * Heavy Angular SPA — needs waitForSelector + extra delay for client-side rendering.
 * Specs: .two-column-compound__column sections, quickstep-rich-text components
 */
async function findProductOnSite(page, productGroup, delayMs) {
  const colorName = productGroup.name;
  const collection = productGroup.collection;
  const firstSku = productGroup.skus[0];
  const vendorSku = (firstSku.vendor_sku || '').toLowerCase();

  // Strip brand prefix from collection
  const collectionName = collection.replace(/^Quick-?Step\s*/i, '').trim();
  const collectionSlug = collectionName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  const colorSlug = colorName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

  try {
    // Strategy 1: Build direct URL with SKU suffix
    if (vendorSku) {
      const url = `${BASE_URL}/en-us/laminate/${collectionSlug}/${colorSlug}--${vendorSku}`;
      const found = await tryQuickStepPage(page, url, delayMs);
      if (found) return found;
    }

    // Strategy 2: Try URL without SKU suffix
    const found = await tryQuickStepPage(page, `${BASE_URL}/en-us/laminate/${collectionSlug}/${colorSlug}`, delayMs);
    if (found) return found;

    // Strategy 3: Quick-Step also has vinyl and hardwood categories
    for (const category of ['vinyl', 'hardwood']) {
      const result = await tryQuickStepPage(page, `${BASE_URL}/en-us/${category}/${collectionSlug}/${colorSlug}`, delayMs);
      if (result) return result;
    }

    // Strategy 4: Browse collection page and find the product
    return await findQuickStepViaCollection(page, productGroup, delayMs, collectionSlug);
  } catch {
    return null;
  }
}

/** Try loading a Quick-Step Angular page with extra wait time */
async function tryQuickStepPage(page, url, delayMs) {
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 25000 });
    // Angular SPA needs extra time to render
    await delay(delayMs + 2000);

    // Wait for Angular to render product content
    try {
      await page.waitForSelector('img[src*="quick-step"], img[src*="floor"], .product-detail, quickstep-rich-text', { timeout: 8000 });
    } catch {
      // If no product elements found, this isn't a valid product page
    }

    const is404 = await page.evaluate(() => {
      const body = document.body?.textContent || '';
      return body.includes('Page not found') || body.includes('404') ||
             document.title.toLowerCase().includes('not found');
    });

    if (is404) return null;

    return await extractQuickStepData(page);
  } catch {
    return null;
  }
}

/** Extract product data from a Quick-Step Angular-rendered page */
async function extractQuickStepData(page) {
  const data = await page.evaluate(() => {
    const images = [];

    // Product images (Angular-rendered)
    document.querySelectorAll('img').forEach(img => {
      const src = img.src || img.dataset.src || img.currentSrc;
      if (src && src.startsWith('http') && !src.includes('logo') && !src.includes('icon') &&
          !src.includes('favicon') && !src.includes('sprite') && !src.includes('tracking')) {
        // Filter for product-related images (not tiny icons)
        if (img.naturalWidth > 100 || img.width > 100 || src.includes('floor') || src.includes('product') || src.includes('room')) {
          images.push(src);
        }
      }
    });

    // Background images
    document.querySelectorAll('[style*="background-image"]').forEach(el => {
      const bgUrl = (el.style.backgroundImage || '').match(/url\(["']?([^"')]+)/)?.[1];
      if (bgUrl && bgUrl.startsWith('http') && !bgUrl.includes('logo')) {
        images.push(bgUrl);
      }
    });

    // Extract specs from .two-column-compound__column and quickstep-rich-text
    const specs = {};
    const textContent = document.body?.innerText || '';
    const lines = textContent.split('\n').map(l => l.trim()).filter(Boolean);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lower = line.toLowerCase();

      // Quick-Step specs often have label on one line, value on next
      const nextLine = (lines[i + 1] || '').trim();

      // Direct "Label: Value" patterns
      const match = line.match(/^(thickness|width|length|wear\s*layer|finish|edge|bevel|material|species|plank\s*size|format|class|warranty|surface\s*structure|installation|bevels?)[:\s]+(.+)/i);
      if (match) {
        const label = match[1].toLowerCase();
        const value = match[2].trim();
        if (label.includes('thickness')) specs.thickness = value;
        if (label.includes('width') || label.includes('size') || label.includes('format')) specs.size = value;
        if (label.includes('length')) specs.length = value;
        if (label.includes('wear')) specs.wear_layer = value;
        if (label.includes('finish') || label.includes('surface')) specs.finish = value;
        if (label.includes('edge') || label.includes('bevel')) specs.edge = value;
        if (label.includes('material') || label.includes('species')) specs.material = value;
        if (label.includes('class')) specs.grade = value;
        if (label.includes('warranty')) specs.warranty = value;
        if (label.includes('installation')) specs.installation = value;
      }

      // Label-only lines followed by value lines
      if (lower === 'thickness' && nextLine) specs.thickness = nextLine;
      if (lower === 'width' && nextLine) specs.size = nextLine;
      if (lower === 'length' && nextLine) specs.length = nextLine;
      if (lower === 'wear layer' && nextLine) specs.wear_layer = nextLine;
      if ((lower === 'finish' || lower === 'surface structure') && nextLine) specs.finish = nextLine;
      if ((lower === 'edge' || lower === 'bevels') && nextLine) specs.edge = nextLine;
    }

    // Also try spec table/list selectors
    document.querySelectorAll('.two-column-compound__column, .specification-list li, .spec-row').forEach(el => {
      const label = (el.querySelector('.label, .spec-label, dt')?.textContent || '').trim().toLowerCase();
      const value = (el.querySelector('.value, .spec-value, dd')?.textContent || '').trim();
      if (label && value) {
        if (label.includes('thickness')) specs.thickness = value;
        if (label.includes('width') || label.includes('format')) specs.size = value;
        if (label.includes('wear')) specs.wear_layer = value;
        if (label.includes('finish') || label.includes('surface')) specs.finish = value;
        if (label.includes('edge') || label.includes('bevel')) specs.edge = value;
      }
    });

    // Description
    const descEl = document.querySelector('quickstep-rich-text p, .product-description p, [class*="description"] p, article p');
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

/** Browse collection listing to find product */
async function findQuickStepViaCollection(page, productGroup, delayMs, collectionSlug) {
  const colorName = productGroup.name;
  try {
    // Try laminate collection page
    await page.goto(`${BASE_URL}/en-us/laminate/${collectionSlug}`, {
      waitUntil: 'networkidle2',
      timeout: 25000,
    });
    await delay(delayMs + 2000);

    const productUrl = await page.evaluate((name) => {
      const nameLower = name.toLowerCase();
      const links = document.querySelectorAll('a[href]');
      for (const a of links) {
        const text = (a.textContent || '').toLowerCase();
        const href = (a.getAttribute('href') || '').toLowerCase();
        if ((text.includes(nameLower) || href.includes(nameLower.replace(/\s+/g, '-'))) &&
            href.includes('/en-us/')) {
          return a.href;
        }
      }
      return null;
    }, colorName);

    if (!productUrl) return null;

    return await tryQuickStepPage(page, productUrl, delayMs);
  } catch {
    return null;
  }
}
