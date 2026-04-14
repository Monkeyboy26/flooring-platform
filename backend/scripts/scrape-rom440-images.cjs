#!/usr/bin/env node

/**
 * ROM440 (Hardware Resources) — Variant-Safe Image Back-fill Scraper
 *
 * Populates media_assets rows for the ~9,935 ROM440 SKUs that are NOT
 * covered by Hardware_Resources_product_data_2026.xlsx (the xlsx-covered
 * 2,277 SKUs already have Salsify imagery in the DB — we DO NOT touch them).
 *
 * Source: hardwareresources.com (Magento 2 "Alpine" theme).
 *
 * Variant safety (the user's #1 concern):
 *   Two independent signals must agree before committing an image.
 *     GATE 1 (structural) — vendor_sku must appear in Magento's
 *       `swatchOptions.skus` map. This is the CMS's own variant-to-
 *       product-id binding; if a vendor_sku isn't in this map, the page
 *       doesn't actually represent that variant and we skip.
 *     GATE 2 (semantic)   — the image filename must literally contain
 *       the vendor_sku (case-insensitive). HR's CDN filenames encode
 *       the finish/species (e.g. "89101-DC_0_67a2e1.jpg"), so any image
 *       whose filename doesn't contain the expected sku is silently
 *       skipped and logged to mismatches.
 *   We NEVER fall back to the parent/config product image — a silently
 *   mis-assigned finish is worse than a missing image.
 *
 * Resume safety:
 *   - Skips SKUs that already have a media_assets row (NOT EXISTS guard).
 *   - Skips image files that already exist on disk (fs.access check).
 *   - INSERT uses ON CONFLICT DO NOTHING on the unique index.
 *   - Page cache dedupes HR fetches: typically 5-10 variants per product
 *     family share a single HR page.
 *
 * Pricing: this script does NOT write anything to the pricing table.
 * In particular, cut_price MUST remain NULL for ROM440 (prior regression).
 *
 * Usage:
 *   docker compose exec -T api node scripts/scrape-rom440-images.cjs [flags]
 *
 * Flags:
 *   --dry-run                    Parse + match, download/write nothing
 *   --limit=N                    Process only the first N SKUs
 *   --only=<vendorSku>           Target a single SKU (case-insensitive)
 *   --category="Decorative Hardware"
 *                                Only process SKUs whose product's master
 *                                class matches. Quote names with spaces.
 */

const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const { Pool } = require('pg');

// ==================== CLI ====================

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');

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
const ONLY = (parseStringFlag('--only=') || '').toUpperCase() || null;
const CATEGORY = parseStringFlag('--category=') || null;

// ==================== Config ====================

const UPLOADS_BASE = process.env.UPLOADS_PATH || '/app/uploads';
const ROM440_UPLOAD_DIR = path.join(UPLOADS_BASE, 'rom440');
const REPORT_DIR = path.join('/app/data', 'ROM440');

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const HR_BASE = 'https://www.hardwareresources.com';
const HR_REFERER = HR_BASE + '/';
const SEARCH_URL_BASE = HR_BASE + '/catalogsearch/result/?q=';

let pageDelayMinMs = 800;
let pageDelayJitterMs = 400;
const IMAGE_DOWNLOAD_CONCURRENCY = 3;
const HTTP_TIMEOUT_MS = 15000;   // was 30000 — fail fast on throttling
const RETRY_MAX = 2;             // was 4 — timeouts don't recover, skip faster
const COOLDOWN_BUMP_MS = 400;    // each retry globally raises base delay by this much
const COOLDOWN_MAX_MS = 5000;    // cap for pageDelayMinMs under sustained throttling

const REQUIRED_FREE_BYTES = 3 * 1024 * 1024 * 1024; // 3 GB

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

async function checkDiskSpace(p) {
  try {
    const stat = fs.statfsSync(p);
    return Number(stat.bavail) * Number(stat.bsize);
  } catch {
    return null; // statfsSync unavailable on some platforms
  }
}

// ==================== HTTP with retry + backoff ====================

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

// ==================== Balanced-brace JSON extractor ====================

