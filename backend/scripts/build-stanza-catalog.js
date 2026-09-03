#!/usr/bin/env node
/**
 * Build Stanza catalog.json + images.json from the transcribed 2025 price list
 * and the scraped product-page image galleries.
 *
 * Stanza International LLC (Chino, CA) — natural-stone pebble & marble mosaic
 * distributor. The PDF "WHOLESALE" column is Roma's COST; retail = cost x 1.6
 * keystone rounded to $0.05 (store standard since the 2026-07 reprice).
 *
 * Selling conventions ([[selling-conventions]]):
 *   - Mosaic sheets sell PER SHEET: sell_by='unit', price_basis='per_unit',
 *     packaging.sqft_per_box = coverage of ONE sheet, pieces_per_box = 1
 *     (the per-unit-coverage pattern used by import-genuine-materials slabs).
 *   - Standing-pebble strips priced per sqft by the vendor sell by the box:
 *     sell_by='box', price_basis='per_sqft', sqft_per_box = box coverage.
 *   - Vessel sinks sell per unit.
 *
 * Images: the FIRST scraped image is the product-page main photo (primary);
 * the rest are the gallery in page order (alternates). Scraped data lives in
 * scraped.json keyed by normalized item code (see norm()).
 *
 * Usage: node scripts/build-stanza-catalog.js [path/to/scraped.json]
 * Emits: backend/data/stanza/catalog.json and images.json
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data', 'stanza');
const SCRAPED_PATH = process.argv[2] || path.join(DATA_DIR, 'scraped.json');
const scraped = JSON.parse(fs.readFileSync(SCRAPED_PATH, 'utf8'));

const norm = (code) => code.toUpperCase().replace(/[^A-Z0-9]/g, '');
const round05 = (n) => Math.round((n * 1.6) / 0.05) * 0.05;
const money = (n) => Math.round(n * 100) / 100;

// coverage (sqft) of a single mesh sheet, by size key
const COVER = { '12x12': 1.0, '6x6hex': 0.65, '17.7x17.7': 2.18, '4x12': 1 / 3, 'sink': null };

// ---- PDF rows: [code, name, colorDesc, cost, size, pcsPerCarton, mode] ----
// mode: 'sheet' (per-sheet unit, default), 'sqft' (per-sqft box), 'unit' (sink)
const COLLECTIONS = [
  ['Tumbled Pebble Mesh', 'natural pebble stone with a tumbled matte surface', [
    ['TT 102', 'Tahiti', 'matte black', 6.75, '12x12', 11, 'sheet'],
    ['TT 104', 'Rio', 'matte mixed earth tones', 6.75, '12x12', 11, 'sheet'],
  ]],
  ['Polished Pebble Mesh', 'natural pebble stone with a polished surface', [
    ['PT 102', 'Black Pearl', 'polished black', 6.75, '12x12', 10, 'sheet'],
    ['PT 104', 'Mixed Salad', 'polished mixed colors', 6.75, '12x12', 11, 'sheet'],
    ['PT 105', 'Red Cranberry', 'polished red / cranberry', 6.75, '12x12', 11, 'sheet'],
  ]],
  ['Leveled Indonesian Pebble Mosaic', 'leveled Indonesian pebble mosaic', [
    ['SA-PT201', 'Taipei Green', 'green pebble', 6.75, '12x12', 11, 'sheet'],
    ['SA-PT202', 'Wonderland', 'white, grey & black pebble', 6.75, '12x12', 11, 'sheet'],
    ['SA-PT203', 'Timor White', 'tumbled white pebble', 6.75, '12x12', 11, 'sheet'],
    ['SA-PT204', 'Jubilee', 'tumbled white, green & black pebble', 6.75, '12x12', 11, 'sheet'],
    ['SA-PT205', 'Jave-Tan', 'natural tan, white & grey pebble', 6.75, '12x12', 11, 'sheet'],
    ['SA-PT207', 'Tiger', 'natural mixed-color pebble', 6.75, '12x12', 11, 'sheet'],
    ['SA-PT209', 'OceaNest', 'natural mixed-color pebble', 6.75, '12x12', 11, 'sheet'],
  ]],
  ['Standing Pebble', 'natural standing pebble arranged vertically', [
    ['SP 102', 'Eclipse', 'black standing pebble', 12.00, '4x12', 5, 'sqft'],
    ['SP 102-H', 'Dark Knight', 'matte-finished black standing pebble', 8.00, '12x12', 6, 'sheet'],
    ['SP 104', 'Rainbow', 'mixed-color standing pebble', 12.00, '4x12', 5, 'sqft'],
  ]],
  ['Flat Pebble Mesh', 'flat-topped natural pebble mosaic', [
    ['FP 102', 'Charcoal', 'black flat pebble', 8.98, '12x12', 5, 'sheet'],
    ['FP 103', 'Birch', 'white flat pebble', 8.98, '12x12', 5, 'sheet'],
    ['FP 104', 'Forrest', 'mixed flat pebble', 8.98, '12x12', 5, 'sheet'],
    ['FP 105', 'Redwood', 'red flat pebble', 8.98, '12x12', 5, 'sheet'],
    ['FP 107', 'Mountain Grey', 'matte mixed grey flat pebble', 8.98, '12x12', 5, 'sheet'],
    ['FP 108', 'Sandy Beach', 'grey/silver polished flat pebble', 8.98, '12x12', 5, 'sheet'],
    ['FP 201', 'Rustic Birch', 'Athens Grey + Wooden White marble flat pebble', 8.98, '12x12', 10, 'sheet'],
    ['FP 202', 'Poppy Seed', 'black flat pebble, matte finish', 8.98, '12x12', 5, 'sheet'],
    ['FP 203', 'Island White', 'oval-shape Timor White flat pebble', 8.98, '12x12', 11, 'sheet'],
    ['FP 203-R', 'Coin Island White', 'coin-shape Timor White flat pebble', 8.98, '12x12', 11, 'sheet'],
    ['FP 207', 'Greco-Roman', 'Athens Grey + Wooden White + Carrara White marble', 8.98, '12x12', 10, 'sheet'],
  ]],
  ['Jade Stone Mosaic', 'jade & marble flat-pebble mosaic', [
    ['FP 306', 'Snowflake', 'white / crystal', 8.60, '12x12', 5, 'sheet'],
    ['FP 307', 'Alaska', 'Carrara White marble tumbled', 8.60, '12x12', 5, 'sheet'],
    ['SA 309', 'Flat Jade', 'green jade flat pebble', 9.98, '12x12', 11, 'sheet'],
    ['PT 311', 'Yellow Jelly', 'yellow onyx flat', 8.98, '12x12', 11, 'sheet'],
    ['PT 312', 'Paladiana', 'capucino & cream white marble', 16.48, '17.7x17.7', 5, 'sheet'],
    ['PT 309', 'Sea Grass', 'flat green jade', 8.60, '12x12', 5, 'sheet'],
    ['PT 316', 'Orion', 'white / black / silver marble', 8.60, '12x12', 5, 'sheet'],
  ]],
  ['Flat Indonesian Stone Mosaic', 'flat Indonesian stone mosaic', [
    ['SA-CP001', 'Tan', 'tan flat pebble', 8.98, '12x12', 11, 'sheet'],
    ['SA-CP002', 'Navajo White', 'white / grey / tan flat pebble', 8.98, '12x12', 11, 'sheet'],
    ['SA-CP004', 'Silver Quartz', 'white / grey / black flat pebble', 8.98, '12x12', 11, 'sheet'],
    ['SA-CP005', 'Sky Green', 'white / green flat pebble', 8.98, '12x12', 11, 'sheet'],
    ['SA-CP006', 'Flat Green', 'flat green (sage moss green)', 8.98, '12x12', 11, 'sheet'],
    ['SA-CP007', 'Bali Mix', 'white, grey, tan, green & black flat pebble', 8.98, '12x12', 11, 'sheet'],
    ['SA-CP009', 'Ganga Gold', 'Calacatta Gold marble tumbled', 10.98, '12x12', 5, 'sheet'],
    ['SA-CP101', 'Fancy Grey', 'special mix grey flat pebble', 8.98, '12x12', 11, 'sheet'],
    ['SA-CP102', 'Alor Black', 'black flat pebble, tumbled', 8.98, '12x12', 11, 'sheet'],
    ['SA-CP105', 'Tuscan Harmony', 'white, tan & red tumbled flat pebble', 8.98, '12x12', 11, 'sheet'],
    ['SA-CP107', 'Fossil Blue', 'earth-tone / blue-grey tumbled flat pebble', 8.98, '12x12', 11, 'sheet'],
    ['SA-CP108', 'Dusty Rose', 'white, tan & capucino tumbled flat pebble', 8.98, '12x12', 11, 'sheet'],
    ['SA-CP116', 'Seafrost', 'white, green & speckle tumbled flat pebble', 8.98, '12x12', 11, 'sheet'],
  ]],
  ['Honeycomb Indonesian Pebble', 'hexagon honeycomb pebble mosaic', [
    ['Honey A1', 'Honeycomb Flat White', 'flat white', 6.75, '6x6hex', 12, 'sheet'],
    ['Honey A2', 'Honeycomb White & Tan Grey', 'white, tan & grey', 6.75, '6x6hex', 12, 'sheet'],
    ['Honey A4', 'Honeycomb Black, Tan & Green', 'black, tan & green', 6.75, '6x6hex', 12, 'sheet'],
    ['Honey B1', 'Honeycomb Flat Capucino', 'flat capucino', 6.75, '6x6hex', 12, 'sheet'],
    ['Honey B2', 'Honeycomb White & Light Grey', 'white & light grey', 6.75, '6x6hex', 12, 'sheet'],
    ['Honey B4', 'Honeycomb Flat Grey', 'flat grey', 6.75, '6x6hex', 12, 'sheet'],
  ]],
  ['Designer Stone Mosaic', 'designer flower-shape & polished stone mosaic', [
    ['SA-DT 202', 'Floresta', 'flower-shape tan, white & grey flat pebble', 9.68, '12x12', null, 'sheet'],
    ['SA-DT 203', 'Magnolia', 'flower-shape tan flat pebble', 9.68, '12x12', null, 'sheet'],
    ['SA-DT 208', 'Spring', 'flower-shape green/golden flat pebble', 9.68, '12x12', null, 'sheet'],
    ['SA-DT 209', 'Autumn', 'flower-shape mixed golden flat pebble', 9.68, '12x12', null, 'sheet'],
    ['DT 102', 'Obsidian', 'polished black flat', 8.98, '12x12', 5, 'sheet'],
    ['DT 104', 'Cinderella', 'high-polished blue / grey', 8.98, '12x12', 5, 'sheet'],
    ['TR 102', 'Mocha', 'high-polished marble, ivory/beige/brown', 8.98, '12x12', 5, 'sheet'],
  ]],
  ['Bubble Pebble 3D', '3D natural pebble mosaic (five sides cut flat, rounded top)', [
    ['Bubble 002', 'Bubble 3D Tan/White/Grey', '3D tan, white & grey', 10.80, '12x12', null, 'sheet'],
    ['Bubble 006', 'Bubble 3D Green', '3D green', 10.80, '12x12', null, 'sheet'],
  ]],
  ['Multi-Finished Hexagon Marble Mosaic', '2" hexagon marble mosaic, multi-finished', [
    ['PW 101', 'Crema Marfil', 'Crema Marfil marble', 11.88, '12x12', null, 'sheet'],
    ['PW 102', 'Marmala White', 'Marmala White marble', 11.88, '12x12', null, 'sheet'],
    ['PW 103', 'Wooden White', 'Wooden White marble, cross-cut', 11.88, '12x12', null, 'sheet'],
  ]],
  ['Handcrafted Natural Stone Vessel Sink', 'handcrafted natural-stone vessel sink', [
    ['DR-001', 'River Rock Sink', 'natural Indonesian river rock', 80.00, 'sink', null, 'unit'],
    ['DF-002', 'Petrified Wood Sink', 'fossilized petrified wood', 180.00, 'sink', null, 'unit'],
  ]],
];

// ---------- public naming ----------
// The vendor is hidden on the storefront (shows as bare code 563), so neither
// product names nor collections may carry "Stanza". Hidden-vendor convention
// (Stone Pride, Icon): name = "{Color} {Descriptive Type}", collection = the
// series descriptor alone.
const NAME_SUFFIX = {
  'Tumbled Pebble Mesh': 'Tumbled Pebble Mosaic',
  'Polished Pebble Mesh': 'Polished Pebble Mosaic',
  'Leveled Indonesian Pebble Mosaic': 'Leveled Indonesian Pebble Mosaic',
  'Standing Pebble': 'Standing Pebble Mosaic',
  'Flat Pebble Mesh': 'Flat Pebble Mosaic',
  'Jade Stone Mosaic': 'Jade Stone Mosaic',
  'Flat Indonesian Stone Mosaic': 'Flat Indonesian Stone Mosaic',
  'Honeycomb Indonesian Pebble': 'Honeycomb Pebble Mosaic',
  'Designer Stone Mosaic': 'Designer Stone Mosaic',
  'Bubble Pebble 3D': '3D Bubble Pebble Mosaic',
  'Multi-Finished Hexagon Marble Mosaic': 'Hexagon Marble Mosaic',
  'Handcrafted Natural Stone Vessel Sink': 'Vessel Sink',
};

// The PDF's item names are colors, some with the series baked in
// ("Honeycomb Flat Grey", "Bubble 3D Green", "River Rock Sink").
function colorOf(name) {
  return name.replace(/^Honeycomb\s+/i, '').replace(/^Bubble 3D\s+/i, '').replace(/\s+Sink$/i, '');
}

// "{Color} {Type}", skipping type words the color already carries
// ("Flat Green" + "Flat Indonesian Stone Mosaic" → "Flat Green Indonesian Stone Mosaic").
function displayName(color, suffix) {
  const have = new Set(color.toLowerCase().split(/\s+/));
  const toks = suffix.split(/\s+/).filter(t => !have.has(t.toLowerCase()));
  return [color, ...toks].join(' ');
}

// ---------- attribute derivation ----------
const SIZE_LABEL = { '12x12': '12" x 12"', '6x6hex': '6" x 6" Hexagon', '17.7x17.7': '17.7" x 17.7"', '4x12': '4" x 12"', 'sink': '' };

function colorFamily(text) {
  const t = text.toLowerCase();
  if (/multi|mixed|rainbow|bali|tuscan|autumn|tiger|paladiana|greco/.test(t)) return 'Multicolor';
  if (/black|charcoal|obsidian|onyx|eclipse|knight/.test(t)) return 'Black';
  if (/white|birch|snow|alaska|carrara|marfil|marmala|island|wonderland|timor/.test(t)) return 'White';
  if (/grey|gray|silver|quartz|mountain|fancy|mocha/.test(t)) return 'Grey';
  if (/green|jade|jelly|forrest|sky|seafrost|floresta|spring/.test(t)) return 'Green';
  if (/blue|fossil|cinderella|ocean/.test(t)) return 'Blue';
  if (/red|redwood|cranberry|poppy/.test(t)) return 'Red';
  if (/gold|ganga|calacatta|yellow/.test(t)) return 'Gold';
  if (/tan|beige|sand|rose|birch|rustic|navajo/.test(t)) return 'Beige';
  return 'Multicolor';
}
function finishOf(coll, colorDesc) {
  const t = (coll + ' ' + colorDesc).toLowerCase();
  if (/polished/.test(t)) return 'Polished';
  if (/honed/.test(t)) return 'Honed';
  if (/tumbled/.test(t)) return 'Tumbled';
  if (/matte/.test(t)) return 'Matte';
  if (/flat/.test(t)) return 'Flat';
  return 'Natural';
}
function shapeOf(coll, name, colorDesc) {
  const t = (coll + ' ' + name + ' ' + colorDesc).toLowerCase();
  if (/hexagon|honeycomb/.test(t)) return 'Hexagon';
  if (/flower|petal/.test(t)) return 'Flower / Petal';
  if (/coin/.test(t)) return 'Coin';
  if (/oval/.test(t)) return 'Oval';
  if (/standing/.test(t)) return 'Standing Strip';
  if (/paladiana/.test(t)) return 'Random / Freeform';
  return 'Pebble';
}
// Keyed off the color description (not the collection name): the "Jade Stone
// Mosaic" collection also carries non-jade marble items (Paladiana, Orion...).
function materialOf(name, colorDesc) {
  const t = (name + ' ' + colorDesc).toLowerCase();
  if (/petrified|river rock/.test(t)) return 'Natural Stone';
  if (/jade/.test(t)) return 'Jade Marble';
  if (/marble|calacatta|carrara|marfil|marmala|capucino|onyx|crystal/.test(t)) return 'Natural Marble';
  return 'Natural Pebble Stone';
}

// ---------- build ----------
const catalog = [];
const images = {};
const missing = [];

for (const [coll, collDesc, rows] of COLLECTIONS) {
  for (const [code, name, colorDesc, cost, size, pcs, mode] of rows) {
    const key = norm(code);
    const slug = 'stanza-' + key.toLowerCase();
    const sc = scraped[key] || {};
    const isSink = mode === 'unit';
    const categorySlug = isSink ? 'bathroom-sinks' : 'mosaic-tile';
    const cover = COVER[size];
    const color = colorOf(name);
    const publicName = displayName(color, NAME_SUFFIX[coll] || coll);

    // pricing / packaging
    let sell_by, price_basis, retail, sqft_per_box, pieces_per_box;
    if (mode === 'unit') {
      sell_by = 'unit'; price_basis = 'per_unit'; retail = round05(cost);
      sqft_per_box = null; pieces_per_box = null;
    } else if (mode === 'sqft') {
      sell_by = 'box'; price_basis = 'per_sqft'; retail = round05(cost);
      sqft_per_box = 5; pieces_per_box = null;
    } else { // 'sheet'
      sell_by = 'unit'; price_basis = 'per_unit'; retail = round05(cost);
      sqft_per_box = cover; pieces_per_box = 1;
    }

    // description: prefer the scraped site copy, else a generated line
    const siteDesc = (sc.desc || '').trim();
    const coverNote = cover ? ` Each ${SIZE_LABEL[size]} mesh-mounted sheet covers ${cover.toFixed(2)} sq ft.` : '';
    const gen = isSink
      ? `Handcrafted ${colorDesc} vessel sink. Each piece is unique in shape, color and size. Sold per unit.`
      : `${publicName} — ${collDesc} in ${colorDesc}.${coverNote} Natural stone; expect natural variation in veining, pits and shade.`;
    const description = siteDesc ? `${siteDesc}${!isSink ? coverNote : ''}` : gen;

    // attrs — no `brand` attribute: the vendor is publicly hidden and the PDP
    // spec table renders every sku_attribute (products.brand_id stays for staff)
    const attrs = {
      collection: coll,
      material: materialOf(name, colorDesc),
      color,
      color_family: colorFamily(name + ' ' + colorDesc),
      product_type: isSink ? 'Vessel Sink' : 'Mosaic Tile',
    };
    if (!isSink) {
      attrs.finish = finishOf(coll, colorDesc);
      attrs.shape = shapeOf(coll, name, colorDesc);
      attrs.pattern = 'Mosaic';
      attrs.size = SIZE_LABEL[size];
      attrs.installation_method = 'Interlocking mesh-mounted sheets';
      attrs.application = 'Floor, Wall, Backsplash, Shower, Pool & Spa';
      if (pcs) attrs.pack_size = mode === 'sqft' ? `${pcs} sq ft per box` : `${pcs} sheets per carton`;
    }

    catalog.push({
      collection: coll,
      name: publicName,
      slug,
      category_slug: categorySlug,
      description,
      attrs,
      skus: [{
        internal_sku: 'STZ-' + key,
        vendor_sku: code,
        // single-SKU products — no size axis, so the variant name is just the
        // color (size lives in the `size` attribute). Avoids the storefront
        // rendering a spurious size variant.
        variant_name: color,
        cost: money(cost),
        retail: money(retail),
        sell_by,
        price_basis,
        sqft_per_box,
        pieces_per_box,
        variant_type: isSink ? 'accessory' : null,
      }],
    });

    // images: first scraped = primary, rest = gallery (in page order)
    const imgs = (sc.images || []).filter(Boolean);
    if (imgs.length) {
      images[slug] = { primary: imgs[0], gallery: imgs.slice(1) };
    } else {
      missing.push(`${code} ${name}${sc.note ? ' — ' + sc.note : ''}`);
    }
  }
}

fs.writeFileSync(path.join(DATA_DIR, 'catalog.json'), JSON.stringify(catalog, null, 2));
fs.writeFileSync(path.join(DATA_DIR, 'images.json'), JSON.stringify(images, null, 2));

console.log(`catalog.json: ${catalog.length} products`);
console.log(`images.json:  ${Object.keys(images).length} products with photos`);
if (missing.length) {
  console.log(`\nNo photos (${missing.length}):`);
  for (const m of missing) console.log('  - ' + m);
}
