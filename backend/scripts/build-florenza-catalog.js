#!/usr/bin/env node
/**
 * Build Florenza Ceramic catalog.json + images.json from the May 2026 price list.
 *
 * Florenza Ceramic (1305 N. Knollwood Circle, Anaheim CA — florenzaceramic.com) is a
 * trade distributor carrying a large mixed catalog of imported porcelain / ceramic /
 * quarry tile + matching trim. Onboarded as its own vendor with a single house brand.
 *
 * INPUT
 *   data/florenza/pricelist.txt   — `pdftotext -layout` of the PDF price list. Four
 *                                   column layouts across the doc:
 *     A "main"    Name/Color | Size | $Price | U/M | Sf/Bx | Pc/Bx | Bxs/Plt | Pro/Type | Origin
 *     B "quarry"  Name/Color | $Price | U/M | Size | Sf/Bx | Pc/Bx | Bxs/Plt | Origin   (no type col)
 *     C "special" Name/Color | $Price | U/M | Size | ...  with `Subway Tiles` / `Mosaics` / `Bullnose` subheaders
 *   data/florenza/wc-products.json — WooCommerce Store API dump (172 products, all with photos)
 *
 * MODEL (see [[variant-pill-independence]])
 *   Each distinct color/name is ONE product; its size + finish + surface rows become the
 *   product's SKUs (grouped by a normalized key that strips only finish/structural words,
 *   never color words). Field tile: sell_by 'box', per_sqft. Mosaics: own product,
 *   sell_by 'unit', per_unit, mosaic-tile. Trim (cove base / corner / bullnose / stair
 *   tread / coping / sanitary, plus the whole Bullnose subsection) becomes a separate
 *   accessory product (sell_by 'unit', variant_type 'accessory') that the importer LINKS
 *   to the matching field SKUs via sku_accessories — matched on the same normalized key.
 *
 * PRICING: price list is Roma's COST; retail = cost x1.6 nickel keystone (in importer).
 *
 * Usage: node scripts/build-florenza-catalog.js
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(__dirname, '..', 'data', 'florenza');
const lines = fs.readFileSync(path.join(DIR, 'pricelist.txt'), 'utf8').split(/\r?\n/);

const ORIGINS = new Set(['Indo', 'Spain', 'Italy', 'U.S.A', 'U.S A', 'USA', 'Mexico', 'Mex',
  'Turkey', 'Bulgaria', 'Malaysia', 'China', 'Colombia', 'Portugal', 'India']);
const TYPES = new Set(['Porcelain', 'porcelain', 'Ceramic', 'ceramic', 'Marble']);
const MARKERS = new Set(['New', 'Sbn', 'Msc', 'msc&Sbn', 'msc&Bln', 'B/O', 'B/o', 'b/o', 'Bln', 'msc']);

const SIZE_RE = /\d+(?:\.\d+)?x\d+(?:\.\d+)?(?:x[\d./]+)?/;   // 12x24 · 8.8x8.8 · 6x6x1/2 · 13.39x15.36

// ---- normalization for grouping / matching (strip finish + structural words, KEEP color words) ----
const STOP = new Set([
  // finish
  'polished', 'unpolished', 'matte', 'matt', 'brillo', 'honed', 'semi', 'semipolish',
  'lappato', 'lapp', 'reliave', 'relieve', 'wave', 'glossy', 'gloss', 'antislip', 'grip',
  // structural / accessory / pattern qualifiers
  'smooth', 'abrasive', 'quarry', 'grafilado', 'hexagon', 'hex', 'cove', 'base',
  'inside', 'outside', 'corner', 'left', 'right', 'bullnose', 'stairtread', 'stairthread',
  'stair', 'tread', 'coping', 'pool', 'sanitary', 'edge', 'angle', 'deco', 'paver', '2cm', 'rounded',
  // noise
  'new', 'ch', 'or', 'and', 'the', 'pc', 'full', 'rock', 'x',
]);
function words(s) {
  return s.toLowerCase()
    .replace(/&#\d+;/g, ' ')
    .replace(/[–—]/g, ' ')
    .replace(/gray/g, 'grey')                     // unify gray/grey
    .replace(/[^a-z0-9\s]/g, ' ')                 // drop punctuation
    .replace(/\b\d+(\.\d+)?\b/g, ' ')             // drop bare numbers (sizes leaked into names)
    .split(/\s+/).filter(Boolean);
}
const normKey = (s) => words(s).filter((w) => !STOP.has(w)).join(' ').trim();
// title-case names the price list wrote in ALL CAPS (quarry section) — leave mixed case
// names (e.g. "Trav.", "dRay") untouched.
function titleCaseIfUpper(s) {
  if (!/[a-z]/.test(s.replace(/[^A-Za-z]/g, ''))) {
    return s.toLowerCase().replace(/\b([a-z])/g, (m, c) => c.toUpperCase());
  }
  return s;
}
// Trailing qualifier words that are never part of a color/line name and can be stripped
// from the END of a display name repeatedly. (Grouping is by normKey, independent of this,
// so aggressive display cleanup never merges products.)
const FIELD_TRAIL = 'matte|matt|polished|unpolished|brillo|glossy|gloss|honed|semi|polish|semipolish|lappato|lapp|grafilado|quarry|smooth|abrasive|grip|antislip|reliave|relieve|wave|hexagon|hex|rounded|paver|2cm|deco|or|and';
const ACC_TRAIL = 'inside|outside|left|right|cove|base|corner|bullnose|stair[\\s-]?t(?:h)?read|stairthread|coping|pool|sanitary';
function cleanBase(name, aggressive) {
  let n = name.replace(/\s+(New|Sbn|Msc|msc&Sbn|msc&Bln|B\/O|B\/o|Bln)\s*$/i, '').trim();
  const trail = new RegExp('(?:\\s*[-–]\\s*)?\\s*(?:\\((?:wave|deco)\\)|\\b(?:' + FIELD_TRAIL + (aggressive ? '|' + ACC_TRAIL : '') + ')\\b|&)\\s*$', 'i');
  let prev = null;
  while (prev !== n && n) { prev = n; n = n.replace(trail, '').replace(/[\s&\-–]+$/, '').trim(); }
  return titleCaseIfUpper(n || name);
}
const displayBase = (name) => cleanBase(name, false);
const accBase = (name) => cleanBase(name, true);

// ---- finish / surface extraction (attribute values; original name kept on variant) ----
function extractFinish(name) {
  const s = name.toLowerCase();
  if (/matte or polished|polished or matte|matte & polished/.test(s)) return 'Matte or Polished';
  if (/semi[\s-]?polish/.test(s)) return 'Semi-Polished';
  if (/unpolished/.test(s)) return 'Unpolished';
  if (/polished/.test(s)) return 'Polished';
  if (/lappato|\blapp\b/.test(s)) return 'Lappato';
  if (/honed/.test(s)) return 'Honed';
  if (/matte|matt\b/.test(s)) return 'Matte';
  if (/brillo|glossy|gloss/.test(s)) return 'Gloss';
  if (/reliave|relieve|wave/.test(s)) return 'Relief';
  return null;
}
function extractSurface(name) {
  const s = name.toLowerCase();
  if (/abrasive/.test(s)) return 'Abrasive';
  if (/grafilado/.test(s)) return 'Grafilado (grooved)';
  if (/antislip|\bgrip\b/.test(s)) return 'Anti-slip';
  if (/smooth/.test(s)) return 'Smooth';
  return null;
}
function extractLook(name) {
  const s = name.toLowerCase();
  if (/wengue|hickory|driftwood|cedar|sequoia|homywood|teka|karval|balsa|oak|woodland|fortezza|chestnut/.test(s)) return 'Wood';
  if (/carrara|calacatta|callacatta|statuario|marmo|marmorea|dolomite|crema marfil|bianco river|trav|travert|apuano|torano|lenci|tresana|wells|onyx|venato|venetian|luxury/.test(s)) return 'Marble';
  if (/cement|cemento|concrete|beton|metro|infused|essenza|artstract/.test(s)) return 'Concrete';
  if (/slate|lavagna|piedra|river stone|gravel|quarry|cotto|rustic|heartland|terrace/.test(s)) return 'Stone';
  return null;
}

const isAccessory = (name, uom, section) =>
  section === 'bullnose' || uom === 'EA' || /coping|stair[\s-]?t(?:h)?read|stairthread/i.test(name);

function accessoryLabel(name, size) {
  const s = name.toLowerCase();
  let kind = 'Trim';
  if (/stair[\s-]?t(?:h)?read|stairthread/.test(s)) kind = 'Stair Tread';
  else if (/coping/.test(s)) kind = 'Pool Coping';
  else if (/bullnose/.test(s)) kind = 'Bullnose';
  else if (/inside.*cove|cove.*inside/.test(s)) kind = 'Inside Cove Base';
  else if (/outside.*cove|cove.*outside|left.*cove|right.*cove/.test(s)) kind = 'Outside Cove Base';
  else if (/cove/.test(s)) kind = 'Cove Base';
  else if (/inside.*corner/.test(s)) kind = 'Inside Corner';
  else if (/outside.*corner/.test(s)) kind = 'Outside Corner';
  else if (/left|right/.test(s) && /corner/.test(s)) kind = 'Corner';
  else if (/corner/.test(s)) kind = 'Corner';
  else if (/sanitary/.test(s)) kind = 'Sanitary Cove';
  return size ? `${kind} (${nominalSize(size)})` : kind;
}

// ---- size helpers ----
function nominalSize(size) {
  const parts = size.split('x');
  if (parts.length >= 2) return `${parts[0]}"x${parts[1]}"`;
  return size;
}
function sizeThickness(size) {
  const parts = size.split('x');
  return parts.length === 3 ? parts[2].replace(/[^\d./]/g, '') : null; // "1/2", "3/8"
}
const sizeCompact = (size) => size.replace(/[^0-9a-z]/gi, '').replace(/\./g, '');

// ---- category ----
function categoryFor(rep, kind) {
  if (kind === 'mosaic') return 'mosaic-tile';
  if (kind === 'accessory') {
    if (/stair[\s-]?t(?:h)?read|stairthread/i.test(rep.name)) return 'stair-treads-nosing';
    return 'trim-accessories';
  }
  const t = (rep.type || '').toLowerCase();
  if (t === 'marble') return 'mosaic-tile';
  return t === 'ceramic' ? 'ceramic-tile' : 'porcelain-tile';
}

// ======================= PARSE =======================
let section = null;         // 'main' | 'quarry' | 'special'
let sub = null;             // for special: 'subway' | 'mosaic' | 'bullnose'
const rows = [];
const failed = [];

function stripTrailingMarkers(name) {
  const found = [];
  let n = name.trim();
  let m = true;
  while (m) {
    m = false;
    const t = n.match(/(.*?)\s+(msc&Sbn|msc&Bln|B\/O|B\/o|New|Sbn|Msc|Bln)\s*$/);
    if (t) { found.push(t[2]); n = t[1].trim(); m = true; }
  }
  return { name: n, markers: found };
}

function parseTail(tail) {
  // tail = the middle+type+origin part; returns {nums:[], type, origin}
  let toks = tail.trim().split(/\s+/);
  // origin can be two words: "U.S A"
  let origin = toks.pop();
  if (toks.length && (toks[toks.length - 1] === 'U.S' || (origin === 'A' && toks[toks.length - 1].endsWith('.S')))) {
    origin = toks.pop() + ' ' + origin;
  }
  let type = null;
  if (toks.length && TYPES.has(toks[toks.length - 1])) type = toks.pop();
  const nums = toks; // remaining numeric-ish columns
  return { nums, type, origin };
}

for (let raw of lines) {
  const line = raw.replace(/\s+$/,'');
  const t = line.trim();
  if (!t) continue;
  // header / section detection
  if (/Name\/Color\s+Size\s+Price/i.test(t)) { section = 'main'; sub = null; continue; }
  // special header must be tested BEFORE quarry — it also starts "Name/Color Price U/M Size"
  // but is the only non-main header carrying a Pro/Type column.
  if (/Name\/Color\s+Price.*Pro\/?Type/i.test(t)) { section = 'special'; sub = null; continue; }
  if (/Name\/Color\s+Price\s+U\/M\s+Size/i.test(t)) { section = 'quarry'; sub = null; continue; }
  if (section === 'special') {
    if (/^Subway Tiles$/i.test(t)) { sub = 'subway'; continue; }
    if (/^Mosaics$/i.test(t)) { sub = 'mosaic'; continue; }
    if (/^Bullnose$/i.test(t)) { sub = 'bullnose'; continue; }
  }
  // skip boilerplate
  if (/^Florenza Ceramic/i.test(t) || /Knollwood|Phone:|Website:|Fax:|FOB Anaheim/i.test(t)) continue;
  if (!section) continue;                       // still in terms/care pages
  if (!/\$/.test(t)) continue;                  // data rows all have a price

  try {
    let name, size, price, uom, tailStr, type, origin, nums;
    if (section === 'main') {
      // Name | Size | $Price | U/M | <nums> | Type | Origin
      const m = t.match(new RegExp('^(.*?)\\s+(' + SIZE_RE.source + ')\\s+\\$\\s*([\\d.]+)\\s+(SF|Pc|PC|EA)\\s+(.*)$'));
      if (!m) { failed.push([section, t]); continue; }
      name = m[1]; size = m[2]; price = m[3]; uom = m[4].toUpperCase();
      ({ nums, type, origin } = parseTail(m[5]));
    } else {
      // quarry & special: Name | $Price | [U/M] | Size | <nums> [| Type] | Origin
      // U/M is occasionally blank; size can be malformed (e.g. "1x4.x1/2", "6x4/5x1/2").
      const LOOSE_SIZE = '\\d[\\d.]*x[\\d.][\\dx.\\/]*';
      const m = t.match(new RegExp('^(.*?)\\s+\\$\\s*([\\d.]+)\\s+(?:(SF|Pc|PC|EA)\\s+)?(' + LOOSE_SIZE + ')\\s+(.*)$'));
      if (!m) { failed.push([section, t]); continue; }
      name = m[1]; price = m[2]; uom = (m[3] || '').toUpperCase(); size = m[4];
      ({ nums, type, origin } = parseTail(m[5]));
      if (!uom) uom = (nums.filter((x) => /\d/.test(x)).length >= 3) ? 'SF' : 'EA';  // infer blank U/M
      if (!type && section === 'special') type = 'Porcelain';
    }
    if (!origin || (!ORIGINS.has(origin) && !/^U\.?S/i.test(origin) && !/Mex|Indo|Spain|Italy|China|India|Turkey|Bulgaria|Malaysia|Colombia|Portugal/i.test(origin))) {
      // origin didn't validate — keep whatever we got but flag lightly
    }
    const mk = stripTrailingMarkers(name);
    name = mk.name;
    // strip the leading "(2x2)" style size tag mosaics carry, keep for label
    let mosaicTag = null;
    const mt = name.match(/^\((\d+x\d+)\)\s*/);
    if (mt) { mosaicTag = mt[1]; name = name.replace(/^\(\d+x\d+\)\s*/, '').trim(); }

    // numeric columns: interpret positionally by section/uom
    const nn = nums.map((x) => x.replace(/[^\d.]/g, '')).filter((x) => x !== '');
    let sqft_box = null, pcs_box = null, boxes_pallet = null;
    if (section === 'main' || sub === 'subway') {
      // Sf/Bx Pc/Bx Bxs/Plt  (SF rows). Pc rows (stair tread) -> just pieces.
      if (uom === 'SF') { [sqft_box, pcs_box, boxes_pallet] = nn; }
      else { pcs_box = nn[0]; boxes_pallet = nn[1]; }
    } else if (sub === 'mosaic' || sub === 'bullnose') {
      // Sf/Bx literally "Pc"/"pc"; the numeric left is sheets/pcs per box
      pcs_box = nn[0]; boxes_pallet = nn[1];
    } else { // quarry
      if (uom === 'SF') { [sqft_box, pcs_box, boxes_pallet] = nn; }
      else { pcs_box = nn[0]; boxes_pallet = nn[1]; }
    }

    const acc = isAccessory(name, uom, sub);
    rows.push({
      section, sub, name, size, cost: parseFloat(price), uom,
      sqft_box: num(sqft_box), pcs_box: num(pcs_box), boxes_pallet: num(boxes_pallet),
      type: type || (section === 'quarry' ? inferQuarryType(name) : 'Porcelain'),
      origin: cleanOrigin(origin), markers: mk.markers, mosaicTag,
      is_accessory: acc,
    });
  } catch (e) {
    failed.push([section, t, e.message]);
  }
}

