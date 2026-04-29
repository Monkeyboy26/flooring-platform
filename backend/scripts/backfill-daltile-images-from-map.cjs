#!/usr/bin/env node
/**
 * Backfill Daltile per-SKU images from the product map JSON.
 *
 * Reads daltile-product-map.json (built from Coveo) and inserts missing
 * primary/swatch/lifestyle images for SKUs that lack them, matching by
 * vendor_sku = coveoSku.
 *
 * Usage:
 *   node backend/scripts/backfill-daltile-images-from-map.cjs --dry-run
 *   node backend/scripts/backfill-daltile-images-from-map.cjs
 */
const { Pool } = require('pg');
const path = require('path');

const pool = new Pool({
  host: process.env.DB_HOST || process.env.PGHOST || 'localhost',
  port: parseInt(process.env.DB_PORT || process.env.PGPORT || '5432'),
  database: process.env.DB_NAME || process.env.PGDATABASE || 'flooring_pim',
  user: process.env.DB_USER || process.env.PGUSER || 'postgres',
  password: process.env.DB_PASSWORD || process.env.PGPASSWORD || 'postgres',
});

const DRY_RUN = process.argv.includes('--dry-run');

function cleanScene7Url(url) {
  if (!url) return null;
  let clean = url.split('?')[0];
  // For AEM DAM URLs, upgrade tiny renditions to full-quality "original"
  if (clean.includes('/jcr:content/renditions/')) {
    clean = clean.replace(/\/jcr:content\/renditions\/.*$/, '/jcr:content/renditions/original');
  }
  return clean;
}

// Skip tiny DAM thumbnails and known placeholder images
const SKIP_PATTERNS = [
  'cq5dam.web.170',
  'No-Series-Image-Available',
  'No-Image-Available',
  'placeholder',
];

function isValidImageUrl(url) {
  if (!url) return false;
  return !SKIP_PATTERNS.some(p => url.includes(p));
}

