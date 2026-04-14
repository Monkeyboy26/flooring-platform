/**
 * Enrich Daltile display_name with Size & Finish from sku_attributes.
 *
 * For each active Daltile product:
 *   - If all SKUs share the same Size → append it (unless already in the name)
 *   - If all SKUs share the same Finish → append it (unless already in the name)
 *   - If display_name is NULL/empty → generate base from `name` first
 *
 * Idempotent — re-running after a successful run produces 0 changes.
 *
 * Usage:
 *   node backend/scripts/enrich-daltile-display-names.cjs --dry-run   # Preview
 *   node backend/scripts/enrich-daltile-display-names.cjs              # Execute
 */

const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'db',
  port: parseInt(process.env.DB_PORT || '5432'),
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  database: process.env.DB_NAME || 'flooring_pim',
});

const DRY_RUN = process.argv.includes('--dry-run');

// ─── Abbreviation maps (from fix-daltile-display-names.cjs) ──────────────────

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

const SIZE_CODE_PATTERNS = [
  /\b[PS]\d{1,2}[A-Z]?\d{1,2}[A-Z]?\d*\b/gi,
  /\b\d{1,2}[xX]\d{1,2}\b/g,
  /\b\d+\/\d+[xX]\d+\b/g,
  /\bS\d\/\d+\w+\b/gi,
  /\b\d+\/\d+[A-Za-z]+\b/g,
];

const GRP_SUFFIX = /\s+Grp\d+$/i;
const PREFIX_STRIPS = [
  /^Lvf\s+/i,
  /^Pts Professional Tile Solution\s+/i,
  /^Tread Pavers\s+/i,
  /^Xteriors Program\s+/i,
];
const LS_PATTERN = /\bLs\b/gi;

function expandName(raw) {
  let name = raw;
  name = name.replace(GRP_SUFFIX, '');
  for (const prefix of PREFIX_STRIPS) {
    name = name.replace(prefix, '');
  }
  for (const [abbrev, full] of Object.entries(WORD_ABBREVS)) {
    name = name.replace(new RegExp(`\\b${abbrev}\\b`, 'g'), full);
  }
  for (const [abbrev, full] of Object.entries(FINISH_ABBREVS)) {
    name = name.replace(new RegExp(`\\b${abbrev}\\b`, 'g'), full);
  }
  name = name.replace(LS_PATTERN, '');
  for (const pattern of SIZE_CODE_PATTERNS) {
    name = name.replace(pattern, '');
  }
  name = name.replace(/\s{2,}/g, ' ').trim();
  name = name.replace(/\s+\d+\s*\d*\/?\d*[xX]?\d*\s*$/, '').trim();
  return name;
}

// ─── Dimension pattern: matches sizes like 12x24, 8X48, 1/2x12, 3x6 ────────
const DIMENSION_RE = /\d+(?:\/\d+)?[xX\/]\d+/;

// Reverse map: full finish name → abbreviation code (for detecting abbreviations in names)
const FINISH_FULL_TO_ABBREV = {};
for (const [abbrev, full] of Object.entries(FINISH_ABBREVS)) {
  FINISH_FULL_TO_ABBREV[full.toLowerCase()] = abbrev;
}
// sku_attributes may say "Glossy" while abbreviation map says "Gloss"
FINISH_FULL_TO_ABBREV['glossy'] = 'Gl';

function baseContainsFinish(base, finish) {
  // Check full finish word
  if (new RegExp(`\\b${finish}\\b`, 'i').test(base)) return true;
  // Check abbreviation (e.g. "Tx" for "Textured")
  const abbrev = FINISH_FULL_TO_ABBREV[finish.toLowerCase()];
  if (abbrev && new RegExp(`\\b${abbrev}\\b`).test(base)) return true;
  return false;
}

function normalizeSize(size) {
  // Uppercase X → lowercase x  (e.g. "8X48" → "8x48")
  return size.replace(/X/g, 'x');
}

