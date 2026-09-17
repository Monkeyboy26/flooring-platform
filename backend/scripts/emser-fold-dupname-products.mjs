#!/usr/bin/env node
/**
 * emser-fold-dupname-products.mjs
 *
 * Resolves the 3 pre-existing duplicate-NAME Emser product pairs that the
 * vendor_sku dedup (emser-dedup-clean.mjs) didn't catch — they aren't V2/V3/W
 * code drift, they're distinct catch-all rows that happen to share a generic
 * name. Each pair = one canonical (more SKUs + media + real collection) + one
 * fragment. We move any genuinely-unique SKU from the fragment onto the
 * canonical (so no variety is lost), then deactivate the fragment
 * (status='inactive' — reversible).
 *
 * All facts below were verified by hand before hardcoding:
 *   • "Marble Polished":  keep 3c803b48 (Calacata, 27 SKUs, 80 media);
 *       fragment 234fd55c → move Winter Frost (M05WINTFR1818CP6, no twin);
 *       Kalta Bianco (P30) & Emperador Dark (P10) are pack-count dupes of
 *       ACTIVE products (3c803b48 / "Marble Marrone Emperador Polished").
 *   • "Marble Polished Mosaic": keep a17b62ac (Winter Frost, 2 SKUs, 6 media);
 *       fragment 39cea6bb → move Silver mosaic (M06MARBSI1212MO2, its only home).
 *   • "Virtue": keep 7aae3458 (Vice & Virtue, porcelain, 6 media);
 *       fragment 7e15c993 (ceramic, 1 media) — all 4 SKUs are P9-twin dupes,
 *       nothing to move.
 *
 * Usage:
 *   node backend/scripts/emser-fold-dupname-products.mjs            # dry run
 *   node backend/scripts/emser-fold-dupname-products.mjs --apply
 */

import pg from 'pg';
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});
const APPLY = process.argv.includes('--apply');
const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');

// Verified plan. moveSkus = vendor_skus to reparent onto `keep` before the
// fragment is deactivated.
const PLAN = [
  { name: 'Marble Polished',        keep: '3c803b48-66ef-44f5-aa90-732c8afdab11', drop: '234fd55c-6000-4737-8ab7-795ef26b564c', moveSkus: ['M05WINTFR1818CP6'] },
  { name: 'Marble Polished Mosaic', keep: 'a17b62ac-bf59-4cdc-ac7b-6f71f1c16d1a', drop: '39cea6bb-34c0-4e01-9a2f-3a5d594be31c', moveSkus: ['M06MARBSI1212MO2'] },
  { name: 'Virtue',                 keep: '7aae3458-3806-42d2-bd23-34f09bb4d7b0', drop: '7e15c993-212b-4a88-90b0-c4bfdbb1b6b7', moveSkus: [] },
];

async function main() {
  console.log(`\n=== Emser fold duplicate-name products — ${APPLY ? 'APPLY' : 'DRY RUN'} ===\n`);

  // Safety re-verification: every moveSku must have NO active twin elsewhere,
  // and every OTHER sku on a fragment must be a dupe of an ACTIVE sku elsewhere.
  const backup = { generated: new Date().toISOString(), plan: [] };
  const client = await pool.connect();
  try {
    for (const step of PLAN) {
      const { rows: fragSkus } = await client.query(
        `SELECT s.id, s.vendor_sku, s.variant_name FROM skus s WHERE s.product_id = $1`, [step.drop]);
      const moveSet = new Set(step.moveSkus.map(v => v.toLowerCase()));
      const moving = fragSkus.filter(s => moveSet.has(s.vendor_sku.toLowerCase()));
      const staying = fragSkus.filter(s => !moveSet.has(s.vendor_sku.toLowerCase()));

      // Guard: each "staying" (to be hidden) sku must have an ACTIVE twin (raw or de-pack) elsewhere.
      const orphaned = [];
      for (const s of staying) {
        const depack = s.vendor_sku.toLowerCase().replace(/(p|cp)[0-9]+$/, '');
        // Twins compare de-packed forms on BOTH sides — a fragment may hold the
        // clean code while the canonical holds the "P9" pack-count variant.
        const { rows: twin } = await client.query(
          `SELECT 1 FROM skus s2 JOIN products p2 ON p2.id = s2.product_id
           WHERE s2.product_id <> $1 AND p2.status = 'active'
             AND regexp_replace(lower(s2.vendor_sku), '(p|cp)[0-9]+$', '') = $2 LIMIT 1`,
          [step.drop, depack]);
        if (!twin.length) orphaned.push(s.vendor_sku);
      }
      // Guard: each "moving" sku must have NO active twin (else it's really a dupe, not unique).
      const notUnique = [];
      for (const s of moving) {
        const depack = s.vendor_sku.toLowerCase().replace(/(p|cp)[0-9]+$/, '');
        // Twins compare de-packed forms on BOTH sides — a fragment may hold the
        // clean code while the canonical holds the "P9" pack-count variant.
        const { rows: twin } = await client.query(
          `SELECT 1 FROM skus s2 JOIN products p2 ON p2.id = s2.product_id
           WHERE s2.product_id <> $1 AND p2.status = 'active'
             AND regexp_replace(lower(s2.vendor_sku), '(p|cp)[0-9]+$', '') = $2 LIMIT 1`,
          [step.drop, depack]);
        if (twin.length) notUnique.push(s.vendor_sku);
      }

      console.log(`• "${step.name}"`);
      console.log(`    keep ${step.keep}  ·  deactivate ${step.drop} (${fragSkus.length} SKUs)`);
      console.log(`    move → keep: ${moving.map(s => s.vendor_sku).join(', ') || '(none)'}`);
      console.log(`    hide as dupes: ${staying.map(s => s.vendor_sku).join(', ') || '(none)'}`);
      if (orphaned.length) console.log(`    ⛔ ORPHAN (no active twin, would be LOST): ${orphaned.join(', ')}`);
      if (notUnique.length) console.log(`    ⚠ move-sku HAS active twin (not unique): ${notUnique.join(', ')}`);
      if (orphaned.length || notUnique.length) throw new Error(`Guard failed for "${step.name}" — aborting, no changes made.`);

      backup.plan.push({ ...step, movingIds: moving.map(s => s.id), fragSkuIds: fragSkus.map(s => s.id) });
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = join(DATA_DIR, `emser-fold-dupname-backup-${stamp}.json`);
    writeFileSync(backupPath, JSON.stringify(backup, null, 2));
    console.log(`\nBackup written: ${backupPath}`);

    if (!APPLY) { console.log(`\nDRY RUN — re-run with --apply to commit.\n`); return; }

    await client.query('BEGIN');
    for (const step of backup.plan) {
      for (const sid of step.movingIds)
        await client.query(`UPDATE skus SET product_id = $1, updated_at = now() WHERE id = $2`, [step.keep, sid]);
      await client.query(`UPDATE products SET status = 'inactive', updated_at = now() WHERE id = $1`, [step.drop]);
    }
    await client.query('COMMIT');
    console.log(`\n✅ Applied: ${backup.plan.length} fragments deactivated, ` +
      `${backup.plan.reduce((n, s) => n + s.movingIds.length, 0)} SKUs moved to canonicals.\n`);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('ABORTED —', e.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
