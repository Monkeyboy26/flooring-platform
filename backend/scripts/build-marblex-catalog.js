#!/usr/bin/env node
/**
 * Build Marblex Corp catalog.json + images.json.
 *
 * Marblex Corp (1415 S. Vernon St, Anaheim CA — marblexcorp.com) is a natural-stone +
 * porcelain distributor. Onboarded as its OWN vendor with a single house brand (Marblex).
 *
 * INPUT (backend/data/marblex/)
 *   sheet1-porcelain.csv  — porcelain tile / slab / paver / mosaic price list
 *       CODE, STOCK NAME, FINISH, PRICE PER SQ.FT, PRICE PER BOX/SLAB, SQ.FT PER BOX,
 *       PIECES PER BOX, COLLECTION (Series/MANUFACTURER), THICKNESS
 *   sheet2-stone.csv      — natural stone, SECTIONED (MARBLE / LIMESTONE / TRAVERTINE /
 *       QUARTZITE / GRANITE / DOLOMITE / NATURAL STONE MOSAICS / NATURAL STONE PATTERNS /
 *       MEDALLION / LINERS,BASEBOARDS,CHAIR RAILS,POOL COPINGS). Per section:
 *       SKU, Description, Size, Finish, Thickness, Price, Type
 *   wc-images-raw.json    — WooCommerce Store API dump [{sku, name, imgs[]}] (823 products),
 *                           keyed by the SAME Marblex code that our SKUs carry → exact match.
 *
 * MODEL (see [[line-item-display]] / [[selling-conventions]] / [[slab-size-entry]])
 *   Each color/stone name is ONE product; its size + finish rows become the product's SKUs.
 *   Slabs, mosaics, patterns, medallions and trim split into their OWN kind (never merged
 *   with field tile — avoids category clobber, cf. [[arizona-categorization]]).
 *     - porcelain field tile  → porcelain-tile,   sell_by box,  per_sqft (packaging)
 *     - porcelain slab (63x126)→ porcelain-slabs,  sell_by unit, per_sqft (area-less slab)
 *     - stone field tile       → natural-stone,    sell_by sqft, per_sqft
 *     - stone slab             → {granite/quartzite/marble}-countertops, unit, per_sqft
 *     - mosaic (porc + stone)  → mosaic-tile,      sell_by unit, per_unit (per sheet)
 *     - pattern                → natural-stone,    sell_by sqft, per_sqft
 *     - medallion              → mosaic-tile,      sell_by unit, per_unit (per piece)
 *     - paver                  → pavers,           box/sqft, per_sqft
 *     - trim (liner/coping/etc)→ trim-accessories, unit, per_unit, variant_type accessory,
 *                                LINKED to same-stone field SKUs via sku_accessories.
 *
 * PRICING: both price lists are Roma COST (wholesale); retail = cost x1.6 keystone (importer).
 * Rows with #N/A price import as draft (unpriced).
 *
 * Usage: node scripts/build-marblex-catalog.js
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(__dirname, '..', 'data', 'marblex');

// ---------- tiny CSV parser (quoted fields, "" escapes) ----------
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else {
      if (c === '"') q = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c === '\r') { /* skip */ }
      else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const money = (s) => {
  if (s == null) return null;
  const t = String(s).replace(/[$,\s]/g, '');
  if (!t || /n\/?a|#/i.test(t)) return null;
  const v = parseFloat(t);
  return Number.isFinite(v) ? v : null;
};
const numOrNull = (s) => { const v = parseFloat(String(s).replace(/[^\d.]/g, '')); return Number.isFinite(v) ? v : null; };
const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const titleCase = (s) => clean(s).toLowerCase().replace(/\b([a-z])/g, (m, c) => c.toUpperCase())
  .replace(/\b(Ce|R11|R10b|Aa|Cd|Lt)\b/gi, (m) => m.toUpperCase());

// ---------- size extraction ----------
const SIZE_RE = /(\d+(?:\s+\d+\/\d+)?(?:\.\d+)?)\s*[xX×]\s*(\d+(?:\.\d+)?)/;
function extractSize(name) {
  const m = name.match(SIZE_RE);
  if (!m) return null;
  return `${m[1].replace(/\s+/g, ' ').trim()}x${m[2]}`;
}
const nominalSize = (size) => {
  if (!size || /slab|pattern|approx|aprxmtly/i.test(size)) return null;
  const m = size.match(SIZE_RE);
  return m ? `${m[1].replace(/\s+/g, ' ').trim()}"x${m[2]}"` : null;
};

// ---------- finish normalization (uses explicit FINISH column) ----------
function normFinish(f) {
  const s = clean(f).toLowerCase();
  if (!s) return null;
  if (/honed\s*unfilled/.test(s)) return 'Honed (Unfilled)';
  if (/semi[\s-]?polish/.test(s)) return 'Semi-Polished';
  if (/polish/.test(s)) return 'Polished';
  if (/honed/.test(s)) return 'Honed';
  if (/matte|matt\b/.test(s)) return 'Matte';
  if (/velvet/.test(s)) return 'Velvet';
  if (/soft/.test(s)) return 'Soft';
  if (/brushed/.test(s)) return 'Brushed';
  if (/tumbled|antique/.test(s)) return 'Tumbled';
  if (/leather/.test(s)) return 'Leathered';
  if (/deep[\s-]?tek/.test(s)) return 'Deep-Tek';
  if (/strong.*r11|r11.*strong|grip.*r11|r11/.test(s)) return 'R11 (Grip)';
  if (/strong/.test(s)) return 'R11 (Grip)';
  if (/grip/.test(s)) return 'Grip';
  return titleCase(f);
}

// ---------- thickness normalization ----------
function normThickness(t) {
  const s = clean(t);
  if (!s) return null;
  const mm = s.match(/([\d.]+)\s*mm/i);
  if (mm) return `${mm[1]}mm`;
  const frac = s.match(/(\d+\s+\d+\/\d+|\d+\/\d+|\d+)\s*(?:"|”|''|in)?/);
  if (frac) return frac[1].replace(/\s+/g, ' ') + '"';
  return s;
}

// ---------- look / material family ----------
function lookFor(name, material) {
  const s = name.toLowerCase();
  if (/wood|bamboo|greenwood/.test(s)) return 'Wood';
  if (/cement|cemento|concrete|beton|buildtech|stonetech|encode/.test(s)) return 'Concrete';
  if (/travertin|slate|rustic|cotto|volcano|terracreta|argilla/.test(s)) return 'Stone';
  if (material === 'Marble' || material === 'Dolomite') return 'Marble';
  if (/calacatta|carrara|statuario|marble|marmi|marmoles|onyx|dolomite/.test(s)) return 'Marble';
  return null;
}

// ---------- shape / pattern from name ----------
function shapeFor(name) {
  const s = name.toLowerCase();
  if (/hexagon|\bhex\b/.test(s)) return 'Hexagon';
  if (/lantern/.test(s)) return 'Lantern';
  if (/herringbone/.test(s)) return 'Herringbone';
  if (/basket\s*weave|basketweave/.test(s)) return 'Basketweave';
  if (/chevron/.test(s)) return 'Chevron';
  if (/penny\s*round|pennyround/.test(s)) return 'Penny Round';
  if (/pinwheel/.test(s)) return 'Pinwheel';
  if (/octagon/.test(s)) return 'Octagon';
  if (/picket/.test(s)) return 'Picket';
  if (/subway/.test(s)) return 'Subway';
  return null;
}

// ================= PARSE SHEET 1 (porcelain) =================
function parsePorcelain() {
  const rows = parseCSV(fs.readFileSync(path.join(DIR, 'sheet1-porcelain.csv'), 'utf8'));
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || !clean(r[0])) continue;
    const [code, stockName, finishRaw, ppsf, ppbox, sqftBox, pcsBox, collectionRaw, thicknessRaw] = r;
    if (!clean(stockName)) continue;
    const name = clean(stockName);

    // collection: "Antique Marble Series/FLORIM"  ·  "Volcano Series (Rondine)"  ·
    //             "Florim Marble Slabs, Florim Porcelain Slabs"
    let series = clean(collectionRaw), manufacturer = null;
    const slash = series.lastIndexOf('/');
    if (slash >= 0) { manufacturer = titleCase(series.slice(slash + 1).replace(/[()]/g, '')); series = clean(series.slice(0, slash)); }
    const paren = series.match(/\(([^)]+)\)/);
    if (paren) { manufacturer = manufacturer || titleCase(paren[1]); series = clean(series.replace(/\([^)]*\)/, '')); }
    series = clean(series.replace(/\s*series\s*$/i, '')) || series;

    // kind
    const isSlab = /porcelain\s+slab/i.test(name) || (/slab/i.test(name) && !sqftBox);
    const isPaver = /paver/i.test(name) || /^20\s*mm$/i.test(clean(thicknessRaw));
    const isMosaic = /mosaic|mosaico/i.test(name);
    const kind = isSlab ? 'slab' : isPaver ? 'paver' : isMosaic ? 'mosaic' : 'field';

    // All porcelain slabs are Florim 63x126 gauged panels — group under one clean collection
    // (the Marble/Color/Cement/Stone look-family from the sheet is kept as the `look` attr).
    if (kind === 'slab') { manufacturer = 'Florim'; series = 'Florim Porcelain Slabs'; }

    out.push({
      source: 'porcelain', code: clean(code), name, material: 'Porcelain', kind,
      series, manufacturer,
      size: extractSize(name),
      finish: normFinish(finishRaw),
      thickness: normThickness(thicknessRaw),
      cost: money(isSlab ? ppsf : ppsf),   // both columns: per-sqft price is authoritative
      cost_box: money(ppbox),
      sqft_box: numOrNull(sqftBox), pcs_box: numOrNull(pcsBox),
    });
  }
  return out;
}

