#!/usr/bin/env node
/**
 * MSI product display_name cleanup.
 *
 * Fixes:
 *   Phase 1: Trim code expansion (Ec→End Cap, Fsn→Flush Stair Nose, etc.)
 *   Phase 2: Thickness separator fix (strip "x.38", "x8mm" from names)
 *   Phase 3: Stacked stone / panel abbreviation expansion (Splitfce→Split Face, Pnl→Panel, etc.)
 *   Phase 4: General cleanup (collapse spaces, fix casing, strip artifacts)
 *   Phase 5: Rebuild search vectors for all changed products
 *
 * Only modifies display_name (storefront-visible). Does NOT touch name
 * (DB identity / unique constraint). Rebuilds search_vectors at end.
 *
 * Usage:
 *   node backend/scripts/msi-name-cleanup.cjs --dry-run    # Preview only
 *   node backend/scripts/msi-name-cleanup.cjs              # Execute updates
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
  console.log(`  ${String(label).padEnd(50)} ${result}`);
}

// ==================== Phase 1: Trim Code Expansion ====================

const TRIM_CODE_MAP = {
  'ec':      'End Cap',
  'ecl':     'End Cap Long',
  'osn':     'Overlapping Stair Nose',
  'fsn':     'Flush Stair Nose',
  'fsnl':    'Flush Stair Nose Long',
  'qr':      'Quarter Round',
  'sr':      'Reducer',
  'st':      'Stair Tread',
  't':       'T-Molding',
  't-sr':    'T-Molding / Reducer',
  '4-in-1':  '4-in-1 Transition',
};

const TRIM_SUFFIX_MAP = {
  '-ee': ' Eased Edge',
  '-sr': ' / Reducer',
};

/**
 * Expand trim codes in product names.
 * Pattern: "{BaseName} {TrimCode}(-Suffix)? {Length}""
 * Example: "Abingdale Fsn-Ee 94"" → "Abingdale Flush Stair Nose Eased Edge 94""
 */
function expandTrimCodes(name) {
  // Build alternation from longest to shortest to match greedily
  const codes = Object.keys(TRIM_CODE_MAP).sort((a, b) => b.length - a.length);
  const codePattern = codes.map(c => c.replace(/[-]/g, '\\-')).join('|');

  const regex = new RegExp(
    `\\s+(${codePattern})(-ee|-sr)?\\s+(\\d+"?)$`,
    'i'
  );

  const match = name.match(regex);
  if (!match) return name;

  const codeKey = match[1].toLowerCase();
  const suffixKey = match[2] ? match[2].toLowerCase() : null;
  const length = match[3];

  const expansion = TRIM_CODE_MAP[codeKey];
  if (!expansion) return name;

  const suffixExpansion = suffixKey ? (TRIM_SUFFIX_MAP[suffixKey] || '') : '';

  // Replace from the match position
  const prefix = name.slice(0, match.index);
  return `${prefix} ${expansion}${suffixExpansion} ${length}`;
}

// ==================== Phase 2: Thickness Separator Fix ====================

/**
 * Strip concatenated thickness from product names.
 * "Crema Marfilx.38 Classic" → "Crema Marfil Classic"
 * "Ayres Blendx8mm" → "Ayres Blend"
 * "Absolute India Blackx.38" → "Absolute India Black"
 */