function num(x) { const v = parseFloat(x); return Number.isFinite(v) ? v : null; }
function inferQuarryType(name) { return /ceramic/i.test(name) ? 'Ceramic' : 'Porcelain'; }
function cleanOrigin(o) {
  if (!o) return null;
  o = o.replace(/\s+/g, ' ').trim();
  const map = { 'U.S A': 'USA', 'U.S.A': 'USA', 'U.S': 'USA', 'Mex': 'Mexico', 'Indo': 'Indonesia', 'porcelain': null };
  return map[o] !== undefined ? map[o] : o;
}

// ======================= GROUP =======================
// key -> product bucket, separately for field / accessory / mosaic
function bucketKey(r) { return normKey(r.name) || r.name.toLowerCase(); }

const fieldGroups = new Map();
const accGroups = new Map();
const mosaicGroups = new Map();

for (const r of rows) {
  const key = bucketKey(r);
  const target = r.section === 'special' && r.sub === 'mosaic' ? mosaicGroups
    : r.is_accessory ? accGroups : fieldGroups;
  if (!target.has(key)) target.set(key, []);
  target.get(key).push(r);
}

// pick a clean product display name for a group
function groupName(members, kind) {
  const fn = kind === 'accessory' ? accBase : displayBase;
  const bases = members.map((m) => fn(m.name));
  bases.sort((a, b) => a.length - b.length);
  return bases[0];
}

