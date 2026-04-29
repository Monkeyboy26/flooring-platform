#!/usr/bin/env node
/**
 * attach-daltile-accessories.cjs
 *
 * Links Daltile trim/accessory SKUs to their parent tile SKUs in the
 * `sku_accessories` junction table. Matches by colorcode within the same
 * series (collection).
 *
 * Also derives `accessory_label` for each accessory SKU from the product
 * name or variant name (Bullnose, Quarter Round, Pencil Liner, etc.).
 *
 * Strategy:
 *   1. Find all Daltile products with accessory SKUs ("Trim & Accessories" products)
 *   2. Find main (non-accessory) products in the same collection/series
 *   3. Match accessories to main SKUs by colorcode (sku_attributes 'color')
 *   4. Fall back to matching all main SKUs if no color match
 *   5. Insert into sku_accessories junction table
 *
 * Usage:
 *   node backend/scripts/attach-daltile-accessories.cjs --dry-run
 *   node backend/scripts/attach-daltile-accessories.cjs
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
const VENDOR_CODE = 'DAL';

// ─── Product map for productType-based labels ───────────────────────────────
const fs = require('fs');
const path = require('path');

let productMapLookup = null; // vendor_sku → productType
function loadProductMap() {
  const mapPath = path.join(__dirname, '..', 'data', 'daltile-product-map.json');
  if (!fs.existsSync(mapPath)) return new Map();
  const map = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
  const lookup = new Map();
  for (const data of Object.values(map.series || {})) {
    for (const accData of Object.values(data.accessories || {})) {
      for (const sku of (accData.skus || [])) {
        if (sku.coveoSku && sku.productType) {
          lookup.set(sku.coveoSku.toUpperCase(), sku.productType);
        }
      }
    }
  }
  return lookup;
}

// ─── Accessory label derivation ──────────────────────────────────────────────

const TRIM_KEYWORDS = [
  [/bullnos[ei]/i, 'Bullnose'],
  [/quarter\s*round/i, 'Quarter Round'],
  [/pencil\s*liner/i, 'Pencil Liner'],
  [/chair\s*rail/i, 'Chair Rail'],
  [/cove\s*base/i, 'Cove Base'],
  [/v[-\s]?cap/i, 'V-Cap'],
  [/mud\s*cap/i, 'Mud Cap'],
  [/jolly/i, 'Jolly Trim'],
  [/schluter/i, 'Edge Trim'],
  [/stair\s*nos[ei]/i, 'Stairnose'],
  [/threshold/i, 'Threshold'],
  [/reducer/i, 'Reducer'],
  [/t[-\s]?mold/i, 'T-Mold'],
  [/end\s*cap/i, 'End Cap'],
  [/liner/i, 'Liner'],
  [/bead/i, 'Bead'],
  [/mosaic\s*trim/i, 'Mosaic Trim'],
  [/trim/i, 'Trim'],
];

function deriveLabel(variantName, productName, vendorSku) {
  // First try keyword-based matching from variant/product names
  const text = `${variantName || ''} ${productName || ''}`;
  for (const [re, label] of TRIM_KEYWORDS) {
    if (re.test(text)) {
      // If keyword match is generic "Trim", try product map for specificity
      if (label === 'Trim') break;
      return label;
    }
  }
  // Fall back to product map's productType for a more specific label
  if (productMapLookup && vendorSku) {
    const pt = productMapLookup.get(vendorSku.toUpperCase());
    if (pt) return pt; // e.g. "Wall Tile Trim", "Floor Tile Trim", "LVT Trim"
  }
  return 'Trim';
}

// ─── Color extraction ────────────────────────────────────────────────────────

/**
 * Extract the Daltile color code prefix from a vendor_sku.
 * Daltile SKUs use two formats:
 *   - Alpha-start: 1-4 alpha + 1-3 digits (e.g., OU57, AC11, FH10, M474)
 *   - Numeric-start: 4 digits (e.g., 0100, 0109, 1469) — Color Wheel, Keystones, etc.
 */