// ================= PARSE SHEET 2 (natural stone) =================
const SECTIONS = {
  'MARBLE': 'Marble', 'LIMESTONE': 'Limestone', 'TRAVERTINE': 'Travertine',
  'QUARTZITE': 'Quartzite', 'GRANITE': 'Granite', 'DOLOMITE': 'Dolomite',
  'NATURAL STONE MOSAICS': 'MOSAIC', 'NATURAL STONE PATTERNS': 'PATTERN',
  'MEDALLION': 'MEDALLION', 'LINERS, BASEBOARDS, CHAIR RAILS, POOL COPINGS': 'TRIM',
};
function stoneMaterialFrom(desc, fallback) {
  const s = desc.toLowerCase();
  if (/travertine/.test(s)) return 'Travertine';
  if (/limestone/.test(s)) return 'Limestone';
  if (/dolomite/.test(s)) return 'Dolomite';
  if (/granite/.test(s)) return 'Granite';
  if (/quartzite/.test(s)) return 'Quartzite';
  if (/marble/.test(s)) return 'Marble';
  return fallback;
}
function parseStone() {
  const rows = parseCSV(fs.readFileSync(path.join(DIR, 'sheet2-stone.csv'), 'utf8'));
  const out = [];
  let sectionMat = null, mode = null;   // mode: field material name OR MOSAIC/PATTERN/MEDALLION/TRIM
  for (const r of rows) {
    const c0 = clean(r[0]);
    if (!c0 && !clean(r[1])) continue;
    if (c0 === 'SKU') continue;                          // per-section header
    if (SECTIONS[c0] && !clean(r[1])) {                  // section banner (only col0 filled)
      const v = SECTIONS[c0];
      if (['MOSAIC', 'PATTERN', 'MEDALLION', 'TRIM'].includes(v)) { mode = v; sectionMat = null; }
      else { mode = 'field'; sectionMat = v; }
      continue;
    }
    const [sku, desc, sizeRaw, finishRaw, thickRaw, priceRaw, typeRaw] = r;
    if (!clean(sku) || !clean(desc)) continue;
    const description = clean(desc);
    const type = clean(typeRaw).toLowerCase();
    const material = stoneMaterialFrom(description, sectionMat || 'Marble');

    // resolve kind (Type column is unreliable inside the TRIM section → use mode/description)
    let kind;
    if (mode === 'TRIM' || /liner|chair rail|baseboard|pool coping|pencil|dome|rope/i.test(description) && mode !== 'field' && mode !== 'MOSAIC') kind = 'trim';
    else if (mode === 'MOSAIC' || type === 'mosaic') kind = 'mosaic';
    else if (mode === 'PATTERN' || type === 'pattern') kind = 'pattern';
    else if (mode === 'MEDALLION' || type === 'medallion') kind = 'medallion';
    else if (type === 'slab' || /slab/i.test(sizeRaw)) kind = 'slab';
    else if (type === 'paver' || /paver/i.test(description)) kind = 'paver';
    else kind = 'field';                                 // Tile, Subway tile

    out.push({
      source: 'stone', code: clean(sku), name: titleCase(description), rawName: description,
      material, kind, series: null, manufacturer: null,
      size: /slab|pattern|approx|aprxmtly/i.test(clean(sizeRaw)) ? null : (extractSize(sizeRaw) || extractSize(description)),
      sizeLabel: clean(sizeRaw),
      finish: normFinish(finishRaw),
      thickness: normThickness(thickRaw),
      cost: money(priceRaw), cost_box: null,
      sqft_box: null, pcs_box: null,
      typeWord: clean(typeRaw),
    });
  }
  return out;
}