const usedInternal = new Set();
function mkInternal(base) {
  let s = 'FLZ-' + base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  let cand = s, i = 2;
  while (usedInternal.has(cand)) cand = `${s}-${i++}`;
  usedInternal.add(cand);
  return cand;
}

function buildSkus(members, kind) {
  const seen = new Set();
  const skus = [];
  for (const r of members) {
    const finish = extractFinish(r.name);
    const surface = extractSurface(r.name);
    const th = sizeThickness(r.size);
    let variantBits = [];
    if (kind === 'accessory') variantBits.push(accessoryLabel(r.name, r.size));
    else {
      variantBits.push(nominalSize(r.size));
      if (finish && finish !== 'Matte or Polished') variantBits.push(finish);
      else if (finish) variantBits.push(finish);
      if (surface) variantBits.push(surface);
    }
    const variant = variantBits.join(' · ');
    // suffix must be unique per SKU within a product (it keys pricing/media). Accessory SKUs
    // of the same size/finish differ only by trim kind (bullnose vs cove vs corner), so key
    // accessories by their label; field/mosaic by size+finish+surface.
    const suffix = kind === 'accessory'
      ? slug(accessoryLabel(r.name, r.size)) || `${sizeCompact(r.size)}-ea`
      : [sizeCompact(r.size), finish && slug(finish), surface && slug(surface)].filter(Boolean).join('-');
    let dedup = `${suffix}|${variant}`;
    if (seen.has(dedup)) continue;               // exact duplicate row
    seen.add(dedup);
    skus.push({
      variant_name: variant,
      size: r.size,
      size_nominal: nominalSize(r.size),
      thickness: th ? `${th}"` : null,
      finish, surface,
      cost: r.cost,
      uom: r.uom,
      sqft_box: r.sqft_box, pcs_box: r.pcs_box, boxes_pallet: r.boxes_pallet,
      type: r.type, origin: r.origin,
      sell_by: (kind === 'field') ? 'box' : 'unit',
      price_basis: (kind === 'field') ? 'per_sqft' : 'per_unit',
      variant_type: (kind === 'accessory') ? 'accessory' : null,
      accessory_label: (kind === 'accessory') ? accessoryLabel(r.name, r.size) : null,
      suffix,
    });
  }
  return skus;
}
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

