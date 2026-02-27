import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';

export function launchBrowser() {
  return puppeteer.launch({
    headless: 'new',
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });
}

export function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Convert a URL-style slug to Title Case.
 * "white-ribbon" → "White Ribbon"
 */
export function deslugify(slug) {
  if (!slug) return '';
  return slug
    // Restore fractions: "1-1-4" → "1\x001/4", "5-8" → "5/8"
    // Mixed numbers first: digit-digit-denominator where denominator is 2,3,4,8,16
    .replace(/(\d)-(\d+)-(\d+)/g, (m, whole, num, den) =>
      [2, 3, 4, 8, 16].includes(Number(den)) ? `${whole}\x00${num}/${den}` : m)
    // Simple fractions: digit-denominator (e.g., "5-8" → "5/8")
    .replace(/(\d)-(\d+)(?=[x×X\s-]|$)/g, (m, num, den) =>
      [2, 3, 4, 8, 16].includes(Number(den)) ? `${num}/${den}` : m)
    .replace(/[-_]+/g, ' ')
    .replace(/\x00/g, '-') // restore mixed-number hyphens (e.g., "1-1/4")
    .replace(/\b\w/g, c => c.toUpperCase())
    .trim();
}

/**
 * Normalize a size string: strip quotes/inch marks, collapse whitespace around "x".
 * "12 x 24" → "12x24", '12" x 24"' → "12x24"
 */