// ================= GROUPING KEY (strip finish/size/format words, keep color+grade+pattern) =================
const STRIP = [
  // material / format / type words
  'porcelain', 'tile', 'slab', 'slabs', 'marble', 'marbleslab', 'granite', 'quartzite',
  'limestone', 'travertine', 'dolomite', 'stone', 'paver', 'subway', 'mosaic', 'mosaico',
  'pattern', 'continuous', 'medallion', 'italian',
  // finish / surface / treatment
  'honed', 'polished', 'polish', 'matte', 'matt', 'velvet', 'soft', 'brushed', 'tumbled',
  'antique', 'leathered', 'leather', 'grip', 'strong', 'semi', 'unfilled', 'filled',
  'brillo', 'glossy', 'gloss', 'lappato', 'reliave',
  // cut / edge
  'cross', 'cut', 'vein', 'deep', 'micro', 'beveled', 'bevel', 'chiseled', 'chisel', 'split',
  'face', 'splitface', 'straight', 'edge', 'select', 'square', 'strip', 'random',
  // decor/shape (kept OUT of key so honed/polished + shapes of same base can still be separate
  // products via kind='mosaic' where the shape lives in the display name, not the key)
  'r11', 'r10b', 'ce', 'mm', 'cm', 'ee', 'aa', 'cd', 'x',
];
const STRIP_SET = new Set(STRIP);
function keyWords(s) {
  return s.toLowerCase()
    .replace(/&#\d+;/g, ' ').replace(/[–—”"'()|.,]/g, ' ')
    .replace(/\b\d+(?:\s+\d+\/\d+)?(?:\.\d+)?\s*[x×]\s*\d+(?:\.\d+)?\b/g, ' ')  // sizes
    .replace(/\b\d+(?:\.\d+)?\s*mm\b/gi, ' ').replace(/\b\d+\/\d+\b/g, ' ')
    .replace(/\bgray\b/g, 'grey')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\b\d+(\.\d+)?\b/g, ' ')
    .split(/\s+/).filter(Boolean);
}
const baseKey = (s) => keyWords(s).filter((w) => !STRIP_SET.has(w)).join(' ').trim();