function fixThickness(name) {
  // Match "x" preceded by a letter (not digit — that's a dimension like 6x24),
  // followed by thickness value with optional decimal, range, and unit.
  // Handles: x.38, x0.38, x3cm, x8mm, x2", x1.25, x1-1.5"
  return name.replace(/(?<=[a-zA-Z])x\.?\d+(?:\.\d+)?(?:-\d+(?:\.\d+)?)?(?:mm|cm|")?/gi, '');
}

// ==================== Phase 3: Stacked Stone / Panel Abbreviations ====================

// Packaging/crating info to strip — must run BEFORE abbreviation expansion
const PACKAGING_PATTERNS = [
  // "-50 Lft/Crt", "-50lf/Cr", "Corn-50 Lft/Crt", etc.
  /[- ]\d+\s*(?:lf|lft)\s*\/\s*(?:crt?|crate)\s*$/i,
  // "- 100 Sqft /Crate", "0-100 Sqft/Crate", "-100 Sqft/Crate"
  /[- ]\d+[-]?\d*\s*sqft?\s*\/?\s*crate\s*$/i,
  // "- 100 Sqft /Crate" with leading dash
  /\s*-\s*\d+\s+sqft?\s*\/\s*crate\s*$/i,
  // "0-100 Sqft/Crate" pattern
  /\s+\d+-\d+\s*sqft?\s*\/?\s*crate\s*$/i,
];

// Abbreviation expansion rules — longest first to avoid partial matches
const STONE_ABBREV_RULES = [
  // Run-together words: insert space before camelCase boundary (but not inside known words)
  [/Easededges/gi, 'Eased Edges'],
  [/Travcop\b/gi, 'Travertine Coping'],
  [/CopingsSb/gi, 'Copings Sb'],
  [/CopingBr/gi, 'Coping Bullnose Round'],
  [/BluestoneFl\b/gi, 'Bluestone Flamed'],
  [/BluestoneFlamed/gi, 'Bluestone Flamed'],
  [/Travertinepanel/gi, 'Travertine Panel'],
  // Multi-char abbreviations (longest first)
  [/\bSpltfcel\b/gi, 'Split Face'],
  [/\bSplitfce\b/gi, 'Split Face'],
  [/\bSpltfac\b/gi, 'Split Face'],
  [/\bSpltfc\b/gi, 'Split Face'],
  [/\bMoldng\b/gi, 'Molding'],
  [/\bMldg\b/gi, 'Molding'],
  [/\bSingl\b/gi, 'Single'],
  [/\bHufcb\b/gi, 'Honed Unfilled Chiseled Brushed'],
  [/\bHufbr\b/gi, 'Honed Unfilled Brushed'],
  [/\bHufc\b/gi, 'Honed Unfilled Chiseled'],
  [/\bHuf\b/gi, 'Honed Unfilled'],
  [/\bCosmc\b/gi, 'Cosmic'],
  [/\bEngr\b/gi, 'Engineered'],
  [/\bMult\b/gi, 'Multi'],
  [/\bFnsh\b/gi, 'Finish'],
  [/\bPnels?\b/gi, 'Panel'],
  [/\bPnls\b/gi, 'Panels'],
  [/\bPnl\b/gi, 'Panel'],
  [/\bCrnr\b/gi, 'Corner'],
  [/\bCorn\b/gi, 'Corner'],
  [/\bCnr\b/gi, 'Corner'],
  [/\bCrn\b/gi, 'Corner'],
  [/\bCor\b/gi, 'Corner'],
  [/\bCopi\b/gi, 'Coping'],
  [/\bCop\b/gi, 'Coping'],
  [/\bPol\b/gi, 'Polished'],
  [/\bHon\b/gi, 'Honed'],
  [/\bTum\b/gi, 'Tumbled'],
  [/\bMos\b/gi, 'Mosaic'],
  [/\bBvl\b/gi, 'Bevel'],
  [/\bBev\b/gi, 'Bevel'],
  [/\bDbl\b/gi, 'Double'],
  [/\bSgl\b/gi, 'Single'],
  [/\bBlk\b/gi, 'Black'],
  [/\bGry\b/gi, 'Grey'],
  [/\bGre\b/gi, 'Grey'],
  [/\bWht\b/gi, 'White'],
  [/\bWav\b/gi, 'Wave'],
  [/\bLht\b/gi, 'Lightweight'],
  [/\bPave\b/gi, 'Paver'],
  // "B Pol" / "B Ho" = Bowl/Bullnose abbreviation in marble context — keep as-is (too ambiguous)
  // Tus. → Tuscany
  [/\bTus\.\s*/gi, 'Tuscany '],
  [/\bTus\b(?!\.|cany)/gi, 'Tuscany'],
  // Suffix patterns: -Eng → Engineered
  [/-\s*Eng\b/gi, ' Engineered'],
  // "Sq & Rec" → "Square & Rectangle"
  [/\bSq\s*&\s*Rec\b/gi, 'Square & Rectangle'],
  // Br in coping context (standalone word before -Eased or -Dbl) → Bullnose Round
  [/\bBr\s*[-–]\s*(Eased|Dbl|Double)/gi, (_, after) => 'Bullnose Round - ' + after],
  // Sb at end → Square Bull or similar (common coping suffix)
  // 3d → 3D (case fix)
  [/\b3d\b/g, '3D'],
  // Xl → XL (case fix)
  [/\bXl\b/g, 'XL'],
];

// Smart-quote L-shape patterns
const LSHAPE_PATTERNS = [
  // Various smart-quote patterns around L
  /[\u201C\u201D"]+L[\u201C\u201D"]+/g,    // "L" or "L"
  /[\u201C]L[\u201D]/g,                       // "L"
  /"L"/g,                                     // "L" straight quotes
];

/**
 * Clean stacked stone and panel product names.
 */
function expandStoneAbbreviations(name) {
  let result = name;

  // Strip packaging info first
  for (const pattern of PACKAGING_PATTERNS) {
    result = result.replace(pattern, '');
  }

  // Expand L-shape patterns (add surrounding spaces for inline cases like Corner"L"Panel)
  for (const pattern of LSHAPE_PATTERNS) {
    result = result.replace(pattern, ' L-Shape ');
  }

  // Fix run-together dimensions: "Panel6x24" → "Panel 6x24", "Pnl6x18" → "Pnl 6x18"
  result = result.replace(/([a-zA-Z])(\d+x\d+)/gi, '$1 $2');

  // Apply abbreviation expansions
  for (const [pattern, replacement] of STONE_ABBREV_RULES) {
    result = result.replace(pattern, replacement);
  }

  return result;
}

// ==================== Phase 4: General Cleanup ====================

/** Words to keep uppercase */
const UPPERCASE_WORDS = new Set([
  'SPC', 'LVP', 'LVT', 'WPC', 'HD', 'MSI', 'USA', 'II', 'III', 'IV',
  'VI', 'VII', 'VIII', 'IX', 'XI', 'XII', '3D',
]);

/** Small words to lowercase in title case (unless first word) */
const SMALL_WORDS = new Set([
  'a', 'an', 'the', 'and', 'but', 'or', 'for', 'nor',
  'of', 'in', 'on', 'at', 'to', 'by', 'up', 'as',
]);

/**
 * Apply title case while respecting acronyms and small words.
 */
function smartTitleCase(str) {
  if (!str) return '';
  return str.replace(/\S+/g, (word, offset) => {
    // Preserve words that are already all-caps and recognized
    if (UPPERCASE_WORDS.has(word.toUpperCase()) && /^[A-Z]+$/.test(word)) return word;
    if (UPPERCASE_WORDS.has(word)) return word;

    // Roman numerals
    if (/^(I{1,3}|IV|VI{0,3}|IX|XI{0,3})$/i.test(word)) return word.toUpperCase();

    // Preserve dimensions like "6x24", "12x12"
    if (/^\d+x\d+$/i.test(word)) return word;

    // Preserve measurements like "78"", "94""
    if (/^\d+"?$/.test(word)) return word;

    // Small words (not first word)
    if (offset > 0 && SMALL_WORDS.has(word.toLowerCase())) return word.toLowerCase();

    // Title case
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  });
}

/**
 * General cleanup applied to all products.
 */
function generalCleanup(name) {
  let result = name;

  // --- Mojibake / replacement character cleanup ---
  // After a digit: likely an inch mark → replace with "
  result = result.replace(/(\d)\uFFFD/g, '$1"');
  // Between words (word � word): likely an em/en dash → replace with -
  result = result.replace(/\s\uFFFD\s/g, ' - ');
  // Between letters (no spaces): likely an em/en dash → replace with space-dash-space
  result = result.replace(/([a-zA-Z])\uFFFD([a-zA-Z])/g, '$1 - $2');
  // Trailing mojibake → strip
  result = result.replace(/\uFFFD+\s*$/g, '');
  // Any remaining mojibake → strip
  result = result.replace(/\uFFFD/g, '');

  // --- Run-together Tus.Word → add space ---
  result = result.replace(/Tus\.(\w)/gi, 'Tus. $1');

  // Remove trailing quote artifacts (straight and smart quotes), but preserve
  // measurement quotes after digits (e.g. 78" should keep the quote)
  result = result.replace(/(?<!\d)[\u201C\u201D"]+\s*$/g, '');
  result = result.replace(/^[\u201C\u201D"]+\s*/g, '');

  // Collapse multiple spaces
  result = result.replace(/\s+/g, ' ');

  // Trim
  result = result.trim();

  // Remove trailing punctuation artifacts (comma, dash, slash)
  result = result.replace(/[,\-\/\s]+$/, '').trim();

  return result;
}

// ==================== Main pipeline ====================

/**
 * Apply all transformations to a product name.
 * Returns the cleaned display_name.
 */
function transformName(name) {
  let result = name;

  // Phase 1: Trim code expansion
  result = expandTrimCodes(result);

  // Phase 2: Thickness fix
  result = fixThickness(result);

  // Phase 3: Stone/panel abbreviations
  result = expandStoneAbbreviations(result);

  // Phase 4: General cleanup
  result = generalCleanup(result);

  // Apply smart title case if the name is all-caps or has mixed casing issues
  if (result === result.toUpperCase() || /[a-z]{2,}\s[A-Z]{2,}[a-z]/.test(result)) {
    result = smartTitleCase(result);
  }

  // Fix individual ALL-CAPS words (4+ chars) that aren't recognized acronyms
  // e.g. "Rockmount Sierra PURE WHITE" → "Rockmount Sierra Pure White"
  result = result.replace(/\b([A-Z]{4,})\b/g, (word) => {
    if (UPPERCASE_WORDS.has(word)) return word;
    return word.charAt(0) + word.slice(1).toLowerCase();
  });

  // Collapse any double spaces introduced by expansions
  result = result.replace(/\s{2,}/g, ' ').trim();

  return result;
}

// ==================== Database operations ====================

async function fetchMsiProducts(client) {
  const { rows } = await client.query(`
    SELECT p.id, p.name, p.display_name, p.collection, c.name AS category
    FROM products p
    JOIN vendors v ON v.id = p.vendor_id
    LEFT JOIN categories c ON c.id = p.category_id
    WHERE v.code = 'MSI' AND p.status = 'active'
    ORDER BY p.name
  `);
  return rows;
}

async function phase1_trimCodes(products) {
  console.log('\n=== Phase 1: Trim Code Expansion ===');

  const trimPattern = /\s+(Ec|Ecl|Osn|Fsn|Fsnl|Qr|Sr|St|T|T-Sr|4-In-1)(-Ee|-Sr)?\s+\d+"?$/i;
  const trimProducts = products.filter(p => trimPattern.test(p.display_name || p.name));

  const updates = [];
  for (const row of trimProducts) {
    const source = row.display_name || row.name;
    const newName = generalCleanup(expandTrimCodes(source));
    if (newName !== source) {
      updates.push({ id: row.id, old: source, new: newName });
    }
  }

  log('Trim products detected:', trimProducts.length);
  log('Display names to update:', updates.length);
  updates.slice(0, 15).forEach(u => log('  \u2192', `"${u.old}" \u2192 "${u.new}"`));
  if (updates.length > 15) log('  \u2192', `...and ${updates.length - 15} more`);

  return updates.length;
}

async function phase2_thicknessFix(products) {
  console.log('\n=== Phase 2: Thickness Separator Fix ===');

  const thicknessPattern = /(?<=[a-zA-Z])x\.?\d+(?:mm|")?/i;
  const thicknessProducts = products.filter(p => thicknessPattern.test(p.display_name || p.name));

  const updates = [];
  for (const row of thicknessProducts) {
    const source = row.display_name || row.name;
    const newName = generalCleanup(fixThickness(source));
    if (newName !== source) {
      updates.push({ id: row.id, old: source, new: newName });
    }
  }

  log('Thickness products detected:', thicknessProducts.length);
  log('Display names to update:', updates.length);
  updates.slice(0, 15).forEach(u => log('  \u2192', `"${u.old}" \u2192 "${u.new}"`));
  if (updates.length > 15) log('  \u2192', `...and ${updates.length - 15} more`);

  return updates.length;
}

async function phase3_stoneAbbreviations(products) {
  console.log('\n=== Phase 3: Stacked Stone & Panel Abbreviation Expansion ===');

  // Find products with any of the stone/panel abbreviations
  const stonePattern = /(?:splitfce|spltfac|spltfcel|spltfc|pnls?\b|pnel\b|corn\b|crnr|cnr|crn|\bcor\b|\bcop\b|\bcopi\b|blk\b|gry\b|gre\b|wht\b|cosmc|engr|wav\b|mult\b|hon\b|\bpol\b|\btum\b|\bmos\b|\bbvl\b|\bbev\b|\bdbl\b|\bsgl\b|singl\b|mldg|moldng|fnsh|\blht\b|\bpave\b|hufc|hufbr|hufcb|\bhuf\b|travcop|easededge|\btus\.|xl\b|-eng\b|sq\s*&\s*rec|\u201CL\u201D|"L"|lft\/crt|sqft\s*\/?\s*crate)/i;
  const stoneProducts = products.filter(p => stonePattern.test(p.display_name || p.name));

  const updates = [];
  for (const row of stoneProducts) {
    const source = row.display_name || row.name;
    const newName = generalCleanup(expandStoneAbbreviations(source));
    if (newName !== source) {
      updates.push({ id: row.id, old: source, new: newName });
    }
  }

  log('Stone/panel products detected:', stoneProducts.length);
  log('Display names to update:', updates.length);
  updates.slice(0, 20).forEach(u => log('  \u2192', `"${u.old}" \u2192 "${u.new}"`));
  if (updates.length > 20) log('  \u2192', `...and ${updates.length - 20} more`);

  return updates.length;
}

async function phase4_generalCleanup(client, products) {
  console.log('\n=== Phase 4: General Cleanup (all products) ===');

  let changed = 0;
  const updates = [];

  for (const row of products) {
    const source = row.display_name || row.name;
    const newName = transformName(source);

    if (newName !== source) {
      // Check if already updated in a previous phase — get latest display_name
      updates.push({ id: row.id, old: source, new: newName });
    }
  }

  log('Total products scanned:', products.length);
  log('Display names to update (all phases combined):', updates.length);

  // Show a sample of the updates not already shown in previous phases
  const sampleUpdates = updates.slice(0, 10);
  sampleUpdates.forEach(u => log('  \u2192', `"${u.old}" \u2192 "${u.new}"`));
  if (updates.length > 10) log('  \u2192', `...and ${updates.length - 10} more`);

  if (!DRY_RUN) {
    for (const u of updates) {
      await client.query('UPDATE products SET display_name = $1 WHERE id = $2', [u.new, u.id]);
      changed++;
    }
  }

  return { changed: updates.length, updates };
}

async function phase5_rebuildSearchVectors(client, changedIds) {
  console.log('\n=== Phase 5: Rebuild Search Vectors ===');

  // Check if search_vector column exists
  const { rows: colCheck } = await client.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name='products' AND column_name='search_vector'
  `);
  if (colCheck.length === 0) {
    log('No search_vector column.', 'skipping');
    return 0;
  }

  if (changedIds.length === 0) {
    log('No products changed.', 'skipping');
    return 0;
  }

  // Rebuild only for changed products
  const res = await client.query(`
    UPDATE products
    SET search_vector = to_tsvector('english',
      COALESCE(name, '') || ' ' || COALESCE(display_name, '') || ' ' || COALESCE(collection, '')
    )
    WHERE id = ANY($1::uuid[])
  `, [changedIds]);

  log('Search vectors rebuilt:', res.rowCount);
  return res.rowCount;
}

// ==================== Main ====================

async function main() {
  console.log(`MSI Name Cleanup ${DRY_RUN ? '[DRY RUN]' : '[EXECUTING]'}`);
  console.log('='.repeat(60));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Fetch all MSI products once
    const products = await fetchMsiProducts(client);
    log('Total active MSI products:', products.length);

    // Phases 1-3: report-only (show per-phase stats, no DB writes)
    const r1 = await phase1_trimCodes(products);
    const r2 = await phase2_thicknessFix(products);
    const r3 = await phase3_stoneAbbreviations(products);

    // Phase 4: authoritative pass — runs ALL transforms on every product and writes
    const r4 = await phase4_generalCleanup(client, products);

    // Collect all changed product IDs for search vector rebuild
    const changedIds = r4.updates.map(u => u.id);

    // Phase 5: Rebuild search vectors
    let r5 = 0;
    if (!DRY_RUN) {
      r5 = await phase5_rebuildSearchVectors(client, changedIds);
    } else {
      log('\n[DRY RUN] Would rebuild search vectors for:', changedIds.length + ' products');
    }

    if (DRY_RUN) {
      await client.query('ROLLBACK');
      console.log('\n[DRY RUN] Rolled back. Run without --dry-run to execute.');
    } else {
      await client.query('COMMIT');
      console.log('\n\u2713 Name cleanup committed.');
    }

    console.log('\n=== Summary ===');
    log('Trim code expansions:', r1);
    log('Thickness fixes:', r2);
    log('Stone/panel abbreviation expansions:', r3);
    log('Total display_names updated:', r4.changed);
    log('Search vectors rebuilt:', r5);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('\n\u2717 Error:', err.message);
    console.error(err.stack);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
