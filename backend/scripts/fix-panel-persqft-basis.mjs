#!/usr/bin/env node
/**
 * fix-panel-persqft-basis.mjs
 *
 * Large-format PANELS whose per-CARTON dollars were stored on a per_sqft basis,
 * so the storefront multiplied by the panel's ~36 sqft: EMS Zambia Deco 47x109
 * rang up at $4,418/panel instead of ~$123. High-confidence tell: per-PIECE area
 * >= 6 sqft (a genuine large panel, single or a 2-3 panel carton), cost > $40/sqft,
 * in a porcelain/ceramic tile category. per-panel cost = cost/pieces, sold
 * unit/per_unit. Retail recomputed by upsertPricing (keystone 1.6x, nine-ending,
 * covering floor).
 *
 * DELIBERATELY EXCLUDED (verified legitimate, would corrupt if converted):
 *   - natural-stone / marble (DAL Calacatta Gold, Pietra Divina ~$50/sqft is real)
 *   - antique-mirror glass (BOS Reflet), mosaics sold per sheet (EMS Corvo 2x4)
 *   - countertop slabs (per-sqft/inquire model by design)
 * These are why cost>$40 alone is NOT the criterion — size + single-piece +
 * porcelain/ceramic is. Mirrors the surgical importer fix in emser-832.js.
 *
 * Usage:
 *   node scripts/fix-panel-persqft-basis.mjs            # dry run
 *   node scripts/fix-panel-persqft-basis.mjs --apply    # write (with backup)
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

async function main() {
  console.log(`\n=== Panel per_sqft-basis fix (${APPLY ? 'APPLY' : 'DRY RUN'}) ===\n`);
  const { rows } = await pool.query(`
    SELECT s.id AS sku_id, v.code AS vcode, p.name, s.variant_name,
           pr.cost, pr.retail_price, pr.price_basis, s.sell_by,
           pk.sqft_per_box, COALESCE(pk.pieces_per_box,1) AS pieces
    FROM skus s JOIN products p ON p.id=s.product_id JOIN vendors v ON v.id=p.vendor_id
    JOIN categories c ON c.id=p.category_id JOIN pricing pr ON pr.sku_id=s.id JOIN packaging pk ON pk.sku_id=s.id
    WHERE s.status='active' AND p.status='active' AND s.is_sample IS NOT TRUE
      AND s.sell_by='box' AND pr.price_basis='per_sqft' AND pr.cost>40
      AND (pk.sqft_per_box/GREATEST(pk.pieces_per_box,1)) >= 6
      AND c.slug IN ('porcelain-tile','ceramic-tile','large-format-tile','wood-look-tile')
    ORDER BY v.code, p.name`);

  const plan = rows.map(r => {
    const pieces = parseInt(r.pieces, 10) || 1;
    const oldCost = parseFloat(r.cost);
    const newCost = r4(oldCost / Math.max(pieces, 1)); // per-carton dollars -> per-panel
    const shownBefore = r2(parseFloat(r.retail_price) * parseFloat(r.sqft_per_box)); // what a customer saw per box/panel
    return { ...r, pieces, oldCost, newCost, newRetail: r2(newCost * 1.6), shownBefore };
  });

  const byV = {};
  for (const p of plan) byV[p.vcode] = (byV[p.vcode] || 0) + 1;
  console.log('Planned:', byV, `(${plan.length} SKUs)\n`);
  for (const p of plan.slice(0, 25)) {
    console.log(
      `${p.vcode} ${p.name} ${p.variant_name || ''}`.slice(0, 52).padEnd(53) +
      ` pcs ${p.pieces} cost ${p.oldCost}${p.newCost !== p.oldCost ? '→' + p.newCost : ''}` +
      ` | was $${p.shownBefore}/box → ~$${p.newRetail}/unit`);
  }
  if (plan.length > 25) console.log(`  … ${plan.length - 25} more`);

  if (!APPLY) { console.log('\nDry run — nothing written. Re-run with --apply.'); await pool.end(); return; }

  const backupName = `panel-persqft-backup-${new Date().toISOString().slice(0,19).replace(/[:T]/g,'-')}.json`;
  let backupPath = path.join(__dirname, `../data/${backupName}`);
  const backupJson = JSON.stringify(plan.map(({ sku_id, vcode, name, variant_name, oldCost, retail_price, price_basis, sell_by, pieces }) =>
    ({ sku_id, vcode, name, variant_name, cost: oldCost, retail_price, price_basis, sell_by, pieces })), null, 1);
  try { fs.writeFileSync(backupPath, backupJson); }
  catch { backupPath = path.join('/tmp', backupName); fs.writeFileSync(backupPath, backupJson); }
  console.log(`\nBackup: ${backupPath}`);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const p of plan) {
      await client.query('UPDATE skus SET sell_by=$2, updated_at=NOW() WHERE id=$1', [p.sku_id, 'unit']);
      await upsertPricing(client, p.sku_id, {
        cost: p.newCost, retail_price: p.newRetail, price_basis: 'per_unit', map_price: null,
      }, { coveringFloor: true });
    }
    await client.query('COMMIT');
    console.log(`Applied ${plan.length} panel fixes.`);
  } catch (err) { await client.query('ROLLBACK'); throw err; }
  finally { client.release(); }
  await pool.end();
}
main().catch(err => { console.error(err); process.exit(1); });
