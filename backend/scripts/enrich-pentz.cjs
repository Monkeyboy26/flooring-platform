#!/usr/bin/env node
/**
 * enrich-pentz.cjs
 *
 * Enriches Pentz Commercial SKUs with images + attributes from the Pentz product API.
 *
 * API: POST https://www.pentzcommercial.com/product-api/export
 *      Body: apikey=<key>
 *      Returns: array of product objects with fcb2b (vendor_sku), image_path,
 *               jj_style_tile_variance, backing, fiber, install_methods, etc.
 *
 * Image convention:
 *   image_path = "https://…/products/7915T_3462_"
 *   jj_style_tile_variance = 4
 *   → images: 7915T_3462_1.jpg … 7915T_3462_4.jpg
 *   First image (_1.jpg) = primary swatch, rest = alternates
 *
 * Usage:
 *   node backend/scripts/enrich-pentz.cjs --dry-run
 *   node backend/scripts/enrich-pentz.cjs
 */

const { Pool } = require('pg');
const https = require('https');
const http = require('http');

const pool = new Pool({
  host: process.env.DB_HOST || process.env.PGHOST || 'localhost',
  port: process.env.DB_PORT || process.env.PGPORT || 5432,
  database: process.env.DB_NAME || process.env.PGDATABASE || 'flooring_pim',
  user: process.env.DB_USER || process.env.PGUSER || 'postgres',
  password: process.env.DB_PASS || process.env.PGPASSWORD || 'postgres',
});

const DRY_RUN = process.argv.includes('--dry-run');
const VENDOR_CODE = 'PC';
const API_URL = 'https://www.pentzcommercial.com/product-api/export';
const API_KEY = 'r6@Tl!f7ApXMW#aN';

// ══════════════════════════════════════════════════════════════════════════════
// API fetch
// ══════════════════════════════════════════════════════════════════════════════

