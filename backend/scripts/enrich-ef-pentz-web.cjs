#!/usr/bin/env node
/**
 * enrich-ef-pentz-web.cjs
 *
 * Gap-fill script for EF-vendor SKUs whose style codes follow the Pentz
 * Commercial website image URL pattern but were NOT in the Pentz API export.
 *
 * These are primarily:
 *   - Broadloom styles ending in B (e.g. 3059B, 3033B)
 *   - Carpet tile styles ending in T (e.g. 7087T, 7033T)
 *   - P100x LVT styles
 *
 * Image URL pattern (same as Pentz API products):
 *   https://www.pentzcommercial.com/wp-content/uploads/products/{style}_{color}_1.jpg
 *
 * Also copies images from same-color size-variant siblings (e.g. DB variant
 * gets the image from the LV variant of the same style+color).
 *
 * Usage:
 *   node backend/scripts/enrich-ef-pentz-web.cjs --dry-run
 *   node backend/scripts/enrich-ef-pentz-web.cjs
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
const VENDOR_CODE = 'EF';
const IMAGE_BASE = 'https://www.pentzcommercial.com/wp-content/uploads/products/';

// ══════════════════════════════════════════════════════════════════════════════
// HTTP HEAD check — verify image exists before inserting
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
  console.log(`enrich-ef-pentz-web.cjs — ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  console.log('═'.repeat(60));

  // Resolve vendor
  const vendorResult = await pool.query('SELECT id FROM vendors WHERE code = $1', [VENDOR_CODE]);
  if (!vendorResult.rows.length) {
    console.error(`Vendor '${VENDOR_CODE}' not found`);
    process.exit(1);
  }
  const vendorId = vendorResult.rows[0].id;
  console.log(`Vendor: ${VENDOR_CODE} (${vendorId})`);

  // ── Load uncovered EF SKUs ──
  const uncoveredResult = await pool.query(`
    SELECT s.id, s.vendor_sku, s.variant_name, s.product_id, p.name as product_name
    FROM skus s
    JOIN products p ON p.id = s.product_id
    LEFT JOIN media_assets ma ON ma.sku_id = s.id AND ma.asset_type = 'primary'
    WHERE p.vendor_id = $1 AND s.status = 'active' AND ma.id IS NULL
  `, [vendorId]);
  console.log(`Uncovered EF SKUs: ${uncoveredResult.rows.length}`);

  // ── Phase 1: Pentz website URL images ──
  console.log('\n' + '═'.repeat(60));
  console.log('Phase 1: Pentz Website URL Images');
  console.log('═'.repeat(60));

  // Parse vendor_sku into parts
  const pentzWebCandidates = [];
  for (const sku of uncoveredResult.rows) {
    const parts = sku.vendor_sku.split('-');
    if (parts.length < 4) continue;
    const style = parts[1];
    const color = parts[2];
    // Only B-suffix, T-suffix, and P100x styles
    if (style.match(/[BT]$/) || style.match(/^P100/)) {
      pentzWebCandidates.push({ ...sku, style, color });
    }
  }
  console.log(`Pentz web candidates: ${pentzWebCandidates.length} SKUs`);

  // Deduplicate by style_color for HEAD checks (many SKUs share the same swatch)
  const pairMap = {};
  for (const c of pentzWebCandidates) {
    const key = `${c.style}_${c.color}`;
    if (!pairMap[key]) pairMap[key] = [];
    pairMap[key].push(c);
  }
  console.log(`Unique style_color pairs to check: ${Object.keys(pairMap).length}`);

  let webHits = 0, webMisses = 0, webImagesCreated = 0;
  const checkedPairs = {};

  // Check each pair with HEAD request, then assign to all SKUs
  const pairs = Object.entries(pairMap);
  for (let i = 0; i < pairs.length; i++) {
    const [pairKey, skus] = pairs[i];
    const url = `${IMAGE_BASE}${pairKey}_1.jpg`;

    const exists = await headCheck(url);
    checkedPairs[pairKey] = exists;

    if (!exists) {
      webMisses++;
      continue;
    }
    webHits++;

    if (DRY_RUN) {
      if (webHits <= 10) {
        console.log(`  [DRY] ${pairKey} → ${skus.length} SKU(s)`);
      }
      continue;
    }

    for (const sku of skus) {
      await upsertMediaAsset({
        product_id: sku.product_id,
        sku_id: sku.id,
        asset_type: 'primary',
        url,
        sort_order: 0,
      });
      webImagesCreated++;
    }

    // Progress log every 50 pairs
    if ((i + 1) % 50 === 0) {
      console.log(`  ... checked ${i + 1}/${pairs.length} pairs`);
    }
  }

  const webSkusCovered = Object.entries(pairMap)
    .filter(([k]) => checkedPairs[k])
    .reduce((sum, [, skus]) => sum + skus.length, 0);

  console.log(`\nPentz Web Summary:`);
  console.log(`  Pairs checked: ${Object.keys(pairMap).length}`);
  console.log(`  Pairs with image: ${webHits}`);
  console.log(`  Pairs without: ${webMisses}`);
  console.log(`  SKUs covered: ${webSkusCovered}`);
  if (!DRY_RUN) console.log(`  Images inserted: ${webImagesCreated}`);

  // ── Phase 2: Same-color sibling copy ──
  console.log('\n' + '═'.repeat(60));
  console.log('Phase 2: Same-Color Sibling Copy');
  console.log('═'.repeat(60));

  // Reload uncovered after Phase 1 (or use original list in dry-run)
  const stillUncoveredResult = DRY_RUN ? uncoveredResult : await pool.query(`
    SELECT s.id, s.vendor_sku, s.variant_name, s.product_id, p.name as product_name
    FROM skus s
    JOIN products p ON p.id = s.product_id
    LEFT JOIN media_assets ma ON ma.sku_id = s.id AND ma.asset_type = 'primary'
    WHERE p.vendor_id = $1 AND s.status = 'active' AND ma.id IS NULL
  `, [vendorId]);

  // Find uncovered SKUs that have a same-color sibling WITH an image
  // Same color = same style_code + color_code in vendor_sku, different size/suffix
  let siblingCopied = 0;
  for (const sku of stillUncoveredResult.rows) {
    const parts = sku.vendor_sku.split('-');
    if (parts.length < 4) continue;
    const style = parts[1];
    const color = parts[2];

    // Find sibling with same style+color that HAS a primary image
    const sibResult = await pool.query(`
      SELECT ma.url
      FROM skus s
      JOIN products p ON p.id = s.product_id
      JOIN media_assets ma ON ma.sku_id = s.id AND ma.asset_type = 'primary'
      WHERE p.vendor_id = $1 AND s.status = 'active'
        AND s.id != $2
        AND s.vendor_sku LIKE $3
      LIMIT 1
    `, [vendorId, sku.id, `1-${style}-${color}-%`]);

    if (!sibResult.rows.length) continue;

    if (DRY_RUN) {
      if (siblingCopied < 10) {
        console.log(`  [DRY] ${sku.vendor_sku} ← sibling image`);
      }
      siblingCopied++;
      continue;
    }

    await upsertMediaAsset({
      product_id: sku.product_id,
      sku_id: sku.id,
      asset_type: 'primary',
      url: sibResult.rows[0].url,
      sort_order: 0,
    });
    siblingCopied++;
  }

  console.log(`Sibling copies: ${siblingCopied}`);

  // ── Phase 3: Activate drafts ──
  console.log('\n' + '═'.repeat(60));
  console.log('Phase 3: Activate Draft Products');
  console.log('═'.repeat(60));

  const draftRes = await pool.query(`
    SELECT COUNT(*) FROM products
    WHERE vendor_id = $1 AND status = 'draft'
  `, [vendorId]);
  const draftsBefore = parseInt(draftRes.rows[0].count);
  console.log(`Draft products: ${draftsBefore}`);

  if (draftsBefore > 0) {
    const eligibleRes = await pool.query(`
      SELECT p.id, p.name
      FROM products p
      WHERE p.vendor_id = $1
        AND p.status = 'draft'
        AND EXISTS (
          SELECT 1 FROM skus s
          JOIN pricing pr ON pr.sku_id = s.id
          WHERE s.product_id = p.id
        )
        AND (
          EXISTS (SELECT 1 FROM media_assets ma JOIN skus s ON s.id = ma.sku_id WHERE s.product_id = p.id AND ma.asset_type = 'primary')
          OR EXISTS (SELECT 1 FROM media_assets ma WHERE ma.product_id = p.id AND ma.asset_type IN ('primary', 'lifestyle'))
        )
        AND NOT EXISTS (
          SELECT 1 FROM products p2
          WHERE p2.name = p.name
            AND p2.vendor_id = (SELECT id FROM vendors WHERE code = 'PC')
            AND p2.status = 'active'
        )
    `, [vendorId]);

    console.log(`Eligible for activation: ${eligibleRes.rows.length}`);

    if (eligibleRes.rows.length > 0) {
      if (DRY_RUN) {
        for (const row of eligibleRes.rows) {
          console.log(`  [DRY] Would activate: ${row.name}`);
        }
      } else {
        const ids = eligibleRes.rows.map(r => r.id);
        await pool.query(`
          UPDATE products SET status = 'active', updated_at = CURRENT_TIMESTAMP
          WHERE id = ANY($1)
        `, [ids]);
        for (const id of ids) {
          pool.query('SELECT refresh_search_vectors($1)', [id]).catch(() => {});
        }
        console.log(`Activated: ${eligibleRes.rows.length} products`);
      }
    }

    const afterRes = await pool.query(`
      SELECT COUNT(*) FROM products WHERE vendor_id = $1 AND status = 'draft'
    `, [vendorId]);
    console.log(`Drafts remaining: ${afterRes.rows[0].count}`);
  }

  // ── Final coverage ──
  const coverage = await pool.query(`
    SELECT
      COUNT(DISTINCT s.id) as total,
      COUNT(DISTINCT CASE WHEN ma.id IS NOT NULL THEN s.id END) as with_img
    FROM skus s
    JOIN products p ON p.id = s.product_id
    LEFT JOIN media_assets ma ON ma.sku_id = s.id AND ma.asset_type = 'primary'
    WHERE p.vendor_id = $1 AND s.status = 'active'
  `, [vendorId]);
  const r = coverage.rows[0];
  console.log(`\nFinal EF coverage: ${r.with_img}/${r.total} SKUs with primary image (${(100 * r.with_img / r.total).toFixed(1)}%)`);

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
