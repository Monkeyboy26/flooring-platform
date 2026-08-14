#!/usr/bin/env node
/**
 * Build the Palacio + Audacity catalog.json + images.json.
 *
 * Two Galleher house brands onboarded together under the Galleher Duffy vendor
 * (code GALL): Palacio (code PAL, by "Mission Collection" — waterproof SPC/laminate
 * + Amora engineered hardwood) and Audacity (code AUD — one SPC line, Symphony).
 * Mirrors GemCore. See [[monarch-onboarding]], [[vendor-sub-brands]].
 *
 * Sources (backend/data/palacio/):
 *   galleher-palaud.tsv       — Galleher pricing: brand|itemCode|price|unit|name
 *                               (SOURCE OF TRUTH for what Roma can buy: 25 Palacio +
 *                               4 Audacity planks, priced; + moldings)
 *   palacio-public-raw.json   — colors/specs/images scraped from themissioncollection.com
 *                               + dealer Shopify (enrichment; matched by color)
 *
 * Built FROM the Galleher planks, enriched with public images/specs by color. Codes
 * differ between systems so matching is by color (collection when available). Retail =
 * cost x 1.6 keystone; sold per sqft by the box. Categories: Amora -> engineered-hardwood,
 * Americano Grande -> laminate, SPC lines (Catalonia/Maritza/Tortosa/Symphony) -> lvp-plank.
 * Priced moldings are color-named -> linked by color (matching_color; unpriced skipped).
 *
 * Usage: node scripts/build-palacio-catalog.js
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, '..', 'data', 'palacio');

const slug = (s) => String(s).toLowerCase().replace(/['".]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const titleCase = (s) => String(s).replace(/\w\S*/g, (t) => t.charAt(0).toUpperCase() + t.slice(1).toLowerCase());
const clean = (s) => (s || '').replace(/[”“]/g, '"').replace(/\s+/g, ' ').trim();
const keystone = (cost) => parseFloat((Math.round(cost * 1.6 / 0.05) * 0.05).toFixed(2));

const COLL_META = {
  Amora:              { brand: 'PAL', cat: 'engineered-hardwood', mat: 'Engineered Hardwood', family: 'Hardwood' },
  'Americano Grande': { brand: 'PAL', cat: 'laminate',            mat: 'Waterproof Laminate',  family: 'Laminate' },
  'Catalonia II':     { brand: 'PAL', cat: 'lvp-plank',           mat: 'SPC Rigid Core',       family: 'SPC' },
  Maritza:            { brand: 'PAL', cat: 'lvp-plank',           mat: 'SPC Rigid Core',       family: 'SPC' },
  Tortosa:            { brand: 'PAL', cat: 'lvp-plank',           mat: 'SPC Rigid Core',       family: 'SPC' },
  'Tortosa II':       { brand: 'PAL', cat: 'lvp-plank',           mat: 'SPC Rigid Core',       family: 'SPC' },
  Symphony:           { brand: 'AUD', cat: 'lvp-plank',           mat: 'SPC Rigid Core',       family: 'SPC' },
};
const PCOLLS = Object.keys(COLL_META).sort((a, b) => b.length - a.length);
const CARTON_SF = { Amora: 31.25, 'Americano Grande': 22.60, 'Catalonia II': 18.91, Maritza: 22.46, Tortosa: 23.1, 'Tortosa II': 23.1, Symphony: 22.80 };
const MC = 'https://www.themissioncollection.com/wp-content/uploads/';
const SPEC_PDF = {
  'Americano Grande': MC + '2024/06/Americano-Grande_Digital-Brochure_Final-6.4.2024.pdf',
  'Catalonia II': MC + '2022/05/Palacio-Catalonia-Tortosa_DataSheet.pdf',
  Tortosa: MC + '2022/05/Palacio-Catalonia-Tortosa_DataSheet.pdf',
  'Tortosa II': MC + '2022/05/Palacio-Catalonia-Tortosa_DataSheet.pdf',
};

