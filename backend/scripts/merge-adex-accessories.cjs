#!/usr/bin/env node
/**
 * merge-adex-accessories.cjs
 *
 * Merges ADEX accessory products (End Cap, Frame Corner, Finishing Edge Corner,
 * Beak, Quarter Round Beak) into their parent molding/trim products as
 * variant_type='accessory' SKUs.
 *
 * The storefront already supports accessory variants — they appear in
 * "Matching Accessories" on the detail page and are excluded from browse/search.
 *
 * Usage:
 *   node backend/scripts/merge-adex-accessories.cjs --dry-run
 *   node backend/scripts/merge-adex-accessories.cjs
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
// Accessory classification patterns
// ──────────────────────────────────────────────────

// Returns { isAccessory, accessoryType, baseType } or null
function classifyProduct(name) {
  // "Quarter Round Beak" → accessory of "Quarter Round ..."
  if (/^Quarter Round Beak$/i.test(name)) {
    return { isAccessory: true, accessoryType: 'Beak', baseType: 'Quarter Round' };
  }
  // "Beak" (standalone) → accessory of "Quarter Round ..."
  if (/^Beak$/i.test(name)) {
    return { isAccessory: true, accessoryType: 'Beak', baseType: 'Quarter Round' };
  }
  // "Finishing Edge Corner" → accessory of "Finishing Edge ..."
  if (/^Finishing Edge Corner$/i.test(name)) {
    return { isAccessory: true, accessoryType: 'FE Corner', baseType: 'Finishing Edge' };
  }
  // "{Type} End Cap" → accessory of "{Type} ..."
  const ecMatch = name.match(/^(.+?)\s+End Cap$/i);
  if (ecMatch) {
    return { isAccessory: true, accessoryType: 'End Cap', baseType: ecMatch[1] };
  }
  // "{Type} Frame Corner {dims?}" → accessory of "{Type} ..."
  const fcMatch = name.match(/^(.+?)\s+Frame Corner(?:\s+[\d.]+\s*x\s*[\d.]+)?$/i);
  if (fcMatch) {
    return { isAccessory: true, accessoryType: 'Frame Corner', baseType: fcMatch[1] };
  }
  return null;
}

// Check if a product name matches a base type (parent candidate)
function isParentCandidate(productName, baseType) {
  // Product name must start with baseType and then have dimensions
  // e.g. baseType="Chair Molding" matches "Chair Molding 1.4 x 6" and "Chair Molding 2 x 8"
  // Also handles "Base Board (glazed Top Edge) 6 x 6" for baseType="Base Board"
  if (!productName.startsWith(baseType)) return false;
  const rest = productName.slice(baseType.length).trim();
  // Exact match (e.g. Habitat's "Finishing Edge" with no dimensions)
  if (rest === '') return true;
  // Strip optional parenthetical description like "(glazed Top Edge)"
  const stripped = rest.replace(/^\([^)]*\)\s*/, '');
  // Must have dimensions after the base type (digits)
  return /^[\d.]/.test(stripped);
}

// Extract numeric item code from vendor_sku (last 3 digits typically)
function extractItemCode(vendorSku) {
  const match = vendorSku.match(/(\d{3})M?$/);
  return match ? match[1] : null;
}

// Parse dimension from product name for ordering
function parseDimension(name) {
  const match = name.match(/([\d.]+)\s*x\s*([\d.]+)/);
  if (!match) return Infinity;
  return parseFloat(match[1]) * parseFloat(match[2]);
}

// ──────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────

