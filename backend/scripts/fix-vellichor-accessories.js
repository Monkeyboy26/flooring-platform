#!/usr/bin/env node

/**
 * Fix Vellichor accessories — link them to individual flooring products.
 *
 * Currently accessories live under standalone "Moldings" products. The storefront
 * needs them as sibling SKUs (same product_id) to show in "Matching Accessories".
 *
 * This script:
 *   1. Creates accessory SKUs under each flooring product (ENG→Engineered, SPC→SPC)
 *   2. Copies pricing from the original molding SKUs
 *   3. Removes the old standalone Moldings products
 *
 * Usage: docker compose exec api node scripts/fix-vellichor-accessories.js
 */

import pg from 'pg';

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: 5432,
  database: 'flooring_pim',
  user: 'postgres',
  password: 'postgres',
});

// Engineered Hardwood collections
const ENG_COLLECTIONS = [
  'Artist Collection',
  'Metropolitan Collection',
  'Prime Collection',
  'River Run Collection',
  'Throne Collection',
];

// SPC collections
const SPC_COLLECTIONS = [
  'Galaxy Collection',
  'Gemstone Collection',
  'Summit Collection',
];

// Accessory definitions (from existing data)
const ENG_ACCESSORIES = [
  { suffix: 'EC',  name: 'End Cap, 8\'',          cost: 40, retail: 80 },
  { suffix: 'FSN', name: 'Flush Stair Nose, 8\'', cost: 65, retail: 130 },
  { suffix: 'QR',  name: 'Quarter Round, 8\'',    cost: 30, retail: 60 },
  { suffix: 'RD',  name: 'Reducer, 8\'',          cost: 40, retail: 80 },
  { suffix: 'TM',  name: 'T-Molding, 8\'',        cost: 40, retail: 80 },
];

const SPC_ACCESSORIES = [
  { suffix: 'EC',  name: 'End Cap, 94-1/2"',           cost: 18, retail: 36 },
  { suffix: 'QR',  name: 'Quarter Round, 94-1/2"',     cost: 12, retail: 24 },
  { suffix: 'RD',  name: 'Reducer, 94-1/2"',           cost: 18, retail: 36 },
  { suffix: 'SN',  name: 'Stair Nose, 94-1/2"',        cost: 28, retail: 56 },
  { suffix: 'SSN', name: 'Square Stair Nose, 94-1/2"', cost: 35, retail: 70 },
  { suffix: 'TM',  name: 'T Molding, 94-1/2"',         cost: 18, retail: 36 },
];

async function upsertAccessorySku(productId, { vendorSku, internalSku, variantName }) {
  const result = await pool.query(`
    INSERT INTO skus (product_id, vendor_sku, internal_sku, variant_name, sell_by, variant_type)
    VALUES ($1, $2, $3, $4, 'unit', 'accessory')
    ON CONFLICT (internal_sku) DO UPDATE SET
      product_id = EXCLUDED.product_id,
      vendor_sku = COALESCE(EXCLUDED.vendor_sku, skus.vendor_sku),
      variant_name = COALESCE(EXCLUDED.variant_name, skus.variant_name),
      sell_by = 'unit',
      variant_type = 'accessory',
      updated_at = CURRENT_TIMESTAMP
    RETURNING id, (xmax = 0) AS is_new
  `, [productId, vendorSku, internalSku, variantName]);
  return result.rows[0];
}

async function upsertPricing(skuId, cost, retail) {
  await pool.query(`
    INSERT INTO pricing (sku_id, cost, retail_price, price_basis)
    VALUES ($1, $2, $3, 'per_unit')
    ON CONFLICT (sku_id) DO UPDATE SET
      cost = EXCLUDED.cost,
      retail_price = EXCLUDED.retail_price,
      price_basis = 'per_unit'
  `, [skuId, cost, retail]);
}

async function main() {
  const vendorRes = await pool.query("SELECT id FROM vendors WHERE code = 'VELLICHOR'");
  if (!vendorRes.rows.length) {
    console.error('Vellichor vendor not found');
    process.exit(1);
  }
  const vendorId = vendorRes.rows[0].id;

  // Get all flooring products (non-accessory SKUs)
  const flooringRes = await pool.query(`
    SELECT DISTINCT p.id as product_id, p.name, p.collection, s.vendor_sku
    FROM products p
    JOIN skus s ON s.product_id = p.id
    WHERE p.vendor_id = $1
      AND (s.variant_type IS NULL OR s.variant_type != 'accessory')
      AND p.collection NOT IN ('Engineered Accessories', 'SPC Accessories')
    ORDER BY p.collection, p.name
  `, [vendorId]);

  console.log(`Found ${flooringRes.rowCount} flooring SKUs\n`);

  let created = 0;
  let updated = 0;

  for (const row of flooringRes.rows) {
    const isEng = ENG_COLLECTIONS.includes(row.collection);
    const isSpc = SPC_COLLECTIONS.includes(row.collection);

    if (!isEng && !isSpc) {
      console.log(`  [SKIP] Unknown collection: ${row.collection} (${row.name})`);
      continue;
    }

    const accessories = isEng ? ENG_ACCESSORIES : SPC_ACCESSORIES;
    const prefix = isEng ? 'ENG' : 'SPC';

    for (const acc of accessories) {
      const vendorSku = `${row.vendor_sku}-${acc.suffix}`;
      const internalSku = `VELLICHOR-${row.vendor_sku}-${acc.suffix}`;

      const sku = await upsertAccessorySku(row.product_id, {
        vendorSku,
        internalSku,
        variantName: acc.name,
      });

      await upsertPricing(sku.id, acc.cost, acc.retail);

      if (sku.is_new) created++;
      else updated++;
    }

    console.log(`  ${row.name} (${row.collection}) — ${accessories.length} accessories`);
  }

  // Clean up old standalone Moldings products
  const oldProducts = await pool.query(`
    SELECT p.id, p.name, p.collection
    FROM products p
    WHERE p.vendor_id = $1
      AND p.collection IN ('Engineered Accessories', 'SPC Accessories')
  `, [vendorId]);

  if (oldProducts.rows.length > 0) {
    console.log(`\nCleaning up ${oldProducts.rows.length} old standalone Moldings products...`);
    for (const old of oldProducts.rows) {
      // Delete pricing for old accessory SKUs
      await pool.query(`
        DELETE FROM pricing WHERE sku_id IN (
          SELECT id FROM skus WHERE product_id = $1
        )
      `, [old.id]);
      // Delete old accessory SKUs
      await pool.query(`DELETE FROM skus WHERE product_id = $1`, [old.id]);
      // Delete old product
      await pool.query(`DELETE FROM products WHERE id = $1`, [old.id]);
      console.log(`  Deleted: ${old.name} (${old.collection})`);
    }
  }

  console.log('\n=== Vellichor Accessory Fix Complete ===');
  console.log(`Accessories created: ${created}`);
  console.log(`Accessories updated: ${updated}`);
  console.log(`Old Moldings products removed: ${oldProducts.rows.length}`);

  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
