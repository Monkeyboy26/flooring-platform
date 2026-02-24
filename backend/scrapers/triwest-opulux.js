import {
  launchBrowser, delay, upsertMediaAsset, upsertSkuAttribute,
  appendLog, addJobError, downloadImage, resolveImageExtension, preferProductShot
} from './base.js';

const BASE_URL = 'https://www.opuluxfloors.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_ERRORS = 30;

/**
 * Opulux enrichment scraper for Tri-West.
 *
 * Scrapes opuluxfloors.com for product images, descriptions, and specs.
 * Enriches EXISTING Tri-West SKUs — never creates new products.
 * Tech: WordPress + Elementor + WooCommerce, Cloudinary CDN
 *
 * Runs AFTER triwest-catalog.js populates SKUs in the DB.
 */
export async function run(pool, job, source) {
  const config = source.config || {};
  const delayMs = config.delay_ms || 2000;
  const vendor_id = source.vendor_id;
  const brandPrefix = 'Opulux';

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
 * Find a product on opuluxfloors.com and extract images/specs.
 * Returns { images: string[], description: string, specs: object } or null.
 *
 * Opulux is a WordPress + Elementor + WooCommerce site with Cloudinary CDN images.
 * Product URLs: /product/{name}/ (e.g., /product/vogue/, /product/posh/)
 * Shop page: /shop-2/
 * Images: res.cloudinary.com/dm3lyhcdj (lazy loaded via data-cloudinary="lazy")
 * Specs: Structured "Product Specifications" section with Size, Wear Layer, Texture, etc.
 * ~10 products total: Vogue, Haute, Posh, Passion, Utopia, Craze, Flair, Aurora, Dazzle, Radiance
 */
async function findProductOnSite(page, productGroup, delayMs) {
  const colorName = productGroup.name;
  const slug = colorName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

  try {
    // Try direct WooCommerce product URL
    await page.goto(`${BASE_URL}/product/${slug}/`, {
      waitUntil: 'networkidle2',
      timeout: 15000,
    });
    await delay(delayMs);

    // Check if valid product page (WooCommerce adds body class)
    const isProduct = await page.evaluate(() => {
      return document.body?.classList.contains('single-product') ||
             document.querySelector('.woocommerce-product-gallery') !== null ||
             document.querySelector('.product_title') !== null;
    });

    if (isProduct) {
      return await extractOpuluxData(page);
    }

    // Fallback: browse shop page for matching product
    return await findProductViaShop(page, productGroup, delayMs);
  } catch {
    return await findProductViaShop(page, productGroup, delayMs);
  }
}

/** Extract product data from an Opulux WooCommerce product page */
async function extractOpuluxData(page) {
  // Scroll to trigger lazy loading of Cloudinary images
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await delay(1500);
  await page.evaluate(() => window.scrollTo(0, 0));
  await delay(500);

  const data = await page.evaluate(() => {
    const images = [];

    // WooCommerce gallery images
    document.querySelectorAll('.woocommerce-product-gallery img, .woocommerce-product-gallery__image img').forEach(img => {
      const src = img.src || img.dataset.src || img.dataset.largeSrc;
      if (src && src.startsWith('http') && !src.includes('placeholder')) {
        images.push(src);
      }
    });

    // Cloudinary lazy-loaded images
    document.querySelectorAll('img[data-cloudinary], img[src*="cloudinary"], img[data-src*="cloudinary"]').forEach(img => {
      const src = img.src || img.dataset.src || img.dataset.lazySrc;
      if (src && src.includes('cloudinary') && !images.includes(src)) {
        images.push(src);
      }
    });

    // Elementor widget images
    document.querySelectorAll('.elementor-widget-image img, .elementor-image img').forEach(img => {
      const src = img.src || img.dataset.src;
      if (src && src.startsWith('http') && !src.includes('logo') && !src.includes('icon') && !src.includes('placeholder')) {
        if (!images.includes(src)) images.push(src);
      }
    });

    // Extract specs from "Product Specifications" section
    const specs = {};
    const textContent = document.body?.innerText || '';

    // Look for spec patterns in the page text
    const specPatterns = [
      { regex: /size[:\s]+([^\n]+)/i, key: 'size' },
      { regex: /wear\s*layer[:\s]+([^\n]+)/i, key: 'wear_layer' },
      { regex: /texture[:\s]+([^\n]+)/i, key: 'finish' },
      { regex: /edge[:\s]+([^\n]+)/i, key: 'edge' },
      { regex: /underlayment[:\s]+([^\n]+)/i, key: 'underlayment' },
      { regex: /locking\s*system[:\s]+([^\n]+)/i, key: 'locking_system' },
      { regex: /application[:\s]+([^\n]+)/i, key: 'application' },
      { regex: /thickness[:\s]+([^\n]+)/i, key: 'thickness' },
      { regex: /warranty[:\s]+([^\n]+)/i, key: 'warranty' },
    ];

    for (const { regex, key } of specPatterns) {
      const match = textContent.match(regex);
      if (match) specs[key] = match[1].trim();
    }

    // Also try WooCommerce additional information table
    document.querySelectorAll('.woocommerce-product-attributes tr, .shop_attributes tr').forEach(row => {
      const label = (row.querySelector('th')?.textContent || '').trim().toLowerCase();
      const value = (row.querySelector('td')?.textContent || '').trim();
      if (label && value) {
        if (label.includes('size') || label.includes('dimension')) specs.size = value;
        if (label.includes('wear')) specs.wear_layer = value;
        if (label.includes('thickness')) specs.thickness = value;
        if (label.includes('finish') || label.includes('texture')) specs.finish = value;
        if (label.includes('edge')) specs.edge = value;
      }
    });

    // Description from WooCommerce product description
    const descEl = document.querySelector('.woocommerce-product-details__short-description, .product-description, .entry-summary .description');
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

/** Fallback: browse shop page to find matching product */
async function findProductViaShop(page, productGroup, delayMs) {
  const colorName = productGroup.name;
  try {
    await page.goto(`${BASE_URL}/shop-2/`, { waitUntil: 'networkidle2', timeout: 15000 });
    await delay(delayMs);

    const productUrl = await page.evaluate((name) => {
      const nameLower = name.toLowerCase();
      // WooCommerce product links
      const links = document.querySelectorAll('a.woocommerce-LoopProduct-link, a[href*="/product/"], .products a');
      for (const a of links) {
        const text = (a.textContent || '').toLowerCase();
        const href = (a.getAttribute('href') || '').toLowerCase();
        if (text.includes(nameLower) || href.includes(nameLower.replace(/\s+/g, '-'))) {
          return a.href;
        }
      }
      return null;
    }, colorName);

    if (!productUrl) return null;

    await page.goto(productUrl, { waitUntil: 'networkidle2', timeout: 15000 });
    await delay(delayMs);

    return await extractOpuluxData(page);
  } catch {
    return null;
  }
}
