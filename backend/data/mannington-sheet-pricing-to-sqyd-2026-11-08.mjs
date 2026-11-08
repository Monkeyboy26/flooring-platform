// Convert Mannington sheet-vinyl pricing from per_sqft to per_sqyd.
//
// The 11/06 onboard stored the price list's native per-SQFT numbers
// (price_basis per_sqft) on sell_by='roll' SKUs. But the entire roll pipeline
// — storefront sheet/carpet calculators, cart line math, rep/admin displays —
// treats sell_by='roll' as per-SQYD (EF/SHAW/PC/TW precedent, 10k+ SKUs):
// the PDP showed "$5.75/sqyd" on a per-sqft number and the calculator/cart
// divided by 9, a 9x UNDERCHARGE (no carts/orders were affected — checked).
// Rather than make every roll code path basis-aware, store sheet like every
// other roll vendor: all costs/prices x9 as per_sqyd.
//
// Derivation (from mannington/mannington-pricelist-2026-11-06.json rolls[],
// the per-sqft vendor truth):
//   cut_cost  = cut_sf x 9 (null for roll-only lines)   roll_cost = roll_sf x 9
//   cost      = (cut_sf ?? roll_sf) x 9
//   retail    = via upsertPricing house rules (1.70x keystone + charm-9),
//               basis per_sqyd passed explicitly
//   cut_price / roll_price = max(1.70x nickel, carpet $1/sqft-margin floor
//               = cost_sqyd + $9, nickel-rounded up) — mirrors upsertPricing's
//               carpetFloor, which we bypass (writing columns directly) because
//               passing cut/roll params with a per-sqft base was the original
//               hazard; with sqyd costs the same floor is applied here.
//
// Backup: pricing_backup_mann_sheet_sqyd_20261108.
//
//   docker exec -e DB_HOST=db flooring-api node data/mannington-sheet-pricing-to-sqyd-2026-11-08.mjs [--apply]

import pg from 'pg';
import fs from 'fs';
import { upsertPricing } from '../scrapers/base.js';

const { Pool } = pg;
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

const APPLY = process.argv.includes('--apply');
const VENDOR_ID = 'dabbf50b-c1ed-4e81-8bf1-c1ac88a5a4bd'; // Mannington
const BACKUP = 'pricing_backup_mann_sheet_sqyd_20261108';
const SRC = new URL('./mannington/mannington-pricelist-2026-11-06.json', import.meta.url).pathname;

const nickel170 = c => Math.round(Math.round(c * 1.70 / 0.05) * 0.05 * 100) / 100;
const CARPET_MIN_MARGIN_SQYD = 9; // $1/sqft x 9 — house rule, see base.js carpetFloor
const rollRetail = costSqyd => {
  const p = nickel170(costSqyd);
  const min = costSqyd + CARPET_MIN_MARGIN_SQYD;
  return p < min ? Math.round(Math.ceil(min / 0.05) * 0.05 * 100) / 100 : p;
};

async function main() {
  const { rolls } = JSON.parse(fs.readFileSync(SRC, 'utf8'));
  const byCatalog = new Map(rolls.map(r => [r.catalog, r]));

  const { rows: skus } = await pool.query(
    `SELECT s.id, s.vendor_sku, pr.cost, pr.retail_price, pr.price_basis
       FROM skus s JOIN products p ON p.id = s.product_id
       JOIN pricing pr ON pr.sku_id = s.id
      WHERE p.vendor_id = $1 AND s.sell_by = 'roll'`, [VENDOR_ID]);
  const targets = skus.filter(s => byCatalog.has(s.vendor_sku));
  const alreadySqyd = targets.filter(s => s.price_basis === 'per_sqyd');
  console.log(`MANN roll SKUs: ${skus.length}; on rolls list: ${targets.length}; already per_sqyd: ${alreadySqyd.length}`);

  const plan = targets.filter(s => s.price_basis !== 'per_sqyd').map(s => {
    const r = byCatalog.get(s.vendor_sku);
    const baseSf = r.cut_sf ?? r.roll_sf;
    return {
      sku_id: s.id, vendor_sku: s.vendor_sku,
      cost: +(baseSf * 9).toFixed(2),
      // roll-only lines get cut = roll (EF convention): isRollPriced() keys on
      // cut_price, and without it the sheet calculator treats the per-sqyd
      // retail as a per-sqft rate (9x overcharge)
      cut_cost: +(baseSf * 9).toFixed(2),
      roll_cost: +(r.roll_sf * 9).toFixed(2),
      old: `${s.cost} ${s.price_basis}`,
    };
  });
  console.log(`To convert: ${plan.length}`);
  for (const p of plan.slice(0, 6)) {
    console.log(`  ${p.vendor_sku}: ${p.old} -> cost ${p.cost}/sqyd, cut ${p.cut_cost ?? '—'} -> ${p.cut_cost ? rollRetail(p.cut_cost) : '—'}, roll ${p.roll_cost} -> ${rollRetail(p.roll_cost)}`);
  }

  if (!APPLY) { console.log('\nDRY RUN — re-run with --apply.'); await pool.end(); return; }

  const ids = plan.map(p => p.sku_id);
  await pool.query(`DROP TABLE IF EXISTS ${BACKUP}`);
  await pool.query(`CREATE TABLE ${BACKUP} AS SELECT * FROM pricing WHERE sku_id = ANY($1::uuid[])`, [ids]);

  for (const p of plan) {
    await upsertPricing(pool, p.sku_id, { cost: p.cost, retail_price: p.cost * 2, price_basis: 'per_sqyd' });
    await pool.query(
      `UPDATE pricing SET cut_cost=$2, cut_price=$3, roll_cost=$4, roll_price=$5 WHERE sku_id=$1`,
      [p.sku_id, p.cut_cost, p.cut_cost != null ? rollRetail(p.cut_cost) : null, p.roll_cost, rollRetail(p.roll_cost)]);
  }
  console.log(`Converted ${plan.length} (backup ${BACKUP}).`);

  const { rows: after } = await pool.query(
    `SELECT s.vendor_sku, pr.cost, pr.retail_price, pr.price_basis, pr.cut_cost, pr.cut_price, pr.roll_cost, pr.roll_price
       FROM skus s JOIN pricing pr ON pr.sku_id = s.id WHERE s.id = ANY($1::uuid[]) ORDER BY random() LIMIT 6`,
    [ids]);
  console.log('\nSample after (all per sqyd; /9 = per sqft):');
  for (const a of after) console.log(`  ${a.vendor_sku} cost ${a.cost} retail ${a.retail_price} ${a.price_basis} cut ${a.cut_cost}->${a.cut_price} roll ${a.roll_cost}->${a.roll_price} (cut/sf ${(a.cut_price / 9).toFixed(2)})`);
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
