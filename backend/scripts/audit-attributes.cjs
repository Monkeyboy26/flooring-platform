#!/usr/bin/env node
/**
 * Attribute Coverage Audit
 *
 * Connects to PostgreSQL and audits attribute coverage across all vendors.
 * Reports three sections:
 *
 *   1. Missing attributes per vendor — for each of the 5 core attributes
 *      (color, finish, size, material, thickness), how many active SKUs lack it
 *   2. Attribute value distribution — top 15 most common values per attribute
 *   3. Variant name samples — 20 sample variant_names from vendors with gaps,
 *      useful for writing parsers to extract attributes from names
 *
 * Usage:
 *   node backend/scripts/audit-attributes.cjs
 */

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/flooring_pim',
});

const CORE_ATTRIBUTES = ['color', 'finish', 'size', 'material', 'thickness'];

// ---------------------------------------------------------------------------
// Section 1: Missing Attributes per Vendor
// ---------------------------------------------------------------------------
async function auditMissingAttributes() {
  console.log('\n' + '='.repeat(80));
  console.log('  SECTION 1: Missing Attributes per Vendor');
  console.log('='.repeat(80));

  const result = await pool.query(`
    SELECT v.name as vendor, v.code as vendor_code,
      COUNT(DISTINCT s.id) as total_skus,
      COUNT(DISTINCT s.id) FILTER (WHERE NOT EXISTS (
        SELECT 1 FROM sku_attributes sa JOIN attributes a ON a.id = sa.attribute_id
        WHERE sa.sku_id = s.id AND a.slug = 'color'
      )) as missing_color,
      COUNT(DISTINCT s.id) FILTER (WHERE NOT EXISTS (
        SELECT 1 FROM sku_attributes sa JOIN attributes a ON a.id = sa.attribute_id
        WHERE sa.sku_id = s.id AND a.slug = 'finish'
      )) as missing_finish,
      COUNT(DISTINCT s.id) FILTER (WHERE NOT EXISTS (
        SELECT 1 FROM sku_attributes sa JOIN attributes a ON a.id = sa.attribute_id
        WHERE sa.sku_id = s.id AND a.slug = 'size'
      )) as missing_size,
      COUNT(DISTINCT s.id) FILTER (WHERE NOT EXISTS (
        SELECT 1 FROM sku_attributes sa JOIN attributes a ON a.id = sa.attribute_id
        WHERE sa.sku_id = s.id AND a.slug = 'material'
      )) as missing_material,
      COUNT(DISTINCT s.id) FILTER (WHERE NOT EXISTS (
        SELECT 1 FROM sku_attributes sa JOIN attributes a ON a.id = sa.attribute_id
        WHERE sa.sku_id = s.id AND a.slug = 'thickness'
      )) as missing_thickness
    FROM skus s
    JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id
    WHERE s.status = 'active' AND s.is_sample = false AND p.status = 'active'
    GROUP BY v.name, v.code
    ORDER BY total_skus DESC
  `);

  if (result.rows.length === 0) {
    console.log('\n  No active SKUs found.\n');
    return;
  }

  // Format for console.table — convert string counts to numbers
  const tableData = result.rows.map(row => ({
    Vendor: row.vendor,
    Code: row.vendor_code,
    'Total SKUs': parseInt(row.total_skus, 10),
    'Missing Color': parseInt(row.missing_color, 10),
    'Missing Finish': parseInt(row.missing_finish, 10),
    'Missing Size': parseInt(row.missing_size, 10),
    'Missing Material': parseInt(row.missing_material, 10),
    'Missing Thickness': parseInt(row.missing_thickness, 10),
  }));

  console.table(tableData);

  // Summary totals
  const totals = tableData.reduce(
    (acc, row) => {
      acc.skus += row['Total SKUs'];
      acc.color += row['Missing Color'];
      acc.finish += row['Missing Finish'];
      acc.size += row['Missing Size'];
      acc.material += row['Missing Material'];
      acc.thickness += row['Missing Thickness'];
      return acc;
    },
    { skus: 0, color: 0, finish: 0, size: 0, material: 0, thickness: 0 }
  );

  console.log('  Totals across all vendors:');
  console.log(`    Total active SKUs:    ${totals.skus}`);
  console.log(`    Missing color:        ${totals.color} (${((totals.color / totals.skus) * 100).toFixed(1)}%)`);
  console.log(`    Missing finish:       ${totals.finish} (${((totals.finish / totals.skus) * 100).toFixed(1)}%)`);
  console.log(`    Missing size:         ${totals.size} (${((totals.size / totals.skus) * 100).toFixed(1)}%)`);
  console.log(`    Missing material:     ${totals.material} (${((totals.material / totals.skus) * 100).toFixed(1)}%)`);
  console.log(`    Missing thickness:    ${totals.thickness} (${((totals.thickness / totals.skus) * 100).toFixed(1)}%)`);
  console.log('');
}

