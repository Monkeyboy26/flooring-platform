/**
 * Roca USA — Data Cleanup Pass 2
 *
 * Fixes remaining short product names:
 * 1. Merge Downtown "Bl"→"Blanco", "Gr"→"Grey" (move accessory SKUs to parent)
 * 2. Merge Limestone "Ar"→"Arena", "Gr"→"Gris" (move field SKUs to parent)
 * 3. Expand: Cc Mosaics "Mg"→"Mesh Glass", Rockart "Bw"→"Black White"
 * 4. Expand: Terrain "Abs"→"Absolute", "Mt"→"Matte"
 * 5. Expand: Terra di Siena "Abs"→"Absolute"
 *
 * Usage: node backend/scripts/roca-cleanup2.js
 */
import pg from 'pg';

const pool = new pg.Pool({
  host: 'localhost', port: 5432, database: 'flooring_pim',
  user: 'postgres', password: 'postgres',
});

async function mergeProduct(client, vendorId, collection, fromName, toName) {
  // Get product IDs
  const fromRes = await client.query(
    'SELECT id FROM products WHERE vendor_id = $1 AND collection = $2 AND name = $3',
    [vendorId, collection, fromName]
  );
  const toRes = await client.query(
    'SELECT id FROM products WHERE vendor_id = $1 AND collection = $2 AND name = $3',
    [vendorId, collection, toName]
  );
  if (!fromRes.rows.length || !toRes.rows.length) {
    console.log(`   SKIP: ${collection} "${fromName}"→"${toName}" (not found)`);
    return 0;
  }
  const fromId = fromRes.rows[0].id;
  const toId = toRes.rows[0].id;

  // Move SKUs: update product_id and fix variant_name
  const moved = await client.query(`
    UPDATE skus SET
      product_id = $1,
      variant_name = regexp_replace(variant_name, $3, $4)
    WHERE product_id = $2
    RETURNING id, variant_name
  `, [toId, fromId, '^' + fromName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), toName]);

  // Move any media_assets
  await client.query(
    'UPDATE media_assets SET product_id = $1 WHERE product_id = $2',
    [toId, fromId]
  );

  // Delete the empty product
  await client.query('DELETE FROM products WHERE id = $1', [fromId]);

  console.log(`   ${collection}: "${fromName}" → "${toName}" (${moved.rowCount} SKUs moved)`);
  return moved.rowCount;
}

async function renameProduct(client, vendorId, collection, fromName, toName) {
  const res = await client.query(`
    UPDATE products SET name = $1
    WHERE vendor_id = $2 AND collection = $3 AND name = $4
    RETURNING id
  `, [toName, vendorId, collection, fromName]);
  if (!res.rows.length) {
    console.log(`   SKIP: ${collection} "${fromName}" (not found)`);
    return 0;
  }
  const productId = res.rows[0].id;

  // Fix variant names
  await client.query(`
    UPDATE skus SET variant_name = regexp_replace(variant_name, $1, $2)
    WHERE product_id = $3
  `, ['^' + fromName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), toName, productId]);

  // Fix sku_attributes color value
  await client.query(`
    UPDATE sku_attributes SET value = $1
    WHERE sku_id IN (SELECT id FROM skus WHERE product_id = $2)
      AND attribute_id = 'd50e8400-e29b-41d4-a716-446655440001'
      AND value = $3
  `, [toName, productId, fromName]);

  console.log(`   ${collection}: "${fromName}" → "${toName}"`);
  return 1;
}

async function run() {
  const client = await pool.connect();
  const vendorRes = await client.query("SELECT id FROM vendors WHERE code = 'ROCA'");
  const vendorId = vendorRes.rows[0].id;

  try {
    await client.query('BEGIN');

    // 1. Merge abbreviations into full-named products
    console.log('\n1. Merging abbreviated products into full-named parents:');
    await mergeProduct(client, vendorId, 'Downtown', 'Bl', 'Blanco');
    await mergeProduct(client, vendorId, 'Downtown', 'Gr', 'Grey');
    await mergeProduct(client, vendorId, 'Limestone', 'Ar', 'Arena');
    await mergeProduct(client, vendorId, 'Limestone', 'Gr', 'Gris');

    // 2. Rename remaining short names
    console.log('\n2. Expanding remaining short names:');
    await renameProduct(client, vendorId, 'Cc Mosaics', 'Mg', 'Mesh Glass');
    await renameProduct(client, vendorId, 'Rockart', 'Bw', 'Black White');
    await renameProduct(client, vendorId, 'Terrain', 'Abs', 'Absolute');
    await renameProduct(client, vendorId, 'Terrain', 'Mt', 'Matte');
    await renameProduct(client, vendorId, 'Terra di Siena', 'Abs', 'Absolute');

    await client.query('COMMIT');

    // Verification
    console.log('\n═══ Verification ═══');
    const v = await client.query(`
      SELECT
        (SELECT count(*) FROM products p JOIN vendors v ON p.vendor_id = v.id WHERE v.code = 'ROCA') as products,
        (SELECT count(*) FROM skus s JOIN products p ON s.product_id = p.id JOIN vendors v ON p.vendor_id = v.id WHERE v.code = 'ROCA') as skus,
        (SELECT count(*) FROM products p JOIN vendors v ON p.vendor_id = v.id WHERE v.code = 'ROCA' AND length(p.name) <= 2) as short_names,
        (SELECT count(*) FROM products p JOIN vendors v ON p.vendor_id = v.id LEFT JOIN skus s ON s.product_id = p.id WHERE v.code = 'ROCA' AND s.id IS NULL) as orphans
    `);
    const r = v.rows[0];
    console.log(`Products:        ${r.products}`);
    console.log(`SKUs:            ${r.skus}`);
    console.log(`Short names:     ${r.short_names} (should be 0)`);
    console.log(`Orphan products: ${r.orphans} (should be 0)`);

  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch(err => { console.error(err); process.exit(1); });
