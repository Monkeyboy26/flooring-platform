/**
 * audit-daltile-edi-prices.mjs
 *
 * Full-catalog EDI price freshness check for Daltile. The 6-hourly
 * daltile-edi-overlay only reprices SKUs present in daltile_edi_map; this
 * audit reconciles EVERY active priced DAL SKU against the current 832 feed:
 *
 *   1. Resolve each SKU's EDI twin: daltile_edi_map → exact vendor_sku →
 *      fuzzy (4-char color prefix + sorted dims, same rule daltile-unified
 *      uses at import).
 *   2. Compute the expected cost (per-sheet conversion for mosaics/stacked
 *      stone sold per_unit when the feed quotes per-SF).
 *   3. Classify: ok / stale (cost drifted) / no-edi-twin / sheet-unknown.
 *
 * --commit applies: cost + retail (keystone 1.6, nine-ending; retail_locked
 * rows keep their retail), and inserts newly-discovered twins into
 * daltile_edi_map so the nightly overlay maintains them from now on.
 * Slab/countertop quote-only SKUs (no pricing row) are left unpriced.
 *
 *   node backend/scripts/audit-daltile-edi-prices.mjs            # dry run
 *   node backend/scripts/audit-daltile-edi-prices.mjs --commit
 */
import pg from 'pg';
import { fetchEdiPriceMap } from '../scrapers/daltile-edi-overlay.js';
import { deriveSheetSqft } from '../scrapers/base.js';

const COMMIT = process.argv.includes('--commit');
const KEYSTONE = 1.6;
const nineEnding = (raw) => Math.round((Math.floor((raw - 0.09) / 0.10) * 0.10 + 0.09) * 100) / 100;

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

const { rows: vrows } = await pool.query(`SELECT id FROM vendors WHERE code='DAL'`);
const DAL = vrows[0].id;
const { rows: srcRows } = await pool.query(
  `SELECT * FROM vendor_sources WHERE scraper_key='daltile-edi-overlay' LIMIT 1`);
const source = srcRows[0] || { config: {} };

console.log('Fetching + parsing current EDI 832 feed…');
const ediMap = await fetchEdiPriceMap(source, null, pool);
console.log(`EDI feed: ${ediMap.size} priced SKUs`);

// Fuzzy index: 4-char color prefix + sorted dims (same as daltile-unified)
const ediFuzzy = new Map();
for (const [sku, v] of ediMap) {
  const dims = sku.match(/(\d{3,4})/g);
  if (!dims) continue;
  const key = `${sku.slice(0, 4)}:${dims.sort().join(',')}`;
  if (!ediFuzzy.has(key)) ediFuzzy.set(key, []);
  ediFuzzy.get(key).push(sku);
}

const { rows: skus } = await pool.query(`
  SELECT s.id, s.vendor_sku, s.sell_by, s.variant_type, c.slug AS category,
         pr.cost, pr.retail_price, pr.price_basis, COALESCE(pr.retail_locked,false) AS retail_locked,
         pk.sqft_per_box, pk.pieces_per_box, m.edi_vendor_sku AS mapped_edi
  FROM skus s
  JOIN products p ON p.id = s.product_id AND p.vendor_id = $1
  LEFT JOIN categories c ON c.id = p.category_id
  LEFT JOIN pricing pr ON pr.sku_id = s.id
  LEFT JOIN packaging pk ON pk.sku_id = s.id
  LEFT JOIN daltile_edi_map m ON m.live_vendor_sku = s.vendor_sku
  WHERE s.status = 'active' AND p.status = 'active'`, [DAL]);
console.log(`Active SKUs: ${skus.length}`);

const stats = { ok: 0, stale: 0, noTwin: 0, sheetUnknown: 0, quoteOnly: 0, newMapEntries: 0 };
const fixes = [];   // {id, vendor_sku, oldCost, newCost, newRetail, retail_locked, via}
const newMap = [];  // {live, edi, via}
const staleSamples = [];

