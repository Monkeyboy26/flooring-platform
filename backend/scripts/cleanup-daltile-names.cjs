#!/usr/bin/env node
/**
 * cleanup-daltile-names.cjs — Clean cryptic Daltile display names & normalize finishes
 *
 * Part 1: Clean ~400 Daltile products with vendor codes in display names
 *   Step 1 — Strip trailing part codes (e.g. S36c9, P43f9, Qcrl1885)
 *   Step 2 — Expand abbreviations (Cv→Cove, Bn→Bullnose, Sntry→Sanitary, etc.)
 *   Step 3 — Strip suffix codes (Dm, Tx, Gs, Ab, Eu, Slimt)
 *   Step 4 — Strip "Lvf " prefix from LVT product names
 *   Step 5 — Strip "Pts Professional Tile Solution " prefix
 *   Step 6 — Collapse whitespace and trim
 *
 * Part 2: Normalize "Glossy" → "Gloss" in sku_attributes (cross-vendor)
 *
 * Usage:
 *   node backend/scripts/cleanup-daltile-names.cjs --dry-run   # Preview changes
 *   node backend/scripts/cleanup-daltile-names.cjs              # Execute cleanup
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

// ─── Part 1 config ──────────────────────────────────────────────────────────

// Step 1: Trailing part codes — alphanumeric model codes at end of name
// Matches: S36c9, P43f9, A3401, Qcrl1885, etc.
const TRAILING_PART_CODE = /\s+[A-Z][a-z]*\d{2,}[a-z0-9]*$/;

// Step 2: Abbreviation expansions — vendor shortcodes → readable terms
// Order: longer abbreviations first to avoid partial matches
const ABBREVIATIONS = [
  ['Outcrn', 'Outside Corner'],
  ['Incrn', 'Inside Corner'],
  ['Extsn', 'Extension'],
  ['Sntry', 'Sanitary'],
  ['Qrtr', 'Quarter'],
  ['Stp', 'Step'],
  ['Cop', 'Coping'],
  ['Scl', 'Left Corner'],
  ['Scr', 'Right Corner'],
  ['Slm', 'Slim'],
  ['Cv', 'Cove'],
  ['Bn', 'Bullnose'],
  ['Ns', 'Nose'],
  ['Bc', 'Base Corner'],
];

// Step 3: Suffix codes to strip entirely (trailing 2-5 char codes)
const SUFFIX_CODES = ['Slimt', 'Dm', 'Tx', 'Gs', 'Ab', 'Eu'];

// Step 4: "Lvf " prefix (LVT/Luxury Vinyl Floor)
const LVF_PREFIX = /^Lvf\s+/i;

// Step 5: "Pts Professional Tile Solution " prefix
const PTS_PREFIX = /^Pts Professional Tile Solution\s+/i;

// ─── Transform function ─────────────────────────────────────────────────────

function cleanDisplayName(raw) {
  let name = raw;

  // Step 1: Strip trailing part codes
  name = name.replace(TRAILING_PART_CODE, '');

  // Step 2: Expand abbreviations (whole-word match)
  for (const [abbrev, expansion] of ABBREVIATIONS) {
    name = name.replace(new RegExp(`\\b${abbrev}\\b`, 'g'), expansion);
  }

  // Step 3: Strip suffix codes (whole-word match at end of string)
  for (const code of SUFFIX_CODES) {
    name = name.replace(new RegExp(`\\s+${code}$`, 'i'), '');
  }

  // Step 4: Strip "Lvf " prefix
  name = name.replace(LVF_PREFIX, '');

  // Step 5: Strip "Pts Professional Tile Solution " prefix
  name = name.replace(PTS_PREFIX, '');

  // Step 6: Collapse whitespace and trim
  name = name.replace(/\s{2,}/g, ' ').trim();

  return name;
}

// ─── Part 1: Clean Daltile display names ────────────────────────────────────

async function cleanDaltileNames() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  Part 1: Clean Daltile Display Names');
  console.log('═══════════════════════════════════════════════════════════\n');

  // Find Daltile vendor
  const vendorRes = await pool.query(
    "SELECT id, name FROM vendors WHERE name ILIKE '%daltile%' LIMIT 1"
  );
  if (vendorRes.rows.length === 0) {
    console.log('  No Daltile vendor found — skipping Part 1.\n');
    return { updated: 0 };
  }
  const vendorId = vendorRes.rows[0].id;
  console.log(`  Vendor: ${vendorRes.rows[0].name} (${vendorId})\n`);

  // Get all active Daltile products with their effective display name
  const products = await pool.query(
    `SELECT id, name, display_name, COALESCE(display_name, name) as effective_name
     FROM products
     WHERE vendor_id = $1 AND status = 'active'
     ORDER BY name`,
    [vendorId]
  );

  const changes = [];

  for (const p of products.rows) {
    const cleaned = cleanDisplayName(p.effective_name);
    if (cleaned !== p.effective_name && cleaned.length > 0) {
      changes.push({
        id: p.id,
        before: p.effective_name,
        after: cleaned,
      });
    }
  }

  if (changes.length === 0) {
    console.log('  No display name changes needed.\n');
    return { updated: 0 };
  }

  // Categorize changes for reporting
  const stats = {
    trailingCode: 0,
    abbreviation: 0,
    suffixCode: 0,
    lvfPrefix: 0,
    ptsPrefix: 0,
  };

  for (const c of changes) {
    if (TRAILING_PART_CODE.test(c.before)) stats.trailingCode++;
    for (const [abbrev] of ABBREVIATIONS) {
      if (new RegExp(`\\b${abbrev}\\b`).test(c.before)) { stats.abbreviation++; break; }
    }
    for (const code of SUFFIX_CODES) {
      if (new RegExp(`\\s+${code}$`, 'i').test(c.before)) { stats.suffixCode++; break; }
    }
    if (LVF_PREFIX.test(c.before)) stats.lvfPrefix++;
    if (PTS_PREFIX.test(c.before)) stats.ptsPrefix++;
  }

  console.log(`  Found ${changes.length} products to clean:`);
  console.log(`    Trailing part codes:  ${stats.trailingCode}`);
  console.log(`    Abbreviations:        ${stats.abbreviation}`);
  console.log(`    Suffix codes:         ${stats.suffixCode}`);
  console.log(`    Lvf prefix:           ${stats.lvfPrefix}`);
  console.log(`    Pts prefix:           ${stats.ptsPrefix}`);
  console.log();

  // Show samples (up to 15)
  const sampleCount = Math.min(changes.length, 15);
  console.log(`  Sample changes (${sampleCount} of ${changes.length}):`);
  for (let i = 0; i < sampleCount; i++) {
    console.log(`    "${changes[i].before}" → "${changes[i].after}"`);
  }
  console.log();

  if (DRY_RUN) {
    console.log(`  [DRY RUN] Would update ${changes.length} display names.\n`);
    return { updated: 0, wouldUpdate: changes.length };
  }

  // Execute updates
  let updated = 0;
  for (const c of changes) {
    await pool.query(
      'UPDATE products SET display_name = $1, updated_at = NOW() WHERE id = $2',
      [c.after, c.id]
    );
    updated++;
  }

  console.log(`  Updated ${updated} display names.\n`);
  return { updated };
}

// ─── Part 2: Normalize "Glossy" → "Gloss" in sku_attributes ────────────────

async function normalizeFinish() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  Part 2: Normalize Finish Attribute ("Glossy" → "Gloss")');
  console.log('═══════════════════════════════════════════════════════════\n');

  // Find the finish attribute
  const attrRes = await pool.query(
    "SELECT id FROM attributes WHERE slug = 'finish' LIMIT 1"
  );
  if (attrRes.rows.length === 0) {
    console.log('  No "finish" attribute found — skipping Part 2.\n');
    return { updated: 0 };
  }
  const finishAttrId = attrRes.rows[0].id;

  // Count current values
  const countRes = await pool.query(
    `SELECT value, COUNT(*) as cnt
     FROM sku_attributes
     WHERE attribute_id = $1 AND value IN ('Gloss', 'Glossy')
     GROUP BY value
     ORDER BY value`,
    [finishAttrId]
  );

  if (countRes.rows.length === 0) {
    console.log('  No "Gloss" or "Glossy" values found.\n');
    return { updated: 0 };
  }

  for (const row of countRes.rows) {
    console.log(`  "${row.value}": ${row.cnt} SKUs`);
  }

  const glossyRow = countRes.rows.find(r => r.value === 'Glossy');
  if (!glossyRow) {
    console.log('\n  No "Glossy" values to normalize — already clean.\n');
    return { updated: 0 };
  }

  const glossyCount = parseInt(glossyRow.cnt, 10);
  console.log(`\n  Will normalize ${glossyCount} "Glossy" → "Gloss"\n`);

  if (DRY_RUN) {
    console.log(`  [DRY RUN] Would update ${glossyCount} sku_attributes rows.\n`);
    return { updated: 0, wouldUpdate: glossyCount };
  }

  const updateRes = await pool.query(
    `UPDATE sku_attributes
     SET value = 'Gloss'
     WHERE attribute_id = $1 AND value = 'Glossy'`,
    [finishAttrId]
  );

  console.log(`  Updated ${updateRes.rowCount} rows.\n`);
  return { updated: updateRes.rowCount };
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log();
  console.log(DRY_RUN ? '🔍 DRY RUN MODE — no changes will be made\n' : '🔧 LIVE MODE — changes will be applied\n');

  const part1 = await cleanDaltileNames();
  const part2 = await normalizeFinish();

  console.log('═══════════════════════════════════════════════════════════');
  console.log('  Summary');
  console.log('═══════════════════════════════════════════════════════════');
  if (DRY_RUN) {
    console.log(`  Part 1: Would clean ${part1.wouldUpdate || 0} Daltile display names`);
    console.log(`  Part 2: Would normalize ${part2.wouldUpdate || 0} "Glossy" → "Gloss"`);
  } else {
    console.log(`  Part 1: Cleaned ${part1.updated} Daltile display names`);
    console.log(`  Part 2: Normalized ${part2.updated} finish values`);
  }
  console.log();

  await pool.end();
}

main().catch(err => {
  console.error('Fatal error:', err);
  pool.end().finally(() => process.exit(1));
});
