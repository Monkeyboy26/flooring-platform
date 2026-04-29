#!/usr/bin/env node
/**
 * attach-bravada-accessories.cjs
 *
 * Moves Bravada accessory SKUs (transitions, moldings, stairnose, etc.)
 * from standalone products into the correct Bravada flooring collection products.
 *
 * Matching strategy:
 *   1. SKU-prefix based routing: accessories often share a prefix with their parent
 *      collection (e.g., "CNST001" = Contempo stairnose → Bravada Contempo)
 *   2. Product name / collection name matching
 *   3. Color name matching against flooring SKU variant_names
 *
 * Usage:
 *   node backend/scripts/attach-bravada-accessories.cjs --dry-run
 *   node backend/scripts/attach-bravada-accessories.cjs
 */

const { Pool } = require('pg');
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

const DRY_RUN = process.argv.includes('--dry-run');

// ── Accessory detection ─────────────────────────────────────────────────────
const ACCESSORY_TYPES = [
  'stairnose', 't-mold', 't mold', 'tmold', 'reducer', 'threshold',
  'end cap', 'endcap', 'quarter round', 'quarter-round', 'flush mount',
  'flush-mount', 'overlap', 'molding', 'transition', 'nosing',
];

const ACCESSORY_PATTERN = new RegExp(ACCESSORY_TYPES.join('|'), 'i');

// ── SKU prefix → collection mapping ─────────────────────────────────────────
// Bravada SKU prefixes encode the collection:
//   CN = Contempo, BCEW/BCEWHB = Barcelona, RGLA = Regalia
//   D'Vine and Symphony use numeric IDs (14xxx, 95xxx)
const SKU_TO_COLLECTION = {
  'CN':     'Bravada Contempo',
  'BCEW':   'Bravada Barcelona',
  'BCEWHB': 'Bravada Barcelona',
  'RGLA':   'Bravada Regalia',
  // Symphony IDs start with 95xxx, D'Vine with 14xxx, Branché with 58xxx
};

// Product name keywords → collection
const NAME_TO_COLLECTION = {
  'contempo':   'Bravada Contempo',
  "d'vine":     "Bravada D'Vine",
  'dvine':      "Bravada D'Vine",
  'd vine':     "Bravada D'Vine",
  'symphony':   'Bravada Symphony',
  'barcelona':  'Bravada Barcelona',
  'branche':    'Bravada Branché',
  'branché':    'Bravada Branché',
  'regalia':    'Bravada Regalia',
};

