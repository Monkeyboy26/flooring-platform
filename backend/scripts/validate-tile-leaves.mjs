#!/usr/bin/env node
/**
 * validate-tile-leaves.mjs
 *
 * Runs the tile-family leaf validator (quality/tileLeafValidator.js) over the
 * active catalog. This is the same evidence + resolver that runs automatically
 * after every scrape and nightly — this CLI exists to dry-run and eyeball.
 *
 *   node scripts/validate-tile-leaves.mjs                 # dry run, all vendors
 *   node scripts/validate-tile-leaves.mjs --vendor AZT    # scope to one vendor
 *   node scripts/validate-tile-leaves.mjs --apply         # write moves/flags
 */
import pg from 'pg';
import { validateTileLeaves } from '../quality/tileLeafValidator.js';

const APPLY = process.argv.includes('--apply');
const vIdx = process.argv.indexOf('--vendor');
const vendorCode = vIdx > -1 ? process.argv[vIdx + 1] : null;

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/flooring_pim',
});

const short = (s, n = 46) => (s || '').length > n ? s.slice(0, n - 1) + '…' : (s || '');

try {
  let vendorId = null;
  if (vendorCode) {
    const { rows } = await pool.query('SELECT id FROM vendors WHERE code = $1', [vendorCode]);
    if (!rows.length) { console.error(`Unknown vendor code ${vendorCode}`); process.exit(1); }
    vendorId = rows[0].id;
  }

  const res = await validateTileLeaves(pool, { vendorId, apply: APPLY });

  const print = (label, list) => {
    if (!list.length) return;
    console.log(`\n${label} (${list.length}):`);
    for (const f of list) {
      console.log(`  ${f.vendor_code.padEnd(5)} ${short(f.name).padEnd(47)} ${f.from} → ${f.to}` +
        `${f.pinned ? '  [PINNED]' : ''}  (${f.reasons.join('; ')})`);
    }
  };

  print(APPLY ? 'MOVED (strong)' : 'WOULD MOVE (strong)', res.moved);
  print(APPLY ? 'FLAGGED for review (weak)' : 'WOULD FLAG (weak)', res.flagged);
  print(APPLY ? 'CLEARED stale needs_review' : 'WOULD CLEAR stale needs_review', res.cleared);

  console.log(`\n${APPLY ? '' : '[dry run] '}checked ${res.checked} tile-family products — ` +
    `${res.moved.length} strong, ${res.flagged.length} flagged, ${res.cleared.length} cleared`);
} finally {
  await pool.end();
}
