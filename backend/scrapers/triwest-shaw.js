import {
  launchBrowser, delay, upsertMediaAsset, upsertSkuAttribute,
  appendLog, addJobError,
  extractLargeImages, collectSiteWideImages,
  extractSpecPDFs
} from './base.js';

const BASE_URL = 'https://shawfloors.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_ERRORS = 30;

/**
 * Shaw enrichment scraper.
 *
 * Scrapes shawfloors.com for product images, descriptions, and specs.
 * Enriches EXISTING Shaw SKUs (from 832 EDI import) — never creates new products.
 * Tech: React SSR, Widen DAM images
 *
 * Runs AFTER shaw-832 import populates SKUs in the DB.
 */
export async function run(pool, job, source) {
  const config = source.config || {};
  const delayMs = config.delay_ms || 2000;
  const vendor_id = source.vendor_id;
  const brandPrefix = 'Shaw';

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
    // Load existing Shaw products (includes SKU-less products from DNav)
    const prodResult = await pool.query(`
      SELECT p.id AS product_id, p.name, p.collection, p.description_long
      FROM products p
      WHERE p.vendor_id = $1
    `, [vendor_id]);

    // Also load SKU data for products that have it
    const skuResult = await pool.query(`
      SELECT s.id AS sku_id, s.vendor_sku, s.internal_sku, s.variant_name, s.product_id
      FROM skus s
      JOIN products p ON p.id = s.product_id
      WHERE p.vendor_id = $1 AND s.status = 'active'
    `, [vendor_id]);

    await appendLog(pool, job.id, `Found ${prodResult.rows.length} ${brandPrefix} products (${skuResult.rows.length} SKUs) to enrich`);

    if (prodResult.rows.length === 0) {
      await appendLog(pool, job.id, `No ${brandPrefix} products found — run shaw-832 import first`);
      return;
    }

    // Build SKU lookup by product_id
    const skusByProduct = new Map();
    for (const row of skuResult.rows) {
      if (!skusByProduct.has(row.product_id)) skusByProduct.set(row.product_id, []);
      skusByProduct.get(row.product_id).push(row);
    }

    // Group products by product_id
    const productGroups = new Map();
    for (const row of prodResult.rows) {
      const key = row.product_id;
      if (!productGroups.has(key)) {
        productGroups.set(key, {
          product_id: row.product_id, name: row.name, collection: row.collection,
          skus: skusByProduct.get(row.product_id) || [],
        });
      }
    }

    await appendLog(pool, job.id, `Grouped into ${productGroups.size} products (${skuResult.rows.length} with SKUs)`);

    // Launch browser
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setUserAgent(USER_AGENT);
    await page.setViewport({ width: 1440, height: 900 });

    // Collect site-wide images to exclude
    await appendLog(pool, job.id, `Collecting site-wide images from ${BASE_URL}...`);
    const siteWideImages = await collectSiteWideImages(page, BASE_URL);
    await appendLog(pool, job.id, `Found ${siteWideImages.size} site-wide images to exclude`);

    // Scrape product pages and enrich
    let processed = 0;
    for (const [key, group] of productGroups) {
      processed++;

      try {
        const productData = await findProductOnSite(page, group, delayMs, siteWideImages, pool, job);

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

        // Upsert product-level images (primary + alternates)
        if (productData.images && productData.images.length > 0) {
          for (let i = 0; i < productData.images.length; i++) {
            await upsertMediaAsset(pool, {
              product_id: group.product_id,
              sku_id: null,
              asset_type: i === 0 ? 'primary' : 'alternate',
              url: productData.images[i],
              original_url: productData.images[i],
              sort_order: i,
            });
            imagesAdded++;
          }
        }

        // Upsert spec PDFs (product-level)
        if (productData.specPdfs && productData.specPdfs.length > 0) {
          for (let i = 0; i < productData.specPdfs.length; i++) {
            await upsertMediaAsset(pool, {
              product_id: group.product_id,
              sku_id: null,
              asset_type: 'spec_pdf',
              url: productData.specPdfs[i].url,
              original_url: productData.specPdfs[i].url,
              sort_order: i,
            });
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
 * Find a product on shawfloors.com and extract images/specs.
 *
 * With 832 EDI data, vendor_sku contains style names (e.g., "ACADIA PARK")
 * and variant_name has clean colors (e.g., "DELICATE").
 *
 * Strategy:
 *   A. Search shawfloors.com using title-cased style name (primary)
 *   B. Fall back to direct URL construction using vendor_sku as collection slug
 *   C. Parse JSON-LD for Product data (handles @graph nesting)
 *   D. Extract Widen DAM URLs from script tags, img src, data-src, and srcset
 *   E. Extract spec PDFs
 *   F. Fall back to extractLargeImages for remaining images
 */
async function findProductOnSite(page, productGroup, delayMs, siteWideImages, pool, job) {
  const firstSku = productGroup.skus[0] || {};
  const vendorSku = firstSku.vendor_sku || '';
  const variantName = firstSku.variant_name || '';

  // Title-case ALL-CAPS style names: "ACADIA PARK" → "Acadia Park"
  const styleName = vendorSku
    .split(/\s+/)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
  const colorName = variantName
    .split(/\s+/)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');

  // Build search terms: style name first (most specific), then with color, then product name
  const searchTerms = [
    styleName,
    colorName && styleName ? `${styleName} ${colorName}` : '',
    productGroup.name,
  ].filter(Boolean);
  const uniqueSearchTerms = [...new Set(searchTerms)];

  let detailUrl = null;

  // Strategy A: Search shawfloors.com (primary — works well with 832 style names)
  for (const searchTerm of uniqueSearchTerms) {
    try {
      await page.goto(`${BASE_URL}/en-us/search?query=${encodeURIComponent(searchTerm)}`, {
        waitUntil: 'networkidle2', timeout: 20000,
      });
      await delay(delayMs);
      await page.waitForSelector('a[href*="/en-us/"]', { timeout: 8000 }).catch(() => null);

      detailUrl = await page.evaluate(() => {
        const categorySegments = ['/hardwood/', '/vinyl/', '/laminate/', '/tile-stone/', '/carpet/'];
        const categoryRoots = ['/hardwood', '/vinyl', '/laminate', '/tile-stone', '/carpet'];

        // First pass: look for deep product links (collection/color pattern)
        for (const a of document.querySelectorAll('a[href*="/en-us/"]')) {
          const href = a.getAttribute('href') || '';
          if (categorySegments.some(c => href.includes(c))) {
            const afterEnUs = href.split('/en-us/')[1] || '';
            const segments = afterEnUs.split('/').filter(Boolean);
            if (segments.length >= 3) {
              return href.startsWith('http') ? href : 'https://shawfloors.com' + href;
            }
          }
        }

        // Second pass: any product-area link that isn't just a category root
        for (const a of document.querySelectorAll('a[href*="/en-us/"]')) {
          const href = a.getAttribute('href') || '';
          if (categorySegments.some(c => href.includes(c))) {
            const isRoot = categoryRoots.some(r => href.endsWith(r) || href.endsWith(r + '/'));
            if (!isRoot) {
              return href.startsWith('http') ? href : 'https://shawfloors.com' + href;
            }
          }
        }

        return null;
      });

      if (detailUrl) break;
    } catch { /* try next term */ }
  }

  // Strategy B: Fall back to direct URL construction using vendor_sku as collection slug
  if (!detailUrl) {
    const categories = ['hardwood', 'vinyl', 'laminate', 'tile-stone', 'carpet'];
    const collectionSlug = slugify(styleName);
    const colorSlug = slugify(colorName);

    if (collectionSlug) {
      for (const category of categories) {
        if (detailUrl) break;

        if (colorSlug) {
          const urlWithColor = `${BASE_URL}/en-us/${category}/${collectionSlug}/${colorSlug}`;
          const found = await tryDirectUrl(page, urlWithColor, delayMs);
          if (found) { detailUrl = found; break; }
        }

        const collectionUrl = `${BASE_URL}/en-us/${category}/${collectionSlug}`;
        const found = await tryDirectUrl(page, collectionUrl, delayMs);
        if (found) { detailUrl = found; break; }
      }
    }
  }

  if (!detailUrl) return null;

  // Navigate to product detail page
  await page.goto(detailUrl, { waitUntil: 'networkidle2', timeout: 20000 });
  await delay(delayMs);

  // Strategy 1: Parse JSON-LD for images and description (server-rendered, most reliable)
  // Handles both top-level @type: 'Product' and nested @graph arrays
  const jsonLdData = await page.evaluate(() => {
    let description = null;
    let images = [];

    function extractProductData(product) {
      if (product.description) description = product.description.trim().slice(0, 2000);
      if (product.image) {
        const imgList = Array.isArray(product.image) ? product.image : [product.image];
        for (const img of imgList) {
          if (typeof img === 'string' && img.startsWith('http')) {
            images.push(img);
          } else if (typeof img === 'object' && img !== null) {
            // Handle ImageObject format: { "@type": "ImageObject", "url": "..." }
            const url = img.url || img.contentUrl || '';
            if (typeof url === 'string' && url.startsWith('http')) images.push(url);
          }
        }
      }
    }

    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const d = JSON.parse(s.textContent);

        // Direct Product type
        if (d['@type'] === 'Product') {
          extractProductData(d);
          break;
        }

        // Handle nested JSON-LD (common in React SSR sites)
        // @graph is an array of typed objects
        if (Array.isArray(d['@graph'])) {
          const product = d['@graph'].find(item => item['@type'] === 'Product');
          if (product) {
            extractProductData(product);
            break;
          }
        }

        // Handle array of items at top level
        if (Array.isArray(d)) {
          const product = d.find(item => item['@type'] === 'Product');
          if (product) {
            extractProductData(product);
            break;
          }
        }
      } catch { /* skip malformed */ }
    }
    return { description, images };
  });

  // Strategy 2: Extract Widen DAM URLs from script tags, img src, data-src, and srcset
  const widenImages = await page.evaluate(() => {
    const results = [];
    const seen = new Set();

    // Helper to add a Widen URL if not already seen
    function addWiden(url) {
      if (!url || typeof url !== 'string') return;
      // Normalize: strip query params for dedup
      const clean = url.split('?')[0].toLowerCase();
      if (!clean.includes('widen.net/content/')) return;
      if (seen.has(clean)) return;
      seen.add(clean);
      results.push(url.split('?')[0]); // Store without query params
    }

    // Widen URL regex — matches full CDN URLs including path with extension
    const widenRegex = /https?:\/\/[a-z0-9.-]*widen\.net\/content\/[a-z0-9]+\/(?:jpeg|jpg|png|webp|gif)\/[a-z0-9_.%-]+/gi;

    // Search script tags for Widen URLs
    for (const s of document.querySelectorAll('script')) {
      const text = s.textContent || '';
      for (const m of text.matchAll(widenRegex)) {
        addWiden(m[0]);
      }
    }

    // Search <img> elements: src, data-src, srcset
    for (const img of document.querySelectorAll('img')) {
      const src = img.getAttribute('src') || '';
      const dataSrc = img.getAttribute('data-src') || '';
      const srcset = img.getAttribute('srcset') || '';

      for (const val of [src, dataSrc]) {
        if (val.includes('widen.net')) addWiden(val);
      }

      // Parse srcset: "url1 1x, url2 2x" or "url1 300w, url2 600w"
      if (srcset.includes('widen.net')) {
        for (const entry of srcset.split(',')) {
          const url = entry.trim().split(/\s+/)[0];
          if (url && url.includes('widen.net')) addWiden(url);
        }
      }
    }

    // Also check <source> elements (picture elements)
    for (const source of document.querySelectorAll('source')) {
      const srcset = source.getAttribute('srcset') || '';
      const src = source.getAttribute('src') || '';
      for (const val of [src]) {
        if (val.includes('widen.net')) addWiden(val);
      }
      if (srcset.includes('widen.net')) {
        for (const entry of srcset.split(',')) {
          const url = entry.trim().split(/\s+/)[0];
          if (url && url.includes('widen.net')) addWiden(url);
        }
      }
    }

    // Check inline styles and other attributes for background images
    for (const el of document.querySelectorAll('[style*="widen.net"]')) {
      const style = el.getAttribute('style') || '';
      for (const m of style.matchAll(widenRegex)) {
        addWiden(m[0]);
      }
    }

    return results;
  });

  // Strategy 3: Extract spec PDFs
  const specPdfs = await extractSpecPDFs(page);

  // Strategy 4: Use extractLargeImages for any remaining images
  const largeImages = await extractLargeImages(page, siteWideImages, 150);

  // Merge all image sources (JSON-LD first, then Widen from scripts/DOM, then large page images)
  const allImages = [...jsonLdData.images];
  const seen = new Set(allImages.map(u => u.split('?')[0].toLowerCase()));
  for (const url of [...widenImages, ...largeImages.map(img => img.src)]) {
    const clean = url.split('?')[0].toLowerCase();
    if (!seen.has(clean)) { seen.add(clean); allImages.push(url); }
  }

  // Specs
  const specs = await page.evaluate(() => {
    const result = {};
    document.querySelectorAll('tr').forEach(row => {
      const cells = row.querySelectorAll('td');
      if (cells.length >= 2) {
        const label = cells[0].textContent.trim().toLowerCase();
        const value = cells[1].textContent.trim();
        if (!label || !value) return;
        if (label.includes('thickness') && !label.includes('veneer')) result.thickness = value;
        if (label.includes('plank width') || (label.includes('width') && !label.includes('plank'))) result.size = value;
        if (label.includes('surface') || label.includes('texture')) result.finish = value;
        if (label.includes('species')) result.material = value;
        if (label.includes('edge')) result.edge = value;
        if (label.includes('construction')) result.construction = value;
        if (label.includes('installation method')) result.installation = value;
      }
    });
    return Object.keys(result).length > 0 ? result : null;
  });

  if (allImages.length === 0 && !jsonLdData.description && !specs && specPdfs.length === 0) return null;
  return { images: allImages, description: jsonLdData.description, specs, specPdfs };
}

/**
 * Try navigating directly to a URL and check if it's a valid product page.
 * Returns the URL if the page loaded successfully and appears to be a product page, null otherwise.
 */
async function tryDirectUrl(page, url, delayMs) {
  try {
    const response = await page.goto(url, { waitUntil: 'networkidle2', timeout: 15000 });
    if (!response || response.status() >= 400) return null;
    await delay(Math.min(delayMs, 1000));

    // Check if we landed on a real product page (not a 404/redirect to homepage)
    const isProductPage = await page.evaluate(() => {
      // Check for JSON-LD Product data
      for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
        try {
          const d = JSON.parse(s.textContent);
          if (d['@type'] === 'Product') return true;
          if (Array.isArray(d['@graph']) && d['@graph'].some(item => item['@type'] === 'Product')) return true;
          if (Array.isArray(d) && d.some(item => item['@type'] === 'Product')) return true;
        } catch { }
      }
      // Check for product-related elements on the page
      if (document.querySelector('[class*="product-detail"], [class*="pdp-"], [data-component*="product"]')) return true;
      // Check for Widen DAM images (strong signal of product page)
      for (const img of document.querySelectorAll('img')) {
        const src = (img.getAttribute('src') || '') + (img.getAttribute('data-src') || '');
        if (src.includes('widen.net')) return true;
      }
      return false;
    });

    if (isProductPage) return url;
    return null;
  } catch {
    return null;
  }
}

/**
 * Convert a product name to a URL slug suitable for Shaw's URL structure.
 * "Floorte Pro 7 Series" → "floorte-pro-7-series"
 */
function slugify(text) {
  if (!text) return '';
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')  // Remove special chars except spaces and hyphens
    .replace(/\s+/g, '-')          // Spaces to hyphens
    .replace(/-+/g, '-')           // Collapse multiple hyphens
    .replace(/^-|-$/g, '');        // Trim leading/trailing hyphens
}
