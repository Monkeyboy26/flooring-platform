import {
  launchBrowser, delay, upsertMediaAsset, upsertSkuAttribute,
  appendLog, addJobError, preferProductShot, filterImageUrls,
  extractLargeImages, collectSiteWideImages,
  extractSpecPDFs, normalizeTriwestName
} from './base.js';

const BASE_URL = 'https://www.ahfcontract.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_ERRORS = 30;
const BATCH_SIZE = 15;

// Fallback category slugs if products.html parsing fails
const PRODUCT_TYPES = [
  'vinyl-composition-tile', 'heterogeneous-sheet', 'homogeneous-sheet',
  'dry-back-lvt', 'loose-lay-lvt', 'rigid-core',
];

// Residential hardwood collections that live on bruce.com / hartco.com, not ahfcontract.com
const RESIDENTIAL_PATTERNS = [
  'timberbrushed', 'dundee', 'manchester', 'waltham', 'kennedale', 'turlington',
  'natural choice', 'america\'s best choice', 'countryside',
  'bruce', 'hartco', 'robbins',
];

/**
 * AHF Contract enrichment scraper — catalog-first matching.
 *
 * Phase 1: Crawl ahfcontract.com catalog → build SKU→URL index
 * Phase 2: Match catalog entries to existing DB products/SKUs
 * Phase 3: Enrich matched products with images, specs, PDFs
 *
 * Runs AFTER import-triwest-832.cjs populates SKUs in the DB.
 */