// ---- parse a Galleher plank/molding name -> collection, color, dims ----
function parseColl(name) { for (const c of PCOLLS) if (name.toLowerCase().startsWith(c.toLowerCase())) return c; return ''; }
function parsePlank(name) {
  const coll = parseColl(name);
  let m = name.match(/(?:MM|mm)\s+(.+)$/) || name.match(/["”]\s*([A-Za-z][^"”]*)$/);
  const color = clean(m ? m[1] : '');
  const dims = name.match(/([\d.\-/]+)"?\s*X\s*([\d.\-/]+)\s*(MM|mm|")?/);
  const width = dims ? dims[1] : '', thickness = dims ? dims[2] + (/(MM|mm)/.test(dims[3] || '') ? 'mm' : '"') : '';
  return { coll, color, width, thickness };
}

// ---- public catalog: index images/specs by color (and collection|color) ----
let pub = { collections: [] };
try { pub = JSON.parse(fs.readFileSync(path.join(DATA, 'palacio-public-raw.json'), 'utf8')); }
catch { console.warn('! palacio-public-raw.json not found — importing without photos/specs'); }
const pubByColor = new Map();      // colorSlug -> {images, specs}
const pubByCollColor = new Map();  // collSlug|colorSlug -> {images, specs}
for (const c of pub.collections || []) {
  for (const p of c.products || []) {
    const color = clean(p.color || p.name);
    const rec = { images: (p.images || []).filter(Boolean),
      specs: { construction: p.construction, thickness: clean(p.thickness), width: clean(p.width).replace(/"/g, ''), length: clean(p.length).replace(/"/g, ''), wear_layer: clean(p.wear_layer), finish: clean(p.finish), texture: clean(p.texture), edge: clean(p.edge) } };
    if (!pubByColor.has(slug(color))) pubByColor.set(slug(color), rec);
    pubByCollColor.set(`${slug(c.name)}|${slug(color)}`, rec);
  }
}
const enrich = (coll, color) => pubByCollColor.get(`${slug(coll)}|${slug(color)}`) || pubByColor.get(slug(color)) || { images: [], specs: {} };

// ==================== Planks (from Galleher) ====================
const tsv = fs.readFileSync(path.join(DATA, 'galleher-palaud.tsv'), 'utf8').trim().split('\n')
  .map((l) => { const [brand, code, price, unit, name] = l.split('|'); return { brand, code, cost: parseFloat(price) > 0 ? parseFloat(price) : null, unit, name: clean(name) }; });

const products = [];
const images = {};
const colorIndex = []; // { colorNorm, collection, brand, internal_sku }
const usedInternal = new Set();

for (const g of tsv.filter((x) => x.unit === 'Square Foot')) {
  const { coll, color, width, thickness } = parsePlank(g.name);
  const meta = COLL_META[coll] || { brand: g.brand === 'Audacity' ? 'AUD' : 'PAL', cat: 'lvp-plank', mat: 'Luxury Vinyl', family: 'SPC' };
  const e = enrich(coll, color);
  let internal_sku = `${meta.brand === 'AUD' ? 'AUD' : 'PAL'}-${slug(coll)}-${slug(color)}`;
  if (usedInternal.has(internal_sku)) internal_sku += `-${slug(g.code)}`;
  usedInternal.add(internal_sku);
  const sku = {
    vendor_sku: g.code, internal_sku, variant_name: width ? `${width}"` : 'Plank', color, collection: coll,
    family: meta.family, material: meta.mat, construction: e.specs.construction || (meta.family === 'Hardwood' ? 'engineered' : meta.family === 'Laminate' ? 'laminate' : 'rigid core'),
    thickness: thickness || e.specs.thickness || '', width: width || e.specs.width || '', length: e.specs.length || '',
    wear_layer: e.specs.wear_layer || '', finish: e.specs.finish || '', surface_texture: e.specs.texture || '',
    waterproof: meta.family === 'Hardwood' ? '' : 'Waterproof', size: [thickness, width && `${width}"`].filter(Boolean).join(' x '),
    cost: g.cost, sqft_box: CARTON_SF[coll] ?? null, status: g.cost == null ? 'draft' : 'active',
  };
  products.push({ name: color, brand: meta.brand, brandName: meta.brand === 'AUD' ? 'Audacity' : 'Palacio', collection: coll, family: meta.family, category: meta.cat, status: sku.status, spec_pdf: SPEC_PDF[coll] || null, skus: [sku] });
  if (e.images.length) images[internal_sku] = { primary: e.images[0], lifestyle: e.images.slice(1) };
  colorIndex.push({ colorNorm: color.toLowerCase(), collection: coll, brand: meta.brand, internal_sku });
}

