#!/usr/bin/env node
/**
 * Merge Daltile Orphan Single-SKU Products
 *
 * Finds single-SKU DAL products that belong to a collection where another
 * product with multiple SKUs already exists. Merges the orphan's SKU into
 * the target product if the orphan's name starts with the same collection.
 *
 * Logic:
 *   - For each single-SKU product: check if its collection has a "main" product
 *     (the one with the most SKUs)
 *   - Only merge if the orphan's product name starts with the collection name
 *     and differs only in color/size suffix (not a unique product)
 *   - Skip if the collection only has single-SKU products (those are legitimate
 *     one-color-per-product collections like Quartetto)
 *
 * Actions per merge:
 *   1. Move orphan's SKU(s) to target product
 *   2. Move orphan's media_assets to target product
 *   3. Set orphan product to inactive (cleanup script handles deletion)
 *
 * Usage:
 *   node backend/scripts/merge-daltile-orphans.cjs --dry-run   # Preview
 *   node backend/scripts/merge-daltile-orphans.cjs              # Execute
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
  console.log(`\n=== Daltile Orphan Merge (${DRY_RUN ? 'DRY RUN' : 'LIVE'}) ===\n`);

  try {
    await client.query('BEGIN');

    // Get DAL vendor ID
    const vendorRes = await client.query(`SELECT id FROM vendors WHERE code = 'DAL'`);
    if (!vendorRes.rows.length) { console.error('DAL vendor not found'); return; }
    const dalVendorId = vendorRes.rows[0].id;

    // ─── Build collection map ──────────────────────────────────────────
    // For each collection, get all active products with their SKU counts
    const collectionData = await client.query(`
      SELECT p.id, p.name, p.collection, p.display_name,
        (SELECT COUNT(*) FROM skus s WHERE s.product_id = p.id AND s.status = 'active') AS sku_count
      FROM products p
      WHERE p.vendor_id = $1 AND p.status = 'active'
        AND p.collection IS NOT NULL AND p.collection != ''
      ORDER BY p.collection, sku_count DESC
    `, [dalVendorId]);

    // Group by collection
    const collections = {};
    for (const row of collectionData.rows) {
      if (!collections[row.collection]) collections[row.collection] = [];
      collections[row.collection].push({
        id: row.id,
        name: row.name,
        displayName: row.display_name,
        skuCount: parseInt(row.sku_count),
      });
    }

    // ─── Find merge candidates ─────────────────────────────────────────
    let merged = 0;
    let skipped = 0;
    let skusMoved = 0;
    let mediaMoved = 0;

    for (const [collection, products] of Object.entries(collections)) {
      const isTrim = p => /Trim|Accessories/i.test(p.name);

      // Find non-trim multi-SKU products — these are valid merge targets
      const multiSkuProducts = products.filter(p => p.skuCount > 1 && !isTrim(p));
      const singleSkuProducts = products.filter(p => p.skuCount === 1 && !isTrim(p));

      // Skip if no non-trim multi-SKU target exists — this collection has
      // one product per color (legitimate structure, not orphans)
      if (multiSkuProducts.length === 0) continue;
      if (singleSkuProducts.length === 0) continue;

      // The target is the non-trim product with the most SKUs
      const target = multiSkuProducts[0];

      for (const orphan of singleSkuProducts) {
        // Only merge if orphan's name starts with collection prefix
        // This ensures "Acreage Highland" merges into "Acreage" collection
        // but "Quartetto Ambra" stays separate if Quartetto has no multi-SKU product
        if (!orphan.name.startsWith(collection)) {
          skipped++;
          continue;
        }

        // Don't merge if orphan name is identical to target — same product
        if (orphan.name === target.name) {
          skipped++;
          continue;
        }

        if (DRY_RUN && merged < 30) {
          console.log(`  MERGE: "${orphan.name}" (1 SKU) → "${target.name}" (${target.skuCount} SKUs) [${collection}]`);
        }

        // Move orphan's SKUs to target product
        const movedSkus = await client.query(`
          UPDATE skus SET product_id = $1, updated_at = CURRENT_TIMESTAMP
          WHERE product_id = $2
          RETURNING id
        `, [target.id, orphan.id]);
        skusMoved += movedSkus.rowCount;

        // Move orphan's media_assets to target product
        // Use ON CONFLICT-safe approach: try to update, skip duplicates
        const orphanMedia = await client.query(`
          SELECT id, sku_id, asset_type, sort_order FROM media_assets
          WHERE product_id = $1
        `, [orphan.id]);

        for (const media of orphanMedia.rows) {
          try {
            await client.query(`
              UPDATE media_assets SET product_id = $1 WHERE id = $2
            `, [target.id, media.id]);
            mediaMoved++;
          } catch (e) {
            // Unique constraint violation — duplicate asset, delete instead
            if (e.code === '23505') {
              await client.query(`DELETE FROM media_assets WHERE id = $1`, [media.id]);
            } else {
              throw e;
            }
          }
        }

        // Deactivate the orphan product
        await client.query(`
          UPDATE products SET status = 'inactive', updated_at = CURRENT_TIMESTAMP
          WHERE id = $1
        `, [orphan.id]);

        merged++;
      }
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
    console.log(`  Products merged: ${merged}`);
    console.log(`  Products skipped: ${skipped}`);
    console.log(`  SKUs moved: ${skusMoved}`);
    console.log(`  Media assets moved: ${mediaMoved}`);

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
