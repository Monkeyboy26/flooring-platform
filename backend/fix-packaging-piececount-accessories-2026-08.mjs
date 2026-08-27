// Follow-up to the Daltile SlimLite fix (2026-08-26): two adjacent packaging
// bugs surfaced during that investigation.
//
// FIX A — undercounted pieces_per_box. Some field-tile / plank boxes carry
//   pieces_per_box=1 but a sqft_per_box that is a CLEAN integer multiple of the
//   single-piece face area (BED hardwood boxes of 5-6 planks, Daltile "Assemble"
//   boxes of 2 tiles, "Delegate" boxes of 10). The area is correct — the piece
//   COUNT is wrong. Set pieces_per_box = round(sqft_per_box / face_area). Only
//   applied when the multiple is clean (integer 2-30 within 8%), which is what
//   distinguishes a genuine multi-piece box from area corruption (SlimLite, whose
//   ratios were non-integer 40x). Excludes slabs/mosaics (size = thickness or
//   chip, not face) and accessories.
//
// FIX B — Daltile bath fittings mispriced as tile. "Bath Accessories" towel
//   bars / soap dishes / caddies are per-piece items (cost $4.25, retail $6.89)
//   but stored sell_by='box', price_basis='per_sqft', variant_type=blank, with a
//   junk sqft_per_box (12.5 etc) — the coverage calculator treats a towel bar as
//   12.5 sqft of tile. Convert to unit/per_unit accessories, clear the bogus
//   area/piece-count, and drop duplicate size tokens from the variant name.
//
//   node fix-packaging-piececount-accessories-2026-08.mjs --dry-run | --apply

import fs from 'fs';
import { pool } from './db.js';

const APPLY = process.argv.includes('--apply');
const backup = { fixA_piececount: [], fixB_bath: [] };

const PIECE_CATS = ['porcelain-tile', 'ceramic-tile', 'wood-look-tile', 'large-format-tile',
  'backsplash-wall', 'engineered-hardwood', 'solid-hardwood', 'laminate', 'lvp-plank', 'lvt-tile'];

// ── FIX A ──
const aCandidates = await pool.query(`
  SELECT s.id AS sku_id, s.internal_sku, v.code AS vendor, p.name, s.variant_name, pk.sqft_per_box AS sf,
    (regexp_match(s.variant_name,'([0-9]+(?:\\.[0-9]+)?)x([0-9]+(?:\\.[0-9]+)?)'))[1]::numeric AS w,
    (regexp_match(s.variant_name,'([0-9]+(?:\\.[0-9]+)?)x([0-9]+(?:\\.[0-9]+)?)'))[2]::numeric AS h
  FROM skus s JOIN products p ON p.id=s.product_id JOIN vendors v ON v.id=p.vendor_id
  LEFT JOIN categories c ON c.id=p.category_id JOIN packaging pk ON pk.sku_id=s.id
  WHERE s.status='active' AND p.status='active' AND s.is_sample IS NOT TRUE
    AND s.sell_by='box' AND pk.pieces_per_box=1 AND pk.sqft_per_box>0
    AND s.variant_type IS DISTINCT FROM 'accessory'
    AND s.variant_name ~ '[0-9]+(\\.[0-9]+)?x[0-9]+'
    AND c.slug = ANY($1)
`, [PIECE_CATS]);

const aUpdates = [];
for (const r of aCandidates.rows) {
  if (!r.w || !r.h || r.w < 3 || r.w > 130 || r.h < 3 || r.h > 130) continue;
  const pieceArea = r.w * r.h / 144;
  const sf = parseFloat(r.sf);
  if (sf < pieceArea * 1.8) continue;                 // ratio ~1 => already fine
  const pcs = Math.round(sf / pieceArea);
  if (pcs < 2 || pcs > 30) continue;
  if (Math.abs(sf - pcs * pieceArea) > sf * 0.08) continue; // not a clean multiple => area corrupt, leave it
  aUpdates.push({ sku_id: r.sku_id, vendor: r.vendor, name: r.name, size: `${r.w}x${r.h}`, sf, from_pcs: 1, to_pcs: pcs });
}
console.log(`FIX A (piece count): ${aUpdates.length} rows`);
for (const u of aUpdates.slice(0, 8)) console.log(`  [${u.vendor}] ${u.name} (${u.size}, ${u.sf}sf): 1 -> ${u.to_pcs} pcs/box`);
if (aUpdates.length > 8) console.log(`  ... and ${aUpdates.length - 8} more`);

