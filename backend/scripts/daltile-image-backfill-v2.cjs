#!/usr/bin/env node
/**
 * daltile-image-backfill-v2.cjs
 *
 * Smarter image matching: tries multiple strategies in order, replaces over-shared
 * fallback images from v1 with better matches.
 *
 * Strategies (in order):
 *   1. Series+color exact match (same as v1, but with stricter color normalization)
 *   2. Series+color fuzzy match (strip common suffixes like "Scraped", "Satin", etc.)
 *   3. Color-only match across all Coveo (find the "canonical" image for that color)
 *   4. Keep existing if no better match found
 *
 * Only replaces product-level primaries that are currently over-shared.
 *
 * Usage:
 *   node backend/scripts/daltile-image-backfill-v2.cjs --dry-run
 *   node backend/scripts/daltile-image-backfill-v2.cjs
 */

const { Pool } = require('pg');
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

const DRY_RUN = process.argv.includes('--dry-run');
const COVEO_DOMAIN = 'www.daltile.com';
const PAGE_SIZE = 1000;
const COVEO_OFFSET_LIMIT = 5000;
const COVEO_FIELDS = ['sku', 'seriesname', 'colornameenglish', 'productimageurl', 'primaryroomsceneurl', 'bodytype', 'producttype'];
const OVERSHARE_THRESHOLD = 3; // primary used by 3+ products = over-shared

const PRODUCT_TYPE_SPLITS = [
  'Floor Tile', 'Floor Tile Trim', 'Wall Tile', 'Wall Tile Trim',
  'Mosaic Tile', 'Mosaic Tile Trim', 'Mosaic Natural Stone Tile',
  'Stone Tile', 'Stone Tile Trim', 'LVT Trim', 'LVT Plank',
  'Luxury Vinyl Tile', 'Porcelain Slab', 'Quartz Slab',
  'Natural Stone Slab', 'Quarry Tile', 'Quarry Tile Trim',
  'Floor Tile Deco', 'Wall Tile Deco', 'Wall Bathroom Accessories',
  'Windowsills-Thresholds',
];

const KNOWN_MATERIAL_SUFFIX_RE = /\s+Glass\s*$/i;
// Strip repeatedly - some colors have compounds like "Aegean Speckle Abrasive"
const COLOR_VARIANT_SUFFIX = /\s+(Scraped|Satin|Polished|Honed|Matte|Brushed|Tumbled|Unfilled|Filled|Abrasive|Speckle|Range|Slim|Mix|Blend|Light|Dark|Medium|Classic|Silo|Technology|SuperGuardX?|SuperGuard)\s*$/i;
// Strip trailing parenthetical: "Glue Down 12 Mil(0.3048)" -> "Glue Down 12 Mil"
const PAREN_SUFFIX = /\s*\([^)]*\)\s*$/;

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }
function norm(s) { return (s || '').toLowerCase().replace(/\s+/g, ' ').trim(); }
function stripKnownMaterialSuffix(c) { return c ? (c.replace(KNOWN_MATERIAL_SUFFIX_RE, '').trim() || c) : c; }

function stripVariantSuffix(color) {
  if (!color) return color;
  // First strip any parenthetical suffix
  let cur = color.replace(PAREN_SUFFIX, '').trim();
  // Apply repeatedly to handle compound suffixes like "Aegean Speckle Abrasive"
  let prev;
  do {
    prev = cur;
    cur = cur.replace(COLOR_VARIANT_SUFFIX, '').trim();
  } while (cur && cur !== prev);
  return cur || color;
}

function stripMaterialSuffix(color, material) {
  if (!color || !material) return color;
  const matLower = material.trim().toLowerCase();
  const colorLower = color.trim().toLowerCase();
  if (colorLower.endsWith(' ' + matLower)) {
    const stripped = color.trim().slice(0, -(matLower.length + 1)).trim();
    return stripped || color;
  }
  const matWords = matLower.split(/\s+/);
  if (matWords.length > 1) {
    const lastWord = matWords[matWords.length - 1];
    if (colorLower.endsWith(' ' + lastWord)) {
      const stripped = color.trim().slice(0, -(lastWord.length + 1)).trim();
      return stripped || color;
    }
  }
  return color;
}

