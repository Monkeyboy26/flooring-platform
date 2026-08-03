#!/usr/bin/env node
/**
 * One-time migration: mosaics / stacked stone sold by the BOX → sold per SHEET.
 *
 * Business rule (see selling-conventions): mosaics, ledger panels, and stacked
 * stone are always sold per sheet (`sell_by='unit'`, `price_basis='per_unit'`),
 * even when the vendor packs them in boxes and quotes a per-sqft price. Many
 * tile feeds (Emser, MSI, THD, Daltile, Stanza, Elysium) landed these as
 * `sell_by='box'` + `per_sqft`, so the storefront showed a coverage calculator
 * and /sqft pricing instead of letting customers buy single sheets.
 *
 * This converts the per-sqft price to a per-SHEET price using the box packaging:
 *   sheet_sqft = pieces_per_box>1 ? sqft_per_box/pieces_per_box : sqft_per_box
 *   new retail  = retail_per_sqft × sheet_sqft
 *   new cost    = cost_per_sqft   × sheet_sqft
 * then sets sell_by='unit', price_basis='per_unit'. Packaging (box coverage +
 * piece/sheet count) is left in place — this matches how already-correct
 * per-sheet mosaics (e.g. Bedrosians) are stored.
 *
 * SAFETY: sheet coverage comes from base.js deriveSheetSqft() (the same helper
 * the scrapers now use). When it can't be derived — a large box with no piece
 * count (sheet count unknown) or no packaging at all — the row is NOT converted
 * (leaving it mis-classified is better than mis-pricing) and is reported for
 * manual review. Accessory/trim SKUs (variant_type='accessory') are skipped.
 *
 * Idempotent (only touches sell_by='box' rows). Writes a before-backup to
 * backend/data/. Dry-run unless --apply. Use --csv to dump the ambiguous rows.
 */
import { pool } from '../db.js';
import { deriveSheetSqft, isTrimPiece } from '../scrapers/base.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APPLY = process.argv.includes('--apply');

const SELECT = `
  SELECT s.id AS sku_id, s.internal_sku, s.variant_type, s.accessory_label,
         v.name AS vendor, c.slug AS category, p.name AS product, s.variant_name,
         pr.cost, pr.retail_price, pr.sale_price, pr.price_basis,
         pk.sqft_per_box, pk.pieces_per_box
  FROM skus s
  JOIN products p ON p.id = s.product_id
  JOIN vendors v ON v.id = p.vendor_id
  LEFT JOIN categories c ON c.id = p.category_id
  LEFT JOIN pricing pr ON pr.sku_id = s.id
  LEFT JOIN packaging pk ON pk.sku_id = s.id
  WHERE s.sell_by = 'box'
    AND ( s.variant_type = 'mosaic'
          OR c.slug IN ('mosaic-tile','stacked-stone')
          OR p.name ILIKE '%mosaic%' )
  ORDER BY v.name, p.name, s.variant_name`;

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const PER_SQFT_BASES = new Set(['per_sqft', 'sqft', null]);