async function main() {
  if (DRY_RUN) console.log('=== DRY RUN — no changes will be written ===\n');

  // Get Daltile vendor ID
  const vendorRes = await pool.query("SELECT id FROM vendors WHERE name ILIKE '%daltile%' LIMIT 1");
  if (vendorRes.rows.length === 0) {
    console.log('No Daltile vendor found!');
    process.exit(1);
  }
  const vendorId = vendorRes.rows[0].id;

  // Query all active Daltile products with their SKUs' Size and Finish values
  const res = await pool.query(`
    SELECT
      p.id,
      p.name,
      p.display_name,
      array_agg(DISTINCT sa_size.value) FILTER (WHERE sa_size.value IS NOT NULL) AS sizes,
      array_agg(DISTINCT sa_finish.value) FILTER (WHERE sa_finish.value IS NOT NULL) AS finishes
    FROM products p
    JOIN skus s ON s.product_id = p.id AND s.status = 'active'
    LEFT JOIN sku_attributes sa_size
      ON sa_size.sku_id = s.id
      AND sa_size.attribute_id = (SELECT id FROM attributes WHERE slug = 'size')
    LEFT JOIN sku_attributes sa_finish
      ON sa_finish.sku_id = s.id
      AND sa_finish.attribute_id = (SELECT id FROM attributes WHERE slug = 'finish')
    WHERE p.vendor_id = $1 AND p.status = 'active'
    GROUP BY p.id, p.name, p.display_name
  `, [vendorId]);

  const results = {
    'size+finish': [],
    'size-only': [],
    'finish-only': [],
    'null-filled': [],
    'skipped': [],
  };

  for (const row of res.rows) {
    const sizes = row.sizes || [];
    const finishes = row.finishes || [];

    const uniformSize = sizes.length === 1 ? normalizeSize(sizes[0]) : null;
    const uniformFinish = finishes.length === 1 ? finishes[0] : null;

    // Nothing uniform to append — skip
    if (!uniformSize && !uniformFinish) {
      results.skipped.push(row);
      continue;
    }

    // Build base display name
    const wasNull = !row.display_name || row.display_name.trim() === '';
    let base;
    if (wasNull) {
      // Generate from name: strip [merged] suffix, expand abbreviations
      const cleaned = row.name.replace(/\s*\[merged\]\s*$/, '');
      base = expandName(cleaned);
    } else {
      base = row.display_name.replace(/\s*\[merged\]\s*$/, '').trim();
    }

    // Determine what to append
    let appendSize = false;
    let appendFinish = false;

    if (uniformSize && !DIMENSION_RE.test(base)) {
      appendSize = true;
    }
    if (uniformFinish && !baseContainsFinish(base, uniformFinish)) {
      appendFinish = true;
    }

    // Nothing to change
    if (!appendSize && !appendFinish && !wasNull) {
      results.skipped.push(row);
      continue;
    }

    // Build new display name
    let newName = base;
    if (appendSize) newName += ' ' + uniformSize;
    if (appendFinish) newName += ' ' + uniformFinish;

    // Skip if unchanged
    if (newName === row.display_name) {
      results.skipped.push(row);
      continue;
    }

    // Categorize the change
    if (wasNull) {
      results['null-filled'].push({ ...row, newName });
    } else if (appendSize && appendFinish) {
      results['size+finish'].push({ ...row, newName });
    } else if (appendSize) {
      results['size-only'].push({ ...row, newName });
    } else if (appendFinish) {
      results['finish-only'].push({ ...row, newName });
    } else {
      // wasNull case with no appending (just base generation)
      results['null-filled'].push({ ...row, newName });
    }

    if (!DRY_RUN) {
      await pool.query('UPDATE products SET display_name = $1 WHERE id = $2', [newName, row.id]);
    }
  }

  // ─── Report ──────────────────────────────────────────────────────────────────
  const totalChanged = results['size+finish'].length + results['size-only'].length
    + results['finish-only'].length + results['null-filled'].length;

  console.log(`Total products scanned: ${res.rows.length}`);
  console.log(`Total to update: ${totalChanged}`);
  console.log(`Skipped (no change): ${results.skipped.length}\n`);

  for (const [category, items] of Object.entries(results)) {
    if (category === 'skipped' || items.length === 0) continue;
    console.log(`── ${category} (${items.length}) ──`);
    const preview = items.slice(0, 15);
    for (const item of preview) {
      const before = item.display_name || `NULL (name: ${item.name})`;
      console.log(`  "${before}" → "${item.newName}"`);
    }
    if (items.length > 15) console.log(`  ... and ${items.length - 15} more`);
    console.log();
  }

  if (DRY_RUN) {
    console.log('No changes written (dry run).');
  } else {
    console.log(`Done — updated ${totalChanged} products.`);
  }

  await pool.end();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
