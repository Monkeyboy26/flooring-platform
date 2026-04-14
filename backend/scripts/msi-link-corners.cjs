#!/usr/bin/env node
/**
 * MSI Corner Accessory Linking Script
 *
 * Re-parents standalone MSI ledger/stacked stone corner products under their
 * matching panel products so they appear as "Matching Accessories" on the
 * storefront via same_product_siblings.
 *
 * Corner SKUs are identified by vendor_sku patterns containing "COR" and
 * matched to panel SKUs via vendor_sku transformations:
 *
 *   Pattern            | Transformation          | Example
 *   -------------------|-------------------------|-------------------------------
 *   *-COR              | strip -COR              | LVENDFOSRUSLED-COR → LVENDFOSRUSLED
 *   *618COR            | 618COR → 624            | LPNLQARCWHI618COR → LPNLQARCWHI624
 *   *918COR            | 918COR → 924            | LPNLQARCWHI918COR → LPNLQARCWHI924
 *   *618COR-{suffix}   | 618COR → 624            | LPNLMARCWHI618COR-3DH → LPNLMARCWHI624-3DH
 *   *4.59COR-MINI      | 4.59COR-MINI → 4.516    | LPNLMALAGRY4.59COR-MINI → LPNLMALAGRY4.516
 *   *4COR (Terrado)    | 4COR → 5 or 6           | LPNLEASHSHA4COR → LPNLEASHSHA5
 *   *66COR             | 66COR → 66              | LPNLQSEDGRY66COR → LPNLQSEDGRY66
 *   LVEN*COR           | strip trailing COR       | LVENECOTWHICOR → LVENECOTWHI
 *   SMOT-CLACOR-*      | strip COR from mid       | SMOT-CLACOR-ALPWHI → SMOT-CLA-ALPWHI
 *
 * Usage:
 *   node backend/scripts/msi-link-corners.cjs --dry-run   # Preview only
 *   node backend/scripts/msi-link-corners.cjs             # Execute
 */

const { Pool } = require('pg');

const DRY_RUN = process.argv.includes('--dry-run');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

// ---------------------------------------------------------------------------
// Vendor SKU → candidate panel SKUs
// ---------------------------------------------------------------------------

// SKU prefixes that are NOT corners despite containing "COR"
const FALSE_POSITIVE_PREFIXES = [
  'NCOR',      // Cordova product line
  'LPAVNCOR',  // Cordova pavers
  'LCOPNCOR',  // Cordova copings
  'NWGVIL',    // Village Coral
  'TCORONADO', // Coronado
  'VTWCOR',    // Coral Ash
];

function isCornerSku(vendorSku) {
  if (!vendorSku) return false;
  const upper = vendorSku.toUpperCase();
  // Check false positives
  for (const prefix of FALSE_POSITIVE_PREFIXES) {
    if (upper.startsWith(prefix)) return false;
  }
  // Coronado mosaic/subway
  if (upper.startsWith('SMOT-COR-')) return false;
  // Must contain COR in a corner-meaningful position
  return upper.includes('COR');
}

/**
 * Generate candidate panel vendor_skus from a corner vendor_sku.
 * Returns an array of possible panel SKUs to look up (in priority order).
 */
function cornerToPanelSkus(cornerSku) {
  const candidates = [];

  // Rule 1: -COR suffix (veneer corners)
  if (cornerSku.endsWith('-COR')) {
    candidates.push(cornerSku.slice(0, -4)); // strip -COR
    return candidates;
  }

  // Rule 2: 618COR with optional suffix (-3DH, -3DW, -MULTI)
  const match618 = cornerSku.match(/^(.+?)618COR(.*)$/);
  if (match618) {
    candidates.push(match618[1] + '624' + match618[2]);
    return candidates;
  }

  // Rule 3: 918COR suffix
  const match918 = cornerSku.match(/^(.+?)918COR$/);
  if (match918) {
    candidates.push(match918[1] + '924');
    return candidates;
  }

  // Rule 4: 4.59COR-MINI suffix
  if (cornerSku.endsWith('4.59COR-MINI')) {
    candidates.push(cornerSku.replace('4.59COR-MINI', '4.516'));
    return candidates;
  }

  // Rule 5: 4COR suffix (Terrado)
  const match4 = cornerSku.match(/^(.+?)4COR$/);
  if (match4) {
    candidates.push(match4[1] + '5');
    candidates.push(match4[1] + '6');
    return candidates;
  }

  // Rule 6: 66COR suffix (Sedona)
  if (cornerSku.endsWith('66COR')) {
    candidates.push(cornerSku.replace('66COR', '66'));
    return candidates;
  }

  // Rule 7: 624COR with suffix
  const match624 = cornerSku.match(/^(.+?)624COR(.+)$/);
  if (match624) {
    candidates.push(match624[1] + '624' + match624[2]);
    return candidates;
  }

  // Rule 8: LVEN*COR (loose veneer corners)
  if (cornerSku.startsWith('LVEN') && cornerSku.endsWith('COR')) {
    candidates.push(cornerSku.slice(0, -3)); // strip COR
    return candidates;
  }

  // Rule 9: SMOT-CLACOR-* (clay corners)
  if (cornerSku.includes('CLACOR')) {
    candidates.push(cornerSku.replace('CLACOR', 'CLA'));
    return candidates;
  }

  return candidates;
}

/**
 * Derive a short variant name for the corner accessory.
 * Goal: clean, concise label like "Corners", "L-Corner 6x18", "Corner Panel".
 */
