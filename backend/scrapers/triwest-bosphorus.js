import {
  launchBrowser, delay, upsertMediaAsset, upsertSkuAttribute,
  appendLog, addJobError, preferProductShot, filterImageUrls,
  extractLargeImages, collectSiteWideImages,
  extractSpecPDFs, normalizeTriwestName
} from './base.js';

const BASE_URL = 'https://bosphorusimports.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_ERRORS = 30;
const BATCH_SIZE = 15;

/**
 * Bosphorus enrichment scraper for Tri-West.
 *
 * Scrapes bosphorusimports.com for product images, descriptions, and specs.
 * Enriches EXISTING Tri-West SKUs — never creates new products.
 * Tech: Custom platform (jQuery/Fancybox)
 *
 * Runs AFTER import-triwest-832.cjs populates SKUs in the DB.
 */
export async function run(pool, job, source) {
  const config = source.config || {};
  const delayMs = config.delay_ms || 2000;
  const vendor_id = source.vendor_id;
  const brandPrefix = 'Bosphorus';

  let browser = null;
  let errorCount = 0;
  let skusEnriched = 0;
  let skusSkipped = 0;
  let imagesAdded = 0;
  let pdfsAdded = 0;
  let pagesSinceLaunch = 0;

  async function logError(msg) {
    errorCount++;
    if (errorCount <= MAX_ERRORS) {
      try { await addJobError(pool, job.id, msg); } catch { }
    }
  }

  try {
    // Load existing TW products for this brand (includes SKU-less products from DNav)
    const prodResult = await pool.query(`
      SELECT p.id AS product_id, p.name, p.collection, p.description_long
      FROM products p
      WHERE p.vendor_id = $1 AND p.collection LIKE $2
    `, [vendor_id, `${brandPrefix}%`]);

    // Also load SKU data for products that have it
    const skuResult = await pool.query(`
      SELECT s.id AS sku_id, s.vendor_sku, s.internal_sku, s.variant_name, s.product_id
      FROM skus s
      JOIN products p ON p.id = s.product_id
      WHERE p.vendor_id = $1 AND p.collection LIKE $2
    `, [vendor_id, `${brandPrefix}%`]);

    await appendLog(pool, job.id, `Found ${prodResult.rows.length} ${brandPrefix} products (${skuResult.rows.length} SKUs) to enrich`);

    if (prodResult.rows.length === 0) {
      await appendLog(pool, job.id, `No ${brandPrefix} products found — run import-triwest-832 first`);
      return;
    }

    // Build SKU lookup by product_id
    const skusByProduct = new Map();
    for (const row of skuResult.rows) {
      if (!skusByProduct.has(row.product_id)) skusByProduct.set(row.product_id, []);
      skusByProduct.get(row.product_id).push(row);
    }

    // Check which products already have a primary image — skip those
    const existingImages = await pool.query(`
      SELECT DISTINCT ma.product_id
      FROM media_assets ma
      JOIN products p ON p.id = ma.product_id
      WHERE p.vendor_id = $1 AND ma.asset_type = 'primary'
    `, [vendor_id]);
    const alreadyHaveImages = new Set(existingImages.rows.map(r => r.product_id));

    // Group products by collection + name
    const productGroups = new Map();
    for (const row of prodResult.rows) {
      const key = `${row.collection}||${row.name}`;
      if (!productGroups.has(key)) {
        productGroups.set(key, {
          product_id: row.product_id, name: row.name, collection: row.collection,
          skus: skusByProduct.get(row.product_id) || [],
        });
      }
    }

    // Filter to products that still need enrichment
    const toEnrich = [...productGroups.entries()].filter(([, g]) => !alreadyHaveImages.has(g.product_id));
    const skippedExisting = productGroups.size - toEnrich.length;

    await appendLog(pool, job.id, `Grouped into ${productGroups.size} products (${skippedExisting} already have images, ${toEnrich.length} to enrich, ${skuResult.rows.length} with SKUs)`);

    browser = await launchBrowser();
    let page = await browser.newPage();
    await page.setUserAgent(USER_AGENT);
    await page.setViewport({ width: 1440, height: 900 });

    // Collect site-wide images to exclude
    await appendLog(pool, job.id, `Collecting site-wide images from ${BASE_URL}...`);
    const siteWideImages = await collectSiteWideImages(page, BASE_URL);
    await appendLog(pool, job.id, `Found ${siteWideImages.size} site-wide images to exclude`);
    pagesSinceLaunch++;

    let processed = 0;
    for (const [key, group] of toEnrich) {
      processed++;

      // Recycle browser periodically to avoid memory leaks
      if (pagesSinceLaunch >= BATCH_SIZE) {
        await appendLog(pool, job.id, `Recycling browser after ${BATCH_SIZE} pages...`);
        try { await page.close(); } catch { }
        try { await browser.close(); } catch { }
        await delay(5000);
        browser = await launchBrowser();
        page = await browser.newPage();
        await page.setUserAgent(USER_AGENT);
        await page.setViewport({ width: 1440, height: 900 });
        pagesSinceLaunch = 0;
      }

      try {
        const productData = await findProductOnSite(page, group, delayMs, siteWideImages);
        pagesSinceLaunch++;

        if (!productData) {
          skusSkipped++;
          continue;
        }

        if (productData.description && !group.skus[0]?.description_long) {
          await pool.query(
            'UPDATE products SET description_long = $1 WHERE id = $2 AND description_long IS NULL',
            [productData.description, group.product_id]
          );
        }

        // Filter junk, deduplicate, then sort product shots first
        if (productData.images && productData.images.length > 0) {
          const filtered = filterImageUrls(productData.images, { maxImages: 8 });
          const sorted = preferProductShot(filtered, group.name);
          for (let i = 0; i < sorted.length; i++) {
            const urlLower = sorted[i].toLowerCase();
            const isLifestyle = urlLower.includes('room') || urlLower.includes('scene')
              || urlLower.includes('lifestyle') || urlLower.includes('installed');
            const assetType = i === 0 ? 'primary'
              : (isLifestyle || i > 2) ? 'lifestyle'
              : 'alternate';
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

        // Upsert spec PDFs
        if (productData.pdfs && productData.pdfs.length > 0) {
          for (let i = 0; i < productData.pdfs.length; i++) {
            await upsertMediaAsset(pool, {
              product_id: group.product_id,
              sku_id: null,
              asset_type: 'spec_pdf',
              url: productData.pdfs[i].url,
              original_url: productData.pdfs[i].url,
              sort_order: i,
            });
            pdfsAdded++;
          }
        }

        if (productData.specs && group.skus.length > 0) {
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
        skusSkipped++;
      }

      if (processed % 10 === 0) {
        await appendLog(pool, job.id, `Progress: ${processed}/${toEnrich.length} products, ${imagesAdded} images, ${pdfsAdded} PDFs`);
      }
    }

    await appendLog(pool, job.id,
      `Complete. Products: ${toEnrich.length} enriched (${skippedExisting} skipped), SKUs enriched: ${skusEnriched}, Skipped: ${skusSkipped}, Images: ${imagesAdded}, PDFs: ${pdfsAdded}, Errors: ${errorCount}`,
      { products_found: productGroups.size, products_updated: skusEnriched }
    );

  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

/**
 * Searches Bosphorus site for product and extracts images/specs.
 * Strategy: Navigate products page, search by name/SKU. Extract from product cards and Fancybox modals.
 */
async function findProductOnSite(page, group, delayMs, siteWideImages) {
  const normalized = normalizeTriwestName(group.name);
  const searchName = normalized.toLowerCase().trim();
  const collectionName = normalizeTriwestName(group.collection.replace(/^Bosphorus\s*/i, '')).toLowerCase();

  // Try products page first, then categories
  const pagesToTry = [`${BASE_URL}/products`, `${BASE_URL}/porcelain`, `${BASE_URL}/natural-stone`, BASE_URL];

  for (const pageUrl of pagesToTry) {
    try {
      await page.goto(pageUrl, { waitUntil: 'networkidle2', timeout: 20000 });
      await delay(delayMs);

      // Search for product by name in product cards
      const productCard = await page.evaluate((name, collection) => {
        const cards = Array.from(document.querySelectorAll('.product-card, .product-item, [class*="product"], .collection-item, a'));
        for (const card of cards) {
          const text = card.innerText.toLowerCase();
          if (text.includes(name) || text.includes(collection)) {
            const link = card.tagName === 'A' ? card : card.querySelector('a');
            return link ? link.href : null;
          }
        }
        return null;
      }, searchName, collectionName);

      if (productCard) {
        await page.goto(productCard, { waitUntil: 'networkidle2', timeout: 20000 });
        await delay(delayMs);

        const data = await extractBosphorusData(page, siteWideImages);
        if (data) return data;
      }
    } catch { continue; }
  }

  return null;
}

async function extractBosphorusData(page, siteWideImages) {
  // Extract large images using utility (filters site-wide images)
  const largeImgs = await extractLargeImages(page, siteWideImages, 150);
  const utilityImages = largeImgs.map(img => img.src);

  // Extract images and specs
  const data = await page.evaluate(() => {
    const images = [];
    const specs = {};

    // Extract images from various sources (Capsule CDN + general)
    document.querySelectorAll('img[src*="/cdn/uploads/"], img[src*="/capsule/"], img[src*="/uploads/"]').forEach(img => {
      let src = img.src;
      src = src.split('?')[0];
      if (!src.includes('logo') && !images.includes(src)) {
        images.push(src);
      }
    });

    // Look for Fancybox gallery images
    document.querySelectorAll('a[data-fancybox], a[href*="/cdn/uploads/"], a[href*="/capsule/"]').forEach(link => {
      let href = link.href;
      href = href.split('?')[0];
      if (!href.includes('logo') && !images.includes(href)) {
        images.push(href);
      }
    });

    // Extract description
    const descEl = document.querySelector('.product-description, .description, [class*="desc"], article p');
    const description = descEl ? descEl.innerText.trim().slice(0, 2000) : null;

    // Extract specs
    const text = document.body.innerText.toLowerCase();

    if (text.includes('porcelain')) specs.material = 'Porcelain';
    else if (text.includes('ceramic')) specs.material = 'Ceramic';
    else if (text.includes('marble')) specs.material = 'Marble';
    else if (text.includes('granite')) specs.material = 'Granite';
    else if (text.includes('travertine')) specs.material = 'Travertine';
    else if (text.includes('limestone')) specs.material = 'Limestone';

    if (text.includes('polished')) specs.finish = 'Polished';
    else if (text.includes('matte')) specs.finish = 'Matte';
    else if (text.includes('honed')) specs.finish = 'Honed';
    else if (text.includes('tumbled')) specs.finish = 'Tumbled';
    else if (text.includes('brushed')) specs.finish = 'Brushed';

    const sizeMatch = text.match(/(\d+)\s*[x×]\s*(\d+)/);
    if (sizeMatch) {
      specs.size = `${sizeMatch[1]}x${sizeMatch[2]}`;
    }

    return { images, description, specs: Object.keys(specs).length > 0 ? specs : null };
  });

  // Merge: utility-extracted first, then page-extracted ones not already present
  const allImageUrls = [...utilityImages];
  for (const url of data.images) {
    if (!allImageUrls.some(u => u.split('?')[0] === url.split('?')[0])) {
      allImageUrls.push(url);
    }
  }

  // Extract spec PDFs while on the detail page
  const pdfs = await extractSpecPDFs(page).catch(() => []);

  if (allImageUrls.length === 0 && !data.description && !data.specs && pdfs.length === 0) return null;
  return { images: allImageUrls, pdfs: pdfs.length > 0 ? pdfs : null, description: data.description, specs: data.specs };
}