// ── FIX B ──
const DIM_TOKEN = /^\s*\d+(\s+\d+\/\d+)?\s*[xX]\s*\d+(\s+\d+\/\d+)?\s*$/;
function dedupVariant(vn) {
  if (!vn) return vn;
  const parts = vn.split(',').map(t => t.trim()).filter(Boolean);
  const seen = new Set();
  const kept = [];
  for (const t of parts) {
    const key = t.toLowerCase().replace(/\s+/g, ' ');
    if (seen.has(key)) continue;         // exact duplicate token (case/space-insensitive)
    seen.add(key);
    kept.push(t);
  }
  return kept.join(', ');
}

const bRows = await pool.query(`
  SELECT s.id AS sku_id, s.internal_sku, p.name, s.variant_name, s.sell_by, s.variant_type,
         pr.price_basis, pr.retail_price, pk.sqft_per_box, pk.pieces_per_box
  FROM skus s JOIN products p ON p.id=s.product_id JOIN vendors v ON v.id=p.vendor_id
  LEFT JOIN categories c ON c.id=p.category_id LEFT JOIN pricing pr ON pr.sku_id=s.id LEFT JOIN packaging pk ON pk.sku_id=s.id
  WHERE v.code='DAL' AND c.slug='bath-accessories' AND s.status='active'
    AND (s.sell_by='box' OR pr.price_basis='per_sqft' OR s.variant_type IS DISTINCT FROM 'accessory')
`);
const bUpdates = bRows.rows.map(r => ({
  sku_id: r.sku_id, name: r.name,
  from: { sell_by: r.sell_by, price_basis: r.price_basis, variant_type: r.variant_type, sqft_per_box: r.sqft_per_box, variant_name: r.variant_name },
  new_variant: dedupVariant(r.variant_name),
}));
console.log(`\nFIX B (bath fittings -> unit accessories): ${bUpdates.length} rows`);
for (const u of bUpdates.slice(0, 6)) console.log(`  ${u.name}: "${u.from.variant_name}" -> "${u.new_variant}" | ${u.from.sell_by}/${u.from.price_basis} -> unit/per_unit, area cleared`);
if (bUpdates.length > 6) console.log(`  ... and ${bUpdates.length - 6} more`);

if (!APPLY) { console.log('\nDry-run. Re-run with --apply.'); await pool.end(); process.exit(0); }

backup.fixA_piececount = aUpdates;
backup.fixB_bath = bUpdates;
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
fs.writeFileSync(`./data/packaging-piececount-accessories-backup-${stamp}.json`, JSON.stringify(backup, null, 2));

for (const u of aUpdates) {
  await pool.query('UPDATE packaging SET pieces_per_box=$2 WHERE sku_id=$1', [u.sku_id, u.to_pcs]);
}
for (const u of bUpdates) {
  await pool.query(`UPDATE skus SET sell_by='unit', variant_type='accessory', variant_name=$2, updated_at=CURRENT_TIMESTAMP WHERE id=$1`, [u.sku_id, u.new_variant]);
  await pool.query(`UPDATE pricing SET price_basis='per_unit' WHERE sku_id=$1`, [u.sku_id]);
  await pool.query(`UPDATE packaging SET sqft_per_box=NULL, pieces_per_box=NULL WHERE sku_id=$1`, [u.sku_id]);
}
console.log(`\nApplied: ${aUpdates.length} piece-count, ${bUpdates.length} bath. Backup: ./data/packaging-piececount-accessories-backup-${stamp}.json`);
await pool.end();