function deriveVariantName(cornerDisplayName, panelDisplayName, cornerSku) {
  // Terrado corners → always "Corners"
  if (cornerSku.match(/^LPNLE.*4COR$/)) return 'Corners';
  // Veneer -COR and LVEN*COR corners
  if (cornerSku.endsWith('-COR') || (cornerSku.startsWith('LVEN') && cornerSku.endsWith('COR'))) {
    if (/sq.*rec/i.test(cornerDisplayName)) return 'Square & Rec Corners';
    return 'Corners';
  }

  // Rockmount: determine size from SKU pattern
  let size = '';
  if (/618COR/.test(cornerSku)) size = '6x18';
  else if (/918COR/.test(cornerSku)) size = '9x18';
  else if (/4\.59COR/.test(cornerSku)) size = '4.5x9';

  // Determine sub-type from SKU suffix
  let subtype = '';
  if (cornerSku.endsWith('-3DH')) subtype = '3D Honed';
  else if (cornerSku.endsWith('-3DW')) subtype = '3D Wave';
  else if (cornerSku.endsWith('-MULTI')) subtype = 'Multi Finish';
  else if (cornerSku.endsWith('-MINI')) subtype = 'Mini';

  const parts = ['L-Corner'];
  if (subtype) parts.push(subtype);
  if (size) parts.push(size);
  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`\nMSI Corner Accessory Linking${DRY_RUN ? ' (DRY RUN)' : ''}`);
  console.log('='.repeat(55) + '\n');

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. Get MSI vendor ID
    const { rows: [vendor] } = await client.query(
      `SELECT id FROM vendors WHERE code = 'MSI'`
    );
    if (!vendor) {
      console.log('ERROR: MSI vendor not found');
      return;
    }

    // 2. Fetch all active MSI SKUs with product info
    const { rows: allSkus } = await client.query(`
      SELECT s.id AS sku_id, s.vendor_sku, s.variant_type, s.variant_name, s.sell_by,
             p.id AS product_id, p.name, p.display_name, p.collection, p.status AS product_status
      FROM skus s
      JOIN products p ON s.product_id = p.id
      WHERE p.vendor_id = $1 AND s.status = 'active' AND p.status = 'active'
      ORDER BY s.vendor_sku
    `, [vendor.id]);

    console.log(`Total active MSI SKUs: ${allSkus.length}\n`);

    // 3. Build lookup: vendor_sku → SKU row
    const skuByVendorSku = new Map();
    for (const s of allSkus) {
      skuByVendorSku.set(s.vendor_sku, s);
    }

    // 4. Identify corner SKUs and match to panels
    const corners = allSkus.filter(s =>
      isCornerSku(s.vendor_sku) && s.variant_type !== 'accessory'
    );

    console.log(`Corner SKUs identified: ${corners.length}\n`);

    let matched = 0, unmatched = 0, skusMoved = 0, productsDeactivated = 0;
    const unmatchedList = [];
    const affectedParentIds = new Set();
    const emptyProductIds = new Set();

    for (const corner of corners) {
      const candidates = cornerToPanelSkus(corner.vendor_sku);
      let panel = null;

      for (const candidateSku of candidates) {
        panel = skuByVendorSku.get(candidateSku);
        if (panel && panel.product_id !== corner.product_id) break;
        panel = null;
      }

      if (!panel) {
        unmatched++;
        unmatchedList.push(
          `  ${corner.vendor_sku.padEnd(30)} ${(corner.display_name || corner.name).padEnd(50)} candidates: [${candidates.join(', ')}]`
        );
        continue;
      }

      matched++;
      affectedParentIds.add(panel.product_id);

      const cornerName = corner.display_name || corner.name;
      const panelName = panel.display_name || panel.name;
      const variantName = deriveVariantName(cornerName, panelName, corner.vendor_sku);

      console.log(`  ${corner.vendor_sku.padEnd(30)} → panel ${panel.vendor_sku.padEnd(25)} [variant: "${variantName}"]`);

      if (!DRY_RUN) {
        // Move corner SKU to the panel's product, mark as accessory
        await client.query(`
          UPDATE skus
          SET product_id = $1,
              variant_type = 'accessory',
              variant_name = $3,
              sell_by = 'unit',
              updated_at = NOW()
          WHERE id = $2
        `, [panel.product_id, corner.sku_id, variantName]);

        skusMoved++;

        // Check if corner's original product is now empty
        const { rows: [{ cnt }] } = await client.query(
          `SELECT COUNT(*) AS cnt FROM skus WHERE product_id = $1 AND status = 'active'`,
          [corner.product_id]
        );

        if (parseInt(cnt) === 0) {
          emptyProductIds.add(corner.product_id);
        }
      } else {
        skusMoved++;
      }
    }

    // 5. Deactivate empty product shells
    if (!DRY_RUN) {
      for (const pid of emptyProductIds) {
        await client.query(
          `UPDATE products SET status = 'discontinued', is_active = false, updated_at = NOW() WHERE id = $1`,
          [pid]
        );
        productsDeactivated++;
      }
    } else {
      productsDeactivated = emptyProductIds.size || matched; // estimate for dry run
    }

    // 6. Summary
    console.log(`\n${'='.repeat(55)}`);
    console.log(`SUMMARY${DRY_RUN ? ' (DRY RUN - no changes committed)' : ''}:`);
    console.log(`  Corner SKUs matched:        ${matched}`);
    console.log(`  SKUs moved & marked:        ${skusMoved}`);
    console.log(`  Products deactivated:       ${productsDeactivated}`);
    console.log(`  Unmatched (no panel found):  ${unmatched}`);

    if (unmatchedList.length > 0) {
      console.log(`\nUnmatched corners:`);
      for (const line of unmatchedList) console.log(line);
    }

    if (DRY_RUN) {
      await client.query('ROLLBACK');
      console.log('\nDry run complete — all changes rolled back.');
    } else {
      await client.query('COMMIT');
      console.log('\nAll changes committed successfully.');
    }

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('\nError:', err.message);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
