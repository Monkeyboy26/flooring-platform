import { upsertMediaAsset, appendLog, addJobError } from './base.js';

/**
 * Daltile DAM (Asset Bank) image enrichment scraper.
 *
 * Searches the Daltile Digital Asset Manager at images.daltile.com for
 * high-quality product images and room scenes, then matches them to
 * existing products in our database that lack images.
 *
 * Covers three brands under the Daltile umbrella:
 *   - Daltile (DAL) — series code prefix from vendor_sku
 *   - American Olean (AO) — search with "AO" or "American Olean" prefix
 *   - Marazzi (MZ) — search with "Marazzi" prefix
 *
 * Auth: Session-based login via POST + CSRF token.
 * Images: previewUrl from search results — permanent public URLs (no auth needed).
 */

const DAM_BASE = 'https://images.daltile.com/assetbank-daltile';
const SEARCH_API = `${DAM_BASE}/rest/asset-search`;
const LOGIN_URL = `${DAM_BASE}/action/login`;

const MAX_RPS = 10;
const REQUEST_INTERVAL = Math.ceil(1000 / MAX_RPS); // ms between requests

// Brands to skip — not tile manufacturers, no DAM images expected
const SKIP_COLLECTIONS = new Set([
  'schluter', 'mapei', 'noble', 'custom building products',
  'color fast', 'bostik', 'rubi', 'primo',
]);

export async function run(pool, job, source) {
  // DEPRECATED: The DAM search API (images.daltile.com/assetbank-daltile) now returns 404.
  // The Coveo catalog scraper (daltile-catalog.js) handles image enrichment via prefix matching
  // and name-based fallback, making this scraper redundant.
  await appendLog(pool, job.id,
    'DEPRECATED: Daltile DAM scraper is retired. Image enrichment is now handled by ' +
    'daltile-catalog.js via prefix matching and name-based fallback. No action taken.'
  );
  return;

  // Load products without images, grouped by collection
  const products = await loadProductsWithoutImages(pool);
  await appendLog(pool, job.id,
    `Found ${products.length} products without images across Daltile/AO/Marazzi`
  );

  if (products.length === 0) {
    await appendLog(pool, job.id, 'No products need images — done');
    return;
  }

  // Group products by collection for batch searching
  const byCollection = groupByCollection(products);
  await appendLog(pool, job.id,
    `Grouped into ${byCollection.size} collections to search`
  );

  let stats = { searched: 0, matched: 0, primarySet: 0, lifestyleSet: 0, errors: 0 };
  // Track assigned primary URLs to prevent cross-product image sharing
  const assignedPrimaryUrls = new Set();

  for (const [collection, prods] of byCollection) {
    try {
      const result = await processCollection(pool, session, collection, prods, job, assignedPrimaryUrls);
      stats.searched++;
      stats.matched += result.matched;
      stats.primarySet += result.primarySet;
      stats.lifestyleSet += result.lifestyleSet;
    } catch (err) {
      stats.errors++;
      if (stats.errors <= 30) {
        await addJobError(pool, job.id, `Collection "${collection}": ${err.message}`);
      }
    }

    // Progress log every 20 collections
    if (stats.searched % 20 === 0) {
      await appendLog(pool, job.id,
        `Progress: ${stats.searched}/${byCollection.size} collections — ` +
        `${stats.matched} products matched, ${stats.primarySet} primary + ${stats.lifestyleSet} lifestyle images`,
        { products_found: products.length, products_updated: stats.matched }
      );
    }
  }

  await appendLog(pool, job.id,
    `Complete. Collections searched: ${stats.searched}, Products matched: ${stats.matched}, ` +
    `Primary images: ${stats.primarySet}, Lifestyle images: ${stats.lifestyleSet}, ` +
    `Errors: ${stats.errors}`,
    { products_found: products.length, products_updated: stats.matched }
  );
}

// ─── Authentication ──────────────────────────────────────────────────────────

/**
 * Authenticate with the Daltile DAM via session-based login.
 * Returns session cookies string on success, null on failure.
 */
