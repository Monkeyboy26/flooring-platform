#!/usr/bin/env node
/**
 * fix-tw-product-grouping.js
 *
 * Merges duplicate Tri-West products that were created one-per-color instead
 * of one product with multiple color SKUs. Groups by (brand, product_name)
 * and re-parents SKUs + media_assets under a single survivor product.
 *
 * Usage:
 *   node backend/scripts/fix-tw-product-grouping.js --dry-run
 *   node backend/scripts/fix-tw-product-grouping.js
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
  console.log(`\n=== Fix TW Product Grouping ${DRY_RUN ? '(DRY RUN)' : '(LIVE)'} ===\n`);

  // 1. Find the TW vendor
  const vendorRes = await pool.query("SELECT id, name FROM vendors WHERE code = 'TW'");
  if (vendorRes.rows.length === 0) {
    console.error('Vendor TW not found');
    process.exit(1);
  }
  const vendorId = vendorRes.rows[0].id;
  console.log(`Vendor: ${vendorRes.rows[0].name} (${vendorId})`);

  // 2. Get all active TW products with their SKU counts and image counts
  const productsRes = await pool.query(`
    SELECT p.id, p.name, p.collection, p.category_id,
      (SELECT COUNT(*) FROM skus WHERE product_id = p.id AND status = 'active') as sku_count,
      (SELECT COUNT(*) FROM media_assets WHERE product_id = p.id AND sku_id IS NOT NULL) as sku_image_count,
      (SELECT COUNT(*) FROM media_assets WHERE product_id = p.id) as total_image_count
    FROM products p
    WHERE p.vendor_id = $1 AND p.status = 'active'
    ORDER BY p.name, p.collection
  `, [vendorId]);

  console.log(`Total active TW products: ${productsRes.rows.length}`);

  // 3. Extract brand from collection and group by (brand, product_name)
  const groups = new Map();
  for (const p of productsRes.rows) {
    const brand = (p.collection || '').split(' - ')[0].trim() || p.collection || '';
    const key = `${brand}|||${p.name}`;

    if (!groups.has(key)) {
      groups.set(key, { brand, name: p.name, products: [] });
    }
    groups.get(key).products.push(p);
  }

  // 4. Filter to groups with duplicates
  const dupeGroups = [];
  let totalDupeProducts = 0;
  for (const [, group] of groups) {
    if (group.products.length > 1) {
      dupeGroups.push(group);
      totalDupeProducts += group.products.length;
    }
  }

  console.log(`Groups with duplicates: ${dupeGroups.length}`);
  console.log(`Products to merge: ${totalDupeProducts}`);
  console.log(`Products that will remain after merge: ${dupeGroups.length} (one per group)`);
  console.log(`Products to be drafted: ${totalDupeProducts - dupeGroups.length}\n`);

  // Show top examples
  const topExamples = [...dupeGroups].sort((a, b) => b.products.length - a.products.length).slice(0, 10);
  console.log('Top 10 duplicate groups:');
  for (const g of topExamples) {
    console.log(`  "${g.name}" (${g.brand}): ${g.products.length} products`);
  }
  console.log('');

  if (DRY_RUN) {
    console.log('DRY RUN — no changes made. Remove --dry-run to execute.\n');

    // Summary stats
    let totalSkusReparented = 0;
    for (const group of dupeGroups) {
      const survivor = pickSurvivor(group.products);
      for (const p of group.products) {
        if (p.id !== survivor.id) {
          totalSkusReparented += parseInt(p.sku_count) || 0;
        }
      }
    }
    console.log(`Would re-parent ~${totalSkusReparented} SKUs`);
    console.log(`Would draft ~${totalDupeProducts - dupeGroups.length} products`);
    console.log(`Would update collection on ~${dupeGroups.length} survivor products`);

    await pool.end();
    return;
  }

  // 5. Execute merges
  const stats = {
    groups_merged: 0,
    skus_reparented: 0,
    media_reparented: 0,
    products_drafted: 0,
    survivors_updated: 0,
    search_vectors_refreshed: 0,
    errors: 0,
  };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const group of dupeGroups) {
      try {
        await client.query('SAVEPOINT merge_group');

        const survivor = pickSurvivor(group.products);
        const others = group.products.filter(p => p.id !== survivor.id);
        const otherIds = others.map(p => p.id);

        // Re-parent SKUs
        const skuResult = await client.query(
          `UPDATE skus SET product_id = $1, updated_at = NOW() WHERE product_id = ANY($2)`,
          [survivor.id, otherIds]
        );
        stats.skus_reparented += skuResult.rowCount;

        // Re-parent SKU-level media_assets (sku_id IS NOT NULL) — no unique conflict
        await client.query(
          `UPDATE media_assets SET product_id = $1 WHERE product_id = ANY($2) AND sku_id IS NOT NULL`,
          [survivor.id, otherIds]
        );

        // Product-level media_assets (sku_id IS NULL): survivor may already have images
        // at same (asset_type, sort_order), so delete losers' duplicates then move the rest
        await client.query(`
          DELETE FROM media_assets m
          WHERE m.product_id = ANY($2) AND m.sku_id IS NULL
            AND EXISTS (
              SELECT 1 FROM media_assets e
              WHERE e.product_id = $1 AND e.sku_id IS NULL
                AND e.asset_type = m.asset_type AND e.sort_order = m.sort_order
            )
        `, [survivor.id, otherIds]);
        const mediaResult = await client.query(
          `UPDATE media_assets SET product_id = $1 WHERE product_id = ANY($2) AND sku_id IS NULL`,
          [survivor.id, otherIds]
        );
        stats.media_reparented += mediaResult.rowCount;

        // Update survivor: set collection to brand only
        await client.query(
          `UPDATE products SET collection = $1, updated_at = NOW() WHERE id = $2`,
          [group.brand, survivor.id]
        );
        stats.survivors_updated++;

        // Draft the others
        const draftResult = await client.query(
          `UPDATE products SET status = 'draft', updated_at = NOW() WHERE id = ANY($1)`,
          [otherIds]
        );
        stats.products_drafted += draftResult.rowCount;

        // Refresh search vector on survivor
        await client.query(`SELECT refresh_search_vectors($1)`, [survivor.id]);
        stats.search_vectors_refreshed++;

        await client.query('RELEASE SAVEPOINT merge_group');
        stats.groups_merged++;
      } catch (err) {
        await client.query('ROLLBACK TO SAVEPOINT merge_group');
        console.error(`Error merging group "${group.name}" (${group.brand}):`, err.message);
        stats.errors++;
      }
    }

    await client.query('COMMIT');
    console.log('\nTransaction committed successfully.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Transaction rolled back:', err.message);
    process.exit(1);
  } finally {
    client.release();
  }

  console.log('\n=== Results ===');
  console.log(`Groups merged:           ${stats.groups_merged}`);
  console.log(`SKUs re-parented:        ${stats.skus_reparented}`);
  console.log(`Media assets moved:      ${stats.media_reparented}`);
  console.log(`Survivor products updated: ${stats.survivors_updated}`);
  console.log(`Products drafted:        ${stats.products_drafted}`);
  console.log(`Search vectors refreshed: ${stats.search_vectors_refreshed}`);
  if (stats.errors > 0) console.log(`Errors:                  ${stats.errors}`);
  console.log('');

  await pool.end();
}

/**
 * Pick the survivor product from a group of duplicates.
 * Prefer: most SKU-level images → most SKUs → first alphabetically by collection (stable).
 */
function pickSurvivor(products) {
  return products.slice().sort((a, b) => {
    const imgDiff = (parseInt(b.sku_image_count) || 0) - (parseInt(a.sku_image_count) || 0);
    if (imgDiff !== 0) return imgDiff;
    const skuDiff = (parseInt(b.sku_count) || 0) - (parseInt(a.sku_count) || 0);
    if (skuDiff !== 0) return skuDiff;
    return (a.collection || '').localeCompare(b.collection || '');
  })[0];
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