function getField(result, fieldName) {
  const raw = result.raw || {};
  const val = raw[fieldName] ?? raw[fieldName.toLowerCase()] ?? null;
  if (val == null) return '';
  if (Array.isArray(val)) return val.map(v => String(v).trim()).filter(Boolean).join(', ');
  return String(val).trim();
}

function isPlaceholderUrl(url) {
  if (!url) return true;
  const lower = url.toLowerCase();
  return lower.includes('placeholder') || lower.includes('no-series-image') ||
    lower.includes('no.series') || lower.includes('coming-soon') ||
    // Also block known generic trim silhouettes
    /\/S\d{3,5}[A-Z]?(\?|$)/i.test(lower) && lower.includes('trimthumbnail');
}

function stripPreset(url) {
  if (!url) return url;
  return url.replace(/\?\$[A-Z_]+\$/, '');
}

function isGenericTrimSilhouette(url) {
  if (!url) return false;
  // e.g. https://s7d9.scene7.com/is/image/daltile/S1212J, S43F9, S44D9, P43C9, A3602
  // Pattern: short alphanumeric code with NO underscores (real product images all have underscores)
  const match = url.match(/\/([A-Z][A-Z0-9]{3,8})(\?|$)/i);
  if (!match) return false;
  // Must contain no underscores and be short (generic trim codes)
  return !match[1].includes('_');
}

