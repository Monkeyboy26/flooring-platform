#!/usr/bin/env node
/**
 * Backfill Daltile per-SKU images from Coveo API.
 *
 * Downloads Coveo's full catalog, extracts per-size image URLs, and matches
 * them to individual SKUs by 4-char color prefix + tile size. This assigns
 * size-specific images (e.g., 12x24 grid vs 2x2 mosaic silo) to each SKU
 * rather than sharing a single product-level image.
 *
 * Usage:
 *   node backend/scripts/backfill-daltile-sku-images.cjs --dry-run
 *   node backend/scripts/backfill-daltile-sku-images.cjs
 */
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || process.env.PGHOST || 'localhost',
  port: parseInt(process.env.DB_PORT || process.env.PGPORT || '5432'),
  database: process.env.DB_NAME || process.env.PGDATABASE || 'flooring_pim',
  user: process.env.DB_USER || process.env.PGUSER || 'postgres',
  password: process.env.DB_PASSWORD || process.env.PGPASSWORD || 'postgres',
});

const DRY_RUN = process.argv.includes('--dry-run');

const COVEO_URL = 'https://www.daltile.com/coveo/rest/search';
const COVEO_FIELDS = [
  'sku', 'seriesname', 'colornameenglish', 'productimageurl',
  'primaryroomsceneurl', 'producttype',
];
const PAGE_SIZE = 100;

// Placeholder / trim image patterns to skip
const SKIP_PATTERNS = [
  'No-Series-Image-Available',
  'SLIMT', 'VSLCAP', 'VQRND', 'EXTSN', 'RNDSTRD', 'VNOSE', 'TMOLD', 'ENDCAP',
  'VSTRD', 'VRDSN', 'VSCAP', 'SQRSTRD',
  'P43C9', 'P43F9', 'S1212J',
  'cq5dam.web.170.170',
];

const TRIM_SKU_RE = /SLIMT|VSLCAP|VQRND|EXTSN|RNDSTRD|VNOSE|TMOLD|ENDCAP|VSTRD|VRDSN|VSCAP|SQRSTRD|BULL|P43C9|P43F9|S1212J|SN4310/i;

// ----- Size extraction -----

// Known compact dimension strings → WxH
const DIM_LOOKUP = {
  '2448': '24x48', '1648': '16x48', '1224': '12x24', '2424': '24x24',
  '1212': '12x12', '1818': '18x18', '1313': '13x13', '3232': '32x32',
  '848': '8x48', '824': '8x24', '624': '6x24', '618': '6x18',
  '412': '4x12', '416': '4x16',
  '324': '3x24', '312': '3x12',
  '1014': '10x14', '1013': '10x13', '912': '9x12',
  '1211': '12x11', '1210': '12x10', '1213': '12x13',
  '124': '1x24', '128': '1x28',
  '66': '6x6', '48': '4x8', '44': '4x4', '36': '3x6',
  '28': '2x8', '26': '2x6', '24': '2x4',
  '22': '2x2', '16': '1x6', '18': '1x8', '11': '1x1',
  '96060': '60x60',
};

/** Extract WxH from a Coveo image URL (e.g., "DAL_EP22_12x24_TrumpetGrey" → "12x24") */
function extractSizeFromUrl(url) {
  if (!url) return null;
  const m = url.match(/[_/](\d+)x(\d+)[_/.]/i);
  return m ? `${m[1]}x${m[2]}` : null;
}

/** Extract WxH from a Coveo SKU code (e.g., "EP22RCT1224MT" → "12x24") */
function extractSizeFromCoveoSku(sku) {
  if (!sku || sku.length < 5) return null;
  const afterPrefix = sku.substring(4);
  // Strip known shape codes at the start
  const cleaned = afterPrefix.replace(/^(RCT|SQU|PLK|STK|HER|BKJ|STJ|DOT|G|RC|MIXED)/i, '');
  // Extract first digit sequence
  const m = cleaned.match(/^(\d{2,5})/);
  if (!m) return null;
  return DIM_LOOKUP[m[1]] || null;
}