export async function run(pool, job, source) {
  const config = source.config || {};
  const delayMs = config.delay_ms || 2000;
  const vendor_id = source.vendor_id;

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
    // ── Phase 0: Launch browser & collect site-wide images ──
    browser = await launchBrowser();
    let page = await browser.newPage();
    await page.setUserAgent(USER_AGENT);
    await page.setViewport({ width: 1440, height: 900 });

    await appendLog(pool, job.id, `Collecting site-wide images from ${BASE_URL}...`);
    const siteWideImages = await collectSiteWideImages(page, BASE_URL);
    await appendLog(pool, job.id, `Found ${siteWideImages.size} site-wide images to exclude`);
    pagesSinceLaunch++;

    // ── Phase 1: Discover catalog ──
    await appendLog(pool, job.id, `Phase 1: Discovering catalog from ${BASE_URL}...`);
    const catalogIndex = await discoverCatalog(page, delayMs, pool, job, () => pagesSinceLaunch++);

    if (catalogIndex.size === 0) {
      await appendLog(pool, job.id, `WARNING: Catalog discovery found 0 products — site structure may have changed`);
    } else {
      await appendLog(pool, job.id, `Catalog discovery complete: ${catalogIndex.size} SKU entries indexed`);
    }

    // Recycle browser before phase 2/3
    try { await page.close(); } catch { }
    try { await browser.close(); } catch { }
    await delay(3000);
    browser = await launchBrowser();
    page = await browser.newPage();
    await page.setUserAgent(USER_AGENT);
    await page.setViewport({ width: 1440, height: 900 });
    pagesSinceLaunch = 0;

    // ── Phase 2: Match catalog to DB ──
    await appendLog(pool, job.id, `Phase 2: Matching catalog entries to DB products...`);
    const matched = await matchCatalogToDb(pool, vendor_id, catalogIndex);
    await appendLog(pool, job.id,
      `Matched ${matched.length} products (${matched.reduce((s, m) => s + m.skus.length, 0)} SKUs). ` +
      `Residential/unmatched will be skipped.`
    );

    // ── Phase 3: Enrich matched products ──
    await appendLog(pool, job.id, `Phase 3: Enriching ${matched.length} matched products...`);

    // Check which products already have a primary image — skip those
    const existingImages = await pool.query(`
      SELECT DISTINCT ma.product_id
      FROM media_assets ma
      JOIN products p ON p.id = ma.product_id
      WHERE p.vendor_id = $1 AND ma.asset_type = 'primary'
    `, [vendor_id]);
    const alreadyHaveImages = new Set(existingImages.rows.map(r => r.product_id));

    const toEnrich = matched.filter(m => !alreadyHaveImages.has(m.product_id));
    const skippedExisting = matched.length - toEnrich.length;
    await appendLog(pool, job.id,
      `${skippedExisting} already have images, ${toEnrich.length} to enrich`
    );

    let processed = 0;
    for (const entry of toEnrich) {
      processed++;

      // Recycle browser periodically
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
        // Pick the first catalog URL from matched entries
        const catalogEntry = entry.catalogEntries[0];
        if (!catalogEntry?.url) {
          skusSkipped++;
          continue;
        }

        const detailUrl = catalogEntry.url.startsWith('http')
          ? catalogEntry.url
          : `${BASE_URL}${catalogEntry.url}`;

        await page.goto(detailUrl, { waitUntil: 'networkidle2', timeout: 25000 });
        await delay(delayMs);
        pagesSinceLaunch++;

        const productData = await extractAhfDetailPage(page, siteWideImages);

        if (!productData) {
          skusSkipped++;
          continue;
        }

        // Update description if we found one and DB is empty
        if (productData.description) {
          await pool.query(
            'UPDATE products SET description_long = $1 WHERE id = $2 AND description_long IS NULL',
            [productData.description, entry.product_id]
          );
        }

        // Filter, deduplicate, sort product shots first
        if (productData.images && productData.images.length > 0) {
          const filtered = filterImageUrls(productData.images, { maxImages: 8 });
          const sorted = preferProductShot(filtered, entry.productName);
          for (let i = 0; i < sorted.length; i++) {
            const urlLower = sorted[i].toLowerCase();
            const isLifestyle = urlLower.includes('room') || urlLower.includes('scene')
              || urlLower.includes('lifestyle') || urlLower.includes('installed');
            const assetType = i === 0 ? 'primary'
              : (isLifestyle || i > 2) ? 'lifestyle'
              : 'alternate';
            await upsertMediaAsset(pool, {
              product_id: entry.product_id,
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
              product_id: entry.product_id,
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
        if (productData.specs && entry.skus.length > 0) {
          for (const sku of entry.skus) {
            for (const [attrSlug, value] of Object.entries(productData.specs)) {
              if (value) await upsertSkuAttribute(pool, sku.sku_id, attrSlug, value);
            }
            skusEnriched++;
          }
        } else {
          skusEnriched += entry.skus.length;
        }
      } catch (err) {
        await logError(`${entry.collection} / ${entry.productName}: ${err.message}`);
        skusSkipped++;
      }

      if (processed % 10 === 0) {
        await appendLog(pool, job.id,
          `Progress: ${processed}/${toEnrich.length} products, ${imagesAdded} images, ${pdfsAdded} PDFs`
        );
      }
    }

    await appendLog(pool, job.id,
      `Complete. Catalog: ${catalogIndex.size} entries. Matched: ${matched.length} products ` +
      `(${skippedExisting} skipped existing). Enriched: ${skusEnriched} SKUs, ` +
      `Skipped: ${skusSkipped}, Images: ${imagesAdded}, PDFs: ${pdfsAdded}, Errors: ${errorCount}`,
      { products_found: catalogIndex.size, products_updated: skusEnriched }
    );

  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// ─────────────────────────────────────────────────────────
// Phase 1: Catalog Discovery
// ─────────────────────────────────────────────────────────

/**
 * Crawl ahfcontract.com product catalog and build a SKU→URL index.
 * Navigation: products.html → category pages → collection pages → product cards
 *
 * @returns {Map<string, {url: string, collection: string, productName: string}>}
 *          Keyed by lowercase SKU / URL slug
 */
async function discoverCatalog(page, delayMs, pool, job, onPageLoad) {
  const catalogIndex = new Map();

  // Step 1: Get category links from the main products page
  let categoryLinks = [];
  try {
    await page.goto(`${BASE_URL}/en-us/products.html`, {
      waitUntil: 'networkidle2', timeout: 25000,
    });
    await delay(delayMs);
    onPageLoad();

    categoryLinks = await page.evaluate((base) => {
      const links = [];
      const seen = new Set();
      // Look for links to product type pages
      for (const a of document.querySelectorAll('a[href*="/en-us/products/"]')) {
        const href = a.getAttribute('href') || '';
        const full = href.startsWith('http') ? href : `${base}${href}`;
        // Category pages are one level deep: /en-us/products/{type}.html
        const match = full.match(/\/en-us\/products\/([a-z0-9-]+)\.html$/);
        if (match && !seen.has(match[1])) {
          seen.add(match[1]);
          links.push({ slug: match[1], url: full });
        }
      }
      return links;
    }, BASE_URL);

    await appendLog(pool, job.id,
      `Found ${categoryLinks.length} category links from products page`
    );
  } catch (err) {
    await appendLog(pool, job.id,
      `Failed to parse products.html (${err.message}), using fallback category list`
    );
  }

  // Fallback: use hardcoded product types if discovery failed
  if (categoryLinks.length === 0) {
    categoryLinks = PRODUCT_TYPES.map(slug => ({
      slug,
      url: `${BASE_URL}/en-us/products/${slug}.html`,
    }));
  }

  // Step 2: For each category, find collection pages
  for (const category of categoryLinks) {
    let collectionLinks = [];
    try {
      await page.goto(category.url, { waitUntil: 'networkidle2', timeout: 25000 });
      await delay(delayMs);
      onPageLoad();

      collectionLinks = await page.evaluate((base, catSlug) => {
        const links = [];
        const seen = new Set();
        for (const a of document.querySelectorAll('a[href*="/en-us/products/"]')) {
          const href = a.getAttribute('href') || '';
          const full = href.startsWith('http') ? href : `${base}${href}`;
          // Collection pages: /en-us/products/{type}/{collection}.html
          const match = full.match(/\/en-us\/products\/([a-zA-Z0-9-]+)\/([a-zA-Z0-9-]+)\.html$/i);
          if (match && !seen.has(match[2].toLowerCase())) {
            seen.add(match[2].toLowerCase());
            const label = (a.textContent || '').trim() || match[2];
            links.push({ slug: match[2].toLowerCase(), url: full, name: label, category: match[1] });
          }
        }
        return links;
      }, BASE_URL, category.slug);

      if (collectionLinks.length > 0) {
        await appendLog(pool, job.id,
          `  ${category.slug}: ${collectionLinks.length} collections found`
        );
      }
    } catch (err) {
      await appendLog(pool, job.id,
        `  ${category.slug}: failed to load (${err.message})`
      );
      continue;
    }

    // Step 3: For each collection page, extract product/SKU links
    for (const collection of collectionLinks) {
      try {
        await page.goto(collection.url, { waitUntil: 'networkidle2', timeout: 25000 });
        await delay(delayMs);
        onPageLoad();

        // Check for "load more" / pagination and click through
        await loadAllProducts(page, delayMs);

        const products = await page.evaluate((base) => {
          const items = [];
          const seen = new Set();
          // Product cards with links to detail pages
          for (const a of document.querySelectorAll('a[href*="/en-us/products/"]')) {
            const href = a.getAttribute('href') || '';
            const full = href.startsWith('http') ? href : `${base}${href}`;
            // Detail pages: /en-us/products/{type}/{collection}/{sku}.html
            const match = full.match(/\/en-us\/products\/([a-zA-Z0-9-]+)\/([a-zA-Z0-9-]+)\/([a-zA-Z0-9-]+)\.html$/i);
            if (match && !seen.has(match[3].toLowerCase())) {
              seen.add(match[3].toLowerCase());
              const label = (a.textContent || '').trim();
              items.push({
                slug: match[3],
                url: full,
                name: label || match[3],
                category: match[1],
                collectionSlug: match[2].toLowerCase(),
              });
            }
          }
          return items;
        }, BASE_URL);

        if (products.length > 0) {
          // This collection page has child product cards — index them
          for (const prod of products) {
            const key = prod.slug.toLowerCase();
            if (!catalogIndex.has(key)) {
              catalogIndex.set(key, {
                url: prod.url,
                collection: collection.name || collection.slug,
                collectionSlug: prod.collectionSlug,
                productName: prod.name,
              });
            }
          }
        } else {
          // No child product cards — this collection page IS the product detail page.
          // Index the collection page itself so name-based matching can find it.
          const key = `_collection_${collection.slug}`;
          if (!catalogIndex.has(key)) {
            catalogIndex.set(key, {
              url: collection.url,
              collection: collection.name || collection.slug,
              collectionSlug: collection.slug,
              productName: collection.name || collection.slug,
            });
          }
        }
      } catch (err) {
        await appendLog(pool, job.id,
          `  ${collection.slug}: failed to extract products (${err.message})`
        );
      }
    }
  }

  return catalogIndex;
}

/**
 * If the collection page has a "load more" button or pagination,
 * click through to reveal all products.
 */
async function loadAllProducts(page, delayMs) {
  // Try clicking "Load More" / "Show More" buttons
  for (let attempt = 0; attempt < 20; attempt++) {
    const clicked = await page.evaluate(() => {
      const btns = [...document.querySelectorAll('button, a')];
      const loadMore = btns.find(b => {
        const text = (b.textContent || '').toLowerCase().trim();
        return text.includes('load more') || text.includes('show more')
          || text.includes('view more') || text.includes('see all');
      });
      if (loadMore && loadMore.offsetParent !== null) {
        loadMore.click();
        return true;
      }
      return false;
    });
    if (!clicked) break;
    await delay(delayMs);
  }

  // Also check for pagination links (next page)
  for (let attempt = 0; attempt < 20; attempt++) {
    const nextClicked = await page.evaluate(() => {
      const next = document.querySelector('.pagination .next a, a[rel="next"], .pager-next a');
      if (next && next.offsetParent !== null) {
        next.click();
        return true;
      }
      return false;
    });
    if (!nextClicked) break;
    await delay(delayMs);
  }
}

// ─────────────────────────────────────────────────────────
// Phase 2: Match Catalog to DB
// ─────────────────────────────────────────────────────────

/**
 * Strip the "AHF" prefix from vendor SKUs for matching.
 * AHFCR001 → cr001, AHF00581406 → 00581406
 */
function stripAhfPrefix(vendorSku) {
  return (vendorSku || '').replace(/^AHF/i, '').toLowerCase();
}

/**
 * Match discovered catalog entries against DB products.
 *
 * @param {Map<string, {url, collection, productName}>} catalogIndex
 * @returns {Array<{product_id, productName, collection, skus, catalogEntries}>}
 */
async function matchCatalogToDb(pool, vendorId, catalogIndex) {
  const brandPrefix = 'AHF';

  // Load all AHF products from DB (includes SKU-less products from DNav)
  const prodResult = await pool.query(`
    SELECT p.id AS product_id, p.name, p.collection, p.description_long
    FROM products p
    WHERE p.vendor_id = $1 AND p.collection LIKE $2
  `, [vendorId, `${brandPrefix}%`]);

  // Also load SKU data for products that have it
  const skuResult = await pool.query(`
    SELECT s.id AS sku_id, s.vendor_sku, s.internal_sku, s.variant_name, s.product_id
    FROM skus s
    JOIN products p ON p.id = s.product_id
    WHERE p.vendor_id = $1 AND p.collection LIKE $2
  `, [vendorId, `${brandPrefix}%`]);

  if (prodResult.rows.length === 0) return [];

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
        product_id: row.product_id,
        productName: row.name,
        collection: row.collection,
        description_long: row.description_long,
        skus: skusByProduct.get(row.product_id) || [],
      });
    }
  }

  const matched = [];
  let matchedSkuCount = 0;
  let residentialSkipped = 0;

  for (const [productId, group] of productGroups) {
    // Skip residential hardwood lines (not on ahfcontract.com)
    const collectionLower = (group.collection || '').toLowerCase();
    const nameLower = (group.productName || '').toLowerCase();
    const isResidential = RESIDENTIAL_PATTERNS.some(p =>
      collectionLower.includes(p) || nameLower.includes(p)
    );
    if (isResidential) {
      residentialSkipped++;
      continue;
    }

    // Try to match each SKU against the catalog index
    const catalogEntries = [];
    for (const sku of group.skus) {
      const stripped = stripAhfPrefix(sku.vendor_sku);
      if (!stripped) continue;

      // Direct lookup
      let entry = catalogIndex.get(stripped);

      // Fallback: strip trailing letters (e.g., "cr001a" → "cr001")
      if (!entry) {
        const trimmed = stripped.replace(/[a-z]+$/, '');
        if (trimmed && trimmed !== stripped) {
          entry = catalogIndex.get(trimmed);
        }
      }

      // Fallback: try matching by iterating catalog keys that start with the stripped SKU
      if (!entry) {
        for (const [catalogKey, catalogVal] of catalogIndex) {
          if (catalogKey.startsWith(stripped) || stripped.startsWith(catalogKey)) {
            entry = catalogVal;
            break;
          }
        }
      }

      if (entry && !catalogEntries.some(e => e.url === entry.url)) {
        catalogEntries.push(entry);
      }
    }

    // Fallback: two-tier collection/product name matching
    if (catalogEntries.length === 0) {
      const normalizedName = normalizeTriwestName(group.productName).toLowerCase();
      // Slugify DB product name for URL-based matching: "Coastal Comfort" → "coastal-comfort"
      const nameSlug = normalizedName.replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');

      // Tier A: Match DB product name slug against catalog URL collection slug
      for (const [, catalogVal] of catalogIndex) {
        if (catalogVal.collectionSlug && nameSlug &&
            catalogVal.collectionSlug === nameSlug) {
          catalogEntries.push(catalogVal);
          break;
        }
      }

      // Tier B: Relaxed substring match — collection name OR product name (not both)
      if (catalogEntries.length === 0) {
        const normalizedCollection = normalizeTriwestName(group.collection).toLowerCase();

        for (const [, catalogVal] of catalogIndex) {
          const catCollection = (catalogVal.collection || '').toLowerCase();
          const catName = (catalogVal.productName || '').toLowerCase();

          if (normalizedCollection && catCollection &&
              (catCollection.includes(normalizedCollection) || normalizedCollection.includes(catCollection))) {
            catalogEntries.push(catalogVal);
            break;
          }
          if (normalizedName && catCollection &&
              (catCollection.includes(normalizedName) || normalizedName.includes(catCollection))) {
            catalogEntries.push(catalogVal);
            break;
          }
          if (normalizedName && catName &&
              (catName.includes(normalizedName) || normalizedName.includes(catName))) {
            catalogEntries.push(catalogVal);
            break;
          }
        }
      }

    }

    if (catalogEntries.length > 0) {
      matched.push({
        product_id: group.product_id,
        productName: group.productName,
        collection: group.collection,
        description_long: group.description_long,
        skus: group.skus,
        catalogEntries,
      });
      matchedSkuCount += group.skus.length;
    }
  }

  return matched;
}

