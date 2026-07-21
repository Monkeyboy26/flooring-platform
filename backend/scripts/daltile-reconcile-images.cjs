#!/usr/bin/env node
/**
 * Reconcile Daltile SKU primary images against the authoritative product map.
 *
 * Fixes the "rough matching" the storefront exposes — right color, wrong
 * pattern or a size/aspect-mismatched render — by replacing a SKU's stored
 * primary image with the map's per-SKU image ONLY when the current one is
 * genuinely wrong. The decision lives in scrapers/daltile-image-rank.cjs and is
 * richness-first: pattern/trim/placeholder errors are always corrected, size
 * drift is corrected only when the map offers a size-accurate real render, and a
 * good scene7 render is never downgraded to a flat swatch or a low-res DAM TIF.
 *
 * Every change is written with source='image-reconcile' and dumped to a backup
 * JSON first, so it is fully traceable and revertible.
 *
 * Usage:
 *   node backend/scripts/daltile-reconcile-images.cjs --dry-run   # report only
 *   node backend/scripts/daltile-reconcile-images.cjs             # apply + backup
 *   node backend/scripts/daltile-reconcile-images.cjs --revert <backup.json>
 */
const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');
const { planPrimaryImageFix } = require('../scrapers/daltile-image-rank.cjs');

const pool = new Pool({
  host: process.env.DB_HOST || process.env.PGHOST || 'localhost',
  port: parseInt(process.env.DB_PORT || process.env.PGPORT || '5432'),
  database: process.env.DB_NAME || process.env.PGDATABASE || 'flooring_pim',
  user: process.env.DB_USER || process.env.PGUSER || 'postgres',
  password: process.env.DB_PASSWORD || process.env.PGPASSWORD || 'postgres',
});

const DRY_RUN = process.argv.includes('--dry-run');
const revertIdx = process.argv.indexOf('--revert');
const REVERT_FILE = revertIdx !== -1 ? process.argv[revertIdx + 1] : null;
const DATA_DIR = path.join(__dirname, '..', 'data');

async function revert(file) {
  const changes = JSON.parse(fs.readFileSync(file, 'utf8'));
  console.log(`Reverting ${changes.length} image changes from ${path.basename(file)}...`);
  let n = 0;
  for (const c of changes) {
    await pool.query(
      `UPDATE media_assets SET url = $1, original_url = $1, source = $2 WHERE id = $3`,
      [c.old_url, c.old_source || 'scraper', c.ma_id]
    );
    n++;
  }
  console.log(`Reverted ${n} rows.`);
  await pool.end();
}

async function main() {
  if (REVERT_FILE) return revert(REVERT_FILE);

  console.log(`\nDaltile Image Reconcile${DRY_RUN ? ' (DRY RUN)' : ''}\n`);

  // 1. Build coveoSku → { productImageUrl, productType } from the product map.
  const productMap = require(path.join(DATA_DIR, 'daltile-product-map.json'));
  const mapBySku = new Map();
  for (const series of Object.values(productMap.series)) {
    for (const product of Object.values(series.products || {})) {
      for (const sku of product.skus || []) {
        if (sku.coveoSku) {
          mapBySku.set(sku.coveoSku.toUpperCase(), {
            productImageUrl: sku.productImageUrl || '',
            productType: sku.productType || '',
          });
        }
      }
    }
    // Trims/accessories can carry their own authoritative images too.
    for (const acc of Object.values(series.accessories || {})) {
      for (const sku of acc.skus || []) {
        if (sku.coveoSku && !mapBySku.has(sku.coveoSku.toUpperCase())) {
          mapBySku.set(sku.coveoSku.toUpperCase(), {
            productImageUrl: sku.productImageUrl || '',
            productType: sku.productType || '',
          });
        }
      }
    }
  }
  console.log(`Product map: ${mapBySku.size} SKUs with image data`);

  // 2. Current primary image for every active Daltile SKU.
  const { rows } = await pool.query(`
    SELECT ma.id AS ma_id, ma.url AS current_url, ma.source AS old_source,
           s.id AS sku_id, s.vendor_sku
    FROM media_assets ma
    JOIN skus s ON s.id = ma.sku_id
    JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id
    WHERE v.code = 'DAL' AND s.status = 'active'
      AND ma.asset_type = 'primary' AND ma.sort_order = 0
  `);
  console.log(`Active Daltile SKUs with a primary image: ${rows.length}\n`);

  // 3. Plan the fixes.
  const changes = [];
  const byReason = {};
  let notInMap = 0;
  for (const row of rows) {
    const entry = mapBySku.get((row.vendor_sku || '').toUpperCase());
    if (!entry) { notInMap++; continue; }
    const plan = planPrimaryImageFix({
      vendorSku: row.vendor_sku,
      productType: entry.productType,
      currentUrl: row.current_url,
      mapImageUrl: entry.productImageUrl,
    });
    if (!plan.replace) continue;
    byReason[plan.reason] = (byReason[plan.reason] || 0) + 1;
    changes.push({
      ma_id: row.ma_id,
      sku_id: row.sku_id,
      vendor_sku: row.vendor_sku,
      old_url: row.current_url,
      new_url: plan.newUrl,
      old_source: row.old_source,
      reason: plan.reason,
    });
  }

  // 4. Report.
  console.log('=== Planned fixes by reason ===');
  for (const [reason, n] of Object.entries(byReason).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${reason}`);
  }
  console.log(`  ----`);
  console.log(`  ${String(changes.length).padStart(4)}  total`);
  console.log(`\n  (${notInMap} active SKUs not in the current map — left untouched)\n`);

  // A few concrete before/after examples per reason.
  const shown = {};
  for (const c of changes) {
    shown[c.reason] = shown[c.reason] || [];
    if (shown[c.reason].length < 2) shown[c.reason].push(c);
  }
  console.log('=== Examples (vendor_sku | old → new) ===');
  for (const [reason, list] of Object.entries(shown)) {
    console.log(`[${reason}]`);
    for (const c of list) {
      const short = (u) => (u && u.includes('/daltile/')) ? u.split('/daltile/').pop() : (u ? u.split('/').pop() : '(none)');
      console.log(`  ${c.vendor_sku}`);
      console.log(`     old: ${short(c.old_url)}`);
      console.log(`     new: ${short(c.new_url)}`);
    }
  }

  if (changes.length === 0) { console.log('\nNothing to fix.'); await pool.end(); return; }

  if (DRY_RUN) {
    console.log('\nDRY RUN — no changes written. Re-run without --dry-run to apply.');
    await pool.end();
    return;
  }

  // 5. Backup, then apply.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(DATA_DIR, `daltile-image-reconcile-backup-${stamp}.json`);
  fs.writeFileSync(backupPath, JSON.stringify(changes, null, 2));
  console.log(`\nBackup written: ${path.relative(process.cwd(), backupPath)}`);

  const client = await pool.connect();
  let applied = 0;
  try {
    await client.query('BEGIN');
    for (const c of changes) {
      await client.query(
        `UPDATE media_assets SET url = $1, original_url = $1, source = 'image-reconcile' WHERE id = $2`,
        [c.new_url, c.ma_id]
      );
      applied++;
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  console.log(`Applied ${applied} image fixes.`);
  console.log(`Revert with: node backend/scripts/daltile-reconcile-images.cjs --revert ${path.relative(process.cwd(), backupPath)}`);
  await pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
