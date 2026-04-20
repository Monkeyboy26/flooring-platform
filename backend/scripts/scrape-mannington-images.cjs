#!/usr/bin/env node

/**
 * Mannington Website Image Scraper
 *
 * Scrapes mannington.com product detail pages for SKU images by extracting
 * structured JSON from Next.js __NEXT_DATA__.
 *
 * Advantage over the DAM scraper (scrape-mannington-dam.cjs):
 *   - No auth needed (public website)
 *   - Structured data (not filename-regex matching)
 *   - One page per pattern gives ALL sibling SKU images via collectionProducts
 *   - ~60 page fetches vs hundreds of DAM folder BFS pages
 *
 * Usage:
 *   docker compose exec api node scripts/scrape-mannington-images.cjs [flags]
 *
 * Flags:
 *   --dry-run          Scrape but don't write to DB
 *   --category=NAME    Only scrape one category (LVT, Hardwood, Laminate)
 *   --verbose          Print extra details
 */

const { Pool } = require('pg');

// ==================== CLI ====================

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const VERBOSE = args.includes('--verbose');

function parseStringFlag(prefix) {
  const a = args.find(x => x.startsWith(prefix));
  if (!a) return null;
  return a.slice(prefix.length).replace(/^"|"$/g, '').trim();
}

const CATEGORY_FILTER = (parseStringFlag('--category=') || '').toLowerCase() || null;

// ==================== Config ====================

const SITE_BASE = 'https://www.mannington.com';
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const REQUEST_DELAY_MS = 500;
const HTTP_TIMEOUT_MS = 15000;
const RETRY_MAX = 3;

// Category listing pages — each shows all patterns in that sub-line
// LVT pages have proper HTML product links; Hardwood/Laminate use compressed data
// (image URLs extracted directly from the compressed __NEXT_DATA__ products string)
const LISTING_PAGES = [
  { url: '/residential/products/luxury-vinyl/aduraapex',  category: 'LVT',      label: 'ADURA Apex' },
  { url: '/residential/products/luxury-vinyl/aduramax',   category: 'LVT',      label: 'ADURA Max' },
  { url: '/residential/products/luxury-vinyl/adurarigid', category: 'LVT',      label: 'ADURA Rigid' },
  { url: '/residential/products/luxury-vinyl/aduraflex',  category: 'LVT',      label: 'ADURA Flex' },
  { url: '/residential/products/luxury-vinyl',            category: 'LVT',      label: 'All LVT' },
  { url: '/residential/products/hardwood',                category: 'Hardwood', label: 'Hardwood' },
  { url: '/residential/products/laminate',                category: 'Laminate', label: 'Laminate' },
];

// Image type mapping: website imageProperty → DB asset_type + sort_order
// Used for product detail pages (__NEXT_DATA__ structured data)
// "Angle" = individual product photo → primary
// "Full"  = flat-lay pattern spread  → alternate
const IMAGE_TYPE_MAP = {
  angle:                    { asset_type: 'primary',   sort_order: 0 },
  full:                     { asset_type: 'alternate', sort_order: 1 },
  prop:                     { asset_type: 'alternate', sort_order: 2 },
  roomscene:                { asset_type: 'lifestyle', sort_order: 3 },
  'roomscene- horizontal':  { asset_type: 'lifestyle', sort_order: 3 },
  'roomscene- vertical':    { asset_type: 'lifestyle', sort_order: 3 },
  lifestyle:                { asset_type: 'lifestyle', sort_order: 3 },
  vignette:                 { asset_type: 'lifestyle', sort_order: 4 },
  swatch:                   { asset_type: 'swatch',    sort_order: 5 },
  social:                   { asset_type: 'alternate', sort_order: 6 },
  other:                    { asset_type: 'alternate', sort_order: 6 },
};

// Filename-based image type mapping: used when extracting from compressed listing
// data where filenames follow DAM convention: {sku}-{type}-{rest}.jpeg
const FILENAME_TYPE_MAP = {
  angle:    { asset_type: 'primary',   sort_order: 0 },
  angleh:   { asset_type: 'primary',   sort_order: 0 },
  full:     { asset_type: 'alternate', sort_order: 1 },
  fullprop: { asset_type: 'alternate', sort_order: 1 },
  prop:     { asset_type: 'alternate', sort_order: 2 },
  detail:   { asset_type: 'alternate', sort_order: 2 },
  rs:       { asset_type: 'lifestyle', sort_order: 3 },
  rs1:      { asset_type: 'lifestyle', sort_order: 3 },
  rs2:      { asset_type: 'lifestyle', sort_order: 3 },
  rsh:      { asset_type: 'lifestyle', sort_order: 3 },
  rsv:      { asset_type: 'lifestyle', sort_order: 3 },
  lifestyle:{ asset_type: 'lifestyle', sort_order: 3 },
  swatch:   { asset_type: 'swatch',    sort_order: 4 },
  vg:       { asset_type: 'lifestyle', sort_order: 4 },
  vg1:      { asset_type: 'lifestyle', sort_order: 4 },
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

function logSection(title) {
  console.log('\n' + '='.repeat(68));
  console.log('  ' + title);
  console.log('='.repeat(68));
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
      console.warn(`  [rate-limit] ${resp.status} on ${url} — waiting ${Math.round(backoff)}ms`);
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
      console.warn(`  [retry] ${e.message} — attempt ${attempt + 1}/${RETRY_MAX}`);
      await sleep(backoff);
      return fetchPage(url, attempt + 1);
    }
    throw e;
  }
}

