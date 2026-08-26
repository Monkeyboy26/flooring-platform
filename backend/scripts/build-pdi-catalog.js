#!/usr/bin/env node
/**
 * Build the PDI catalog.json from the vendor price book.
 *
 * Source: "PDI - Local Stocking Dealer Pricing" (effective 11/01/2025), the
 * Pacific Direct Industries (PDI) Local Stocking Dealer Pricelist. Three product
 * families — Laminate (Poseidon), SPC vinyl (Viva Las Vegas / Monaco Royale /
 * Exotic Delights), and Engineered Hardwood (Florence / Napa Valley / Manhattan
 * / Riche / Custom) — plus per-family trim moldings, EVA underlayment, and a
 * wood adhesive.
 *
 * The price book "$ / Sf" (and molding "Cost") columns are Roma's COST (local
 * stocking dealer / wholesale). Retail is applied at import time (cost x 1.6,
 * nickel-rounded) — see import-pdi.js. This script only transcribes the sheet.
 *
 * Flooring is sold per sqft (by the box); moldings / treads / pad / adhesive are
 * sold per piece/roll/bucket (unit). Each vendor item number becomes one product
 * with a single field SKU (mirrors the Mango model — see [[mango-onboarding]]).
 *
 * Usage: node scripts/build-pdi-catalog.js   (writes ../data/pdi/catalog.json)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, '..', 'data', 'pdi');

// ---- Flooring groups: shared specs + [item#, colorName] rows ----------------
// `over` lets a single row override a shared field (e.g. Lindos length/box).
const GROUPS = [
  // ============================ LAMINATE ============================
  {
    collection: 'Poseidon', category: 'laminate',
    material: 'Laminate', family: 'laminate',
    specs: {
      construction: 'Waterproof Laminate', thickness: '12.3 mm', width: '7.68 in',
      length: '5 ft', abrasion_resistance: 'AC4', finish: 'Micro Bevel',
      edge_type: 'Micro Bevel', surface_texture: 'Wood Texture',
      installation_method: 'Click Lock', features: 'Waterproof',
    },
    sqft_box: 19.08, cost: 2.30,
    rows: [
      ['PSDN020', 'Hermes'],
      ['PSDN021', 'Lindos', { length: '4 ft', sqft_box: 20.40 }],
      ['PSDN022', 'Jupiter'],
      ['PSDN023', 'Pegasus'],
      ['PSDN024', 'Hydra'],
      ['PSDN025', 'Kraken'],
      ['PSDN026', 'Aegen'],
    ],
  },
  {
    collection: 'Poseidon', category: 'laminate',
    material: 'Laminate', family: 'laminate',
    specs: {
      construction: 'Waterproof Laminate', thickness: '12.3 mm', width: '9.4 in',
      length: '5 ft', abrasion_resistance: 'AC4', finish: 'Micro Bevel',
      edge_type: 'Micro Bevel', surface_texture: 'Wood Texture',
      installation_method: 'Click Lock', features: 'Waterproof',
    },
    sqft_box: 23.29, cost: 2.35,
    rows: [
      ['PSDN040', 'Adonis'], ['PSDN041', 'Apollo'], ['PSDN042', 'Iris'],
      ['PSDN043', 'Maia'], ['PSDN044', 'Zephyr'], ['PSDN045', 'Eros'],
      ['PSDN046', 'Artemis'], ['PSDN047', 'Corfu'], ['PSDN048', 'Hades'],
      ['PSDN049', 'Hercules'], ['PSDN050', 'Morpheus'], ['PSDN051', 'Chariot'],
      ['PSDN052', 'Odyssey'], ['PSDN053', 'Thalassa'],
    ],
  },
  {
    collection: 'Poseidon XL', category: 'laminate',
    material: 'Laminate', family: 'laminate',
    specs: {
      construction: 'Waterproof Laminate', thickness: '12.3 mm', width: '9.4 in',
      length: '6 ft', abrasion_resistance: 'AC4', finish: 'Micro Bevel',
      edge_type: 'Micro Bevel', surface_texture: '4D EIR (Embossed-in-Register)',
      installation_method: 'Click Lock', features: 'Waterproof, 4D EIR',
    },
    sqft_box: 23.31, cost: 2.45,
    rows: [
      ['PSDN088', 'Vulcan'], ['PSDN089', 'Selene'],
      ['PSDN090', 'Pluto'], ['PSDN091', 'Leto'],
    ],
  },
  {
    collection: 'Poseidon Herringbone', category: 'laminate',
    material: 'Laminate', family: 'laminate',
    specs: {
      construction: 'Waterproof Laminate', thickness: '12.3 mm', width: '5 in',
      abrasion_resistance: 'AC4', finish: 'Micro Bevel', edge_type: 'Micro Bevel',
      surface_texture: '4D EIR (Embossed-in-Register)',
      installation_method: 'Herringbone Click Lock', pattern: 'Herringbone',
      features: 'Waterproof, 4D EIR, Herringbone',
    },
    cost: 2.60,
    rows: [
      ['PSDH018', 'Hermes', { length: '30 in', sqft_box: 16.32 }],
      ['PSDH019', 'Vulcan', { length: '36 in', sqft_box: 19.86 }],
      ['PSDH020', 'Morpheus', { length: '30 in', sqft_box: 16.32 }],
    ],
  },

  // ============================== SPC ==============================
  {
    collection: 'Viva Las Vegas', category: 'lvp-plank',
    material: 'SPC Vinyl', family: 'spc',
    specs: {
      construction: 'Rigid Core (SPC)', thickness: '8 mm', width: '9 in',
      length: '5 ft', wear_layer: '20 mil', finish: 'Painted Bevel',
      surface_texture: 'EIR (Embossed-in-Register)', underlayer: 'Attached IXPE Pad',
      installation_method: 'Click Lock', features: 'Waterproof, EIR, Attached IXPE Pad',
    },
    sqft_box: 18.84, cost: 2.45,
    rows: [
      ['ESPC188', 'High Roller'], ['ESPC191', 'Feeling Lucky'],
      ['ESPC194', 'Desert Walnut'], ['ESPC195', 'Bellagio Beige'],
      ['ESPC196', 'Venetian Vibes'], ['ESPC197', 'All In'],
      ['ESPC198', 'Royal Flush'], ['ESPC199', 'Tropicana'],
    ],
  },
  {
    collection: 'Monaco Royale', category: 'lvp-plank',
    material: 'SPC Vinyl', family: 'spc',
    specs: {
      construction: 'Rigid Core (SPC)', thickness: '8 mm', width: '9 in',
      length: '5 ft', wear_layer: '20 mil', finish: 'Painted Bevel',
      surface_texture: '4D EIR (Embossed-in-Register)',
      underlayer: 'Attached 1.5mm High-Density IXPE Pad',
      installation_method: 'Click Lock',
      features: 'Waterproof, 4D EIR, Attached 1.5mm IXPE Pad',
    },
    sqft_box: 18.84, cost: 2.55,
    rows: [
      ['ESPC808', 'Grand Prix'], ['ESPC809', 'Monte Carlo'],
      ['ESPC810', 'Elysian Heights'], ['ESPC811', 'Chateau Crest'],
      ['ESPC812', 'Echelon'], ['ESPC813', 'Aurelia'],
    ],
  },
  {
    collection: 'Exotic Delights', category: 'lvp-plank',
    material: 'SPC Vinyl', family: 'spc',
    specs: {
      construction: 'Rigid Core (SPC)', thickness: '6.5 mm', width: '7 in',
      length: '4 ft', wear_layer: '20 mil', finish: 'Painted Bevel',
      underlayer: 'Attached 1.5mm High-Density IXPE Pad',
      installation_method: 'Click Lock',
      features: 'Waterproof, Attached 1.5mm IXPE Pad',
    },
    sqft_box: 23.64, cost: 2.19,
    rows: [
      ['ESPC151', 'Hawaiian Koa'], ['ESPC152', 'Santos Mahogany'],
      ['ESPC154', 'Exotic Walnut'],
    ],
  },

  // ======================= ENGINEERED HARDWOOD =======================
  {
    collection: 'Florence', category: 'engineered-hardwood',
    material: 'Engineered Hardwood', family: 'hardwood',
    specs: {
      construction: 'Engineered Hardwood', species: 'European Oak',
      surface_texture: 'Wire Brushed', thickness: '5/8 in', width: '7.5 in',
      length: '2-6 ft', wear_layer: '4 mm', installation_method: 'Glue / Nail / Float',
    },
    sqft_box: 23.32, cost: 5.79,
    rows: [['HH0007', 'Seneca Oak'], ['HH0014', 'Tuscan Oak']],
  },
  {
    collection: 'Napa Valley', category: 'engineered-hardwood',
    material: 'Engineered Hardwood', family: 'hardwood',
    specs: {
      construction: 'Engineered Hardwood', species: 'European Oak',
      surface_texture: 'Wire Brushed', thickness: '5/8 in', width: '9.5 in',
      length: '2-7 ft', wear_layer: '4 mm', installation_method: 'Glue / Nail / Float',
    },
    sqft_box: 34.10, cost: 6.19,
    rows: [
      ['HH1327', 'Calistoga Oak'], ['HH1328', 'Amorosa Oak'],
      ['SHY1340', 'Giotto'], ['SHY1341', 'Elmshaven'],
    ],
  },
  {
    collection: 'Manhattan', category: 'engineered-hardwood',
    material: 'Engineered Hardwood', family: 'hardwood',
    // NOTE: price-sheet collection header says 1/2" thickness but the per-row
    // "Thick" column prints 5/8". Using the collection header (1/2") — flagged.
    specs: {
      construction: 'Engineered Hardwood', species: 'White Oak',
      surface_texture: 'Wire Brushed', thickness: '1/2 in', width: '7.5 in',
      length: '1-6 ft', wear_layer: '2 mm', installation_method: 'Glue / Nail / Float',
    },
    sqft_box: 31.10, cost: 3.99,
    rows: [
      ['HH1888', 'Skyline'], ['HH1889', 'Cityscape'], ['HH1890', 'Urbanview'],
      ['HH1891', 'Metrovista'], ['HH1892', 'Panorama'],
    ],
  },
  {
    collection: 'Riche', category: 'engineered-hardwood',
    material: 'Engineered Hardwood', family: 'hardwood',
    specs: {
      construction: 'Engineered Hardwood', species: 'American Oak',
      surface_texture: 'Wire Brushed', thickness: '5/8 in', width: '8.7 in',
      length: '2-7 ft', wear_layer: '4 mm', installation_method: 'Glue / Nail / Float',
      style: 'A/B Select Grade',
    },
    sqft_box: 31.26, cost: 6.89,
    rows: [
      ['SHY0888', 'Almafi'], ['SHY0889', 'Capri'],
      ['SHY0890', 'Smeralda'], ['SHY0891', 'Portofino'],
    ],
  },
  {
    collection: 'Custom', category: 'engineered-hardwood',
    material: 'Engineered Hardwood', family: 'hardwood', status: 'draft', // call for pricing
    specs: {
      construction: 'Engineered Hardwood', species: 'American Oak',
      surface_texture: 'Wire Brushed', thickness: '5/8 in', width: '8.7 in',
      length: '2-7 ft', wear_layer: '4 mm', installation_method: 'Glue / Nail / Float',
      style: 'A/B Select Grade',
    },
    sqft_box: 34.10, cost: null, // "CALL FOR PRICING"
    rows: [['TZ-HH1007', 'Custom Flooring']],
  },
];

// ---- Molding / accessory tables (COST columns from the sheet) ---------------
// One accessory product per material family; attached to that family's planks.
const ACCESSORY_PRODUCTS = [
  {
    key: 'laminate', family: 'laminate', category: 'transitions-moldings',
    name: 'Poseidon Laminate Trims & Moldings',
    desc: 'Color-coordinated laminate transition trims and moldings for PDI Poseidon waterproof laminate floors. Sold per piece (moldings 96", stair treads 12"x48"x1"). Includes a 3mm EVA underlayment pad (sold per 100 sf roll).',
    items: [
      { label: 'Reducer', code: 'PSDN-REDUCER', cost: 21.00, note: '96 in' },
      { label: 'End Molding', code: 'PSDN-ENDMOLD', cost: 21.00, note: '96 in' },
      { label: 'Square Nose', code: 'PSDN-SQNOSE', cost: 21.00, note: '96 in', stairOnly: true },
      { label: 'Flush Stair Nose', code: 'PSDN-FLUSHSN', cost: 32.00, note: '96 in', stairOnly: true },
      { label: 'T-Molding', code: 'PSDN-TMOLD', cost: 21.00, note: '96 in' },
      { label: 'Quarter Round', code: 'PSDN-QRND', cost: 16.00, note: '96 in' },
      { label: 'Stair Treads 12"x48"x1"', code: 'PSDN-TREAD', cost: 66.00, category: 'stair-treads-nosing', stairOnly: true },
      { label: '3mm EVA Underlayment Pad (100 sf roll)', code: 'PSDN-EVAPAD', cost: 17.00, category: 'underlayment' },
    ],
  },
  {
    key: 'spc', family: 'spc', category: 'transitions-moldings',
    name: 'PDI SPC Vinyl Trims & Moldings',
    desc: 'Color-coordinated vinyl transition trims and moldings for PDI SPC rigid-core vinyl plank floors (Viva Las Vegas, Monaco Royale, Exotic Delights). Sold per piece (moldings 92", stair treads 12"x48"x1").',
    items: [
      { label: 'Reducer', code: 'ESPC-REDUCER', cost: 21.00, note: '92 in' },
      { label: 'End Mold', code: 'ESPC-ENDMOLD', cost: 21.00, note: '92 in' },
      { label: 'Square Nose', code: 'ESPC-SQNOSE', cost: 21.00, note: '92 in', stairOnly: true },
      { label: 'Flush Stair Nose', code: 'ESPC-FLUSHSN', cost: 32.00, note: '92 in', stairOnly: true },
      { label: 'T-Mold', code: 'ESPC-TMOLD', cost: 21.00, note: '92 in' },
      { label: 'Quarter Round', code: 'ESPC-QRND', cost: 16.00, note: '92 in' },
      { label: 'Stair Treads 12"x48"x1"', code: 'ESPC-TREAD', cost: 66.00, category: 'stair-treads-nosing', stairOnly: true },
    ],
  },
  {
    key: 'hardwood', family: 'hardwood', category: 'transitions-moldings',
    name: 'PDI Hardwood Trims & Moldings',
    desc: 'Color-coordinated wood transition trims and moldings for PDI engineered hardwood floors. Sold per piece (96"). Includes SIKA T-21 3-in-1 wood adhesive (adhesive, sealer, sound — 4-gallon bucket, covers 120-140 sf).',
    items: [
      { label: 'Reducer', code: 'HW-REDUCER', cost: 85.00, note: '96 in' },
      { label: 'End Mold', code: 'HW-ENDMOLD', cost: 85.00, note: '96 in' },
      { label: 'Square Nose', code: 'HW-SQNOSE', cost: 85.00, note: '96 in', stairOnly: true },
      { label: 'T-Mold', code: 'HW-TMOLD', cost: 85.00, note: '96 in' },
      { label: 'Flush Stair Nose', code: 'HW-FLUSHSN', cost: 120.00, note: '96 in', stairOnly: true },
      { label: 'Flush Square Edged Stair Nose', code: 'HW-SQEDGESN', cost: 145.00, note: '96 in', stairOnly: true },
      { label: 'SIKA T-21 3-in-1 Wood Adhesive (4 gal)', code: 'HW-SIKAT21', cost: 165.00, category: 'adhesives-sealants' },
    ],
  },
];

// ---- Expand groups into flat product list -----------------------------------
const products = [];
for (const g of GROUPS) {
  for (const [code, name, over = {}] of g.rows) {
    const { sqft_box: ovBox, ...ovSpecs } = over;
    products.push({
      code,
      internal_sku: `PDI-${code}`,
      name,
      collection: g.collection,
      category: g.category,
      material: g.material,
      family: g.family,
      status: g.status || 'active',
      sqft_box: ovBox != null ? ovBox : g.sqft_box,
      cost: g.cost,
      specs: { ...g.specs, ...ovSpecs },
    });
  }
}

const catalog = {
  vendor: {
    name: 'Pacific Direct Industries', code: 'PDI',
    website: 'https://pacificdirectflooring.com',
    email: 'orders@pacificdirectindustries.com',
    phone: '323-721-1930',
    address: '2510 Malt Avenue, Commerce, CA 90040',
    notes: 'Local stocking dealer pricelist effective 11/01/2025. FOB Commerce, CA. Fax 323-721-1931. Cost = local stocking dealer price; retail applied at x1.6. Laminate (Poseidon), SPC (Viva Las Vegas / Monaco Royale / Exotic Delights), Engineered Hardwood (Florence / Napa Valley / Manhattan / Riche / Custom).',
  },
  products,
  accessories: ACCESSORY_PRODUCTS,
};

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, 'catalog.json'), JSON.stringify(catalog, null, 2));
const byFam = products.reduce((m, p) => ((m[p.family] = (m[p.family] || 0) + 1), m), {});
const accCount = ACCESSORY_PRODUCTS.reduce((n, a) => n + a.items.length, 0);
console.log(`Wrote catalog.json: ${products.length} flooring products`, byFam);
console.log(`  + ${ACCESSORY_PRODUCTS.length} accessory products (${accCount} accessory SKUs)`);
