#!/usr/bin/env node
/**
 * One-time reprice: switch Daltile from the old cost-based sliding markup
 * (2.5x/2.2x/2.0x/1.8x/1.6x by cost band) to a flat 1.6x keystone, matching
 * every other vendor. See scrapers/daltile-832.js + daltile-unified.js.
 *
 * Only rows whose retail was DERIVED from the sliding formula are touched:
 * ratio (retail/cost) rounded to 1dp ∈ {1.8, 2.0, 2.2, 2.5}. Real EDI list
 * prices scatter (1.3/1.4/1.7/2.4/2.6/3.0) and are left alone. The 1.6 band is
 * already keystone (no-op) and skipped. retail_locked rows are never touched.
 *
 * Writes a full before/after backup to backend/data/ first. Dry-run by default;
 * pass --apply to write.
 */
import { pool } from '../db.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const DALTILE_VENDOR_ID = '550e8400-e29b-41d4-a716-446655440003';
const APPLY = process.argv.includes('--apply');
const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const { rows } = await pool.query(
    `SELECT pr.sku_id, pr.cost, pr.retail_price,
            ROUND((pr.retail_price / pr.cost)::numeric, 1) AS ratio
       FROM pricing pr
       JOIN skus s     ON s.id = pr.sku_id
       JOIN products p ON p.id = s.product_id
      WHERE p.vendor_id = $1
        AND pr.cost > 0
        AND pr.retail_locked = false
        AND ROUND((pr.retail_price / pr.cost)::numeric, 1) IN (1.8, 2.0, 2.2, 2.5)`,
    [DALTILE_VENDOR_ID]
  );

  if (!rows.length) {
    console.log('No sliding-scale Daltile prices found — nothing to reprice.');
    await pool.end();
    return;
  }

  const changes = rows.map(r => {
    const cost = parseFloat(r.cost);
    return {
      sku_id: r.sku_id,
      cost,
      old_retail: parseFloat(r.retail_price),
      new_retail: Math.round(cost * 1.6 * 100) / 100,
      old_ratio: parseFloat(r.ratio),
    };
  });

  // Timestamped backup of every row we're about to touch.
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(__dirname, '..', 'data', `daltile-reprice-backup-${ts}.json`);
  fs.writeFileSync(backupPath, JSON.stringify(changes, null, 2));
  console.log(`Backup written: ${backupPath} (${changes.length} rows)`);

  // Summary by band.
  const byBand = {};
  for (const c of changes) byBand[c.old_ratio] = (byBand[c.old_ratio] || 0) + 1;
  console.log('Rows by old ratio band:', byBand);
  const drop = changes.reduce((s, c) => s + (c.old_retail - c.new_retail), 0);
  console.log(`Avg retail drop: $${(drop / changes.length).toFixed(2)} per SKU`);
  console.log('Sample:', changes.slice(0, 5).map(c =>
    `cost $${c.cost} ${c.old_ratio}x $${c.old_retail} → $${c.new_retail}`).join(' | '));

  if (!APPLY) {
    console.log('\nDRY RUN — re-run with --apply to write changes.');
    await pool.end();
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const c of changes) {
      await client.query(
        'UPDATE pricing SET retail_price = $1 WHERE sku_id = $2',
        [c.new_retail, c.sku_id]
      );
    }
    await client.query('COMMIT');
    console.log(`\nAPPLIED — repriced ${changes.length} Daltile SKUs to flat 1.6x keystone.`);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  await pool.end();
}

main().catch(async e => { console.error(e); await pool.end(); process.exit(1); });