function makeProduct(key, members, kind) {
  const base = groupName(members, kind);
  const name = kind === 'accessory' ? `${base} Trim` : kind === 'mosaic' ? `${base} Mosaic` : base;
  const skus = buildSkus(members, kind);
  const rep = { ...members[0], type: skusDominantType(skus) };
  const cat = categoryFor(rep, kind);
  return {
    pkey: mkInternal(name),
    key, kind, name, collection: base,
    category: cat,
    material: skusDominantType(skus),
    look: extractLook(base),
    origin: rep.origin,
    origins: [...new Set(skus.map((s) => s.origin).filter(Boolean))],
    status: 'active',
    skus,
  };
}
function skusDominantType(skus) {
  const t = skus.map((s) => s.type).filter(Boolean);
  if (t.some((x) => /marble/i.test(x))) return 'Marble';
  if (t.some((x) => /ceramic/i.test(x))) return t.every((x) => /ceramic/i.test(x)) ? 'Ceramic' : 'Porcelain';
  return 'Porcelain';
}

const products = [];
for (const [key, members] of fieldGroups) products.push(makeProduct(key, members, 'field'));
for (const [key, members] of mosaicGroups) products.push(makeProduct(key, members, 'mosaic'));
const accessoryProducts = [];
for (const [key, members] of accGroups) accessoryProducts.push(makeProduct(key, members, 'accessory'));

