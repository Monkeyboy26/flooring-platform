/**
 * Fujiwa Tile — "field tile sold by the box, mosaic sold by the sheet"
 *
 * Owner rule (2026-09-06): within Fujiwa's Pool Tile line, the 6" field tiles
 * are sold by the BOX (per-sqft, buy whole boxes) and every mesh-mounted /
 * small-format item is a MOSAIC sold by the SHEET.
 *
 * Source of truth for the split is the price list's pcsPerUnit column
 * (see scripts/import-fujiwa.js): pcsPerUnit=4 = individual 6" field tiles;
 * pcsPerUnit=1 = mesh/sheet formats. That maps 1:1 onto the stored Size:
 *   FIELD (box) : "6", "6x6", "6x6 Glossy Solid"
 *   SHEET (mosaic): everything else — 1x1, 2x2, 3x3, 4x4, penny round,
 *                   hexagon, arabesque, random/pebble blends, glass,
 *                   6" Akron, 6 1/4x16, 6x13-3/4 Listello, 1&2 blends, …
 *
 * The platform models "sold by the sheet" the same way the catalog-wide
 * mosaic-per-sheet conversion did (and the 44 Fujiwa Watermark art mosaics
 * already are): sell_by='unit', price_basis='per_unit', the stored price is
 * the PER-SHEET total (per-sqft rate × sheet coverage), sqft_per_box retained
 * as the sheet coverage. Field tiles stay sell_by='box' / per_sqft and get
 * pieces_per_box filled (4 pcs/sqft) so the storefront labels them "box"
 * rather than falling through to the small-coverage "sheet" heuristic.
 *
 * Idempotent — reads current state, only writes rows that differ. Dry-run by
 * default; pass --apply to commit (writes a JSON backup first).
 *
 * Usage:
 *   node backend/scripts/fix-fujiwa-tile-mosaic-selling.mjs           # dry run
 *   node backend/scripts/fix-fujiwa-tile-mosaic-selling.mjs --apply   # commit
 */
import pg from 'pg';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const APPLY = process.argv.includes('--apply');
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

const VENDOR_ID = '8ec5135f-8ded-4818-925e-2ca70bef4c0a'; // Fujiwa Tile

// Non-tile accessories in the Pool Tile category — never touched here.
const ACCESSORY_PRODUCTS = ['Depth Markers', 'Hide 12" Skimmer Lid Kit', 'Pool Tile Trims', 'Pebblestone'];

// Field tile (sold by the box) sizes. Everything else in Pool Tile is a
// mesh/sheet mosaic. Normalized (lowercased, whitespace collapsed).
const FIELD_SIZES = new Set(['6', '6x6', '6x6 glossy solid']);