// ==================== Accessories (color-named moldings) ====================
function typeOf(name) {
  if (/square stair ?nos/i.test(name)) return 'Square Stair Nose';
  if (/flush stair ?nos/i.test(name)) return 'Stair Nose';
  if (/stair ?nos/i.test(name)) return 'Stair Nose';
  if (/t-?mold/i.test(name)) return 'T-Molding';
  if (/reducer/i.test(name)) return 'Reducer';
  if (/quarter round/i.test(name)) return 'Quarter Round';
  if (/end cap|threshold/i.test(name)) return 'End Cap / Threshold';
  if (/tread/i.test(name)) return 'Stair Tread';
  return 'Molding';
}
// molding names come in two shapes: "<Type> <Color> <len>" and
// "<Collection> <Type> <len> <Color>". Strip collection + type + any length token;
// whatever remains is the color.
function accColor(name) {
  let s = clean(name);
  for (const c of PCOLLS) s = s.replace(new RegExp(`^${c}\\s+`, 'i'), '');
  s = s.replace(/^(square stair ?nos\w*|flush stair ?nos\w*|stair ?nos\w*|reducer|t-?molding|t-?mold|quarter round|end cap\s*\/?\s*threshold|end cap|threshold|tread)\s+/i, '');
  s = s.replace(/\d+(-\d+\/\d+)?"?/g, ' ').replace(/"/g, ' '); // remove length tokens anywhere
  return clean(s);
}
const byColor = {};
for (const c of colorIndex) (byColor[c.colorNorm] ||= []).push(c);

const accessories = [];
for (const a of tsv.filter((x) => x.unit === 'Piece')) {
  const color = accColor(a.name);
  const cands = byColor[color.toLowerCase()] || [];
  const meta = cands.length ? COLL_META[cands[0].collection] : null;
  accessories.push({
    itemCode: a.code, cost: a.cost, name: a.name, type: typeOf(a.name),
    brand: cands.length ? cands[0].brand : (a.brand === 'Audacity' ? 'AUD' : 'PAL'),
    collection: cands.length ? cands[0].collection : null,
    material: meta ? meta.mat : 'Vinyl',
    plank_internal_skus: cands.map((c) => c.internal_sku),
    color: cands.length ? titleCase(color) : null,
  });
}

// ==================== Output ====================
const catalog = {
  vendor: { name: 'Galleher Duffy', code: 'GALL', website: 'https://www.galleherduffy.com' },
  brands: [
    { name: 'Palacio', code: 'PAL', website: 'https://www.themissioncollection.com' },
    { name: 'Audacity', code: 'AUD', website: 'https://www.galleherduffy.com' },
  ],
  markup: 1.6, products, accessories,
};
fs.writeFileSync(path.join(DATA, 'catalog.json'), JSON.stringify(catalog, null, 2));
fs.writeFileSync(path.join(DATA, 'images.json'), JSON.stringify(images, null, 2));

const byBrand = {};
for (const p of products) (byBrand[p.brand] ||= { n: 0, active: 0, img: 0 }), byBrand[p.brand].n++, (p.status === 'active' && byBrand[p.brand].active++), (images[p.skus[0].internal_sku] && byBrand[p.brand].img++);
const linked = accessories.filter((a) => a.plank_internal_skus.length).length;
const priced = accessories.filter((a) => a.cost != null).length;
console.log('=== Palacio + Audacity catalog built ===');
console.log(`Products: ${products.length} — ${JSON.stringify(byBrand)}`);
console.log(`Images: ${Object.keys(images).length}/${products.length} planks`);
console.log(`Accessories: ${accessories.length} (${priced} priced, ${linked} linked to a plank)`);
console.log(`Collections: ${[...new Set(products.map((p) => `${p.brand}:${p.collection}`))].join(', ')}`);
