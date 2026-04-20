#!/usr/bin/env node
/**
 * Daltile Data Cleanup v3 — Multi-fix script
 *
 * Fixes:
 *   1. Tag 6 untagged trim/molding SKUs as accessories
 *   2. Standardize Gray → Grey across product names, display_names, and color attributes
 *   3. Fix 14 products with generic display_names (no color)
 *   4. Backfill 1,164 empty variant_names from size/shape attributes
 *   5. Backfill material attribute from display_name (Porcelain/Ceramic/etc.)
 *
 * Usage:
 *   node backend/scripts/cleanup-daltile-v3.cjs --dry-run
 *   node backend/scripts/cleanup-daltile-v3.cjs
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
  console.log(`\n=== Daltile Cleanup v3 (${DRY_RUN ? 'DRY RUN' : 'LIVE'}) ===\n`);

  try {
    await client.query('BEGIN');

    const vendorRes = await client.query(`SELECT id FROM vendors WHERE code = 'DAL'`);
    if (!vendorRes.rows.length) { console.error('DAL vendor not found'); return; }
    const dalVendorId = vendorRes.rows[0].id;

    // ═══════════════════════════════════════════════════════════════════
    // Fix 1: Tag untagged trim/molding SKUs as accessories
    // ═══════════════════════════════════════════════════════════════════
    console.log('--- Fix 1: Tag Untagged Trim/Molding SKUs ---');

    const trimRes = await client.query(`
      UPDATE skus SET variant_type = 'accessory', updated_at = CURRENT_TIMESTAMP
      WHERE id IN (
        SELECT s.id FROM skus s
        JOIN products p ON p.id = s.product_id
        WHERE p.vendor_id = $1 AND s.status = 'active' AND p.status = 'active'
          AND s.variant_type IS DISTINCT FROM 'accessory'
          AND s.vendor_sku ~* 'SLIMT|VSLCAP|VQRND|EXTSN|RNDSTRD|VRDSN|VSCAP|VSTRD|ENDCAP|TMOLD|VNOSE|BULL'
      )
      RETURNING id, vendor_sku
    `, [dalVendorId]);

    for (const row of trimRes.rows) {
      console.log(`  Tagged as accessory: ${row.vendor_sku}`);
    }
    console.log(`  Total tagged: ${trimRes.rowCount}\n`);

    // ═══════════════════════════════════════════════════════════════════
    // Fix 2: Standardize Gray → Grey
    // ═══════════════════════════════════════════════════════════════════
    console.log('--- Fix 2: Standardize Gray → Grey ---');

    // Fix product names (row-by-row to handle unique constraint conflicts via merge)
    const grayProducts = await client.query(`
      SELECT id, name, display_name, collection
      FROM products
      WHERE vendor_id = $1 AND status = 'active' AND name ~ '\\mGray\\M'
    `, [dalVendorId]);

    let namesFixed = 0, namesMerged = 0;
    for (const row of grayProducts.rows) {
      const newName = row.name.replace(/\bGray\b/g, 'Grey');
      const newDisplay = (row.display_name || '').replace(/\bGray\b/g, 'Grey');

      // Check if target name already exists
      const existing = await client.query(`
        SELECT id FROM products WHERE vendor_id = $1 AND name = $2 AND collection = $3 AND id != $4 AND status = 'active' LIMIT 1
      `, [dalVendorId, newName, row.collection, row.id]);

      if (existing.rows.length > 0) {
        // Merge: move SKUs & media to existing, deactivate this one
        const targetId = existing.rows[0].id;
        await client.query(`UPDATE skus SET product_id = $1, updated_at = CURRENT_TIMESTAMP WHERE product_id = $2`, [targetId, row.id]);
        const media = await client.query(`SELECT id FROM media_assets WHERE product_id = $1`, [row.id]);
        for (const m of media.rows) {
          try {
            await client.query(`UPDATE media_assets SET product_id = $1 WHERE id = $2`, [targetId, m.id]);
          } catch (e) {
            if (e.code === '23505') await client.query(`DELETE FROM media_assets WHERE id = $1`, [m.id]);
            else throw e;
          }
        }
        await client.query(`UPDATE products SET status = 'inactive', updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [row.id]);
        if (DRY_RUN) console.log(`  MERGE: "${row.name}" → existing "${newName}"`);
        namesMerged++;
      } else {
        await client.query(`UPDATE products SET name = $1, display_name = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3`,
          [newName, newDisplay, row.id]);
        namesFixed++;
      }
    }
    console.log(`  Product names fixed: ${namesFixed}`);
    console.log(`  Product names merged: ${namesMerged}`);

    // Fix color attributes
    const colorAttrRes = await client.query(`SELECT id FROM attributes WHERE slug = 'color'`);
    if (colorAttrRes.rows.length) {
      const colorAttrId = colorAttrRes.rows[0].id;
      const colorGrayRes = await client.query(`
        UPDATE sku_attributes SET value = REGEXP_REPLACE(value, '\\mGray\\M', 'Grey', 'g')
        WHERE attribute_id = $1
          AND value ~ '\\mGray\\M'
          AND sku_id IN (
            SELECT s.id FROM skus s
            JOIN products p ON p.id = s.product_id
            WHERE p.vendor_id = $2 AND s.status = 'active'
          )
        RETURNING sku_id
      `, [colorAttrId, dalVendorId]);
      console.log(`  Color attributes fixed: ${colorGrayRes.rowCount}`);
    }
    console.log('');

    // ═══════════════════════════════════════════════════════════════════
    // Fix 3: Fix generic display_names (no color)
    // ═══════════════════════════════════════════════════════════════════
    console.log('--- Fix 3: Fix Generic Display Names ---');

    // Find products where name = collection (no color in name)
    const genericRes = await client.query(`
      SELECT p.id, p.name, p.display_name, p.collection,
        (SELECT ARRAY_AGG(DISTINCT sa.value) FROM sku_attributes sa
         JOIN attributes a ON a.id = sa.attribute_id
         JOIN skus s ON s.id = sa.sku_id
         WHERE a.slug = 'color' AND s.product_id = p.id AND s.status = 'active'
        ) AS colors
      FROM products p
      WHERE p.vendor_id = $1 AND p.status = 'active'
        AND p.name = p.collection
    `, [dalVendorId]);

    let genericFixed = 0;
    for (const row of genericRes.rows) {
      if (!row.colors || row.colors.length === 0) continue;
      // If all SKUs share the same color, add it to the name
      if (row.colors.length === 1 && row.colors[0]) {
        const color = row.colors[0];
        const newName = `${row.collection} ${color}`;
        // Update display_name: replace "Collection TileType" with "Collection Color TileType"
        const tileTypeMatch = row.display_name.match(/\s+(Porcelain Tile|Ceramic Tile|Mosaic Tile|Backsplash Tile|Glass Tile|Molding|LVT|Luxury Vinyl Tile)$/i);
        let newDisplayName;
        if (tileTypeMatch) {
          newDisplayName = `${row.collection} ${color}${tileTypeMatch[0]}`;
        } else {
          newDisplayName = `${row.collection} ${color}`;
        }

        console.log(`  "${row.display_name}" → "${newDisplayName}"`);

        if (!DRY_RUN) {
          // Check for existing product with same name to avoid unique constraint
          const existing = await client.query(`
            SELECT id FROM products WHERE vendor_id = $1 AND name = $2 AND id != $3 AND status = 'active' LIMIT 1
          `, [dalVendorId, newName, row.id]);

          if (existing.rows.length > 0) {
            // Merge into existing
            const targetId = existing.rows[0].id;
            await client.query(`UPDATE skus SET product_id = $1, updated_at = CURRENT_TIMESTAMP WHERE product_id = $2`, [targetId, row.id]);
            await client.query(`UPDATE products SET status = 'inactive', updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [row.id]);
            console.log(`    → Merged into existing product`);
          } else {
            await client.query(`UPDATE products SET name = $1, display_name = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3`,
              [newName, newDisplayName, row.id]);
          }
        }
        genericFixed++;
      } else {
        // Multiple colors — these products just need their SKUs split or left as-is
        if (DRY_RUN) {
          console.log(`  SKIP "${row.display_name}" — multiple colors: ${row.colors.join(', ')}`);
        }
      }
    }
    console.log(`  Generic names fixed: ${genericFixed}\n`);

    // ═══════════════════════════════════════════════════════════════════
    // Fix 4: Backfill empty variant_names
    // ═══════════════════════════════════════════════════════════════════
    console.log('--- Fix 4: Backfill Empty Variant Names ---');

    const sizeAttrRes = await client.query(`SELECT id FROM attributes WHERE slug = 'size'`);
    const shapeAttrRes = await client.query(`SELECT id FROM attributes WHERE slug = 'shape'`);
    const sizeAttrId = sizeAttrRes.rows[0]?.id;
    const shapeAttrId = shapeAttrRes.rows[0]?.id;

    const emptyVariantRes = await client.query(`
      SELECT s.id AS sku_id, s.vendor_sku,
        (SELECT sa.value FROM sku_attributes sa WHERE sa.sku_id = s.id AND sa.attribute_id = $2) AS size_val,
        (SELECT sa.value FROM sku_attributes sa WHERE sa.sku_id = s.id AND sa.attribute_id = $3) AS shape_val
      FROM skus s
      JOIN products p ON p.id = s.product_id
      WHERE p.vendor_id = $1 AND s.status = 'active' AND p.status = 'active'
        AND s.variant_type IS DISTINCT FROM 'accessory'
        AND (s.variant_name IS NULL OR s.variant_name = '')
    `, [dalVendorId, sizeAttrId, shapeAttrId]);

    let variantFixed = 0;
    for (const row of emptyVariantRes.rows) {
      let variantName = '';

      if (row.size_val) {
        // Use size as primary identifier (matches existing patterns like "12x24", "6x6")
        variantName = row.size_val;
      }

      if (row.shape_val && row.shape_val !== variantName) {
        variantName = variantName ? `${variantName} ${row.shape_val}` : row.shape_val;
      }

      if (!variantName) continue;

      if (DRY_RUN && variantFixed < 15) {
        console.log(`  ${row.vendor_sku} → "${variantName}"`);
      }

      if (!DRY_RUN) {
        await client.query(`UPDATE skus SET variant_name = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
          [variantName, row.sku_id]);
      }
      variantFixed++;
    }
    console.log(`  Variant names set: ${variantFixed}`);
    console.log(`  Still empty (no size/shape data): ${emptyVariantRes.rows.length - variantFixed}\n`);

    // ═══════════════════════════════════════════════════════════════════
    // Fix 5: Backfill material attribute from display_name
    // ═══════════════════════════════════════════════════════════════════
    console.log('--- Fix 5: Backfill Material Attribute ---');

    const materialAttrRes = await client.query(`SELECT id FROM attributes WHERE slug = 'material'`);
    if (!materialAttrRes.rows.length) {
      console.log('  No "material" attribute found, skipping\n');
    } else {
      const materialAttrId = materialAttrRes.rows[0].id;

      // Map display_name keywords to material values
      const MATERIAL_MAP = [
        [/Porcelain/i, 'Porcelain'],
        [/Ceramic/i, 'Ceramic'],
        [/Glass/i, 'Glass'],
        [/Natural Stone/i, 'Natural Stone'],
        [/Marble/i, 'Marble'],
        [/Travertine/i, 'Travertine'],
        [/Quartzite/i, 'Quartzite'],
        [/Limestone/i, 'Limestone'],
        [/Slate/i, 'Slate'],
        [/LVT|Luxury Vinyl/i, 'Luxury Vinyl'],
      ];

      const missingMaterialRes = await client.query(`
        SELECT s.id AS sku_id, p.display_name, p.name
        FROM skus s
        JOIN products p ON p.id = s.product_id
        LEFT JOIN sku_attributes sa ON sa.sku_id = s.id AND sa.attribute_id = $2
        WHERE p.vendor_id = $1 AND s.status = 'active' AND p.status = 'active'
          AND s.variant_type IS DISTINCT FROM 'accessory'
          AND sa.value IS NULL
      `, [dalVendorId, materialAttrId]);

      let materialSet = 0;
      for (const row of missingMaterialRes.rows) {
        const text = `${row.display_name || ''} ${row.name || ''}`;
        let material = null;
        for (const [re, val] of MATERIAL_MAP) {
          if (re.test(text)) { material = val; break; }
        }
        if (!material) continue;

        if (DRY_RUN && materialSet < 10) {
          console.log(`  "${row.display_name}" → ${material}`);
        }

        if (!DRY_RUN) {
          await client.query(`
            INSERT INTO sku_attributes (sku_id, attribute_id, value)
            VALUES ($1, $2, $3)
            ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value = EXCLUDED.value
          `, [row.sku_id, materialAttrId, material]);
        }
        materialSet++;
      }
      console.log(`  Material set: ${materialSet}`);
      console.log(`  No material parseable: ${missingMaterialRes.rows.length - materialSet}\n`);
    }

    // ═══════════════════════════════════════════════════════════════════
    // Summary
    // ═══════════════════════════════════════════════════════════════════
    if (DRY_RUN) {
      console.log('=== DRY RUN — Rolling back ===');
      await client.query('ROLLBACK');
    } else {
      await client.query('COMMIT');
      console.log('=== Changes committed ===');
    }

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error:', err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
