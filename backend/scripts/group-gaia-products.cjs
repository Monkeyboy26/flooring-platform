/**
 * Gaia Flooring — Product Grouping
 *
 * Merges per-color products into per-collection products.
 * Before: 55 products (one per color), e.g. "Grey Fox", "Alpaca", ...
 * After:  8 products (one per collection), e.g. "eTERRA White Series"
 *         with each color as a SKU under the product.
 *
 * Usage: docker compose exec api node scripts/group-gaia-products.cjs [--dry-run]
 */
const pg = require('pg');

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: 5432, database: 'flooring_pim', user: 'postgres', password: 'postgres',
});

const DRY_RUN = process.argv.includes('--dry-run');

async function run() {
  const client = await pool.connect();
  try {
    // Get vendor
    const { rows: [vendor] } = await client.query(
      "SELECT id FROM vendors WHERE code = 'GAIA'"
    );
    if (!vendor) { console.error('GAIA vendor not found.'); return; }
    const vendorId = vendor.id;

    // Get all collections with their products
    const { rows: collections } = await client.query(`
      SELECT p.collection,
             array_agg(p.id ORDER BY p.name) as product_ids,
             array_agg(p.name ORDER BY p.name) as product_names
      FROM products p
      WHERE p.vendor_id = $1 AND p.is_active = true
      GROUP BY p.collection
      ORDER BY p.collection
    `, [vendorId]);

    console.log(`Found ${collections.length} collections to group:\n`);

    let totalMerged = 0;
    let totalDeleted = 0;

    for (const col of collections) {
      const { collection, product_ids, product_names } = col;
      const count = product_ids.length;

      if (count <= 1) {
        console.log(`  ${collection}: only 1 product, skipping`);
        continue;
      }

      console.log(`  ${collection}: ${count} colors → 1 product`);
      console.log(`    Colors: ${product_names.join(', ')}`);

      // Pick first product as keeper
      const keeperId = product_ids[0];
      const keeperName = product_names[0];
      const donorIds = product_ids.slice(1);

      if (DRY_RUN) {
        console.log(`    [DRY RUN] Would keep "${keeperName}" (${keeperId}), merge ${donorIds.length} donors\n`);
        totalMerged += count;
        totalDeleted += donorIds.length;
        continue;
      }

      await client.query('BEGIN');
      try {
        // Move all donor SKUs to keeper product
        for (const donorId of donorIds) {
          await client.query(
            'UPDATE skus SET product_id = $1 WHERE product_id = $2',
            [keeperId, donorId]
          );
        }

        // Move SKU-level media_assets (where sku_id IS NOT NULL)
        for (const donorId of donorIds) {
          await client.query(
            'UPDATE media_assets SET product_id = $1 WHERE product_id = $2 AND sku_id IS NOT NULL',
            [keeperId, donorId]
          );
        }

        // Move or delete product-level media_assets (where sku_id IS NULL)
        for (const donorId of donorIds) {
          // Delete donor product-level media to avoid sort_order conflicts
          await client.query(
            'DELETE FROM media_assets WHERE product_id = $1 AND sku_id IS NULL',
            [donorId]
          );
        }

        // Update cart_items referencing donor products
        for (const donorId of donorIds) {
          await client.query(
            'UPDATE cart_items SET product_id = $1 WHERE product_id = $2',
            [keeperId, donorId]
          );
        }

        // Update any other product references
        const refTables = [
          'order_items', 'quote_items', 'showroom_visit_items',
          'sample_request_items', 'estimate_items', 'trade_favorite_items',
        ];
        for (const table of refTables) {
          try {
            await client.query(
              `UPDATE ${table} SET product_id = $1 WHERE product_id = ANY($2::uuid[])`,
              [keeperId, donorIds]
            );
          } catch { /* table may not exist */ }
        }

        // Delete wishlists + product_reviews (have ON DELETE CASCADE, but let's be explicit)
        try {
          await client.query(
            'DELETE FROM wishlists WHERE product_id = ANY($1::uuid[])',
            [donorIds]
          );
        } catch { }
        try {
          await client.query(
            'DELETE FROM product_reviews WHERE product_id = ANY($1::uuid[])',
            [donorIds]
          );
        } catch { }

        // Nullify installation_inquiries (ON DELETE SET NULL)
        try {
          await client.query(
            'UPDATE installation_inquiries SET product_id = $1 WHERE product_id = ANY($2::uuid[])',
            [keeperId, donorIds]
          );
        } catch { }

        // Delete donor products
        await client.query(
          'DELETE FROM products WHERE id = ANY($1::uuid[])',
          [donorIds]
        );

        // Rename keeper to collection name
        await client.query(
          'UPDATE products SET name = $1 WHERE id = $2',
          [collection, keeperId]
        );

        await client.query('COMMIT');

        totalMerged += count;
        totalDeleted += donorIds.length;
        console.log(`    ✓ Merged ${count} products → "${collection}" (kept ${keeperName})\n`);

      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`    ✗ FAILED: ${err.message}\n`);
      }
    }

    // Final counts
    const { rows: [final] } = await client.query(`
      SELECT count(*) as products,
             (SELECT count(*) FROM skus s JOIN products p ON p.id = s.product_id
              WHERE p.vendor_id = $1 AND s.variant_type IS NULL) as main_skus,
             (SELECT count(*) FROM skus s JOIN products p ON p.id = s.product_id
              WHERE p.vendor_id = $1 AND s.variant_type = 'accessory') as acc_skus,
             (SELECT count(*) FROM media_assets ma JOIN skus s ON s.id = ma.sku_id
              JOIN products p ON p.id = s.product_id WHERE p.vendor_id = $1) as images
      FROM products WHERE vendor_id = $1
    `, [vendorId]);

    console.log('=== Grouping Complete ===');
    console.log(`Products: ${final.products} (was 55)`);
    console.log(`Main SKUs: ${final.main_skus}`);
    console.log(`Accessory SKUs: ${final.acc_skus}`);
    console.log(`Images: ${final.images}`);
    console.log(`Collections merged: ${totalMerged} colors → ${collections.length} products`);
    console.log(`Products deleted: ${totalDeleted}`);
    if (DRY_RUN) console.log('\n[DRY RUN] No changes were made.');

  } finally {
    client.release();
    await pool.end();
  }
}

run().catch(err => { console.error(err); process.exit(1); });
