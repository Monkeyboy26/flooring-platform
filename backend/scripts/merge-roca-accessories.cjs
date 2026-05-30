#!/usr/bin/env node
/**
 * merge-roca-accessories.cjs
 *
 * Merges standalone Roca accessory products (bullnose, cove, quarter round,
 * pencil liner, etc.) into their parent field-tile products so that
 * build-sku-accessories.cjs can link them via the sku_accessories junction table.
 *
 * Problem: During import, 72 standalone accessory-only products (123 SKUs) were
 * created separately from their parent field tiles. build-sku-accessories.cjs
 * only handles same-product accessories, so these orphans need to be merged first.
 *
 * Usage:
 *   node backend/scripts/merge-roca-accessories.cjs --dry-run
 *   node backend/scripts/merge-roca-accessories.cjs
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

// ── Trim-type patterns to strip when extracting base color ───────────────────

const TRIM_PATTERNS = [
  /\bleft\s*cove\b/i,
  /\bright\s*cove\b/i,
  /\bcove(?:\s*[-–]\s*flat\s*top)?\b/i,
  /\bcove\s*(?:base|quarry)\b/i,
  /\bbullnos[ei]\b/i,
  /\bquarter\s*round\b/i,
  /\bpencil(?:\s*liner)?\b/i,
  /\bchair\s*rail\b/i,
  /\bv[-\s]?cap\b/i,
  /\bradius\b/i,
  /\bmud\s*cap\b/i,
  /\bsurface\s*cap\b/i,
  /\bcontour\b/i,
  /\bflat\s*top\b/i,
  /\bmosaic\b/i,
  /\bfield\b/i,
  /\bmesh\b/i,
  /\btwist\b/i,
  /\bqr\b/i,
  /\blc\b/i,
  /\brc\b/i,
  /\bpen\b/i,
  /\bcorner\b/i,
  /\btrim\b/i,
  /\bglazed\s*porcelain\b/i,
  /\bsmooth\b/i,
  /\babrasive\b/i,
  /\binside\s*corner\b/i,
  /\boutside\s*corner\b/i,
  /\bquarry\b/i,
];

// Dimension patterns: "3 3/4x6", "1/2x10", "3/4x16", "2.5x5", "3x12", "4 1/4x6", "4 1x4x4 1/4", "6x18", etc.
const DIM_PATTERN = /\d[\d\s\/\.]*x[\d\s\/\.]*/gi;

// Known abbreviation mappings for Roca product names
const ABBREV_MAP = {
  't.gray': 'tender gray',
  't. gray': 'tender gray',
  'at. blue': 'atoll blue',
  'at.blue': 'atoll blue',
  'p. green': 'peacock green',
  'p.green': 'peacock green',
  'vel. pink': 'velvet pink',
  'vel.pink': 'velvet pink',
  'wh ice': 'white ice',
  'dark gr': 'dark gray',
};

/**
 * Extract the base color from a standalone accessory product name.
 * Strips trim types, dimensions, and normalizes abbreviations.
 */
