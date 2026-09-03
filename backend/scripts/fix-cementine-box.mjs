#!/usr/bin/env node
/**
 * fix-cementine-box.mjs
 *
 * Owner rule (2026-09-03): ALL Cementine items are sold by the box — the AZ
 * price list prices the individual patterns (B&W/Evo/Posa/Retro 1-5) per piece
 * (EA $4.06, sf/pc 0.4304), but the store only sells full 27-pc boxes, exactly
 * like the B&W Mix row the list itself prices per BX ($109.70 → $9.44/sf).
 *
 * Converts every Cementine SKU still on unit/per_unit to box/per_sqft with
 * cost = EA net / sf-per-pc (4.06 / 0.4304 = $9.43/sf); retail is recomputed
 * by upsertPricing (keystone 1.6x, nine-ending, covering floor → $15.09/sf,
 * matching the B&W Mix). Packaging (27 pcs / 11.6208 sf per box) is already
 * present on all SKUs and is left untouched.
 *
 * The importer is guarded the same way (scrapers/arizona.js BOX_ONLY_SERIES +
 * BX handling in planFromPriceList) so a re-scrape will not revert this.
 * Idempotent: re-running finds nothing on unit/per_unit and no-ops.
 *
 * Usage:
 *   node scripts/fix-cementine-box.mjs           # dry run
 *   node scripts/fix-cementine-box.mjs --apply   # write (with backup)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';
import { upsertPricing } from '../scrapers/base.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APPLY = process.argv.includes('--apply');
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL
    || `postgresql://postgres:${process.env.DB_PASSWORD || process.env.DB_PASS || 'postgres'}@${process.env.DB_HOST || 'localhost'}:5432/${process.env.DB_NAME || 'flooring_pim'}`,
});
const r2 = v => Math.round(v * 100) / 100;

// Price-list authoritative: every Cementine pattern row is EA $4.06 @ 0.4304 sf/pc.
const SF_PER_PC = 0.4304;

async function main() {
  console.log(`\n=== Cementine sell-by-box fix (${APPLY ? 'APPLY' : 'DRY RUN'}) ===\n`);
  const { rows } = await pool.query(`
    SELECT s.id AS sku_id, s.vendor_sku, p.name, s.sell_by,
           pr.cost, pr.retail_price, pr.price_basis, pk.sqft_per_box, pk.pieces_per_box
    FROM skus s
    JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id
    LEFT JOIN pricing pr ON pr.sku_id = s.id
    LEFT JOIN packaging pk ON pk.sku_id = s.id
    WHERE v.code = 'AZT' AND p.name ILIKE '%cementine%'
    ORDER BY p.name`);

  const plan = [];
  for (const c of rows) {
    if (c.sell_by === 'box' && c.price_basis === 'per_sqft') {
      console.log(`  = ${c.vendor_sku}  ${c.name} — already box/per_sqft @ ${c.cost}, skipped`);
      continue;
    }
    const cost = r2(parseFloat(c.cost) / SF_PER_PC); // EA net → per-sqft
    plan.push({ cur: c, cost, retail: r2(cost * 1.6) });
  }

  for (const p of plan) {
    console.log(
      `${p.cur.vendor_sku}  ${p.cur.name}`.padEnd(48) +
      ` ${p.cur.sell_by}/${p.cur.price_basis} → box/per_sqft` +
      `  cost ${p.cur.cost}→${p.cost}  retail ${p.cur.retail_price}→~${p.retail}`);
  }

  if (!APPLY) { console.log(`\n${plan.length} SKUs planned. Dry run — nothing written. Re-run with --apply.`); await pool.end(); return; }
  if (!plan.length) { console.log('Nothing to do.'); await pool.end(); return; }

  const backupName = `cementine-box-backup-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
  let backupPath = path.join(__dirname, `../data/${backupName}`);
  const backupJson = JSON.stringify(plan.map(p => p.cur), null, 1);
  try { fs.writeFileSync(backupPath, backupJson); }
  catch { backupPath = path.join('/tmp', backupName); fs.writeFileSync(backupPath, backupJson); }
  console.log(`\nBackup: ${backupPath}`);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const p of plan) {
      await client.query('UPDATE skus SET sell_by=$2, updated_at=NOW() WHERE id=$1', [p.cur.sku_id, 'box']);
      await upsertPricing(client, p.cur.sku_id, {
        cost: p.cost, retail_price: p.retail, price_basis: 'per_sqft', map_price: null,
      }, { coveringFloor: true });
    }
    await client.query('COMMIT');
    console.log(`Applied ${plan.length} SKU fixes.`);
  } catch (err) { await client.query('ROLLBACK'); throw err; }
  finally { client.release(); }
  await pool.end();
}
main().catch(err => { console.error(err); process.exit(1); });
