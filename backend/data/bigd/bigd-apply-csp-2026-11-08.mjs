// Apply Big D Supply (BIGD) Customer Specific Pricing changes from the
// 10/1/2026 CSP sheet (pricing@bigdsupply.com 2026-10-06, thread
// 1a112c9a1df17204, "41515 Big D Supply Updated Price List").
//
// Source: backend/data/bigd/bigd-cost-diff-2026-11-08.csv from
// parse-bigd-csp.py (x-range column parse; price-column char recovery for
// rows where long descriptions overlap). 15 changes: 13 WFTaylor lines +6%
// (eff 9/14), Mapei 8040003 +10.3%, Planiseal PMB 2438513 -17%.
//
// EXCLUDED: sheet skus 1562/2568/2580 are FOAM SOLUTIONS pads (20SY rolls)
// colliding with our Sponge Cushion Industries Tred-Mor skus (30yd rolls) —
// same style numbers, different manufacturer; our pads are NOT in this sheet.
// Schluter book items + Hallmark lines price via separate sheets (not CSP).
//
//   docker exec -e DB_HOST=db flooring-api node data/bigd/bigd-apply-csp-2026-11-08.mjs [--apply]

import pg from 'pg';
import fs from 'fs';
import { upsertPricing } from '../../scrapers/base.js';

const { Pool } = pg;
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

const APPLY = process.argv.includes('--apply');
const VENDOR_ID = '71708161-0077-4b80-b128-a52d689de455'; // Big D Supply
const BACKUP = 'pricing_backup_bigd_20261108';
const CSV = new URL('./bigd-cost-diff-2026-11-08.csv', import.meta.url).pathname;

function parseCsv(path) {
  const lines = fs.readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean);
  const header = lines[0].split(',');
  return lines.slice(1).map(l => {
    const cols = l.split(',');
    const row = {};
    header.forEach((h, i) => { row[h] = cols[i]; });
    return row;
  });
}

async function main() {
  const rows = parseCsv(CSV);
  console.log(`CSV change rows: ${rows.length}`);

  const changes = [];
  let missing = 0;
  for (const r of rows) {
    const newCost = parseFloat(r.new_cost);
    const { rows: skus } = await pool.query(
      `SELECT s.id AS sku_id, pr.cost, pr.retail_price, pr.price_basis, pr.retail_locked
         FROM products p JOIN skus s ON s.product_id = p.id
         JOIN pricing pr ON pr.sku_id = s.id
        WHERE p.vendor_id = $1 AND s.vendor_sku = $2`,
      [VENDOR_ID, r.vendor_sku]);
    if (!skus.length) { missing++; console.warn(`  ! no DB sku for ${r.vendor_sku}`); continue; }
    for (const s of skus) {
      // guard: CSV old_cost must match live cost (abort stale CSV application)
      if (Math.abs(parseFloat(s.cost) - parseFloat(r.old_cost)) > 0.005) {
        console.warn(`  ! drift ${r.vendor_sku}: live cost ${s.cost} != csv old_cost ${r.old_cost} — skipping`);
        continue;
      }
      changes.push({ ...s, vendor_sku: r.vendor_sku, newCost });
    }
  }
  console.log(`Resolved ${changes.length} pricing rows to update (${missing} vendor_skus unresolved).`);
  const locked = changes.filter(c => c.retail_locked);
  if (locked.length) console.log(`  (${locked.length} are retail_locked — cost updated, retail kept)`);

  if (!APPLY) {
    console.log('\nDRY RUN — first 10 planned changes:');
    for (const c of changes.slice(0, 10)) {
      console.log(`  ${c.vendor_sku.padEnd(16)} cost ${c.cost} -> ${c.newCost}  (retail now ${c.retail_price}, basis ${c.price_basis})`);
    }
    console.log('\nRe-run with --apply to back up + write.');
    await pool.end();
    return;
  }

  const ids = changes.map(c => c.sku_id);
  await pool.query(`DROP TABLE IF EXISTS ${BACKUP}`);
  await pool.query(
    `CREATE TABLE ${BACKUP} AS SELECT * FROM pricing WHERE sku_id = ANY($1::uuid[])`, [ids]);
  const { rows: [{ count }] } = await pool.query(`SELECT count(*) FROM ${BACKUP}`);
  console.log(`Backed up ${count} rows to ${BACKUP}.`);

  let done = 0;
  for (const c of changes) {
    await upsertPricing(pool, c.sku_id, { cost: c.newCost, retail_price: c.newCost * 2 });
    done++;
  }
  console.log(`Applied ${done} cost updates (retail re-derived via house rules).`);

  const sample = changes.slice(0, 8).map(c => c.sku_id);
  const { rows: after } = await pool.query(
    `SELECT s.vendor_sku, pr.cost, pr.retail_price, round(pr.retail_price/NULLIF(pr.cost,0),2) ratio
       FROM skus s JOIN pricing pr ON pr.sku_id = s.id WHERE s.id = ANY($1::uuid[])
      ORDER BY s.vendor_sku`, [sample]);
  console.log('\nSample after:');
  for (const a of after) console.log(`  ${a.vendor_sku.padEnd(16)} cost ${a.cost} retail ${a.retail_price} (${a.ratio}x)`);

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
