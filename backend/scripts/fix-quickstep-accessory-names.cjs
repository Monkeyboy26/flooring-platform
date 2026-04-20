#!/usr/bin/env node
/**
 * Fix Quick-Step accessory names and add per-color matching.
 *
 * Problems:
 *   - variant_name has the COLOR ("Ashen Oak") instead of the accessory TYPE
 *   - No way to filter accessories per-color on the storefront
 *
 * Fixes:
 *   1. Rename variant_name to proper accessory type (from vendor_sku prefix)
 *   2. Store original color as `matching_color` attribute on each accessory SKU
 *   3. Normalize the matching_color to the canonical PIM color name
 *
 * Usage:
 *   node backend/scripts/fix-quickstep-accessory-names.cjs --dry-run
 *   node backend/scripts/fix-quickstep-accessory-names.cjs
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

// Vendor SKU prefix → proper accessory type name
const SKU_PREFIX_MAP = [
  { prefix: 'UNLMQND',  name: 'Quarter Round' },
  { prefix: 'UNLQUART', name: 'Quarter Round' },
  { prefix: 'UNLMINC',  name: 'Multifunctional Molding' },
  { prefix: 'UNLMSNP',  name: 'Overlap Stair Nose' },
  { prefix: 'UNLMFSDB', name: 'Flush Stair Nose' },
  { prefix: 'UNLMFSNB', name: 'Flush Stair Nose' },
  { prefix: 'UNLMFSDC', name: 'Flush Stair Nose' },
  { prefix: 'UNLMCAPM', name: 'Square Flush Stair Nose' },
];

function getAccessoryType(vendorSku) {
  const upper = (vendorSku || '').toUpperCase();
  for (const entry of SKU_PREFIX_MAP) {
    if (upper.startsWith(entry.prefix)) return entry.name;
  }
  return null;
}

// Color alias → canonical PIM color (same map from map-quickstep-accessories.cjs)
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
  'celler oak planks': 'denali oak',
  'steele chestnut planks': 'vailmont chestnut',
  'aged chestnut planks': 'vailmont chestnut',
  'natural rustic oak': 'natural oak',
};

async function main() {
  console.log(`\n=== Fix Quick-Step Accessory Names ===`);
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}\n`);

  // Get all active Quick-Step accessories
  const result = await pool.query(`
    SELECT s.id AS sku_id, s.variant_name, s.vendor_sku, p.name AS product_name
    FROM skus s
    JOIN products p ON p.id = s.product_id
    WHERE p.collection = 'Quick-Step'
      AND s.variant_type = 'accessory'
      AND s.status = 'active'
    ORDER BY s.vendor_sku
  `);

  console.log(`Total active accessories: ${result.rows.length}\n`);

  // Build canonical color set from flooring SKUs
  const flooringResult = await pool.query(`
    SELECT LOWER(TRIM(s.variant_name)) AS color
    FROM skus s
    WHERE s.internal_sku LIKE 'QS-%'
  `);
  const canonicalColors = new Set(flooringResult.rows.map(r => r.color));

  // Ensure matching_color attribute exists
  let matchingColorAttrId;
  const attrCheck = await pool.query(`SELECT id FROM attributes WHERE slug = 'matching_color'`);
  if (attrCheck.rows.length) {
    matchingColorAttrId = attrCheck.rows[0].id;
  } else if (!DRY_RUN) {
    const ins = await pool.query(`
      INSERT INTO attributes (name, slug, is_filterable, display_order)
      VALUES ('Matching Color', 'matching_color', false, 999)
      RETURNING id
    `);
    matchingColorAttrId = ins.rows[0].id;
    console.log(`Created 'matching_color' attribute (id: ${matchingColorAttrId})\n`);
  } else {
    matchingColorAttrId = 'dry-run-id';
    console.log(`Would create 'matching_color' attribute\n`);
  }

  const stats = { renamed: 0, colorSet: 0, skipped: 0, byType: {} };

  for (const row of result.rows) {
    const accessoryType = getAccessoryType(row.vendor_sku);
    if (!accessoryType) {
      console.log(`  SKIP: No type mapping for vendor_sku ${row.vendor_sku}`);
      stats.skipped++;
      continue;
    }

    // Current variant_name is the color — normalize it
    const rawColor = (row.variant_name || '').trim();
    const colorLower = rawColor.toLowerCase();

    // Resolve to canonical color name (via alias or direct match)
    let canonicalColor = colorLower;
    if (COLOR_ALIASES[colorLower]) {
      canonicalColor = COLOR_ALIASES[colorLower];
    }
    // If still not a known flooring color, keep original (some are generic like "96")
    const isKnownColor = canonicalColors.has(canonicalColor);

    if (DRY_RUN) {
      console.log(`  ${row.vendor_sku}: "${rawColor}" → type="${accessoryType}", color="${isKnownColor ? canonicalColor : rawColor + ' (unknown)'}"`);
    } else {
      // Update variant_name to accessory type
      await pool.query(`UPDATE skus SET variant_name = $1 WHERE id = $2`, [accessoryType, row.sku_id]);

      // Store matching_color attribute (canonical name)
      if (isKnownColor) {
        await pool.query(`
          INSERT INTO sku_attributes (sku_id, attribute_id, value)
          VALUES ($1, $2, $3)
          ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value = $3
        `, [row.sku_id, matchingColorAttrId, canonicalColor]);
        stats.colorSet++;
      }
    }

    stats.renamed++;
    stats.byType[accessoryType] = (stats.byType[accessoryType] || 0) + 1;
  }

  console.log(`\nRenamed: ${stats.renamed}, Colors set: ${stats.colorSet}, Skipped: ${stats.skipped}`);
  console.log('By type:', stats.byType);

  if (!DRY_RUN) {
    // Verify
    console.log('\nVerification — sample accessories:');
    const verify = await pool.query(`
      SELECT s.variant_name AS type, sa.value AS matching_color, s.vendor_sku,
             pr.retail_price, p.name AS product
      FROM skus s
      JOIN products p ON p.id = s.product_id
      LEFT JOIN sku_attributes sa ON sa.sku_id = s.id
        AND sa.attribute_id = (SELECT id FROM attributes WHERE slug = 'matching_color')
      LEFT JOIN pricing pr ON pr.sku_id = s.id
      WHERE p.collection = 'Quick-Step' AND s.variant_type = 'accessory' AND s.status = 'active'
      ORDER BY p.name, sa.value, s.variant_name
      LIMIT 20
    `);
    for (const row of verify.rows) {
      console.log(`  ${row.product} | ${row.matching_color || '(none)'} | ${row.type} | $${row.retail_price || '?'}`);
    }

    // Count per product + type
    console.log('\nAccessory types per product:');
    const summary = await pool.query(`
      SELECT p.name, s.variant_name AS type, COUNT(*) as cnt
      FROM skus s
      JOIN products p ON p.id = s.product_id
      WHERE p.collection = 'Quick-Step' AND s.variant_type = 'accessory' AND s.status = 'active'
      GROUP BY p.name, s.variant_name
      ORDER BY p.name, s.variant_name
    `);
    for (const row of summary.rows) {
      console.log(`  ${row.name}: ${row.type} (${row.cnt})`);
    }
  }

  await pool.end();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
