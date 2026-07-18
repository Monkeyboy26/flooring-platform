#!/usr/bin/env node
/**
 * fix-daltile-image-mismatches.cjs
 *
 * Repairs SKU-level Daltile primary images using the product map as the
 * candidate source (backend/data/daltile-product-map.json).
 *
 * Fixes three failure modes of the Coveo import (see daltile-image-match.cjs):
 *   wrong-color     — filename embeds another color's code (multi-SKU Coveo
 *                     entries share one image across colors)
 *   swatch-upgrade  — color-correct swatch used as primary when a real
 *                     product shot of the same size exists
 *   generic-upgrade — bare item-code silhouette (e.g. "S4369", "Q1665")
 *                     when a same-size color-specific shot exists
 * Also backfills SKUs that have no primary image at all, when a same-size
 * color-correct shot exists.
 *
 * Replacement URLs are HTTP-validated before applying (some Coveo-published
 * Scene7 URLs 403). Broken ones are excluded and the next-best candidate is
 * used; the broken list is persisted to data/daltile-broken-images.json so
 * the unified scraper also skips them.
 *
 * Usage:
 *   node backend/scripts/fix-daltile-image-mismatches.cjs --dry-run
 *   node backend/scripts/fix-daltile-image-mismatches.cjs
 */

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { buildImageIndex, resolveImage } = require('../scrapers/daltile-image-match.cjs');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

const DRY_RUN = process.argv.includes('--dry-run');
const MAP_PATH = path.join(__dirname, '..', 'data', 'daltile-product-map.json');
const BROKEN_PATH = path.join(__dirname, '..', 'data', 'daltile-broken-images.json');
const CHECK_CONCURRENCY = 20;

async function urlOk(url) {
  try {
    const r = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(10000) });
    return r.ok;
  } catch { return false; }
}

async function checkUrls(urls) {
  const results = new Map();
  for (let i = 0; i < urls.length; i += CHECK_CONCURRENCY) {
    const batch = urls.slice(i, i + CHECK_CONCURRENCY);
    const oks = await Promise.all(batch.map(urlOk));
    batch.forEach((u, j) => results.set(u, oks[j]));
  }
  return results;
}

