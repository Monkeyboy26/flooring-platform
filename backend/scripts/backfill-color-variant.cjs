#!/usr/bin/env node
/**
 * backfill-color-variant.cjs — Backfill missing color attributes & empty variant_names
 *
 * Part 1: For SKUs missing the "color" EAV attribute, derive it from product name
 *         vs collection, or from variant_name.
 * Part 2: For SKUs with empty variant_name, set it from color attribute or product name.
 *
 * Usage:
 *   node backend/scripts/backfill-color-variant.cjs --dry-run         # Preview changes
 *   node backend/scripts/backfill-color-variant.cjs                   # Execute backfill
 *   node backend/scripts/backfill-color-variant.cjs --vendor BEDRO    # Single vendor
 *   node backend/scripts/backfill-color-variant.cjs --colors-only     # Part 1 only
 *   node backend/scripts/backfill-color-variant.cjs --variants-only   # Part 2 only
 */

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/flooring_pim',
});

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const COLORS_ONLY = args.includes('--colors-only');
const VARIANTS_ONLY = args.includes('--variants-only');
const vendorIdx = args.indexOf('--vendor');
const VENDOR_FILTER = vendorIdx !== -1 ? args[vendorIdx + 1] : null;

// ---------------------------------------------------------------------------
// Non-color vocabulary — shapes, finishes, forms, parts that are NOT colors
// ---------------------------------------------------------------------------

