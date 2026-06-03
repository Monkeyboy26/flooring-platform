#!/usr/bin/env node
/**
 * attach-eternity-accessories.cjs
 *
 * Populates the `sku_accessories` junction table and `accessory_label` column
 * for Eternity Flooring products.
 *
 * Eternity structure:
 *   - Each product = 1 color variant (1 main flooring SKU + N molding accessories)
 *   - Accessories share the same product_id as their parent flooring SKU
 *   - Vendor SKU pattern: main = "ECO-31001", accessory = "ECO-31001-TMOLD"
 *   - Molding types per series: T-Mold, Quarter Round, Flush/Overlap/Square Flush
 *     Stairnose, Custom Stairnose, End/Cover/Flexible Molding (Workshop)
 *
 * This script:
 *   1. Activates all Eternity accessory SKUs (if any are inactive)
 *   2. Links each accessory to its parent main SKU within the same product
 *   3. Derives and sets accessory_label values from variant_name
 *
 * Usage:
 *   node backend/scripts/attach-eternity-accessories.cjs --dry-run
 *   node backend/scripts/attach-eternity-accessories.cjs
 */

const { Pool } = require('pg');
const pool = new Pool({
  host: process.env.DB_HOST || process.env.PGHOST || 'localhost',
  port: process.env.DB_PORT || process.env.PGPORT || 5432,
  database: process.env.DB_NAME || process.env.PGDATABASE || 'flooring_pim',
  user: process.env.DB_USER || process.env.PGUSER || 'postgres',
  password: process.env.DB_PASS || process.env.PGPASSWORD || 'postgres',
});

const DRY_RUN = process.argv.includes('--dry-run');

// ── Label derivation ─────────────────────────────────────────────────────────

/**
 * Eternity molding suffix → canonical label.
 * These match the suffixes used in import-eternity.js.
 */
const SUFFIX_LABEL_MAP = {
  'TMOLD':       'T-Mold',
  'REDUCER':     'Reducer',
  'END-CAP':     'End Cap',
  'SQ-FLUSH-SN': 'Square Flush Stairnose',
  'QTR-ROUND':   'Quarter Round',
  'OVERLAP-SN':  'Overlap Stairnose',
  'FLUSH-SN':    'Flush Stairnose',
  'CUSTOM-SN':   'Custom Stairnose',
  'END-MOLD':    'End Molding',
  'COVER-MOLD':  'Cover Molding',
  'FLEX-MOLD':   'Flexible Molding',
};

/** Fallback: variant_name keyword patterns */
const TYPE_KEYWORDS = [
  [/square\s*flush\s*stair\s*nos[ei]/i, 'Square Flush Stairnose'],
  [/custom\s*square\s*flush\s*stair\s*nos[ei]/i, 'Custom Stairnose'],
  [/flush\s*stair\s*nos[ei]/i, 'Flush Stairnose'],
  [/overlap(?:ping)?\s*stair\s*nos[ei]/i, 'Overlap Stairnose'],
  [/stair\s*nos[ei]/i, 'Stairnose'],
  [/t[-\s]?mold/i, 'T-Mold'],
  [/reducer/i, 'Reducer'],
  [/end\s*mold/i, 'End Molding'],
  [/quarter\s*round/i, 'Quarter Round'],
  [/cover\s*mold/i, 'Cover Molding'],
  [/flexible\s*mold/i, 'Flexible Molding'],
  [/threshold/i, 'Threshold'],
];

/**
 * Derive the accessory label for an Eternity SKU.
 * Tries vendor_sku suffix first, then variant_name keywords.
 */