/** Extract WxH from our vendor_sku (fallback when no size attribute) */
function extractSizeFromVendorSku(sku) {
  if (!sku || sku.length < 5) return null;
  const afterPrefix = sku.substring(4);
  // Strip known shape/type codes
  const cleaned = afterPrefix.replace(/^(SQ|RCT|PLK|STK|HERR?|BKJ?|BJ|STJ|DOT|G|RC|MIXED)/i, '');
  const m = cleaned.match(/^(\d{2,5})/);
  if (!m) return null;
  return DIM_LOOKUP[m[1]] || null;
}

// ----- Helpers -----

function isValidImageUrl(url) {
  if (!url) return false;
  return !SKIP_PATTERNS.some(p => url.includes(p));
}

function cleanUrl(url) {
  if (!url) return null;
  let clean = url.split('?')[0];
  if (clean.includes('/jcr:content/renditions/')) {
    clean = clean.replace(/\/jcr:content\/renditions\/.*$/, '/jcr:content/renditions/original');
  }
  if (clean.includes('digitalassets.daltile.com/content/dam/') && !clean.includes('/jcr:content/')) {
    clean += '/jcr:content/renditions/original';
  }
  return clean;
}

function extractPrefix(sku) {
  if (!sku) return null;
  const m = sku.trim().match(/^([A-Z]{2}\d{2})/i);
  return m ? m[1].toUpperCase() : null;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function getField(raw, key) {
  const val = raw[key];
  if (Array.isArray(val)) return (val[0] || '').trim();
  return (val || '').trim();
}

// ----- Coveo download -----

async function queryCoveo(aq, firstResult = 0) {
  const resp = await fetch(COVEO_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ q: '', aq, firstResult, numberOfResults: PAGE_SIZE, fieldsToInclude: COVEO_FIELDS }),
    signal: AbortSignal.timeout(30000),
  });
  if (!resp.ok) throw new Error(`Coveo ${resp.status}`);
  return resp.json();
}

/**
 * Download full Coveo catalog and build per-SKU size-specific image maps.
 *
 * Returns:
 *   prefixSizeMap: Map<"PREFIX|WxH", {imageUrl, roomUrl, colorName, series}>
 *   prefixFallback: Map<"PREFIX", {imageUrl, roomUrl, colorName, series}>
 *   seriesColorMap: Map<"normSeries|normColor", {imageUrl, roomUrl, ...}>
 */
async function downloadCoveoCatalog() {
  const prefixSizeMap = new Map();   // "EP22|12x24" → entry
  const prefixFallback = new Map();  // "EP22" → first valid entry
  const seriesColorMap = new Map();  // for fallback matching

  for (const source of ['product', 'Products']) {
    const aq = `@sitetargethostname=="www.daltile.com" @sourcedisplayname==${source}`;
    let offset = 0, total = null;

    while (true) {
      let data;
      try { data = await queryCoveo(aq, offset); }
      catch (err) { console.log(`  Coveo error at offset ${offset}: ${err.message}`); break; }

      if (total === null) {
        total = data.totalCount;
        console.log(`  Coveo "${source}": ${total} results`);
      }

      const results = data.results || [];
      if (results.length === 0) break;

      for (const result of results) {
        const raw = result.raw || {};
        const productType = getField(raw, 'producttype').toLowerCase();
        if (productType.includes('trim')) continue;

        const colorName = getField(raw, 'colornameenglish');
        const imageUrl = cleanUrl(getField(raw, 'productimageurl'));
        const roomUrl = cleanUrl(getField(raw, 'primaryroomsceneurl'));
        const series = getField(raw, 'seriesname');
        const skuField = getField(raw, 'sku');

        if (!isValidImageUrl(imageUrl)) continue;

        const entry = {
          imageUrl,
          roomUrl: isValidImageUrl(roomUrl) ? roomUrl : null,
          colorName,
          series,
        };

        // Extract size from image URL (most reliable)
        const imageSize = extractSizeFromUrl(imageUrl);

        // Process each SKU code in this Coveo result
        const skuCodes = skuField.split(';').map(s => s.trim()).filter(Boolean);
        const prefixesSeen = new Set();

        for (const sku of skuCodes) {
          if (TRIM_SKU_RE.test(sku)) continue;
          const prefix = extractPrefix(sku);
          if (!prefix) continue;

          // Map prefix → fallback (first valid image per prefix)
          if (!prefixFallback.has(prefix)) prefixFallback.set(prefix, entry);

          // Map prefix|size from image URL
          if (imageSize) {
            const key = `${prefix}|${imageSize}`;
            if (!prefixSizeMap.has(key)) prefixSizeMap.set(key, entry);
          }

          // Also map prefix|size from each individual SKU code's embedded size
          // This handles cases where one Coveo entry covers e.g. "12x12; 18x18"
          // and the image is labeled 12x12 — we still want to map both sizes
          const skuSize = extractSizeFromCoveoSku(sku);
          if (skuSize && skuSize !== imageSize) {
            const key = `${prefix}|${skuSize}`;
            if (!prefixSizeMap.has(key)) prefixSizeMap.set(key, entry);
          }
        }

        // Series+color map for fallback
        if (series && colorName) {
          const normSeries = normalize(series);
          const normColor = normalize(colorName);
          if (normSeries && normColor) {
            const key = `${normSeries}|${normColor}`;
            if (!seriesColorMap.has(key)) seriesColorMap.set(key, entry);
          }
        }
      }

      offset += results.length;
      if (offset >= total) break;
      await sleep(200);
    }
  }

  return { prefixSizeMap, prefixFallback, seriesColorMap };
}

