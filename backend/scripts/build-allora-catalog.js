#!/usr/bin/env node
/**
 * Build backend/data/allora/catalog.json from the Allora "Displaying Dealer
 * Price List" v7.2025.
 *
 * Allora (Made in Italy, European Oak engineered hardwood) is manufactured /
 * distributed by Old Master Products — the SAME vendor as Garrison Collection.
 * In this platform Old Master Products is the vendor (code GAR) and Garrison /
 * Allora are sub-brands (products.brand_id). This catalog carries brand 'Allora'.
 *
 * Dealer price = Roma COST; retail = cost x1.6 keystone snapped to a 9-ending
 * with the covering floor (applied by import-allora.js, matching the store
 * standard — see [[nine-ending-prices]] / [[covering-margin-floor]]).
 *
 * Modeling mirrors Garrison ([[garrison-onboarding]]): one product per color,
 * with size/grade/format variant SKUs (7-1/2" & 9-1/2" wide plank in Select
 * Character (ABCD) and Select (AB) grades, plus Herringbone). Unfinished Select
 * is its own product (no color, no matched mouldings). Five color-matched
 * moulding types per color become the priced accessories.
 *
 * Usage: node scripts/build-allora-catalog.js
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, '..', 'data', 'allora');

// ---- Shared specs (identical across the whole Allora line) ----
const SPECIES = 'European Oak';
const MATERIAL = 'Engineered Hardwood';
const THICKNESS = '5/8" (15 mm)';
const WEAR_LAYER = '4.0 mm';
const EDGE = 'Micro-Beveled';
const CONSTRUCTION = 'Engineered (100% Birch Plywood), Micro-Beveled Edge';
const FINISH = 'Eight-Layer Water-Based UV Matte Lacquer';
const SURFACE = 'Light Wire-Brushed';

// ---- Format specs ----
// `sizeLabel` is the clean value stored in the `size` attribute — it drives the
// storefront's size/format pill (7-1/2" · 9-1/2" · Herringbone). The full metric
// dimension lives in width/length/thickness for the spec block. See
// [[variant-pill-independence]].
const FMT = {
  p75: { sizeLabel: '7-1/2″', width: '7-1/2" (192 mm)', length: 'Mostly 7\'8-1/2" (2350 mm)', sqft_box: 19.42, lbs_box: 45, install: 'Glue, Float' },
  p95: { sizeLabel: '9-1/2″', width: '9-1/2" (242 mm)', length: 'Mostly 7\'8-1/2" (2350 mm)', sqft_box: 24.49, lbs_box: 57, install: 'Glue, Float' },
  hb:  { sizeLabel: 'Herringbone', width: '4-3/4" (120 mm)', length: '23-5/8" (600 mm)', sqft_box: 7.75, lbs_box: 18, install: 'Glue', pattern: 'Herringbone' },
};

// Grade is the second variant axis (a genuine upgrade choice). Kept to two clean
// pill values; the vendor appearance codes (ABCD/AB/ABC) live in the description
// instead of splitting herringbone's ABC into a confusing third pill.
const GRADE_CHAR = 'Select Character';
const GRADE_SEL = 'Select';
const GRADE_HB = 'Select Character'; // herringbone is ABC, still "Select Character" for the pill axis

// Colors in price-list order → index drives moulding SKU suffix (01..08).
const COLOR_INDEX = { Altura: 1, Aria: 2, Doma: 3, Luna: 4, Sella: 5, Strada: 6, Ventasso: 7, Volto: 8 };

// Which formats/grades each color offers + herringbone SKU number where present.
const PLANKS = {
  Altura:   { c75: 6.99, s75: 9.79, c95: 7.49 },
  Aria:     { c75: 6.99,            c95: 7.49 },
  Doma:     { c75: 6.99, s75: 9.79, c95: 7.49, s95: 10.99, hb: 9.49, hbNum: 403 },
  Luna:     { c75: 6.99, s75: 9.79, c95: 7.49, s95: 10.99, hb: 9.49, hbNum: 404 },
  Sella:    { c75: 6.99, s75: 9.79, c95: 7.49, s95: 10.99, hb: 9.49, hbNum: 405 },
  Strada:   { c75: 6.99 },
  Ventasso: { c75: 6.99 },
  Volto:    { c75: 6.99,            c95: 7.49 },
};

// Five color-matched moulding types. vendor_sku = prefix + zero-padded color index.
const MOULDINGS = [
  { type: 'Reducer',               prefix: 'GCALRE7O',  cost: 99.99,  size: '5/8" x 2" x 92-1/2"' },
  { type: 'Square Stair Nosing',   prefix: 'GCALSNO7O', cost: 149.99, size: '1-1/2" x 3-1/2" x 92-1/2"' },
  { type: 'Bullnose Stair Nosing', prefix: 'GCALNOO8O', cost: 99.99,  size: '5/8" x 3-1/2" x 96"' },
  { type: 'Baby Threshold',        prefix: 'GCALBTO8O', cost: 79.99,  size: '5/8" x 2" x 96"' },
  { type: 'T-Moulding',            prefix: 'GCALTMO8O', cost: 79.99,  size: '5/8" x 2" x 96"' },
];

function plankSku(color, vendorSku, variantName, grade, fmt, cost) {
  return {
    vendor_sku: vendorSku,
    internal_sku: `ALLORA-${vendorSku}`,
    variant_name: variantName,
    size: fmt.sizeLabel,
    cost,
    sqft_box: fmt.sqft_box,
    lbs_box: fmt.lbs_box,
    status: 'active',
    note: null,
    thickness: THICKNESS,
    width: fmt.width,
    length: fmt.length,
    wear_layer: WEAR_LAYER,
    grade,
    edge_type: EDGE,
    finish: FINISH,
    pattern: fmt.pattern || null,
  };
}

function buildColorProduct(color) {
  const idx = COLOR_INDEX[color];
  const spec = PLANKS[color];
  const c75 = `GFALO750${idx}`;      // 7-1/2" Select Character
  const c95 = `GFALO950${idx}`;      // 9-1/2" Select Character
  const skus = [];

  if (spec.c75) skus.push(plankSku(color, c75, '7-1/2″ · Select Character', GRADE_CHAR, FMT.p75, spec.c75));
  if (spec.s75) skus.push(plankSku(color, `${c75}S`, '7-1/2″ · Select', GRADE_SEL, FMT.p75, spec.s75));
  if (spec.c95) skus.push(plankSku(color, c95, '9-1/2″ · Select Character', GRADE_CHAR, FMT.p95, spec.c95));
  if (spec.s95) skus.push(plankSku(color, `${c95}S`, '9-1/2″ · Select', GRADE_SEL, FMT.p95, spec.s95));
  if (spec.hb)  skus.push(plankSku(color, `GFALPH${spec.hbNum}`, 'Herringbone · 4-3/4″', GRADE_HB, FMT.hb, spec.hb));

  const mouldings = MOULDINGS.map((m) => {
    const vsku = `${m.prefix}0${idx}`;
    return {
      type: m.type,
      accessory_label: `${m.type} — ${color}`,
      vendor_sku: vsku,
      internal_sku: `ALLORA-${vsku}`,
      cost: m.cost,
      size: m.size,
    };
  });

  return {
    collection: 'Allora',
    name: color,
    color,
    species: SPECIES,
    finish: FINISH,
    category: 'engineered-hardwood',
    material: MATERIAL,
    specs: {
      construction: CONSTRUCTION,
      installation_method: 'Glue, Float (Herringbone: Glue)',
      surface_texture: SURFACE,
    },
    mould_note: 'Color-matched Reducer, Square/Bullnose Stair Nosing, Baby Threshold & T-Moulding.',
    skus,
    mouldings,
  };
}

// Unfinished Select 9-1/2" — its own product, smooth/no finish, no mouldings.
function buildUnfinished() {
  const vsku = 'GFALO9500S';
  return {
    collection: 'Allora',
    name: 'Unfinished',
    color: 'Unfinished',
    species: SPECIES,
    finish: 'Unfinished (No Finish)',
    category: 'engineered-hardwood',
    material: MATERIAL,
    specs: {
      construction: CONSTRUCTION,
      installation_method: 'Glue, Float',
      surface_texture: 'Smooth',
    },
    mould_note: null,
    skus: [{
      vendor_sku: vsku,
      internal_sku: `ALLORA-${vsku}`,
      variant_name: '9-1/2″ · Unfinished Select',
      size: '9-1/2″',
      cost: 8.49,
      sqft_box: FMT.p95.sqft_box,
      lbs_box: FMT.p95.lbs_box,
      status: 'active',
      note: 'Unfinished, smooth — site-finished after install.',
      thickness: THICKNESS,
      width: FMT.p95.width,
      length: FMT.p95.length,
      wear_layer: WEAR_LAYER,
      grade: GRADE_SEL,
      edge_type: EDGE,
      finish: 'Unfinished (No Finish)',
      pattern: null,
    }],
    mouldings: [],
  };
}

const products = [...Object.keys(COLOR_INDEX).map(buildColorProduct), buildUnfinished()];

const catalog = {
  vendor: {
    // Resolve-by-code only — import-allora.js looks up the existing vendor and
    // never mutates it (the Old Master rename + brand split is a one-time SQL
    // migration). Brand is carried separately (code ALLORA).
    name: 'Old Master Products',
    code: 'GAR',
    brand: 'Allora',
    brand_code: 'ALLORA',
    website: 'https://allorafloors.com',
    notes: 'Allora (Made in Italy, European Oak engineered) — Displaying Dealer Price List v7.2025. Dealer price = Roma COST; retail = cost x1.6 keystone (9-ending + covering floor). Same manufacturer/vendor as Garrison (Old Master Products). Colors: Altura, Aria, Doma, Luna, Sella, Strada, Ventasso, Volto (+ Unfinished). Formats: 7-1/2" & 9-1/2" wide plank (Select Character ABCD / Select AB) + Herringbone. 5 color-matched moulding types. Prefinished stair treads/risers, adhesives, LOBA/BONA care products are contact-for-pricing and NOT imported.',
  },
  products,
};

const skuCount = products.reduce((n, p) => n + p.skus.length, 0);
const mouldCount = products.reduce((n, p) => n + p.mouldings.length, 0);

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, 'catalog.json'), JSON.stringify(catalog, null, 2));
console.log(`Wrote catalog.json: ${products.length} products, ${skuCount} plank SKUs, ${mouldCount} moulding SKUs`);
