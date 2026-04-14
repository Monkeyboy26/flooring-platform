#!/usr/bin/env node

/**
 * Add accessory SKUs to Johnson Hardwood flooring products.
 *
 * The original import script (import-johnson-hardwood.js) only imported
 * flooring products. This script adds the accessory SKUs (T-Mold, Threshold,
 * Reducer, Quarter Round, Stair Nose) that are listed as columns in the
 * Johnson Hardwood West Preferred Price List (Nov 17, 2025).
 *
 * Each accessory is created as a SKU with variant_type='accessory' under
 * the same product_id as its parent flooring product, so it appears in
 * the "Matching Accessories" section on the storefront.
 *
 * Usage: docker compose exec api node scripts/add-johnson-accessories.js
 */

import pg from 'pg';

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: 5432,
  database: 'flooring_pim',
  user: 'postgres',
  password: 'postgres',
});

// ==================== Accessory price data from PDF ====================

// Tuscan Walnut has different (higher) accessory prices — exact match first
const WALNUT_SKUS = new Set(['AME-E46705', 'AME-E46706']);
const WALNUT_PRICES = { tMold: 84, threshold: 84, reducer: 84, quarterRound: 54, stairNose: 114 };

// Prefix-based matching for all other series
// Engineered Hardwood: T-Mold/Threshold/Reducer are 78", Quarter Round/Stair Nose are 84"
// SPC & HPF: all accessories are 94"
const PREFIX_RULES = [
  // --- Engineered Hardwood (type: 'hardwood') ---
  { prefix: 'AME-AHM',  type: 'hardwood', tMold: 66, threshold: 66, reducer: 66, quarterRound: 48, stairNose: 91 },   // Alehouse Maple
  { prefix: 'AME-AHO',  type: 'hardwood', tMold: 69, threshold: 69, reducer: 69, quarterRound: 48, stairNose: 93 },   // Alehouse Oak
  { prefix: 'AME-EM19', type: 'hardwood', tMold: 66, threshold: 66, reducer: 66, quarterRound: 48, stairNose: 91 },   // English Pub Maple
  { prefix: 'AME-EH',   type: 'hardwood', tMold: 67, threshold: 67, reducer: 67, quarterRound: 48, stairNose: 91 },   // English Pub Hickory HS
  { prefix: 'AME-ESH',  type: 'hardwood', tMold: 67, threshold: 67, reducer: 67, quarterRound: 48, stairNose: 91 },   // English Pub Hickory Smooth
  { prefix: 'AME-GC',   type: 'hardwood', tMold: 69, threshold: 69, reducer: 69, quarterRound: 48, stairNose: 93 },   // Grand Chateau
  { prefix: 'AME-OG',   type: 'hardwood', tMold: 69, threshold: 69, reducer: 69, quarterRound: 48, stairNose: 93 },   // Oak Grove (standard + Prime)
  { prefix: 'AME-E467', type: 'hardwood', tMold: 67, threshold: 67, reducer: 67, quarterRound: 48, stairNose: 91 },   // Tuscan Hickory (all sub-groups)
  { prefix: 'AME-EM46', type: 'hardwood', tMold: 67, threshold: 67, reducer: 67, quarterRound: 48, stairNose: 91 },   // Tuscan Maple
  { prefix: 'AME-CRH',  type: 'hardwood', tMold: 67, threshold: 67, reducer: 67, quarterRound: 48, stairNose: 91 },   // Canyon Ridge
  { prefix: 'AME-CSO',  type: 'hardwood', tMold: 69, threshold: 69, reducer: 69, quarterRound: 48, stairNose: 93 },   // Countryside Oak
  { prefix: 'PL-OL',    type: 'hardwood', tMold: 69, threshold: 69, reducer: 69, quarterRound: 48, stairNose: 93 },   // Olympus
  { prefix: 'AME-TTO',  type: 'hardwood', tMold: 69, threshold: 69, reducer: 69, quarterRound: 48, stairNose: 93 },   // Texas Timber

  // --- SPC standard (type: 'spc') ---
  { prefix: 'CELLAR-',  type: 'spc', tMold: 35, threshold: 35, reducer: 35, quarterRound: 25, flushSN: 55 },          // Cellar House
  { prefix: 'PHS-',     type: 'spc', tMold: 35, threshold: 35, reducer: 35, quarterRound: 25, flushSN: 55 },          // Public House
  { prefix: 'SV-',      type: 'spc', tMold: 35, threshold: 35, reducer: 35, quarterRound: 25, flushSN: 55 },          // Skyview

  // --- SPC special (type: 'spc-special') — different accessory types ---
  { prefix: 'FM-',      type: 'spc-special', threeInOne: 35, versaEdge: 45, quarterRound: 18, tMoldReducer: 35, flushSN: 55 },  // Farmhouse Manor
  { prefix: '3WS-',     type: 'spc-special', threeInOne: 35, versaEdge: 45, quarterRound: 18, tMoldReducer: 35, flushSN: 55 },  // Sicily

  // --- High Performance Flooring (type: 'hpf') ---
  { prefix: 'BVS-',     type: 'hpf', tMold: 35, threshold: 35, reducer: 35, quarterRound: 25, flushSN: 55 },          // Bella Vista
  { prefix: 'OTS-',     type: 'hpf', tMold: 35, threshold: 35, reducer: 35, quarterRound: 25, flushSN: 55 },          // Olde Tavern
];