// display base name: strip trailing/という noise, keep grade + color + pattern words
function displayBase(row) {
  let n = row.name;
  // remove leading manufacturer echo for stone? keep. Remove size + material/format words for display.
  n = n.replace(SIZE_RE, ' ')
       .replace(/\b(Porcelain|Marble|Granite|Quartzite|Limestone|Travertine|Dolomite)\s+(Tile|Slab|Slabs|Paver|Pattern|Mosaic)\b/gi, ' ')
       .replace(/\b(Porcelain|Marble|Granite|Quartzite|Limestone|Travertine|Dolomite)\b/gi, ' ')
       .replace(/\bMarbleslab\b/gi, ' ')
       .replace(/\b(Tile|Slab|Slabs|Paver|Pattern|Mosaic|Mosaico|Subway)\b/gi, ' ')
       .replace(/\|\s*\d+\s*mm/gi, ' ').replace(/\(\d+x\d+\s*cm\)/gi, ' ')
       .replace(/\bR1[01]B?\b/gi, ' ').replace(/\(CE\)/gi, ' ').replace(/\bFinish\b/gi, ' ')
       .replace(/\b\d+(?:\.\d+)?\s*mm\b/gi, ' ')
       .replace(/\b\d+\s+\d+\/\d+\b/g, ' ').replace(/\b\d+\/\d+\b/g, ' ');
  // strip finish words for field/slab display base (finish becomes a pill); keep for mosaics? keep pattern
  const finRe = /\b(Honed|Polished|Polish|Matte|Matt|Velvet|Soft|Brushed|Tumbled|Antique|Leathered|Leather|Strong|Grip|Semi[\s-]?Polished|Unfilled|Filled|Deep[\s-]?Tek|Brillo|Glossy|Gloss|Lappato)\b/gi;
  n = n.replace(finRe, ' ');
  n = clean(n).replace(/\s{2,}/g, ' ').replace(/[\s\-|]+$/,'').replace(/^[\s\-|]+/,'');
  return titleCase(n) || row.name;
}

