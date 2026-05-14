#!/usr/bin/env node
/**
 * fix-ef-pc-cleanup.cjs
 *
 * Three-phase cleanup for EF/PC image and duplicate issues:
 *   Phase 1: Fix plank images — replace grey PD-suffix swatches with vivid T-suffix tile images
 *   Phase 2: Deactivate EF cross-vendor duplicates (same product exists under PC vendor)
 *   Phase 3: Delete empty EF draft product shells (0 SKUs, 0 images)
 *
 * Usage:
 *   node backend/scripts/fix-ef-pc-cleanup.cjs --dry-run
 *   node backend/scripts/fix-ef-pc-cleanup.cjs
 */

const { Pool } = require('pg');
const https = require('https');

const pool = new Pool({
  host: process.env.DB_HOST || process.env.PGHOST || 'localhost',
  port: process.env.DB_PORT || process.env.PGPORT || 5432,
  database: process.env.DB_NAME || process.env.PGDATABASE || 'flooring_pim',
  user: process.env.DB_USER || process.env.PGUSER || 'postgres',
  password: process.env.DB_PASS || process.env.PGPASSWORD || 'postgres',
});

const DRY_RUN = process.argv.includes('--dry-run');

// ══════════════════════════════════════════════════════════════════════════════
// HTTP HEAD check — verify image URL exists before swapping
// ══════════════════════════════════════════════════════════════════════════════

