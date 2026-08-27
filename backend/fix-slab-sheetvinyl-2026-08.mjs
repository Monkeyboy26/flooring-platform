// Owner decisions 2026-08-26 (data quality follow-ups):
//
// A. Roca 63"x126" porcelain slabs (19 SKUs, currently box/per_sqft in
//    porcelain-tile) -> per-slab convention: category porcelain-slabs,
//    sell_by unit, price x sqft_per_box (55.11) as per_unit. Mirrors
//    scripts/migrate-slab-per-unit.mjs math. ROCA catalog was a one-time
//    import (only roca-inventory is scheduled), so no rescrape reverts this.
//
// B. Tri-West/Armstrong sheet vinyl (110 SKUs, sell_by='sqft', per_sqft,
//    no packaging) -> roll convention like carpet: sell_by roll, per_sqyd,
//    cost/retail x9, cut_price/cut_cost populated (storefront roll experience
//    keys off sell_by='roll' + cut_price). roll_width_ft left NULL — pull from
//    Tri-West when available; the missing-roll-width rule tracks it.
//
//   node fix-slab-sheetvinyl-2026-08.mjs --dry-run | --apply

import fs from 'fs';
import { pool } from './db.js';

const APPLY = process.argv.includes('--apply');
const backup = { roca_slabs: [], tw_sheet_vinyl: [] };

// A. Roca slabs
const slabs = await pool.query(`
  SELECT s.id AS sku_id, s.internal_sku, p.id AS product_id, p.name, s.variant_name,
         pr.cost, pr.retail_price, pk.sqft_per_box, c.slug AS category
  FROM skus s
  JOIN products p ON p.id = s.product_id
  JOIN vendors v ON v.id = p.vendor_id
  JOIN categories c ON c.id = p.category_id
  JOIN pricing pr ON pr.sku_id = s.id
  JOIN packaging pk ON pk.sku_id = s.id
  WHERE v.code = 'ROCA' AND s.status = 'active'
    AND pk.sqft_per_box >= 25 AND COALESCE(pk.pieces_per_box, 1) = 1
    AND s.sell_by = 'box' AND pr.price_basis = 'per_sqft'
`);
console.log(`A. Roca slabs: ${slabs.rows.length} SKUs`);
for (const r of slabs.rows.slice(0, 4)) {
  console.log(`   ${r.name} ${r.variant_name}: $${r.retail_price}/sf -> $${(r.retail_price * r.sqft_per_box).toFixed(2)}/slab`);
}

// B. TW sheet vinyl
const vinyl = await pool.query(`
  SELECT s.id AS sku_id, s.internal_sku, p.name, s.variant_name, pr.cost, pr.retail_price
  FROM skus s
  JOIN products p ON p.id = s.product_id
  JOIN vendors v ON v.id = p.vendor_id
  JOIN categories c ON c.id = p.category_id
  JOIN pricing pr ON pr.sku_id = s.id
  WHERE v.code = 'TW' AND c.slug = 'sheet-vinyl' AND s.status = 'active'
    AND s.sell_by = 'sqft' AND pr.price_basis = 'per_sqft'
`);
console.log(`B. TW sheet vinyl: ${vinyl.rows.length} SKUs`);
for (const r of vinyl.rows.slice(0, 4)) {
  console.log(`   ${r.name} ${r.variant_name}: $${r.retail_price}/sqft -> $${(r.retail_price * 9).toFixed(2)}/sqyd`);
}

if (!APPLY) { console.log('\nDry-run. Re-run with --apply.'); await pool.end(); process.exit(0); }

backup.roca_slabs = slabs.rows;
backup.tw_sheet_vinyl = vinyl.rows;

// A. apply: prices first (uses current per-sqft rate), then sell_by + category
const slabIds = slabs.rows.map(r => r.sku_id);
await pool.query(`
  UPDATE pricing pr SET
    retail_price = ROUND(pr.retail_price * pk.sqft_per_box, 2),
    cost = CASE WHEN pr.cost IS NOT NULL THEN ROUND(pr.cost * pk.sqft_per_box, 2) ELSE NULL END,
    price_basis = 'per_unit'
  FROM packaging pk
  WHERE pk.sku_id = pr.sku_id AND pr.sku_id = ANY($1)
`, [slabIds]);
await pool.query(`UPDATE skus SET sell_by = 'unit', updated_at = CURRENT_TIMESTAMP WHERE id = ANY($1)`, [slabIds]);
await pool.query(`
  UPDATE products SET category_id = (SELECT id FROM categories WHERE slug = 'porcelain-slabs'),
    updated_at = CURRENT_TIMESTAMP
  WHERE id IN (SELECT product_id FROM skus WHERE id = ANY($1))
`, [slabIds]);
console.log(`A. converted ${slabIds.length} slab SKUs (+ their products to porcelain-slabs)`);

// B. apply
const vinylIds = vinyl.rows.map(r => r.sku_id);
await pool.query(`
  UPDATE pricing pr SET
    retail_price = ROUND(pr.retail_price * 9, 2),
    cost = CASE WHEN pr.cost IS NOT NULL THEN ROUND(pr.cost * 9, 2) ELSE NULL END,
    cut_price = ROUND(pr.retail_price * 9, 2),
    cut_cost = CASE WHEN pr.cost IS NOT NULL THEN ROUND(pr.cost * 9, 2) ELSE NULL END,
    price_basis = 'per_sqyd'
  WHERE pr.sku_id = ANY($1)
`, [vinylIds]);
await pool.query(`UPDATE skus SET sell_by = 'roll', updated_at = CURRENT_TIMESTAMP WHERE id = ANY($1)`, [vinylIds]);
console.log(`B. converted ${vinylIds.length} sheet vinyl SKUs to roll/per_sqyd`);

const path = `./data/slab-sheetvinyl-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
fs.writeFileSync(path, JSON.stringify(backup, null, 2));
console.log(`Backup: ${path}`);
await pool.end();