function normalize(str) {
  return (str || '').toLowerCase().replace(/\bgray\b/g, 'grey').replace(/[^a-z0-9]/g, '');
}

function extractColor(productName, collection) {
  return productName
    .replace(new RegExp(`^${collection.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*`, 'i'), '')
    .replace(/\s*(Porcelain Tile|Ceramic Tile|Mosaic|Glass Tile|LVT|Luxury Vinyl|Porcelain|Ceramic|Tile)$/i, '')
    .replace(/\s*(Glue Down|Rigid Click)\s+\d+\s+Mil\s*\([^)]*\)\s*$/i, '')
    .replace(/\s*(Satin|Abrasive|Double Abrasive|Glossy)$/i, '')
    .trim();
}

// ----- URL verification -----

const _verifyCache = new Map();

async function verifyUrl(url) {
  if (_verifyCache.has(url)) return _verifyCache.get(url);
  try {
    const resp = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(8000), redirect: 'follow' });
    _verifyCache.set(url, resp.ok);
    return resp.ok;
  } catch {
    _verifyCache.set(url, false);
    return false;
  }
}

// ----- Main -----

async function main() {
  console.log(`\nDaltile Per-SKU Image Backfill${DRY_RUN ? ' (DRY RUN)' : ''}\n`);

  // Get DAL vendor ID
  const vendorRes = await pool.query(`SELECT id FROM vendors WHERE code = 'DAL'`);
  const dalVendorId = vendorRes.rows[0].id;

  // ===== Step 1: Download Coveo catalog =====
  console.log('=== Step 1: Downloading Coveo catalog ===');
  const { prefixSizeMap, prefixFallback, seriesColorMap } = await downloadCoveoCatalog();
  console.log(`  prefix|size entries: ${prefixSizeMap.size}`);
  console.log(`  prefix fallback entries: ${prefixFallback.size}`);
  console.log(`  series|color entries: ${seriesColorMap.size}\n`);

  // ===== Step 2: Get SKUs needing per-SKU images =====
  console.log('=== Step 2: Finding SKUs without sku-level images ===');
  const skuRes = await pool.query(`
    SELECT s.id AS sku_id, s.vendor_sku,
      p.id AS product_id, p.name, p.display_name, p.collection,
      sa_size.value AS size_attr
    FROM skus s
    JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id
    LEFT JOIN sku_attributes sa_size ON sa_size.sku_id = s.id
      AND sa_size.attribute_id = (SELECT id FROM attributes WHERE slug = 'size')
    LEFT JOIN media_assets m_sku ON m_sku.sku_id = s.id
      AND m_sku.asset_type IN ('primary','alternate','lifestyle')
    WHERE v.code = 'DAL' AND s.status = 'active' AND p.status = 'active'
      AND s.variant_type IS DISTINCT FROM 'accessory'
      AND m_sku.id IS NULL
    ORDER BY p.collection, p.name, s.vendor_sku
  `);

  console.log(`  ${skuRes.rows.length} SKUs need per-SKU images\n`);

  // ===== Step 3: Match each SKU =====
  console.log('=== Step 3: Per-SKU matching ===');
  const stats = {
    prefixSize: 0,      // Matched by prefix + size
    prefixSizeVsku: 0,  // Matched by prefix + size extracted from vendor_sku
    prefixOnly: 0,      // Matched by prefix fallback (no size match)
    seriesColor: 0,     // Matched by series + color name
    productFallback: 0, // Used existing product-level image
    noMatch: 0,
    inserted: 0,
    lifestyleInserted: 0,
    verified: 0,
    broken: 0,
  };

  let prevCollection = '';

  for (const sku of skuRes.rows) {
    if (sku.collection !== prevCollection) {
      prevCollection = sku.collection;
      console.log(`\n--- ${sku.collection} ---`);
    }

    const prefix = extractPrefix(sku.vendor_sku);
    const sizeAttr = sku.size_attr; // e.g., "12x24"
    const sizeParsed = extractSizeFromVendorSku(sku.vendor_sku); // fallback

    const size = sizeAttr || sizeParsed;

    let match = null;
    let strategy = '';

    // Strategy 1: prefix + size (exact)
    if (prefix && size) {
      const key = `${prefix}|${size}`;
      if (prefixSizeMap.has(key)) {
        match = prefixSizeMap.get(key);
        strategy = sizeAttr ? 'prefix+size' : 'prefix+size(vsku)';
      }
    }

    // Strategy 2: prefix fallback (any image for this color prefix)
    if (!match && prefix && prefixFallback.has(prefix)) {
      match = prefixFallback.get(prefix);
      strategy = 'prefix-fallback';
    }

    // Strategy 3: series + color name match
    if (!match) {
      const color = extractColor(sku.name, sku.collection);
      const normColl = normalize(sku.collection);
      const normColor = normalize(color);
      if (normColl && normColor) {
        const key = `${normColl}|${normColor}`;
        if (seriesColorMap.has(key)) {
          match = seriesColorMap.get(key);
          strategy = 'series+color';
        } else {
          // Partial: check if any series key contains our collection
          for (const [mapKey, entry] of seriesColorMap) {
            const [mapSeries, mapColor] = mapKey.split('|');
            if (mapColor === normColor && (mapSeries.includes(normColl) || normColl.includes(mapSeries))) {
              match = entry;
              strategy = 'series+color(partial)';
              break;
            }
          }
        }
      }
    }

    // Strategy 4: Copy product-level image to sku-level
    if (!match) {
      const prodImg = await pool.query(`
        SELECT url, asset_type FROM media_assets
        WHERE product_id = $1 AND sku_id IS NULL
          AND asset_type IN ('primary','lifestyle')
        ORDER BY asset_type, sort_order
        LIMIT 2
      `, [sku.product_id]);

      if (prodImg.rows.length > 0) {
        const primary = prodImg.rows.find(r => r.asset_type === 'primary');
        const lifestyle = prodImg.rows.find(r => r.asset_type === 'lifestyle');
        match = {
          imageUrl: primary?.url || lifestyle?.url,
          roomUrl: lifestyle?.url || null,
        };
        strategy = 'product-copy';
      }
    }

    if (!match) {
      stats.noMatch++;
      console.log(`  NONE: ${sku.vendor_sku} "${sku.name}" size=${size || '?'} prefix=${prefix || '?'}`);
      continue;
    }

    // Trust Coveo Scene7 URLs (from Daltile's own catalog).
    // Only verify DAM URLs which can be flaky with HEAD requests.
    if (strategy !== 'product-copy' && match.imageUrl.includes('digitalassets.daltile.com')) {
      const ok = await verifyUrl(match.imageUrl);
      if (!ok) {
        stats.broken++;
        // Fall through to product-copy
        const prodImg = await pool.query(`
          SELECT url, asset_type FROM media_assets
          WHERE product_id = $1 AND sku_id IS NULL
            AND asset_type IN ('primary','lifestyle')
          ORDER BY asset_type, sort_order LIMIT 2
        `, [sku.product_id]);
        if (prodImg.rows.length > 0) {
          const primary = prodImg.rows.find(r => r.asset_type === 'primary');
          const lifestyle = prodImg.rows.find(r => r.asset_type === 'lifestyle');
          match = { imageUrl: primary?.url || lifestyle?.url, roomUrl: lifestyle?.url || null };
          strategy = 'product-copy(broken-dam)';
        } else {
          stats.noMatch++;
          console.log(`  BROKEN+NONE: ${sku.vendor_sku} "${sku.name}" url=${match.imageUrl.split('/').pop()}`);
          continue;
        }
      }
    }

    // Count by strategy
    if (strategy === 'prefix+size') stats.prefixSize++;
    else if (strategy === 'prefix+size(vsku)') stats.prefixSizeVsku++;
    else if (strategy === 'prefix-fallback') stats.prefixOnly++;
    else if (strategy.startsWith('series+color')) stats.seriesColor++;
    else stats.productFallback++;

    if (DRY_RUN) {
      const imgShort = match.imageUrl ? match.imageUrl.split('/').pop().substring(0, 50) : 'N/A';
      console.log(`  ${strategy.toUpperCase()}: ${sku.vendor_sku} (${size || '?'}) → ${imgShort}`);
    }

    if (!DRY_RUN) {
      // Insert primary image at SKU level
      await pool.query(`
        INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order, source)
        VALUES ($1, $2, 'primary', $3, $3, 0, $4)
        ON CONFLICT DO NOTHING
      `, [sku.product_id, sku.sku_id, match.imageUrl, `sku-${strategy}`]);
      stats.inserted++;

      // Insert lifestyle if available
      if (match.roomUrl && match.roomUrl !== match.imageUrl) {
        await pool.query(`
          INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order, source)
          VALUES ($1, $2, 'lifestyle', $3, $3, 0, $4)
          ON CONFLICT DO NOTHING
        `, [sku.product_id, sku.sku_id, match.roomUrl, `sku-${strategy}`]);
        stats.lifestyleInserted++;
      }
    }
  }

  // ===== Summary =====
  console.log('\n\n=== Summary ===');
  console.log(`  prefix+size match:      ${stats.prefixSize}`);
  console.log(`  prefix+size(vsku):      ${stats.prefixSizeVsku}`);
  console.log(`  prefix fallback:        ${stats.prefixOnly}`);
  console.log(`  series+color:           ${stats.seriesColor}`);
  console.log(`  product-level copy:     ${stats.productFallback}`);
  console.log(`  URLs verified OK:       ${stats.verified}`);
  console.log(`  URLs broken:            ${stats.broken}`);
  console.log(`  No match at all:        ${stats.noMatch}`);

  if (!DRY_RUN) {
    console.log(`\n  SKU images inserted:       ${stats.inserted}`);
    console.log(`  SKU lifestyle inserted:    ${stats.lifestyleInserted}`);
  }

  // Coverage after
  const coverage = await pool.query(`
    SELECT COUNT(DISTINCT s.id) AS total,
      COUNT(DISTINCT CASE WHEN m_sku.id IS NOT NULL THEN s.id END) AS has_sku_img,
      COUNT(DISTINCT CASE WHEN m_sku.id IS NULL AND m_prod.id IS NOT NULL THEN s.id END) AS prod_only,
      COUNT(DISTINCT CASE WHEN m_sku.id IS NULL AND m_prod.id IS NULL THEN s.id END) AS no_img
    FROM skus s
    JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id
    LEFT JOIN media_assets m_sku ON m_sku.sku_id = s.id AND m_sku.asset_type IN ('primary','alternate','lifestyle')
    LEFT JOIN media_assets m_prod ON m_prod.product_id = p.id AND m_prod.sku_id IS NULL AND m_prod.asset_type IN ('primary','alternate','lifestyle')
    WHERE v.code = 'DAL' AND s.status = 'active' AND p.status = 'active'
      AND s.variant_type IS DISTINCT FROM 'accessory'
  `);

  const { total, has_sku_img, prod_only, no_img } = coverage.rows[0];
  console.log(`\nSKU image coverage: ${has_sku_img}/${total} (${(has_sku_img / total * 100).toFixed(1)}%)`);
  console.log(`  Product-level only: ${prod_only}`);
  console.log(`  No image: ${no_img}`);

  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
