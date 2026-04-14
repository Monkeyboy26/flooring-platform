#!/usr/bin/env node
/**
 * daltile-fix-sizes.cjs
 *
 * Fixes incorrect size attributes on Daltile SKUs. The EDI 832 importer stores
 * mosaic SHEET dimensions (e.g. "12x10") instead of the individual TILE size
 * (e.g. "1X6"). This script pulls correct nominalsize values from Coveo and
 * updates mismatched size attributes.
 *
 * Strategy:
 *   1. Load full Coveo catalog, index by exact SKU
 *   2. For each DB Daltile SKU, try direct match in Coveo
 *   3. If no match, try stripping known suffix tokens (MS, MB, MP) from DB sku
 *   4. If matched and sizes differ, update DB to Coveo's nominalsize
 *
 * Usage:
 *   node backend/scripts/daltile-fix-sizes.cjs --dry-run
 *   node backend/scripts/daltile-fix-sizes.cjs
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
const COVEO_FIELDS = ['sku', 'nominalsize', 'producttype', 'seriesname', 'colornameenglish'];

const PRODUCT_TYPE_SPLITS = [
  'Floor Tile', 'Floor Tile Trim', 'Wall Tile', 'Wall Tile Trim',
  'Mosaic Tile', 'Mosaic Tile Trim', 'Mosaic Natural Stone Tile',
  'Stone Tile', 'Stone Tile Trim', 'LVT Trim', 'LVT Plank',
  'Luxury Vinyl Tile', 'Porcelain Slab', 'Quartz Slab',
  'Natural Stone Slab', 'Quarry Tile', 'Quarry Tile Trim',
  'Floor Tile Deco', 'Wall Tile Deco', 'Wall Bathroom Accessories',
  'Windowsills-Thresholds',
];

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function getField(result, fieldName) {
  const raw = result.raw || {};
  const val = raw[fieldName] ?? raw[fieldName.toLowerCase()] ?? null;
  if (val == null) return '';
  if (Array.isArray(val)) return val.map(v => String(v).trim()).filter(Boolean).join(', ');
  return String(val).trim();
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
  return allResults;
}

// Normalize size for comparison: uppercase, strip spaces around x
function normSize(s) {
  if (!s) return '';
  return String(s).toUpperCase().replace(/\s*X\s*/g, 'X').replace(/\s+/g, '').trim();
}

// DB sizes written by EDI 832 importer use lowercase x (e.g., "12x10").
// Correctly-sourced sizes use uppercase X (e.g., "12X24"). This pattern
// distinguishes EDI-derived sheet sizes (likely wrong for mosaics) from
// authoritative values.
function isEdiFormat(s) {
  if (!s) return false;
  // Lowercase x surrounded by digits, no uppercase X present
  return /\d+x\d+/.test(s) && !/X/.test(s);
}

// Validate that a Coveo size looks like a real size (NxM, N/MxP, etc)
function isValidSize(s) {
  if (!s) return false;
  const n = normSize(s);
  // Must contain X and digits on both sides
  return /^[\d./]+X[\d./]+$/.test(n);
}

// Try stripping suffix tokens from a vendor sku
function skuVariants(sku) {
  const s = sku.toUpperCase();
  const variants = new Set([s]);
  // Strip MS (mosaic sheet), MB (mosaic border), MP (mosaic pattern) before the final 2-char suffix
  // Daltile sku format: ...PREFIX + <suffix-token> + FINISH2
  // e.g. AC24STJ16MSGL -> strip MS -> AC24STJ16GL
  const stripPatterns = [
    /MS(?=[A-Z]{2}$)/,   // MS before 2-char finish
    /MB(?=[A-Z]{2}$)/,
    /MP(?=[A-Z]{2}$)/,
    /MT(?=[A-Z]{2}$)/,   // sometimes MT
  ];
  for (const p of stripPatterns) {
    if (p.test(s)) variants.add(s.replace(p, ''));
  }
  return Array.from(variants);
}

