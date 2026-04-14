#!/usr/bin/env node

/**
 * Merge EF Pentz Pricing → PC Vendor SKUs
 *
 * Problem: The EF EDI 832 importer created duplicate products/SKUs under vendor EF
 * for Pentz items (internal_sku LIKE 'EF-1-%'). These have real pricing from EDI
 * but no images. The proper PC vendor products have images but $0 placeholder pricing.
 *
 * This script:
 *   1. Finds all EF SKUs with internal_sku LIKE 'EF-1-%' and their pricing
 *   2. Matches them to PC SKUs where pc.vendor_sku = REPLACE(ef.internal_sku, 'EF-', '')
 *   3. Copies pricing (cost, retail_price, etc.) to PC SKUs
 *   4. Sets matched EF products to status = 'draft' to hide from storefront
 *   5. Also fixes Pentz collection names from format type to base design name
 *
 * Usage:
 *   docker compose exec api node scripts/merge-ef-pentz-pricing.js
 *   docker compose exec api node scripts/merge-ef-pentz-pricing.js --dry-run
 */

import pg from 'pg';

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

const DRY_RUN = process.argv.includes('--dry-run');

/**
 * Derive collection name from product name by stripping format suffixes.
 * Must match the logic in import-pentz-commercial.js.
 */
function deriveCollection(name) {
  if (!name) return '';
  let s = name.trim();
  s = s.replace(/\s+Broadloom$/i, '');
  s = s.replace(/\s+Plank$/i, '');
  s = s.replace(/\s+LVT$/i, '');
  s = s.replace(/\s+\d{2}$/, '');       // broadloom widths
  s = s.replace(/\s+Plus$/i, '');        // LVT variants
  return s.trim() || name.trim();
}

