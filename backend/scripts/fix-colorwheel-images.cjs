#!/usr/bin/env node
/**
 * fix-colorwheel-images.cjs
 *
 * Assigns correct per-SKU product images for every Color Wheel SKU.
 *
 * Strategy:
 *   1. Build a colorCode → best swatch URL from EXISTING DB images
 *      (main tiles that already have validated color-specific Scene7 images)
 *   2. For main tile SKUs: try the per-SKU Coveo URL, validate, else use DB swatch
 *   3. For trim SKUs with generic silhouettes: replace with DB-proven color swatch
 *   4. For imageless SKUs: assign the DB-proven color swatch
 *
 * Usage:
 *   node backend/scripts/fix-colorwheel-images.cjs --dry-run
 *   node backend/scripts/fix-colorwheel-images.cjs
 */

const { Pool } = require('pg');
const https = require('https');
const fs = require('fs');
const path = require('path');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASS || 'postgres',
});

const DRY_RUN = process.argv.includes('--dry-run');

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Extract the Daltile color code from a vendor_sku.
 * Alpha-start: 1-4 alpha + 1-3 digits (e.g., K175, AM30)
 * Numeric-start: 4 digits (e.g., 0100, 1469)
 */
function extractColorCode(vendorSku) {
  if (!vendorSku) return null;
  const sku = vendorSku.toUpperCase().trim();
  const alphaMatch = sku.match(/^([A-Z]{1,4}\d{1,3})/);
  if (alphaMatch) return alphaMatch[1];
  const numMatch = sku.match(/^(\d{4})/);
  if (numMatch) return numMatch[1];
  return null;
}

/**
 * Is this a generic trim silhouette (not color-specific)?
 * Generic: A3361MOD, S4369MOD, SC3619TN, SCR3361M, etc.
 * Color-specific: DAL_0190_6x6_ArcticWhite_SGloss_Classic_swatch
 */
function isGenericTrimImage(url) {
  if (!url) return true;
  const filename = url.split('/').pop();
  return !filename.startsWith('DAL_');
}

