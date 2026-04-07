import {
  launchBrowser, delay, appendLog, addJobError,
  saveProductImages, filterImageUrls, preferProductShot,
  fuzzyMatch, normalizeTriwestName
} from './base.js';

const BASE_URL = 'https://www.provenzafloors.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_ERRORS = 30;
const BATCH_SIZE = 15;

/** TW collection name (uppercase) → Provenza website collection name */
const COLLECTION_MAP = {
  'AFFINITY': 'Affinity',
  'AFRICAN PLAINS': 'African Plains',
  'ANTICO': 'Antico',
  'CONCORDE OAK': 'Concorde Oak',
  'DUTCH MASTERS': 'Dutch Masters',
  'EUROPEAN OAK 4MM': 'Dutch Masters',
  'GRAND POMPEII': 'Grand Pompeii',
  'HERRINGBONE RESERVE': 'Herringbone Reserve',
  'HERRINGBONE CUSTOM': 'Herringbone Custom',
  'LIGHTHOUSE COVE': 'Lighthouse Cove',
  'FIRST IMPRESSIONS': 'First Impressions',
  'LUGANO': 'Lugano',
  'MODA LIVING': 'Moda Living',
  'MODERN RUSTIC': 'Modern Rustic',
  'MODESSA': 'Modessa',
  'NEW WAVE': 'New Wave',
  'NEW YORK LOFT': 'New York Loft',
  'NYC LOFT': 'New York Loft',
  'OLD WORLD': 'Old World',
  'PALAIS ROYALE': 'Palais Royale',
  'POMPEII': 'Pompeii',
  'RICHMOND': 'Richmond',
  'STONESCAPE': 'Stonescape',
  'STUDIO MODERNO': 'Studio Moderno',
  'TRESOR': 'Tresor',
  'UPTOWN CHIC': 'Uptown Chic',
  'VITALI ELITE': 'Vitali Elite',
  'VITALI': 'Vitali',
  'VOLTERRA': 'Volterra',
  'WALL CHIC': 'Wall Chic',
};

/** Known collections by category on provenzafloors.com */
const COLLECTIONS_BY_CATEGORY = {
  hardwood: [
    'Affinity', 'African Plains', 'Antico', 'Dutch Masters', 'Grand Pompeii',
    'Herringbone Reserve', 'Herringbone Custom', 'Lighthouse Cove', 'Lugano',
    'Modern Rustic', 'New York Loft', 'Old World', 'Palais Royale', 'Pompeii',
    'Richmond', 'Studio Moderno', 'Tresor', 'Vitali', 'Vitali Elite', 'Volterra',
    'Wall Chic',
  ],
  waterprooflvp: [
    'Concorde Oak', 'First Impressions', 'Moda Living', 'Uptown Chic',
    'New Wave', 'Stonescape', 'Modessa',
  ],
};

/** Accessory patterns — products matching these are NOT on provenzafloors.com */
const ACCESSORY_RE = /\b(stair\s*nose|reducer|t[- ]?mold|bullnose|quarter\s*round|threshold|end\s*cap|overlap|flush\s*mount|baby\s*threshold|multi[- ]?purpose|transition|scotia|shoe\s*mold)/i;

/**
 * Provenza catalog-first enrichment scraper for Tri-West.
 *
 * Phase 1: Scrape ~25 collection pages on provenzafloors.com to build a
 *          complete catalog of { colorName → imageUrls[] }.
 * Phase 2: Match TW products against the catalog by color name.
 * Phase 3: Detail-page fallback for high-value unmatched products.
 *
 * Runs AFTER import-triwest-832.cjs populates SKUs in the DB.
 */
