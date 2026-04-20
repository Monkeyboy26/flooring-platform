#!/usr/bin/env node
/**
 * Detect cross-color image mismatches in Mannington media_assets.
 * Finds SKUs whose non-swatch images contain a different sibling's color
 * in the filename but NOT their own color.
 */
const { Pool } = require('pg');
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

async function main() {
  // Get all Mannington non-accessory SKUs with their images
  const { rows: skus } = await pool.query(`
    SELECT s.id as sku_id, s.vendor_sku, s.variant_name, s.product_id, p.name as product_name
    FROM skus s
    JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id
    WHERE v.code = 'MANNINGTON' AND s.status = 'active'
      AND COALESCE(s.variant_type, '') != 'accessory'
      AND s.variant_name IS NOT NULL AND LENGTH(s.variant_name) >= 3
  `);

  const { rows: images } = await pool.query(`
    SELECT ma.sku_id, ma.asset_type, ma.url
    FROM media_assets ma
    JOIN skus s ON s.id = ma.sku_id
    JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id
    WHERE v.code = 'MANNINGTON' AND ma.asset_type IN ('primary', 'alternate')
  `);

  // Build maps
  const skuMap = new Map();
  const productSkus = new Map(); // product_id → [sku]
  for (const sku of skus) {
    skuMap.set(sku.sku_id, sku);
    if (!productSkus.has(sku.product_id)) productSkus.set(sku.product_id, []);
    productSkus.get(sku.product_id).push(sku);
  }

  const skuImages = new Map(); // sku_id → [image]
  for (const img of images) {
    if (!skuImages.has(img.sku_id)) skuImages.set(img.sku_id, []);
    skuImages.get(img.sku_id).push(img);
  }

  function colorSlug(name) {
    return (name || '').toLowerCase().replace(/[^a-z]/g, '');
  }

  let issues = [];

  for (const [pid, siblings] of productSkus) {
    const colors = [...new Set(siblings.map(s => s.variant_name))];
    if (colors.length < 2) continue;

    for (const sku of siblings) {
      const imgs = skuImages.get(sku.sku_id) || [];
      if (imgs.length === 0) continue;

      const mySlug = colorSlug(sku.variant_name);
      if (mySlug.length < 3) continue;

      // Check each sibling color
      for (const sibColor of colors) {
        if (sibColor === sku.variant_name) continue;
        const sibSlug = colorSlug(sibColor);
        if (sibSlug.length < 4) continue;

        // Count images that contain sibling's color but NOT own color
        const wrongCount = imgs.filter(img => {
          const fn = (img.url || '').split('/').pop().toLowerCase().replace(/[_-]/g, '');
          return fn.includes(sibSlug) && !fn.includes(mySlug);
        }).length;

        if (wrongCount > 0 && wrongCount >= imgs.length / 2) {
          issues.push({
            vendorSku: sku.vendor_sku,
            variantName: sku.variant_name,
            productName: sku.product_name,
            wrongColor: sibColor,
            wrongCount,
            totalImages: imgs.length,
          });
        }
      }
    }
  }

  if (issues.length === 0) {
    console.log('No cross-color image mismatches found.');
  } else {
    console.log(`Found ${issues.length} cross-color mismatches:\n`);
    for (const i of issues) {
      console.log(`  ${i.vendorSku} (${i.productName} - ${i.variantName}): ${i.wrongCount}/${i.totalImages} images show "${i.wrongColor}"`);
    }
  }

  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