function headCheck(url) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname,
      method: 'HEAD',
    }, (res) => {
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(5000, () => { req.destroy(); resolve(false); });
    req.end();
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// Main
// ══════════════════════════════════════════════════════════════════════════════

async function main() {
  console.log(`fix-ef-pc-cleanup.cjs — ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  console.log('═'.repeat(60));

  // Resolve vendors
  const efRes = await pool.query("SELECT id FROM vendors WHERE code = 'EF'");
  const pcRes = await pool.query("SELECT id FROM vendors WHERE code = 'PC'");
  if (!efRes.rows.length || !pcRes.rows.length) {
    console.error('Could not find EF and/or PC vendors');
    process.exit(1);
  }
  const efId = efRes.rows[0].id;
  const pcId = pcRes.rows[0].id;
  console.log(`EF vendor: ${efId}, PC vendor: ${pcId}`);

  // ══════════════════════════════════════════════════════════════════════════
  // Phase 1: Fix Plank Images — Replace PD_ swatches with T_ tile swatches
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(60));
  console.log('Phase 1: Fix Plank Images — Replace PD_ with T_ swatches');
  console.log('═'.repeat(60));

  // Find all SKU-level primary images with PD_ pattern (plank format, grey/colorless)
  const plankImgRes = await pool.query(`
    SELECT ma.id AS media_id, ma.url, s.id AS sku_id, s.vendor_sku, p.name AS product_name
    FROM media_assets ma
    JOIN skus s ON s.id = ma.sku_id
    JOIN products p ON p.id = s.product_id
    WHERE p.vendor_id IN ($1, $2)
      AND ma.asset_type = 'primary'
      AND ma.url LIKE '%PD_%_1.jpg'
  `, [efId, pcId]);

  console.log(`SKUs with PD_ primary images: ${plankImgRes.rows.length}`);

  // Group by tile URL to avoid redundant HEAD checks
  const pdToTile = {};
  for (const row of plankImgRes.rows) {
    const tileUrl = row.url.replace(/PD_/, 'T_');
    if (!pdToTile[tileUrl]) pdToTile[tileUrl] = [];
    pdToTile[tileUrl].push(row);
  }

  let imgFixed = 0, imgKept = 0;
  const tileEntries = Object.entries(pdToTile);
  console.log(`Unique tile URLs to HEAD-check: ${tileEntries.length}`);

  for (let i = 0; i < tileEntries.length; i++) {
    const [tileUrl, rows] = tileEntries[i];
    const exists = await headCheck(tileUrl);

    if (!exists) {
      imgKept += rows.length;
      continue;
    }

    for (const row of rows) {
      if (DRY_RUN) {
        console.log(`  [DRY] ${row.vendor_sku} (${row.product_name}): PD_ → T_`);
      } else {
        await pool.query('UPDATE media_assets SET url = $1 WHERE id = $2', [tileUrl, row.media_id]);
      }
      imgFixed++;
    }

    if ((i + 1) % 20 === 0) {
      console.log(`  ... checked ${i + 1}/${tileEntries.length}`);
    }
  }

  console.log(`\nPlank Image Summary:`);
  console.log(`  Replaced PD_ → T_: ${imgFixed}`);
  console.log(`  Kept (no tile alt): ${imgKept}`);

  // ══════════════════════════════════════════════════════════════════════════
  // Phase 2: Deactivate EF Cross-Vendor Duplicates
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(60));
  console.log('Phase 2: Deactivate EF Cross-Vendor Duplicates');
  console.log('═'.repeat(60));

  // Find active EF products whose name matches an active PC product
  const dupeRes = await pool.query(`
    SELECT e.id, e.name,
           (SELECT COUNT(*) FROM skus WHERE product_id = c.id) AS pc_skus,
           (SELECT COUNT(*) FROM media_assets WHERE product_id = c.id
              OR sku_id IN (SELECT id FROM skus WHERE product_id = c.id)) AS pc_media
    FROM products e
    JOIN products c ON e.name = c.name AND c.vendor_id = $2 AND c.status = 'active'
    WHERE e.vendor_id = $1 AND e.status = 'active'
  `, [efId, pcId]);

  console.log(`Cross-vendor duplicates found: ${dupeRes.rows.length}`);

  let deactivated = 0;
  for (const row of dupeRes.rows) {
    // Sanity check: only deactivate if the PC version actually has SKUs
    if (parseInt(row.pc_skus) === 0) {
      console.log(`  SKIP "${row.name}" — PC version has 0 SKUs`);
      continue;
    }
    if (DRY_RUN) {
      console.log(`  [DRY] Deactivate EF: "${row.name}" (PC has ${row.pc_skus} SKUs, ${row.pc_media} media)`);
    } else {
      await pool.query(
        "UPDATE products SET status = 'draft', updated_at = CURRENT_TIMESTAMP WHERE id = $1",
        [row.id]
      );
      console.log(`  Deactivated EF: "${row.name}"`);
    }
    deactivated++;
  }

  console.log(`Deactivated: ${deactivated}`);

  // ══════════════════════════════════════════════════════════════════════════
  // Phase 3: Delete Empty Draft Shells
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(60));
  console.log('Phase 3: Delete Empty EF Draft Shells');
  console.log('═'.repeat(60));

  // Find EF draft products with no SKUs at all
  const emptyRes = await pool.query(`
    SELECT p.id, p.name
    FROM products p
    WHERE p.vendor_id = $1
      AND p.status = 'draft'
      AND NOT EXISTS (SELECT 1 FROM skus WHERE product_id = p.id)
  `, [efId]);

  console.log(`Empty draft shells found: ${emptyRes.rows.length}`);

  if (emptyRes.rows.length > 0) {
    const ids = emptyRes.rows.map(r => r.id);

    if (DRY_RUN) {
      for (const row of emptyRes.rows.slice(0, 20)) {
        console.log(`  [DRY] Would delete: "${row.name}"`);
      }
      if (emptyRes.rows.length > 20) {
        console.log(`  ... and ${emptyRes.rows.length - 20} more`);
      }
    } else {
      // Delete media_assets first (FK constraint), then products
      const mediaDel = await pool.query('DELETE FROM media_assets WHERE product_id = ANY($1)', [ids]);
      console.log(`  Deleted ${mediaDel.rowCount} orphan media_assets`);

      const prodDel = await pool.query('DELETE FROM products WHERE id = ANY($1)', [ids]);
      console.log(`  Deleted ${prodDel.rowCount} empty draft products`);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Summary
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(60));
  console.log('SUMMARY');
  console.log('═'.repeat(60));
  console.log(`  Phase 1 — Plank images replaced: ${imgFixed}, kept: ${imgKept}`);
  console.log(`  Phase 2 — EF duplicates deactivated: ${deactivated}`);
  console.log(`  Phase 3 — Empty draft shells: ${emptyRes.rows.length}`);
  if (DRY_RUN) console.log('\n  *** DRY RUN — no changes written ***');
  console.log('═'.repeat(60));

  await pool.end();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
