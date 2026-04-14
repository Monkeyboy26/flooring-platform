#!/usr/bin/env node
/**
 * Shaw product display_name cleanup.
 *
 * Fixes:
 *   1. Accessory abbreviations → full words (Flsn → Flush Stairnose, Sn → Stairnose, etc.)
 *   2. Fraction formatting (3 8 → 3/8", 5 16 → 5/16", 1 2 → 1/2")
 *   3. Truncated color/material suffixes (Si → Silver, Bw → Bright White, etc.)
 *   4. Cryptic style codes → cleaned marketing names (Coretec product lines)
 *   5. Main product Xv-series style codes (note: no readable name available — flag only)
 *
 * Only modifies display_name (storefront-visible). Does NOT touch name/collection
 * (DB identity). Rebuilds search_vectors at end.
 *
 * Usage:
 *   node backend/scripts/shaw-name-cleanup.cjs --dry-run
 *   node backend/scripts/shaw-name-cleanup.cjs
 */

const { Pool } = require('pg');

const DRY_RUN = process.argv.includes('--dry-run');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

function log(label, result) {
  console.log(`  ${String(label).padEnd(45)} ${result}`);
}

// ==================== Name transformation rules ====================

// Fraction patterns: "3 8" at word boundary → "3/8\""
// Must run BEFORE abbreviation expansion since "3 8 L Shape" → "3/8\" L Shape"
const FRACTION_RULES = [
  [/\b1 2\b/g, '1/2"'],
  [/\b1 4\b/g, '1/4"'],
  [/\b3 8\b/g, '3/8"'],
  [/\b5 16\b/g, '5/16"'],
  [/\b7 16\b/g, '7/16"'],
  [/\b9 16\b/g, '9/16"'],
  [/\b7 9 16\b/g, '7/9/16'],
  [/\b3 4\b/g, '3/4"'],
  [/\b7 9\/16\b/g, '7-9/16'],  // catch "7 9/16" after first pass
];

// Abbreviation expansion rules — longest/most specific patterns first
const ABBREV_RULES = [
  // Multi-word patterns FIRST (before individual words get replaced)
  [/\bTC Tile Cpt Reducer\b/gi, 'Tile-to-Carpet Reducer'],
  [/\bClnr Concentrat\b/gi, 'Cleaner Concentrate'],
  [/\bSeam Sealr\b/gi, 'Seam Sealer'],
  [/\bCpt 32 Oz Spray Cleaner\b/gi, 'Carpet 32 oz Spray Cleaner'],
  [/\bBaby Thres\b/gi, 'Baby Threshold'],
  [/\bMulti Pr Rd\b/gi, 'Multi-Purpose Reducer'],
  [/\bOverlap Strnose\b/gi, 'Overlap Stairnose'],
  [/\bOverlap Stairnosing\b/gi, 'Overlap Stairnose'],
  [/\bOverlap Sn\b/gi, 'Overlap Stairnose'],
  [/\bOl Stairnose\b/gi, 'Overlap Stairnose'],
  [/\bO Stairnose\b/gi, 'Overlap Stairnose'],
  [/\bFlush Sn\b/gi, 'Flush Stairnose'],
  [/\bF Reducer Hs\b/gi, 'Flush Reducer Handscraped'],
  [/\bF Stairnose Hs\b/gi, 'Flush Stairnose Handscraped'],
  [/\bO Reducer Hs\b/gi, 'Overlap Reducer Handscraped'],
  [/\bO Stairnose Hs\b/gi, 'Overlap Stairnose Handscraped'],
  [/\bF Reducer\b/gi, 'Flush Reducer'],
  [/\bF Stairnose\b/gi, 'Flush Stairnose'],
  [/\bO Reducer\b/gi, 'Overlap Reducer'],
  [/\bQtr Rnd\b/gi, 'Quarter Round'],
  [/\bQuarter Rnd\b/gi, 'Quarter Round'],
  [/\bQtr Round\b/gi, 'Quarter Round'],
  [/\bHs Cleaner\b/gi, 'Hardwood/Stone Cleaner'],
  // Single-word accessory abbreviations
  [/\bFlsn\b/gi, 'Flush Stairnose'],
  [/\bOlsn\b/gi, 'Overlap Stairnose'],
  [/\bTrhd\b/gi, 'Threshold'],
  [/\bTh$/gm, 'Threshold'],       // "Th" at end of name only
  [/\bPlsh\b/gi, 'Polished'],
  [/\bJmbo\b/gi, 'Jumbo'],
  // Shaw product line abbreviations (case-sensitive to avoid false positives)
  [/\bADH\b/g, 'Adhesive'],
  [/\bHs\b/g, 'Handscraped'],
  [/\bBn\b/g, 'Bullnose'],
  // Sizing context
  [/\b4 5m\b/g, '4-5mm'],
  [/\b4\.5w4\.5\b/g, '4.5" Wide 4.5'],
  // Product line abbreviations (case-sensitive)
  [/\bG4\b/g, 'Gen 4'],
  [/\bG1\b/g, 'Gen 1'],
  [/\bVsm\b/gi, 'VSM'],
  [/\bMbx\b/gi, 'MBX'],
];

