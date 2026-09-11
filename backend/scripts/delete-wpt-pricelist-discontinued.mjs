/**
 * Hard-delete WPT products that appear on the July 2026 price list's explicit
 * "Discontinued Items" section (pp.12-14) and are NOT anywhere in its current
 * section — i.e. genuinely dropped colors, verified one by one against the list.
 *
 * (Distinct from delete-wpt-discontinued.mjs, which removed items already flagged
 * status='inactive'. These 19 are still 'active' in our DB but discontinued by
 * the vendor.) Matched by (collection, name). Aborts if any SKU is referenced by
 * an order/cart/estimate/PO/credit memo. Writes a JSON backup. Idempotent.
 *   node backend/scripts/delete-wpt-pricelist-discontinued.mjs [--apply]
 */
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const APPLY = process.argv.includes('--apply');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost', port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim', user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

// (collection, product name) — verified against the price list's Discontinued page.
const DISCONTINUED = [
  ['Bacara', 'Bacara Riviera Blend-BGL06'], ['Bacara', 'Bacara Summerland Blend-BGL04'],
  ['Bloom', 'Bloom Azahar Base'], ['Bloom', 'Bloom Azahar Deco'], ['Bloom', 'Bloom Sea Deco'],
  ['Bloom', 'Bloom Thyme Base'], ['Bloom', 'Bloom Thyme Deco'],
  ['Cotto', 'Cotto Ardesia Slate'], ['Cotto', 'Cotto Hideaway Alpine Grey'],
  ['Cotto', 'Cotto Hideaway Alpine Light Grey'], ['Cotto', 'Cotto Modello'],
  ['Dayton', 'Dayton Pearl'],
  ['Elements', 'Elements Honeycomb'], ['Elements', 'Elements Winsor'],
  ['Genesee', 'Genesee Black'],
  ['Reflections', 'Reflections Brighton'], ['Reflections', 'Reflections Charm'], ['Reflections', 'Reflections Silver'],
  ['Seasons', 'Seasons Winter Strips'],
  // Second pass — discontinued colors/decos whose current siblings stay (verified
  // by size/variant so the current versions are never caught):
  ['Lumen & Bloom', 'Lumen Beige'],       // disc "Lumen Beige 12x40" (Lumen Moon current)
  ['Retro', 'Retro Deco 2'],              // disc Retro 9x9 Deco 1/2/3 (Deco 4/7/8/Mix/Neutral current)
  ['Urban', 'Urban Deco 3'], ['Urban', 'Urban Deco 4'], ['Urban', 'Urban Deco 7'], // disc (Gris/Mix current)
  ['Waterways', 'Water Ways Sandy Beach'], // disc "Sandy Beach GSRA 03"
];

async function main() {
  const vendor = (await pool.query(`SELECT id FROM vendors WHERE LOWER(name) LIKE '%western pacific%' OR code='807' LIMIT 1`)).rows[0];
  if (!vendor) throw new Error('WPT vendor not found');

  const found = [];
  for (const [coll, name] of DISCONTINUED) {
    const rows = (await pool.query(
      `SELECT p.id AS product_id, p.name FROM products p WHERE p.vendor_id=$1 AND p.collection=$2 AND p.name=$3`,
      [vendor.id, coll, name])).rows;
    if (rows.length) found.push(...rows.map(r => ({ ...r, coll })));
  }
  if (!found.length) { console.log('Nothing to delete (already gone).'); await pool.end(); return; }

  const productIds = found.map(f => f.product_id);
  const skuIds = (await pool.query(`SELECT id FROM skus WHERE product_id = ANY($1)`, [productIds])).rows.map(r => r.id);
  const refs = (await pool.query(`SELECT
      (SELECT count(*) FROM order_items WHERE sku_id=ANY($1)) o,
      (SELECT count(*) FROM cart_items WHERE sku_id=ANY($1)) c,
      (SELECT count(*) FROM estimate_items WHERE sku_id=ANY($1)) e,
      (SELECT count(*) FROM purchase_order_items WHERE sku_id=ANY($1)) po,
      (SELECT count(*) FROM credit_memo_items WHERE sku_id=ANY($1)) cm`, [skuIds])).rows[0];
  const blocking = Object.entries(refs).filter(([, v]) => Number(v) > 0);

  console.log(`\n${found.length} discontinued WPT products matched:`);
  found.forEach(f => console.log(`  - ${f.coll} / ${f.name}`));
  if (blocking.length) { console.log('\n✗ ABORT — referenced by:', blocking.map(([k, v]) => `${k}=${v}`).join(', ')); await pool.end(); return; }
  const missing = DISCONTINUED.length - found.length;
  if (missing > 0) console.log(`(${missing} already absent)`);

  if (!APPLY) { console.log('\nDry run — pass --apply to commit.'); await pool.end(); return; }

  const backup = {};
  for (const [k, sql, pr] of [
    ['products', `SELECT * FROM products WHERE id=ANY($1)`, [productIds]],
    ['skus', `SELECT * FROM skus WHERE id=ANY($1)`, [skuIds]],
    ['pricing', `SELECT * FROM pricing WHERE sku_id=ANY($1)`, [skuIds]],
    ['packaging', `SELECT * FROM packaging WHERE sku_id=ANY($1)`, [skuIds]],
    ['sku_attributes', `SELECT * FROM sku_attributes WHERE sku_id=ANY($1)`, [skuIds]],
    ['media_assets', `SELECT * FROM media_assets WHERE sku_id=ANY($1) OR product_id=ANY($2)`, [skuIds, productIds]],
    ['sku_accessories', `SELECT * FROM sku_accessories WHERE parent_sku_id=ANY($1) OR accessory_sku_id=ANY($1)`, [skuIds]],
  ]) backup[k] = (await pool.query(sql, pr)).rows;
  const bp = path.join(__dirname, '..', 'data', `wpt-pricelist-discontinued-backup-${Date.now()}.json`);
  fs.writeFileSync(bp, JSON.stringify(backup, null, 2));
  console.log(`\nBackup: ${bp}`);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM media_assets WHERE sku_id=ANY($1) OR product_id=ANY($2)`, [skuIds, productIds]);
    await client.query(`DELETE FROM sku_accessories WHERE parent_sku_id=ANY($1) OR accessory_sku_id=ANY($1)`, [skuIds]);
    await client.query(`DELETE FROM pricing WHERE sku_id=ANY($1)`, [skuIds]);
    await client.query(`DELETE FROM packaging WHERE sku_id=ANY($1)`, [skuIds]);
    await client.query(`DELETE FROM sku_attributes WHERE sku_id=ANY($1)`, [skuIds]);
    await client.query(`DELETE FROM skus WHERE id=ANY($1)`, [skuIds]);
    const del = await client.query(`DELETE FROM products WHERE id=ANY($1)`, [productIds]);
    await client.query('COMMIT');
    console.log(`\n✓ Deleted ${del.rowCount} products (${skuIds.length} SKUs).`);
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); await pool.end(); }
}
main().catch(e => { console.error(e); process.exit(1); });
