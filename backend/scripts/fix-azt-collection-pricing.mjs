#!/usr/bin/env node
/**
 * fix-azt-collection-pricing.mjs
 *
 * Targeted, price-list-authoritative repair of Arizona Tile products whose SKUs
 * collapsed onto one shared price (a field plank + a per-sheet mesh grouped under
 * one product both took the plank's per-SF price). Symptoms: Bio Attitude 8x48
 * plank sold per-piece BELOW cost, its 1x24 stacked-stone mesh sold at $5.79
 * instead of $18.89/sheet; Calacatta Umber Hexagon + Bianco Carrara Penny Round
 * flattened to a wrong shared price.
 *
 * Every corrected value comes from backend/data/arizona/tile-prices.xlsx via the
 * same rules the importer uses (scrapers/arizona.js:planFromPriceList): SHT/EA →
 * unit/per_unit at net price; SF in a unit category → per-piece (net × sf/pc);
 * SF field tile → box/per_sqft. Retail is recomputed by upsertPricing (keystone
 * 1.6x, nine-ending, covering floor). Trim (ROCA bullnose, BLZ jolly, ELY
 * bullnose) is intentionally NOT touched — per-piece trim priced ~= field
 * per-sqft is legitimate, not this bug.
 *
 * Usage:
 *   node scripts/fix-azt-collection-pricing.mjs           # dry run
 *   node scripts/fix-azt-collection-pricing.mjs --apply   # write (with backup)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';
import { upsertPricing } from '../scrapers/base.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APPLY = process.argv.includes('--apply');
const WOOD_LOOK_TILE = '650e8400-e29b-41d4-a716-446655440015';
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/flooring_pim',
});
const r2 = v => Math.round(v * 100) / 100;

// Authoritative per-SKU corrections keyed by AZT vendor_sku. cost/sell_by/basis/
// packaging straight from the price list; retail left to upsertPricing.
// moveCategory (product-level) only where the product is truly miscategorized.
const FIX = [
  // Bio Attitude 8x48 wood-look plank — was stacked-stone/unit/per_unit @ $3.67/pc (below cost)
  ...['327821', '327823', '327825', '327827', '327829'].map(v => ({
    vendor_sku: v, sell_by: 'box', price_basis: 'per_sqft', cost: 3.67,
    sqft_per_box: 15.4944, pieces_per_box: 6, coveringFloor: true, moveCategory: WOOD_LOOK_TILE,
  })),
  // Bio Attitude Straight Stack 1x24 Mesh — SHT @ $18.89/sheet (was $3.67)
  ...['329018', '329020', '329022', '329024', '329026'].map(v => ({
    vendor_sku: v, sell_by: 'unit', price_basis: 'per_unit', cost: 18.89,
    sqft_per_box: 11.6208, pieces_per_box: 6, coveringFloor: true,
  })),
  // Bio Attitude Hex 16x18 Mesh — price already right ($23.11); backfill packaging
  ...['329017', '329019', '329021', '329023', '329025'].map(v => ({
    vendor_sku: v, sell_by: 'unit', price_basis: 'per_unit', cost: 23.11,
    sqft_per_box: 5.918, pieces_per_box: 4, coveringFloor: true,
  })),
  // Calacatta Umber Hexagon — flattened to $16.70; real list values differ
  { vendor_sku: '117950', sell_by: 'unit', price_basis: 'per_unit', cost: 11.53,   // 2x2 Hex Mesh (SHT)
    sqft_per_box: 4.84, pieces_per_box: 5, coveringFloor: true },
  { vendor_sku: '117938', sell_by: 'unit', price_basis: 'per_unit', cost: r2(12.58 * 0.3849), // 8x8 Hex (SF→per-piece) = 4.84
    sqft_per_box: 3.849, pieces_per_box: 10, coveringFloor: true },
  // Bianco Carrara Penny Round 3/4 Mesh — $13.94 → $17.84/sheet (SHT)
  { vendor_sku: '337403', sell_by: 'unit', price_basis: 'per_unit', cost: 17.84,
    sqft_per_box: 4.4905, pieces_per_box: 5, coveringFloor: true },
];

async function main() {
  console.log(`\n=== AZT collection pricing fix (${APPLY ? 'APPLY' : 'DRY RUN'}) ===\n`);
  const skus = new Map();
  const { rows } = await pool.query(`
    SELECT s.id AS sku_id, s.vendor_sku, s.product_id, p.name, s.variant_name,
           s.sell_by, pr.price_basis, pr.cost, pr.retail_price, pk.sqft_per_box, pk.pieces_per_box, p.category_id
    FROM skus s JOIN products p ON p.id=s.product_id JOIN vendors v ON v.id=p.vendor_id
    LEFT JOIN pricing pr ON pr.sku_id=s.id LEFT JOIN packaging pk ON pk.sku_id=s.id
    WHERE v.code='AZT' AND s.vendor_sku = ANY($1)`, [FIX.map(f => f.vendor_sku)]);
  for (const r of rows) skus.set(r.vendor_sku, r);

  const plan = [];
  for (const f of FIX) {
    const cur = skus.get(f.vendor_sku);
    if (!cur) { console.log(`  ! vendor_sku ${f.vendor_sku} not found — skipped`); continue; }
    const retail = r2(f.cost * 1.6); // keystone; upsertPricing nine-ends + floors it
    plan.push({ ...f, cur, retail });
  }

  for (const p of plan) {
    const c = p.cur;
    console.log(
      `${p.vendor_sku}  ${c.name} — ${c.variant_name}`.padEnd(58) +
      ` cost ${c.cost}→${p.cost}` +
      ` ${c.sell_by}/${c.price_basis}→${p.sell_by}/${p.price_basis}` +
      ` sfbx ${c.sqft_per_box ?? '∅'}→${p.sqft_per_box}` +
      (p.moveCategory && c.category_id !== p.moveCategory ? '  [→wood-look-tile]' : ''));
  }

  if (!APPLY) { console.log(`\n${plan.length} SKUs planned. Dry run — nothing written. Re-run with --apply.`); await pool.end(); return; }

  const backupName = `azt-collection-pricing-backup-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
  let backupPath = path.join(__dirname, `../data/${backupName}`);
  const backupJson = JSON.stringify(plan.map(p => p.cur), null, 1);
  try { fs.writeFileSync(backupPath, backupJson); }
  catch { backupPath = path.join('/tmp', backupName); fs.writeFileSync(backupPath, backupJson); }
  console.log(`\nBackup: ${backupPath}`);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const movedProducts = new Set();
    for (const p of plan) {
      if (p.moveCategory && p.cur.category_id !== p.moveCategory && !movedProducts.has(p.cur.product_id)) {
        await client.query('UPDATE products SET category_id=$2, updated_at=NOW() WHERE id=$1', [p.cur.product_id, p.moveCategory]);
        movedProducts.add(p.cur.product_id);
      }
      if (p.cur.sell_by !== p.sell_by) {
        await client.query('UPDATE skus SET sell_by=$2, updated_at=NOW() WHERE id=$1', [p.cur.sku_id, p.sell_by]);
      }
      await upsertPricing(client, p.cur.sku_id, {
        cost: p.cost, retail_price: p.retail, price_basis: p.price_basis, map_price: null,
      }, { coveringFloor: p.coveringFloor === true });
      await client.query(`
        INSERT INTO packaging (sku_id, sqft_per_box, pieces_per_box) VALUES ($1,$2,$3)
        ON CONFLICT (sku_id) DO UPDATE SET sqft_per_box=EXCLUDED.sqft_per_box, pieces_per_box=EXCLUDED.pieces_per_box
      `, [p.cur.sku_id, p.sqft_per_box, p.pieces_per_box]);
    }
    await client.query('COMMIT');
    console.log(`Applied ${plan.length} SKU fixes (${movedProducts.size} products recategorized).`);
  } catch (err) { await client.query('ROLLBACK'); throw err; }
  finally { client.release(); }
  await pool.end();
}
main().catch(err => { console.error(err); process.exit(1); });