// mosaic / medallion display keep the shape/pattern for a distinct product name
function mosaicBase(row) {
  let n = row.name
    .replace(SIZE_RE, ' ')
    .replace(/\b(Marble|Travertine|Limestone|Porcelain)\b/gi, ' ')
    .replace(/\bMosaic\b/gi, ' ')
    .replace(/\b(Honed|Polished|Polish|Tumbled|Antique|Brushed|Matte)\b/gi, ' ')
    .replace(/\bTile\b/gi, ' ');
  return clean(titleCase(n)) || row.name;
}

// ================= ACCESSORY (trim) label =================
function trimLabel(row) {
  const s = row.name.toLowerCase();
  let kind = 'Trim';
  if (/pool coping|coping/.test(s)) kind = 'Pool Coping';
  else if (/pencil liner/.test(s)) kind = 'Pencil Liner';
  else if (/dome liner/.test(s)) kind = 'Dome Liner';
  else if (/rope liner/.test(s)) kind = 'Rope Liner';
  else if (/l-?cap/.test(s)) kind = 'L-Cap Liner';
  else if (/deco liner/.test(s)) kind = 'Deco Liner';
  else if (/baseboard/.test(s)) kind = 'Baseboard';
  else if (/chair rail/.test(s)) kind = 'Chair Rail';
  else if (/liner/.test(s)) kind = 'Liner';
  const sz = row.sizeLabel && !/slab|pattern/i.test(row.sizeLabel) ? row.sizeLabel : row.size;
  return sz ? `${kind} (${sz})` : kind;
}
// stone base for trim (to link to matching field product): strip trim/finish/size words
function trimStoneKey(row) {
  const n = row.name
    .replace(/\b(pencil|dome|rope|deco|l-?cap|chair rail|baseboard|liner|coping|pool)\b/gi, ' ')
    .replace(/\b(marble|travertine|limestone)\b/gi, ' ');
  return baseKey(n);
}

// ================= CATEGORY =================
function categoryFor(row) {
  const { material, kind } = row;
  if (kind === 'trim') return 'trim-accessories';
  if (kind === 'medallion') return 'mosaic-tile';
  if (kind === 'mosaic') return 'mosaic-tile';
  if (kind === 'paver') return 'pavers';
  if (kind === 'slab') {
    if (material === 'Porcelain') return 'porcelain-slabs';
    if (material === 'Granite') return 'granite-countertops';
    if (material === 'Quartzite') return 'quartzite-countertops';
    return 'marble-countertops';               // marble / travertine / limestone / dolomite
  }
  // field tile / pattern
  if (material === 'Porcelain') return 'porcelain-tile';
  return 'natural-stone';
}

// ================= SELL BY / PRICE BASIS =================
function sellSpec(row) {
  if (row.kind === 'trim' || row.kind === 'medallion' || row.kind === 'mosaic')
    return { sell_by: 'unit', price_basis: 'per_unit' };
  if (row.kind === 'slab')
    return { sell_by: 'unit', price_basis: 'per_sqft' };   // area-less slab edge case → /sqft + rep size entry
  if (row.kind === 'paver')
    return { sell_by: row.sqft_box ? 'box' : 'sqft', price_basis: 'per_sqft' };
  // field tile / pattern
  if (row.material === 'Porcelain' && row.sqft_box) return { sell_by: 'box', price_basis: 'per_sqft' };
  return { sell_by: 'sqft', price_basis: 'per_sqft' };
}

