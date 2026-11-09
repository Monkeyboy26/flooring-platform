/**
 * Apply the raised $1.50 covering margin floor to EXISTING stored prices.
 *
 * The baseline minimum margin went $0.99 → $1.50 (owner, 2026-11-08). New scrapes
 * pick it up via upsertPricing, but already-stored retail prices were only floored
 * to the old $0.99. This lifts any covering product whose retail now sits under
 * cost + the category minimum margin up to the smallest 9-ending ≥ that floor.
 *
 * Mirrors priceRetail()/coveringFloorValue in backend/scrapers/base.js exactly:
 *   - minMargin: mosaic-tile per_unit = $4.50; any tile/mosaic category = $1.50;
 *     everything else = $1.50 (the new baseline).
 *   - covering floor applies to area coverings (per_sqft/sqft) and to tile/mosaic
 *     categories. (The per_unit coveringFloor opt for loose stacked-stone sheets
 *     isn't stored in the DB; the mosaic/tile categories catch those cases.)
 *   - FLOOR semantics: only ever RAISES a price, never lowers one. Rows already at
 *     or above the floor are untouched. Locked rows are lifted too — base.js's
 *     GREATEST() never lets a retail_locked price sit under the covering floor.
 *
 * Usage:
 *   node backend/scripts/apply-minmargin-150.mjs                        # dry run (default)
 *   node backend/scripts/apply-minmargin-150.mjs --apply                # commit changes
 *   node backend/scripts/apply-minmargin-150.mjs --skip-locked --apply  # leave retail_locked (HD-matched) prices as-is
 */
import pg from 'pg';

const APPLY = process.argv.includes('--apply');
const SKIP_LOCKED = process.argv.includes('--skip-locked');

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

const RETAIL_MIN_MARGIN = 1.50;
const TILE_MIN_MARGIN = 1.50;
const MOSAIC_MIN_MARGIN = 4.50;
const TILE_FLOOR_SLUGS = new Set(['tile', 'backsplash-tile', 'ceramic-tile',
  'commercial-tile', 'fluted-tile', 'large-format-tile', 'pavers', 'pool-coping',
  'pool-tile', 'porcelain-tile', 'talavera-tile', 'terrazzo-tile', 'wood-look-tile']);

const round2 = (v) => Math.round(Number(v) * 100) / 100;
// Largest value ending in 9 (…X.09/…/X.99) that is ≤ v — round DOWN only.
const nearestNine = (v) => {
  const cents = Math.round(Number(v) * 100);
  const k = Math.floor((cents - 9) / 10);
  return Math.max(9, k * 10 + 9) / 100;
};
// Smallest 9-ending ≥ floorMin (base.js coveringFloorValue).
const floorToNine = (floorMin) => {
  let nine = nearestNine(floorMin);
  if (nine < floorMin - 1e-9) nine = round2(nine + 0.10);
  return nine;
};

async function main() {
  const { rows } = await pool.query(`
    SELECT pr.sku_id, pr.cost, pr.retail_price, pr.price_basis, pr.retail_locked,
           c.slug AS cat_slug
    FROM pricing pr
    JOIN skus s ON pr.sku_id = s.id
    JOIN products p ON s.product_id = p.id
    LEFT JOIN categories c ON p.category_id = c.id
    WHERE pr.cost IS NOT NULL AND pr.cost > 0
      AND pr.retail_price IS NOT NULL AND pr.retail_price > 0
  `);

  let considered = 0, raised = 0, lockedRaised = 0;
  const updates = [];
  const samples = [];

  for (const r of rows) {
    const cost = Number(r.cost);
    const cur = round2(r.retail_price);
    const cat = r.cat_slug;
    const isMosaic = cat === 'mosaic-tile';
    const isTile = TILE_FLOOR_SLUGS.has(cat);
    const isArea = r.price_basis === 'per_sqft' || r.price_basis === 'sqft';
    const applyCoveringFloor = isArea || isMosaic || isTile;
    if (!applyCoveringFloor) continue;
    if (SKIP_LOCKED && r.retail_locked) continue; // preserve HD-matched prices
    considered++;

    const minMargin = (isMosaic && r.price_basis === 'per_unit') ? MOSAIC_MIN_MARGIN
      : (isTile || isMosaic) ? TILE_MIN_MARGIN : RETAIL_MIN_MARGIN;
    const floorVal = floorToNine(cost + minMargin);

    if (cur >= floorVal - 1e-9) continue; // already clears the floor — leave it
    raised++;
    if (r.retail_locked) lockedRaised++;
    updates.push({ sku_id: r.sku_id, newPrice: floorVal });
    if (samples.length < 20) {
      samples.push(`  ${String(r.sku_id).slice(0, 8)}  cost ${cost.toFixed(2)}  ${cur.toFixed(2)} -> ${floorVal.toFixed(2)}  margin ${minMargin.toFixed(2)}  ${r.price_basis || 'n/a'}${r.retail_locked ? ' [LOCKED]' : ''}  ${cat || '(no cat)'}`);
    }
  }

  console.log(`Priced rows scanned:            ${rows.length}`);
  console.log(`  covering (floor applies):     ${considered}`);
  console.log(`  below new $1.50 floor → raise: ${raised}  (of which locked: ${lockedRaised})`);
  console.log(`\nSample changes:`);
  console.log(samples.join('\n') || '  (none)');

  if (!APPLY) {
    console.log(`\nDRY RUN — nothing written. Re-run with --apply to commit ${raised} updates.`);
    await pool.end();
    return;
  }

  console.log(`\nApplying ${raised} updates…`);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const u of updates) {
      await client.query('UPDATE pricing SET retail_price = $1 WHERE sku_id = $2', [u.newPrice, u.sku_id]);
    }
    await client.query('COMMIT');
    console.log(`Done — ${raised} rows updated.`);
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
