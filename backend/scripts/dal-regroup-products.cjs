#!/usr/bin/env node
/**
 * dal-regroup-products.js
 *
 * Migration script to fix over-fragmented Daltile (DAL/AO/MZ) products.
 * Merges products that differ only by finish suffix, Grp# suffix, Lvf prefix,
 * or Bn (bullnose/trim) designation. Re-tags trim variant_types to 'accessory'
 * and backfills finish attributes from product names.
 *
 * Expected result: ~2,987 products → ~800-1,000 active products.
 *
 * Usage:
 *   node backend/scripts/dal-regroup-products.js --dry-run
 *   node backend/scripts/dal-regroup-products.js
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

// Daltile vendor codes
const VENDOR_CODES = ['DAL', 'AO', 'MZ'];

// Finish suffix mapping
const FINISH_SUFFIX_RE = /\s+(Mt|Pl|Hn|St|Gl|Sx|Lp)$/i;
const FINISH_MAP = {
  mt: 'Matte', pl: 'Polished', hn: 'Honed', st: 'Structured',
  gl: 'Gloss', sx: 'Textured', lp: 'Lappato',
};

// Full finish keyword → value (for Step 6)
const FINISH_KEYWORDS = {
  matte: 'Matte', polished: 'Polished', honed: 'Honed',
  structured: 'Structured', gloss: 'Gloss', textured: 'Textured',
  lappato: 'Lappato',
};

async function getVendorIds() {
  const res = await pool.query(
    'SELECT id, code FROM vendors WHERE code = ANY($1)',
    [VENDOR_CODES]
  );
  return res.rows.map(r => r.id);
}

/**
 * Move all SKUs from one product to another.
 * Returns count of SKUs moved.
 */
async function moveSkus(fromProductId, toProductId, setAccessory = false) {
  if (DRY_RUN) {
    const cnt = await pool.query(
      'SELECT COUNT(*) as c FROM skus WHERE product_id = $1', [fromProductId]
    );
    return parseInt(cnt.rows[0].c, 10);
  }
  let query = 'UPDATE skus SET product_id = $1, updated_at = NOW() WHERE product_id = $2';
  const params = [toProductId, fromProductId];
  if (setAccessory) {
    query = "UPDATE skus SET product_id = $1, variant_type = 'accessory', updated_at = NOW() WHERE product_id = $2";
  }
  const res = await pool.query(query, params);
  return res.rowCount;
}

/**
 * Move media_assets from one product to another.
 */
async function moveMedia(fromProductId, toProductId) {
  if (DRY_RUN) return;
  // Update product_id; handle potential conflicts on the unique indexes
  // by just ignoring conflicts (ON CONFLICT DO NOTHING equivalent via catch)
  const assets = await pool.query(
    'SELECT id, sku_id, asset_type, sort_order FROM media_assets WHERE product_id = $1',
    [fromProductId]
  );
  for (const a of assets.rows) {
    try {
      await pool.query(
        'UPDATE media_assets SET product_id = $1 WHERE id = $2',
        [toProductId, a.id]
      );
    } catch {
      // Unique constraint conflict — skip this asset
    }
  }
}

/**
 * Deactivate a product (set status='inactive').
 */
