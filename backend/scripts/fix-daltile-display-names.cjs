/**
 * Fix Daltile display_name — one-time cleanup script.
 *
 * 1. For products WITHOUT display_name: generate from `name` by expanding
 *    EDI abbreviations, stripping internal codes, and cleaning prefixes.
 * 2. For products WITH display_name that still contain unexpanded abbreviations:
 *    re-expand them.
 *
 * Run: docker compose exec api node backend/scripts/fix-daltile-display-names.cjs
 */

const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'db',
  port: parseInt(process.env.DB_PORT || '5432'),
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  database: process.env.DB_NAME || 'flooring_pim',
});

// ─── Abbreviation map ──────────────────────────────────────────────────────────
// Two-letter finish/type codes from Daltile EDI TRN segments.
// Matched as whole words (word boundaries) to avoid false positives.
const FINISH_ABBREVS = {
  'Mt':  'Matte',
  'Gl':  'Gloss',
  'St':  'Structured',
  'Pl':  'Polished',
  'Tx':  'Textured',
  'Lp':  'Lappato',
  'Ab':  'Abrasive',
  'Gs':  'Glass',
  'Sx':  'Semi-Textured',
  'Hn':  'Honed',
  'Sf':  'Soft',
  'Sc':  'Scored',
  'Mx':  'Mixed',
  'Tm':  'Tumbled',
};

const WORD_ABBREVS = {
  'Bn':     'Bullnose',
  'Cv':     'Cove',
  'Mm':     'Mosaic',
  'Dm':     'Direct Mount',
  'Stp':    'Step',
  'Ns':     'Nose',
  'Cop':    'Coping',
  'Outcrn': 'Outside Corner',
  'Qrtr':   'Quarter',
  'Extsn':  'Extension',
  'Slimt':  'Slim Trim',
  'Vrdsn':  'Versa Down',
  'Vslcap': 'Versa Cap',
  'Vscap':  'Versa Stair Cap',
  'Vqrnd':  'Versa Quarter Round',
  'Bc':     'Base',
};

// Internal size/shape codes to strip entirely (matched as whole words)
// These are Daltile item-code fragments that leak into TRN trade names.
const SIZE_CODE_PATTERNS = [
  /\b[PS]\d{1,2}[A-Z]?\d{1,2}[A-Z]?\d*\b/gi,  // P43c9, S43f9, S36c9, Sc36c9, Pc36c9, etc.
  /\b\d{1,2}[xX]\d{1,2}\b/g,                    // 1/2x12, 1/2x6, 8x10
  /\b\d+\/\d+[xX]\d+\b/g,                        // 1/2x12 with fractions
  /\bS\d\/\d+\w+\b/gi,                            // S1/212j type codes
  /\b\d+\/\d+[A-Za-z]+\b/g,                       // 1/26bn, 1/26payed, etc.
];

// Regex for Grp suffix: " Grp1", " Grp2", etc.
const GRP_SUFFIX = /\s+Grp\d+$/i;

// Internal prefix patterns to strip
const PREFIX_STRIPS = [
  /^Lvf\s+/i,                     // LVF (luxury vinyl floor) prefix
  /^Pts Professional Tile Solution\s+/i, // PTS prefix
  /^Tread Pavers\s+/i,            // Tread Pavers prefix (→ just the collection name)
  /^Xteriors Program\s+/i,        // Xteriors Program prefix
];

// "Ls" between a code and finish — strip it (it's a qualifier, not meaningful)
const LS_PATTERN = /\bLs\b/gi;

function expandName(raw) {
  let name = raw;

  // Strip Grp suffix
  name = name.replace(GRP_SUFFIX, '');

  // Strip prefixes
  for (const prefix of PREFIX_STRIPS) {
    name = name.replace(prefix, '');
  }

  // Expand word abbreviations (order matters — do multi-char first)
  for (const [abbrev, full] of Object.entries(WORD_ABBREVS)) {
    name = name.replace(new RegExp(`\\b${abbrev}\\b`, 'g'), full);
  }

  // Expand finish abbreviations (typically at end of name)
  for (const [abbrev, full] of Object.entries(FINISH_ABBREVS)) {
    name = name.replace(new RegExp(`\\b${abbrev}\\b`, 'g'), full);
  }

  // Strip "Ls" qualifier
  name = name.replace(LS_PATTERN, '');

  // Strip internal size codes
  for (const pattern of SIZE_CODE_PATTERNS) {
    name = name.replace(pattern, '');
  }

  // Clean up whitespace
  name = name.replace(/\s{2,}/g, ' ').trim();

  // Remove trailing size dimensions that may remain: e.g., "6" or "1 3/8x94"
  name = name.replace(/\s+\d+\s*\d*\/?\d*[xX]?\d*\s*$/, '').trim();

  return name;
}