// ─────────────────────────────────────────────────────────
// Phase 3: Detail Page Extraction
// ─────────────────────────────────────────────────────────

/**
 * Extract product data from an AHF detail page.
 * Improved version with JSON-LD priority, SVG filtering, CDN image handling.
 *
 * @param {import('puppeteer').Page} page
 * @param {Set<string>} siteWideImages - URLs to exclude
 * @returns {Promise<{images: string[], pdfs: Array, description: string, specs: object}|null>}
 */
async function extractAhfDetailPage(page, siteWideImages) {
  // Wait for AEM client-side rendering
  await page.waitForSelector('img, .product-detail, .product-content, [class*="product"]', {
    timeout: 8000,
  }).catch(() => null);

  // Use extractLargeImages for dimension-filtered results
  const largeImages = await extractLargeImages(page, siteWideImages, 150);

  // Also grab CDN images that might be lazy-loaded or below size threshold
  const cdnImages = await page.evaluate(() => {
    const results = [];
    const seen = new Set();

    // Standard CDN images
    const selectors = [
      'img[src*="/cdn/"]', '[data-src*="/cdn/"]', '[data-image*="/cdn/"]',
      '[data-zoom*="/cdn/"]', '[data-src*="/content/"]', 'img[src*="/content/"]',
    ];

    for (const sel of selectors) {
      for (const el of document.querySelectorAll(sel)) {
        const src = el.src || el.dataset?.src || el.dataset?.image || el.dataset?.zoom || '';
        if (!src) continue;
        // Skip SVGs, logos, icons
        const srcLower = src.toLowerCase();
        if (srcLower.endsWith('.svg') || srcLower.includes('.svg?')) continue;
        if (srcLower.includes('logo') || srcLower.includes('icon') || srcLower.includes('nav')
            || srcLower.includes('badge') || srcLower.includes('sprite')) continue;

        const clean = src.replace(/\?size=\w+/, '?size=detail');
        if (!seen.has(clean.split('?')[0].toLowerCase())) {
          seen.add(clean.split('?')[0].toLowerCase());
          results.push(clean);
        }
      }
    }

    return results;
  });

  // Merge: large images first, then CDN-specific ones not already present
  const allImageUrls = largeImages
    .map(img => img.src)
    .filter(src => {
      const lower = src.toLowerCase();
      // Exclude SVGs and HTML pages
      if (lower.endsWith('.svg') || lower.includes('.svg?')) return false;
      if (lower.endsWith('.html') || lower.includes('.html?')) return false;
      return true;
    });

  for (const url of cdnImages) {
    const lower = url.toLowerCase();
    if (lower.endsWith('.html') || lower.includes('.html?')) continue;
    const urlBase = lower.split('?')[0];
    if (!allImageUrls.some(u => u.split('?')[0].toLowerCase() === urlBase)) {
      allImageUrls.push(url);
    }
  }

  // Extract spec PDFs
  const pdfs = await extractSpecPDFs(page);

  // Description and specs via JSON-LD first, then DOM fallback
  const extra = await page.evaluate(() => {
    let description = null;
    let jsonLdImages = [];

    // JSON-LD Product schema
    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const d = JSON.parse(s.textContent);
        const product = d['@type'] === 'Product' ? d
          : (Array.isArray(d['@graph']) ? d['@graph'].find(g => g['@type'] === 'Product') : null);
        if (product) {
          if (product.description) description = product.description.trim().slice(0, 2000);
          if (product.image) {
            const imgs = Array.isArray(product.image) ? product.image : [product.image];
            jsonLdImages = imgs
              .map(i => typeof i === 'string' ? i : i?.url)
              .filter(Boolean);
          }
        }
      } catch { }
    }

    // DOM fallback for description
    if (!description) {
      const descEl = document.querySelector(
        '.product-description, [class*="description"] p, .detail-content p, ' +
        '.about-product p, .product-info p, [class*="product"] p'
      );
      if (descEl) description = descEl.textContent.trim().slice(0, 2000);
    }

    // Specs from table rows
    const specs = {};
    for (const row of document.querySelectorAll('tr')) {
      const th = row.querySelector('th, td:first-child');
      const td = row.querySelector('td:last-child');
      if (th && td && th !== td) {
        const label = th.textContent.trim().toLowerCase();
        const value = td.textContent.trim();
        if (!label || !value) continue;
        if (label.includes('thickness') && !label.includes('veneer')) specs.thickness = value;
        if (label.includes('width') || label.includes('plank width')) specs.size = value;
        if (label.includes('surface') || label.includes('finish') || label.includes('texture')) specs.finish = value;
        if (label.includes('species') || label.includes('wood type')) specs.material = value;
        if (label.includes('edge')) specs.edge = value;
        if (label.includes('construction')) specs.construction = value;
        if (label.includes('installation')) specs.installation = value;
        if (label.includes('janka')) specs.janka_hardness = value;
        if (label.includes('wear layer')) specs.wear_layer = value;
      }
    }
    // Definition lists
    for (const dl of document.querySelectorAll('dl')) {
      const dts = dl.querySelectorAll('dt');
      const dds = dl.querySelectorAll('dd');
      for (let i = 0; i < Math.min(dts.length, dds.length); i++) {
        const label = dts[i].textContent.trim().toLowerCase();
        const value = dds[i].textContent.trim();
        if (label.includes('thickness')) specs.thickness = value;
        if (label.includes('width')) specs.size = value;
        if (label.includes('finish')) specs.finish = value;
        if (label.includes('species')) specs.material = value;
        if (label.includes('edge')) specs.edge = value;
        if (label.includes('wear layer')) specs.wear_layer = value;
      }
    }

    return {
      description,
      specs: Object.keys(specs).length > 0 ? specs : null,
      jsonLdImages,
    };
  });

  // Add JSON-LD images (high quality, from structured data) if not already present
  for (const url of extra.jsonLdImages || []) {
    const lower = url.toLowerCase();
    if (lower.endsWith('.svg') || lower.includes('.svg?')) continue;
    if (lower.endsWith('.html') || lower.includes('.html?')) continue;
    const urlBase = lower.split('?')[0];
    if (!allImageUrls.some(u => u.split('?')[0].toLowerCase() === urlBase)) {
      allImageUrls.push(url);
    }
  }

  if (allImageUrls.length === 0 && !extra.description && !extra.specs && pdfs.length === 0) {
    return null;
  }

  return {
    images: allImageUrls,
    pdfs: pdfs.length > 0 ? pdfs : null,
    description: extra.description,
    specs: extra.specs,
  };
}