function deriveLabel(vendorSku, variantName) {
  const vsku = vendorSku || '';

  // Strategy 1: Match vendor_sku suffix (after last known base SKU portion)
  // Eternity format: "ECO-31001-TMOLD" → suffix = "TMOLD"
  for (const [suffix, label] of Object.entries(SUFFIX_LABEL_MAP)) {
    if (vsku.toUpperCase().endsWith(suffix)) return label;
  }

  // Strategy 2: variant_name keyword matching
  const vn = variantName || '';
  for (const [re, label] of TYPE_KEYWORDS) {
    if (re.test(vn)) return label;
  }

  // Fallback: clean variant_name (strip dimensions)
  const cleaned = vn
    .replace(/,?\s*\d+(?:'?\d*)?(?:"|in|inch(?:es)?)?$/i, '')
    .replace(/\s*\(.*?\)\s*/g, '')
    .trim();
  return cleaned || 'Accessory';
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`attach-eternity-accessories.cjs — ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  console.log('─'.repeat(60));

  // Step 1: Find Eternity vendor
  const vendorResult = await pool.query(
    `SELECT id FROM vendors WHERE code = 'ETERNITY'`
  );
  if (vendorResult.rows.length === 0) {
    console.error('Eternity vendor not found (code=ETERNITY). Run import-eternity.js first.');
    process.exit(1);
  }
  const vendorId = vendorResult.rows[0].id;
  console.log(`Vendor ID: ${vendorId}`);

  // Step 2: Activate any inactive/draft Eternity accessory SKUs
  const inactiveResult = await pool.query(`
    SELECT s.id, s.status, s.internal_sku
    FROM skus s
    JOIN products p ON s.product_id = p.id
    WHERE p.vendor_id = $1
      AND s.variant_type = 'accessory'
      AND s.status != 'active'
  `, [vendorId]);

  console.log(`Found ${inactiveResult.rows.length} inactive/draft accessory SKUs to activate`);

  if (!DRY_RUN && inactiveResult.rows.length > 0) {
    const ids = inactiveResult.rows.map(r => r.id);
    await pool.query(`
      UPDATE skus SET status = 'active', updated_at = CURRENT_TIMESTAMP
      WHERE id = ANY($1)
    `, [ids]);
    console.log(`  Activated ${ids.length} accessory SKUs`);
  }

  // Step 3: Load all Eternity products with their SKUs
  const allSkus = await pool.query(`
    SELECT s.id, s.product_id, s.vendor_sku, s.internal_sku, s.variant_name,
      s.variant_type, s.sell_by, s.accessory_label,
      p.name AS product_name, p.collection
    FROM skus s
    JOIN products p ON s.product_id = p.id
    WHERE p.vendor_id = $1
      AND (s.status = 'active' OR s.variant_type = 'accessory')
      AND s.is_sample = false
    ORDER BY p.collection, p.name, s.variant_type NULLS FIRST, s.vendor_sku
  `, [vendorId]);

  console.log(`Loaded ${allSkus.rows.length} Eternity SKUs`);

  // Group by product
  const byProduct = {};
  for (const s of allSkus.rows) {
    if (!byProduct[s.product_id]) byProduct[s.product_id] = [];
    byProduct[s.product_id].push(s);
  }

  const productCount = Object.keys(byProduct).length;
  console.log(`Across ${productCount} products\n`);

  // Step 4: Build links and labels
  const linkBatch = [];  // [parent_sku_id, accessory_sku_id, sort_order]
  const labelBatch = []; // [sku_id, label]
  let totalLinks = 0;
  let productsWithLinks = 0;
  let skippedProducts = 0;

  for (const [productId, skus] of Object.entries(byProduct)) {
    const mainSkus = skus.filter(s => s.variant_type !== 'accessory');
    const accSkus = skus.filter(s => s.variant_type === 'accessory');

    if (mainSkus.length === 0 || accSkus.length === 0) {
      skippedProducts++;
      continue;
    }

    productsWithLinks++;
    const productName = skus[0].product_name;
    const collection = skus[0].collection;

    // Derive labels for accessories
    for (const acc of accSkus) {
      const label = deriveLabel(acc.vendor_sku, acc.variant_name);
      if (label) {
        labelBatch.push([acc.id, label]);
      }
    }

    // Link accessories to their parent main SKU
    if (mainSkus.length === 1) {
      // Single main SKU: link all accessories to it
      const main = mainSkus[0];
      let sortOrder = 0;
      for (const acc of accSkus) {
        linkBatch.push([main.id, acc.id, sortOrder++]);
        totalLinks++;
      }
    } else {
      // Grouped product (multiple main SKUs): match by vendor_sku prefix
      for (const main of mainSkus) {
        const prefix = (main.vendor_sku || '') + '-';
        const matched = accSkus.filter(a => (a.vendor_sku || '').startsWith(prefix));
        let sortOrder = 0;
        for (const acc of matched) {
          linkBatch.push([main.id, acc.id, sortOrder++]);
          totalLinks++;
        }
      }
    }

    if (DRY_RUN) {
      const labels = accSkus.map(a => deriveLabel(a.vendor_sku, a.variant_name));
      console.log(`  ${collection} / ${productName}: ${mainSkus.length} main × ${accSkus.length} acc → [${labels.join(', ')}]`);
    }
  }

  // Deduplicate links
  const linkSet = new Set();
  const dedupedLinks = [];
  for (const [parent, acc, sort] of linkBatch) {
    const key = `${parent}|${acc}`;
    if (!linkSet.has(key)) {
      linkSet.add(key);
      dedupedLinks.push([parent, acc, sort]);
    }
  }

  // Deduplicate labels
  const labelMap = new Map();
  for (const [skuId, label] of labelBatch) {
    labelMap.set(skuId, label);
  }
  const dedupedLabels = Array.from(labelMap.entries());

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Products with accessories: ${productsWithLinks}`);
  console.log(`Products skipped (no main+acc pair): ${skippedProducts}`);
  console.log(`Total links to write: ${dedupedLinks.length}`);
  console.log(`Total labels to write: ${dedupedLabels.length}`);

  // Label distribution
  const labelDist = {};
  for (const [, label] of dedupedLabels) {
    labelDist[label] = (labelDist[label] || 0) + 1;
  }
  console.log('\nLabel distribution:');
  for (const [label, count] of Object.entries(labelDist).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${label}: ${count}`);
  }

  if (DRY_RUN) {
    console.log('\nSample links (first 20):');
    for (const [parent, acc, sort] of dedupedLinks.slice(0, 20)) {
      console.log(`  ${parent} → ${acc} (sort: ${sort})`);
    }
  } else {
    // Step 5: Clear existing Eternity links
    const delResult = await pool.query(`
      DELETE FROM sku_accessories
      WHERE parent_sku_id IN (
        SELECT s.id FROM skus s
        JOIN products p ON p.id = s.product_id
        WHERE p.vendor_id = $1
      )
    `, [vendorId]);
    console.log(`\nCleared ${delResult.rowCount} existing Eternity sku_accessories links`);

    // Step 6: Write links in batches
    console.log('Writing sku_accessories links...');
    const BATCH_SIZE = 500;
    let written = 0;
    for (let i = 0; i < dedupedLinks.length; i += BATCH_SIZE) {
      const batch = dedupedLinks.slice(i, i + BATCH_SIZE);
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
      if (written % 2000 === 0 || written === dedupedLinks.length) {
        console.log(`  ${written}/${dedupedLinks.length} links written`);
      }
    }

    // Step 7: Write labels
    console.log('Writing accessory_label values...');
    for (let i = 0; i < dedupedLabels.length; i += BATCH_SIZE) {
      const batch = dedupedLabels.slice(i, i + BATCH_SIZE);
      const ids = batch.map(b => b[0]);
      const caseLines = batch.map((b, j) => `WHEN id = $${j * 2 + 1} THEN $${j * 2 + 2}`).join(' ');
      const params = [];
      for (const [skuId, label] of batch) {
        params.push(skuId, label);
      }
      await pool.query(`
        UPDATE skus SET accessory_label = CASE ${caseLines} END, updated_at = CURRENT_TIMESTAMP
        WHERE id = ANY($${params.length + 1})
      `, [...params, ids]);
    }
    console.log(`  ${dedupedLabels.length} labels written`);

    // Step 8: Summary
    const linkCount = await pool.query(`
      SELECT COUNT(*) FROM sku_accessories sa
      JOIN skus s ON sa.parent_sku_id = s.id
      JOIN products p ON s.product_id = p.id
      WHERE p.vendor_id = $1
    `, [vendorId]);
    const labelCount = await pool.query(`
      SELECT accessory_label, COUNT(*) FROM skus s
      JOIN products p ON s.product_id = p.id
      WHERE p.vendor_id = $1 AND s.accessory_label IS NOT NULL
      GROUP BY accessory_label ORDER BY accessory_label
    `, [vendorId]);

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`Eternity sku_accessories links: ${linkCount.rows[0].count}`);
    console.log('Labels in DB:');
    for (const r of labelCount.rows) {
      console.log(`  ${r.accessory_label}: ${r.count}`);
    }
  }

  console.log('\nDone!');
  await pool.end();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
