#!/usr/bin/env node
/**
 * Backfill Daltile SKU size attributes — v2 (enhanced vendor_sku parsing).
 *
 * Strategy:
 *   1. Enhanced vendor_sku parsing: strip the 4-char color-code prefix
 *      ({2 alpha}{2 digit}), then find size digits in what remains.
 *      Handles patterns like LS42|1224|J1PV → 12x24
 *   2. Mosaic pattern parsing: BJMS → brick joint, HERRMS → herringbone, etc.
 *   3. LVT plank parsing: 648CLVT → 6x48, 747GD → 7x47
 *   4. Sibling consensus: if ALL siblings with a size share the same value,
 *      apply that to the missing ones too.
 *
 * Usage:
 *   node backend/scripts/backfill-daltile-sizes-v2.cjs [--dry-run]
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

// Known valid tile/plank sizes for validation
const VALID_SIZES = new Set([
  '1x1','1x3','1x4','1x6','1x12',
  '2x2','2x4','2x6','2x8','2x10','2x12',
  '3x3','3x6','3x12','3x15','3x24',
  '4x4','4x8','4x12','4x16','4x48',
  '6x6','6x12','6x18','6x24','6x36','6x48',
  '7x47','7x48',
  '8x8','8x10','8x24','8x36','8x48',
  '9x12','9x36',
  '10x14','10x16',
  '12x10','12x12','12x24','12x36','12x48',
  '13x13',
  '14x14','15x15','15x30',
  '16x16','16x32','16x48',
  '18x18','18x36',
  '20x20','20x39',
  '24x24','24x48',
  '30x30','30x60',
  '33x33','36x36',
  '39x59','48x48',
]);

/**
 * Parse size from Daltile vendor_sku using multiple strategies.
 */
function parseSizeFromSku(vendorSku) {
  if (!vendorSku) return null;
  const upper = vendorSku.toUpperCase();

  // ─── Strategy A: Shape prefix (PLK, RCT, SQU, HEX, XTP, RT) ─────
  const shapeMatch = upper.match(/(PLK|RCT|SQU|SQ|HEX|XTP|RT)(\d{2,4})/);
  if (shapeMatch) {
    const size = digitsToSize(shapeMatch[2]);
    if (size && VALID_SIZES.has(size)) return size;
  }

  // ─── Strategy B: LVT/LVP plank → {color}{3-4 digit size}CLVT ─────
  const lvtMatch = upper.match(/(\d{3,4})CLVT/);
  if (lvtMatch) {
    const size = digitsToSize(lvtMatch[1]);
    if (size && VALID_SIZES.has(size)) return size;
  }

  // ─── Strategy C: LVP/hardwood GD suffix → {color}{3-4 digit size}GD ─
  const gdMatch = upper.match(/(\d{3,4})GD/);
  if (gdMatch) {
    const size = digitsToSize(gdMatch[1]);
    if (size && VALID_SIZES.has(size)) return size;
  }

  // ─── Strategy D: Brick joint mosaic → digit(s) before BJMS ────────
  const bjMatch = upper.match(/(\d{2,4})(?:HERR)?BJMS/);
  if (bjMatch) {
    const size = digitsToSize(bjMatch[1]);
    if (size && VALID_SIZES.has(size)) return size;
  }

  // ─── Strategy E: Herringbone mosaic → digit(s) before HERRMS ──────
  const herrMatch = upper.match(/(\d{2,4})HERRMS/);
  if (herrMatch) {
    const size = digitsToSize(herrMatch[1]);
    if (size && VALID_SIZES.has(size)) return size;
  }

  // ─── Strategy F: Generic mosaic → digit(s) before MS suffix ───────
  // Match {digits}MS where MS is followed by end, 1P, MT, GL, PL, HN, TX
  const msMatch = upper.match(/(\d{2,4})MS(?:$|1[PU]|MT|GL|PL|HN|TX|XT)/);
  if (msMatch) {
    const size = digitsToSize(msMatch[1]);
    if (size && VALID_SIZES.has(size)) return size;
  }

  // ─── Strategy G: Strip 4-char color prefix, find 3-4 digit size ───
  // Pattern: {2 alpha}{2 digit}{size digits}{suffix}
  // e.g., LS42|1224|J1PV → 12x24
  const colorPrefixMatch = upper.match(/^[A-Z]{2}\d{2}(\d{3,4})/);
  if (colorPrefixMatch) {
    const size = digitsToSize(colorPrefixMatch[1]);
    if (size && VALID_SIZES.has(size)) return size;
  }

  // ─── Strategy H: 3-char color prefix (some codes are X## or ##X) ──
  const shortPrefixMatch = upper.match(/^[A-Z0-9]{3}(\d{3,4})/);
  if (shortPrefixMatch) {
    const size = digitsToSize(shortPrefixMatch[1]);
    if (size && VALID_SIZES.has(size)) return size;
  }

  // ─── Strategy I: Find digit sequence before known suffixes ─────────
  const suffixPatterns = /(J\d|1P\d?|A1P|MOD|MSMT|MSGL|MSPL|MSHN|1L|1U|TRD|C1P|H1P)/;
  for (const len of [4, 3]) {
    const re = new RegExp('(\\d{' + len + '})' + suffixPatterns.source);
    const m = upper.match(re);
    if (m) {
      const size = digitsToSize(m[1]);
      if (size && VALID_SIZES.has(size)) return size;
    }
  }

  // ─── Strategy J: Trim profile sizes ────────────────────────────────
  if (upper.includes('SLIMT')) return '2x94';
  if (upper.includes('VSLCAP')) return '1 3/8x94';
  if (upper.includes('VQRND')) return '3/4x94';
  if (upper.includes('EXTSN')) return '1 3/4x94';

  return null;
}

