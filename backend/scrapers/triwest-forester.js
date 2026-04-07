import {
  launchBrowser, delay, upsertMediaAsset, upsertSkuAttribute,
  appendLog, addJobError, preferProductShot, filterImageUrls,
  extractLargeImages, collectSiteWideImages,
  extractSpecPDFs, normalizeTriwestName
} from './base.js';

const BASE_URL = 'https://www.paradigmflooring.net';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_ERRORS = 30;
const BATCH_SIZE = 15;

/**
 * Forester enrichment scraper for Tri-West.
 *
 * Forester is a Tri-West private label that rebrands Paradigm Flooring products.
 * Scrapes paradigmflooring.net for product images, descriptions, and specs.
 * Enriches EXISTING Tri-West SKUs — never creates new products.
 * Tech: Wix (client-side rendered)
 *
 * Collections mapping:
 *   Forester "Odyssey"   → Paradigm Odyssey 20 MIL WPC  (SKU: FOS70xx → 70xx)
 *   Forester "Conquest"  → Paradigm Conquest SPC         (SKU: FOSCONxxxxPAD → CONxxxx)
 *   Forester "Inception" → Paradigm Inception SPC/WPC    (SKU: FOSSHAWINxxxxx)
 *   Forester "Reserve"   → Paradigm Reserve              (SKU: FOS prefix)
 *
 * Paradigm site URL patterns:
 *   /paradigm-odyssey-20mil
 *   /paradigm-conquest-spc
 *   /paradigm-inception
 *   /paradigm-reserve
 *
 * Wix images: static.wixstatic.com/media/{hash}.jpg
 *
 * Runs AFTER import-triwest-832.cjs populates SKUs in the DB.
 */

// Map product line keyword → Paradigm collection page URL path
const COLLECTION_PAGES = {
  'odyssey': '/paradigm-odyssey-20mil',
  'conquest': '/paradigm-conquest-spc',
  'inception': '/paradigm-inception',
  'reserve': '/paradigm-reserve',
};

