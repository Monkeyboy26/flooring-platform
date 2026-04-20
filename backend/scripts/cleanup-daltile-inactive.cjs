#!/usr/bin/env node
/**
 * Cleanup Daltile Inactive Products & SKUs
 *
 * Deletes inactive DAL products and SKUs plus all their dependent records.
 * Handles FK references from historical tables (order_items, quote_items, etc.)
 * by setting them to NULL before deleting.
 *
 * Deletion order (respects FK constraints):
 *   1. NULL out historical FK references (order_items, quote_items, etc.)
 *   2. sku_attributes
 *   3. media_assets (SKU-level)
 *   4. pricing
 *   5. packaging
 *   6. cart_items
 *   7. inventory_snapshots
 *   8. stock_alerts
 *   9. trade_favorite_items
 *  10. skus
 *  11. media_assets (product-level)
 *  12. product_tags
 *  13. wishlists
 *  14. products
 *
 * Usage:
 *   node backend/scripts/cleanup-daltile-inactive.cjs --dry-run   # Preview
 *   node backend/scripts/cleanup-daltile-inactive.cjs              # Execute
 */
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || process.env.PGHOST || 'localhost',
  port: parseInt(process.env.DB_PORT || process.env.PGPORT || '5432'),
  database: process.env.DB_NAME || process.env.PGDATABASE || 'flooring_pim',
  user: process.env.DB_USER || process.env.PGUSER || 'postgres',
  password: process.env.DB_PASSWORD || process.env.PGPASSWORD || 'postgres',
});

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  const client = await pool.connect();
  console.log(`\n=== Daltile Inactive Cleanup (${DRY_RUN ? 'DRY RUN' : 'LIVE'}) ===\n`);

  try {
    await client.query('BEGIN');

    // Get DAL vendor ID
    const vendorRes = await client.query(`SELECT id FROM vendors WHERE code = 'DAL'`);
    if (!vendorRes.rows.length) { console.error('DAL vendor not found'); return; }
    const dalVendorId = vendorRes.rows[0].id;

    // ─── Identify inactive SKUs ────────────────────────────────────────
    const inactiveSkus = await client.query(`
      SELECT s.id FROM skus s
      JOIN products p ON p.id = s.product_id
      WHERE p.vendor_id = $1 AND s.status != 'active'
    `, [dalVendorId]);
    const skuIds = inactiveSkus.rows.map(r => r.id);
    console.log(`Inactive SKUs found: ${skuIds.length}`);

    if (skuIds.length > 0) {
      // ─── Step 1: NULL out historical FK references ─────────────────────
      // These tables store denormalized copies of product info, so NULLing the FK is safe
      console.log('\n--- Step 1: NULL out historical references ---');

      const historicalTables = [
        { table: 'order_items', cols: ['sku_id', 'product_id'] },
        { table: 'quote_items', cols: ['sku_id', 'product_id'] },
        { table: 'purchase_order_items', cols: ['sku_id'] },
        { table: 'showroom_visit_items', cols: ['sku_id', 'product_id'] },
        { table: 'sample_request_items', cols: ['sku_id', 'product_id'] },
        { table: 'estimate_items', cols: ['sku_id', 'product_id'] },
        { table: 'invoice_items', cols: ['sku_id'] },
        { table: 'bill_items', cols: ['sku_id'] },
      ];

      for (const { table, cols } of historicalTables) {
        for (const col of cols) {
          const res = await client.query(`
            UPDATE ${table} SET ${col} = NULL
            WHERE ${col} = ANY($1::uuid[])
            RETURNING id
          `, [skuIds]);
          if (res.rowCount > 0) {
            console.log(`  ${table}.${col}: NULLed ${res.rowCount} rows`);
          }
        }
      }

      // ─── Step 2: Delete SKU child records ──────────────────────────────
      console.log('\n--- Step 2: Delete SKU child records ---');

      const skuChildTables = [
        'sku_attributes',
        'pricing',
        'packaging',
        'cart_items',
        'inventory_snapshots',
        'stock_alerts',
        'trade_favorite_items',
      ];

      for (const table of skuChildTables) {
        const res = await client.query(`
          DELETE FROM ${table} WHERE sku_id = ANY($1::uuid[]) RETURNING sku_id
        `, [skuIds]);
        console.log(`  ${table}: deleted ${res.rowCount} rows`);
      }

      // Delete SKU-level media_assets
      const skuMedia = await client.query(`
        DELETE FROM media_assets WHERE sku_id = ANY($1::uuid[]) RETURNING id
      `, [skuIds]);
      console.log(`  media_assets (sku-level): deleted ${skuMedia.rowCount} rows`);

      // ─── Step 3: Delete inactive SKUs ──────────────────────────────────
      console.log('\n--- Step 3: Delete inactive SKUs ---');
      const deletedSkus = await client.query(`
        DELETE FROM skus WHERE id = ANY($1::uuid[]) RETURNING id
      `, [skuIds]);
      console.log(`  Deleted ${deletedSkus.rowCount} SKUs`);
    }

    // ─── Identify inactive products (with no remaining active SKUs) ────
    console.log('\n--- Step 4: Delete inactive products ---');

    const inactiveProducts = await client.query(`
      SELECT p.id FROM products p
      WHERE p.vendor_id = $1 AND p.status != 'active'
        AND NOT EXISTS (SELECT 1 FROM skus s WHERE s.product_id = p.id)
    `, [dalVendorId]);
    const prodIds = inactiveProducts.rows.map(r => r.id);
    console.log(`Inactive products (no SKUs remaining): ${prodIds.length}`);

    if (prodIds.length > 0) {
      // NULL out historical product references
      const prodHistorical = [
        { table: 'order_items', col: 'product_id' },
        { table: 'quote_items', col: 'product_id' },
        { table: 'showroom_visit_items', col: 'product_id' },
        { table: 'sample_request_items', col: 'product_id' },
        { table: 'estimate_items', col: 'product_id' },
        { table: 'installation_inquiries', col: 'product_id' },
      ];

      for (const { table, col } of prodHistorical) {
        const res = await client.query(`
          UPDATE ${table} SET ${col} = NULL
          WHERE ${col} = ANY($1::uuid[])
          RETURNING id
        `, [prodIds]);
        if (res.rowCount > 0) {
          console.log(`  ${table}.${col}: NULLed ${res.rowCount} rows`);
        }
      }

      // Delete product child records (those with ON DELETE CASCADE will auto-delete,
      // but explicit is safer)
      const prodChildTables = [
        'media_assets',     // product_id NOT NULL FK
        'product_tags',     // ON DELETE CASCADE, but explicit
        'wishlists',        // ON DELETE CASCADE, but explicit
        'product_reviews',  // ON DELETE CASCADE, but explicit
      ];

      for (const table of prodChildTables) {
        const res = await client.query(`
          DELETE FROM ${table} WHERE product_id = ANY($1::uuid[]) RETURNING product_id
        `, [prodIds]);
        if (res.rowCount > 0) {
          console.log(`  ${table}: deleted ${res.rowCount} rows`);
        }
      }

      // Also delete any remaining trade_favorite_items referencing these products
      const favItems = await client.query(`
        DELETE FROM trade_favorite_items WHERE product_id = ANY($1::uuid[]) RETURNING id
      `, [prodIds]);
      if (favItems.rowCount > 0) {
        console.log(`  trade_favorite_items (product): deleted ${favItems.rowCount} rows`);
      }

      // Delete the products
      const deletedProds = await client.query(`
        DELETE FROM products WHERE id = ANY($1::uuid[]) RETURNING id
      `, [prodIds]);
      console.log(`  Deleted ${deletedProds.rowCount} products`);
    }

    // ─── Summary ──────────────────────────────────────────────────────
    if (DRY_RUN) {
      console.log('\n=== DRY RUN — Rolling back ===');
      await client.query('ROLLBACK');
    } else {
      await client.query('COMMIT');
      console.log('\n=== Changes committed ===');
    }

    console.log(`\nSummary:`);
    console.log(`  Inactive SKUs deleted: ${skuIds.length}`);
    console.log(`  Inactive products deleted: ${prodIds.length}`);

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error:', err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