// ---------------------------------------------------------------------------
// Section 2: Attribute Value Distribution
// ---------------------------------------------------------------------------
async function auditValueDistribution() {
  console.log('='.repeat(80));
  console.log('  SECTION 2: Attribute Value Distribution (Top 15 per Attribute)');
  console.log('='.repeat(80));

  const result = await pool.query(`
    SELECT a.slug, sa.value, COUNT(*) as count
    FROM sku_attributes sa
    JOIN attributes a ON a.id = sa.attribute_id
    WHERE a.slug IN ('color', 'finish', 'size', 'material', 'thickness')
    GROUP BY a.slug, sa.value
    ORDER BY a.slug, count DESC
  `);

  // Group by slug
  const grouped = {};
  for (const row of result.rows) {
    if (!grouped[row.slug]) grouped[row.slug] = [];
    grouped[row.slug].push({ value: row.value, count: parseInt(row.count, 10) });
  }

  for (const attr of CORE_ATTRIBUTES) {
    const values = grouped[attr] || [];
    const top15 = values.slice(0, 15);

    console.log(`\n  --- ${attr.toUpperCase()} (${values.length} unique values) ---`);

    if (top15.length === 0) {
      console.log('    (no values found)');
      continue;
    }

    const tableData = top15.map((row, i) => ({
      '#': i + 1,
      Value: row.value,
      Count: row.count,
    }));

    console.table(tableData);
  }

  console.log('');
}

// ---------------------------------------------------------------------------
// Section 3: Variant Name Patterns (for attribute parsing)
// ---------------------------------------------------------------------------
async function auditVariantNamePatterns() {
  console.log('='.repeat(80));
  console.log('  SECTION 3: Variant Name Samples from Vendors with Missing Attributes');
  console.log('='.repeat(80));

  // Find vendors that have SKUs missing at least one core attribute
  const vendorsWithGaps = await pool.query(`
    SELECT DISTINCT v.id, v.name, v.code
    FROM vendors v
    JOIN products p ON p.vendor_id = v.id
    JOIN skus s ON s.product_id = p.id
    WHERE s.status = 'active' AND s.is_sample = false AND p.status = 'active'
      AND NOT EXISTS (
        SELECT 1 FROM sku_attributes sa
        JOIN attributes a ON a.id = sa.attribute_id
        WHERE sa.sku_id = s.id AND a.slug IN ('color', 'finish', 'size', 'material', 'thickness')
      )
    ORDER BY v.name
  `);

  if (vendorsWithGaps.rows.length === 0) {
    console.log('\n  All vendors have full attribute coverage. No samples needed.\n');
    return;
  }

  console.log(`\n  Found ${vendorsWithGaps.rows.length} vendors with SKUs missing ALL core attributes.\n`);

  for (const vendor of vendorsWithGaps.rows) {
    const samples = await pool.query(`
      SELECT s.variant_name, s.vendor_sku, p.name as product_name
      FROM skus s
      JOIN products p ON p.id = s.product_id
      WHERE p.vendor_id = $1
        AND s.status = 'active'
        AND s.is_sample = false
        AND p.status = 'active'
        AND s.variant_name IS NOT NULL
        AND s.variant_name != ''
        AND NOT EXISTS (
          SELECT 1 FROM sku_attributes sa
          JOIN attributes a ON a.id = sa.attribute_id
          WHERE sa.sku_id = s.id AND a.slug IN ('color', 'finish', 'size', 'material', 'thickness')
        )
      ORDER BY RANDOM()
      LIMIT 20
    `, [vendor.id]);

    if (samples.rows.length === 0) continue;

    console.log(`  --- ${vendor.name} (${vendor.code}) — ${samples.rows.length} samples ---`);

    const tableData = samples.rows.map(row => ({
      'Vendor SKU': row.vendor_sku,
      'Variant Name': row.variant_name,
      'Product': row.product_name,
    }));

    console.table(tableData);
    console.log('');
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log('\n' + '='.repeat(80));
  console.log('  ATTRIBUTE COVERAGE AUDIT');
  console.log('  ' + new Date().toISOString());
  console.log('='.repeat(80));

  await auditMissingAttributes();
  await auditValueDistribution();
  await auditVariantNamePatterns();

  console.log('='.repeat(80));
  console.log('  Audit complete.');
  console.log('='.repeat(80) + '\n');
}

main()
  .catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  })
  .finally(() => pool.end());
