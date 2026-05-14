#!/usr/bin/env node

/**
 * Fix EF (Engineered Floors) Pricing & Packaging Data
 *
 * Problem: Broadloom SKUs have roll_price/cut_price set to vendor cost (no retail markup).
 *          LVP/LVT SKUs with very low cost have inadequate 2× markup.
 *
 * Phase 1: Fix broadloom roll_price / cut_price / cut_cost (2,210 SKUs)
 * Phase 2: Increase LVP/LVT retail markup for cheap SKUs (267 SKUs)
 * Phase 3: Fill missing cut_price (47 SKUs — handled by Phase 1 Step 3)
 *
 * Usage:
 *   node backend/scripts/fix-ef-pricing.cjs [--dry-run]
 *   docker compose exec api node scripts/fix-ef-pricing.cjs [--dry-run]
 */

const pg = require('pg');

const DRY_RUN = process.argv.includes('--dry-run');

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

async function main() {
  console.log(`EF Pricing Fix — ${DRY_RUN ? 'DRY RUN' : 'LIVE'}\n`);

  // Verify EF vendor exists
  const vendorRes = await pool.query("SELECT id FROM vendors WHERE code = 'EF'");
  if (!vendorRes.rows.length) {
    console.error('EF vendor not found in DB');
    process.exit(1);
  }
  const vendorId = vendorRes.rows[0].id;

  // ════════════════════════════════════════════════════
  // Phase 1: Fix broadloom roll_price / cut_price / cut_cost
  // ════════════════════════════════════════════════════
  console.log('═══ Phase 1: Fix broadloom pricing (sqyd SKUs) ═══\n');

  // Find all EF broadloom SKUs (sell_by = 'sqyd')
  const broadloomRes = await pool.query(`
    SELECT s.id AS sku_id, s.vendor_sku, s.variant_name,
           pr.cost, pr.retail_price, pr.roll_cost, pr.roll_price,
           pr.cut_cost, pr.cut_price
    FROM skus s
    JOIN products p ON s.product_id = p.id
    JOIN pricing pr ON pr.sku_id = s.id
    WHERE p.vendor_id = $1
      AND s.status = 'active'
      AND s.sell_by = 'sqyd'
  `, [vendorId]);

  console.log(`Found ${broadloomRes.rows.length} broadloom SKUs\n`);

  // Identify SKUs where cut_price > roll_price (vendor charges a cut surcharge)
  const surchargeSkus = broadloomRes.rows.filter(r =>
    r.cut_price !== null && parseFloat(r.cut_price) > parseFloat(r.roll_price)
  );
  const noSurchargeSkus = broadloomRes.rows.filter(r =>
    r.cut_price === null || parseFloat(r.cut_price) <= parseFloat(r.roll_price)
  );

  console.log(`  Surcharge SKUs (cut_price > roll_price): ${surchargeSkus.length}`);
  console.log(`  No-surcharge / NULL cut_price SKUs: ${noSurchargeSkus.length}\n`);

  // Step 1: For surcharge SKUs, move vendor cut cost from cut_price into cut_cost
  // (before we overwrite cut_price with retail)
  let step1Count = 0;
  for (const row of surchargeSkus) {
    const vendorCutCost = parseFloat(row.cut_price); // current cut_price IS the vendor cut cost

    if (DRY_RUN) {
      if (step1Count < 5) {
        console.log(`  [DRY] Step 1: ${row.vendor_sku} — cut_cost: ${row.cut_cost} → ${vendorCutCost.toFixed(2)}`);
      }
    } else {
      await pool.query(
        'UPDATE pricing SET cut_cost = $1 WHERE sku_id = $2',
        [vendorCutCost, row.sku_id]
      );
    }
    step1Count++;
  }
  console.log(`  Step 1 — Set cut_cost from cut_price: ${step1Count} SKUs${DRY_RUN ? ' (dry run)' : ''}\n`);

  // Step 2: Fix roll_price = retail_price × 9 for ALL broadloom
  let step2Count = 0;
  for (const row of broadloomRes.rows) {
    const retailPrice = parseFloat(row.retail_price);
    const newRollPrice = Math.round(retailPrice * 9 * 100) / 100;
    const oldRollPrice = parseFloat(row.roll_price);

    if (DRY_RUN) {
      if (step2Count < 5) {
        console.log(`  [DRY] Step 2: ${row.vendor_sku} — roll_price: ${oldRollPrice.toFixed(2)} → ${newRollPrice.toFixed(2)} (retail ${retailPrice.toFixed(4)}/sqft × 9)`);
      }
    } else {
      await pool.query(
        'UPDATE pricing SET roll_price = $1 WHERE sku_id = $2',
        [newRollPrice, row.sku_id]
      );
    }
    step2Count++;
  }
  console.log(`  Step 2 — Set roll_price = retail_price × 9: ${step2Count} SKUs${DRY_RUN ? ' (dry run)' : ''}\n`);

  // Step 3: Fix cut_price
  // For surcharge SKUs: cut_price = cut_cost × (retail_price / cost) — preserves surcharge + adds retail markup
  // For no-surcharge / NULL: cut_price = roll_price (= retail_price × 9)
  let step3Surcharge = 0, step3NoSurcharge = 0;

  for (const row of surchargeSkus) {
    const cost = parseFloat(row.cost);
    const retailPrice = parseFloat(row.retail_price);
    const vendorCutCost = parseFloat(row.cut_price); // we already saved this to cut_cost in Step 1
    const marginRatio = cost > 0 ? retailPrice / cost : 2;
    const newCutPrice = Math.round(vendorCutCost * marginRatio * 100) / 100;

    if (DRY_RUN) {
      if (step3Surcharge < 5) {
        console.log(`  [DRY] Step 3 (surcharge): ${row.vendor_sku} — cut_price: ${parseFloat(row.cut_price).toFixed(2)} → ${newCutPrice.toFixed(2)} (cut_cost ${vendorCutCost.toFixed(2)} × margin ${marginRatio.toFixed(2)})`);
      }
    } else {
      await pool.query(
        'UPDATE pricing SET cut_price = $1 WHERE sku_id = $2',
        [newCutPrice, row.sku_id]
      );
    }
    step3Surcharge++;
  }

  for (const row of noSurchargeSkus) {
    const retailPrice = parseFloat(row.retail_price);
    const newRollPrice = Math.round(retailPrice * 9 * 100) / 100; // same as Step 2

    if (DRY_RUN) {
      if (step3NoSurcharge < 5) {
        console.log(`  [DRY] Step 3 (no-surcharge): ${row.vendor_sku} — cut_price: ${row.cut_price || 'NULL'} → ${newRollPrice.toFixed(2)} (= roll_price)`);
      }
    } else {
      await pool.query(
        'UPDATE pricing SET cut_price = $1 WHERE sku_id = $2',
        [newRollPrice, row.sku_id]
      );
    }
    step3NoSurcharge++;
  }
  console.log(`  Step 3 — Set cut_price: ${step3Surcharge} surcharge + ${step3NoSurcharge} no-surcharge = ${step3Surcharge + step3NoSurcharge} SKUs${DRY_RUN ? ' (dry run)' : ''}\n`);

  // ════════════════════════════════════════════════════
  // Phase 2: Increase LVP/LVT retail markup for cheap SKUs
  // ════════════════════════════════════════════════════
  console.log('═══ Phase 2: Increase LVP/LVT markup (sqft SKUs with retail < $0.50) ═══\n');

  const lvpRes = await pool.query(`
    SELECT s.id AS sku_id, s.vendor_sku, s.variant_name,
           pr.cost, pr.retail_price
    FROM skus s
    JOIN products p ON s.product_id = p.id
    JOIN pricing pr ON pr.sku_id = s.id
    WHERE p.vendor_id = $1
      AND s.status = 'active'
      AND s.sell_by = 'sqft'
      AND pr.retail_price < 0.50
      AND pr.cost > 0
  `, [vendorId]);

  console.log(`Found ${lvpRes.rows.length} LVP/LVT SKUs with retail < $0.50\n`);

  let phase2Count = 0;
  for (const row of lvpRes.rows) {
    const cost = parseFloat(row.cost);
    const oldRetail = parseFloat(row.retail_price);
    const newRetail = Math.round(cost * 4 * 100) / 100;

    if (DRY_RUN) {
      if (phase2Count < 10) {
        console.log(`  [DRY] ${row.vendor_sku} — retail: $${oldRetail.toFixed(2)} → $${newRetail.toFixed(2)} (cost $${cost.toFixed(2)} × 4)`);
      }
    } else {
      await pool.query(
        'UPDATE pricing SET retail_price = $1 WHERE sku_id = $2',
        [newRetail, row.sku_id]
      );
    }
    phase2Count++;
  }
  console.log(`  Phase 2 — Updated retail markup: ${phase2Count} SKUs${DRY_RUN ? ' (dry run)' : ''}\n`);

  // ════════════════════════════════════════════════════
  // Phase 3: Remove roll dimensions from broadloom size attributes
  // ════════════════════════════════════════════════════
  // Roll dimensions (e.g., "12' x 150'") are packaging data, not product attributes.
  // They cause display names like "Astounding Rockwell 12x150 I Carpet".
  // Delete size attribute for all sqyd SKUs across ALL vendors.
  console.log('═══ Phase 3: Remove roll-dimension size attributes from broadloom SKUs ═══\n');

  const rollSizeRes = await pool.query(`
    SELECT sa.sku_id, sa.value, s.vendor_sku
    FROM sku_attributes sa
    JOIN attributes a ON a.id = sa.attribute_id AND a.slug = 'size'
    JOIN skus s ON s.id = sa.sku_id
    WHERE s.sell_by = 'sqyd' AND s.status = 'active'
  `);

  console.log(`Found ${rollSizeRes.rows.length} broadloom SKUs with size attribute\n`);

  let phase3Count = 0;
  for (const row of rollSizeRes.rows) {
    if (DRY_RUN) {
      if (phase3Count < 10) {
        console.log(`  [DRY] Delete size="${row.value}" from ${row.vendor_sku}`);
      }
    } else {
      await pool.query(`
        DELETE FROM sku_attributes
        WHERE sku_id = $1
          AND attribute_id = (SELECT id FROM attributes WHERE slug = 'size')
      `, [row.sku_id]);
    }
    phase3Count++;
  }
  console.log(`  Phase 3 — Removed size attribute: ${phase3Count} broadloom SKUs${DRY_RUN ? ' (dry run)' : ''}\n`);

  // ════════════════════════════════════════════════════
  // Phase 4: Merge duplicate EF products with dimensions in name
  // ════════════════════════════════════════════════════
  // Products like "Gallatin Plus 6.99 X 48" and "Gallatin Plus 7 X 48" should be
  // one product "Gallatin Plus". Merge SKUs from the dimension-named duplicate
  // into the clean-named product.
  console.log('═══ Phase 4: Merge EF products with stale dimensions in name ═══\n');

  const dimRegex = /\s+\d+\.?\d*"?\s*[xX×]\s*\d+\.?\d*"?/gi;

  const efProducts = await pool.query(`
    SELECT p.id, p.name, p.collection, p.category_id, p.status
    FROM products p
    WHERE p.vendor_id = $1
    ORDER BY p.name
  `, [vendorId]);

  // Find products whose name still contains dimensions
  const dimProducts = efProducts.rows.filter(p => dimRegex.test(p.name));
  // Reset lastIndex since we're reusing the regex
  dimRegex.lastIndex = 0;

  let phase4Merged = 0;
  for (const dimProd of dimProducts) {
    const cleanName = dimProd.name.replace(dimRegex, '').replace(/\s{2,}/g, ' ').trim();
    dimRegex.lastIndex = 0;
    if (!cleanName || cleanName === dimProd.name) continue;

    // Find the canonical product (same vendor, collection, clean name)
    const canonical = await pool.query(`
      SELECT id, name FROM products
      WHERE vendor_id = $1 AND collection = $2 AND name = $3 AND id != $4
    `, [vendorId, dimProd.collection || '', cleanName, dimProd.id]);

    if (canonical.rows.length === 0) {
      // No canonical product exists — just rename this one
      if (DRY_RUN) {
        if (phase4Merged < 10) {
          console.log(`  [DRY] Rename: "${dimProd.name}" → "${cleanName}"`);
        }
      } else {
        await pool.query('UPDATE products SET name = $1, updated_at = NOW() WHERE id = $2', [cleanName, dimProd.id]);
      }
      phase4Merged++;
    } else {
      // Canonical exists — move SKUs from the duplicate to the canonical
      const canonicalId = canonical.rows[0].id;
      if (DRY_RUN) {
        const skuCount = await pool.query('SELECT COUNT(*) AS c FROM skus WHERE product_id = $1', [dimProd.id]);
        if (phase4Merged < 10) {
          console.log(`  [DRY] Merge: "${dimProd.name}" (${skuCount.rows[0].c} SKUs) → "${canonical.rows[0].name}" (id ${canonicalId})`);
        }
      } else {
        // Move all SKUs to canonical product
        await pool.query('UPDATE skus SET product_id = $1, updated_at = NOW() WHERE product_id = $2', [canonicalId, dimProd.id]);
        // Move media assets
        await pool.query('UPDATE media_assets SET product_id = $1 WHERE product_id = $2 AND sku_id IS NULL', [canonicalId, dimProd.id]);
        // Delete the empty duplicate product
        await pool.query('DELETE FROM products WHERE id = $1', [dimProd.id]);
      }
      phase4Merged++;
    }
  }
  console.log(`  Phase 4 — Merged/renamed: ${phase4Merged} products with dimension names${DRY_RUN ? ' (dry run)' : ''}\n`);

  // ════════════════════════════════════════════════════
  // Phase 5: Deactivate EF-side duplicates that also exist under PC (Pentz Commercial)
  // ════════════════════════════════════════════════════
  // Pentz Commercial is a brand under Engineered Floors. The PC vendor import
  // creates its own SKUs with richer media (5× more images). The EF 832 EDI import
  // also creates SKUs for the same products because the brand field isn't populated.
  // Deactivate the EF side — the PC records have better data and are the correct home.
  console.log('═══ Phase 5: Deactivate EF SKUs duplicated under PC (Pentz Commercial) ═══\n');

  const pcVendorRes = await pool.query("SELECT id FROM vendors WHERE code = 'PC'");
  let phase5Skus = 0, phase5Products = 0;

  if (!pcVendorRes.rows.length) {
    console.log('  PC vendor not found — skipping Phase 5\n');
  } else {
    const pcVendorId = pcVendorRes.rows[0].id;

    // Find EF SKUs whose vendor_sku also exists under PC
    const dupSkus = await pool.query(`
      SELECT s_ef.id AS ef_sku_id, s_ef.vendor_sku, s_ef.product_id AS ef_product_id,
             p_ef.name AS ef_product_name, p_ef.collection AS ef_collection
      FROM skus s_ef
      JOIN products p_ef ON p_ef.id = s_ef.product_id AND p_ef.vendor_id = $1
      WHERE s_ef.status = 'active'
        AND s_ef.vendor_sku IN (
          SELECT s_pc.vendor_sku
          FROM skus s_pc
          JOIN products p_pc ON p_pc.id = s_pc.product_id AND p_pc.vendor_id = $2
          WHERE s_pc.status = 'active'
        )
    `, [vendorId, pcVendorId]);

    console.log(`  Found ${dupSkus.rows.length} EF SKUs with matching PC vendor_sku\n`);

    // Deactivate the EF-side duplicates
    const efSkuIds = dupSkus.rows.map(r => r.ef_sku_id);

    if (efSkuIds.length > 0) {
      if (DRY_RUN) {
        for (let i = 0; i < Math.min(10, dupSkus.rows.length); i++) {
          const r = dupSkus.rows[i];
          console.log(`  [DRY] Deactivate EF SKU ${r.vendor_sku} (${r.ef_collection} / ${r.ef_product_name})`);
        }
        if (dupSkus.rows.length > 10) console.log(`  ... and ${dupSkus.rows.length - 10} more`);
      } else {
        await pool.query(`
          UPDATE skus SET status = 'inactive', updated_at = NOW()
          WHERE id = ANY($1::uuid[])
        `, [efSkuIds]);
      }
      phase5Skus = efSkuIds.length;

      // Deactivate EF products that now have zero active SKUs
      const affectedProductIds = [...new Set(dupSkus.rows.map(r => r.ef_product_id))];

      // In dry-run, simulate by checking if all active SKUs of a product are in our deactivation list
      const emptyProducts = await pool.query(`
        SELECT p.id, p.name, p.collection
        FROM products p
        WHERE p.id = ANY($1::uuid[])
          AND p.vendor_id = $2
          AND NOT EXISTS (
            SELECT 1 FROM skus s WHERE s.product_id = p.id AND s.status = 'active'
            ${DRY_RUN ? "AND s.id != ALL($3::uuid[])" : ''}
          )
      `, DRY_RUN ? [affectedProductIds, vendorId, efSkuIds] : [affectedProductIds, vendorId]);

      if (emptyProducts.rows.length > 0) {
        if (DRY_RUN) {
          for (const p of emptyProducts.rows.slice(0, 5)) {
            console.log(`  [DRY] Deactivate empty EF product: "${p.collection} / ${p.name}"`);
          }
          if (emptyProducts.rows.length > 5) console.log(`  ... and ${emptyProducts.rows.length - 5} more products`);
        } else {
          await pool.query(`
            UPDATE products SET status = 'inactive', is_active = false, updated_at = NOW()
            WHERE id = ANY($1::uuid[])
          `, [emptyProducts.rows.map(p => p.id)]);
        }
        phase5Products = emptyProducts.rows.length;
      }
    }
    console.log(`  Phase 5 — Deactivated: ${phase5Skus} EF SKUs, ${phase5Products} empty products${DRY_RUN ? ' (dry run)' : ''}\n`);
  }

  // ════════════════════════════════════════════════════
  // Summary & Verification
  // ════════════════════════════════════════════════════
  console.log('\n═══════════════════════════════════════════');
  console.log('  EF Pricing Fix Summary');
  console.log('═══════════════════════════════════════════');
  console.log(`Mode:                   ${DRY_RUN ? 'DRY RUN (no DB writes)' : 'LIVE'}`);
  console.log(`Phase 1 — Broadloom:    ${broadloomRes.rows.length} SKUs`);
  console.log(`  Step 1 (cut_cost):    ${step1Count}`);
  console.log(`  Step 2 (roll_price):  ${step2Count}`);
  console.log(`  Step 3 (cut_price):   ${step3Surcharge + step3NoSurcharge} (${step3Surcharge} surcharge + ${step3NoSurcharge} no-surcharge)`);
  console.log(`Phase 2 — LVP/LVT:     ${phase2Count} SKUs (2× → 4× markup)`);
  console.log(`Phase 3 — Size attrs:   ${phase3Count} broadloom SKUs cleaned`);
  console.log(`Phase 4 — Dedup:        ${phase4Merged} products merged/renamed`);
  console.log(`Phase 5 — EF/PC dedup:  ${phase5Skus} SKUs, ${phase5Products} products deactivated`);
  console.log('═══════════════════════════════════════════\n');

  if (!DRY_RUN) {
    // Verify broadloom: roll_price should NOT equal roll_cost
    const verifyBroadloom = await pool.query(`
      SELECT COUNT(*) AS total,
             COUNT(*) FILTER (WHERE pr.roll_price = pr.roll_cost) AS still_equal,
             COUNT(*) FILTER (WHERE pr.roll_price > pr.roll_cost) AS has_markup,
             COUNT(*) FILTER (WHERE pr.cut_price IS NULL) AS null_cut_price
      FROM skus s
      JOIN products p ON s.product_id = p.id
      JOIN pricing pr ON pr.sku_id = s.id
      WHERE p.vendor_id = $1 AND s.status = 'active' AND s.sell_by = 'sqyd'
    `, [vendorId]);
    const vb = verifyBroadloom.rows[0];
    console.log('Verification — Broadloom:');
    console.log(`  Total sqyd SKUs:         ${vb.total}`);
    console.log(`  roll_price = roll_cost:   ${vb.still_equal} (should be 0)`);
    console.log(`  roll_price > roll_cost:   ${vb.has_markup} (should equal total)`);
    console.log(`  NULL cut_price:           ${vb.null_cut_price} (should be 0)\n`);

    // Verify LVP: no retail < $0.50
    const verifyLvp = await pool.query(`
      SELECT COUNT(*) AS low_retail
      FROM skus s
      JOIN products p ON s.product_id = p.id
      JOIN pricing pr ON pr.sku_id = s.id
      WHERE p.vendor_id = $1 AND s.status = 'active' AND s.sell_by = 'sqft'
        AND pr.retail_price < 0.50
    `, [vendorId]);
    console.log('Verification — LVP/LVT:');
    console.log(`  SKUs with retail < $0.50: ${verifyLvp.rows[0].low_retail} (should be 0)\n`);

    // Sample a broadloom SKU
    const sample = await pool.query(`
      SELECT s.vendor_sku, pr.cost, pr.retail_price,
             pr.roll_cost, pr.roll_price, pr.cut_cost, pr.cut_price
      FROM skus s
      JOIN products p ON s.product_id = p.id
      JOIN pricing pr ON pr.sku_id = s.id
      WHERE p.vendor_id = $1 AND s.status = 'active' AND s.sell_by = 'sqyd'
      LIMIT 3
    `, [vendorId]);
    console.log('Sample broadloom SKUs:');
    for (const s of sample.rows) {
      console.log(`  ${s.vendor_sku}: cost=$${parseFloat(s.cost).toFixed(4)}/sqft retail=$${parseFloat(s.retail_price).toFixed(4)}/sqft roll_cost=$${parseFloat(s.roll_cost).toFixed(2)}/sqyd roll_price=$${parseFloat(s.roll_price).toFixed(2)}/sqyd cut_cost=${s.cut_cost ? '$' + parseFloat(s.cut_cost).toFixed(2) : 'NULL'}/sqyd cut_price=$${parseFloat(s.cut_price).toFixed(2)}/sqyd`);
    }
  }

  await pool.end();
}

main().catch(err => {
  console.error('Fix failed:', err);
  process.exit(1);
});