function norm(s) {
  return (s || '')
    .toLowerCase()
    .replace(/\s*\(.*?\)\s*/g, '')
    .replace(/[\s-](?:european|french|white)\s*(?:oak|walnut)$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function baseColor(s) {
  return norm(s).split(/[-\/]/)[0].trim();
}

function detectTargetCollection(vendorSku, productName, collectionName) {
  const sku = (vendorSku || '').toUpperCase();
  const pName = (productName || '').toLowerCase();
  const coll = (collectionName || '').toLowerCase();

  // 1. SKU prefix match
  for (const [prefix, target] of Object.entries(SKU_TO_COLLECTION)) {
    if (sku.startsWith(prefix)) return target;
  }

  // 2. Product name or collection keyword match
  for (const [keyword, target] of Object.entries(NAME_TO_COLLECTION)) {
    if (pName.includes(keyword) || coll.includes(keyword)) return target;
  }

  // 3. Numeric ID ranges (D'Vine: 14xxx, Symphony: 95xxx, Branché: 58xxx)
  const numMatch = sku.match(/^(\d{2})\d{3}/);
  if (numMatch) {
    const prefix2 = numMatch[1];
    if (prefix2 === '14') return "Bravada D'Vine";
    if (prefix2 === '95') return 'Bravada Symphony';
    if (prefix2 === '58') return 'Bravada Branché';
  }

  return null;
}

async function main() {
  console.log(`\n=== Attach Bravada Accessories ===`);
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}\n`);

  // Find vendor
  const { rows: [tw] } = await pool.query(`SELECT id FROM vendors WHERE code = 'TW'`);
  if (!tw) { console.error('Tri-West vendor not found'); process.exit(1); }
  const vendorId = tw.id;

  // Load Bravada FLOORING products (targets)
  const { rows: floorProducts } = await pool.query(`
    SELECT p.id, p.name, p.collection
    FROM products p
    WHERE p.vendor_id = $1
      AND p.collection ILIKE 'Bravada%'
      AND p.collection NOT ILIKE '%Accessor%'
  `, [vendorId]);

  console.log(`Flooring products: ${floorProducts.length}`);
  for (const p of floorProducts) {
    console.log(`  ${p.collection} / ${p.name}`);
  }

  // Build collection → product_id lookup
  const collectionToProduct = new Map();
  for (const p of floorProducts) {
    collectionToProduct.set(p.collection, p.id);
  }

  // Load flooring SKU colors for color-based matching
  const { rows: floorSkus } = await pool.query(`
    SELECT s.variant_name, s.product_id, p.collection
    FROM skus s
    JOIN products p ON p.id = s.product_id
    WHERE p.vendor_id = $1
      AND p.collection ILIKE 'Bravada%'
      AND s.variant_type IS DISTINCT FROM 'accessory'
  `, [vendorId]);

  const colorToCollection = new Map();
  const baseColorToCollection = new Map();
  for (const s of floorSkus) {
    const n = norm(s.variant_name);
    const b = baseColor(s.variant_name);
    if (n && !colorToCollection.has(n)) colorToCollection.set(n, s.collection);
    if (b && !baseColorToCollection.has(b)) baseColorToCollection.set(b, s.collection);
  }
  console.log(`\nColor index: ${colorToCollection.size} exact, ${baseColorToCollection.size} base`);

  // Load candidate accessory SKUs
  // These are SKUs in Bravada-related products that match the accessory pattern
  const { rows: accSkus } = await pool.query(`
    SELECT s.id AS sku_id, s.vendor_sku, s.variant_name, s.variant_type,
           s.sell_by, s.product_id, p.name AS product_name, p.collection
    FROM skus s
    JOIN products p ON p.id = s.product_id
    WHERE p.vendor_id = $1
      AND (p.collection ILIKE 'Bravada%' OR p.name ILIKE '%Bravada%')
    ORDER BY s.vendor_sku
  `, [vendorId]);

  // Filter to accessory SKUs
  const accessories = accSkus.filter(s =>
    ACCESSORY_PATTERN.test(s.variant_name || '') ||
    ACCESSORY_PATTERN.test(s.product_name || '') ||
    s.variant_type === 'accessory'
  );

  console.log(`\nAccessory SKUs found: ${accessories.length}\n`);

  let attached = 0;
  let skipped = 0;
  let alreadyCorrect = 0;

  for (const acc of accessories) {
    // Determine target collection
    let targetColl = detectTargetCollection(acc.vendor_sku, acc.product_name, acc.collection);

    // Fallback: try matching by color name
    if (!targetColl && acc.variant_name) {
      const n = norm(acc.variant_name);
      const b = baseColor(acc.variant_name);
      targetColl = colorToCollection.get(n) || baseColorToCollection.get(b) || null;
    }

    if (!targetColl) {
      console.log(`  SKIP: ${acc.vendor_sku} / "${acc.variant_name}" — no target found`);
      skipped++;
      continue;
    }

    const targetProductId = collectionToProduct.get(targetColl);
    if (!targetProductId) {
      console.log(`  SKIP: ${acc.vendor_sku} — target collection "${targetColl}" not in DB`);
      skipped++;
      continue;
    }

    // Already in the right product?
    if (acc.product_id === targetProductId && acc.variant_type === 'accessory') {
      alreadyCorrect++;
      continue;
    }

    console.log(`  ${acc.vendor_sku} "${acc.variant_name}" → ${targetColl}`);

    if (!DRY_RUN) {
      // Move SKU to target product and mark as accessory
      await pool.query(`
        UPDATE skus SET product_id = $1, variant_type = 'accessory', sell_by = 'unit'
        WHERE id = $2
      `, [targetProductId, acc.sku_id]);

      // Move any media for this SKU
      await pool.query(`
        UPDATE media_assets SET product_id = $1 WHERE sku_id = $2
      `, [targetProductId, acc.sku_id]);
    }

    attached++;
  }

  // Clean up orphaned products (products with no remaining SKUs)
  if (!DRY_RUN && attached > 0) {
    const { rowCount: orphansDeleted } = await pool.query(`
      DELETE FROM products
      WHERE vendor_id = $1
        AND collection ILIKE 'Bravada%'
        AND id NOT IN (SELECT DISTINCT product_id FROM skus)
    `, [vendorId]);
    if (orphansDeleted > 0) {
      console.log(`\nCleaned up ${orphansDeleted} orphaned products`);
    }
  }

  // ── Summary ──
  console.log(`\n=== Summary ===`);
  console.log(`Attached: ${attached}`);
  console.log(`Already correct: ${alreadyCorrect}`);
  console.log(`Skipped (no target): ${skipped}`);
  console.log(`Total accessories: ${accessories.length}`);

  await pool.end();
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
