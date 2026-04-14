#!/usr/bin/env node
/**
 * Backfill Missing EAV Attributes from variant_name Patterns
 *
 * Connects to PostgreSQL and parses variant_name on SKUs to extract
 * color, finish, size, material, and thickness attributes that are
 * currently missing from sku_attributes.
 *
 * Usage:
 *   node backend/scripts/backfill-attributes.cjs --dry-run   # Preview changes
 *   node backend/scripts/backfill-attributes.cjs              # Execute backfill
 */

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/flooring_pim',
});

const DRY_RUN = process.argv.includes('--dry-run');

// ---------------------------------------------------------------------------
// Vendors where color extraction from variant_name is unreliable
// (variant_name contains full product descriptions, not color info)
// ---------------------------------------------------------------------------
const COLOR_SKIP_VENDORS = new Set(['JMV']);

// ---------------------------------------------------------------------------
// Words that are shapes/forms, not colors — filter from color extraction
// ---------------------------------------------------------------------------
const NON_COLOR_WORDS = new Set([
  'rectangle', 'square', 'hexagon', 'octagon', 'mosaic', 'trim', 'liner',
  'bullnose', 'cove', 'base', 'outcorner', 'incorner', 'quarter', 'round',
  'pencil', 'chair', 'rail', 'sink', 'v-cap', 'molding', 'reducer',
  'stair', 'nosing', 'threshold', 'saddle', 'transition', 'corner',
  'edge', 'strip', 'plank', 'tile', 'slab', 'sheet', 'roll',
  'field', 'accent', 'border', 'deco', 'insert', 'medallion',
  'stepwise', 'countertop', 'unit', 'part', 'set', 'piece',
]);

// ---------------------------------------------------------------------------
// Known finish vocabulary (case-insensitive match)
// ---------------------------------------------------------------------------
const KNOWN_FINISHES = [
  'Matte', 'Polished', 'Satin', 'Honed', 'Brushed', 'Textured',
  'Natural', 'Glossy', 'Lappato', 'Rectified', 'Tumbled', 'Chiseled',
];

const FINISH_PATTERN = new RegExp(
  '\\b(' + KNOWN_FINISHES.map(f => f.toLowerCase()).join('|') + ')\\b',
  'gi'
);

