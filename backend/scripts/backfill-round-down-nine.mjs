/**
 * Backfill: switch charm pricing from NEAREST-9 to ROUND-DOWN-9.
 *
 * Context: retail_price used to be rounded to the NEAREST value ending in 9
 * (…X.09/X.19/…/X.99). The rule changed (2026-08-23) to round DOWN only —
 * see nearestNine() in backend/scrapers/base.js and [[nine-ending-prices]].
 *
 * The stored retail_price already ends in 9, so re-rounding the STORED value is
 * a no-op — the rule operates on the pre-rounding base (cost × 1.6), which isn't
 * stored. So we recompute from cost and only touch rows that were provably
 * keystone-priced: a row qualifies iff its current retail_price equals exactly
 * what the OLD rule produced from cost × 1.6 (with the same covering-margin
 * floor). Those we rewrite with the NEW round-down rule. Every other row —
 * MAP-based, Home-Depot-locked, vendor-list, or manually-set — is left untouched
 * because its base can't be reconstructed from the DB. retail_locked always skipped.
 *
 * Result: keystone rows whose base sat above an .x9 boundary drop by 10¢; rows
 * already floor-aligned are unchanged. The covering floor (cost + $0.99) can
 * still lift a per_sqft/sqft price that would otherwise dip under cost.
 *
 * Usage:
 *   node backend/scripts/backfill-round-down-nine.mjs            # dry run (default)
 *   node backend/scripts/backfill-round-down-nine.mjs --apply    # commit changes
 */
import pg from 'pg';

const APPLY = process.argv.includes('--apply');

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

const RETAIL_MARKUP = 1.6;
const RETAIL_MIN_MARGIN = 0.99;

// OLD rule: nearest value ending in 9, exact midpoints round down.
const oldNine = (v) => {
  const cents = Math.round(Number(v) * 100);
  const k = Math.round((cents - 9) / 10 - 1e-9);
  return Math.max(9, k * 10 + 9) / 100;
};
// NEW rule: largest value ending in 9 that is ≤ v (round down only).
const newNine = (v) => {
  const cents = Math.round(Number(v) * 100);
  const k = Math.floor((cents - 9) / 10);
  return Math.max(9, k * 10 + 9) / 100;
};

// Mirrors priceRetail() in base.js. applyCoveringFloor is true for area coverings
// (per_sqft/sqft); per_unit mosaics also floor via a caller opt we can't see here,
// so any row the floor would have bumped simply won't match keystone and is skipped.
function priceRetail(base, cost, applyCoveringFloor, nineFn) {
  const rn = Number(base);
  if (!(rn > 0)) return null;
  const cn = applyCoveringFloor ? (Number(cost) || 0) : 0;
  const floorMin = cn > 0 ? cn + RETAIL_MIN_MARGIN : 0;
  let nine = nineFn(Math.max(rn, floorMin));
  if (floorMin > 0 && nine < floorMin - 1e-9) nine = Math.round((nine + 0.10) * 100) / 100;
  return nine;
}

const round2 = (v) => Math.round(Number(v) * 100) / 100;

async function main() {
  const { rows } = await pool.query(`
    SELECT sku_id, cost, retail_price, price_basis
    FROM pricing
    WHERE retail_locked IS NOT TRUE
      AND cost IS NOT NULL AND cost > 0
      AND retail_price IS NOT NULL AND retail_price > 0
  `);

  let keystone = 0, changed = 0, skippedNonKeystone = 0, noop = 0;
  const updates = [];
  const samples = [];

  for (const r of rows) {
    const cost = Number(r.cost);
    const cur = round2(r.retail_price);
    const applyCoveringFloor = r.price_basis === 'per_sqft' || r.price_basis === 'sqft';
    const base = cost * RETAIL_MARKUP;

    const oldExpected = priceRetail(base, cost, applyCoveringFloor, oldNine);
    if (oldExpected == null || round2(oldExpected) !== cur) {
      skippedNonKeystone++;
      continue; // not keystone-priced (MAP/list/manual) — base unknown, leave as-is
    }
    keystone++;

    const newExpected = round2(priceRetail(base, cost, applyCoveringFloor, newNine));
    if (newExpected === cur) { noop++; continue; }

    changed++;
    updates.push({ sku_id: r.sku_id, newPrice: newExpected });
    if (samples.length < 15) {
      samples.push(`  ${r.sku_id.slice(0, 8)}  cost ${cost.toFixed(2)}  ${cur.toFixed(2)} -> ${newExpected.toFixed(2)}  (${r.price_basis || 'n/a'})`);
    }
  }

  console.log(`Scanned (unlocked, priced):     ${rows.length}`);
  console.log(`  keystone-priced (cost×1.6):   ${keystone}`);
  console.log(`    already floor-aligned:      ${noop}`);
  console.log(`    to lower by 10¢:            ${changed}`);
  console.log(`  non-keystone (skipped):       ${skippedNonKeystone}`);
  console.log(`\nSample changes:`);
  console.log(samples.join('\n') || '  (none)');

  if (!APPLY) {
    console.log(`\nDRY RUN — no changes written. Re-run with --apply to commit ${changed} updates.`);
    await pool.end();
    return;
  }

  console.log(`\nApplying ${changed} updates…`);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const u of updates) {
      await client.query('UPDATE pricing SET retail_price = $1 WHERE sku_id = $2', [u.newPrice, u.sku_id]);
    }
    await client.query('COMMIT');
    console.log(`Done — ${changed} rows updated.`);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Rolled back:', e.message);
    process.exitCode = 1;
  } finally {
    client.release();
  }
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
