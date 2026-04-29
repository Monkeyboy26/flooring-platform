#!/usr/bin/env node
/**
 * Emser Tile — Redistribute Product-Level Images to SKU Level
 *
 * Problem: The catalog scraper stored lifestyle/room-scene images at product level
 * (sku_id IS NULL), so ALL color variants share the same secondary photos.
 * Emser's API returns images per-SKU — each image belongs to a specific SKU.
 *
 * Strategy:
 *   1. Match by vendor_sku code in the filename (most reliable — e.g. j01bconsi1224)
 *   2. Fall back to color name matching in filename
 *   3. No match → keep at product level
 *   4. Delete redundant product-level primaries where SKU-level primaries exist
 *   5. Skip spec_pdf (always shared)
 *
 * Usage: docker compose exec api node scripts/emser-redistribute-images.js [--dry-run]
 */
import pg from 'pg';

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: 5432, database: 'flooring_pim', user: 'postgres', password: 'postgres',
});

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  console.log(`=== Emser Image Redistribution ===${DRY_RUN ? ' [DRY RUN]' : ''}\n`);

  const vendorRes = await pool.query("SELECT id FROM vendors WHERE code = 'EMSER'");
  if (!vendorRes.rows.length) { console.error('Vendor EMSER not found'); process.exit(1); }
  const vendorId = vendorRes.rows[0].id;

  // Get all Emser SKUs with vendor_sku and color
  const skuRes = await pool.query(`
    SELECT s.id as sku_id, s.product_id, lower(s.vendor_sku) as vsku, s.variant_name,
      (SELECT sa.value FROM sku_attributes sa JOIN attributes a ON a.id = sa.attribute_id
       WHERE sa.sku_id = s.id AND a.slug = 'color' LIMIT 1) as color
    FROM skus s
    JOIN products p ON p.id = s.product_id
    WHERE p.vendor_id = $1 AND (s.variant_type IS NULL OR s.variant_type != 'accessory')
  `, [vendorId]);

  // Build lookup: product_id → [{sku_id, vsku, color}]
  const skusByProduct = new Map();
  for (const row of skuRes.rows) {
    if (!skusByProduct.has(row.product_id)) skusByProduct.set(row.product_id, []);
    skusByProduct.get(row.product_id).push(row);
  }
  console.log(`Loaded ${skuRes.rows.length} SKUs across ${skusByProduct.size} products`);

  // Get all product-level images (excluding spec_pdf)
  const images = await pool.query(`
    SELECT ma.id, ma.product_id, ma.asset_type, ma.url, ma.sort_order
    FROM media_assets ma
    JOIN products p ON p.id = ma.product_id
    WHERE p.vendor_id = $1 AND ma.sku_id IS NULL AND ma.asset_type != 'spec_pdf'
    ORDER BY ma.product_id, ma.sort_order
  `, [vendorId]);

  const imagesByProduct = new Map();
  for (const img of images.rows) {
    if (!imagesByProduct.has(img.product_id)) imagesByProduct.set(img.product_id, []);
    imagesByProduct.get(img.product_id).push(img);
  }
  console.log(`Found ${images.rows.length} product-level images across ${imagesByProduct.size} products`);

  // Check which products have SKU-level primaries
  const skuPrimaryRes = await pool.query(`
    SELECT DISTINCT ma.product_id
    FROM media_assets ma
    JOIN products p ON p.id = ma.product_id
    WHERE p.vendor_id = $1 AND ma.sku_id IS NOT NULL AND ma.asset_type = 'primary'
  `, [vendorId]);
  const hasSkuPrimaries = new Set(skuPrimaryRes.rows.map(r => r.product_id));

  // Track existing SKU-level URLs
  const existingRes = await pool.query(`
    SELECT ma.sku_id, ma.url
    FROM media_assets ma
    JOIN products p ON p.id = ma.product_id
    WHERE p.vendor_id = $1 AND ma.sku_id IS NOT NULL
  `, [vendorId]);
  const existingSkuUrls = new Set();
  for (const r of existingRes.rows) existingSkuUrls.add(`${r.sku_id}:${r.url}`);

  let stats = { processed: 0, skuMatched: 0, colorMatched: 0, kept: 0, deleted: 0, deduped: 0, inserted: 0 };

  for (const [productId, prodImages] of imagesByProduct) {
    const skus = skusByProduct.get(productId);
    if (!skus || skus.length === 0) continue;

    const seenUrls = new Set();

    for (const img of prodImages) {
      // Deduplicate
      if (seenUrls.has(img.url)) {
        if (!DRY_RUN) await pool.query('DELETE FROM media_assets WHERE id = $1', [img.id]);
        stats.deduped++;
        continue;
      }
      seenUrls.add(img.url);

      // Delete redundant product-level primaries
      if (img.asset_type === 'primary' && hasSkuPrimaries.has(productId)) {
        if (!DRY_RUN) await pool.query('DELETE FROM media_assets WHERE id = $1', [img.id]);
        stats.deleted++;
        continue;
      }

      const filename = img.url.split('/').pop().toLowerCase().replace(/[\s_-]+/g, '');

      // Strategy 1: Match by vendor_sku in filename (most reliable)
      let matchedSkuIds = [];
      for (const sku of skus) {
        if (sku.vsku && sku.vsku.length >= 6 && filename.includes(sku.vsku.replace(/[\s_-]+/g, ''))) {
          matchedSkuIds.push(sku.sku_id);
        }
      }

      if (matchedSkuIds.length > 0) {
        // Delete the product-level image, insert per matched SKU
        if (!DRY_RUN) await pool.query('DELETE FROM media_assets WHERE id = $1', [img.id]);
        for (const skuId of matchedSkuIds) {
          if (!existingSkuUrls.has(`${skuId}:${img.url}`)) {
            const nextSort = await pool.query(
              `SELECT COALESCE(MAX(sort_order), -1) + 1 as n FROM media_assets WHERE product_id = $1 AND sku_id = $2 AND asset_type = $3`,
              [productId, skuId, img.asset_type]
            );
            if (!DRY_RUN) await pool.query(
              `INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
               VALUES ($1, $2, $3, $4, $4, $5)
               ON CONFLICT (product_id, sku_id, asset_type, sort_order) WHERE sku_id IS NOT NULL DO UPDATE SET url = EXCLUDED.url`,
              [productId, skuId, img.asset_type, img.url, nextSort.rows[0].n]
            );
            existingSkuUrls.add(`${skuId}:${img.url}`);
            stats.inserted++;
          }
        }
        stats.skuMatched++;
        continue;
      }

      // Strategy 2: Match by color in filename (only for multi-color products)
      const distinctColors = new Map(); // normalized color → [skuIds]
      for (const sku of skus) {
        const color = (sku.color || sku.variant_name || '').toLowerCase().replace(/[\s_-]+/g, '');
        if (color.length < 3) continue;
        if (!distinctColors.has(color)) distinctColors.set(color, []);
        distinctColors.get(color).push(sku.sku_id);
      }

      if (distinctColors.size > 1) {
        const colorMatches = [];
        for (const [color, skuIds] of distinctColors) {
          if (filename.includes(color)) colorMatches.push({ color, skuIds });
        }

        if (colorMatches.length === 1) {
          // Single color match — assign to all SKUs of that color
          if (!DRY_RUN) await pool.query('DELETE FROM media_assets WHERE id = $1', [img.id]);
          for (const skuId of colorMatches[0].skuIds) {
            if (!existingSkuUrls.has(`${skuId}:${img.url}`)) {
              const nextSort = await pool.query(
                `SELECT COALESCE(MAX(sort_order), -1) + 1 as n FROM media_assets WHERE product_id = $1 AND sku_id = $2 AND asset_type = $3`,
                [productId, skuId, img.asset_type]
              );
              if (!DRY_RUN) await pool.query(
                `INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
                 VALUES ($1, $2, $3, $4, $4, $5)
                 ON CONFLICT (product_id, sku_id, asset_type, sort_order) WHERE sku_id IS NOT NULL DO UPDATE SET url = EXCLUDED.url`,
                [productId, skuId, img.asset_type, img.url, nextSort.rows[0].n]
              );
              existingSkuUrls.add(`${skuId}:${img.url}`);
              stats.inserted++;
            }
          }
          stats.colorMatched++;
          continue;
        }
      }

      // No match → keep at product level
      stats.kept++;
    }

    stats.processed++;
    if (stats.processed % 100 === 0) {
      console.log(`  ${stats.processed} products | sku-match: ${stats.skuMatched}, color-match: ${stats.colorMatched}, kept: ${stats.kept}, inserted: ${stats.inserted}`);
    }
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Products processed: ${stats.processed}`);
  console.log(`Matched by vendor_sku: ${stats.skuMatched}`);
  console.log(`Matched by color: ${stats.colorMatched}`);
  console.log(`SKU-level copies inserted: ${stats.inserted}`);
  console.log(`Redundant primaries deleted: ${stats.deleted}`);
  console.log(`Duplicates removed: ${stats.deduped}`);
  console.log(`Kept at product level: ${stats.kept}`);
  console.log(`${'='.repeat(60)}\n`);

  const verify = await pool.query(`
    SELECT
      COUNT(CASE WHEN ma.sku_id IS NOT NULL THEN 1 END) as sku_level,
      COUNT(CASE WHEN ma.sku_id IS NULL THEN 1 END) as product_level,
      COUNT(*) as total
    FROM media_assets ma
    JOIN products p ON p.id = ma.product_id
    WHERE p.vendor_id = $1
  `, [vendorId]);
  const v = verify.rows[0];
  console.log(`Final: ${v.sku_level} SKU-level, ${v.product_level} product-level, ${v.total} total`);

  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
