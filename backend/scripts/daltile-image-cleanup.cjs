#!/usr/bin/env node
/**
 * daltile-image-cleanup.cjs
 *
 * Removes misleading/generic Daltile Scene7 images that were assigned to many
 * unrelated SKUs (collection hero images, shape silhouettes, shared swatches).
 *
 * Two steps:
 *   1. Delete SKU-level media_assets where the same URL is shared across 10+ SKUs
 *   2. Strip "?$TRIMTHUMBNAIL$" preset from remaining Daltile URLs for higher resolution
 *
 * Usage:
 *   node backend/scripts/daltile-image-cleanup.cjs --dry-run
 *   node backend/scripts/daltile-image-cleanup.cjs
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
const SHARED_THRESHOLD = 10;

async function main() {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  DALTILE IMAGE CLEANUP ${DRY_RUN ? '(DRY RUN)' : '(LIVE)'}`);
  console.log(`${'='.repeat(60)}\n`);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ── Step 1: Identify over-shared URLs ──
    console.log('─── Step 1: Identify over-shared URLs ───\n');
    const shared = await client.query(`
      SELECT url, COUNT(DISTINCT sku_id) as sku_count, COUNT(*) as asset_count
      FROM media_assets
      WHERE sku_id IS NOT NULL AND url LIKE '%scene7.com%'
      GROUP BY url
      HAVING COUNT(DISTINCT sku_id) >= $1
      ORDER BY sku_count DESC
    `, [SHARED_THRESHOLD]);

    console.log(`  URLs shared across ${SHARED_THRESHOLD}+ SKUs: ${shared.rows.length}`);
    console.log(`  Top 5:`);
    for (const row of shared.rows.slice(0, 5)) {
      console.log(`    ${row.sku_count} SKUs — ${row.url.slice(0, 80)}`);
    }

    const totalAssets = shared.rows.reduce((sum, r) => sum + parseInt(r.asset_count), 0);
    console.log(`\n  Total SKU-level assets to delete: ${totalAssets}\n`);

    // ── Step 2: Delete over-shared SKU-level assets ──
    console.log('─── Step 2: Delete over-shared SKU-level assets ───\n');
    const deleteRes = await client.query(`
      DELETE FROM media_assets
      WHERE sku_id IS NOT NULL
        AND url LIKE '%scene7.com%'
        AND url IN (
          SELECT url FROM media_assets
          WHERE sku_id IS NOT NULL AND url LIKE '%scene7.com%'
          GROUP BY url
          HAVING COUNT(DISTINCT sku_id) >= $1
        )
      RETURNING id
    `, [SHARED_THRESHOLD]);
    console.log(`  Deleted ${deleteRes.rowCount} SKU-level media assets\n`);

    // ── Step 3: Strip TRIMTHUMBNAIL preset from remaining URLs ──
    console.log('─── Step 3: Strip ?$TRIMTHUMBNAIL$ preset ───\n');
    const updateRes = await client.query(`
      UPDATE media_assets
      SET url = REPLACE(url, '?$TRIMTHUMBNAIL$', '')
      WHERE url LIKE '%scene7.com%' AND url LIKE '%TRIMTHUMBNAIL%'
      RETURNING id
    `);
    console.log(`  Stripped preset from ${updateRes.rowCount} URLs\n`);

    // ── Step 4: Also clean up product-level (non-SKU) assets with same URLs ──
    // If a URL is in the over-shared list, it's a collection hero — keep ONE instance
    // at the product level for products that had it, delete any duplicates.
    console.log('─── Step 4: Dedupe product-level assets with same URLs ───\n');
    const dedupeRes = await client.query(`
      DELETE FROM media_assets
      WHERE id IN (
        SELECT id FROM (
          SELECT id, ROW_NUMBER() OVER (PARTITION BY product_id, url ORDER BY created_at) as rn
          FROM media_assets
          WHERE sku_id IS NULL AND product_id IS NOT NULL AND url LIKE '%scene7.com%'
        ) x WHERE rn > 1
      )
      RETURNING id
    `);
    console.log(`  Deleted ${dedupeRes.rowCount} duplicate product-level assets\n`);

    // ── Verification ──
    console.log('─── Verification ───\n');
    const verify = await client.query(`
      SELECT COUNT(*) as remaining FROM media_assets WHERE url LIKE '%TRIMTHUMBNAIL%'
    `);
    console.log(`  Assets still containing TRIMTHUMBNAIL: ${verify.rows[0].remaining}`);

    const verifyShared = await client.query(`
      SELECT COUNT(*) FROM (
        SELECT url FROM media_assets
        WHERE sku_id IS NOT NULL AND url LIKE '%scene7.com%'
        GROUP BY url HAVING COUNT(DISTINCT sku_id) >= $1
      ) x
    `, [SHARED_THRESHOLD]);
    console.log(`  URLs still over-shared (${SHARED_THRESHOLD}+ SKUs): ${verifyShared.rows[0].count}\n`);

    if (DRY_RUN) {
      console.log('[DRY RUN] Rolling back...\n');
      await client.query('ROLLBACK');
    } else {
      await client.query('COMMIT');
      console.log('Transaction committed.\n');
    }

    console.log(`${'='.repeat(60)}`);
    console.log('  SUMMARY');
    console.log(`${'='.repeat(60)}`);
    console.log(`  Over-shared URLs found:     ${shared.rows.length}`);
    console.log(`  SKU-level assets deleted:   ${deleteRes.rowCount}`);
    console.log(`  URL presets stripped:       ${updateRes.rowCount}`);
    console.log(`  Duplicate product assets:   ${dedupeRes.rowCount}`);
    console.log(`${'='.repeat(60)}\n`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Rolled back:', err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
