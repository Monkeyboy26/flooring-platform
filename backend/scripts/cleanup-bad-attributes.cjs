#!/usr/bin/env node
/**
 * cleanup-bad-attributes.cjs — Remove junk/corrupted attribute values
 *
 * Cleans three categories of bad data in sku_attributes:
 *   1. Corrupted finish values (Tri-West scraper artifacts)
 *   2. "No Color" placeholder color values
 *   3. Size/dimension values stored as color (e.g. 7'10", 94")
 *
 * Usage:
 *   node backend/scripts/cleanup-bad-attributes.cjs --dry-run   # Preview
 *   node backend/scripts/cleanup-bad-attributes.cjs              # Execute
 */

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/flooring_pim',
});

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`  CLEANUP BAD ATTRIBUTE VALUES${DRY_RUN ? ' (DRY RUN)' : ''}`);
  console.log(`  ${new Date().toISOString()}`);
  console.log(`${'='.repeat(70)}\n`);

  // Look up attribute IDs
  const { rows: attrs } = await pool.query(
    `SELECT id, slug FROM attributes WHERE slug IN ('color', 'finish')`
  );
  const attrMap = {};
  for (const a of attrs) attrMap[a.slug] = a.id;

  if (!attrMap.color || !attrMap.finish) {
    console.error('  ERROR: Missing color or finish attribute definition.');
    process.exit(1);
  }

  let totalDeleted = 0;

  // -------------------------------------------------------------------------
  // 1. Corrupted finish values (Tri-West scraper artifacts)
  // -------------------------------------------------------------------------
  console.log(`${'─'.repeat(70)}`);
  console.log(`  1. CORRUPTED FINISH VALUES`);
  console.log(`${'─'.repeat(70)}\n`);

  // Count before deleting
  const { rows: corruptedFinish } = await pool.query(`
    SELECT sa.value, COUNT(*) AS cnt
    FROM sku_attributes sa
    WHERE sa.attribute_id = $1
      AND (sa.value LIKE '%Dutch Masters%' OR sa.value LIKE '%esTexturesGrades%')
    GROUP BY sa.value
  `, [attrMap.finish]);

  for (const row of corruptedFinish) {
    const preview = row.value.length > 60 ? row.value.slice(0, 60) + '...' : row.value;
    console.log(`  "${preview}" — ${row.cnt} rows`);
  }

  const corruptedTotal = corruptedFinish.reduce((s, r) => s + parseInt(r.cnt), 0);
  console.log(`\n  Total corrupted finish values: ${corruptedTotal}`);

  if (!DRY_RUN && corruptedTotal > 0) {
    const { rowCount } = await pool.query(`
      DELETE FROM sku_attributes
      WHERE attribute_id = $1
        AND (value LIKE '%Dutch Masters%' OR value LIKE '%esTexturesGrades%')
    `, [attrMap.finish]);
    console.log(`  Deleted: ${rowCount}`);
    totalDeleted += rowCount;
  }
  console.log();

  // -------------------------------------------------------------------------
  // 2. "No Color" placeholder values
  // -------------------------------------------------------------------------
  console.log(`${'─'.repeat(70)}`);
  console.log(`  2. "NO COLOR" PLACEHOLDER VALUES`);
  console.log(`${'─'.repeat(70)}\n`);

  const { rows: noColorVendors } = await pool.query(`
    SELECT v.code, v.name, COUNT(*) AS cnt
    FROM sku_attributes sa
    JOIN skus s ON s.id = sa.sku_id
    JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id
    WHERE sa.attribute_id = $1 AND sa.value = 'No Color'
    GROUP BY v.code, v.name
    ORDER BY cnt DESC
  `, [attrMap.color]);

  for (const row of noColorVendors) {
    console.log(`  ${row.name.padEnd(35)} ${row.cnt}`);
  }

  const noColorTotal = noColorVendors.reduce((s, r) => s + parseInt(r.cnt), 0);
  console.log(`\n  Total "No Color" entries: ${noColorTotal}`);

  if (!DRY_RUN && noColorTotal > 0) {
    const { rowCount } = await pool.query(`
      DELETE FROM sku_attributes
      WHERE attribute_id = $1 AND value = 'No Color'
    `, [attrMap.color]);
    console.log(`  Deleted: ${rowCount}`);
    totalDeleted += rowCount;
  }
  console.log();

  // -------------------------------------------------------------------------
  // 3. Size/dimension values stored as color
  // -------------------------------------------------------------------------
  console.log(`${'─'.repeat(70)}`);
  console.log(`  3. SIZE/DIMENSION VALUES STORED AS COLOR`);
  console.log(`${'─'.repeat(70)}\n`);

  // Find color values that are clearly dimensions/measurements, not colors.
  // Pattern targets: pure numbers, numbers with units/quotes, fraction patterns.
  // Excludes legitimate names like "3D White Blade", "1st Down", "2nd Inning".
  const DIM_PATTERN = `^(\\d+[''"\\.\\s/]*)+$`    // pure numbers: "94", "7'10\"", "1 94"
    + `|^\\d+[''"]+`                                // starts with number + quote: 94", 78"
    + `|^\\d+\\s*/\\s*\\d+`                         // fractions: 1/4", 1/2"
    + `|^\\d+[''"]?\\s*[xX×]\\s*\\d+`              // dimensions: 12x24
    + `|^\\d+k$`;                                   // codes like "4k"

  const { rows: dimColors } = await pool.query(`
    SELECT sa.value, COUNT(*) AS cnt
    FROM sku_attributes sa
    WHERE sa.attribute_id = $1 AND sa.value ~ $2
    GROUP BY sa.value
    ORDER BY cnt DESC
  `, [attrMap.color, DIM_PATTERN]);

  const showLimit = Math.min(dimColors.length, 20);
  for (let i = 0; i < showLimit; i++) {
    console.log(`  "${dimColors[i].value.padEnd(20)}" — ${dimColors[i].cnt} rows`);
  }
  if (dimColors.length > showLimit) {
    console.log(`  ... and ${dimColors.length - showLimit} more distinct values`);
  }

  const dimTotal = dimColors.reduce((s, r) => s + parseInt(r.cnt), 0);
  console.log(`\n  Total digit-prefixed color values: ${dimTotal}`);

  if (!DRY_RUN && dimTotal > 0) {
    const { rowCount } = await pool.query(`
      DELETE FROM sku_attributes
      WHERE attribute_id = $1 AND value ~ $2
    `, [attrMap.color, DIM_PATTERN]);
    console.log(`  Deleted: ${rowCount}`);
    totalDeleted += rowCount;
  }
  console.log();

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------
  console.log(`${'='.repeat(70)}`);
  console.log(`  SUMMARY${DRY_RUN ? ' (DRY RUN — no changes made)' : ''}`);
  console.log(`${'='.repeat(70)}`);
  console.log(`  Corrupted finish values:    ${corruptedTotal}${DRY_RUN ? '' : ` → deleted ${corruptedTotal}`}`);
  console.log(`  "No Color" placeholders:    ${noColorTotal}${DRY_RUN ? '' : ` → deleted ${noColorTotal}`}`);
  console.log(`  Dimension-as-color values:  ${dimTotal}${DRY_RUN ? '' : ` → deleted ${dimTotal}`}`);
  console.log(`  Total ${DRY_RUN ? 'to delete' : 'deleted'}:              ${DRY_RUN ? corruptedTotal + noColorTotal + dimTotal : totalDeleted}`);
  console.log(`${'='.repeat(70)}\n`);
}

main()
  .catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  })
  .finally(() => pool.end());
