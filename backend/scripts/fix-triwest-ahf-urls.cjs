#!/usr/bin/env node
/**
 * Fix Tri-West broken ahfcontract.com image URLs
 *
 * ahfcontract.com CDN returns 403 for all requests. This script:
 *   1. Dutton Pass main SKUs: domain swap ahfcontract.com → hartco.com (confirmed working)
 *   2. Accessories with same-product parent: copy parent's working image
 *   3. Accessories with cross-product color match: copy matching color's image
 *   4. Remaining (no replacement available): delete broken media_asset records
 *
 * Usage:
 *   node backend/scripts/fix-triwest-ahf-urls.cjs [--dry-run]
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
  const client = await pool.connect();
  console.log(`Fix Tri-West ahfcontract.com broken URLs ${DRY_RUN ? '(DRY RUN)' : ''}\n`);

  try {
    await client.query('BEGIN');

    // -----------------------------------------------------------------------
    // Phase 1: Dutton Pass domain swap (ahfcontract.com → hartco.com)
    // -----------------------------------------------------------------------
    console.log('=== Phase 1: Dutton Pass domain swap ===');
    const duttonResult = await client.query(`
      UPDATE media_assets ma
      SET url = replace(ma.url, 'www.ahfcontract.com', 'www.hartco.com'),
          original_url = ma.url
      FROM skus s
      JOIN products p ON p.id = s.product_id
      JOIN vendors v ON v.id = p.vendor_id
      WHERE ma.sku_id = s.id
        AND ma.asset_type = 'primary'
        AND ma.url LIKE '%ahfcontract.com%'
        AND v.name = 'Tri-West'
        AND p.name = 'Dutton Pass Collection 6.5'
        AND s.variant_type IS DISTINCT FROM 'accessory'
      ${DRY_RUN ? 'RETURNING ma.id' : 'RETURNING ma.id'}
    `);
    console.log(`  Domain-swapped: ${duttonResult.rowCount} Dutton Pass primaries\n`);

    // -----------------------------------------------------------------------
    // Phase 2: Accessories — same-product parent match
    // -----------------------------------------------------------------------
    console.log('=== Phase 2: Same-product parent image copy ===');
    const sameProductResult = await client.query(`
      WITH broken_acc AS (
        SELECT ma.id as media_id, s.id as sku_id, p.id as product_id,
          p.name as product_name, s.variant_name,
          regexp_replace(s.variant_name,
            ' - (Reducer|Stair Nose|End Cap|Multi-Purpose|Quarter Round|Threshold|T-Molding|Wall Base)$', '') as color_name
        FROM media_assets ma
        JOIN skus s ON s.id = ma.sku_id
        JOIN products p ON p.id = s.product_id
        JOIN vendors v ON v.id = p.vendor_id
        WHERE v.name = 'Tri-West'
          AND ma.asset_type = 'primary'
          AND ma.url LIKE '%ahfcontract.com%'
          AND s.variant_type = 'accessory'
      ),
      parent_imgs AS (
        SELECT DISTINCT ON (p.id, s.variant_name)
          p.id as product_id, s.variant_name as color, ma.url
        FROM media_assets ma
        JOIN skus s ON s.id = ma.sku_id
        JOIN products p ON p.id = s.product_id
        JOIN vendors v ON v.id = p.vendor_id
        WHERE v.name = 'Tri-West'
          AND ma.asset_type = 'primary'
          AND ma.url NOT LIKE '%ahfcontract.com%'
          AND ma.url LIKE 'http%'
          AND s.variant_type IS DISTINCT FROM 'accessory'
        ORDER BY p.id, s.variant_name, ma.sort_order
      )
      UPDATE media_assets ma2
      SET url = pi.url,
          original_url = ma2.url
      FROM broken_acc ba
      JOIN parent_imgs pi ON pi.product_id = ba.product_id AND pi.color = ba.color_name
      WHERE ma2.id = ba.media_id
      RETURNING ma2.id
    `);
    console.log(`  Same-product match: ${sameProductResult.rowCount} accessories updated\n`);

    // -----------------------------------------------------------------------
    // Phase 3: Accessories — cross-product color match
    // -----------------------------------------------------------------------
    console.log('=== Phase 3: Cross-product color match ===');
    const crossProductResult = await client.query(`
      WITH broken_acc AS (
        SELECT ma.id as media_id, s.id as sku_id, p.id as product_id,
          p.name as product_name, s.variant_name,
          regexp_replace(s.variant_name,
            ' - (Reducer|Stair Nose|End Cap|Multi-Purpose|Quarter Round|Threshold|T-Molding|Wall Base)$', '') as color_name
        FROM media_assets ma
        JOIN skus s ON s.id = ma.sku_id
        JOIN products p ON p.id = s.product_id
        JOIN vendors v ON v.id = p.vendor_id
        WHERE v.name = 'Tri-West'
          AND ma.asset_type = 'primary'
          AND ma.url LIKE '%ahfcontract.com%'
          AND s.variant_type = 'accessory'
      ),
      cross_imgs AS (
        SELECT DISTINCT ON (s.variant_name)
          s.variant_name as color, ma.url
        FROM media_assets ma
        JOIN skus s ON s.id = ma.sku_id
        JOIN products p ON p.id = s.product_id
        JOIN vendors v ON v.id = p.vendor_id
        WHERE v.name = 'Tri-West'
          AND ma.asset_type = 'primary'
          AND ma.url NOT LIKE '%ahfcontract.com%'
          AND ma.url LIKE 'http%'
          AND s.variant_type IS DISTINCT FROM 'accessory'
        ORDER BY s.variant_name, ma.sort_order
      )
      UPDATE media_assets ma2
      SET url = ci.url,
          original_url = ma2.url
      FROM broken_acc ba
      JOIN cross_imgs ci ON ci.color = ba.color_name
      WHERE ma2.id = ba.media_id
        AND ma2.url LIKE '%ahfcontract.com%'
      RETURNING ma2.id
    `);
    console.log(`  Cross-product match: ${crossProductResult.rowCount} accessories updated\n`);

    // -----------------------------------------------------------------------
    // Phase 4: Delete remaining broken records (no replacement available)
    // -----------------------------------------------------------------------
    console.log('=== Phase 4: Remove unrepairable broken images ===');

    // Show what we're about to delete
    const remaining = await client.query(`
      SELECT p.name, s.variant_name, s.variant_type,
        CASE WHEN s.variant_type = 'accessory' THEN 'accessory' ELSE 'flooring' END as type
      FROM media_assets ma
      JOIN skus s ON s.id = ma.sku_id
      JOIN products p ON p.id = s.product_id
      JOIN vendors v ON v.id = p.vendor_id
      WHERE v.name = 'Tri-West'
        AND ma.asset_type = 'primary'
        AND ma.url LIKE '%ahfcontract.com%'
      ORDER BY type, p.name, s.variant_name
    `);

    const accessories = remaining.rows.filter(r => r.variant_type === 'accessory');
    const flooring = remaining.rows.filter(r => r.variant_type !== 'accessory');

    if (flooring.length > 0) {
      console.log(`  Main flooring products to remove (${flooring.length}):`);
      for (const r of flooring) {
        console.log(`    ${r.name} / ${r.variant_name}`);
      }
    }
    console.log(`  Accessories to remove: ${accessories.length}`);
    if (accessories.length > 0) {
      const byProduct = {};
      for (const r of accessories) {
        byProduct[r.name] = (byProduct[r.name] || 0) + 1;
      }
      for (const [name, count] of Object.entries(byProduct).sort()) {
        console.log(`    ${name}: ${count}`);
      }
    }

    const deleteResult = await client.query(`
      DELETE FROM media_assets ma
      USING skus s, products p, vendors v
      WHERE ma.sku_id = s.id
        AND s.product_id = p.id
        AND p.vendor_id = v.id
        AND v.name = 'Tri-West'
        AND ma.asset_type = 'primary'
        AND ma.url LIKE '%ahfcontract.com%'
      RETURNING ma.id
    `);
    console.log(`\n  Deleted: ${deleteResult.rowCount} broken media_asset records\n`);

    // -----------------------------------------------------------------------
    // Summary
    // -----------------------------------------------------------------------
    console.log('=== Summary ===');
    console.log(`  Domain-swapped (Dutton Pass):  ${duttonResult.rowCount}`);
    console.log(`  Same-product parent match:     ${sameProductResult.rowCount}`);
    console.log(`  Cross-product color match:     ${crossProductResult.rowCount}`);
    console.log(`  Deleted (no replacement):      ${deleteResult.rowCount}`);
    console.log(`  Total fixed:                   ${duttonResult.rowCount + sameProductResult.rowCount + crossProductResult.rowCount}`);
    console.log(`  Total processed:               ${duttonResult.rowCount + sameProductResult.rowCount + crossProductResult.rowCount + deleteResult.rowCount}`);

    if (DRY_RUN) {
      await client.query('ROLLBACK');
      console.log('\n(DRY RUN — all changes rolled back)');
    } else {
      await client.query('COMMIT');
      console.log('\nChanges committed.');
    }
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  pool.end();
  process.exit(1);
});
