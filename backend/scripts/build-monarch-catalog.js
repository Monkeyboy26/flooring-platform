#!/usr/bin/env node
/**
 * Build the Monarch Plank catalog.json + images.json from the gathered sources.
 *
 * Monarch Plank is onboarded as a BRAND (code MONARCH) under a NEW distributor
 * vendor "Galleher Duffy" (code GALLEHERDUFFY) — Roma sources Monarch through
 * its Galleher Duffy dealer account 370815. See [[monarch-onboarding]],
 * [[vendor-sub-brands]].
 *
 * Sources (backend/data/monarch/):
 *   monarch-public-raw.json  — 88 prefinished colors / 12 collections from the
 *                              public monarchplank.com Shopify feed (specs+images)
 *   galleher-cost-map.json   — Roma dealer COST $/sqft, uniform per collection+width
 *   galleher-accessories.tsv — 158 color-matched moldings (itemCode|price|name)
 *
 * Pricing: dealer cost is Roma's cost; retail = cost x 1.6 nickel-rounded
 * (keystone standard — see [[selling-conventions]]). Flooring sold per sqft by the
 * box (sell_by 'box', price_basis per_sqft). Collections with NO published Galleher
 * cost (Premio, Regent, True Teak, Unfinished) import as DRAFT with no price
 * (storefront no-cost convention — see [[shaw-categorization]]).
 *
 * Accessories (moldings) are grouped into a "{Collection} Trims" product and linked
 * to that collection's plank SKUs by matching the plank COLOR name inside the
 * molding name (Garrison pattern — see [[line-item-display]]).
 *
 * Usage: node scripts/build-monarch-catalog.js
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, '..', 'data', 'monarch');
const raw = JSON.parse(fs.readFileSync(path.join(DATA, 'monarch-public-raw.json'), 'utf8'));

// ---- Collections that go live vs draft (no published cost) ----
const DRAFT_COLLECTIONS = new Set(['Premio', 'Regent', 'True Teak', 'Unfinished']);

// ---- Dealer COST $/sqft, per collection (some vary by width) ----
// From galleher-cost-map.json (Galleher Duffy dealer acct 370815, 2026-08-14).
function costOf(collection, width) {
  switch (collection) {
    case 'La Grande': return 14.18;
    case 'Domaine II': return width === '4-3/4' ? 11.19 : 10.90; // 4-3/4 = herringbone
    case 'Dover': return 7.15;
    case 'Manor': return 8.96;
    case 'Tableau': return 7.87;
    case 'Hokkaido': return 7.52;
    case 'Vinland': return width === '7' ? 9.19 : 8.86;
    case 'Lago': return width === '7' ? 6.31 : 7.03;
    default: return null; // Premio, Regent, True Teak, Unfinished
  }
}

// ---- Carton coverage (SF per carton), per collection+width ----
// Tableau 31.26 confirmed from Galleher detail page. Rest from Monarch spec
// sheets (build-monarch-cartons subagent → fill CARTON_SF below).
// SF per carton (random-length; published by dealer Luxe Floor Studio, verified
// against the known Tableau 31.26). Herringbone widths carry their own carton.
const CARTON_SF = {
  'La Grande|11-3/8': 18.73,
  'Domaine II|9-1/2': 25.32,
  'Domaine II|4-3/4': 8.68,   // herringbone
  'Dover|7-1/2': 20.04,
  'Manor|9-1/2': 25.32,
  'Regent|7-1/2': 26.14,
  'Tableau|8-5/8': 31.26,
  'Hokkaido|7-1/2': 23.31,
  'Premio|7-1/2': 27.0,
  'Premio|6-1/2': 23.44,
  'Vinland|7': 27.56,
  'Vinland|6': 23.62,
  'True Teak|7-1/4': 20.91,
  'Lago|7': 24.99,
  'Lago|4-3/8': 4.69,         // herringbone
};
function cartonOf(collection, width) {
  return CARTON_SF[`${collection}|${width}`] ?? null;
}

// Per-collection spec-sheet PDF (monarchplank.com product pages, Shopify CDN).
// Unfinished has no spec sheet (draft). Attached to each product as spec_pdf.
const SPEC_PDF = {
  'La Grande': 'https://cdn.shopify.com/s/files/1/2720/0826/files/La_Grande_Spec_Sheet_rev0626.pdf?v=1781545561',
  'Domaine II': 'https://cdn.shopify.com/s/files/1/2720/0826/files/Domaine_II_Spec_Sheet_rev0626.pdf?v=1780917950',
  Dover: 'https://cdn.shopify.com/s/files/1/2720/0826/files/Dover_Spec_Sheet_rev0626.pdf?v=1780918462',
  Manor: 'https://cdn.shopify.com/s/files/1/2720/0826/files/Manor_Spec_Sheet_rev0626.pdf?v=1781545566',
  Regent: 'https://cdn.shopify.com/s/files/1/2720/0826/files/Regent_Spec_Sheet_rev0626.pdf?v=1780921067',
  Tableau: 'https://cdn.shopify.com/s/files/1/2720/0826/files/Tableau_Spec_Sheet_rev12Aug2024_f3122d81-49c2-41e4-a320-263a173e217a.pdf?v=1755560620',
  Hokkaido: 'https://cdn.shopify.com/s/files/1/2720/0826/files/Hokkaido_Spec_Sheet_rev0626.pdf?v=1780918696',
  Premio: 'https://cdn.shopify.com/s/files/1/2720/0826/files/Premio_Spec_Sheet_rev0526.pdf?v=1781546441',
  Vinland: 'https://cdn.shopify.com/s/files/1/2720/0826/files/Vinland_Spec_Sheet_rev0626.pdf?v=1780921456',
  'True Teak': 'https://cdn.shopify.com/s/files/1/2720/0826/files/True_Teak_Spec_Sheet_rev0626.pdf?v=1781546598',
  Lago: 'https://cdn.shopify.com/s/files/1/2720/0826/files/Lago_Spec_Sheet_rev0626.pdf?v=1781545563',
};

const slug = (s) => String(s).toLowerCase().replace(/['".]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const titleCase = (s) => s.replace(/\w\S*/g, (t) => t.charAt(0).toUpperCase() + t.slice(1).toLowerCase());