function getAccessoryGroup(vendorSku) {
  // Exact match for Tuscan Walnut (higher prices)
  if (WALNUT_SKUS.has(vendorSku)) {
    return { type: 'hardwood', ...WALNUT_PRICES };
  }
  // Prefix matching
  for (const rule of PREFIX_RULES) {
    if (vendorSku.startsWith(rule.prefix)) {
      return rule;
    }
  }
  return null;
}

function buildAccessoryList(group) {
  if (group.type === 'hardwood') {
    return [
      { suffix: 'TMOLD',      name: 'T-Mold 78"',        cost: group.tMold },
      { suffix: 'THRESHOLD',  name: 'Threshold 78"',     cost: group.threshold },
      { suffix: 'REDUCER',    name: 'Reducer 78"',       cost: group.reducer },
      { suffix: 'QTR-ROUND',  name: 'Quarter Round 84"', cost: group.quarterRound },
      { suffix: 'STAIR-NOSE', name: 'Stair Nose 84"',    cost: group.stairNose },
    ];
  }
  if (group.type === 'spc' || group.type === 'hpf') {
    return [
      { suffix: 'TMOLD',      name: 'T-Mold 94"',           cost: group.tMold },
      { suffix: 'THRESHOLD',  name: 'Threshold 94"',        cost: group.threshold },
      { suffix: 'REDUCER',    name: 'Reducer 94"',          cost: group.reducer },
      { suffix: 'QTR-ROUND',  name: 'Quarter Round 94"',    cost: group.quarterRound },
      { suffix: 'FLUSH-SN',   name: 'Flush Stair Nose 94"', cost: group.flushSN },
    ];
  }
  if (group.type === 'spc-special') {
    return [
      { suffix: '3IN1',        name: '3-in-1 Transition 94"', cost: group.threeInOne },
      { suffix: 'VERSA-EDGE',  name: 'Versa Edge 94"',        cost: group.versaEdge },
      { suffix: 'QTR-ROUND',   name: 'Quarter Round 94"',     cost: group.quarterRound },
      { suffix: 'TM-RD',       name: 'T-Mold/Reducer 94"',    cost: group.tMoldReducer },
      { suffix: 'FLUSH-SN',    name: 'Flush Stair Nose 94"',  cost: group.flushSN },
    ];
  }
  return [];
}

// ==================== DB helpers ====================

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

async function upsertPricing(skuId, cost) {
  await pool.query(`
    INSERT INTO pricing (sku_id, cost, retail_price, price_basis)
    VALUES ($1, $2, $3, 'per_unit')
    ON CONFLICT (sku_id) DO UPDATE SET
      cost = EXCLUDED.cost,
      retail_price = EXCLUDED.retail_price,
      price_basis = 'per_unit'
  `, [skuId, cost, (cost * 2.0).toFixed(2)]);
}

// ==================== Main ====================

async function main() {
  // Get vendor
  const vendorRes = await pool.query("SELECT id FROM vendors WHERE code = 'JOHNSONHW'");
  if (!vendorRes.rows.length) {
    console.error('Johnson Hardwood vendor not found. Run import-johnson-hardwood.js first.');
    process.exit(1);
  }
  const vendorId = vendorRes.rows[0].id;

  // Get all existing flooring SKUs (non-accessory)
  const flooringSkus = await pool.query(`
    SELECT s.id AS sku_id, s.vendor_sku, s.product_id, p.name AS product_name, p.collection
    FROM skus s
    JOIN products p ON p.id = s.product_id
    WHERE p.vendor_id = $1
      AND (s.variant_type IS NULL OR s.variant_type != 'accessory')
    ORDER BY p.collection, p.name
  `, [vendorId]);

  console.log(`Found ${flooringSkus.rowCount} flooring SKUs to add accessories to\n`);

  let accessoriesCreated = 0;
  let accessoriesUpdated = 0;
  let skipped = 0;

  for (const row of flooringSkus.rows) {
    const group = getAccessoryGroup(row.vendor_sku);
    if (!group) {
      console.log(`  [SKIP] No accessory mapping for ${row.vendor_sku} (${row.product_name})`);
      skipped++;
      continue;
    }

    const accessories = buildAccessoryList(group);

    for (const acc of accessories) {
      const accVendorSku = `${row.vendor_sku}-${acc.suffix}`;
      const accInternalSku = `JH-${row.vendor_sku}-${acc.suffix}`;

      const sku = await upsertAccessorySku(row.product_id, {
        vendorSku: accVendorSku,
        internalSku: accInternalSku,
        variantName: acc.name,
      });

      await upsertPricing(sku.id, acc.cost);

      if (sku.is_new) accessoriesCreated++;
      else accessoriesUpdated++;
    }

    console.log(`  ${row.product_name} (${row.collection}) — ${accessories.length} accessories`);
  }

  console.log('\n=== Accessory Import Complete ===');
  console.log(`Accessories created: ${accessoriesCreated}`);
  console.log(`Accessories updated: ${accessoriesUpdated}`);
  console.log(`Flooring SKUs skipped: ${skipped}`);
  console.log(`Total accessory SKUs: ${accessoriesCreated + accessoriesUpdated}`);

  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