// ==================== __NEXT_DATA__ Extraction ====================

function extractNextData(html) {
  const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

// ==================== SKU Lookup ====================

async function buildSkuLookup() {
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
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return map;
}

// ==================== Phase 2: Discover Product URLs ====================

/**
 * Fetch each category listing page and extract links to product detail pages.
 * Group by pattern slug, keeping one URL per pattern (since collectionProducts
 * on a single detail page gives us images for ALL sibling SKUs).
 */
async function discoverProductUrls(listings) {
  const patterns = new Map(); // patternKey → { url, category, pattern }

  for (const listing of listings) {
    console.log(`  Fetching ${listing.label} (${listing.url})...`);

    let html;
    try {
      html = await fetchPage(SITE_BASE + listing.url);
    } catch (e) {
      console.warn(`    [error] Failed to fetch listing: ${e.message}`);
      continue;
    }

    let linksFound = 0;

    // Strategy 1: Parse __NEXT_DATA__ for structured product list
    const nextData = extractNextData(html);
    if (nextData) {
      const pageProps = nextData?.props?.pageProps || {};
      // Walk common pageProps shapes to find product arrays
      const candidates = [
        pageProps.products,
        pageProps.collection?.products,
        pageProps.productLine?.products,
        pageProps.data?.products,
      ];
      for (const products of candidates) {
        if (!Array.isArray(products)) continue;
        for (const p of products) {
          const url = p.url || p.path || p.href || p.slug;
          if (!url || typeof url !== 'string') continue;
          // Ensure it looks like a product URL (has enough depth)
          if (!url.includes('/residential/products/') && !url.startsWith('/')) continue;
          const fullUrl = url.startsWith('http') ? new URL(url).pathname : url;
          const segments = fullUrl.split('/').filter(Boolean);
          if (segments.length < 5) continue;
          const patternSlug = segments[segments.length - 2];
          const patternKey = `${listing.category}:${patternSlug}`;
          if (!patterns.has(patternKey)) {
            patterns.set(patternKey, { url: fullUrl, category: listing.category, pattern: patternSlug });
            linksFound++;
          }
        }
      }
    }

    // Strategy 2: Extract product detail links from HTML href attributes
    // Product detail URL pattern: /residential/products/.../{pattern-slug}/{sku-code}
    const linkRe = /href="(\/residential\/products\/[^"]+)"/g;
    let match;
    while ((match = linkRe.exec(html)) !== null) {
      const path = match[1];
      const segments = path.split('/').filter(Boolean);

      // Product detail URLs have at least 5 segments and end with a SKU code
      if (segments.length < 5) continue;
      const lastSeg = segments[segments.length - 1];
      if (!lastSeg || lastSeg.length < 3) continue;

      // Skip if last segment is a known sub-category (not a product SKU)
      if (/^(luxury-vinyl|adura[\w-]*|hardwood|laminate|all|products)$/i.test(lastSeg)) continue;

      const patternSlug = segments[segments.length - 2];
      if (!patternSlug) continue;

      const patternKey = `${listing.category}:${patternSlug}`;
      if (!patterns.has(patternKey)) {
        patterns.set(patternKey, { url: path, category: listing.category, pattern: patternSlug });
        linksFound++;
      }
    }

    console.log(`    Found ${linksFound} new pattern URLs`);
    await sleep(REQUEST_DELAY_MS);
  }

  return patterns;
}

// ==================== Phase 3: Scrape Product Pages ====================

/**
 * Extract images for all SKUs from a product detail page's __NEXT_DATA__.
 *
 * Navigates: props.pageProps.product + product.collectionProducts[]
 * Each product has pimcoreData.image[] with imageProperty labels and CDN URLs.
 *
 * Returns: [{ vendorSku, images: [{ asset_type, sort_order, url, originalUrl }] }]
 */
