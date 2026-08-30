#!/usr/bin/env node
/**
 * fix-field-tile-per-piece.mjs
 *
 * MSI field/subway/plank tiles miscategorized as mosaic-tile and therefore left
 * on unit/per_unit with the per-PIECE face area in sqft_per_box — so the PDP
 * showed ".333 sqft/box" (one 4x12) and charged the per-sqft price per PIECE,
 * ~3x too high (Bay Blue 4x12: $16.79/sqft instead of $5.59). These are real
 * field tiles: MSI's carton reference prices them per SQFT, multi-piece, and its
 * per-piece area matches the nominal size in the name. Fix: box/per_sqft, real
 * carton coverage from data/msi/carton-packaging.json, and move OUT of
 * mosaic-tile (else the msi-unified reconciler reverts them and the
 * mosaic-not-per-sheet rule flags them). Retail recomputed by upsertPricing.
 *
 * Category: porcelain-tile for large-format porcelain lines (>= 12" side or known
 * porcelain series), else ceramic-tile (glazed ceramic/glass subway). Deco
 * mosaics, natural stone (per-piece stone model) and trim are never matched.
 *
 * Usage: node scripts/fix-field-tile-per-piece.mjs [--apply]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';
import { upsertPricing } from '../scrapers/base.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APPLY = process.argv.includes('--apply');
const CERAMIC = '650e8400-e29b-41d4-a716-446655440013';
const PORCELAIN = '650e8400-e29b-41d4-a716-446655440012';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/flooring_pim' });
const REF = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/msi/carton-packaging.json'), 'utf-8')).items || {};
const refByUpper = Object.fromEntries(Object.entries(REF).map(([k, v]) => [k.toUpperCase(), v]));
const SKIP = /mosaic|mesh|\bhex\b|penny|basket|round|chevron|herring|pinwheel|estrella|floralis|\bfan\b|arabesque|picket|3d|ellipse|liner|pencil|bullnose|\btrim\b|\bcap\b|corner|chair|quarter|jolly|listello|\bdot\b/i;
const r2 = v => Math.round(v * 100) / 100;
const PORC_LINE = /adella|autumn|gauged/i;

async function main() {
  console.log(`\n=== Field-tile per-piece fix (${APPLY ? 'APPLY' : 'DRY RUN'}) ===\n`);
  const { rows } = await pool.query(`
    SELECT s.id AS sku_id, s.product_id, s.vendor_sku, p.name, s.variant_name, c.slug AS cat,
           pr.cost, pr.retail_price
    FROM skus s JOIN products p ON p.id=s.product_id JOIN vendors v ON v.id=p.vendor_id
    JOIN categories c ON c.id=p.category_id JOIN pricing pr ON pr.sku_id=s.id
    WHERE v.code='MSI' AND s.status='active' AND p.status='active' AND s.is_sample IS NOT TRUE
      AND s.sell_by='unit' AND pr.price_basis='per_unit' AND c.slug='mosaic-tile'`);

  const plan = [];
  for (const r of rows) {
    const ref = refByUpper[(r.vendor_sku || '').toUpperCase()];
    if (!ref || ref.price_uom !== 'SQFT') continue;
    if (!(ref.pieces_per_box >= 4 && ref.sqft_per_box >= 3 && ref.sqft_per_piece > 0)) continue;
    const hay = `${r.variant_name || ''} ${r.name}`;
    if (SKIP.test(hay)) continue;
    const m = hay.match(/([0-9]+(?:\.[0-9]+)?)x([0-9]+(?:\.[0-9]+)?)/i);
    if (!m) continue;
    const w = parseFloat(m[1]), h = parseFloat(m[2]);
    if (!(w >= 1 && w <= 24 && h >= 4 && h <= 48)) continue;
    const nominal = w * h / 144;
    if (Math.abs(ref.sqft_per_piece - nominal) > 0.15 * Math.max(nominal, 0.01)) continue; // confirm individual field tile
    const bigSide = Math.max(w, h);
    // subway/plank (3x6 … 4x12) = glazed ceramic/glass wall tile; 12x24+/16x16
    // = porcelain field/floor. Known porcelain series forced to porcelain.
    const newCat = (bigSide >= 16 || PORC_LINE.test(hay)) ? PORCELAIN : CERAMIC;
    plan.push({ ...r, w, h, refSpb: ref.sqft_per_box, refPcs: ref.pieces_per_box, newCat,
      newCatSlug: newCat === PORCELAIN ? 'porcelain-tile' : 'ceramic-tile' });
  }

  console.log(`${plan.length} field tiles to fix (box/per_sqft + carton + recategorize)\n`);
  for (const p of plan) {
    console.log(`  ${p.vendor_sku.padEnd(24)} ${(p.name + ' ' + (p.variant_name||'')).slice(0,40).padEnd(40)}` +
      ` $${p.retail_price}/pc → $${p.retail_price}/sqft, ${p.refPcs}pc/${p.refSpb}sf, →${p.newCatSlug}`);
  }
  if (!plan.length) { await pool.end(); return; }
  if (!APPLY) { console.log('\nDry run — nothing written. Re-run with --apply.'); await pool.end(); return; }

  const backupName = `field-tile-per-piece-backup-${new Date().toISOString().slice(0,19).replace(/[:T]/g,'-')}.json`;
  let backupPath = path.join(__dirname, `../data/${backupName}`);
  try { fs.writeFileSync(backupPath, JSON.stringify(plan.map(({ sku_id, product_id, vendor_sku, name, variant_name, cat, cost, retail_price }) => ({ sku_id, product_id, vendor_sku, name, variant_name, cat, cost, retail_price })), null, 1)); }
  catch { backupPath = path.join('/tmp', backupName); fs.writeFileSync(backupPath, JSON.stringify(plan, null, 1)); }
  console.log(`\nBackup: ${backupPath}`);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const movedProducts = new Set();
    for (const p of plan) {
      if (!movedProducts.has(p.product_id)) {
        await client.query('UPDATE products SET category_id=$2, updated_at=NOW() WHERE id=$1', [p.product_id, p.newCat]);
        movedProducts.add(p.product_id);
      }
      await client.query('UPDATE skus SET sell_by=$2, updated_at=NOW() WHERE id=$1', [p.sku_id, 'box']);
      await upsertPricing(client, p.sku_id, {
        cost: parseFloat(p.cost), retail_price: parseFloat(p.retail_price), price_basis: 'per_sqft', map_price: null,
      }, { coveringFloor: true });
      await client.query(`
        INSERT INTO packaging (sku_id, sqft_per_box, pieces_per_box) VALUES ($1,$2,$3)
        ON CONFLICT (sku_id) DO UPDATE SET sqft_per_box=EXCLUDED.sqft_per_box, pieces_per_box=EXCLUDED.pieces_per_box
      `, [p.sku_id, p.refSpb, p.refPcs]);
    }
    await client.query('COMMIT');
    console.log(`Applied ${plan.length} field-tile fixes (${movedProducts.size} products recategorized).`);
  } catch (err) { await client.query('ROLLBACK'); throw err; }
  finally { client.release(); }
  await pool.end();
}
main().catch(err => { console.error(err); process.exit(1); });
