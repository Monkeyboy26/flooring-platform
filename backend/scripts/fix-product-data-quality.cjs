#!/usr/bin/env node
/**
 * Product Data Quality Cleanup
 *
 * Multi-phase migration script that fixes the most impactful data quality
 * issues found during the post-TW-merge audit:
 *
 *   Phase 1: Draft orphan SKUs (active SKUs under inactive products)
 *   Phase 2: Title-case ALL CAPS product/SKU names
 *   Phase 3: Clean whitespace in product/SKU names
 *   Phase 4: Delete corrupted prices ($222K/sqft nonsense)
 *
 * Each phase runs independently — partial failures don't block others.
 *
 * Usage:
 *   node backend/scripts/fix-product-data-quality.cjs --dry-run   # Preview changes
 *   node backend/scripts/fix-product-data-quality.cjs              # Execute cleanup
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

// ---------------------------------------------------------------------------
// Title-Case Helpers (from import-triwest-832.cjs)
// ---------------------------------------------------------------------------
const KEEP_UPPER = new Set(['SPC', 'WPC', 'LVP', 'LVT', 'PVC', 'HD', 'II', 'III', 'IV', 'AHF']);
const KEEP_LOWER = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'in', 'at', 'to', 'for', 'by', 'on', 'with']);

function titleCaseEdi(text) {
  if (!text) return '';
  return text
    .split(/\s+/)
    .map((w, i) => {
      const upper = w.toUpperCase();
      if (KEEP_UPPER.has(upper)) return upper;
      if (i > 0 && KEEP_LOWER.has(w.toLowerCase())) return w.toLowerCase();
      if (w.length <= 1) return w.toUpperCase();
      return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    })
    .join(' ');
}

// ---------------------------------------------------------------------------
// Phase 1: Draft Orphan SKUs
// ---------------------------------------------------------------------------
async function phase1_draftOrphanSkus() {
  console.log('\n=== Phase 1: Draft Orphan SKUs ===');

  const countRes = await pool.query(`
    SELECT COUNT(*) as cnt FROM skus
    WHERE status = 'active' AND product_id IN (
      SELECT id FROM products WHERE status != 'active'
    )
  `);
  const count = parseInt(countRes.rows[0].cnt, 10);
  console.log(`  Found ${count} active SKUs under inactive products`);

  if (count === 0) return 0;

  if (!DRY_RUN) {
    const result = await pool.query(`
      UPDATE skus SET status = 'draft', updated_at = NOW()
      WHERE status = 'active' AND product_id IN (
        SELECT id FROM products WHERE status != 'active'
      )
    `);
    console.log(`  ✓ Drafted ${result.rowCount} orphan SKUs`);
    return result.rowCount;
  } else {
    console.log(`  [DRY RUN] Would draft ${count} orphan SKUs`);
    return count;
  }
}

// ---------------------------------------------------------------------------
// Phase 2: Title-Case ALL CAPS Names
// ---------------------------------------------------------------------------
async function phase2_titleCaseNames() {
  console.log('\n=== Phase 2: Title-Case ALL CAPS Names ===');

  // Find ALL CAPS products
  const products = await pool.query(`
    SELECT id, name, collection FROM products
    WHERE name = UPPER(name) AND LENGTH(name) > 2 AND status = 'active'
  `);
  console.log(`  Found ${products.rows.length} ALL CAPS products`);

  if (products.rows.length === 0) return { products: 0, skus: 0 };

  let productCount = 0;
  let skuCount = 0;
  const productIds = [];

  for (const row of products.rows) {
    const newName = titleCaseEdi(row.name);
    const newCollection = (row.collection && row.collection === row.collection.toUpperCase() && row.collection.length > 2)
      ? titleCaseEdi(row.collection)
      : row.collection;

    if (newName === row.name && newCollection === row.collection) continue;

    if (!DRY_RUN) {
      await pool.query(
        `UPDATE products SET name = $1, collection = $2, updated_at = NOW() WHERE id = $3`,
        [newName, newCollection, row.id]
      );
    }
    productCount++;
    productIds.push(row.id);

    if (productCount <= 5) {
      console.log(`  Example: "${row.name}" → "${newName}"`);
    }
  }

  // Title-case variant_name on ALL CAPS SKUs (broader — catches SKUs even
  // if their parent product wasn't ALL CAPS)
  const skuRes = await pool.query(`
    SELECT s.id, s.variant_name, s.product_id FROM skus s
    WHERE s.status = 'active'
      AND s.variant_name = UPPER(s.variant_name)
      AND LENGTH(s.variant_name) > 2
  `);

  for (const sku of skuRes.rows) {
    const newVariant = titleCaseEdi(sku.variant_name);
    if (newVariant === sku.variant_name) continue;

    if (!DRY_RUN) {
      await pool.query(
        `UPDATE skus SET variant_name = $1, updated_at = NOW() WHERE id = $2`,
        [newVariant, sku.id]
      );
    }
    skuCount++;
    // Collect product_id for search vector refresh
    if (!productIds.includes(sku.product_id)) {
      productIds.push(sku.product_id);
    }
  }

  // Refresh search vectors for affected products
  if (!DRY_RUN && productIds.length > 0) {
    console.log(`  Refreshing search vectors for ${productIds.length} products...`);
    // Batch refresh — the function supports a single product_id, so call for each
    // For large counts, just do a full refresh
    if (productIds.length > 500) {
      await pool.query(`SELECT refresh_search_vectors()`);
    } else {
      for (const pid of productIds) {
        await pool.query(`SELECT refresh_search_vectors($1)`, [pid]);
      }
    }
  }

  const label = DRY_RUN ? '[DRY RUN] Would title-case' : '✓ Title-cased';
  console.log(`  ${label} ${productCount} products + ${skuCount} SKU variant names`);
  return { products: productCount, skus: skuCount };
}

// ---------------------------------------------------------------------------
// Phase 3: Clean Whitespace
// ---------------------------------------------------------------------------
async function phase3_cleanWhitespace() {
  console.log('\n=== Phase 3: Clean Whitespace in Names ===');

  // Products — skip rows where cleaning would violate unique constraint
  const productCountRes = await pool.query(`
    SELECT COUNT(*) as cnt FROM products p1
    WHERE p1.status = 'active' AND (
      p1.name != TRIM(REGEXP_REPLACE(p1.name, '\\s+', ' ', 'g'))
      OR p1.collection != TRIM(REGEXP_REPLACE(p1.collection, '\\s+', ' ', 'g'))
    )
    AND NOT EXISTS (
      SELECT 1 FROM products p2
      WHERE p2.id != p1.id
        AND p2.vendor_id = p1.vendor_id
        AND TRIM(REGEXP_REPLACE(p2.collection, '\\s+', ' ', 'g')) = TRIM(REGEXP_REPLACE(p1.collection, '\\s+', ' ', 'g'))
        AND TRIM(REGEXP_REPLACE(p2.name, '\\s+', ' ', 'g')) = TRIM(REGEXP_REPLACE(p1.name, '\\s+', ' ', 'g'))
    )
  `);
  const productCount = parseInt(productCountRes.rows[0].cnt, 10);
  console.log(`  Found ${productCount} products with whitespace issues (skipping duplicates)`);

  if (!DRY_RUN && productCount > 0) {
    const result = await pool.query(`
      UPDATE products SET
        name = TRIM(REGEXP_REPLACE(name, '\\s+', ' ', 'g')),
        collection = TRIM(REGEXP_REPLACE(collection, '\\s+', ' ', 'g')),
        updated_at = NOW()
      WHERE id IN (
        SELECT p1.id FROM products p1
        WHERE p1.status = 'active' AND (
          p1.name != TRIM(REGEXP_REPLACE(p1.name, '\\s+', ' ', 'g'))
          OR p1.collection != TRIM(REGEXP_REPLACE(p1.collection, '\\s+', ' ', 'g'))
        )
        AND NOT EXISTS (
          SELECT 1 FROM products p2
          WHERE p2.id != p1.id
            AND p2.vendor_id = p1.vendor_id
            AND TRIM(REGEXP_REPLACE(p2.collection, '\\s+', ' ', 'g')) = TRIM(REGEXP_REPLACE(p1.collection, '\\s+', ' ', 'g'))
            AND TRIM(REGEXP_REPLACE(p2.name, '\\s+', ' ', 'g')) = TRIM(REGEXP_REPLACE(p1.name, '\\s+', ' ', 'g'))
        )
      )
    `);
    console.log(`  ✓ Cleaned ${result.rowCount} product names`);
  } else if (DRY_RUN && productCount > 0) {
    console.log(`  [DRY RUN] Would clean ${productCount} product names`);
  }

  // SKUs
  const skuCountRes = await pool.query(`
    SELECT COUNT(*) as cnt FROM skus
    WHERE status = 'active'
      AND variant_name IS NOT NULL
      AND variant_name != TRIM(REGEXP_REPLACE(variant_name, '\\s+', ' ', 'g'))
  `);
  const skuCount = parseInt(skuCountRes.rows[0].cnt, 10);
  console.log(`  Found ${skuCount} SKUs with whitespace issues in variant_name`);

  if (!DRY_RUN && skuCount > 0) {
    const result = await pool.query(`
      UPDATE skus SET
        variant_name = TRIM(REGEXP_REPLACE(variant_name, '\\s+', ' ', 'g')),
        updated_at = NOW()
      WHERE status = 'active'
        AND variant_name IS NOT NULL
        AND variant_name != TRIM(REGEXP_REPLACE(variant_name, '\\s+', ' ', 'g'))
    `);
    console.log(`  ✓ Cleaned ${result.rowCount} SKU variant names`);
  } else if (DRY_RUN && skuCount > 0) {
    console.log(`  [DRY RUN] Would clean ${skuCount} SKU variant names`);
  }

  return { products: productCount, skus: skuCount };
}

// ---------------------------------------------------------------------------
// Phase 4: Fix Corrupted Prices
// ---------------------------------------------------------------------------
async function phase4_fixCorruptedPrices() {
  console.log('\n=== Phase 4: Fix Corrupted Prices ===');

  // Per-sqft prices > $500 (flooring never costs that much per sqft)
  const sqftRes = await pool.query(`
    SELECT pr.sku_id, pr.retail_price, pr.cost, pr.price_basis,
           s.vendor_sku, s.variant_name,
           p.name as product_name, v.name as vendor_name
    FROM pricing pr
    JOIN skus s ON s.id = pr.sku_id
    JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id
    WHERE pr.retail_price > 500
      AND pr.price_basis = 'per_sqft'
      AND s.status = 'active'
    ORDER BY pr.retail_price DESC
  `);

  // Per-unit prices > $10,000 for non-vanity vendors
  // (James Martin vanities can legitimately be $3K-$8K)
  const unitRes = await pool.query(`
    SELECT pr.sku_id, pr.retail_price, pr.cost, pr.price_basis,
           s.vendor_sku, s.variant_name,
           p.name as product_name, v.name as vendor_name
    FROM pricing pr
    JOIN skus s ON s.id = pr.sku_id
    JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id
    WHERE pr.retail_price > 10000
      AND (pr.price_basis IS NULL OR pr.price_basis != 'per_sqft')
      AND s.status = 'active'
      AND v.code NOT IN ('JMV', 'james-martin', 'jamesmartin')
    ORDER BY pr.retail_price DESC
  `);

  const corrupted = [...sqftRes.rows, ...unitRes.rows];
  console.log(`  Found ${corrupted.length} corrupted prices (${sqftRes.rows.length} per_sqft + ${unitRes.rows.length} per_unit)`);

  for (const row of corrupted) {
    console.log(`    ${row.vendor_name} | ${row.product_name} | ${row.variant_name || ''} | $${parseFloat(row.retail_price).toFixed(2)}/${row.price_basis || 'unit'} | SKU: ${row.vendor_sku}`);
  }

  if (!DRY_RUN && corrupted.length > 0) {
    const skuIds = corrupted.map(r => r.sku_id);
    const result = await pool.query(
      `DELETE FROM pricing WHERE sku_id = ANY($1)`,
      [skuIds]
    );
    console.log(`  ✓ Deleted ${result.rowCount} corrupted pricing rows`);
    return result.rowCount;
  } else if (DRY_RUN && corrupted.length > 0) {
    console.log(`  [DRY RUN] Would delete ${corrupted.length} corrupted pricing rows`);
  }

  return corrupted.length;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Product Data Quality Cleanup${DRY_RUN ? ' (DRY RUN)' : ''}`);
  console.log(`${'='.repeat(60)}`);

  const stats = {};

  try {
    stats.phase1 = await phase1_draftOrphanSkus();
  } catch (err) {
    console.error('Phase 1 failed:', err.message);
    stats.phase1 = 'FAILED';
  }

  try {
    stats.phase2 = await phase2_titleCaseNames();
  } catch (err) {
    console.error('Phase 2 failed:', err.message);
    stats.phase2 = 'FAILED';
  }

  try {
    stats.phase3 = await phase3_cleanWhitespace();
  } catch (err) {
    console.error('Phase 3 failed:', err.message);
    stats.phase3 = 'FAILED';
  }

  try {
    stats.phase4 = await phase4_fixCorruptedPrices();
  } catch (err) {
    console.error('Phase 4 failed:', err.message);
    stats.phase4 = 'FAILED';
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log('Summary:');
  console.log(`  Phase 1 (Orphan SKUs):     ${typeof stats.phase1 === 'number' ? stats.phase1 + ' drafted' : JSON.stringify(stats.phase1)}`);
  console.log(`  Phase 2 (Title-Case):      ${stats.phase2?.products !== undefined ? stats.phase2.products + ' products, ' + stats.phase2.skus + ' SKUs' : stats.phase2}`);
  console.log(`  Phase 3 (Whitespace):      ${stats.phase3?.products !== undefined ? stats.phase3.products + ' products, ' + stats.phase3.skus + ' SKUs' : stats.phase3}`);
  console.log(`  Phase 4 (Corrupt Prices):  ${typeof stats.phase4 === 'number' ? stats.phase4 + ' deleted' : stats.phase4}`);
  console.log(`${'='.repeat(60)}\n`);
}

main()
  .catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  })
  .finally(() => pool.end());
