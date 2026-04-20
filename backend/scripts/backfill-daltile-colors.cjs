#!/usr/bin/env node
/**
 * Backfill Daltile SKU color attributes.
 *
 * Color is at 19% coverage — the worst attribute gap. Strategy:
 *   1. Parse from product name: strip collection prefix → remaining = color
 *      e.g., "Color Wheel Classic Desert Gray" → strip "Color Wheel Classic" → "Desert Gray"
 *   2. Fall back to variant_name if it contains non-size text
 *   3. Skip trim/accessory products (color not meaningful for trims)
 *
 * Product name format from EDI 832 scraper: "{Collection} {TitleCaseColor}"
 *
 * Usage:
 *   node backend/scripts/backfill-daltile-colors.cjs --dry-run   # Preview
 *   node backend/scripts/backfill-daltile-colors.cjs              # Execute
 */
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || process.env.PGHOST || 'localhost',
  port: parseInt(process.env.DB_PORT || process.env.PGPORT || '5432'),
  database: process.env.DB_NAME || process.env.PGDATABASE || 'flooring_pim',
  user: process.env.DB_USER || process.env.PGUSER || 'postgres',
  password: process.env.DB_PASSWORD || process.env.PGPASSWORD || 'postgres',
});

const DRY_RUN = process.argv.includes('--dry-run');

// Patterns that indicate a variant_name is a size, not a color
const SIZE_LIKE_RE = /^\d+(\.\d+)?\s*[xX×]\s*\d+/;
const PURE_NUMBER_RE = /^\d+(\.\d+)?$/;

// Finish terms that might be embedded in color — strip them
const FINISH_TERMS = [
  'Matte', 'Glossy', 'Polished', 'Honed', 'Textured', 'Tumbled',
  'Lappato', 'Structured', 'Satin Polished', 'Light Polished',
  'Superguardx Technology', 'Superguard Technology',
  'Enhanced Urethane', 'Abrasive', 'Semi-Textured',
];
const finishPattern = new RegExp(
  '\\s*(?:' + FINISH_TERMS.map(t => t.replace(/\s+/g, '\\s+')).join('|') + ')\\s*',
  'gi'
);

/**
 * Extract color from product name by stripping the collection prefix.
 * "Acreage Highland" with collection "Acreage" → "Highland"
 * "Color Wheel Classic Desert Gray" with collection "Color Wheel Classic" → "Desert Gray"
 */
function extractColorFromName(productName, collection) {
  if (!productName || !collection) return null;

  // Product name must start with collection
  if (!productName.startsWith(collection)) return null;

  // Get the remaining text after collection prefix
  let color = productName.slice(collection.length).trim();

  // Skip if nothing remains
  if (!color) return null;

  // Skip trim/accessories indicators
  if (/Trim|Accessories|Bullnose|Quarter Round|Molding/i.test(color)) return null;

  // Strip embedded finish terms
  color = color.replace(finishPattern, ' ').trim();

  // Strip any trailing size info (e.g., "12x24")
  color = color.replace(/\s+\d+(\.\d+)?\s*[xX×]\s*\d+(\.\d+)?\s*$/, '').trim();

  // Skip if it looks like a size or code, not a color
  if (SIZE_LIKE_RE.test(color)) return null;
  if (PURE_NUMBER_RE.test(color)) return null;
  if (color.length <= 1) return null;

  // Skip if it's just a shape descriptor
  if (/^(Rectangle|Hexagon|Square|Plank|Mosaic|Cove|Bullnose)$/i.test(color)) return null;

  return color;
}

/**
 * Try to extract color from variant_name (fallback).
 * Only use if it's not a size or dimension.
 */
function extractColorFromVariant(variantName) {
  if (!variantName) return null;
  const v = variantName.trim();

  // Skip if it looks like a size
  if (SIZE_LIKE_RE.test(v)) return null;
  if (PURE_NUMBER_RE.test(v)) return null;
  if (v.length <= 1) return null;

  // Skip known non-color variant names
  if (/^(Rectangle|Hexagon|Square|Plank|Mosaic|Matte|Glossy|Polished|Textured)$/i.test(v)) return null;

  // Strip finish terms from variant name too
  let color = v.replace(finishPattern, ' ').trim();
  if (!color || color.length <= 1) return null;

  return color;
}

async function main() {
  console.log(`Daltile color backfill${DRY_RUN ? ' (DRY RUN)' : ''}\n`);

  // Get the color attribute ID
  const attrResult = await pool.query("SELECT id FROM attributes WHERE slug = 'color'");
  if (!attrResult.rows.length) {
    console.error('No "color" attribute found in attributes table');
    process.exit(1);
  }
  const colorAttrId = attrResult.rows[0].id;

  // Load all DAL SKUs without a color attribute
  const result = await pool.query(`
    SELECT s.id AS sku_id, s.vendor_sku, s.variant_name,
      p.name AS product_name, p.collection,
      s.variant_type
    FROM skus s
    JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id
    LEFT JOIN sku_attributes sa ON sa.sku_id = s.id AND sa.attribute_id = $1
    WHERE v.code = 'DAL' AND s.status = 'active' AND p.status = 'active'
      AND sa.value IS NULL
    ORDER BY p.collection, p.name
  `, [colorAttrId]);

  console.log(`Found ${result.rows.length} DAL SKUs without color\n`);

  let stats = { from_name: 0, from_variant: 0, no_source: 0, skipped_trim: 0 };

  for (const row of result.rows) {
    const { sku_id, variant_name, product_name, collection, variant_type } = row;

    // Skip trim/accessory SKUs — color isn't meaningful
    if (variant_type === 'accessory' || /Trim|Accessories/i.test(product_name)) {
      stats.skipped_trim++;
      continue;
    }

    // 1. Try extracting color from product name
    let color = extractColorFromName(product_name, collection);
    let source = 'name';

    // 2. Fall back to variant_name
    if (!color) {
      color = extractColorFromVariant(variant_name);
      source = 'variant';
    }

    if (!color) {
      stats.no_source++;
      continue;
    }

    stats[`from_${source}`]++;

    if (DRY_RUN) {
      if (stats.from_name + stats.from_variant <= 30) {
        console.log(`  [${source}] "${product_name}" → color: "${color}"`);
      }
      continue;
    }

    await pool.query(`
      INSERT INTO sku_attributes (sku_id, attribute_id, value)
      VALUES ($1, $2, $3)
      ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value = EXCLUDED.value
    `, [sku_id, colorAttrId, color]);
  }

  console.log(`\nResults:`);
  console.log(`  From product name:     ${stats.from_name}`);
  console.log(`  From variant_name:     ${stats.from_variant}`);
  console.log(`  No source available:   ${stats.no_source}`);
  console.log(`  Skipped trims:         ${stats.skipped_trim}`);
  console.log(`  Total colors added:    ${stats.from_name + stats.from_variant}`);

  // Show coverage stats
  const coverage = await pool.query(`
    SELECT
      COUNT(*) AS total_active,
      COUNT(sa.value) AS has_color
    FROM skus s
    JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id
    LEFT JOIN sku_attributes sa ON sa.sku_id = s.id AND sa.attribute_id = $1
    WHERE v.code = 'DAL' AND s.status = 'active' AND p.status = 'active'
      AND s.variant_type IS DISTINCT FROM 'accessory'
  `, [colorAttrId]);

  if (coverage.rows.length) {
    const { total_active, has_color } = coverage.rows[0];
    const pct = total_active > 0 ? ((has_color / total_active) * 100).toFixed(1) : '0';
    console.log(`\nColor coverage (non-trim): ${has_color}/${total_active} (${pct}%)`);
  }

  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
