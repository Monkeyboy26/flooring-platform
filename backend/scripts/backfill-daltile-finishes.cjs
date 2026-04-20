#!/usr/bin/env node
/**
 * Backfill Daltile SKU finish attributes.
 *
 * Parses finish from:
 *   1. Vendor_sku suffix (MT=Matte, GL=Glossy, PL=Polished, etc.)
 *   2. variant_name keywords ("Matte", "Glossy", etc.)
 *   3. Product name keywords (fallback)
 *
 * Usage:
 *   node backend/scripts/backfill-daltile-finishes.cjs [--dry-run]
 */
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.PGHOST || 'localhost',
  port: process.env.PGPORT || 5432,
  database: process.env.PGDATABASE || 'flooring_pim',
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'postgres',
});

const DRY_RUN = process.argv.includes('--dry-run');

// Vendor_sku suffix → finish mapping
// Suffix must appear at end of SKU (possibly followed by J/1/2 piece codes)
const SUFFIX_MAP = [
  [/MT([J1-9]\d*)?$/i, 'Matte'],
  [/GL([1-9]\d*)?$/i, 'Glossy'],
  [/PL([1-9]\d*)?$/i, 'Polished'],
  [/TX([1-9]\d*)?$/i, 'Textured'],
  [/LP([1-9]\d*)?$/i, 'Light Polished'],
  [/AB([1-9]\d*)?$/i, 'Abrasive'],
  [/EU$/i, 'Enhanced Urethane'],
  [/VCSL$/i, 'Satin Polished'],
  // SX = SuperGuardX Technology (trim pieces)
  [/SX$/i, 'SuperGuardX Technology'],
];

// ST suffix is context-dependent
const ST_SUFFIX = /ST([1-9]\d*)?$/i;

// Trim type indicators in vendor_sku
const TRIM_PATTERNS = /SLIMT|VSLCAP|VQRND|EXTSN|RNDSTRD|VRDSN|VSCAP|VSTRD|ENDCAP|TMOLD|VNOSE/i;

// Keywords to find finish in text fields
const FINISH_KEYWORDS = [
  [/\bMatte\b/i, 'Matte'],
  [/\bGlossy\b/i, 'Glossy'],
  [/\bPolished\b/i, 'Polished'],
  [/\bSatin\b/i, 'Satin'],
  [/\bTextured\b/i, 'Textured'],
  [/\bHoned\b/i, 'Honed'],
  [/\bNatural Cleft\b/i, 'Natural Cleft'],
  [/\bTumbled\b/i, 'Tumbled'],
];

/**
 * Parse finish from vendor_sku suffix.
 */
function parseFinishFromSku(vendorSku, productName) {
  if (!vendorSku) return null;
  const upper = vendorSku.toUpperCase();

  for (const [re, finish] of SUFFIX_MAP) {
    if (re.test(upper)) return finish;
  }

  // ST suffix: SuperGuard Technology for trims, Satin for tiles
  if (ST_SUFFIX.test(upper)) {
    if (TRIM_PATTERNS.test(upper) || (productName && /Trim/i.test(productName))) {
      return 'SuperGuard Technology';
    }
    return 'Satin';
  }

  return null;
}

/**
 * Extract finish from a text field (variant_name or product name).
 */
function parseFinishFromText(text) {
  if (!text) return null;
  for (const [re, finish] of FINISH_KEYWORDS) {
    if (re.test(text)) return finish;
  }
  return null;
}

async function main() {
  console.log(`Daltile finish backfill${DRY_RUN ? ' (DRY RUN)' : ''}`);

  const attrResult = await pool.query("SELECT id FROM attributes WHERE slug = 'finish'");
  if (!attrResult.rows.length) {
    console.error('No "finish" attribute found');
    process.exit(1);
  }
  const finishAttrId = attrResult.rows[0].id;

  // Load all DAL SKUs without finish
  const result = await pool.query(`
    SELECT s.id AS sku_id, s.vendor_sku, s.variant_name, p.name as product_name
    FROM skus s
    JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id
    LEFT JOIN sku_attributes sa ON sa.sku_id = s.id AND sa.attribute_id = $1
    WHERE v.code = 'DAL' AND sa.value IS NULL
    ORDER BY s.vendor_sku
  `, [finishAttrId]);

  console.log(`Found ${result.rows.length} DAL SKUs without finish`);

  let stats = { from_sku: 0, from_variant: 0, from_name: 0, no_source: 0 };

  for (const row of result.rows) {
    const { sku_id, vendor_sku, variant_name, product_name } = row;

    // 1. Try vendor_sku suffix
    let finish = parseFinishFromSku(vendor_sku, product_name);
    let source = 'sku';

    // 2. Try variant_name
    if (!finish) {
      finish = parseFinishFromText(variant_name);
      source = 'variant';
    }

    // 3. Try product name
    if (!finish) {
      finish = parseFinishFromText(product_name);
      source = 'name';
    }

    if (!finish) {
      stats.no_source++;
      continue;
    }

    stats[`from_${source}`]++;

    if (!DRY_RUN) {
      await pool.query(`
        INSERT INTO sku_attributes (sku_id, attribute_id, value)
        VALUES ($1, $2, $3)
        ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value = EXCLUDED.value
      `, [sku_id, finishAttrId, finish]);
    }
  }

  console.log(`\nResults:`);
  console.log(`  From vendor_sku suffix: ${stats.from_sku}`);
  console.log(`  From variant_name:      ${stats.from_variant}`);
  console.log(`  From product name:      ${stats.from_name}`);
  console.log(`  No source available:    ${stats.no_source}`);
  console.log(`  Total added:            ${stats.from_sku + stats.from_variant + stats.from_name}`);

  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
