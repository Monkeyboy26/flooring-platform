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
 * Paradigm enrichment scraper for Tri-West.
 *
 * Scrapes paradigmflooring.net for product images, descriptions, and specs.
 * Enriches EXISTING Tri-West SKUs — never creates new products.
 * Tech: Wix (Thunderbolt)
 *
 * Runs AFTER import-triwest-832.cjs populates SKUs in the DB.
 */
export async function run(pool, job, source) {
  const config = source.config || {};
  const delayMs = config.delay_ms || 2000;
  const vendor_id = source.vendor_id;
  const brandPrefix = 'Paradigm';

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

    // Launch browser
    browser = await launchBrowser();
    let page = await browser.newPage();
    await page.setUserAgent(USER_AGENT);
    await page.setViewport({ width: 1440, height: 900 });

    // Collect site-wide images to exclude
    await appendLog(pool, job.id, `Collecting site-wide images from ${BASE_URL}...`);
    const siteWideImages = await collectSiteWideImages(page, BASE_URL);
    await appendLog(pool, job.id, `Found ${siteWideImages.size} site-wide images to exclude`);
    pagesSinceLaunch++;

    // Scrape product pages and enrich
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
        const normalizedName = normalizeTriwestName(group.name);
        const productData = await findProductOnSite(page, group, normalizedName, delayMs, siteWideImages);
        pagesSinceLaunch++;

        if (!productData) {
          skusSkipped++;
          continue;
        }

        // Update description if we found one and DB is empty
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

        // Upsert specs as SKU attributes
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
 * Find a product on paradigmflooring.net and extract images/specs.
 * Returns { images: string[], description: string, specs: object, pdfs: array } or null.
 *
 * Paradigm is a Wix (Thunderbolt) site.
 * Product URLs: /items/{bird-name-slug} (e.g., /items/oriole, /items/falcon)
 * Images: static.wixstatic.com/media/497d1e_{hash}~mv2.jpg with fill params
 * Specs: rendered dynamically by Wix — extract from page text via keyword matching
 * Collections: Performer, Performer 20mil, Paradigm Insignia, Conquest, Odyssey, Performer Painted Bevel
 */
async function findProductOnSite(page, productGroup, normalizedName, delayMs, siteWideImages) {
  const colorName = productGroup.name;
  const slug = colorName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  const normalizedSlug = normalizedName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

  try {
    // Strategy 1: Try direct item page by color name slug
    let found = await tryParadigmPage(page, `${BASE_URL}/items/${slug}`, delayMs, siteWideImages);
    if (found) return found;

    // Strategy 1b: Try with normalized name slug
    if (normalizedSlug !== slug) {
      found = await tryParadigmPage(page, `${BASE_URL}/items/${normalizedSlug}`, delayMs, siteWideImages);
      if (found) return found;
    }

    // Strategy 2: Try without hyphens (single word slugs like /items/oriole)
    const singleSlug = colorName.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (singleSlug !== slug) {
      found = await tryParadigmPage(page, `${BASE_URL}/items/${singleSlug}`, delayMs, siteWideImages);
      if (found) return found;
    }

    // Strategy 3: Try with first word only (for multi-word color names)
    const firstWord = colorName.toLowerCase().split(/\s+/)[0];
    if (firstWord !== slug && firstWord !== singleSlug) {
      found = await tryParadigmPage(page, `${BASE_URL}/items/${firstWord}`, delayMs, siteWideImages);
      if (found) return found;
    }

    // Strategy 4: Browse homepage and find matching links in gallery
    return await findParadigmViaGallery(page, productGroup, normalizedName, delayMs, siteWideImages);
  } catch {
    return null;
  }
}

/** Try loading a Paradigm page and extracting data */
async function tryParadigmPage(page, url, delayMs, siteWideImages) {
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 });
    await delay(delayMs + 1000); // Extra delay for Wix dynamic rendering

    const is404 = await page.evaluate(() => {
      const body = document.body?.textContent || '';
      return body.includes('Page not found') || body.includes("This page isn't available") ||
             document.title.includes('404');
    });

    if (is404) return null;

    return await extractParadigmData(page, siteWideImages);
  } catch {
    return null;
  }
}

