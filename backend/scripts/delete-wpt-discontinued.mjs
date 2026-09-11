/**
 * Hard-delete discontinued (status='inactive') Western Pacific Tile products.
 *
 * Removes the 12 discontinued WPT items entirely — product + SKU + pricing +
 * packaging + attributes + media + accessory links. Scoped to WPT products whose
 * EVERY SKU is inactive (never touches a product that still has an active SKU).
 * Guards: refuses to run if any target SKU is referenced by an order, cart,
 * estimate, PO, or credit memo. Writes a full JSON backup before deleting.
 *
 * Idempotent (nothing left to delete on re-run). Dry-run default; --apply commits.
 *   node backend/scripts/delete-wpt-discontinued.mjs [--apply]
 */
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const APPLY = process.argv.includes('--apply');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

async function main() {
  const vendor = (await pool.query(
    `SELECT id FROM vendors WHERE LOWER(name) LIKE '%western pacific%' OR code='807' LIMIT 1`)).rows[0];
  if (!vendor) throw new Error('WPT vendor not found');

  // Products whose EVERY sku is inactive (fully discontinued).
  const { rows: targets } = await pool.query(
    `SELECT p.id AS product_id, p.name
       FROM products p
      WHERE p.vendor_id = $1
        AND EXISTS (SELECT 1 FROM skus s WHERE s.product_id = p.id AND s.status = 'inactive')
        AND NOT EXISTS (SELECT 1 FROM skus s WHERE s.product_id = p.id AND s.status <> 'inactive')
      ORDER BY p.name`, [vendor.id]);
  if (!targets.length) { console.log('Nothing to delete — no fully-discontinued WPT products.'); await pool.end(); return; }

  const productIds = targets.map(t => t.product_id);
  const { rows: skuRows } = await pool.query(`SELECT id FROM skus WHERE product_id = ANY($1)`, [productIds]);
  const skuIds = skuRows.map(r => r.id);

  // Safety: refuse if any SKU is referenced by a transaction record.
  const refs = (await pool.query(`SELECT
      (SELECT count(*) FROM order_items WHERE sku_id = ANY($1)) AS orders,
      (SELECT count(*) FROM cart_items WHERE sku_id = ANY($1)) AS carts,
      (SELECT count(*) FROM estimate_items WHERE sku_id = ANY($1)) AS estimates,
      (SELECT count(*) FROM purchase_order_items WHERE sku_id = ANY($1)) AS pos,
      (SELECT count(*) FROM credit_memo_items WHERE sku_id = ANY($1)) AS credits`, [skuIds])).rows[0];
  const blocking = Object.entries(refs).filter(([, v]) => Number(v) > 0);
  if (blocking.length) { console.log('✗ ABORT — target SKUs referenced by:', blocking.map(([k, v]) => `${k}=${v}`).join(', ')); await pool.end(); return; }

  console.log(`\n${targets.length} fully-discontinued WPT products to delete:`);
  targets.forEach(t => console.log(`  - ${t.name}`));

  if (!APPLY) { console.log('\nDry run — pass --apply to commit.'); await pool.end(); return; }

  // Backup everything we're about to delete.
  const backup = { generated_at: new Date().toISOString(), vendor_id: vendor.id, products: targets, sku_ids: skuIds };
  for (const [key, sql, params] of [
    ['products', `SELECT * FROM products WHERE id = ANY($1)`, [productIds]],
    ['skus', `SELECT * FROM skus WHERE id = ANY($1)`, [skuIds]],
    ['pricing', `SELECT * FROM pricing WHERE sku_id = ANY($1)`, [skuIds]],
    ['packaging', `SELECT * FROM packaging WHERE sku_id = ANY($1)`, [skuIds]],
    ['sku_attributes', `SELECT * FROM sku_attributes WHERE sku_id = ANY($1)`, [skuIds]],
    ['media_assets', `SELECT * FROM media_assets WHERE sku_id = ANY($1) OR product_id = ANY($2)`, [skuIds, productIds]],
    ['sku_accessories', `SELECT * FROM sku_accessories WHERE parent_sku_id = ANY($1) OR accessory_sku_id = ANY($1)`, [skuIds]],
  ]) backup[key] = (await pool.query(sql, params)).rows;
  const backupPath = path.join(__dirname, '..', 'data', `wpt-discontinued-deleted-backup-${Date.now()}.json`);
  fs.writeFileSync(backupPath, JSON.stringify(backup, null, 2));
  console.log(`\nBackup: ${backupPath}`);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Child rows without ON DELETE CASCADE (cascade tables clear automatically on sku delete).
    await client.query(`DELETE FROM media_assets WHERE sku_id = ANY($1) OR product_id = ANY($2)`, [skuIds, productIds]);
    await client.query(`DELETE FROM sku_accessories WHERE parent_sku_id = ANY($1) OR accessory_sku_id = ANY($1)`, [skuIds]);
    await client.query(`DELETE FROM pricing WHERE sku_id = ANY($1)`, [skuIds]);
    await client.query(`DELETE FROM packaging WHERE sku_id = ANY($1)`, [skuIds]);
    await client.query(`DELETE FROM sku_attributes WHERE sku_id = ANY($1)`, [skuIds]);
    await client.query(`DELETE FROM skus WHERE id = ANY($1)`, [skuIds]);
    const del = await client.query(`DELETE FROM products WHERE id = ANY($1)`, [productIds]);
    await client.query('COMMIT');
    console.log(`\n✓ Deleted ${del.rowCount} products (${skuIds.length} SKUs) and all dependent rows.`);
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); await pool.end(); }
}
main().catch(e => { console.error(e); process.exit(1); });