// ---------------------------------------------------------------------------
// Size patterns
// ---------------------------------------------------------------------------
// Matches: 12x24, 6 x 24, 12"x24", 6X24, 12 X 24, 4×8, etc.
const SIZE_PATTERN = /\b(\d+(?:\.\d+)?)\s*['"]?\s*[xX×]\s*(\d+(?:\.\d+)?)\s*['"]?\b/g;

// Thickness: 8mm, 12mm, etc.
const THICKNESS_PATTERN = /\b(\d+(?:\.\d+)?)\s*mm\b/gi;

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

/**
 * Normalize a size string: "12 X 24" → "12x24"
 */
function normalizeSize(match, w, h) {
  return `${w}x${h}`;
}

/**
 * Normalize a finish string to title-case controlled vocabulary.
 */
function normalizeFinish(raw) {
  const lower = raw.toLowerCase();
  const found = KNOWN_FINISHES.find(f => f.toLowerCase() === lower);
  return found || (raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase());
}

/**
 * Title-case a string for color values.
 */
function titleCase(str) {
  if (!str) return '';
  return str
    .trim()
    .replace(/\s+/g, ' ')
    .split(' ')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

/**
 * Parse a variant_name and extract attributes.
 *
 * Returns an object with keys: size, finish, thickness, color
 * Only keys where a value was extracted will be present.
 */
function parseVariantName(variantName, productName, collection, vendorCode) {
  const result = {};
  let remaining = variantName;

  // --- Extract sizes ---
  const sizeMatches = [];
  let sizeMatch;
  SIZE_PATTERN.lastIndex = 0;
  while ((sizeMatch = SIZE_PATTERN.exec(variantName)) !== null) {
    const normalized = normalizeSize(sizeMatch[0], sizeMatch[1], sizeMatch[2]);
    sizeMatches.push(normalized);
    remaining = remaining.replace(sizeMatch[0], ' ');
  }
  if (sizeMatches.length > 0) {
    result.size = sizeMatches.join(', ');
  }

  // --- Extract thickness ---
  THICKNESS_PATTERN.lastIndex = 0;
  const thicknessMatch = THICKNESS_PATTERN.exec(variantName);
  if (thicknessMatch) {
    result.thickness = thicknessMatch[1] + 'mm';
    remaining = remaining.replace(thicknessMatch[0], ' ');
  }

  // --- Extract finishes ---
  const finishMatches = [];
  let finishMatch;
  FINISH_PATTERN.lastIndex = 0;
  while ((finishMatch = FINISH_PATTERN.exec(remaining)) !== null) {
    const normalized = normalizeFinish(finishMatch[1]);
    if (!finishMatches.includes(normalized)) {
      finishMatches.push(normalized);
    }
  }
  if (finishMatches.length > 0) {
    result.finish = finishMatches.join(', ');
    // Remove finish words from remaining text
    for (const f of finishMatches) {
      remaining = remaining.replace(new RegExp('\\b' + f + '\\b', 'gi'), ' ');
    }
  }

  // --- Extract color (whatever meaningful text remains) ---
  // Skip color extraction entirely for vendors with unreliable variant names
  if (!COLOR_SKIP_VENDORS.has(vendorCode)) {
    // Clean up remaining text
    remaining = remaining
      .replace(/[,\-|/]+/g, ' ')  // Replace separators with spaces
      .replace(/\d+(?:\.\d+)?\s*(?:mm|cm|in|ft|sf|sqft)\b/gi, ' ')  // Remove stray dimensions
      .replace(/\s+/g, ' ')
      .trim();

    // Remove non-color words (shapes, forms, parts)
    const words = remaining.split(' ').filter(w => !NON_COLOR_WORDS.has(w.toLowerCase()));
    remaining = words.join(' ').trim();

    // Skip if the remainder is empty, or matches the product name / collection
    if (remaining.length > 0) {
      const remainLower = remaining.toLowerCase();
      const productLower = (productName || '').toLowerCase().trim();
      const collectionLower = (collection || '').toLowerCase().trim();

      // Don't use the color if it's just the product name or collection repeated
      const isJustProductName = remainLower === productLower;
      const isJustCollection = remainLower === collectionLower;
      // Also skip if it's purely numeric or too short to be meaningful
      const isPurelyNumeric = /^\d+$/.test(remaining);
      const isTooShort = remaining.length < 2;

      if (!isJustProductName && !isJustCollection && !isPurelyNumeric && !isTooShort) {
        result.color = titleCase(remaining);
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Main backfill logic
// ---------------------------------------------------------------------------
async function main() {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`  Backfill Attributes from variant_name${DRY_RUN ? ' (DRY RUN)' : ''}`);
  console.log(`  ${new Date().toISOString()}`);
  console.log(`${'='.repeat(70)}\n`);

  // Step 1: Look up attribute IDs for the 5 core attributes
  const attrResult = await pool.query(`
    SELECT id, slug FROM attributes
    WHERE slug IN ('color', 'finish', 'size', 'material', 'thickness')
  `);

  const attrIdMap = {};
  for (const row of attrResult.rows) {
    attrIdMap[row.slug] = row.id;
  }

  const coreAttrs = ['color', 'finish', 'size', 'material', 'thickness'];
  const missingAttrs = coreAttrs.filter(a => !attrIdMap[a]);
  if (missingAttrs.length > 0) {
    console.log(`  WARNING: Missing attribute definitions for: ${missingAttrs.join(', ')}`);
    console.log(`  These attributes will be skipped.\n`);
  }

  const availableAttrs = coreAttrs.filter(a => attrIdMap[a]);
  console.log(`  Found attribute IDs for: ${availableAttrs.join(', ')}\n`);

  // Step 2: Query all active non-sample SKUs missing at least one core attribute
  const skuResult = await pool.query(`
    SELECT s.id as sku_id, s.variant_name, p.name as product_name, p.collection, v.code as vendor_code,
      ARRAY(
        SELECT a.slug FROM sku_attributes sa
        JOIN attributes a ON a.id = sa.attribute_id
        WHERE sa.sku_id = s.id AND a.slug IN ('color','finish','size','material','thickness')
      ) as existing_attrs
    FROM skus s
    JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id
    WHERE s.status = 'active' AND s.is_sample = false AND p.status = 'active'
      AND s.variant_name IS NOT NULL AND s.variant_name != ''
      AND (
        NOT EXISTS (SELECT 1 FROM sku_attributes sa JOIN attributes a ON a.id = sa.attribute_id WHERE sa.sku_id = s.id AND a.slug = 'color')
        OR NOT EXISTS (SELECT 1 FROM sku_attributes sa JOIN attributes a ON a.id = sa.attribute_id WHERE sa.sku_id = s.id AND a.slug = 'finish')
        OR NOT EXISTS (SELECT 1 FROM sku_attributes sa JOIN attributes a ON a.id = sa.attribute_id WHERE sa.sku_id = s.id AND a.slug = 'size')
      )
  `);

  console.log(`  Found ${skuResult.rows.length} SKUs with missing attributes to process.\n`);

  if (skuResult.rows.length === 0) {
    console.log('  Nothing to do. All SKUs have complete core attributes.\n');
    return;
  }

  // Step 3: Parse each variant_name and collect inserts
  const stats = {
    processed: 0,
    skipped: 0,
    inserted: { color: 0, finish: 0, size: 0, material: 0, thickness: 0 },
  };

  const inserts = []; // Array of { skuId, attrSlug, attrId, value }

  for (const row of skuResult.rows) {
    stats.processed++;

    const existingSet = new Set(row.existing_attrs || []);
    const parsed = parseVariantName(row.variant_name, row.product_name, row.collection, row.vendor_code);

    let anyNew = false;

    for (const [attrSlug, value] of Object.entries(parsed)) {
      // Skip if we don't have an ID for this attribute
      if (!attrIdMap[attrSlug]) continue;
      // Skip if the SKU already has this attribute
      if (existingSet.has(attrSlug)) continue;

      inserts.push({
        skuId: row.sku_id,
        attrSlug,
        attrId: attrIdMap[attrSlug],
        value,
        variantName: row.variant_name,
        vendorCode: row.vendor_code,
      });
      anyNew = true;
    }

    if (!anyNew) {
      stats.skipped++;
    }
  }

  console.log(`  Parsed ${stats.processed} SKUs. ${inserts.length} new attribute values to insert. ${stats.skipped} SKUs yielded no new attributes.\n`);

  // Step 4: Insert (or preview) the new attribute values
  if (DRY_RUN) {
    // Show a sample of what would be inserted
    const sampleCount = Math.min(inserts.length, 30);
    if (sampleCount > 0) {
      console.log(`  Sample of ${sampleCount} inserts (of ${inserts.length} total):\n`);
      for (let i = 0; i < sampleCount; i++) {
        const ins = inserts[i];
        console.log(`    [${ins.vendorCode}] variant="${ins.variantName}" → ${ins.attrSlug}="${ins.value}"`);
      }
      if (inserts.length > sampleCount) {
        console.log(`    ... and ${inserts.length - sampleCount} more`);
      }
      console.log('');
    }

    // Count by type
    for (const ins of inserts) {
      stats.inserted[ins.attrSlug]++;
    }
  } else {
    // Execute inserts
    let successCount = 0;
    let conflictCount = 0;

    for (const ins of inserts) {
      try {
        const result = await pool.query(
          `INSERT INTO sku_attributes (sku_id, attribute_id, value)
           VALUES ($1, $2, $3)
           ON CONFLICT DO NOTHING`,
          [ins.skuId, ins.attrId, ins.value]
        );
        if (result.rowCount > 0) {
          successCount++;
          stats.inserted[ins.attrSlug]++;
        } else {
          conflictCount++;
        }
      } catch (err) {
        console.error(`    ERROR inserting ${ins.attrSlug}="${ins.value}" for SKU ${ins.skuId}: ${err.message}`);
      }
    }

    console.log(`  Inserted ${successCount} attribute values (${conflictCount} conflicts/duplicates skipped).\n`);
  }

  // Step 5: Print summary
  console.log(`${'='.repeat(70)}`);
  console.log(`  Summary${DRY_RUN ? ' (DRY RUN)' : ''}`);
  console.log(`${'='.repeat(70)}`);
  console.log(`  SKUs processed:         ${stats.processed}`);
  console.log(`  SKUs with no new attrs: ${stats.skipped}`);
  console.log(`  Attributes ${DRY_RUN ? 'to insert' : 'inserted'}:`);
  console.log(`    color:                ${stats.inserted.color}`);
  console.log(`    finish:               ${stats.inserted.finish}`);
  console.log(`    size:                 ${stats.inserted.size}`);
  console.log(`    thickness:            ${stats.inserted.thickness}`);
  console.log(`    material:             ${stats.inserted.material}`);
  console.log(`    TOTAL:                ${Object.values(stats.inserted).reduce((a, b) => a + b, 0)}`);
  console.log(`${'='.repeat(70)}\n`);
}

main()
  .catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  })
  .finally(() => pool.end());
