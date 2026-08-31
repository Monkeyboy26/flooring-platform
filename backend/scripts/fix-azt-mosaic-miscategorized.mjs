#!/usr/bin/env node
/**
 * fix-azt-mosaic-miscategorized.mjs
 *
 * Arizona Tile piece-format products stuck in mosaic-tile. The AZ series pages
 * carry mesh-mount category tags describing their MOSAIC formats; the scraper's
 * format splitter separates those into "<Series> Mosaics" products, but the
 * leftover piece/field color products kept the series-level mosaic-tile win
 * (priority 85 beats the material tag). Verified against the live AZ WC tags and
 * backend/data/arizona/tile-prices.xlsx:
 *
 *   • Gem <color> (8) — "GEM <C> FLUTED 2X16 MESH", SHT $8.37 — fluted mesh
 *     sheets → fluted-tile. Pricing already per-sheet; backfill box packaging.
 *   • S-Series <color> 2x12 (6) — "S-<C> GLOSSY 2X12", SF $4.16, 0.1614 sf/pc —
 *     real glazed wall tile → backsplash-wall. Stored cost was the per-SF rate
 *     on a per_unit basis (a 2x12 piece billed as a full sqft) → box/per_sqft
 *     with the list's box packaging, like sibling Arte/Castle Brick.
 *   • Thin Brick Skyline (2x8) — kiln-fired brick veneer pieces (name matched
 *     the mosaic name-pattern) → backsplash-wall. Not in the current price
 *     list; pricing left untouched.
 *   • Atlantic Grey (4x16 Split + Modella mesh) — marble → natural-stone.
 *     4x16: "ATLANTIC GREY SPLIT 4X16", SF $10.47 was per-piece-converted →
 *     box/per_sqft (box packaging already right). Modella: SHT sheet, belongs
 *     with its sibling "Atlantic Grey Mosaics" product → reparent SKU.
 *   • Geo-Solid Square Frost (12x12 glass hex mesh, SHT) — genuinely a mosaic;
 *     NOT touched (listed here so nobody "fixes" it later).
 *
 * Scraper-side prevention ships separately in scrapers/arizona.js (default
 * format group demotion + modella→mosaic + wall sizes 2x8/2x12/2x16).
 *
 * Usage:
 *   node scripts/fix-azt-mosaic-miscategorized.mjs           # dry run
 *   node scripts/fix-azt-mosaic-miscategorized.mjs --apply   # write (with backup)
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

// Product-level category moves, keyed by product id (names for the log only).
const MOVES = [
  // Gem fluted 2x16 mesh colors → fluted-tile
  { id: '97105b8c-2579-4af8-b401-27b0a64b1a15', name: 'Gem Bianco', to: 'fluted-tile' },
  { id: '371a38d8-0e5b-4dee-a545-3cba02f4e351', name: 'Gem Cotto', to: 'fluted-tile' },
  { id: '0ec334a2-3a9b-4507-9130-813235dce5ee', name: 'Gem Grigio', to: 'fluted-tile' },
  { id: '4f1cd3bf-a295-4dbc-9dcb-a58b8b6131e4', name: 'Gem Notte', to: 'fluted-tile' },
  { id: 'aace4c1e-b1ac-4285-9d78-119458e5593c', name: 'Gem Salvia', to: 'fluted-tile' },
  { id: '07410910-f318-49a6-98ce-8119bebd991e', name: 'Gem Tabacco', to: 'fluted-tile' },
  { id: '022fb938-3c88-44d3-b967-919ee1839e99', name: 'Gem Verde', to: 'fluted-tile' },
  { id: '1392beb1-d23e-4109-a253-ab4f91b8a85c', name: 'Gem Vino', to: 'fluted-tile' },
  // S-Series 2x12 glossy wall tile colors → backsplash-wall
  { id: 'ce2c5f3a-2c49-4215-97a1-4b1946269028', name: 'S-Series Canvas White', to: 'backsplash-wall' },
  { id: '313b4646-18f3-4411-8ddb-fff0c90d14b4', name: 'S-Series Cloud Blue', to: 'backsplash-wall' },
  { id: 'f4ec7578-5576-405d-9963-2517b33e05b4', name: 'S-Series Gallery Grey', to: 'backsplash-wall' },
  { id: 'aec23f07-1b57-4ba2-bf98-06941df70b00', name: 'S-Series Halo Grey', to: 'backsplash-wall' },
  { id: 'c33a803e-3fb0-47cf-aca5-03c40a725c67', name: 'S-Series Soft Sage', to: 'backsplash-wall' },
  { id: '21084574-6c6c-4267-ae0d-6422e9c4cde0', name: 'S-Series Vintage Grey', to: 'backsplash-wall' },
  // Thin Brick Skyline 2x8 brick veneer → backsplash-wall
  { id: '5e6ddd65-1c63-496d-8d72-4537be87649b', name: 'Thin Brick Skyline', to: 'backsplash-wall' },
  // Atlantic Grey field product (4x16 Split marble) → natural-stone
  { id: 'ff4c3729-805d-4294-9e1a-723123697c08', name: 'Atlantic Grey', to: 'natural-stone' },
];

// SKU-level pricing/packaging repairs (values straight from tile-prices.xlsx).
// Gem: SHT unit/per_unit $8.37 already correct — packaging only.
const GEM_SKUS = ['333005', '333007', '333009', '333011', '333013', '333015', '333017', '333019'];
const SSERIES_2X12_SKUS = ['324810', '324838', '324856', '324859', '324863', '324868'];
const FIX = [
  ...GEM_SKUS.map(v => ({
    vendor_sku: v, sell_by: 'unit', price_basis: 'per_unit', cost: 8.37,
    sqft_per_box: 7.7472, pieces_per_box: 6, coveringFloor: true,
  })),
  ...SSERIES_2X12_SKUS.map(v => ({
    vendor_sku: v, sell_by: 'box', price_basis: 'per_sqft', cost: 4.16,
    sqft_per_box: 7.1016, pieces_per_box: 44, coveringFloor: true,
  })),
  { vendor_sku: '331247', sell_by: 'box', price_basis: 'per_sqft', cost: 10.47,
    sqft_per_box: 2.222, pieces_per_box: 5, coveringFloor: true },
];

// Atlantic Grey Modella mesh sheet → reparent to the sibling Mosaics product.
const REPARENT = [{
  vendor_sku: '331252',
  from: 'ff4c3729-805d-4294-9e1a-723123697c08',  // Atlantic Grey
  to: '058ead58-62b3-415b-948c-547b47d8db90',    // Atlantic Grey Mosaics
}];

async function main() {
  console.log(`\n=== AZT mosaic miscategorization fix (${APPLY ? 'APPLY' : 'DRY RUN'}) ===\n`);

  const { rows: catRows } = await pool.query(
    `SELECT id, slug FROM categories WHERE slug = ANY($1)`,
    [[...new Set(MOVES.map(m => m.to))]]);
  const catId = Object.fromEntries(catRows.map(r => [r.slug, r.id]));
  for (const slug of new Set(MOVES.map(m => m.to))) {
    if (!catId[slug]) throw new Error(`category ${slug} not found`);
  }

  const { rows: prodRows } = await pool.query(`
    SELECT p.id, p.name, p.collection, c.slug AS cat
    FROM products p LEFT JOIN categories c ON c.id = p.category_id
    WHERE p.id = ANY($1)`, [MOVES.map(m => m.id)]);
  const prodById = new Map(prodRows.map(r => [r.id, r]));

  const { rows: skuRows } = await pool.query(`
    SELECT s.id AS sku_id, s.vendor_sku, s.product_id, p.name, s.variant_name,
           s.sell_by, pr.price_basis, pr.cost, pr.retail_price, pk.sqft_per_box, pk.pieces_per_box
    FROM skus s JOIN products p ON p.id = s.product_id JOIN vendors v ON v.id = p.vendor_id
    LEFT JOIN pricing pr ON pr.sku_id = s.id LEFT JOIN packaging pk ON pk.sku_id = s.id
    WHERE v.code = 'AZT' AND s.vendor_sku = ANY($1)`,
    [FIX.map(f => f.vendor_sku).concat(REPARENT.map(r => r.vendor_sku))]);
  const skuByVendor = new Map(skuRows.map(r => [r.vendor_sku, r]));

  console.log('— product category moves —');
  const movePlan = [];
  for (const m of MOVES) {
    const cur = prodById.get(m.id);
    if (!cur) { console.log(`  ! product ${m.name} (${m.id}) not found — skipped`); continue; }
    if (cur.cat === m.to) { console.log(`  = ${cur.name} already ${m.to}`); continue; }
    movePlan.push({ ...m, cur });
    console.log(`  ${cur.name} [${cur.collection}]`.padEnd(45) + ` ${cur.cat} → ${m.to}`);
  }

  console.log('\n— SKU pricing/packaging —');
  const fixPlan = [];
  for (const f of FIX) {
    const cur = skuByVendor.get(f.vendor_sku);
    if (!cur) { console.log(`  ! vendor_sku ${f.vendor_sku} not found — skipped`); continue; }
    const retail = r2(f.cost * 1.6); // keystone; upsertPricing nine-ends + floors it
    fixPlan.push({ ...f, cur, retail });
    console.log(
      `  ${f.vendor_sku}  ${cur.name} — ${cur.variant_name}`.padEnd(60) +
      ` cost ${cur.cost}→${f.cost}  ${cur.sell_by}/${cur.price_basis}→${f.sell_by}/${f.price_basis}` +
      `  sfbx ${cur.sqft_per_box ?? '∅'}→${f.sqft_per_box}`);
  }

  console.log('\n— SKU reparent —');
  const reparentPlan = [];
  for (const r of REPARENT) {
    const cur = skuByVendor.get(r.vendor_sku);
    if (!cur) { console.log(`  ! vendor_sku ${r.vendor_sku} not found — skipped`); continue; }
    if (cur.product_id !== r.from) { console.log(`  = ${r.vendor_sku} already moved`); continue; }
    reparentPlan.push({ ...r, cur });
    console.log(`  ${r.vendor_sku}  ${cur.name} — ${cur.variant_name}  → Atlantic Grey Mosaics`);
  }

  if (!APPLY) {
    console.log(`\n${movePlan.length} moves, ${fixPlan.length} SKU fixes, ${reparentPlan.length} reparents planned. Dry run — re-run with --apply.`);
    await pool.end(); return;
  }

  const backupName = `azt-mosaic-miscat-backup-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
  let backupPath = path.join(__dirname, `../data/${backupName}`);
  const backupJson = JSON.stringify({
    products: movePlan.map(m => m.cur),
    skus: fixPlan.map(f => f.cur),
    reparents: reparentPlan.map(r => r.cur),
  }, null, 1);
  try { fs.writeFileSync(backupPath, backupJson); }
  catch { backupPath = path.join('/tmp', backupName); fs.writeFileSync(backupPath, backupJson); }
  console.log(`\nBackup: ${backupPath}`);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const m of movePlan) {
      await client.query('UPDATE products SET category_id=$2, updated_at=NOW() WHERE id=$1', [m.id, catId[m.to]]);
    }
    for (const f of fixPlan) {
      if (f.cur.sell_by !== f.sell_by) {
        await client.query('UPDATE skus SET sell_by=$2, updated_at=NOW() WHERE id=$1', [f.cur.sku_id, f.sell_by]);
      }
      await upsertPricing(client, f.cur.sku_id, {
        cost: f.cost, retail_price: f.retail, price_basis: f.price_basis, map_price: null,
      }, { coveringFloor: f.coveringFloor === true });
      await client.query(`
        INSERT INTO packaging (sku_id, sqft_per_box, pieces_per_box) VALUES ($1,$2,$3)
        ON CONFLICT (sku_id) DO UPDATE SET sqft_per_box=EXCLUDED.sqft_per_box, pieces_per_box=EXCLUDED.pieces_per_box
      `, [f.cur.sku_id, f.sqft_per_box, f.pieces_per_box]);
    }
    for (const r of reparentPlan) {
      await client.query('UPDATE skus SET product_id=$2, updated_at=NOW() WHERE id=$1', [r.cur.sku_id, r.to]);
    }
    await client.query('COMMIT');
    console.log(`Applied: ${movePlan.length} category moves, ${fixPlan.length} SKU fixes, ${reparentPlan.length} reparents.`);
  } catch (err) { await client.query('ROLLBACK'); throw err; }
  finally { client.release(); }
  await pool.end();
}
main().catch(err => { console.error(err); process.exit(1); });