const RETAIL_MARKUP = 1.6;
const RETAIL_MIN_MARGIN = 0.99;
const round2 = (v) => Math.round(Number(v) * 100) / 100;
// Round DOWN to nearest .x9 (platform keystone rule, mirrors update-fujiwa).
const newNine = (v) => {
  const cents = Math.round(Number(v) * 100);
  const k = Math.floor((cents - 9) / 10);
  return Math.max(9, k * 10 + 9) / 100;
};
function priceRetail(cost, basis) {
  const base = cost * RETAIL_MARKUP;
  const coveringFloor = (basis === 'per_sqft' || basis === 'sqft');
  const floorMin = coveringFloor ? cost + RETAIL_MIN_MARGIN : 0;
  let nine = newNine(Math.max(base, floorMin));
  if (floorMin > 0 && nine < floorMin - 1e-9) nine = Math.round((nine + 0.10) * 100) / 100;
  return nine;
}
const normSize = (s) => String(s || '').toLowerCase().replace(/["″]/g, '').replace(/\s+/g, ' ').trim();

async function main() {
  const { rows } = await pool.query(`
    SELECT s.id, s.vendor_sku, s.variant_name, s.sell_by, p.name AS product_name,
           pr.cost, pr.retail_price, pr.price_basis, pr.retail_locked,
           pk.sqft_per_box, pk.pieces_per_box,
           (SELECT value FROM sku_attributes sa
              JOIN attributes a ON a.id = sa.attribute_id
             WHERE sa.sku_id = s.id AND a.slug = 'size' LIMIT 1) AS size
    FROM skus s
    JOIN products p ON p.id = s.product_id
    JOIN categories c ON c.id = p.category_id
    LEFT JOIN pricing pr ON pr.sku_id = s.id
    LEFT JOIN packaging pk ON pk.sku_id = s.id
    WHERE p.vendor_id = $1 AND c.name = 'Pool Tile'
      AND p.name <> ALL($2)
    ORDER BY s.vendor_sku
  `, [VENDOR_ID, ACCESSORY_PRODUCTS]);

  const backup = [];
  const toSheet = [];   // box/per_sqft -> unit/per_unit per-sheet
  const toBox = [];     // field tiles: ensure pieces_per_box so they read "box"
  const skippedLocked = [];
  const unclassified = []; // no size + no coverage — reported, untouched

  for (const s of rows) {
    const size = normSize(s.size) || normSize((s.variant_name || '').split(',')[0]);
    const sfbx = s.sqft_per_box != null ? Number(s.sqft_per_box) : null;
    const isField = FIELD_SIZES.has(size);

    if (isField) {
      // Keep by-the-box; fill pieces_per_box (4 pcs per sqft) if missing so the
      // storefront labels it "box" instead of the small-coverage "sheet".
      const wantPcs = sfbx > 0 ? Math.max(1, Math.round(4 * sfbx)) : 4;
      const needSellBy = s.sell_by !== 'box';
      const needBasis = s.price_basis && s.price_basis !== 'per_sqft';
      const needPcs = !(parseInt(s.pieces_per_box) > 0);
      if (needSellBy || needBasis || needPcs) {
        backup.push({ ...s });
        toBox.push({ id: s.id, vendor_sku: s.vendor_sku, size,
          sell_by: needSellBy ? 'box' : null,
          price_basis: needBasis ? 'per_sqft' : null,
          pieces_per_box: needPcs ? wantPcs : null });
      }
      continue;
    }

    // Mosaic / mesh sheet -> sold by the sheet.
    // Already-converted rows (unit/per_unit) store a PER-SHEET price; never
    // re-multiply them — keeps the script idempotent across re-runs.
    if (s.sell_by === 'unit' && s.price_basis === 'per_unit') continue;
    if (s.retail_locked) { skippedLocked.push(s.vendor_sku); continue; }
    if (!(sfbx > 0)) { unclassified.push(`${s.vendor_sku} (${size || 'no size'}, no coverage)`); continue; }

    const rate = Number(s.cost); // stored per-sqft cost rate
    const newCost = round2(rate * sfbx);
    const newRetail = priceRetail(newCost, 'per_unit');
    const changed = s.sell_by !== 'unit'
      || s.price_basis !== 'per_unit'
      || round2(s.cost) !== newCost
      || round2(s.retail_price) !== round2(newRetail);
    if (changed) {
      backup.push({ ...s });
      toSheet.push({ id: s.id, vendor_sku: s.vendor_sku, size, sfbx,
        oldCost: s.cost, newCost, oldRetail: s.retail_price, newRetail });
    }
  }

  console.log(`Fujiwa Pool Tile SKUs (excl. accessories): ${rows.length}`);
  console.log(`\n--- MOSAIC -> sheet (sell_by=unit, per_unit, per-sheet price): ${toSheet.length} ---`);
  for (const u of toSheet) {
    console.log(`  ${u.vendor_sku.padEnd(16)} ${String(u.size).padEnd(20)} `
      + `${u.sfbx}sf  cost ${String(u.oldCost).padStart(7)}->${String(u.newCost).padStart(7)}  `
      + `retail ${String(u.oldRetail).padStart(8)}->${String(u.newRetail).padStart(8)}`);
  }
  console.log(`\n--- FIELD TILE -> box label (ensure pieces_per_box): ${toBox.length} ---`);
  for (const u of toBox) {
    console.log(`  ${u.vendor_sku.padEnd(16)} ${String(u.size).padEnd(20)} `
      + `${[u.sell_by && 'sell_by=box', u.price_basis && 'basis=per_sqft',
           u.pieces_per_box && `pieces_per_box=${u.pieces_per_box}`].filter(Boolean).join(', ')}`);
  }
  if (skippedLocked.length) console.log(`\nSkipped (retail_locked): ${skippedLocked.join(', ')}`);
  if (unclassified.length) console.log(`\nUnclassified mosaics (left untouched): ${unclassified.join(', ')}`);

  if (!APPLY) {
    console.log('\nDRY RUN — re-run with --apply to commit.');
    await pool.end();
    return;
  }
  if (!toSheet.length && !toBox.length) {
    console.log('\nNothing to change.');
    await pool.end();
    return;
  }

  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const backupName = `fujiwa-tile-mosaic-selling-backup-${stamp}.json`;
  let backupPath = path.join(__dirname, '..', 'data', backupName);
  try { fs.writeFileSync(backupPath, JSON.stringify(backup, null, 2)); }
  catch { backupPath = path.join(os.tmpdir(), backupName); fs.writeFileSync(backupPath, JSON.stringify(backup, null, 2)); }
  console.log(`\nBackup written: ${backupPath}`);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const u of toSheet) {
      await client.query(`UPDATE skus SET sell_by = 'unit', updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [u.id]);
      await client.query(`UPDATE pricing SET cost = $2, retail_price = $3, price_basis = 'per_unit' WHERE sku_id = $1`,
        [u.id, u.newCost, u.newRetail]);
    }
    for (const u of toBox) {
      if (u.sell_by) await client.query(`UPDATE skus SET sell_by = 'box', updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [u.id]);
      if (u.price_basis) await client.query(`UPDATE pricing SET price_basis = 'per_sqft' WHERE sku_id = $1`, [u.id]);
      if (u.pieces_per_box) {
        await client.query(`
          INSERT INTO packaging (sku_id, pieces_per_box) VALUES ($1, $2)
          ON CONFLICT (sku_id) DO UPDATE SET pieces_per_box = EXCLUDED.pieces_per_box
        `, [u.id, u.pieces_per_box]);
      }
    }
    await client.query('COMMIT');
    console.log(`\nApplied: ${toSheet.length} mosaics -> sheet, ${toBox.length} field tiles -> box.`);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('ROLLED BACK:', e.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
