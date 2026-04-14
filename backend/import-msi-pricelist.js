#!/usr/bin/env node
/**
 * Import MSI Price List data (Jan 2026 VDL)
 *
 * Matches price list items to existing SKUs by vendor_sku and imports:
 * - Pricing: cost per unit (dealer price), price_basis (per_sqft or per_unit)
 * - Packaging: sqft_per_box, pieces_per_box
 * - SKU attributes: size, finish, thickness
 *
 * Usage: node backend/scripts/import-msi-pricelist.js [path-to-json]
 *   Default: /tmp/msi_pricelist_lookup.json
 */

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

const ATTR_IDS = {
  size: 'd50e8400-e29b-41d4-a716-446655440004',
  finish: 'd50e8400-e29b-41d4-a716-446655440003',
  thickness: 'd50e8400-e29b-41d4-a716-446655440010',
};

async function run() {
  const jsonPath = process.argv[2] || '/tmp/msi_pricelist_lookup.json';
  if (!fs.existsSync(jsonPath)) {
    console.error(`File not found: ${jsonPath}`);
    process.exit(1);
  }

  const lookup = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const itemCount = Object.keys(lookup).length;
  console.log(`Loaded ${itemCount} price list items`);

  // Get all MSI SKUs from DB
  const { rows: skus } = await pool.query(`
    SELECT s.id, s.vendor_sku, s.product_id
    FROM skus s
    JOIN products p ON s.product_id = p.id
    WHERE p.vendor_id = (SELECT id FROM vendors WHERE name ILIKE '%msi%' LIMIT 1)
  `);
  console.log(`Found ${skus.length} MSI SKUs in DB`);

  let matched = 0, pricingUpserted = 0, packagingUpserted = 0, attrsUpserted = 0;
  let skipped = 0;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const sku of skus) {
      const key = sku.vendor_sku.toUpperCase();
      const item = lookup[key];
      if (!item) {
        skipped++;
        continue;
      }
      matched++;

      // --- Pricing ---
      const pricePerUom = item.price_per_uom;
      if (pricePerUom && typeof pricePerUom === 'number' && pricePerUom > 0) {
        const priceBasis = item.uom === 'SQFT' ? 'per_sqft' : 'per_unit';
        const cost = parseFloat(pricePerUom.toFixed(2));

        // Calculate retail price: 2.5x markup on cost (standard flooring markup)
        // This gives a healthy margin; can be adjusted via margin_tiers later
        const retail = parseFloat((cost * 2.5).toFixed(2));

        await client.query(`
          INSERT INTO pricing (sku_id, cost, retail_price, price_basis)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (sku_id) DO UPDATE
            SET cost = EXCLUDED.cost,
                retail_price = EXCLUDED.retail_price,
                price_basis = EXCLUDED.price_basis
        `, [sku.id, cost, retail, priceBasis]);
        pricingUpserted++;
      }

      // --- Packaging ---
      const sqftPerBox = item.sqft_per_box;
      const piecesPerBox = item.pieces_per_box;
      if (sqftPerBox && sqftPerBox > 0) {
        await client.query(`
          INSERT INTO packaging (sku_id, sqft_per_box, pieces_per_box)
          VALUES ($1, $2, $3)
          ON CONFLICT (sku_id) DO UPDATE
            SET sqft_per_box = COALESCE(EXCLUDED.sqft_per_box, packaging.sqft_per_box),
                pieces_per_box = COALESCE(EXCLUDED.pieces_per_box, packaging.pieces_per_box)
        `, [sku.id, sqftPerBox, piecesPerBox ? Math.round(piecesPerBox) : null]);
        packagingUpserted++;
      }

      // --- SKU Attributes ---
      const attrValues = [];
      if (item.size && item.size !== 'MISC.' && item.size !== 'None') {
        attrValues.push([ATTR_IDS.size, item.size.trim()]);
      }
      if (item.finish && item.finish !== 'MISC.' && item.finish !== 'None') {
        attrValues.push([ATTR_IDS.finish, item.finish.trim()]);
      }
      if (item.thickness && item.thickness !== 'MISC.' && item.thickness !== 'None') {
        attrValues.push([ATTR_IDS.thickness, item.thickness.trim()]);
      }

      for (const [attrId, value] of attrValues) {
        await client.query(`
          INSERT INTO sku_attributes (sku_id, attribute_id, value)
          VALUES ($1, $2, $3)
          ON CONFLICT (sku_id, attribute_id) DO UPDATE
            SET value = EXCLUDED.value
        `, [sku.id, attrId, value]);
        attrsUpserted++;
      }
    }

    await client.query('COMMIT');
    console.log(`\nResults:`);
    console.log(`  Matched: ${matched} / ${skus.length} SKUs`);
    console.log(`  Skipped (no match): ${skipped}`);
    console.log(`  Pricing upserted: ${pricingUpserted}`);
    console.log(`  Packaging upserted: ${packagingUpserted}`);
    console.log(`  Attributes upserted: ${attrsUpserted}`);

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error:', err.message);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
