#!/usr/bin/env node
/**
 * activate-emser-tile.cjs
 *
 * Activates Emser tile products that have images and pricing, while keeping
 * sundries (Z-prefix SKUs) and imageless products as draft.
 *
 * Usage:
 *   node backend/scripts/activate-emser-tile.cjs --dry-run
 *   node backend/scripts/activate-emser-tile.cjs
 */

const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  console.log(`\n=== Activate Emser Tile Products ${DRY_RUN ? '(DRY RUN)' : '(LIVE)'} ===\n`);

  // 1. Find the Emser vendor
  const vendorRes = await pool.query("SELECT id, name FROM vendors WHERE code = 'EMSER'");
  if (vendorRes.rows.length === 0) {
    console.error('Vendor EMSER not found');
    process.exit(1);
  }
  const vendorId = vendorRes.rows[0].id;
  console.log(`Vendor: ${vendorRes.rows[0].name} (${vendorId})`);

  // 2. Count current state
  const statusRes = await pool.query(`
    SELECT status, COUNT(*) as cnt
    FROM products WHERE vendor_id = $1
    GROUP BY status ORDER BY status
  `, [vendorId]);
  console.log('\nCurrent product status breakdown:');
  for (const r of statusRes.rows) {
    console.log(`  ${r.status}: ${r.cnt}`);
  }

  // 3. Find draft products eligible for activation:
  //    - Has at least one non-Z-prefix SKU (real tile, not sundry)
  //    - Has at least one media_asset (has images)
  //    - Has at least one SKU with pricing
  const eligibleRes = await pool.query(`
    SELECT p.id, p.name, p.collection
    FROM products p
    WHERE p.vendor_id = $1
      AND p.status = 'draft'
      AND EXISTS (
        SELECT 1 FROM skus s
        WHERE s.product_id = p.id
          AND s.vendor_sku NOT LIKE 'Z%'
      )
      AND EXISTS (
        SELECT 1 FROM media_assets ma
        WHERE ma.product_id = p.id
      )
      AND EXISTS (
        SELECT 1 FROM skus s
        JOIN pricing pr ON pr.sku_id = s.id
        WHERE s.product_id = p.id
      )
    ORDER BY p.collection, p.name
  `, [vendorId]);

  const toActivate = eligibleRes.rows;
  console.log(`\nProducts eligible for activation: ${toActivate.length}`);

  // 4. Breakdown of what stays draft
  const sundryCountRes = await pool.query(`
    SELECT COUNT(DISTINCT p.id) as cnt
    FROM products p
    WHERE p.vendor_id = $1
      AND p.status = 'draft'
      AND NOT EXISTS (
        SELECT 1 FROM skus s
        WHERE s.product_id = p.id
          AND s.vendor_sku NOT LIKE 'Z%'
      )
  `, [vendorId]);

  const noImageCountRes = await pool.query(`
    SELECT COUNT(DISTINCT p.id) as cnt
    FROM products p
    WHERE p.vendor_id = $1
      AND p.status = 'draft'
      AND EXISTS (
        SELECT 1 FROM skus s
        WHERE s.product_id = p.id
          AND s.vendor_sku NOT LIKE 'Z%'
      )
      AND NOT EXISTS (
        SELECT 1 FROM media_assets ma
        WHERE ma.product_id = p.id
      )
  `, [vendorId]);

  const noPricingCountRes = await pool.query(`
    SELECT COUNT(DISTINCT p.id) as cnt
    FROM products p
    WHERE p.vendor_id = $1
      AND p.status = 'draft'
      AND EXISTS (
        SELECT 1 FROM skus s
        WHERE s.product_id = p.id
          AND s.vendor_sku NOT LIKE 'Z%'
      )
      AND EXISTS (
        SELECT 1 FROM media_assets ma
        WHERE ma.product_id = p.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM skus s
        JOIN pricing pr ON pr.sku_id = s.id
        WHERE s.product_id = p.id
      )
  `, [vendorId]);

  console.log(`\nBreakdown of draft products:`);
  console.log(`  Sundries (Z-prefix only):       ${sundryCountRes.rows[0].cnt}`);
  console.log(`  Tile without images:             ${noImageCountRes.rows[0].cnt}`);
  console.log(`  Tile with images, no pricing:    ${noPricingCountRes.rows[0].cnt}`);
  console.log(`  Tile ready to activate:          ${toActivate.length}`);

  // Show sample of what will be activated
  console.log(`\nSample products to activate (first 15):`);
  for (const p of toActivate.slice(0, 15)) {
    console.log(`  ${p.collection} — ${p.name}`);
  }
  if (toActivate.length > 15) console.log(`  ... and ${toActivate.length - 15} more`);

  if (DRY_RUN) {
    console.log('\nDRY RUN — no changes made. Remove --dry-run to execute.\n');
    await pool.end();
    return;
  }

  // 5. Activate products and refresh search vectors
  const productIds = toActivate.map(p => p.id);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Batch activate
    const activateRes = await client.query(`
      UPDATE products SET status = 'active', updated_at = NOW()
      WHERE id = ANY($1)
    `, [productIds]);

    console.log(`\nActivated ${activateRes.rowCount} products.`);

    // Refresh search vectors for all activated products
    console.log('Refreshing search vectors...');
    let vectorCount = 0;
    for (const pid of productIds) {
      await client.query('SELECT refresh_search_vectors($1)', [pid]);
      vectorCount++;
      if (vectorCount % 100 === 0) {
        process.stdout.write(`  ${vectorCount}/${productIds.length}\r`);
      }
    }
    console.log(`  Refreshed ${vectorCount} search vectors.`);

    await client.query('COMMIT');
    console.log('Transaction committed successfully.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Transaction rolled back:', err.message);
    process.exit(1);
  } finally {
    client.release();
  }

  // 6. Print final state
  const finalRes = await pool.query(`
    SELECT status, COUNT(*) as cnt
    FROM products WHERE vendor_id = $1
    GROUP BY status ORDER BY status
  `, [vendorId]);
  console.log('\nFinal product status breakdown:');
  for (const r of finalRes.rows) {
    console.log(`  ${r.status}: ${r.cnt}`);
  }
  console.log('');

  await pool.end();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