// ---- accessory -> field link map (same normalized key) ----
const fieldByKey = new Map(products.filter((p) => p.kind === 'field').map((p) => [p.key, p]));
let linked = 0, unlinked = 0;
for (const ap of accessoryProducts) {
  const fp = fieldByKey.get(ap.key);
  ap.attach_to = fp ? [fp.pkey] : [];
  if (fp) { linked++; ap.collection = fp.name; ap.name = `${fp.name} Trim`; }  // inherit the clean field-line name
  else unlinked++;
}

// ---- collections: group product families so colors of one line share a collection ----
// The storefront renders same-collection + same-category products as a color-swatch grid on
// the PDP (collection_siblings) and lists collections on the shop page. A product's own name
// was being used as its collection, which grouped nothing. Group by name stem (name minus the
// trailing color word); a stem shared by >=2 products becomes the collection, singletons keep
// their full name. Each product also gets a `color` attribute = the distinguishing word(s).
const famBase = (p) => (p.kind === 'mosaic' ? p.name.replace(/\s+Mosaic$/i, '').trim() : p.name);
const stemOf = (name) => { const w = name.split(/\s+/); return w.length > 1 ? w.slice(0, -1).join(' ') : name; };
{
  const groups = new Map();   // stem(lower) -> { label, items }
  for (const p of products.filter((x) => x.kind === 'field' || x.kind === 'mosaic')) {
    const st = stemOf(famBase(p)), k = st.toLowerCase();
    if (!groups.has(k)) groups.set(k, { label: st, items: [] });
    groups.get(k).items.push(p);
  }
  for (const { label, items } of groups.values()) {
    if (items.length >= 2) for (const p of items) p.collection = label;
    else items[0].collection = famBase(items[0]);            // singleton keeps its own line name
  }
  // accessories inherit the linked field line's collection (else keep their cleaned base)
  const byPkey = new Map(products.map((p) => [p.pkey, p]));
  for (const ap of accessoryProducts) {
    const fp = (ap.attach_to || []).map((k) => byPkey.get(k)).find(Boolean);
    if (fp) ap.collection = fp.collection;
  }
  // color attribute = the part of the name beyond the collection stem (field/mosaic only)
  for (const p of [...products, ...accessoryProducts]) {
    p.color = null;
    if (p.kind === 'accessory') continue;
    const nm = famBase(p), coll = p.collection || '';
    if (coll && nm.length > coll.length && nm.toLowerCase().startsWith(coll.toLowerCase())) {
      p.color = nm.slice(coll.length).replace(/^[\s.,\-–]+/, '').trim() || null;
    }
  }
}

