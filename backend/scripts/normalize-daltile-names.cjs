#!/usr/bin/env node
/**
 * normalize-daltile-names.cjs — Comprehensive Daltile name cleanup
 *
 * Replaces both cleanup-daltile-names.cjs and fix-daltile-display-names.cjs
 * with a single, complete 9-step transformation pipeline.
 *
 * Transforms raw EDI `name` → clean `display_name` for every active Daltile product,
 * and cleans SKU variant_name values that contain vendor abbreviations.
 *
 * Usage:
 *   node backend/scripts/normalize-daltile-names.cjs --dry-run   # Preview changes
 *   node backend/scripts/normalize-daltile-names.cjs              # Execute
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

// ─── Step 1: Prefix patterns to strip ──────────────────────────────────────

const PREFIXES = [
  /^Lvf\s+/i,
  /^Pts Professional Tile Solution\s+/i,
  /^Xteriors Program\s+/i,
  /^Tread Pavers\s+/i,
];

// ─── Step 2: Trailing group suffix ─────────────────────────────────────────

const GRP_SUFFIX = /\s+Grp\d+$/i;

// ─── Step 3: Word abbreviations (longer first to avoid partial matches) ────

const WORD_ABBREVS = [
  ['Rndstrd', 'Round Stair Tread'],
  ['Outcrn',  'Outside Corner'],
  ['Vslcap',  'Versa End Cap'],
  ['Vqrnd',   'Versa Quarter Round'],
  ['Vscap',   'Versa Stair Cap'],
  ['Vrdsn',   'Versa Down'],
  ['Slimt',   'Slim Trim'],
  ['Incrn',   'Inside Corner'],
  ['Extsn',   'Extension'],
  ['Sntry',   'Sanitary'],
  ['Qrtr',    'Quarter'],
  ['Stp',     'Step'],
  ['Cop',     'Coping'],
  ['Cv',      'Cove'],
  ['Bn',      'Bullnose'],
  ['Ns',      'Nose'],
  ['Bc',      'Base'],
  ['Mm',      'Mosaic'],
  ['Dm',      'Direct Mount'],
];

// ─── Step 4: Finish abbreviations ──────────────────────────────────────────

const FINISH_ABBREVS = [
  ['Mt', 'Matte'],
  ['Gl', 'Gloss'],
  ['St', 'Structured'],
  ['Pl', 'Polished'],
  ['Tx', 'Textured'],
  ['Lp', 'Lappato'],
  ['Ab', 'Abrasive'],
  ['Gs', 'Glass'],
  ['Sx', 'Semi-Textured'],
  ['Hn', 'Honed'],
  ['Sf', 'Soft'],
  ['Sc', 'Scored'],
  ['Mx', 'Mixed'],
  ['Tm', 'Tumbled'],
  ['Eu', ''],  // internal code — strip entirely
];

// ─── Step 6: Vendor part code patterns ─────────────────────────────────────

const PART_CODE_PATTERNS = [
  /\b[PS]c?\d{1,2}[a-z]?\d{1,2}[a-z]?\d*\b/gi,  // S36c9, P43f9, Sc36c9, Pc36c9
  /\bS\d\/\d+\w+\b/gi,                             // S1/212j type codes
  /\b[A-Z][a-z]*\d{3,}[a-z0-9]*\b/g,              // A4200, Qcrl1885
];

// Internal size qualifiers: 6r, 1224c6, 1232c6, 1624s, 2020s, 1232s
// Exclude x/X to avoid eating dimension components like "4x94" in "3/4x94"
const SIZE_QUALIFIERS = /\b\d{1,4}[a-wy-z]\d{0,2}\b/gi;

// ─── Step 7: Dimension strings ─────────────────────────────────────────────

const DIMENSION_PATTERNS = [
  /\b\d+\s+\d+\/\d+[xX]\d+\b/g,    // "2 3/4x44", "12 1/5x50", "1 3/4x94"
  /\b\d+\/\d+[xX]\d+\/?\d*\b/g,     // "1/2x12", "3/4x94", "3/4x3/4"
  /\b\d+[xX]\d+\b/g,                 // "8x10" plain dimensions
];

// Expanded finish words — used in Step 8 to strip trailing finish terms
const EXPANDED_FINISHES = FINISH_ABBREVS
  .map(([, expansion]) => expansion)
  .filter(e => e.length > 0);

const TRAILING_FINISH_RE = new RegExp(
  `\\s+(?:${EXPANDED_FINISHES.join('|')})$`, 'i'
);

// ─── Transform pipeline ────────────────────────────────────────────────────

function normalizeName(raw) {
  let name = raw;

  // Step 1: Strip prefixes
  for (const prefix of PREFIXES) {
    name = name.replace(prefix, '');
  }

  // Step 2: Strip trailing group suffix
  name = name.replace(GRP_SUFFIX, '');

  // Step 3: Expand word abbreviations (whole-word, longer first)
  for (const [abbrev, expansion] of WORD_ABBREVS) {
    name = name.replace(new RegExp(`\\b${abbrev}\\b`, 'g'), expansion);
  }

  // Step 4: Expand finish abbreviations (whole-word)
  // All positions expanded here; trailing ones removed in Step 8
  for (const [abbrev, expansion] of FINISH_ABBREVS) {
    name = name.replace(new RegExp(`\\b${abbrev}\\b`, 'g'), expansion);
  }

  // Step 5: Strip "Ls" qualifier (whole-word)
  name = name.replace(/\bLs\b/gi, '');

  // Step 6: Strip vendor part codes
  for (const pattern of PART_CODE_PATTERNS) {
    name = name.replace(pattern, '');
  }
  name = name.replace(SIZE_QUALIFIERS, '');

  // Step 7: Strip dimension strings (longer patterns first)
  for (const pattern of DIMENSION_PATTERNS) {
    name = name.replace(pattern, '');
  }

  // Collapse whitespace before Step 8 so trailing detection works
  name = name.replace(/\s{2,}/g, ' ').trim();

  // Step 8: Strip trailing expanded finish words
  // After codes/dimensions are removed, if name ends with a finish word, strip it.
  // Apply repeatedly for stacked finishes (e.g. "... Structured Textured")
  while (TRAILING_FINISH_RE.test(name)) {
    name = name.replace(TRAILING_FINISH_RE, '');
  }

  // Also strip any remaining unknown trailing 2-letter codes
  name = name.replace(/\s+[A-Z][a-z]$/, '');

  // Step 9: Collapse whitespace and trim
  name = name.replace(/\s{2,}/g, ' ').trim();

  // Remove any trailing lone numbers that may remain
  name = name.replace(/\s+\d+$/, '').trim();

  return name;
}

// ─── Part 1: Normalize product display_name ────────────────────────────────

async function normalizeProducts() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  Part 1: Normalize Daltile Product Display Names');
  console.log('═══════════════════════════════════════════════════════════\n');

  const vendorRes = await pool.query(
    "SELECT id, name FROM vendors WHERE name ILIKE '%daltile%' LIMIT 1"
  );
  if (vendorRes.rows.length === 0) {
    console.log('  No Daltile vendor found — aborting.\n');
    return { updated: 0, total: 0 };
  }
  const vendorId = vendorRes.rows[0].id;
  console.log(`  Vendor: ${vendorRes.rows[0].name} (id=${vendorId})\n`);

  // Get ALL active Daltile products — always transform from raw `name`
  const products = await pool.query(
    `SELECT id, name, display_name
     FROM products
     WHERE vendor_id = $1 AND status = 'active'
     ORDER BY name`,
    [vendorId]
  );

  console.log(`  Total active products: ${products.rows.length}\n`);

  const changes = [];
  const unchanged = [];

  for (const p of products.rows) {
    const cleaned = normalizeName(p.name);
    const current = p.display_name || p.name;

    if (cleaned !== current && cleaned.length > 0) {
      changes.push({
        id: p.id,
        rawName: p.name,
        currentDisplay: current,
        newDisplay: cleaned,
      });
    } else {
      unchanged.push(p.name);
    }
  }

  // Categorize changes for reporting
  const hadNoDisplay = changes.filter(c => !c.currentDisplay || c.currentDisplay === c.rawName);
  const hadPartialDisplay = changes.filter(c => c.currentDisplay && c.currentDisplay !== c.rawName);

  console.log(`  Changes needed: ${changes.length}`);
  console.log(`    No display_name (raw name → clean):   ${hadNoDisplay.length}`);
  console.log(`    Had partial display_name → cleaner:    ${hadPartialDisplay.length}`);
  console.log(`    Already clean / unchanged:             ${unchanged.length}`);
  console.log();

  // Show all changes in dry-run, or samples in live mode
  const showCount = DRY_RUN ? changes.length : Math.min(changes.length, 25);
  if (showCount > 0) {
    console.log(`  ${DRY_RUN ? 'All' : 'Sample'} changes (${showCount} of ${changes.length}):`);
    for (let i = 0; i < showCount; i++) {
      const c = changes[i];
      console.log(`    "${c.currentDisplay}" → "${c.newDisplay}"`);
    }
    console.log();
  }

  if (DRY_RUN) {
    console.log(`  [DRY RUN] Would update ${changes.length} product display_names.\n`);
    return { updated: 0, wouldUpdate: changes.length, total: products.rows.length };
  }

  // Execute updates
  let updated = 0;
  for (const c of changes) {
    await pool.query(
      'UPDATE products SET display_name = $1, updated_at = NOW() WHERE id = $2',
      [c.newDisplay, c.id]
    );
    updated++;
  }

  console.log(`  Updated ${updated} product display_names.\n`);
  return { updated, total: products.rows.length };
}

// ─── Part 2: Clean SKU variant_name values ─────────────────────────────────

async function normalizeVariantNames() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  Part 2: Clean Daltile SKU Variant Names');
  console.log('═══════════════════════════════════════════════════════════\n');

  const vendorRes = await pool.query(
    "SELECT id FROM vendors WHERE name ILIKE '%daltile%' LIMIT 1"
  );
  if (vendorRes.rows.length === 0) {
    return { updated: 0 };
  }
  const vendorId = vendorRes.rows[0].id;

  // Get SKUs with variant_name that contain known abbreviations
  // Build a regex pattern for PostgreSQL to find candidates
  const allAbbrevs = [
    ...WORD_ABBREVS.map(([a]) => a),
    ...FINISH_ABBREVS.filter(([, e]) => e !== '').map(([a]) => a),
    'Ls',
  ];
  // PostgreSQL word-boundary regex
  const pgPattern = allAbbrevs.map(a => `\\m${a}\\M`).join('|');

  const skus = await pool.query(
    `SELECT s.id, s.variant_name
     FROM skus s
     JOIN products p ON s.product_id = p.id
     WHERE p.vendor_id = $1 AND p.status = 'active'
       AND s.variant_name IS NOT NULL
       AND s.variant_name ~ ($2)
     ORDER BY s.variant_name`,
    [vendorId, pgPattern]
  );

  console.log(`  SKUs with abbreviations in variant_name: ${skus.rows.length}\n`);

  const changes = [];
  for (const s of skus.rows) {
    const cleaned = normalizeName(s.variant_name);
    if (cleaned !== s.variant_name && cleaned.length > 0) {
      changes.push({
        id: s.id,
        before: s.variant_name,
        after: cleaned,
      });
    }
  }

  if (changes.length === 0) {
    console.log('  No variant_name changes needed.\n');
    return { updated: 0 };
  }

  const showCount = DRY_RUN ? changes.length : Math.min(changes.length, 15);
  console.log(`  ${DRY_RUN ? 'All' : 'Sample'} changes (${showCount} of ${changes.length}):`);
  for (let i = 0; i < showCount; i++) {
    console.log(`    "${changes[i].before}" → "${changes[i].after}"`);
  }
  console.log();

  if (DRY_RUN) {
    console.log(`  [DRY RUN] Would update ${changes.length} SKU variant_names.\n`);
    return { updated: 0, wouldUpdate: changes.length };
  }

  let updated = 0;
  for (const c of changes) {
    await pool.query(
      'UPDATE skus SET variant_name = $1 WHERE id = $2',
      [c.after, c.id]
    );
    updated++;
  }

  console.log(`  Updated ${updated} SKU variant_names.\n`);
  return { updated };
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log();
  console.log(DRY_RUN
    ? '--- DRY RUN MODE — no changes will be made ---\n'
    : '--- LIVE MODE — changes will be applied ---\n'
  );

  const part1 = await normalizeProducts();
  const part2 = await normalizeVariantNames();

  console.log('═══════════════════════════════════════════════════════════');
  console.log('  Summary');
  console.log('═══════════════════════════════════════════════════════════');
  if (DRY_RUN) {
    console.log(`  Products:      ${part1.wouldUpdate || 0} of ${part1.total} would be updated`);
    console.log(`  SKU variants:  ${part2.wouldUpdate || 0} would be updated`);
  } else {
    console.log(`  Products:      ${part1.updated} of ${part1.total} updated`);
    console.log(`  SKU variants:  ${part2.updated} updated`);
  }
  console.log();

  await pool.end();
}

main().catch(err => {
  console.error('Fatal error:', err);
  pool.end().finally(() => process.exit(1));
});
