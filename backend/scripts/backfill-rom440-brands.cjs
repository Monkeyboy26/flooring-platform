#!/usr/bin/env node

/**
 * ROM440 (Hardware Resources) — Sub-brand Back-fill
 *
 * Hardware Resources is a house-of-brands: Jeffrey Alexander (decorative
 * hardware + vanities), Elements (value decorative + bath hardware),
 * Task Lighting (light & power), HR Max (functional hardware), and the
 * "Hardware Resources" house label (organizers, carved wood, moulding).
 * Our import assigned every product the generic Hardware Resources brand.
 *
 * This script visits each product's page on hardwareresources.com (same
 * search→redirect + page-cache approach as scrape-rom440-images.cjs),
 * reads the authoritative spec-table row:
 *
 *     <td class="col data" data-th="Brand">Jeffrey Alexander</td>
 *
 * and points products.brand_id at the matching brands row (created on
 * first sight, linked to the HR vendor via vendor_brands, is_primary=false).
 * The storefront already prefers brand_name over vendor_name, so no
 * frontend change is needed.
 *
 * Products with no page (discontinued) or no Brand row keep the generic
 * Hardware Resources brand.
 *
 * Resume safety: results are committed per-product and recorded in
 * data/ROM440/brand-backfill-state.json; a re-run skips finished products.
 *
 * Usage:
 *   docker compose exec -T api node scripts/backfill-rom440-brands.cjs [flags]
 *
 * Flags:
 *   --dry-run          Resolve + report, write nothing to the DB
 *   --limit=N          Process only the first N products
 *   --active-only      Only products with is_active AND status='active'
 *   --category="Decorative Hardware"   Restrict by category name
 */

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

// ==================== CLI ====================

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const ACTIVE_ONLY = args.includes('--active-only');

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
const CATEGORY = parseStringFlag('--category=') || null;

// ==================== Config ====================

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const HR_BASE = 'https://www.hardwareresources.com';
const SEARCH_URL_BASE = HR_BASE + '/catalogsearch/result/?q=';

const DATA_DIR = process.env.ROM440_DIR || '/app/data/ROM440';
const STATE_FILE = path.join(DATA_DIR, 'brand-backfill-state.json');

const HR_VENDOR_ID = 'c94f3624-6796-4b3b-b5d7-0f5e544955a5';

let pageDelayMinMs = 800;
let pageDelayJitterMs = 400;
const HTTP_TIMEOUT_MS = 15000;
const RETRY_MAX = 2;
const COOLDOWN_BUMP_MS = 400;
const COOLDOWN_MAX_MS = 5000;
const STATE_SAVE_EVERY = 25;

// Canonical brand labels as they appear in HR's spec table. Unknown
// labels are kept verbatim (trimmed) and logged so we notice new brands.
const BRAND_CANON = {
  'jeffrey alexander': 'Jeffrey Alexander',
  'elements': 'Elements',
  'task lighting': 'Task Lighting',
  'hr max': 'HR Max',
  'hardware resources': 'Hardware Resources',
};

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

function bumpCooldown() {
  const before = pageDelayMinMs;
  pageDelayMinMs = Math.min(COOLDOWN_MAX_MS, pageDelayMinMs + COOLDOWN_BUMP_MS);
  if (pageDelayMinMs !== before) {
    console.warn(`  [cooldown] pageDelayMinMs: ${before} → ${pageDelayMinMs} ms`);
  }
}

async function fetchWithRetry(url, opts = {}, attempt = 0) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      ...opts,
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        ...(opts.headers || {}),
      },
    });
    clearTimeout(timeout);
    if ((resp.status === 429 || resp.status === 503) && attempt < RETRY_MAX) {
      const retryAfterHeader = resp.headers.get('retry-after');
      const retryAfterSec = retryAfterHeader ? parseInt(retryAfterHeader, 10) : 0;
      const backoff = Math.max(
        (Number.isFinite(retryAfterSec) ? retryAfterSec * 1000 : 0),
        Math.pow(2, attempt) * 1000 + Math.random() * 1000
      );
      console.warn(`  [rate-limit] ${resp.status} on ${url} — waiting ${Math.round(backoff)}ms (attempt ${attempt + 1}/${RETRY_MAX})`);
      bumpCooldown();
      await sleep(backoff);
      return fetchWithRetry(url, opts, attempt + 1);
    }
    return resp;
  } catch (e) {
    clearTimeout(timeout);
    if (attempt < RETRY_MAX) {
      const backoff = Math.pow(2, attempt) * 1000 + Math.random() * 500;
      console.warn(`  [retry] ${url} → ${e.message} — waiting ${Math.round(backoff)}ms (attempt ${attempt + 1}/${RETRY_MAX})`);
      bumpCooldown();
      await sleep(backoff);
      return fetchWithRetry(url, opts, attempt + 1);
    }
    throw e;
  }
}