// ---- safety: guarantee (collection, name) is unique so the importer's upsert never
// clobbers a distinct product. Disambiguate rare collisions with the size/thickness. ----
{
  const seen = new Map();
  for (const p of [...products, ...accessoryProducts]) {
    let k = `${p.collection}||${p.name}`;
    if (seen.has(k)) {
      const dim = (p.skus[0] && (p.skus[0].thickness || p.skus[0].size_nominal)) || String(seen.get(k) + 1);
      p.name = `${p.name} (${dim})`;
      k = `${p.collection}||${p.name}`;
      let i = 2; while (seen.has(k)) { p.name = `${p.name} ${i++}`; k = `${p.collection}||${p.name}`; }
    }
    seen.set(k, (seen.get(k) || 0) + 1);
  }
}

// ======================= IMAGES (WooCommerce, matched PER SKU) =======================
// The store's image FILENAMES encode color/size/surface/finish/accessory (e.g.
// "Sahara-Sand-Smooth-6x6-1.jpg", "SPANISH-RED-COVE-QUARRY-6x6-1.jpg", "Durango-Taupe.jpg").
// We gather each catalog product's candidate images from same-line store products, gate them
// by (a) store category vs product kind, (b) the color that distinguishes this product inside
// a multi-color store bundle, (c) accessory-token vs field, then score each image against each
// SKU by shared size/surface/finish/accessory tokens and attach it to the best SKU.
const wc = JSON.parse(fs.readFileSync(path.join(DIR, 'wc-products.json'), 'utf8'));