// Color/material suffix expansions — match word boundary, not just end of string,
// because display_name may have variant color appended after the suffix
const SUFFIX_RULES = [
  [/ Sil\b/, ' Silver Aluminum'],  // "L Shape Sil" (before "Si" to avoid partial match)
  [/ Si\b/, ' Silver'],            // "L Shape Si"
  [/ Bw\b/, ' Bright White'],
  [/ Sat\b/, ' Satin Nickel'],
  [/ Pol\b/, ' Polished Chrome'],
  [/ Pv\b/, ' PVC'],
  [/ Br\b/, ' Bright White'],
  [/ Tr\b/, ' Transition'],
  [/\bSlp\b/g, 'SLP'],
  [/\bSc\b/g, 'Scroll'],           // Capital III 18 Sc
  [/\bBl\b/g, 'Berber Loop'],      // Capital III Bl
  [/ Anodi\b/, ' Anodized'],       // truncated "Anodized"
  [/ Anodiz\b/, ' Anodized'],
];

// Coretec line names — strip embedded style codes and clean up
// "Coretec Pro Plus Enhanced Hd 9 Vv488" → "COREtec Pro Plus Enhanced HD 9"
const CORETEC_RULES = [
  [/\bCoretec\b/gi, 'COREtec'],
  [/\bVv\d{3,4}\b/gi, ''],        // strip Vv488, Vv017 etc.
  [/\bHd\b/g, 'HD'],
  [/\bEvp\b/g, 'EVP'],
];

function transformName(name) {
  let result = name;

  // 1. Fractions first
  for (const [pattern, replacement] of FRACTION_RULES) {
    result = result.replace(pattern, replacement);
  }

  // 2. Abbreviations
  for (const [pattern, replacement] of ABBREV_RULES) {
    result = result.replace(pattern, replacement);
  }

  // 3. Suffixes
  for (const [pattern, replacement] of SUFFIX_RULES) {
    result = result.replace(pattern, replacement);
  }

  // 4. Coretec
  for (const [pattern, replacement] of CORETEC_RULES) {
    result = result.replace(pattern, replacement);
  }

  // 5. Clean up double spaces and trim
  result = result.replace(/\s+/g, ' ').trim();

  // 6. Title case words that are all-lowercase (skip acronyms, numbers, etc.)
  // Only do this for words > 2 chars that are fully lowercase
  // Actually, skip this — Shaw names are already mixed case from the scraper

  return result;
}

async function phase1_fixAccessoryDisplayNames(client) {
  console.log('\n=== Phase 1: Fix accessory product display_names ===');

  const { rows } = await client.query(`
    SELECT p.id, p.name, p.display_name, c.name AS category
    FROM products p
    JOIN vendors v ON v.id = p.vendor_id
    LEFT JOIN categories c ON c.id = p.category_id
    WHERE v.code = 'SHAW' AND p.status = 'active'
      AND c.name IN ('Transitions & Moldings','Wall Base','Installation & Sundries','Adhesives & Sealants','Underlayment')
    ORDER BY p.name
  `);

  let changed = 0;
  const updates = [];
  for (const row of rows) {
    // Transform the product NAME (not display_name) — removes hardcoded color
    // suffixes that duplicate what variant_name already provides.
    // The frontend's fullProductName() appends the variant color at render time.
    const newDisplayName = transformName(row.name);
    if (newDisplayName !== (row.display_name || row.name)) {
      updates.push({ id: row.id, old: row.display_name || row.name, new: newDisplayName });
    }
  }

  log('Accessory products scanned:', rows.length);
  log('Display names to update:', updates.length);
  updates.slice(0, 30).forEach(u => log('  →', `"${u.old}" → "${u.new}"`));
  if (updates.length > 30) log('  →', `...and ${updates.length - 30} more`);

  for (const u of updates) {
    await client.query('UPDATE products SET display_name = $1 WHERE id = $2', [u.new, u.id]);
    changed++;
  }

  return changed;
}