function extractColorCode(vendorSku) {
  if (!vendorSku) return null;
  const sku = vendorSku.toUpperCase().trim();
  // Try alpha-start pattern first (most common)
  const alphaMatch = sku.match(/^([A-Z]{1,4}\d{1,3})/);
  if (alphaMatch) return alphaMatch[1];
  // Try numeric-start pattern (4-digit code)
  const numMatch = sku.match(/^(\d{4})/);
  if (numMatch) return numMatch[1];
  return null;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`attach-daltile-accessories.cjs — ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  console.log('─'.repeat(60));

  // Load product map for productType-based labels
  productMapLookup = loadProductMap();
  console.log(`Loaded product map: ${productMapLookup.size} accessory SKU→productType mappings`);

  // Get Daltile vendor ID
  const vendorResult = await pool.query('SELECT id FROM vendors WHERE code = $1', [VENDOR_CODE]);
  if (!vendorResult.rows.length) {
    console.error(`Vendor with code "${VENDOR_CODE}" not found.`);
    process.exit(1);
  }
  const vendorId = vendorResult.rows[0].id;

  // Clear existing Daltile accessory links
  if (!DRY_RUN) {
    const deleteResult = await pool.query(`
      DELETE FROM sku_accessories sa
      USING skus s, products p
      WHERE sa.parent_sku_id = s.id AND s.product_id = p.id AND p.vendor_id = $1
    `, [vendorId]);
    console.log(`Cleared ${deleteResult.rowCount} existing Daltile accessory links`);

    await pool.query(`
      UPDATE skus SET accessory_label = NULL
      FROM products p
      WHERE skus.product_id = p.id AND p.vendor_id = $1 AND skus.accessory_label IS NOT NULL
    `, [vendorId]);
  }

  // Step 1: Load all Daltile collections that have both main + accessory SKUs
  const collectionsResult = await pool.query(`
    SELECT DISTINCT p.collection
    FROM products p
    JOIN skus s ON s.product_id = p.id AND s.status = 'active'
    WHERE p.vendor_id = $1 AND p.status IN ('active', 'draft') AND p.collection != ''
      AND s.variant_type = 'accessory'
  `, [vendorId]);

  const collections = collectionsResult.rows.map(r => r.collection);
  console.log(`Found ${collections.length} collections with accessories`);

  let totalLinks = 0;
  let totalLabels = 0;
  const linkBatch = [];  // [parent_sku_id, accessory_sku_id, sort_order]
  const labelBatch = []; // [sku_id, label]

  // Step 2: For each collection, match accessories to main SKUs
  for (const collection of collections) {
    // Load main SKUs in this collection
    const mainResult = await pool.query(`
      SELECT s.id, s.vendor_sku, s.variant_name, p.name as product_name
      FROM skus s
      JOIN products p ON p.id = s.product_id
      WHERE p.vendor_id = $1 AND p.collection = $2 AND p.status IN ('active', 'draft')
        AND s.status = 'active' AND COALESCE(s.variant_type, '') != 'accessory'
      ORDER BY s.vendor_sku
    `, [vendorId, collection]);

    // Load accessory SKUs in this collection
    const accResult = await pool.query(`
      SELECT s.id, s.vendor_sku, s.variant_name, p.name as product_name
      FROM skus s
      JOIN products p ON p.id = s.product_id
      WHERE p.vendor_id = $1 AND p.collection = $2 AND p.status IN ('active', 'draft')
        AND s.status = 'active' AND s.variant_type = 'accessory'
      ORDER BY s.vendor_sku
    `, [vendorId, collection]);

    const mainSkus = mainResult.rows;
    const accSkus = accResult.rows;

    if (mainSkus.length === 0 || accSkus.length === 0) continue;

    // Build color-code index for main SKUs
    const mainByColor = new Map(); // colorCode → [mainSku]
    for (const m of mainSkus) {
      const cc = extractColorCode(m.vendor_sku);
      if (!cc) continue;
      if (!mainByColor.has(cc)) mainByColor.set(cc, []);
      mainByColor.get(cc).push(m);
    }

    // Match each accessory to main SKUs by color code
    for (const acc of accSkus) {
      // Derive label
      const label = deriveLabel(acc.variant_name, acc.product_name, acc.vendor_sku);
      labelBatch.push([acc.id, label]);
      totalLabels++;

      const accColorCode = extractColorCode(acc.vendor_sku);
      let matchedMains = [];

      if (accColorCode && mainByColor.has(accColorCode)) {
        // Color-code match: link to all main SKUs with same color code
        matchedMains = mainByColor.get(accColorCode);
      } else {
        // No color match: skip (accessory is still visible via same-product siblings)
        // Linking to ALL main SKUs creates a combinatorial explosion
        matchedMains = [];
      }

      let sortOrder = 0;
      for (const main of matchedMains) {
        linkBatch.push([main.id, acc.id, sortOrder++]);
        totalLinks++;
      }
    }

    if (accSkus.length > 0) {
      const colorMatched = accSkus.filter(a => {
        const cc = extractColorCode(a.vendor_sku);
        return cc && mainByColor.has(cc);
      }).length;
      console.log(`  ${collection}: ${mainSkus.length} main + ${accSkus.length} acc → ${colorMatched} color-matched, ${accSkus.length - colorMatched} all-to-all`);
    }
  }

  console.log(`\nTotal: ${totalLinks} links, ${totalLabels} labels`);

  if (DRY_RUN) {
    console.log('\nSample links (first 20):');
    for (const [parent, acc, sort] of linkBatch.slice(0, 20)) {
      console.log(`  ${parent} → ${acc} (sort: ${sort})`);
    }
    console.log('\nSample labels (first 20):');
    for (const [skuId, label] of labelBatch.slice(0, 20)) {
      console.log(`  ${skuId} → "${label}"`);
    }
  } else {
    // Write links in batches
    console.log('\nWriting sku_accessories links...');
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
      if (written % 5000 === 0 || written === linkBatch.length) {
        console.log(`  ${written}/${linkBatch.length} links written`);
      }
    }

    // Write labels
    console.log('Writing accessory_label values...');
    const labelMap = new Map();
    for (const [skuId, label] of labelBatch) {
      labelMap.set(skuId, label);
    }
    const dedupedLabels = Array.from(labelMap.entries());

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
  }

  // Summary stats
  if (!DRY_RUN) {
    const countResult = await pool.query(`
      SELECT COUNT(*) FROM sku_accessories sa
      JOIN skus s ON sa.parent_sku_id = s.id
      JOIN products p ON s.product_id = p.id
      WHERE p.vendor_id = $1
    `, [vendorId]);

    const labelCount = await pool.query(`
      SELECT COUNT(*) FROM skus s
      JOIN products p ON s.product_id = p.id
      WHERE p.vendor_id = $1 AND s.accessory_label IS NOT NULL
    `, [vendorId]);

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`Total Daltile links in sku_accessories: ${countResult.rows[0].count}`);
    console.log(`Total Daltile SKUs with accessory_label: ${labelCount.rows[0].count}`);
  }

  console.log('\nDone!');
  await pool.end();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