const SURF_TOK = ['grafilado', 'abrasive', 'smooth', 'grip', 'antislip'];
const FIN_TOK = ['unpolished', 'polished', 'matte', 'brillo', 'glossy', 'gloss', 'honed', 'lappato', 'lapp', 'semipolish'];
const ACC_TOK = { cove: 'cove', base: 'cove', bullnose: 'bullnose', corner: 'corner', coping: 'coping', stairtread: 'stair', stairthread: 'stair', stair: 'stair', tread: 'stair', sanitary: 'sanitary' };
const catClass = (cats) => (cats || []).some((c) => /mosaic/i.test(c)) ? 'mosaic' : (cats || []).some((c) => /quarry/i.test(c)) ? 'quarry' : 'tile';

function parseImg(url) {
  let fn = url.split('/').pop();
  fn = fn.replace(/\.(jpe?g|png|webp)$/i, '').replace(/-scaled\b/i, '');
  const sizes = (fn.match(/\d{1,2}(?:\.\d+)?x\d{1,2}(?:\.\d+)?/g) || []).map((s) => s.toLowerCase());
  const w = fn.toLowerCase().replace(/[_\-]+/g, ' ')
    .replace(/\b(e\d{6,}|[a-z0-9]{12,})\b/g, ' ')          // wordpress hash suffixes
    .replace(/\d{1,2}(?:\.\d+)?x\d{1,2}(?:\.\d+)?/g, ' ')  // strip sizes from word list
    .split(/\s+/).filter(Boolean);
  const wset = new Set(w);
  const surfaces = SURF_TOK.filter((t) => wset.has(t));
  const finishes = FIN_TOK.filter((t) => wset.has(t));
  let accKind = null;
  for (const [t, k] of Object.entries(ACC_TOK)) if (wset.has(t)) { accKind = k; break; }
  return { url, sizes: new Set(sizes), surfaces: new Set(surfaces), finishes: new Set(finishes), accKind, words: wset };
}

