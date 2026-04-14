#!/usr/bin/env node
/**
 * daltile-fix-mosaic-sheet-sizes.cjs
 *
 * Fixes mosaic SKUs that have SHEET dimensions (e.g., "11x13", "12x10") in
 * their size attribute instead of the individual TILE piece size (e.g., "3x6").
 *
 * These are "the same product split into two" — a mosaic sheet product and its
 * companion field tile share the same tile pieces. The mosaic size should
 * describe the piece size, not the sheet dimension.
 *
 * Strategy:
 *   1. Find Daltile active mosaic SKUs with suspect sheet-dimension sizes
 *   2. For each, look at sibling SKUs in the same product with variant_type
 *      in ('floor_tile','wall_tile','stone_tile')
 *   3. If siblings have exactly ONE distinct size → copy it to the mosaic SKU
 *   4. If ambiguous → skip with log
 *
 * Usage:
 *   node backend/scripts/daltile-fix-mosaic-sheet-sizes.cjs --dry-run
 *   node backend/scripts/daltile-fix-mosaic-sheet-sizes.cjs
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

// Known sheet-dimension sizes (non-standard tile dimensions observed on mosaic SKUs)
const SHEET_SIZES = [
  '11x12', '11x13', '12x10', '12x11', '12x13', '12x14',
  '12x15', '12x16', '13x13', '13x14', '13x15', '14x18',
];

async function main() {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  DALTILE MOSAIC SHEET-SIZE FIX ${DRY_RUN ? '(DRY RUN)' : '(LIVE)'}`);
  console.log(`${'='.repeat(60)}\n`);

  // Find Daltile SKUs with suspect sheet-dimension sizes
  const { rows: suspects } = await pool.query(`
    SELECT s.id as sku_id, s.product_id, s.vendor_sku, s.variant_name,
           sa.attribute_id, sa.value as current_size, p.name as product_name
    FROM skus s
    JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id
    JOIN sku_attributes sa ON sa.sku_id = s.id
    JOIN attributes a ON a.id = sa.attribute_id
    WHERE v.code = 'DAL'
      AND a.slug = 'size'
      AND s.status = 'active'
      AND sa.value = ANY($1::text[])
    ORDER BY p.name, s.vendor_sku
  `, [SHEET_SIZES]);

  console.log(`Found ${suspects.length} SKUs with sheet-dimension sizes\n`);

  // For each, find sibling field/wall/stone tile sizes in the same product
  const updates = [];
  const skipped = { noSiblings: 0, ambiguous: 0 };
  const ambiguousExamples = [];

  for (const s of suspects) {
    const { rows: siblings } = await pool.query(`
      SELECT DISTINCT sa2.value as size
      FROM skus s2
      JOIN sku_attributes sa2 ON sa2.sku_id = s2.id
      JOIN attributes a2 ON a2.id = sa2.attribute_id
      WHERE s2.product_id = $1
        AND s2.id != $2
        AND s2.status = 'active'
        AND s2.variant_type IN ('floor_tile', 'wall_tile', 'stone_tile')
        AND a2.slug = 'size'
    `, [s.product_id, s.sku_id]);

    if (siblings.length === 0) { skipped.noSiblings++; continue; }
    if (siblings.length > 1) {
      skipped.ambiguous++;
      if (ambiguousExamples.length < 10) {
        ambiguousExamples.push({
          product: s.product_name,
          sku: s.vendor_sku,
          current: s.current_size,
          options: siblings.map(x => x.size),
        });
      }
      continue;
    }
    // Exactly one sibling size — use it
    updates.push({
      sku_id: s.sku_id,
      attribute_id: s.attribute_id,
      vendor_sku: s.vendor_sku,
      product_name: s.product_name,
      from: s.current_size,
      to: siblings[0].size,
    });
  }

  console.log(`Results:`);
  console.log(`  Updates available: ${updates.length}`);
  console.log(`  Skipped (no tile siblings): ${skipped.noSiblings}`);
  console.log(`  Skipped (multiple sibling sizes): ${skipped.ambiguous}\n`);

  if (ambiguousExamples.length > 0) {
    console.log('Examples of ambiguous cases (skipped):');
    for (const ex of ambiguousExamples) {
      console.log(`  ${ex.product} / ${ex.sku}: ${ex.current} → ? (options: ${ex.options.join(', ')})`);
    }
    console.log();
  }

  if (updates.length === 0) {
    console.log('No updates to apply.');
    await pool.end();
    return;
  }

  console.log(`Planned updates:`);
  for (const u of updates) {
    console.log(`  ${u.product_name} / ${u.vendor_sku}: ${u.from} → ${u.to}`);
  }
  console.log();

  if (DRY_RUN) {
    console.log('Dry run — no changes applied.');
    await pool.end();
    return;
  }

  console.log(`Applying ${updates.length} updates...`);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const u of updates) {
      await client.query(
        'UPDATE sku_attributes SET value = $1 WHERE sku_id = $2 AND attribute_id = $3',
        [u.to, u.sku_id, u.attribute_id]
      );
    }
    await client.query('COMMIT');
    console.log(`  Committed ${updates.length} updates.`);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  await pool.end();
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