// Balanced-brace JSON extractor (same as scrape-rom440-images.cjs) — the
// swatchOptions blob embeds HTML strings with unbalanced braces, so a
// regex is not safe here.
function extractJsonObject(src, key) {
  const idx = src.indexOf(key);
  if (idx === -1) return {};
  let i = src.indexOf('{', idx + key.length);
  if (i === -1) return {};
  const start = i;
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      if (escape) { escape = false; continue; }
      if (c === '\\') { escape = true; continue; }
      if (c === '"') { inStr = false; continue; }
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        const raw = src.slice(start, i + 1);
        try {
          return JSON.parse(raw);
        } catch {
          return {};
        }
      }
    }
  }
  return {};
}

// ==================== Page parsing ====================

function parseBrandPage(html, canonicalUrl) {
  // Authoritative brand: the "More Information" spec table row.
  let brand = null;
  const m = html.match(/data-th="Brand"[^>]*>\s*([^<]+?)\s*</);
  if (m) {
    const raw = m[1].replace(/\s+/g, ' ').trim();
    brand = BRAND_CANON[raw.toLowerCase()] || raw;
    if (!BRAND_CANON[raw.toLowerCase()]) {
      console.warn(`  [new-brand-label] "${raw}" on ${canonicalUrl}`);
    }
  }

  // Variant skus map — used only to seed the search cache so sibling
  // SKUs skip the /catalogsearch round-trip.
  let skus = {};
  const swatchIdx = html.indexOf('"swatchOptions"');
  if (swatchIdx !== -1) {
    const region = html.slice(swatchIdx, swatchIdx + 2_000_000);
    skus = extractJsonObject(region, '"skus":');
  }

  return { canonicalUrl, brand, skus };
}

// ==================== Page fetch with cache ====================

const pageCache = new Map();   // canonicalUrl → parsed
const searchCache = new Map(); // vendor_sku (UPPER) → canonicalUrl | '__NOT_FOUND__'
let totalPageFetches = 0;
let totalPageCacheHits = 0;
let totalSearchCacheHits = 0;