for (const s of skus) {
  const vs = (s.vendor_sku || '').toUpperCase();
  const hasPrice = s.retail_price != null && parseFloat(s.retail_price) > 0;
  if (!hasPrice) { stats.quoteOnly++; continue; }   // slabs / quote-only — leave alone

  // Resolve EDI twin
  let ediSku = null, via = null;
  if (s.mapped_edi && ediMap.has(s.mapped_edi)) { ediSku = s.mapped_edi; via = 'map'; }
  else if (ediMap.has(vs)) { ediSku = vs; via = 'exact'; }
  else {
    // Fuzzy is stricter here than at import: same color prefix + dims AND the
    // same trailing finish/grade letters (after the last digit). Without the
    // tail check, VL72PLK624XTMT (textured 1st quality) fuzzy-hits
    // VL72PLK624MT (standard) or …XTMJ1 (J1 grade) and we'd reprice against
    // the wrong item.
    const dims = vs.match(/(\d{3,4})/g);
    if (dims) {
      const tail = (sku) => (sku.match(/[A-Z/]+$/) || [''])[0];
      const cands = (ediFuzzy.get(`${vs.slice(0, 4)}:${dims.sort().join(',')}`) || [])
        .filter(c => tail(c) === tail(vs));
      if (cands.length === 1) { ediSku = cands[0]; via = 'fuzzy'; }
    }
  }
  if (!ediSku) { stats.noTwin++; continue; }
  const ep = ediMap.get(ediSku);

  // Expected cost, with per-sheet conversion where the live row sells per sheet
  let effCost = ep.cost;
  const sellsPerSheet = s.price_basis === 'per_unit'
    && (s.category === 'mosaic-tile' || s.category === 'stacked-stone')
    && s.variant_type !== 'accessory';
  if (sellsPerSheet && ep.basis === 'per_sqft') {
    const sheetSqft = deriveSheetSqft(s.sqft_per_box, s.pieces_per_box)
      || deriveSheetSqft(ep.sqft_per_box, ep.pieces_per_box);
    if (!sheetSqft) { stats.sheetUnknown++; continue; }
    effCost = ep.cost * sheetSqft;
  } else if (!sellsPerSheet && s.price_basis === 'per_unit' && ep.basis === 'per_sqft'
             && s.variant_type !== 'accessory') {
    // live sells per piece but feed quotes per-SF with no sheet model — ambiguous, skip
    stats.sheetUnknown++; continue;
  }

  const newCost = Math.round(effCost * 100) / 100;
  const curCost = parseFloat(s.cost || 0);
  if (Math.abs(curCost - newCost) <= 0.02) {
    stats.ok++;
  } else {
    stats.stale++;
    const newRetail = s.retail_locked ? parseFloat(s.retail_price)
      : (newCost > 0 ? nineEnding(newCost * KEYSTONE) : 0);
    fixes.push({ id: s.id, vendor_sku: s.vendor_sku, oldCost: curCost, newCost, newRetail, via });
    if (staleSamples.length < 15) staleSamples.push(
      `${s.vendor_sku} [${via}] $${curCost} -> $${newCost} (retail ${s.retail_locked ? 'locked' : '$' + newRetail})`);
  }
  if (!s.mapped_edi && (via === 'exact' || via === 'fuzzy')) newMap.push({ live: s.vendor_sku, edi: ediSku, via });
}

console.log(`\nResults: ${stats.ok} up-to-date, ${stats.stale} stale, ${stats.noTwin} no EDI twin, `
  + `${stats.sheetUnknown} sheet-coverage-ambiguous, ${stats.quoteOnly} quote-only (skipped).`);
console.log(`New daltile_edi_map candidates: ${newMap.length}`);
if (staleSamples.length) { console.log('\nStale samples:'); for (const l of staleSamples) console.log(' ', l); }

if (COMMIT) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`CREATE TABLE IF NOT EXISTS daltile_overlay_backup (
      sku_id uuid, live_vendor_sku text, sell_by text, cost numeric, retail_price numeric,
      price_basis text, retail_locked boolean, backed_up_at timestamptz DEFAULT now())`);
    for (const f of fixes) {
      await client.query(
        `INSERT INTO daltile_overlay_backup (sku_id, live_vendor_sku, cost, retail_price, retail_locked)
         SELECT $1, $2, pr.cost, pr.retail_price, pr.retail_locked FROM pricing pr WHERE pr.sku_id = $1`,
        [f.id, f.vendor_sku]);
      await client.query(
        `UPDATE pricing SET cost = $2,
           retail_price = CASE WHEN retail_locked THEN retail_price ELSE $3 END
         WHERE sku_id = $1`, [f.id, f.newCost, f.newRetail]);
    }
    for (const nm of newMap) {
      await client.query(`
        INSERT INTO daltile_edi_map (live_vendor_sku, edi_vendor_sku, confidence, method, updated_at)
        VALUES ($1, $2, $3, 'price-audit', now())
        ON CONFLICT (live_vendor_sku) DO NOTHING`, [nm.live, nm.edi, nm.via]);
      stats.newMapEntries++;
    }
    await client.query('COMMIT');
    console.log(`\nApplied ${fixes.length} price fixes; added ${stats.newMapEntries} daltile_edi_map entries.`);
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
} else {
  console.log('\nDry run — re-run with --commit to apply.');
}
await pool.end();
