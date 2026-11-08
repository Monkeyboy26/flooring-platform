// Apply Roca USA (vendor ROCA) dealer-cost changes from the 2026 Price Book
// II-JUL (emailed by ivan.bailon@rocatileusa.com 2026-11-02, Gmail thread
// 1a19e7741a07624e). Previous costs dated from the II-JAN edition (2026-03-07).
//
// Source: backend/data/roca/roca-cost-diff-2026-11-08.csv, produced by
// parse-roca-pricebook.py (grid-band PDF parse + image-verified fixups for
// merged-cell edge rows) diffed against live pricing. per_unit SKUs priced SF
// in the book (slabs) were converted via packaging area; conversion verified
// exact against the existing March costs (e.g. 8.40/SF x 36.167 sqft = 303.80).
//
// Deliberately NOT touched:
//   - F1O237U011/371 (AVALON 20MM paver): book lists $5.70 (series page) AND
//     $5.40 (PAVERS page) for the same code; DB keeps $5.40 pending vendor ack.
//   - 294 DB SKUs absent from the July book (likely discontinued; review sep).
//
// Retail is re-derived through upsertPricing() house rules: 1.70x keystone
// (retail=2x cost hands it to applyKeystone), charm-to-9, category floor.
// retail_locked rows keep their price. price_basis is NOT passed -> preserved.
//
//   docker exec -e DB_HOST=db flooring-api node data/roca/roca-apply-pricebook-2026-11-08.mjs [--apply]
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
const VENDOR_ID = 'b898517d-1643-4158-a92f-bf494bb69ef0'; // Roca USA
const BACKUP = 'pricing_backup_roca_20261108';
const CSV = new URL('./roca-cost-diff-2026-11-08.csv', import.meta.url).pathname;

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