function digitsToSize(digits) {
  if (digits.length === 4) return `${parseInt(digits.slice(0, 2))}x${parseInt(digits.slice(2))}`;
  if (digits.length === 3) return `${parseInt(digits[0])}x${parseInt(digits.slice(1))}`;
  if (digits.length === 2) return `${parseInt(digits[0])}x${parseInt(digits[1])}`;
  return null;
}

/**
 * Extract size from variant_name.
 */
function parseSizeFromVariant(variantName) {
  if (!variantName) return null;
  // Direct dimension match: "12x24", "6X48", etc.
  const m = variantName.match(/(\d+(?:\.\d+)?)\s*[xX×]\s*(\d+(?:\.\d+)?)/);
  if (m) return `${m[1]}x${m[2]}`;
  return null;
}

async function main() {
  console.log(`Daltile size backfill v2${DRY_RUN ? ' (DRY RUN)' : ''}\n`);

  const attrResult = await pool.query("SELECT id FROM attributes WHERE slug = 'size'");
  if (!attrResult.rows.length) { console.error('No "size" attribute found'); process.exit(1); }
  const sizeAttrId = attrResult.rows[0].id;

  // ─── Strategy 1: Enhanced vendor_sku + variant_name parsing ────────
  console.log('--- Strategy 1: Enhanced SKU/Variant Parsing ---');

  const missing = await pool.query(`
    SELECT s.id AS sku_id, s.vendor_sku, s.variant_name, s.product_id, p.name
    FROM skus s
    JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id
    LEFT JOIN sku_attributes sa ON sa.sku_id = s.id AND sa.attribute_id = $1
    WHERE v.code = 'DAL' AND s.status = 'active' AND p.status = 'active'
      AND sa.value IS NULL
    ORDER BY s.vendor_sku
  `, [sizeAttrId]);

  console.log(`  SKUs missing size: ${missing.rows.length}`);

  let stats = { from_sku: 0, from_variant: 0, from_sibling: 0, no_source: 0 };
  const stillMissing = []; // Track for sibling pass

  for (const row of missing.rows) {
    let size = parseSizeFromSku(row.vendor_sku);
    let source = 'sku';

    if (!size) {
      size = parseSizeFromVariant(row.variant_name);
      source = 'variant';
    }

    if (!size) {
      stillMissing.push(row);
      continue;
    }

    stats[`from_${source}`]++;

    if (DRY_RUN && (stats.from_sku + stats.from_variant) <= 20) {
      console.log(`  [${source}] ${row.vendor_sku} → "${size}"`);
    }

    if (!DRY_RUN) {
      await pool.query(`
        INSERT INTO sku_attributes (sku_id, attribute_id, value)
        VALUES ($1, $2, $3)
        ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value = EXCLUDED.value
      `, [row.sku_id, sizeAttrId, size]);
    }
  }

  console.log(`  Parsed from vendor_sku: ${stats.from_sku}`);
  console.log(`  Parsed from variant: ${stats.from_variant}`);
  console.log(`  Still missing: ${stillMissing.length}`);

  // ─── Strategy 2: Sibling Consensus ─────────────────────────────────
  // If ALL siblings with size agree on the same value, apply to missing SKUs.
  // This helps when a product has one standard size and some SKUs missed parsing.
  console.log('\n--- Strategy 2: Sibling Consensus ---');

  for (const row of stillMissing) {
    const siblings = await pool.query(`
      SELECT DISTINCT sa.value
      FROM skus s
      JOIN sku_attributes sa ON sa.sku_id = s.id AND sa.attribute_id = $1
      WHERE s.product_id = $2 AND s.status = 'active' AND s.id <> $3
    `, [sizeAttrId, row.product_id, row.sku_id]);

    // Only inherit if all siblings agree on one size
    if (siblings.rows.length === 1) {
      const size = siblings.rows[0].value;
      stats.from_sibling++;

      if (DRY_RUN && stats.from_sibling <= 10) {
        console.log(`  [sibling] ${row.vendor_sku} (${row.name}) → "${size}"`);
      }

      if (!DRY_RUN) {
        await pool.query(`
          INSERT INTO sku_attributes (sku_id, attribute_id, value)
          VALUES ($1, $2, $3)
          ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value = EXCLUDED.value
        `, [row.sku_id, sizeAttrId, size]);
      }
    } else {
      stats.no_source++;
    }
  }

  console.log(`  From sibling consensus: ${stats.from_sibling}`);
  console.log(`  No source available: ${stats.no_source}`);

  // ─── Coverage ──────────────────────────────────────────────────────
  const coverage = await pool.query(`
    SELECT COUNT(*) AS total, COUNT(sa.value) AS has_size
    FROM skus s
    JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id
    LEFT JOIN sku_attributes sa ON sa.sku_id = s.id AND sa.attribute_id = $1
    WHERE v.code = 'DAL' AND s.status = 'active' AND p.status = 'active'
      AND s.variant_type IS DISTINCT FROM 'accessory'
  `, [sizeAttrId]);

  const { total, has_size } = coverage.rows[0];
  const pct = total > 0 ? ((has_size / total) * 100).toFixed(1) : '0';
  console.log(`\nSize coverage (non-trim): ${has_size}/${total} (${pct}%)`);

  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