function populateSearchCacheFromPage(parsed) {
  if (parsed.skus && Object.keys(parsed.skus).length > 0) {
    for (const val of Object.values(parsed.skus)) {
      if (val) searchCache.set(String(val).toUpperCase(), parsed.canonicalUrl);
    }
    return;
  }
  const slugMatch = parsed.canonicalUrl.match(/\/([^\/]+)\.html(?:$|\?|#)/);
  if (slugMatch) searchCache.set(slugMatch[1].toUpperCase(), parsed.canonicalUrl);
}

async function getOrFetchPage(vendorSku) {
  const skuKey = vendorSku.toUpperCase();

  if (searchCache.has(skuKey)) {
    const cached = searchCache.get(skuKey);
    if (cached === '__NOT_FOUND__') throw new Error('no-redirect');
    if (pageCache.has(cached)) {
      totalSearchCacheHits++;
      return pageCache.get(cached);
    }
  }

  const searchUrl = SEARCH_URL_BASE + encodeURIComponent(vendorSku);
  let resp;
  try {
    resp = await fetchWithRetry(searchUrl, { redirect: 'follow' });
  } catch (e) {
    throw new Error(`fetch-exhausted: ${e.message}`);
  }
  if (!resp.ok) {
    if (process.env.DEBUG_ROM440) console.warn(`  [debug] ${vendorSku} → ${resp.status} final=${(resp.url || '').slice(0, 110)}`);
    // Exact-match search can redirect to Magento's internal
    // /catalog/product/view/id/NNN/s/<slug>/ URL, which HR 404s (they only
    // serve rewritten /<slug>.html URLs). Rebuild the clean URL from the
    // slug and verify the SKU against the page's own variant map.
    const slugM = (resp.url || '').match(/\/catalog\/product\/view\/id\/\d+\/s\/([^\/?]+)/);
    try { await resp.text(); } catch {}
    if (slugM) {
      const cleanUrl = `${HR_BASE}/${slugM[1]}.html`;
      let parsed = pageCache.get(cleanUrl);
      if (!parsed) {
        await sleep(pageDelayMinMs + Math.random() * pageDelayJitterMs);
        const cleanResp = await fetchWithRetry(cleanUrl, { redirect: 'follow' });
        if (cleanResp.ok) {
          const finalClean = (cleanResp.url || cleanUrl).split('?')[0];
          parsed = parseBrandPage(await cleanResp.text(), finalClean);
          pageCache.set(finalClean, parsed);
          if (finalClean !== cleanUrl) pageCache.set(cleanUrl, parsed);
          populateSearchCacheFromPage(parsed);
          totalPageFetches++;
        } else {
          try { await cleanResp.text(); } catch {}
        }
      }
      if (parsed) {
        const skuInMap = parsed.skus && Object.values(parsed.skus).some(v => String(v).toUpperCase() === skuKey);
        const slugPrefix = skuKey.startsWith(slugM[1].toUpperCase().replace(/-/g, '')) || skuKey.replace(/[^A-Z0-9]/g, '').startsWith(slugM[1].toUpperCase().replace(/[^A-Z0-9]/g, ''));
        if (skuInMap || slugPrefix) {
          searchCache.set(skuKey, parsed.canonicalUrl);
          await sleep(pageDelayMinMs + Math.random() * pageDelayJitterMs);
          return parsed;
        }
      }
    }
    throw new Error(`search-http-${resp.status}`);
  }
  const finalUrlRaw = resp.url || searchUrl;
  if (finalUrlRaw.includes('/catalogsearch/')) {
    // No exact-match redirect. Some SKUs (vanity tops, mirrors) land on a
    // results page instead — follow the first product tile and accept it
    // only if the page's own variant map (or slug) confirms this SKU.
    let resultsHtml = '';
    try { resultsHtml = await resp.text(); } catch {}
    const tile = resultsHtml.match(/class="product-item-link"[^>]*href="(https:\/\/www\.hardwareresources\.com\/[^"]+\.html)"/);
    if (tile) {
      const tileUrl = tile[1].split('?')[0];
      let parsed = pageCache.get(tileUrl);
      if (!parsed) {
        await sleep(pageDelayMinMs + Math.random() * pageDelayJitterMs);
        const tileResp = await fetchWithRetry(tileUrl, { redirect: 'follow' });
        if (tileResp.ok) {
          parsed = parseBrandPage(await tileResp.text(), tileUrl);
          pageCache.set(tileUrl, parsed);
          populateSearchCacheFromPage(parsed);
          totalPageFetches++;
        } else {
          try { await tileResp.text(); } catch {}
        }
      }
      if (parsed) {
        const skuInMap = parsed.skus && Object.values(parsed.skus).some(v => String(v).toUpperCase() === skuKey);
        const slugMatch = tileUrl.toUpperCase().includes(skuKey.replace(/[^A-Z0-9]/g, '-')) || tileUrl.toUpperCase().includes(skuKey);
        if (skuInMap || slugMatch) {
          searchCache.set(skuKey, tileUrl);
          await sleep(pageDelayMinMs + Math.random() * pageDelayJitterMs);
          return parsed;
        }
      }
    }
    searchCache.set(skuKey, '__NOT_FOUND__');
    throw new Error('no-redirect');
  }
  const canonicalUrl = finalUrlRaw.split('?')[0];

  if (pageCache.has(canonicalUrl)) {
    try { await resp.text(); } catch {}
    totalPageCacheHits++;
    const parsed = pageCache.get(canonicalUrl);
    populateSearchCacheFromPage(parsed);
    searchCache.set(skuKey, canonicalUrl);
    return parsed;
  }

  const html = await resp.text();
  const parsed = parseBrandPage(html, canonicalUrl);
  pageCache.set(canonicalUrl, parsed);
  populateSearchCacheFromPage(parsed);
  searchCache.set(skuKey, canonicalUrl);
  totalPageFetches++;
  await sleep(pageDelayMinMs + Math.random() * pageDelayJitterMs);
  return parsed;
}

// ==================== Brand rows ====================

const brandIdByName = new Map(); // canonical name → brands.id

async function ensureBrand(name) {
  if (brandIdByName.has(name)) return brandIdByName.get(name);
  const code = name.toUpperCase().replace(/[^A-Z0-9]+/g, '');
  const existing = await pool.query('SELECT id FROM brands WHERE lower(name) = lower($1) OR code = $2', [name, code]);
  let id;
  if (existing.rows.length > 0) {
    id = existing.rows[0].id;
  } else if (DRY_RUN) {
    id = `dry-run-${code}`;
  } else {
    const ins = await pool.query(
      'INSERT INTO brands (name, code) VALUES ($1, $2) ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name RETURNING id',
      [name, code]
    );
    id = ins.rows[0].id;
  }
  if (!DRY_RUN) {
    await pool.query(
      'INSERT INTO vendor_brands (vendor_id, brand_id, is_primary) VALUES ($1, $2, false) ON CONFLICT DO NOTHING',
      [HR_VENDOR_ID, id]
    );
  }
  brandIdByName.set(name, id);
  return id;
}

// ==================== State (resume) ====================

let state = { products: {} }; // productId → { brand|null, status }

function loadState() {
  try {
    state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (!state.products) state = { products: {} };
  } catch {
    state = { products: {} };
  }
}

function saveState() {
  if (DRY_RUN) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state));
  } catch (e) {
    console.warn(`  [state] failed to save: ${e.message}`);
  }
}

