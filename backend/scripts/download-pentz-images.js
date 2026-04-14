#!/usr/bin/env node

/**
 * Download Pentz Commercial images to local /uploads/ directory.
 *
 * Pentz images are served from a slow WordPress server (~500-800ms per image).
 * This script downloads them locally so they load instantly via nginx.
 *
 * Usage:
 *   docker compose exec api node scripts/download-pentz-images.js
 */

import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

const UPLOADS_BASE = process.env.UPLOADS_PATH || '/app/uploads';
const CONCURRENCY = 10;

async function downloadImage(imageUrl, destPath) {
  try {
    await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
    const resp = await fetch(imageUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(30000),
    });
    if (!resp.ok) return null;
    await pipeline(resp.body, fs.createWriteStream(destPath));
    return destPath;
  } catch {
    try { await fs.promises.unlink(destPath); } catch { }
    return null;
  }
}

async function main() {
  console.log('=== Download Pentz Commercial Images ===\n');

  // Get all Pentz media assets with external URLs
  const result = await pool.query(`
    SELECT ma.id, ma.url, ma.sku_id, ma.product_id, ma.asset_type, ma.sort_order
    FROM media_assets ma
    JOIN products p ON ma.product_id = p.id
    JOIN vendors v ON p.vendor_id = v.id
    WHERE v.code = 'PC'
      AND ma.url LIKE 'https://%'
    ORDER BY ma.product_id, ma.sku_id, ma.sort_order
  `);

  const assets = result.rows;
  console.log(`  Found ${assets.length} images to download\n`);

  let downloaded = 0;
  let skipped = 0;
  let failed = 0;

  // Process in batches for concurrency control
  for (let i = 0; i < assets.length; i += CONCURRENCY) {
    const batch = assets.slice(i, i + CONCURRENCY);

    await Promise.all(batch.map(async (asset) => {
      // Build local path: /uploads/products/{product_id}/{sku_id}-{sort_order}.jpg
      const filename = asset.sku_id
        ? `${asset.sku_id}-${asset.sort_order}.jpg`
        : `product-${asset.sort_order}.jpg`;
      const destDir = path.join(UPLOADS_BASE, 'products', asset.product_id);
      const destPath = path.join(destDir, filename);
      const localUrl = `/uploads/products/${asset.product_id}/${filename}`;

      // Skip if already downloaded
      try {
        await fs.promises.access(destPath);
        skipped++;
        return;
      } catch { /* file doesn't exist, proceed */ }

      const ok = await downloadImage(asset.url, destPath);
      if (ok) {
        // Update DB: local URL, preserve original
        await pool.query(`
          UPDATE media_assets SET url = $1, original_url = $2 WHERE id = $3
        `, [localUrl, asset.url, asset.id]);
        downloaded++;
      } else {
        failed++;
      }
    }));

    // Progress
    const done = i + batch.length;
    if (done % 100 === 0 || done === assets.length) {
      console.log(`  Progress: ${done}/${assets.length} (${downloaded} downloaded, ${skipped} skipped, ${failed} failed)`);
    }
  }

  console.log('\n=== Complete ===');
  console.log(`  Downloaded: ${downloaded}`);
  console.log(`  Skipped:    ${skipped}`);
  console.log(`  Failed:     ${failed}`);

  await pool.end();
}

main().catch(err => {
  console.error('Download failed:', err);
  pool.end();
  process.exit(1);
});
