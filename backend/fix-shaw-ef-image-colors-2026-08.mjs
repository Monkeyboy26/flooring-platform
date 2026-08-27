// Shaw + EF carpet: wrong-color LIFESTYLE / SECONDARY (alternate) photos.
//
// Scope: asset_type IN ('lifestyle','alternate') ONLY. Primary swatches are left
// untouched — Shaw's Widen swatch files use a normalized "00"+last-3 color scheme
// that can't be safely reconciled from the URL, and primaries are never leaked
// across colors by the PDP anyway (only product-level LIFESTYLE is supplemented
// into a SKU's gallery — see /api/storefront/skus/:id media logic).
//
// The bug: the scrapers attach a SPECIFIC color's room scene at product level
// (sku_id NULL). The PDP then supplements those into every sparse SKU's gallery,
// so e.g. "Astounding I" shows a room scene of "Astounding III Endless Sea", and
// a beige carpet's page shows a burgundy room. Fix = route each color-specific
// image to the matching color SKU, or delete it when no color matches (the
// scrapers' own rule: no image > wrong image).
//
// URL color encodings handled:
//   EF cloudinary:   /v###/2565_Astounding_615_Endless_Sea_RS_x.jpg  → style 2565, color 615 (exact)
//   Shaw shawinc:    img.shawinc.com/v1/54256_56595/ROOM/...          → style 54256, color 56595 (exact)
//   Shaw widen main: /jpeg/e0552_00708_main                           → style e0552, color 00708 (exact)
//   Shaw widen media:/jpeg/MB372_00713.jpg                            → media code, color = last-3 (00713→713), NORMALIZED
//
// Normalized (Shaw media-code) colors are matched by last-3 digits within the
// SAME product only (the M-code is a reusable scene id, not a style ref) and only
// when that last-3 is unique in the product; otherwise the row is deleted.
//
//   node fix-shaw-ef-image-colors-2026-08.mjs --dry-run | --apply

import fs from 'fs';
import { pool } from './db.js';

const APPLY = process.argv.includes('--apply');

const media = (await pool.query(`
  SELECT ma.id, ma.product_id, ma.sku_id, ma.asset_type, ma.url, ma.sort_order,
         v.code AS vendor, p.name AS product_name, s.variant_name
  FROM media_assets ma
  JOIN products p ON p.id = ma.product_id
  JOIN vendors v ON v.id = p.vendor_id
  JOIN categories c ON c.id = p.category_id
  LEFT JOIN skus s ON s.id = ma.sku_id
  WHERE v.code IN ('SHAW','EF') AND c.slug = 'broadloom-carpet'
    AND ma.asset_type IN ('lifestyle','alternate')
`)).rows;

const skus = (await pool.query(`
  SELECT s.id, s.product_id, s.variant_name, s.status, v.code AS vendor, p.name AS product_name
  FROM skus s
  JOIN products p ON p.id = s.product_id
  JOIN vendors v ON v.id = p.vendor_id
  JOIN categories c ON c.id = p.category_id
  WHERE v.code IN ('SHAW','EF') AND c.slug = 'broadloom-carpet' AND s.is_sample = false
`)).rows;

const colorCode = (variant) => (String(variant || '').match(/([A-Za-z0-9]{3,5})\s*$/) || [])[1] || null;
// SKU color name = variant_name minus its trailing code ("Endless Sea 615" → "endless sea")
const colorName = (variant) => String(variant || '').replace(/\s*[A-Za-z0-9]{3,5}\s*$/, '').trim().toLowerCase();

// vendor|STYLECODE → product ids whose name ends with that style code
const styleToProducts = new Map();
// productId|COLOR → sku (active preferred)   (exact-color index)
const productColorToSku = new Map();
// productId|L3 → [skus]  (normalized last-3 index, for Shaw media-code files)
const productL3ToSkus = new Map();
// productId → [{name, sku}]  (color-name index, for EF room scenes with stale/repeated codes)
const productNames = new Map();
const productById = new Map();
for (const s of skus) {
  productById.set(s.product_id, s.product_name);
  const styleTok = (s.product_name.match(/(\S+)\s*$/) || [])[1];
  if (styleTok) {
    const k = s.vendor + '|' + styleTok.toUpperCase();
    if (!styleToProducts.has(k)) styleToProducts.set(k, new Set());
    styleToProducts.get(k).add(s.product_id);
  }
  const cc = colorCode(s.variant_name);
  if (cc) {
    const k = s.product_id + '|' + cc.toUpperCase();
    const prev = productColorToSku.get(k);
    if (!prev || (prev.status !== 'active' && s.status === 'active')) productColorToSku.set(k, s);
    const l3 = cc.slice(-3);
    const lk = s.product_id + '|' + l3;
    if (!productL3ToSkus.has(lk)) productL3ToSkus.set(lk, []);
    productL3ToSkus.get(lk).push(s);
  }
  const cn = colorName(s.variant_name);
  if (cn && cn.length >= 4) {
    if (!productNames.has(s.product_id)) productNames.set(s.product_id, []);
    productNames.get(s.product_id).push({ name: cn, sku: s });
  }
}