async function main() {
  console.log(`\n=== Merge ADEX Accessories ${DRY_RUN ? '(DRY RUN)' : '(LIVE)'} ===\n`);

  // 1. Find ADEX vendor
  const vendorRes = await pool.query("SELECT id, name FROM vendors WHERE code = 'ADEX'");
  if (vendorRes.rows.length === 0) {
    console.error('Vendor ADEX not found');
    process.exit(1);
  }
  const vendorId = vendorRes.rows[0].id;
  console.log(`Vendor: ${vendorRes.rows[0].name} (${vendorId})\n`);

  // 2. Load all active ADEX products with their SKUs
  const productsRes = await pool.query(`
    SELECT p.id, p.name, p.collection,
      (SELECT COUNT(*) FROM skus WHERE product_id = p.id AND status = 'active') as sku_count
    FROM products p
    WHERE p.vendor_id = $1 AND p.status = 'active'
    ORDER BY p.collection, p.name
  `, [vendorId]);

  console.log(`Loaded ${productsRes.rows.length} active ADEX products\n`);

  // Load SKUs for all ADEX products
  const skusRes = await pool.query(`
    SELECT s.id, s.product_id, s.vendor_sku, s.variant_name, s.variant_type, s.sell_by
    FROM skus s
    JOIN products p ON p.id = s.product_id
    WHERE p.vendor_id = $1 AND p.status = 'active' AND s.status = 'active'
    ORDER BY s.vendor_sku
  `, [vendorId]);

  // Group SKUs by product_id
  const skusByProduct = new Map();
  for (const sku of skusRes.rows) {
    if (!skusByProduct.has(sku.product_id)) skusByProduct.set(sku.product_id, []);
    skusByProduct.get(sku.product_id).push(sku);
  }

  // 3. Classify products by collection
  const collections = new Map(); // collection → { parents: [], accessories: [] }
  for (const p of productsRes.rows) {
    if (!collections.has(p.collection)) {
      collections.set(p.collection, { parents: [], accessories: [] });
    }
    const classification = classifyProduct(p.name);
    if (classification) {
      collections.get(p.collection).accessories.push({
        ...p,
        ...classification,
        skus: skusByProduct.get(p.id) || [],
      });
    } else {
      collections.get(p.collection).parents.push({
        ...p,
        skus: skusByProduct.get(p.id) || [],
      });
    }
  }

  // 4. Build merge plan
  const mergePlan = []; // { accessory, parentProduct, skusToMove, accessoryType }

  for (const [collection, { parents, accessories }] of collections) {
    if (accessories.length === 0) {
      console.log(`${collection}: ${parents.length} products, 0 accessories — skip`);
      continue;
    }

    console.log(`${collection}: ${parents.length} parents, ${accessories.length} accessories`);

    for (const acc of accessories) {
      // Find candidate parents by base type match
      const candidates = parents.filter(p => isParentCandidate(p.name, acc.baseType));

      if (candidates.length === 0) {
        console.log(`  ⚠ "${acc.name}" — no parent found for baseType="${acc.baseType}"`);
        continue;
      }

      if (candidates.length === 1) {
        // Simple case: one parent, move all SKUs
        mergePlan.push({
          collection,
          accessory: acc,
          parent: candidates[0],
          skusToMove: acc.skus,
          accessoryType: acc.accessoryType,
        });
        console.log(`  ✓ "${acc.name}" (${acc.skus.length} SKUs) → "${candidates[0].name}"`);
        continue;
      }

      // Multi-parent case: group accessory SKUs by item code
      const skusByItemCode = new Map();
      for (const sku of acc.skus) {
        const itemCode = extractItemCode(sku.vendor_sku);
        if (!skusByItemCode.has(itemCode)) skusByItemCode.set(itemCode, []);
        skusByItemCode.get(itemCode).push(sku);
      }

      if (skusByItemCode.size === 1) {
        // Single item code serving multiple parents — assign to smallest parent
        const sortedCandidates = candidates.slice().sort((a, b) => parseDimension(a.name) - parseDimension(b.name));
        const smallest = sortedCandidates[0];
        mergePlan.push({
          collection,
          accessory: acc,
          parent: smallest,
          skusToMove: acc.skus,
          accessoryType: acc.accessoryType,
        });
        console.log(`  ✓ "${acc.name}" (${acc.skus.length} SKUs, 1 item code) → "${smallest.name}" (smallest)`);
        continue;
      }

      // Multiple item codes — match each group to a parent by color overlap
      // Build color sets for each parent
      const parentColorSets = candidates.map(p => ({
        parent: p,
        colors: new Set((skusByProduct.get(p.id) || []).map(s => s.variant_name)),
        dimension: parseDimension(p.name),
      }));

      // Sort item codes numerically for dimension-ordering tiebreak
      const sortedItemCodes = [...skusByItemCode.keys()].sort((a, b) => parseInt(a) - parseInt(b));

      // Sort parents by dimension for tiebreak
      parentColorSets.sort((a, b) => a.dimension - b.dimension);

      const usedParents = new Set();

      for (const itemCode of sortedItemCodes) {
        const groupSkus = skusByItemCode.get(itemCode);
        const groupColors = new Set(groupSkus.map(s => s.variant_name));

        // Find best matching parent by color overlap (Jaccard similarity)
        let bestParent = null;
        let bestScore = -1;

        for (const pc of parentColorSets) {
          if (usedParents.has(pc.parent.id)) continue;
          const intersection = [...groupColors].filter(c => pc.colors.has(c)).length;
          const union = new Set([...groupColors, ...pc.colors]).size;
          const score = union > 0 ? intersection / union : 0;
          if (score > bestScore) {
            bestScore = score;
            bestParent = pc.parent;
          }
        }

        if (!bestParent) {
          // Fallback: use smallest unused parent
          const unused = parentColorSets.find(pc => !usedParents.has(pc.parent.id));
          if (unused) bestParent = unused.parent;
        }

        if (bestParent) {
          usedParents.add(bestParent.id);
          mergePlan.push({
            collection,
            accessory: acc,
            parent: bestParent,
            skusToMove: groupSkus,
            accessoryType: acc.accessoryType,
            itemCode,
            isPartial: true,
          });
          console.log(`  ✓ "${acc.name}" item ${itemCode} (${groupSkus.length} SKUs) → "${bestParent.name}" (score=${bestScore.toFixed(2)})`);
        } else {
          console.log(`  ⚠ "${acc.name}" item ${itemCode} — no parent available`);
        }
      }
    }
  }

  console.log(`\nMerge plan: ${mergePlan.length} merges\n`);

  // Count unique accessory products to draft
  const accessoryProductIds = new Set(mergePlan.map(m => m.accessory.id));
  console.log(`Accessory products to draft: ${accessoryProductIds.size}`);
  console.log(`Total SKUs to move: ${mergePlan.reduce((sum, m) => sum + m.skusToMove.length, 0)}\n`);

  if (DRY_RUN) {
    console.log('=== DRY RUN — no changes made ===\n');

    // Summary by collection
    const collSummary = new Map();
    for (const m of mergePlan) {
      if (!collSummary.has(m.collection)) collSummary.set(m.collection, { before: 0, merged: new Set() });
      collSummary.get(m.collection).merged.add(m.accessory.id);
    }
    for (const [coll, { parents, accessories }] of collections) {
      const merged = collSummary.get(coll);
      const mergedCount = merged ? merged.merged.size : 0;
      const total = parents.length + accessories.length;
      console.log(`  ${coll}: ${total} → ${total - mergedCount} (${mergedCount} merged)`);
    }
    console.log('');
    await pool.end();
    return;
  }

  // 5. Execute merges
  const stats = {
    skus_moved: 0,
    skus_updated: 0,
    media_reparented: 0,
    products_drafted: 0,
    search_vectors_refreshed: 0,
    errors: 0,
  };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Track which accessory products have been fully processed
    const processedAccessories = new Set();
    // Track parent products that received accessories (for search vector refresh)
    const parentIds = new Set();

    for (const merge of mergePlan) {
      try {
        await client.query('SAVEPOINT merge_acc');

        const { accessory, parent, skusToMove, accessoryType } = merge;
        parentIds.add(parent.id);

        // Move SKUs to parent product with accessory variant_type
        for (const sku of skusToMove) {
          const newVariantName = `${accessoryType} - ${sku.variant_name}`;

          await client.query(`
            UPDATE skus
            SET product_id = $1,
                variant_type = 'accessory',
                sell_by = 'unit',
                variant_name = $2,
                updated_at = NOW()
            WHERE id = $3
          `, [parent.id, newVariantName, sku.id]);
          stats.skus_updated++;
        }

        stats.skus_moved += skusToMove.length;

        // Re-parent SKU-level media_assets
        const skuIds = skusToMove.map(s => s.id);
        await client.query(`
          UPDATE media_assets SET product_id = $1
          WHERE sku_id = ANY($2)
        `, [parent.id, skuIds]);

        // Mark accessory as processed (may happen across multiple merges for multi-parent splits)
        processedAccessories.add(accessory.id);

        await client.query('RELEASE SAVEPOINT merge_acc');
      } catch (err) {
        await client.query('ROLLBACK TO SAVEPOINT merge_acc');
        console.error(`Error merging "${merge.accessory.name}" → "${merge.parent.name}":`, err.message);
        stats.errors++;
      }
    }

    // 6. Handle product-level media for accessory products, then draft them
    for (const accId of processedAccessories) {
      try {
        await client.query('SAVEPOINT draft_acc');

        // Find which parent(s) received SKUs from this accessory
        const parentTargets = mergePlan
          .filter(m => m.accessory.id === accId)
          .map(m => m.parent.id);
        const primaryParentId = parentTargets[0];

        // Product-level media: move to primary parent, handle conflicts
        // Delete conflicting media first
        await client.query(`
          DELETE FROM media_assets m
          WHERE m.product_id = $1 AND m.sku_id IS NULL
            AND EXISTS (
              SELECT 1 FROM media_assets e
              WHERE e.product_id = $2 AND e.sku_id IS NULL
                AND e.asset_type = m.asset_type AND e.sort_order = m.sort_order
            )
        `, [accId, primaryParentId]);

        // Move remaining product-level media with incrementing sort_order
        const maxSortRes = await client.query(`
          SELECT COALESCE(MAX(sort_order), -1) + 1 as next_sort
          FROM media_assets WHERE product_id = $1 AND sku_id IS NULL
        `, [primaryParentId]);
        let nextSort = parseInt(maxSortRes.rows[0].next_sort) || 0;

        const remainingMedia = await client.query(`
          SELECT id FROM media_assets WHERE product_id = $1 AND sku_id IS NULL ORDER BY sort_order
        `, [accId]);

        for (const row of remainingMedia.rows) {
          await client.query(
            `UPDATE media_assets SET product_id = $1, sort_order = $2 WHERE id = $3`,
            [primaryParentId, nextSort++, row.id]
          );
          stats.media_reparented++;
        }

        // Draft the accessory product (rename to avoid unique constraint)
        await client.query(`
          UPDATE products
          SET status = 'draft',
              name = name || ' [merged-' || LEFT(id::text, 8) || ']',
              updated_at = NOW()
          WHERE id = $1
        `, [accId]);
        stats.products_drafted++;

        await client.query('RELEASE SAVEPOINT draft_acc');
      } catch (err) {
        await client.query('ROLLBACK TO SAVEPOINT draft_acc');
        console.error(`Error drafting accessory product ${accId}:`, err.message);
        stats.errors++;
      }
    }

    // 7. Refresh search vectors on all parent products that received accessories
    for (const pid of parentIds) {
      try {
        await client.query(`SELECT refresh_search_vectors($1)`, [pid]);
        stats.search_vectors_refreshed++;
      } catch (e) {
        // Function may not exist — non-fatal
      }
    }

    await client.query('COMMIT');
    console.log('Transaction committed successfully.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Transaction rolled back:', err.message);
    process.exit(1);
  } finally {
    client.release();
  }

  // Print results
  console.log('\n=== Results ===');
  console.log(`SKUs moved:                ${stats.skus_moved}`);
  console.log(`SKUs updated:              ${stats.skus_updated}`);
  console.log(`Media assets moved:        ${stats.media_reparented}`);
  console.log(`Products drafted:          ${stats.products_drafted}`);
  console.log(`Search vectors refreshed:  ${stats.search_vectors_refreshed}`);
  if (stats.errors > 0) console.log(`Errors:                    ${stats.errors}`);
  console.log('');

  // Verification queries
  const activeCount = await pool.query(`
    SELECT COUNT(*) FROM products p
    JOIN vendors v ON v.id = p.vendor_id
    WHERE v.code = 'ADEX' AND p.status = 'active'
  `);
  console.log(`Active ADEX products: ${activeCount.rows[0].count}`);

  const accSkuCount = await pool.query(`
    SELECT COUNT(*) FROM skus s
    JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id
    WHERE v.code = 'ADEX' AND s.variant_type = 'accessory' AND s.status = 'active'
  `);
  console.log(`Accessory SKUs: ${accSkuCount.rows[0].count}`);
  console.log('');

  await pool.end();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