async function main() {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  DALTILE SKU IMAGE MATCH FIX ${DRY_RUN ? '(DRY RUN)' : '(LIVE)'}`);
  console.log(`${'='.repeat(60)}\n`);

  const productMap = JSON.parse(fs.readFileSync(MAP_PATH, 'utf-8'));
  const knownBroken = new Set(
    fs.existsSync(BROKEN_PATH) ? JSON.parse(fs.readFileSync(BROKEN_PATH, 'utf-8')) : []
  );
  let index = buildImageIndex(productMap.series, knownBroken);
  console.log(`Image index: ${index.byCode.size} color codes, ${index.knownCodes.size} known codes` +
    (knownBroken.size ? ` (${knownBroken.size} known-broken URLs excluded)` : '') + '\n');

  // Trim/accessory SKUs get conservative matching (same-size only) so shape
  // silhouettes aren't displaced by field-tile photos.
  const trimSkus = new Set();
  for (const series of Object.values(productMap.series)) {
    for (const group of Object.values(series.accessories || {})) {
      for (const sku of group.skus || []) trimSkus.add((sku.coveoSku || '').toUpperCase());
    }
    for (const group of Object.values(series.products || {})) {
      for (const sku of group.skus || []) {
        if (/trim/i.test(sku.productType || '')) trimSkus.add((sku.coveoSku || '').toUpperCase());
      }
    }
  }
  console.log(`Trim/accessory SKUs: ${trimSkus.size}`);

  // All active DAL-family SKUs with their current primary image (if any) and size
  const { rows } = await pool.query(`
    SELECT s.id AS sku_id, s.vendor_sku, p.id AS product_id, p.name AS product_name,
      ma.id AS ma_id, ma.url,
      (SELECT sa.value FROM sku_attributes sa
       JOIN attributes a ON a.id = sa.attribute_id
       WHERE sa.sku_id = s.id AND a.slug = 'size' LIMIT 1) AS size
    FROM skus s
    JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id
    LEFT JOIN media_assets ma ON ma.sku_id = s.id AND ma.asset_type = 'primary'
    WHERE v.code = 'DAL' AND s.status = 'active' AND p.status = 'active'
  `);
  console.log(`Loaded ${rows.length} active Daltile SKUs`);

  // Compute fixes, validate replacement URLs, and retry with the next-best
  // candidate when one is broken — loop until every replacement URL checks out.
  const checked = new Map();
  let fixes;
  for (let pass = 1; ; pass++) {
    fixes = [];
    for (const r of rows) {
      const isTrim = trimSkus.has((r.vendor_sku || '').toUpperCase());
      const fix = resolveImage(index, r.vendor_sku, r.size, r.url, { isTrim });
      if (fix) fixes.push({ ...r, newUrl: fix.url, reason: fix.reason });
    }
    const unchecked = [...new Set(fixes.map(f => f.newUrl))].filter(u => !checked.has(u));
    if (unchecked.length === 0) break;
    console.log(`Pass ${pass}: validating ${unchecked.length} replacement URLs...`);
    const results = await checkUrls(unchecked);
    let newBroken = 0;
    for (const [u, ok] of results) {
      checked.set(u, ok);
      if (!ok) { knownBroken.add(u); newBroken++; }
    }
    if (newBroken === 0) break;
    console.log(`  ${newBroken} broken URLs excluded, recomputing...`);
    index = buildImageIndex(productMap.series, knownBroken);
  }
  fixes = fixes.filter(f => checked.get(f.newUrl) !== false);

  if (knownBroken.size > 0) {
    fs.writeFileSync(BROKEN_PATH, JSON.stringify([...knownBroken].sort(), null, 2));
    console.log(`Broken URL list (${knownBroken.size}) saved to ${BROKEN_PATH}\n`);
  }

  const byReason = {};
  for (const f of fixes) byReason[f.reason] = (byReason[f.reason] || 0) + 1;

  console.log(`\nFix plan (${fixes.length} SKUs):`);
  for (const [reason, count] of Object.entries(byReason).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${reason}: ${count}`);
  }

  for (const reason of Object.keys(byReason)) {
    console.log(`\nSample ${reason} (first 5):`);
    for (const f of fixes.filter(x => x.reason === reason).slice(0, 5)) {
      console.log(`  ${f.vendor_sku} (${f.product_name})`);
      console.log(`    OLD: ${f.url ? f.url.split('/').pop() : '(none)'}`);
      console.log(`    NEW: ${f.newUrl.split('/').pop()}`);
    }
  }

  if (DRY_RUN) {
    console.log('\nDry run — no changes applied.');
    await pool.end();
    return;
  }

  if (fixes.length === 0) {
    console.log('\nNothing to fix.');
    await pool.end();
    return;
  }

  // Backup replaced rows so the change is reversible
  const backupPath = path.join(__dirname, '..', 'data', 'daltile-image-fix-backup.json');
  fs.writeFileSync(backupPath, JSON.stringify(
    fixes.map(f => ({ ma_id: f.ma_id, sku_id: f.sku_id, old_url: f.url, new_url: f.newUrl, reason: f.reason })),
    null, 2
  ));
  console.log(`\nBackup of replaced URLs written to ${backupPath}`);

  console.log(`Applying ${fixes.length} fixes...`);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const f of fixes) {
      if (f.ma_id) {
        await client.query(
          `UPDATE media_assets SET url = $2, original_url = $2 WHERE id = $1`,
          [f.ma_id, f.newUrl]
        );
      } else {
        await client.query(`
          INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
          VALUES ($1, $2, 'primary', $3, $3, 0)
        `, [f.product_id, f.sku_id, f.newUrl]);
      }
    }
    await client.query('COMMIT');
    console.log(`Committed ${fixes.length} fixes.`);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  await pool.end();
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
