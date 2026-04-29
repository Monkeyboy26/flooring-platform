#!/usr/bin/env node
/**
 * msi-attach-accessories-v2.cjs
 *
 * Tags MSI accessory SKUs (bullnose, corners, quarter round, pencil/rail/crown
 * molding, shelf) with variant_type='accessory', sell_by='unit', and proper
 * variant_name + accessory_label.  Then populates the sku_accessories junction
 * table linking every main SKU in the same product to its accessory siblings.
 *
 * The MSI unified scraper already grouped accessories into their parent
 * products, so NO product_id moves are required — only tagging & linking.
 *
 * Usage:
 *   node backend/scripts/msi-attach-accessories-v2.cjs --dry-run
 *   node backend/scripts/msi-attach-accessories-v2.cjs
 */

const { Pool } = require('pg');

const DRY_RUN = process.argv.includes('--dry-run');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

// ─── Accessory detection by vendor_sku ──────────────────────────────────────

/**
 * Detect whether a vendor_sku is an accessory and return its label.
 * Returns null if not an accessory.
 */
function detectAccessoryBySku(vendorSku) {
  const sku = (vendorSku || '').toUpperCase();

  // Quatrefoil mosaic pattern — NOT an accessory (contains QTR but isn't quarter round)
  if (sku.includes('QTRFOIL')) return null;

  // Bullnose patterns: ...BN, ...BNP, ...BNP-N, ...BN-K, ...BN-N, ...BN-R, ...BNG, ...BNL-3D, ...BNM-N
  if (/BN[PGKLMR]?(?:-[A-Z0-9]+)?$/.test(sku)) return 'Bullnose';

  // Quarter round (Renzo): ...QTR
  if (/QTR$/.test(sku)) return 'Quarter Round';

  // Quarter round molding (SMOT-PT-QTRRD-...)
  if (sku.includes('QTRRD')) return 'Quarter Round';

  // Pencil molding (SMOT-PENCIL-...)
  if (sku.includes('PENCIL')) return 'Pencil Molding';

  // Corner shelf (SMOT-CSHELF-...)
  if (sku.includes('CSHELF')) return 'Corner Shelf';

  // Pen molding (THDW1-MP-...)
  if (/^THDW\d+-MP-/.test(sku)) return 'Pencil Molding';

  // Rail molding (THDW1-MR-...)
  if (/^THDW\d+-MR-/.test(sku)) return 'Rail Molding';

  // Crown molding (THDW3-MCR-...)
  if (/^THDW\d+-MCR-/.test(sku)) return 'Crown Molding';

  // Ledger/stacked stone corners: vendor_sku containing COR
  // LPN...COR, LVEN...-COR
  if (/COR(?:-\w+)?$/.test(sku) && (sku.startsWith('LPN') || sku.startsWith('LVEN'))) {
    if (sku.includes('3DH') || sku.includes('-3DH')) return '3D Honed Corner';
    if (sku.includes('MULTI')) return 'Multi Finish Corner';
    if (sku.includes('MINI')) return 'Mini Panel Corner';
    if (sku.includes('-PEN')) return 'Pencil Ledger Corner';
    return 'Ledger Corner';
  }

  // Clay corner pieces (SMOT-CLACOR-...)
  if (sku.includes('CLACOR')) return 'Corner Piece';

  return null;
}

/**
 * Derive a per-SKU variant_name by extracting size + finish from vendor_sku.
 * E.g., NPRACAR3X24BNP → "3x24 Polished Bullnose"
 *        LPNLMALAGRY618COR → "6x18 Ledger Corner"
 *        SMOT-PT-QTRRD-AW5/8X6 → "5/8x6 Quarter Round"
 */