// ================= BUILD PRODUCTS =================
const usedInternal = new Set();
function mkPkey(base, extra) {
  let s = 'MX-' + `${base} ${extra || ''}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  let cand = s, i = 2;
  while (usedInternal.has(cand)) cand = `${s}-${i++}`;
  usedInternal.add(cand);
  return cand;
}

function variantName(row) {
  if (row.kind === 'trim') return [trimLabel(row), row.finish].filter(Boolean).join(' · ');
  if (row.kind === 'medallion') return [nominalSize(row.size) || row.sizeLabel, row.finish].filter(Boolean).join(' · ');
  const bits = [];
  const ns = nominalSize(row.size);
  if (ns) bits.push(ns);
  // surface/cut treatment descriptor (kept on the SKU so it stays distinct)
  const treat = (row.name.match(/\b(Cross Cut|Vein Cut|Deep Beveled|Micro Beveled|Beveled|Chiseled|Split ?Face|Straight Edge|Unfilled|Filled|Basketweave|Herringbone|Hexagon|Lantern|Chevron|Pinwheel|Octagon|Penny ?Round|Picket)\b/i) || [])[0];
  if (treat && row.kind !== 'field') bits.push(titleCase(treat));
  if (row.finish) bits.push(row.finish);
  if (!bits.length) bits.push(row.finish || 'Standard');
  return [...new Set(bits)].join(' · ');
}

function buildProducts(rows) {
  // bucket: kind family
  const groups = new Map();   // groupKey -> { rows, kind, material, series }
  for (const r of rows) {
    if (!r.code) continue;
    let gk;
    if (r.kind === 'mosaic' || r.kind === 'medallion') gk = `${r.kind}|${mosaicBase(r).toLowerCase()}`;
    else if (r.kind === 'trim') gk = `trim|${r.material}|${trimStoneKey(r) || r.code}`;
    else {
      const bk = baseKey(r.name) || r.code.toLowerCase();
      gk = `${r.source}|${r.kind}|${r.material}|${r.series || ''}|${bk}`;
    }
    if (!groups.has(gk)) groups.set(gk, []);
    groups.get(gk).push(r);
  }

  const products = [];
  for (const [gk, members] of groups) {
    const rep = members[0];
    const kind = rep.kind;
    // product display name
    let base;
    if (kind === 'mosaic') base = mosaicBase(rep);
    else if (kind === 'medallion') base = mosaicBase(rep);
    else if (kind === 'trim') base = displayBase(rep);
    else base = members.map(displayBase).sort((a, b) => a.length - b.length)[0];

    let name = base;
    if (kind === 'slab') name = `${base} Slab`;
    else if (kind === 'mosaic') name = /mosaic/i.test(base) ? base : `${base} Mosaic`;
    else if (kind === 'medallion') name = /medallion/i.test(base) ? base : `${base} Medallion`;
    else if (kind === 'trim') name = `${base} Trim`;
    else if (kind === 'paver') name = /paver/i.test(base) ? base : `${base} Paver`;

    // SKUs (dedup exact code+size+finish)
    const seen = new Set();
    const skus = [];
    for (const r of members) {
      const dk = `${r.code}|${r.size}|${r.finish}|${variantName(r)}`;
      if (seen.has(dk)) continue; seen.add(dk);
      const spec = sellSpec(r);
      skus.push({
        code: r.code,
        variant_name: variantName(r),
        size: r.size, size_nominal: nominalSize(r.size), size_label: r.sizeLabel || null,
        finish: r.finish, thickness: r.thickness,
        material: r.material,
        cost: r.cost,
        sqft_box: r.sqft_box, pcs_box: r.pcs_box,
        sell_by: spec.sell_by, price_basis: spec.price_basis,
        variant_type: kind === 'trim' ? 'accessory' : null,
        accessory_label: kind === 'trim' ? trimLabel(r) : null,
      });
    }
    if (!skus.length) continue;

    const series = rep.series || null;
    const manufacturer = rep.manufacturer || null;
    const material = rep.material;
    const priced = skus.filter((s) => s.cost != null);
    products.push({
      pkey: mkPkey(name, kind === 'slab' ? 'slab' : kind === 'mosaic' ? 'mos' : kind === 'trim' ? 'trim' : ''),
      key: gk, kind, name,
      collection: series || base,          // refined below for multi-color series
      series, manufacturer, material,
      category: categoryFor(rep),
      look: lookFor(name, material),
      shape: shapeFor(name),
      status: priced.length ? 'active' : 'draft',
      color: null,
      trimStoneKey: kind === 'trim' ? trimStoneKey(rep) : null,
      fieldStoneKey: (kind === 'field') ? (baseKey(rep.name) || null) : null,
      fieldMaterial: material,
      skus,
    });
  }
  return products;
}

// ================= COLLECTIONS + COLOR =================
// Porcelain: series is the collection (multi-color). Stone: group by name stem so colors of a
// stone family share a collection; singletons keep their own name.
function assignCollections(products) {
  // porcelain: collection already = series. compute color = name minus nothing special (name IS color)
  const stem = (name) => { const w = name.split(/\s+/); return w.length > 1 ? w.slice(0, -1).join(' ') : name; };
  const groups = new Map();
  for (const p of products) {
    if (p.kind === 'trim') continue;
    if (p.material === 'Porcelain' && p.series) {         // porcelain keeps its series collection
      p.collection = p.series;
      continue;
    }
    const k = stem(p.name).toLowerCase() + '|' + p.category;
    if (!groups.has(k)) groups.set(k, { label: stem(p.name), items: [] });
    groups.get(k).items.push(p);
  }
  for (const { label, items } of groups.values()) {
    if (items.length >= 2) for (const p of items) p.collection = label;
    else items[0].collection = items[0].name;
  }
  // color attribute = name beyond the collection stem
  for (const p of products) {
    if (p.kind === 'trim') { p.color = null; continue; }
    const coll = p.collection || '';
    if (coll && p.name.length > coll.length && p.name.toLowerCase().startsWith(coll.toLowerCase()))
      p.color = clean(p.name.slice(coll.length).replace(/^[\s.,\-–]+/, '')) || null;
    else if (p.material === 'Porcelain' && p.series) p.color = p.name;   // porcelain: full name is the color/variant
  }
}

// ================= ACCESSORY → FIELD LINK =================
function linkTrim(products) {
  const fieldByKey = new Map();
  for (const p of products) if (p.kind === 'field' && p.fieldStoneKey)
    fieldByKey.set(`${p.fieldMaterial}|${p.fieldStoneKey}`, p);
  let linked = 0, unlinked = 0;
  for (const ap of products) {
    if (ap.kind !== 'trim') continue;
    const fp = fieldByKey.get(`${ap.material}|${ap.trimStoneKey}`);
    ap.attach_to = fp ? [fp.pkey] : [];
    if (fp) { linked++; ap.collection = fp.collection; ap.name = `${displayBase({ name: fp.name })} Trim`; ap.color = fp.color; }
    else unlinked++;
  }
  return { linked, unlinked };
}

// ================= UNIQUENESS (collection,name) =================
function ensureUnique(products) {
  const seen = new Map();
  for (const p of products) {
    let k = `${p.collection}||${p.name}`;
    if (seen.has(k)) {
      const dim = (p.skus[0] && (p.skus[0].size_nominal || p.skus[0].thickness)) || String(seen.get(k) + 1);
      p.name = `${p.name} (${dim})`;
      k = `${p.collection}||${p.name}`;
      let i = 2; while (seen.has(k)) { p.name = `${p.name} ${i++}`; k = `${p.collection}||${p.name}`; }
    }
    seen.set(k, (seen.get(k) || 0) + 1);
  }
}

// ================= IMAGES (match by Marblex code) =================
const LOGO_RE = /Marblex-Logo/i;
const DIAGRAM_RE = /TABLE|TECHS?|TECHNICAL|SPECIFICATION|PACKAGING|SIZE[_-]?TABLE|GENERIC_.*COLLECTION|-COLLECTION|colors?\.png/i;
function buildImages(products) {
  const raw = JSON.parse(fs.readFileSync(path.join(DIR, 'wc-images-raw.json'), 'utf8'));
  const byCode = new Map();
  for (const p of raw) {
    const code = clean(p.sku);
    if (!code) continue;
    const imgs = (p.imgs || []).filter((u) => u && !LOGO_RE.test(u));
    if (!imgs.length) continue;
    if (!byCode.has(code)) byCode.set(code, []);
    for (const u of imgs) if (!byCode.get(code).includes(u)) byCode.get(code).push(u);
  }
  const rank = (arr) => [...arr].sort((a, b) => (DIAGRAM_RE.test(a) ? 1 : 0) - (DIAGRAM_RE.test(b) ? 1 : 0));

  const images = {};
  let prodWith = 0, skuWith = 0;
  for (const p of products) {
    const skusOut = {};
    let prodPrimary = null; const prodAlts = [];
    for (const s of p.skus) {
      const imgs = byCode.get(s.code);
      if (!imgs || !imgs.length) continue;
      const ranked = rank(imgs);
      skusOut[s.code] = { primary: ranked[0], alternates: ranked.slice(1, 6) };
      skuWith++;
      if (!prodPrimary) prodPrimary = ranked[0];
      for (const u of ranked) if (u !== prodPrimary && !prodAlts.includes(u)) prodAlts.push(u);
    }
    if (prodPrimary || Object.keys(skusOut).length) {
      images[p.pkey] = { product: { primary: prodPrimary, alternates: prodAlts.slice(0, 6) }, skus: skusOut };
      prodWith++;
    }
  }
  return { images, prodWith, skuWith };
}

// ================= MAIN =================
const rows = [...parsePorcelain(), ...parseStone()];
const products = buildProducts(rows);
assignCollections(products);
const { linked, unlinked } = linkTrim(products);
ensureUnique(products);
const { images, prodWith, skuWith } = buildImages(products);

const fieldProducts = products.filter((p) => p.kind !== 'trim');
const accessoryProducts = products.filter((p) => p.kind === 'trim');

const catalog = {
  vendor: {
    name: 'Marblex Corp', code: 'MX',
    website: 'https://marblexcorp.com',
    email: null, phone: '(714) 780-0999',
    address: '1415 S. Vernon Street, Anaheim, CA 92805',
    notes: 'Natural-stone + porcelain distributor (Anaheim, CA). Marble/travertine/limestone/'
      + 'granite/quartzite/dolomite tile, slabs, mosaics, patterns, medallions & trim, plus '
      + 'imported porcelain (Florim, Rondine, Keraben, etc.). Price lists = Roma cost; retail = '
      + 'cost x1.6 keystone. FOB Anaheim. Office 1415 S. Vernon St, Anaheim CA 92805 / (714) 780-0999.',
  },
  brand: { name: 'Marblex', code: 'MX', website: 'https://marblexcorp.com' },
  markup: 1.6,
  products: fieldProducts,
  accessoryProducts,
};
fs.writeFileSync(path.join(DIR, 'catalog.json'), JSON.stringify(catalog, null, 2));
fs.writeFileSync(path.join(DIR, 'images.json'), JSON.stringify(images, null, 2));

// ================= REPORT =================
const skuCount = (arr) => arr.reduce((a, p) => a + p.skus.length, 0);
const byKind = {};
for (const p of products) { byKind[p.kind] = byKind[p.kind] || { p: 0, s: 0 }; byKind[p.kind].p++; byKind[p.kind].s += p.skus.length; }
const byCat = {};
for (const p of products) byCat[p.category] = (byCat[p.category] || 0) + 1;
const draft = products.filter((p) => p.status === 'draft').length;

console.log('=== Marblex build ===');
console.log(`rows parsed: ${rows.length}  (porcelain ${rows.filter(r=>r.source==='porcelain').length}, stone ${rows.filter(r=>r.source==='stone').length})`);
console.log(`products: ${products.length}  (${skuCount(products)} skus)  draft(unpriced): ${draft}`);
console.log('by kind:', Object.entries(byKind).map(([k, v]) => `${k} ${v.p}p/${v.s}s`).join('  '));
console.log('by category:', byCat);
console.log(`trim: linked ${linked}, standalone ${unlinked}`);
console.log(`images: ${prodWith}/${products.length} products, ${skuWith} sku-level matches`);
{
  const colls = new Map();
  for (const p of products) colls.set(p.collection, (colls.get(p.collection) || 0) + 1);
  const multi = [...colls.values()].filter((n) => n >= 2).length;
  console.log(`collections: ${colls.size} (${multi} with >=2 products)`);
}
