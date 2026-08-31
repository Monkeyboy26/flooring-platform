#!/usr/bin/env node
/**
 * fix-bardiglio-dal-trim.mjs — two spot fixes from the 2026-08-31 catalog sweep.
 *
 * 1. AZT Bardiglio (14 SKUs): stale FLAT prices — every field size $11.15/pc
 *    (a per-SF rate stored per-piece: same price for a 2x8, 12x12 and 18x18)
 *    and every mosaic shape $9.85 regardless of sheet. The line is delisted:
 *    arizonatile.com/product/bardiglio-special-order/ is a 404 and the 2026
 *    price book carries none of our sizes/finishes (only polished 12x24/4x16
 *    field we don't stock, trims, and a discontinued mini brick). Per AZT
 *    policy (price-list-only, "Call for Price" on no match — same as the 466
 *    Daltile slabs) → DELETE the stale pricing rows so they show Call for
 *    Price. Lifecycle (deactivation) stays with the scraper's safety pass.
 *
 * 2. DAL M474112PRHN (Venetian Calacatta 0.75x12 pencil rail, Honed): cost
 *    $40.86 / retail $65.29 is a scrape error — the same item retails at
 *    $8–12/pc at Daltile dealers, and the product's own sibling 0.75x12
 *    pencils (White Cliffs / Emperador Dark, polished) cost $15.28 → align
 *    to the sibling rate ($15.28 cost, keystone retail). Not in
 *    daltile_edi_map, so no EDI overlay will fight this.
 *
 * Usage: node scripts/fix-bardiglio-dal-trim.mjs [--apply]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';
import { upsertPricing } from '../scrapers/base.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APPLY = process.argv.includes('--apply');
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/flooring_pim',
});

const BARDIGLIO_SKUS = [
  '338354', '335035', '335036',                                  // tumbled field 12x12/18x18/2x8
  '318965', '318966', '318967', '318968', '318969',              // mosaics (flat 9.85)
  '318970', '318971', '318972', '318973', '318974', '318975',
];

async function main() {
  console.log(`\n=== Bardiglio call-for-price + DAL trim fix (${APPLY ? 'APPLY' : 'DRY RUN'}) ===\n`);

  const { rows: bard } = await pool.query(`
    SELECT s.id AS sku_id, s.vendor_sku, p.name, s.variant_name, pr.cost, pr.retail_price
    FROM skus s JOIN products p ON p.id=s.product_id JOIN vendors v ON v.id=p.vendor_id
    JOIN pricing pr ON pr.sku_id=s.id
    WHERE v.code='AZT' AND s.vendor_sku = ANY($1)`, [BARDIGLIO_SKUS]);
  for (const b of bard) {
    console.log(`  AZT ${b.vendor_sku}  ${b.name} — ${b.variant_name}: $${b.cost}/$${b.retail_price} → Call for Price`);
  }

  const { rows: dal } = await pool.query(`
    SELECT s.id AS sku_id, s.vendor_sku, p.name, s.variant_name, pr.cost, pr.retail_price
    FROM skus s JOIN products p ON p.id=s.product_id JOIN vendors v ON v.id=p.vendor_id
    LEFT JOIN pricing pr ON pr.sku_id=s.id
    WHERE v.code='DAL' AND s.vendor_sku='M474112PRHN'`);
  for (const d of dal) {
    console.log(`  DAL ${d.vendor_sku}  ${d.variant_name}: cost ${d.cost}→15.28, retail ${d.retail_price}→~24.39`);
  }

  console.log(`\n${bard.length} Bardiglio pricing rows to clear, ${dal.length} DAL trim fix.`);
  if (!APPLY) { console.log('Dry run — re-run with --apply.'); await pool.end(); return; }

  const backupName = `bardiglio-daltrim-backup-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
  let backupPath = path.join(__dirname, `../data/${backupName}`);
  const backupJson = JSON.stringify({ bardiglio: bard, dal }, null, 1);
  try { fs.writeFileSync(backupPath, backupJson); }
  catch { backupPath = path.join('/tmp', backupName); fs.writeFileSync(backupPath, backupJson); }
  console.log(`Backup: ${backupPath}`);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (bard.length) {
      await client.query(`DELETE FROM pricing WHERE sku_id = ANY($1)`, [bard.map(b => b.sku_id)]);
    }
    for (const d of dal) {
      await upsertPricing(client, d.sku_id, {
        cost: 15.28, retail_price: 24.45, price_basis: 'per_unit', map_price: null,
      }); // nine-ends to 24.39, matching the sibling pencils
    }
    await client.query('COMMIT');
    console.log(`Applied: ${bard.length} pricing rows deleted, ${dal.length} trim repriced.`);
  } catch (err) { await client.query('ROLLBACK'); throw err; }
  finally { client.release(); }
  await pool.end();
}
main().catch(err => { console.error(err); process.exit(1); });