function deriveVariantName(vendorSku, typeLabel) {
  const sku = (vendorSku || '').toUpperCase();
  const parts = [];

  // Extract dimensions from vendor_sku
  // Patterns: 3X24, 2.4X24, 4.59, 618, 918, 624, 924, 5/8X6, 0.75X12, 2X12
  let size = null;

  // NxN dimension patterns (with optional decimals and fractions)
  const dimMatch = sku.match(/(\d+(?:\.\d+)?(?:\/\d+)?)\s*X\s*(\d+(?:\.\d+)?)/i);
  if (dimMatch) {
    size = `${dimMatch[1]}x${dimMatch[2]}`;
  }

  // LPN corner/panel: ...618COR (6x18), ...918COR (9x18), ...624 (6x24), ...4.59COR (4.5x9)
  if (!size && sku.startsWith('LPN')) {
    // Try 3-digit pattern first: 618 = 6x18, 918 = 9x18, 624 = 6x24, 924 = 9x24
    const lpn3 = sku.match(/(\d)(\d{2})(?:COR|$)/);
    if (lpn3 && parseInt(lpn3[2]) >= 9 && parseInt(lpn3[2]) <= 36) {
      size = `${lpn3[1]}x${lpn3[2]}`;
    }
    // Try decimal pattern: 4.59COR = 4.5x9
    if (!size) {
      const lpnDec = sku.match(/(\d+\.\d+)(\d)(?:COR|$)/);
      if (lpnDec) {
        size = `${lpnDec[1]}x${lpnDec[2]}`;
      }
    }
    // Flats corners: just a single digit ...4COR, ...5COR, ...6COR
    if (!size) {
      const lpnFlat = sku.match(/(\d)COR$/);
      if (lpnFlat) {
        size = `${lpnFlat[1]}"`;
      }
    }
  }

  if (size) parts.push(size);

  // Extract finish from vendor_sku suffix
  // P or BNP = Polished, H = Honed, BNL-3D = Lapato 3D, BNG = Glazed, BNM = Matte
  if (/BNP(?:-[A-Z])?$/.test(sku)) {
    parts.push('Polished');
  } else if (/BNL-3D$/.test(sku)) {
    parts.push('Lapato 3D');
  } else if (/BNG(?:-[A-Z])?$/.test(sku)) {
    parts.push('Glazed');
  } else if (/BNM(?:-[A-Z])?$/.test(sku)) {
    parts.push('Matte');
  }

  parts.push(typeLabel);

  return parts.join(' ');
}

/**
 * Detect whether a product name indicates an accessory.
 * Used as fallback when vendor_sku detection misses.
 */
