#!/usr/bin/env node
/**
 * One-time backfill: split box-sold marble field tiles out of Marble Countertops
 * into Natural Stone as separate " Tile" products.
 *
 * Problem: 6 marble products have both slab SKUs (unit) and field-tile SKUs (box)
 * on the same product in Marble Countertops. The field tiles should be in Natural Stone.
 *
 * Actions:
 *   1. For each affected product, create a new product in Natural Stone with
 *      collection = original collection + " Tile"
 *   2. Move box-sold SKUs to the new product (UPDATE skus.product_id)
 *   3. Copy primary media asset to the new product
 *
 * Usage: docker exec -i flooring-api node backend/scripts/split-marble-tiles.mjs [--dry-run]
 */

import pg from 'pg';
const { Pool } = pg;

const DRY_RUN = process.argv.includes('--dry-run');
const VENDOR_ID = '550e8400-e29b-41d4-a716-446655440007'; // Arizona Tile

const pool = new Pool({
  host: process.env.PGHOST || 'db',
  port: process.env.PGPORT || 5432,
  database: process.env.PGDATABASE || 'flooring_pim',
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'postgres',
});

async function main() {
  console.log(`\n=== Split marble field tiles → Natural Stone ${DRY_RUN ? '(DRY RUN)' : ''} ===\n`);

  // Get category IDs
  const { rows: cats } = await pool.query(
    `SELECT id, slug FROM categories WHERE slug IN ('marble-countertops', 'natural-stone')`
  );
  const marbleId = cats.find(c => c.slug === 'marble-countertops')?.id;
  const naturalStoneId = cats.find(c => c.slug === 'natural-stone')?.id;
  if (!marbleId || !naturalStoneId) {
    console.error('Could not find marble-countertops or natural-stone category');
    process.exit(1);
  }

  // Find products in Marble Countertops that have box-sold SKUs
  const { rows: affected } = await pool.query(`
    SELECT DISTINCT p.id, p.name, p.collection, p.slug, p.description_short, p.description_long
    FROM products p
    JOIN skus s ON s.product_id = p.id
    WHERE p.vendor_id = $1
      AND p.category_id = $2
      AND s.sell_by = 'box'
    ORDER BY p.name
  `, [VENDOR_ID, marbleId]);

  console.log(`Found ${affected.length} products with box-sold tile SKUs in Marble Countertops:\n`);

  let totalMoved = 0;

  for (const prod of affected) {
    // Count box vs unit SKUs
    const { rows: skuCounts } = await pool.query(`
      SELECT sell_by, COUNT(*) as cnt
      FROM skus WHERE product_id = $1
      GROUP BY sell_by
    `, [prod.id]);
    const boxCount = skuCounts.find(r => r.sell_by === 'box')?.cnt || 0;
    const unitCount = skuCounts.find(r => r.sell_by === 'unit')?.cnt || 0;

    console.log(`  ${prod.name} (collection: "${prod.collection}")`);
    console.log(`    ${boxCount} box-sold tile SKUs, ${unitCount} unit-sold slab SKUs`);

    if (DRY_RUN) {
      // Show which SKUs would be moved
      const { rows: tileSkus } = await pool.query(
        `SELECT variant_name FROM skus WHERE product_id = $1 AND sell_by = 'box' ORDER BY variant_name`,
        [prod.id]
      );
      for (const s of tileSkus) console.log(`    → would move: ${s.variant_name}`);
      totalMoved += parseInt(boxCount);
      continue;
    }

    // Create new product in Natural Stone with " Tile" collection suffix
    const newCollection = prod.collection + ' Tile';
    const newSlug = prod.slug ? prod.slug + '-tile' : null;

    let newProductId;
    try {
      const { rows } = await pool.query(`
        INSERT INTO products (vendor_id, name, collection, category_id, slug,
                              description_short, description_long, is_active, status)
        VALUES ($1, $2, $3, $4, $5, $6, $7, true, 'active')
        ON CONFLICT ON CONSTRAINT products_vendor_collection_name_unique
        DO UPDATE SET category_id = $4, updated_at = CURRENT_TIMESTAMP
        RETURNING id, (xmax = 0) AS is_new
      `, [VENDOR_ID, prod.name, newCollection, naturalStoneId, newSlug,
          prod.description_short, prod.description_long]);
      newProductId = rows[0].id;
      console.log(`    ${rows[0].is_new ? 'Created' : 'Found existing'} product → ${newCollection} (Natural Stone)`);
    } catch (err) {
      if (err.code === '23505' && err.constraint === 'products_slug_unique') {
        // Slug collision — insert without slug
        const { rows } = await pool.query(`
          INSERT INTO products (vendor_id, name, collection, category_id,
                                description_short, description_long, is_active, status)
          VALUES ($1, $2, $3, $4, $5, $6, true, 'active')
          ON CONFLICT ON CONSTRAINT products_vendor_collection_name_unique
          DO UPDATE SET category_id = $4, updated_at = CURRENT_TIMESTAMP
          RETURNING id, (xmax = 0) AS is_new
        `, [VENDOR_ID, prod.name, newCollection, naturalStoneId,
            prod.description_short, prod.description_long]);
        newProductId = rows[0].id;
        console.log(`    ${rows[0].is_new ? 'Created' : 'Found existing'} product (no slug) → ${newCollection} (Natural Stone)`);
      } else {
        throw err;
      }
    }

    // Move box-sold SKUs to the new product
    const { rowCount } = await pool.query(`
      UPDATE skus SET product_id = $1, updated_at = CURRENT_TIMESTAMP
      WHERE product_id = $2 AND sell_by = 'box'
    `, [newProductId, prod.id]);
    console.log(`    Moved ${rowCount} tile SKUs`);
    totalMoved += rowCount;

    // Copy primary media asset to new product (if exists and new product doesn't have one)
    const { rows: media } = await pool.query(`
      SELECT url, original_url, asset_type
      FROM media_assets
      WHERE product_id = $1 AND asset_type = 'primary' AND sku_id IS NULL
      LIMIT 1
    `, [prod.id]);
    if (media.length > 0) {
      await pool.query(`
        INSERT INTO media_assets (product_id, url, original_url, asset_type, sort_order)
        VALUES ($1, $2, $3, $4, 0)
        ON CONFLICT DO NOTHING
      `, [newProductId, media[0].url, media[0].original_url, media[0].asset_type]);
      console.log(`    Copied primary image`);
    }

    // Refresh search vectors for both products
    await pool.query('SELECT refresh_search_vectors($1)', [newProductId]).catch(() => {});
    await pool.query('SELECT refresh_search_vectors($1)', [prod.id]).catch(() => {});
  }

  console.log(`\n${DRY_RUN ? 'Would move' : 'Moved'} ${totalMoved} tile SKUs total across ${affected.length} products\n`);

  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