const pool = [];   // { key, keyWords:Set, cls, imgs:[parsed] }
for (const p of wc) {
  const key = normKey(p.name.replace(/&#\d+;/g, ' '));
  const imgs = (p.images || []).map((i) => i.src).filter(Boolean).map(parseImg);
  if (!imgs.length) continue;
  pool.push({ key, keyWords: new Set(key.split(' ').filter(Boolean)), cls: catClass((p.categories || []).map((c) => c.name)), imgs });
}
const keyMatch = (a, b) => a === b || a.startsWith(b + ' ') || b.startsWith(a + ' ');
const catAligned = (kind, cls) => kind === 'mosaic' ? cls === 'mosaic' : cls !== 'mosaic';
const size2 = (s) => s.split('x').slice(0, 2).join('x').toLowerCase();
function accKindOf(sku) {
  const s = (sku.accessory_label || '').toLowerCase();
  if (/stair/.test(s)) return 'stair'; if (/coping/.test(s)) return 'coping';
  if (/bullnose/.test(s)) return 'bullnose'; if (/corner/.test(s)) return 'corner';
  if (/cove|base/.test(s)) return 'cove'; if (/sanitary/.test(s)) return 'sanitary';
  return null;
}
function score(img, sku, kind) {
  let sc = 0;
  if (img.sizes.has(size2(sku.size))) sc += 10;
  if (sku.surface && img.surfaces.has(slug(sku.surface))) sc += 4;
  if (sku.finish) { const f = sku.finish.toLowerCase(); if ([...img.finishes].some((t) => f.includes(t) || t.includes(f.split(' ')[0]))) sc += 4; }
  if (kind === 'accessory' && img.accKind && img.accKind === accKindOf(sku)) sc += 6;
  return sc;
}

const images = {};
let withImg = 0, skuMatched = 0;
for (const p of [...products, ...accessoryProducts]) {
  // candidate images: same-line store products, category-aligned, color-distinguished, acc-gated
  const cand = [];
  const pWords = p.key.split(' ').filter(Boolean);
  for (const s of pool) {
    if (!keyMatch(p.key, s.key) || !catAligned(p.kind, s.cls)) continue;
    const dist = pWords.filter((w) => !s.keyWords.has(w));   // color that distinguishes p inside s's bundle
    for (const img of s.imgs) {
      if (dist.length && !dist.some((w) => img.words.has(w))) continue;          // wrong sibling color
      const wantsAcc = p.kind === 'accessory';
      if (wantsAcc !== !!img.accKind) continue;                                  // field imgs ↔ field skus; acc imgs ↔ acc skus
      if (!cand.some((c) => c.url === img.url)) cand.push(img);
    }
  }
  if (!cand.length) continue;
  withImg++;

  // assign each candidate image to its best-scoring SKU
  const bySku = new Map();         // suffix -> [{url, sc}]
  const generic = [];
  for (const img of cand) {
    let best = null, bestSc = 0;
    for (const sku of p.skus) { const sc = score(img, sku, p.kind); if (sc > bestSc) { bestSc = sc; best = sku; } }
    if (best) { if (!bySku.has(best.suffix)) bySku.set(best.suffix, []); bySku.get(best.suffix).push({ url: img.url, sc: bestSc }); }
    else generic.push(img.url);
  }
  const skusOut = {};
  for (const [suf, arr] of bySku) {
    arr.sort((a, b) => b.sc - a.sc);
    const urls = [...new Set(arr.map((a) => a.url))];
    skusOut[suf] = { primary: urls[0], alternates: urls.slice(1, 7) };
    skuMatched++;
  }
  // product-level fallback (browse grid / SKUs with no own image): prefer a generic image,
  // else reuse the first candidate so every product still has a hero.
  const prodPrimary = generic[0] || cand[0].url;
  const prodAlts = [...new Set([...generic.slice(1), ...cand.map((c) => c.url)])].filter((u) => u !== prodPrimary).slice(0, 6);
  images[p.pkey] = { product: { primary: prodPrimary, alternates: prodAlts }, skus: skusOut };
}

// ======================= EMIT =======================
const catalog = {
  vendor: {
    name: 'Florenza Ceramic', code: 'FLZ',
    website: 'https://florenzaceramic.com',
    email: 'Order@florenzaceramic.com', phone: '(714) 772-7800',
    address: '1305 N. Knollwood Circle, Anaheim, CA 92801',
    notes: 'Trade tile distributor (Anaheim, CA). Imported porcelain / ceramic / quarry tile + trim. Price list = Roma cost; retail = cost x1.6 keystone. FOB Anaheim warehouse. info@florenzaceramic.com / PO to Order@florenzaceramic.com.',
  },
  brand: { name: 'Florenza Ceramic', code: 'FLZ', website: 'https://florenzaceramic.com' },
  markup: 1.6,
  products,
  accessoryProducts,
};
fs.writeFileSync(path.join(DIR, 'catalog.json'), JSON.stringify(catalog, null, 2));
fs.writeFileSync(path.join(DIR, 'images.json'), JSON.stringify(images, null, 2));

// ======================= REPORT =======================
const fieldP = products.filter((p) => p.kind === 'field');
const mosaicP = products.filter((p) => p.kind === 'mosaic');
const skuCount = (arr) => arr.reduce((a, p) => a + p.skus.length, 0);
console.log('=== Florenza build ===');
console.log(`rows parsed: ${rows.length}   failed lines: ${failed.length}`);
console.log(`field products:     ${fieldP.length}  (${skuCount(fieldP)} skus)`);
console.log(`mosaic products:    ${mosaicP.length}  (${skuCount(mosaicP)} skus)`);
console.log(`accessory products: ${accessoryProducts.length}  (${skuCount(accessoryProducts)} skus)`);
console.log(`  linked to a field line: ${linked}   standalone: ${unlinked}`);
{
  const colls = new Map();
  for (const p of [...products, ...accessoryProducts]) colls.set(p.collection, (colls.get(p.collection) || 0) + 1);
  const multi = [...colls.values()].filter((n) => n >= 2).length;
  console.log(`collections: ${colls.size} (${multi} with >=2 products), e.g. ` +
    [...colls.entries()].filter(([, n]) => n >= 3).slice(0, 6).map(([c, n]) => `${c}(${n})`).join(', '));
}
console.log(`products with >=1 photo: ${withImg} / ${products.length + accessoryProducts.length}   (SKU-specific image matches: ${skuMatched})`);
const cats = {};
for (const p of [...products, ...accessoryProducts]) cats[p.category] = (cats[p.category] || 0) + 1;
console.log('categories:', cats);
if (failed.length) {
  console.log('\n--- FAILED LINES ---');
  for (const f of failed.slice(0, 40)) console.log(f[0], '|', f[1]);
}
