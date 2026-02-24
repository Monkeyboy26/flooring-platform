import {
  launchBrowser, delay, upsertMediaAsset, upsertSkuAttribute,
  appendLog, addJobError, downloadImage, resolveImageExtension, preferProductShot
} from './base.js';

const BASE_URL = 'https://www.tayloradhesives.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_ERRORS = 30;

/**
 * WF Taylor enrichment scraper for Tri-West.
 *
 * Scrapes tayloradhesives.com for product images, descriptions, and specs.
 * Enriches EXISTING Tri-West SKUs — never creates new products.
 * Tech: WordPress + WooCommerce
 *
 * Runs AFTER triwest-catalog.js populates SKUs in the DB.
 */
export async function run(pool, job, source) {
  const config = source.config || {};
  const delayMs = config.delay_ms || 2000;
  const vendor_id = source.vendor_id;
  const brandPrefix = 'WF Taylor';

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
 * Find product on WF Taylor WooCommerce site and extract data
 */
async function findProductOnSite(page, group, delayMs) {
  const productName = group.name;
  const slug = productName.toLowerCase()
    .replace(/[®™]/g, '')
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');

  // Try WooCommerce product URL: /product/{slug}/
  const productUrl = `${BASE_URL}/product/${slug}/`;

  try {
    await page.goto(productUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    await delay(delayMs);

    // Check if page exists
    const is404 = await page.evaluate(() => {
      return document.title.toLowerCase().includes('404') ||
             document.body.textContent.toLowerCase().includes('not found') ||
             document.querySelector('.error404');
    });

    if (is404) {
      throw new Error('Product page not found');
    }

    // Extract product data
    const data = await page.evaluate(() => {
      const result = {
        images: [],
        description: '',
        specs: {}
      };

      // Extract description from WooCommerce tabs
      const descElement = document.querySelector('.woocommerce-product-details__short-description, .product-description, .woocommerce-Tabs-panel--description');
      if (descElement) {
        result.description = descElement.textContent.trim();
      }

      // Extract images from WooCommerce gallery
      const galleryImages = document.querySelectorAll('.woocommerce-product-gallery__image img, .product-image img');
      const imageUrls = new Set();

      galleryImages.forEach(img => {
        let url = img.src;
        // Get full-size image if available
        const parent = img.closest('a');
        if (parent && parent.href && parent.href.match(/\.(jpg|jpeg|png|webp)$/i)) {
          url = parent.href;
        }
        if (url && !url.includes('logo') && !url.includes('icon')) {
          imageUrls.add(url);
        }
      });

      // Also check for images in wp-content/uploads
      const contentImages = document.querySelectorAll('img[src*="/wp-content/uploads/"]');
      contentImages.forEach(img => {
        if (img.src && !img.src.includes('logo') && !img.src.includes('icon')) {
          imageUrls.add(img.src);
        }
      });

      result.images = Array.from(imageUrls);

      // Extract technical specs from product details
      const specsSection = document.querySelector('.woocommerce-Tabs-panel--additional_information, .product-specs, [class*="technical"]');
      if (specsSection) {
        const text = specsSection.textContent.toLowerCase();

        // Coverage rate
        const coverageMatch = text.match(/coverage[:\s]+([0-9,]+)\s*(?:sq\.?\s*ft|ft²|sf)/i);
        if (coverageMatch) {
          result.specs.coverage = coverageMatch[1].replace(/,/g, '') + ' sq ft';
        }

        // Open time
        const openTimeMatch = text.match(/open time[:\s]+([0-9]+)\s*(?:min|minutes)/i);
        if (openTimeMatch) {
          result.specs.open_time = openTimeMatch[1] + ' minutes';
        }

        // VOC content
        const vocMatch = text.match(/voc[:\s]+([0-9]+)\s*(?:g\/l)/i);
        if (vocMatch) {
          result.specs.voc_content = vocMatch[1] + ' g/L';
        }

        // Application method
        const appMatch = text.match(/application[:\s]+([a-z\s]+)(?:\n|$)/i);
        if (appMatch) {
          result.specs.application_method = appMatch[1].trim();
        }
      }

      // Check WooCommerce product attributes table
      const attrTable = document.querySelector('.woocommerce-product-attributes');
      if (attrTable) {
        const rows = attrTable.querySelectorAll('tr');
        rows.forEach(row => {
          const label = row.querySelector('th');
          const value = row.querySelector('td');
          if (label && value) {
            const key = label.textContent.trim().toLowerCase();
            const val = value.textContent.trim();

            if (key.includes('coverage') && !result.specs.coverage) {
              result.specs.coverage = val;
            } else if (key.includes('open time') && !result.specs.open_time) {
              result.specs.open_time = val;
            } else if (key.includes('voc') && !result.specs.voc_content) {
              result.specs.voc_content = val;
            }
          }
        });
      }

      return result;
    });

    if (data.images.length === 0 && !data.description) {
      return null;
    }

    return data;

  } catch (err) {
    // Fallback: WordPress search
    try {
      await page.goto(`${BASE_URL}/?s=${encodeURIComponent(productName)}`, {
        waitUntil: 'networkidle2',
        timeout: 30000
      });
      await delay(delayMs);

      // Look for product in search results
      const foundProduct = await page.evaluate((searchName) => {
        const links = Array.from(document.querySelectorAll('a.woocommerce-LoopProduct-link, .product a, .search-result a'));
        for (const link of links) {
          const text = link.textContent.toLowerCase();
          const searchLower = searchName.toLowerCase();
          if (text.includes(searchLower) || searchLower.includes(text.trim())) {
            return link.href;
          }
        }
        return null;
      }, productName);

      if (foundProduct) {
        await page.goto(foundProduct, { waitUntil: 'networkidle2', timeout: 30000 });
        await delay(delayMs);

        const data = await page.evaluate(() => {
          const result = { images: [], description: '', specs: {} };

          const descElement = document.querySelector('.woocommerce-product-details__short-description, .product-description');
          if (descElement) {
            result.description = descElement.textContent.trim();
          }

          const imgElements = document.querySelectorAll('.woocommerce-product-gallery__image img, img[src*="/wp-content/uploads/"]');
          const imageUrls = new Set();
          imgElements.forEach(img => {
            if (img.src && !img.src.includes('logo')) {
              imageUrls.add(img.src);
            }
          });
          result.images = Array.from(imageUrls);

          return result;
        });

        return data.images.length > 0 || data.description ? data : null;
      }
    } catch (searchErr) {
      // Search fallback failed
    }

    return null;
  }
}