async function authenticate() {
  const user = process.env.DALTILE_DAM_USER || 'RomaFlooring';
  const pass = process.env.DALTILE_DAM_PASS || 'Roma1440';

  try {
    // Step 1: GET the login page to extract CSRF token and session cookie
    const loginPage = await fetch(LOGIN_URL, {
      redirect: 'manual',
      signal: AbortSignal.timeout(15000),
    });

    const cookies = extractCookies(loginPage);
    const html = await loginPage.text();

    // Extract CSRF token from hidden form field
    // Asset Bank uses name="CSRF" (not csrfToken)
    const csrfMatch = html.match(/name="CSRF"\s+value="([^"]+)"/i);
    const csrf = csrfMatch ? csrfMatch[1] : '';

    // Step 2: POST login credentials
    const formBody = new URLSearchParams({
      username: user,
      password: pass,
    });
    if (csrf) formBody.set('CSRF', csrf);

    const loginResp = await fetch(LOGIN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': cookies,
      },
      body: formBody.toString(),
      redirect: 'manual',
      signal: AbortSignal.timeout(15000),
    });

    // Merge cookies from both responses
    const sessionCookies = mergeCookies(cookies, extractCookies(loginResp));

    // Success: 302 redirect to viewHome (not viewLoginOrNoPermission)
    const location = loginResp.headers.get('location') || '';
    if (loginResp.status === 302 && location.includes('viewHome')) {
      return sessionCookies;
    }

    console.error('[daltile-dam] Login failed — status:', loginResp.status, 'location:', location);
    return null;
  } catch (err) {
    console.error('[daltile-dam] Auth error:', err.message);
    return null;
  }
}

// Track when session was last validated to avoid excessive validation calls
let lastSessionValidation = 0;
const SESSION_TTL = 5 * 60 * 1000; // Re-validate every 5 minutes

/**
 * Re-authenticate if session expired (detected by 302/403).
 * Caches validation result for SESSION_TTL to minimize overhead.
 */
async function ensureSession(session) {
  // Skip validation if recently validated
  if (Date.now() - lastSessionValidation < SESSION_TTL) return session;

  // Quick validation: try a minimal search
  try {
    const resp = await fetch(`${SEARCH_API}?keywords=test&pageSize=1`, {
      headers: { 'Cookie': session, 'Accept': 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(10000),
    });
    if (resp.status === 200) {
      lastSessionValidation = Date.now();
      return session;
    }
  } catch { /* re-login */ }

  console.log('[daltile-dam] Session expired, re-authenticating...');
  const newSession = await authenticate();
  if (newSession) lastSessionValidation = Date.now();
  return newSession;
}

// ─── DAM Search ──────────────────────────────────────────────────────────────

/**
 * Search the DAM for assets matching a keyword.
 * Returns array of { id, filename, previewUrl, description }.
 */
async function searchDAM(session, keywords, page = 0, pageSize = 100) {
  const url = new URL(SEARCH_API);
  url.searchParams.set('keywords', keywords);
  url.searchParams.set('pageSize', String(pageSize));
  url.searchParams.set('page', String(page));

  let retries = 0;
  while (retries < 3) {
    await delay(REQUEST_INTERVAL);

    const resp = await fetch(url.toString(), {
      headers: {
        'Cookie': session,
        'Accept': 'application/json',
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(20000),
    });

    if (resp.status === 429) {
      // Rate limited — exponential backoff
      const wait = Math.min(1000 * Math.pow(2, retries), 10000);
      console.log(`[daltile-dam] Rate limited, waiting ${wait}ms`);
      await delay(wait);
      retries++;
      continue;
    }

    if (resp.status === 302 || resp.status === 403) {
      // Session expired — caller should re-authenticate
      return null;
    }

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`DAM search error ${resp.status}: ${text.slice(0, 200)}`);
    }

    const data = await resp.json();
    return parseSearchResults(data);
  }

  throw new Error('DAM search failed after 3 retries');
}

/**
 * Parse Asset Bank search API response into a flat array of assets.
 */
function parseSearchResults(data) {
  // Asset Bank REST returns different formats depending on version
  const assets = [];

  // Format 1: { assets: [...] } or direct array
  const items = Array.isArray(data) ? data : (data.assets || data.results || []);

  for (const item of items) {
    const id = item.id || item.assetId;
    const filename = item.filename || item.originalFilename || '';
    const description = item.description || item.name || '';

    // previewUrl or contentUrl — these are public (no auth needed after redirect)
    let previewUrl = item.previewUrl || item.contentUrl || item.thumbnailUrl || '';

    // If we got a relative URL, make it absolute
    if (previewUrl && !previewUrl.startsWith('http')) {
      previewUrl = `${DAM_BASE}${previewUrl.startsWith('/') ? '' : '/'}${previewUrl}`;
    }

    // Skip QR code placeholders — the DAM generates QR codes as previews for
    // non-image assets (videos, PDFs, catalogs). Pattern: "preview_1234567-Name.jpeg"
    if (/^\d{7}-/.test(filename)) continue;

    if (id && (previewUrl || filename)) {
      assets.push({ id, filename: filename.toUpperCase(), previewUrl, description });
    }
  }

  return assets;
}

