// Deactivate Mannington (MANN) SKUs dropped from the 11/06/2026 Acct-80985
// price lists: any still-active SKU whose vendor_sku appears in NONE of the
// parsed lists (field color codes, trim catalogs, roll catalogs). These are
// color-level discontinuations (verified: e.g. Pacaya Mesquite keeps
// Cinder/Lava/Sediment in the list, DB's Ash/Obsidian/Pumice are gone) plus
// their color-matched trims. See mannington-apply-pricelist-2026-11-06.mjs
// for the matching rationale.
//
// Products left with zero active SKUs are deactivated too (products don't
// auto-deactivate when their last sellable SKU dies — known integrity gap).
//
// Backups (idempotent drop+recreate):
//   skus_mann_dropped_deactivate_backup_20261106  (sku rows pre-update)
//   products_mann_dropped_deactivate_backup_20261106 (product rows pre-update)
//
//   docker exec -e DB_HOST=db flooring-api node data/mannington-deactivate-dropped-2026-11-06.mjs [--apply]

import pg from 'pg';
import fs from 'fs';

const { Pool } = pg;
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

const APPLY = process.argv.includes('--apply');
const VENDOR_ID = 'dabbf50b-c1ed-4e81-8bf1-c1ac88a5a4bd'; // Mannington
const SKU_BACKUP = 'skus_mann_dropped_deactivate_backup_20261106';
const PROD_BACKUP = 'products_mann_dropped_deactivate_backup_20261106';
const SRC = new URL('./mannington/mannington-pricelist-2026-11-06.json', import.meta.url).pathname;

// DB vendor_sku -> PDF color code where the PDF's own key format drifts
// (the list prints LWB06CT for Chestnut but LWB06AL1 for Almond — the DB's
// trailing-1 form is the same item, NOT a discontinuation).
const ALIASES = { LWB06CT1: 'LWB06CT' };

async function main() {
  const list = JSON.parse(fs.readFileSync(SRC, 'utf8'));
  const keys = new Set([
    ...list.fields.map(f => f.color_code),
    ...Object.keys(list.trims),
    ...list.rolls.map(r => r.catalog),
  ]);
  for (const [db, pdf] of Object.entries(ALIASES)) if (keys.has(pdf)) keys.add(db);
  console.log(`List keys: ${keys.size}`);

  const { rows: skus } = await pool.query(
    `SELECT s.id, s.vendor_sku, s.variant_name, s.sell_by, p.id AS product_id, p.name AS product_name
       FROM products p JOIN skus s ON s.product_id = p.id
      WHERE p.vendor_id = $1 AND s.status = 'active'
      ORDER BY p.name, s.vendor_sku`, [VENDOR_ID]);
  const drop = skus.filter(s => !keys.has(s.vendor_sku));
  const field = drop.filter(s => s.sell_by === 'box');
  console.log(`Active MANN SKUs: ${skus.length}; to deactivate: ${drop.length} (${field.length} field, ${drop.length - field.length} trims)`);

  const byProduct = {};
  for (const s of drop) (byProduct[s.product_name] ||= []).push(s);
  for (const [p, rows] of Object.entries(byProduct).sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${p}: ${rows.length}  (${rows.slice(0, 6).map(r => r.vendor_sku).join(', ')}${rows.length > 6 ? ', …' : ''})`);
  }

  // products that would end with zero active SKUs
  const dropIds = drop.map(s => s.id);
  const { rows: emptyProducts } = await pool.query(
    `SELECT p.id, p.name FROM products p
      WHERE p.vendor_id = $1 AND p.is_active
        AND NOT EXISTS (SELECT 1 FROM skus s WHERE s.product_id = p.id
                          AND s.status = 'active' AND s.id <> ALL($2::uuid[]))`,
    [VENDOR_ID, dropIds]);
  console.log(`Products ending with 0 active SKUs (will deactivate): ${emptyProducts.length}`);
  for (const p of emptyProducts) console.log(`  - ${p.name}`);

  if (!APPLY) {
    console.log('\nDRY RUN — re-run with --apply to back up + write.');
    await pool.end();
    return;
  }

  await pool.query(`DROP TABLE IF EXISTS ${SKU_BACKUP}`);
  await pool.query(`CREATE TABLE ${SKU_BACKUP} AS SELECT * FROM skus WHERE id = ANY($1::uuid[])`, [dropIds]);
  const { rowCount: skuCount } = await pool.query(
    `UPDATE skus SET status = 'inactive', updated_at = now() WHERE id = ANY($1::uuid[])`, [dropIds]);
  console.log(`Deactivated ${skuCount} SKUs (backup ${SKU_BACKUP}).`);

  const emptyIds = emptyProducts.map(p => p.id);
  if (emptyIds.length) {
    await pool.query(`DROP TABLE IF EXISTS ${PROD_BACKUP}`);
    await pool.query(`CREATE TABLE ${PROD_BACKUP} AS SELECT * FROM products WHERE id = ANY($1::uuid[])`, [emptyIds]);
    const { rowCount: pCount } = await pool.query(
      `UPDATE products SET is_active = false, updated_at = now() WHERE id = ANY($1::uuid[])`, [emptyIds]);
    console.log(`Deactivated ${pCount} zero-SKU products (backup ${PROD_BACKUP}).`);
  }

  const { rows: [after] } = await pool.query(
    `SELECT count(*) FILTER (WHERE s.status = 'active') AS active_skus,
            count(DISTINCT p.id) FILTER (WHERE p.is_active) AS active_products
       FROM products p JOIN skus s ON s.product_id = p.id WHERE p.vendor_id = $1`, [VENDOR_ID]);
  console.log(`After: ${after.active_skus} active SKUs, ${after.active_products} active products.`);
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
