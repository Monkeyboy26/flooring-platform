#!/usr/bin/env node
/**
 * Shaw abbreviation/truncation/typo cleanup.
 *
 * Fixes:
 *   1. Display name abbreviations (Ct→COREtec, Tl→Tile, Tnl→Tonal, etc.)
 *   2. Variant name + color attribute truncations (15-char EDI cutoff)
 *   3. Variant name + color attribute style code removal (V1234, 0278v, Ds)
 *   4. Variant name + color attribute abbreviation expansion
 *   5. Variant name + color attribute typo fixes
 *   6. Rebuild search vectors
 *
 * Usage:
 *   node backend/scripts/shaw-abbrev-fix.cjs --dry-run
 *   node backend/scripts/shaw-abbrev-fix.cjs
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
  console.log(`  ${label.padEnd(42)} ${result}`);
}

// ─── Display name fixes (exact match) ────────────────────────────────
const DISPLAY_NAME_FIXES = {
  'Ct Tile SPC 18':        'COREtec Tile SPC 18',
  'Carbon Copy Tl':        'Carbon Copy Tile',
  'High Ranking Tnl':      'High Ranking Tonal',
  'Calais Stil':           'Calais Stiletto',
  'Artistic Impres':       'Artistic Impressions',
  'COREtec Plus Xle':      'COREtec Plus XL Enhanced',
  'Flsn4.5w4.5 5.4':      'Flush Stairnose 4.5" 4.5-5.4mm',
  'Flush Sn5.5mm':         'Flush Stairnose 5.5mm',
  'Cabana Life B':         'Cabana Life Berber',
  'Cabana Life T':         'Cabana Life Texture',
  'Make It Yours S':       'Make It Yours Saxony',
  'Everyday Comfort S':    'Everyday Comfort Saxony',
};

// ─── Truncation fixes (variant_name + color attr) ────────────────────
// 15-char EDI cutoff completing the truncated word
const TRUNCATION_FIXES = {
  'Autumn Barnboar':       'Autumn Barnboard',
  'Black Tourmalin':       'Black Tourmaline',
  'Brushed Aluminu':       'Brushed Aluminum',
  'Colonial Distri':       'Colonial District',
  'Compound Intere':       'Compound Interest',
  'Dalmatian Jaspe':       'Dalmatian Jasper',
  'Embrace Strengt':       'Embrace Strength',
  'Fresh Perspecti':       'Fresh Perspective',
  'Hudson Valley O':       'Hudson Valley Oak',
  'Light Aspiratio':       'Light Aspiration',
  'Luck Of The Dra':       'Luck Of The Draw',
  "Nature's Essent":       "Nature's Essence",
  'Peachtree Stree':       'Peachtree Street',
  'Seacliff Height':       'Seacliff Heights',
  'Sophisticated G':       'Sophisticated Grey',
  'Spring Buttercu':       'Spring Buttercup',
  'Stars And Strip':       'Stars And Stripes',
  'Stroke Of Geniu':       'Stroke Of Genius',
  'Tattered Barnbo':       'Tattered Barnboard',
  'Timeless Barnbo':       'Timeless Barnboard',
  'Weathered Sidin':       'Weathered Siding',
  'Polished Chrome Anodiz': 'Polished Chrome Anodized',
  'Satin Nickel Anodi':    'Satin Nickel Anodized',
  'Satin Silver Anodi':    'Satin Silver Anodized',
  'Antique Chest':         'Antique Chestnut',
};

// ─── Style code removal (regex patterns → cleaned value) ─────────────
// These are variant_name + color patterns with trailing style/vendor codes
const STYLE_CODE_FIXES = {
  'Lighthouse 0278v':      'Lighthouse',
  'Lighthouse V2547':      'Lighthouse',
  'Lighthouse0278v':       'Lighthouse',
  'Lighthouse0736v':       'Lighthouse',
  'Driftwood V1736':       'Driftwood',
  'Driftwood V2546':       'Driftwood',
  'Driftwood Solid':       'Driftwood Solid', // NOT a code, keep as is
  'Color 520 V4049':       'Color 520',
  'Shadow V3100':          'Shadow',
  'Marina V2547':          'Marina',
  'Stone Grey Ds 0736v':   'Stone Grey',
  'Stone Grey Ds Ve210':   'Stone Grey',
  'Moonlight Ds':          'Moonlight',
  'Canyon Brown Ds':       'Canyon Brown',
  'Desert Sand Ds':        'Desert Sand',
  'Wheatfield Ds':         'Wheatfield',
  'Lighthouse V2547':      'Lighthouse',
};

// ─── Abbreviation expansions ─────────────────────────────────────────
const ABBREVIATION_FIXES = {
  'Charity W Cpt':         'Charity With Carpet',
  'Courage W Cpt':         'Courage With Carpet',
  'Hope W Cpt':            'Hope With Carpet',
  'Red Oak Naturl':        'Red Oak Natural',
  'Molding Track L':       'Molding Track LVT',
  'Vsm Tape 2 Inch':       'VSM Tape 2 Inch',
};

// ─── Typo fixes ──────────────────────────────────────────────────────
const TYPO_FIXES = {
  'Cinnamon Wlanut':       'Cinnamon Walnut',
  'Occasional Biege':      'Occasional Beige',
  'Toasted Tuape':         'Toasted Taupe',
  'Richhil Caastle':       'Richhill Castle',
  'Richhil Castle':        'Richhill Castle',
  'Weathered Bardboard':   'Weathered Barnboard',
  'Michigan Ave Indepencence': 'Michigan Ave Independence',
  'Eastwell  Oak':         'Eastwell Oak',
  'Laughs   Yawns':        'Laughs & Yawns',
};

// Merge all variant/color fixes into one map
const ALL_VALUE_FIXES = {
  ...TRUNCATION_FIXES,
  ...STYLE_CODE_FIXES,
  ...ABBREVIATION_FIXES,
  ...TYPO_FIXES,
};
// Remove no-op entry
delete ALL_VALUE_FIXES['Driftwood Solid'];

async function phase1_displayNames(client) {
  console.log('\n=== Phase 1: Fix display_name abbreviations ===');
  let count = 0;
  for (const [old, fixed] of Object.entries(DISPLAY_NAME_FIXES)) {
    const res = await client.query(`
      UPDATE products p SET display_name = $2, name = CASE WHEN p.name = p.display_name THEN $2 ELSE p.name END
      FROM vendors v
      WHERE v.id = p.vendor_id AND v.code = 'SHAW' AND p.status = 'active'
        AND p.display_name = $1
    `, [old, fixed]);
    if (res.rowCount > 0) {
      log(`"${old}" → "${fixed}"`, res.rowCount);
      count += res.rowCount;
    }
  }
  log('Total display_names fixed:', count);
  return count;
}

async function phase2_variantNames(client) {
  console.log('\n=== Phase 2: Fix variant_name truncations/abbreviations/typos ===');
  let count = 0;
  for (const [old, fixed] of Object.entries(ALL_VALUE_FIXES)) {
    const res = await client.query(`
      UPDATE skus s SET variant_name = $2
      FROM products p, vendors v
      WHERE p.id = s.product_id AND v.id = p.vendor_id
        AND v.code = 'SHAW' AND s.status = 'active'
        AND s.variant_name = $1
    `, [old, fixed]);
    if (res.rowCount > 0) {
      log(`"${old}" → "${fixed}"`, res.rowCount);
      count += res.rowCount;
    }
  }
  log('Total variant_names fixed:', count);
  return count;
}

async function phase3_colorAttributes(client) {
  console.log('\n=== Phase 3: Fix color attribute truncations/abbreviations/typos ===');
  // Get the color attribute ID
  const { rows: [attr] } = await client.query(
    `SELECT id FROM attributes WHERE slug = 'color'`
  );
  if (!attr) { log('No color attribute found!', ''); return 0; }

  let count = 0;
  for (const [old, fixed] of Object.entries(ALL_VALUE_FIXES)) {
    const res = await client.query(`
      UPDATE sku_attributes sa SET value = $3
      FROM skus s, products p, vendors v
      WHERE s.id = sa.sku_id AND p.id = s.product_id AND v.id = p.vendor_id
        AND v.code = 'SHAW' AND s.status = 'active'
        AND sa.attribute_id = $1 AND sa.value = $2
    `, [attr.id, old, fixed]);
    if (res.rowCount > 0) {
      log(`"${old}" → "${fixed}"`, res.rowCount);
      count += res.rowCount;
    }
  }
  log('Total color attributes fixed:', count);
  return count;
}

async function phase4_searchVectors(client) {
  console.log('\n=== Phase 4: Rebuild search vectors ===');
  const { rows: colCheck } = await client.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name='products' AND column_name='search_vector'
  `);
  if (colCheck.length === 0) { log('No search_vector column.', 'skipping'); return 0; }

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
  console.log(`Shaw Abbreviation Fix ${DRY_RUN ? '[DRY RUN]' : '[EXECUTING]'}`);
  console.log('='.repeat(60));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const r1 = await phase1_displayNames(client);
    const r2 = await phase2_variantNames(client);
    const r3 = await phase3_colorAttributes(client);
    const r4 = await phase4_searchVectors(client);

    if (DRY_RUN) {
      await client.query('ROLLBACK');
      console.log('\n[DRY RUN] Rolled back.');
    } else {
      await client.query('COMMIT');
      console.log('\n✓ Committed.');
    }

    console.log('\n=== Summary ===');
    log('Display names fixed:', r1);
    log('Variant names fixed:', r2);
    log('Color attributes fixed:', r3);
    log('Search vectors rebuilt:', r4);
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