// ─── Product Loading & Grouping ──────────────────────────────────────────────

/**
 * Load Daltile/AO/Marazzi products that have no images.
 * Returns array of { product_id, name, collection, vendor_sku, vendor_code }.
 */
async function loadProductsWithoutImages(pool) {
  // Find products missing primary images (not just products with zero images).
  // This picks up products that only have lifestyle/room-scene images.
  const result = await pool.query(`
    SELECT DISTINCT ON (p.id)
      p.id AS product_id, p.name, p.collection,
      s.vendor_sku, v.code AS vendor_code
    FROM products p
    JOIN vendors v ON v.id = p.vendor_id
    JOIN skus s ON s.product_id = p.id
    WHERE v.code IN ('DAL', 'AO', 'MZ')
      AND p.status = 'active'
      AND NOT EXISTS (
        SELECT 1 FROM media_assets ma
        WHERE ma.product_id = p.id AND ma.asset_type = 'primary'
      )
    ORDER BY p.id, s.id
  `);
  return result.rows;
}

/**
 * Group products by their effective collection name for DAM searching.
 * Products in the generic 'daltile' collection get their real collection
 * extracted from the product name.
 */
function groupByCollection(products) {
  const groups = new Map();

  for (const prod of products) {
    let collection = (prod.collection || '').trim();

    // Skip non-tile brands
    if (SKIP_COLLECTIONS.has(collection.toLowerCase())) continue;

    // Products in the generic 'daltile' collection — the product name often
    // IS the color, and we need to extract the series from vendor_sku.
    // We'll group these by the series code instead.
    if (collection.toLowerCase() === 'daltile' || !collection) {
      // Use the product name as the search term (it's typically the collection name)
      collection = prod.name || 'daltile';
    }

    if (!groups.has(collection)) {
      groups.set(collection, []);
    }
    groups.get(collection).push(prod);
  }

  return groups;
}

// ─── Collection Processing ───────────────────────────────────────────────────

/**
 * Process a single collection: search DAM, match assets to products, save images.
 */
async function processCollection(pool, session, collection, products, job, assignedPrimaryUrls) {
  let result = { matched: 0, primarySet: 0, lifestyleSet: 0 };

  // Determine search keywords based on brand
  const searchTerms = buildSearchTerms(collection, products);

  let allAssets = [];
  for (const term of searchTerms) {
    // Ensure session is still valid
    session = await ensureSession(session);
    if (!session) throw new Error('Failed to re-authenticate');

    const assets = await searchDAM(session, term);
    if (assets === null) {
      // Session expired mid-search — re-auth and retry
      session = await authenticate();
      if (!session) throw new Error('Failed to re-authenticate');
      const retry = await searchDAM(session, term);
      if (retry) allAssets.push(...retry);
    } else {
      allAssets.push(...assets);
    }
  }

  if (allAssets.length === 0) return result;

  // Deduplicate assets by ID
  const seenIds = new Set();
  allAssets = allAssets.filter(a => {
    if (seenIds.has(a.id)) return false;
    seenIds.add(a.id);
    return true;
  });

  // Classify assets: product shots vs room scenes
  const { productShots, roomScenes } = classifyAssets(allAssets);

  // Build series code index from assets
  const assetsBySeriesCode = indexAssetsBySeriesCode(productShots);
  const roomScenesByCollection = indexRoomScenesByCollection(roomScenes, collection);

  // Match each product
  for (const prod of products) {
    const seriesCode = extractSeriesCode(prod.vendor_sku);
    let primaryUrl = null;
    let lifestyleUrl = null;

    // Try series code match first
    if (seriesCode && assetsBySeriesCode.has(seriesCode)) {
      const matched = assetsBySeriesCode.get(seriesCode);
      primaryUrl = matched[0]?.previewUrl;
    }

    // No fuzzy fallback for primary — fuzzy matching assigns collection-level images
    // to all products regardless of color, causing cross-color image sharing.
    // Only series-code matching is color-specific enough for primary images.

    // Room scene: collection-level match
    if (roomScenesByCollection.length > 0) {
      lifestyleUrl = roomScenesByCollection[0]?.previewUrl;
    }

    // Fallback: use any room scene from the search results
    if (!lifestyleUrl && roomScenes.length > 0) {
      lifestyleUrl = roomScenes[0]?.previewUrl;
    }

    // Save images
    if (primaryUrl || lifestyleUrl) {
      result.matched++;

      if (primaryUrl && !assignedPrimaryUrls.has(primaryUrl)) {
        await upsertMediaAsset(pool, {
          product_id: prod.product_id,
          sku_id: null,
          asset_type: 'primary',
          url: primaryUrl,
          original_url: primaryUrl,
          sort_order: 0,
        });
        assignedPrimaryUrls.add(primaryUrl);
        result.primarySet++;
      }

      if (lifestyleUrl && lifestyleUrl !== primaryUrl) {
        await upsertMediaAsset(pool, {
          product_id: prod.product_id,
          sku_id: null,
          asset_type: 'lifestyle',
          url: lifestyleUrl,
          original_url: lifestyleUrl,
          sort_order: 1,
        });
        result.lifestyleSet++;
      }
    }
  }

  return result;
}

