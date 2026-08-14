#!/usr/bin/env node
/**
 * Build the GemCore catalog.json + images.json.
 *
 * GemCore is onboarded as a BRAND (code GEM) under the existing Galleher Duffy
 * vendor (code GALL) — GemCore is Galleher's waterproof-flooring line. Mirrors the
 * Reward onboarding. See [[monarch-onboarding]], [[vendor-sub-brands]].
 *
 * Three families → storefront categories:
 *   SPC (rigid stone composite: Garnet/Opal/Crystal/Diamond/Jasper/Sapphire/Topaz/Onyx) → lvp-plank
 *   LVT (glue-down: Meridian II / Advantage II)                                          → lvp-plank
 *   Laminate (waterproof AC4: Riverfront / Lakeshore / Seaside)                          → laminate
 *
 * Sources (backend/data/gemcore/):
 *   gemcore-public-raw.json  — 86 planks (SPC+LVT from gemcoreflooring.com Shopify;
 *                              laminate merged in from products-full.json) w/ specs+images
 *   galleher-planks.tsv       — 88 planks: itemCode|cost|name (per-color dealer cost)
 *   galleher-accessories.tsv  — 446 moldings: itemCode|cost|name (named by COLOR only)
 *
 * Public & Galleher item codes DIFFER (public GEM.../dirty REW#, Galleher REW...), so
 * planks are joined by (collection|color); code is a fallback. Galleher stocks SPC
 * colors not on the public site (Topaz, Onyx) → added imageless. Retail = cost x 1.6
 * nickel-rounded (keystone), sold per sqft by the box. Moldings link to their plank by
 * COLOR (stored as matching_color, not color — storefront gates on color). Garrison pattern.
 *
 * Usage: node scripts/build-gemcore-catalog.js
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, '..', 'data', 'gemcore');
const raw = JSON.parse(fs.readFileSync(path.join(DATA, 'gemcore-public-raw.json'), 'utf8'));

const slug = (s) => String(s).toLowerCase().replace(/['".]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const titleCase = (s) => String(s).replace(/\w\S*/g, (t) => t.charAt(0).toUpperCase() + t.slice(1).toLowerCase());
const clean = (s) => (s || '').replace(/[”“]/g, '"').replace(/\s+/g, ' ').trim();
const keystone = (cost) => parseFloat((Math.round(cost * 1.6 / 0.05) * 0.05).toFixed(2));
const normSku = (s) => (s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

const FAMILY_CAT = { SPC: 'lvp-plank', LVT: 'lvp-plank', Laminate: 'laminate' };
const FAMILY_MATERIAL = { SPC: 'SPC Rigid Core', LVT: 'Luxury Vinyl (LVT)', Laminate: 'Waterproof Laminate' };

// ---- Per-collection spec-sheet PDF (gemcoreflooring.com Shopify CDN) ----
const GCDN = 'https://cdn.shopify.com/s/files/1/0589/1915/7924/files/';
const SPEC_PDF = {
  Garnet: 'Garnet_spec_sheet_91823.pdf?v=1695085934',
  Opal: 'OPAL_COLLECTION_-_8.9.21.pdf?v=1647301693',
  Crystal: 'Crystal_spec_sheet_91823.pdf?v=1695085934',
  Diamond: 'DIAMOND_spec_sheet_031925.pdf?v=1742414872',
  Jasper: 'Jasper_spec_sheet_31925.pdf?v=1742414873',
  Sapphire: 'SAPPHIRE_COLLECTION_-_4.23.pdf?v=1680731790',
  Topaz: 'TOPAZ_COLLECTION_-_4.23.pdf?v=1680731790',
  Onyx: 'ONYX_COLLECTION_-_4.23.pdf?v=1680731790',
  'Meridian II': 'Meridian_II_Spec_Sheet_-_1.25.pdf?v=1736992175',
  'Advantage II': 'Advantage_II__Spec_Sheet_1.25.pdf?v=1736992175',
  Lakeshore: 'Lakeshore_Specs_081224.pdf?v=1728069516',
  Seaside: 'Seaside_Specs_081224.pdf?v=1728069515',
  Riverfront: 'Riverfront-Specs_100225-002.pdf?v=1776784089',
};
const specPdfOf = (collection) => (SPEC_PDF[collection] ? GCDN + SPEC_PDF[collection] : null);

// ---- Carton SF per collection (GemCore spec-sheet PDFs) ----
const CARTON_SF = {
  Garnet: 26.29, Opal: 21.29, Crystal: 26.41, Diamond: 22.64, Jasper: 27.48, Sapphire: 22.60,
  Topaz: 25.28, Onyx: 25.97, 'Meridian II': 51.33, 'Advantage II': 34.98,
  Riverfront: 23.44, Lakeshore: 20.15, Seaside: 23.14,
};

// ---- Galleher per-color cost, keyed by normalized code AND by collection|color ----
const COLLS = ['Advantage II', 'Meridian II', 'Garnet', 'Opal', 'Crystal', 'Diamond', 'Jasper',
  'Sapphire', 'Topaz', 'Onyx', 'Seaside', 'Lakeshore', 'Riverfront'];
const FAMILY_OF = (coll) => (/Meridian|Advantage/.test(coll) ? 'LVT' : /Riverfront|Lakeshore|Seaside/.test(coll) ? 'Laminate' : 'SPC');
function parseG(name) {
  const color = (name.match(/"\s*([A-Za-z][A-Za-z0-9 ]*?)\s*$/) || [])[1] || '';
  let coll = '';
  for (const c of COLLS) if (name.toLowerCase().startsWith(c.toLowerCase())) { coll = c; break; }
  const wl = (name.match(/(\d+)\s*mil/i) || [])[1];
  const dims = name.match(/([\d.]+)"?\s*X\s*([\d.]+)"/i);
  return { coll, color: clean(color), wear_layer: wl ? `${wl} mil` : '', width: dims ? dims[1] : '', length: dims ? dims[2] : '' };
}
const gPlanks = fs.readFileSync(path.join(DATA, 'galleher-planks.tsv'), 'utf8').trim().split('\n').map((l) => {
  const [code, price, name] = l.split('|');
  const cost = parseFloat(price) > 0 ? parseFloat(price) : null;
  return { code, cost, name: clean(name), ...parseG(clean(name)) };
});
const gByNorm = new Map(gPlanks.map((g) => [normSku(g.code), g]));
const gByName = new Map(gPlanks.map((g) => [`${slug(g.coll)}|${slug(g.color)}`, g]));
const consumed = new Set();
function matchG(sku, collection, color) {
  let g = gByNorm.get(normSku(sku)) || gByName.get(`${slug(collection)}|${slug(color)}`);
  if (g) consumed.add(g.code);
  return g;
}

// ==================== Planks ====================
const products = [];
const images = {};
const colorIndex = []; // { colorNorm, collection, internal_sku }
const usedInternal = new Set();

function addPlank({ collection, family, color, specs, cost, images: imgs, vendor_sku }) {
  let internal_sku = `GEM-${slug(collection)}-${slug(color)}`;
  if (usedInternal.has(internal_sku)) internal_sku += `-${slug(vendor_sku || '')}`;
  usedInternal.add(internal_sku);
  const status = cost == null ? 'draft' : 'active';
  const sku = {
    vendor_sku: vendor_sku || internal_sku, internal_sku, variant_name: specs.width ? `${specs.width}"` : 'Plank',
    color, collection, family, material: FAMILY_MATERIAL[family],
    construction: specs.construction || (family === 'Laminate' ? 'laminate' : family === 'SPC' ? 'rigid core' : 'glue-down'),
    thickness: specs.thickness || '', width: specs.width || '', length: specs.length || '',
    wear_layer: specs.wear_layer || '', finish: specs.finish || '', surface_texture: specs.texture || '',
    waterproof: 'Waterproof', size: [specs.thickness, specs.width].filter(Boolean).join(' x '),
    cost, sqft_box: CARTON_SF[collection] ?? null, status,
  };
  products.push({ name: color, collection, family, status, category: FAMILY_CAT[family], spec_pdf: specPdfOf(collection), skus: [sku] });
  if (imgs && imgs.length) images[internal_sku] = { primary: imgs[0], lifestyle: imgs.slice(1) };
  colorIndex.push({ colorNorm: color.toLowerCase(), collection, internal_sku });
}

// public planks (join Galleher cost by code or collection|color)
for (const col of raw.collections) {
  const collection = clean(col.name), family = col.family || FAMILY_OF(collection);
  for (const p of col.products) {
    const color = titleCase(clean(p.name).replace(new RegExp(`^${collection}\\s+`, 'i'), ''));
    const g = matchG(p.sku, collection, color);
    addPlank({
      collection, family, color, cost: g ? g.cost : null, vendor_sku: (g && g.code) || p.sku,
      images: (p.images || []).filter(Boolean),
      specs: { construction: p.construction, thickness: clean(p.thickness), width: clean(p.width).replace(/"/g, ''),
        length: clean(p.length).replace(/"/g, ''), wear_layer: clean(p.wear_layer), finish: clean(p.finish), texture: clean(p.texture) },
    });
  }
}
// Galleher-only planks (e.g. Topaz, Onyx SPC not on the public site) → imageless
for (const g of gPlanks) {
  if (consumed.has(g.code) || !g.coll) continue;
  const family = FAMILY_OF(g.coll);
  addPlank({
    collection: g.coll, family, color: titleCase(g.color), cost: g.cost, vendor_sku: g.code, images: [],
    specs: { width: g.width, length: g.length, wear_layer: g.wear_layer, thickness: family === 'SPC' ? '5mm' : '' },
  });
}

// ==================== Accessories (color-named moldings) ====================
const acc = fs.readFileSync(path.join(DATA, 'galleher-accessories.tsv'), 'utf8').trim().split('\n').map((l) => {
  const [code, price, name] = l.split('|');
  return { code, cost: parseFloat(price) > 0 ? parseFloat(price) : null, name: clean(name) };
});
function typeOf(name) {
  if (/square stair ?nos/i.test(name)) return 'Square Stair Nose';
  if (/stair ?nos/i.test(name)) return 'Stair Nose';
  if (/t-?mold/i.test(name)) return 'T-Molding';
  if (/reducer/i.test(name)) return 'Reducer';
  if (/quarter round/i.test(name)) return 'Quarter Round';
  if (/end cap|threshold/i.test(name)) return 'End Cap / Threshold';
  if (/tread/i.test(name)) return 'Stair Tread';
  if (/riser/i.test(name)) return 'Riser';
  return 'Molding';
}
// GemCore moldings are "<Type> <Color> <length>" (no collection) → match color globally.
// Types include "Stair Nosing - Overlap", "Square Stairnose", etc.
function accColor(name) {
  let s = clean(name).replace(/^(square stair ?nos\w*|stair ?nos\w*(\s*-\s*overlap)?|reducer|t-?mold|quarter round|end cap\s*\/?\s*threshold|end cap|threshold|tread|riser)\s+/i, '');
  s = s.replace(/\s+\d+(-\d+\/\d+)?"?\s*$/, ''); // trailing length
  return clean(s);
}
const byColor = {};
for (const c of colorIndex) (byColor[c.colorNorm] ||= []).push(c);

const accessories = [];
for (const a of acc) {
  const color = accColor(a.name);
  const cands = byColor[color.toLowerCase()] || [];
  accessories.push({
    itemCode: a.code, cost: a.cost, name: a.name, type: typeOf(a.name),
    collection: cands.length ? cands[0].collection : null,
    plank_internal_skus: cands.map((c) => c.internal_sku),
    color: cands.length ? titleCase(color) : null,
  });
}

// ==================== Output ====================
const catalog = {
  vendor: { name: 'Galleher Duffy', code: 'GALL', website: 'https://www.galleherduffy.com' },
  brand: { name: 'GemCore', code: 'GEM', website: 'https://www.gemcoreflooring.com' },
  markup: 1.6, products, accessories,
};
fs.writeFileSync(path.join(DATA, 'catalog.json'), JSON.stringify(catalog, null, 2));
fs.writeFileSync(path.join(DATA, 'images.json'), JSON.stringify(images, null, 2));

const byFam = {};
for (const p of products) (byFam[p.family] ||= { n: 0, active: 0 }), byFam[p.family].n++, (p.status === 'active' && byFam[p.family].active++);
const linked = accessories.filter((a) => a.plank_internal_skus.length).length;
const totalLinks = accessories.reduce((n, a) => n + a.plank_internal_skus.length, 0);
const noCost = products.filter((p) => p.skus[0].cost == null).map((p) => `${p.collection}/${p.name}`);
const missCarton = [...new Set(products.filter((p) => p.status === 'active' && p.skus[0].sqft_box == null).map((p) => p.collection))];
console.log('=== GemCore catalog built ===');
console.log(`Products: ${products.length} — ${JSON.stringify(byFam)}`);
console.log(`Images: ${Object.keys(images).length} colors with photos`);
console.log(`Accessories: ${accessories.length} (${linked} linked, ${accessories.length - linked} unmatched; ${totalLinks} plank links)`);
console.log(`No-cost (draft): ${noCost.length}${noCost.length ? ' — ' + noCost.slice(0, 12).join(', ') : ''}`);
console.log(`Active missing carton SF: ${missCarton.length ? missCarton.join(', ') : 'none'}`);
