import {
  launchBrowser, delay, upsertMediaAsset, upsertSkuAttribute,
  appendLog, addJobError, preferProductShot, filterImageUrls,
  extractLargeImages, collectSiteWideImages,
  extractSpecPDFs, normalizeTriwestName
} from './base.js';

const BASE_URL = 'https://elysiumtile.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_ERRORS = 30;
const BATCH_SIZE = 15;

/**
 * Elysium enrichment scraper for Tri-West.
 *
 * Scrapes elysiumtile.com for product images, descriptions, and specs.
 * Enriches EXISTING Tri-West SKUs — never creates new products.
 * Tech: Custom PHP
 *
 * Runs AFTER import-triwest-832.cjs populates SKUs in the DB.
 */
export async function run(pool, job, source) {
  const config = source.config || {};
  const delayMs = config.delay_ms || 2000;
  const vendor_id = source.vendor_id;
  const brandPrefix = 'Elysium';

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
 * Searches Elysium site for product and extracts images/specs.
 * Strategy: Browse product listings page and find matching links by name,
 * then navigate to the product detail page.
 */
async function findProductOnSite(page, group, delayMs, siteWideImages) {
  const searchName = group.name.trim();
  const normalizedName = normalizeTriwestName(searchName);
  const collectionName = normalizeTriwestName(group.collection.replace(/^Elysium\s*-?\s*/i, ''));

  // Strategy 1: Navigate to products listing page and search for matching links
  const listingUrls = [
    `${BASE_URL}/products`,
    `${BASE_URL}/collections`,
    `${BASE_URL}/catalog`,
    BASE_URL,
  ];

  for (const listingUrl of listingUrls) {
    try {
      await page.goto(listingUrl, { waitUntil: 'networkidle2', timeout: 20000 });
      await delay(delayMs);

      // Search for links matching the product name or collection name
      const productUrl = await page.evaluate((name, normalized, collection) => {
        const nameLower = name.toLowerCase();
        const normalizedLower = normalized.toLowerCase();
        const collLower = collection.toLowerCase();

        const allLinks = Array.from(document.querySelectorAll('a[href]'));

        // Name match first (most precise)
        for (const a of allLinks) {
          const text = (a.textContent || '').toLowerCase().trim();
          const href = (a.getAttribute('href') || '').toLowerCase();
          if (text.includes(nameLower) || text.includes(normalizedLower) ||
              href.includes(nameLower.replace(/\s+/g, '-')) ||
              href.includes(normalizedLower.replace(/\s+/g, '-'))) {
            if (href.includes('product') || href.includes('collection') ||
                href.includes('catalog') || href.length > 20) {
              return a.href;
            }
          }
        }

        // Collection name match
        if (collLower) {
          for (const a of allLinks) {
            const text = (a.textContent || '').toLowerCase().trim();
            const href = (a.getAttribute('href') || '').toLowerCase();
            if (text.includes(collLower) || href.includes(collLower.replace(/\s+/g, '-'))) {
              if (href.includes('product') || href.includes('collection') || href.length > 20) {
                return a.href;
              }
            }
          }
        }

        return null;
      }, searchName, normalizedName, collectionName);

      if (productUrl) {
        await page.goto(productUrl, { waitUntil: 'networkidle2', timeout: 30000 });
        await delay(delayMs);
        const data = await extractProductData(page, siteWideImages);
        if (data) return data;
      }
    } catch { /* try next listing URL */ }
  }

  // Strategy 2: Build product URL from slug patterns
  const slug = normalizedName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  const slugPatterns = [
    `${BASE_URL}/products/${slug}`,
    `${BASE_URL}/product/${slug}`,
    `${BASE_URL}/collections/${slug}`,
  ];

  for (const productUrl of slugPatterns) {
    try {
      const response = await page.goto(productUrl, { waitUntil: 'networkidle2', timeout: 20000 });
      if (!response || response.status() === 404) continue;
      await delay(delayMs);

      const notFound = await page.evaluate(() => {
        const text = document.body.innerText.toLowerCase();
        return text.includes('not found') || text.includes('no product') ||
               text.includes('404') || text.includes('page doesn');
      });

      if (!notFound) {
        const data = await extractProductData(page, siteWideImages);
        if (data) return data;
      }
    } catch { /* try next pattern */ }
  }

  return null;
}

/**
 * Extracts product images, description, specs, and spec PDFs from Elysium product page.
 */
async function extractProductData(page, siteWideImages) {
  // Extract large images using utility (filters site-wide images)
  const largeImgs = await extractLargeImages(page, siteWideImages || new Set(), 150);
  const utilityImages = largeImgs.map(img => img.src);

  // Extract spec PDFs
  const pdfs = await extractSpecPDFs(page).catch(() => []);

  const data = await page.evaluate(() => {
    const images = [];
    const specs = {};

    // Extract images from product detail page
    document.querySelectorAll('img[src*="/static/images/product/"]').forEach(img => {
      const src = img.src;
      if (!src.includes('logo') && !src.includes('icon') && !images.includes(src)) {
        images.push(src);
      }
    });

    // Look for gallery or lightbox images
    document.querySelectorAll('a[href*="/static/images/product/"]').forEach(link => {
      const href = link.href;
      if (!href.includes('logo') && !href.includes('icon') && !images.includes(href)) {
        images.push(href);
      }
    });

    // Extract description
    const descEl = document.querySelector('.product-description, .description, [class*="desc"]');
    const description = descEl ? descEl.innerText.trim().slice(0, 2000) : null;

    // Extract specs from page content
    const text = document.body.innerText.toLowerCase();

    // Material
    if (text.includes('porcelain')) specs.material = 'Porcelain';
    else if (text.includes('ceramic')) specs.material = 'Ceramic';
    else if (text.includes('glass')) specs.material = 'Glass';
    else if (text.includes('stone')) specs.material = 'Stone';

    // Finish
    if (text.includes('polished')) specs.finish = 'Polished';
    else if (text.includes('matte')) specs.finish = 'Matte';
    else if (text.includes('honed')) specs.finish = 'Honed';
    else if (text.includes('glossy')) specs.finish = 'Glossy';

    // Size extraction
    const sizeMatch = text.match(/(\d+)\s*[x\u00d7]\s*(\d+)/);
    if (sizeMatch) {
      specs.size = `${sizeMatch[1]}x${sizeMatch[2]}`;
    }

    // PEI rating for tile
    const peiMatch = text.match(/pei\s*[:\-]?\s*(\d)/i);
    if (peiMatch) {
      specs.pei_rating = peiMatch[1];
    }

    // Wear layer
    const wearMatch = text.match(/wear\s*layer[:\s]+([0-9.]+\s*(?:mm|mil))/i);
    if (wearMatch) specs.wear_layer = wearMatch[1];

    // Thickness
    const thicknessMatch = text.match(/thickness[:\s]+([0-9/.]+\s*(?:mm|"|in))/i);
    if (thicknessMatch) specs.thickness = thicknessMatch[1];

    return {
      images,
      description,
      specs: Object.keys(specs).length > 0 ? specs : null,
    };
  });

  // Merge: utility-extracted first, then page-extracted ones not already present
  const allImageUrls = [...utilityImages];
  for (const url of data.images) {
    if (!allImageUrls.some(u => u.split('?')[0] === url.split('?')[0])) {
      allImageUrls.push(url);
    }
  }

  if (allImageUrls.length === 0 && !data.description && !data.specs && pdfs.length === 0) return null;
  return {
    images: allImageUrls,
    description: data.description,
    specs: data.specs,
    pdfs: pdfs.length > 0 ? pdfs : null,
  };
}