async function main() {
  const { rows } = await pool.query(SELECT);
  console.log(`${rows.length} box-sold mosaic/stacked-stone SKU(s) matched.\n`);
  if (!rows.length) { await pool.end(); return; }

  const convert = [];      // { sku_id, sheetSqft, newCost, newRetail, newSale }
  const ambiguous = [];    // can't derive sheet coverage
  const accessories = [];  // genuine trim pieces — leave alone

  for (const r of rows) {
    const isTrim = (r.accessory_label && r.accessory_label.trim())
      || isTrimPiece(`${r.product} ${r.variant_name || ''}`);
    if (isTrim) { accessories.push(r); continue; }
    const sheetSqft = deriveSheetSqft(r.sqft_per_box, r.pieces_per_box);
    if (!sheetSqft) { ambiguous.push(r); continue; }

    // Feeds always hand us per-sqft here; guard so an already-per-unit row
    // (retail already per sheet) is only re-flagged sell_by, never re-multiplied.
    const perSqft = PER_SQFT_BASES.has(r.price_basis);
    convert.push({
      ...r,
      sheetSqft,
      newCost: r.cost == null ? null : (perSqft ? round2(r.cost * sheetSqft) : round2(r.cost)),
      newRetail: r.retail_price == null ? null : (perSqft ? round2(r.retail_price * sheetSqft) : round2(r.retail_price)),
      newSale: r.sale_price == null ? null : (perSqft ? round2(r.sale_price * sheetSqft) : round2(r.sale_price)),
    });
  }

  // Per-vendor summary
  const byVendor = {};
  for (const r of convert) (byVendor[r.vendor] ??= { convert: 0, ambiguous: 0, accessory: 0 }).convert++;
  for (const r of ambiguous) (byVendor[r.vendor] ??= { convert: 0, ambiguous: 0, accessory: 0 }).ambiguous++;
  for (const r of accessories) (byVendor[r.vendor] ??= { convert: 0, ambiguous: 0, accessory: 0 }).accessory++;
  console.log('Vendor                      convert  ambiguous  accessory');
  console.log('─'.repeat(58));
  for (const [v, c] of Object.entries(byVendor).sort((a, b) => b[1].convert - a[1].convert))
    console.log(`${v.padEnd(26)}  ${String(c.convert).padStart(7)}  ${String(c.ambiguous).padStart(9)}  ${String(c.accessory).padStart(9)}`);
  console.log('─'.repeat(58));
  console.log(`${'TOTAL'.padEnd(26)}  ${String(convert.length).padStart(7)}  ${String(ambiguous.length).padStart(9)}  ${String(accessories.length).padStart(9)}\n`);

  console.log('Sample conversions:');
  for (const r of convert.slice(0, 8)) {
    console.log(`  [${r.vendor}] ${r.product} / ${r.variant_name || '—'}`);
    console.log(`     $${r.retail_price}/sqft × ${r.sheetSqft.toFixed(4)} sf/sheet = $${r.newRetail}/sheet  (cost $${r.cost}→$${r.newCost})`);
  }

  if (ambiguous.length) {
    console.log(`\n⚠  ${ambiguous.length} SKU(s) left as box (sheet coverage underivable — large box, no piece count):`);
    const ambByVendor = {};
    for (const r of ambiguous) (ambByVendor[r.vendor] ??= []).push(r);
    for (const [v, list] of Object.entries(ambByVendor))
      console.log(`     ${v}: ${list.length}  (e.g. "${list[0].product}" sqft_per_box=${list[0].sqft_per_box}, pieces=${list[0].pieces_per_box ?? 'null'})`);
    if (process.argv.includes('--csv')) {
      const csvPath = path.join(__dirname, '..', 'data', 'mosaic-per-sheet-ambiguous.csv');
      const header = 'vendor,category,product,variant,internal_sku,sqft_per_box,pieces_per_box,price_basis,retail_price\n';
      const body = ambiguous.map(r => [r.vendor, r.category, r.product, r.variant_name, r.internal_sku, r.sqft_per_box, r.pieces_per_box, r.price_basis, r.retail_price]
        .map(x => `"${String(x ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
      fs.writeFileSync(csvPath, header + body);
      console.log(`     → full list: ${csvPath}`);
    }
  }

  if (!APPLY) { console.log('\nDry-run. Re-run with --apply to write (add --csv to dump ambiguous rows).'); await pool.end(); return; }

  // Backup the exact before-state of the rows we're about to touch.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = path.join(__dirname, '..', 'data', `mosaic-per-sheet-backup-${stamp}.json`);
  fs.writeFileSync(backup, JSON.stringify(convert.map(r => ({
    sku_id: r.sku_id, internal_sku: r.internal_sku,
    old: { sell_by: 'box', price_basis: r.price_basis, cost: r.cost, retail_price: r.retail_price, sale_price: r.sale_price },
    new: { sell_by: 'unit', price_basis: 'per_unit', cost: r.newCost, retail_price: r.newRetail, sale_price: r.newSale },
  })), null, 2));
  console.log(`\nBackup → ${backup}`);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let n = 0;
    for (const r of convert) {
      await client.query(
        `UPDATE pricing SET cost = COALESCE($2, cost), retail_price = COALESCE($3, retail_price),
                            sale_price = $4, price_basis = 'per_unit'
         WHERE sku_id = $1`,
        [r.sku_id, r.newCost, r.newRetail, r.newSale]
      );
      await client.query(`UPDATE skus SET sell_by = 'unit', updated_at = NOW() WHERE id = $1`, [r.sku_id]);
      n++;
    }
    await client.query('COMMIT');
    console.log(`\n✔ Converted ${n} SKU(s) to per-sheet (sell_by=unit, price_basis=per_unit).`);
    console.log(`  ${ambiguous.length} ambiguous + ${accessories.length} accessory left unchanged.`);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
