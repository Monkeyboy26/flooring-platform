#!/usr/bin/env node
/**
 * Group Bosphorus colors: merge color-per-product into one product per collection.
 *
 * Before: Argile > Cacao (3 SKUs), Argile > Concrete (3 SKUs), ...
 * After:  Argile (27 SKUs) — colors live in sku_attributes
 *
 * Usage:
 *   node backend/scripts/group-bosphorus-colors.cjs --dry-run
 *   node backend/scripts/group-bosphorus-colors.cjs
 */

const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

const dryRun = process.argv.includes('--dry-run');

function makeSlug(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

async function main() {
  console.log(`\n=== Group Bosphorus Colors ===`);
  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}\n`);

  // Find vendor
  const { rows: [vendor] } = await pool.query(
    `SELECT id, name FROM vendors WHERE name ILIKE '%bosphorus%' LIMIT 1`
  );
  if (!vendor) { console.error('No Bosphorus vendor found'); process.exit(1); }
  console.log(`Vendor: ${vendor.name} (${vendor.id})\n`);

  // Get all collections with their product counts
  const { rows: collections } = await pool.query(`
    SELECT p.collection, COUNT(DISTINCT p.id) as product_count, COUNT(s.id) as sku_count
    FROM products p
    JOIN skus s ON s.product_id = p.id
    WHERE p.vendor_id = $1
    GROUP BY p.collection
    ORDER BY p.collection
  `, [vendor.id]);

  const multiColor = collections.filter(c => parseInt(c.product_count) > 1);
  const singleColor = collections.filter(c => parseInt(c.product_count) === 1);

  console.log(`Multi-color collections to group: ${multiColor.length}`);
  console.log(`Single-color collections to rename: ${singleColor.length}\n`);

  let totalSkusMoved = 0;
  let totalMediaMoved = 0;
  let totalProductsDeleted = 0;

  // --- Phase 1: Group multi-color collections ---
  console.log('--- Phase 1: Group multi-color collections ---\n');

  for (const coll of multiColor) {
    const { rows: products } = await pool.query(`
      SELECT p.id, p.name, p.display_name, p.slug, p.description_short,
             (SELECT COUNT(*) FROM skus s WHERE s.product_id = p.id) as sku_count,
             (SELECT COUNT(*) FROM media_assets ma WHERE ma.product_id = p.id) as media_count
      FROM products p
      WHERE p.vendor_id = $1 AND p.collection = $2
      ORDER BY p.name
    `, [vendor.id, coll.collection]);

    // Pick master: first product alphabetically
    const master = products[0];
    const others = products.slice(1);

    console.log(`${coll.collection}: ${products.length} colors → 1 product (${coll.sku_count} SKUs)`);

    if (dryRun) {
      console.log(`  Master: "${master.name}" (${master.sku_count} SKUs, ${master.media_count} imgs)`);
      for (const o of others) {
        console.log(`    merge ← "${o.name}" (${o.sku_count} SKUs, ${o.media_count} imgs)`);
      }
      continue;
    }

    // Move SKUs and media from each non-master to master
    for (const other of others) {
      // 1. Move SKUs
      const { rowCount: skusMoved } = await pool.query(
        `UPDATE skus SET product_id = $1 WHERE product_id = $2`, [master.id, other.id]
      );

      // 2. Move SKU-level media (sku_id IS NOT NULL) — safe, unique by sku_id
      const { rowCount: skuMediaMoved } = await pool.query(
        `UPDATE media_assets SET product_id = $1 WHERE product_id = $2 AND sku_id IS NOT NULL`,
        [master.id, other.id]
      );

      // 3. Move product-level media (sku_id IS NULL) — offset sort_order to avoid conflicts
      let productMediaMoved = 0;
      const assetTypes = ['primary', 'alternate', 'lifestyle', 'spec_pdf', 'swatch'];
      for (const atype of assetTypes) {
        // Find max sort_order for this asset_type on master (product-level only)
        const { rows: [{ max_sort }] } = await pool.query(`
          SELECT COALESCE(MAX(sort_order), -1) as max_sort FROM media_assets
          WHERE product_id = $1 AND asset_type = $2 AND sku_id IS NULL
        `, [master.id, atype]);
        const offset = parseInt(max_sort) + 1;

        const { rowCount } = await pool.query(`
          UPDATE media_assets SET product_id = $1, sort_order = sort_order + $3
          WHERE product_id = $2 AND asset_type = $4 AND sku_id IS NULL
        `, [master.id, other.id, offset, atype]);
        productMediaMoved += rowCount;
      }

      const mediaMoved = skuMediaMoved + productMediaMoved;
      totalSkusMoved += skusMoved;
      totalMediaMoved += mediaMoved;
      console.log(`  ← "${other.name}": ${skusMoved} SKUs, ${mediaMoved} imgs`);
    }

    // Re-point all FK references from non-master products to master
    const deleteIds = others.map(o => o.id);
    const fkTables = [
      'order_items', 'cart_items', 'estimate_items', 'quote_items',
      'wishlists', 'trade_favorite_items', 'product_tags', 'product_reviews',
      'sample_request_items', 'showroom_visit_items', 'installation_inquiries'
    ];
    for (const tbl of fkTables) {
      await pool.query(
        `UPDATE ${tbl} SET product_id = $1 WHERE product_id = ANY($2)`,
        [master.id, deleteIds]
      );
    }

    // Delete empty non-master products
    const { rowCount: deleted } = await pool.query(
      `DELETE FROM products WHERE id = ANY($1)`, [deleteIds]
    );
    totalProductsDeleted += deleted;

    // Rename master to collection name
    const slug = makeSlug(coll.collection);
    // Extract material suffix from existing display_name
    const suffixMatch = (master.display_name || '').match(/\s+(Porcelain Tile|Ceramic Tile|Natural Stone|Glass Tile|Mosaic Tile|Tile)$/i);
    const suffix = suffixMatch ? suffixMatch[1] : 'Porcelain Tile';

    await pool.query(`
      UPDATE products SET name = $1, display_name = $2, slug = $3 WHERE id = $4
    `, [coll.collection, `${coll.collection} ${suffix}`, slug, master.id]);
  }

  // --- Phase 2: Rename single-color collection products ---
  console.log('\n--- Phase 2: Rename single-product collections ---\n');

  let renamed = 0;
  for (const coll of singleColor) {
    const { rows: [product] } = await pool.query(`
      SELECT p.id, p.name, p.display_name, p.slug
      FROM products p
      WHERE p.vendor_id = $1 AND p.collection = $2
      LIMIT 1
    `, [vendor.id, coll.collection]);

    // Skip if already named after collection
    if (product.name === coll.collection) continue;

    const slug = makeSlug(coll.collection);
    const suffixMatch = (product.display_name || '').match(/\s+(Porcelain Tile|Ceramic Tile|Natural Stone|Glass Tile|Mosaic Tile|Tile)$/i);
    const suffix = suffixMatch ? suffixMatch[1] : 'Porcelain Tile';

    if (dryRun) {
      console.log(`  ${coll.collection}: "${product.name}" → "${coll.collection}"`);
    } else {
      await pool.query(`
        UPDATE products SET name = $1, display_name = $2, slug = $3 WHERE id = $4
      `, [coll.collection, `${coll.collection} ${suffix}`, slug, product.id]);
      console.log(`  ${coll.collection}: "${product.name}" → "${coll.collection}"`);
    }
    renamed++;
  }
  console.log(`  Renamed: ${renamed}`);

  // --- Summary ---
  console.log(`\n=== Summary ===`);
  console.log(`Collections grouped: ${multiColor.length}`);
  console.log(`SKUs moved: ${totalSkusMoved}`);
  console.log(`Media moved: ${totalMediaMoved}`);
  console.log(`Products deleted: ${totalProductsDeleted}`);
  console.log(`Single products renamed: ${renamed}`);

  // Final counts
  const { rows: [final] } = await pool.query(`
    SELECT COUNT(DISTINCT p.id) as products, COUNT(s.id) as skus,
           COUNT(DISTINCT p.collection) as collections
    FROM products p
    JOIN skus s ON s.product_id = p.id
    WHERE p.vendor_id = $1
  `, [vendor.id]);
  console.log(`\nFinal: ${final.products} products, ${final.skus} SKUs, ${final.collections} collections`);

  // Refresh search vectors
  if (!dryRun) {
    console.log('\nRefreshing search vectors...');
    await pool.query(`SELECT refresh_search_vectors()`).catch(() => {
      console.log('  (refresh_search_vectors not available, skipping)');
    });
  }

  await pool.end();
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
