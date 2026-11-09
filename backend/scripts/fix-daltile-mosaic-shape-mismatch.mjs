#!/usr/bin/env node
// fix-daltile-mosaic-shape-mismatch.mjs
//
// Daltile's Coveo feed publishes ONE swatch per series+color (for Keystones:
// the 2x1 Oval mosaic silo) and the old importer attached it to every SKU of
// that color regardless of piece shape — so a 2x2 straight-joint, hexagon, or
// cove-base PDP shows an oval mosaic it doesn't sell. A few SKUs also got the
// oval as their PRIMARY (feed productimageurl color-fallback).
//
// This one-time cleanup (scraper now guards via mosaicShapeMismatch):
//   1. DELETEs swatch assets that are shape-mismatched mosaic silos.
//   2. REPLACEs mismatched primaries with the color's authoritative chip/render
//      from the Daltile product map (same 4-char color prefix), remote URL +
//      mirrored_at=NULL so mirror-images-backfill localizes it.
//
// Usage: node scripts/fix-daltile-mosaic-shape-mismatch.mjs [--apply]
// (default is dry-run)

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { mosaicShapeMismatch, mosaicImageShape, normalizeMapUrl, isPlaceholderUrl,
  vendorSkuShapeHints } = require('../scrapers/daltile-image-rank.cjs');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APPLY = process.argv.includes('--apply');

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: +(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

// Color-prefix → candidate URLs from the product map (for primary replacement)
function buildColorIndex() {
  const mapPath = path.join(__dirname, '..', 'data', 'daltile-product-map.json');
  const raw = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
  const flat = [];
  (function walk(o) {
    if (Array.isArray(o)) return o.forEach(walk);
    if (o && typeof o === 'object') {
      if (o.coveoSku) flat.push(o);
      else Object.values(o).forEach(walk);
    }
  })(raw);
  const byColor = new Map();
  for (const e of flat) {
    const prefix = (e.coveoSku || '').slice(0, 4).toUpperCase();
    if (!prefix) continue;
    if (!byColor.has(prefix)) byColor.set(prefix, new Set());
    for (const u of [e.productImageUrl, e.swatchUrl]) {
      const n = normalizeMapUrl(u);
      if (n && !isPlaceholderUrl(n)) byColor.get(prefix).add(n);
    }
  }
  return byColor;
}

// Keystones colors whose map entries are ALL oval silos (e.g. D335 Almond)
// still have a flat color chip in the DAM at a predictable path — derive it
// from the color name and HEAD-probe before trusting it.
const chipProbeCache = new Map();
async function keystonesChipUrl(f) {
  if (!/keystones/i.test(f.product_name)) return null;
  // Color: "Daltile Keystones Almond" → Almond; trims carry it in the variant
  // ("Almond, 1X1, Matte, Bullnose" → Almond).
  const color = /trim/i.test(f.product_name)
    ? (f.variant_name || '').split(',')[0].trim()
    : f.product_name.replace(/^.*keystones\s+/i, '').trim();
  const colorToken = color.replace(/[^a-z0-9]/gi, '');
  const prefix = (f.vendor_sku || '').slice(0, 4).toUpperCase();
  if (!colorToken || !/^D\d{3}$/.test(prefix)) return null;
  const url = `https://digitalassets.daltile.com/content/dam/Daltile/DAL_images/Keystones/DAL_${prefix}_2x2_${colorToken}.tif/jcr:content/renditions/cq5dam.web.1280.1280.jpeg`;
  if (chipProbeCache.has(url)) return chipProbeCache.get(url);
  let ok = false;
  try {
    const res = await fetch(url, { method: 'HEAD', headers: { 'User-Agent': 'Mozilla/5.0' } });
    ok = res.ok;
  } catch { ok = false; }
  chipProbeCache.set(url, ok ? url : null);
  return ok ? url : null;
}

async function main() {
  const { rows } = await pool.query(`
    SELECT ma.id AS ma_id, ma.asset_type, ma.url, ma.original_url, ma.sort_order,
           s.id AS sku_id, s.vendor_sku, s.variant_name, p.name AS product_name,
           COALESCE(sz.value, '') AS attr_size, COALESCE(sh.value, '') AS attr_shape
    FROM media_assets ma
    JOIN skus s ON s.id = ma.sku_id
    JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id
    LEFT JOIN LATERAL (
      SELECT sa.value FROM sku_attributes sa JOIN attributes a ON a.id = sa.attribute_id
      WHERE sa.sku_id = s.id AND a.slug = 'size' LIMIT 1) sz ON true
    LEFT JOIN LATERAL (
      SELECT sa.value FROM sku_attributes sa JOIN attributes a ON a.id = sa.attribute_id
      WHERE sa.sku_id = s.id AND a.slug = 'shape' LIMIT 1) sh ON true
    WHERE v.code = 'DAL' AND ma.asset_type IN ('swatch', 'primary')
      AND COALESCE(ma.original_url, ma.url) ~* 'msc'
  `);

  const flagged = [];
  for (const r of rows) {
    const url = r.original_url || r.url;
    const desc = [r.attr_size, r.attr_shape, r.variant_name, vendorSkuShapeHints(r.vendor_sku)]
      .filter(Boolean).join(' ');
    if (mosaicShapeMismatch(url, desc)) flagged.push({ ...r, desc, bad_url: url });
  }
  const swatches = flagged.filter((f) => f.asset_type === 'swatch');
  const primaries = flagged.filter((f) => f.asset_type === 'primary');
  console.log(`scanned=${rows.length} mismatched: swatch=${swatches.length} primary=${primaries.length}`);

  // Resolve primary replacements
  const colorIndex = buildColorIndex();
  for (const f of primaries) {
    const prefix = (f.vendor_sku || '').slice(0, 4).toUpperCase();
    const candidates = [...(colorIndex.get(prefix) || [])];
    // Prefer a shape-CORRECT mosaic render for this SKU. Else fall back to a
    // non-mosaic surface render / color chip — EXCEPT for pattern-layout
    // mosaics (straight joint, herringbone, …) where a field-tile render would
    // misrepresent the product worse than the same-color wrong-shape silo.
    const patternMosaic = /joint|herringbone|chevron|basketweave/i.test(f.desc) &&
      !/bullnose|cove|liner|corner|trim/i.test(f.desc + ' ' + f.product_name);
    f.replacement =
      candidates.find((u) => mosaicImageShape(u) && !mosaicShapeMismatch(u, f.desc)) ||
      (!patternMosaic ? candidates.find((u) => !mosaicImageShape(u)) : null) ||
      (!patternMosaic ? await keystonesChipUrl(f) : null) ||
      null;
  }

  for (const f of swatches) console.log(`  DEL swatch  ${f.vendor_sku}  ${f.desc}  ←  ${f.bad_url.split('/').pop()}`);
  for (const f of primaries) console.log(`  FIX primary ${f.vendor_sku}  ${f.desc}  →  ${f.replacement ? f.replacement.split('/').pop() : 'NO REPLACEMENT (left as-is)'}`);

  if (!APPLY) { console.log('\nDry run — pass --apply to execute.'); await pool.end(); return; }

  // Backup
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(__dirname, '..', 'data', `dal-mosaic-shape-mismatch-backup-${ts}.json`);
  fs.writeFileSync(backupPath, JSON.stringify(flagged, null, 2));
  console.log(`\nbackup → ${backupPath}`);

  let deleted = 0, replaced = 0, skipped = 0;
  for (const f of swatches) {
    await pool.query('DELETE FROM media_assets WHERE id = $1', [f.ma_id]);
    deleted++;
  }
  for (const f of primaries) {
    if (!f.replacement) { skipped++; continue; }
    await pool.query(
      `UPDATE media_assets SET url = $1, original_url = $1, source = 'shape-mismatch-fix',
         mirrored_at = NULL, mirror_bytes = NULL WHERE id = $2`,
      [f.replacement, f.ma_id]
    );
    replaced++;
  }
  console.log(`applied: swatches deleted=${deleted}, primaries replaced=${replaced}, primaries skipped=${skipped}`);
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
