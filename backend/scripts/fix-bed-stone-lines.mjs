#!/usr/bin/env node
/**
 * fix-bed-stone-lines.mjs
 *
 * Five Bedrosians natural-stone LINES (field tile + pavers + one hex-mosaic
 * variant each) sat whole in mosaic-tile — the BED variant of the AZT "Gem"
 * bug. Surfaced when fix-bed-zero-cost.mjs gave their field SKUs real costs
 * and the mosaic-not-per-sheet rule flagged the per-sqft rows.
 *
 *  • Durango / Iceberg White / Glorious White / Silver Cream → natural-stone
 *  • Ashen Grey (marble ledger line) → stacked-stone
 *  • Field SKUs with real box packaging were sell_by=unit → box (unit +
 *    per_sqft + BOX-sized packaging would display piece price = rate × box!)
 *  • Durango 16x24 / 24x24 tumbled pavers (no packaging) → per-piece stone
 *    model: keep unit/per_sqft, add packaging(piece area, 1)
 *
 * Idempotent. Usage: node scripts/fix-bed-stone-lines.mjs --apply (dry default)
 */
import pg from 'pg';
const APPLY = process.argv.includes('--apply');
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/flooring_pim',
});

const MOVES = [
  { name: 'Durango', to: 'natural-stone' },
  { name: 'Iceberg White', to: 'natural-stone' },
  { name: 'Glorious White', to: 'natural-stone' },
  { name: 'Silver Cream', to: 'natural-stone' },
  { name: 'Ashen Grey', to: 'stacked-stone' },
];
const TO_BOX = ['MRBASHGRY1224H', '100000514', 'MRBGLOWHT0312B', '100000917', 'MRBICEBRG1224B', '100002121'];
const PIECE_PKG = [
  { vendor_sku: '100000522', sf: 2.6667, pcs: 1 },  // Durango 16x24 tumbled paver
  { vendor_sku: '100000523', sf: 4.0, pcs: 1 },     // Durango 24x24 tumbled paver
];

async function main() {
  console.log(`\n=== BED stone lines out of mosaic-tile (${APPLY ? 'APPLY' : 'DRY RUN'}) ===\n`);
  const bed = (await pool.query(`SELECT id FROM vendors WHERE code='BED'`)).rows[0].id;
  const cats = Object.fromEntries((await pool.query(
    `SELECT slug, id FROM categories WHERE slug IN ('natural-stone','stacked-stone')`)).rows.map(r => [r.slug, r.id]));

  for (const m of MOVES) {
    const { rows } = await pool.query(`
      SELECT p.id, c.slug FROM products p JOIN categories c ON c.id=p.category_id
      WHERE p.vendor_id=$1 AND p.name=$2 AND p.collection=$2 AND p.is_active`, [bed, m.name]);
    for (const r of rows) {
      console.log(`  ${m.name}: ${r.slug} → ${m.to}${r.slug === m.to ? ' (already)' : ''}`);
      if (APPLY && r.slug !== m.to) {
        await pool.query(`UPDATE products SET category_id=$2, updated_at=NOW() WHERE id=$1`, [r.id, cats[m.to]]);
      }
    }
  }
  for (const v of TO_BOX) {
    const { rows } = await pool.query(`
      SELECT s.id, s.sell_by FROM skus s JOIN products p ON p.id=s.product_id
      WHERE p.vendor_id=$1 AND s.vendor_sku=$2`, [bed, v]);
    for (const r of rows) {
      console.log(`  ${v}: sell_by ${r.sell_by} → box${r.sell_by === 'box' ? ' (already)' : ''}`);
      if (APPLY && r.sell_by !== 'box') {
        await pool.query(`UPDATE skus SET sell_by='box', updated_at=NOW() WHERE id=$1`, [r.id]);
      }
    }
  }
  for (const p of PIECE_PKG) {
    const { rows } = await pool.query(`
      SELECT s.id FROM skus s JOIN products pr ON pr.id=s.product_id
      WHERE pr.vendor_id=$1 AND s.vendor_sku=$2`, [bed, p.vendor_sku]);
    for (const r of rows) {
      console.log(`  ${p.vendor_sku}: packaging → ${p.sf}sf/1pc (per-piece paver)`);
      if (APPLY) {
        await pool.query(`
          INSERT INTO packaging (sku_id, sqft_per_box, pieces_per_box) VALUES ($1,$2,$3)
          ON CONFLICT (sku_id) DO UPDATE SET sqft_per_box=EXCLUDED.sqft_per_box, pieces_per_box=EXCLUDED.pieces_per_box
        `, [r.id, p.sf, p.pcs]);
      }
    }
  }
  console.log(APPLY ? '\nApplied.' : '\nDry run — re-run with --apply.');
  await pool.end();
}
main().catch(e => { console.error(e); process.exit(1); });