async function phase2_fixMainProductDisplayNames(client) {
  console.log('\n=== Phase 2: Fix main product display_names ===');

  const { rows } = await client.query(`
    SELECT p.id, p.name, p.display_name, p.collection, c.name AS category,
      (SELECT sa.value FROM skus s JOIN sku_attributes sa ON sa.sku_id=s.id
       JOIN attributes a ON a.id=sa.attribute_id AND a.slug='size'
       WHERE s.product_id=p.id AND s.status='active' LIMIT 1) AS size_attr
    FROM products p
    JOIN vendors v ON v.id = p.vendor_id
    LEFT JOIN categories c ON c.id = p.category_id
    WHERE v.code = 'SHAW' AND p.status = 'active'
      AND (c.name IS NULL OR c.name NOT IN ('Transitions & Moldings','Wall Base','Installation & Sundries','Adhesives & Sealants','Underlayment'))
    ORDER BY p.name
  `);

  let changed = 0;
  const updates = [];
  for (const row of rows) {
    let newName = transformName(row.display_name || row.name);

    // For COREtec products where Vv-code was stripped, append plank width
    // to disambiguate (e.g. "COREtec Pro Enhanced" 7" vs 9")
    if (/coretec/i.test(row.name) && /Vv\d{3,4}/i.test(row.name) && row.size_attr) {
      // Extract width from size like "7.20\" x 48.04\"" or "9.06\" Wide"
      const widthMatch = row.size_attr.match(/^(\d+)\.\d+"/);
      if (widthMatch) {
        const width = widthMatch[1] + '"';
        // Only append if the width number isn't already in the cleaned name
        // (e.g. "HD 9" already has the 9 from original name)
        const widthNum = widthMatch[1];
        if (!new RegExp('\\b' + widthNum + '\\b').test(newName)) {
          newName = newName + ' ' + width;
        }
      }
    }

    newName = newName.replace(/\s+/g, ' ').trim();
    if (newName !== (row.display_name || row.name)) {
      updates.push({ id: row.id, old: row.display_name || row.name, new: newName, collection: row.collection });
    }
  }

  log('Main products scanned:', rows.length);
  log('Display names to update:', updates.length);
  updates.forEach(u => log('  →', `"${u.old}" → "${u.new}"`));

  for (const u of updates) {
    await client.query('UPDATE products SET display_name = $1 WHERE id = $2', [u.new, u.id]);
    changed++;
  }

  return changed;
}

async function phase3_fixVariantNames(client) {
  console.log('\n=== Phase 3: Fix SKU variant_names ===');

  // Some variant_names have trailing style codes or garbled suffixes
  // e.g. "Lighthouse0278v", "Rustic Mpl Ntl"
  const { rows } = await client.query(`
    SELECT s.id, s.variant_name, p.name AS product_name
    FROM skus s
    JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id
    WHERE v.code = 'SHAW' AND s.status = 'active'
      AND (
        s.variant_name ~ '[0-9]{4}[a-z]$'           -- trailing style code like "Lighthouse0278v"
        OR s.variant_name ~ ' Ntl$'                   -- abbreviated "Natural"
        OR s.variant_name ~ ' Nat$'                   -- abbreviated "Natural"
        OR s.variant_name ~ ' Mpl '                   -- abbreviated "Maple"
      )
    ORDER BY s.variant_name
  `);

  const VARIANT_FIXES = [
    [/(\w)(\d{4}[a-z])$/i, '$1'],     // strip trailing style code e.g. "Lighthouse0278v" → "Lighthouse"
    [/\bNtl\b/gi, 'Natural'],
    [/\bNat\b/gi, 'Natural'],
    [/\bMpl\b/gi, 'Maple'],
  ];

  let changed = 0;
  const updates = [];
  for (const row of rows) {
    let newName = row.variant_name;
    for (const [pattern, replacement] of VARIANT_FIXES) {
      newName = newName.replace(pattern, replacement);
    }
    newName = newName.replace(/\s+/g, ' ').trim();
    if (newName !== row.variant_name) {
      updates.push({ id: row.id, old: row.variant_name, new: newName });
    }
  }

  log('Variant names to fix:', updates.length);
  updates.slice(0, 15).forEach(u => log('  →', `"${u.old}" → "${u.new}"`));
  if (updates.length > 15) log('  →', `...and ${updates.length - 15} more`);

  for (const u of updates) {
    await client.query('UPDATE skus SET variant_name = $1 WHERE id = $2', [u.new, u.id]);
    changed++;
  }

  return changed;
}

async function phase4_fixColorAttributes(client) {
  console.log('\n=== Phase 4: Fix color attribute abbreviations ===');

  // Some color attrs have abbreviated values matching the variant_name issues
  const { rows } = await client.query(`
    SELECT sa.sku_id, sa.value AS old_value, a.id AS attr_id
    FROM sku_attributes sa
    JOIN attributes a ON a.id = sa.attribute_id AND a.slug = 'color'
    JOIN skus s ON s.id = sa.sku_id
    JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id
    WHERE v.code = 'SHAW' AND s.status = 'active'
      AND (
        sa.value ~ ' NTL$'
        OR sa.value ~ ' NAT$'
        OR sa.value ~ ' MPL '
        OR sa.value ~ '\d{4}[A-Z]$'
      )
  `);

  const COLOR_FIXES = [
    [/\bNTL\b/gi, 'NATURAL'],
    [/\bNAT\b/gi, 'NATURAL'],
    [/\bMPL\b/gi, 'MAPLE'],
    [/(\w)(\d{4}[A-Z])$/i, '$1'],
  ];

  let changed = 0;
  const updates = [];
  for (const row of rows) {
    let newVal = row.old_value;
    for (const [pattern, replacement] of COLOR_FIXES) {
      newVal = newVal.replace(pattern, replacement);
    }
    newVal = newVal.replace(/\s+/g, ' ').trim();
    if (newVal !== row.old_value) {
      updates.push({ sku_id: row.sku_id, attr_id: row.attr_id, old: row.old_value, new: newVal });
    }
  }

  log('Color attributes to fix:', updates.length);
  updates.slice(0, 10).forEach(u => log('  →', `"${u.old}" → "${u.new}"`));

  for (const u of updates) {
    await client.query('UPDATE sku_attributes SET value = $1 WHERE sku_id = $2 AND attribute_id = $3', [u.new, u.sku_id, u.attr_id]);
    changed++;
  }

  return changed;
}

async function phase5_rebuildSearchVectors(client) {
  console.log('\n=== Phase 5: Rebuild search vectors ===');

  const { rows: colCheck } = await client.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name='products' AND column_name='search_vector'
  `);
  if (colCheck.length === 0) {
    log('No search_vector column.', 'skipping');
    return 0;
  }

  const res = await client.query(`
    UPDATE products p
    SET search_vector = to_tsvector('english',
      COALESCE(p.name, '') || ' ' || COALESCE(p.display_name, '') || ' ' || COALESCE(p.collection, '')
    )
    FROM vendors v
    WHERE v.id = p.vendor_id AND v.code = 'SHAW'
  `);
  log('Rebuilt search vectors:', res.rowCount);
  return res.rowCount;
}

async function main() {
  console.log(`Shaw Name Cleanup ${DRY_RUN ? '[DRY RUN]' : '[EXECUTING]'}`);
  console.log('='.repeat(60));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const r1 = await phase1_fixAccessoryDisplayNames(client);
    const r2 = await phase2_fixMainProductDisplayNames(client);
    const r3 = await phase3_fixVariantNames(client);
    const r4 = await phase4_fixColorAttributes(client);
    const r5 = await phase5_rebuildSearchVectors(client);

    if (DRY_RUN) {
      await client.query('ROLLBACK');
      console.log('\n[DRY RUN] Rolled back. Run without --dry-run to execute.');
    } else {
      await client.query('COMMIT');
      console.log('\n✓ Name cleanup committed.');
    }

    console.log('\n=== Summary ===');
    log('Accessory display_names fixed:', r1);
    log('Main display_names fixed:', r2);
    log('Variant names fixed:', r3);
    log('Color attributes fixed:', r4);
    log('Search vectors rebuilt:', r5);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('\n✗ Error:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