/**
 * Build search terms for a collection, accounting for brand-specific prefixes.
 */
function buildSearchTerms(collection, products) {
  const terms = new Set();

  // Primary search: collection name itself
  terms.add(collection);

  // Determine brand prefix from first product
  const vendorCode = products[0]?.vendor_code;
  if (vendorCode === 'AO') {
    // American Olean: also search with "AO" prefix and "American Olean" prefix
    terms.add(`AO ${collection}`);
    terms.add(`American Olean ${collection}`);
  } else if (vendorCode === 'MZ') {
    terms.add(`Marazzi ${collection}`);
  } else {
    // Daltile: also try "DAL" prefix
    terms.add(`DAL ${collection}`);
  }

  return [...terms];
}

// ─── Asset Classification ────────────────────────────────────────────────────

/**
 * Classify DAM assets into product shots and room scenes based on filename patterns.
 *
 * Daltile DAM filename conventions:
 *   DAL_{seriesCode}_{size}_{colorName}.tif     — product shot
 *   DAL_{CollectionName}_RES_01.tif             — residential room scene
 *   DAL_{CollectionName}_COM_01.tif             — commercial room scene
 */
function classifyAssets(assets) {
  const productShots = [];
  const roomScenes = [];

  for (const asset of assets) {
    const fn = asset.filename || '';

    // Skip video files entirely — they're not usable as product images
    if (/\.mp4|\.mov|\.avi|\.webm/i.test(fn)) {
      roomScenes.push(asset); // bucket with room scenes so they don't become primary
      continue;
    }

    if (isRoomScene(fn)) {
      roomScenes.push(asset);
    } else {
      productShots.push(asset);
    }
  }

  return { productShots, roomScenes };
}

/**
 * Check if a filename indicates a room scene / lifestyle image.
 */
function isRoomScene(filename) {
  const fn = filename.toUpperCase();
  return fn.includes('_RES_') || fn.includes('_RES.') ||
         fn.includes('_COM_') || fn.includes('_COM.') ||
         fn.includes('_ROOM') || fn.includes('_SCENE') ||
         fn.includes('ROOMSCENE') || fn.includes('LIFESTYLE') ||
         fn.includes('SPOTLIGHT') || fn.includes('_PROMO') ||
         fn.includes('_HERO') || fn.includes('_BANNER') ||
         fn.includes('_CAMPAIGN') || fn.includes('_LOGO') ||
         fn.includes('1920X1080') || fn.includes('_4K') ||
         fn.includes('_QUILT') || fn.includes('_QUILT_') ||
         fn.includes('_QUILTPATTERN') ||
         fn.includes('_QUILT') || fn.includes('QUILTPATTERN') ||
         fn.includes('QUILT');
}

/**
 * Index product shot assets by their extracted series code.
 * Returns Map<seriesCode, asset[]>.
 */
function indexAssetsBySeriesCode(assets) {
  const index = new Map();

  for (const asset of assets) {
    const code = extractSeriesCodeFromFilename(asset.filename);
    if (!code) continue;

    if (!index.has(code)) index.set(code, []);
    index.get(code).push(asset);
  }

  return index;
}

