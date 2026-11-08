// Apply Genuine Materials (GMI) Q4 2026 price list cost changes
// (Q4 PL 2026.pdf from support@genuinematerials.com 2026-10-29,
// Gmail thread 1a189c15fc1a6949). Prior costs from 2026-07-29 onboard.
//
// Source: backend/data/gm/gmi-q4-cost-diff-2026-11-08.csv, produced by
// parse-gmi-q4-2026.py (section-aware: clearance-collection skus price from
// the p11 clearance tables, Sintera/porcelain/hybrid/3296/sinks from p3-10;
// sink page image-verified). 9 changes: 2 SINTERA $399 promo 26" prefabs
// (GQE014/GQE020) + 7 clearance jumbo-slab markdowns.
//
// Deliberately NOT touched: GMHSC001/002/004 (now SPECIAL ORDER, no price);
// GQC007-J, GQC015-P52, GQD008-J, GQE021-J absent from Q4 clearance tables
// (likely sold out — review separately). Retail re-derived via upsertPricing
// house rules; retail_locked rows keep price; price_basis preserved.
//
//   docker exec -e DB_HOST=db flooring-api node data/gm/gmi-apply-q4-2026-11-08.mjs [--apply]
// Without --apply it's a dry run (no writes, no backup).

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
const VENDOR_ID = '86a82f9b-8ffe-4069-b6d8-5c328ce5a609'; // Genuine Materials
const BACKUP = 'pricing_backup_gmi_20261108';
const CSV = new URL('./gmi-q4-cost-diff-2026-11-08.csv', import.meta.url).pathname;

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
