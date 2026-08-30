#!/usr/bin/env node
/**
 * audit-carton-coverage.mjs  (READ ONLY — never writes)
 *
 * Scope check for the per-piece-leak bug (box coverage stored as one piece's
 * area instead of the full carton — Balboa Amber showed 0.987 sqft/box for a
 * 17-piece carton that covers 16.779). Run this against production FIRST to see
 * how many SKUs are affected, before applying fix-msi-carton-coverage.mjs.
 *
 * Two detectors:
 *   MSI          → compared against data/msi/carton-packaging.json (authoritative)
 *   all vendors  → name-parsed tile size; flags box SKUs (pieces > 1) whose
 *                  sqft_per_box ~= a single piece's area and is far below the
 *                  real carton (same logic as the carton-coverage-per-piece
 *                  quality rule). Mosaics/slabs excluded (name size ≠ face size).
 *
 * Usage:
 *   node scripts/audit-carton-coverage.mjs
 *   DATABASE_URL=postgresql://USER:PASS@HOST:5432/flooring_pim node scripts/audit-carton-coverage.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/flooring_pim',
});
const REF = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../data/msi/carton-packaging.json'), 'utf-8')
).items || {};

const CATS = ['porcelain-tile', 'ceramic-tile', 'wood-look-tile', 'large-format-tile',
  'backsplash-wall', 'engineered-hardwood', 'solid-hardwood', 'laminate', 'lvp-plank', 'lvt-tile'];

async function main() {
  console.log('\n=== Carton-coverage audit (READ ONLY) ===\n');

  // ── MSI: authoritative reference cross-check ──────────────────────────────
  const msi = await pool.query(`
    SELECT s.vendor_sku, p.name, s.variant_name, pk.sqft_per_box, pk.pieces_per_box
    FROM skus s JOIN products p ON p.id=s.product_id JOIN vendors v ON v.id=p.vendor_id
    JOIN packaging pk ON pk.sku_id=s.id
    WHERE v.code='MSI' AND s.status='active' AND s.sell_by='box'
      AND COALESCE(s.variant_type,'')<>'accessory' AND pk.sqft_per_box IS NOT NULL`);
  const msiHits = [];
  for (const r of msi.rows) {
    const ref = REF[(r.vendor_sku || '').toUpperCase()];
    if (!ref || !(ref.sqft_per_box > 0) || !(ref.pieces_per_box > 1)) continue;
    const our = parseFloat(r.sqft_per_box);
    if (!(our > 0) || Math.abs(our - ref.sqft_per_box) <= 0.05 * ref.sqft_per_box) continue;
    const perPiece = ref.sqft_per_piece != null
      && Math.abs(our - ref.sqft_per_piece) <= 0.02 * Math.max(1, ref.sqft_per_piece);
    msiHits.push({ vendor_sku: r.vendor_sku, name: `${r.name} ${r.variant_name || ''}`.trim(),
      our, ref: ref.sqft_per_box, kind: perPiece ? 'per-piece-leak' : 'coverage-mismatch' });
  }
  console.log(`MSI (vs carton-packaging.json): ${msiHits.length} mismatched of ${msi.rows.length} box SKUs`);
  msiHits.slice(0, 40).forEach(h => console.log(`  ${h.kind.padEnd(18)} ${h.vendor_sku.padEnd(22)} ${h.our}→${h.ref}  | ${h.name}`));
  if (msiHits.length > 40) console.log(`  … ${msiHits.length - 40} more`);

  // ── All vendors: name-parsed size heuristic ───────────────────────────────
  const all = await pool.query(`
    SELECT v.code AS vendor_code, s.vendor_sku, p.name, s.variant_name,
           pk.sqft_per_box AS sf, pk.pieces_per_box AS pcs,
           (regexp_match(s.variant_name,'([0-9]+(?:\\.[0-9]+)?)x([0-9]+(?:\\.[0-9]+)?)'))[1]::numeric AS w,
           (regexp_match(s.variant_name,'([0-9]+(?:\\.[0-9]+)?)x([0-9]+(?:\\.[0-9]+)?)'))[2]::numeric AS h
    FROM skus s JOIN products p ON p.id=s.product_id JOIN vendors v ON v.id=p.vendor_id
    JOIN categories c ON c.id=p.category_id
    LEFT JOIN packaging pk ON pk.sku_id=s.id
    WHERE s.status='active' AND p.status='active' AND s.is_sample IS NOT TRUE
      AND s.sell_by='box' AND pk.pieces_per_box > 1 AND pk.sqft_per_box > 0
      AND s.variant_type IS DISTINCT FROM 'accessory'
      AND c.slug = ANY($1) AND s.variant_name ~ '[0-9]+(\\.[0-9]+)?x[0-9]+'`, [CATS]);
  const byVendor = {};
  const heurHits = [];
  for (const r of all.rows) {
    const w = parseFloat(r.w), h = parseFloat(r.h), sf = parseFloat(r.sf), pcs = parseInt(r.pcs, 10);
    if (!(w >= 3 && w <= 63 && h >= 3 && h <= 63)) continue; // >63" = cm dims (e.g. WPT "22.5x119.5" = 9x48) or slab
    const pieceArea = w * h / 144, expected = pieceArea * pcs;
    if (Math.abs(sf - pieceArea) > 0.15 * pieceArea) continue;
    if (sf >= expected * 0.6) continue;
    byVendor[r.vendor_code] = (byVendor[r.vendor_code] || 0) + 1;
    heurHits.push({ vendor_code: r.vendor_code, vendor_sku: r.vendor_sku,
      name: `${r.name} ${r.variant_name || ''}`.trim(), sf, pcs, size: `${w}x${h}`, expected });
  }
  console.log(`\nAll vendors (name-size heuristic): ${heurHits.length} suspected of ${all.rows.length} multi-piece box SKUs`);
  console.log('  by vendor:', byVendor);
  heurHits.slice(0, 40).forEach(h =>
    console.log(`  ${h.vendor_code.padEnd(6)} ${h.vendor_sku.padEnd(22)} ${h.sf} sqft for ${h.pcs}×${h.size} → expect ~${h.expected.toFixed(2)}  | ${h.name}`));
  if (heurHits.length > 40) console.log(`  … ${heurHits.length - 40} more`);

  console.log('\n(Read-only. Fix MSI with: node scripts/fix-msi-carton-coverage.mjs --apply)');
  await pool.end();
}
main().catch(err => { console.error(err); process.exit(1); });
