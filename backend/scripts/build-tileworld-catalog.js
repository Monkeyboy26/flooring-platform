#!/usr/bin/env node
/**
 * Build Tile World catalog.json + images.json from the SEPT 2026 price sheet.
 *
 * Tile World Inc. (1100 E Howell Avenue, Anaheim CA — tileworldusa.com,
 * Sales@TileWorldUSA.com, 714-363-3444) is a trade distributor of imported
 * porcelain / ceramic floor, wall, paver and wood-look tile (made in India &
 * Spain). Onboarded as its OWN vendor carrying a single house brand (Tile World).
 *
 * INPUTS  (backend/data/tileworld/)
 *   pricelist-sept2026.txt — `pdftotext -layout pricelist-sept2026.pdf`. The clean
 *       two-column layout is authoritative for what we sell + pricing. Sections are
 *       introduced by a header line ("<SIZE> Floor And Wall Tiles" / "Wood Design
 *       Planks" / "Pavers" / "Outdoor/ Elevation Tiles" / "Wall Tiles"), then a
 *       packaging line, then "Item name  Price ($/SF)" rows. Two blocks put TWO
 *       DIFFERENT sections side by side (8X24 | 8X55 planks; 12X24 Outdoor | 12X36
 *       Wall) — each column carries its own section. The 24x48 list continues onto
 *       the next page (Spain* + R10 items) with no repeated header. Packaging is
 *       taken from the hardcoded SECTIONS table (parsing the wrapped side-by-side
 *       packaging lines is error-prone); per-item "(2PCS/13.8SF)" overrides win.
 *   site-details.json — legacy tileworldusa.com scrape (name → thumbnail + Color /
 *       Surface). Used only to enrich matching designs with a photo + color facet
 *       (matched on normalized base name). New items with no site match stay photoless.
 *
 * MODEL (see [[variant-pill-independence]] / [[line-item-display]])
 *   Each distinct design/color name is ONE product; its size × finish × surface ×
 *   origin rows become its SKUs (sell_by 'box', per_sqft). Finish is parsed from the
 *   trailing parenthetical marker ("(MATTE)", "(POLISH)", "(HIGH GLOSS)/(GLOSSY)",
 *   "(MATT+CARV)", "(matt and pol)"/"(M+P)" → Matte & Polished, "(R10 MATTE)" →
 *   Matte + R10 slip rating). Unmarked floor/wall = Polished; planks/outdoor/pavers
 *   = Matte. A design that appears in two categories (porcelain floor vs ceramic
 *   wall) becomes two products, disambiguated by a "(Wall)"/"(Plank)" qualifier.
 *
 * CATEGORY: Floor and Wall / Outdoor / Pavers → porcelain-tile; Wood Design Planks →
 *   wood-look-tile; 12X36 Wall Tiles → ceramic-tile.
 *
 * PRICING: sheet price = Roma COST; retail = cost x1.6 nickel keystone (importer).
 *
 * OUTPUTS: catalog.json, images.json, images-src.json (local→remote for staging).
 *
 * Usage: node scripts/build-tileworld-catalog.js
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(__dirname, '..', 'data', 'tileworld');
const SRC = path.join(DIR, 'pricelist-sept2026.txt');

// ==================== section table (packaging hardcoded from the sheet) ====================
// pack: { sf: SF/box, pcs: pieces/box, bp: boxes/pallet }
const SECTIONS = {
  '12x24-fw':    { size: '12X24', cat: 'porcelain-tile', mat: 'Porcelain', origin: 'India', app: 'Floor · Wall',    def: 'Polished', pack: { sf: 9.70,  pcs: 5, bp: 64 } },
  '24x48-fw':    { size: '24X48', cat: 'porcelain-tile', mat: 'Porcelain', origin: 'India', app: 'Floor · Wall',    def: 'Polished', pack: { sf: 15.50, pcs: 2, bp: 30 } },
  '24x48-paver': { size: '24X48', cat: 'porcelain-tile', mat: 'Porcelain', origin: 'India', app: 'Outdoor · Paver', def: 'Matte',    pack: { sf: 7.75,  pcs: 1, bp: 30 }, isPaver: true },
  '24x24-fw':    { size: '24X24', cat: 'porcelain-tile', mat: 'Porcelain', origin: 'India', app: 'Floor · Wall',    def: 'Polished', pack: { sf: 15.5,  pcs: 4, bp: 36 } },
  '48x48-fw':    { size: '48X48', cat: 'porcelain-tile', mat: 'Porcelain', origin: 'India', app: 'Floor · Wall',    def: 'Polished', pack: { sf: 31,    pcs: 2, bp: 28 } },
  '36x36-fw':    { size: '36X36', cat: 'porcelain-tile', mat: 'Porcelain', origin: 'Spain', app: 'Floor · Wall',    def: 'Polished', pack: { sf: 17.44, pcs: 2, bp: 32 } },
  '32x32-fw':    { size: '32X32', cat: 'porcelain-tile', mat: 'Porcelain', origin: 'India', app: 'Floor · Wall',    def: 'Polished', pack: { sf: 20.67, pcs: 3, bp: 36 } },
  '6x36-plank':  { size: '6X36',  cat: 'wood-look-tile', mat: 'Porcelain', origin: 'India', app: 'Floor · Wall',    def: 'Matte',    pack: { sf: 11.20, pcs: 8, bp: 60 }, look: 'Wood' },
  '8x48-plank':  { size: '8X48',  cat: 'wood-look-tile', mat: 'Porcelain', origin: 'India', app: 'Floor · Wall',    def: 'Matte',    pack: { sf: 12.92, pcs: 5, bp: 42 }, look: 'Wood' },
  '8x24-plank':  { size: '8X24',  cat: 'wood-look-tile', mat: 'Porcelain', origin: 'India', app: 'Floor · Wall',    def: 'Matte',    pack: { sf: 7.75,  pcs: 6, bp: 84 }, look: 'Wood' },
  '8x55-plank':  { size: '8X55',  cat: 'wood-look-tile', mat: 'Porcelain', origin: 'India', app: 'Floor · Wall',    def: 'Matte',    pack: { sf: 11.45, pcs: 4, bp: 45 }, look: 'Wood' },
  '12x24-out':   { size: '12X24', cat: 'porcelain-tile', mat: 'Porcelain', origin: 'India', app: 'Outdoor · Facade', def: 'Matte',   pack: { sf: 9.7,   pcs: 5, bp: 48 }, isOutdoor: true },
  '12x36-wall':  { size: '12X36', cat: 'ceramic-tile',   mat: 'Ceramic',   origin: 'India', app: 'Wall',            def: 'Polished', pack: { sf: 11.63, pcs: 4, bp: 57 } },
};

// Map a header fragment (one column of a header line) to a section id, or null.
function sectionFor(frag) {
  const t = (frag || '').trim();
  if (!t) return null;
  const U = t.toUpperCase();
  if (/PAVERS/.test(U)) return '24x48-paver';
  if (/OUTDOOR|ELEVATION/.test(U)) return '12x24-out';
  const m = /(\d+)\s*X\s*(\d+)/i.exec(t);
  if (!m) return null;
  const size = `${m[1]}X${m[2]}`.toUpperCase();
  if (/WOOD\s+DESIGN\s+PLANK/.test(U)) {
    return { '6X36': '6x36-plank', '8X48': '8x48-plank', '8X24': '8x24-plank', '8X55': '8x55-plank' }[size] || null;
  }
  if (size === '12X36' && /WALL\s+TILE/.test(U)) return '12x36-wall';
  if (/FLOOR\s+AND\s+WALL/.test(U)) {
    return { '12X24': '12x24-fw', '24X48': '24x48-fw', '24X24': '24x24-fw', '48X48': '48x48-fw', '36X36': '36x36-fw', '32X32': '32x32-fw' }[size] || null;
  }
  return null;
}

// ==================== 1. parse the layout text into raw items ====================
const PRICE_RE = /\$\s?(\d+\.\d{2})/g;
const COL_THRESHOLD = 48;   // price char-index below → left column, at/above → right (side-by-side blocks)

// Some sheet names drop the closing paren ("CALACATTA CARVED (MATT+CARV"). Close any
// dangling "(" so the finish marker parses and the base name strips it cleanly.
function closeParens(s) {
  const open = (s.match(/\(/g) || []).length, close = (s.match(/\)/g) || []).length;
  return open > close ? s + ')'.repeat(open - close) : s;
}

function parseItems() {
  const lines = fs.readFileSync(SRC, 'utf8').split(/\r?\n/);
  const items = [];
  let leftSec = null, rightSec = null;
  let lastLeft = null, lastRight = null;

  for (const rawLine of lines) {
    const line = rawLine.replace(/ /g, ' ');
    if (!line.trim()) continue;
    const hasPrice = /\$\s?\d+\.\d{2}/.test(line);

    // -- header line (never has a price) --
    if (!hasPrice) {
      const segs = line.split(/\s{3,}/).map((s) => s.trim()).filter(Boolean);
      const found = segs.map((s) => sectionFor(s)).filter(Boolean);
      if (found.length >= 2) {            // two different sections side by side
        leftSec = found[0]; rightSec = found[1];
        lastLeft = lastRight = null;
        continue;
      }
      if (found.length === 1) {           // one header spans both columns (or single column)
        leftSec = rightSec = found[0];
        lastLeft = lastRight = null;
        continue;
      }
      // continuation of a wrapped item name, e.g. "(MATTE)(2PCS/13.8SF)"
      const cont = line.trim();
      if (/^\(/.test(cont)) {
        const indent = line.length - line.trimStart().length;
        const target = indent < COL_THRESHOLD ? lastLeft : lastRight;
        if (target) target.raw = `${target.raw} ${cont}`.trim();
      }
      continue;                           // page headers, "Item name" rows, packaging, blanks
    }

    // -- item line: extract (name, price) pairs left→right --
    PRICE_RE.lastIndex = 0;
    let m, prev = 0;
    while ((m = PRICE_RE.exec(line)) !== null) {
      const name = closeParens(line.slice(prev, m.index).trim());
      prev = PRICE_RE.lastIndex;
      if (!name) continue;
      const isLeft = m.index < COL_THRESHOLD || leftSec === rightSec;
      const secId = isLeft ? leftSec : rightSec;
      if (!secId) continue;
      const it = { raw: name, price: +m[1], secId };
      items.push(it);
      if (m.index < COL_THRESHOLD) lastLeft = it; else lastRight = it;
    }
  }
  return items;
}

// ==================== 2. derive finish / surface / base name ====================
function deriveFinish(rawName, section) {
  const paren = [...rawName.matchAll(/\(([^)]*)\)/g)].map((m) => m[1]).join(' ').toUpperCase();
  const hasMatt = /MATT/.test(paren), hasPol = /POL/.test(paren);
  let finish = null, surface = null, rating = null;
  if (/R10/.test(paren)) rating = 'R10';
  if (/M\s*\+\s*P/.test(paren) || (hasMatt && hasPol)) finish = 'Matte & Polished';
  else if (/CARV/.test(paren)) { surface = 'Carved'; finish = 'Matte'; }
  else if (/GLOSS/.test(paren)) finish = 'High Gloss';
  else if (hasMatt) finish = 'Matte';
  else if (hasPol) finish = 'Polished';
  if (!finish) finish = section.def;
  return { finish, surface, rating };
}

// Per-item packaging override "(2PCS/13.8SF)" → { pcs, sf }
function packOverride(rawName) {
  const m = /(\d+)\s*PCS?\s*\/\s*([\d.]+)\s*SF/i.exec(rawName);
  return m ? { pcs: +m[1], sf: +m[2] } : null;
}

// Canonicalize spelling inconsistencies so the same design isn't split into duplicate
// products AND so the price-sheet name resolves to the website's (differently spelled)
// name during image matching. The site-only variants (Sande/Cola/Laos/Creama/Caryola/
// "Cloud White") don't occur as whole words in any sheet name, so they only rewrite the
// site side — sheet display names are unaffected (verified against the full item list).
const SPELLING = [
  [/\bsaturio\b/gi, 'Satuario'], [/\bsatvario\b/gi, 'Satuario'],
  [/\bbbianco\b/gi, 'Bianco'], [/\bgranity\b/gi, 'Graniti'],
  [/\bantracita\b/gi, 'Antracite'], [/\bgrafito\b/gi, 'Graffito'],
  [/\bsande\b/gi, 'Sandy'], [/\bcola\b/gi, 'Colla'], [/\blaos\b/gi, 'Loas'],
  [/\bcreama\b/gi, 'Crema'], [/\bcaryola\b/gi, 'Crayola'], [/\bcloud white\b/gi, 'Cloudy White'],
];
function canon(s) {
  let out = s;
  for (const [re, rep] of SPELLING) out = out.replace(re, rep);
  return out;
}

// Base (design) name = raw name with all parentheticals + trailing junk removed.
function baseName(rawName) {
  let s = rawName.replace(/\bSpain\*?/ig, ' ');   // origin marker, not part of the name
  s = s.replace(/\([^)]*\)/g, ' ');               // drop all parentheticals (finish/override)
  s = s.replace(/\s{2,}/g, ' ').replace(/[\s._-]+$/, '').trim();
  return canon(s);
}

function normKey(s) {
  return canon(s).toLowerCase().replace(/gray/g, 'grey').replace(/[^a-z0-9]+/g, ' ').trim();
}
// Two match keys per name: `siteKey` keeps word spacing but strips a trailing dup-page
// digit ("Canus Ash 1", and sheet "007-1"→"007"); `tightKey` removes all separators so
// punctuation-only differences match ("NRC012" ↔ "NRC-012", "Anti Sky" ↔ "ANTISKY").
function siteKey(name) {
  return normKey(name).replace(/ \d$/, '').trim();
}
function tightKey(name) {
  return normKey(name).replace(/ /g, '');
}
function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
function titleName(base) {
  if (/[\d_/]/.test(base)) return base;   // codes keep original casing
  return base.split(/\s+/).map((w) => (w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w)).join(' ');
}
function sizeAttr(size) {
  const m = /(\d+)\s*[xX]\s*(\d+)/.exec(size);
  return m ? `${m[1]}x${m[2]}` : size;
}
function sizeDisp(size) {
  const m = /(\d+)\s*[xX]\s*(\d+)/.exec(size);
  return m ? `${m[1]}″ × ${m[2]}″` : size;
}

const CAT_QUALIFIER = { 'ceramic-tile': ' (Wall)', 'wood-look-tile': ' (Plank)' };

// ==================== 3. site images + color enrichment ====================
let siteDetails = {};
try { siteDetails = JSON.parse(fs.readFileSync(path.join(DIR, 'site-details.json'), 'utf8')); }
catch { console.warn('! site-details.json not found — building without site photos/colors'); }
const siteByName = new Map();   // spaced key OR tight key -> [rec] (both point at the same recs)
function indexSite(k, rec) {
  if (!k) return;
  if (!siteByName.has(k)) siteByName.set(k, []);
  const arr = siteByName.get(k);
  if (!arr.includes(rec)) arr.push(rec);
}
for (const key of Object.keys(siteDetails)) {
  const e = siteDetails[key];
  if (!e.name) continue;
  const meta = e.meta || {};
  const rec = {
    sizeSlug: e.size_slug, img: e.img,
    color: (meta.Color || '').trim() || null,
    surface: (meta['Surface look'] || '').split(/&nbsp;|&|\s{2,}/)[0].trim() || null,
  };
  indexSite(siteKey(e.name), rec);
  indexSite(tightKey(e.name), rec);
}
// look up a design's site records by spaced key, falling back to the tight key
function siteRecsFor(base) {
  return siteByName.get(siteKey(base)) || siteByName.get(tightKey(base)) || [];
}
const sizeSlugFor = (size) => {
  const m = /(\d+)\s*[xX]\s*(\d+)/.exec(size);
  return m ? `${m[1]}-x-${m[2]}-in` : null;
};

// ==================== 4. group items into products ====================
const items = parseItems();

// origins & categories per base (to know when to label origin / qualify duplicate designs)
const originsByBase = new Map();
const catsByBase = new Map();
for (const it of items) {
  const sec = SECTIONS[it.secId];
  const origin = /Spain\*?/i.test(it.raw) ? 'Spain' : sec.origin;
  const b = normKey(baseName(it.raw));
  if (!originsByBase.has(b)) originsByBase.set(b, new Set());
  originsByBase.get(b).add(origin);
  if (!catsByBase.has(b)) catsByBase.set(b, new Set());
  catsByBase.get(b).add(sec.cat);
}

const products = new Map();      // pkey -> product
const usedPkey = new Map();      // pkey -> groupKey that owns it
function pkeyFor(groupKey, base) {
  const slug = slugify(base) || 'item';
  let cand = `TWD-${slug}`;
  if (usedPkey.has(cand) && usedPkey.get(cand) !== groupKey) {
    let i = 2;
    while (usedPkey.has(`${cand}-${i}`) && usedPkey.get(`${cand}-${i}`) !== groupKey) i++;
    cand = `${cand}-${i}`;
  }
  usedPkey.set(cand, groupKey);
  return cand;
}
const groupToPkey = new Map();

const usedSuffix = new Map();    // pkey -> Set(suffix)
function suffixFor(pkey, size, finish, surface, rating, origin, multiOrigin) {
  const parts = [size.toLowerCase().replace(/[^a-z0-9]+/g, ''), slugify(finish)];
  if (surface) parts.push(slugify(surface));
  if (rating) parts.push(slugify(rating));
  if (multiOrigin) parts.push(slugify(origin));
  const base = parts.filter(Boolean).join('-');
  if (!usedSuffix.has(pkey)) usedSuffix.set(pkey, new Set());
  const seen = usedSuffix.get(pkey);
  let cand = base, i = 2;
  while (seen.has(cand)) cand = `${base}-${i++}`;
  seen.add(cand);
  return cand;
}

for (const it of items) {
  const sec = SECTIONS[it.secId];
  const base = baseName(it.raw);
  const nk = normKey(base);
  const category = sec.cat;
  const origin = /Spain\*?/i.test(it.raw) ? 'Spain' : sec.origin;
  const { finish, surface, rating } = deriveFinish(it.raw, sec);
  const size = sec.size;
  const multiOrigin = (originsByBase.get(nk) || new Set()).size > 1;
  const ov = packOverride(it.raw);

  const groupKey = `${nk}|${category}`;
  let pkey = groupToPkey.get(groupKey);
  if (!pkey) { pkey = pkeyFor(groupKey, base); groupToPkey.set(groupKey, pkey); }

  if (!products.has(pkey)) {
    const multiCat = (catsByBase.get(nk) || new Set()).size > 1;
    const qualifier = multiCat ? (CAT_QUALIFIER[category] || '') : '';
    products.set(pkey, {
      pkey, base,
      name: titleName(base) + qualifier,
      collection: titleName(base) + qualifier,
      category,
      material: sec.mat,
      look: sec.look || null,
      status: 'active',
      origins: new Set(),
      sizes: new Set(),
      sale: false,
      skus: [],
    });
  }
  const p = products.get(pkey);
  p.origins.add(origin);
  p.sizes.add(sizeDisp(size));

  const suffix = suffixFor(pkey, size, finish, surface, rating, origin, multiOrigin);
  const variantBits = [sizeDisp(size), finish];
  if (surface) variantBits.push(surface);
  if (rating) variantBits.push(rating);
  if (multiOrigin) variantBits.push(`Made in ${origin}`);

  p.skus.push({
    suffix,
    variant_name: variantBits.join(' · '),
    sell_by: 'box',
    price_basis: 'per_sqft',
    cost: it.price,
    sqft_box: ov ? ov.sf : sec.pack.sf,
    pcs_box: ov ? ov.pcs : sec.pack.pcs,
    boxes_pallet: sec.pack.bp,
    size: sizeAttr(size),
    size_nominal: sizeDisp(size),
    finish,
    surface,
    origin,
    application: sec.app,
    _sizeCode: size,
  });
}

// ==================== 5. attach color + images ====================
const images = {};
const imagesSrc = {};
let matchedProducts = 0, matchedSkus = 0;

for (const p of products.values()) {
  const siteRecs = siteRecsFor(p.base);
  p.color = siteRecs.map((r) => r.color).find(Boolean) || null;
  if (!siteRecs.length) continue;
  matchedProducts++;

  const im = { product: { primary: null, alternates: [] }, skus: {} };
  const bySizeSlug = new Map();
  for (const r of siteRecs) if (r.img) bySizeSlug.set(r.sizeSlug, r);

  const stage = (remoteUrl, tag) => {
    const local = `/uploads/tileworld/${p.pkey}-${tag}.jpg`;
    imagesSrc[local] = remoteUrl;
    return local;
  };

  for (const s of p.skus) {
    const ss = sizeSlugFor(s._sizeCode);
    const rec = ss && bySizeSlug.get(ss);
    if (rec) { im.skus[s.suffix] = { primary: stage(rec.img, s._sizeCode.toLowerCase()), alternates: [] }; matchedSkus++; }
  }
  const firstRec = siteRecs.find((r) => r.img);
  if (firstRec) im.product.primary = stage(firstRec.img, 'primary');
  images[p.pkey] = im;
}

// ==================== 6. finalize + write ====================
const productList = [...products.values()].map((p) => ({
  pkey: p.pkey,
  name: p.name,
  collection: p.collection,
  category: p.category,
  status: p.status,
  material: p.material,
  look: p.look,
  color: p.color,
  origins: [...p.origins],
  origin: [...p.origins][0],
  sale: p.sale,
  skus: p.skus.map((s) => { const { _sizeCode, ...rest } = s; return rest; }),
}));

const catalog = {
  vendor: {
    name: 'Tile World',
    code: 'TWD',
    website: 'https://tileworldusa.com',
    email: 'Sales@TileWorldUSA.com',
    phone: '714-363-3444',
    address: '1100 E Howell Avenue, Anaheim, CA 92805',
    notes: 'Trade distributor of imported porcelain / ceramic floor, wall, paver & wood-look tile '
      + '(made in India & Spain). Priced from the SEPT 2026 price sheet (Roma cost; retail = cost x1.6). FOB Anaheim.',
  },
  brand: { name: 'Tile World', code: 'TWD', website: 'https://tileworldusa.com' },
  markup: 1.6,
  source: 'SEPT 2026 price sheet + tileworldusa.com',
  products: productList,
  accessoryProducts: [],
};

fs.writeFileSync(path.join(DIR, 'catalog.json'), JSON.stringify(catalog, null, 2));
fs.writeFileSync(path.join(DIR, 'images.json'), JSON.stringify(images, null, 2));
fs.writeFileSync(path.join(DIR, 'images-src.json'), JSON.stringify(imagesSrc, null, 2));

// ==================== summary ====================
const skuCount = productList.reduce((n, p) => n + p.skus.length, 0);
const byCat = {}, bySize = {};
for (const p of productList) byCat[p.category] = (byCat[p.category] || 0) + 1;
for (const p of productList) for (const s of p.skus) bySize[s.size] = (bySize[s.size] || 0) + 1;
console.log('=== Tile World catalog built (SEPT 2026) ===');
console.log(`Items parsed:      ${items.length}`);
console.log(`Products:          ${productList.length}  (${skuCount} SKUs)`);
console.log('By category:      ', byCat);
console.log('SKUs by size:     ', bySize);
console.log(`Products w/ photo: ${matchedProducts}  |  SKU-level photos: ${matchedSkus}  |  images to stage: ${Object.keys(imagesSrc).length}`);
console.log(`Products w/ color: ${productList.filter((p) => p.color).length}`);
console.log('\nWrote catalog.json, images.json, images-src.json');
