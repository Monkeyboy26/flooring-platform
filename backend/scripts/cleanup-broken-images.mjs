#!/usr/bin/env node
/**
 * Find and delete broken (404) media_asset URLs for DAL/AO/MZ vendors.
 * Tests each URL with a HEAD request and removes 404s so the frontend
 * COALESCE fallback can show a working image instead.
 *
 * Usage: docker exec -i flooring-api node /app/scripts/cleanup-broken-images.mjs [--dry-run]
 */
import pg from 'pg';

const DRY_RUN = process.argv.includes('--dry-run');
const CONCURRENCY = 10;
const TIMEOUT_MS = 8000;

async function testUrl(url) {
  try {
    const resp = await fetch(url, {
      method: 'HEAD',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'follow',
    });
    return resp.status;
  } catch {
    return 0; // timeout or network error
  }
}

async function main() {
  const pool = new pg.Pool({
    host: process.env.DB_HOST || 'db',
    port: parseInt(process.env.DB_PORT || '5432'),
    database: process.env.DB_NAME || 'flooring_pim',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
  });

  // Load all DAL/AO/MZ image URLs
  const result = await pool.query(`
    SELECT ma.sku_id, ma.product_id, ma.asset_type, ma.sort_order, ma.url
    FROM media_assets ma
    JOIN skus s ON s.id = ma.sku_id
    JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id
    WHERE v.code IN ('DAL', 'AO', 'MZ')
      AND s.status = 'active'
    ORDER BY ma.url
  `);

  // Deduplicate by URL (many SKUs share the same image)
  const urlMap = new Map();
  for (const row of result.rows) {
    if (!urlMap.has(row.url)) urlMap.set(row.url, []);
    urlMap.get(row.url).push(row);
  }

  const uniqueUrls = [...urlMap.keys()];
  console.log(`Testing ${uniqueUrls.length} unique URLs (${result.rows.length} total media_assets)...`);
  if (DRY_RUN) console.log('DRY RUN — no deletions will be made\n');

  let tested = 0, broken = 0, deleted = 0;

  // Process in batches for concurrency
  for (let i = 0; i < uniqueUrls.length; i += CONCURRENCY) {
    const batch = uniqueUrls.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(async (url) => {
      const status = await testUrl(url);
      return { url, status };
    }));

    for (const { url, status } of results) {
      tested++;
      if (status === 404) {
        broken++;
        const rows = urlMap.get(url);
        console.log(`  404 [${rows.length} refs] ${url.substring(0, 120)}`);

        if (!DRY_RUN) {
          for (const row of rows) {
            await pool.query(
              `DELETE FROM media_assets WHERE sku_id = $1 AND product_id = $2 AND asset_type = $3 AND sort_order = $4`,
              [row.sku_id, row.product_id, row.asset_type, row.sort_order]
            );
            deleted++;
          }
        }
      }
    }

    if (tested % 100 === 0 || i + CONCURRENCY >= uniqueUrls.length) {
      process.stdout.write(`\r  Progress: ${tested}/${uniqueUrls.length} tested, ${broken} broken`);
    }
  }

  console.log(`\n\nDone. Tested: ${tested}, Broken: ${broken}, Deleted: ${deleted}`);
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