function extractColor(productName) {
  let color = productName;

  // Strip trim-type keywords
  for (const re of TRIM_PATTERNS) {
    color = color.replace(re, '');
  }
  // Strip dimensions — including tricky "4 1x4x4 1/4" multi-x formats
  color = color.replace(DIM_PATTERN, '');
  // Strip residual "xN" fragments left after dim stripping (e.g., "x4 1/4")
  color = color.replace(/\bx\d[\d\s\/]*/gi, '');
  // Strip standalone numbers/fractions left behind
  color = color.replace(/\b\d+\s*\/\s*\d+\b/g, '');
  // Strip parentheticals like (Bright), (Matte), (A), (B)
  color = color.replace(/\s*\([^)]*\)\s*/g, '');
  // Strip trailing punctuation and stray quotes
  color = color.replace(/["""'']/g, '');
  // Collapse whitespace
  color = color.replace(/\s+/g, ' ').trim();
  // Strip leading/trailing hyphens/dashes
  color = color.replace(/^[-–—\s]+|[-–—\s]+$/g, '').trim();

  // Normalize abbreviations — check as prefix (handles "T.gray ..." → "tender gray ...")
  let lower = color.toLowerCase();
  for (const [abbrev, expanded] of Object.entries(ABBREV_MAP)) {
    if (lower === abbrev) {
      color = expanded;
      break;
    }
    if (lower.startsWith(abbrev + ' ')) {
      color = expanded + lower.substring(abbrev.length);
      break;
    }
  }

  return color.toLowerCase().trim();
}

/**
 * Normalize a product name for comparison.
 */
function normName(name) {
  let n = (name || '').toLowerCase().trim();
  // Expand abbreviations
  if (ABBREV_MAP[n]) n = ABBREV_MAP[n];
  // Strip "tegel " prefix (Tegel collection uses "Tegel Forest" but parent is "Forest")
  n = n.replace(/^tegel\s+/i, '');
  // Strip qualifiers that appear in parent names but not accessory names
  n = n.replace(/\bsmooth\b/gi, '');
  n = n.replace(/\babrasive\b/gi, '');
  n = n.replace(/\bpolished\b/gi, '');
  n = n.replace(/\bunpolished\b/gi, '');
  n = n.replace(/\bbright\s*/gi, '');
  n = n.replace(/\bmatte\s*/gi, '');
  // Strip "quarry" since it appears in both parent and accessory names in Forge
  n = n.replace(/\bquarry\b/gi, '');
  // Strip dimensions from parent names too
  n = n.replace(/\d[\d.\-\/]*x\d[\d.\-\/]*/gi, '');
  n = n.replace(/\b\d+"?\s*$/g, '');
  n = n.replace(/\s+/g, ' ').trim();
  return n;
}

/**
 * Score how well an accessory color matches a parent product name.
 * Returns 0 (no match) to 100 (exact match).
 */
function matchScore(accColor, parentName) {
  const pn = normName(parentName);
  if (!accColor || !pn) return 0;

  // Exact match (after normalization: "Bright Aqua" → "aqua" matches accColor "aqua")
  if (accColor === pn) return 100;

  // Parent starts with color (e.g., color="white ice" matches "white ice 4 1/4x10")
  if (pn.startsWith(accColor + ' ')) return 80;

  // Color starts with parent (e.g., color="white ice twist" matches parent "white ice")
  if (accColor.startsWith(pn + ' ')) return 70;

  // Substring match
  if (pn.includes(accColor) || accColor.includes(pn)) return 50;

  // Word overlap — proportional scoring, require majority match
  const accWords = accColor.split(/\s+/).filter(w => w.length > 1);
  const pnWords = pn.split(/\s+/).filter(w => w.length > 1);
  if (accWords.length > 0 && pnWords.length > 0) {
    const overlap = accWords.filter(w => pnWords.includes(w)).length;
    const ratio = overlap / Math.max(accWords.length, pnWords.length);
    // Require at least 50% overlap of the larger set, and at least 2 words overlapping
    // (or 1 word if both sides only have 1 word)
    if (ratio >= 0.5 && (overlap >= 2 || (accWords.length === 1 && pnWords.length === 1))) {
      return Math.round(10 + 30 * ratio);
    }
  }

  return 0;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n=== Merge Roca Accessories ${DRY_RUN ? '(DRY RUN)' : '(LIVE)'} ===\n`);

  // 1. Find Roca vendor
  const vendorRes = await pool.query("SELECT id, name FROM vendors WHERE name ILIKE '%roca%' LIMIT 1");
  if (vendorRes.rows.length === 0) {
    console.error('Roca vendor not found');
    process.exit(1);
  }
  const vendorId = vendorRes.rows[0].id;
  console.log(`Vendor: ${vendorRes.rows[0].name} (${vendorId})\n`);

  // 2. Load all active Roca products with SKU breakdown
  const productsRes = await pool.query(`
    SELECT p.id, p.name, p.collection,
      COUNT(*) FILTER (WHERE s.variant_type = 'accessory') as acc_count,
      COUNT(*) FILTER (WHERE COALESCE(s.variant_type, '') != 'accessory') as main_count
    FROM products p
    JOIN skus s ON s.product_id = p.id AND s.status = 'active'
    WHERE p.vendor_id = $1 AND p.status = 'active'
    GROUP BY p.id, p.name, p.collection
    ORDER BY p.collection, p.name
  `, [vendorId]);

  // Classify products
  const standaloneAccessories = []; // ALL skus are accessories
  const parentCandidates = [];      // has at least 1 non-accessory SKU

  for (const p of productsRes.rows) {
    if (parseInt(p.main_count) === 0 && parseInt(p.acc_count) > 0) {
      standaloneAccessories.push(p);
    } else if (parseInt(p.main_count) > 0) {
      parentCandidates.push(p);
    }
  }

  console.log(`Standalone accessory products: ${standaloneAccessories.length}`);
  console.log(`Parent candidates (have field tiles): ${parentCandidates.length}\n`);

  // Group parent candidates by collection for lookup
  const parentsByCollection = {};
  for (const p of parentCandidates) {
    if (!parentsByCollection[p.collection]) parentsByCollection[p.collection] = [];
    parentsByCollection[p.collection].push(p);
  }

  // 3. Load SKUs for standalone accessory products
  const standaloneIds = standaloneAccessories.map(p => p.id);
  const skusRes = await pool.query(`
    SELECT s.id, s.product_id, s.vendor_sku, s.variant_name, s.variant_type, s.sell_by
    FROM skus s
    WHERE s.product_id = ANY($1) AND s.status = 'active'
    ORDER BY s.vendor_sku
  `, [standaloneIds]);

  const skusByProduct = {};
  for (const s of skusRes.rows) {
    if (!skusByProduct[s.product_id]) skusByProduct[s.product_id] = [];
    skusByProduct[s.product_id].push(s);
  }

  // 4. Build merge plan
  const mergePlan = [];
  const unmatched = [];

  for (const acc of standaloneAccessories) {
    const color = extractColor(acc.name);
    const candidates = parentsByCollection[acc.collection] || [];

    if (candidates.length === 0) {
      unmatched.push({ product: acc, reason: 'no parent candidates in collection' });
      continue;
    }

    // Special case: "Crackled" in Maiolica — multi-color product, all crackled bullnoses
    // should go to all Crackled parent products. But we need a single parent.
    // For Crackled, find the parent with matching suffix if possible, otherwise use first.

    // Special case: "Contour" in Color Collection — multi-color decorative, no single color.
    // Try to find a "Contour" parent, otherwise skip.

    // Score all candidates
    const scored = candidates.map(p => ({
      parent: p,
      score: matchScore(color, p.name),
    })).filter(s => s.score > 0);

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    if (scored.length === 0) {
      // Special fallback: when the accessory name has no discernible color (e.g., "Bullnose 3x12"),
      // only use fallback if the collection has very few parent candidates (1-4)
      if (!color || color.length === 0) {
        if (candidates.length <= 4) {
          // Small collection — assign to first parent (e.g., Calacata Gold)
          const fallback = candidates[0];
          mergePlan.push({
            accessory: acc,
            parent: fallback,
            skus: skusByProduct[acc.id] || [],
            color,
            matchType: 'fallback-small-collection',
            score: 10,
          });
          console.log(`  [fallback] "${acc.name}" (${acc.collection}) → "${fallback.name}" (no color, small collection)`);
          continue;
        }
        // Large collection with no color — can't determine parent
        unmatched.push({ product: acc, reason: 'no color extracted, too many candidates', collection: acc.collection });
        continue;
      }

      unmatched.push({ product: acc, reason: `no match for color="${color}"`, collection: acc.collection });
      continue;
    }

    const best = scored[0];
    mergePlan.push({
      accessory: acc,
      parent: best.parent,
      skus: skusByProduct[acc.id] || [],
      color,
      matchType: best.score >= 90 ? 'exact/bright' : best.score >= 70 ? 'prefix' : 'fuzzy',
      score: best.score,
    });

    const marker = best.score >= 90 ? '+' : best.score >= 50 ? '~' : '?';
    console.log(`  [${marker}] "${acc.name}" → "${best.parent.name}" (${acc.collection}, color="${color}", score=${best.score})`);
  }

  if (unmatched.length > 0) {
    console.log(`\nUnmatched (${unmatched.length}):`);
    for (const u of unmatched) {
      console.log(`  ! "${u.product.name}" (${u.product.collection}) — ${u.reason}`);
    }
  }

  const totalSkus = mergePlan.reduce((sum, m) => sum + m.skus.length, 0);
  const uniqueProducts = new Set(mergePlan.map(m => m.accessory.id)).size;
  console.log(`\nMerge plan: ${mergePlan.length} merges, ${uniqueProducts} products, ${totalSkus} SKUs\n`);

  if (DRY_RUN) {
    // Summary by collection
    const collSummary = {};
    for (const m of mergePlan) {
      if (!collSummary[m.accessory.collection]) collSummary[m.accessory.collection] = { merged: 0, skus: 0 };
      collSummary[m.accessory.collection].merged++;
      collSummary[m.accessory.collection].skus += m.skus.length;
    }
    console.log('By collection:');
    for (const [coll, stats] of Object.entries(collSummary).sort((a, b) => a[0].localeCompare(b[0]))) {
      console.log(`  ${coll}: ${stats.merged} products, ${stats.skus} SKUs`);
    }
    console.log('\n=== DRY RUN — no changes made ===\n');
    await pool.end();
    return;
  }

  // 5. Execute merges
  const stats = {
    skus_moved: 0,
    media_reparented: 0,
    products_drafted: 0,
    errors: 0,
  };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const processedAccessories = new Set();
    const parentIds = new Set();

    for (const merge of mergePlan) {
      try {
        await client.query('SAVEPOINT merge_acc');

        const { accessory, parent, skus } = merge;
        parentIds.add(parent.id);

        // Move SKUs to parent product (keep variant_type='accessory', sell_by='unit')
        for (const sku of skus) {
          await client.query(`
            UPDATE skus
            SET product_id = $1,
                sell_by = 'unit',
                updated_at = NOW()
            WHERE id = $2
          `, [parent.id, sku.id]);
          stats.skus_moved++;
        }

        // Re-parent SKU-level media_assets
        const skuIds = skus.map(s => s.id);
        if (skuIds.length > 0) {
          await client.query(`
            UPDATE media_assets SET product_id = $1
            WHERE sku_id = ANY($2)
          `, [parent.id, skuIds]);
        }

        processedAccessories.add(accessory.id);
        await client.query('RELEASE SAVEPOINT merge_acc');
      } catch (err) {
        await client.query('ROLLBACK TO SAVEPOINT merge_acc');
        console.error(`Error merging "${merge.accessory.name}" → "${merge.parent.name}":`, err.message);
        stats.errors++;
      }
    }

    // 6. Handle product-level media and draft empty products
    for (const accId of processedAccessories) {
      try {
        await client.query('SAVEPOINT draft_acc');

        // Find primary parent that received SKUs
        const parentTarget = mergePlan.find(m => m.accessory.id === accId);
        if (!parentTarget) continue;
        const primaryParentId = parentTarget.parent.id;

        // Move product-level media (delete conflicts first)
        await client.query(`
          DELETE FROM media_assets m
          WHERE m.product_id = $1 AND m.sku_id IS NULL
            AND EXISTS (
              SELECT 1 FROM media_assets e
              WHERE e.product_id = $2 AND e.sku_id IS NULL
                AND e.asset_type = m.asset_type AND e.sort_order = m.sort_order
            )
        `, [accId, primaryParentId]);

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

        // Draft the now-empty accessory product
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

    // 7. Refresh search vectors on parent products
    for (const pid of parentIds) {
      try {
        await client.query(`SELECT refresh_search_vectors($1)`, [pid]);
      } catch (e) {
        // Non-fatal: function may not exist
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
  console.log(`SKUs moved:         ${stats.skus_moved}`);
  console.log(`Media reparented:   ${stats.media_reparented}`);
  console.log(`Products drafted:   ${stats.products_drafted}`);
  if (stats.errors > 0) console.log(`Errors:             ${stats.errors}`);

  // Verification
  const activeCount = await pool.query(`
    SELECT COUNT(*) FROM products p
    JOIN vendors v ON v.id = p.vendor_id
    WHERE v.name ILIKE '%roca%' AND p.status = 'active'
  `);
  const accSkuCount = await pool.query(`
    SELECT COUNT(*) FROM skus s
    JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id
    WHERE v.name ILIKE '%roca%' AND s.variant_type = 'accessory' AND s.status = 'active'
  `);
  const standaloneCount = await pool.query(`
    SELECT COUNT(DISTINCT p.id) FROM products p
    JOIN vendors v ON v.id = p.vendor_id
    JOIN skus s ON s.product_id = p.id AND s.status = 'active'
    WHERE v.name ILIKE '%roca%' AND p.status = 'active'
    GROUP BY p.id
    HAVING COUNT(*) FILTER (WHERE COALESCE(s.variant_type,'') != 'accessory') = 0
  `);
  console.log(`\nActive Roca products: ${activeCount.rows[0].count}`);
  console.log(`Accessory SKUs: ${accSkuCount.rows[0].count}`);
  console.log(`Remaining standalone accessory products: ${standaloneCount.rows.length}`);
  console.log('');

  await pool.end();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
