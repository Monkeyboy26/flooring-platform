#!/usr/bin/env node
/**
 * Map Quick-Step 832 accessories to the correct website-sourced flooring products.
 *
 * Strategy:
 *   1. Build color → product_id map from QS- flooring SKUs
 *   2. Match color-named accessories (Quarter Round 94, etc.) by exact/fuzzy color name
 *   3. Match collection-named accessories by collection hint in old product name
 *   4. Move matched accessory SKUs to the correct product, set variant_type='accessory'
 *   5. Activate matched accessory SKUs
 *
 * Usage:
 *   node backend/scripts/map-quickstep-accessories.cjs --dry-run
 *   node backend/scripts/map-quickstep-accessories.cjs
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
const VENDOR_ID = '550e8400-e29b-41d4-a716-446655440008';

// Collection name hints found in old 832 product names
const COLLECTION_HINTS = [
  { pattern: /colossia/i, collection: 'Colossia' },
  { pattern: /palisade/i, collection: 'Palisades Park' },
  { pattern: /ellicott/i, collection: 'Ellicott Point' },
  { pattern: /tilleto/i, collection: 'Tilleto' },
  { pattern: /vestia/i, collection: 'Vestia' },
  { pattern: /artisan/i, collection: 'Studio' },
  { pattern: /perdestia/i, collection: 'Perdestia' },
  { pattern: /propello/i, collection: 'Propello' },
  { pattern: /stellaris/i, collection: 'Stellaris' },
  { pattern: /abreeza/i, collection: 'Abreeza' },
  { pattern: /reclaime/i, collection: 'Reclaime' },
  { pattern: /studio/i, collection: 'Studio' },
];

// Fuzzy name mappings for 832 color names that differ from PIM names
const COLOR_ALIASES = {
  'aviator': 'aviator oak',
  'cargo': 'cargo oak',
  'eclipse': 'eclipse hickory',
  'glider': 'glider oak',
  'horizon': 'horizon hickory',
  'jetstream': 'jetstream oak',
  'nomad': 'nomad oak',
  'solstice': 'solstice hickory',
  'sunbeam': 'sunbeam hickory',
  'leather bound oak': 'leatherbound oak',
  'heatherd oak planks': 'heathered oak',
  'heathered oak planks': 'heathered oak',
  'malted tawny oak planks': 'malted tawny oak',
  'mocha oak planks': 'mocha oak',
  'white wash oak planks': 'white wash oak',
  'rock river oak': 'rocky river oak',
  'gilded oak': 'gilded page oak',
  'glided oak': 'gilded page oak',
  'rain forest/brown thrasher oak': 'brown thrasher oak',
  'golden wheat oak': 'wheat oak',
  'celler oak planks': 'denali oak',      // Colossia rebrand
  'steele chestnut planks': 'vailmont chestnut', // Studio rebrand
  'aged chestnut planks': 'vailmont chestnut',
  'natural rustic oak': 'natural oak',
};

async function main() {
  console.log(`\n=== Quick-Step Accessory Mapping ===`);
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}\n`);

  // Step 1: Build color → product_id map from QS- flooring SKUs
  const flooringResult = await pool.query(`
    SELECT LOWER(TRIM(s.variant_name)) AS color, p.id AS product_id, p.name AS product_name
    FROM skus s
    JOIN products p ON p.id = s.product_id
    WHERE s.internal_sku LIKE 'QS-%'
  `);

  const colorMap = new Map(); // color → { product_id, product_name }
  for (const row of flooringResult.rows) {
    colorMap.set(row.color, { product_id: row.product_id, product_name: row.product_name });
  }
  console.log(`Flooring colors loaded: ${colorMap.size}`);

  // Add aliases
  for (const [alias, canonical] of Object.entries(COLOR_ALIASES)) {
    const target = colorMap.get(canonical);
    if (target && !colorMap.has(alias)) {
      colorMap.set(alias, target);
    }
  }
  console.log(`With aliases: ${colorMap.size}\n`);

  // Build collection name → product_id map
  const collectionMap = new Map();
  for (const row of flooringResult.rows) {
    if (!collectionMap.has(row.product_name)) {
      collectionMap.set(row.product_name, row.product_id);
    }
  }

  // Step 2: Get all old 832 Quick-Step accessory SKUs (and SKUs from accessory-like products)
  const accessoryResult = await pool.query(`
    SELECT s.id AS sku_id, s.variant_name, s.variant_type, s.product_id, s.vendor_sku,
           s.sell_by, s.status AS sku_status,
           p.name AS old_product_name, p.collection AS old_collection
    FROM skus s
    JOIN products p ON p.id = s.product_id
    WHERE p.vendor_id = $1
      AND (p.collection LIKE 'Quickstep%' OR p.collection LIKE 'Quick-Step%')
      AND s.internal_sku NOT LIKE 'QS-%'
  `, [VENDOR_ID]);

  console.log(`Total old 832 SKUs: ${accessoryResult.rows.length}\n`);

  // Categorize accessory types by old product name
  const ACCESSORY_PATTERNS = [
    /quarter\s*round/i,
    /stair\s*nose/i,
    /overlap/i,
    /flush/i,
    /incizo/i,
    /5\s*in\s*1/i,
    /multi\s*func/i,
    /4\s*in\s*1/i,
  ];

  const isAccessoryProduct = (name) => ACCESSORY_PATTERNS.some(p => p.test(name));

  const stats = { matched: 0, unmatched: 0, skippedNonAccessory: 0, byMethod: {} };
  const updates = []; // { sku_id, new_product_id, product_name, method, old_name, variant_name }

  for (const row of accessoryResult.rows) {
    const oldName = row.old_product_name;

    // Skip non-accessory products (flooring, samples, displays, tools, underlayment, etc.)
    if (!isAccessoryProduct(oldName) && row.variant_type !== 'accessory') {
      stats.skippedNonAccessory++;
      continue;
    }

    let target = null;
    let method = '';

    // Method 1: Match by color name (for Quarter Round 94, Flush Stair Nose 96, etc.)
    const colorKey = (row.variant_name || '').toLowerCase().trim();
    if (colorKey && colorKey.length > 3 && !/^\d/.test(colorKey)) {
      target = colorMap.get(colorKey);
      if (target) method = 'color_name';
    }

    // Method 2: Match by collection hint in old product name
    if (!target) {
      for (const hint of COLLECTION_HINTS) {
        if (hint.pattern.test(oldName)) {
          const pid = collectionMap.get(hint.collection);
          if (pid) {
            target = { product_id: pid, product_name: hint.collection };
            method = 'collection_hint';
            break;
          }
        }
      }
    }

    // Method 3: Match by old collection field (e.g., "Quick-Step - BOOK CASE OAK")
    if (!target && row.old_collection) {
      const dashIdx = row.old_collection.indexOf(' - ');
      if (dashIdx > 0) {
        const colorFromCollection = row.old_collection.slice(dashIdx + 3).toLowerCase().trim();
        target = colorMap.get(colorFromCollection);
        if (target) method = 'collection_color';
      }
    }

    if (target) {
      updates.push({
        sku_id: row.sku_id,
        new_product_id: target.product_id,
        product_name: target.product_name,
        method,
        old_name: oldName,
        variant_name: row.variant_name,
        vendor_sku: row.vendor_sku,
      });
      stats.matched++;
      stats.byMethod[method] = (stats.byMethod[method] || 0) + 1;
    } else {
      stats.unmatched++;
      if (stats.unmatched <= 20) {
        console.log(`  UNMATCHED: "${oldName}" / "${row.variant_name}" (${row.vendor_sku})`);
      }
    }
  }

  console.log(`\nMatched: ${stats.matched}, Unmatched: ${stats.unmatched}, Skipped non-accessory: ${stats.skippedNonAccessory}`);
  console.log('By method:', stats.byMethod);

  // Show sample of what will be updated
  console.log('\nSample updates:');
  const samples = updates.slice(0, 15);
  for (const u of samples) {
    console.log(`  ${u.old_name} / ${u.variant_name} → ${u.product_name} (${u.method})`);
  }

  if (DRY_RUN) {
    console.log('\n--- DRY RUN: No changes made ---');
    // Show summary by target product
    const byProduct = {};
    for (const u of updates) {
      if (!byProduct[u.product_name]) byProduct[u.product_name] = 0;
      byProduct[u.product_name]++;
    }
    console.log('\nAccessories per product:');
    for (const [name, count] of Object.entries(byProduct).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${name}: ${count}`);
    }
  } else {
    console.log('\nApplying updates...');

    let updated = 0;
    for (const u of updates) {
      await pool.query(`
        UPDATE skus SET
          product_id = $1,
          variant_type = 'accessory',
          sell_by = 'unit',
          status = 'active'
        WHERE id = $2
      `, [u.new_product_id, u.sku_id]);
      updated++;
    }

    console.log(`Updated ${updated} accessory SKUs`);

    // Verify
    const verify = await pool.query(`
      SELECT p.name, COUNT(s.id) AS accessories
      FROM skus s
      JOIN products p ON p.id = s.product_id
      WHERE s.internal_sku NOT LIKE 'QS-%'
        AND s.variant_type = 'accessory'
        AND p.collection = 'Quick-Step'
        AND p.status = 'active'
      GROUP BY p.name
      ORDER BY p.name
    `);
    console.log('\nAccessories per product (verified):');
    for (const row of verify.rows) {
      console.log(`  ${row.name}: ${row.accessories}`);
    }
  }

  await pool.end();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