// ── URL parsers → { style, color, normalized } | null ───────────────────────
function parseEf(url) {
  const file = decodeURIComponent(url.split('/').pop() || '');
  // Trailing hash + variant markers (RS/V/_1) are noise; the rest holds style +
  // one or more numeric codes + the color name. Codes can repeat (style echoed),
  // so collect ALL of them and also keep the text blob for color-name matching.
  const style = (file.match(/^(\d{4})_/) || [])[1] || null;
  const codes = [...file.matchAll(/_(\d{2,4})(?=_)/g)].map(m => m[1]);
  const text = ' ' + file.toLowerCase().replace(/_/g, ' ') + ' ';
  if (!style && !codes.length) return null;
  return { style, codes, text, normalized: false, ef: true };
}
function parseShaw(url) {
  let m = url.match(/\/v1\/([A-Za-z0-9]+)_([A-Za-z0-9]{3,5})\//);   // img.shawinc.com exact
  if (m) return { style: m[1].toUpperCase(), color: m[2].toUpperCase(), normalized: false };
  m = url.match(/\/([A-Za-z0-9]{4,6})_(\d{3,5})_main\b/i);          // widen ..._main exact (style-prefixed)
  if (m) return { style: m[1].toUpperCase(), color: m[2].toUpperCase(), normalized: false };
  m = url.match(/\/(M[A-Za-z0-9]+)_(\d{5})\.(?:jpe?g|png|webp)/i);  // widen media code, normalized color
  if (m) return { style: null, color: m[2], normalized: true };
  return null;
}

// EF colors are stored un-padded ("Endless Sea 615"); Shaw padded ("Alabaster 00149")
const exactColorKeys = (vendor, color) => vendor === 'EF'
  ? [color.toUpperCase(), color.replace(/^0+/, '').toUpperCase()]
  : [color.toUpperCase()];

// Candidate products for a row: the attached product + any product whose name
// ends with a style code found in the URL (density-tier siblings share scenes)
function candidateProducts(vendor, productId, parsed) {
  const set = new Set([productId]);
  const styleCodes = parsed.ef ? [parsed.style, ...parsed.codes] : [parsed.style];
  for (const sc of styleCodes) {
    if (!sc) continue;
    const prods = styleToProducts.get(vendor + '|' + String(sc).toUpperCase());
    if (prods) for (const pid of prods) set.add(pid);
  }
  return [...set];
}

function findTarget(vendor, productId, parsed) {
  if (parsed.normalized) {
    // Shaw media-code file: last-3 color, SAME product only, must be unique
    const cands = productL3ToSkus.get(productId + '|' + parsed.color.slice(-3)) || [];
    const active = cands.filter(s => s.status === 'active');
    const pool_ = active.length ? active : cands;
    return pool_.length === 1 ? pool_[0] : null;
  }
  const prods = candidateProducts(vendor, productId, parsed);
  if (parsed.ef) {
    // EF: color code first (any numeric token), then color NAME substring match
    for (const pid of prods) {
      for (const code of parsed.codes) {
        for (const ck of exactColorKeys(vendor, code)) {
          const hit = productColorToSku.get(pid + '|' + ck);
          if (hit) return hit;
        }
      }
    }
    for (const pid of prods) {
      // longest names first so "Crystal Clear" wins over a stray "Clear"
      const names = (productNames.get(pid) || []).slice().sort((a, b) => b.name.length - a.name.length);
      for (const { name, sku } of names) {
        if (parsed.text.includes(' ' + name + ' ')) return sku;
      }
    }
    return null;
  }
  // Shaw exact formats
  for (const pid of prods) {
    for (const ck of exactColorKeys(vendor, parsed.color)) {
      const hit = productColorToSku.get(pid + '|' + ck);
      if (hit) return hit;
    }
  }
  return null;
}

// Does an already-attached SKU legitimately own this image?
function skuMatches(vendor, row, parsed) {
  if (parsed.normalized) {
    const cc = colorCode(row.variant_name);
    return cc && cc.slice(-3) === parsed.color.slice(-3);
  }
  if (parsed.ef) {
    const cc = colorCode(row.variant_name);
    if (cc && parsed.codes.some(code => exactColorKeys(vendor, code).map(x => x.toUpperCase()).includes(cc.toUpperCase()))) return true;
    const cn = colorName(row.variant_name);
    return !!(cn && cn.length >= 4 && parsed.text.includes(' ' + cn + ' '));
  }
  const cc = colorCode(row.variant_name);
  return !!(cc && exactColorKeys(vendor, parsed.color).includes(cc.toUpperCase()));
}

const moves = [];
const deletes = [];
let okCount = 0, genericCount = 0;

for (const row of media) {
  const parsed = row.vendor === 'EF' ? parseEf(row.url) : parseShaw(row.url);
  if (!parsed) { genericCount++; continue; }              // no color encoded — safe anywhere

  if (row.sku_id) {
    if (skuMatches(row.vendor, row, parsed)) { okCount++; continue; }
    const target = findTarget(row.vendor, row.product_id, parsed);
    if (target && target.id !== row.sku_id) moves.push({ row, target });
    else if (!target) deletes.push({ row, reason: 'sku-level color mismatch, no target' });
    else okCount++;
  } else {
    const target = findTarget(row.vendor, row.product_id, parsed);
    if (target) moves.push({ row, target });
    else deletes.push({ row, reason: 'product-level color-specific, no target' });
  }
}

console.log(`Rows scanned (lifestyle+alternate): ${media.length}`);
console.log(`  already correct:          ${okCount}`);
console.log(`  generic (no color code):  ${genericCount}`);
console.log(`  move to matching SKU:     ${moves.length}`);
console.log(`  delete (unmatchable):     ${deletes.length}`);

const tally = {};
for (const { row } of moves) { const k = `move ${row.vendor} ${row.asset_type} ${row.sku_id ? 'sku' : 'prod'}`; tally[k] = (tally[k]||0)+1; }
for (const { row } of deletes) { const k = `del  ${row.vendor} ${row.asset_type} ${row.sku_id ? 'sku' : 'prod'}`; tally[k] = (tally[k]||0)+1; }
console.log(tally);

console.log('\nSample moves:');
for (const { row, target } of moves.slice(0, 6))
  console.log(`  [${row.vendor}/${row.asset_type}/${row.sku_id?'sku':'prod'}] ${row.product_name}${row.variant_name?' / '+row.variant_name:''} → ${productById.get(target.product_id)} / ${target.variant_name}`);
console.log('\nSample deletes:');
for (const { row, reason } of deletes.slice(0, 6))
  console.log(`  [${row.vendor}/${row.asset_type}/${row.sku_id?'sku':'prod'}] ${row.product_name}${row.variant_name?' / '+row.variant_name:''} — ${reason}\n     ${row.url.slice(0,100)}`);

if (!APPLY) { console.log('\nDry-run. Re-run with --apply.'); await pool.end(); process.exit(0); }

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
fs.writeFileSync(new URL(`./data/shaw-ef-image-color-backup-${stamp}.json`, import.meta.url),
  JSON.stringify({ moves: moves.map(m => ({ ...m.row, target_sku_id: m.target.id })), deletes: deletes.map(d => ({ ...d.row, reason: d.reason })) }, null, 1));

let moved = 0, dupDropped = 0, dropped = 0;
for (const { row, target } of moves) {
  const dup = await pool.query(
    'SELECT 1 FROM media_assets WHERE sku_id = $1 AND url = $2 AND id != $3 LIMIT 1', [target.id, row.url, row.id]);
  if (dup.rows.length) { await pool.query('DELETE FROM media_assets WHERE id = $1', [row.id]); dupDropped++; continue; }
  const next = await pool.query(
    `SELECT COALESCE(MAX(sort_order), -1) + 1 AS so FROM media_assets WHERE product_id = $1 AND sku_id = $2 AND asset_type = $3`,
    [target.product_id, target.id, row.asset_type]);
  await pool.query('UPDATE media_assets SET sku_id = $1, sort_order = $2 WHERE id = $3', [target.id, next.rows[0].so, row.id]);
  moved++;
}
for (const { row } of deletes) { await pool.query('DELETE FROM media_assets WHERE id = $1', [row.id]); dropped++; }
console.log(`\nApplied: ${moved} moved, ${dupDropped} duplicates dropped, ${dropped} deleted. Backup: data/shaw-ef-image-color-backup-${stamp}.json`);
await pool.end();
