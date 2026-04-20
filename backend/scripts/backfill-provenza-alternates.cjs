#!/usr/bin/env node
/**
 * Backfill Provenza alternate/lifestyle images by probing GCS URL patterns.
 *
 * Provenza GCS naming: {base}.jpg (primary), {base}_04.jpg, {base}_05.jpg, {base}_06.jpg (alternates).
 * Suffixes _01 through _03 don't exist; _04+ are alternate angles and room scenes.
 *
 * Runs entirely via HTTP HEAD checks — no browser needed.
 */

const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'db',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

// Provenza GCS uses _04, _05, _06, _07 for alternate images (skip _01–_03)
const SUFFIXES = ['_04', '_05', '_06', '_07', '_08'];

async function headCheck(url) {
  try {
    const resp = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
    return resp.ok;
  } catch {
    return false;
  }
}

async function main() {
  console.log('Fetching Provenza flooring SKUs with primary images...');

  const result = await pool.query(`
    SELECT s.id AS sku_id, s.product_id, s.variant_name, ma.url AS primary_url
    FROM skus s
    JOIN products p ON p.id = s.product_id
    JOIN media_assets ma ON ma.sku_id = s.id AND ma.asset_type = 'primary'
    WHERE p.collection LIKE 'Provenza%'
      AND s.variant_type IS NULL
    ORDER BY p.collection, s.variant_name
  `);

  console.log(`Found ${result.rows.length} SKUs with primary images`);

  let totalAdded = 0;
  let skusProcessed = 0;

  for (const row of result.rows) {
    const { sku_id, product_id, variant_name, primary_url } = row;

    // Extract base URL without extension: ...Provenza-Affinity-PRO2305-Mellow
    const dotIdx = primary_url.lastIndexOf('.');
    const ext = primary_url.slice(dotIdx); // .jpg
    const base = primary_url.slice(0, dotIdx);

    // Probe suffix variants: _04, _05, _06, _07, _08
    const foundUrls = [];
    for (const suffix of SUFFIXES) {
      const candidateUrl = `${base}${suffix}${ext}`;
      if (await headCheck(candidateUrl)) {
        foundUrls.push(candidateUrl);
      } else {
        break; // stop at first gap
      }
    }

    // Save found alternates
    for (let i = 0; i < foundUrls.length; i++) {
      const assetType = i < 2 ? 'alternate' : 'lifestyle';
      const sortOrder = i + 1; // 1, 2, 3... (primary is 0)

      try {
        await pool.query(`
          INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
          VALUES ($1, $2, $3, $4, $4, $5)
          ON CONFLICT (product_id, sku_id, asset_type, sort_order) WHERE sku_id IS NOT NULL
          DO UPDATE SET url = EXCLUDED.url, original_url = EXCLUDED.original_url
        `, [product_id, sku_id, assetType, foundUrls[i], sortOrder]);
        totalAdded++;
      } catch (err) {
        console.error(`  Error saving ${variant_name} [${assetType} #${sortOrder}]: ${err.message}`);
      }
    }

    skusProcessed++;
    if (skusProcessed % 25 === 0 || foundUrls.length > 0) {
      if (foundUrls.length > 0) {
        console.log(`  ${variant_name}: +${foundUrls.length} images`);
      }
      if (skusProcessed % 50 === 0) {
        console.log(`  Progress: ${skusProcessed}/${result.rows.length} SKUs, ${totalAdded} images added`);
      }
    }
  }

  console.log(`\nDone: ${skusProcessed} SKUs processed, ${totalAdded} alternate/lifestyle images added`);

  // Final counts
  const counts = await pool.query(`
    SELECT ma.asset_type, count(*)
    FROM media_assets ma
    JOIN skus s ON ma.sku_id = s.id
    JOIN products p ON s.product_id = p.id
    WHERE p.collection LIKE 'Provenza%'
    GROUP BY ma.asset_type
    ORDER BY ma.asset_type
  `);
  console.log('\nFinal media counts:');
  for (const r of counts.rows) {
    console.log(`  ${r.asset_type}: ${r.count}`);
  }

  await pool.end();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
