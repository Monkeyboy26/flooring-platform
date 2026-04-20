#!/usr/bin/env node

/**
 * Mannington DAM Image Scraper
 *
 * Crawls the Mannington Pimcore DAM (manningtonprod.pimcoreclient.com),
 * matches images to existing Mannington SKUs by vendor_sku code extracted
 * from filenames, and upserts media_assets records.
 *
 * Source: Public Pimcore DAM with server-rendered HTML listing pages.
 *   - Root folders: Hardwood (pid=3068), LVT (pid=66), Laminate (pid=3717)
 *   - Filename convention: {skuCode}-{imageType}-{design}-{color}.ext
 *   - SKU code = first token before first hyphen (e.g., 28600, RGP081)
 *
 * Usage:
 *   docker compose exec api node scripts/scrape-mannington-dam.cjs [flags]
 *
 * Flags:
 *   --dry-run          Crawl + match but don't write to DB
 *   --limit=N          Stop after inserting N images
 *   --category=NAME    Only crawl one category (Hardwood, LVT, Laminate)
 *   --verbose          Print extra matching details
 */

const { Pool } = require('pg');

// ==================== CLI ====================

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const VERBOSE = args.includes('--verbose');

function parseIntFlag(prefix) {
  const a = args.find(x => x.startsWith(prefix));
  if (!a) return null;
  const v = parseInt(a.slice(prefix.length), 10);
  return Number.isFinite(v) ? v : null;
}
function parseStringFlag(prefix) {
  const a = args.find(x => x.startsWith(prefix));
  if (!a) return null;
  return a.slice(prefix.length).replace(/^"|"$/g, '').trim();
}

const LIMIT = parseIntFlag('--limit=') ?? Infinity;
const CATEGORY_FILTER = (parseStringFlag('--category=') || '').toLowerCase() || null;

// ==================== Config ====================

const DAM_BASE = 'https://manningtonprod.pimcoreclient.com';
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const ROOT_FOLDERS = [
  { pid: 3068, name: 'Hardwood' },
  { pid: 66,   name: 'LVT' },
  { pid: 3717, name: 'Laminate' },
];

const ITEMS_PER_PAGE = 30;
const REQUEST_DELAY_MS = 250;
const HTTP_TIMEOUT_MS = 15000;
const RETRY_MAX = 3;
const MAX_IMAGES_PER_SKU = 8;

// Folders to skip (non-product content)
const SKIP_FOLDER_RE = /^(Displays?|Documents?|Icons?|Logos?|Marketing|Branding|Spec\s*Sheets?|Social|Downloads|Cropped|Resized|CAD|Videos?|Swatches?\s*Only)/i;

// ==================== DB Pool ====================

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

// ==================== Utilities ====================

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function logSection(title) {
  console.log('\n' + '='.repeat(68));
  console.log('  ' + title);
  console.log('='.repeat(68));
}

// ==================== Session Management ====================

let sessionCookie = null;

/**
 * Authenticate with the DAM using "Mannington Public Access" (no credentials needed).
 * Returns the PHPSESSID cookie to use for subsequent requests.
 */
