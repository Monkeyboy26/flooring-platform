import {
  launchBrowser, delay, upsertMediaAsset, upsertSkuAttribute,
  appendLog, addJobError, downloadImage, resolveImageExtension, preferProductShot
} from './base.js';

const BASE_URL = 'https://summit-flooring.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_ERRORS = 30;

/**
 * Summit enrichment scraper for Tri-West.
 *
 * Scrapes summit-flooring.com for product images, descriptions, and specs.
 * Enriches EXISTING Tri-West SKUs — never creates new products.
 * Tech: WordPress + Divi
 *
 * Runs AFTER triwest-catalog.js populates SKUs in the DB.
 */
export async function run(pool, job, source) {
  const config = source.config || {};
  const delayMs = config.delay_ms || 2000;
  const vendor_id = source.vendor_id;
  const brandPrefix = 'Summit';

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
 * Searches Summit site for product and extracts images/specs.
 * Strategy: Try WooCommerce product URL, fallback to WordPress search.
 */
async function findProductOnSite(page, group, delayMs) {
  const searchName = group.name.trim();
  const slug = searchName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

  // Try WooCommerce product URL
  const productUrl = `${BASE_URL}/product/${slug}/`;

  try {
    await page.goto(productUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    await delay(delayMs);

    // Check if product page loaded successfully
    const notFound = await page.evaluate(() => {
      return document.querySelector('.woocommerce-error, .error404') !== null;
    });

    if (!notFound) {
      return await extractProductData(page);
    }
  } catch (err) {
    // Fallback to search
  }

  // Fallback: WordPress search
  try {
    const searchUrl = `${BASE_URL}/?s=${encodeURIComponent(searchName)}`;
    await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    await delay(delayMs);

    // Find first matching product link
    const productLink = await page.evaluate((name) => {
      const links = Array.from(document.querySelectorAll('a.woocommerce-LoopProduct-link, .product a, .entry-title a'));
      for (const link of links) {
        const text = link.innerText.toLowerCase();
        if (text.includes(name.toLowerCase())) {
          return link.href;
        }
      }
      return null;
    }, searchName);

    if (productLink) {
      await page.goto(productLink, { waitUntil: 'networkidle2', timeout: 30000 });
      await delay(delayMs);
      return await extractProductData(page);
    }
  } catch (err) {
    return null;
  }

  return null;
}

/**
 * Extracts product images, description, and specs from Summit product page.
 */
async function extractProductData(page) {
  return await page.evaluate(() => {
    const images = [];
    const specs = {};

    // Extract WooCommerce gallery images
    document.querySelectorAll('.woocommerce-product-gallery__image img, .woocommerce-product-gallery a').forEach(el => {
      let src = el.tagName === 'A' ? el.href : el.src;
      if (src && !src.includes('logo') && !images.includes(src)) {
        images.push(src);
      }
    });

    // Extract Divi image modules
    document.querySelectorAll('.et_pb_image img, .et_pb_gallery_image img').forEach(img => {
      let src = img.src;
      if (src && !src.includes('logo') && !images.includes(src)) {
        images.push(src);
      }
    });

    // Extract from wp-content/uploads
    document.querySelectorAll('img[src*="/wp-content/uploads/"]').forEach(img => {
      let src = img.src;
      if (!src.includes('logo') && !src.includes('icon') && !images.includes(src)) {
        images.push(src);
      }
    });

    // Extract description
    const descEl = document.querySelector('.woocommerce-product-details__short-description, .product_description, .entry-content');
    const description = descEl ? descEl.innerText.trim() : null;

    // Extract specs from WooCommerce attributes table
    const specsTable = document.querySelector('.woocommerce-product-attributes, .shop_attributes');
    if (specsTable) {
      specsTable.querySelectorAll('tr').forEach(row => {
        const th = row.querySelector('th');
        const td = row.querySelector('td');
        if (th && td) {
          const key = th.innerText.toLowerCase().trim();
          const value = td.innerText.trim();

          if (key.includes('material')) specs.material = value;
          else if (key.includes('finish')) specs.finish = value;
          else if (key.includes('size')) specs.size = value;
          else if (key.includes('color')) specs.color = value;
          else if (key.includes('thickness')) specs.thickness = value;
          else if (key.includes('wear layer')) specs.wear_layer = value;
        }
      });
    }

    // Fallback: extract from text content
    if (Object.keys(specs).length === 0) {
      const text = document.body.innerText.toLowerCase();

      if (text.includes('vinyl')) specs.material = 'Vinyl';
      else if (text.includes('laminate')) specs.material = 'Laminate';
      else if (text.includes('hardwood')) specs.material = 'Hardwood';
      else if (text.includes('carpet')) specs.material = 'Carpet';

      if (text.includes('textured')) specs.finish = 'Textured';
      else if (text.includes('smooth')) specs.finish = 'Smooth';
      else if (text.includes('embossed')) specs.finish = 'Embossed';

      const sizeMatch = text.match(/(\d+\.?\d*)\s*[x×]\s*(\d+\.?\d*)/);
      if (sizeMatch) {
        specs.size = `${sizeMatch[1]}x${sizeMatch[2]}`;
      }
    }

    return {
      images,
      description,
      specs: Object.keys(specs).length > 0 ? specs : null
    };
  });
}