export async function run(pool, job, source) {
  const config = source.config || {};
  const delayMs = config.delay_ms || 3000; // Wix needs longer delays
  const vendor_id = source.vendor_id;
  const brandPrefix = 'Forester';

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

    await appendLog(pool, job.id, `Grouped into ${productGroups.size} products (${skippedExisting} already have images, ${toEnrich.length} to enrich)`);

    if (toEnrich.length === 0) {
      await appendLog(pool, job.id, 'All products already have images — nothing to enrich');
      return;
    }

    browser = await launchBrowser();
    let page = await browser.newPage();
    await page.setUserAgent(USER_AGENT);
    await page.setViewport({ width: 1440, height: 900 });

    // Phase 1: Crawl collection pages and build color → image map
    // Each collection page shows a grid of all colors with swatch/product images
    await appendLog(pool, job.id, 'Phase 1: Crawling Paradigm collection pages for product images...');

    // colorKey → { images: string[], specs: object }
    const colorImageMap = new Map();

    for (const [lineKey, pagePath] of Object.entries(COLLECTION_PAGES)) {
      if (pagesSinceLaunch >= BATCH_SIZE) {
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
        await page.goto(`${BASE_URL}${pagePath}`, { waitUntil: 'networkidle2', timeout: 45000 });
        await delay(delayMs);
        pagesSinceLaunch++;

        // Scroll to load lazy Wix images
        await autoScroll(page);
        await delay(2000);

        // Extract all Wix images and try to associate with color names
        const pageData = await page.evaluate(() => {
          const results = [];
          const specs = {};

          // Extract all wixstatic images (product swatches and room scenes)
          const allImages = [];
          document.querySelectorAll('img[src*="wixstatic.com"]').forEach(img => {
            const src = img.src || '';
            if (!src) return;
            const srcLower = src.toLowerCase();
            if (srcLower.includes('logo') || srcLower.includes('icon') || srcLower.includes('favicon')) return;

            // Get full-res by stripping /v1/fill/... resize params
            const fullRes = src.replace(/\/v1\/fill\/[^/]+\//, '/');
            const alt = (img.alt || '').trim();
            const title = (img.title || '').trim();
            const parentText = (img.closest('div, figure, a')?.textContent || '').trim();

            allImages.push({
              url: fullRes,
              alt,
              title,
              parentText: parentText.slice(0, 200),
              width: img.naturalWidth || 0,
              height: img.naturalHeight || 0,
            });
          });

          // Try to group images by color name from alt text, title, or nearby text
          const colorGroups = new Map();
          for (const img of allImages) {
            // Try to extract a color name from metadata
            const nameSource = img.alt || img.title || img.parentText;
            const nameParts = nameSource.split(/[,|\n]/).map(s => s.trim()).filter(Boolean);
            const colorName = nameParts[0] || '';

            if (colorName && colorName.length > 1 && colorName.length < 50) {
              const key = colorName.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
              if (!colorGroups.has(key)) colorGroups.set(key, []);
              colorGroups.get(key).push(img.url);
            } else {
              // Ungrouped images — add to a general bucket
              if (!colorGroups.has('_general')) colorGroups.set('_general', []);
              colorGroups.get('_general').push(img.url);
            }
          }

          // Extract specs from page text
          const text = document.body?.innerText || '';
          const wearMatch = text.match(/wear\s*layer[:\s]*([0-9.]+\s*(?:mil|mm))/i);
          if (wearMatch) specs.wear_layer = wearMatch[1];
          const thickMatch = text.match(/(?:total\s*)?thickness[:\s]*([0-9.]+\s*(?:mm|"|in))/i);
          if (thickMatch) specs.thickness = thickMatch[1];
          const widthMatch = text.match(/(?:plank\s*)?width[:\s]*([0-9.]+\s*(?:"|in|mm))/i);
          if (widthMatch) specs.size = widthMatch[1];
          if (text.match(/wpc/i)) specs.construction = 'WPC';
          else if (text.match(/spc/i)) specs.construction = 'SPC';

          // Convert Map to array for serialization
          const groups = [];
          for (const [name, urls] of colorGroups.entries()) {
            groups.push({ name, urls: [...new Set(urls)] });
          }

          return { groups, specs: Object.keys(specs).length > 0 ? specs : null, allImageCount: allImages.length };
        });

        await appendLog(pool, job.id, `  ${lineKey}: found ${pageData.allImageCount} images in ${pageData.groups.length} groups`);

        // Store extracted data keyed by collection line + color name
        for (const group of pageData.groups) {
          if (group.name === '_general') continue;
          const mapKey = `${lineKey}||${group.name}`;
          colorImageMap.set(mapKey, {
            images: group.urls.slice(0, 8),
            specs: pageData.specs,
          });
        }

        // Also store the general images under the line key for fallback
        const generalGroup = pageData.groups.find(g => g.name === '_general');
        if (generalGroup && generalGroup.urls.length > 0) {
          colorImageMap.set(`${lineKey}||_fallback`, {
            images: generalGroup.urls.slice(0, 4),
            specs: pageData.specs,
          });
        }

        // Store specs for the line even if no images matched
        if (pageData.specs) {
          colorImageMap.set(`${lineKey}||_specs`, { images: [], specs: pageData.specs });
        }

      } catch (err) {
        await logError(`Failed to crawl ${lineKey} collection page: ${err.message}`);
      }
    }

    await appendLog(pool, job.id, `Phase 1 complete: ${colorImageMap.size} color/image groups found`);

    // Phase 2: Match DB products to extracted images
    await appendLog(pool, job.id, 'Phase 2: Matching products to images...');
    let processed = 0;

    for (const [key, group] of toEnrich) {
      processed++;

      try {
        // Determine which product line this belongs to
        const nameLower = group.name.toLowerCase();
        let productLine = null;
        for (const lineKey of Object.keys(COLLECTION_PAGES)) {
          if (nameLower.includes(lineKey)) {
            productLine = lineKey;
            break;
          }
        }

        if (!productLine) {
          skusSkipped++;
          continue;
        }

        // Extract color name from collection: "Forester - AGORA - 9"X72"" → "agora"
        const collAfterPrefix = group.collection.replace(/^Forester\s*-\s*/i, '').trim();
        const colorName = collAfterPrefix
          .replace(/\s*-?\s*\d+["']?\s*[xX×]\s*\d+["']?.*$/, '')  // strip dimensions
          .replace(/\s*-?\s*\d+\s*(MIL|mil).*$/, '')                // strip mil spec
          .replace(/\s*-?\s*94\.49"?.*$/, '')                       // strip stair nose length
          .replace(/\s*-?\s*60"?.*$/, '')                           // strip tread length
          .replace(/\s*-?\s*48"?.*$/, '')                           // strip flush stair length
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, ' ')
          .trim();

        if (!colorName) {
          skusSkipped++;
          continue;
        }

        // Try exact match first, then fuzzy
        let matchData = colorImageMap.get(`${productLine}||${colorName}`);

        // Try partial matching if exact fails
        if (!matchData) {
          for (const [mapKey, data] of colorImageMap.entries()) {
            if (!mapKey.startsWith(productLine + '||')) continue;
            const mapColor = mapKey.split('||')[1];
            if (mapColor === '_general' || mapColor === '_fallback' || mapColor === '_specs') continue;
            if (mapColor.includes(colorName) || colorName.includes(mapColor)) {
              matchData = data;
              break;
            }
          }
        }

        // Fall back to collection-level specs even if no image match
        const specsData = matchData || colorImageMap.get(`${productLine}||_specs`);

        if (!matchData && !specsData) {
          skusSkipped++;
          continue;
        }

        // Save images
        const images = matchData?.images || [];
        if (images.length > 0) {
          const filtered = filterImageUrls(images, { maxImages: 8 });
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

        // Save specs (if product has SKUs)
        const specs = specsData?.specs;
        if (specs && group.skus.length > 0) {
          for (const sku of group.skus) {
            for (const [attrSlug, value] of Object.entries(specs)) {
              if (value) await upsertSkuAttribute(pool, sku.sku_id, attrSlug, value);
            }
          }
        }
        skusEnriched++;
      } catch (err) {
        await logError(`${group.collection} / ${group.name}: ${err.message}`);
        skusSkipped++;
      }

      if (processed % 50 === 0) {
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

/** Scroll page to trigger Wix lazy-loaded images */
async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise(resolve => {
      let totalHeight = 0;
      const distance = 400;
      const timer = setInterval(() => {
        window.scrollBy(0, distance);
        totalHeight += distance;
        if (totalHeight >= document.body.scrollHeight) {
          clearInterval(timer);
          window.scrollTo(0, 0);
          resolve();
        }
      }, 150);
    });
  });
}