function fetchPentzAPI() {
  return new Promise((resolve, reject) => {
    const body = `apikey=${encodeURIComponent(API_KEY)}`;
    const url = new URL(API_URL);

    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          return reject(new Error(`API returned ${res.statusCode}: ${data.slice(0, 200)}`));
        }
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Failed to parse API response: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(90000, () => { req.destroy(); reject(new Error('API timeout')); });
    req.write(body);
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

async function setAttr(sku_id, slug, value) {
  if (!value || !String(value).trim()) return false;
  const attr = await pool.query('SELECT id FROM attributes WHERE slug = $1', [slug]);
  if (!attr.rows.length) return false;
  await pool.query(`
    INSERT INTO sku_attributes (sku_id, attribute_id, value)
    VALUES ($1, $2, $3)
    ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value = EXCLUDED.value
  `, [sku_id, attr.rows[0].id, String(value).trim()]);
  return true;
}

// ══════════════════════════════════════════════════════════════════════════════
// Main
// ══════════════════════════════════════════════════════════════════════════════

async function main() {
  console.log(`enrich-pentz.cjs — ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  console.log('═'.repeat(60));

  // Resolve vendor
  const vendorResult = await pool.query('SELECT id FROM vendors WHERE code = $1', [VENDOR_CODE]);
  if (!vendorResult.rows.length) {
    console.error(`Vendor '${VENDOR_CODE}' not found`);
    process.exit(1);
  }
  const vendorId = vendorResult.rows[0].id;
  console.log(`Vendor: ${VENDOR_CODE} (${vendorId})`);

  // ── Fetch API ──
  console.log('\nFetching Pentz product API...');
  const apiProducts = await fetchPentzAPI();
  console.log(`API returned ${apiProducts.length} products`);

  // Build API lookup by fcb2b (vendor_sku)
  const apiByVsku = {};
  for (const p of apiProducts) {
    if (p.fcb2b) apiByVsku[p.fcb2b] = p;
  }
  console.log(`Unique fcb2b values: ${Object.keys(apiByVsku).length}`);

  // ── Load DB SKUs ──
  const skusResult = await pool.query(`
    SELECT s.id, s.vendor_sku, s.variant_name, s.product_id, p.name as product_name
    FROM skus s
    JOIN products p ON p.id = s.product_id
    WHERE p.vendor_id = $1 AND s.status = 'active'
  `, [vendorId]);
  console.log(`DB SKUs: ${skusResult.rows.length}`);

  // Pre-cache attribute slugs
  const attrResult = await pool.query('SELECT id, slug FROM attributes');
  const attrExists = new Set(attrResult.rows.map(r => r.slug));

  // ── Clear stale SKU-level images ──
  if (!DRY_RUN) {
    const cleared = await pool.query(`
      DELETE FROM media_assets ma
      USING skus s, products p
      WHERE ma.sku_id = s.id
        AND s.product_id = p.id
        AND p.vendor_id = $1
        AND ma.asset_type IN ('primary', 'alternate')
        AND ma.sku_id IS NOT NULL
    `, [vendorId]);
    console.log(`Cleared ${cleared.rowCount} stale SKU-level images`);
  }

  // ── Match & enrich ──
  let matched = 0, unmatched = 0;
  let imagesCreated = 0, attrsSet = 0;
  const enrichedProducts = new Set(); // track product_ids that got images

  for (const sku of skusResult.rows) {
    const apiProduct = apiByVsku[sku.vendor_sku];
    if (!apiProduct) {
      unmatched++;
      continue;
    }
    matched++;

    const imagePath = apiProduct.image_path;
    const variance = parseInt(apiProduct.jj_style_tile_variance) || 1;

    if (DRY_RUN) {
      if (matched <= 10) {
        console.log(`  [DRY] ${sku.vendor_sku} (${sku.variant_name}) → ${variance} image(s)`);
      }
      enrichedProducts.add(sku.product_id);
      continue;
    }

    // Assign images: _1.jpg = primary, _2.jpg+ = alternate
    for (let i = 1; i <= variance; i++) {
      const url = `${imagePath}${i}.jpg`;
      await upsertMediaAsset({
        product_id: sku.product_id,
        sku_id: sku.id,
        asset_type: i === 1 ? 'primary' : 'alternate',
        url,
        sort_order: i - 1,
      });
      imagesCreated++;
    }
    enrichedProducts.add(sku.product_id);

    // Attributes
    if (apiProduct.backing && attrExists.has('material')) {
      if (await setAttr(sku.id, 'material', apiProduct.backing)) attrsSet++;
    }
    if (apiProduct.fiber && attrExists.has('fiber_brand')) {
      if (await setAttr(sku.id, 'fiber_brand', apiProduct.fiber)) attrsSet++;
    }
    if (apiProduct.install_methods && attrExists.has('installation_method')) {
      if (await setAttr(sku.id, 'installation_method', apiProduct.install_methods)) attrsSet++;
    }
    if (apiProduct.color && attrExists.has('color')) {
      if (await setAttr(sku.id, 'color', apiProduct.color)) attrsSet++;
    }
  }

  console.log(`\nMatching Summary:`);
  console.log(`  Matched:   ${matched}`);
  console.log(`  Unmatched: ${unmatched}`);
  console.log(`  Images:    ${imagesCreated}`);
  console.log(`  Attrs:     ${attrsSet}`);

  // ── Activate drafts ──
  console.log('\n' + '═'.repeat(60));
  console.log('Activate Draft Products');
  console.log('═'.repeat(60));

  const beforeRes = await pool.query(`
    SELECT COUNT(*) FROM products
    WHERE vendor_id = $1 AND status = 'draft'
  `, [vendorId]);
  const draftsBefore = parseInt(beforeRes.rows[0].count);
  console.log(`Draft products before: ${draftsBefore}`);

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

  // ── Final stats ──
  if (!DRY_RUN) {
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
    console.log(`\nFinal coverage: ${r.with_img}/${r.total} SKUs with primary image (${(100*r.with_img/r.total).toFixed(1)}%)`);
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