function detectAccessoryByName(productName) {
  const name = (productName || '').toLowerCase();

  if (/\bbullnos[ei]\b/.test(name)) return 'Bullnose';
  if (/\bquarter\s*round\b/.test(name)) return 'Quarter Round';
  if (/\bpencil\s*(?:mold(?:ing)?|liner)\b/.test(name)) return 'Pencil Molding';
  if (/\brail\s*mold(?:ing)?\b/.test(name)) return 'Rail Molding';
  if (/\bcrown\s*mold(?:ing)?\b/.test(name)) return 'Crown Molding';
  if (/\bpen\s*mold(?:ing)?\b/.test(name)) return 'Pencil Molding';
  if (/\bshelf\b/.test(name)) return 'Corner Shelf';
  if (/\bcorner\s*piece\b/.test(name)) return 'Corner Piece';
  if (/\bledger\s*corner\b/.test(name)) return 'Ledger Corner';
  if (/\bcorner\b/.test(name)) return 'Ledger Corner';

  return null;
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n=== MSI Attach Accessories v2 ===`);
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}\n`);

  // Find MSI vendor
  const { rows: [vendor] } = await pool.query(
    `SELECT id FROM vendors WHERE name ILIKE '%MSI%' LIMIT 1`
  );
  if (!vendor) { console.error('MSI vendor not found'); process.exit(1); }
  const vendorId = vendor.id;
  console.log(`MSI vendor ID: ${vendorId}`);

  // Clear existing MSI accessory links + tags
  if (!DRY_RUN) {
    const { rowCount: cleared } = await pool.query(`
      DELETE FROM sku_accessories sa
      USING skus s, products p
      WHERE sa.parent_sku_id = s.id AND s.product_id = p.id AND p.vendor_id = $1
    `, [vendorId]);
    if (cleared > 0) console.log(`Cleared ${cleared} existing MSI accessory links`);

    const { rowCount: untagged } = await pool.query(`
      UPDATE skus SET variant_type = NULL, variant_name = NULL, accessory_label = NULL
      FROM products p
      WHERE skus.product_id = p.id AND p.vendor_id = $1 AND skus.variant_type = 'accessory'
    `, [vendorId]);
    if (untagged > 0) console.log(`Untagged ${untagged} previously tagged accessory SKUs`);
  }

  // Load all active MSI SKUs with product info
  const { rows: allSkus } = await pool.query(`
    SELECT s.id, s.vendor_sku, s.variant_name, s.product_id,
           p.name as product_name, p.collection, c.name as category
    FROM skus s
    JOIN products p ON s.product_id = p.id
    LEFT JOIN categories c ON p.category_id = c.id
    WHERE p.vendor_id = $1 AND s.status = 'active'
    ORDER BY s.vendor_sku
  `, [vendorId]);

  console.log(`Loaded ${allSkus.length} active MSI SKUs\n`);

  // ── Phase 1: Identify accessories ──────────────────────────────────────────

  const accessories = [];  // { sku, label }
  const byLabel = {};

  for (const sku of allSkus) {
    let label = detectAccessoryBySku(sku.vendor_sku);
    if (!label) label = detectAccessoryByName(sku.product_name);
    if (!label) continue;

    accessories.push({ sku, label });
    byLabel[label] = (byLabel[label] || 0) + 1;
  }

  console.log(`Identified ${accessories.length} accessory SKUs:`);
  for (const [label, count] of Object.entries(byLabel).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${label}: ${count}`);
  }
  console.log();

  // ── Phase 2: Tag accessories ───────────────────────────────────────────────

  console.log('Tagging accessories...');
  let tagged = 0;

  if (DRY_RUN) {
    for (const { sku, label } of accessories) {
      const variantName = deriveVariantName(sku.vendor_sku, label);
      console.log(`  TAG ${sku.vendor_sku} → variant_name="${variantName}", accessory_label="${label}"`);
      tagged++;
    }
  } else {
    // Tag each SKU individually since variant_name is per-SKU
    for (const { sku, label } of accessories) {
      const variantName = deriveVariantName(sku.vendor_sku, label);
      await pool.query(`
        UPDATE skus SET
          variant_type = 'accessory',
          sell_by = 'unit',
          variant_name = $1,
          accessory_label = $2,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = $3
      `, [variantName, label, sku.id]);
      tagged++;
    }
    console.log(`  Tagged ${tagged} SKUs with per-SKU variant_names`);
  }
  console.log(`Total tagged: ${tagged}\n`);

  // ── Phase 3: Populate sku_accessories junction table ───────────────────────

  console.log('Building sku_accessories links...');

  // Build set of accessory SKU IDs for fast lookup
  const accessorySkuIds = new Set(accessories.map(a => a.sku.id));

  // Group accessories by product_id
  const accByProduct = new Map();
  for (const { sku } of accessories) {
    if (!accByProduct.has(sku.product_id)) accByProduct.set(sku.product_id, []);
    accByProduct.get(sku.product_id).push(sku);
  }

  const linkBatch = [];
  let productsWithAcc = 0;
  let productsAccOnly = 0;

  for (const [productId, accSkus] of accByProduct) {
    // Get main SKUs in this product (those NOT in our accessory set)
    const mainSkus = allSkus.filter(s =>
      s.product_id === productId && !accessorySkuIds.has(s.id)
    );

    if (mainSkus.length === 0) {
      productsAccOnly++;
      if (DRY_RUN) {
        console.log(`  WARN: "${accSkus[0]?.product_name}" — ${accSkus.length} accessories, 0 main SKUs`);
      }
      continue;
    }

    productsWithAcc++;

    // Link every main SKU → every accessory SKU in this product
    for (const main of mainSkus) {
      let sortOrder = 0;
      for (const acc of accSkus) {
        linkBatch.push([main.id, acc.id, sortOrder++]);
      }
    }
  }

  console.log(`Products with main + accessories: ${productsWithAcc}`);
  console.log(`Products with accessories only: ${productsAccOnly}`);
  console.log(`Junction table links to create: ${linkBatch.length}`);

  if (DRY_RUN) {
    console.log('\nSample links (first 30):');
    for (const [parentId, accId, sort] of linkBatch.slice(0, 30)) {
      const pSku = allSkus.find(s => s.id === parentId);
      const aSku = allSkus.find(s => s.id === accId);
      console.log(`  ${pSku?.vendor_sku} → ${aSku?.vendor_sku} [${aSku?.product_name}] (sort: ${sort})`);
    }
  } else {
    const BATCH_SIZE = 500;
    let written = 0;
    for (let i = 0; i < linkBatch.length; i += BATCH_SIZE) {
      const batch = linkBatch.slice(i, i + BATCH_SIZE);
      const values = [];
      const params = [];
      for (let j = 0; j < batch.length; j++) {
        const offset = j * 3;
        values.push(`($${offset + 1}, $${offset + 2}, $${offset + 3})`);
        params.push(batch[j][0], batch[j][1], batch[j][2]);
      }
      await pool.query(`
        INSERT INTO sku_accessories (parent_sku_id, accessory_sku_id, sort_order)
        VALUES ${values.join(', ')}
        ON CONFLICT (parent_sku_id, accessory_sku_id) DO UPDATE SET sort_order = EXCLUDED.sort_order
      `, params);
      written += batch.length;
      if (written % 2000 === 0 || written === linkBatch.length) {
        console.log(`  ${written}/${linkBatch.length} links written`);
      }
    }
  }

  // ── Summary ────────────────────────────────────────────────────────────────

  if (!DRY_RUN) {
    const { rows: [accCount] } = await pool.query(`
      SELECT COUNT(*) FROM skus s
      JOIN products p ON s.product_id = p.id
      WHERE p.vendor_id = $1 AND s.variant_type = 'accessory'
    `, [vendorId]);

    const { rows: [linkCount] } = await pool.query(`
      SELECT COUNT(*) FROM sku_accessories sa
      JOIN skus s ON sa.parent_sku_id = s.id
      JOIN products p ON s.product_id = p.id
      WHERE p.vendor_id = $1
    `, [vendorId]);

    console.log(`\n${'─'.repeat(50)}`);
    console.log(`MSI accessory SKUs tagged: ${accCount.count}`);
    console.log(`MSI sku_accessories links:  ${linkCount.count}`);
  }

  console.log('\nDone!');
  await pool.end();
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