function headCheck(url) {
  return new Promise(resolve => {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'http:' ? require('http') : https;
    const req = mod.request(url, { method: 'HEAD', timeout: 8000 }, res => {
      resolve(res.statusCode >= 200 && res.statusCode < 400);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

// ─── Load product map for per-SKU URLs ───────────────────────────────────────

function loadProductMap() {
  const mapPath = path.join(__dirname, '..', 'data', 'daltile-product-map.json');
  const map = JSON.parse(fs.readFileSync(mapPath, 'utf8'));

  const CW = ['Color Wheel Classic', 'Color Wheel Linear', 'Color Wheel Mosaic',
              'Color Wheel Retro', 'Color Wheel Splash'];

  // vendor_sku (upper) → { img, swatch, colorCode, isAccessory }
  const skuMap = new Map();

  for (const collName of CW) {
    const series = map.series[collName];
    if (!series) continue;

    for (const [colorName, colorData] of Object.entries(series.products || {})) {
      const cc = colorData.colorcode || '';
      for (const sku of (colorData.skus || [])) {
        const key = (sku.coveoSku || '').toUpperCase();
        if (!key) continue;
        skuMap.set(key, {
          img: sku.productImageUrl || '',
          swatch: sku.swatchUrl || '',
          colorCode: cc,
          isAccessory: false,
        });
      }
    }

    for (const [accName, accData] of Object.entries(series.accessories || {})) {
      const cc = accData.colorcode || '';
      for (const sku of (accData.skus || [])) {
        const key = (sku.coveoSku || '').toUpperCase();
        if (!key) continue;
        skuMap.set(key, {
          img: sku.productImageUrl || '',
          swatch: sku.swatchUrl || '',
          colorCode: cc,
          isAccessory: true,
        });
      }
    }
  }

  return skuMap;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`fix-colorwheel-images.cjs — ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  console.log('─'.repeat(60));

  const productMap = loadProductMap();
  console.log(`Product map: ${productMap.size} Color Wheel SKU entries`);

  const vendorRes = await pool.query("SELECT id FROM vendors WHERE code = 'DAL'");
  const vendorId = vendorRes.rows[0].id;

  // ── Step 1: Build colorCode → best swatch from EXISTING DB images ──────────
  // Find main tile SKUs that already have color-specific (DAL_) images
  const swatchRes = await pool.query(`
    SELECT s.vendor_sku, ma.url
    FROM skus s
    JOIN products p ON p.id = s.product_id
    JOIN media_assets ma ON ma.sku_id = s.id AND ma.asset_type = 'primary'
    WHERE p.vendor_id = $1 AND p.collection LIKE 'Color Wheel%'
      AND s.status = 'active'
      AND ma.url LIKE '%scene7%DAL_%'
    ORDER BY s.vendor_sku
  `, [vendorId]);

  // colorCode → { url, size } — prefer largest tile for best swatch representation
  const dbSwatches = new Map();
  for (const row of swatchRes.rows) {
    const cc = extractColorCode(row.vendor_sku);
    if (!cc) continue;

    // Extract size for priority: 6x6 > 4x4 > 3x6 > others
    const sizeMatch = row.url.match(/_(\d+)x(\d+)_/i);
    const area = sizeMatch ? parseInt(sizeMatch[1]) * parseInt(sizeMatch[2]) : 0;

    const existing = dbSwatches.get(cc);
    if (!existing || area > existing.area) {
      dbSwatches.set(cc, { url: row.url, area });
    }
  }

  console.log(`DB color swatches: ${dbSwatches.size} unique colors with proven images`);

  // ── Step 2: Load all Color Wheel SKUs ──────────────────────────────────────
  const allRes = await pool.query(`
    SELECT s.id, s.vendor_sku, s.variant_name, p.name, p.collection, p.id as product_id,
      ma.id as media_id, ma.url as current_url
    FROM skus s
    JOIN products p ON p.id = s.product_id
    LEFT JOIN media_assets ma ON ma.sku_id = s.id AND ma.asset_type = 'primary'
    WHERE p.vendor_id = $1 AND p.collection LIKE 'Color Wheel%' AND s.status = 'active'
    ORDER BY p.collection, s.vendor_sku
  `, [vendorId]);

  console.log(`DB: ${allRes.rows.length} Color Wheel SKUs total`);

  // ── Step 3: Determine what needs fixing ────────────────────────────────────
  const stats = {
    alreadyCorrect: 0,    // has color-specific image, matches best available
    genericToSwatch: 0,   // generic trim silhouette → color swatch
    missingToSwatch: 0,   // no image → color swatch
    perSkuUpgrade: 0,     // has image but wrong size → correct per-SKU image
    noFix: 0,             // can't fix (no color swatch available)
    updated: 0,
    inserted: 0,
  };

  // Collect assignments that need URL validation
  const needsValidation = [];
  // Collect assignments using DB-proven URLs (no validation needed)
  const provenAssignments = [];

  for (const row of allRes.rows) {
    const cc = extractColorCode(row.vendor_sku);
    const mapEntry = productMap.get(row.vendor_sku.toUpperCase());
    const dbSwatch = cc ? dbSwatches.get(cc) : null;
    const currentIsGeneric = isGenericTrimImage(row.current_url);
    const currentIsColorSpecific = row.current_url && !currentIsGeneric;

    // Case 1: Already has a color-specific image
    if (currentIsColorSpecific) {
      // Check if the product map has a DIFFERENT per-SKU image (size-specific)
      if (mapEntry && mapEntry.img && !isGenericTrimImage(mapEntry.img) && mapEntry.img !== row.current_url) {
        // Product map has a different color-specific URL — could be size-specific
        // Only try to upgrade if the URLs differ in the size portion
        needsValidation.push({
          row, newUrl: mapEntry.img, reason: 'per-sku-upgrade',
          fallback: row.current_url, // keep current if validation fails
        });
        stats.perSkuUpgrade++;
      } else {
        stats.alreadyCorrect++;
      }
      continue;
    }

    // Case 2: Has a generic trim silhouette → replace with color swatch
    if (row.current_url && currentIsGeneric) {
      if (dbSwatch) {
        provenAssignments.push({ row, newUrl: dbSwatch.url, action: 'update' });
        stats.genericToSwatch++;
      } else if (mapEntry && mapEntry.img && !isGenericTrimImage(mapEntry.img)) {
        needsValidation.push({ row, newUrl: mapEntry.img, reason: 'generic-to-coveo' });
        stats.genericToSwatch++;
      } else {
        stats.noFix++;
      }
      continue;
    }

    // Case 3: No image at all
    if (!row.current_url) {
      if (dbSwatch) {
        provenAssignments.push({ row, newUrl: dbSwatch.url, action: 'insert' });
        stats.missingToSwatch++;
      } else if (mapEntry && mapEntry.img) {
        needsValidation.push({ row, newUrl: mapEntry.img, reason: 'missing-to-coveo' });
        stats.missingToSwatch++;
      } else {
        stats.noFix++;
      }
      continue;
    }

    stats.alreadyCorrect++;
  }

  console.log(`\n── Analysis ──`);
  console.log(`Already correct (color-specific): ${stats.alreadyCorrect}`);
  console.log(`Generic silhouette → color swatch: ${stats.genericToSwatch}`);
  console.log(`Missing → color swatch: ${stats.missingToSwatch}`);
  console.log(`Per-SKU size upgrade candidates: ${stats.perSkuUpgrade}`);
  console.log(`No fix available: ${stats.noFix}`);
  console.log(`\nDB-proven assignments (no validation): ${provenAssignments.length}`);
  console.log(`Needs URL validation: ${needsValidation.length}`);

  // ── Step 4: Validate Coveo URLs ────────────────────────────────────────────
  console.log(`\nValidating ${needsValidation.length} image URLs...`);
  const BATCH = 30;
  const validatedAssignments = [];
  let okCount = 0, failCount = 0;

  for (let i = 0; i < needsValidation.length; i += BATCH) {
    const batch = needsValidation.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(async item => {
      const ok = await headCheck(item.newUrl);
      return { ...item, ok };
    }));

    for (const r of results) {
      if (r.ok) {
        validatedAssignments.push({
          row: r.row,
          newUrl: r.newUrl,
          action: r.row.media_id ? 'update' : 'insert',
        });
        okCount++;
      } else {
        failCount++;
        // For per-sku-upgrade failures, the current image stays (no action needed)
        // For others, try DB swatch fallback
        if (r.reason !== 'per-sku-upgrade') {
          const cc = extractColorCode(r.row.vendor_sku);
          const fallback = cc ? dbSwatches.get(cc) : null;
          if (fallback) {
            provenAssignments.push({
              row: r.row,
              newUrl: fallback.url,
              action: r.row.media_id ? 'update' : 'insert',
            });
          }
        }
      }
    }

    if ((i + BATCH) % 150 === 0 || i + BATCH >= needsValidation.length) {
      process.stdout.write(`  ${Math.min(i + BATCH, needsValidation.length)}/${needsValidation.length} — ${okCount} OK, ${failCount} failed\r`);
    }
  }
  console.log(`  Validation complete: ${okCount} OK, ${failCount} failed`);

  const allAssignments = [...provenAssignments, ...validatedAssignments];
  console.log(`\nTotal assignments to apply: ${allAssignments.length}`);

  if (DRY_RUN) {
    console.log('\nSample assignments (first 30):');
    for (const a of allAssignments.slice(0, 30)) {
      const oldShort = a.row.current_url ? a.row.current_url.split('/').pop().substring(0, 35) : 'NONE';
      const newShort = a.newUrl.split('/').pop().substring(0, 45);
      console.log(`  ${a.action.padEnd(6)} ${a.row.vendor_sku.padEnd(18)} ${oldShort.padEnd(37)} → ${newShort}`);
    }
  } else {
    // Apply
    let updated = 0, inserted = 0;

    for (const a of allAssignments) {
      if (a.action === 'update' && a.row.media_id) {
        await pool.query('UPDATE media_assets SET url = $1 WHERE id = $2', [a.newUrl, a.row.media_id]);
        updated++;
      } else {
        await pool.query(`
          INSERT INTO media_assets (product_id, sku_id, asset_type, url, sort_order, source)
          VALUES ($1, $2, 'primary', $3, 0, 'coveo-fix')
          ON CONFLICT (product_id, sku_id, asset_type, sort_order) WHERE sku_id IS NOT NULL
          DO UPDATE SET url = EXCLUDED.url
        `, [a.row.product_id, a.row.id, a.newUrl]);
        inserted++;
      }
    }

    console.log(`Applied: ${updated} updated, ${inserted} inserted`);
  }

  // ── Final coverage ─────────────────────────────────────────────────────────
  const finalRes = await pool.query(`
    SELECT p.collection,
      COUNT(*) as total,
      COUNT(ma.id) as with_img,
      COUNT(ma.id) FILTER (WHERE ma.url LIKE '%DAL_%') as color_specific,
      COUNT(ma.id) FILTER (WHERE ma.url NOT LIKE '%DAL_%') as generic
    FROM skus s
    JOIN products p ON p.id = s.product_id
    LEFT JOIN media_assets ma ON ma.sku_id = s.id AND ma.asset_type = 'primary'
    WHERE p.vendor_id = $1 AND p.collection LIKE 'Color Wheel%' AND s.status = 'active'
    GROUP BY p.collection
    ORDER BY p.collection
  `, [vendorId]);

  console.log(`\n${'─'.repeat(60)}`);
  console.log('Collection'.padEnd(25) + 'Total'.padStart(7) + 'Images'.padStart(8) + 'Color✓'.padStart(8) + 'Generic'.padStart(9));
  console.log('─'.repeat(57));
  for (const r of finalRes.rows) {
    console.log(
      r.collection.padEnd(25) +
      String(r.total).padStart(7) +
      String(r.with_img).padStart(8) +
      String(r.color_specific).padStart(8) +
      String(r.generic).padStart(9)
    );
  }

  console.log('\nDone!');
  await pool.end();
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
