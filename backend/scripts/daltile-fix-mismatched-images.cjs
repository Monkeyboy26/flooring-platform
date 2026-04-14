#!/usr/bin/env node
/**
 * daltile-fix-mismatched-images.cjs
 *
 * Fixes Daltile product-level primary images that were inherited from a
 * pre-split mega-product and no longer match the actual color of the product.
 *
 * Detection:
 *   Daltile image URLs follow the pattern:
 *     https://s7d9.scene7.com/is/image/daltile/DAL_<SERIES><COLOR>_<SIZE>_<NAME>
 *     https://digitalassets.daltile.com/.../DAL_<SERIES><COLOR>_<SIZE>_<NAME>
 *   The SERIES+COLOR code (e.g. "AM31" = Armor Guilded Copper) also appears
 *   as the prefix of the SKUs for that color (e.g. AM31...CR1P).
 *
 *   If a product has a primary image with a code that doesn't match ANY of
 *   its active SKUs' vendor_sku prefixes, the image was misassigned during
 *   the product split.
 *
 * Fix strategy (in order):
 *   1. If the product has SKU-level primary images, promote the first one
 *      to a product-level primary image (asset_type='primary', sku_id=null)
 *      and delete the mismatched one.
 *   2. Otherwise, delete the mismatched product-level primary image. The
 *      storefront will fall back to SKU-level images or placeholder.
 *
 * Usage:
 *   node backend/scripts/daltile-fix-mismatched-images.cjs --dry-run
 *   node backend/scripts/daltile-fix-mismatched-images.cjs
 */

const { Pool } = require('pg');
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  DALTILE MISMATCHED-IMAGE FIX ${DRY_RUN ? '(DRY RUN)' : '(LIVE)'}`);
  console.log(`${'='.repeat(60)}\n`);

  // Find all DAL products with a product-level primary image whose code
  // doesn't match any active SKU in the product.
  const { rows: mismatched } = await pool.query(`
    WITH image_codes AS (
      SELECT p.id as product_id, p.name as product_name,
             ma.id as media_id, ma.url,
             substring(ma.url from 'DAL_([A-Z0-9]+)_') as code
      FROM products p
      JOIN vendors v ON v.id = p.vendor_id
      JOIN media_assets ma ON ma.product_id = p.id AND ma.sku_id IS NULL AND ma.asset_type='primary'
      WHERE v.code='DAL' AND p.status='active'
    )
    SELECT ic.product_id, ic.product_name, ic.media_id, ic.url, ic.code
    FROM image_codes ic
    WHERE ic.code IS NOT NULL
      AND NOT EXISTS(
        SELECT 1 FROM skus s
        WHERE s.product_id = ic.product_id
          AND s.status = 'active'
          AND UPPER(s.vendor_sku) LIKE ic.code || '%'
      )
    ORDER BY ic.product_name
  `);

  console.log(`Found ${mismatched.length} products with mismatched primary images\n`);

  // For each, check if it has SKU-level primary images
  const actions = { promote: [], delete: [] };
  for (const m of mismatched) {
    const { rows: skuImages } = await pool.query(`
      SELECT ma.id, ma.url, ma.original_url, ma.asset_type, ma.sort_order, s.vendor_sku
      FROM media_assets ma
      JOIN skus s ON s.id = ma.sku_id
      WHERE s.product_id = $1 AND s.status='active' AND ma.asset_type='primary'
      ORDER BY ma.sort_order, s.vendor_sku
      LIMIT 1
    `, [m.product_id]);

    if (skuImages.length > 0) {
      actions.promote.push({ ...m, skuImage: skuImages[0] });
    } else {
      actions.delete.push(m);
    }
  }

  console.log(`Fix plan:`);
  console.log(`  Promote SKU image to product primary: ${actions.promote.length}`);
  console.log(`  Delete (no SKU images available): ${actions.delete.length}\n`);

  if (actions.promote.length > 0) {
    console.log(`Sample promotions (first 10):`);
    for (const p of actions.promote.slice(0, 10)) {
      console.log(`  ${p.product_name}`);
      console.log(`    OLD: ${p.url.substring(0, 90)}`);
      console.log(`    NEW: ${p.skuImage.url.substring(0, 90)} (from SKU ${p.skuImage.vendor_sku})`);
    }
    console.log();
  }

  if (actions.delete.length > 0) {
    console.log(`Sample deletions (first 10):`);
    for (const d of actions.delete.slice(0, 10)) {
      console.log(`  ${d.product_name}: ${d.url.substring(0, 100)}`);
    }
    console.log();
  }

  if (DRY_RUN) {
    console.log('Dry run — no changes applied.');
    await pool.end();
    return;
  }

  const total = actions.promote.length + actions.delete.length;
  if (total === 0) {
    console.log('Nothing to fix.');
    await pool.end();
    return;
  }

  console.log(`Applying ${total} fixes...`);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Promotions: delete the mismatched primary first (unique constraint on
    // product_id+asset_type+sort_order), then insert the new one.
    for (const p of actions.promote) {
      await client.query('DELETE FROM media_assets WHERE id = $1', [p.media_id]);
      await client.query(`
        INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
        VALUES ($1, NULL, 'primary', $2, $3, 0)
      `, [p.product_id, p.skuImage.url, p.skuImage.original_url]);
    }

    // Straight deletions
    for (const d of actions.delete) {
      await client.query('DELETE FROM media_assets WHERE id = $1', [d.media_id]);
    }

    await client.query('COMMIT');
    console.log(`  Committed ${actions.promote.length} promotions + ${actions.delete.length} deletions.`);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  await pool.end();
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
