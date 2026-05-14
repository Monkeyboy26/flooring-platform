#!/usr/bin/env node
/**
 * fix-all-lifestyle-primaries.cjs
 *
 * Comprehensive fix for lifestyle/room-scene images incorrectly set as primary
 * across ALL vendors. Detects via URL keyword matching (same keywords as
 * base.js isLifestyleUrl).
 *
 * For each lifestyle primary found:
 *   - If a non-lifestyle alternate exists → 3-step swap
 *   - If no suitable alternate → reclassify primary to lifestyle
 *
 * Usage:
 *   node backend/scripts/fix-all-lifestyle-primaries.cjs --dry-run
 *   node backend/scripts/fix-all-lifestyle-primaries.cjs
 *   node backend/scripts/fix-all-lifestyle-primaries.cjs --sku-only    # only SKU-level
 *   node backend/scripts/fix-all-lifestyle-primaries.cjs --product-only # only product-level
 */

const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.PGHOST || 'localhost',
  port: parseInt(process.env.PGPORT || '5432'),
  database: process.env.PGDATABASE || 'flooring_pim',
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'postgres',
});

const DRY_RUN = process.argv.includes('--dry-run');
const SKU_ONLY = process.argv.includes('--sku-only');
const PRODUCT_ONLY = process.argv.includes('--product-only');

// Same keywords as base.js LIFESTYLE_KEYWORDS
const LIFESTYLE_KEYWORDS = [
  'room', 'scene', 'lifestyle', 'installed', 'roomscene', 'setting',
  'interior', 'kitchen', 'bath', 'bathroom', 'living', 'outdoor', 'pool',
  'backyard', 'application', 'install', 'showroom',
  'ambiance', 'vignette', 'hero', 'banner', 'header',
  'spotlight', 'promo', 'campaign', '1920x1080', '_4k',
  '.mp4', '.mov', '.webm',
  'amb0', 'amb1', '_amb_', '-amb-', 'amb_', 'ambi_',
  '_amb.', '-amb.', '-amb ',
  'crop_upscale',
  'ambience', 'gallery', 'roomview', 'room-view', 'insitu', 'in-situ',
  'inspiration', 'styled',
  'ambiente', 'bagno', 'cucina', 'ristorante', 'terrazza', 'soggiorno',
  'camera_', 'camera-',
  'posa', 'esterno', 'ingresso', 'veranda', 'giardino',
  'ambientazione', 'ambienta',
];

function isLifestyleUrl(url, productName) {
  const filename = url.toLowerCase().split('/').pop().split('?')[0];
  if (!productName) return LIFESTYLE_KEYWORDS.some(kw => filename.includes(kw));
  const prodLow = productName.toLowerCase();
  return LIFESTYLE_KEYWORDS.some(kw => filename.includes(kw) && !prodLow.includes(kw));
}

