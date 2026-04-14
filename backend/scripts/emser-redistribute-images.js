#!/usr/bin/env node
/**
 * Emser Tile — Redistribute Product-Level Images to SKU Level
 *
 * Problem: All 8,062 Emser images are stored at the product level (sku_id IS NULL),
 * so every color variant of a product shows the same pool of mixed images.
 *
 * Strategy:
 *   1. For each multi-color Emser product, get its color SKUs and image URLs
 *   2. Parse the color name from each image filename (pattern: series_COLOR_sku_...)
 *   3. Match image → SKU by color. Assign as SKU-level image.
 *   4. Images referencing multiple colors or no color stay at product level as lifestyle/shared.
 *   5. Reassign asset_type: SKU-level color images get primary/alternate, shared remain lifestyle.
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

  // Get all active Emser products with their SKUs
  const products = await pool.query(`
    SELECT p.id as product_id, p.name, p.collection,
      json_agg(json_build_object(
        'sku_id', s.id,
        'vendor_sku', s.vendor_sku,
        'variant_name', s.variant_name,
        'variant_type', s.variant_type
      ) ORDER BY s.vendor_sku) as skus
    FROM products p
    JOIN vendors v ON v.id = p.vendor_id
    JOIN skus s ON s.product_id = p.id
    WHERE p.vendor_id = $1 AND p.status = 'active'
    GROUP BY p.id, p.name, p.collection
    ORDER BY p.collection, p.name
  `, [vendorId]);

  console.log(`Loaded ${products.rows.length} active products`);

  // Load color attributes for all SKUs in one query
  const colorRes = await pool.query(`
    SELECT sa.sku_id, sa.value
    FROM sku_attributes sa
    JOIN attributes a ON a.id = sa.attribute_id
    JOIN skus s ON s.id = sa.sku_id
    JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id
    WHERE a.slug = 'color' AND p.vendor_id = $1
  `, [vendorId]);
  const colorBySku = new Map();
  for (const row of colorRes.rows) colorBySku.set(row.sku_id, row.value);
  console.log(`Loaded ${colorBySku.size} SKU color attributes`);

  // Get all product-level images
  const images = await pool.query(`
    SELECT ma.id, ma.product_id, ma.asset_type, ma.url, ma.sort_order
    FROM media_assets ma
    JOIN products p ON p.id = ma.product_id
    JOIN vendors v ON v.id = p.vendor_id
    WHERE p.vendor_id = $1 AND ma.sku_id IS NULL
    ORDER BY ma.product_id, ma.sort_order
  `, [vendorId]);

  // Index images by product_id
  const imagesByProduct = new Map();
  for (const img of images.rows) {
    if (!imagesByProduct.has(img.product_id)) imagesByProduct.set(img.product_id, []);
    imagesByProduct.get(img.product_id).push(img);
  }

  let totalProcessed = 0;
  let totalReassigned = 0;
  let totalKeptShared = 0;
  let productsProcessed = 0;
  let productsSkipped = 0;

  for (const prod of products.rows) {
    const prodImages = imagesByProduct.get(prod.product_id);
    if (!prodImages || prodImages.length === 0) continue;

    // Attach colors from the lookup map
    const skus = prod.skus
      .filter(s => s.variant_type !== 'accessory')
      .map(s => ({ ...s, color: colorBySku.get(s.sku_id) || null }));
    const skusWithColor = skus.filter(s => s.color);

    if (skusWithColor.length <= 1) {
      // Single-color or no-color product — leave images at product level
      productsSkipped++;
      continue;
    }

    productsProcessed++;

    // Build color → SKU mapping
    // Normalize color names for filename matching
    const colorToSku = new Map();
    const colorNorms = []; // [{norm, skuId, originalColor}]
    for (const sku of skusWithColor) {
      const norm = sku.color.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
      colorToSku.set(norm, sku.sku_id);
      colorNorms.push({ norm, skuId: sku.sku_id, original: sku.color });

      // Also try variant_name as fallback (sometimes differs from color attribute)
      if (sku.variant_name) {
        const vnorm = sku.variant_name.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
        if (vnorm !== norm) {
          colorToSku.set(vnorm, sku.sku_id);
          colorNorms.push({ norm: vnorm, skuId: sku.sku_id, original: sku.variant_name });
        }
      }
    }

    // Match each image to a SKU by color in filename
    const skuImages = new Map(); // skuId → [{url, asset_type}]
    const sharedImages = [];     // Images that stay at product level

    for (const img of prodImages) {
      const filename = img.url.split('/').pop().toLowerCase();

      // Find which colors appear in this filename
      const matchedSkuIds = new Set();
      for (const { norm, skuId } of colorNorms) {
        // Check if color appears as a word boundary in the filename
        // Pattern: _COLOR_ or _COLOR. or series_COLOR_sku
        if (norm.length >= 3 && filename.includes(norm)) {
          matchedSkuIds.add(skuId);
        }
      }

      if (matchedSkuIds.size === 1) {
        // Single color match — assign to that SKU
        const skuId = [...matchedSkuIds][0];
        if (!skuImages.has(skuId)) skuImages.set(skuId, []);
        skuImages.get(skuId).push(img);
        totalReassigned++;
      } else {
        // 0 or multiple color matches — keep as shared product-level image
        sharedImages.push(img);
        totalKeptShared++;
      }
    }

    if (totalReassigned === 0 && productsProcessed % 100 === 0) {
      // Progress reporting
    }

    // Apply changes
    if (!DRY_RUN) {
      // 1. Delete all existing product-level images for this product
      await pool.query('DELETE FROM media_assets WHERE product_id = $1 AND sku_id IS NULL', [prod.product_id]);

      // 2. Re-insert shared images at product level
      for (let i = 0; i < sharedImages.length; i++) {
        const img = sharedImages[i];
        const isLifestyle = /room|scene|lifestyle|rs[_.]|roomscene|application|vignette/i.test(img.url);
        const assetType = isLifestyle ? 'lifestyle' : (i === 0 ? 'primary' : 'alternate');
        await pool.query(
          `INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
           VALUES ($1, NULL, $2, $3, $3, $4)
           ON CONFLICT (product_id, asset_type, sort_order) WHERE sku_id IS NULL DO UPDATE SET url = EXCLUDED.url`,
          [prod.product_id, assetType, img.url, i]
        );
      }

      // 3. Insert SKU-level images
      for (const [skuId, imgs] of skuImages) {
        for (let i = 0; i < imgs.length; i++) {
          const img = imgs[i];
          const isLifestyle = /room|scene|lifestyle|rs[_.]|roomscene|application|vignette/i.test(img.url);
          const assetType = isLifestyle ? 'lifestyle' : (i === 0 ? 'primary' : 'alternate');
          await pool.query(
            `INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
             VALUES ($1, $2, $3, $4, $4, $5)
             ON CONFLICT (product_id, sku_id, asset_type, sort_order) WHERE sku_id IS NOT NULL DO UPDATE SET url = EXCLUDED.url`,
            [prod.product_id, skuId, assetType, img.url, i]
          );
        }
      }
    }

    totalProcessed += prodImages.length;

    if (productsProcessed % 50 === 0) {
      console.log(`  Progress: ${productsProcessed} products, ${totalReassigned} images → SKU level, ${totalKeptShared} shared`);
    }
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`Products processed: ${productsProcessed}`);
  console.log(`Products skipped (single-color): ${productsSkipped}`);
  console.log(`Images reassigned to SKU level: ${totalReassigned}`);
  console.log(`Images kept as shared (product level): ${totalKeptShared}`);
  console.log(`Total images processed: ${totalProcessed}`);
  console.log(`${'='.repeat(50)}\n`);

  // Verify
  const verify = await pool.query(`
    SELECT
      COUNT(CASE WHEN ma.sku_id IS NOT NULL THEN 1 END) as sku_level,
      COUNT(CASE WHEN ma.sku_id IS NULL THEN 1 END) as product_level,
      COUNT(*) as total
    FROM media_assets ma
    JOIN products p ON p.id = ma.product_id
    JOIN vendors v ON v.id = p.vendor_id
    WHERE v.code = 'EMSER'
  `);
  const v = verify.rows[0];
  console.log(`Final: ${v.sku_level} SKU-level, ${v.product_level} product-level, ${v.total} total images`);

  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
