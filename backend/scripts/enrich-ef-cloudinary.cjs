#!/usr/bin/env node
/**
 * enrich-ef-cloudinary.cjs
 *
 * Enriches Engineered Floors SKUs with images from the EF Cloudinary Search API.
 * Covers products/colors NOT in the CSV catalog (344 draft products, partial-color gaps).
 *
 * Cloudinary structure:
 *   Folder: "Hard Surface/American Standard_D2026/JPG Scans"  (swatches)
 *   Folder: "Hard Surface/American Standard_D2026/Room Scenes"
 *   Folder: "Pentz Commercial/Abstract_7915T/Room Scenes"
 *
 *   Filename: "D2026_6218_jpecpt" → style=D2026, color=6218
 *   Metadata: product_color = "6218 Venice" → colorCode=6218, colorName=Venice
 *   Metadata: image_type = "swatches" | "room_scenes" | "trend_boards"
 *
 * Matching: vendor_sku "1-D2026-6218-7X48-RF" → style=D2026, color=6218
 *   Exact match on style+colorCode (numeric, not fuzzy name matching).
 *
 * Usage:
 *   node backend/scripts/enrich-ef-cloudinary.cjs --dry-run
 *   node backend/scripts/enrich-ef-cloudinary.cjs
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
// When run inside the engfloors pipeline, ef-lifecycle.js is the single authority
// on activation. --no-activate skips Phase 3 so images-then-lifecycle don't flap.
const NO_ACTIVATE = process.argv.includes('--no-activate');

const CLOUDINARY_API_KEY = process.env.EF_CLOUDINARY_API_KEY;
const CLOUDINARY_API_SECRET = process.env.EF_CLOUDINARY_API_SECRET;
if (!CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
  console.error('EF_CLOUDINARY_API_KEY and EF_CLOUDINARY_API_SECRET must be set');
  process.exit(1);
}
const CLOUDINARY_CLOUD = 'engineeredfloors';
const SEARCH_URL = `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD}/resources/search`;
const AUTH = 'Basic ' + Buffer.from(`${CLOUDINARY_API_KEY}:${CLOUDINARY_API_SECRET}`).toString('base64');

// ══════════════════════════════════════════════════════════════════════════════
// Cloudinary API
// ══════════════════════════════════════════════════════════════════════════════

function cloudinarySearch(expression, cursor) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      expression,
      max_results: 100,
      with_field: 'metadata',
      ...(cursor ? { next_cursor: cursor } : {}),
    });

    const url = new URL(SEARCH_URL);
    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': AUTH,
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          return reject(new Error(`Cloudinary ${res.statusCode}: ${data.slice(0, 200)}`));
        }
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`Parse error: ${e.message}`)); }
      });
    });

    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Cloudinary timeout')); });
    req.write(body);
    req.end();
  });
}

async function paginateSearch(expression) {
  const all = [];
  let cursor = null;
  let page = 0;
  do {
    const resp = await cloudinarySearch(expression, cursor);
    all.push(...(resp.resources || []));
    cursor = resp.next_cursor || null;
    page++;
  } while (cursor);
  return all;
}

// ══════════════════════════════════════════════════════════════════════════════
// Parsing helpers
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Extract style code from folder name.
 * "Hard Surface/American Standard_D2026/JPG Scans" → "D2026"
 * "Carpet/Brazen I-II_6240/JPG Scans" → "6240"
 * "Pentz Commercial/Abstract_7915T" → "7915T"
 */
function extractStyleFromFolder(folder) {
  const m = folder.match(/_([A-Z0-9]+)(?:\/|$)/i);
  return m ? m[1] : null;
}

/**
 * Extract color code from product_color metadata.
 * "6218 Venice" → "6218"
 * "14701 Cactus Flower" → "14701"
 */
function extractColorCode(productColor) {
  if (!productColor) return null;
  const m = String(productColor).match(/^(\d+)/);
  return m ? m[1] : null;
}

/**
 * Extract color name from product_color metadata.
 * "6218 Venice" → "Venice"
 */
function extractColorName(productColor) {
  if (!productColor) return null;
  const m = String(productColor).match(/^\d+\s+(.+)/);
  return m ? m[1].trim() : null;
}

// ══════════════════════════════════════════════════════════════════════════════
// DB helpers
// ══════════════════════════════════════════════════════════════════════════════

