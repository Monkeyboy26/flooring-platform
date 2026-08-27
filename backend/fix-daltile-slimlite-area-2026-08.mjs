// Daltile SlimLite gauged-porcelain panels — corrupt sqft_per_box (2026-08-26).
//
// SlimLite ships ONE panel per box (pieces_per_box=1 across all 76 SKUs). Its
// 832 feed intermittently delivers a garbage surface-area per unit — within a
// single size, some colors carry the true panel area (39x118 -> 32.0 sqft) and
// others carry values up to 40x too large (1291.6). A corrupt row tells the
// storefront coverage calculator that one 32-sqft panel covers 1,291 sqft, so a
// buyer needing 100 sqft is quoted a single panel.
//
// Fix: sqft_per_box = panel face area (W x H / 144) from the size in the name.
// Bulletproof because pieces_per_box=1 and the size is the true face dimension
// (the already-correct rows equal exactly this). Scoped to the SlimLite line by
// name — NOT a blanket single-piece recompute, which would clobber multi-piece
// boxes miscounted as 1 (Daltile "Assemble"/"Delegate") where the area is right
// and the piece count is wrong. Those are reported separately, not touched here.
//
//   node fix-daltile-slimlite-area-2026-08.mjs --dry-run | --apply

import fs from 'fs';
import { pool } from './db.js';

const APPLY = process.argv.includes('--apply');

const { rows } = await pool.query(`
  SELECT s.id AS sku_id, s.internal_sku, p.name, s.variant_name,
         pk.sqft_per_box, pk.pieces_per_box,
         (regexp_match(s.variant_name, '([0-9]+)x([0-9]+)'))[1]::numeric AS w,
         (regexp_match(s.variant_name, '([0-9]+)x([0-9]+)'))[2]::numeric AS h
  FROM skus s
  JOIN products p ON p.id = s.product_id
  JOIN vendors v ON v.id = p.vendor_id
  JOIN packaging pk ON pk.sku_id = s.id
  WHERE v.code = 'DAL' AND p.name ILIKE '%SlimLite%' AND s.status = 'active'
    AND s.variant_name ~ '[0-9]+x[0-9]+'
`);

const updates = [];
let skipped = 0;
for (const r of rows) {
  // Safety: only single-panel boxes (all SlimLite are, but guard anyway).
  if (r.pieces_per_box !== 1 || !r.w || !r.h) { skipped++; continue; }
  const realSf = Math.round((r.w * r.h / 144) * 10000) / 10000;
  const cur = parseFloat(r.sqft_per_box);
  if (Math.abs(cur - realSf) < 0.01) { skipped++; continue; } // already correct
  updates.push({ sku_id: r.sku_id, name: r.name, size: `${r.w}x${r.h}`, from: cur, to: realSf });
}

console.log(`${rows.length} SlimLite panels; ${updates.length} corrupt sqft_per_box to fix, ${skipped} already correct/skipped`);
for (const u of updates.slice(0, 12)) console.log(`  ${u.name} (${u.size}): ${u.from} -> ${u.to} sqft`);
if (updates.length > 12) console.log(`  ... and ${updates.length - 12} more`);

if (!APPLY) { console.log('\nDry-run. Re-run with --apply.'); await pool.end(); process.exit(0); }

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
fs.writeFileSync(`./data/daltile-slimlite-area-backup-${stamp}.json`, JSON.stringify(updates, null, 2));
for (const u of updates) {
  await pool.query('UPDATE packaging SET sqft_per_box = $2 WHERE sku_id = $1', [u.sku_id, u.to]);
}
console.log(`Applied ${updates.length} updates. Backup: ./data/daltile-slimlite-area-backup-${stamp}.json`);
await pool.end();
