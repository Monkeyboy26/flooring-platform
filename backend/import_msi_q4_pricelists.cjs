#!/usr/bin/env node
/**
 * Import MSI Q4-2024 Price List data from 3 files:
 * 1. Backsplash_Ledger_Sinks_Flooring (only SKUs not in Jan'26 VDL)
 * 2. Natural Stone Slabs (all)
 * 3. Prefab (all)
 *
 * Matches by vendor_sku (uppercase). Only imports pricing for SKUs
 * that don't already have a pricing row (preserves newer Jan'26 data).
 */

const { Pool } = require('pg');
const fs = require('fs');

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
  // Load all three lookups
  const files = [
    { path: '/tmp/msi_backsplash_q4_only_lookup.json', label: 'Backsplash Q4 (unique)', skipExistingPricing: false },
    { path: '/tmp/msi_natural_stone_slabs_lookup.json', label: 'Natural Stone Slabs', skipExistingPricing: false },
    { path: '/tmp/msi_prefab_lookup.json', label: 'Prefab', skipExistingPricing: false },
  ];

  // Merge all lookups into one
  const allItems = {};
  for (const file of files) {
    if (!fs.existsSync(file.path)) {
      console.log(`Skipping ${file.label}: file not found at ${file.path}`);
      continue;
    }
    const data = JSON.parse(fs.readFileSync(file.path, 'utf8'));
    const count = Object.keys(data).length;
    console.log(`Loaded ${count} items from ${file.label}`);
    for (const [key, val] of Object.entries(data)) {
      allItems[key] = { ...val, _source: file.label };
    }
  }
  console.log(`Total items to process: ${Object.keys(allItems).length}`);

  // Get all MSI SKUs from DB
  const { rows: skus } = await pool.query(`
    SELECT s.id, s.vendor_sku, s.product_id
    FROM skus s
    JOIN products p ON s.product_id = p.id
    WHERE p.vendor_id = (SELECT id FROM vendors WHERE name ILIKE '%msi%' LIMIT 1)
  `);
  console.log(`Found ${skus.length} MSI SKUs in DB`);

  // Get SKUs that already have pricing (to skip them)
  const { rows: pricedSkus } = await pool.query(`
    SELECT DISTINCT s.vendor_sku
    FROM skus s
    JOIN products p ON s.product_id = p.id
    JOIN pricing pr ON pr.sku_id = s.id
    WHERE p.vendor_id = (SELECT id FROM vendors WHERE name ILIKE '%msi%' LIMIT 1)
  `);
  const alreadyPriced = new Set(pricedSkus.map(r => r.vendor_sku.toUpperCase()));
  console.log(`Already have pricing for ${alreadyPriced.size} SKUs (will skip these)`);

  let matched = 0, pricingUpserted = 0, packagingUpserted = 0, attrsUpserted = 0;
  let skipped = 0, skippedPriced = 0;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const sku of skus) {
      const key = sku.vendor_sku.toUpperCase();
      const item = allItems[key];
      if (!item) {
        skipped++;
        continue;
      }
      matched++;

      // --- Pricing ---
      // Determine cost and retail from the item data
      let cost = null;
      let retail = null;
      let priceBasis = 'per_unit';

      if (item.price_per_uom !== undefined) {
        // Backsplash format: price_per_uom, uom
        cost = item.price_per_uom;
        priceBasis = item.uom === 'SQFT' ? 'per_sqft' : 'per_unit';
        if (cost && typeof cost === 'number' && cost > 0) {
          retail = parseFloat((cost * 2.5).toFixed(2));
          cost = parseFloat(cost.toFixed(2));
        } else {
          cost = null;
        }
      } else if (item.cost !== undefined) {
        // Natural Stone / Prefab format: cost, retail_price
        cost = item.cost;
        priceBasis = item.uom === 'SQFT' ? 'per_sqft' : 'per_unit';
        if (cost && typeof cost === 'number' && cost > 0) {
          cost = parseFloat(cost.toFixed(2));
          if (item.retail_price && typeof item.retail_price === 'number') {
            retail = parseFloat(item.retail_price.toFixed(2));
          } else {
            retail = parseFloat((cost * 2.5).toFixed(2));
          }
        } else {
          cost = null;
        }
      }

      // Skip pricing if this SKU already has pricing from Jan'26 VDL
      if (cost && alreadyPriced.has(key)) {
        skippedPriced++;
        // Still import packaging and attributes below
      } else if (cost) {
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
      if (item.size && !['MISC.', 'MISC', 'None', 'N/A', ''].includes(item.size)) {
        attrValues.push([ATTR_IDS.size, item.size.trim()]);
      }
      if (item.finish && !['MISC.', 'MISC', 'None', 'N/A', ''].includes(item.finish)) {
        attrValues.push([ATTR_IDS.finish, item.finish.trim()]);
      }
      if (item.thickness && !['MISC.', 'MISC', 'None', 'N/A', ''].includes(item.thickness)) {
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
    console.log(`  Skipped (no match in price lists): ${skipped}`);
    console.log(`  Skipped pricing (already have Jan'26 data): ${skippedPriced}`);
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