export async function run(pool, job, source) {
  const config = source.config || {};
  const delayMs = config.delay_ms || 2000;
  const vendor_id = source.vendor_id;
  const brandPrefix = 'Provenza';

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
    // ── Load existing TW Provenza products ──
    const prodResult = await pool.query(`
      SELECT p.id AS product_id, p.name, p.collection, p.description_long
      FROM products p
      WHERE p.vendor_id = $1 AND p.collection LIKE $2 AND p.is_active = true
    `, [vendor_id, `${brandPrefix}%`]);

    const skuResult = await pool.query(`
      SELECT s.id AS sku_id, s.vendor_sku, s.internal_sku, s.variant_name, s.product_id
      FROM skus s
      JOIN products p ON p.id = s.product_id
      WHERE p.vendor_id = $1 AND p.collection LIKE $2 AND p.is_active = true
    `, [vendor_id, `${brandPrefix}%`]);

    await appendLog(pool, job.id,
      `Found ${prodResult.rows.length} ${brandPrefix} products (${skuResult.rows.length} SKUs)`);

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

    // Group products by collection + name (dedup)
    const productGroups = new Map();
    for (const row of prodResult.rows) {
      const key = `${row.collection}||${row.name}`;
      if (!productGroups.has(key)) {
        productGroups.set(key, {
          product_id: row.product_id,
          name: row.name,
          collection: row.collection,
          description_long: row.description_long,
          skus: skusByProduct.get(row.product_id) || [],
        });
      }
    }

    // Skip products that already have a primary image
    const existingImages = await pool.query(`
      SELECT DISTINCT ma.product_id
      FROM media_assets ma
      JOIN products p ON p.id = ma.product_id
      WHERE p.vendor_id = $1 AND ma.asset_type = 'primary'
    `, [vendor_id]);
    const alreadyHaveImages = new Set(existingImages.rows.map(r => r.product_id));

    // Filter to products needing enrichment, skip accessories
    const toEnrich = [];
    let accessorySkipped = 0;
    for (const [, group] of productGroups) {
      if (alreadyHaveImages.has(group.product_id)) continue;
      if (ACCESSORY_RE.test(group.name)) { accessorySkipped++; continue; }
      toEnrich.push(group);
    }
    const skippedExisting = productGroups.size - toEnrich.length - accessorySkipped;

    await appendLog(pool, job.id,
      `${productGroups.size} unique products: ${skippedExisting} have images, ${accessorySkipped} accessories skipped, ${toEnrich.length} to enrich`);

    // ── Phase 1: Build website catalog ──
    await appendLog(pool, job.id, 'Phase 1: Scraping collection pages to build catalog...');
    browser = await launchBrowser();
    let page = await browser.newPage();
    await page.setUserAgent(USER_AGENT);
    await page.setViewport({ width: 1440, height: 900 });

    const catalog = await buildCatalog(page, pool, job, delayMs);
    await appendLog(pool, job.id, `Catalog built: ${catalog.size} colors across all collections`);

    // ── Phase 2: Match TW products against catalog ──
    await appendLog(pool, job.id, `Phase 2: Matching ${toEnrich.length} products against catalog...`);

    let matched = 0;
    let unmatched = 0;
    const unmatchedForFallback = [];

    for (const group of toEnrich) {
      const colorName = extractColorName(group);
      const collectionName = extractCollectionName(group);
      const normalizedColor = normalizeColor(colorName);

      // Try exact match first
      let catalogEntry = catalog.get(normalizedColor);

      // Try fuzzy match if no exact match
      if (!catalogEntry) {
        let bestScore = 0;
        let bestKey = null;
        for (const [key, entry] of catalog) {
          // If we know the collection, only match within that collection
          if (collectionName && entry.collection &&
              entry.collection.toLowerCase() !== collectionName.toLowerCase()) continue;
          const score = fuzzyMatch(normalizedColor, key);
          if (score > bestScore && score >= 0.8) {
            bestScore = score;
            bestKey = key;
          }
        }
        if (bestKey) catalogEntry = catalog.get(bestKey);
      }

      // Also try matching with collection prefix stripped from color
      if (!catalogEntry && collectionName) {
        const colorWithoutColl = normalizedColor
          .replace(new RegExp(`^${collectionName.toLowerCase()}\\s*`, 'i'), '')
          .trim();
        if (colorWithoutColl && colorWithoutColl !== normalizedColor) {
          catalogEntry = catalog.get(colorWithoutColl);
        }
      }

      if (catalogEntry && catalogEntry.imageUrls.length > 0) {
        try {
          const filtered = filterImageUrls(catalogEntry.imageUrls, { maxImages: 8 });
          const sorted = preferProductShot(filtered, colorName);
          const saved = await saveProductImages(pool, group.product_id, sorted);
          imagesAdded += saved;
          skusEnriched++;
          matched++;
        } catch (err) {
          await logError(`Save images for ${group.name}: ${err.message}`);
          skusSkipped++;
        }
      } else {
        unmatched++;
        // Queue for Phase 3 fallback if product has a vendor_sku
        const firstSku = group.skus[0];
        if (firstSku?.vendor_sku && collectionName) {
          unmatchedForFallback.push({ group, collectionName, colorName });
        }
        skusSkipped++;
      }

      if ((matched + unmatched) % 50 === 0) {
        await appendLog(pool, job.id,
          `Phase 2 progress: ${matched + unmatched}/${toEnrich.length} (${matched} matched, ${unmatched} unmatched)`);
      }
    }

    await appendLog(pool, job.id,
      `Phase 2 complete: ${matched} matched, ${unmatched} unmatched, ${unmatchedForFallback.length} queued for fallback`);

    // ── Phase 3: Detail page fallback for unmatched products ──
    if (unmatchedForFallback.length > 0) {
      await appendLog(pool, job.id,
        `Phase 3: Trying detail pages for ${unmatchedForFallback.length} unmatched products...`);

      let fallbackMatched = 0;
      let pagesSinceLaunch = 0;

      for (const { group, collectionName, colorName } of unmatchedForFallback) {
        // Recycle browser periodically
        if (pagesSinceLaunch >= BATCH_SIZE) {
          try { await page.close(); } catch { }
          try { await browser.close(); } catch { }
          await delay(3000);
          browser = await launchBrowser();
          page = await browser.newPage();
          await page.setUserAgent(USER_AGENT);
          await page.setViewport({ width: 1440, height: 900 });
          pagesSinceLaunch = 0;
        }

        try {
          const images = await tryDetailPage(page, group, collectionName, colorName, delayMs);
          pagesSinceLaunch++;

          if (images && images.length > 0) {
            const filtered = filterImageUrls(images, { maxImages: 8 });
            const sorted = preferProductShot(filtered, colorName);
            const saved = await saveProductImages(pool, group.product_id, sorted);
            imagesAdded += saved;
            skusEnriched++;
            skusSkipped--; // was counted as skipped in Phase 2
            fallbackMatched++;
          }
        } catch (err) {
          await logError(`Detail page fallback ${group.name}: ${err.message}`);
        }

        await delay(delayMs);
      }

      await appendLog(pool, job.id,
        `Phase 3 complete: ${fallbackMatched}/${unmatchedForFallback.length} matched via detail pages`);
    }

    await appendLog(pool, job.id,
      `Complete. Enriched: ${skusEnriched}, Skipped: ${skusSkipped}, Images: ${imagesAdded}, Errors: ${errorCount}`,
      { products_found: productGroups.size, products_updated: skusEnriched }
    );

  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

/**
 * Phase 1: Scrape all known collection pages on provenzafloors.com.
 * Returns Map<normalizedColorName, { collection, category, imageUrls[] }>
 */
async function buildCatalog(page, pool, job, delayMs) {
  const catalog = new Map();
  let totalPages = 0;

  for (const [category, collections] of Object.entries(COLLECTIONS_BY_CATEGORY)) {
    for (const collection of collections) {
      try {
        const url = `${BASE_URL}/${category}?collection=${encodeURIComponent(collection)}`;
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
        await delay(3000);

        // Scroll down repeatedly to trigger infinite scroll / lazy loading
        await scrollToBottom(page);
        await delay(2000);

        // Extract product cards with their images
        const products = await page.evaluate(() => {
          const results = [];
          const seen = new Set();

          // Strategy 1: Look for product cards with image + text
          const cards = document.querySelectorAll(
            '.product-card, .product-item, .color-card, .product, [class*="product"], [class*="color"]'
          );
          for (const card of cards) {
            const img = card.querySelector('img');
            const nameEl = card.querySelector(
              'h3, h4, h5, .product-name, .color-name, [class*="name"], [class*="title"], p, span'
            );
            if (!img) continue;
            const src = img.currentSrc || img.src || img.dataset?.src || '';
            const name = (nameEl?.textContent || img.alt || '').trim();
            if (src && name && !seen.has(name.toLowerCase())) {
              seen.add(name.toLowerCase());
              results.push({ colorName: name, imageUrl: src });
            }
          }

          // Strategy 2: If no structured cards, look for GCS images with alt text
          if (results.length === 0) {
            for (const img of document.querySelectorAll('img')) {
              const src = img.currentSrc || img.src || img.dataset?.src || '';
              if (!src.includes('storage.googleapis.com') && !src.includes('provenza')) continue;
              if (src.includes('logo') || src.includes('emblem') || src.includes('icon')) continue;
              const alt = (img.alt || '').trim();
              const name = alt || extractNameFromUrl(src);
              if (name && !seen.has(name.toLowerCase())) {
                seen.add(name.toLowerCase());
                results.push({ colorName: name, imageUrl: src });
              }
            }
          }

          // Strategy 3: Extract from any large images on the page
          if (results.length === 0) {
            for (const img of document.querySelectorAll('img')) {
              if (!img.complete || img.naturalWidth < 100 || img.naturalHeight < 100) continue;
              const src = img.currentSrc || img.src || '';
              if (!src.startsWith('http')) continue;
              if (src.includes('logo') || src.includes('emblem') || src.includes('icon')) continue;
              const name = extractNameFromUrl(src);
              if (name && !seen.has(name.toLowerCase())) {
                seen.add(name.toLowerCase());
                results.push({ colorName: name, imageUrl: src });
              }
            }
          }

          function extractNameFromUrl(url) {
            try {
              const filename = url.split('/').pop().split('?')[0].split('.')[0];
              // Strip "Provenza-Collection-" prefix patterns, keep last part as color
              const parts = filename.split('-');
              if (parts.length >= 3) {
                // Guess: last 1-3 parts are color name
                return parts.slice(-2).join(' ').replace(/_/g, ' ');
              }
              return filename.replace(/[-_]/g, ' ');
            } catch { return ''; }
          }

          return results;
        });

        // Also extract additional image variants from page (room scenes, alternates)
        const allGcsImages = await page.evaluate(() => {
          const map = {};
          for (const img of document.querySelectorAll('img')) {
            const src = img.currentSrc || img.src || img.dataset?.src || '';
            if (!src.includes('storage.googleapis.com')) continue;
            if (src.includes('logo') || src.includes('emblem')) continue;
            // Group by base filename (strip numbered suffixes)
            const filename = src.split('/').pop().split('?')[0];
            const base = filename.replace(/(_\d{2}|_rs\d*)\.jpg$/i, '.jpg');
            if (!map[base]) map[base] = [];
            if (!map[base].includes(src)) map[base].push(src);
          }
          return map;
        });

        for (const product of products) {
          const normalized = normalizeColor(product.colorName);
          if (!normalized || normalized.length < 2) continue;

          // Collect all image URLs for this color (main + variants)
          const imageUrls = [product.imageUrl];

          // Find additional images that share the same base pattern
          const mainFilename = product.imageUrl.split('/').pop().split('?')[0];
          const mainBase = mainFilename.replace(/(_\d{2}|_rs\d*)\.jpg$/i, '.jpg');
          if (allGcsImages[mainBase]) {
            for (const url of allGcsImages[mainBase]) {
              if (!imageUrls.includes(url)) imageUrls.push(url);
            }
          }
          // Also try numbered variants from the main URL
          for (const suffix of ['_02', '_03', '_04', '_05', '_06', '_rs1', '_rs2', '_rs3']) {
            const variantUrl = product.imageUrl.replace(/\.jpg$/i, `${suffix}.jpg`);
            if (!imageUrls.includes(variantUrl)) imageUrls.push(variantUrl);
          }

          if (!catalog.has(normalized)) {
            catalog.set(normalized, {
              collection,
              category,
              imageUrls,
            });
          }
        }

        totalPages++;
        if (products.length > 0) {
          await appendLog(pool, job.id,
            `  ${category}/${collection}: ${products.length} colors found`);
        }
      } catch (err) {
        await appendLog(pool, job.id,
          `  Warning: failed to load ${category}/${collection}: ${err.message}`);
      }

      await delay(delayMs);
    }
  }

  await appendLog(pool, job.id, `Scraped ${totalPages} collection pages`);

  // Verify GCS image URLs actually exist (batch HEAD check the primary image only)
  await appendLog(pool, job.id, 'Verifying catalog image URLs...');
  let verified = 0;
  let removed = 0;
  for (const [key, entry] of catalog) {
    if (entry.imageUrls.length === 0) { catalog.delete(key); removed++; continue; }
    try {
      const resp = await fetch(entry.imageUrls[0], {
        method: 'HEAD',
        signal: AbortSignal.timeout(5000),
        headers: { 'User-Agent': USER_AGENT },
      });
      if (!resp.ok) {
        catalog.delete(key);
        removed++;
      } else {
        verified++;
      }
    } catch {
      // Keep it — may still work for browser access even if HEAD fails
      verified++;
    }
  }
  await appendLog(pool, job.id, `Verified: ${verified} valid, ${removed} removed`);

  return catalog;
}

/**
 * Scroll to the bottom of the page to trigger infinite scroll / lazy loading.
 * Keeps scrolling until no new content appears.
 */
async function scrollToBottom(page) {
  let prevHeight = 0;
  let attempts = 0;
  const maxAttempts = 15;

  while (attempts < maxAttempts) {
    const currentHeight = await page.evaluate(() => document.body.scrollHeight);
    if (currentHeight === prevHeight) break;
    prevHeight = currentHeight;
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await delay(1500);
    attempts++;
  }
}

/**
 * Extract the color name from a TW product group.
 *
 * TW data patterns:
 * - collection = "Provenza - AFFINITY", name = "CAMEO"        → color = "CAMEO"
 * - collection = "Provenza - BE MINE", name = "BE MINE"       → color = "BE MINE"
 * - collection = "Provenza", name = "AUTUMN GREY"              → color = "AUTUMN GREY"
 */
function extractColorName(group) {
  return group.name || '';
}

/**
 * Extract the Provenza collection name from TW data.
 * Uses COLLECTION_MAP to translate TW's uppercase collection names.
 */
function extractCollectionName(group) {
  const raw = (group.collection || '').replace(/^Provenza\s*[-–—]\s*/i, '').trim();
  if (!raw || raw.toLowerCase() === 'provenza') return null;

  // Direct map lookup
  const mapped = COLLECTION_MAP[raw.toUpperCase()];
  if (mapped) return mapped;

  // Fuzzy lookup — try to match against known collections
  const upper = raw.toUpperCase();
  for (const [key, val] of Object.entries(COLLECTION_MAP)) {
    if (upper.includes(key) || key.includes(upper)) return val;
  }

  return null;
}

/**
 * Normalize a color name for catalog lookup.
 * Lowercase, strip wood species suffixes, collapse whitespace.
 */
function normalizeColor(name) {
  if (!name) return '';
  return name
    .toLowerCase()
    .replace(/\s*[-–—]\s*(white oak|european oak|maple|hickory|walnut|acacia|oak)\s*$/i, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Phase 3 fallback: try navigating to a Provenza detail page directly.
 * Returns array of image URLs or null.
 */
async function tryDetailPage(page, group, collectionName, colorName, delayMs) {
  const firstSku = group.skus[0];
  if (!firstSku?.vendor_sku) return null;

  const categories = ['hardwood', 'waterprooflvp', 'maxcorelaminate'];

  // Determine which category to try first based on COLLECTIONS_BY_CATEGORY
  const orderedCategories = [...categories];
  for (const [cat, colls] of Object.entries(COLLECTIONS_BY_CATEGORY)) {
    if (colls.some(c => c.toLowerCase() === collectionName.toLowerCase())) {
      // Move matching category to front
      const idx = orderedCategories.indexOf(cat);
      if (idx > 0) {
        orderedCategories.splice(idx, 1);
        orderedCategories.unshift(cat);
      }
      break;
    }
  }

  for (const category of orderedCategories) {
    try {
      const url = `${BASE_URL}/${category}/detail?sku=${encodeURIComponent(firstSku.vendor_sku)}&color=${encodeURIComponent(colorName)}&collection=${encodeURIComponent(collectionName)}`;
      const response = await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 });
      if (!response || response.status() !== 200) continue;

      // Wait for Angular rendering
      await delay(5000);
      await page.waitForFunction(() => {
        return !window.getAllAngularTestabilities?.()?.some(t => !t.isStable());
      }, { timeout: 10000 }).catch(() => null);

      // Check if page actually loaded product content
      const hasContent = await page.evaluate(() => {
        const imgs = document.querySelectorAll('img[src*="storage.googleapis.com"]');
        return imgs.length > 0;
      });
      if (!hasContent) continue;

      // Extract GCS images
      const images = await page.evaluate(() => {
        const results = [];
        const seen = new Set();
        for (const img of document.querySelectorAll('img')) {
          const src = img.currentSrc || img.src || img.dataset?.src || '';
          if (!src.includes('storage.googleapis.com/provenza-web')) continue;
          if (src.includes('emblem') || src.includes('logo')) continue;
          const clean = src.replace('/lightbox/', '/detail/').replace('_lb.jpg', '.jpg');
          if (!seen.has(clean)) { seen.add(clean); results.push(clean); }
        }
        // Also check background images
        for (const el of document.querySelectorAll('[style*="storage.googleapis.com"]')) {
          const match = el.style.backgroundImage?.match(/url\(['"]?(https:\/\/storage[^'")\s]+)['"]?\)/);
          if (match && !seen.has(match[1])) { seen.add(match[1]); results.push(match[1]); }
        }
        return results;
      });

      if (images.length > 0) return images;
    } catch { /* try next category */ }
  }

  return null;
}
