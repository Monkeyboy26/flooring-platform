#!/usr/bin/env node
/**
 * fix-jmv-images.cjs
 *
 * Re-syncs James Martin image ordering from the XLSX Etail Feed.
 * The import script stored images correctly, but subsequent enrichment
 * scripts disrupted the sort_order. This script:
 *   1. Reads the XLSX to get the canonical image order per Item Number
 *   2. Deletes all non-PDF media_assets for each JMV SKU
 *   3. Re-inserts images in the XLSX column order (Images → primary, Images_1..29 → alternate)
 *
 * Usage:
 *   node backend/scripts/fix-jmv-images.cjs --file ~/Downloads/james-martin.xlsx --dry-run
 *   node backend/scripts/fix-jmv-images.cjs --file ~/Downloads/james-martin.xlsx
 */

const XLSX = require('xlsx');
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || process.env.PGHOST || 'localhost',
  port: process.env.DB_PORT || process.env.PGPORT || 5432,
  database: process.env.DB_NAME || process.env.PGDATABASE || 'flooring_pim',
  user: process.env.DB_USER || process.env.PGUSER || 'postgres',
  password: process.env.DB_PASS || process.env.PGPASSWORD || 'postgres',
});

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const fileIdx = args.indexOf('--file');
const filePath = fileIdx !== -1 ? args[fileIdx + 1] : null;

if (!filePath) {
  console.error('Usage: node fix-jmv-images.cjs --file <path.xlsx> [--dry-run]');
  process.exit(1);
}

function col(row, name) {
  let v = row[name];
  if (v === undefined) v = row[name + ' '];
  if (v == null || String(v).trim() === '') return null;
  return String(v).trim();
}

async function main() {
  console.log(`fix-jmv-images.cjs — ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  console.log(`File: ${filePath}`);
  console.log('─'.repeat(60));

  // Step 1: Read XLSX
  console.log('Reading XLSX...');
  const workbook = XLSX.readFile(filePath);
  let allRows = [];
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet);
    console.log(`  Sheet "${sheetName}": ${rows.length} rows`);
    allRows = allRows.concat(rows);
  }

  // Build image map: itemNumber → [url1, url2, ...]
  const imageMap = new Map();
  for (const row of allRows) {
    const itemNumber = col(row, 'Item Number');
    if (!itemNumber) continue;

    const urls = [];
    const primaryImg = col(row, 'Images');
    if (primaryImg && primaryImg.startsWith('http')) urls.push(primaryImg);
    for (let j = 1; j <= 29; j++) {
      const imgUrl = col(row, `Images_${j}`);
      if (imgUrl && imgUrl.startsWith('http')) urls.push(imgUrl);
    }
    if (urls.length > 0) {
      imageMap.set(itemNumber, urls);
    }
  }
  console.log(`XLSX: ${imageMap.size} items with images\n`);

  // Step 2: Load all JMV SKUs
  const skuResult = await pool.query(`
    SELECT s.id, s.vendor_sku, s.internal_sku, p.id as product_id
    FROM skus s
    JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id AND v.code = 'JMV'
    WHERE s.status = 'active'
    ORDER BY s.internal_sku
  `);
  console.log(`DB: ${skuResult.rows.length} active JMV SKUs`);

  // Step 3: Process each SKU
  let updated = 0, skipped = 0, noXlsx = 0, alreadyOk = 0;

  for (const sku of skuResult.rows) {
    const urls = imageMap.get(sku.vendor_sku);
    if (!urls || urls.length === 0) {
      noXlsx++;
      continue;
    }

    // Check if current DB images already match XLSX order
    const currentMedia = await pool.query(`
      SELECT url, asset_type, sort_order FROM media_assets
      WHERE sku_id = $1 AND asset_type IN ('primary', 'alternate')
      ORDER BY sort_order
    `, [sku.id]);

    const currentUrls = currentMedia.rows.map(r => r.url.replace('https://', 'http://'));
    const xlsxUrls = urls.map(u => u.replace('https://', 'http://'));

    // Check if order matches and first is primary
    const orderMatches = currentMedia.rows.length === urls.length
      && currentMedia.rows[0]?.asset_type === 'primary'
      && currentUrls.every((u, i) => u === xlsxUrls[i]);

    if (orderMatches) {
      alreadyOk++;
      continue;
    }

    if (!DRY_RUN) {
      // Delete existing non-PDF images
      await pool.query(`
        DELETE FROM media_assets
        WHERE sku_id = $1 AND asset_type IN ('primary', 'alternate')
      `, [sku.id]);

      // Re-insert in XLSX order
      for (let j = 0; j < urls.length; j++) {
        const assetType = j === 0 ? 'primary' : 'alternate';
        const url = urls[j].replace('http://', 'https://');
        await pool.query(`
          INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
          VALUES ($1, $2, $3, $4, $5, $6)
        `, [sku.product_id, sku.id, assetType, url, urls[j], j]);
      }
    }

    updated++;
    if (updated <= 5) {
      console.log(`  ${sku.internal_sku}: ${urls.length} images (was ${currentMedia.rows.length}, primary: ${currentMedia.rows[0]?.asset_type === 'primary' ? 'yes' : 'NO'})`);
    }
  }

  if (updated > 5) console.log(`  ... and ${updated - 5} more`);

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Updated: ${updated} SKUs`);
  console.log(`Already correct: ${alreadyOk} SKUs`);
  console.log(`No XLSX images: ${noXlsx} SKUs`);
  console.log(`Skipped: ${skipped} SKUs`);

  if (!DRY_RUN && updated > 0) {
    // Verify
    const verifyResult = await pool.query(`
      SELECT
        SUM(CASE WHEN EXISTS(SELECT 1 FROM media_assets ma WHERE ma.sku_id = s.id AND ma.asset_type = 'primary') THEN 1 ELSE 0 END) as with_primary,
        SUM(CASE WHEN NOT EXISTS(SELECT 1 FROM media_assets ma WHERE ma.sku_id = s.id AND ma.asset_type = 'primary') THEN 1 ELSE 0 END) as without_primary
      FROM skus s
      JOIN products p ON p.id = s.product_id
      JOIN vendors v ON v.id = p.vendor_id AND v.code = 'JMV'
      WHERE s.status = 'active'
    `);
    console.log(`\nVerification: ${verifyResult.rows[0].with_primary} with primary, ${verifyResult.rows[0].without_primary} without`);
  }

  console.log('\nDone!');
  await pool.end();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