/**
 * Filter room scenes that match the collection name.
 */
function indexRoomScenesByCollection(roomScenes, collection) {
  if (!collection) return roomScenes;

  const collSlug = collection.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return roomScenes.filter(a => {
    const fn = (a.filename || '').replace(/[^A-Z0-9]/g, '');
    return fn.includes(collSlug);
  });
}

// ─── Series Code Extraction ──────────────────────────────────────────────────

/**
 * Extract the series code from a vendor_sku.
 *
 * Daltile SKU format: {seriesCode}{colorCode}{sizeCode}{formatSuffix}
 * Examples:
 *   CC08RCT416MT → CC08  (Cove Creek, color 08)
 *   AC11PLK848MT → AC11  (Acreage, color 11)
 *   RV20PLK624MT → RV20  (Riverway, color 20)
 *
 * The series code is the leading alpha chars followed by the first set of digits.
 */
function extractSeriesCode(vendorSku) {
  if (!vendorSku) return null;
  const sku = vendorSku.toUpperCase().trim();

  // Pattern: 1-4 alpha chars + 1-3 digits at the start
  const match = sku.match(/^([A-Z]{1,4}\d{1,3})/);
  return match ? match[1] : null;
}

/**
 * Extract series code from a DAM asset filename.
 *
 * DAM filenames: DAL_{seriesCode}_{size}_{color}.tif
 * Also: AO_{seriesCode}_..., MZ_{seriesCode}_...
 */
function extractSeriesCodeFromFilename(filename) {
  if (!filename) return null;
  const fn = filename.toUpperCase();

  // Strip brand prefix: DAL_, AO_, MZ_
  const prefixMatch = fn.match(/^(?:DAL|AO|MZ)[_-]([A-Z]{1,4}\d{1,3})/);
  if (prefixMatch) return prefixMatch[1];

  // Try without prefix: direct series code at start
  const directMatch = fn.match(/^([A-Z]{1,4}\d{1,3})[_-]/);
  return directMatch ? directMatch[1] : null;
}

/**
 * Fuzzy match an asset to a product by name / collection keywords.
 * Returns the previewUrl of the best match, or null.
 */
function fuzzyMatchAsset(assets, productName, collection) {
  if (!assets.length) return null;

  const nameSlug = (productName || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const collSlug = (collection || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

  // Score each asset
  let bestScore = 0;
  let bestAsset = null;

  for (const asset of assets) {
    const fn = (asset.filename || '').replace(/[^A-Z0-9]/g, '');
    const desc = (asset.description || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const searchable = fn + desc;

    let score = 0;

    // Name words in filename/description
    if (nameSlug.length >= 3 && searchable.includes(nameSlug)) score += 10;

    // Collection in filename
    if (collSlug.length >= 3 && searchable.includes(collSlug)) score += 5;

    // Individual words from name
    const words = (productName || '').toUpperCase().split(/\s+/).filter(w => w.length >= 3);
    for (const w of words) {
      const wSlug = w.replace(/[^A-Z0-9]/g, '');
      if (wSlug.length >= 3 && searchable.includes(wSlug)) score += 2;
    }

    if (score > bestScore) {
      bestScore = score;
      bestAsset = asset;
    }
  }

  // Require minimum confidence
  return bestScore >= 4 ? bestAsset?.previewUrl || null : null;
}

// ─── Cookie / HTTP Helpers ───────────────────────────────────────────────────

/**
 * Extract Set-Cookie values from a response and format as a Cookie header string.
 */
function extractCookies(response) {
  const setCookies = response.headers.getSetCookie?.() || [];
  // Fallback for older Node versions
  if (setCookies.length === 0) {
    const raw = response.headers.get('set-cookie');
    if (raw) return raw.split(',').map(c => c.split(';')[0].trim()).join('; ');
    return '';
  }
  return setCookies.map(c => c.split(';')[0].trim()).join('; ');
}

/**
 * Merge two cookie strings, with newer cookies overriding older ones.
 */
function mergeCookies(oldCookies, newCookies) {
  const map = new Map();
  for (const str of [oldCookies, newCookies]) {
    if (!str) continue;
    for (const part of str.split(';')) {
      const eq = part.indexOf('=');
      if (eq > 0) {
        const key = part.slice(0, eq).trim();
        const val = part.slice(eq + 1).trim();
        map.set(key, val);
      }
    }
  }
  return [...map.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