/** Extract product data from a Paradigm Wix page */
async function extractParadigmData(page, siteWideImages) {
  // Wait for Wix to render dynamic content
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await delay(1000);
  await page.evaluate(() => window.scrollTo(0, 0));
  await delay(500);

  // Extract large images using utility (filters site-wide images)
  const largeImgs = await extractLargeImages(page, siteWideImages, 150);
  const utilityImages = largeImgs.map(img => img.src);

  // Extract spec PDFs
  const specPdfs = await extractSpecPDFs(page);

  const data = await page.evaluate(() => {
    const images = [];

    // Wix-hosted images (static.wixstatic.com)
    document.querySelectorAll('img[src*="wixstatic"], img[src*="wix.com"], wow-image img').forEach(img => {
      let src = img.src || img.dataset.src || img.currentSrc;
      if (src && src.includes('wixstatic') && !src.includes('logo') && !src.includes('icon') && !src.includes('favicon')) {
        // Normalize Wix image URL — preserve the /v1/fill/ base but request high-res
        // Original: .../v1/fill/w_600,h_400,.../image.jpg
        // High-res: .../v1/fill/w_1920,h_1920,al_c,q_90/image.jpg
        const fillMatch = src.match(/^(.*\/v1\/fill\/)[^/]+(\/[^/]+)$/);
        if (fillMatch) {
          images.push(`${fillMatch[1]}w_1920,h_1920,al_c,q_90${fillMatch[2]}`);
        } else {
          // No fill params — use the base media URL directly
          const mediaBase = src.split('/v1/')[0];
          if (mediaBase.includes('wixstatic')) {
            images.push(mediaBase);
          } else {
            images.push(src);
          }
        }
      }
    });

    // Also check background images from Wix components
    document.querySelectorAll('[data-bg], [style*="background-image"]').forEach(el => {
      const bgUrl = el.dataset.bg || (el.style.backgroundImage || '').match(/url\(["']?([^"')]+)/)?.[1];
      if (bgUrl && bgUrl.includes('wixstatic') && !bgUrl.includes('logo')) {
        const fillMatch = bgUrl.match(/^(.*\/v1\/fill\/)[^/]+(\/[^/]+)$/);
        if (fillMatch) {
          images.push(`${fillMatch[1]}w_1920,h_1920,al_c,q_90${fillMatch[2]}`);
        } else {
          images.push(bgUrl.split('/v1/')[0]);
        }
      }
    });

    // Extract specs from Wix page text (dynamically rendered)
    const specs = {};
    const textContent = document.body?.innerText || '';
    const lines = textContent.split('\n').map(l => l.trim()).filter(Boolean);

    for (const line of lines) {
      const match = line.match(/^(thickness|width|length|wear\s*layer|finish|edge|species|material|construction|warranty|size|plank\s*size|sq\.?\s*ft)[:\s-]+(.+)/i);
      if (match) {
        const label = match[1].toLowerCase().trim();
        const value = match[2].trim();
        if (label.includes('thickness')) specs.thickness = value;
        if (label.includes('width') || label.includes('size') || label.includes('plank')) specs.size = value;
        if (label.includes('wear')) specs.wear_layer = value;
        if (label.includes('finish')) specs.finish = value;
        if (label.includes('edge')) specs.edge = value;
        if (label.includes('species') || label.includes('material')) specs.material = value;
        if (label.includes('construction')) specs.construction = value;
        if (label.includes('warranty')) specs.warranty = value;
        if (label.includes('sq')) specs.sqft_per_carton = value;
      }
      // Dimension pattern: 7" x 48" or 7 x 48
      if (!specs.size && line.match(/\d+[""\u2033']?\s*x\s*\d+[""\u2033']?/)) {
        const dimMatch = line.match(/(\d+[""\u2033']?\s*x\s*\d+[""\u2033']?)/);
        if (dimMatch) specs.size = dimMatch[1];
      }
    }

    // Description
    const descEl = document.querySelector('[data-testid="richTextElement"] p, p[class*="font"], article p');
    const description = descEl ? descEl.textContent.trim().slice(0, 2000) : null;

    return {
      images: [...new Set(images)],
      description,
      specs: Object.keys(specs).length > 0 ? specs : null,
    };
  });

  // Merge utility-extracted images with page-extracted images
  const mergedImages = [...new Set([...utilityImages, ...data.images])];
  data.images = mergedImages;
  data.pdfs = specPdfs;

  if (data.images.length === 0 && !data.description && !data.specs) return null;
  return data;
}

/** Fallback: browse Paradigm homepage/gallery to find product links */
async function findParadigmViaGallery(page, productGroup, normalizedName, delayMs, siteWideImages) {
  const colorName = productGroup.name;
  try {
    await page.goto(BASE_URL, { waitUntil: 'networkidle2', timeout: 20000 });
    await delay(delayMs + 1000);

    const productUrl = await page.evaluate((name, normalized) => {
      const nameLower = name.toLowerCase();
      const normalizedLower = normalized.toLowerCase();
      const links = document.querySelectorAll('a[href*="/items/"]');
      for (const a of links) {
        const text = (a.textContent || '').toLowerCase();
        const href = (a.getAttribute('href') || '').toLowerCase();
        if (text.includes(nameLower) || href.includes(nameLower.replace(/\s+/g, '-')) ||
            text.includes(normalizedLower) || href.includes(normalizedLower.replace(/\s+/g, '-'))) {
          return a.href;
        }
      }
      return null;
    }, colorName, normalizedName);

    if (!productUrl) return null;

    await page.goto(productUrl, { waitUntil: 'networkidle2', timeout: 20000 });
    await delay(delayMs + 1000);

    return await extractParadigmData(page, siteWideImages);
  } catch {
    return null;
  }
}
