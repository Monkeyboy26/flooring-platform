#!/usr/bin/env node
/**
 * Build Tile World catalog.json + images.json from the MAR 2024 price sheet.
 *
 * Tile World Inc. (1100 E Howell Avenue, Anaheim CA — tileworldusa.com,
 * Sales@TileWorldUSA.com, 714-363-3444) is a trade distributor of imported
 * porcelain / ceramic floor, wall and wood-look tile (made in India & Spain).
 * Onboarded as its OWN vendor carrying a single house brand (Tile World).
 *
 * INPUTS  (backend/data/tileworld/)
 *   pricelist.pdf / pricelist.bbox.xml  — the price sheet. `pricelist.bbox.xml` is
 *       `pdftotext -bbox-layout pricelist.pdf pricelist.bbox.xml`. The sheet is a
 *       TWO-COLUMN layout with per-section headers ("<SIZE> Floor and Wall Tiles
 *       (MADE IN <ORIGIN>)" / "Wood Design Planks" / "Wall Tiles" /
 *       "Outdoor/Elevation Tiles") each followed by a packaging line
 *       ("X SF/Box - Y PCs/Box - Z Boxes/Pallet") then "ITEM NAME  PRICE ($/SF)"
 *       rows. We parse by word bounding-box so each item attaches to the correct
 *       column + section header. One right-column 12X24 block is the "(SALE)"
 *       closeout list (factory-code names) — imported active per owner.
 *   site-details.json — tileworldusa.com product scrape (name → thumbnail image +
 *       Color / Surface metadata), keyed by "<size_slug>||<slug>". Used only to
 *       enrich the price-sheet products with a photo + color facet (matched on
 *       normalized name). The PDF is authoritative for what we sell + pricing.
 *
 * MODEL (see [[variant-pill-independence]] / [[line-item-display]])
 *   Each distinct design/color name is ONE product; its size × finish × origin
 *   rows become the product's SKUs. Field/wall/wood-look field tile: sell_by 'box',
 *   per_sqft. No trim/accessories on this sheet. Finish is parsed from the item
 *   name's parenthetical marker ("(MATTE)", "(HIGH GLOSS)", "(MATT+CARVING)", …);
 *   unmarked floor/wall = Polished ("* All Matte tiles are noted (MATTE)"), planks
 *   = Matte (section-level), outdoor = Matte.
 *
 * CATEGORY: Floor and Wall / Outdoor → porcelain-tile; Wood Design Planks →
 *   wood-look-tile; 12X36 Wall Tiles → ceramic-tile.
 *
 * PRICING: sheet price = Roma COST; retail = cost x1.6 nickel keystone (importer).
 *
 * OUTPUTS: catalog.json (vendor/brand/products/skus), images.json (local
 *   /uploads/tileworld/ paths keyed by pkey), images-src.json (local→remote map
 *   for stage-tileworld-images.js to download).
 *
 * Usage: node scripts/build-tileworld-catalog.js
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(__dirname, '..', 'data', 'tileworld');

// ==================== 1. parse the price sheet (bbox) ====================
const xml = fs.readFileSync(path.join(DIR, 'pricelist.bbox.xml'), 'utf8');
const COL_SPLIT = 306.0;   // page width ~612; left col < 306, right col >= 306
const Y_TOL = 3.0;

const WORD_RE = /<word xMin="([0-9.]+)" yMin="([0-9.]+)" xMax="([0-9.]+)" yMax="([0-9.]+)">([\s\S]*?)<\/word>/g;
const HEADER_RE = /(Floor and Wall Tiles|Wood Design Planks|Wall Tiles|Outdoor\/Elevation Tiles)/i;
const SIZE_HDR_RE = /(\d+\s*[xX]\s*\d+)/;
const ORIGIN_RE = /MADE IN (INDIA|SPAIN)/i;
const PACK_RE = /([\d.]+)\s*SF\/Box.*?([\d.]+)\s*PCs?\/Box.*?([\d.]+)\s*Box(?:es)?\/Pallet/i;
const PRICE_RE = /\$\s*(\d+\.\d{2})/;

function unescapeXml(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'");
}

function rowsFor(words) {
  words.sort((a, b) => a.y - b.y || a.x - b.x);
  const rows = [];
  for (const w of words) {
    const last = rows[rows.length - 1];
    if (last && Math.abs(w.y - last.y) <= Y_TOL) {
      last.words.push(w);
      last.y = (last.y + w.y) / 2;
    } else {
      rows.push({ y: w.y, words: [w] });
    }
  }
  for (const r of rows) {
    r.words.sort((a, b) => a.x - b.x);
    r.text = r.words.map((w) => w.t).join(' ').trim();
  }
  return rows;
}

function parseItems() {
  const pages = xml.split('<page ').slice(1);
  const items = [];
  pages.forEach((page, pi) => {
    const words = [];
    let m;
    WORD_RE.lastIndex = 0;
    while ((m = WORD_RE.exec(page)) !== null) {
      const t = unescapeXml(m[5]).trim();
      if (t) words.push({ x: +m[1], y: +m[2], xmax: +m[3], t });
    }
    for (const col of ['L', 'R']) {
      const cw = words.filter((w) => (w.x < COL_SPLIT) === (col === 'L'));
      const rows = rowsFor(cw.map((w) => ({ ...w })));
      let section = null, pack = null, sale = false;
      for (const r of rows) {
        const t = r.text;
        const hm = HEADER_RE.exec(t);
        if (hm && (/MADE IN/i.test(t) || /PLANK/i.test(t))) {
          const sz = SIZE_HDR_RE.exec(t);
          const org = ORIGIN_RE.exec(t);
          section = {
            size: sz ? sz[1].replace(/\s+/g, '').toUpperCase() : '?',
            origin: org ? (org[1][0] + org[1].slice(1).toLowerCase()) : 'India',
            kind: hm[1],
            matteSection: /\(MATTE\)/i.test(t) && /PLANK/i.test(t),
          };
          pack = null; sale = false;
          continue;
        }
        const pm = PACK_RE.exec(t.replace(/,/g, ''));
        if (pm && section) { pack = { sf_box: +pm[1], pcs_box: +pm[2], boxes_pallet: +pm[3] }; continue; }
        if (/\(SALE\)/i.test(t)) { sale = true; continue; }
        const price = PRICE_RE.exec(t);
        if (price && section) {
          const name = t.slice(0, price.index).replace(/\s{2,}/g, ' ').replace(/^[\s.\-]+|[\s.\-]+$/g, '').trim();
          if (!name) continue;
          items.push({
            page: pi + 1, col, rawName: name, price: +price[1],
            size: section.size, origin: section.origin, kind: section.kind,
            sale, matteSection: section.matteSection,
            ...(pack || { sf_box: null, pcs_box: null, boxes_pallet: null }),
          });
        }
      }
    }
  });
  return items;
}

// ==================== 2. derive finish / surface / base name ====================
// Finish lives in a trailing parenthetical marker on the item name.
function deriveFinish(rawName, section) {
  const paren = [...rawName.matchAll(/\(([^)]*)\)/g)].map((m) => m[1].toUpperCase()).join(' ');
  let finish = null, surface = null;
  if (/CARV/.test(paren)) { finish = 'Matte'; surface = 'Carved'; }
  else if (/HIGH\s*GLOSS|HIGHGLOSS/.test(paren)) finish = 'High Gloss';
  else if (/MATT/.test(paren)) finish = 'Matte';
  else if (/POLISH/.test(paren)) finish = 'Polished';
  if (!finish) {
    if (section.matteSection) finish = 'Matte';           // wood-look planks
    else if (section.kind === 'Outdoor/Elevation Tiles') finish = 'Matte';
    else finish = 'Polished';                              // unmarked floor/wall = polished
  }
  return { finish, surface };
}

// Canonicalize a handful of spelling inconsistencies so the same design isn't
// split into duplicate products, and so sheet names match the website's spelling.
// Each entry is a clear misspelling of ONE design word — never merges distinct
// designs (verified against the full item list).
const SPELLING = [
  [/\bsaturio\b/gi, 'Satuario'], [/\bsatvario\b/gi, 'Satuario'],
  [/\bbbianco\b/gi, 'Bianco'], [/\bgranity\b/gi, 'Graniti'],
  [/\bantracita\b/gi, 'Antracite'], [/\bgrafito\b/gi, 'Graffito'],
  [/\bcaryola\b/gi, 'Crayola'], [/\bexide\b/gi, 'Excide'],
];
function canon(s) {
  let out = s;
  for (const [re, rep] of SPELLING) out = out.replace(re, rep);
  return out;
}

// Base (design) name = raw name with the finish parenthetical + trailing finish
// words removed, so the same design across sizes/finishes groups into one product.
function baseName(rawName) {
  let s = rawName.replace(/\([^)]*\)/g, ' ');             // drop all parentheticals
  s = s.replace(/\s{2,}/g, ' ').replace(/[\s._-]+$/,'').trim();
  return canon(s);
}

function normKey(s) {
  return canon(s).toLowerCase().replace(/gray/g, 'grey').replace(/[^a-z0-9]+/g, ' ').trim();
}
// Site product pages sometimes carry a " 1"/" 2" dup-page suffix ("Canus Ash 1").
// Strip a SINGLE trailing digit (never multi-digit codes like "NRC 001") for
// site-name → sheet-name matching only.
function siteKey(name) {
  return normKey(name).replace(/ \d$/, '').trim();
}
function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
function titleName(base) {
  // Codes (anything with a digit / underscore / slash) keep their original casing.
  if (/[\d_/]/.test(base)) return base;
  return base.split(/\s+/).map((w) => w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w).join(' ');
}
// Size ATTRIBUTE value must be the plain `12x24` form (no quotes) so the storefront's
// dimension regex parses it and renders the Size variant pills (matches Roca et al.).
function sizeAttr(size) {
  const m = /(\d+)\s*[xX]\s*(\d+)/.exec(size);
  return m ? `${m[1]}x${m[2]}` : size;
}
function sizeDisp(size) {               // "12X24" -> `12″ × 24″` (display / variant name / desc)
  const m = /(\d+)\s*[xX]\s*(\d+)/.exec(size);
  return m ? `${m[1]}″ × ${m[2]}″` : size;
}

const CATEGORY = {
  'Floor and Wall Tiles': 'porcelain-tile',
  'Outdoor/Elevation Tiles': 'porcelain-tile',
  'Wood Design Planks': 'wood-look-tile',
  'Wall Tiles': 'ceramic-tile',
};
const MATERIAL = { 'Wall Tiles': 'Ceramic' };   // 12X36 wall tile is ceramic; everything else porcelain
const LOOK = { 'Wood Design Planks': 'Wood' };

// ==================== 3. site images + color enrichment ====================
const siteDetails = JSON.parse(fs.readFileSync(path.join(DIR, 'site-details.json'), 'utf8'));
// index site entries by normalized name -> [{size, img, color, surface}]
const siteByName = new Map();
for (const key of Object.keys(siteDetails)) {
  const e = siteDetails[key];
  const nk = siteKey(e.name);
  if (!nk) continue;
  const meta = e.meta || {};
  const rec = {
    sizeSlug: e.size_slug, img: e.img,
    color: (meta.Color || '').trim() || null,
    surface: (meta['Surface look'] || '').split(/&nbsp;|&|\s{2,}/)[0].trim() || null,
  };
  if (!siteByName.has(nk)) siteByName.set(nk, []);
  siteByName.get(nk).push(rec);
}
const sizeSlugFor = (size) => {           // "12X24" -> "12-x-24-in"
  const m = /(\d+)\s*[xX]\s*(\d+)/.exec(size);
  return m ? `${m[1]}-x-${m[2]}-in` : null;
};

// ==================== 4. group items into products ====================
const items = parseItems();

const products = new Map();   // pkey -> product
const usedPkey = new Map();    // pkey -> groupKey that owns it
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

// A design name that appears in >1 category (e.g. "Crema Marfil" as both a 12x24
// porcelain floor tile and a 12x36 ceramic wall tile) becomes two products — a
// qualifier keeps their names distinct (unique on vendor+collection+name).
const catsByBase = new Map();
for (const it of items) {
  const b = normKey(baseName(it.rawName));
  if (!catsByBase.has(b)) catsByBase.set(b, new Set());
  catsByBase.get(b).add(CATEGORY[it.kind] || 'porcelain-tile');
}
const CAT_QUALIFIER = { 'ceramic-tile': ' (Wall)', 'wood-look-tile': ' (Plank)' };

const usedSuffix = new Map();  // pkey -> Set(suffix)
function suffixFor(pkey, size, finish, surface, origin, multiOrigin) {
  const parts = [size.toLowerCase().replace(/[^a-z0-9]+/g, ''), slugify(finish)];
  if (surface) parts.push(slugify(surface));
  if (multiOrigin) parts.push(slugify(origin));
  let base = parts.filter(Boolean).join('-');
  if (!usedSuffix.has(pkey)) usedSuffix.set(pkey, new Set());
  const seen = usedSuffix.get(pkey);
  let cand = base, i = 2;
  while (seen.has(cand)) cand = `${base}-${i++}`;
  seen.add(cand);
  return cand;
}

// pre-compute origins per base name (to know when to label origin in variants)
const originsByBase = new Map();
for (const it of items) {
  const b = baseName(it.rawName);
  if (!originsByBase.has(b)) originsByBase.set(b, new Set());
  originsByBase.get(b).add(it.origin);
}

for (const it of items) {
  const base = baseName(it.rawName);
  const category = CATEGORY[it.kind] || 'porcelain-tile';
  const { finish, surface } = deriveFinish(it.rawName, it);
  const size = it.size;
  const multiOrigin = (originsByBase.get(base) || new Set()).size > 1;

  // group same design across sizes/finishes/origins, but keep categories separate
  const groupKey = `${normKey(base)}|${category}`;
  let pkey = groupToPkey.get(groupKey);
  if (!pkey) { pkey = pkeyFor(groupKey, base); groupToPkey.set(groupKey, pkey); }

  if (!products.has(pkey)) {
    const multiCat = (catsByBase.get(normKey(base)) || new Set()).size > 1;
    const qualifier = multiCat ? (CAT_QUALIFIER[category] || '') : '';
    products.set(pkey, {
      pkey,
      base,
      name: titleName(base) + qualifier,
      collection: titleName(base) + qualifier,   // each design stands alone (no line grouping on sheet)
      category,
      material: MATERIAL[it.kind] || 'Porcelain',
      look: LOOK[it.kind] || null,
      status: 'active',
      kinds: new Set(),
      origins: new Set(),
      sizes: new Set(),
      sale: false,
      skus: [],
    });
  }
  const p = products.get(pkey);
  p.kinds.add(it.kind);
  p.origins.add(it.origin);
  p.sizes.add(sizeDisp(size));
  if (it.sale) p.sale = true;

  const suffix = suffixFor(pkey, size, finish, surface, it.origin, multiOrigin);
  const variantBits = [sizeDisp(size), finish];
  if (surface) variantBits.push(surface);
  if (multiOrigin) variantBits.push(`Made in ${it.origin}`);

  p.skus.push({
    suffix,
    variant_name: variantBits.join(' · '),
    sell_by: 'box',
    price_basis: 'per_sqft',
    cost: it.price,
    sqft_box: it.sf_box,
    pcs_box: it.pcs_box,
    boxes_pallet: it.boxes_pallet,
    size: sizeAttr(size),
    size_nominal: sizeDisp(size),
    finish,
    surface,
    origin: it.origin,
    kind: it.kind,
    application: it.kind === 'Outdoor/Elevation Tiles' ? 'Outdoor · Facade'
      : it.kind === 'Wall Tiles' ? 'Wall' : 'Floor · Wall',
    _rawName: it.rawName,
    _sizeCode: size,
  });
}

// ==================== 5. attach color + images ====================
const images = {};
const imagesSrc = {};   // local path -> remote url (for the staging step)
let matchedProducts = 0, matchedSkus = 0;

for (const p of products.values()) {
  const nk = normKey(p.base);
  const siteRecs = siteByName.get(nk) || [];
  // color: first non-null site color
  const color = siteRecs.map((r) => r.color).find(Boolean) || null;
  p.color = color;

  if (!siteRecs.length) continue;
  matchedProducts++;
  const im = { product: { primary: null, alternates: [] }, skus: {} };

  // map site records by sizeSlug for per-SKU matching
  const bySizeSlug = new Map();
  for (const r of siteRecs) if (r.img) bySizeSlug.set(r.sizeSlug, r);

  const stage = (remoteUrl, tag) => {
    const local = `/uploads/tileworld/${p.pkey}-${tag}.jpg`;
    imagesSrc[local] = remoteUrl;
    return local;
  };

  // SKU-level images where the site carries that exact size
  for (const s of p.skus) {
    const ss = sizeSlugFor(s._sizeCode);
    const rec = ss && bySizeSlug.get(ss);
    if (rec) {
      im.skus[s.suffix] = { primary: stage(rec.img, s._sizeCode.toLowerCase()), alternates: [] };
      matchedSkus++;
    }
  }
  // product-level primary = first available site image (prefer smallest/most common size)
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
  skus: p.skus.map((s) => {
    const { _rawName, _sizeCode, ...rest } = s;
    return rest;
  }),
}));

const catalog = {
  vendor: {
    name: 'Tile World',
    code: 'TWD',
    website: 'https://tileworldusa.com',
    email: 'Sales@TileWorldUSA.com',
    phone: '714-363-3444',
    address: '1100 E Howell Avenue, Anaheim, CA 92805',
    notes: 'Trade distributor of imported porcelain / ceramic floor, wall & wood-look tile '
      + '(made in India & Spain). Priced from the MAR 2024 price sheet (Roma cost; retail = cost x1.6). FOB Anaheim.',
  },
  brand: { name: 'Tile World', code: 'TWD', website: 'https://tileworldusa.com' },
  markup: 1.6,
  source: 'MAR 2024 price sheet + tileworldusa.com',
  products: productList,
  accessoryProducts: [],
};

fs.writeFileSync(path.join(DIR, 'catalog.json'), JSON.stringify(catalog, null, 2));
fs.writeFileSync(path.join(DIR, 'images.json'), JSON.stringify(images, null, 2));
fs.writeFileSync(path.join(DIR, 'images-src.json'), JSON.stringify(imagesSrc, null, 2));

// ==================== summary ====================
const skuCount = productList.reduce((n, p) => n + p.skus.length, 0);
const byCat = {};
for (const p of productList) byCat[p.category] = (byCat[p.category] || 0) + 1;
console.log('=== Tile World catalog built ===');
console.log(`Items parsed:    ${items.length}`);
console.log(`Products:        ${productList.length}  (${skuCount} SKUs)`);
console.log('By category:    ', byCat);
console.log(`Products w/ photo: ${matchedProducts}  |  SKU-level photos: ${matchedSkus}  |  images to stage: ${Object.keys(imagesSrc).length}`);
console.log(`Products w/ color: ${productList.filter((p) => p.color).length}`);
console.log(`Sale (closeout) products: ${productList.filter((p) => p.sale).length}`);
console.log('\nWrote catalog.json, images.json, images-src.json');
