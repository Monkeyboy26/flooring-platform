#!/usr/bin/env node
/**
 * Photo/Media Coverage Audit
 *
 * Connects to PostgreSQL and reports per-vendor media coverage gaps:
 *   1. Products missing a primary photo
 *   2. Products missing a lifestyle photo
 *   3. SKUs with no SKU-level image (falling back to product-level only)
 *   4. Products with only 1 image total
 *   5. Overall summary (totals + averages)
 *
 * Usage:
 *   node backend/scripts/audit-photos.cjs
 *   DATABASE_URL=postgresql://... node backend/scripts/audit-photos.cjs
 */

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/flooring_pim',
});

async function main() {
  // -----------------------------------------------------------------------
  // 1. Products Missing Primary Photo
  // -----------------------------------------------------------------------
  console.log('\n========================================');
  console.log('  1. Products Missing Primary Photo');
  console.log('========================================\n');

  const { rows: missingPrimary } = await pool.query(`
    SELECT v.name AS vendor, COUNT(*) AS missing_primary
    FROM products p
    JOIN vendors v ON v.id = p.vendor_id
    WHERE p.status = 'active'
      AND NOT EXISTS (
        SELECT 1 FROM media_assets ma
        WHERE ma.product_id = p.id AND ma.asset_type = 'primary'
      )
    GROUP BY v.name
    ORDER BY missing_primary DESC
  `);

  if (missingPrimary.length) {
    console.table(missingPrimary.map(r => ({
      Vendor: r.vendor,
      'Missing Primary': Number(r.missing_primary),
    })));
  } else {
    console.log('  All active products have a primary photo.\n');
  }

  // -----------------------------------------------------------------------
  // 2. Products Missing Lifestyle Photo
  // -----------------------------------------------------------------------
  console.log('\n========================================');
  console.log('  2. Products Missing Lifestyle Photo');
  console.log('========================================\n');

  const { rows: missingLifestyle } = await pool.query(`
    SELECT v.name AS vendor, COUNT(*) AS missing_lifestyle
    FROM products p
    JOIN vendors v ON v.id = p.vendor_id
    WHERE p.status = 'active'
      AND NOT EXISTS (
        SELECT 1 FROM media_assets ma
        WHERE ma.product_id = p.id AND ma.asset_type = 'lifestyle'
      )
    GROUP BY v.name
    ORDER BY missing_lifestyle DESC
  `);

  if (missingLifestyle.length) {
    console.table(missingLifestyle.map(r => ({
      Vendor: r.vendor,
      'Missing Lifestyle': Number(r.missing_lifestyle),
    })));
  } else {
    console.log('  All active products have a lifestyle photo.\n');
  }

  // -----------------------------------------------------------------------
  // 3. SKUs With No SKU-Level Image
  // -----------------------------------------------------------------------
  console.log('\n========================================');
  console.log('  3. SKUs With No SKU-Level Image');
  console.log('========================================\n');

  const { rows: noSkuImage } = await pool.query(`
    SELECT v.name AS vendor, COUNT(*) AS no_sku_image
    FROM skus s
    JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id
    WHERE s.status = 'active' AND s.is_sample = false
      AND NOT EXISTS (
        SELECT 1 FROM media_assets ma WHERE ma.sku_id = s.id
      )
    GROUP BY v.name
    ORDER BY no_sku_image DESC
  `);

  if (noSkuImage.length) {
    console.table(noSkuImage.map(r => ({
      Vendor: r.vendor,
      'No SKU Image': Number(r.no_sku_image),
    })));
  } else {
    console.log('  All active SKUs have a SKU-level image.\n');
  }

  // -----------------------------------------------------------------------
  // 4. Products With Only 1 Image Total
  // -----------------------------------------------------------------------
  console.log('\n========================================');
  console.log('  4. Products With Only 1 Image Total');
  console.log('========================================\n');

  const { rows: singleImage } = await pool.query(`
    SELECT v.name AS vendor, COUNT(*) AS single_image_products
    FROM products p
    JOIN vendors v ON v.id = p.vendor_id
    WHERE p.status = 'active'
      AND (SELECT COUNT(*) FROM media_assets ma WHERE ma.product_id = p.id) = 1
    GROUP BY v.name
    ORDER BY single_image_products DESC
  `);

  if (singleImage.length) {
    console.table(singleImage.map(r => ({
      Vendor: r.vendor,
      'Single Image Products': Number(r.single_image_products),
    })));
  } else {
    console.log('  No active products have exactly 1 image.\n');
  }

  // -----------------------------------------------------------------------
  // 5. Overall Summary
  // -----------------------------------------------------------------------
  console.log('\n========================================');
  console.log('  5. Overall Summary');
  console.log('========================================\n');

  const { rows: [summary] } = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM products WHERE status = 'active') AS total_products,
      (SELECT COUNT(DISTINCT p.id)
       FROM products p
       JOIN media_assets ma ON ma.product_id = p.id
       WHERE p.status = 'active') AS products_with_images,
      (SELECT COUNT(*) FROM media_assets) AS total_media_assets,
      (SELECT ROUND(AVG(cnt)::numeric, 2)
       FROM (
         SELECT p.id, COUNT(ma.id) AS cnt
         FROM products p
         LEFT JOIN media_assets ma ON ma.product_id = p.id
         WHERE p.status = 'active'
         GROUP BY p.id
       ) sub) AS avg_images_per_product
  `);

  const totalProducts = Number(summary.total_products);
  const withImages = Number(summary.products_with_images);
  const coveragePct = totalProducts > 0
    ? ((withImages / totalProducts) * 100).toFixed(1)
    : '0.0';

  console.table([{
    'Total Active Products': totalProducts,
    'Products With Images': withImages,
    'Coverage %': `${coveragePct}%`,
    'Total Media Assets': Number(summary.total_media_assets),
    'Avg Images / Product': Number(summary.avg_images_per_product),
  }]);
}

main()
  .then(() => {
    console.log('\nAudit complete.\n');
    return pool.end();
  })
  .catch(err => {
    console.error('Audit failed:', err);
    pool.end();
    process.exit(1);
  });