async function main() {
  console.log('Fixing Daltile display_name values...\n');

  // Get vendor ID
  const vendorRes = await pool.query("SELECT id FROM vendors WHERE name ILIKE '%daltile%' LIMIT 1");
  if (vendorRes.rows.length === 0) {
    console.log('No Daltile vendor found!');
    process.exit(1);
  }
  const vendorId = vendorRes.rows[0].id;

  // ── Part 1: Products WITHOUT display_name ─────────────────────────────────
  const noDisplay = await pool.query(
    `SELECT id, name, collection FROM products
     WHERE vendor_id = $1 AND status = 'active'
       AND (display_name IS NULL OR display_name = '')
     ORDER BY name`,
    [vendorId]
  );

  console.log(`Part 1: ${noDisplay.rows.length} products without display_name`);
  let set = 0;
  for (const p of noDisplay.rows) {
    const expanded = expandName(p.name);
    if (expanded && expanded !== p.name) {
      await pool.query('UPDATE products SET display_name = $1 WHERE id = $2', [expanded, p.id]);
      if (set < 10) console.log(`  "${p.name}" → "${expanded}"`);
      set++;
    } else {
      // Name is already clean — just copy to display_name
      await pool.query('UPDATE products SET display_name = $1 WHERE id = $2', [p.name, p.id]);
      set++;
    }
  }
  console.log(`  Set ${set} display_names\n`);

  // ── Part 2: Products WITH display_name that still have unexpanded abbreviations ──
  // Look for display_names ending in known 2-letter abbreviations
  const abbrevPattern = Object.keys(FINISH_ABBREVS)
    .map(a => `'${a}'`)
    .join(', ');

  const needsExpansion = await pool.query(
    `SELECT id, name, display_name FROM products
     WHERE vendor_id = $1 AND status = 'active'
       AND display_name IS NOT NULL AND display_name != ''
       AND (
         display_name ~ '\\y(St|Tx|Ab|Mx|Tm|Lp|Sf|Sc|Gs|Sx|Hn)$'
         OR display_name ~ '\\y(Mm|Bn|Dm|Cv|Stp|Ns|Cop|Outcrn|Qrtr)\\y'
         OR display_name ~ 'Grp\\d'
         OR display_name ~ '\\bLs\\b'
         OR display_name ~ '[PS]\\d{1,2}[A-Za-z]\\d'
       )
     ORDER BY name`,
    [vendorId]
  );

  console.log(`Part 2: ${needsExpansion.rows.length} products with incomplete display_name`);
  let fixed = 0;
  for (const p of needsExpansion.rows) {
    const expanded = expandName(p.display_name);
    if (expanded !== p.display_name) {
      await pool.query('UPDATE products SET display_name = $1 WHERE id = $2', [expanded, p.id]);
      if (fixed < 10) console.log(`  "${p.display_name}" → "${expanded}"`);
      fixed++;
    }
  }
  console.log(`  Fixed ${fixed} display_names\n`);

  // ── Summary ───────────────────────────────────────────────────────────────
  const summary = await pool.query(
    `SELECT
       COUNT(*) as total,
       COUNT(CASE WHEN display_name IS NOT NULL AND display_name != '' THEN 1 END) as has_display,
       COUNT(CASE WHEN display_name IS NULL OR display_name = '' THEN 1 END) as no_display
     FROM products WHERE vendor_id = $1 AND status = 'active'`,
    [vendorId]
  );
  const s = summary.rows[0];
  console.log(`Summary: ${s.total} active products — ${s.has_display} with display_name, ${s.no_display} without`);

  await pool.end();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
