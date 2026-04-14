#!/usr/bin/env node
/**
 * fix-adex-grouping.cjs
 *
 * Fixes broken product grouping for ADEX USA collections where color variants
 * were imported as separate products (1 SKU each) instead of grouped under a
 * single product. Re-parents SKUs + media_assets under survivor products and
 * drafts the duplicates.
 *
 * Collections fixed:
 *   Mosaic  — 45 products → 4 (color baked into product name)
 *   Horizon — 43 products → 7 (3 colors grouped, 3 split out as separate products)
 *   Neri    — 79 products → ~49 (Satin White always split; End Caps fragmented)
 *   Hampton — 29 products → 28 (split Rail Molding Frame Corner)
 *
 * Usage:
 *   node backend/scripts/fix-adex-grouping.cjs --dry-run
 *   node backend/scripts/fix-adex-grouping.cjs
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

// ──────────────────────────────────────────────────
// Collection-specific group key functions
// ──────────────────────────────────────────────────

// Mosaic colors (sorted longest-first to avoid partial matches)
const MOSAIC_COLORS = [
  'Light Sandstone', 'Light Smoke', 'Light Blue', 'Light Gray',
  'Matte Black', 'Matte White',
  'Black', 'Denim', 'Smoke', 'Sage', 'Taupe', 'Teal', 'White',
];

function mosaicGroupKey(name) {
  let key = name;
  for (const color of MOSAIC_COLORS) {
    // Color at start: "Black Penny Rounds 12 3/8 x 11 1/2" → "Penny Rounds ..."
    if (key.startsWith(color + ' ')) {
      key = key.slice(color.length + 1);
      break;
    }
    // Color in middle: "Hex 1\" Black 11.97 x 11.69" → "Hex 1\" 11.97 x 11.69"
    const idx = key.indexOf(' ' + color + ' ');
    if (idx !== -1) {
      key = key.slice(0, idx) + key.slice(idx + color.length + 1);
      break;
    }
  }
  return key.trim();
}

// Horizon: colors = Natural/Platinum/Sable, finishes = Glossy/Matte
const HORIZON_COLORS = ['Natural', 'Platinum', 'Sable'];
const HORIZON_FINISHES = ['Glossy', 'Matte'];

function horizonGroupKey(name) {
  let key = name;
  for (const color of HORIZON_COLORS) {
    for (const finish of HORIZON_FINISHES) {
      const token = ` ${color} ${finish} `;
      if (key.includes(token)) {
        key = key.replace(token, ' ');
        return key.replace(/\s+/g, ' ').trim();
      }
      const endToken = ` ${color} ${finish}`;
      if (key.endsWith(endToken)) {
        key = key.slice(0, -endToken.length);
        return key.trim();
      }
    }
  }
  return key.trim();
}

// Neri: strip "Satin White" / "Satin" / "Lino" from name,
// then strip trailing dimensions from End Cap / Frame Corner / Finishing Edge Corner
function neriGroupKey(name) {
  let key = name;

  // Strip color/finish words (longest match first)
  // "Satin White" in middle (before dimensions)
  key = key.replace(/ Satin White /g, ' ');
  // "Satin" at end
  key = key.replace(/ Satin$/, '');
  // "Lino" in middle (before dimensions)
  key = key.replace(/ Lino /g, ' ');

  key = key.replace(/\s+/g, ' ').trim();

  // For End Cap / Frame Corner / Finishing Edge Corner, strip trailing dimensions
  // so that "Base Board End Cap 12" and "Base Board End Cap 6" merge to "Base Board End Cap"
  const baseForCheck = key.replace(/\s+\d[\d. x/]*$/, '');
  if (/End Cap|Frame Corner/.test(baseForCheck) || /^Finishing Edge Corner/.test(key)) {
    key = key.replace(/\s+\d[\d. x/]*$/, '');
  }

  return key.trim();
}

// Hampton: merge split Rail Molding Frame Corner
function hamptonGroupKey(name) {
  let key = name;
  if (/Frame Corner/.test(key)) {
    key = key.replace(/\s+\d[\d. x/]*$/, '');
  }
  return key.trim();
}

// Map collection name → group key function
const GROUP_KEY_FN = {
  Mosaic: mosaicGroupKey,
  Horizon: horizonGroupKey,
  Neri: neriGroupKey,
  Hampton: hamptonGroupKey,
};

const TARGET_COLLECTIONS = Object.keys(GROUP_KEY_FN);

// ──────────────────────────────────────────────────
// Survivor selection
// ──────────────────────────────────────────────────

function pickSurvivor(products) {
  return products.slice().sort((a, b) => {
    // Most SKUs first
    const skuDiff = (parseInt(b.sku_count) || 0) - (parseInt(a.sku_count) || 0);
    if (skuDiff !== 0) return skuDiff;
    // Most images
    const imgDiff = (parseInt(b.total_image_count) || 0) - (parseInt(a.total_image_count) || 0);
    if (imgDiff !== 0) return imgDiff;
    // Alphabetically first name (stable)
    return (a.name || '').localeCompare(b.name || '');
  })[0];
}

// ──────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────

async function main() {
  console.log(`\n=== Fix ADEX Product Grouping ${DRY_RUN ? '(DRY RUN)' : '(LIVE)'} ===\n`);

  // 1. Find ADEX vendor
  const vendorRes = await pool.query("SELECT id, name FROM vendors WHERE code = 'ADEX'");
  if (vendorRes.rows.length === 0) {
    console.error('Vendor ADEX not found');
    process.exit(1);
  }
  const vendorId = vendorRes.rows[0].id;
  console.log(`Vendor: ${vendorRes.rows[0].name} (${vendorId})\n`);

  // 2. Load all active products in target collections
  const productsRes = await pool.query(`
    SELECT p.id, p.name, p.collection,
      (SELECT COUNT(*) FROM skus WHERE product_id = p.id AND status = 'active') as sku_count,
      (SELECT COUNT(*) FROM media_assets WHERE product_id = p.id) as total_image_count
    FROM products p
    WHERE p.vendor_id = $1 AND p.status = 'active'
      AND p.collection = ANY($2)
    ORDER BY p.collection, p.name
  `, [vendorId, TARGET_COLLECTIONS]);

  console.log(`Loaded ${productsRes.rows.length} active products across ${TARGET_COLLECTIONS.join(', ')}\n`);

  // 3. Group by collection + group key
  const allGroups = []; // { collection, groupKey, products[] }

  for (const collection of TARGET_COLLECTIONS) {
    const collProducts = productsRes.rows.filter(p => p.collection === collection);
    const keyFn = GROUP_KEY_FN[collection];
    const groups = new Map();

    for (const p of collProducts) {
      const key = keyFn(p.name);
      if (!groups.has(key)) {
        groups.set(key, { collection, groupKey: key, products: [] });
      }
      groups.get(key).products.push(p);
    }

    // Only include groups with >1 product (need merging)
    for (const [, group] of groups) {
      if (group.products.length > 1) {
        allGroups.push(group);
      }
    }

    // Summary per collection
    const mergeGroups = [...groups.values()].filter(g => g.products.length > 1);
    const totalMergeProducts = mergeGroups.reduce((sum, g) => sum + g.products.length, 0);
    const finalCount = groups.size;
    console.log(`${collection}: ${collProducts.length} products → ${finalCount} groups (${mergeGroups.length} groups need merging, ${totalMergeProducts} products involved)`);
  }

  console.log(`\nTotal groups to merge: ${allGroups.length}`);
  const totalProductsToMerge = allGroups.reduce((sum, g) => sum + g.products.length, 0);
  const totalProductsToDraft = totalProductsToMerge - allGroups.length;
  console.log(`Products involved: ${totalProductsToMerge}`);
  console.log(`Products to draft: ${totalProductsToDraft}\n`);

  // Show all merge groups
  for (const g of allGroups) {
    const survivor = pickSurvivor(g.products);
    console.log(`  [${g.collection}] "${g.groupKey}" ← ${g.products.length} products:`);
    for (const p of g.products) {
      const isSurvivor = p.id === survivor.id;
      console.log(`    ${isSurvivor ? '★' : '×'} "${p.name}" (${p.sku_count} SKUs, ${p.total_image_count} imgs)${isSurvivor ? ' [SURVIVOR]' : ''}`);
    }
  }

  if (DRY_RUN) {
    console.log('\n=== DRY RUN — no changes made ===');
    console.log(`Would merge ${allGroups.length} groups`);
    console.log(`Would re-parent SKUs from ${totalProductsToDraft} products`);
    console.log(`Would draft ${totalProductsToDraft} products`);
    console.log(`Would rename ${allGroups.length} survivor products\n`);
    await pool.end();
    return;
  }

  // 4. Execute merges
  const stats = {
    groups_merged: 0,
    skus_reparented: 0,
    media_reparented: 0,
    products_drafted: 0,
    survivors_renamed: 0,
    search_vectors_refreshed: 0,
    duplicate_skus_drafted: 0,
    errors: 0,
  };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const group of allGroups) {
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

        // Re-parent SKU-level media_assets (sku_id IS NOT NULL)
        await client.query(
          `UPDATE media_assets SET product_id = $1 WHERE product_id = ANY($2) AND sku_id IS NOT NULL`,
          [survivor.id, otherIds]
        );

        // Product-level media (sku_id IS NULL): unique index on (product_id, asset_type, sort_order)
        // Delete non-survivor media that would conflict, then move any remaining
        await client.query(`
          DELETE FROM media_assets m
          WHERE m.product_id = ANY($2) AND m.sku_id IS NULL
            AND EXISTS (
              SELECT 1 FROM media_assets e
              WHERE e.product_id = $1 AND e.sku_id IS NULL
                AND e.asset_type = m.asset_type AND e.sort_order = m.sort_order
            )
        `, [survivor.id, otherIds]);
        // Also delete cross-duplicate media among non-survivors themselves
        // (keep only one per asset_type+sort_order to avoid conflicts on UPDATE)
        await client.query(`
          DELETE FROM media_assets m
          WHERE m.product_id = ANY($1) AND m.sku_id IS NULL
            AND EXISTS (
              SELECT 1 FROM media_assets e
              WHERE e.product_id = ANY($1) AND e.sku_id IS NULL
                AND e.asset_type = m.asset_type AND e.sort_order = m.sort_order
                AND e.id < m.id
            )
        `, [otherIds]);
        // Now safe to move remaining product-level media — assign incrementing sort_order
        // to avoid conflicts with existing survivor media
        const maxSortRes = await client.query(`
          SELECT COALESCE(MAX(sort_order), -1) + 1 as next_sort
          FROM media_assets WHERE product_id = $1 AND sku_id IS NULL
        `, [survivor.id]);
        let nextSort = parseInt(maxSortRes.rows[0].next_sort) || 0;
        const remainingMedia = await client.query(`
          SELECT id FROM media_assets WHERE product_id = ANY($1) AND sku_id IS NULL ORDER BY sort_order
        `, [otherIds]);
        for (const row of remainingMedia.rows) {
          await client.query(
            `UPDATE media_assets SET product_id = $1, sort_order = $2 WHERE id = $3`,
            [survivor.id, nextSort++, row.id]
          );
          stats.media_reparented++;
        }

        // Draft non-survivors and rename them to avoid unique constraint conflicts
        // Unique constraint: (vendor_id, collection, name) — drafted products still occupy the slot
        for (const other of others) {
          await client.query(
            `UPDATE products SET status = 'draft', name = name || ' [merged-' || LEFT(id::text, 8) || ']', updated_at = NOW() WHERE id = $1`,
            [other.id]
          );
        }
        stats.products_drafted += others.length;

        // Rename survivor to the clean group key
        if (survivor.name !== group.groupKey) {
          await client.query(
            `UPDATE products SET name = $1, updated_at = NOW() WHERE id = $2`,
            [group.groupKey, survivor.id]
          );
          stats.survivors_renamed++;
        }

        // Refresh search vector on survivor
        try {
          await client.query(`SELECT refresh_search_vectors($1)`, [survivor.id]);
          stats.search_vectors_refreshed++;
        } catch (e) {
          // Function may not exist — non-fatal
        }

        await client.query('RELEASE SAVEPOINT merge_group');
        stats.groups_merged++;
      } catch (err) {
        await client.query('ROLLBACK TO SAVEPOINT merge_group');
        console.error(`\nError merging group "${group.groupKey}" (${group.collection}):`, err.message);
        stats.errors++;
      }
    }

    // 5. Report duplicate variant_names within merged products
    //    Only draft if vendor_skus are identical (true dupes); otherwise just report
    //    (different vendor_skus with same variant_name = size variants needing variant_name fix)
    const dupSkus = await client.query(`
      SELECT s1.id as keep_id, s2.id as draft_id, s1.product_id, s1.variant_name,
             s1.vendor_sku as keep_sku, s2.vendor_sku as draft_sku, p.name as product_name
      FROM skus s1
      JOIN skus s2 ON s1.product_id = s2.product_id
        AND s1.variant_name = s2.variant_name
        AND s1.id < s2.id
      JOIN products p ON p.id = s1.product_id
      WHERE p.vendor_id = $1 AND p.status = 'active'
        AND s1.status = 'active' AND s2.status = 'active'
        AND p.collection = ANY($2)
      ORDER BY p.name, s1.variant_name
    `, [vendorId, TARGET_COLLECTIONS]);

    if (dupSkus.rows.length > 0) {
      const trueDupes = dupSkus.rows.filter(d => d.keep_sku === d.draft_sku);
      const sizeVariants = dupSkus.rows.filter(d => d.keep_sku !== d.draft_sku);

      if (trueDupes.length > 0) {
        console.log(`\nDrafting ${trueDupes.length} true duplicate SKUs (identical vendor_sku + variant_name):`);
        for (const dup of trueDupes) {
          console.log(`  [${dup.product_name}] "${dup.variant_name}" (${dup.draft_sku})`);
          await client.query(
            `UPDATE skus SET status = 'draft', updated_at = NOW() WHERE id = $1`,
            [dup.draft_id]
          );
          stats.duplicate_skus_drafted++;
        }
      }

      if (sizeVariants.length > 0) {
        console.log(`\nNote: ${sizeVariants.length} SKU pairs share variant_name but have different vendor_skus (likely size variants):`);
        for (const dup of sizeVariants) {
          console.log(`  [${dup.product_name}] "${dup.variant_name}": ${dup.keep_sku} vs ${dup.draft_sku}`);
        }
        console.log('  → These need variant_name updates to distinguish sizes (not auto-fixed)');
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

  // Print results
  console.log('\n=== Results ===');
  console.log(`Groups merged:             ${stats.groups_merged}`);
  console.log(`SKUs re-parented:          ${stats.skus_reparented}`);
  console.log(`Media assets moved:        ${stats.media_reparented}`);
  console.log(`Survivors renamed:         ${stats.survivors_renamed}`);
  console.log(`Products drafted:          ${stats.products_drafted}`);
  console.log(`Duplicate SKUs drafted:    ${stats.duplicate_skus_drafted}`);
  console.log(`Search vectors refreshed:  ${stats.search_vectors_refreshed}`);
  if (stats.errors > 0) console.log(`Errors:                    ${stats.errors}`);
  console.log('');

  await pool.end();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