async function main() {
  console.log(`=== Merge EF Pentz Pricing → PC SKUs ===${DRY_RUN ? ' [DRY RUN]' : ''}\n`);

  // ── Step 1: Fix Pentz collection names on PC vendor products ──────────────

  console.log('Step 1: Fixing Pentz collection names...');

  const pcVendor = await pool.query("SELECT id FROM vendors WHERE code = 'PC'");
  if (!pcVendor.rows.length) {
    console.error('ERROR: Vendor PC not found');
    await pool.end();
    process.exit(1);
  }
  const pcVendorId = pcVendor.rows[0].id;

  const pcProducts = await pool.query(
    'SELECT id, name, collection FROM products WHERE vendor_id = $1',
    [pcVendorId]
  );

  // Build a set of existing (collection, name) combos to detect conflicts
  const existingKeys = new Set();
  for (const prod of pcProducts.rows) {
    existingKeys.add(`${prod.collection}|||${prod.name}`);
  }

  let collectionsFixed = 0, collectionsSkipped = 0;
  for (const prod of pcProducts.rows) {
    const newCollection = deriveCollection(prod.name);
    if (newCollection !== prod.collection) {
      const targetKey = `${newCollection}|||${prod.name}`;
      if (existingKeys.has(targetKey)) {
        console.log(`  SKIP "${prod.name}": "${prod.collection}" → "${newCollection}" (would conflict with existing product)`);
        collectionsSkipped++;
        continue;
      }
      if (!DRY_RUN) {
        await pool.query(
          'UPDATE products SET collection = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
          [newCollection, prod.id]
        );
      }
      // Update the tracking set so subsequent updates see the new state
      existingKeys.delete(`${prod.collection}|||${prod.name}`);
      existingKeys.add(targetKey);
      console.log(`  "${prod.name}": "${prod.collection}" → "${newCollection}"`);
      collectionsFixed++;
    }
  }
  console.log(`  Collections fixed: ${collectionsFixed}, skipped: ${collectionsSkipped}\n`);

  // ── Step 2: Transfer pricing from EF duplicates to PC SKUs ────────────────

  console.log('Step 2: Transferring pricing from EF → PC...');

  // Get all EF Pentz SKUs with their pricing
  const efSkus = await pool.query(`
    SELECT s.id AS ef_sku_id, s.internal_sku, s.product_id AS ef_product_id,
           p.cost, p.retail_price, p.price_basis, p.cut_price, p.roll_price,
           p.cut_cost, p.roll_cost, p.roll_min_sqft, p.map_price,
           p.sale_price, p.sale_ends_at
    FROM skus s
    JOIN pricing p ON p.sku_id = s.id
    WHERE s.internal_sku LIKE 'EF-1-%'
  `);
  console.log(`  Found ${efSkus.rows.length} EF Pentz SKUs with pricing`);

  let matched = 0, unmatched = 0, pricingUpdated = 0, pricingSkipped = 0;
  const efProductIds = new Set();

  for (const ef of efSkus.rows) {
    // Derive match key: strip 'EF-' prefix, then extract style+color parts
    const matchKey = ef.internal_sku.replace(/^EF-/, '');
    const parts = matchKey.split('-');
    // Format: 1-{style}-{color}-{size}-{suffix}
    const style = parts[1] || '';
    const color = parts[2] || '';

    // Find the corresponding PC SKU by style+color (suffixes differ between EF and PC)
    const pcSku = await pool.query(
      `SELECT s.id FROM skus s
       JOIN products pr ON pr.id = s.product_id
       WHERE split_part(s.vendor_sku, '-', 2) = $1
         AND split_part(s.vendor_sku, '-', 3) = $2
         AND pr.vendor_id = $3`,
      [style, color, pcVendorId]
    );

    if (!pcSku.rows.length) {
      unmatched++;
      continue;
    }

    matched++;
    efProductIds.add(ef.ef_product_id);
    const pcSkuId = pcSku.rows[0].id;

    // Only transfer if EF has non-zero pricing
    const hasPricing = parseFloat(ef.cost) > 0 || parseFloat(ef.retail_price) > 0;
    if (!hasPricing) {
      pricingSkipped++;
      continue;
    }

    if (!DRY_RUN) {
      await pool.query(`
        INSERT INTO pricing (sku_id, cost, retail_price, price_basis, cut_price, roll_price,
                             cut_cost, roll_cost, roll_min_sqft, map_price, sale_price, sale_ends_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        ON CONFLICT (sku_id) DO UPDATE SET
          cost = EXCLUDED.cost,
          retail_price = EXCLUDED.retail_price,
          price_basis = COALESCE(EXCLUDED.price_basis, pricing.price_basis),
          cut_price = COALESCE(EXCLUDED.cut_price, pricing.cut_price),
          roll_price = COALESCE(EXCLUDED.roll_price, pricing.roll_price),
          cut_cost = COALESCE(EXCLUDED.cut_cost, pricing.cut_cost),
          roll_cost = COALESCE(EXCLUDED.roll_cost, pricing.roll_cost),
          roll_min_sqft = COALESCE(EXCLUDED.roll_min_sqft, pricing.roll_min_sqft),
          map_price = COALESCE(EXCLUDED.map_price, pricing.map_price),
          sale_price = COALESCE(EXCLUDED.sale_price, pricing.sale_price),
          sale_ends_at = COALESCE(EXCLUDED.sale_ends_at, pricing.sale_ends_at)
      `, [
        pcSkuId, ef.cost, ef.retail_price, ef.price_basis,
        ef.cut_price, ef.roll_price, ef.cut_cost, ef.roll_cost,
        ef.roll_min_sqft, ef.map_price, ef.sale_price, ef.sale_ends_at,
      ]);
    }
    pricingUpdated++;
  }

  console.log(`  Matched: ${matched} | Unmatched: ${unmatched}`);
  console.log(`  Pricing transferred: ${pricingUpdated} | Skipped (zero pricing): ${pricingSkipped}\n`);

  // ── Step 3: Set EF duplicate products to draft ────────────────────────────

  console.log('Step 3: Setting EF duplicate products to draft...');

  const efProductIdArray = Array.from(efProductIds);
  if (efProductIdArray.length > 0 && !DRY_RUN) {
    const result = await pool.query(
      `UPDATE products SET status = 'draft', updated_at = CURRENT_TIMESTAMP
       WHERE id = ANY($1) AND status != 'draft'`,
      [efProductIdArray]
    );
    console.log(`  Set ${result.rowCount} EF products to draft (of ${efProductIdArray.length} matched)`);
  } else {
    console.log(`  ${DRY_RUN ? '[DRY RUN] Would set' : 'No'} ${efProductIdArray.length} EF products to draft`);
  }

  console.log('\n=== Done ===');
  await pool.end();
}

main().catch(err => {
  console.error('Merge failed:', err);
  pool.end();
  process.exit(1);
});