async function main() {
  console.log(`\nDaltile Image Backfill from Product Map${DRY_RUN ? ' (DRY RUN)' : ''}\n`);

  // 1. Load product map and build coveoSku → images lookup
  const mapPath = path.join(__dirname, '..', 'data', 'daltile-product-map.json');
  const productMap = require(mapPath);
  console.log(`Product map: ${productMap.summary.skus} SKUs, ${productMap.summary.accessories} accessories`);

  const skuImageMap = new Map(); // coveoSku → { primary, swatch, lifestyle }
  for (const [seriesName, series] of Object.entries(productMap.series)) {
    for (const [colorName, product] of Object.entries(series.products || {})) {
      for (const sku of product.skus || []) {
        if (!sku.coveoSku) continue;
        const primary = cleanScene7Url(sku.productImageUrl);
        const swatch = cleanScene7Url(sku.swatchUrl);
        const lifestyle = cleanScene7Url(sku.roomSceneUrl);
        skuImageMap.set(sku.coveoSku, {
          primary: isValidImageUrl(primary) ? primary : null,
          swatch: isValidImageUrl(swatch) ? swatch : null,
          lifestyle: isValidImageUrl(lifestyle) ? lifestyle : null,
        });
      }
    }
    for (const [accName, acc] of Object.entries(series.accessories || {})) {
      for (const sku of acc.skus || []) {
        if (!sku.coveoSku) continue;
        const primary = cleanScene7Url(sku.productImageUrl);
        const swatch = cleanScene7Url(sku.swatchUrl);
        const lifestyle = cleanScene7Url(sku.roomSceneUrl);
        skuImageMap.set(sku.coveoSku, {
          primary: isValidImageUrl(primary) ? primary : null,
          swatch: isValidImageUrl(swatch) ? swatch : null,
          lifestyle: isValidImageUrl(lifestyle) ? lifestyle : null,
        });
      }
    }
  }
  console.log(`Image lookup built: ${skuImageMap.size} SKUs with URLs\n`);

  // 2. Find all Daltile SKUs missing primary images
  const missingRes = await pool.query(`
    SELECT s.id AS sku_id, s.vendor_sku, s.product_id, p.name AS product_name
    FROM skus s
    JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id
    LEFT JOIN media_assets m ON m.sku_id = s.id AND m.asset_type = 'primary'
    WHERE v.code = 'DAL' AND s.status = 'active' AND p.status = 'active'
      AND m.id IS NULL
    ORDER BY p.collection, p.name, s.vendor_sku
  `);
  console.log(`SKUs missing primary image: ${missingRes.rows.length}`);

  // 3. Also find SKUs missing swatch images
  const missingSwatchRes = await pool.query(`
    SELECT s.id AS sku_id, s.vendor_sku, s.product_id
    FROM skus s
    JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id
    LEFT JOIN media_assets m ON m.sku_id = s.id AND m.asset_type = 'swatch'
    WHERE v.code = 'DAL' AND s.status = 'active' AND p.status = 'active'
      AND m.id IS NULL
  `);
  const missingSwatchSet = new Set(missingSwatchRes.rows.map(r => r.vendor_sku));

  // 4. Find SKUs missing lifestyle images
  const missingLifestyleRes = await pool.query(`
    SELECT s.id AS sku_id, s.vendor_sku, s.product_id
    FROM skus s
    JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id
    LEFT JOIN media_assets m ON m.sku_id = s.id AND m.asset_type = 'lifestyle'
    WHERE v.code = 'DAL' AND s.status = 'active' AND p.status = 'active'
      AND m.id IS NULL
  `);
  const missingLifestyleSet = new Set(missingLifestyleRes.rows.map(r => r.vendor_sku));

  console.log(`SKUs missing swatch: ${missingSwatchSet.size}`);
  console.log(`SKUs missing lifestyle: ${missingLifestyleSet.size}\n`);

  let stats = { primarySet: 0, swatchSet: 0, lifestyleSet: 0, noMapMatch: 0, noUrl: 0 };

  // Build sku_id lookup for swatch/lifestyle inserts
  const skuIdByVendorSku = new Map();
  for (const row of [...missingSwatchRes.rows, ...missingLifestyleRes.rows]) {
    skuIdByVendorSku.set(row.vendor_sku, row.sku_id);
  }

  // 5. Process missing primary images
  for (const row of missingRes.rows) {
    const images = skuImageMap.get(row.vendor_sku);
    if (!images) {
      stats.noMapMatch++;
      if (DRY_RUN) console.log(`  NO MAP MATCH: ${row.vendor_sku} (${row.product_name})`);
      continue;
    }

    // Primary image
    if (images.primary) {
      if (DRY_RUN) {
        console.log(`  PRIMARY: ${row.vendor_sku} → ${images.primary.split('/').pop()}`);
      } else {
        await pool.query(`
          INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order, source)
          VALUES ($1, $2, 'primary', $3, $3, 0, 'product-map-backfill')
          ON CONFLICT (product_id, sku_id, asset_type, sort_order) WHERE sku_id IS NOT NULL
          DO UPDATE SET url = EXCLUDED.url, original_url = EXCLUDED.original_url, source = EXCLUDED.source
        `, [row.product_id, row.sku_id, images.primary]);
      }
      stats.primarySet++;
    } else {
      stats.noUrl++;
    }

    // Also set swatch and lifestyle if missing
    skuIdByVendorSku.set(row.vendor_sku, row.sku_id);
  }

  // 6. Process missing swatch images
  for (const row of missingSwatchRes.rows) {
    const images = skuImageMap.get(row.vendor_sku);
    if (!images || !images.swatch) continue;

    if (!DRY_RUN) {
      await pool.query(`
        INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order, source)
        VALUES ($1, $2, 'swatch', $3, $3, 0, 'product-map-backfill')
        ON CONFLICT (product_id, sku_id, asset_type, sort_order) WHERE sku_id IS NOT NULL
          DO UPDATE SET url = EXCLUDED.url, original_url = EXCLUDED.original_url, source = EXCLUDED.source
      `, [row.product_id, row.sku_id, images.swatch]);
    }
    stats.swatchSet++;
  }

  // 7. Process missing lifestyle images
  for (const row of missingLifestyleRes.rows) {
    const images = skuImageMap.get(row.vendor_sku);
    if (!images || !images.lifestyle) continue;

    if (!DRY_RUN) {
      await pool.query(`
        INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order, source)
        VALUES ($1, $2, 'lifestyle', $3, $3, 0, 'product-map-backfill')
        ON CONFLICT (product_id, sku_id, asset_type, sort_order) WHERE sku_id IS NOT NULL
          DO UPDATE SET url = EXCLUDED.url, original_url = EXCLUDED.original_url, source = EXCLUDED.source
      `, [row.product_id, row.sku_id, images.lifestyle]);
    }
    stats.lifestyleSet++;
  }

  // 8. Final coverage check
  const coverage = await pool.query(`
    SELECT COUNT(DISTINCT s.id) AS total,
      COUNT(DISTINCT CASE WHEN m.id IS NOT NULL THEN s.id END) AS has_image
    FROM skus s
    JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id
    LEFT JOIN media_assets m ON (m.sku_id = s.id OR m.product_id = p.id) AND m.asset_type IN ('primary','alternate','lifestyle')
    WHERE v.code = 'DAL' AND s.status = 'active' AND p.status = 'active'
  `);
  const { total, has_image } = coverage.rows[0];
  const pct = total > 0 ? ((has_image / total) * 100).toFixed(1) : '0';

  console.log('\n=== Summary ===');
  console.log(`Primary images added: ${stats.primarySet}`);
  console.log(`Swatch images added: ${stats.swatchSet}`);
  console.log(`Lifestyle images added: ${stats.lifestyleSet}`);
  console.log(`No map match: ${stats.noMapMatch}`);
  console.log(`Map match but no URL: ${stats.noUrl}`);
  console.log(`\nImage coverage: ${has_image}/${total} (${pct}%)`);

  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