async function main() {
  const client = await pool.connect();
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  console.log(`Scope: ${SKU_ONLY ? 'SKU-level only' : PRODUCT_ONLY ? 'Product-level only' : 'Both'}\n`);

  try {
    // Find all primary images
    const skuFilter = SKU_ONLY ? 'AND ma.sku_id IS NOT NULL'
      : PRODUCT_ONLY ? 'AND ma.sku_id IS NULL'
      : '';

    const { rows: primaries } = await client.query(`
      SELECT ma.id, ma.product_id, ma.sku_id, ma.url, ma.sort_order,
             p.name as pname, p.collection, v.name as vendor
      FROM media_assets ma
      JOIN products p ON p.id = ma.product_id
      JOIN vendors v ON v.id = p.vendor_id
      WHERE ma.asset_type = 'primary'
        AND ma.sort_order = 0
        ${skuFilter}
      ORDER BY v.name, p.collection, p.name
    `);

    console.log(`Found ${primaries.length} total primary images to check\n`);

    // Filter to lifestyle primaries
    const lifestylePrimaries = primaries.filter(r =>
      isLifestyleUrl(r.url, r.pname)
    );

    console.log(`Found ${lifestylePrimaries.length} lifestyle-as-primary images\n`);

    if (lifestylePrimaries.length === 0) {
      console.log('Nothing to fix!');
      return;
    }

    // Group by vendor for reporting
    const byVendor = {};
    for (const r of lifestylePrimaries) {
      byVendor[r.vendor] = (byVendor[r.vendor] || 0) + 1;
    }
    console.log('By vendor:');
    for (const [v, c] of Object.entries(byVendor).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${v}: ${c}`);
    }
    console.log('');

    let swapped = 0, reclassified = 0, skipped = 0;

    if (!DRY_RUN) {
      await client.query('BEGIN');
    }

    for (const row of lifestylePrimaries) {
      const level = row.sku_id ? 'sku' : 'product';
      const label = `[${row.vendor}] ${row.pname}/${row.collection} (${level})`;

      // Find a non-lifestyle alternate for this product/sku
      const altQuery = row.sku_id
        ? `SELECT id, url, sort_order FROM media_assets
           WHERE product_id = $1 AND sku_id = $2
             AND asset_type = 'alternate' AND sort_order >= 0
           ORDER BY sort_order LIMIT 10`
        : `SELECT id, url, sort_order FROM media_assets
           WHERE product_id = $1 AND sku_id IS NULL
             AND asset_type = 'alternate' AND sort_order >= 0
           ORDER BY sort_order LIMIT 10`;

      const altParams = row.sku_id
        ? [row.product_id, row.sku_id]
        : [row.product_id];

      const { rows: alternates } = await client.query(altQuery, altParams);

      // Find first non-lifestyle alternate
      const goodAlt = alternates.find(a => !isLifestyleUrl(a.url, row.pname));

      if (goodAlt) {
        // 3-step swap
        const tempSort = -(10000 + swapped);
        const safeSort = 20 + swapped;

        if (!DRY_RUN) {
          // Step 1: Demote old primary to lifestyle with temp negative sort_order
          await client.query(
            `UPDATE media_assets SET asset_type = 'lifestyle', sort_order = $1 WHERE id = $2`,
            [tempSort, row.id]
          );
          // Step 2: Promote alternate to primary at sort_order 0
          await client.query(
            `UPDATE media_assets SET asset_type = 'primary', sort_order = 0 WHERE id = $1`,
            [goodAlt.id]
          );
          // Step 3: Assign safe positive sort_order to demoted image
          await client.query(
            `UPDATE media_assets SET sort_order = $1 WHERE id = $2`,
            [safeSort, row.id]
          );
        }

        console.log(`SWAP  ${label}`);
        console.log(`      old: ${row.url.split('/').pop()}`);
        console.log(`      new: ${goodAlt.url.split('/').pop()}`);
        swapped++;
      } else {
        // No good alternate — reclassify primary to lifestyle
        // Find a safe sort_order for lifestyle
        const maxSortRes = await client.query(
          row.sku_id
            ? `SELECT COALESCE(MAX(sort_order), 0) + 1 as next_sort
               FROM media_assets WHERE product_id = $1 AND sku_id = $2
                 AND asset_type = 'lifestyle' AND sort_order >= 0`
            : `SELECT COALESCE(MAX(sort_order), 0) + 1 as next_sort
               FROM media_assets WHERE product_id = $1 AND sku_id IS NULL
                 AND asset_type = 'lifestyle' AND sort_order >= 0`,
          row.sku_id ? [row.product_id, row.sku_id] : [row.product_id]
        );
        const nextSort = Math.max(parseInt(maxSortRes.rows[0].next_sort), 30);

        if (!DRY_RUN) {
          await client.query(
            `UPDATE media_assets SET asset_type = 'lifestyle', sort_order = $1 WHERE id = $2`,
            [nextSort, row.id]
          );
        }

        console.log(`RECL  ${label}`);
        console.log(`      ${row.url.split('/').pop()} → lifestyle (sort ${nextSort})`);
        reclassified++;
      }
    }

    if (!DRY_RUN) {
      await client.query('COMMIT');
      console.log(`\nCOMMITTED.`);
    }

    console.log(`\nSummary:`);
    console.log(`  Swapped:      ${swapped}`);
    console.log(`  Reclassified: ${reclassified}`);
    console.log(`  Total fixed:  ${swapped + reclassified}`);
    if (DRY_RUN) console.log(`\n(Dry run - no changes made. Remove --dry-run to apply.)`);

  } catch (err) {
    if (!DRY_RUN) await client.query('ROLLBACK').catch(() => {});
    console.error('ERROR:', err.message);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