async function main() {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  DALTILE SIZE FIX ${DRY_RUN ? '(DRY RUN)' : '(LIVE)'}`);
  console.log(`${'='.repeat(60)}\n`);

  const vendorRes = await pool.query("SELECT id FROM vendors WHERE code='DAL'");
  const vendorId = vendorRes.rows[0].id;

  // Load Coveo
  console.log('Fetching Coveo catalog...');
  const results = await fetchAllCoveoResults();
  console.log(`  Loaded ${results.length} entries\n`);

  // Index by individual SKU. Coveo parallel arrays are independently alphabetically sorted
  // (not positionally aligned to SKU), so only use entries that resolve to exactly ONE SKU
  // and ONE size — those are unambiguous.
  const coveoBySku = new Map();
  let skippedMulti = 0;
  for (const r of results) {
    const raw = r.raw || {};
    // Normalize to flat SKU list: split string values on ;/, and flatten arrays
    const rawSku = raw.sku;
    const skuList = [];
    const push = v => {
      if (!v) return;
      for (const part of String(v).split(/[;,]/)) {
        const t = part.trim().toUpperCase();
        if (t) skuList.push(t);
      }
    };
    if (Array.isArray(rawSku)) { for (const v of rawSku) push(v); }
    else push(rawSku);

    const rawSize = raw.nominalsize;
    const sizeList = [];
    const pushSize = v => { if (v) { const t = String(v).trim(); if (t) sizeList.push(t); } };
    if (Array.isArray(rawSize)) { for (const v of rawSize) pushSize(v); }
    else pushSize(rawSize);

    if (skuList.length === 0 || sizeList.length === 0) continue;
    // Only trust single-sku, single-size entries (unambiguous mapping)
    if (skuList.length !== 1 || sizeList.length !== 1) { skippedMulti++; continue; }
    const sku = skuList[0];
    const size = sizeList[0];
    if (!coveoBySku.has(sku)) coveoBySku.set(sku, size);
  }
  console.log(`  Indexed ${coveoBySku.size} unique Coveo SKUs (skipped ${skippedMulti} multi-sku entries)\n`);

  // Load DB SKUs with size attributes
  console.log('Loading DB size attributes...');
  const dbRes = await pool.query(`
    SELECT s.id as sku_id, s.vendor_sku, sa.attribute_id, sa.value as db_size
    FROM skus s
    JOIN products p ON p.id = s.product_id
    JOIN sku_attributes sa ON sa.sku_id = s.id
    JOIN attributes a ON a.id = sa.attribute_id
    WHERE p.vendor_id = $1
      AND a.slug = 'size'
      AND s.status = 'active'
      AND s.vendor_sku IS NOT NULL
  `, [vendorId]);
  console.log(`  ${dbRes.rows.length} SKUs with size attributes\n`);

  // Match and diff
  let matched = 0, mismatched = 0, directMatch = 0, fuzzyMatch = 0, unmatched = 0;
  const updates = [];
  const mismatchExamples = {};

  for (const row of dbRes.rows) {
    const dbSku = (row.vendor_sku || '').toUpperCase();
    if (!dbSku) continue;

    let coveoSize = coveoBySku.get(dbSku);
    let matchType = 'direct';
    if (!coveoSize) {
      // Try variants
      for (const v of skuVariants(dbSku)) {
        if (v !== dbSku && coveoBySku.has(v)) {
          coveoSize = coveoBySku.get(v);
          matchType = 'fuzzy';
          break;
        }
      }
    }

    if (!coveoSize) { unmatched++; continue; }
    matched++;
    if (matchType === 'direct') directMatch++;
    else fuzzyMatch++;

    if (normSize(coveoSize) !== normSize(row.db_size)) {
      mismatched++;
      const key = `${row.db_size} → ${coveoSize}`;
      mismatchExamples[key] = (mismatchExamples[key] || 0) + 1;
      // Only fix DB values that look like EDI-derived sheet sizes, and only
      // write Coveo values that look like valid sizes. Skip uppercase-X values
      // (those were sourced from a trusted path).
      if (!isEdiFormat(row.db_size)) continue;
      if (!isValidSize(coveoSize)) continue;
      updates.push({ attribute_id: row.attribute_id, sku_id: row.sku_id, vendor_sku: row.vendor_sku, from: row.db_size, to: normSize(coveoSize) });
    }
  }

  console.log(`Match results:`);
  console.log(`  Matched: ${matched} (direct: ${directMatch}, fuzzy: ${fuzzyMatch})`);
  console.log(`  Unmatched: ${unmatched}`);
  console.log(`  Size mismatches: ${mismatched}`);
  console.log(`  Updates to apply (EDI-format only): ${updates.length}\n`);

  console.log('Top mismatch patterns:');
  const sorted = Object.entries(mismatchExamples).sort((a, b) => b[1] - a[1]).slice(0, 20);
  for (const [pattern, count] of sorted) {
    console.log(`  ${count.toString().padStart(4)}× ${pattern}`);
  }
  console.log();

  if (DRY_RUN) {
    console.log(`Dry run — no updates applied. All ${updates.length} planned updates:`);
    for (const u of updates) {
      console.log(`  ${u.vendor_sku}: ${u.from} → ${u.to}`);
    }
    await pool.end();
    return;
  }

  if (updates.length === 0) {
    console.log('No updates needed.');
    await pool.end();
    return;
  }

  console.log(`Applying ${updates.length} updates...`);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const u of updates) {
      await client.query(
        'UPDATE sku_attributes SET value = $1 WHERE sku_id = $2 AND attribute_id = $3',
        [u.to, u.sku_id, u.attribute_id]
      );
    }
    await client.query('COMMIT');
    console.log(`  Committed ${updates.length} updates.`);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  await pool.end();
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
