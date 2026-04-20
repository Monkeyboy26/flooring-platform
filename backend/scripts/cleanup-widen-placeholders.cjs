#!/usr/bin/env node
/**
 * One-time cleanup: Remove Widen CDN placeholder images (≤10KB) from media_assets.
 * Widen "Preview Not Available" placeholders are exactly 8,016 bytes.
 * After removal, promotes first remaining alternate to primary where needed.
 *
 * Usage: node backend/scripts/cleanup-widen-placeholders.cjs [--dry-run]
 */
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.PGHOST || 'localhost',
  port: process.env.PGPORT || 5432,
  database: process.env.PGDATABASE || 'flooring_pim',
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'postgres',
});

const DRY_RUN = process.argv.includes('--dry-run');
const PLACEHOLDER_THRESHOLD = 10000; // bytes
const BATCH_SIZE = 50;

async function main() {
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);

  // Get all Widen CDN images for AZT vendor
  const result = await pool.query(`
    SELECT ma.id, ma.url, ma.sku_id, ma.asset_type, ma.sort_order
    FROM media_assets ma
    WHERE ma.url LIKE '%widen.net%'
    AND (ma.product_id IN (SELECT id FROM products WHERE vendor_id = '550e8400-e29b-41d4-a716-446655440007')
         OR ma.sku_id IN (SELECT id FROM skus WHERE internal_sku LIKE 'AZT-%'))
    ORDER BY ma.sort_order
  `);

  console.log(`Found ${result.rows.length} Widen CDN images to check`);

  const toDelete = [];
  let checked = 0;

  // Check in batches
  for (let i = 0; i < result.rows.length; i += BATCH_SIZE) {
    const batch = result.rows.slice(i, i + BATCH_SIZE);
    const checks = await Promise.allSettled(batch.map(async (row) => {
      try {
        const res = await fetch(row.url, {
          method: 'HEAD',
          signal: AbortSignal.timeout(8000),
        });
        const len = parseInt(res.headers.get('content-length') || '0', 10);
        return { ...row, contentLength: len, isPlaceholder: len > 0 && len <= PLACEHOLDER_THRESHOLD };
      } catch {
        return { ...row, contentLength: -1, isPlaceholder: false };
      }
    }));

    for (const check of checks) {
      if (check.status === 'fulfilled' && check.value.isPlaceholder) {
        toDelete.push(check.value);
      }
    }

    checked += batch.length;
    if (checked % 500 === 0 || checked === result.rows.length) {
      console.log(`Checked ${checked}/${result.rows.length}, placeholders found: ${toDelete.length}`);
    }
  }

  console.log(`\nTotal placeholders to remove: ${toDelete.length}`);

  if (toDelete.length === 0) {
    console.log('No placeholders found. Done.');
    await pool.end();
    return;
  }

  // Sample output
  console.log(`\nSample placeholders:`);
  for (const p of toDelete.slice(0, 5)) {
    console.log(`  ${p.id} (${p.contentLength}B) ${p.asset_type} #${p.sort_order}`);
  }

  if (!DRY_RUN) {
    // Delete placeholders
    const ids = toDelete.map(p => p.id);
    const deleteResult = await pool.query(
      'DELETE FROM media_assets WHERE id = ANY($1)',
      [ids]
    );
    console.log(`\nDeleted ${deleteResult.rowCount} placeholder images`);

    // Promote first alternate to primary for SKUs that lost their primary
    const promoteResult = await pool.query(`
      WITH needs_primary AS (
        SELECT DISTINCT s.id as sku_id, s.product_id
        FROM skus s
        JOIN media_assets ma ON ma.sku_id = s.id
        WHERE s.internal_sku LIKE 'AZT-%'
        AND NOT EXISTS (
          SELECT 1 FROM media_assets m2 WHERE m2.sku_id = s.id AND m2.asset_type = 'primary'
        )
      ),
      to_promote AS (
        SELECT DISTINCT ON (np.sku_id) ma.id as media_id
        FROM needs_primary np
        JOIN media_assets ma ON ma.sku_id = np.sku_id AND ma.asset_type IN ('alternate', 'lifestyle')
        ORDER BY np.sku_id, ma.sort_order
      )
      UPDATE media_assets SET asset_type = 'primary'
      FROM to_promote
      WHERE media_assets.id = to_promote.media_id
    `);
    console.log(`Promoted ${promoteResult.rowCount} images to primary`);

    // Also promote for product-level images (sku_id IS NULL)
    const productPromote = await pool.query(`
      WITH needs_primary AS (
        SELECT DISTINCT p.id as product_id
        FROM products p
        WHERE p.vendor_id = '550e8400-e29b-41d4-a716-446655440007'
        AND NOT EXISTS (
          SELECT 1 FROM media_assets m2 WHERE m2.product_id = p.id AND m2.sku_id IS NULL AND m2.asset_type = 'primary'
        )
        AND EXISTS (
          SELECT 1 FROM media_assets m3 WHERE m3.product_id = p.id AND m3.sku_id IS NULL
        )
      ),
      to_promote AS (
        SELECT DISTINCT ON (np.product_id) ma.id as media_id
        FROM needs_primary np
        JOIN media_assets ma ON ma.product_id = np.product_id AND ma.sku_id IS NULL AND ma.asset_type IN ('alternate', 'lifestyle')
        ORDER BY np.product_id, ma.sort_order
      )
      UPDATE media_assets SET asset_type = 'primary'
      FROM to_promote
      WHERE media_assets.id = to_promote.media_id
    `);
    console.log(`Promoted ${productPromote.rowCount} product-level images to primary`);
  }

  await pool.end();
  console.log('\nDone.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
