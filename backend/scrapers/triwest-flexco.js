import {
  launchBrowser, delay, upsertMediaAsset, upsertSkuAttribute,
  appendLog, addJobError, downloadImage, resolveImageExtension, preferProductShot
} from './base.js';

const BASE_URL = 'https://www.flexcofloors.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_ERRORS = 30;

/**
 * Flexco enrichment scraper for Tri-West.
 *
 * Scrapes flexcofloors.com for product images, descriptions, and specs.
 * Enriches EXISTING Tri-West SKUs — never creates new products.
 * Tech: WordPress + Divi + WooCommerce
 *
 * Runs AFTER triwest-catalog.js populates SKUs in the DB.
 */
export async function run(pool, job, source) {
  const config = source.config || {};
  const delayMs = config.delay_ms || 2000;
  const vendor_id = source.vendor_id;
  const brandPrefix = 'Flexco';

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
 * Find a product on flexcofloors.com and extract images/specs.
 * Returns { images: string[], description: string, specs: object } or null.
 *
 * Flexco is a WordPress + Divi + WooCommerce site.
 * Product URLs: /{product-slug}/ (e.g., /distinct-designs-rubber-flooring/)
 * Images: self-hosted at /wp-content/uploads/{year}/{month}/{filename}.jpg
 * Selectors: .et_pb_image (Divi images), .woocommerce-product-gallery,
 *            .fl-dd-spec-table (spec tables), .et_pb_text (text blocks)
 * Note: Flexco is primarily commercial — pages are often collection-level, not individual SKU pages.
 */
async function findProductOnSite(page, productGroup, delayMs) {
  const colorName = productGroup.name;
  const collection = productGroup.collection;
  const collectionName = collection.replace(/^Flexco\s*/i, '').trim();

  // Build possible slugs from collection name and color name
  const collectionSlug = collectionName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  const colorSlug = colorName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

  try {
    // Strategy 1: Try WooCommerce product URL by color name
    let found = await tryFlexcoPage(page, `${BASE_URL}/product/${colorSlug}/`, delayMs);
    if (found) return found;

    // Strategy 2: Try collection slug as a page
    found = await tryFlexcoPage(page, `${BASE_URL}/${collectionSlug}/`, delayMs);
    if (found) return found;

    // Strategy 3: Try combined collection-color slug
    found = await tryFlexcoPage(page, `${BASE_URL}/${collectionSlug}-${colorSlug}/`, delayMs);
    if (found) return found;

    // Strategy 4: WordPress search
    return await findFlexcoViaSearch(page, productGroup, delayMs);
  } catch {
    return null;
  }
}

/** Try loading a Flexco page and extracting data */
async function tryFlexcoPage(page, url, delayMs) {
  try {
    const resp = await page.goto(url, { waitUntil: 'networkidle2', timeout: 15000 });
    if (!resp || resp.status() === 404) return null;
    await delay(delayMs);

    const is404 = await page.evaluate(() => {
      return document.body?.classList.contains('error404') ||
             document.title.toLowerCase().includes('page not found');
    });

    if (is404) return null;

    return await extractFlexcoData(page);
  } catch {
    return null;
  }
}

/** Extract product data from a Flexco page */
async function extractFlexcoData(page) {
  const data = await page.evaluate(() => {
    const images = [];

    // WooCommerce gallery images
    document.querySelectorAll('.woocommerce-product-gallery img, .woocommerce-product-gallery__image img').forEach(img => {
      const src = img.src || img.dataset.src || img.dataset.largeSrc;
      if (src && src.includes('wp-content/uploads') && !src.includes('placeholder')) {
        images.push(src);
      }
    });

    // Divi builder images
    document.querySelectorAll('.et_pb_image img, .et_pb_image_wrap img').forEach(img => {
      const src = img.src || img.dataset.src;
      if (src && src.includes('wp-content/uploads') && !src.includes('logo') && !src.includes('icon')) {
        if (!images.includes(src)) images.push(src);
      }
    });

    // Regular content images
    document.querySelectorAll('.entry-content img, article img').forEach(img => {
      const src = img.src || img.dataset.src;
      if (src && src.startsWith('http') && !src.includes('logo') && !src.includes('icon') && !src.includes('placeholder')) {
        if (!images.includes(src)) images.push(src);
      }
    });

    // Extract specs from Flexco spec table
    const specs = {};
    document.querySelectorAll('.fl-dd-spec-table tr, table tr').forEach(row => {
      const cells = row.querySelectorAll('td, th');
      if (cells.length >= 2) {
        const label = (cells[0].textContent || '').trim().toLowerCase();
        const value = (cells[1].textContent || '').trim();
        if (label && value) {
          if (label.includes('thickness') || label.includes('gauge')) specs.thickness = value;
          if (label.includes('width') || label.includes('size') || label.includes('dimension')) specs.size = value;
          if (label.includes('finish') || label.includes('surface')) specs.finish = value;
          if (label.includes('material') || label.includes('composition')) specs.material = value;
          if (label.includes('edge')) specs.edge = value;
          if (label.includes('wear')) specs.wear_layer = value;
          if (label.includes('color') || label.includes('colour')) specs.color = value;
          if (label.includes('warranty')) specs.warranty = value;
        }
      }
    });

    // Also parse from Divi text blocks
    document.querySelectorAll('.et_pb_text, .et_pb_cta').forEach(block => {
      const text = block.innerText || '';
      const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
      for (const line of lines) {
        const match = line.match(/^(thickness|gauge|size|dimensions?|material|finish|wear\s*layer|edge)[:\s-]+(.+)/i);
        if (match) {
          const label = match[1].toLowerCase();
          const value = match[2].trim();
          if (label.includes('thickness') || label.includes('gauge')) specs.thickness = specs.thickness || value;
          if (label.includes('size') || label.includes('dimension')) specs.size = specs.size || value;
          if (label.includes('material')) specs.material = specs.material || value;
          if (label.includes('finish')) specs.finish = specs.finish || value;
          if (label.includes('wear')) specs.wear_layer = specs.wear_layer || value;
          if (label.includes('edge')) specs.edge = specs.edge || value;
        }
      }
    });

    // Description
    const descEl = document.querySelector('.woocommerce-product-details__short-description, .et_pb_text .description, .entry-content p');
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

/** Fallback: use WordPress search to find the product */
async function findFlexcoViaSearch(page, productGroup, delayMs) {
  const colorName = productGroup.name;
  try {
    await page.goto(`${BASE_URL}/?s=${encodeURIComponent(colorName)}`, {
      waitUntil: 'networkidle2',
      timeout: 15000,
    });
    await delay(delayMs);

    const productUrl = await page.evaluate((name) => {
      const nameLower = name.toLowerCase();
      const links = document.querySelectorAll('a[href]');
      for (const a of links) {
        const text = (a.textContent || '').toLowerCase();
        const href = a.getAttribute('href') || '';
        if ((text.includes(nameLower) || href.toLowerCase().includes(nameLower.replace(/\s+/g, '-'))) &&
            !href.includes('?s=') && !href.includes('/page/')) {
          return a.href;
        }
      }
      return null;
    }, colorName);

    if (!productUrl) return null;

    await page.goto(productUrl, { waitUntil: 'networkidle2', timeout: 15000 });
    await delay(delayMs);

    return await extractFlexcoData(page);
  } catch {
    return null;
  }
}
