#!/usr/bin/env node
/**
 * Purge Widen CDN "Preview Not Available" placeholder images from media_assets.
 * The CDN returns HTTP 404 for removed/unavailable assets — these render as a
 * generic "Preview Not Available" image on the storefront.
 *
 * Usage:  node backend/scripts/purge-widen-placeholders.mjs [--dry-run]
 */
import pg from 'pg';

const DRY_RUN = process.argv.includes('--dry-run');
const CONCURRENCY = 30;
const VENDOR_ID = '550e8400-e29b-41d4-a716-446655440007'; // Arizona Tile

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

const PLACEHOLDER_SIZE = 8016; // "Preview Not Available" PNG placeholder

async function checkUrl(url) {
  try {
    const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(8000) });
    if (!res.ok) return true; // 404 / 5xx = placeholder
    // Also catch the placeholder when CDN returns 200 with the known size
    const len = parseInt(res.headers.get('content-length') || '0', 10);
    if (len > 0 && len <= PLACEHOLDER_SIZE) return true;
    return false;
  } catch {
    return true; // network error = treat as unavailable
  }
}

async function main() {
  console.log(DRY_RUN ? '=== DRY RUN ===' : '=== LIVE RUN ===');

  // Fetch all distinct Widen URLs for Arizona Tile
  const { rows } = await pool.query(`
    SELECT DISTINCT ma.id, ma.url, ma.asset_type, ma.sku_id, p.name AS product_name
    FROM media_assets ma
    JOIN products p ON ma.product_id = p.id
    WHERE p.vendor_id = $1
      AND ma.url LIKE '%widen.net%'
    ORDER BY ma.url
  `, [VENDOR_ID]);

  console.log(`Found ${rows.length} Widen media_asset rows to check`);

  // Deduplicate by URL for efficient checking
  const urlMap = new Map();
  for (const row of rows) {
    if (!urlMap.has(row.url)) urlMap.set(row.url, []);
    urlMap.get(row.url).push(row);
  }

  const uniqueUrls = [...urlMap.keys()];
  console.log(`${uniqueUrls.length} unique URLs`);

  const badIds = [];
  let checked = 0;

  // Process in batches
  for (let i = 0; i < uniqueUrls.length; i += CONCURRENCY) {
    const batch = uniqueUrls.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(async (url) => {
      const isBad = await checkUrl(url);
      return { url, isBad };
    }));

    for (const { url, isBad } of results) {
      if (isBad) {
        const affected = urlMap.get(url);
        for (const row of affected) {
          badIds.push(row.id);
          console.log(`  ✗ [${row.asset_type}] ${row.product_name} → ${url.split('/').pop().split('?')[0]}`);
        }
      }
    }

    checked += batch.length;
    if (checked % 300 === 0 || checked === uniqueUrls.length) {
      console.log(`  checked ${checked}/${uniqueUrls.length} unique URLs, found ${badIds.length} bad rows so far`);
    }
  }

  console.log(`\nTotal placeholder rows to delete: ${badIds.length}`);

  if (badIds.length === 0) {
    console.log('Nothing to do.');
    await pool.end();
    return;
  }

  if (!DRY_RUN) {
    // Delete in batches of 500
    for (let i = 0; i < badIds.length; i += 500) {
      const batch = badIds.slice(i, i + 500);
      const { rowCount } = await pool.query(
        `DELETE FROM media_assets WHERE id = ANY($1::uuid[])`,
        [batch]
      );
      console.log(`  deleted ${rowCount} rows (batch ${Math.floor(i / 500) + 1})`);
    }
    console.log('Done.');
  } else {
    console.log('Dry run — no rows deleted. Remove --dry-run to execute.');
  }

  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
