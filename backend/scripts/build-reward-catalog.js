#!/usr/bin/env node
/**
 * Build the Reward Flooring catalog.json + images.json.
 *
 * Reward Flooring is onboarded as a BRAND (code REWARD) under the existing
 * Galleher Duffy vendor (code GALL) — Reward is Galleher's proprietary hardwood
 * line, sourced through Roma's Galleher Duffy dealer account. Mirrors the Monarch
 * onboarding. See [[monarch-onboarding]], [[vendor-sub-brands]].
 *
 * Sources (backend/data/reward/):
 *   reward-public-raw.json  — 106 planks / 13 collections from rewardflooring.com
 *                             Shopify feed (specs + images). product.sku = REW code.
 *   galleher-planks.tsv      — 109 planks: itemCode|cost|name (per-COLOR dealer cost)
 *   galleher-accessories.tsv — 427 moldings: itemCode|cost|name
 *
 * Planks are joined public<->Galleher by the REW item code (exact). Galleher has a
 * "Sereno" collection (White Oak) not on the public site — added imageless from the
 * TSV. Retail = cost x 1.6 nickel-rounded (keystone). Sold per sqft by the box.
 *
 * Accessories grouped into "{Collection} Trims", linked to their plank by base color
 * + species (herringbone base-color links both straight & herringbone). Reward names
 * moldings by species+color (e.g. "Reducer White Oak Butler"); Castillo's species is
 * "Arborea". Store molding color under matching_color (NOT color) — the storefront
 * gates accessories on parent.color==accessory.color. See [[monarch-onboarding]].
 *
 * Usage: node scripts/build-reward-catalog.js
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, '..', 'data', 'reward');
const raw = JSON.parse(fs.readFileSync(path.join(DATA, 'reward-public-raw.json'), 'utf8'));

const slug = (s) => String(s).toLowerCase().replace(/['".]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const titleCase = (s) => s.replace(/\w\S*/g, (t) => t.charAt(0).toUpperCase() + t.slice(1).toLowerCase());
const clean = (s) => (s || '').replace(/[”“]/g, '"').replace(/\s+/g, ' ').trim();
const keystone = (cost) => parseFloat((Math.round(cost * 1.6 / 0.05) * 0.05).toFixed(2));