const NON_COLOR_WORDS = new Set([
  // Shapes / forms
  'rectangle', 'square', 'hexagon', 'octagon', 'mosaic', 'plank', 'tile',
  'slab', 'sheet', 'roll', 'strip', 'brick', 'penny', 'round', 'chevron',
  'herringbone', 'picket', 'arabesque', 'lantern', 'diamond', 'fan',
  // Finishes
  'matte', 'polished', 'satin', 'honed', 'brushed', 'textured', 'natural',
  'glossy', 'lappato', 'rectified', 'tumbled', 'chiseled', 'flamed',
  'leathered', 'sandblasted', 'bush-hammered', 'antiqued', 'distressed',
  // Parts / accessory types
  'trim', 'liner', 'bullnose', 'cove', 'base', 'outcorner', 'incorner',
  'quarter', 'pencil', 'chair', 'rail', 'v-cap', 'molding', 'reducer',
  'stair', 'nosing', 'threshold', 'saddle', 'transition', 'corner', 'edge',
  'field', 'accent', 'border', 'deco', 'insert', 'medallion', 'stepwise',
  // Product types (not colors)
  'cabinet', 'vanity', 'mirror', 'bench', 'shelf', 'countertop', 'sink',
  'faucet', 'shower', 'adhesive', 'grout', 'mortar', 'sealant', 'caulk',
  'underlayment', 'membrane', 'backer', 'knife', 'gun', 'tip', 'pliers',
  'tool', 'kit', 'precut', 'ready', 'assemble', 'replacement', 'regular',
  'sausage', 'putty', 'construction', 'tube', 'cork', 'level',
  'screws', 'washers', 'nails', 'primer', 'concentrate', 'gallon',
  'flex', 'based', 'water', 'hutch', 'drawer', 'door', 'panel',
  // Generic terms
  'side', 'top', 'set', 'piece', 'unit', 'part', 'w/pad', 'spc',
  // Connectors / filler words
  'to', 'and', 'or', 'for', 'with', 'the', 'of', 'in', 'a', 'an',
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Title-case a string: "french oak natural" → "French Oak Natural" */
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
 * Check if a string is entirely composed of non-color words (shapes, finishes, etc.)
 */
function isEntirelyNonColor(str) {
  if (!str) return true;
  const words = str.toLowerCase().replace(/[,]/g, ' ').split(/\s+/).filter(w => w.length > 0);
  if (words.length === 0) return true;
  return words.every(w => NON_COLOR_WORDS.has(w) || /^\d+$/.test(w));
}

/**
 * Clean a raw color string: strip size patterns, stray numbers, trim punctuation.
 * Returns null if nothing meaningful remains.
 */
function cleanColor(raw) {
  if (!raw) return null;
  let s = raw
    // Remove dimension patterns: 12x24, 6"x24", etc.
    .replace(/\b\d+(?:\.\d+)?\s*['"]?\s*[xX×]\s*\d+(?:\.\d+)?\s*['"]?\b/g, ' ')
    // Remove thickness patterns: 8mm, 12mm
    .replace(/\b\d+(?:\.\d+)?\s*mm\b/gi, ' ')
    // Remove stray measurement units
    .replace(/\b\d+(?:\.\d+)?\s*(?:cm|in|ft|sf|sqft|lf|pc|pcs|oz|gal)\b/gi, ' ')
    // Remove leading/trailing dashes, slashes, pipes
    .replace(/^[\s\-/|,]+|[\s\-/|,]+$/g, '')
    // Collapse whitespace
    .replace(/\s+/g, ' ')
    .trim();

  // Skip if purely numeric or too short
  if (!s || s.length < 2 || /^\d+$/.test(s)) return null;
  // Skip if the result is entirely non-color words (shapes, finishes, etc.)
  if (isEntirelyNonColor(s)) return null;
  // Skip if it contains product-type words mixed in (likely a description, not a color)
  const lowerWords = s.toLowerCase().split(/\s+/);
  const PRODUCT_KEYWORDS = ['cabinet', 'vanity', 'mirror', 'bench', 'shelf', 'countertop',
    'sink', 'faucet', 'shower', 'adhesive', 'knife', 'gun', 'pliers', 'kit', 'tube'];
  if (lowerWords.some(w => PRODUCT_KEYWORDS.includes(w))) return null;
  return titleCase(s);
}

/**
 * Clean a variant_name-derived color more aggressively:
 * strip known finish/shape words, then check if anything remains.
 */
function cleanVariantColor(raw) {
  if (!raw) return null;
  let s = raw
    .replace(/\b\d+(?:\.\d+)?\s*['"]?\s*[xX×]\s*\d+(?:\.\d+)?\s*['"]?\b/g, ' ')
    .replace(/\b\d+(?:\.\d+)?\s*mm\b/gi, ' ')
    .replace(/\b\d+(?:\.\d+)?\s*(?:cm|in|ft|sf|sqft|lf|pc|pcs|oz|gal)\b/gi, ' ');

  // Remove non-color words
  const words = s.split(/[\s,]+/).filter(w => w.length > 0);
  const colorWords = words.filter(w => !NON_COLOR_WORDS.has(w.toLowerCase()) && !/^\d+$/.test(w));

  const result = colorWords.join(' ').replace(/^[\s\-/|,]+|[\s\-/|,]+$/g, '').trim();
  if (!result || result.length < 2) return null;
  return titleCase(result);
}

/**
 * Derive a color from product name vs collection.
 * Returns { color, method } or null if not derivable.
 */
function deriveColor(productName, collection, variantName) {
  const name = (productName || '').trim();
  const coll = (collection || '').trim();

  if (!name || !coll) return null;

  const nameLower = name.toLowerCase();
  const collLower = coll.toLowerCase();

  // Case 1: name starts with collection → remainder is color
  if (nameLower !== collLower && nameLower.startsWith(collLower)) {
    const remainder = name.slice(coll.length).trim();
    // Strip leading dash/pipe/comma separators
    const stripped = remainder.replace(/^[\s\-/|,]+/, '').trim();
    if (stripped) {
      const color = cleanColor(stripped);
      if (color) return { color, method: 'prefix-strip' };
      // If we found a remainder but it was non-color (e.g. "Cabinet", "Hutch"),
      // don't fall through to full-name — the product name is collection + descriptor
      return null;
    }
  }

  // Case 2: name != collection (and doesn't start with it) → full name is color
  if (nameLower !== collLower) {
    const color = cleanColor(name);
    if (color && color.toLowerCase() !== collLower) {
      return { color, method: 'full-name' };
    }
  }

  // Case 3: name == collection but has variant_name → parse color from variant
  // Use stricter cleaning to strip finish/shape words from variant_name
  if (nameLower === collLower && variantName && variantName.trim()) {
    const color = cleanVariantColor(variantName);
    if (color && color.toLowerCase() !== collLower) {
      return { color, method: 'variant-parse' };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Part 1: Backfill Color Attributes
// ---------------------------------------------------------------------------

async function backfillColors(colorAttrId) {
  console.log(`\n${'─'.repeat(70)}`);
  console.log(`  PART 1: BACKFILL COLOR ATTRIBUTES${DRY_RUN ? ' (DRY RUN)' : ''}`);
  console.log(`${'─'.repeat(70)}\n`);

  // Find all active non-sample SKUs missing the color attribute
  const vendorClause = VENDOR_FILTER ? `AND v.code = $2` : '';
  const params = VENDOR_FILTER ? [colorAttrId, VENDOR_FILTER] : [colorAttrId];

  const { rows: skus } = await pool.query(`
    SELECT s.id AS sku_id, s.variant_name, p.name AS product_name, p.collection,
           v.code AS vendor_code, v.name AS vendor_name
    FROM skus s
    JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id
    WHERE s.status = 'active' AND s.is_sample = false AND p.status = 'active'
      AND NOT EXISTS (
        SELECT 1 FROM sku_attributes sa
        WHERE sa.sku_id = s.id AND sa.attribute_id = $1
      )
      ${vendorClause}
    ORDER BY v.code, p.collection, p.name
  `, params);

  console.log(`  Found ${skus.length} SKUs missing color attribute.\n`);

  if (skus.length === 0) {
    console.log('  Nothing to do.\n');
    return { total: 0, fixed: 0, skipped: 0 };
  }

  // Derive colors
  const inserts = []; // { skuId, color, method, vendorCode, productName, collection }
  const skippedByVendor = {};

  for (const row of skus) {
    const result = deriveColor(row.product_name, row.collection, row.variant_name);
    if (result) {
      inserts.push({
        skuId: row.sku_id,
        color: result.color,
        method: result.method,
        vendorCode: row.vendor_code,
        productName: row.product_name,
        collection: row.collection,
      });
    } else {
      skippedByVendor[row.vendor_code] = (skippedByVendor[row.vendor_code] || 0) + 1;
    }
  }

  // Show stats by vendor and method
  const byVendorMethod = {};
  for (const ins of inserts) {
    const key = `${ins.vendorCode}`;
    if (!byVendorMethod[key]) byVendorMethod[key] = { 'prefix-strip': 0, 'full-name': 0, 'variant-parse': 0, total: 0 };
    byVendorMethod[key][ins.method]++;
    byVendorMethod[key].total++;
  }

  console.log('  Derivation results by vendor:');
  console.log('  ' + '-'.repeat(68));
  console.log(`  ${'Vendor'.padEnd(12)} ${'Prefix'.padStart(8)} ${'FullName'.padStart(10)} ${'Variant'.padStart(9)} ${'Total'.padStart(7)} ${'Skipped'.padStart(9)}`);
  console.log('  ' + '-'.repeat(68));
  const allVendors = new Set([...Object.keys(byVendorMethod), ...Object.keys(skippedByVendor)]);
  for (const v of [...allVendors].sort()) {
    const m = byVendorMethod[v] || { 'prefix-strip': 0, 'full-name': 0, 'variant-parse': 0, total: 0 };
    const sk = skippedByVendor[v] || 0;
    console.log(`  ${v.padEnd(12)} ${String(m['prefix-strip']).padStart(8)} ${String(m['full-name']).padStart(10)} ${String(m['variant-parse']).padStart(9)} ${String(m.total).padStart(7)} ${String(sk).padStart(9)}`);
  }
  console.log('  ' + '-'.repeat(68));
  console.log(`  ${'TOTAL'.padEnd(12)} ${String(inserts.filter(i => i.method === 'prefix-strip').length).padStart(8)} ${String(inserts.filter(i => i.method === 'full-name').length).padStart(10)} ${String(inserts.filter(i => i.method === 'variant-parse').length).padStart(9)} ${String(inserts.length).padStart(7)} ${String(Object.values(skippedByVendor).reduce((a, b) => a + b, 0)).padStart(9)}`);
  console.log();

  // Dry-run: show samples per vendor
  if (DRY_RUN) {
    const samplesByVendor = {};
    for (const ins of inserts) {
      if (!samplesByVendor[ins.vendorCode]) samplesByVendor[ins.vendorCode] = [];
      if (samplesByVendor[ins.vendorCode].length < 5) {
        samplesByVendor[ins.vendorCode].push(ins);
      }
    }

    console.log('  Sample transformations:\n');
    for (const [vendor, samples] of Object.entries(samplesByVendor).sort()) {
      console.log(`  [${vendor}]`);
      for (const s of samples) {
        console.log(`    "${s.collection}" / "${s.productName}" → color="${s.color}" (${s.method})`);
      }
      console.log();
    }
  } else {
    // Execute: batch insert via unnest()
    const BATCH = 500;
    let inserted = 0;

    for (let i = 0; i < inserts.length; i += BATCH) {
      const batch = inserts.slice(i, i + BATCH);
      const skuIds = batch.map(b => b.skuId);
      const values = batch.map(b => b.color);

      const result = await pool.query(`
        INSERT INTO sku_attributes (sku_id, attribute_id, value)
        SELECT unnest($1::uuid[]), $2, unnest($3::text[])
        ON CONFLICT (sku_id, attribute_id) DO NOTHING
      `, [skuIds, colorAttrId, values]);

      inserted += result.rowCount;
    }

    console.log(`  Inserted ${inserted} color attributes (${inserts.length - inserted} conflicts skipped).\n`);
  }

  const totalSkipped = Object.values(skippedByVendor).reduce((a, b) => a + b, 0);
  return { total: skus.length, fixed: inserts.length, skipped: totalSkipped };
}

// ---------------------------------------------------------------------------
// Part 2: Backfill Empty Variant Names
// ---------------------------------------------------------------------------

async function backfillVariantNames(colorAttrId) {
  console.log(`\n${'─'.repeat(70)}`);
  console.log(`  PART 2: BACKFILL EMPTY VARIANT NAMES${DRY_RUN ? ' (DRY RUN)' : ''}`);
  console.log(`${'─'.repeat(70)}\n`);

  // Find SKUs with empty variant_name, LEFT JOIN to get their color attribute if it exists
  const vendorClause = VENDOR_FILTER ? `AND v.code = $2` : '';
  const params = VENDOR_FILTER ? [colorAttrId, VENDOR_FILTER] : [colorAttrId];

  const { rows: skus } = await pool.query(`
    SELECT s.id AS sku_id, s.variant_name, p.name AS product_name, p.collection,
           v.code AS vendor_code, v.name AS vendor_name,
           sa.value AS color_value
    FROM skus s
    JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id
    LEFT JOIN sku_attributes sa ON sa.sku_id = s.id AND sa.attribute_id = $1
    WHERE s.status = 'active' AND s.is_sample = false AND p.status = 'active'
      AND (s.variant_name IS NULL OR s.variant_name = '')
      ${vendorClause}
    ORDER BY v.code, p.collection, p.name
  `, params);

  console.log(`  Found ${skus.length} SKUs with empty variant_name.\n`);

  if (skus.length === 0) {
    console.log('  Nothing to do.\n');
    return { total: 0, fixed: 0, skipped: 0 };
  }

  // Derive variant_name
  const updates = []; // { skuId, newVariantName, source, vendorCode }
  const skippedByVendor = {};

  for (const row of skus) {
    const nameLower = (row.product_name || '').toLowerCase().trim();
    const collLower = (row.collection || '').toLowerCase().trim();

    let newName = null;
    let source = null;

    // Priority 1: use existing color attribute (titleCase to normalize ALL-CAPS)
    if (row.color_value && row.color_value.trim()) {
      const cv = row.color_value.trim();
      // Apply titleCase only if the value is all-uppercase
      newName = (cv === cv.toUpperCase() && cv.length > 2) ? titleCase(cv) : cv;
      source = 'color-attr';
    }
    // Priority 2: derive from product_name if it differs from collection
    else if (nameLower && nameLower !== collLower) {
      // If name starts with collection, strip prefix
      if (nameLower.startsWith(collLower)) {
        const remainder = row.product_name.trim().slice(row.collection.trim().length)
          .replace(/^[\s\-/|,]+/, '').trim();
        if (remainder) {
          newName = titleCase(remainder);
          source = 'name-prefix';
        }
      }
      // Otherwise use the full product name
      if (!newName) {
        newName = titleCase(row.product_name.trim());
        source = 'product-name';
      }
    }

    if (newName) {
      updates.push({
        skuId: row.sku_id,
        newVariantName: newName,
        source,
        vendorCode: row.vendor_code,
        productName: row.product_name,
        collection: row.collection,
      });
    } else {
      skippedByVendor[row.vendor_code] = (skippedByVendor[row.vendor_code] || 0) + 1;
    }
  }

  // Stats by vendor
  const byVendor = {};
  for (const u of updates) {
    if (!byVendor[u.vendorCode]) byVendor[u.vendorCode] = { 'color-attr': 0, 'name-prefix': 0, 'product-name': 0, total: 0 };
    byVendor[u.vendorCode][u.source]++;
    byVendor[u.vendorCode].total++;
  }

  console.log('  Derivation results by vendor:');
  console.log('  ' + '-'.repeat(68));
  console.log(`  ${'Vendor'.padEnd(12)} ${'ColorAttr'.padStart(10)} ${'NamePfx'.padStart(9)} ${'ProdName'.padStart(10)} ${'Total'.padStart(7)} ${'Skipped'.padStart(9)}`);
  console.log('  ' + '-'.repeat(68));
  const allVendors = new Set([...Object.keys(byVendor), ...Object.keys(skippedByVendor)]);
  for (const v of [...allVendors].sort()) {
    const m = byVendor[v] || { 'color-attr': 0, 'name-prefix': 0, 'product-name': 0, total: 0 };
    const sk = skippedByVendor[v] || 0;
    console.log(`  ${v.padEnd(12)} ${String(m['color-attr']).padStart(10)} ${String(m['name-prefix']).padStart(9)} ${String(m['product-name']).padStart(10)} ${String(m.total).padStart(7)} ${String(sk).padStart(9)}`);
  }
  console.log('  ' + '-'.repeat(68));
  console.log(`  ${'TOTAL'.padEnd(12)} ${String(updates.filter(u => u.source === 'color-attr').length).padStart(10)} ${String(updates.filter(u => u.source === 'name-prefix').length).padStart(9)} ${String(updates.filter(u => u.source === 'product-name').length).padStart(10)} ${String(updates.length).padStart(7)} ${String(Object.values(skippedByVendor).reduce((a, b) => a + b, 0)).padStart(9)}`);
  console.log();

  if (DRY_RUN) {
    const samplesByVendor = {};
    for (const u of updates) {
      if (!samplesByVendor[u.vendorCode]) samplesByVendor[u.vendorCode] = [];
      if (samplesByVendor[u.vendorCode].length < 5) {
        samplesByVendor[u.vendorCode].push(u);
      }
    }

    console.log('  Sample transformations:\n');
    for (const [vendor, samples] of Object.entries(samplesByVendor).sort()) {
      console.log(`  [${vendor}]`);
      for (const s of samples) {
        console.log(`    "${s.collection}" / "${s.productName}" → variant_name="${s.newVariantName}" (${s.source})`);
      }
      console.log();
    }
  } else {
    // Execute: batch update via unnest()
    const BATCH = 500;
    let updated = 0;

    for (let i = 0; i < updates.length; i += BATCH) {
      const batch = updates.slice(i, i + BATCH);
      const skuIds = batch.map(b => b.skuId);
      const names = batch.map(b => b.newVariantName);

      const result = await pool.query(`
        UPDATE skus SET variant_name = data.new_name, updated_at = NOW()
        FROM (SELECT unnest($1::uuid[]) AS id, unnest($2::text[]) AS new_name) data
        WHERE skus.id = data.id
      `, [skuIds, names]);

      updated += result.rowCount;
    }

    console.log(`  Updated ${updated} variant names.\n`);
  }

  const totalSkipped = Object.values(skippedByVendor).reduce((a, b) => a + b, 0);
  return { total: skus.length, fixed: updates.length, skipped: totalSkipped };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`  BACKFILL COLOR ATTRIBUTES & VARIANT NAMES${DRY_RUN ? ' (DRY RUN)' : ''}`);
  console.log(`  ${new Date().toISOString()}`);
  if (VENDOR_FILTER) console.log(`  Vendor filter: ${VENDOR_FILTER}`);
  if (COLORS_ONLY) console.log(`  Mode: colors only`);
  if (VARIANTS_ONLY) console.log(`  Mode: variants only`);
  console.log(`${'='.repeat(70)}`);

  // Look up color attribute ID
  const { rows: attrRows } = await pool.query(
    `SELECT id FROM attributes WHERE slug = 'color'`
  );
  if (attrRows.length === 0) {
    console.error('  ERROR: No attribute with slug "color" found. Aborting.');
    process.exit(1);
  }
  const colorAttrId = attrRows[0].id;
  console.log(`  Color attribute ID: ${colorAttrId}`);

  let colorStats = null;
  let variantStats = null;

  if (!VARIANTS_ONLY) {
    colorStats = await backfillColors(colorAttrId);
  }

  if (!COLORS_ONLY) {
    variantStats = await backfillVariantNames(colorAttrId);
  }

  // Summary
  console.log(`${'='.repeat(70)}`);
  console.log(`  SUMMARY${DRY_RUN ? ' (DRY RUN — no changes made)' : ''}`);
  console.log(`${'='.repeat(70)}`);
  if (colorStats) {
    console.log(`  Color attributes:`);
    console.log(`    Missing:     ${colorStats.total}`);
    console.log(`    ${DRY_RUN ? 'Would fix' : 'Fixed'}:      ${colorStats.fixed}`);
    console.log(`    Unfixable:   ${colorStats.skipped}`);
  }
  if (variantStats) {
    console.log(`  Variant names:`);
    console.log(`    Empty:       ${variantStats.total}`);
    console.log(`    ${DRY_RUN ? 'Would fix' : 'Fixed'}:      ${variantStats.fixed}`);
    console.log(`    Unfixable:   ${variantStats.skipped}`);
  }
  console.log(`${'='.repeat(70)}\n`);
}

main()
  .catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  })
  .finally(() => pool.end());
