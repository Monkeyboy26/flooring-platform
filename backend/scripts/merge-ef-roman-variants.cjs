#!/usr/bin/env node
/**
 * merge-ef-roman-variants.cjs
 *
 * Merges EF (Engineered Floors) products with Roman numeral suffixes (I, II, III)
 * into single products with sub_line attribute for variant pill display.
 *
 * Example: "Astounding I", "Astounding II", "Astounding III"
 *   → single product "Astounding" with sub_line = I/II/III on each SKU
 *
 * The storefront sub_line pill mechanism (already used for Mannington ADURA)
 * handles filtering colors per sub-line and matching colors when switching.
 *
 * Usage:
 *   node backend/scripts/merge-ef-roman-variants.cjs --dry-run   # preview
 *   node backend/scripts/merge-ef-roman-variants.cjs              # live run
 */

const { Pool } = require('pg');

const pool = new Pool({
  host: 'localhost',
  port: 5432,
  user: 'postgres',
  password: 'postgres',
  database: 'flooring_pim',
});

const DRY_RUN = process.argv.includes('--dry-run');
const SUB_LINE_ATTR_ID = '7eded353-d9ec-4be3-8685-9ca599d80d98';

async function main() {
  const client = await pool.connect();
  try {
    // Get EF vendor ID
    const efVendor = await client.query("SELECT id FROM vendors WHERE code = 'EF'");
    if (!efVendor.rows.length) { console.error('EF vendor not found'); return; }
    const vendorId = efVendor.rows[0].id;

    // Find all Roman numeral product groups with >1 variant
    const groups = await client.query(`
      WITH roman_products AS (
        SELECT p.id, p.name, p.collection,
               CASE
                 WHEN p.name ~ ' III$' THEN 'III'
                 WHEN p.name ~ ' II$' THEN 'II'
                 WHEN p.name ~ ' I$' THEN 'I'
               END AS numeral,
               regexp_replace(p.name, ' (I{1,3})$', '') AS base_name
        FROM products p
        WHERE p.vendor_id = $1
          AND p.name ~ ' I{1,3}$'
          AND p.status = 'active'
      )
      SELECT rp.collection, rp.base_name,
             json_agg(json_build_object(
               'id', rp.id,
               'name', rp.name,
               'numeral', rp.numeral
             ) ORDER BY
               CASE rp.numeral WHEN 'I' THEN 1 WHEN 'II' THEN 2 WHEN 'III' THEN 3 END
             ) AS variants
      FROM roman_products rp
      GROUP BY rp.collection, rp.base_name
      HAVING count(*) > 1
      ORDER BY rp.collection, rp.base_name
    `, [vendorId]);

    console.log(`${DRY_RUN ? '[DRY RUN] ' : ''}Found ${groups.rows.length} product groups to merge\n`);

    let totalSkusMoved = 0;
    let totalMediaMoved = 0;
    let totalProductsDeactivated = 0;
    let totalSubLineAttrsAdded = 0;

    for (const group of groups.rows) {
      const variants = group.variants;
      // Canonical product = first variant (lowest numeral, usually "I")
      const canonical = variants[0];
      const others = variants.slice(1);

      console.log(`=== ${group.base_name} (${group.collection}) ===`);
      console.log(`  Canonical: ${canonical.name} (${canonical.id})`);
      console.log(`  Merging in: ${others.map(v => v.name).join(', ')}`);

      if (!DRY_RUN) {
        await client.query('BEGIN');
      }

      try {
        // Step 1: Add sub_line attribute to canonical product's SKUs
        const canonicalSkus = await client.query(
          `SELECT id FROM skus WHERE product_id = $1 AND status = 'active'`,
          [canonical.id]
        );

        let added = 0;
        for (const sku of canonicalSkus.rows) {
          const existing = await client.query(
            `SELECT 1 FROM sku_attributes WHERE sku_id = $1 AND attribute_id = $2`,
            [sku.id, SUB_LINE_ATTR_ID]
          );
          if (existing.rows.length === 0) {
            if (!DRY_RUN) {
              await client.query(
                `INSERT INTO sku_attributes (sku_id, attribute_id, value) VALUES ($1, $2, $3)`,
                [sku.id, SUB_LINE_ATTR_ID, canonical.numeral]
              );
            }
            added++;
            totalSubLineAttrsAdded++;
          }
        }
        console.log(`  sub_line='${canonical.numeral}' → ${added} SKUs (canonical)`);

        // Step 2: Process each non-canonical variant
        for (const other of others) {
          // Get SKUs from this variant
          const otherSkus = await client.query(
            `SELECT id FROM skus WHERE product_id = $1 AND status = 'active'`,
            [other.id]
          );

          // Add sub_line attribute to these SKUs
          let otherAdded = 0;
          for (const sku of otherSkus.rows) {
            const existing = await client.query(
              `SELECT 1 FROM sku_attributes WHERE sku_id = $1 AND attribute_id = $2`,
              [sku.id, SUB_LINE_ATTR_ID]
            );
            if (existing.rows.length === 0) {
              if (!DRY_RUN) {
                await client.query(
                  `INSERT INTO sku_attributes (sku_id, attribute_id, value) VALUES ($1, $2, $3)`,
                  [sku.id, SUB_LINE_ATTR_ID, other.numeral]
                );
              }
              otherAdded++;
              totalSubLineAttrsAdded++;
            }
          }
          console.log(`  sub_line='${other.numeral}' → ${otherAdded} SKUs`);

          // Move SKUs to canonical product
          if (!DRY_RUN) {
            await client.query(
              `UPDATE skus SET product_id = $1, updated_at = NOW()
               WHERE product_id = $2 AND status = 'active'`,
              [canonical.id, other.id]
            );
          }
          totalSkusMoved += otherSkus.rows.length;
          console.log(`  Moved ${otherSkus.rows.length} SKUs → ${canonical.name}`);

          // Move SKU-level media_assets (update product_id to match new parent)
          if (!DRY_RUN) {
            const skuMedia = await client.query(
              `UPDATE media_assets SET product_id = $1
               WHERE product_id = $2 AND sku_id IS NOT NULL
               RETURNING id`,
              [canonical.id, other.id]
            );
            if (skuMedia.rowCount > 0) {
              totalMediaMoved += skuMedia.rowCount;
              console.log(`  Moved ${skuMedia.rowCount} SKU-level media assets`);
            }
          } else {
            const skuMediaCount = await client.query(
              `SELECT count(*) AS cnt FROM media_assets
               WHERE product_id = $1 AND sku_id IS NOT NULL`,
              [other.id]
            );
            const cnt = parseInt(skuMediaCount.rows[0].cnt);
            if (cnt > 0) {
              totalMediaMoved += cnt;
              console.log(`  Would move ${cnt} SKU-level media assets`);
            }
          }

          // Delete product-level media from non-canonical product.
          // Roman numeral variants share the same collection imagery,
          // so canonical already has equivalent lifestyle/alternate photos.
          // Moving would violate unique constraint (product_id, asset_type, sort_order).
          if (!DRY_RUN) {
            const delResult = await client.query(
              `DELETE FROM media_assets WHERE product_id = $1 AND sku_id IS NULL RETURNING id`,
              [other.id]
            );
            if (delResult.rowCount > 0) {
              console.log(`  Deleted ${delResult.rowCount} duplicate product-level media`);
            }
          } else {
            const prodMediaCount = await client.query(
              `SELECT count(*) AS cnt FROM media_assets
               WHERE product_id = $1 AND sku_id IS NULL`,
              [other.id]
            );
            const cnt = parseInt(prodMediaCount.rows[0].cnt);
            if (cnt > 0) {
              console.log(`  Would delete ${cnt} duplicate product-level media`);
            }
          }

          // Deactivate the now-empty product
          if (!DRY_RUN) {
            await client.query(
              `UPDATE products SET status = 'inactive', is_active = false, updated_at = NOW()
               WHERE id = $1`,
              [other.id]
            );
          }
          totalProductsDeactivated++;
          console.log(`  Deactivated: ${other.name}`);
        }

        // Step 3: Rename canonical product (strip Roman numeral suffix)
        if (!DRY_RUN) {
          await client.query(
            `UPDATE products SET name = $1, updated_at = NOW() WHERE id = $2`,
            [group.base_name, canonical.id]
          );
        }
        console.log(`  Renamed: ${canonical.name} → ${group.base_name}`);

        if (!DRY_RUN) {
          await client.query('COMMIT');
        }
        console.log('');
      } catch (err) {
        if (!DRY_RUN) {
          await client.query('ROLLBACK');
        }
        console.error(`  ERROR: ${err.message}`);
        throw err;
      }
    }

    console.log(`\n--- Summary ---`);
    console.log(`Groups merged: ${groups.rows.length}`);
    console.log(`Sub-line attributes added: ${totalSubLineAttrsAdded}`);
    console.log(`SKUs moved to canonical products: ${totalSkusMoved}`);
    console.log(`Media assets moved: ${totalMediaMoved}`);
    console.log(`Products deactivated: ${totalProductsDeactivated}`);
    if (DRY_RUN) console.log('\n[DRY RUN — no changes made]');

  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