function extractSkuImages(nextData) {
  const pageProps = nextData?.props?.pageProps || {};
  const product = pageProps.product || pageProps.productData || {};
  const results = [];

  // Process main product + all collectionProducts (sibling SKUs)
  const allProducts = [product, ...(product.collectionProducts || [])];

  for (const p of allProducts) {
    if (!p || typeof p !== 'object') continue;

    // Vendor SKU — try multiple field names that Mannington's Next.js app might use
    const vendorSku = p.itemNumber || p.skuNumber || p.colorNumber ||
                      p.number || p.sku || '';
    if (!vendorSku || typeof vendorSku !== 'string') continue;

    // Images from pimcoreData.image[]
    const images = p.pimcoreData?.image || p.images || [];
    if (!Array.isArray(images) || images.length === 0) continue;

    const mapped = [];
    for (const img of images) {
      const typeName = (img.imageProperty || img.type || '').toLowerCase();
      const mapping = IMAGE_TYPE_MAP[typeName];
      if (!mapping) {
        if (VERBOSE && typeName) {
          console.log(`      [skip-type] Unknown image type "${typeName}" for ${vendorSku}`);
        }
        continue;
      }

      // Actual mannington.com structure: img.image (CDN URL), img.highResolutionImage (hi-res)
      const url = img.image ||
                  img.transformedImages?.jpeg ||
                  img.url || null;
      const originalUrl = img.highResolutionImage || img.originalImage || null;

      if (!url) continue;

      mapped.push({
        asset_type: mapping.asset_type,
        sort_order: mapping.sort_order,
        url,
        originalUrl,
      });
    }

    if (mapped.length > 0) {
      results.push({ vendorSku: vendorSku.toUpperCase(), images: mapped });
    }
  }

  return results;
}

// ==================== Compressed Data Extraction (Hardwood/Laminate) ====================

/**
 * Extract SKU images from the compressed products string on listing pages.
 *
 * Hardwood and Laminate listing pages use a tokenized encoding where field names
 * are replaced with short references after the first occurrence. Image URLs however
 * remain as full URLs in the string, following DAM filename conventions:
 *   {sku}-{type}-{pattern}-{color}.jpeg (TransformedImages)
 *   {sku}-{type}-{pattern}-{color}.tif  (originals in DAM)
 *
 * Strategy: Extract all JPEG and TIF URLs, parse filenames for SKU + type,
 * pair them by matching sku+type, and group by SKU.
 */