async function upsertMediaAsset({ product_id, sku_id, asset_type, url, sort_order }) {
  if (url && url.startsWith('http://')) url = url.replace('http://', 'https://');
  const at = asset_type || 'primary';
  const so = sort_order || 0;

  if (sku_id) {
    await pool.query(`
      INSERT INTO media_assets (product_id, sku_id, asset_type, url, sort_order)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (product_id, sku_id, asset_type, sort_order) WHERE sku_id IS NOT NULL DO UPDATE SET
        url = EXCLUDED.url
      RETURNING id
    `, [product_id, sku_id, at, url, so]);
  } else {
    await pool.query(`
      INSERT INTO media_assets (product_id, sku_id, asset_type, url, sort_order)
      VALUES ($1, NULL, $2, $3, $4)
      ON CONFLICT (product_id, asset_type, sort_order) WHERE sku_id IS NULL DO UPDATE SET
        url = EXCLUDED.url
      RETURNING id
    `, [product_id, at, url, so]);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Main
// ══════════════════════════════════════════════════════════════════════════════

async function main() {
  console.log(`enrich-ef-cloudinary.cjs — ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  console.log('═'.repeat(60));

  // Resolve EF + Pentz vendors
  const efVendor = await pool.query("SELECT id FROM vendors WHERE code = 'EF'");
  const pcVendor = await pool.query("SELECT id FROM vendors WHERE code = 'PC'");
  if (!efVendor.rows.length) { console.error('EF vendor not found'); process.exit(1); }
  const efVendorId = efVendor.rows[0].id;
  const pcVendorId = pcVendor.rows.length ? pcVendor.rows[0].id : null;
  console.log(`EF vendor: ${efVendorId}`);
  if (pcVendorId) console.log(`PC vendor: ${pcVendorId}`);

  // ── Load DB SKUs indexed by style+color code ──
  const vendorIds = [efVendorId];
  if (pcVendorId) vendorIds.push(pcVendorId);

  const skusResult = await pool.query(`
    SELECT s.id, s.vendor_sku, s.variant_name, s.product_id, s.variant_type,
           p.name as product_name, p.vendor_id
    FROM skus s
    JOIN products p ON p.id = s.product_id
    WHERE p.vendor_id = ANY($1) AND s.status = 'active'
  `, [vendorIds]);

  // Build index: styleCode → colorCode → [skus]
  const skuIndex = {};
  for (const sku of skusResult.rows) {
    const parts = sku.vendor_sku.split('-');
    if (parts.length < 5) continue;
    const style = parts[1];
    const color = parts[2];
    if (!skuIndex[style]) skuIndex[style] = {};
    if (!skuIndex[style][color]) skuIndex[style][color] = [];
    skuIndex[style][color].push(sku);
  }
  console.log(`Loaded ${skusResult.rows.length} SKUs, ${Object.keys(skuIndex).length} styles\n`);

  // ── Check existing image coverage (to only fill gaps) ──
  const existingImages = await pool.query(`
    SELECT DISTINCT s.id as sku_id
    FROM media_assets ma
    JOIN skus s ON s.id = ma.sku_id
    JOIN products p ON p.id = s.product_id
    WHERE p.vendor_id = ANY($1) AND ma.asset_type = 'primary' AND ma.sku_id IS NOT NULL
  `, [vendorIds]);
  const skusWithImage = new Set(existingImages.rows.map(r => r.sku_id));
  console.log(`SKUs already with primary image: ${skusWithImage.size}`);

  // ── Fetch Cloudinary swatches ──
  console.log('\nFetching Cloudinary swatches...');
  const swatches = await paginateSearch('metadata.image_type=swatches');
  console.log(`Fetched ${swatches.length} swatch images`);

  // ── Fetch Cloudinary room scenes ──
  console.log('Fetching Cloudinary room scenes...');
  const roomScenes = await paginateSearch('metadata.image_type=room_scenes');
  console.log(`Fetched ${roomScenes.length} room scene images`);

  // ── Process swatches: assign to SKUs missing primary images ──
  console.log('\n' + '═'.repeat(60));
  console.log('Phase 1: Swatch → SKU Primary Image (gap-fill)');
  console.log('═'.repeat(60));

  let swatchAssigned = 0, swatchSkipped = 0, swatchNoMatch = 0;

  for (const img of swatches) {
    const folder = img.asset_folder || '';
    const meta = img.metadata || {};
    const productColor = meta.product_color || '';

    const style = extractStyleFromFolder(folder);
    const colorCode = extractColorCode(productColor);
    if (!style || !colorCode) { swatchNoMatch++; continue; }

    const matchedSkus = (skuIndex[style] || {})[colorCode] || [];
    if (matchedSkus.length === 0) { swatchNoMatch++; continue; }

    const url = img.secure_url || img.url || '';
    if (!url) continue;

    for (const sku of matchedSkus) {
      if (skusWithImage.has(sku.id)) { swatchSkipped++; continue; }

      if (DRY_RUN) {
        if (swatchAssigned < 15) {
          const colorName = extractColorName(productColor) || '';
          console.log(`  [DRY] ${sku.vendor_sku} (${sku.variant_name}) ← ${colorName}`);
        }
        swatchAssigned++;
        skusWithImage.add(sku.id); // mark as covered for dry-run counting
        continue;
      }

      await upsertMediaAsset({
        product_id: sku.product_id,
        sku_id: sku.id,
        asset_type: 'primary',
        url,
        sort_order: 0,
      });
      swatchAssigned++;
      skusWithImage.add(sku.id);
    }
  }

  console.log(`\n  Swatches assigned: ${swatchAssigned} (new)`);
  console.log(`  Swatches skipped:  ${swatchSkipped} (already had image)`);
  console.log(`  No DB match:       ${swatchNoMatch}`);

  // ── Process room scenes: assign to the specific COLOR they depict ──
  // Each room scene's product_color metadata names the exact color shown
  // ("3905 Eminent Oak"), so attach it to that color's SKU as a SKU-level
  // lifestyle image. The old behavior grouped scenes by style only and pooled
  // every color's scenes onto every product (sku_id NULL), so a shopper viewing
  // one color saw room shots of unrelated colors in the same gallery.
  //   - color matched to a stocked SKU  → SKU-level lifestyle (that color only)
  //   - no color in metadata (generic)  → product-level lifestyle fallback
  //   - color present but not stocked   → dropped (we don't sell it)
  console.log('\n' + '═'.repeat(60));
  console.log('Phase 2: Room Scenes → Color-Matched Lifestyle Images');
  console.log('═'.repeat(60));

  const scenesBySku = new Map();   // sku_id → { product_id, urls: [] }
  const genericByStyle = {};       // style  → [url]  (no color → product-level)
  let rsDropped = 0;               // color present but not stocked

  for (const img of roomScenes) {
    const folder = img.asset_folder || '';
    const style = extractStyleFromFolder(folder);
    if (!style || !skuIndex[style]) continue;
    const url = img.secure_url || img.url || '';
    if (!url) continue;

    const colorCode = extractColorCode((img.metadata || {}).product_color);
    if (!colorCode) {
      (genericByStyle[style] = genericByStyle[style] || []).push(url);
      continue;
    }
    const matchedSkus = (skuIndex[style] || {})[colorCode] || [];
    if (matchedSkus.length === 0) { rsDropped++; continue; }
    for (const sku of matchedSkus) {
      if (!scenesBySku.has(sku.id)) scenesBySku.set(sku.id, { product_id: sku.product_id, urls: [] });
      const bucket = scenesBySku.get(sku.id);
      if (!bucket.urls.includes(url)) bucket.urls.push(url);
    }
  }

  // Purge the old style-pooled product-level lifestyle rows for every product we
  // touch, so the previous contamination is cleared before we re-place scenes.
  const touchedProductIds = new Set();
  for (const v of scenesBySku.values()) touchedProductIds.add(v.product_id);
  for (const style of Object.keys(genericByStyle)) {
    for (const skus of Object.values(skuIndex[style] || {})) {
      for (const s of skus) touchedProductIds.add(s.product_id);
    }
  }
  if (!DRY_RUN && touchedProductIds.size) {
    await pool.query(
      `DELETE FROM media_assets WHERE sku_id IS NULL AND asset_type = 'lifestyle' AND product_id = ANY($1)`,
      [[...touchedProductIds]]
    );
  }

  let rsAssigned = 0, rsGeneric = 0;

  // Color-matched scenes → SKU-level lifestyle
  for (const [skuId, { product_id, urls }] of scenesBySku) {
    for (let i = 0; i < urls.length; i++) {
      if (DRY_RUN) { rsAssigned++; continue; }
      await upsertMediaAsset({
        product_id,
        sku_id: skuId,
        asset_type: 'lifestyle',
        url: urls[i],
        sort_order: i,
      });
      rsAssigned++;
    }
  }

  // Generic (no-color) scenes → product-level lifestyle across the style's products
  for (const [style, urls] of Object.entries(genericByStyle)) {
    const productIds = new Set();
    for (const skus of Object.values(skuIndex[style] || {})) {
      for (const sku of skus) productIds.add(sku.product_id);
    }
    for (const pid of productIds) {
      for (let i = 0; i < urls.length; i++) {
        if (DRY_RUN) { rsGeneric++; continue; }
        await upsertMediaAsset({
          product_id: pid,
          sku_id: null,
          asset_type: 'lifestyle',
          url: urls[i],
          sort_order: i,
        });
        rsGeneric++;
      }
    }
  }

  console.log(`\n  Color-matched scenes: ${rsAssigned} (SKU-level, ${scenesBySku.size} colors)`);
  console.log(`  Generic scenes:       ${rsGeneric} (product-level fallback)`);
  console.log(`  Dropped (unstocked):  ${rsDropped}`);

  // ── Activate drafts ──
  console.log('\n' + '═'.repeat(60));
  console.log('Phase 3: Activate Eligible Drafts');
  console.log('═'.repeat(60));

  if (NO_ACTIVATE) console.log('  Skipped (--no-activate; lifecycle step owns activation)');
  for (const vid of NO_ACTIVATE ? [] : vendorIds) {
    const vcode = vid === efVendorId ? 'EF' : 'PC';
    const beforeRes = await pool.query(
      'SELECT COUNT(*) FROM products WHERE vendor_id = $1 AND status = $2', [vid, 'draft']
    );
    const draftsBefore = parseInt(beforeRes.rows[0].count);
    if (draftsBefore === 0) { console.log(`  ${vcode}: no drafts`); continue; }

    const eligibleRes = await pool.query(`
      SELECT p.id, p.name FROM products p
      WHERE p.vendor_id = $1 AND p.status = 'draft'
        AND EXISTS (SELECT 1 FROM skus s JOIN pricing pr ON pr.sku_id = s.id WHERE s.product_id = p.id)
        AND (
          EXISTS (SELECT 1 FROM media_assets ma JOIN skus s ON s.id = ma.sku_id WHERE s.product_id = p.id AND ma.asset_type = 'primary')
          OR EXISTS (SELECT 1 FROM media_assets ma WHERE ma.product_id = p.id AND ma.asset_type IN ('primary','lifestyle'))
        )
    `, [vid]);

    console.log(`  ${vcode}: ${draftsBefore} drafts, ${eligibleRes.rows.length} eligible`);

    if (eligibleRes.rows.length > 0 && !DRY_RUN) {
      const ids = eligibleRes.rows.map(r => r.id);
      await pool.query('UPDATE products SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = ANY($2)', ['active', ids]);
      for (const id of ids) pool.query('SELECT refresh_search_vectors($1)', [id]).catch(() => {});
      console.log(`    Activated: ${ids.length}`);
    } else if (eligibleRes.rows.length > 0) {
      for (const r of eligibleRes.rows.slice(0, 10)) console.log(`    [DRY] Would activate: ${r.name}`);
      if (eligibleRes.rows.length > 10) console.log(`    ... and ${eligibleRes.rows.length - 10} more`);
    }
  }

  // ── Final coverage ──
  if (!DRY_RUN) {
    for (const vid of vendorIds) {
      const vcode = vid === efVendorId ? 'EF' : 'PC';
      const cov = await pool.query(`
        SELECT COUNT(DISTINCT s.id) as total,
          COUNT(DISTINCT CASE WHEN ma.id IS NOT NULL THEN s.id END) as with_img
        FROM skus s JOIN products p ON p.id=s.product_id
        LEFT JOIN media_assets ma ON ma.sku_id=s.id AND ma.asset_type='primary'
        WHERE p.vendor_id=$1 AND s.status='active'
      `, [vid]);
      const r = cov.rows[0];
      console.log(`\n  ${vcode} coverage: ${r.with_img}/${r.total} (${(100*r.with_img/r.total).toFixed(1)}%)`);
    }
  }

  console.log('\n' + '═'.repeat(60));
  console.log('DONE');
  if (DRY_RUN) console.log('  *** DRY RUN — no changes written ***');
  console.log('═'.repeat(60));

  await pool.end();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
