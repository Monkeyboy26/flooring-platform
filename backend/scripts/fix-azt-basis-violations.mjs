#!/usr/bin/env node
/**
 * fix-azt-basis-violations.mjs
 *
 * Clears the open AZT selling-basis quality violations (mosaic-not-per-sheet +
 * unit-basis-mismatch) with price-list-authoritative values from
 * backend/data/arizona/tile-prices.xlsx, per the importer's own rules
 * (scrapers/arizona.js:planFromPriceList): SHT/EA → unit/per_unit at net;
 * SF in a per-piece category → per-sheet (net × sf/pc); SF field → box/per_sqft.
 *
 * • 49 unpriced mosaic sheets (Cotto Toscano, Icon, Lagos, Sahara, Shibusa,
 *   Sky Blue/Skyline/Terra Nova 3D, Terrazzo, Tru Marmi) get real per-sheet
 *   pricing — they were "Call for Price".
 * • Invictus Vein Cut chevron mesh ×8: box/per_unit → unit/per_unit; the list
 *   prices matte $8.37 / polished $9.42 (half were cross-priced).
 * • Haisa Blue 3D stack sheet + Spark Bars 5x10 (EA) → unit/per_unit.
 * • Split Silver Travertine 4x16: NOT in the current list — stored $11.53
 *   matches sibling 4x16 SF rates (Skyline 9.42 / Sky Blue 8.66 / Atlantic
 *   Grey 10.47), so keep cost and set the basis it was always meant to have
 *   (box/per_sqft; box packaging already present).
 * • Vincen 2x2 mosaics ×3 (340047/340057/340067): no list row anywhere —
 *   intentionally left unpriced (call-for-price); violations stay open.
 *
 * Retail = keystone cost×1.6; upsertPricing nine-ends and applies the
 * covering floor.
 *
 * Usage:
 *   node scripts/fix-azt-basis-violations.mjs           # dry run
 *   node scripts/fix-azt-basis-violations.mjs --apply   # write (with backup)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';
import { upsertPricing } from '../scrapers/base.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APPLY = process.argv.includes('--apply');
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/flooring_pim',
});
const r2 = v => Math.round(v * 100) / 100;

// sku(s), cost, optional packaging {sf, pcs}, optional sell_by/basis overrides.
const sheet = (skus, cost, pkg = null) => skus.map(v => ({
  vendor_sku: v, sell_by: 'unit', price_basis: 'per_unit', cost, ...(pkg && { pkg }),
}));

const FIX = [
  // ── Cotto Toscano mosaics (SHT; list has no box data) ──
  ...sheet(['341280', '341286'], 8.37),                       // 2x2 Mosaico
  ...sheet(['341281', '341287'], 16.79),                      // 6in Star/Cross
  ...sheet(['341282', '341288'], 12.58),                      // HBone 1x6
  // ── Icon Hex 20x24 (SF 5.08 × 2.5286 sf/pc → per sheet) ──
  ...sheet(['7655', '7654', '7653'], r2(5.08 * 2.5286), { sf: 10.1144, pcs: 4 }),
  // ── Lagos Hex 4in (SHT) ──
  ...sheet(['7981', '7980', '7979', '7978', '7977'], 15.78, { sf: 8.6, pcs: 10 }),
  // ── Sahara (SHT unless noted) ──
  ...sheet(['340680'], 16.79, { sf: 11.2872, pcs: 10 }),      // Penny Round 2in
  ...sheet(['340682'], 16.79, { sf: 8.0054, pcs: 10 }),       // Penny Round 3/4
  ...sheet(['340672'], 12.11, { sf: 7.8225, pcs: 10 }),       // Chevron
  ...sheet(['340674'], 10.47, { sf: 10.51, pcs: 10 }),        // HBone 1x6
  ...sheet(['340679'], 16.79, { sf: 9.6517, pcs: 10 }),       // Multi Fin 2x2 Hex
  ...sheet(['340670'], r2(15.26 * 0.384132), { sf: 1.9207, pcs: 5 }),  // 8in Hex (SF → per pc)
  ...sheet(['340676'], 9.42, { sf: 5.3908, pcs: 10 }),        // 4x4 Hex Mesh
  // ── Shibusa (SHT) ──
  ...sheet(['7482', '7506', '7526', '7557', '7616'], 8.66, { sf: 4.842, pcs: 5 }),    // Basketweave 2x2
  ...sheet(['7479', '7503', '7523', '7554', '7613'], 17.26, { sf: 8.9, pcs: 10 }),    // Long Rhomboid 3x4
  ...sheet(['7481', '7505', '7525', '7556', '7615'], 18.28, { sf: 11.6208, pcs: 6 }), // Straight Stack 1x24
  // ── 3D Split 5-7/8x24 mesh (SHT) ──
  ...sheet(['343291'], 9.11, { sf: 5.907, pcs: 6 }),          // Sky Blue
  ...sheet(['343293'], 10.47, { sf: 5.907, pcs: 6 }),         // Skyline
  ...sheet(['343297'], 9.11, { sf: 5.907, pcs: 6 }),          // Terra Nova
  // ── Terrazzo Hex 4in (SHT) ──
  ...sheet(['8000', '8007', '8016', '8023', '8044'], 16.24, { sf: 8.6, pcs: 10 }),
  // ── Tru Marmi Hex 4in Matte (SHT) ──
  ...sheet(['6978', '7009', '7028', '7089', '7131'], 15.78, { sf: 8.6, pcs: 10 }),

  // ── unit-basis-mismatch repairs ──
  // Haisa Blue Split 3D Stack sheet (SHT 9.11; box pkg already right)
  ...sheet(['320178'], 9.11, { sf: 4.987, pcs: 5 }),
  // Invictus Vein Cut Chevron Mesh: matte 8.37 / polished 9.42 (SHT)
  ...sheet(['330977', '330998', '331019', '331058'], 8.37),   // Matte
  ...sheet(['330979', '331000', '331021', '331060'], 9.42),   // Polished
  // Spark Bars 5x10 (EA 3.11; box pkg already right)
  ...sheet(['337275', '337276'], 3.11, { sf: 4.7152, pcs: 14 }),
  // Split Silver Travertine 4x16 — stored cost is the SF rate; fix the basis
  { vendor_sku: '331340', sell_by: 'box', price_basis: 'per_sqft', cost: 11.53, pkg: { sf: 2.6664, pcs: 6 } },
];

async function main() {
  console.log(`\n=== AZT basis-violation fix (${APPLY ? 'APPLY' : 'DRY RUN'}) ===\n`);
  const { rows } = await pool.query(`
    SELECT s.id AS sku_id, s.vendor_sku, p.name, s.variant_name, s.sell_by,
           pr.price_basis, pr.cost, pr.retail_price, pk.sqft_per_box, pk.pieces_per_box
    FROM skus s JOIN products p ON p.id=s.product_id JOIN vendors v ON v.id=p.vendor_id
    LEFT JOIN pricing pr ON pr.sku_id=s.id LEFT JOIN packaging pk ON pk.sku_id=s.id
    WHERE v.code='AZT' AND s.vendor_sku = ANY($1)`, [FIX.map(f => f.vendor_sku)]);
  const cur = new Map(rows.map(r => [r.vendor_sku, r]));

  const plan = [];
  for (const f of FIX) {
    const c = cur.get(f.vendor_sku);
    if (!c) { console.log(`  ! vendor_sku ${f.vendor_sku} not found — skipped`); continue; }
    plan.push({ ...f, cur: c, retail: r2(f.cost * 1.6) });
    console.log(
      `  ${f.vendor_sku}  ${c.name} — ${c.variant_name}`.padEnd(62) +
      ` ${c.sell_by}/${c.price_basis ?? '∅'} $${c.cost ?? '∅'}` +
      ` → ${f.sell_by}/${f.price_basis} $${f.cost}` +
      (f.pkg ? `  pkg ${f.pkg.sf}/${f.pkg.pcs}` : ''));
  }

  if (!APPLY) { console.log(`\n${plan.length} SKUs planned (Vincen 340047/340057/340067 intentionally left call-for-price). Dry run — re-run with --apply.`); await pool.end(); return; }

  const backupName = `azt-basis-violations-backup-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
  let backupPath = path.join(__dirname, `../data/${backupName}`);
  const backupJson = JSON.stringify(plan.map(p => p.cur), null, 1);
  try { fs.writeFileSync(backupPath, backupJson); }
  catch { backupPath = path.join('/tmp', backupName); fs.writeFileSync(backupPath, backupJson); }
  console.log(`\nBackup: ${backupPath}`);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const p of plan) {
      if (p.cur.sell_by !== p.sell_by) {
        await client.query('UPDATE skus SET sell_by=$2, updated_at=NOW() WHERE id=$1', [p.cur.sku_id, p.sell_by]);
      }
      await upsertPricing(client, p.cur.sku_id, {
        cost: p.cost, retail_price: p.retail, price_basis: p.price_basis, map_price: null,
      }, { coveringFloor: true });
      if (p.pkg) {
        await client.query(`
          INSERT INTO packaging (sku_id, sqft_per_box, pieces_per_box) VALUES ($1,$2,$3)
          ON CONFLICT (sku_id) DO UPDATE SET sqft_per_box=EXCLUDED.sqft_per_box, pieces_per_box=EXCLUDED.pieces_per_box
        `, [p.cur.sku_id, p.pkg.sf, p.pkg.pcs]);
      }
    }
    await client.query('COMMIT');
    console.log(`Applied ${plan.length} SKU fixes.`);
  } catch (err) { await client.query('ROLLBACK'); throw err; }
  finally { client.release(); }
  await pool.end();
}
main().catch(err => { console.error(err); process.exit(1); });