// ==================== Main ====================

async function main() {
  console.log('ROM440 sub-brand back-fill' + (DRY_RUN ? ' (DRY RUN)' : ''));
  loadState();
  const alreadyDone = Object.keys(state.products).length;
  if (alreadyDone > 0) console.log(`Resuming: ${alreadyDone} products already resolved in state file`);

  const params = [HR_VENDOR_ID];
  let where = 'p.vendor_id = $1';
  if (ACTIVE_ONLY) where += " AND p.is_active AND p.status = 'active'";
  if (CATEGORY) {
    params.push(CATEGORY);
    where += ` AND c.name = $${params.length}`;
  }

  // Order active-first (storefront-visible products get brands soonest),
  // then by vendor_sku so product families cluster and share page cache.
  const { rows } = await pool.query(`
    SELECT p.id, p.name, p.brand_id, b.name AS brand_name,
           (p.is_active AND p.status = 'active') AS live,
           array_agg(s.vendor_sku ORDER BY length(s.vendor_sku), s.vendor_sku) AS vendor_skus,
           min(s.vendor_sku) AS sort_sku
    FROM products p
    LEFT JOIN categories c ON c.id = p.category_id
    LEFT JOIN brands b ON b.id = p.brand_id
    JOIN skus s ON s.product_id = p.id
    WHERE ${where}
    GROUP BY p.id, p.name, p.brand_id, b.name, live
    ORDER BY live DESC, min(s.vendor_sku)
  `, params);

  const todo = rows.filter(r => !state.products[r.id]).slice(0, LIMIT);
  console.log(`${rows.length} products in scope, ${todo.length} to process`);

  const counts = {};       // brand name → count (this run)
  let notFound = 0, noBrandRow = 0, updated = 0, unchanged = 0, errors = 0;
  let processed = 0;

  for (const prod of todo) {
    processed++;
    let parsed = null;
    let lastErr = null;
    // Try up to 2 vendor_skus (shortest first — most likely the base sku).
    for (const sku of prod.vendor_skus.slice(0, 2)) {
      try {
        parsed = await getOrFetchPage(sku);
        break;
      } catch (e) {
        lastErr = e.message;
        // Failures skip the post-fetch politeness delay — without a pause
        // here a run of errors hammers HR fast enough to trip their WAF
        // (observed as blanket search-http-404s).
        await sleep(pageDelayMinMs + Math.random() * pageDelayJitterMs);
      }
    }

    let entry;
    if (!parsed) {
      if (lastErr === 'no-redirect') { notFound++; entry = { status: 'not-found' }; }
      else { errors++; entry = { status: 'error', error: lastErr }; }
    } else if (!parsed.brand) {
      noBrandRow++;
      entry = { status: 'no-brand-row' };
    } else {
      const brand = parsed.brand;
      counts[brand] = (counts[brand] || 0) + 1;
      entry = { status: 'ok', brand };
      if (brand === prod.brand_name) {
        unchanged++;
      } else {
        const brandId = await ensureBrand(brand);
        if (!DRY_RUN) {
          await pool.query('UPDATE products SET brand_id = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [brandId, prod.id]);
        }
        updated++;
      }
    }

    state.products[prod.id] = entry;
    if (processed % STATE_SAVE_EVERY === 0) {
      saveState();
      console.log(`  [${processed}/${todo.length}] updated=${updated} unchanged=${unchanged} notFound=${notFound} noBrandRow=${noBrandRow} errors=${errors} | fetches=${totalPageFetches} cacheHits=${totalPageCacheHits + totalSearchCacheHits}`);
    }
  }

  saveState();

  console.log('\n==================== Summary ====================');
  console.log(`Processed:      ${processed}`);
  console.log(`Updated:        ${updated}${DRY_RUN ? ' (dry run — not written)' : ''}`);
  console.log(`Unchanged:      ${unchanged}`);
  console.log(`Not found:      ${notFound}`);
  console.log(`No brand row:   ${noBrandRow}`);
  console.log(`Errors:         ${errors}`);
  console.log(`Page fetches:   ${totalPageFetches} (cache hits: ${totalPageCacheHits + totalSearchCacheHits})`);
  console.log('Brand counts (this run):');
  for (const [b, n] of Object.entries(counts).sort((a, z) => z[1] - a[1])) {
    console.log(`  ${b}: ${n}`);
  }

  await pool.end();
}

main().catch(async (err) => {
  console.error('FATAL:', err);
  saveState();
  try { await pool.end(); } catch {}
  process.exit(1);
});
