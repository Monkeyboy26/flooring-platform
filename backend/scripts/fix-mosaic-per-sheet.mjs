#!/usr/bin/env node
/**
 * fix-mosaic-per-sheet.mjs
 *
 * Converts priced mosaic/ledger SKUs flagged by the mosaic-not-per-sheet rule
 * (EMS, DAL, STX, ICON, 563/Stanza) from per-sqft to per-SHEET pricing
 * (sell_by=unit, price_basis=per_unit, cost = rate × sheet area), matching the
 * platform convention and the AZT fix that preceded this.
 *
 * Sheet area per SKU, in order of confidence:
 *   1. packaging pieces_per_box + sqft_per_box  → sfbx/pcs
 *   2. size-attr dims when both sides ≥ 4.5"    → w×h/144 (sheet dims; chips
 *      like DAL "1x1" are skipped here). If stored sqft_per_box is within 25%
 *      of the dims area, prefer it (it's the actual mesh coverage).
 *   3. sqft_per_box alone when 0.25–4.6 sf      → it IS the sheet coverage
 *      (DAL stores per-sheet coverage with no piece count)
 *   4. vendor special cases: ICON 2x2 porcelain mosaics = 1 sf sheets, 10/box
 *      (source catalog: "10/pcs-Box"); 563 Stanza standing-pebble 4x12 strips
 *      priced per strip.
 * Anything underivable is reported and left untouched.
 *
 * Packaging: real multi-sheet box data is kept; where the stored sqft_per_box
 * was the single-sheet coverage, pieces_per_box is set to 1; where dims gave
 * the sheet and sqft_per_box is an integer multiple, pieces_per_box is filled.
 *
 * Retail = keystone cost×1.6; upsertPricing nine-ends + covering floor —
 * effective $/sqft pricing is preserved, only the selling unit changes.
 *
 * MSI ledgestone/fieldstone crates, STX loose veneers and all UNPRICED mosaics
 * (OTT etc.) are intentionally NOT here — the rule now excludes them
 * (loose veneer sells per sqft; unpriced = call-for-price).
 *
 * Usage:
 *   node scripts/fix-mosaic-per-sheet.mjs           # dry run
 *   node scripts/fix-mosaic-per-sheet.mjs --apply   # write (with backup)
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
const r4 = v => Math.round(v * 10000) / 10000;

const VENEER_NAME_RE = /(veneer|fieldstone|ledgestone|\bashlar\b|sq rec|engineered stone|\brandom\b)/i;

// Parse "12x12", "6x24", '4" x 12"', "8X18", "12x35" → [w, h] inches.
function parseDims(s) {
  if (!s) return null;
  const m = String(s).replace(/["″]/g, '').match(/(\d+(?:\.\d+)?)\s*[xX]\s*(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const a = parseFloat(m[1]), b = parseFloat(m[2]);
  return isFinite(a) && isFinite(b) ? [a, b] : null;
}

function deriveSheetSf({ code, size, sfbx, pcs }) {
  if (pcs > 0 && sfbx > 0) return { sf: sfbx / pcs, how: `box ${sfbx}/${pcs}` };
  // DAL Pebble Oasis "Art Deco Pebble": sibling pebble sheets are 0.98 sf and
  // 10.78 sf/carton = exactly 11 sheets.
  if (code === 'DAL' && /art deco pebble/i.test(size || '')) {
    return { sf: 0.98, how: 'Pebble Oasis sheet (sibling coverage)', pcsHint: 11 };
  }
  // DAL Vivify trapezoid mosaic: 14-11/16 x 12-13/16 sheet = 1.31 sf,
  // 13.10 sf/carton = 10 sheets (Daltile spec, confirmed via dealer listings).
  if (code === 'DAL' && sfbx === 13.1) {
    return { sf: 1.31, how: 'Vivify trapezoid sheet 13x15', pcsHint: 10 };
  }
  const dims = parseDims(size);
  if (code === 'ICON') return { sf: 1.0, how: 'ICON 2x2 mesh = 1 sf sheet' };
  if (code === '563' && dims) return { sf: r4(dims[0] * dims[1] / 144), how: 'pebble strip dims' };
  if (dims && Math.min(dims[0], dims[1]) >= 4.5) {
    const dimSf = dims[0] * dims[1] / 144;
    if (sfbx > 0 && Math.abs(sfbx - dimSf) / dimSf < 0.25) {
      return { sf: sfbx, how: `mesh coverage ${sfbx} (~${r2(dimSf)} dims)` };
    }
    return { sf: r4(dimSf), how: `sheet dims ${dims[0]}x${dims[1]}` };
  }
  if (sfbx > 0 && sfbx >= 0.25 && sfbx <= 4.6) return { sf: sfbx, how: `stored sheet coverage ${sfbx}` };
  return null;
}

async function main() {
  console.log(`\n=== Mosaic per-sheet conversion (${APPLY ? 'APPLY' : 'DRY RUN'}) ===\n`);
  const { rows } = await pool.query(`
    SELECT v.code, c.slug AS cat, p.name, s.id AS sku_id, s.vendor_sku, s.variant_name,
           s.sell_by, pr.price_basis, pr.cost::float AS cost, pr.retail_price::float AS retail,
           pk.sqft_per_box::float AS sfbx, pk.pieces_per_box AS pcs,
           (SELECT sa.value FROM sku_attributes sa
             WHERE sa.sku_id=s.id AND sa.attribute_id=(SELECT id FROM attributes WHERE slug='size')) AS size
    FROM quality_violations qv
    JOIN vendors v ON v.id=qv.vendor_id
    JOIN skus s ON s.id=qv.sku_id
    JOIN products p ON p.id=s.product_id
    JOIN categories c ON c.id=p.category_id
    JOIN pricing pr ON pr.sku_id=s.id AND pr.cost > 0
    LEFT JOIN packaging pk ON pk.sku_id=s.id
    WHERE qv.status='open' AND qv.rule_key='mosaic-not-per-sheet'
      AND pr.price_basis='per_sqft'
    ORDER BY v.code, p.name`);

  const plan = [], skipped = [];
  for (const r of rows) {
    if (VENEER_NAME_RE.test(r.name) || VENEER_NAME_RE.test(r.variant_name || '')) continue; // rule now excludes
    const d = deriveSheetSf({ code: r.code, size: r.size, sfbx: r.sfbx, pcs: r.pcs });
    if (!d) { skipped.push(r); continue; }
    const cost = r2(r.cost * d.sf);
    // Packaging plan: keep real box data; fill pieces where derivable
    let pkg = null;
    if (!(r.pcs > 0)) {
      if (r.sfbx > 0 && Math.abs(r.sfbx - d.sf) < 1e-6) pkg = { sf: r.sfbx, pcs: 1 };
      else if (r.sfbx > 0 && d.sf > 0) {
        const n = r.sfbx / d.sf;
        if (Math.abs(n - Math.round(n)) < 0.15 && Math.round(n) >= 2 && Math.round(n) <= 40) {
          pkg = { sf: r.sfbx, pcs: Math.round(n) };
        }
      } else if (d.pcsHint && r.sfbx > 0) pkg = { sf: r.sfbx, pcs: d.pcsHint };
      else if (r.code === 'ICON') pkg = { sf: 10.0, pcs: 10 };
      else if (!r.sfbx) pkg = { sf: r4(d.sf), pcs: 1 };
    }
    plan.push({ ...r, sheetSf: d.sf, how: d.how, newCost: cost, newRetail: r2(cost * 1.6), pkg });
  }

  for (const p of plan) {
    console.log(
      `  ${p.code} ${p.vendor_sku}  ${p.name}`.slice(0, 66).padEnd(67) +
      ` $${p.cost}/sf × ${r2(p.sheetSf)}sf → $${p.newCost}/sheet  [${p.how}]` +
      (p.pkg ? `  pkg→${p.pkg.sf}/${p.pkg.pcs}` : ''));
  }
  if (skipped.length) {
    console.log('\n— underivable, left untouched —');
    for (const s of skipped) console.log(`  ${s.code} ${s.vendor_sku}  ${s.name} — size:${s.size ?? '∅'} sfbx:${s.sfbx ?? '∅'} pcs:${s.pcs ?? '∅'}`);
  }
  console.log(`\n${plan.length} SKUs planned, ${skipped.length} skipped.`);
  if (!APPLY) { console.log('Dry run — re-run with --apply.'); await pool.end(); return; }

  const backupName = `mosaic-per-sheet-backup-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
  let backupPath = path.join(__dirname, `../data/${backupName}`);
  const backupJson = JSON.stringify(plan.map(({ sku_id, vendor_sku, code, sell_by, price_basis, cost, retail, sfbx, pcs }) =>
    ({ sku_id, vendor_sku, code, sell_by, price_basis, cost, retail, sfbx, pcs })), null, 1);
  try { fs.writeFileSync(backupPath, backupJson); }
  catch { backupPath = path.join('/tmp', backupName); fs.writeFileSync(backupPath, backupJson); }
  console.log(`Backup: ${backupPath}`);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const p of plan) {
      if (p.sell_by !== 'unit') {
        await client.query(`UPDATE skus SET sell_by='unit', updated_at=NOW() WHERE id=$1`, [p.sku_id]);
      }
      await upsertPricing(client, p.sku_id, {
        cost: p.newCost, retail_price: p.newRetail, price_basis: 'per_unit', map_price: null,
      }, { coveringFloor: true });
      if (p.pkg) {
        await client.query(`
          INSERT INTO packaging (sku_id, sqft_per_box, pieces_per_box) VALUES ($1,$2,$3)
          ON CONFLICT (sku_id) DO UPDATE SET sqft_per_box=EXCLUDED.sqft_per_box, pieces_per_box=EXCLUDED.pieces_per_box
        `, [p.sku_id, p.pkg.sf, p.pkg.pcs]);
      }
    }
    await client.query('COMMIT');
    console.log(`Applied ${plan.length} conversions.`);
  } catch (err) { await client.query('ROLLBACK'); throw err; }
  finally { client.release(); }
  await pool.end();
}
main().catch(err => { console.error(err); process.exit(1); });
