#!/usr/bin/env node
/**
 * One-time fix: Emser mosaic SHEETS mis-tagged variant_type='accessory'.
 *
 * The Emser 832 scraper classifies a product as an accessory when the feed's
 * manufacturer column ("collection") isn't "EMSER TILE" (isSundry) — meant to
 * catch Laticrete/Rubi/Nuheat installation sundries. But whole mosaic sheets
 * whose manufacturer string differs get swept up too, so ~149 genuine mosaic
 * products (their own product rows, multi-sheet packaging, already sell_by=unit
 * after the per-sheet migration) carry variant_type='accessory'. That hides
 * them from normal variant/browse display as if they were trim.
 *
 * This clears variant_type → NULL for those, scoped precisely: Emser +
 * accessory + (mosaic-tile category OR name contains "mosaic") + NOT trim
 * (bullnose/sbn/pencil/…) + sheet-like packaging (pieces_per_box>1 or a small
 * single sheet ≤3 sqft). Shower-system foam boards, leveling clips, coping and
 * pencil trim that also live in tile categories are excluded (not mosaics /
 * are trim) and stay accessory. The scraper is fixed in tandem
 * (emser-832 groupIntoProducts) so re-imports don't re-tag them.
 *
 * Idempotent. Writes a backup. Dry-run unless --apply.
 */
import { pool } from '../db.js';
import { isTrimPiece } from '../scrapers/base.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APPLY = process.argv.includes('--apply');

const SELECT = `
  SELECT s.id AS sku_id, s.internal_sku, c.slug AS category,
         p.name AS product, s.variant_name, s.sell_by,
         pk.sqft_per_box, pk.pieces_per_box
  FROM skus s
  JOIN products p ON p.id = s.product_id
  JOIN vendors v ON v.id = p.vendor_id
  LEFT JOIN categories c ON c.id = p.category_id
  LEFT JOIN packaging pk ON pk.sku_id = s.id
  WHERE v.name = 'Emser Tile'
    AND s.variant_type = 'accessory'
    AND (c.slug = 'mosaic-tile' OR p.name ~* 'mosaic')`;

const sheetLike = (r) =>
  (r.pieces_per_box && r.pieces_per_box > 1) ||
  (r.sqft_per_box && r.sqft_per_box > 0 && r.sqft_per_box <= 3);

async function main() {
  const { rows } = await pool.query(SELECT);
  // Genuine mosaic sheets: not trim, real sheet packaging.
  const fix = rows.filter(r => !isTrimPiece(`${r.product} ${r.variant_name || ''}`) && sheetLike(r));
  const skippedTrim = rows.filter(r => isTrimPiece(`${r.product} ${r.variant_name || ''}`));
  const skippedShape = rows.filter(r => !isTrimPiece(`${r.product} ${r.variant_name || ''}`) && !sheetLike(r));

  console.log(`${rows.length} Emser accessory rows in mosaic scope.`);
  console.log(`  → ${fix.length} genuine mosaic sheets to un-tag`);
  console.log(`  → ${skippedTrim.length} trim left as accessory`);
  console.log(`  → ${skippedShape.length} non-sheet left as accessory\n`);

  const byCat = {};
  for (const r of fix) byCat[r.category] = (byCat[r.category] || 0) + 1;
  console.log('By category:', JSON.stringify(byCat));
  console.log('\nSamples:');
  for (const r of fix.slice(0, 8))
    console.log(`  [${r.category}] ${r.product} / ${r.variant_name || '—'}  (${r.sell_by}, ${r.pieces_per_box || '?'} sheets)`);

  if (!fix.length) { await pool.end(); return; }
  if (!APPLY) { console.log('\nDry-run. Re-run with --apply to write.'); await pool.end(); return; }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = path.join(__dirname, '..', 'data', `emser-mosaic-accessory-fix-${stamp}.json`);
  fs.writeFileSync(backup, JSON.stringify(fix, null, 2));
  console.log(`\nBackup → ${backup}`);

  const ids = fix.map(r => r.sku_id);
  const res = await pool.query(
    `UPDATE skus SET variant_type = NULL, updated_at = NOW() WHERE id = ANY($1)`,
    [ids]
  );
  console.log(`✔ Cleared variant_type on ${res.rowCount} mosaic SKU(s).`);
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