export function normalizeSize(raw) {
  if (!raw) return '';
  return raw
    .replace(/["″'']/g, '')
    .replace(/\s*[xX×]\s*/g, 'x')
    .trim();
}

/**
 * Build a variant name from size + optional qualifiers (finish, shape, etc.).
 * Filters out empty values, joins with ", ".
 * ("12x24", "Matte") → "12x24, Matte"
 * ("12x24", "Matte", "Mosaic") → "12x24, Matte, Mosaic"
 */
export function buildVariantName(size, ...qualifiers) {
  const parts = [normalizeSize(size), ...qualifiers].filter(Boolean);
  return parts.join(', ') || null;
}

/**
 * Upsert product by (vendor_id, collection, name). Returns product id.
 */
export async function upsertProduct(pool, { vendor_id, name, collection, category_id, description_short, description_long }) {
  const result = await pool.query(`
    INSERT INTO products (vendor_id, name, collection, category_id, status, description_short, description_long)
    VALUES ($1, $2, $3, $4, 'draft', $5, $6)
    ON CONFLICT ON CONSTRAINT products_vendor_collection_name_unique DO UPDATE SET
      category_id = COALESCE(EXCLUDED.category_id, products.category_id),
      description_short = COALESCE(EXCLUDED.description_short, products.description_short),
      description_long = COALESCE(EXCLUDED.description_long, products.description_long),
      updated_at = CURRENT_TIMESTAMP
    RETURNING id, (xmax = 0) AS is_new
  `, [vendor_id, name, collection || '', category_id || null, description_short || null, description_long || null]);
  return result.rows[0];
}

/**
 * Upsert SKU by internal_sku. Returns sku id.
 */
export async function upsertSku(pool, { product_id, vendor_sku, internal_sku, variant_name, sell_by, variant_type }) {
  const result = await pool.query(`
    INSERT INTO skus (product_id, vendor_sku, internal_sku, variant_name, sell_by, variant_type)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (internal_sku) DO UPDATE SET
      product_id = EXCLUDED.product_id,
      vendor_sku = COALESCE(EXCLUDED.vendor_sku, skus.vendor_sku),
      variant_name = COALESCE(EXCLUDED.variant_name, skus.variant_name),
      sell_by = COALESCE(EXCLUDED.sell_by, skus.sell_by),
      variant_type = COALESCE(EXCLUDED.variant_type, skus.variant_type),
      updated_at = CURRENT_TIMESTAMP
    RETURNING id, (xmax = 0) AS is_new
  `, [product_id, vendor_sku, internal_sku, variant_name || null, sell_by || 'sqft', variant_type || null]);
  return result.rows[0];
}

/**
 * Upsert sku_attribute by (sku_id, attribute slug).
 * Looks up attribute_id from slug, then inserts or updates.
 */
export async function upsertSkuAttribute(pool, sku_id, attributeSlug, value) {
  if (!value || !value.trim()) return;
  const attr = await pool.query('SELECT id FROM attributes WHERE slug = $1', [attributeSlug]);
  if (!attr.rows.length) return;
  const attribute_id = attr.rows[0].id;
  await pool.query(`
    INSERT INTO sku_attributes (sku_id, attribute_id, value)
    VALUES ($1, $2, $3)
    ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value = EXCLUDED.value
  `, [sku_id, attribute_id, value.trim()]);
}

/**
 * Append a log line to a scrape job and optionally update counters.
 */
export async function appendLog(pool, jobId, message, counters) {
  const timestamp = new Date().toISOString().slice(11, 19);
  const line = `[${timestamp}] ${message}\n`;
  let query = `UPDATE scrape_jobs SET log = log || $2`;
  const params = [jobId, line];
  let paramIdx = 3;

  if (counters) {
    if (counters.products_found != null) {
      query += `, products_found = $${paramIdx}`;
      params.push(counters.products_found);
      paramIdx++;
    }
    if (counters.products_created != null) {
      query += `, products_created = $${paramIdx}`;
      params.push(counters.products_created);
      paramIdx++;
    }
    if (counters.products_updated != null) {
      query += `, products_updated = $${paramIdx}`;
      params.push(counters.products_updated);
      paramIdx++;
    }
    if (counters.skus_created != null) {
      query += `, skus_created = $${paramIdx}`;
      params.push(counters.skus_created);
      paramIdx++;
    }
  }

  query += ` WHERE id = $1`;
  await pool.query(query, params);
}

/**
 * Upsert packaging by sku_id (PK). Returns nothing.
 */
export async function upsertPackaging(pool, sku_id, { sqft_per_box, pieces_per_box, weight_per_box_lbs, boxes_per_pallet, sqft_per_pallet, weight_per_pallet_lbs, roll_width_ft }) {
  await pool.query(`
    INSERT INTO packaging (sku_id, sqft_per_box, pieces_per_box, weight_per_box_lbs, boxes_per_pallet, sqft_per_pallet, weight_per_pallet_lbs, roll_width_ft)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT (sku_id) DO UPDATE SET
      sqft_per_box = COALESCE(EXCLUDED.sqft_per_box, packaging.sqft_per_box),
      pieces_per_box = COALESCE(EXCLUDED.pieces_per_box, packaging.pieces_per_box),
      weight_per_box_lbs = COALESCE(EXCLUDED.weight_per_box_lbs, packaging.weight_per_box_lbs),
      boxes_per_pallet = COALESCE(EXCLUDED.boxes_per_pallet, packaging.boxes_per_pallet),
      sqft_per_pallet = COALESCE(EXCLUDED.sqft_per_pallet, packaging.sqft_per_pallet),
      weight_per_pallet_lbs = COALESCE(EXCLUDED.weight_per_pallet_lbs, packaging.weight_per_pallet_lbs),
      roll_width_ft = COALESCE(EXCLUDED.roll_width_ft, packaging.roll_width_ft)
  `, [sku_id, sqft_per_box || null, pieces_per_box || null, weight_per_box_lbs || null, boxes_per_pallet || null, sqft_per_pallet || null, weight_per_pallet_lbs || null, roll_width_ft || null]);
}

/**
 * Upsert pricing by sku_id (PK). Returns nothing.
 */
export async function upsertPricing(pool, sku_id, { cost, retail_price, price_basis, cut_price, roll_price, cut_cost, roll_cost, roll_min_sqft, map_price }) {
  await pool.query(`
    INSERT INTO pricing (sku_id, cost, retail_price, price_basis, cut_price, roll_price, cut_cost, roll_cost, roll_min_sqft, map_price)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    ON CONFLICT (sku_id) DO UPDATE SET
      cost = COALESCE(EXCLUDED.cost, pricing.cost),
      retail_price = COALESCE(EXCLUDED.retail_price, pricing.retail_price),
      price_basis = COALESCE(EXCLUDED.price_basis, pricing.price_basis),
      cut_price = COALESCE(EXCLUDED.cut_price, pricing.cut_price),
      roll_price = COALESCE(EXCLUDED.roll_price, pricing.roll_price),
      cut_cost = COALESCE(EXCLUDED.cut_cost, pricing.cut_cost),
      roll_cost = COALESCE(EXCLUDED.roll_cost, pricing.roll_cost),
      roll_min_sqft = COALESCE(EXCLUDED.roll_min_sqft, pricing.roll_min_sqft),
      map_price = COALESCE(EXCLUDED.map_price, pricing.map_price)
  `, [sku_id, cost || 0, retail_price || 0, price_basis || 'per_sqft', cut_price || null, roll_price || null, cut_cost || null, roll_cost || null, roll_min_sqft || null, map_price || null]);
}

/**
 * Upsert inventory snapshot by (sku_id, warehouse). Used for scraped warehouse stock.
 */
export async function upsertInventorySnapshot(pool, sku_id, warehouse, { qty_on_hand_sqft, qty_in_transit_sqft }) {
  await pool.query(`
    INSERT INTO inventory_snapshots (sku_id, warehouse, qty_on_hand_sqft, qty_in_transit_sqft, snapshot_time, fresh_until)
    VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + INTERVAL '24 hours')
    ON CONFLICT (sku_id, warehouse) DO UPDATE SET
      qty_on_hand_sqft = EXCLUDED.qty_on_hand_sqft,
      qty_in_transit_sqft = EXCLUDED.qty_in_transit_sqft,
      snapshot_time = CURRENT_TIMESTAMP,
      fresh_until = CURRENT_TIMESTAMP + INTERVAL '24 hours'
  `, [sku_id, warehouse, qty_on_hand_sqft || 0, qty_in_transit_sqft || 0]);
}

/**
 * Add an error entry to a scrape job's errors JSONB array.
 */
export async function addJobError(pool, jobId, error) {
  await pool.query(`
    UPDATE scrape_jobs SET errors = errors || $2::jsonb WHERE id = $1
  `, [jobId, JSON.stringify([{ message: error, time: new Date().toISOString() }])]);
}

/**
 * Download an image from a URL to a local file path.
 * Creates parent directories as needed. Returns destPath on success, null on failure.
 */
export async function downloadImage(imageUrl, destPath) {
  try {
    await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
    const resp = await fetch(imageUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(30000)
    });
    if (!resp.ok) return null;
    await pipeline(resp.body, fs.createWriteStream(destPath));
    return destPath;
  } catch (err) {
    // Clean up partial file
    try { await fs.promises.unlink(destPath); } catch { }
    return null;
  }
}

/**
 * Upsert a media_assets row.
 * Uses separate partial unique indexes for SKU-level vs product-level images.
 * Returns { id, is_new }.
 */
export async function upsertMediaAsset(pool, { product_id, sku_id, asset_type, url, original_url, sort_order }) {
  const at = asset_type || 'primary';
  const so = sort_order || 0;
  const ou = original_url || null;

  let result;
  if (sku_id) {
    // SKU-level image: conflict on (product_id, sku_id, asset_type, sort_order) WHERE sku_id IS NOT NULL
    result = await pool.query(`
      INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (product_id, sku_id, asset_type, sort_order) WHERE sku_id IS NOT NULL DO UPDATE SET
        url = EXCLUDED.url,
        original_url = EXCLUDED.original_url
      RETURNING id, (xmax = 0) AS is_new
    `, [product_id, sku_id, at, url, ou, so]);
  } else {
    // Product-level image: conflict on (product_id, asset_type, sort_order) WHERE sku_id IS NULL
    result = await pool.query(`
      INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
      VALUES ($1, NULL, $2, $3, $4, $5)
      ON CONFLICT (product_id, asset_type, sort_order) WHERE sku_id IS NULL DO UPDATE SET
        url = EXCLUDED.url,
        original_url = EXCLUDED.original_url
      RETURNING id, (xmax = 0) AS is_new
    `, [product_id, at, url, ou, so]);
  }
  return result.rows[0];
}

/**
 * Extract file extension from an image URL. Defaults to '.jpg'.
 */
export function resolveImageExtension(url) {
  try {
    const pathname = new URL(url).pathname;
    const match = pathname.match(/\.(jpg|jpeg|png|webp|gif)(\?|$)/i);
    if (match) return '.' + match[1].toLowerCase().replace('jpeg', 'jpg');
  } catch { }
  return '.jpg';
}

/**
 * Extract large images from a page, filtering out icons, logos, and tiny elements.
 * Uses actual rendered dimensions (naturalWidth/naturalHeight) to exclude small images.
 *
 * @param {import('puppeteer').Page} page - Puppeteer page object
 * @param {Set<string>} [excludeUrls] - URLs to skip (e.g., site-wide images from collectSiteWideImages)
 * @param {number} [minDimension=150] - Minimum width AND height in pixels
 * @returns {Promise<Array<{src: string, width: number, height: number, alt: string}>>} sorted by area descending
 */
export async function extractLargeImages(page, excludeUrls = new Set(), minDimension = 150) {
  const EXCLUDE_PATTERNS = [
    'logo', 'icon', 'favicon', 'social', 'sprite', 'pixel', 'tracking',
    'blank', 'spacer', 'nav', 'menu', 'footer', 'header', 'badge', 'flag',
    'spinner', 'loader', 'avatar', 'arrow', 'caret', 'chevron', 'close',
    'search', 'cart', 'phone', 'email', 'map-pin', 'marker', 'play-btn',
    'share', 'print', 'pdf-icon', 'download-icon', 'ClaimU',
    '1x1', '1px', 'transparent.gif', 'transparent.png',
  ];

  const excludeArray = [...excludeUrls];

  return page.evaluate((excludePatterns, excludeUrlList, minDim) => {
    const results = [];
    const seen = new Set();

    for (const img of document.querySelectorAll('img')) {
      if (!img.complete || img.naturalHeight === 0) continue;
      if (img.naturalWidth < minDim || img.naturalHeight < minDim) continue;

      const src = img.currentSrc || img.src || img.dataset?.src || '';
      if (!src || !src.startsWith('http')) continue;

      const srcLower = src.toLowerCase();
      const srcClean = srcLower.split('?')[0];

      // Skip excluded URL patterns
      if (excludePatterns.some(p => srcLower.includes(p))) continue;

      // Skip site-wide images
      if (excludeUrlList.some(u => srcLower.includes(u.toLowerCase()))) continue;

      // Deduplicate by cleaned URL
      if (seen.has(srcClean)) continue;
      seen.add(srcClean);

      results.push({
        src,
        width: img.naturalWidth,
        height: img.naturalHeight,
        alt: (img.alt || '').trim(),
      });
    }

    // Sort by pixel area descending (largest images first)
    results.sort((a, b) => (b.width * b.height) - (a.width * a.height));
    return results;
  }, EXCLUDE_PATTERNS, excludeArray, minDimension);
}

/**
 * Navigate to a brand's homepage and collect all image URLs present.
 * These represent site-wide elements (logos, banners, nav icons) that
 * should be excluded from product-specific image results.
 *
 * @param {import('puppeteer').Page} page - Puppeteer page object
 * @param {string} baseUrl - Brand homepage URL
 * @returns {Promise<Set<string>>} Set of image URLs to exclude
 */
export async function collectSiteWideImages(page, baseUrl) {
  try {
    await page.goto(baseUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    await delay(2000);

    const urls = await page.evaluate(() => {
      const results = [];
      for (const img of document.querySelectorAll('img')) {
        const src = img.currentSrc || img.src || '';
        if (src && src.startsWith('http')) {
          // Normalize: strip query params for comparison
          results.push(src.split('?')[0].toLowerCase());
        }
      }
      return results;
    });

    return new Set(urls);
  } catch {
    return new Set();
  }
}

/**
 * Fuzzy-match a scraped product name to a DB product name.
 * Returns a confidence score between 0 and 1.
 *
 * @param {string} scraped - Name from the vendor website
 * @param {string} dbName - Name from our database
 * @returns {number} Confidence score 0–1
 */
export function fuzzyMatch(scraped, dbName) {
  if (!scraped || !dbName) return 0;

  // Normalize: lowercase, strip punctuation, collapse whitespace
  const normalize = (s) => s.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
  const a = normalize(scraped);
  const b = normalize(dbName);

  if (!a || !b) return 0;

  // Exact match
  if (a === b) return 1;

  // Containment check
  if (a.includes(b) || b.includes(a)) return 0.9;

  // Word overlap ratio
  const wordsA = new Set(a.split(' '));
  const wordsB = new Set(b.split(' '));
  const intersection = [...wordsA].filter(w => wordsB.has(w));
  const union = new Set([...wordsA, ...wordsB]);

  if (union.size === 0) return 0;

  const jaccard = intersection.length / union.size;

  // Boost if all words from the shorter name are in the longer name
  const shorter = wordsA.size <= wordsB.size ? wordsA : wordsB;
  const longer = wordsA.size <= wordsB.size ? wordsB : wordsA;
  const allShorterInLonger = [...shorter].every(w => longer.has(w));
  if (allShorterInLonger && shorter.size >= 2) return Math.max(jaccard, 0.85);

  return jaccard;
}

/**
 * Sort image URLs to prefer product-only shots (white/transparent background)
 * over lifestyle/room-scene images. Returns a new sorted array (does not mutate).
 *
 * Philosophy: TRUST the vendor's original gallery order by default. Only re-rank
 * when there's a strong signal (lifestyle keyword → demote, or known product-shot
 * pattern → promote). When scores tie, the vendor's original order is preserved.
 *
 * Use as: const sorted = preferProductShot(imageUrls, 'colorName');
 * Or with variant hints: preferProductShot(imageUrls, 'colorName', { size: '12x12', finish: 'Honed' });
 */
export function preferProductShot(urls, colorHint, variantHints) {
  if (!urls || urls.length <= 1) return urls || [];

  // Strong indicators of a clean product shot (swatch on white/transparent bg)
  const PRODUCT_KEYWORDS = [
    'swatch', 'chip', 'product', 'closeup', 'close-up',
    'sample', 'solo', 'isolated', 'cutout', 'cut-out', 'studio',
    'white-bg', 'transparent', 'no-bg', 'nobg', 'variation', 'resize',
  ];

  // Keywords that suggest a lifestyle/room-scene image
  const LIFESTYLE_KEYWORDS = [
    'room', 'scene', 'lifestyle', 'installed', 'roomscene', 'setting',
    'interior', 'kitchen', 'bath', 'bathroom', 'living', 'outdoor', 'pool',
    'backyard', 'application', 'install', 'showroom',
    'ambiance', 'vignette', 'hero', 'banner', 'header',
    'amb0', 'amb1', '_amb_', '-amb-',
    'crop_upscale',
  ];

  // Normalize color hint for URL matching
  const colorSlug = colorHint
    ? colorHint.toLowerCase().replace(/[^a-z0-9]+/g, '')
    : null;

  // Normalize variant hints for URL matching (e.g., "12x12" → "12x12", "Honed" → "honed")
  const sizeSlug = variantHints?.size
    ? variantHints.size.toLowerCase().replace(/[^a-z0-9x]+/g, '') : null;
  const finishSlug = variantHints?.finish
    ? variantHints.finish.toLowerCase().replace(/[^a-z0-9]+/g, '') : null;

  function scoreUrl(url, originalIndex) {
    const lower = url.toLowerCase();
    const filename = lower.split('/').pop().split('?')[0];
    let score = 0;

    // PNG files are more likely to have transparent backgrounds
    if (filename.endsWith('.png')) score += 2;

    // Arizona Tile convention: filenames ending in -P before the extension are product shots
    if (/-p\.\w+$/.test(filename)) score += 6;

    for (const kw of PRODUCT_KEYWORDS) {
      if (filename.includes(kw)) { score += 3; break; }
    }
    for (const kw of LIFESTYLE_KEYWORDS) {
      if (filename.includes(kw)) { score -= 5; break; }
    }

    // Color-aware boost: if URL filename contains the color name, it's likely
    // the right product shot for this color (not a shared/wrong-color image)
    if (colorSlug && colorSlug.length >= 3) {
      if (filename.includes(colorSlug)) score += 5;
    }

    // Variant-aware boost: prefer images whose filename matches the specific size and finish
    const fnNorm = filename.replace(/[^a-z0-9x]+/g, '');
    if (sizeSlug && sizeSlug.length >= 3 && fnNorm.includes(sizeSlug)) score += 8;
    if (finishSlug && finishSlug.length >= 3 && fnNorm.includes(finishSlug)) score += 8;

    // Stable sort: preserve vendor's original gallery order as tiebreaker.
    // A tiny penalty per position ensures original order wins when scores are equal.
    score -= originalIndex * 0.001;

    return score;
  }

  return urls
    .map((url, i) => ({ url, score: scoreUrl(url, i) }))
    .sort((a, b) => b.score - a.score)
    .map(x => x.url);
}

/**
 * Extract PDF links from a page, filtered to spec/technical documents.
 * Returns array of { url, label } objects.
 *
 * @param {import('puppeteer').Page} page - Puppeteer page object
 * @returns {Promise<Array<{url: string, label: string}>>}
 */
export async function extractSpecPDFs(page) {
  const SPEC_KEYWORDS = [
    'spec', 'technical', 'install', 'maintenance', 'warranty',
    'care', 'data sheet', 'datasheet', 'guide', 'brochure',
  ];

  return page.evaluate((keywords) => {
    const results = [];
    const seen = new Set();
    for (const a of document.querySelectorAll('a[href]')) {
      const href = (a.getAttribute('href') || '').trim();
      if (!href.match(/\.pdf(\?|#|$)/i)) continue;
      const url = href.startsWith('http') ? href : new URL(href, location.origin).href;
      const urlLower = url.toLowerCase();
      if (seen.has(urlLower)) continue;
      const label = (a.textContent || '').trim() || (a.getAttribute('title') || '').trim() || '';
      const combined = (label + ' ' + urlLower).toLowerCase();
      if (keywords.some(kw => combined.includes(kw))) {
        seen.add(urlLower);
        results.push({ url, label: label || url.split('/').pop().replace('.pdf', '') });
      }
    }
    return results;
  }, SPEC_KEYWORDS);
}

/**
 * Normalize Tri-West product names for better matching against manufacturer sites.
 *
 * - Strips "Brand - " prefix from collection names (e.g., "Provenza - ICONIC" → "ICONIC")
 * - Title-cases ALL-CAPS color names (e.g., "AUTUMN GREY" → "Autumn Grey")
 * - Removes trailing dimension strings already captured as size attributes
 *
 * @param {string} rawName - Raw name from Tri-West DNav portal
 * @returns {string} Normalized name
 */
export function normalizeTriwestName(rawName) {
  if (!rawName) return '';
  let name = rawName.trim();

  // Strip "Brand - " prefix (handles "Provenza - ICONIC", "Shaw - Floorte Pro", etc.)
  name = name.replace(/^[A-Za-z][A-Za-z\s&.-]+\s*[-–—]\s*/, '');

  // Remove trailing dimension strings like "12x24", "7" x 48"", "3/4 x 5"
  name = name.replace(/\s+\d+["″']?\s*[xX×]\s*\d+["″']?\s*$/, '');
  name = name.replace(/\s+\d+\/\d+\s*[xX×]\s*\d+["″']?\s*$/, '');

  // Title-case if ALL CAPS (2+ words all uppercase)
  if (name === name.toUpperCase() && name.includes(' ')) {
    name = name
      .toLowerCase()
      .replace(/\b\w/g, c => c.toUpperCase());
  }

  return name.trim();
}
