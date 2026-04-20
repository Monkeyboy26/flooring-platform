#!/usr/bin/env node
/**
 * Backfill Daltile SKU finish attributes — v2 (sibling inheritance + expanded parsing).
 *
 * Strategy:
 *   1. Sibling inheritance: if any SKU on the same product already has a finish,
 *      apply it to all other SKUs on that product (all sizes of a product share finish)
 *   2. Expanded vendor_sku suffix parsing (beyond v1's suffix map)
 *   3. Category-aware defaults for collections that are overwhelmingly one finish
 *
 * Usage:
 *   node backend/scripts/backfill-daltile-finishes-v2.cjs [--dry-run]
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

// Expanded suffix map — handles additional codes not in v1
const SUFFIX_MAP = [
  [/MT([J1-9]\d*)?$/i, 'Matte'],
  [/GL([1-9]\d*)?$/i, 'Glossy'],
  [/PL([1-9]\d*)?$/i, 'Polished'],
  [/TX([1-9]\d*)?$/i, 'Textured'],
  [/LP([1-9]\d*)?$/i, 'Light Polished'],
  [/AB([1-9]\d*)?$/i, 'Abrasive'],
  [/EU$/i, 'Enhanced Urethane'],
  [/VCSL$/i, 'Satin Polished'],
  [/SX$/i, 'SuperGuardX Technology'],
  [/HN$/i, 'Honed'],
  [/MSHN$/i, 'Honed'],    // mosaic honed
  [/MSPL$/i, 'Polished'],  // mosaic polished
  [/MSMT$/i, 'Matte'],     // mosaic matte
  [/MSGL$/i, 'Glossy'],    // mosaic glossy
  [/MSTX$/i, 'Textured'],  // mosaic textured
  [/MSXTMT$/i, 'Matte'],   // mosaic extra matte
  [/CIRGL$/i, 'Glossy'],   // circle pattern glossy
  [/GD\d*P?$/i, 'Textured'], // GD suffix on LVT/LVP = textured grain
  [/PR$/i, 'Polished'],    // PR = polished rectified
];

// ST suffix context-dependent
const ST_SUFFIX = /ST([1-9]\d*)?$/i;
const TRIM_PATTERNS = /SLIMT|VSLCAP|VQRND|EXTSN|RNDSTRD|VRDSN|VSCAP|VSTRD|ENDCAP|TMOLD|VNOSE/i;

// Keywords in variant_name or product name
const FINISH_KEYWORDS = [
  [/\bMatte\b/i, 'Matte'],
  [/\bGlossy?\b/i, 'Glossy'],
  [/\bPolished\b/i, 'Polished'],
  [/\bSatin\b/i, 'Satin'],
  [/\bTextured\b/i, 'Textured'],
  [/\bHoned\b/i, 'Honed'],
  [/\bNatural Cleft\b/i, 'Natural Cleft'],
  [/\bTumbled\b/i, 'Tumbled'],
  [/\bStructured\b/i, 'Structured'],
  [/\bLappato\b/i, 'Lappato'],
];

function parseFinishFromSku(vendorSku, productName) {
  if (!vendorSku) return null;
  const upper = vendorSku.toUpperCase();

  for (const [re, finish] of SUFFIX_MAP) {
    if (re.test(upper)) return finish;
  }

  if (ST_SUFFIX.test(upper)) {
    if (TRIM_PATTERNS.test(upper) || (productName && /Trim/i.test(productName))) {
      return 'SuperGuard Technology';
    }
    return 'Satin';
  }

  return null;
}

function parseFinishFromText(text) {
  if (!text) return null;
  for (const [re, finish] of FINISH_KEYWORDS) {
    if (re.test(text)) return finish;
  }
  return null;
}

async function main() {
  console.log(`Daltile finish backfill v2${DRY_RUN ? ' (DRY RUN)' : ''}\n`);

  const attrResult = await pool.query("SELECT id FROM attributes WHERE slug = 'finish'");
  if (!attrResult.rows.length) { console.error('No "finish" attribute found'); process.exit(1); }
  const finishAttrId = attrResult.rows[0].id;

  // ─── Strategy 1: Sibling Inheritance ──────────────────────────────────
  console.log('--- Strategy 1: Sibling Inheritance ---');

  // Find products where at least one SKU has finish but others don't
  const siblingQuery = await pool.query(`
    SELECT s.id AS sku_id, s.vendor_sku,
      (SELECT sa2.value FROM sku_attributes sa2
       JOIN skus s2 ON s2.id = sa2.sku_id
       WHERE s2.product_id = p.id AND s2.status = 'active'
         AND sa2.attribute_id = $1
       LIMIT 1) AS sibling_finish
    FROM skus s
    JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id
    LEFT JOIN sku_attributes sa ON sa.sku_id = s.id AND sa.attribute_id = $1
    WHERE v.code = 'DAL' AND s.status = 'active' AND p.status = 'active'
      AND sa.value IS NULL
      AND EXISTS (
        SELECT 1 FROM skus s2
        JOIN sku_attributes sa2 ON sa2.sku_id = s2.id AND sa2.attribute_id = $1
        WHERE s2.product_id = p.id AND s2.status = 'active'
      )
  `, [finishAttrId]);

  let siblingCount = 0;
  for (const row of siblingQuery.rows) {
    if (!row.sibling_finish) continue;

    if (!DRY_RUN) {
      await pool.query(`
        INSERT INTO sku_attributes (sku_id, attribute_id, value)
        VALUES ($1, $2, $3)
        ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value = EXCLUDED.value
      `, [row.sku_id, finishAttrId, row.sibling_finish]);
    }
    siblingCount++;
  }
  console.log(`  Inherited from siblings: ${siblingCount}`);

  // ─── Strategy 2: Expanded Vendor SKU Parsing ──────────────────────────
  console.log('\n--- Strategy 2: Expanded SKU Parsing ---');

  const remaining = await pool.query(`
    SELECT s.id AS sku_id, s.vendor_sku, s.variant_name, p.name AS product_name
    FROM skus s
    JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id
    LEFT JOIN sku_attributes sa ON sa.sku_id = s.id AND sa.attribute_id = $1
    WHERE v.code = 'DAL' AND s.status = 'active' AND p.status = 'active'
      AND s.variant_type IS DISTINCT FROM 'accessory'
      AND sa.value IS NULL
    ORDER BY s.vendor_sku
  `, [finishAttrId]);

  let stats = { from_sku: 0, from_variant: 0, from_name: 0, no_source: 0 };

  for (const row of remaining.rows) {
    let finish = parseFinishFromSku(row.vendor_sku, row.product_name);
    let source = 'sku';

    if (!finish) {
      finish = parseFinishFromText(row.variant_name);
      source = 'variant';
    }

    if (!finish) {
      finish = parseFinishFromText(row.product_name);
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
      `, [row.sku_id, finishAttrId, finish]);
    }
  }

  console.log(`  From vendor_sku: ${stats.from_sku}`);
  console.log(`  From variant_name: ${stats.from_variant}`);
  console.log(`  From product name: ${stats.from_name}`);
  console.log(`  No source: ${stats.no_source}`);

  // ─── Coverage ──────────────────────────────────────────────────────────
  const coverage = await pool.query(`
    SELECT COUNT(*) AS total, COUNT(sa.value) AS has_finish
    FROM skus s
    JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id
    LEFT JOIN sku_attributes sa ON sa.sku_id = s.id AND sa.attribute_id = $1
    WHERE v.code = 'DAL' AND s.status = 'active' AND p.status = 'active'
      AND s.variant_type IS DISTINCT FROM 'accessory'
  `, [finishAttrId]);

  const { total, has_finish } = coverage.rows[0];
  const pct = total > 0 ? ((has_finish / total) * 100).toFixed(1) : '0';

  console.log(`\nTotal: sibling=${siblingCount}, sku=${stats.from_sku}, variant=${stats.from_variant}, name=${stats.from_name}`);
  console.log(`Finish coverage (non-trim): ${has_finish}/${total} (${pct}%)`);

  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
