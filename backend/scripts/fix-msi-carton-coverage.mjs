#!/usr/bin/env node
/**
 * fix-msi-carton-coverage.mjs
 *
 * Targeted backfill for MSI SKUs whose packaging.sqft_per_box holds the per-PIECE
 * surface area instead of the full carton coverage (e.g. Balboa Amber showed
 * "0.987 sqft/box · $2.56 per box" instead of "16.779 sqft/box · $43.46 per box").
 *
 * Root cause: scrapers/msi-unified.js:523-529 — when the 832 feed supplies a
 * per-piece surface measure (MEA SU) but PO4 has no carton size / piece count,
 * sqft_per_box falls back to the per-piece value. The importer already self-heals
 * this at scrapers/msi-unified.js:1076-1079 by reconciling against
 * data/msi/carton-packaging.json, and fix-msi-price-basis.mjs (action
 * 'packaging-only') does the same for cost/basis. This script isolates JUST the
 * carton-coverage correction so it can run safely against production, which still
 * carries pre-reconciliation packaging values. It NEVER touches pricing — the
 * per-sqft cost/retail on prod are already correct; only the coverage (and the
 * per-box figure derived from it) is wrong.
 *
 * A row is corrected only when ALL hold:
 *   - vendor = MSI, active, non-accessory, sell_by = 'box'
 *   - the reference has a real multi-piece carton (pieces_per_box > 1, sqft_per_box > 0)
 *   - stored sqft_per_box differs from the reference by > 5% (same tolerance the
 *     importer uses), i.e. it is plainly not the carton figure
 * Already-correct rows and rows without a carton reference are left untouched.
 *
 * Usage:
 *   node scripts/fix-msi-carton-coverage.mjs            # dry run (default)
 *   node scripts/fix-msi-carton-coverage.mjs --apply    # write changes (with backup)
 *
 * Target production by exporting its connection first:
 *   DATABASE_URL=postgresql://USER:PASS@HOST:5432/flooring_pim node scripts/fix-msi-carton-coverage.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APPLY = process.argv.includes('--apply');

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/flooring_pim',
});

const REF = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../data/msi/carton-packaging.json'), 'utf-8')
).items || {};

const r4 = v => Math.round(v * 10000) / 10000;

async function main() {
  console.log(`\n=== MSI carton-coverage backfill (${APPLY ? 'APPLY' : 'DRY RUN'}) ===\n`);

  const { rows } = await pool.query(`
    SELECT s.id AS sku_id, s.vendor_sku, s.variant_name,
           p.name AS product_name,
           pk.sqft_per_box, pk.pieces_per_box
    FROM skus s
    JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id
    LEFT JOIN packaging pk ON pk.sku_id = s.id
    WHERE v.code = 'MSI' AND s.status = 'active'
      AND s.sell_by = 'box'
      AND COALESCE(s.variant_type, '') <> 'accessory'
      AND pk.sqft_per_box IS NOT NULL`);

  const plan = [];
  for (const r of rows) {
    const ref = REF[(r.vendor_sku || '').toUpperCase()];
    if (!ref) continue;
    const refSpb = Number(ref.sqft_per_box);
    const refPpb = Number(ref.pieces_per_box);
    if (!(refSpb > 0) || !(refPpb > 1)) continue;         // need a real multi-piece carton
    const ourSpb = parseFloat(r.sqft_per_box);
    if (!(ourSpb > 0)) continue;
    if (Math.abs(ourSpb - refSpb) <= 0.05 * refSpb) continue; // already correct

    // Flag the classic per-piece leak explicitly for the report.
    const looksPerPiece = ref.sqft_per_piece != null
      && Math.abs(ourSpb - Number(ref.sqft_per_piece)) <= 0.02 * Math.max(1, Number(ref.sqft_per_piece));

    plan.push({
      ...r,
      ourSpb,
      nextSpb: r4(refSpb),
      ourPpb: r.pieces_per_box,
      nextPpb: refPpb,
      kind: looksPerPiece ? 'per-piece-leak' : 'coverage-mismatch',
    });
  }

  const byKind = {};
  for (const p of plan) byKind[p.kind] = (byKind[p.kind] || 0) + 1;
  console.log('Planned coverage fixes:', byKind, `(${plan.length} SKUs of ${rows.length} MSI box SKUs scanned)\n`);
  for (const p of plan) {
    console.log(
      `${p.kind.padEnd(18)} ${String(p.vendor_sku).padEnd(24)}` +
      ` spb ${p.ourSpb}→${p.nextSpb}` +
      `${Number(p.ourPpb) !== p.nextPpb ? ` pcs ${p.ourPpb ?? '∅'}→${p.nextPpb}` : ''}` +
      `  | ${p.product_name} ${p.variant_name || ''}`
    );
  }

  if (!plan.length) { console.log('Nothing to fix.'); await pool.end(); return; }
  if (!APPLY) { console.log('\nDry run — nothing written. Re-run with --apply.'); await pool.end(); return; }

  const backupName = `msi-carton-coverage-backup-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
  let backupPath = path.join(__dirname, `../data/${backupName}`);
  const backupJson = JSON.stringify(
    plan.map(p => ({ sku_id: p.sku_id, vendor_sku: p.vendor_sku, sqft_per_box: p.ourSpb, pieces_per_box: p.ourPpb })),
    null, 1
  );
  try { fs.writeFileSync(backupPath, backupJson); }
  catch { backupPath = path.join('/tmp', backupName); fs.writeFileSync(backupPath, backupJson); }
  console.log(`\nBackup: ${backupPath}`);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const p of plan) {
      await client.query(
        'UPDATE packaging SET sqft_per_box = $2, pieces_per_box = $3 WHERE sku_id = $1',
        [p.sku_id, p.nextSpb, p.nextPpb]
      );
    }
    await client.query('COMMIT');
    console.log(`Applied ${plan.length} carton-coverage fixes.`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
