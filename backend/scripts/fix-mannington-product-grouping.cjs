#!/usr/bin/env node
/**
 * Fix Mannington Product Grouping
 *
 * Problem: ~40 pattern names (e.g. "Napa") appear as 2-4 separate products
 * across ADURA sub-lines (Flex, Max, Rigid, APEX, PRO). This script:
 *
 * 1. Stamps each ADURA SKU with a `sub_line` attribute preserving original collection
 * 2. Merges same-pattern products into single products (keeper = most SKUs)
 * 3. Consolidates all "ADURA *" collections into a single "ADURA" collection
 * 4. Sets display_name for all Mannington products
 * 5. Rebuilds search vectors for affected products
 *
 * Usage: node fix-mannington-product-grouping.cjs [--dry-run] [--verbose]
 */

const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres'
});

const DRY_RUN = process.argv.includes('--dry-run');
const VERBOSE = process.argv.includes('--verbose');

function log(...args) { console.log(...args); }
function verbose(...args) { if (VERBOSE) console.log('  [verbose]', ...args); }

async function main() {
  const client = await pool.connect();
  try {
    if (DRY_RUN) log('=== DRY RUN MODE — no changes will be made ===\n');

    // Find Mannington vendor
    const { rows: [vendor] } = await client.query(
      `SELECT id FROM vendors WHERE LOWER(name) LIKE '%mannington%' LIMIT 1`
    );
    if (!vendor) { log('ERROR: Mannington vendor not found'); return; }
    const vendorId = vendor.id;
    log(`Mannington vendor ID: ${vendorId}\n`);

    // ================================================================
    // STEP 1: Ensure sub_line attribute exists & stamp ADURA SKUs
    // ================================================================
    log('=== Step 1: Stamp sub_line attribute on ADURA SKUs ===');

    // Ensure the attribute exists
    let { rows: [subLineAttr] } = await client.query(
      `SELECT id FROM attributes WHERE slug = 'sub_line'`
    );
    if (!subLineAttr) {
      if (!DRY_RUN) {
        const { rows: [created] } = await client.query(
          `INSERT INTO attributes (name, slug, display_order, is_filterable)
           VALUES ('Sub-Line', 'sub_line', 50, true) RETURNING id`
        );
        subLineAttr = created;
        log('  Created sub_line attribute');
      } else {
        log('  Would create sub_line attribute');
        subLineAttr = { id: 'dry-run-placeholder' };
      }
    } else {
      log(`  sub_line attribute already exists (${subLineAttr.id})`);
    }

    // Get all ADURA products with their current collections
    const { rows: aduraProducts } = await client.query(`
      SELECT p.id, p.name, p.collection
      FROM products p
      WHERE p.vendor_id = $1 AND p.collection LIKE 'ADURA%'
      ORDER BY p.collection, p.name
    `, [vendorId]);
    log(`  Found ${aduraProducts.length} ADURA products`);

    // Stamp sub_line on each ADURA SKU (original collection name)
    let stamped = 0;
    for (const prod of aduraProducts) {
      const { rows: skus } = await client.query(
        `SELECT id FROM skus WHERE product_id = $1 AND status = 'active'`,
        [prod.id]
      );
      for (const sku of skus) {
        if (!DRY_RUN) {
          await client.query(`
            INSERT INTO sku_attributes (sku_id, attribute_id, value)
            VALUES ($1, $2, $3)
            ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value = $3
          `, [sku.id, subLineAttr.id, prod.collection]);
        }
        stamped++;
      }
      verbose(`  ${prod.collection} / ${prod.name}: ${skus.length} SKUs stamped`);
    }
    log(`  Stamped sub_line on ${stamped} SKUs\n`);

    // ================================================================
    // STEP 2: Merge same-pattern products across ADURA sub-lines
    // ================================================================
    log('=== Step 2: Merge same-pattern products ===');

    // Find pattern names that appear in multiple ADURA collections
    const { rows: duplicatePatterns } = await client.query(`
      SELECT p.name, array_agg(p.id ORDER BY p.collection) as product_ids,
             array_agg(p.collection ORDER BY p.collection) as collections,
             array_agg(
               (SELECT count(*) FROM skus s
                WHERE s.product_id = p.id AND s.status = 'active'
                AND COALESCE(s.variant_type, '') != 'accessory')::int
               ORDER BY p.collection
             ) as sku_counts
      FROM products p
      WHERE p.vendor_id = $1 AND p.collection LIKE 'ADURA%'
      GROUP BY p.name
      HAVING count(DISTINCT p.collection) > 1
      ORDER BY p.name
    `, [vendorId]);

    log(`  Found ${duplicatePatterns.length} patterns appearing in multiple ADURA collections\n`);

    let totalMerged = 0;
    let totalDonorsDeleted = 0;
    let totalSkusMoved = 0;

    for (const pattern of duplicatePatterns) {
      const { name, product_ids, collections, sku_counts } = pattern;

      // Pick the keeper: the product with the most non-accessory SKUs
      let keeperIdx = 0;
      let maxCount = sku_counts[0];
      for (let i = 1; i < sku_counts.length; i++) {
        if (sku_counts[i] > maxCount) { maxCount = sku_counts[i]; keeperIdx = i; }
      }
      const keeperId = product_ids[keeperIdx];
      const keeperCollection = collections[keeperIdx];
      const donorIds = product_ids.filter((_, i) => i !== keeperIdx);
      const donorCollections = collections.filter((_, i) => i !== keeperIdx);

      log(`  Pattern: "${name}"`);
      log(`    Keeper: ${keeperCollection} (${maxCount} SKUs) [${keeperId}]`);
      donorIds.forEach((id, i) => {
        log(`    Donor:  ${donorCollections[i]} (${sku_counts[product_ids.indexOf(id)]} SKUs) [${id}]`);
      });

      if (!DRY_RUN) {
        await client.query('BEGIN');
        try {
          for (const donorId of donorIds) {
            // Get donor's accessory vendor_skus to deduplicate
            const { rows: donorAccessories } = await client.query(`
              SELECT s.id, s.vendor_sku FROM skus s
              WHERE s.product_id = $1 AND s.variant_type = 'accessory'
            `, [donorId]);

            // Get keeper's existing accessory vendor_skus
            const { rows: keeperAccessories } = await client.query(`
              SELECT s.vendor_sku FROM skus s
              WHERE s.product_id = $1 AND s.variant_type = 'accessory'
            `, [keeperId]);
            const keeperAccSkus = new Set(keeperAccessories.map(a => a.vendor_sku));

            // Delete duplicate accessories (same vendor_sku already on keeper)
            const dupeAccIds = donorAccessories
              .filter(a => keeperAccSkus.has(a.vendor_sku))
              .map(a => a.id);
            if (dupeAccIds.length > 0) {
              // Clean up references before deleting
              await client.query(`DELETE FROM sku_attributes WHERE sku_id = ANY($1::uuid[])`, [dupeAccIds]);
              await client.query(`DELETE FROM pricing WHERE sku_id = ANY($1::uuid[])`, [dupeAccIds]);
              await client.query(`DELETE FROM packaging WHERE sku_id = ANY($1::uuid[])`, [dupeAccIds]);
              await client.query(`DELETE FROM media_assets WHERE sku_id = ANY($1::uuid[])`, [dupeAccIds]);
              await client.query(`DELETE FROM cart_items WHERE sku_id = ANY($1::uuid[])`, [dupeAccIds]);
              await client.query(`DELETE FROM skus WHERE id = ANY($1::uuid[])`, [dupeAccIds]);
              verbose(`    Deleted ${dupeAccIds.length} duplicate accessories from donor ${donorId}`);
            }

            // Move remaining donor SKUs to keeper
            const { rowCount: skusMoved } = await client.query(
              `UPDATE skus SET product_id = $1 WHERE product_id = $2`,
              [keeperId, donorId]
            );
            totalSkusMoved += skusMoved;
            verbose(`    Moved ${skusMoved} SKUs from ${donorId} to keeper`);

            // Move donor media_assets to keeper
            await client.query(
              `UPDATE media_assets SET product_id = $1 WHERE product_id = $2`,
              [keeperId, donorId]
            );

            // Delete the now-empty donor product
            await client.query(`DELETE FROM products WHERE id = $1`, [donorId]);
            totalDonorsDeleted++;
          }
          await client.query('COMMIT');
          totalMerged++;
          log(`    -> Merged ${donorIds.length} donors into keeper`);
        } catch (err) {
          await client.query('ROLLBACK');
          log(`    ERROR merging "${name}": ${err.message}`);
        }
      } else {
        totalMerged++;
        totalDonorsDeleted += donorIds.length;
        for (const donorId of donorIds) {
          const { rows: [{ count }] } = await client.query(
            `SELECT count(*) FROM skus WHERE product_id = $1`, [donorId]
          );
          totalSkusMoved += parseInt(count);
        }
      }
    }

    log(`\n  Summary: ${totalMerged} patterns merged, ${totalDonorsDeleted} donor products deleted, ${totalSkusMoved} SKUs moved\n`);

    // ================================================================
    // STEP 3: Consolidate ADURA collections
    // ================================================================
    log('=== Step 3: Consolidate ADURA collections into "ADURA" ===');

    // Important: we need to handle the unique constraint (vendor_id, collection, name).
    // After merging, each pattern name is unique within ADURA, so this should be safe.
    // But check for conflicts first.
    const { rows: conflicts } = await client.query(`
      SELECT name, array_agg(DISTINCT collection) as collections
      FROM products
      WHERE vendor_id = $1 AND collection LIKE 'ADURA%' AND collection != 'ADURA'
      GROUP BY name
      HAVING EXISTS (
        SELECT 1 FROM products p2
        WHERE p2.vendor_id = $1 AND p2.collection = 'ADURA' AND p2.name = products.name
      )
    `, [vendorId]);

    if (conflicts.length > 0) {
      log('  WARNING: These patterns would conflict with existing ADURA products:');
      conflicts.forEach(c => log(`    "${c.name}" in ${c.collections.join(', ')}`));
      log('  Skipping collection consolidation to avoid unique constraint violations.');
    } else {
      if (!DRY_RUN) {
        const { rowCount } = await client.query(`
          UPDATE products SET collection = 'ADURA'
          WHERE vendor_id = $1 AND collection LIKE 'ADURA%' AND collection != 'ADURA'
        `, [vendorId]);
        log(`  Updated ${rowCount} products to collection = 'ADURA'`);
      } else {
        const { rows: [{ count }] } = await client.query(`
          SELECT count(*) FROM products
          WHERE vendor_id = $1 AND collection LIKE 'ADURA%' AND collection != 'ADURA'
        `, [vendorId]);
        log(`  Would update ${count} products to collection = 'ADURA'`);
      }
    }
    log('');

    // ================================================================
    // STEP 4: Set display_name
    // ================================================================
    log('=== Step 4: Set display_name ===');

    // ADURA products: display_name = name (pattern name like "Napa")
    if (!DRY_RUN) {
      const { rowCount: aduraUpdated } = await client.query(`
        UPDATE products SET display_name = name
        WHERE vendor_id = $1 AND collection = 'ADURA'
      `, [vendorId]);
      log(`  Set display_name for ${aduraUpdated} ADURA products`);
    } else {
      const { rows: [{ count }] } = await client.query(`
        SELECT count(*) FROM products WHERE vendor_id = $1 AND collection = 'ADURA'
      `, [vendorId]);
      log(`  Would set display_name for ${count} ADURA products`);
    }

    // Non-ADURA: display_name = collection + ' ' + name (if different), else just name
    if (!DRY_RUN) {
      const { rowCount: nonAduraUpdated } = await client.query(`
        UPDATE products
        SET display_name = CASE
          WHEN name = collection THEN name
          ELSE collection || ' ' || name
        END
        WHERE vendor_id = $1 AND collection NOT LIKE 'ADURA%'
          AND (display_name IS NULL OR display_name = '')
      `, [vendorId]);
      log(`  Set display_name for ${nonAduraUpdated} non-ADURA products`);
    } else {
      const { rows: [{ count }] } = await client.query(`
        SELECT count(*) FROM products
        WHERE vendor_id = $1 AND collection NOT LIKE 'ADURA%'
          AND (display_name IS NULL OR display_name = '')
      `, [vendorId]);
      log(`  Would set display_name for ${count} non-ADURA products`);
    }
    log('');

    // ================================================================
    // STEP 5: Rebuild search vectors
    // ================================================================
    log('=== Step 5: Rebuild search vectors ===');

    if (!DRY_RUN) {
      // Refresh search vectors for all affected Mannington products
      const { rows: affectedProducts } = await client.query(
        `SELECT id FROM products WHERE vendor_id = $1`, [vendorId]
      );
      for (const prod of affectedProducts) {
        await client.query(`SELECT refresh_search_vectors($1)`, [prod.id]);
      }
      log(`  Rebuilt search vectors for ${affectedProducts.length} products`);
    } else {
      const { rows: [{ count }] } = await client.query(
        `SELECT count(*) FROM products WHERE vendor_id = $1`, [vendorId]
      );
      log(`  Would rebuild search vectors for ${count} products`);
    }

    // ================================================================
    // Final report
    // ================================================================
    log('\n=== Final Report ===');
    const { rows: finalStats } = await client.query(`
      SELECT
        count(*) as total_products,
        count(DISTINCT collection) as distinct_collections,
        (SELECT count(*) FROM skus s JOIN products p ON s.product_id = p.id
         WHERE p.vendor_id = $1 AND s.status = 'active') as total_skus
      FROM products WHERE vendor_id = $1
    `, [vendorId]);
    const stats = finalStats[0];
    log(`  Mannington products: ${stats.total_products}`);
    log(`  Distinct collections: ${stats.distinct_collections}`);
    log(`  Active SKUs: ${stats.total_skus}`);

    // Show collection breakdown
    const { rows: collBreakdown } = await client.query(`
      SELECT collection, count(*) as products,
        (SELECT count(*) FROM skus s WHERE s.product_id = ANY(array_agg(p.id)) AND s.status = 'active') as skus
      FROM products p WHERE p.vendor_id = $1
      GROUP BY collection ORDER BY collection
    `, [vendorId]);
    log('\n  Collection breakdown:');
    collBreakdown.forEach(r => log(`    ${r.collection}: ${r.products} products, ${r.skus} SKUs`));

    if (DRY_RUN) log('\n=== DRY RUN COMPLETE — no changes were made ===');
    else log('\n=== DONE ===');

  } catch (err) {
    console.error('Fatal error:', err);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