async function authenticate() {
  console.log('  Authenticating with Mannington Public Access...');
  const resp = await fetch(`${DAM_BASE}/dam/login/login`, {
    method: 'POST',
    headers: {
      'User-Agent': USER_AGENT,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'mannington-public=Mannington+Public+Access',
    redirect: 'manual',
  });

  const cookies = resp.headers.getSetCookie ? resp.headers.getSetCookie() : [];
  const phpSession = cookies.find(c => c.startsWith('PHPSESSID='));
  if (!phpSession) {
    throw new Error('Failed to authenticate — no PHPSESSID cookie received');
  }
  sessionCookie = phpSession.split(';')[0];
  console.log(`  Authenticated (session: ${sessionCookie.substring(0, 20)}...)`);
}

// ==================== HTTP with retry + backoff ====================

async function fetchPage(url, attempt = 0) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        ...(sessionCookie ? { 'Cookie': sessionCookie } : {}),
      },
    });
    clearTimeout(timeout);

    // If redirected to login page, re-authenticate and retry
    const finalUrl = resp.url || url;
    if (finalUrl.includes('/dam/login') || finalUrl.includes('/dam/logout')) {
      if (attempt < RETRY_MAX) {
        console.warn('  [session] Session expired, re-authenticating...');
        await authenticate();
        return fetchPage(url, attempt + 1);
      }
      throw new Error('Session keeps expiring');
    }

    if ((resp.status === 429 || resp.status === 503) && attempt < RETRY_MAX) {
      const retryAfterHeader = resp.headers.get('retry-after');
      const retryAfterSec = retryAfterHeader ? parseInt(retryAfterHeader, 10) : 0;
      const backoff = Math.max(
        (Number.isFinite(retryAfterSec) ? retryAfterSec * 1000 : 0),
        Math.pow(2, attempt) * 1000 + Math.random() * 1000
      );
      console.warn(`  [rate-limit] ${resp.status} on ${url} — waiting ${Math.round(backoff)}ms (attempt ${attempt + 1}/${RETRY_MAX})`);
      await sleep(backoff);
      return fetchPage(url, attempt + 1);
    }
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status} for ${url}`);
    }
    return await resp.text();
  } catch (e) {
    clearTimeout(timeout);
    if (attempt < RETRY_MAX) {
      const backoff = Math.pow(2, attempt) * 1000 + Math.random() * 500;
      console.warn(`  [retry] ${url} → ${e.message} — waiting ${Math.round(backoff)}ms (attempt ${attempt + 1}/${RETRY_MAX})`);
      await sleep(backoff);
      return fetchPage(url, attempt + 1);
    }
    throw e;
  }
}

// ==================== HTML Parsing ====================

/**
 * Parse a DAM folder listing page. Extracts folders, assets, and pagination info.
 *
 * HTML structure (Pimcore DAM Bootstrap grid):
 *   div.grid-asset > div.thumbnail > div.asset-preview > a[href] > img[alt, src]
 *   - Folders: href="/dam/asset/list?pid=X", alt = folder name
 *   - Assets:  href="/dam/asset/detail?pid=X&id=Y", alt = original filename
 *   - img src contains thumbnail URL with image-thumb__{id}__dam_list pattern
 */
function parseFolderPage(html) {
  const folders = [];
  const assets = [];
  let maxPage = 1;

  // Two-step approach for robust HTML parsing:
  // 1. Find all <a href="..."> tags
  // 2. Look for <img> within the next ~800 chars and extract alt/src independently
  const anchorRe = /<a\s+href="([^"]+)"[^>]*>/g;
  let anchorMatch;
  while ((anchorMatch = anchorRe.exec(html)) !== null) {
    const href = anchorMatch[1];

    // Only process DAM folder/asset links
    if (!href.includes('/dam/asset/')) continue;

    // Find <img> tag within the next ~800 chars
    const region = html.substring(anchorMatch.index, anchorMatch.index + 800);
    const imgMatch = region.match(/<img\s+([^>]+)>/);
    if (!imgMatch) continue;

    const imgAttrs = imgMatch[1];
    const altMatch = imgAttrs.match(/alt="([^"]*)"/);
    if (!altMatch) continue;
    const alt = altMatch[1];

    // Folder: href contains /dam/asset/list?pid=
    const folderPidMatch = href.match(/\/dam\/asset\/list\?pid=(\d+)/);
    if (folderPidMatch) {
      folders.push({
        pid: parseInt(folderPidMatch[1], 10),
        name: alt,
      });
      continue;
    }

    // Asset: href contains /dam/asset/detail and id=
    const assetIdMatch = href.match(/\/dam\/asset\/detail[^"]*[?&]id=(\d+)/);
    if (assetIdMatch) {
      const assetId = parseInt(assetIdMatch[1], 10);

      // Real thumbnail URL is in style="background-image: url(...)" (not src, which is a placeholder).
      // Format: /Mannington/.../image-thumb__{id}__dam_list/{stem}.png
      // Swap dam_list → dam_detail for 1600px version. CDN URLs are public (no auth needed).
      let thumbPath = null;
      const bgMatch = imgAttrs.match(/background-image:\s*url\(([^)]+)\)/);
      if (bgMatch) {
        const bgUrl = bgMatch[1];
        const listMatch = bgUrl.match(/^(\/[^?]+\/image-thumb__\d+__)dam_list(\/[^?]+)\.\w+$/);
        if (listMatch) {
          // Use .webp for smaller file size (CDN supports both .png and .webp)
          thumbPath = listMatch[1] + 'dam_detail' + listMatch[2] + '.webp';
        }
      }

      assets.push({
        id: assetId,
        filename: alt, // original filename with extension
        thumbPath,      // path portion for dam_detail URL (null if no bg-image)
      });
    }
  }

  // Extract pagination: look for page links
  const pageRe = /[?&]page=(\d+)/g;
  let pm;
  while ((pm = pageRe.exec(html)) !== null) {
    const p = parseInt(pm[1], 10);
    if (p > maxPage) maxPage = p;
  }

  return { folders, assets, maxPage };
}

// ==================== Filename Parsing ====================

/**
 * Parse a DAM filename to extract vendor SKU code and image type.
 *
 * Standard pattern (SKU code first):
 *   28600-RSH-Anthology-Parchment.tif       → {skuCode: '28600', imageType: 'rsh'}
 *   RGP081-rs_aspen-drift.jpg               → {skuCode: 'RGP081', imageType: 'rs'}
 *   28600-molding-wall_base-...-parchment.tif → {skuCode: '28600', imageType: 'molding'}
 *
 * Reversed pattern (SKU code at end, used by some ADURA products):
 *   baltic-stone_storm_rrp450_rs.jpg         → {skuCode: 'RRP450', imageType: 'rs'}
 *   adura_kona_rs-beach_rgp700.jpg           → {skuCode: 'RGP700', imageType: 'rs'}
 *   vienna_alabaster_rs_rgr430.jpg           → {skuCode: 'RGR430', imageType: 'rs'}
 *
 * No Sku-Social-something.jpg               → skipped
 *
 * Returns null if filename can't be parsed or should be skipped.
 */
function parseFilename(filename, skuLookup) {
  if (!filename) return null;

  // Strip extension
  const stem = filename.replace(/\.\w+$/, '');
  if (!stem) return null;

  // Skip "No Sku" pattern
  if (/^No\s*Sku/i.test(stem)) return null;

  // Split on hyphens
  const parts = stem.split('-');
  if (parts.length < 2) return null;

  // --- Strategy 1: Standard pattern (SKU code as first token) ---
  const firstToken = parts[0].trim();
  if (firstToken && firstToken.length >= 3) {
    let imageType = parts[1].trim().toLowerCase();
    // Handle underscore-joined tokens: "rs_aspen" → "rs", "full_prop" → "fullprop"
    const underscoreIdx = imageType.indexOf('_');
    if (underscoreIdx > 0) {
      const before = imageType.substring(0, underscoreIdx);
      const after = imageType.substring(underscoreIdx + 1);
      if (before === 'full' && after === 'prop') {
        imageType = 'fullprop';
      } else {
        imageType = before;
      }
    }

    // If skuLookup is available, verify the code exists before returning
    const code = firstToken.toUpperCase();
    if (!skuLookup || skuLookup.has(code)) {
      return { skuCode: code, imageType };
    }
  }

  // --- Strategy 2: Reversed pattern (scan all tokens for a known SKU code) ---
  // Only if we have a skuLookup to validate against
  if (skuLookup) {
    // Split on both hyphens and underscores to find SKU codes anywhere
    const allTokens = stem.split(/[-_]/);
    for (const token of allTokens) {
      const code = token.trim().toUpperCase();
      if (code.length >= 4 && skuLookup.has(code)) {
        // Found a matching SKU code — now extract image type
        // Look for known type keywords in the rest of the tokens
        const imageType = extractImageType(allTokens, code);
        return { skuCode: code, imageType };
      }
    }
  }

  // --- Fallback: return first-token parse even if not in lookup ---
  if (firstToken && firstToken.length >= 3) {
    let imageType = parts[1].trim().toLowerCase();
    const underscoreIdx = imageType.indexOf('_');
    if (underscoreIdx > 0) {
      const before = imageType.substring(0, underscoreIdx);
      const after = imageType.substring(underscoreIdx + 1);
      imageType = (before === 'full' && after === 'prop') ? 'fullprop' : before;
    }
    return { skuCode: firstToken.toUpperCase(), imageType };
  }

  return null;
}

/**
 * Extract image type from tokens when SKU code is not the first token.
 * Scans for known type keywords: rs, rsh, rsv, full, angle, prop, swatch, molding, vg, etc.
 */
const IMAGE_TYPE_KEYWORDS = new Set([
  'rs', 'rsh', 'rsv', 'full', 'fullprop', 'angle', 'prop', 'swatch',
  'molding', 'vg', 'lifestyle', 'editorial', 'social'
]);

function extractImageType(tokens, skuCode) {
  for (const token of tokens) {
    const t = token.trim().toLowerCase();
    if (t === skuCode.toLowerCase()) continue; // skip the SKU code itself
    if (IMAGE_TYPE_KEYWORDS.has(t)) return t;
  }
  // Default to 'rs' for reversed-pattern files (most are room scenes)
  return 'rs';
}

// ==================== Image Type Mapping ====================

/**
 * Map DAM image type codes to media_assets.asset_type values.
 *
 * Returns null for types that should be skipped (e.g., social).
 */
function mapImageType(type) {
  if (!type) return null;
  const t = type.toLowerCase();

  // Product shots → primary
  if (t === 'full' || t === 'fullprop') return 'primary';

  // Angle / prop → alternate
  if (t === 'angle' || t === 'prop') return 'alternate';

  // Room scenes → lifestyle
  if (t === 'rs' || t === 'rsh' || t === 'rsv' || t === 'vg' ||
      t === 'lifestyle' || t === 'editorial') return 'lifestyle';

  // Swatch
  if (t === 'swatch') return 'swatch';

  // Molding images → map to accessory SKUs (handled separately)
  if (t === 'molding') return 'molding';

  // Social → skip
  if (t === 'social') return null;

  // Unknown type → treat as alternate
  return 'alternate';
}

// ==================== DAM Crawler ====================

/**
 * BFS traversal of one category tree. Returns all discovered assets.
 */
async function crawlCategory(rootPid, categoryName) {
  const allAssets = [];
  const queue = [{ pid: rootPid, path: categoryName }];
  const visited = new Set();
  let pagesFetched = 0;

  while (queue.length > 0) {
    const { pid, path: folderPath } = queue.shift();
    if (visited.has(pid)) continue;
    visited.add(pid);

    // Fetch all pages of this folder
    let page = 1;
    let maxPage = 1;

    while (page <= maxPage) {
      const url = `${DAM_BASE}/dam/asset/list?pid=${pid}&page=${page}`;
      if (VERBOSE) console.log(`    Fetching ${folderPath} page ${page}...`);

      let html;
      try {
        html = await fetchPage(url);
        pagesFetched++;
      } catch (e) {
        console.warn(`    [error] Failed to fetch pid=${pid} page=${page}: ${e.message}`);
        break;
      }

      const parsed = parseFolderPage(html);

      // Update max page from pagination
      if (parsed.maxPage > maxPage) maxPage = parsed.maxPage;

      // Process folders → add to BFS queue (skip non-product folders)
      for (const folder of parsed.folders) {
        if (SKIP_FOLDER_RE.test(folder.name)) {
          if (VERBOSE) console.log(`    [skip] folder: ${folder.name}`);
          continue;
        }
        if (!visited.has(folder.pid)) {
          queue.push({ pid: folder.pid, path: `${folderPath}/${folder.name}` });
        }
      }

      // Collect assets with folder path context
      for (const asset of parsed.assets) {
        allAssets.push({
          ...asset,
          folderPath,
          categoryName,
        });
      }

      page++;
      if (page <= maxPage) await sleep(REQUEST_DELAY_MS);
    }

    // Rate limit between folders
    await sleep(REQUEST_DELAY_MS);
  }

  console.log(`    ${categoryName}: ${visited.size} folders crawled, ${pagesFetched} pages fetched, ${allAssets.length} assets found`);
  return allAssets;
}

// ==================== SKU Lookup ====================

/**
 * Load all Mannington SKUs into a Map keyed by UPPER(vendor_sku).
 * vendor_sku in the DB is the raw colorCode (e.g., '28600', 'RGP081').
 */
async function buildSkuLookup(pool) {
  const { rows } = await pool.query(`
    SELECT s.id AS sku_id,
           s.product_id,
           s.vendor_sku,
           s.variant_name,
           s.variant_type
    FROM skus s
    JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id
    WHERE v.code = 'MANNINGTON'
      AND s.status = 'active'
  `);

  const map = new Map();
  for (const row of rows) {
    const key = row.vendor_sku.toUpperCase();
    if (!map.has(key)) {
      map.set(key, []);
    }
    map.get(key).push(row);
  }
  return map;
}

// ==================== Media Upsert ====================

async function upsertMedia(pool, { product_id, sku_id, asset_type, url, original_url, sort_order }) {
  if (sku_id) {
    return pool.query(`
      INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (product_id, sku_id, asset_type, sort_order) WHERE sku_id IS NOT NULL
      DO UPDATE SET url = EXCLUDED.url, original_url = EXCLUDED.original_url
      RETURNING id, (xmax = 0) AS is_new
    `, [product_id, sku_id, asset_type, url, original_url, sort_order]);
  }
  return pool.query(`
    INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
    VALUES ($1, NULL, $2, $3, $4, $5)
    ON CONFLICT (product_id, asset_type, sort_order) WHERE sku_id IS NULL
    DO UPDATE SET url = EXCLUDED.url, original_url = EXCLUDED.original_url
    RETURNING id, (xmax = 0) AS is_new
  `, [product_id, asset_type, url, original_url, sort_order]);
}

/**
 * Build the full-size image URL from the asset's thumbnail path or fallback.
 *
 * Preferred: dam_detail thumbnail (1600px WebP, fast CDN):
 *   https://manningtonprod.pimcoreclient.com/{path}/image-thumb__{id}__dam_detail/{stem}.webp
 *
 * Fallback (when thumbPath is null due to lazy loading):
 *   Construct from folderPath + asset ID + filename stem
 */
function buildImageUrl(asset) {
  if (asset.thumbPath) {
    return DAM_BASE + asset.thumbPath;
  }

  // Fallback: construct from known patterns
  // We can't reliably reconstruct the full folder path for the CDN URL,
  // so use the downloadOriginal endpoint as both url and original_url
  return `${DAM_BASE}/dam/asset/downloadOriginal?id=${asset.id}`;
}

function buildOriginalUrl(asset) {
  return `${DAM_BASE}/dam/asset/downloadOriginal?id=${asset.id}`;
}

// ==================== Main ====================

async function main() {
  const startTime = Date.now();

  logSection(`Mannington DAM Image Scraper — ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  if (LIMIT !== Infinity) console.log(`  Limit:         ${LIMIT}`);
  if (CATEGORY_FILTER) console.log(`  Category:      ${CATEGORY_FILTER}`);
  if (VERBOSE) console.log(`  Verbose:       on`);

  // --- Preflight ---
  try {
    await pool.query('SELECT 1');
  } catch (e) {
    console.error(`  ERROR: database unreachable: ${e.message}`);
    process.exit(1);
  }

  // --- Phase 1: Build SKU lookup ---
  logSection('Phase 1: Building SKU lookup');

  const skuLookup = await buildSkuLookup(pool);
  const totalSkus = [...skuLookup.values()].reduce((s, arr) => s + arr.length, 0);
  console.log(`  Loaded ${totalSkus} active Mannington SKUs (${skuLookup.size} unique vendor_sku codes)`);

  // Check existing media count
  const { rows: [{ count: existingCount }] } = await pool.query(`
    SELECT COUNT(*) FROM media_assets ma
    JOIN products p ON p.id = ma.product_id
    JOIN vendors v ON v.id = p.vendor_id
    WHERE v.code = 'MANNINGTON'
  `);
  console.log(`  Existing media_assets for Mannington: ${existingCount}`);

  // --- Authenticate with DAM ---
  await authenticate();

  // --- Phase 2: Crawl DAM ---
  logSection('Phase 2: Crawling DAM');

  const categoriesToCrawl = CATEGORY_FILTER
    ? ROOT_FOLDERS.filter(f => f.name.toLowerCase() === CATEGORY_FILTER)
    : ROOT_FOLDERS;

  if (categoriesToCrawl.length === 0) {
    console.error(`  ERROR: no category matches "${CATEGORY_FILTER}". Valid: ${ROOT_FOLDERS.map(f => f.name).join(', ')}`);
    process.exit(1);
  }

  let allAssets = [];
  for (const root of categoriesToCrawl) {
    console.log(`\n  Crawling ${root.name} (pid=${root.pid})...`);
    const assets = await crawlCategory(root.pid, root.name);
    allAssets.push(...assets);
  }

  console.log(`\n  Total assets discovered: ${allAssets.length}`);

  // --- Phase 3: Match + Insert ---
  logSection('Phase 3: Matching images to SKUs');

  const stats = {
    matched: 0,
    unmatched: 0,
    skipped: 0,        // non-parseable filenames, social, etc.
    inserted: 0,
    updated: 0,
    capped: 0,         // skipped due to per-SKU cap
    moldingMatched: 0,
    moldingSkipped: 0,
  };

  const byCategory = new Map();    // category → { matched, unmatched, inserted }
  const unmatchedCodes = new Map(); // skuCode → count (for reporting)

  // Group assets by matched SKU for sort_order assignment
  // First pass: parse filenames and match to SKUs
  const matchedGroups = new Map();  // sku_id → [{asset, assetType, parsed}]
  const unmatchedAssets = [];

  for (const asset of allAssets) {
    const parsed = parseFilename(asset.filename, skuLookup);
    if (!parsed) {
      stats.skipped++;
      continue;
    }

    const assetType = mapImageType(parsed.imageType);
    if (!assetType) {
      stats.skipped++;
      continue;
    }

    // Look up SKU
    const skuEntries = skuLookup.get(parsed.skuCode);
    if (!skuEntries || skuEntries.length === 0) {
      stats.unmatched++;
      unmatchedCodes.set(parsed.skuCode, (unmatchedCodes.get(parsed.skuCode) || 0) + 1);
      unmatchedAssets.push({ filename: asset.filename, skuCode: parsed.skuCode, imageType: parsed.imageType });
      continue;
    }

    // Handle molding images → match to accessory SKUs under same product
    if (assetType === 'molding') {
      // Find the flooring SKU (non-accessory) to get the product_id
      const flooringSku = skuEntries.find(s => s.variant_type !== 'accessory');
      if (!flooringSku) {
        stats.moldingSkipped++;
        continue;
      }

      // Find accessory SKUs for this product
      // We'd need to query for accessory SKUs with the same product_id
      // For now, assign molding images at the product level (no sku_id)
      const key = `product:${flooringSku.product_id}:molding`;
      if (!matchedGroups.has(key)) matchedGroups.set(key, []);
      matchedGroups.get(key).push({
        asset,
        assetType: 'alternate', // molding images → alternate at product level
        productId: flooringSku.product_id,
        skuId: null,
      });
      stats.moldingMatched++;
      continue;
    }

    // For regular images, assign to all non-accessory SKUs with this vendor_sku
    const flooringSkus = skuEntries.filter(s => s.variant_type !== 'accessory');
    if (flooringSkus.length === 0) {
      stats.unmatched++;
      continue;
    }

    for (const sku of flooringSkus) {
      const key = `sku:${sku.sku_id}`;
      if (!matchedGroups.has(key)) matchedGroups.set(key, []);
      matchedGroups.get(key).push({
        asset,
        assetType,
        productId: sku.product_id,
        skuId: sku.sku_id,
      });
    }
    stats.matched++;

    // Track per-category stats
    const cat = asset.categoryName || 'Unknown';
    if (!byCategory.has(cat)) byCategory.set(cat, { matched: 0, unmatched: 0, inserted: 0 });
    byCategory.get(cat).matched++;
  }

  console.log(`  Matched: ${stats.matched}, Unmatched: ${stats.unmatched}, Skipped: ${stats.skipped}`);
  console.log(`  Molding: ${stats.moldingMatched} matched, ${stats.moldingSkipped} skipped`);
  console.log(`  Unique SKU groups to process: ${matchedGroups.size}`);

  // Second pass: assign sort_order and upsert
  logSection('Phase 4: Upserting media assets');

  let insertCount = 0;

  for (const [groupKey, items] of matchedGroups) {
    if (insertCount >= LIMIT) break;

    // Sort items: primary first, then alternate, then lifestyle, then swatch
    const typeOrder = { primary: 0, alternate: 1, lifestyle: 2, swatch: 3 };
    items.sort((a, b) => (typeOrder[a.assetType] ?? 9) - (typeOrder[b.assetType] ?? 9));

    // Cap at MAX_IMAGES_PER_SKU
    const capped = items.slice(0, MAX_IMAGES_PER_SKU);
    if (items.length > MAX_IMAGES_PER_SKU) {
      stats.capped += items.length - MAX_IMAGES_PER_SKU;
    }

    // Ensure only one primary; demote extras to alternate
    let hasPrimary = false;
    for (const item of capped) {
      if (item.assetType === 'primary') {
        if (hasPrimary) {
          item.assetType = 'alternate';
        } else {
          hasPrimary = true;
        }
      }
    }

    // Assign sort_order: primary=0, then incrementing
    let sortIdx = 0;
    for (const item of capped) {
      if (insertCount >= LIMIT) break;

      const sortOrder = item.assetType === 'primary' ? 0 : sortIdx + 1;
      if (item.assetType !== 'primary') sortIdx++;

      const url = buildImageUrl(item.asset);
      const originalUrl = buildOriginalUrl(item.asset);

      if (DRY_RUN) {
        if (VERBOSE) {
          console.log(`    [dry] ${item.asset.filename} → ${item.assetType} sort=${sortOrder} sku=${item.skuId || 'product-level'}`);
        }
        stats.inserted++;
        insertCount++;
        continue;
      }

      try {
        const result = await upsertMedia(pool, {
          product_id: item.productId,
          sku_id: item.skuId,
          asset_type: item.assetType,
          url,
          original_url: originalUrl,
          sort_order: sortOrder,
        });
        if (result.rows[0]?.is_new) {
          stats.inserted++;
        } else {
          stats.updated++;
        }
        insertCount++;
      } catch (e) {
        console.warn(`    [db] upsert failed for ${item.asset.filename}: ${e.message}`);
      }
    }

    // Progress logging
    if (insertCount % 100 === 0 && insertCount > 0) {
      const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(0);
      console.log(`  [progress] ${insertCount} images processed (${stats.inserted} new, ${stats.updated} updated) — ${elapsedSec}s`);
    }
  }

  // --- Summary ---
  logSection('Summary');

  const elapsedMs = Date.now() - startTime;

  console.log(`  Total DAM assets discovered:   ${allAssets.length}`);
  console.log(`  Filename parse failures/skips: ${stats.skipped}`);
  console.log(`  Matched to SKUs:              ${stats.matched}`);
  console.log(`  Unmatched (no SKU in DB):      ${stats.unmatched}`);
  console.log(`  Molding matched:               ${stats.moldingMatched}`);
  console.log(`  Molding skipped:               ${stats.moldingSkipped}`);
  console.log(`  Images inserted (new):         ${stats.inserted}`);
  console.log(`  Images updated (existing):     ${stats.updated}`);
  console.log(`  Capped (over ${MAX_IMAGES_PER_SKU}/SKU):          ${stats.capped}`);
  console.log(`  Elapsed:                       ${(elapsedMs / 1000 / 60).toFixed(1)} min`);

  if (byCategory.size > 0) {
    console.log('\n  Category breakdown:');
    for (const [cat, s] of [...byCategory.entries()].sort()) {
      console.log(`    ${cat.padEnd(12)} ${String(s.matched).padStart(6)} matched  ${String(s.inserted).padStart(6)} inserted`);
    }
  }

  // Top unmatched codes
  if (unmatchedCodes.size > 0) {
    const topUnmatched = [...unmatchedCodes.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20);
    console.log(`\n  Top unmatched SKU codes (${unmatchedCodes.size} unique):`);
    for (const [code, count] of topUnmatched) {
      console.log(`    ${code.padEnd(12)} ${count} images`);
    }
    if (unmatchedCodes.size > 20) {
      console.log(`    ... and ${unmatchedCodes.size - 20} more`);
    }
  }

  // Match rate
  const totalParseable = stats.matched + stats.unmatched;
  if (totalParseable > 0) {
    const matchRate = ((stats.matched / totalParseable) * 100).toFixed(1);
    console.log(`\n  Match rate: ${matchRate}% (${stats.matched}/${totalParseable} parseable images)`);
  }

  if (DRY_RUN) {
    console.log('\n  DRY RUN — no changes were made to the database.');
  }

  // Verify final count
  if (!DRY_RUN) {
    const { rows: [{ count: finalCount }] } = await pool.query(`
      SELECT COUNT(*) FROM media_assets ma
      JOIN products p ON p.id = ma.product_id
      JOIN vendors v ON v.id = p.vendor_id
      WHERE v.code = 'MANNINGTON'
    `);
    console.log(`\n  Mannington media_assets total: ${existingCount} → ${finalCount}`);
  }

  await pool.end();
}

main().catch(async (err) => {
  console.error('\nFATAL:', err);
  try { await pool.end(); } catch {}
  process.exit(1);
});
