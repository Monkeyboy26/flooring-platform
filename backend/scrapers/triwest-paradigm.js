import {
  launchBrowser, delay, upsertMediaAsset, upsertSkuAttribute,
  appendLog, addJobError, downloadImage, resolveImageExtension, preferProductShot
} from './base.js';

const BASE_URL = 'https://www.paradigmflooring.net';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_ERRORS = 30;

/**
 * Paradigm enrichment scraper for Tri-West.
 *
 * Scrapes paradigmflooring.net for product images, descriptions, and specs.
 * Enriches EXISTING Tri-West SKUs — never creates new products.
 * Tech: Wix (Thunderbolt)
 *
 * Runs AFTER triwest-catalog.js populates SKUs in the DB.
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
 * Find a product on paradigmflooring.net and extract images/specs.
 * Returns { images: string[], description: string, specs: object } or null.
 *
 * Paradigm is a Wix (Thunderbolt) site.
 * Product URLs: /items/{bird-name-slug} (e.g., /items/oriole, /items/falcon)
 * Images: static.wixstatic.com/media/497d1e_{hash}~mv2.jpg with fill params
 * Specs: rendered dynamically by Wix — extract from page text via keyword matching
 * Collections: Performer, Performer 20mil, Paradigm Insignia, Conquest, Odyssey, Performer Painted Bevel
 */
async function findProductOnSite(page, productGroup, delayMs) {
  const colorName = productGroup.name;
  const slug = colorName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

  try {
    // Strategy 1: Try direct item page by color name slug
    let found = await tryParadigmPage(page, `${BASE_URL}/items/${slug}`, delayMs);
    if (found) return found;

    // Strategy 2: Try without hyphens (single word slugs like /items/oriole)
    const singleSlug = colorName.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (singleSlug !== slug) {
      found = await tryParadigmPage(page, `${BASE_URL}/items/${singleSlug}`, delayMs);
      if (found) return found;
    }

    // Strategy 3: Try with first word only (for multi-word color names)
    const firstWord = colorName.toLowerCase().split(/\s+/)[0];
    if (firstWord !== slug && firstWord !== singleSlug) {
      found = await tryParadigmPage(page, `${BASE_URL}/items/${firstWord}`, delayMs);
      if (found) return found;
    }

    // Strategy 4: Browse homepage and find matching links in gallery
    return await findParadigmViaGallery(page, productGroup, delayMs);
  } catch {
    return null;
  }
}

/** Try loading a Paradigm page and extracting data */
async function tryParadigmPage(page, url, delayMs) {
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 });
    await delay(delayMs + 1000); // Extra delay for Wix dynamic rendering

    const is404 = await page.evaluate(() => {
      const body = document.body?.textContent || '';
      return body.includes('Page not found') || body.includes("This page isn't available") ||
             document.title.includes('404');
    });

    if (is404) return null;

    return await extractParadigmData(page);
  } catch {
    return null;
  }
}

/** Extract product data from a Paradigm Wix page */
async function extractParadigmData(page) {
  // Wait for Wix to render dynamic content
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await delay(1000);
  await page.evaluate(() => window.scrollTo(0, 0));
  await delay(500);

  const data = await page.evaluate(() => {
    const images = [];

    // Wix-hosted images (static.wixstatic.com)
    document.querySelectorAll('img[src*="wixstatic"], img[src*="wix.com"], wow-image img').forEach(img => {
      let src = img.src || img.dataset.src || img.currentSrc;
      if (src && src.includes('wixstatic') && !src.includes('logo') && !src.includes('icon') && !src.includes('favicon')) {
        // Normalize Wix image URL — remove fill params and request a high-res version
        const base = src.split('/v1/fill/')[0];
        if (base.includes('wixstatic')) {
          images.push(base);
        } else {
          images.push(src);
        }
      }
    });

    // Also check background images from Wix components
    document.querySelectorAll('[data-bg], [style*="background-image"]').forEach(el => {
      const bgUrl = el.dataset.bg || (el.style.backgroundImage || '').match(/url\(["']?([^"')]+)/)?.[1];
      if (bgUrl && bgUrl.includes('wixstatic') && !bgUrl.includes('logo')) {
        images.push(bgUrl.split('/v1/fill/')[0]);
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
      if (!specs.size && line.match(/\d+["″']?\s*x\s*\d+["″']?/)) {
        const dimMatch = line.match(/(\d+["″']?\s*x\s*\d+["″']?)/);
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

  if (data.images.length === 0 && !data.description && !data.specs) return null;
  return data;
}

/** Fallback: browse Paradigm homepage/gallery to find product links */
async function findParadigmViaGallery(page, productGroup, delayMs) {
  const colorName = productGroup.name;
  try {
    await page.goto(BASE_URL, { waitUntil: 'networkidle2', timeout: 20000 });
    await delay(delayMs + 1000);

    const productUrl = await page.evaluate((name) => {
      const nameLower = name.toLowerCase();
      const links = document.querySelectorAll('a[href*="/items/"]');
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

    await page.goto(productUrl, { waitUntil: 'networkidle2', timeout: 20000 });
    await delay(delayMs + 1000);

    return await extractParadigmData(page);
  } catch {
    return null;
  }
}