// species phrases (multi-word first) used to strip species from a color label
const SPECIES = ['european oak', 'euro oak', 'white oak', 'red oak', 'walnut', 'hickory', 'maple', 'arborea'];
const normSku = (s) => (s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
function stripSpecies(s) {
  let t = s;
  for (const sp of SPECIES) { const re = new RegExp(`^${sp}\\s+`, 'i'); if (re.test(t)) { t = t.replace(re, ''); break; } }
  return t;
}

// ---- Galleher per-color cost, keyed by REW item code ----
function loadTsv(file) {
  return fs.readFileSync(path.join(DATA, file), 'utf8').trim().split('\n').map((l) => {
    const [code, price, name] = l.split('|');
    return { code, cost: parseFloat(price) > 0 ? parseFloat(price) : null, name: clean(name) };
  });
}
const gPlanks = loadTsv('galleher-planks.tsv');

// Map a Galleher plank name -> public collection, dims, species, species-stripped color.
const GCOL = [['Provence III Herringbone', 'Provence III'], ['Provence III', 'Provence III'],
  ['Heritage Solid', 'Heritage'], ['Camino II', 'Camino II'], ['El Paso', 'El Paso'],
  ['Mill Creek', 'Mill Creek'], ['Sereno', 'Sereno'], ['Sylvania', 'Sylvania'], ['Urbano', 'Urbano'],
  ['Castillo', 'Castillo'], ['Terreno', 'Terreno'], ['Avalon', 'Avalon'], ['Islands', 'Islands'],
  ['Europa', 'Europa'], ['Costa', 'Costa']];
const COLL_SPECIES = { Islands: 'European Oak', Castillo: 'Arborea', Sereno: 'White Oak',
  Costa: 'European Oak', Terreno: 'European Oak', Urbano: 'European Oak', 'Mill Creek': 'European Oak',
  Europa: 'European Oak', 'El Paso': 'Hickory', Avalon: 'European Oak', Sylvania: 'White Oak',
  'Camino II': 'Maple', 'Provence III': 'European Oak', Heritage: 'Red Oak' };
function parseGalleher(g) {
  let pub = null, rest = g.name;
  for (const [gc, p] of GCOL) if (g.name.toLowerCase().startsWith(gc.toLowerCase())) { pub = p; rest = g.name.slice(gc.length).trim(); break; }
  const m = rest.match(/^([\d/]+)"?\s*X\s*([\d/-]+)"?(?:\s*X\s*[\d/-]+"?)?\s*(.*)$/i);
  const thickness = m ? m[1] : '', width = m ? m[2] : '';
  let color = clean(m ? m[3] : rest), species = null;
  for (const sp of SPECIES) { const re = new RegExp(`^${sp}\\s+`, 'i'); if (re.test(color)) { species = titleCase(sp); color = clean(color.replace(re, '')); break; } }
  return { pub, thickness, width, color, species };
}
const gParsed = gPlanks.map((g) => ({ ...g, ...parseGalleher(g) }));
const gByNorm = new Map(gParsed.map((g) => [normSku(g.code), g]));
const gByName = new Map();
for (const g of gParsed) if (g.pub) gByName.set(`${g.pub}|${g.width}|${slug(g.color.toLowerCase())}`, g);
const consumed = new Set();
// Match a public plank to its Galleher row (normalized SKU first, then name), marking
// the Galleher row consumed so leftovers can be added as imageless products afterward.
function matchGalleher(sku, collection, width, shortColorSlug) {
  let g = gByNorm.get(normSku(sku)) || gByName.get(`${collection}|${width}|${shortColorSlug}`);
  if (g) consumed.add(g.code);
  return g;
}

// ---- Carton SF per collection|width (manufacturer spec sheets) ----

// ---- Per-collection spec-sheet PDF (rewardflooring.com /pages/specifications,
//      Shopify CDN) → attached to each product as spec_pdf documentation. ----
const CDN = 'https://cdn.shopify.com/s/files/1/0021/4502/6101/files/';
const SPEC_PDF = {
  Avalon: 'Avalon_Spec_Sheet_9.24.pdf?v=1727201175',
  'Camino II': 'Camino_II_Spec_Sheet_0624_dd1645ca-6c0f-444d-86d9-e8ec65e53d61.pdf?v=1718812423',
  Castillo: 'Castillo_Spec_Sheet_0924.pdf?v=1727201784',
  Costa: 'Costa_Spec_Sheet_0624_b5116f5e-48f5-48c6-b653-3d4f9cc93bc4.pdf?v=1718827046',
  'El Paso': 'El_Paso_Spec_Sheet_0924.pdf?v=1727202185',
  Europa: 'Europa_Spec_Sheet_0624_1abc59b9-d4b5-4761-809a-8a97fcec6c4c.pdf?v=1718827867',
  Heritage: 'Heritage_Spec_Sheet_1224.pdf?v=1733273968',
  Islands: 'Islands_0924.pdf?v=1727197775',
  'Mill Creek': 'Mill_Creek_Spec_Sheet_0624_8a09a7b2-4078-40f4-98ea-4dedab88f5ef.pdf?v=1718830574',
  'Provence III': 'Provence_III_Spec_Sheet_15b29e1e-57af-4792-8413-aa37cc82608e.pdf?v=1718831364',
  Sereno: 'Sereno_Spec_Sheet_0624_21a230cc-98d5-41bb-baa8-bc8f492675aa.pdf?v=1718831389',
  Sylvania: 'Sylvania_Spec_Sheet_0624_a884f038-ef0b-4189-8a01-ccfbb18ba84c.pdf?v=1718831591',
  Terreno: 'Terreno_Spec_Sheet_0624_85bd2fd8-33dc-41bd-9ab8-1b896602d8c9.pdf?v=1718831918',
  Urbano: 'Urbano_Spec_Sheet_0225.pdf?v=1738624081',
};
const specPdfOf = (collection) => (SPEC_PDF[collection] ? CDN + SPEC_PDF[collection] : null);

// ---- Carton SF per collection|width (manufacturer spec sheets) ----
const CARTON_SF = {
  'Avalon|7-1/2': 25.77, 'Provence III|7-1/2': 31.08, 'Provence III|4-3/4': 16.02,
  'Urbano|9-1/2': 34.10, 'Heritage|3-1/4': 20.00, 'Heritage|2-1/4': 20.00, 'Europa|5-1/2': 32.93,
  'Terreno|9-1/2': 34.10, 'Mill Creek|7-1/2': 31.09, 'Sylvania|7': 24.50, 'Costa|7-1/2': 31.09,
  'Castillo|6-1/2': 43.33, 'Islands|7-1/2': 34.36, 'El Paso|5': 33.36, 'Camino II|5': 24.61,
  'Sereno|7-1/2': 31.11,
};
function cartonOf(collection, width) { return CARTON_SF[`${collection}|${width}`] ?? null; }

// ==================== Planks ====================
const products = [];
const images = {};
const colorIndex = []; // { collection, internal_sku, speciesNorm, baseShort }
const usedInternal = new Set();

for (const col of raw.collections) {
  const collection = col.name.trim();
  // detect colliding short-colors within the collection (e.g. Heritage "Natural")
  const shortCount = {};
  for (const p of col.products) {
    const ac = clean(clean(p.name).replace(new RegExp(`^${collection}\\s+`, 'i'), '').replace(/\s+in\.?\s*$/i, ''));
    const short = clean(stripSpecies(ac)).toLowerCase();
    shortCount[short] = (shortCount[short] || 0) + 1;
  }

  for (const p of col.products) {
    const afterColl = clean(clean(p.name).replace(new RegExp(`^${collection}\\s+`, 'i'), '').replace(/\s+in\.?\s*$/i, ''));
    const shortColor = titleCase(clean(stripSpecies(afterColl)));
    const fullColor = titleCase(afterColl);
    // use the short color unless it collides within the collection (then keep species)
    const displayColor = shortCount[shortColor.toLowerCase()] > 1 ? fullColor : shortColor;

    const width = clean(p.width).replace(/"/g, '');
    const thickness = clean(p.thickness).replace(/"/g, '');
    const g = matchGalleher(p.sku, collection, width, slug(stripSpecies(afterColl.toLowerCase())));
    const cost = g ? g.cost : null;
    let internal_sku = `REW-${slug(collection)}-${slug(displayColor)}`;
    if (usedInternal.has(internal_sku)) internal_sku = `REW-${slug(collection)}-${slug(fullColor)}-${slug(p.sku || (g && g.code) || '')}`;
    usedInternal.add(internal_sku);
    const size = [thickness, width].filter(Boolean).map((x) => `${x}"`).join(' x ');

    const sku = {
      vendor_sku: p.sku || (g && g.code) || internal_sku, internal_sku,
      variant_name: width ? `${width}"` : 'Plank',
      color: displayColor, collection, species: p.species || null,
      finish: clean(p.finish) || null, surface_texture: clean(p.texture) || null,
      construction: p.construction || 'engineered', grade: clean(p.grade) || null,
      edge: clean(p.edge) || null, wear_layer: clean(p.wear_layer) || null,
      thickness, width, size, length: clean(p.length) || null,
      cost, sqft_box: cartonOf(collection, width),
      status: cost == null ? 'draft' : 'active',
    };
    products.push({ name: displayColor, collection, species: p.species || 'European Oak', status: sku.status, spec_pdf: specPdfOf(collection), skus: [sku] });
    if (p.images && p.images.length) images[internal_sku] = { primary: p.images[0], lifestyle: p.images.slice(1) };

    const baseShort = displayColor.toLowerCase().replace(/\s+herringbone$/, '');
    colorIndex.push({ collection, internal_sku, speciesNorm: (p.species || '').toLowerCase(), baseShort });
  }
}

// ---- Galleher-only planks (not on the public site, e.g. Sereno, plus discontinued
//      colors Galleher still stocks): add imageless so their trims can link + they're
//      buyable. Cost from the TSV; species parsed from the name or the collection default.
for (const g of gParsed) {
  if (consumed.has(g.code) || !g.pub) continue;
  const collection = g.pub;
  const species = g.species || COLL_SPECIES[collection] || 'European Oak';
  const color = titleCase(g.color);
  let internal_sku = `REW-${slug(collection)}-${slug(color)}`;
  if (usedInternal.has(internal_sku)) internal_sku += `-${slug(g.code)}`;
  usedInternal.add(internal_sku);
  const sku = {
    vendor_sku: g.code, internal_sku, variant_name: g.width ? `${g.width}"` : 'Plank', color, collection,
    species, finish: null, surface_texture: null, construction: /solid/i.test(g.name) ? 'solid' : 'engineered',
    grade: null, edge: null, wear_layer: null, thickness: g.thickness, width: g.width,
    size: [g.thickness, g.width].filter(Boolean).map((x) => `${x}"`).join(' x '), length: null,
    cost: g.cost, sqft_box: cartonOf(collection, g.width), status: g.cost == null ? 'draft' : 'active',
  };
  products.push({ name: color, collection, species, status: sku.status, spec_pdf: specPdfOf(collection), skus: [sku] });
  colorIndex.push({ collection, internal_sku, speciesNorm: species.toLowerCase(), baseShort: color.toLowerCase().replace(/\s+herringbone$/, '') });
}

// ==================== Accessories ====================
const acc = loadTsv('galleher-accessories.tsv');
const accessories = [];

function typeOf(name) {
  if (/square stair ?nos/i.test(name)) return 'Square Stair Nose';
  if (/stair ?nos/i.test(name)) return 'Stair Nose';
  if (/t-?mold/i.test(name)) return 'T-Molding';
  if (/reducer/i.test(name)) return 'Reducer';
  if (/quarter round/i.test(name)) return 'Quarter Round';
  return 'Molding';
}
// strip type + species + trailing length to expose the color tokens
function parseAcc(name) {
  let s = clean(name);
  s = s.replace(/^(square stairnose|stairnose|reducer|t-?mold|quarter round)\s+/i, '');
  let speciesNorm = '';
  for (const sp of SPECIES) { const re = new RegExp(`^${sp}\\s+`, 'i'); if (re.test(s)) { speciesNorm = sp; s = s.replace(re, ''); break; } }
  s = s.replace(/\s+\d+(-\d+\/\d+)?"?\s*$/, ''); // trailing length e.g. 78"
  return { speciesNorm, color: clean(s).toLowerCase() };
}

for (const a of acc) {
  const { speciesNorm, color } = parseAcc(a.name);
  const base = color.replace(/\s+herringbone$/, '');
  // candidate planks whose base color matches
  let cands = colorIndex.filter((c) => c.baseShort === base);
  // disambiguate by species when the color collides across species (Heritage "Natural")
  if (cands.length > 1 && speciesNorm) {
    const sp = cands.filter((c) => c.speciesNorm === speciesNorm || (speciesNorm === 'arborea' && c.speciesNorm === 'arborea'));
    if (sp.length) cands = sp;
  }
  accessories.push({
    itemCode: a.code, cost: a.cost, name: a.name, type: typeOf(a.name),
    collection: cands.length ? cands[0].collection : null,
    plank_internal_skus: cands.map((c) => c.internal_sku),
    color: cands.length ? titleCase(base) : null,
  });
}

// ==================== Output ====================
const catalog = {
  vendor: { name: 'Galleher Duffy', code: 'GALL', website: 'https://www.galleherduffy.com' },
  brand: { name: 'Reward Flooring', code: 'REWARD', website: 'https://rewardflooring.com' },
  markup: 1.6, products, accessories,
};
fs.writeFileSync(path.join(DATA, 'catalog.json'), JSON.stringify(catalog, null, 2));
fs.writeFileSync(path.join(DATA, 'images.json'), JSON.stringify(images, null, 2));

const active = products.filter((p) => p.status === 'active').length;
const linked = accessories.filter((a) => a.plank_internal_skus.length).length;
const totalLinks = accessories.reduce((n, a) => n + a.plank_internal_skus.length, 0);
const noCost = products.filter((p) => p.skus[0].cost == null).map((p) => `${p.collection}/${p.name}`);
const missCarton = new Set();
for (const p of products) if (p.status === 'active' && p.skus[0].sqft_box == null) missCarton.add(`${p.collection}|${p.skus[0].width}`);
console.log('=== Reward catalog built ===');
console.log(`Products (colors): ${products.length}  (${active} active, ${products.length - active} draft/no-cost)`);
console.log(`Images: ${Object.keys(images).length} colors with photos`);
console.log(`Accessories: ${accessories.length}  (${linked} linked, ${accessories.length - linked} unmatched; ${totalLinks} plank links)`);
console.log(`No-cost planks: ${noCost.length ? noCost.join(', ') : 'none'}`);
console.log(`Active missing carton SF: ${missCarton.size ? [...missCarton].join(', ') : 'none'}`);
