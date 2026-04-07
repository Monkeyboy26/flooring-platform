import {
  launchBrowser, delay, upsertMediaAsset, upsertSkuAttribute,
  appendLog, addJobError, preferProductShot, filterImageUrls,
  extractLargeImages, collectSiteWideImages,
  extractSpecPDFs, normalizeTriwestName
} from './base.js';

const BASE_URL = 'https://www.jmcork.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_ERRORS = 30;
const BATCH_SIZE = 15;

/**
 * JM Cork enrichment scraper for Tri-West.
 *
 * Scrapes jmcork.com for product images, descriptions, and specs.
 * Enriches EXISTING Tri-West SKUs — never creates new products.
 * Tech: Unknown (specialty cork brand)
 *
 * Runs AFTER import-triwest-832.cjs populates SKUs in the DB.
 */
export async function run(pool, job, source) {
  const config = source.config || {};
  const delayMs = config.delay_ms || 2000;
  const vendor_id = source.vendor_id;
  const brandPrefix = 'JM Cork';

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

    // Check which products already have a primary image — skip those
    const existingImages = await pool.query(`
      SELECT DISTINCT ma.product_id
      FROM media_assets ma
      JOIN products p ON p.id = ma.product_id
      WHERE p.vendor_id = $1 AND ma.asset_type = 'primary'
    `, [vendor_id]);
    const alreadyHaveImages = new Set(existingImages.rows.map(r => r.product_id));

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
 * Attempts to find product on JM Cork site.
 * Returns { images: [], description: string, specs: {}, specPdfs: [] } or null.
 */
async function findProductOnSite(page, group, delayMs, siteWideImages) {
  try {
    const normalizedName = normalizeTriwestName(group.name);
    const normalizedCollection = normalizeTriwestName(group.collection);
    const searchTerms = [
      group.name,
      normalizedName,
      normalizedCollection,
      group.collection.replace(/^JM\s+Cork\s*/i, '').trim(),
      group.skus[0]?.variant_name
    ].filter(Boolean);

    // Strategy 1: Navigate to products/flooring section
    try {
      await page.goto(BASE_URL, { waitUntil: 'networkidle2', timeout: 10000 });
      await delay(1000);

      // Look for cork flooring product links
      const productLinks = await page.$$eval('a[href*="product"], a[href*="floor"], a[href*="cork"], a[href*="collection"]', links =>
        links.map(a => ({ text: a.textContent.trim(), href: a.href }))
      );

      if (productLinks.length > 0) {
        for (const term of searchTerms) {
          const match = productLinks.find(link =>
            link.text.toLowerCase().includes(term.toLowerCase()) ||
            link.href.toLowerCase().includes(term.toLowerCase().replace(/\s+/g, '-'))
          );

          if (match) {
            await page.goto(match.href, { waitUntil: 'networkidle2', timeout: 10000 });
            await delay(1000);

            const data = await extractProductData(page, group.name, siteWideImages);
            if (data) return data;
          }
        }
      }
    } catch (navErr) {
      // Navigation failed
    }

    // Strategy 2: Try search functionality
    try {
      const hasSearch = await page.$('input[type="search"], input[name*="search"], input[placeholder*="Search"]');
      if (hasSearch) {
        await page.type('input[type="search"], input[name*="search"], input[placeholder*="Search"]', searchTerms[0]);
        await Promise.race([
          page.waitForNavigation({ timeout: 5000 }),
          page.keyboard.press('Enter')
        ]);
        await delay(1000);

        const data = await extractProductData(page, group.name, siteWideImages);
        if (data) return data;
      }
    } catch (searchErr) {
      // Search failed
    }

    // Strategy 3: Generic extraction from current page
    const genericData = await extractProductData(page, group.name, siteWideImages);
    return genericData;

  } catch (err) {
    return null;
  }
}

/**
 * Extracts product data from current page using extractLargeImages consistently.
 */
async function extractProductData(page, productName, siteWideImages) {
  try {
    // Use extractLargeImages for consistent image filtering
    const largeImgs = await extractLargeImages(page, siteWideImages || new Set(), 150);
    const images = largeImgs.map(img => img.src);

    // Extract spec PDFs
    const specPdfs = await extractSpecPDFs(page);

    const description = await page.evaluate(() => {
      const selectors = ['.description', '.product-description', 'p', 'article p', '.content'];
      for (const sel of selectors) {
        const elem = document.querySelector(sel);
        if (elem && elem.textContent.trim().length > 50) {
          return elem.textContent.trim();
        }
      }
      return null;
    });

    const specs = {};
    try {
      const specText = await page.evaluate(() => document.body.innerText);

      // Cork-specific specs
      const thicknessMatch = specText.match(/thickness[:\s]+([0-9/.]+\s*(?:mm|inch|in))/i);
      if (thicknessMatch) specs.thickness = thicknessMatch[1].trim();

      const widthMatch = specText.match(/width[:\s]+([0-9/.]+\s*(?:mm|inch|in|"))/i);
      if (widthMatch) specs.width = widthMatch[1].trim();

      const lengthMatch = specText.match(/length[:\s]+([0-9/.]+\s*(?:mm|inch|in|ft))/i);
      if (lengthMatch) specs.length = lengthMatch[1].trim();

      const densityMatch = specText.match(/density[:\s]+([0-9.]+\s*(?:kg\/m|lb\/ft))/i);
      if (densityMatch) specs.density = densityMatch[1].trim();

      const finishMatch = specText.match(/finish[:\s]+([a-z\s]+)/i);
      if (finishMatch) specs.finish = finishMatch[1].trim();

      const installMatch = specText.match(/installation[:\s]+([a-z\s]+(?:click|glue|floating))/i);
      if (installMatch) specs.installation_method = installMatch[1].trim();

      const coreMatch = specText.match(/core[:\s]+([a-z\s]+)/i);
      if (coreMatch) specs.core = coreMatch[1].trim();
    } catch (specErr) {
      // Specs extraction failed
    }

    if (images.length === 0 && !description && Object.keys(specs).length === 0) {
      return null;
    }

    return {
      images: images.length > 0 ? images : null,
      description,
      specs: Object.keys(specs).length > 0 ? specs : null,
      pdfs: specPdfs,
    };
  } catch (err) {
    return null;
  }
}