// Strip the collection prefix from a public product name to get the color.
function colorFrom(collectionName, productName) {
  let n = productName.trim();
  if (n.toLowerCase().startsWith(collectionName.toLowerCase())) n = n.slice(collectionName.length).trim();
  return titleCase(n.replace(/\s+/g, ' '));
}

// ==================== Planks ====================
const products = [];
const images = {};
const colorIndex = []; // { colorNorm, collection, internal_sku } for accessory linking

for (const col of raw.collections) {
  const collection = col.name.replace(/\s*\(.*\)\s*$/, '').trim(); // "Unfinished (French Oak & Walnut)" -> "Unfinished"
  const isDraft = DRAFT_COLLECTIONS.has(collection);
  for (const p of col.products) {
    const color = colorFrom(col.name, p.name) || titleCase(p.name);
    const width = p.width || '';
    const thickness = p.thickness || '';
    const cost = isDraft ? null : costOf(collection, width);
    const internal_sku = `MON-${slug(collection)}-${slug(color)}`;
    const size = [thickness, width].filter(Boolean).map((x) => `${x}"`).join(' x ');

    const sku = {
      vendor_sku: p.sku || null,
      internal_sku,
      variant_name: width ? `${width}"` : 'Plank',
      color, collection, species: p.species || null,
      finish: p.finish || null,
      surface_texture: p.texture || null,
      construction: p.construction || 'engineered',
      grade: p.grade || null,
      edge: p.edge || null,
      wear_layer: p.wear_layer || null,
      thickness, width, size,
      length: p.length || null,
      cost,
      sqft_box: cartonOf(collection, width),
      status: isDraft || cost == null ? 'draft' : 'active',
    };

    products.push({
      name: color,
      collection,
      species: p.species || 'European Oak',
      status: isDraft || cost == null ? 'draft' : 'active',
      handle: p.handle,
      spec_pdf: SPEC_PDF[collection] || null,
      skus: [sku],
    });

    if (p.images && p.images.length) {
      images[internal_sku] = { primary: p.images[0], lifestyle: p.images.slice(1) };
    }
    // baseNorm drops the " herringbone" suffix so a base-color molding (e.g. "Allier")
  // links to BOTH the straight-lay and herringbone planks of that color.
  const colorNorm = color.toLowerCase();
  colorIndex.push({ colorNorm, baseNorm: colorNorm.replace(/\s+herringbone$/, ''), collection, internal_sku, color });
  }
}

// ==================== Accessories (moldings) ====================
// Parse galleher-accessories.tsv → type + color, link to plank color by longest
// plank-color substring match inside the molding name.
const tsv = fs.readFileSync(path.join(DATA, 'galleher-accessories.tsv'), 'utf8').trim().split('\n');
const accessories = []; // { itemCode, cost, name, type, collection|null, plank_internal_skus[], color|null }

function typeOf(name) {
  if (/end cap|threshold/i.test(name)) return 'End Cap / Threshold';
  if (/t-?mold/i.test(name)) return 'T-Molding';
  if (/reducer/i.test(name)) return 'Reducer';
  if (/tread/i.test(name)) return 'Stair Tread';
  if (/riser/i.test(name)) return 'Riser';
  if (/stair ?nos/i.test(name)) return 'Stair Nose';
  return 'Molding';
}

const esc = (s) => s.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');

// Galleher names Hokkaido moldings by the Japanese species; the planks use the
// wood's local name. Map so the color-substring matcher lines them up.
const SPECIES_ALIAS = { 'japanese oak': 'nara', 'japanese ash': 'tamo', 'japanese chestnut': 'kuri' };
// Spelling variants seen only in Galleher molding names.
const COLOR_ALIAS = { lemiere: 'lumiere' };

