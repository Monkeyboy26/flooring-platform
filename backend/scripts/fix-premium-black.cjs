#!/usr/bin/env node
/**
 * Fix Premium Black product grouping
 *
 * Problem: 18 products (11 empty), 31 SKUs spanning 5 product types all mixed together.
 * Main product has slabs, tiles, trim, and thresholds. Tiles scattered across 4 products.
 *
 * Target:
 *  1. "Premium Black Slab"          (Granite Countertops) — 11 PSL/RSL slab SKUs
 *  2. "Premium Black Tile" (NEW)    (Natural Stone)       — 9 tile SKUs + 1 trim accessory
 *  3. "Premium Black Stacked Stone" (Stacked Stone)       — 4 LPNL panel SKUs (merged)
 *  4. "Premium Black Threshold"     (keep existing)       — 6 threshold SKUs
 *  5. Delete 14 empty/absorbed products
 */

const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres'
});

// Category IDs
const GRANITE_COUNTERTOPS = '650e8400-e29b-41d4-a716-446655440042';
const NATURAL_STONE       = '650e8400-e29b-41d4-a716-446655440011';
const STACKED_STONE       = '650e8400-e29b-41d4-a716-446655440061';

// Existing product IDs
const MAIN_PRODUCT     = 'bb14cbe7-b9ba-4f28-9a8e-e99ed0a11798'; // 17 SKUs — will become slab-only
const STACKED_316      = '316b5d4f-3cf8-4fa6-8794-d84228f560c2'; // LPNL + tiles mixed (Stacked Stone)
const ROCKMOUNT        = 'a903538b-2557-4768-a55f-24b125761150'; // LPNL mini panels (Stacked Stone)
const THRESHOLD_PROD   = 'c8c7d5ec-568a-40f9-95fa-61de21f03e6e'; // 5 threshold SKUs
const HONED_THRESHOLD  = '94ea631e-2c9f-4cba-84ff-c25dd076d85b'; // 1 honed threshold
const TILE_18          = '34b1f4ec-6f13-4f49-b5af-5e1803bca9e9'; // 1 tile (18" Black)
const TILE_18x18       = '5e71f52c-374e-4364-97c9-0453add115b4'; // 1 tile (18"x18"x.50)

// Empty products to delete
const EMPTY_PRODUCTS = [
  '2cd5463a-d2e4-40d4-b786-929c2a1090e8', // "Black" (Premium collection, 0 SKUs)
  '4fc8ab33-af0f-4cc0-9d80-e0425a8de2b1', // "Premium Black" (0 SKUs)
  'efe81945-b5c1-479d-9a8f-8ff7c79a68bd', // "Premium Blackx.37 Honed" (0 SKUs)
  '364037ab-ab8e-4fa4-b0ae-15dbcf88b40a', // "Premium Blackx.37 P1" (0 SKUs)
  'dbcce9c0-2554-4584-a073-7aed862ab472', // "Premium Blackx.38 Honed" (0 SKUs)
  'c3717251-6e57-4494-a652-7b5a46e77962', // "Premium Blackx.38 P1" (0 SKUs)
  'fb3757eb-d2ae-4a1c-b56e-ba8d792d0323', // "Premium Blackx.50 Honed" (0 SKUs)
  '190e879c-dbca-49b5-9207-259280c7f12b', // "Premium Blk Honedx.75 Sill Dbl Bvl" (0 SKUs)
  'c25bcace-701e-49f4-8142-c79f67a40f9f', // "Premium Blkx.75 Dbl Bevel Threshold" (0 SKUs)
  'aa42dbc7-894c-4be7-8260-f012b017ef04', // "Premium Blkx.75 Sill Dbl Bvl" (0 SKUs)
  'ff5e8ce9-8b60-4d76-babc-2bd1bb86b718', // "Premium Blkx.75 Sngl Holy Threshold" (0 SKUs)
];