function extractImagesFromCompressedData(productsStr, skuLookup) {
  if (!productsStr || typeof productsStr !== 'string') return [];

  // Extract TransformedImages JPEG URLs
  const jpegRe = /https?:\/\/manningtonprod\.pimcoreclient\.com\/TransformedImages\/([^\u00a8\s"]+\.jpe?g)/gi;
  const jpegs = [];
  let m;
  while ((m = jpegRe.exec(productsStr)) !== null) {
    jpegs.push({ url: m[0], filename: m[1] });
  }

  // Extract TIF URLs (originals)
  const tifRe = /https?:\/\/manningtonprod\.pimcoreclient\.com\/Mannington\/[^\u00a8\s"]+\.tif/gi;
  const tifs = [];
  while ((m = tifRe.exec(productsStr)) !== null) {
    tifs.push(m[0]);
  }

  // Build TIF lookup: key = lowercase({sku}-{type}) → URL
  const tifLookup = new Map();
  for (const tifUrl of tifs) {
    const fname = decodeURIComponent(tifUrl.split('/').pop().replace(/\.tif$/i, ''));
    const parts = fname.split('-');
    if (parts.length >= 2) {
      const key = (parts[0] + '-' + parts[1]).toLowerCase();
      tifLookup.set(key, tifUrl);
    }
  }

  // Process JPEG URLs → group by SKU code
  const bySkuCode = new Map(); // vendorSku → [{ asset_type, sort_order, url, originalUrl }]

  // Known image type tokens for detecting compound filenames
  const KNOWN_TYPES = new Set(Object.keys(FILENAME_TYPE_MAP));

  for (const { url, filename } of jpegs) {
    const stem = filename.replace(/\.jpe?g$/i, '');
    const parts = stem.split('-');
    if (parts.length < 2) continue;

    let skuCodes = [];   // one or two SKU codes to associate
    let typeToken;
    let tifKeyPrefix;

    const part0 = parts[0].toUpperCase();
    const part1lower = parts[1].toLowerCase();

    // Skip if first part looks like a keyword, not a SKU code
    if (part0.length < 3) continue;
    if (/^(full|angle|prop|rs|rsh|rsv|swatch|vg)$/i.test(part0)) continue;

    if (KNOWN_TYPES.has(part1lower)) {
      // Normal filename: {sku}-{type}-{pattern}-{color}.jpeg
      skuCodes = [part0];
      typeToken = part1lower;
      tifKeyPrefix = parts[0] + '-' + parts[1];
    } else if (parts.length >= 3 && KNOWN_TYPES.has(parts[2].toLowerCase())) {
      // Compound filename: {sku1}-{sku2}-{type}-{pattern}-{color}.jpeg
      // e.g. rsp110-app301-full-heartwood-ridge.jpeg
      const part1upper = parts[1].toUpperCase();
      if (part1upper.length >= 3 && !/^(full|angle|prop|rs|rsh|rsv|swatch|vg)$/i.test(part1upper)) {
        skuCodes = [part0, part1upper];
        typeToken = parts[2].toLowerCase();
        tifKeyPrefix = parts[0] + '-' + parts[1] + '-' + parts[2];
      } else {
        continue;
      }
    } else {
      // Unrecognized format — skip
      if (VERBOSE) console.log(`    [skip-type] Filename type "${part1lower}" for ${part0}`);
      continue;
    }

    // Filter to SKU codes that exist in our DB (with fuzzy fallback)
    const matchedCodes = [];
    for (const c of skuCodes) {
      if (skuLookup.has(c)) {
        matchedCodes.push(c);
      } else {
        // Fuzzy: try inserting 'F' before trailing digits (e.g., HPLS37APN1 → HPLS37APNF1)
        const fuzzy = c.replace(/(\D)(\d+)$/, '$1F$2');
        if (fuzzy !== c && skuLookup.has(fuzzy)) {
          matchedCodes.push(fuzzy);
          if (VERBOSE) console.log(`    [fuzzy] ${c} → ${fuzzy}`);
        }
      }
    }
    if (matchedCodes.length === 0) continue;

    const mapping = FILENAME_TYPE_MAP[typeToken];
    if (!mapping) continue;

    // Find matching TIF as original URL
    const originalUrl = tifLookup.get(tifKeyPrefix.toLowerCase()) || null;

    for (const skuCode of matchedCodes) {
      if (!bySkuCode.has(skuCode)) bySkuCode.set(skuCode, []);
      bySkuCode.get(skuCode).push({
        asset_type: mapping.asset_type,
        sort_order: mapping.sort_order,
        url,
        originalUrl,
      });
    }
  }

  // Convert to the same format as extractSkuImages
  const results = [];
  for (const [vendorSku, images] of bySkuCode) {
    // Deduplicate by url
    const seen = new Set();
    const deduped = images.filter(img => {
      if (seen.has(img.url)) return false;
      seen.add(img.url);
      return true;
    });
    results.push({ vendorSku, images: deduped });
  }

  return results;
}

// ==================== Main ====================

async function main() {
  const startTime = Date.now();

  logSection(`Mannington Website Image Scraper — ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  if (CATEGORY_FILTER) console.log(`  Category:  ${CATEGORY_FILTER}`);
  if (VERBOSE) console.log(`  Verbose:   on`);

  // Preflight DB check
  try {
    await pool.query('SELECT 1');
  } catch (e) {
    console.error(`  ERROR: database unreachable: ${e.message}`);
    process.exit(1);
  }

  // ---- Phase 1: Build SKU lookup ----
  logSection('Phase 1: Building SKU lookup');

  const skuLookup = await buildSkuLookup();
  const totalSkus = [...skuLookup.values()].reduce((s, arr) => s + arr.length, 0);
  console.log(`  Loaded ${totalSkus} active Mannington SKUs (${skuLookup.size} unique vendor_sku codes)`);

  const { rows: [{ count: existingCount }] } = await pool.query(`
    SELECT COUNT(*) FROM media_assets ma
    JOIN products p ON p.id = ma.product_id
    JOIN vendors v ON v.id = p.vendor_id
    WHERE v.code = 'MANNINGTON'
  `);
  console.log(`  Existing media_assets for Mannington: ${existingCount}`);

  // ---- Phase 2: Fetch listing pages + discover product URLs ----
  logSection('Phase 2: Fetching listing pages');

  const listingsToScrape = CATEGORY_FILTER
    ? LISTING_PAGES.filter(l => l.category.toLowerCase() === CATEGORY_FILTER)
    : LISTING_PAGES;

  if (listingsToScrape.length === 0) {
    console.error(`  ERROR: no category matches "${CATEGORY_FILTER}". Valid: LVT, Hardwood, Laminate`);
    process.exit(1);
  }

  // Fetch all listing pages and separate into two groups:
  //  1. Pages with product detail links → visit individual pages (LVT)
  //  2. Pages with compressed data → extract image URLs directly (Hardwood/Laminate)
  const productUrls = new Map();     // patternKey → { url, category }
  const compressedListings = [];     // { html, nextData, category, label }

  for (const listing of listingsToScrape) {
    console.log(`  Fetching ${listing.label} (${listing.url})...`);

    let html;
    try {
      html = await fetchPage(SITE_BASE + listing.url);
    } catch (e) {
      console.warn(`    [error] Failed to fetch listing: ${e.message}`);
      continue;
    }

    // Try to extract product detail links from HTML
    let linksFound = 0;
    const nextData = extractNextData(html);

    // Strategy 1: Parse __NEXT_DATA__ for structured product list
    if (nextData) {
      const pageProps = nextData?.props?.pageProps || {};
      const candidates = [
        pageProps.products,
        pageProps.collection?.products,
        pageProps.productLine?.products,
        pageProps.data?.products,
      ];
      for (const products of candidates) {
        if (!Array.isArray(products)) continue;
        for (const p of products) {
          const url = p.url || p.path || p.href || p.slug;
          if (!url || typeof url !== 'string') continue;
          if (!url.includes('/residential/products/') && !url.startsWith('/')) continue;
          const fullUrl = url.startsWith('http') ? new URL(url).pathname : url;
          const segments = fullUrl.split('/').filter(Boolean);
          if (segments.length < 5) continue;
          const patternSlug = segments[segments.length - 2];
          const patternKey = `${listing.category}:${patternSlug}`;
          if (!productUrls.has(patternKey)) {
            productUrls.set(patternKey, { url: fullUrl, category: listing.category, pattern: patternSlug });
            linksFound++;
          }
        }
      }
    }

    // Strategy 2: Extract product detail links from HTML
    const linkRe = /href="(\/residential\/products\/[^"]+)"/g;
    let match;
    while ((match = linkRe.exec(html)) !== null) {
      const path = match[1];
      const segments = path.split('/').filter(Boolean);
      if (segments.length < 5) continue;
      const lastSeg = segments[segments.length - 1];
      if (!lastSeg || lastSeg.length < 3) continue;
      if (/^(luxury-vinyl|adura[\w-]*|hardwood|laminate|all|products)$/i.test(lastSeg)) continue;
      const patternSlug = segments[segments.length - 2];
      if (!patternSlug) continue;
      const patternKey = `${listing.category}:${patternSlug}`;
      if (!productUrls.has(patternKey)) {
        productUrls.set(patternKey, { url: path, category: listing.category, pattern: patternSlug });
        linksFound++;
      }
    }

    // If no product links found but page has compressed products data, save for
    // direct image extraction (Hardwood/Laminate pages use this format)
    if (linksFound === 0 && nextData) {
      const productsStr = nextData?.props?.pageProps?.products;
      if (typeof productsStr === 'string' && productsStr.length > 1000) {
        compressedListings.push({
          productsStr,
          category: listing.category,
          label: listing.label,
        });
        console.log(`    Using compressed data extraction (${(productsStr.length / 1024).toFixed(0)}KB)`);
      } else {
        console.log(`    No product links or data found`);
      }
    } else {
      console.log(`    Found ${linksFound} product pattern URLs`);
    }

    await sleep(REQUEST_DELAY_MS);
  }

  console.log(`\n  Product detail URLs: ${productUrls.size} patterns`);
  console.log(`  Compressed listings: ${compressedListings.length} (${compressedListings.map(c => c.label).join(', ') || 'none'})`);

  if (productUrls.size === 0 && compressedListings.length === 0) {
    console.error('  ERROR: no product data discovered — check if mannington.com structure changed');
    await pool.end();
    process.exit(1);
  }

  if (VERBOSE) {
    for (const [key, { url }] of productUrls) {
      console.log(`    ${key} → ${url}`);
    }
  }

  // ---- Phase 3a: Scrape product detail pages (LVT) ----
  const allSkuImages = [];
  const pagesScraped = { success: 0, failed: 0, noData: 0 };

  if (productUrls.size > 0) {
    logSection('Phase 3a: Scraping product detail pages');

    let firstPageData = null;
    let idx = 0;

    for (const [patternKey, { url }] of productUrls) {
      idx++;
      const progress = `[${idx}/${productUrls.size}]`;

      let html;
      try {
        html = await fetchPage(SITE_BASE + url);
      } catch (e) {
        console.warn(`  ${progress} ${patternKey}: FAILED — ${e.message}`);
        pagesScraped.failed++;
        continue;
      }

      const nextData = extractNextData(html);
      if (!nextData) {
        if (VERBOSE) console.log(`  ${progress} ${patternKey}: no __NEXT_DATA__`);
        pagesScraped.noData++;
        await sleep(REQUEST_DELAY_MS);
        continue;
      }

      // On first success, dump product shape for debugging
      if (!firstPageData && VERBOSE) {
        const product = nextData?.props?.pageProps?.product;
        if (product) {
          firstPageData = true;
          console.log(`\n  [debug] Product keys: ${Object.keys(product).join(', ')}`);
          const firstImg = product.pimcoreData?.image?.[0];
          if (firstImg) {
            console.log(`  [debug] Image keys: ${Object.keys(firstImg).join(', ')}`);
            console.log(`  [debug] imageProperty: ${firstImg.imageProperty}`);
          }
          for (const k of ['sku', 'itemNumber', 'skuNumber', 'colorNumber', 'number']) {
            if (product[k]) { console.log(`  [debug] SKU field: ${k} = ${product[k]}`); break; }
          }
          console.log('');
        }
      }

      const skuImages = extractSkuImages(nextData);
      if (skuImages.length === 0) {
        if (VERBOSE) console.log(`  ${progress} ${patternKey}: no images extracted`);
        pagesScraped.noData++;
        await sleep(REQUEST_DELAY_MS);
        continue;
      }

      // Tag as detail page source (structured data — reliable SKU-to-image mapping)
      for (const entry of skuImages) entry.source = 'detail';
      allSkuImages.push(...skuImages);
      pagesScraped.success++;

      if (VERBOSE) {
        console.log(`  ${progress} ${patternKey}: ${skuImages.length} SKUs, ${skuImages.reduce((s, e) => s + e.images.length, 0)} images`);
      } else if (idx % 10 === 0) {
        console.log(`  ${progress} ${pagesScraped.success} pages scraped so far...`);
      }

      await sleep(REQUEST_DELAY_MS);
    }

    console.log(`\n  Detail pages: ${pagesScraped.success} success, ${pagesScraped.failed} failed, ${pagesScraped.noData} no data`);
  }

  // ---- Phase 3b: Extract images from compressed listings (Hardwood/Laminate) ----
  if (compressedListings.length > 0) {
    logSection('Phase 3b: Extracting images from compressed listing data');

    for (const { productsStr, category, label } of compressedListings) {
      const extracted = extractImagesFromCompressedData(productsStr, skuLookup);
      const totalImages = extracted.reduce((s, e) => s + e.images.length, 0);
      console.log(`  ${label}: ${extracted.length} SKUs, ${totalImages} images extracted`);
      // Tag as compressed source (filename-based — SKU codes in filenames can be wrong)
      for (const entry of extracted) entry.source = 'compressed';
      allSkuImages.push(...extracted);
    }
  }

  console.log(`\n  Total SKU image sets collected: ${allSkuImages.length}`);

  // Build set of vendorSkus that came from detail pages (structured data — reliable)
  // Detail page entries were pushed first (before compressed data entries)
  const detailPageSkus = new Set();
  for (const entry of allSkuImages) {
    if (entry.source === 'detail') detailPageSkus.add(entry.vendorSku);
  }

  // Deduplicate by vendorSku — detail page data always wins over compressed data
  // (compressed filenames can have swapped/incorrect SKU codes)
  const deduped = new Map();
  for (const entry of allSkuImages) {
    const existing = deduped.get(entry.vendorSku);
    if (!existing) {
      deduped.set(entry.vendorSku, entry);
    } else if (entry.source === 'detail') {
      // Detail page always overwrites compressed
      if (existing.source !== 'detail' || entry.images.length > existing.images.length) {
        deduped.set(entry.vendorSku, entry);
      }
    } else {
      // Compressed data: only use if no detail page data exists and has more images
      if (existing.source !== 'detail' && entry.images.length > existing.images.length) {
        deduped.set(entry.vendorSku, entry);
      }
    }
  }
  console.log(`  Unique vendor SKUs with images: ${deduped.size} (${detailPageSkus.size} from detail pages)`);

  // ---- Phase 3c: Fix cross-color image assignments ----
  // Some Mannington products have images assigned to the wrong color variant.
  // This handles arbitrary misassignment patterns including 2-way swaps, 3-way
  // rotations, and mixed cases. Strategy: pool ALL non-swatch images from the
  // product group, classify each by which color appears in the filename, then
  // redistribute to the correct SKU.
  logSection('Phase 3c: Cross-color image validation');

  let crossColorFixes = 0;
  // Group deduped entries by product_id
  const byProduct = new Map();
  for (const [vendorSku, entry] of deduped) {
    const skuEntries = skuLookup.get(vendorSku);
    if (!skuEntries || skuEntries.length === 0) continue;
    const sku = skuEntries.find(s => s.variant_type !== 'accessory') || skuEntries[0];
    const pid = sku.product_id;
    if (!byProduct.has(pid)) byProduct.set(pid, []);
    byProduct.get(pid).push({ vendorSku, variantName: sku.variant_name, entry });
  }

  function colorSlug(name) {
    return (name || '').toLowerCase().replace(/[^a-z]/g, '');
  }

  for (const [pid, group] of byProduct) {
    if (group.length < 2) continue;
    const colorNames = [...new Set(group.map(g => g.variantName).filter(Boolean))];
    if (colorNames.length < 2) continue;

    // Build color slugs (skip short ones that cause false matches)
    const colorSlugs = colorNames
      .map(cn => ({ name: cn, slug: colorSlug(cn) }))
      .filter(c => c.slug.length >= 4);
    if (colorSlugs.length < 2) continue;

    // Check if any SKU in this group has misassigned images
    let hasMismatch = false;
    for (const item of group) {
      const nonSwatch = item.entry.images.filter(i => i.asset_type !== 'swatch');
      if (nonSwatch.length === 0) continue;
      const mySlug = colorSlug(item.variantName);
      if (mySlug.length < 3) continue;

      for (const c of colorSlugs) {
        if (c.name === item.variantName) continue;
        const wrongCount = nonSwatch.filter(img => {
          const fn = (img.url || '').split('/').pop().toLowerCase().replace(/[_-]/g, '');
          return fn.includes(c.slug) && !fn.includes(mySlug);
        }).length;
        if (wrongCount > 0 && wrongCount >= nonSwatch.length / 2) {
          hasMismatch = true;
          break;
        }
      }
      if (hasMismatch) break;
    }

    if (!hasMismatch) continue;

    // Pool all non-swatch images from the group
    const pool = []; // { img, fromVendorSku }
    for (const item of group) {
      for (const img of item.entry.images) {
        if (img.asset_type !== 'swatch') {
          pool.push({ img, fromVendorSku: item.vendorSku });
        }
      }
    }

    // Classify each pooled image by which color the filename matches
    const buckets = new Map(); // colorName → [img]
    const unclassified = [];
    for (const { img } of pool) {
      const fn = (img.url || '').split('/').pop().toLowerCase().replace(/[_-]/g, '');
      let matched = null;
      for (const c of colorSlugs) {
        if (fn.includes(c.slug)) {
          // If multiple colors match, pick the longest slug (most specific)
          if (!matched || c.slug.length > matched.slug.length) matched = c;
        }
      }
      if (matched) {
        if (!buckets.has(matched.name)) buckets.set(matched.name, []);
        buckets.get(matched.name).push(img);
      } else {
        unclassified.push(img);
      }
    }

    // Redistribute: give each SKU the images matching its color
    for (const item of group) {
      const correctImages = buckets.get(item.variantName) || [];
      if (correctImages.length === 0) continue;

      const mySwatch = item.entry.images.filter(i => i.asset_type === 'swatch');
      const oldNonSwatch = item.entry.images.filter(i => i.asset_type !== 'swatch');

      // Only change if the assignment actually differs
      const oldUrls = new Set(oldNonSwatch.map(i => i.url));
      const newUrls = new Set(correctImages.map(i => i.url));
      const changed = oldUrls.size !== newUrls.size || [...oldUrls].some(u => !newUrls.has(u));

      if (changed) {
        if (VERBOSE) console.log(`  [cross-color] ${item.vendorSku} (${item.variantName}): reassigned ${correctImages.length} images (was ${oldNonSwatch.length})`);
        item.entry.images = [...correctImages, ...mySwatch];
        crossColorFixes++;
      }
    }

    // Give unclassified images (no color in filename) to all SKUs in the group
    if (unclassified.length > 0 && VERBOSE) {
      console.log(`  [cross-color] Product ${pid}: ${unclassified.length} images unclassified (shared across group)`);
    }
  }
  console.log(`  Cross-color fixes: ${crossColorFixes}`);

  // ---- Phase 3d: SKU-code prefix validation ----
  // Some images have the correct color name in the filename but the WRONG vendor
  // SKU code prefix (e.g., FXT361-RS-Corinthia-Amber.jpeg on FXT360/Amber).
  // The image physically shows the wrong product. Detect this by checking if
  // non-swatch filenames start with a sibling's vendor SKU and move accordingly.
  logSection('Phase 3d: SKU-code prefix validation');

  let skuPrefixFixes = 0;
  for (const [pid, group] of byProduct) {
    if (group.length < 2) continue;

    // Build a set of vendor SKU codes in this product group (lowercased)
    const groupSkuCodes = new Map(); // lowercase code → vendorSku
    for (const item of group) {
      groupSkuCodes.set(item.vendorSku.toLowerCase(), item.vendorSku);
    }

    for (const item of group) {
      const myCodeLower = item.vendorSku.toLowerCase();
      const toRemove = [];
      const nonSwatch = item.entry.images.filter(i => i.asset_type !== 'swatch');

      for (const img of nonSwatch) {
        const fn = (img.url || '').split('/').pop().toLowerCase();
        // Check if filename starts with a DIFFERENT sibling's SKU code
        for (const [sibCode, sibVendorSku] of groupSkuCodes) {
          if (sibCode === myCodeLower) continue;
          if (fn.startsWith(sibCode + '-') || fn.startsWith(sibCode + '_')) {
            // This image belongs to the sibling, not this SKU
            toRemove.push(img);
            // Add it to the sibling's images if not already there
            const sibItem = group.find(g => g.vendorSku === sibVendorSku);
            if (sibItem) {
              const sibUrls = new Set(sibItem.entry.images.map(i => i.url));
              if (!sibUrls.has(img.url)) {
                sibItem.entry.images.push(img);
              }
            }
            if (VERBOSE) console.log(`  [sku-prefix] ${item.vendorSku}: ${fn} starts with ${sibVendorSku} → moved`);
            break;
          }
        }
      }

      if (toRemove.length > 0) {
        const removeUrls = new Set(toRemove.map(i => i.url));
        item.entry.images = item.entry.images.filter(i => !removeUrls.has(i.url));
        skuPrefixFixes++;
      }
    }
  }
  console.log(`  SKU-prefix fixes: ${skuPrefixFixes}`);

  // ---- Phase 4: Match + Insert ----
  logSection('Phase 4: Matching and inserting images');

  const stats = {
    matched: 0,
    unmatched: 0,
    skusUpdated: 0,
    imagesInserted: 0,
    imagesDeleted: 0,
    errors: 0,
  };

  const unmatchedCodes = [];

  for (const [vendorSku, entry] of deduped) {
    const skuEntries = skuLookup.get(vendorSku);
    if (!skuEntries || skuEntries.length === 0) {
      stats.unmatched++;
      unmatchedCodes.push(vendorSku);
      continue;
    }

    stats.matched++;

    // Insert images for each matching non-accessory SKU
    const flooringSkus = skuEntries.filter(s => s.variant_type !== 'accessory');
    if (flooringSkus.length === 0) continue;

    // Reassign sort_orders to be unique per (asset_type).
    // The unique constraint is (product_id, sku_id, asset_type, sort_order),
    // so two images of the same asset_type need different sort_orders.
    // Sort by the original sort_order hint, then assign incrementing values.
    const images = [...entry.images].sort((a, b) => a.sort_order - b.sort_order);
    const typeCounters = {};
    for (const img of images) {
      const base = img.sort_order;
      const count = typeCounters[img.asset_type] || 0;
      img.sort_order = base + count;
      typeCounters[img.asset_type] = count + 1;
    }

    for (const sku of flooringSkus) {
      if (DRY_RUN) {
        if (VERBOSE) {
          console.log(`  [dry] ${vendorSku} → sku_id=${sku.sku_id} (${images.length} images)`);
        }
        stats.skusUpdated++;
        stats.imagesInserted += images.length;
        continue;
      }

      // Transaction: delete old images, insert new set
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const { rowCount: deleted } = await client.query(
          'DELETE FROM media_assets WHERE sku_id = $1',
          [sku.sku_id]
        );
        stats.imagesDeleted += deleted;

        for (const img of images) {
          await client.query(`
            INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
            VALUES ($1, $2, $3, $4, $5, $6)
          `, [sku.product_id, sku.sku_id, img.asset_type, img.url, img.originalUrl, img.sort_order]);
          stats.imagesInserted++;
        }

        await client.query('COMMIT');
        stats.skusUpdated++;
      } catch (e) {
        await client.query('ROLLBACK');
        console.warn(`  [db] Failed for ${vendorSku} (sku_id=${sku.sku_id}): ${e.message}`);
        stats.errors++;
      } finally {
        client.release();
      }
    }

    // Progress every 50 matched SKUs
    if (stats.matched % 50 === 0) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      console.log(`  [progress] ${stats.matched} matched, ${stats.skusUpdated} updated, ${stats.imagesInserted} images — ${elapsed}s`);
    }
  }

  // ---- Summary ----
  logSection('Summary');

  const elapsed = Date.now() - startTime;

  console.log(`  Pages scraped:            ${pagesScraped.success}`);
  console.log(`  Unique SKU image sets:    ${deduped.size}`);
  console.log(`  Matched to DB:            ${stats.matched}`);
  console.log(`  Unmatched (no DB SKU):    ${stats.unmatched}`);
  console.log(`  SKUs updated:             ${stats.skusUpdated}`);
  console.log(`  Images deleted (old):     ${stats.imagesDeleted}`);
  console.log(`  Images inserted (new):    ${stats.imagesInserted}`);
  console.log(`  DB errors:                ${stats.errors}`);
  console.log(`  Elapsed:                  ${(elapsed / 1000).toFixed(1)}s`);

  // Match rate
  const total = stats.matched + stats.unmatched;
  if (total > 0) {
    console.log(`  Match rate:               ${((stats.matched / total) * 100).toFixed(1)}% (${stats.matched}/${total})`);
  }

  // Top unmatched codes
  if (unmatchedCodes.length > 0) {
    console.log(`\n  Unmatched vendor SKUs (${unmatchedCodes.length}):`);
    const show = unmatchedCodes.slice(0, 25);
    for (const code of show) {
      console.log(`    ${code}`);
    }
    if (unmatchedCodes.length > 25) {
      console.log(`    ... and ${unmatchedCodes.length - 25} more`);
    }
  }

  if (DRY_RUN) {
    console.log('\n  DRY RUN — no changes were made to the database.');
  } else {
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