// Vinland is multi-species: a "{species}" molding fits every Vinland plank of that
// species (grade-agnostic). True Teak's 2 colors are keyed by Natural/Bleached.
const vinlandBySpecies = {}; // 'walnut' -> [ref...]
const teakByTone = {};       // 'natural'|'bleached' -> [ref...]
for (const p of products) {
  const ref = { collection: p.collection, internal_sku: p.skus[0].internal_sku, color: p.name };
  if (p.collection === 'Vinland') (vinlandBySpecies[(p.species || '').toLowerCase()] ||= []).push(ref);
  if (p.collection === 'True Teak') (teakByTone[p.name.toLowerCase().split(' ')[0]] ||= []).push(ref);
}

// Generic/unfinished trims carry no finished color — never link them to a plank.
const isGeneric = (name) => /unfinish|\bunf\b|7-day|4mm radius|prime euro oak|rustic euro oak/i.test(name);

function normalizeAcc(name) {
  let s = ' ' + name.toLowerCase() + ' ';
  for (const [k, v] of Object.entries(SPECIES_ALIAS)) s = s.split(k).join(v);
  for (const [k, v] of Object.entries(COLOR_ALIAS)) s = s.replace(new RegExp(`(^|[^a-z])${esc(k)}([^a-z]|$)`, 'g'), `$1${v}$2`);
  return s;
}

// Return matched plank refs (usually 1; several for a Vinland species family).
function matchColors(name) {
  if (isGeneric(name)) return [];
  const n = normalizeAcc(name);
  // 1) longest plank BASE color appearing as a token — covers the European Oak
  //    collections, Hokkaido (via species alias) and the Lumiere/Lemiere variant.
  //    Returns every plank sharing that base color (straight-lay + herringbone).
  let best = null;
  for (const c of colorIndex) {
    const re = new RegExp(`(^|[^a-z])${esc(c.baseNorm)}([^a-z]|$)`);
    if (re.test(n) && (!best || c.baseNorm.length > best.baseNorm.length)) best = c;
  }
  if (best) return colorIndex.filter((c) => c.collection === best.collection && c.baseNorm === best.baseNorm);
  // 2) Vinland species family (Walnut/Maple/Hickory/Red Oak/White Oak)
  const raw = name.toLowerCase();
  for (const sp of Object.keys(vinlandBySpecies)) if (sp && raw.includes(sp)) return vinlandBySpecies[sp];
  // 3) True Teak, keyed by tone
  if (raw.includes('teak')) {
    if (raw.includes('bleached')) return teakByTone.bleached || [];
    if (raw.includes('natural')) return teakByTone.natural || [];
  }
  return [];
}

for (const line of tsv) {
  const [itemCode, priceStr, name] = line.split('|');
  if (!itemCode) continue;
  const cost = parseFloat(priceStr);
  const matches = matchColors(name.trim());
  accessories.push({
    itemCode, cost: cost > 0 ? cost : null, name: name.trim(), type: typeOf(name),
    collection: matches.length ? matches[0].collection : null,
    plank_internal_skus: matches.map((m) => m.internal_sku),
    // single match keeps its exact color; a species family collapses to the shared word
    color: matches.length === 1 ? matches[0].color : (matches.length ? matches[0].color.split(' ')[0] : null),
  });
}

// ==================== Output ====================
const catalog = {
  vendor: {
    name: 'Galleher Duffy', code: 'GALL',
    website: 'https://www.galleherduffy.com',
    address: 'A Division of Artivo Surfaces',
    notes: 'Flooring distributor (Galleher + Tom Duffy + Trinity Hardwood). Roma dealer account 370815. Primary brand onboarded: Monarch Plank.',
  },
  brand: { name: 'Monarch Plank', code: 'MONARCH', website: 'https://monarchplank.com' },
  markup: 1.6,
  products,
  accessories,
};

fs.writeFileSync(path.join(DATA, 'catalog.json'), JSON.stringify(catalog, null, 2));
fs.writeFileSync(path.join(DATA, 'images.json'), JSON.stringify(images, null, 2));

// ---- Report ----
const active = products.filter((p) => p.status === 'active').length;
const draft = products.length - active;
const linked = accessories.filter((a) => a.plank_internal_skus.length).length;
const totalLinks = accessories.reduce((n, a) => n + a.plank_internal_skus.length, 0);
const accByType = {};
for (const a of accessories) accByType[a.type] = (accByType[a.type] || 0) + 1;
const missCarton = new Set();
for (const p of products) for (const s of p.skus) if (s.status === 'active' && s.sqft_box == null) missCarton.add(`${s.collection}|${s.width}`);

console.log('=== Monarch catalog built ===');
console.log(`Products (colors): ${products.length}  (${active} active, ${draft} draft)`);
console.log(`Images: ${Object.keys(images).length} colors with photos`);
console.log(`Accessories: ${accessories.length}  (${linked} linked, ${accessories.length - linked} unmatched; ${totalLinks} plank links total)`);
console.log('  by type:', JSON.stringify(accByType));
console.log(`Active SKUs missing carton SF: ${missCarton.size ? [...missCarton].join(', ') : 'none'}`);
console.log(`Wrote ${path.join(DATA, 'catalog.json')} and images.json`);