async function main() {
  const client = await pool.connect();
  const msiVendor = await client.query("SELECT id FROM vendors WHERE code = 'MSI'");
  const msiId = msiVendor.rows[0].id;

  try {
    await client.query('BEGIN');

    // ═══════════════════════════════════════════
    // Step 1: Create "Premium Black Tile" product
    // ═══════════════════════════════════════════
    console.log('\n=== Step 1: Create Premium Black Tile ===');
    const tileProductId = uuidv4();
    await client.query(`
      INSERT INTO products (id, vendor_id, name, collection, category_id, status, display_name, slug, is_active)
      VALUES ($1, $2, 'Premium Black Tile', 'Premium Black', $3, 'active', 'Premium Black Tile', 'premium-black-tile', true)
    `, [tileProductId, msiId, NATURAL_STONE]);
    console.log(`  Created product ${tileProductId}`);

    // Move tile SKUs from main product (bb14cbe7)
    const tileSKUsFromMain = [
      'TPBLACK1212HN', 'TPREMBLK1224H', 'TPREMBLK24240', 'TPREMBLK24240.5', 'TPREMSUD1818H'
    ];
    const { rows: mainTileSkus } = await client.query(`
      SELECT id, vendor_sku FROM skus WHERE product_id = $1 AND vendor_sku = ANY($2::text[])
    `, [MAIN_PRODUCT, tileSKUsFromMain]);

    if (mainTileSkus.length > 0) {
      const ids = mainTileSkus.map(s => s.id);
      await client.query(`UPDATE skus SET product_id = $1 WHERE id = ANY($2::uuid[])`, [tileProductId, ids]);
      console.log(`  Moved ${mainTileSkus.length} tile SKUs from main product: ${mainTileSkus.map(s => s.vendor_sku).join(', ')}`);
    }

    // Move tile SKUs from stacked stone product (316b5d4f)
    const tileSKUsFromStacked = ['TPBLACK1212', 'TPREMBLK1224'];
    const { rows: stackedTileSkus } = await client.query(`
      SELECT id, vendor_sku FROM skus WHERE product_id = $1 AND vendor_sku = ANY($2::text[])
    `, [STACKED_316, tileSKUsFromStacked]);

    if (stackedTileSkus.length > 0) {
      const ids = stackedTileSkus.map(s => s.id);
      await client.query(`UPDATE skus SET product_id = $1 WHERE id = ANY($2::uuid[])`, [tileProductId, ids]);
      console.log(`  Moved ${stackedTileSkus.length} tile SKUs from stacked stone product: ${stackedTileSkus.map(s => s.vendor_sku).join(', ')}`);
    }

    // Move tile SKU from "Premium 18" Black" product (34b1f4ec)
    const { rows: tile18Skus } = await client.query(`
      SELECT id, vendor_sku FROM skus WHERE product_id = $1
    `, [TILE_18]);
    if (tile18Skus.length > 0) {
      const ids = tile18Skus.map(s => s.id);
      await client.query(`UPDATE skus SET product_id = $1 WHERE id = ANY($2::uuid[])`, [tileProductId, ids]);
      console.log(`  Moved ${tile18Skus.length} tile SKU from Premium 18": ${tile18Skus.map(s => s.vendor_sku).join(', ')}`);
    }

    // Move tile SKU from "Premium 18"x18"x.50" product (5e71f52c)
    const { rows: tile18x18Skus } = await client.query(`
      SELECT id, vendor_sku FROM skus WHERE product_id = $1
    `, [TILE_18x18]);
    if (tile18x18Skus.length > 0) {
      const ids = tile18x18Skus.map(s => s.id);
      await client.query(`UPDATE skus SET product_id = $1 WHERE id = ANY($2::uuid[])`, [tileProductId, ids]);
      console.log(`  Moved ${tile18x18Skus.length} tile SKU from Premium 18"x18": ${tile18x18Skus.map(s => s.vendor_sku).join(', ')}`);
    }

    // Move THDW1-MR-BLA (marble rail trim) to tile product as accessory
    const { rows: trimSkus } = await client.query(`
      SELECT id, vendor_sku FROM skus WHERE product_id = $1 AND vendor_sku = 'THDW1-MR-BLA'
    `, [MAIN_PRODUCT]);
    if (trimSkus.length > 0) {
      await client.query(`
        UPDATE skus SET product_id = $1, variant_type = 'accessory', variant_name = 'Marble Rail'
        WHERE id = $2
      `, [tileProductId, trimSkus[0].id]);
      console.log(`  Moved THDW1-MR-BLA to tile product as accessory`);
    }

    // Verify tile product SKU count
    const { rows: [{ count: tileCount }] } = await client.query(
      'SELECT count(*) FROM skus WHERE product_id = $1', [tileProductId]
    );
    console.log(`  Total tile product SKUs: ${tileCount}`);

    // ═══════════════════════════════════════════
    // Step 2: Convert main product to slab-only
    // ═══════════════════════════════════════════
    console.log('\n=== Step 2: Convert main product to Premium Black Slab ===');
    await client.query(`
      UPDATE products
      SET name = 'Premium Black Slab',
          display_name = 'Premium Black',
          collection = 'Premium Black',
          category_id = $1,
          slug = 'premium-black-slab'
      WHERE id = $2
    `, [GRANITE_COUNTERTOPS, MAIN_PRODUCT]);

    const { rows: [{ count: slabCount }] } = await client.query(
      'SELECT count(*) FROM skus WHERE product_id = $1', [MAIN_PRODUCT]
    );
    console.log(`  Updated main product → "Premium Black Slab" (Granite Countertops)`);
    console.log(`  Remaining slab SKUs: ${slabCount}`);

    // List remaining SKUs to verify
    const { rows: remainingSlabs } = await client.query(
      'SELECT vendor_sku FROM skus WHERE product_id = $1 ORDER BY vendor_sku', [MAIN_PRODUCT]
    );
    console.log(`  SKUs: ${remainingSlabs.map(s => s.vendor_sku).join(', ')}`);

    // ═══════════════════════════════════════════
    // Step 3: Merge stacked stone products
    // ═══════════════════════════════════════════
    console.log('\n=== Step 3: Merge stacked stone products ===');

    // Move LPNL SKU from 316b5d4f to Rockmount product
    const { rows: lpnlSkus } = await client.query(`
      SELECT id, vendor_sku FROM skus WHERE product_id = $1 AND vendor_sku LIKE 'LPNL%'
    `, [STACKED_316]);

    if (lpnlSkus.length > 0) {
      const ids = lpnlSkus.map(s => s.id);
      await client.query(`UPDATE skus SET product_id = $1 WHERE id = ANY($2::uuid[])`, [ROCKMOUNT, ids]);
      console.log(`  Moved ${lpnlSkus.length} LPNL SKU from 316b to Rockmount: ${lpnlSkus.map(s => s.vendor_sku).join(', ')}`);
    }

    // Rename Rockmount product
    await client.query(`
      UPDATE products
      SET name = 'Premium Black Stacked Stone',
          display_name = 'Premium Black Stacked Stone',
          collection = 'Premium Black'
      WHERE id = $1
    `, [ROCKMOUNT]);

    const { rows: [{ count: stackedCount }] } = await client.query(
      'SELECT count(*) FROM skus WHERE product_id = $1', [ROCKMOUNT]
    );
    console.log(`  Updated Rockmount → "Premium Black Stacked Stone"`);
    console.log(`  Total stacked stone SKUs: ${stackedCount}`);

    // ═══════════════════════════════════════════
    // Step 4: Consolidate threshold product
    // ═══════════════════════════════════════════
    console.log('\n=== Step 4: Consolidate thresholds ===');

    // Move honed threshold from 94ea631e to main threshold product
    const { rows: honedThresholdSkus } = await client.query(`
      SELECT id, vendor_sku FROM skus WHERE product_id = $1
    `, [HONED_THRESHOLD]);

    if (honedThresholdSkus.length > 0) {
      const ids = honedThresholdSkus.map(s => s.id);
      await client.query(`
        UPDATE skus SET product_id = $1, variant_type = 'accessory', variant_name = 'Threshold'
        WHERE id = ANY($2::uuid[])
      `, [THRESHOLD_PROD, ids]);
      console.log(`  Moved ${honedThresholdSkus.length} honed threshold to main threshold product`);
    }

    // Rename threshold product
    await client.query(`
      UPDATE products
      SET name = 'Premium Black Threshold',
          display_name = 'Premium Black Threshold',
          collection = 'Premium Black',
          slug = 'premium-black-threshold'
      WHERE id = $1
    `, [THRESHOLD_PROD]);

    const { rows: [{ count: thresholdCount }] } = await client.query(
      'SELECT count(*) FROM skus WHERE product_id = $1', [THRESHOLD_PROD]
    );
    console.log(`  Updated threshold product → "Premium Black Threshold"`);
    console.log(`  Total threshold SKUs: ${thresholdCount}`);

    // ═══════════════════════════════════════════
    // Step 5: Copy slab images to tile product
    // ═══════════════════════════════════════════
    console.log('\n=== Step 5: Set up tile product media ===');

    // Use the MSI CDN image that the main product has
    const cdnUrl = 'https://cdn.msisurfaces.com/images/colornames/premium-black-granite.jpg';
    await client.query(`
      INSERT INTO media_assets (id, product_id, asset_type, url, sort_order)
      VALUES ($1, $2, 'primary', $3, 0)
    `, [uuidv4(), tileProductId, cdnUrl]);
    console.log(`  Added CDN primary image to tile product`);

    // ═══════════════════════════════════════════
    // Step 6: Delete absorbed products (now empty)
    // ═══════════════════════════════════════════
    console.log('\n=== Step 6: Delete absorbed products ===');

    // Products that had SKUs moved out: 316b5d4f, 34b1f4ec, 5e71f52c, 94ea631e
    const absorbedProducts = [STACKED_316, TILE_18, TILE_18x18, HONED_THRESHOLD];

    for (const pid of absorbedProducts) {
      // Verify no SKUs remain
      const { rows: [{ count: remaining }] } = await client.query(
        'SELECT count(*) FROM skus WHERE product_id = $1', [pid]
      );
      if (parseInt(remaining) > 0) {
        console.log(`  WARNING: Product ${pid} still has ${remaining} SKUs — skipping delete`);
        continue;
      }
      // Delete media first, then product
      await client.query('DELETE FROM media_assets WHERE product_id = $1', [pid]);
      await client.query('DELETE FROM products WHERE id = $1', [pid]);
      console.log(`  Deleted absorbed product ${pid}`);
    }

    // ═══════════════════════════════════════════
    // Step 7: Delete empty products (0 SKUs)
    // ═══════════════════════════════════════════
    console.log('\n=== Step 7: Delete empty Premium Black products ===');

    for (const pid of EMPTY_PRODUCTS) {
      const { rows: [{ count: remaining }] } = await client.query(
        'SELECT count(*) FROM skus WHERE product_id = $1', [pid]
      );
      if (parseInt(remaining) > 0) {
        console.log(`  WARNING: Product ${pid} still has ${remaining} SKUs — skipping delete`);
        continue;
      }
      await client.query('DELETE FROM media_assets WHERE product_id = $1', [pid]);
      await client.query('DELETE FROM products WHERE id = $1', [pid]);
      console.log(`  Deleted empty product ${pid}`);
    }

    // ═══════════════════════════════════════════
    // Summary
    // ═══════════════════════════════════════════
    console.log('\n=== Final State ===');
    const { rows: finalProducts } = await client.query(`
      SELECT p.id, p.name, p.display_name, p.slug, c.name as category,
        (SELECT count(*) FROM skus s WHERE s.product_id = p.id) as sku_count
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      WHERE p.id IN ($1, $2, $3, $4)
      ORDER BY p.name
    `, [MAIN_PRODUCT, tileProductId, ROCKMOUNT, THRESHOLD_PROD]);

    for (const p of finalProducts) {
      console.log(`  ${p.name} (${p.category}): ${p.sku_count} SKUs — slug: ${p.slug}`);
    }

    await client.query('COMMIT');
    console.log('\nDone!');

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('ERROR — rolled back:', err.message);
    console.error(err.stack);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