async function deactivateProduct(productId) {
  if (DRY_RUN) return;
  await pool.query(
    "UPDATE products SET status = 'inactive', updated_at = NOW() WHERE id = $1",
    [productId]
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Step 1: Merge Grp# suffix products
// ──────────────────────────────────────────────────────────────────────────────

async function step1_mergeGrpProducts(vendorIds) {
  console.log('\n── Step 1: Merge Grp# suffix products ──');

  const res = await pool.query(`
    SELECT id, name, collection, vendor_id,
      TRIM(REGEXP_REPLACE(name, '\\s+Grp\\d+$', '', 'i')) as base_name,
      (SELECT COUNT(*) FROM skus WHERE product_id = p.id) as sku_count
    FROM products p
    WHERE vendor_id = ANY($1) AND status = 'active'
      AND name ~ '\\s+Grp\\d+$'
    ORDER BY collection, base_name, sku_count DESC, created_at ASC
  `, [vendorIds]);

  // Group by (vendor_id, collection, base_name)
  const groups = new Map();
  for (const row of res.rows) {
    const key = `${row.vendor_id}|||${row.collection}|||${row.base_name}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  // Also find non-Grp products that match the base_name — they should be survivors
  let eliminated = 0;
  let skusMoved = 0;

  for (const [key, grpProducts] of groups) {
    const [vendorId, collection, baseName] = key.split('|||');

    // Check for existing non-Grp product with this base name (any status — unique constraint is status-agnostic)
    const existingRes = await pool.query(
      `SELECT id, name, status, (SELECT COUNT(*) FROM skus WHERE product_id = p.id) as sku_count
       FROM products p
       WHERE vendor_id = $1 AND collection = $2 AND name = $3
       LIMIT 1`,
      [vendorId, collection, baseName]
    );

    let survivor;
    let toAbsorb;

    if (existingRes.rows.length > 0) {
      // Non-Grp product exists — use it as survivor (reactivate if inactive)
      survivor = existingRes.rows[0];
      toAbsorb = grpProducts;
      if (survivor.status !== 'active' && !DRY_RUN) {
        await pool.query("UPDATE products SET status = 'active', updated_at = NOW() WHERE id = $1", [survivor.id]);
      }
    } else {
      // No non-Grp product — pick the one with most SKUs as survivor
      // Sort: most SKUs first, then earliest created
      const sorted = [...grpProducts].sort((a, b) =>
        parseInt(b.sku_count) - parseInt(a.sku_count)
      );
      survivor = sorted[0];
      toAbsorb = sorted.slice(1);

      // Rename survivor to base name
      if (!DRY_RUN) {
        await pool.query(
          'UPDATE products SET name = $1, updated_at = NOW() WHERE id = $2',
          [baseName, survivor.id]
        );
      }
    }

    for (const absorbed of toAbsorb) {
      const moved = await moveSkus(absorbed.id, survivor.id);
      skusMoved += moved;
      await moveMedia(absorbed.id, survivor.id);
      await deactivateProduct(absorbed.id);
      eliminated++;
    }
  }

  console.log(`  ${DRY_RUN ? 'Would eliminate' : 'Eliminated'}: ${eliminated} products, moved ${skusMoved} SKUs`);
  return eliminated;
}

// ──────────────────────────────────────────────────────────────────────────────
// Step 2: Merge finish suffix products (Mt, Pl, Hn, etc.)
// ──────────────────────────────────────────────────────────────────────────────

async function step2_mergeFinishProducts(vendorIds) {
  console.log('\n── Step 2: Merge finish suffix products ──');

  const res = await pool.query(`
    SELECT id, name, collection, vendor_id,
      TRIM(REGEXP_REPLACE(name, '\\s+(Mt|Pl|Hn|St|Gl|Sx|Lp)$', '', 'i')) as base_name,
      (SELECT COUNT(*) FROM skus WHERE product_id = p.id) as sku_count
    FROM products p
    WHERE vendor_id = ANY($1) AND status = 'active'
      AND name ~ '\\s+(Mt|Pl|Hn|St|Gl|Sx|Lp)$'
    ORDER BY collection, base_name, sku_count DESC, created_at ASC
  `, [vendorIds]);

  // Group by (vendor_id, collection, base_name)
  const groups = new Map();
  for (const row of res.rows) {
    const key = `${row.vendor_id}|||${row.collection}|||${row.base_name}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  let eliminated = 0;
  let skusMoved = 0;
  let finishesBackfilled = 0;

  for (const [key, finishProducts] of groups) {
    const [vendorId, collection, baseName] = key.split('|||');

    // Before merging: backfill finish attribute on SKUs of each product
    for (const prod of finishProducts) {
      const suffixMatch = prod.name.match(FINISH_SUFFIX_RE);
      if (suffixMatch) {
        const finishVal = FINISH_MAP[suffixMatch[1].toLowerCase()] || suffixMatch[1];
        // Get SKUs that don't already have a finish attribute
        const skuRes = await pool.query(`
          SELECT s.id FROM skus s
          WHERE s.product_id = $1
            AND NOT EXISTS (
              SELECT 1 FROM sku_attributes sa
              JOIN attributes a ON a.id = sa.attribute_id
              WHERE sa.sku_id = s.id AND a.slug = 'finish'
            )
        `, [prod.id]);

        if (!DRY_RUN) {
          const attrRes = await pool.query("SELECT id FROM attributes WHERE slug = 'finish'");
          if (attrRes.rows.length > 0) {
            const attrId = attrRes.rows[0].id;
            for (const sku of skuRes.rows) {
              await pool.query(`
                INSERT INTO sku_attributes (sku_id, attribute_id, value)
                VALUES ($1, $2, $3)
                ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value = EXCLUDED.value
              `, [sku.id, attrId, finishVal]);
              finishesBackfilled++;
            }
          }
        } else {
          finishesBackfilled += skuRes.rows.length;
        }
      }
    }

    // Check for existing base-name product (no suffix) — any status, since unique constraint is status-agnostic
    const existingRes = await pool.query(
      `SELECT id, name, status, (SELECT COUNT(*) FROM skus WHERE product_id = p.id) as sku_count
       FROM products p
       WHERE vendor_id = $1 AND collection = $2 AND name = $3
       LIMIT 1`,
      [vendorId, collection, baseName]
    );

    let survivor;
    let toAbsorb;

    if (existingRes.rows.length > 0) {
      survivor = existingRes.rows[0];
      toAbsorb = finishProducts;
      if (survivor.status !== 'active' && !DRY_RUN) {
        await pool.query("UPDATE products SET status = 'active', updated_at = NOW() WHERE id = $1", [survivor.id]);
      }
    } else if (finishProducts.length > 1) {
      const sorted = [...finishProducts].sort((a, b) =>
        parseInt(b.sku_count) - parseInt(a.sku_count)
      );
      survivor = sorted[0];
      toAbsorb = sorted.slice(1);

      // Rename survivor to stripped base name
      if (!DRY_RUN) {
        await pool.query(
          'UPDATE products SET name = $1, updated_at = NOW() WHERE id = $2',
          [baseName, survivor.id]
        );
      }
    } else {
      // Only one product with this suffix and no base exists — just rename
      if (!DRY_RUN) {
        await pool.query(
          'UPDATE products SET name = $1, updated_at = NOW() WHERE id = $2',
          [baseName, finishProducts[0].id]
        );
      }
      continue;
    }

    for (const absorbed of toAbsorb) {
      if (absorbed.id === survivor.id) continue;
      const moved = await moveSkus(absorbed.id, survivor.id);
      skusMoved += moved;
      await moveMedia(absorbed.id, survivor.id);
      await deactivateProduct(absorbed.id);
      eliminated++;
    }
  }

  console.log(`  ${DRY_RUN ? 'Would eliminate' : 'Eliminated'}: ${eliminated} products, moved ${skusMoved} SKUs`);
  console.log(`  Finish attributes backfilled: ${finishesBackfilled} SKUs`);
  return eliminated;
}

// ──────────────────────────────────────────────────────────────────────────────
// Step 3: Attach Bn (bullnose/trim) products as accessories
// ──────────────────────────────────────────────────────────────────────────────

async function step3_attachBnProducts(vendorIds) {
  console.log('\n── Step 3: Attach Bn (bullnose/trim) products ──');

  const res = await pool.query(`
    SELECT id, name, collection, vendor_id,
      TRIM(REGEXP_REPLACE(name, '\\s+Bn\\s+.*$', '', 'i')) as derived_parent,
      (SELECT COUNT(*) FROM skus WHERE product_id = p.id) as sku_count
    FROM products p
    WHERE vendor_id = ANY($1) AND status = 'active'
      AND name ~* '\\sBn\\s'
    ORDER BY collection, name
  `, [vendorIds]);

  let eliminated = 0;
  let skusMoved = 0;
  const orphans = [];

  for (const bnProduct of res.rows) {
    let parentName = bnProduct.derived_parent;
    // Also strip finish suffix from derived parent for matching
    parentName = parentName.replace(FINISH_SUFFIX_RE, '').trim();

    // Try to find parent product
    let parentRes = await pool.query(
      `SELECT id, name FROM products
       WHERE vendor_id = $1 AND collection = $2 AND status = 'active'
         AND (
           name = $3
           OR TRIM(REGEXP_REPLACE(name, '\\s+(Mt|Pl|Hn|St|Gl|Sx|Lp)$', '', 'i')) = $3
         )
         AND id != $4
       ORDER BY (SELECT COUNT(*) FROM skus WHERE product_id = products.id) DESC
       LIMIT 1`,
      [bnProduct.vendor_id, bnProduct.collection, parentName, bnProduct.id]
    );

    if (parentRes.rows.length === 0) {
      orphans.push({ name: bnProduct.name, collection: bnProduct.collection });
      continue;
    }

    const parent = parentRes.rows[0];
    const moved = await moveSkus(bnProduct.id, parent.id, true); // setAccessory=true
    skusMoved += moved;
    await moveMedia(bnProduct.id, parent.id);
    await deactivateProduct(bnProduct.id);
    eliminated++;
  }

  console.log(`  ${DRY_RUN ? 'Would eliminate' : 'Eliminated'}: ${eliminated} products, moved ${skusMoved} SKUs as accessories`);
  if (orphans.length > 0) {
    console.log(`  Orphan Bn products (no parent found): ${orphans.length}`);
    for (const o of orphans.slice(0, 20)) {
      console.log(`    - "${o.name}" (${o.collection})`);
    }
    if (orphans.length > 20) console.log(`    ... and ${orphans.length - 20} more`);
  }
  return eliminated;
}

// ──────────────────────────────────────────────────────────────────────────────
// Step 4: Merge Lvf per-color products
// ──────────────────────────────────────────────────────────────────────────────

async function step4_mergeLvfProducts(vendorIds) {
  console.log('\n── Step 4: Merge Lvf prefix products ──');

  const res = await pool.query(`
    SELECT id, name, collection, vendor_id,
      TRIM(REGEXP_REPLACE(name, '^\\s*Lvf\\s+', '', 'i')) as base_name,
      (SELECT COUNT(*) FROM skus WHERE product_id = p.id) as sku_count
    FROM products p
    WHERE vendor_id = ANY($1) AND status = 'active'
      AND name ~* '^\\s*Lvf\\s+'
    ORDER BY collection, base_name
  `, [vendorIds]);

  let eliminated = 0;
  let skusMoved = 0;
  const orphans = [];

  for (const lvfProduct of res.rows) {
    const baseName = lvfProduct.base_name;

    // Find non-Lvf parent in same collection
    const parentRes = await pool.query(
      `SELECT id, name FROM products
       WHERE vendor_id = $1 AND collection = $2 AND status = 'active'
         AND name = $3 AND id != $4
       ORDER BY (SELECT COUNT(*) FROM skus WHERE product_id = products.id) DESC
       LIMIT 1`,
      [lvfProduct.vendor_id, lvfProduct.collection, baseName, lvfProduct.id]
    );

    if (parentRes.rows.length === 0) {
      // Also try matching after stripping finish suffix from baseName
      const strippedBase = baseName.replace(FINISH_SUFFIX_RE, '').trim();
      const parentRes2 = await pool.query(
        `SELECT id, name FROM products
         WHERE vendor_id = $1 AND collection = $2 AND status = 'active'
           AND (
             name = $3
             OR TRIM(REGEXP_REPLACE(name, '\\s+(Mt|Pl|Hn|St|Gl|Sx|Lp)$', '', 'i')) = $3
           )
           AND id != $4
         ORDER BY (SELECT COUNT(*) FROM skus WHERE product_id = products.id) DESC
         LIMIT 1`,
        [lvfProduct.vendor_id, lvfProduct.collection, strippedBase, lvfProduct.id]
      );

      if (parentRes2.rows.length === 0) {
        orphans.push({ name: lvfProduct.name, collection: lvfProduct.collection });
        continue;
      }

      const parent = parentRes2.rows[0];
      const moved = await moveSkus(lvfProduct.id, parent.id, true);
      skusMoved += moved;
      await moveMedia(lvfProduct.id, parent.id);
      await deactivateProduct(lvfProduct.id);
      eliminated++;
      continue;
    }

    const parent = parentRes.rows[0];
    const moved = await moveSkus(lvfProduct.id, parent.id, true);
    skusMoved += moved;
    await moveMedia(lvfProduct.id, parent.id);
    await deactivateProduct(lvfProduct.id);
    eliminated++;
  }

  console.log(`  ${DRY_RUN ? 'Would eliminate' : 'Eliminated'}: ${eliminated} products, moved ${skusMoved} SKUs as accessories`);
  if (orphans.length > 0) {
    console.log(`  Orphan Lvf products (no parent found): ${orphans.length}`);
    for (const o of orphans.slice(0, 10)) {
      console.log(`    - "${o.name}" (${o.collection})`);
    }
    if (orphans.length > 10) console.log(`    ... and ${orphans.length - 10} more`);
  }
  return eliminated;
}

// ──────────────────────────────────────────────────────────────────────────────
// Step 5: Re-tag trim variant_types → 'accessory'
// ──────────────────────────────────────────────────────────────────────────────

async function step5_retagTrimTypes(vendorIds) {
  console.log('\n── Step 5: Re-tag trim variant_types → accessory ──');

  const trimTypes = ['floor_trim', 'wall_trim', 'lvt_trim', 'mosaic_trim', 'quarry_trim'];

  const countRes = await pool.query(`
    SELECT COUNT(*) as c FROM skus s
    JOIN products p ON p.id = s.product_id
    WHERE s.variant_type = ANY($1) AND p.vendor_id = ANY($2)
  `, [trimTypes, vendorIds]);

  const count = parseInt(countRes.rows[0].c, 10);

  if (!DRY_RUN && count > 0) {
    await pool.query(`
      UPDATE skus SET variant_type = 'accessory', updated_at = NOW()
      WHERE variant_type = ANY($1)
        AND product_id IN (SELECT id FROM products WHERE vendor_id = ANY($2))
    `, [trimTypes, vendorIds]);
  }

  console.log(`  ${DRY_RUN ? 'Would re-tag' : 'Re-tagged'}: ${count} SKUs`);
  return count;
}

// ──────────────────────────────────────────────────────────────────────────────
// Step 6: Backfill finish attribute on remaining products
// ──────────────────────────────────────────────────────────────────────────────

async function step6_backfillFinish(vendorIds) {
  console.log('\n── Step 6: Backfill finish attribute on remaining SKUs ──');

  // Find the finish attribute ID
  const attrRes = await pool.query("SELECT id FROM attributes WHERE slug = 'finish'");
  if (attrRes.rows.length === 0) {
    console.log('  No "finish" attribute found — skipping.');
    return 0;
  }
  const finishAttrId = attrRes.rows[0].id;

  // Find products whose names still contain finish keywords
  const keywordPattern = Object.keys(FINISH_KEYWORDS).join('|');
  const productsRes = await pool.query(`
    SELECT p.id, p.name FROM products p
    WHERE p.vendor_id = ANY($1) AND p.status = 'active'
      AND p.name ~* ('\\m(' || $2 || ')\\M')
  `, [vendorIds, keywordPattern]);

  let backfilled = 0;

  for (const prod of productsRes.rows) {
    // Find which finish keyword matches
    const nameLower = prod.name.toLowerCase();
    let finishVal = null;
    for (const [kw, val] of Object.entries(FINISH_KEYWORDS)) {
      if (new RegExp(`\\b${kw}\\b`, 'i').test(nameLower)) {
        finishVal = val;
        break;
      }
    }
    if (!finishVal) continue;

    // Get SKUs missing finish attribute
    const skuRes = await pool.query(`
      SELECT s.id FROM skus s
      WHERE s.product_id = $1
        AND NOT EXISTS (
          SELECT 1 FROM sku_attributes sa
          WHERE sa.sku_id = s.id AND sa.attribute_id = $2
        )
    `, [prod.id, finishAttrId]);

    if (skuRes.rows.length === 0) continue;

    if (!DRY_RUN) {
      for (const sku of skuRes.rows) {
        await pool.query(`
          INSERT INTO sku_attributes (sku_id, attribute_id, value)
          VALUES ($1, $2, $3)
          ON CONFLICT (sku_id, attribute_id) DO NOTHING
        `, [sku.id, finishAttrId, finishVal]);
      }
    }
    backfilled += skuRes.rows.length;
  }

  console.log(`  ${DRY_RUN ? 'Would backfill' : 'Backfilled'}: ${backfilled} SKUs`);
  return backfilled;
}

// ──────────────────────────────────────────────────────────────────────────────
// Step 7: Clean display_name on merged products
// ──────────────────────────────────────────────────────────────────────────────

async function step7_cleanDisplayNames(vendorIds) {
  console.log('\n── Step 7: Clean display_name on merged products ──');

  // Set display_name = name for all active products where they differ or display_name is null
  const res = await pool.query(`
    SELECT id, name, display_name FROM products
    WHERE vendor_id = ANY($1) AND status = 'active'
      AND (display_name IS NULL OR display_name != name)
  `, [vendorIds]);

  let updated = 0;

  for (const prod of res.rows) {
    let cleanName = prod.name;
    // Strip residual EDI junk: Mm, Ls, size patterns at end
    cleanName = cleanName.replace(/\s+Mm\s*$/i, '').trim();
    cleanName = cleanName.replace(/\s+Ls\s*$/i, '').trim();

    if (!DRY_RUN) {
      await pool.query(
        'UPDATE products SET display_name = $1, updated_at = NOW() WHERE id = $2',
        [cleanName, prod.id]
      );
    }
    updated++;
  }

  console.log(`  ${DRY_RUN ? 'Would update' : 'Updated'}: ${updated} display_names`);
  return updated;
}

// ──────────────────────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n=== Daltile Product Regrouping ${DRY_RUN ? '(DRY RUN)' : '(LIVE)'} ===\n`);

  const vendorIds = await getVendorIds();
  if (vendorIds.length === 0) {
    console.error('No DAL/AO/MZ vendors found.');
    process.exit(1);
  }
  console.log(`Found ${vendorIds.length} vendor(s): ${VENDOR_CODES.join(', ')}`);

  // Count before
  const beforeRes = await pool.query(
    "SELECT COUNT(*) as c FROM products WHERE vendor_id = ANY($1) AND status = 'active'",
    [vendorIds]
  );
  const before = parseInt(beforeRes.rows[0].c, 10);
  console.log(`Active products before: ${before}`);

  const e1 = await step1_mergeGrpProducts(vendorIds);
  const e2 = await step2_mergeFinishProducts(vendorIds);
  const e3 = await step3_attachBnProducts(vendorIds);
  const e4 = await step4_mergeLvfProducts(vendorIds);
  await step5_retagTrimTypes(vendorIds);
  await step6_backfillFinish(vendorIds);
  await step7_cleanDisplayNames(vendorIds);

  // Count after
  const afterRes = await pool.query(
    "SELECT COUNT(*) as c FROM products WHERE vendor_id = ANY($1) AND status = 'active'",
    [vendorIds]
  );
  const after = parseInt(afterRes.rows[0].c, 10);
  const totalEliminated = e1 + e2 + e3 + e4;

  console.log(`\n=== Summary ===`);
  console.log(`  Products before: ${before}`);
  console.log(`  Products after:  ${after}`);
  console.log(`  Total eliminated: ${totalEliminated}`);
  console.log(`  Reduction: ${before > 0 ? ((totalEliminated / before) * 100).toFixed(1) : 0}%`);

  if (DRY_RUN) {
    console.log('\n  (DRY RUN — no changes were made)\n');
  } else {
    // Refresh search vectors for all affected products
    console.log('\n  Refreshing search vectors...');
    await pool.query('SELECT refresh_search_vectors()').catch(() => {});
    console.log('  Done.\n');
  }
}

main()
  .catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  })
  .finally(() => pool.end());