/**
 * Given a big JSON-ish blob `src` and a key like `"skus":`, find the
 * opening `{` after the key and return the parsed object by walking
 * a balanced-brace scan that respects strings and escapes. This is
 * safer than a regex because the surrounding Magento swatchOptions
 * blob embeds `"attributes":"<table>...</table>"` and similar, which
 * contain unbalanced braces inside string literals.
 */
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

// ==================== Magento page parser ====================

function parseMagentoPage(html, canonicalUrl) {
  // ---- Configurable product path: swatchOptions with skus + images maps ----
  let skus = {};
  let images = {};

  const swatchIdx = html.indexOf('"swatchOptions"');
  if (swatchIdx !== -1) {
    const region = html.slice(swatchIdx, swatchIdx + 2_000_000); // cap slice
    skus = extractJsonObject(region, '"skus":');
    images = extractJsonObject(region, '"images":');
  }

  // ---- Simple product path: mage/gallery/gallery init with data array ----
  // For non-configurable products (sinks, grids, strainers, etc.) the image
  // set lives in a `"data":[{...}]` array inside a mage/gallery/gallery
  // `x-magento-init` block. There's no per-variant map — the page IS the
  // single-SKU product, so the only safety gate we have here is the URL
  // slug + filename check, applied at commit time by the worker loop.
  const simpleImages = [];
  const galleryIdx = html.indexOf('"mage/gallery/gallery"');
  if (galleryIdx !== -1) {
    const region = html.slice(galleryIdx, galleryIdx + 400_000);
    const dataStart = region.indexOf('"data":');
    if (dataStart !== -1) {
      // Walk to the opening '[' and do a balanced-bracket scan.
      let i = region.indexOf('[', dataStart);
      if (i !== -1) {
        const start = i;
        let depth = 0, inStr = false, esc = false;
        for (; i < region.length; i++) {
          const c = region[i];
          if (inStr) {
            if (esc) { esc = false; continue; }
            if (c === '\\') { esc = true; continue; }
            if (c === '"') { inStr = false; continue; }
            continue;
          }
          if (c === '"') { inStr = true; continue; }
          if (c === '[') depth++;
          else if (c === ']') { depth--; if (depth === 0) { i++; break; } }
        }
        try {
          const arr = JSON.parse(region.slice(start, i));
          if (Array.isArray(arr)) {
            for (const entry of arr) {
              if (entry && entry.type === 'image' && entry.full) {
                simpleImages.push({
                  full: entry.full,
                  isMain: !!entry.isMain,
                  position: entry.position,
                });
              }
            }
          }
        } catch { /* ignore — fall through to empty simpleImages */ }
      }
    }
  }

  // Optional spec PDFs from cpsdProducts.additional_lables.specifications.
  // These often embed an <a href="..."> or a raw URL. Keys are Magento
  // product IDs (same IDs used by the swatchOptions.skus map), so we
  // can key specPdfs by magento ID and join at commit time.
  const specPdfs = {};
  try {
    const cpsdIdx = html.indexOf('"cpsdProducts"');
    if (cpsdIdx !== -1) {
      const region = html.slice(cpsdIdx, cpsdIdx + 500_000);
      // Tiny ad-hoc walk: find each "<digits>":{...spec...} block.
      const idRe = /"(\d+)":\{/g;
      let m;
      while ((m = idRe.exec(region)) !== null) {
        const mid = m[1];
        const blockStart = m.index + m[0].length - 1; // points at '{'
        // Find balanced end of this block
        let depth = 0, i = blockStart, inStr = false, esc = false;
        for (; i < region.length; i++) {
          const c = region[i];
          if (inStr) {
            if (esc) { esc = false; continue; }
            if (c === '\\') { esc = true; continue; }
            if (c === '"') { inStr = false; continue; }
            continue;
          }
          if (c === '"') { inStr = true; continue; }
          if (c === '{') depth++;
          else if (c === '}') {
            depth--;
            if (depth === 0) { i++; break; }
          }
        }
        const block = region.slice(blockStart, i);
        const specRaw = block.match(/"specifications":"((?:[^"\\]|\\.)*)"/);
        if (!specRaw) continue;
        const decoded = specRaw[1].replace(/\\\//g, '/').replace(/\\"/g, '"');
        // Might be either a URL or an <a href="URL">...</a>
        let url = null;
        const hrefMatch = decoded.match(/href=(?:"|\\")([^"\\]+)(?:"|\\")/);
        if (hrefMatch) {
          url = hrefMatch[1];
        } else if (/^https?:\/\//i.test(decoded)) {
          url = decoded;
        } else if (decoded.startsWith('//')) {
          url = 'https:' + decoded;
        }
        // Normalize protocol-relative URLs from any source
        if (url && url.startsWith('//')) url = 'https:' + url;
        if (url) specPdfs[mid] = url;
      }
    }
  } catch { /* best effort */ }

  // ---- Simple product spec PDF fallback ----
  // For simple products the spec PDF is a plain HTML link:
  //   <td id="product-attribute-resources-specifications">
  //     <a href="//images.salsify.com/.../file.pdf" target="_blank">Specifications</a>
  //   </td>
  let simpleSpecPdf = null;
  try {
    const specIdx = html.indexOf('product-attribute-resources-specifications');
    if (specIdx !== -1) {
      const region = html.slice(specIdx, specIdx + 2000);
      const hrefMatch = region.match(/href="([^"]+\.pdf[^"]*)"/i);
      if (hrefMatch) {
        let u = hrefMatch[1];
        if (u.startsWith('//')) u = 'https:' + u;
        simpleSpecPdf = u;
      }
    }
  } catch {}

  return { canonicalUrl, skus, images, specPdfs, simpleImages, simpleSpecPdf };
}

// ==================== Page fetch with cache ====================

const pageCache = new Map();   // canonicalUrl → parsedPayload
const searchCache = new Map(); // vendor_sku (UPPER) → canonicalUrl | '__NOT_FOUND__'
let totalPageFetches = 0;
let totalPageCacheHits = 0;
let totalSearchCacheHits = 0;

/**
 * After we've parsed a page, remember every vendor_sku we saw on it so
 * future SKUs on the same family skip the HR /catalogsearch round-trip
 * entirely. For configurable products, the Magento skus map gives us
 * every variant on the page at once. For simple products, the slug in
 * the canonical URL is the SKU.
 */
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

  // Fast path 1: we previously discovered this SKU lives on a page we've
  // already parsed. Zero HTTP requests.
  if (searchCache.has(skuKey)) {
    const cached = searchCache.get(skuKey);
    if (cached === '__NOT_FOUND__') throw new Error('no-redirect');
    if (pageCache.has(cached)) {
      totalSearchCacheHits++;
      return pageCache.get(cached);
    }
    // Shouldn't happen (pageCache is the authoritative store), but
    // fall through to a fresh fetch if it does.
  }

  const searchUrl = SEARCH_URL_BASE + encodeURIComponent(vendorSku);
  let resp;
  try {
    resp = await fetchWithRetry(searchUrl, { redirect: 'follow' });
  } catch (e) {
    // Exhausted retries. Don't cache — HR may recover — but re-throw so
    // the worker loop records a notFound and moves on quickly.
    throw new Error(`fetch-exhausted: ${e.message}`);
  }
  if (!resp.ok) {
    throw new Error(`search-http-${resp.status}`);
  }
  const finalUrlRaw = resp.url || searchUrl;
  if (finalUrlRaw.includes('/catalogsearch/')) {
    try { await resp.text(); } catch {}
    searchCache.set(skuKey, '__NOT_FOUND__');
    throw new Error('no-redirect');
  }
  const canonicalUrl = finalUrlRaw.split('?')[0];

  // Fast path 2: the canonical URL was already parsed under a different
  // SKU query. Drain the response and reuse the cached parse.
  if (pageCache.has(canonicalUrl)) {
    try { await resp.text(); } catch {}
    totalPageCacheHits++;
    const parsed = pageCache.get(canonicalUrl);
    populateSearchCacheFromPage(parsed);
    return parsed;
  }

  const html = await resp.text();
  const parsed = parseMagentoPage(html, canonicalUrl);
  pageCache.set(canonicalUrl, parsed);
  populateSearchCacheFromPage(parsed);
  totalPageFetches++;
  // Rate limit: only sleep after a real fetch (not any cache hit).
  await sleep(pageDelayMinMs + Math.random() * pageDelayJitterMs);
  return parsed;
}

// ==================== Image download ====================

async function downloadImage(imageUrl, destPath) {
  try {
    await fs.promises.access(destPath);
    return 'already-exists';
  } catch { /* not present — proceed */ }

  try {
    await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
    const resp = await fetch(imageUrl, {
      headers: { 'User-Agent': USER_AGENT, 'Referer': HR_REFERER },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!resp.ok) return null;
    await pipeline(resp.body, fs.createWriteStream(destPath));
    return 'downloaded';
  } catch (e) {
    try { await fs.promises.unlink(destPath); } catch {}
    return null;
  }
}

// ==================== DB insert ====================

async function insertMediaAsset(productId, skuId, assetType, publicUrl, originalUrl, sortOrder) {
  await pool.query(
    `INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (product_id, sku_id, asset_type, sort_order) WHERE sku_id IS NOT NULL DO NOTHING`,
    [productId, skuId, assetType, publicUrl, originalUrl, sortOrder]
  );
}

// ==================== Main ====================

async function main() {
  const startTime = Date.now();

  logSection(`ROM440 Image Scraper — ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  console.log(`  UPLOADS_BASE:  ${UPLOADS_BASE}`);
  console.log(`  Target dir:    ${ROM440_UPLOAD_DIR}`);
  if (LIMIT !== Infinity) console.log(`  Limit:         ${LIMIT}`);
  if (ONLY) console.log(`  Only:          ${ONLY}`);
  if (CATEGORY) console.log(`  Category:      ${CATEGORY}`);

  // --- Preflight ---
  if (!DRY_RUN) {
    try {
      await fs.promises.mkdir(ROM440_UPLOAD_DIR, { recursive: true });
      // Write test
      const probe = path.join(ROM440_UPLOAD_DIR, '.write-probe');
      await fs.promises.writeFile(probe, 'ok');
      await fs.promises.unlink(probe);
    } catch (e) {
      console.error(`  ERROR: cannot write to ${ROM440_UPLOAD_DIR}: ${e.message}`);
      process.exit(1);
    }

    const free = await checkDiskSpace(UPLOADS_BASE);
    if (free !== null) {
      const freeGb = (free / 1024 / 1024 / 1024).toFixed(2);
      console.log(`  Free disk:     ${freeGb} GB`);
      if (free < REQUIRED_FREE_BYTES) {
        console.error(`  ERROR: less than 3 GB free — aborting.`);
        process.exit(1);
      }
    }
  }

  try {
    await pool.query('SELECT 1');
  } catch (e) {
    console.error(`  ERROR: database unreachable: ${e.message}`);
    process.exit(1);
  }

  // --- Phase 1: Work queue ---
  logSection('Phase 1: Loading work queue');

  const queueParams = [];
  let queueSql = `
    SELECT s.id AS sku_id,
           s.vendor_sku,
           s.variant_name,
           s.product_id,
           p.name AS product_name,
           c.name AS master_class
    FROM skus s
    JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id
    LEFT JOIN categories c ON c.id = p.category_id
    WHERE v.code = 'ROM440'
      AND NOT EXISTS (
        SELECT 1 FROM media_assets m WHERE m.sku_id = s.id
      )
  `;
  if (ONLY) {
    queueParams.push(ONLY);
    queueSql += ` AND UPPER(s.vendor_sku) = $${queueParams.length}`;
  }
  if (CATEGORY) {
    queueParams.push(CATEGORY);
    queueSql += ` AND c.name = $${queueParams.length}`;
  }
  queueSql += ` ORDER BY c.name NULLS LAST, s.vendor_sku`;
  if (LIMIT !== Infinity) {
    queueParams.push(LIMIT);
    queueSql += ` LIMIT $${queueParams.length}`;
  }

  const { rows: queue } = await pool.query(queueSql, queueParams);
  console.log(`  SKUs to process: ${queue.length}`);

  if (queue.length === 0) {
    console.log('\n  Nothing to do. All ROM440 SKUs in scope already have media.');
    await pool.end();
    return;
  }

  // --- Phase 2: Worker loop ---
  logSection('Phase 2: Scraping');

  const byClass = new Map(); // master_class → { processed, primary, alternate, spec, skipped }
  const notFound = [];
  const mismatches = [];       // filename HAS extension but doesn't contain vendor_sku (CRITICAL)
  const noExtSkipped = [];     // parent-image URLs with no file extension (expected)
  const imagesWritten = [];
  let httpImageDownloads = 0;
  let httpImageSkipped = 0;

  function bucket(cls) {
    const key = cls || '(uncategorized)';
    if (!byClass.has(key)) {
      byClass.set(key, { processed: 0, primary: 0, alternate: 0, spec: 0, skipped: 0 });
    }
    return byClass.get(key);
  }

  let i = 0;
  for (const sku of queue) {
    i++;
    const b = bucket(sku.master_class);
    b.processed++;

    if (i % 25 === 0 || i === 1) {
      const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(0);
      console.log(
        `  [${i}/${queue.length}] ${sku.vendor_sku.padEnd(16)} ${String(sku.master_class || '').padEnd(22)}` +
        `  pages=${totalPageFetches} pHits=${totalPageCacheHits} sHits=${totalSearchCacheHits}` +
        `  imgs=${imagesWritten.length}  ${elapsedSec}s`
      );
    }

    let parsed;
    try {
      parsed = await getOrFetchPage(sku.vendor_sku);
    } catch (e) {
      notFound.push({ sku: sku.vendor_sku, reason: e.message });
      b.skipped++;
      continue;
    }

    // Decide which product pattern the page uses.
    //
    //   Configurable product: swatchOptions.skus is a non-empty map of
    //     Magento_id → vendor_sku. We MUST find our vendor_sku in the map
    //     (GATE 1-config) or refuse the page.
    //
    //   Simple product: swatchOptions is absent. The page represents a
    //     single SKU, so GATE 1-simple is: the URL slug must equal the
    //     vendor_sku (case-insensitive). This prevents an accidental
    //     redirect to a different product from silently committing the
    //     wrong image.
    //
    // In both cases, GATE 2 (filename contains vendor_sku) is applied per
    // image at commit time.
    const targetSku = sku.vendor_sku.toUpperCase();
    const hasSwatch = parsed.skus && Object.keys(parsed.skus).length > 0;

    let magentoId = null;
    let variantImages = [];
    let specPdfUrl = null;

    if (hasSwatch) {
      // --- Configurable product path ---
      for (const [id, val] of Object.entries(parsed.skus)) {
        if (String(val).toUpperCase() === targetSku) { magentoId = id; break; }
      }
      if (!magentoId) {
        notFound.push({ sku: sku.vendor_sku, reason: 'not-in-skus-map', url: parsed.canonicalUrl });
        b.skipped++;
        continue;
      }
      variantImages = (parsed.images && parsed.images[magentoId]) || [];
      if (!variantImages.length) {
        notFound.push({ sku: sku.vendor_sku, reason: 'no-images-for-variant', url: parsed.canonicalUrl });
        b.skipped++;
        continue;
      }
      specPdfUrl = parsed.specPdfs && parsed.specPdfs[magentoId];
    } else {
      // --- Simple product path ---
      // GATE 1-simple: URL slug must match vendor_sku
      const slugMatch = parsed.canonicalUrl.match(/\/([^\/]+)\.html(?:$|\?|#)/);
      const slug = slugMatch ? slugMatch[1].toUpperCase() : null;
      if (!slug || slug !== targetSku) {
        notFound.push({
          sku: sku.vendor_sku,
          reason: 'slug-mismatch',
          url: parsed.canonicalUrl,
        });
        b.skipped++;
        continue;
      }
      if (!parsed.simpleImages || parsed.simpleImages.length === 0) {
        notFound.push({ sku: sku.vendor_sku, reason: 'no-gallery-data', url: parsed.canonicalUrl });
        b.skipped++;
        continue;
      }
      variantImages = parsed.simpleImages;
      specPdfUrl = parsed.simpleSpecPdf || null;
    }

    // Sort: main first, then by position
    const sorted = variantImages.slice().sort((a, b2) => {
      const aMain = a.isMain ? 1 : 0;
      const bMain = b2.isMain ? 1 : 0;
      if (aMain !== bMain) return bMain - aMain;
      return (parseInt(a.position, 10) || 0) - (parseInt(b2.position, 10) || 0);
    });

    // Stage downloads for this SKU, then run them concurrency-limited
    const downloadPlan = [];
    let primaryWritten = false;
    let alternateIndex = 0;
    let skippedForMismatch = 0;

    for (const img of sorted) {
      const fullUrl = img.full || img.medium || img.small || img.img;
      if (!fullUrl || typeof fullUrl !== 'string') continue;
      const fileMatch = fullUrl.match(/\/([^\/?#]+)\.(jpe?g|png|webp)(\?|#|$)/i);
      const filename = fileMatch ? fileMatch[1] : null;

      // GATE 2 — filename must literally contain the vendor_sku.
      // If there's no file extension at all, this is a hashed Magento
      // "base image" URL (shared parent-product asset) — not a variant
      // image and NOT a safety violation, just something we refuse to
      // commit. Track separately from true filename mismatches.
      if (!filename) {
        noExtSkipped.push({ sku: sku.vendor_sku, magentoId, url: fullUrl });
        skippedForMismatch++;
        continue;
      }
      if (!filename.toUpperCase().includes(targetSku)) {
        skippedForMismatch++;
        mismatches.push({ sku: sku.vendor_sku, magentoId, filename, url: fullUrl });
        continue;
      }

      const isMain = !!img.isMain;
      let assetType;
      let localFilename;
      let sortOrder;
      if (!primaryWritten && isMain) {
        assetType = 'primary';
        localFilename = 'primary.jpg';
        sortOrder = 0;
        primaryWritten = true;
      } else {
        assetType = 'alternate';
        localFilename = `alternate-${alternateIndex}.jpg`;
        sortOrder = alternateIndex + 1; // +1 to keep primary at 0
        alternateIndex++;
      }

      const localPath = path.join(ROM440_UPLOAD_DIR, sku.vendor_sku, localFilename);
      const publicUrl = `/uploads/rom440/${sku.vendor_sku}/${localFilename}`;
      downloadPlan.push({ fullUrl, localPath, publicUrl, assetType, sortOrder });
    }

    if (skippedForMismatch > 0) b.skipped += skippedForMismatch;

    if (downloadPlan.length === 0) {
      // Everything was filename-rejected → effectively not-found for this SKU
      notFound.push({ sku: sku.vendor_sku, reason: 'all-images-filtered-by-filename-check', url: parsed.canonicalUrl });
      continue;
    }

    // Execute downloads with small concurrency to keep HR happy
    for (let j = 0; j < downloadPlan.length; j += IMAGE_DOWNLOAD_CONCURRENCY) {
      const batch = downloadPlan.slice(j, j + IMAGE_DOWNLOAD_CONCURRENCY);
      await Promise.all(batch.map(async (d) => {
        if (DRY_RUN) {
          imagesWritten.push({ sku: sku.vendor_sku, type: d.assetType, localPath: d.localPath });
          if (d.assetType === 'primary') b.primary++; else b.alternate++;
          return;
        }
        const result = await downloadImage(d.fullUrl, d.localPath);
        if (!result) {
          return; // silent failure per-image; still try the others
        }
        if (result === 'downloaded') httpImageDownloads++;
        else httpImageSkipped++;
        try {
          await insertMediaAsset(
            sku.product_id,
            sku.sku_id,
            d.assetType,
            d.publicUrl,
            d.fullUrl,
            d.sortOrder
          );
          imagesWritten.push({ sku: sku.vendor_sku, type: d.assetType, localPath: d.localPath });
          if (d.assetType === 'primary') b.primary++; else b.alternate++;
        } catch (e) {
          console.warn(`  [db] insert failed ${sku.vendor_sku}/${d.assetType}: ${e.message}`);
        }
      }));
    }

    // Spec PDF (optional) — resolved per-path above
    const specUrl = specPdfUrl;
    if (specUrl) {
      if (DRY_RUN) {
        b.spec++;
      } else {
        try {
          await insertMediaAsset(sku.product_id, sku.sku_id, 'spec_pdf', specUrl, specUrl, 0);
          b.spec++;
        } catch (e) {
          console.warn(`  [db] spec_pdf insert failed ${sku.vendor_sku}: ${e.message}`);
        }
      }
    }
  }

  // --- Phase 7: Summary + report ---
  logSection('Summary');

  const elapsedMs = Date.now() - startTime;
  const totalPrimary = [...byClass.values()].reduce((s, b) => s + b.primary, 0);
  const totalAlternate = [...byClass.values()].reduce((s, b) => s + b.alternate, 0);
  const totalSpec = [...byClass.values()].reduce((s, b) => s + b.spec, 0);
  const totalProcessed = [...byClass.values()].reduce((s, b) => s + b.processed, 0);
  const totalSkipped = [...byClass.values()].reduce((s, b) => s + b.skipped, 0);

  console.log('  Master class breakdown:');
  for (const [cls, b] of [...byClass.entries()].sort()) {
    console.log(
      `    ${cls.padEnd(24)} ${String(b.processed).padStart(5)} processed` +
      `  ${String(b.primary).padStart(5)} primary` +
      `  ${String(b.alternate).padStart(5)} alternate` +
      `  ${String(b.spec).padStart(5)} spec_pdf` +
      `  ${String(b.skipped).padStart(5)} skipped`
    );
  }
  console.log('');
  console.log(`  SKUs processed:        ${totalProcessed}`);
  console.log(`  Primary images:        ${totalPrimary}`);
  console.log(`  Alternate images:      ${totalAlternate}`);
  console.log(`  Spec PDFs:             ${totalSpec}`);
  console.log(`  Not found on HR:       ${notFound.length}`);
  console.log(`  Filename mismatches:   ${mismatches.length}${mismatches.length > 0 ? '   ← CRITICAL: REVIEW' : ''}`);
  console.log(`  Parent-image skips:    ${noExtSkipped.length}  (hashed URLs w/o extension — expected)`);
  console.log(`  Unique HR pages:       ${pageCache.size}`);
  console.log(`  Total HR fetches:      ${totalPageFetches}`);
  console.log(`  Page cache hits:       ${totalPageCacheHits}  (canonical URL already parsed)`);
  console.log(`  Search cache hits:     ${totalSearchCacheHits}  (zero-HTTP dedupe)`);
  console.log(`  Image downloads:       ${httpImageDownloads} (${httpImageSkipped} already-on-disk)`);
  console.log(`  Elapsed:               ${(elapsedMs / 1000 / 60).toFixed(1)} min`);
  if (DRY_RUN) console.log('\n  DRY RUN — nothing was written to disk or DB.');

  // Persist report
  if (!DRY_RUN && (notFound.length || mismatches.length || imagesWritten.length)) {
    try {
      await fs.promises.mkdir(REPORT_DIR, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const reportPath = path.join(REPORT_DIR, `scrape-report-${ts}.json`);
      const report = {
        startedAt: new Date(startTime).toISOString(),
        finishedAt: new Date().toISOString(),
        elapsedMs,
        dryRun: DRY_RUN,
        filters: { LIMIT: LIMIT === Infinity ? null : LIMIT, ONLY, CATEGORY },
        totals: {
          processed: totalProcessed,
          primary: totalPrimary,
          alternate: totalAlternate,
          spec: totalSpec,
          notFound: notFound.length,
          mismatches: mismatches.length,
          skipped: totalSkipped,
          uniquePages: pageCache.size,
          pageFetches: totalPageFetches,
          pageCacheHits: totalPageCacheHits,
          imageDownloads: httpImageDownloads,
        },
        byClass: Object.fromEntries(byClass),
        notFound,
        mismatches,
      };
      await fs.promises.writeFile(reportPath, JSON.stringify(report, null, 2));
      console.log(`\n  Report: ${reportPath}`);

      if (mismatches.length) {
        const mmPath = path.join(REPORT_DIR, `mismatches-${ts}.txt`);
        await fs.promises.writeFile(
          mmPath,
          mismatches.map(m => `${m.sku}\t${m.magentoId}\t${m.filename || '(no-filename)'}\t${m.url}`).join('\n')
        );
        console.log(`  Mismatches: ${mmPath}`);
      }
      if (notFound.length) {
        const nfPath = path.join(REPORT_DIR, `not-found-${ts}.txt`);
        await fs.promises.writeFile(
          nfPath,
          notFound.map(n => `${n.sku}\t${n.reason}\t${n.url || ''}`).join('\n')
        );
        console.log(`  Not found:  ${nfPath}`);
      }
    } catch (e) {
      console.warn(`  [report] failed to write: ${e.message}`);
    }
  }

  await pool.end();
}

main().catch(async (err) => {
  console.error('\nFATAL:', err);
  try { await pool.end(); } catch {}
  process.exit(1);
});