async function queryCoveo(extraFilter, firstResult, numberOfResults) {
  const aq = `@sitetargethostname=="${COVEO_DOMAIN}" @sourcedisplayname==product${extraFilter}`;
  const resp = await fetch(`https://${COVEO_DOMAIN}/coveo/rest/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ q: '', aq, firstResult, numberOfResults, fieldsToInclude: COVEO_FIELDS }),
    signal: AbortSignal.timeout(30000),
  });
  if (!resp.ok) throw new Error(`Coveo ${resp.status}`);
  return resp.json();
}

async function paginateQuery(extraFilter, totalCount) {
  const results = [];
  let offset = 0;
  while (offset < totalCount && offset < COVEO_OFFSET_LIMIT) {
    const pageSize = Math.min(PAGE_SIZE, totalCount - offset);
    const resp = await queryCoveo(extraFilter, offset, pageSize);
    const batch = resp.results || [];
    if (batch.length === 0) break;
    results.push(...batch);
    offset += batch.length;
    if (offset < totalCount) await delay(200);
  }
  return results;
}

async function fetchAllCoveoResults() {
  const probe = await queryCoveo('', 0, 0);
  const totalCount = probe.totalCount || 0;
  if (totalCount === 0) return [];
  if (totalCount <= COVEO_OFFSET_LIMIT) return paginateQuery('', totalCount);
  const allResults = [];
  const seen = new Set();
  for (const pt of PRODUCT_TYPE_SPLITS) {
    const f = ` @producttype=="${pt}"`;
    const p = await queryCoveo(f, 0, 0);
    if (!p.totalCount) continue;
    const results = await paginateQuery(f, p.totalCount);
    for (const r of results) {
      const s = getField(r, 'sku');
      if (!s) continue;
      const key = s.split(/[;,]/).map(x => x.trim().toUpperCase()).sort().join('|');
      if (!seen.has(key)) { seen.add(key); allResults.push(r); }
    }
  }
  const catchFilter = PRODUCT_TYPE_SPLITS.map(t => `@producttype<>"${t}"`).join(' ');
  const cp = await queryCoveo(` ${catchFilter}`, 0, 0);
  if (cp.totalCount > 0) {
    const results = await paginateQuery(` ${catchFilter}`, Math.min(cp.totalCount, COVEO_OFFSET_LIMIT));
    for (const r of results) {
      const s = getField(r, 'sku');
      if (!s) continue;
      const key = s.split(/[;,]/).map(x => x.trim().toUpperCase()).sort().join('|');
      if (!seen.has(key)) { seen.add(key); allResults.push(r); }
    }
  }
  return allResults;
}

async function main() {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  DALTILE IMAGE BACKFILL V2 ${DRY_RUN ? '(DRY RUN)' : '(LIVE)'}`);
  console.log(`${'='.repeat(60)}\n`);

  const vendorRes = await pool.query("SELECT id FROM vendors WHERE code='DAL'");
  const vendorId = vendorRes.rows[0].id;

  // ── Step 1: Fetch Coveo ──
  console.log('─── Step 1: Fetching Coveo catalog ───\n');
  const results = await fetchAllCoveoResults();
  console.log(`  Total Coveo results: ${results.length}`);

  // ── Step 2: Build image maps ──
  console.log('\n─── Step 2: Building image maps ───\n');
  // Track each image's associated metadata + vote strength (how many SKUs use it)
  const seriesColorMap = new Map(); // "series|color" -> best image
  const colorOnlyMap = new Map(); // "color" -> { url, votes, series }
  const seriesColorFuzzyMap = new Map(); // "series|color-no-suffix" -> best image
  const seriesBestMap = new Map(); // "series" -> best image (highest votes)
  const seriesImages = new Map(); // "series" -> [{ url, color, shape, votes }] for keyword matching

  // Priority tier for product types: lower = better (real product images win over trim)
  function typeTier(t) {
    const lower = (t || '').toLowerCase();
    if (lower.includes('trim')) return 2;
    if (lower.includes('threshold') || lower.includes('windowsill')) return 2;
    return 1; // planks, tiles, mosaics, slabs, deco
  }

  function betterEntry(existing, candidate) {
    // Prefer lower tier (real products), then higher votes
    if (candidate.tier < existing.tier) return true;
    if (candidate.tier > existing.tier) return false;
    return candidate.votes > existing.votes;
  }

  for (const r of results) {
    const series = getField(r, 'seriesname');
    const rawColor = getField(r, 'colornameenglish');
    const material = getField(r, 'bodytype');
    const prodType = getField(r, 'producttype');
    const color = stripKnownMaterialSuffix(stripMaterialSuffix(rawColor, material));
    const prodImg = stripPreset(getField(r, 'productimageurl'));

    const validProd = prodImg && !isPlaceholderUrl(prodImg) && !isGenericTrimSilhouette(prodImg) ? prodImg : '';
    if (!validProd || !series || !color) continue;

    // How many SKUs does this entry cover? (votes)
    const rawSku = getField(r, 'sku');
    const skuCount = (rawSku.split(/[;,]/).map(s => s.trim()).filter(Boolean).length) || 1;
    const tier = typeTier(prodType);
    const entry = { url: validProd, votes: skuCount, tier, series };

    const key = `${norm(series)}|${norm(color)}`;
    if (!seriesColorMap.has(key) || betterEntry(seriesColorMap.get(key), entry)) {
      seriesColorMap.set(key, { ...entry });
    }

    const fuzzyColor = stripVariantSuffix(color);
    const fuzzyKey = `${norm(series)}|${norm(fuzzyColor)}`;
    if (!seriesColorFuzzyMap.has(fuzzyKey) || betterEntry(seriesColorFuzzyMap.get(fuzzyKey), entry)) {
      seriesColorFuzzyMap.set(fuzzyKey, { ...entry });
    }

    const colorKey = norm(color);
    if (!colorOnlyMap.has(colorKey) || betterEntry(colorOnlyMap.get(colorKey), entry)) {
      colorOnlyMap.set(colorKey, { ...entry });
    }

    const seriesKey = norm(series);
    if (!seriesBestMap.has(seriesKey) || betterEntry(seriesBestMap.get(seriesKey), entry)) {
      seriesBestMap.set(seriesKey, { ...entry });
    }

    if (!seriesImages.has(seriesKey)) seriesImages.set(seriesKey, []);
    seriesImages.get(seriesKey).push({ url: validProd, color: norm(color), votes: skuCount, tier });
  }
  console.log(`  series+color keys: ${seriesColorMap.size}`);
  console.log(`  series+fuzzyColor keys: ${seriesColorFuzzyMap.size}`);
  console.log(`  color-only keys: ${colorOnlyMap.size}`);
  console.log(`  series-best keys: ${seriesBestMap.size}\n`);

  // ── Step 3: Find products with over-shared primary images ──
  console.log('─── Step 3: Finding products with over-shared primary images ───\n');
  const overSharedRes = await pool.query(`
    SELECT p.id, p.name, p.collection,
           (SELECT sa.value FROM skus s JOIN sku_attributes sa ON sa.sku_id=s.id
              WHERE s.product_id=p.id AND s.status='active'
              AND sa.attribute_id=(SELECT id FROM attributes WHERE slug='color')
              LIMIT 1) as color,
           ma.url as current_url,
           (SELECT COUNT(*) FROM media_assets ma2
              WHERE ma2.url = ma.url AND ma2.asset_type='primary' AND ma2.sku_id IS NULL) as share_count
    FROM products p
    JOIN media_assets ma ON ma.product_id=p.id AND ma.sku_id IS NULL AND ma.asset_type='primary'
    WHERE p.vendor_id=$1 AND p.status='active'
      AND EXISTS (
        SELECT 1 FROM media_assets ma3
        WHERE ma3.url = ma.url AND ma3.asset_type='primary' AND ma3.sku_id IS NULL
        GROUP BY ma3.url HAVING COUNT(*) >= $2
      )
    ORDER BY share_count DESC, p.collection, p.name
  `, [vendorId, OVERSHARE_THRESHOLD]);
  console.log(`  Products with over-shared (${OVERSHARE_THRESHOLD}+) primary: ${overSharedRes.rows.length}\n`);

  // Also find products that still have NO primary image
  const missingRes = await pool.query(`
    SELECT p.id, p.name, p.collection,
           (SELECT sa.value FROM skus s JOIN sku_attributes sa ON sa.sku_id=s.id
              WHERE s.product_id=p.id AND s.status='active'
              AND sa.attribute_id=(SELECT id FROM attributes WHERE slug='color')
              LIMIT 1) as color
    FROM products p
    WHERE p.vendor_id=$1 AND p.status='active'
      AND NOT EXISTS (
        SELECT 1 FROM media_assets ma
        WHERE ma.product_id=p.id AND ma.sku_id IS NULL AND ma.asset_type='primary'
      )
  `, [vendorId]);
  console.log(`  Products with NO primary: ${missingRes.rows.length}\n`);

  // Combine: these are the candidates for new images
  const candidates = [
    ...overSharedRes.rows.map(r => ({ ...r, status: 'over-shared' })),
    ...missingRes.rows.map(r => ({ ...r, status: 'missing', current_url: null })),
  ];

  // ── Step 4: Match candidates to Coveo images ──
  console.log('─── Step 4: Matching candidates ───\n');
  const updates = []; // { productId, newUrl, oldUrl, strategy }
  let exact = 0, fuzzy = 0, colorOnly = 0, fuzzyColorOnly = 0, seriesFall = 0, nothing = 0;

  for (const c of candidates) {
    const collection = (c.collection || '').trim();
    const color = (c.color || '').trim();
    if (!collection) { nothing++; continue; }

    let matchedUrl = null, strategy = null;

    // Strategy 1: exact series+color
    if (color) {
      const key1 = `${norm(collection)}|${norm(color)}`;
      const m1 = seriesColorMap.get(key1);
      if (m1) { matchedUrl = m1.url; strategy = 'exact'; exact++; }
    }

    // Strategy 2: series+color-no-suffix
    if (!matchedUrl && color) {
      const fuzzyColor = stripVariantSuffix(color);
      const key2 = `${norm(collection)}|${norm(fuzzyColor)}`;
      const m2 = seriesColorFuzzyMap.get(key2);
      if (m2) { matchedUrl = m2.url; strategy = 'fuzzy'; fuzzy++; }
    }

    // Strategy 3: color only (any series)
    if (!matchedUrl && color) {
      const key3 = norm(color);
      const m3 = colorOnlyMap.get(key3);
      if (m3) { matchedUrl = m3.url; strategy = `color-only (${m3.series})`; colorOnly++; }
    }

    // Strategy 4: stripped color only (any series)
    if (!matchedUrl && color) {
      const fuzzyColor = stripVariantSuffix(color);
      const key4 = norm(fuzzyColor);
      const m4 = colorOnlyMap.get(key4);
      if (m4) { matchedUrl = m4.url; strategy = `fuzzy-color-only (${m4.series})`; fuzzyColorOnly++; }
    }

    // Strategy 5: keyword match in image URLs (within same series)
    if (!matchedUrl && color) {
      const seriesImgs = seriesImages.get(norm(collection)) || [];
      // Try full color words and common abbreviations
      const abbreviations = {
        'pillow': ['pllw', 'pillow'],
        'pyramid': ['pyr', 'pyramid'],
        'star': ['star'],
        'rope': ['rope'],
        'ogee': ['ogee'],
        'french square': ['frsq'],
        'liner': ['lnr', 'liner'],
        'chair rail': ['chr'],
        'pencil': ['pl', 'pencil'],
        'dot': ['dot'],
        'deco': ['deco'],
        'brick joint': ['brkjnt'],
        'herringbone': ['hrbn', 'herr'],
        'hexagon': ['hex'],
        'penny round': ['pnyrnd', 'pny'],
        'picket': ['pkt', 'picket'],
      };
      const colorNorm = norm(color);
      const keywords = [];
      for (const [phrase, abbrs] of Object.entries(abbreviations)) {
        if (colorNorm.includes(phrase)) keywords.push(...abbrs);
      }
      // Also use the color itself as a keyword
      for (const word of colorNorm.split(/\s+/)) {
        if (word.length >= 3) keywords.push(word);
      }

      let best = null;
      for (const img of seriesImgs) {
        const urlLower = img.url.toLowerCase();
        const matchCount = keywords.filter(k => urlLower.includes(k)).length;
        if (matchCount === 0) continue;
        // Prefer: higher match count, then lower tier, then higher votes
        const betterThan = !best ||
          matchCount > best.matchCount ||
          (matchCount === best.matchCount && img.tier < best.tier) ||
          (matchCount === best.matchCount && img.tier === best.tier && img.votes > best.votes);
        if (betterThan) best = { ...img, matchCount };
      }
      if (best) { matchedUrl = best.url; strategy = 'keyword-match'; fuzzyColorOnly++; }
    }

    // Strategy 6: series fallback
    if (!matchedUrl) {
      const key6 = norm(collection);
      const m6 = seriesBestMap.get(key6);
      if (m6) { matchedUrl = m6.url; strategy = 'series-fallback'; seriesFall++; }
    }

    if (!matchedUrl) { nothing++; continue; }
    if (matchedUrl === c.current_url) continue; // no change

    updates.push({ productId: c.id, newUrl: matchedUrl, oldUrl: c.current_url, strategy, name: c.name, color });
  }

  console.log(`  Matched exact (series+color):        ${exact}`);
  console.log(`  Matched fuzzy (stripped suffix):     ${fuzzy}`);
  console.log(`  Matched color-only (other series):   ${colorOnly}`);
  console.log(`  Matched fuzzy color-only:            ${fuzzyColorOnly}`);
  console.log(`  Matched series-fallback:             ${seriesFall}`);
  console.log(`  Unmatched:                           ${nothing}`);
  console.log(`  Net updates to apply: ${updates.length}\n`);

  // Show samples
  console.log('  Sample updates:');
  for (const u of updates.slice(0, 10)) {
    console.log(`    [${u.strategy}] ${u.name.slice(0, 40)} / ${u.color}`);
    console.log(`      ${(u.oldUrl || '(none)').slice(0, 70)} -> ${u.newUrl.slice(0, 70)}`);
  }
  console.log('');

  // ── Step 5: Execute updates ──
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    console.log('─── Step 5: Applying updates ───\n');
    let deleted = 0, inserted = 0;
    for (const u of updates) {
      const del = await client.query(`
        DELETE FROM media_assets
        WHERE product_id=$1 AND sku_id IS NULL AND asset_type='primary'
      `, [u.productId]);
      deleted += del.rowCount;

      const ins = await client.query(`
        INSERT INTO media_assets (product_id, sku_id, url, asset_type)
        VALUES ($1, NULL, $2, 'primary')
        ON CONFLICT DO NOTHING
      `, [u.productId, u.newUrl]);
      inserted += ins.rowCount;
    }
    console.log(`  Deleted old primaries: ${deleted}`);
    console.log(`  Inserted new primaries: ${inserted}\n`);

    if (DRY_RUN) {
      console.log('[DRY RUN] Rolling back...\n');
      await client.query('ROLLBACK');
    } else {
      await client.query('COMMIT');
      console.log('Transaction committed.\n');
    }
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // ── Summary ──
  console.log(`${'='.repeat(60)}`);
  console.log('  SUMMARY');
  console.log(`${'='.repeat(60)}`);
  console.log(`  Candidates (over-shared + missing): ${candidates.length}`);
  console.log(`  Updates applied:                    ${updates.length}`);
  console.log(`${'='.repeat(60)}\n`);

  await pool.end();
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
