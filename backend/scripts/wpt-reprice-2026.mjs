/**
 * wpt-reprice-2026.mjs
 *
 * Full Western Pacific Tile (vendor code 807) reprice from the authoritative
 * "WPT XL Z1 5.01.2026" wholesale price list (effective Jul 1 2026, Zone 1).
 *
 * WHY: WPT's DB prices were a mix of good values and bad parses — many field
 * tiles carried per-SF costs that had been mis-divided or mis-imported (Norway
 * $1.49, Dorne $0.85, Materia Prima $0.14, Super White $0.80, Cypress Brown
 * $0.33, etc.). Rather than reason about the prior partial fixes, this repices
 * every SKU straight from the 2026 list.
 *
 * The list was transcribed (WPT-main pages 2-14; the separate Akua mosaic PDF is
 * NOT carried by us) and each active WPT SKU was matched to its list row by a
 * section-scoped, format/size-aware matcher. The resolved mapping is frozen in
 *   backend/data/wpt/wpt-reprice-2026.json
 * as one row per sku_id, so this apply step carries no fuzzy logic.
 *
 * Per row it sets:
 *   - pricing.cost        = list price
 *   - pricing.retail_price= keystone: nine-ending round-down of cost x 1.6
 *                           (covering floor cost+$0.99), matching upsertPricing
 *   - pricing.price_basis = per_sqft (U/M = SF) | per_unit (U/M = sheet/Each)
 *   - skus.sell_by        = box (SF) | unit (sheet/Each)
 *   - packaging.pieces_per_box / sqft_per_box from the list (only when the list
 *     row carries that value; a null in the list leaves the existing value)
 *
 * DROPS: none. Every active WPT SKU maps to a live 2026 list entry (spelling /
 * format variance only), so nothing is deactivated.
 * retail_locked rows are skipped.
 *
 *   node backend/scripts/wpt-reprice-2026.mjs            # dry run
 *   node backend/scripts/wpt-reprice-2026.mjs --commit   # apply
 */
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COMMIT = process.argv.includes('--commit');
const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

const rows = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/wpt/wpt-reprice-2026.json'), 'utf8'));

const { rows: v } = await pool.query("SELECT id FROM vendors WHERE code='807' AND name ILIKE '%western pacific%'");
if (!v.length) { console.error('WPT vendor not found'); process.exit(1); }

console.log(`=== WPT 2026 reprice — ${COMMIT ? 'COMMIT' : 'DRY RUN'} ===`);
console.log(`Reprice rows: ${rows.length}`);

// Guard: every sku_id must still be an active WPT sku, and report what changes.
const ids = rows.map(r => r.sku_id);
const { rows: live } = await pool.query(`
  SELECT s.id, s.sell_by, pr.cost, pr.retail_price, pr.price_basis
  FROM skus s JOIN products p ON p.id=s.product_id LEFT JOIN pricing pr ON pr.sku_id=s.id
  WHERE p.vendor_id=$1 AND s.status='active' AND s.id = ANY($2)`, [v[0].id, ids]);
const liveById = new Map(live.map(r => [r.id, r]));
const missing = rows.filter(r => !liveById.has(r.sku_id));
if (missing.length) console.log(`WARN: ${missing.length} mapped sku_ids no longer active WPT skus (skipped): ` +
  missing.slice(0,5).map(m=>m.name).join(', '));

let costChg=0, sellByChg=0, skipLocked=0;
for (const r of rows) {
  if (r.locked) { skipLocked++; continue; }
  const cur = liveById.get(r.sku_id);
  if (!cur) continue;
  if (Math.abs((+cur.cost||0) - r.cost) > 0.005) costChg++;
  if (cur.sell_by !== r.sell_by) sellByChg++;
}
console.log(`cost changes: ${costChg} | sell_by changes: ${sellByChg} | locked skipped: ${skipLocked}`);

if (!COMMIT) {
  console.log('\nBiggest cost corrections (|Δ| desc, top 15):');
  rows.filter(r=>!r.locked && liveById.has(r.sku_id))
    .map(r=>({r, d:r.cost-(+liveById.get(r.sku_id).cost||0)}))
    .sort((a,b)=>Math.abs(b.d)-Math.abs(a.d)).slice(0,15)
    .forEach(({r,d})=>console.log(`  ${r.name} ${r.variant}: $${(+liveById.get(r.sku_id).cost||0).toFixed(2)} -> $${r.cost.toFixed(2)} (retail $${r.retail.toFixed(2)}, ${r.sell_by})`));
  console.log('\nDry run — re-run with --commit to apply.');
  await pool.end(); process.exit(0);
}

const client = await pool.connect();
let applied = 0;
try {
  await client.query('BEGIN');
  for (const r of rows) {
    if (r.locked || !liveById.has(r.sku_id)) continue;
    await client.query(
      `UPDATE pricing SET cost=$2, retail_price=$3, price_basis=$4 WHERE sku_id=$1`,
      [r.sku_id, r.cost, r.retail, r.price_basis]);
    await client.query(`UPDATE skus SET sell_by=$2 WHERE id=$1`, [r.sku_id, r.sell_by]);
    if (r.pcs != null || r.sqft != null) {
      // upsert only the columns the list provides; keep existing otherwise
      await client.query(`
        INSERT INTO packaging (sku_id, pieces_per_box, sqft_per_box)
        VALUES ($1, $2, $3)
        ON CONFLICT (sku_id) DO UPDATE SET
          pieces_per_box = COALESCE(EXCLUDED.pieces_per_box, packaging.pieces_per_box),
          sqft_per_box   = COALESCE(EXCLUDED.sqft_per_box,   packaging.sqft_per_box)`,
        [r.sku_id, r.pcs, r.sqft]);
    }
    applied++;
  }
  await client.query('COMMIT');
} catch (e) {
  await client.query('ROLLBACK');
  console.error('ROLLBACK:', e.message);
  process.exit(1);
} finally {
  client.release();
}
console.log(`Applied ${applied} SKUs`);

// refresh search vectors
const { rows: prods } = await pool.query(
  'SELECT DISTINCT p.id FROM products p JOIN skus s ON s.product_id=p.id WHERE s.id = ANY($1)', [ids]);
for (const r of prods) await pool.query('SELECT refresh_search_vectors($1)', [r.id]).catch(()=>{});
console.log(`Refreshed search vectors (${prods.length} products)`);
await pool.end();
console.log('=== done ===');
