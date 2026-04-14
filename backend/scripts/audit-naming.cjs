#!/usr/bin/env node
/**
 * audit-naming.cjs — Product Naming Data Quality Audit
 *
 * Connects to PostgreSQL and reports on naming/labeling gaps across vendors:
 *   1. Display name coverage (products with vs without display_name)
 *   2. Redundant names (name == collection, pointless duplication)
 *   3. Missing color attribute on SKUs
 *   4. Empty variant names on SKUs
 *
 * Usage:
 *   node backend/scripts/audit-naming.cjs
 *
 * Environment:
 *   DATABASE_URL  — full connection string (fallback: local dev defaults)
 */

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/flooring_pim',
});

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

const QUERIES = {
  displayNameCoverage: `
    SELECT v.name AS vendor,
      COUNT(*) AS total_products,
      COUNT(p.display_name) AS has_display_name,
      COUNT(*) - COUNT(p.display_name) AS missing_display_name
    FROM products p
    JOIN vendors v ON v.id = p.vendor_id
    WHERE p.status = 'active'
    GROUP BY v.name
    ORDER BY missing_display_name DESC
  `,

  redundantNames: `
    SELECT v.name AS vendor, COUNT(*) AS count
    FROM products p
    JOIN vendors v ON v.id = p.vendor_id
    WHERE p.status = 'active' AND LOWER(p.name) = LOWER(p.collection)
    GROUP BY v.name
    ORDER BY count DESC
  `,

  missingColor: `
    SELECT v.name AS vendor, COUNT(*) AS skus_missing_color
    FROM skus s
    JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id
    WHERE s.status = 'active' AND s.is_sample = false
    AND NOT EXISTS (
      SELECT 1 FROM sku_attributes sa
      JOIN attributes a ON a.id = sa.attribute_id
      WHERE sa.sku_id = s.id AND a.slug = 'color'
    )
    GROUP BY v.name
    ORDER BY skus_missing_color DESC
  `,

  emptyVariantName: `
    SELECT v.name AS vendor, COUNT(*) AS empty_variant_name
    FROM skus s
    JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id
    WHERE s.status = 'active' AND s.is_sample = false
    AND (s.variant_name IS NULL OR s.variant_name = '')
    GROUP BY v.name
    ORDER BY empty_variant_name DESC
  `,
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('='.repeat(70));
  console.log('  PRODUCT NAMING DATA QUALITY AUDIT');
  console.log('='.repeat(70));
  console.log();

  // --- 1. Display Name Coverage ---
  console.log('-'.repeat(70));
  console.log('  1. DISPLAY NAME COVERAGE (active products)');
  console.log('-'.repeat(70));
  const { rows: displayRows } = await pool.query(QUERIES.displayNameCoverage);
  if (displayRows.length) {
    console.table(displayRows);
  } else {
    console.log('  (no active products found)');
  }
  const totalMissingDisplay = displayRows.reduce((sum, r) => sum + parseInt(r.missing_display_name, 10), 0);
  const totalProducts = displayRows.reduce((sum, r) => sum + parseInt(r.total_products, 10), 0);
  console.log();

  // --- 2. Redundant Names ---
  console.log('-'.repeat(70));
  console.log('  2. REDUNDANT NAMES (name == collection)');
  console.log('-'.repeat(70));
  const { rows: redundantRows } = await pool.query(QUERIES.redundantNames);
  if (redundantRows.length) {
    console.table(redundantRows);
  } else {
    console.log('  (no redundant names found)');
  }
  const totalRedundant = redundantRows.reduce((sum, r) => sum + parseInt(r.count, 10), 0);
  console.log();

  // --- 3. Missing Color Attribute ---
  console.log('-'.repeat(70));
  console.log('  3. MISSING COLOR ATTRIBUTE (active non-sample SKUs)');
  console.log('-'.repeat(70));
  const { rows: colorRows } = await pool.query(QUERIES.missingColor);
  if (colorRows.length) {
    console.table(colorRows);
  } else {
    console.log('  (all SKUs have a color attribute)');
  }
  const totalMissingColor = colorRows.reduce((sum, r) => sum + parseInt(r.skus_missing_color, 10), 0);
  console.log();

  // --- 4. Empty Variant Names ---
  console.log('-'.repeat(70));
  console.log('  4. EMPTY VARIANT NAMES (active non-sample SKUs)');
  console.log('-'.repeat(70));
  const { rows: variantRows } = await pool.query(QUERIES.emptyVariantName);
  if (variantRows.length) {
    console.table(variantRows);
  } else {
    console.log('  (all SKUs have variant names)');
  }
  const totalEmptyVariant = variantRows.reduce((sum, r) => sum + parseInt(r.empty_variant_name, 10), 0);
  console.log();

  // --- Summary ---
  console.log('='.repeat(70));
  console.log('  SUMMARY');
  console.log('='.repeat(70));
  console.log(`  Total active products:               ${totalProducts}`);
  console.log(`  Products missing display_name:        ${totalMissingDisplay}`);
  console.log(`  Products with redundant name:         ${totalRedundant}`);
  console.log(`  SKUs missing color attribute:         ${totalMissingColor}`);
  console.log(`  SKUs with empty variant_name:         ${totalEmptyVariant}`);
  console.log('='.repeat(70));
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error('Audit failed:', err);
    process.exit(1);
  })
  .finally(() => {
    pool.end();
  });
