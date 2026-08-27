#!/usr/bin/env node
/**
 * fix-msi-price-basis.mjs
 *
 * One-time backfill for the MSI price-basis ↔ selling-basis mismatch (2026-08).
 *
 * The 832 prices items on its own basis (usually SQFT) independent of how PO4
 * says they pack (EA/PC ⇒ sell_by 'unit'). The importer stored the SF rate as a
 * per-piece price: a 2-sqft Dymo tile sold below cost, a 0.12-sqft subway piece
 * sold at 8×. This script re-checks every active MSI SKU against the MSI price
 * list (which carries PRICE/UOM vs PRICE/EACH vs PRICE/BOX plus carton
 * packaging) and applies the same reconciliation now built into
 * scrapers/msi-unified.js:
 *
 *   A. unit-sold, SF-priced field/wall tile with known cartons → sell_by 'box'
 *      at the per-sqft price, real carton packaging
 *   B. unit-sold, SF-priced natural stone → keep the per-sqft RATE, flip
 *      price_basis to 'per_sqft' (platform per-piece stone model: piece price =
 *      rate × sqft_per_box)
 *   C. unit-sold, SF-priced per-sheet products (mosaic/stacked-stone) → convert
 *      dollars to per-piece (× piece sqft)
 *   D. unit-sold EA-priced backsplash with cartons → per-sqft + sell per box
 *   E. box-sold but EA-priced → convert dollars to per-sqft (÷ piece sqft)
 *   F. box-sold SKUs whose sqft_per_box holds the per-PIECE area → real carton
 *
 * Only rows whose stored cost matches the price list on the *wrong* basis are
 * touched — already-correct rows and rows with drifted prices are left alone.
 * Pricing writes go through upsertPricing (nine-ending, covering floor,
 * retail_locked respected).
 *
 * Usage:
 *   node scripts/fix-msi-price-basis.mjs --pricelist=/path/to/msi-pricelist.json          # dry run
 *   node scripts/fix-msi-price-basis.mjs --pricelist=/path/to/msi-pricelist.json --apply
 *
 * The pricelist JSON is an array of rows extracted from the MSI price list xlsb:
 *   { item, name, sqft_per_piece, pieces_per_box, sqft_per_box, uom, price_uom,
 *     price_each, price_box, status }
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';
import { upsertPricing, upsertPackaging, isTrimPiece } from '../scrapers/base.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APPLY = process.argv.includes('--apply');
const plArg = process.argv.find(a => a.startsWith('--pricelist='));
if (!plArg) { console.error('Missing --pricelist=/path/to/msi-pricelist.json'); process.exit(1); }

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/flooring_pim',
});

const priceList = new Map(
  JSON.parse(fs.readFileSync(plArg.split('=')[1], 'utf-8')).map(r => [String(r.item).toUpperCase(), r])
);

const close = (a, b, tol = 0.02) => {
  if (a == null || b == null) return false;
  const x = Number(a), y = Number(b);
  return Number.isFinite(x) && Number.isFinite(y) && Math.abs(x - y) <= tol * Math.max(1, Math.abs(y));
};
const r2 = v => Math.round(v * 100) / 100;
const r4 = v => Math.round(v * 10000) / 10000;

async function main() {
  console.log(`\n=== MSI price-basis backfill (${APPLY ? 'APPLY' : 'DRY RUN'}) ===\n`);

  const { rows } = await pool.query(`
    SELECT s.id AS sku_id, s.vendor_sku, s.sell_by, s.variant_name,
           p.name AS product_name, c.slug AS category,
           pr.cost, pr.retail_price, pr.price_basis, pr.retail_locked, pr.map_price,
           pk.sqft_per_box, pk.pieces_per_box
    FROM skus s
    JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id
    LEFT JOIN categories c ON c.id = p.category_id
    LEFT JOIN pricing pr ON pr.sku_id = s.id
    LEFT JOIN packaging pk ON pk.sku_id = s.id
    WHERE v.code = 'MSI' AND s.status = 'active'
      AND COALESCE(s.variant_type, '') <> 'accessory'`);

  const plan = [];
  for (const r of rows) {
    const pl = priceList.get((r.vendor_sku || '').toUpperCase());
    if (!pl || r.cost == null) continue;
    const cost = parseFloat(r.cost);
    const retail = r.retail_price != null ? parseFloat(r.retail_price) : null;
    if (!(cost > 0)) continue;
    const uom = String(pl.uom || '').toUpperCase();
    const spp = pl.sqft_per_piece || null;
    const carton = pl.pieces_per_box > 0 && pl.sqft_per_box > 0;
    const ourSpb = r.sqft_per_box != null ? parseFloat(r.sqft_per_box) : null;
    const name = `${r.product_name} ${r.variant_name || ''}`;
    const sheetItem = r.category === 'mosaic-tile' || r.category === 'stacked-stone' || /mosaic/i.test(name);
    const trim = isTrimPiece(name);
    const costIsUomRate = close(cost, pl.price_uom);
    const costIsEach = close(cost, pl.price_each);

    let action = null, next = null;
    if (r.sell_by === 'unit' && uom === 'SQFT' && costIsUomRate && !costIsEach && !trim) {
      if (r.category === 'natural-stone') {
        action = 'stone-basis';           // keep rate, flip basis, ensure piece area
        next = {
          price_basis: 'per_sqft',
          sqft_per_box: ourSpb || spp || null, pieces_per_box: r.pieces_per_box || 1,
        };
      } else if (!sheetItem && carton) {
        action = 'box-flip';              // sell cartons at the SF price
        next = {
          sell_by: 'box', price_basis: 'per_sqft',
          sqft_per_box: pl.sqft_per_box, pieces_per_box: pl.pieces_per_box,
        };
      } else if (spp) {
        action = 'per-piece-dollars';     // price the piece/sheet itself
        next = {
          cost: r2(cost * spp), retail_price: retail != null ? r2(retail * spp) : null,
          price_basis: 'per_unit', coveringFloor: sheetItem,
        };
      }
    } else if (r.sell_by === 'unit' && uom === 'EACH' && costIsUomRate
        && r.category === 'backsplash-wall' && !trim && carton && spp) {
      action = 'box-flip-ea';             // EA-priced backsplash → per-sqft cartons
      next = {
        sell_by: 'box', price_basis: 'per_sqft',
        cost: r4(cost / spp), retail_price: retail != null ? r2(retail / spp) : null,
        sqft_per_box: pl.sqft_per_box, pieces_per_box: pl.pieces_per_box,
      };
    } else if (r.sell_by === 'box' && uom === 'EACH' && costIsUomRate
        && spp && Math.abs(spp - 1) > 0.02) {
      action = 'ea-to-sqft';              // box-sold but piece-priced
      next = {
        cost: r4(cost / spp), retail_price: retail != null ? r2(retail / spp) : null,
        price_basis: 'per_sqft',
        sqft_per_box: carton ? pl.sqft_per_box : ourSpb, pieces_per_box: carton ? pl.pieces_per_box : r.pieces_per_box,
      };
    } else if (r.sell_by === 'box' && carton && ourSpb
        && Math.abs(ourSpb - pl.sqft_per_box) > 0.05 * pl.sqft_per_box) {
      action = 'packaging-only';          // per-piece area stored as carton coverage
      next = { sqft_per_box: pl.sqft_per_box, pieces_per_box: pl.pieces_per_box };
    }
    if (action) plan.push({ ...r, action, next, pl });
  }

  const byAction = {};
  for (const p of plan) byAction[p.action] = (byAction[p.action] || 0) + 1;
  console.log('Planned changes:', byAction, `(${plan.length} SKUs of ${rows.length} scanned)\n`);
  for (const p of plan) {
    console.log(
      `${p.action.padEnd(18)} ${String(p.vendor_sku).padEnd(24)} ${(p.category || '').padEnd(16)}` +
      ` cost ${p.cost}${p.next.cost != null ? '→' + p.next.cost : ''}` +
      ` retail ${p.retail_price}${p.next.retail_price != null ? '→' + p.next.retail_price : ''}` +
      `${p.next.sell_by ? ` sell_by ${p.sell_by}→${p.next.sell_by}` : ''}` +
      `${p.next.price_basis && p.next.price_basis !== p.price_basis ? ` basis ${p.price_basis}→${p.next.price_basis}` : ''}` +
      `${p.next.sqft_per_box != null && !close(p.sqft_per_box, p.next.sqft_per_box, 0.001) ? ` spb ${p.sqft_per_box}→${p.next.sqft_per_box}` : ''}` +
      `  | ${p.product_name} ${p.variant_name || ''}`
    );
  }

  if (!APPLY) { console.log('\nDry run — nothing written. Re-run with --apply.'); await pool.end(); return; }

  const backupName = `msi-price-basis-backup-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
  let backupPath = path.join(__dirname, `../data/${backupName}`);
  const backupJson = JSON.stringify(plan.map(({ pl, next, ...rest }) => rest), null, 1);
  try {
    fs.writeFileSync(backupPath, backupJson);
  } catch {
    backupPath = path.join('/tmp', backupName); // container's /app/data may be read-only for the app user
    fs.writeFileSync(backupPath, backupJson);
  }
  console.log(`\nBackup: ${backupPath}`);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const p of plan) {
      if (p.next.sell_by && p.next.sell_by !== p.sell_by) {
        await client.query('UPDATE skus SET sell_by = $2 WHERE id = $1', [p.sku_id, p.next.sell_by]);
      }
      if (p.next.price_basis || p.next.cost != null) {
        await upsertPricing(client, p.sku_id, {
          cost: p.next.cost != null ? p.next.cost : parseFloat(p.cost),
          retail_price: p.next.retail_price != null ? p.next.retail_price : (p.retail_price != null ? parseFloat(p.retail_price) : null),
          price_basis: p.next.price_basis || p.price_basis,
          map_price: null,
        }, { coveringFloor: p.next.coveringFloor === true });
      }
      if (p.next.sqft_per_box != null || p.next.pieces_per_box != null) {
        // upsertPackaging COALESCEs NULLs, but we need real overwrites here
        await client.query(`
          INSERT INTO packaging (sku_id, sqft_per_box, pieces_per_box)
          VALUES ($1, $2, $3)
          ON CONFLICT (sku_id) DO UPDATE SET
            sqft_per_box = COALESCE(EXCLUDED.sqft_per_box, packaging.sqft_per_box),
            pieces_per_box = COALESCE(EXCLUDED.pieces_per_box, packaging.pieces_per_box)
        `, [p.sku_id, p.next.sqft_per_box || null, p.next.pieces_per_box || null]);
      }
    }
    await client.query('COMMIT');
    console.log(`Applied ${plan.length} SKU fixes.`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
