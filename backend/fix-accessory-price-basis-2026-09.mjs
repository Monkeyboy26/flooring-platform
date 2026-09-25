#!/usr/bin/env node
// Accessory price-basis retag ([[cost-po-married-invariant]] gap 3).
//
// ~630 accessory SKUs (EMS 312 / GOT 193 / DAL 71 / MSI 25 / TW 18 / SIEN 9 /
// MLG 3, incl. inactive) carry per-PIECE cost+retail but price_basis='per_sqft'
// with sqft_per_box > 1 and sell_by='box'. Customers order these BY THE PIECE
// (accessory UI), so every basis-driven conversion then multiplies the piece cost
// by the box area: computePoLineCost overcosts vendor POs 11×–50× (RD-10032
// "Beautiful Sicily" was the first live hit) and the rep add-item path inflates
// the CUSTOMER subtotal the same way (unit_price × sqft_needed).
//
// Fix: set price_basis='per_unit' AND sell_by='unit' — exactly what the Emser
// Q1-2026 price-list import does when it matches a trim row (it flipped 278
// per_sqft/box trims to per_unit/unit from the dealer PDF's per-piece quotes;
// these leftovers are largely its trimUnmatched). Both fields must move together:
// basis alone fixes PO/cost math but leaves the storefront labeling a piece price
// "/sqft" (display keys on sell_by). Verified per-piece semantics per vendor:
// EMS trim (dealer PDF quotes PC), GOT mosaic sheets (per-sheet), DAL/AO Color
// Wheel-style trim, MSI ledger corners, SIEN bullnose/deco, MLG deco pieces,
// TW bullnose/cove/stair parts (all inactive).
//
// EXCLUDED: AZT — Arizona Tile price lists are genuinely SF/BX rate-based (the
// one candidate, Honey Tumbled "Lyon Pattern", is a field-tile pattern set whose
// $4.42 cost IS a per-sqft rate; retagging it would undercost POs 16×).
//
// Packaging is left alone: GOT's sqft_per_box=pieces_per_box is REAL (1-sqft
// mosaic sheets), indistinguishable from EMS's piece-count-stuffed area — and
// nothing prices off it once basis+sell_by are per-unit.
//
// Safety gate: a row is only retagged when NOT rate-like (cost × sqft_per_box <=
// retail would mean cost is a genuine area rate) — reported and skipped.
//
// Durability: scrapers used to re-clobber basis on every rescrape via
// upsertPricing's unconditional 'per_sqft' default — fixed in base.js (basis only
// updates when the caller explicitly sends one), shipped alongside this script.
//
//   node fix-accessory-price-basis-2026-09.mjs            # dry-run report
//   node fix-accessory-price-basis-2026-09.mjs --apply
// Reverse: restore price_basis/sell_by per sku_id from the backup JSON in
// backend/data/.

import fs from 'fs';
import { pool } from './db.js';

const APPLY = process.argv.includes('--apply');

const candidates = await pool.query(`
  SELECT s.id AS sku_id, s.internal_sku, s.status, s.sell_by, v.code AS vendor,
         p.name, s.variant_name, pr.price_basis, pr.cost, pr.retail_price,
         pk.sqft_per_box
  FROM skus s
  JOIN products p ON p.id = s.product_id
  JOIN vendors v ON v.id = p.vendor_id
  JOIN pricing pr ON pr.sku_id = s.id
  JOIN packaging pk ON pk.sku_id = s.id
  WHERE s.variant_type = 'accessory'
    AND pr.price_basis IN ('per_sqft', 'sqft')
    AND pk.sqft_per_box > 1
    AND v.code <> 'AZT'
  ORDER BY v.code, p.name, s.variant_name
`);

const retag = [];
const suspectRate = [];
for (const r of candidates.rows) {
  const cost = parseFloat(r.cost), retail = parseFloat(r.retail_price), spb = parseFloat(r.sqft_per_box);
  if (cost > 0 && retail > 0 && cost * spb <= retail) { suspectRate.push(r); continue; }
  retag.push(r);
}

const byVendor = {};
for (const r of retag) byVendor[r.vendor] = (byVendor[r.vendor] || 0) + 1;
console.log(`Candidates: ${candidates.rows.length} | retag -> per_unit/unit: ${retag.length} | rate-like skipped: ${suspectRate.length}`);
console.log('By vendor:', Object.entries(byVendor).sort((a, b) => b[1] - a[1]).map(([v, n]) => `${v} ${n}`).join(', '));
for (const r of retag.slice(0, 6)) console.log(`  [${r.vendor}] ${r.name} — ${r.variant_name || ''} (${r.sell_by}/${r.price_basis}, spb ${r.sqft_per_box}, cost ${r.cost}, retail ${r.retail_price})`);
if (retag.length > 6) console.log(`  ... and ${retag.length - 6} more`);
for (const r of suspectRate) console.log(`  SKIPPED rate-like: [${r.vendor}] ${r.name} — ${r.variant_name || ''} (cost ${r.cost} × spb ${r.sqft_per_box} <= retail ${r.retail_price})`);

if (!APPLY) {
  console.log('\nDry run — pass --apply to retag.');
} else {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `data/accessory-price-basis-backup-${stamp}.json`;
  fs.writeFileSync(backupPath, JSON.stringify(retag.map(r => ({
    sku_id: r.sku_id, internal_sku: r.internal_sku, vendor: r.vendor,
    previous_price_basis: r.price_basis, previous_sell_by: r.sell_by,
  })), null, 2));
  console.log(`\nBackup: backend/${backupPath}`);
  const ids = retag.map(r => r.sku_id);
  const pRes = await pool.query(
    `UPDATE pricing SET price_basis = 'per_unit' WHERE sku_id = ANY($1)`, [ids]);
  const sRes = await pool.query(
    `UPDATE skus SET sell_by = 'unit', updated_at = CURRENT_TIMESTAMP WHERE id = ANY($1)`, [ids]);
  console.log(`Retagged ${pRes.rowCount} pricing rows to per_unit, ${sRes.rowCount} skus to sell_by=unit.`);
}
await pool.end();
