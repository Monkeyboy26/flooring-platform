#!/usr/bin/env node
/**
 * Backfill / fix Daltile SKU size attributes.
 *
 * Fixes two issues:
 *   1. Combined sizes: "12x24, 1x6, 24x48, 3x24, 6x12" → single correct size
 *   2. Missing sizes: parse from vendor_sku (PLK/RCT/SQU/HEX patterns) or variant_name
 *
 * Usage:
 *   node backend/scripts/backfill-daltile-sizes.cjs [--dry-run]
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

/**
 * Parse the nominal size from a Daltile vendor_sku.
 * PLK624 → 6x24, RCT1224 → 12x24, SQU2424 → 24x24, HEX1212 → 12x12
 */
// Known valid tile sizes for validation of ambiguous patterns
const VALID_TILE_SIZES = new Set([
  '1x1','1x6','2x2','2x8','2x10',
  '3x6','3x12','3x15','3x24',
  '4x4','4x8','4x12','4x16','4x48',
  '6x6','6x12','6x18','6x24','6x36','6x48',
  '8x8','8x24','8x48',
  '10x14','12x10','12x12','12x24',
  '15x30','16x16','16x48',
  '18x18','18x36',
  '20x20','20x39',
  '24x24','24x48',
  '30x60','33x33','36x36',
  '39x59','48x48',
]);

function parseSizeFromVendorSku(vendorSku) {
  if (!vendorSku) return null;
  const upper = vendorSku.toUpperCase();
  // Primary: shape prefix + digits (PLK, RCT, SQU, SQ, HEX, XTP, RT)
  const match = upper.match(/(PLK|RCT|SQU|SQ|HEX|XTP|RT)(\d{2,4})/);
  if (match) return digitsToSize(match[2]);

  // Secondary: digit sequence before known suffixes (MOD, MS, 1P, SP, etc.)
  // Try 4, 3, 2 digit lengths and validate against known tile sizes
  // to avoid grabbing color code digits
  const SUFFIX = /(MOD|MS\d|MS1P|MSMT|MSGL|PANEL|1PK?\b|1P2\b|1L\b|TRD)/;
  for (const len of [4, 3, 2]) {
    const re = new RegExp('(\\d{' + len + '})' + SUFFIX.source);
    const m = upper.match(re);
    if (m) {
      const size = digitsToSize(m[1]);
      if (size && VALID_TILE_SIZES.has(size)) return size;
    }
  }

  return null;
}

function digitsToSize(digits) {
  if (digits.length === 4) {
    return `${parseInt(digits.slice(0, 2))}x${parseInt(digits.slice(2))}`;
  }
  if (digits.length === 3) {
    return `${parseInt(digits[0])}x${parseInt(digits.slice(1))}`;
  }
  if (digits.length === 2) {
    return `${parseInt(digits[0])}x${parseInt(digits[1])}`;
  }
  return null;
}

/**
 * Normalize a size value: strip quotes, normalize separators.
 */
function normalizeSize(s) {
  if (!s) return null;
  return s.trim().replace(/["″'']/g, '').replace(/\s*[xX×]\s*/g, 'x').trim() || null;
}

/**
 * Resolve the correct single size for a SKU.
 */
function resolveSingleSize(currentSize, vendorSku, variantName) {
  // 1. Parse from vendor_sku — most reliable
  const skuParsed = parseSizeFromVendorSku(vendorSku);
  if (skuParsed) return skuParsed;

  // 1b. Trim type → size mapping (each trim profile type has a standard size)
  if (vendorSku) {
    const v = vendorSku.toUpperCase();
    if (v.includes('SLIMT')) return '2x94';
    if (v.includes('VSLCAP')) return '1 3/8x94';
    if (v.includes('VQRND')) return '3/4x94';
    if (v.includes('EXTSN')) return '1 3/4x94';
    if (v.includes('RNDSTRD')) return '12 1/5x50';
    if (v.includes('VRDSN')) return '1 3/4x94';
  }

  // 2. If variant_name is purely a size (e.g., "12x24"), use it
  if (variantName) {
    const clean = normalizeSize(variantName);
    if (clean && /^\d+(\.\d+)?x\d+(\.\d+)?$/.test(clean)) return clean;
  }

  // 2b. Extract size embedded in variant_name (e.g., "Diamond 12x24" → "12x24")
  if (variantName) {
    const embedded = variantName.match(/(\d+(?:\.\d+)?)\s*[xX×]\s*(\d+(?:\.\d+)?)/);
    if (embedded) return `${embedded[1]}x${embedded[2]}`;
  }

  // 3. If current size has commas and variant_name matches one of them
  if (currentSize && currentSize.includes(',') && variantName) {
    const sizes = currentSize.split(',').map(s => normalizeSize(s)).filter(Boolean);
    const vClean = normalizeSize(variantName);
    if (vClean) {
      const match = sizes.find(s => s === vClean);
      if (match) return match;
    }
  }

  // 4. If current size is single (no commas), keep it
  if (currentSize && !currentSize.includes(',')) return normalizeSize(currentSize);

  return null;
}

async function main() {
  console.log(`Daltile size backfill${DRY_RUN ? ' (DRY RUN)' : ''}`);

  // Get the size attribute ID
  const attrResult = await pool.query("SELECT id FROM attributes WHERE slug = 'size'");
  if (!attrResult.rows.length) {
    console.error('No "size" attribute found in attributes table');
    process.exit(1);
  }
  const sizeAttrId = attrResult.rows[0].id;

  // Load all DAL SKUs with their current size attribute (if any)
  const result = await pool.query(`
    SELECT s.id AS sku_id, s.vendor_sku, s.variant_name,
      sa.value AS current_size
    FROM skus s
    JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id
    LEFT JOIN sku_attributes sa ON sa.sku_id = s.id AND sa.attribute_id = $1
    WHERE v.code = 'DAL'
    ORDER BY s.vendor_sku
  `, [sizeAttrId]);

  console.log(`Loaded ${result.rows.length} DAL SKUs`);

  let stats = { fixed_combined: 0, added_missing: 0, unchanged: 0, no_source: 0 };

  for (const row of result.rows) {
    const { sku_id, vendor_sku, variant_name, current_size } = row;

    if (current_size && !current_size.includes(',')) {
      // Already has a clean single size
      stats.unchanged++;
      continue;
    }

    const resolved = resolveSingleSize(current_size, vendor_sku, variant_name);

    if (!resolved) {
      stats.no_source++;
      continue;
    }

    // Check if this is fixing a combined size or adding a missing one
    const isCombinedFix = current_size && current_size.includes(',');

    if (DRY_RUN) {
      if (isCombinedFix) {
        console.log(`  FIX: ${vendor_sku} "${current_size}" → "${resolved}"`);
        stats.fixed_combined++;
      } else {
        stats.added_missing++;
      }
      continue;
    }

    // Upsert the size attribute
    await pool.query(`
      INSERT INTO sku_attributes (sku_id, attribute_id, value)
      VALUES ($1, $2, $3)
      ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value = EXCLUDED.value
    `, [sku_id, sizeAttrId, resolved]);

    if (isCombinedFix) {
      stats.fixed_combined++;
    } else {
      stats.added_missing++;
    }
  }

  console.log(`\nResults:`);
  console.log(`  Fixed combined sizes: ${stats.fixed_combined}`);
  console.log(`  Added missing sizes:  ${stats.added_missing}`);
  console.log(`  Already clean:        ${stats.unchanged}`);
  console.log(`  No source available:  ${stats.no_source}`);

  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
