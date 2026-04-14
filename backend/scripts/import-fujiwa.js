#!/usr/bin/env node

/**
 * Import Fujiwa Tile product data from price list PDF.
 * Source: Fujiwa Group USA, Inc. Price List (Effective January 15, 2025)
 * Website: https://www.fujiwatiles.com
 *
 * Sections:
 *   1. Pool Tiles (~75 series, sold by sqft)
 *   2. Depth Markers (6 items, sold each)
 *   3. Skimmer Lid Kits (6 items, sold each)
 *   4. Trims (various, sold each/per LF)
 *   5. Watermark Mosaics (~50 decorative art pieces, sold each)
 *
 * Usage: docker compose exec api node scripts/import-fujiwa.js
 */

import pg from 'pg';

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: 5432,
  database: 'flooring_pim',
  user: 'postgres',
  password: 'postgres',
});

// ==================== Category IDs ====================
const CAT_MOSAIC = '650e8400-e29b-41d4-a716-446655440014'; // Mosaic Tile
const CAT_TILE   = '650e8400-e29b-41d4-a716-446655440010'; // Tile
let   CAT_POOL   = null; // Will be created

// ==================== POOL TILE DATA ====================
// Grouped by family. Each family = 1 product.
// Variants: [seriesCode, tileSize, sqftPerUnit, pcsPerUnit, costPerSqft]
// pcsPerUnit: 1 = sheet-based, 4 = individual pieces per sqft

const POOL_TILE_FAMILIES = {
  'ALCO':       { desc: '6" Akron Pool Tile',             variants: [['ALCO',      '6" Akron',               1.08, 1, 6.60]] },
  'ALEX':       { desc: '3" x 3" Pool Tile',              variants: [['ALEX',      '3" x 3"',                1.08, 1, 5.47]] },
  'AMBON':      { desc: '6" Akron Pool Tile',              variants: [['AMBON',     '6" Akron',               1.08, 1, 8.25]] },
  'BOHOL':      { desc: '6" x 6" Pool Tile',              variants: [['BOHOL',     '6" x 6"',                1.00, 4, 18.70]] },
  'BORA':       { desc: '6" x 6" Pool Tile',              variants: [['BORA',      '6" x 6"',                1.00, 4, 6.60]] },
  'CEL':        { desc: '2" x 2" Pool Tile',              variants: [['CEL',       '2" x 2"',                1.08, 1, 6.05]] },
  'CRESTA':     { desc: '4" x 4" Pool Tile',              variants: [['CRESTA',    '4" x 4"',                1.00, 1, 4.95]] },
  'EROS':       { desc: 'Pool Tile',                       variants: [
    ['EROS-1X1', '1-1/8" x 1-1/8"', 1.00, 1, 17.33],
    ['EROS-6X6', '6" x 6"',         1.00, 4, 18.70],
  ]},
  'FGM':        { desc: '3/4" x 3/4" Glass Mosaic',        variants: [['FGM',       '3/4" x 3/4" Glass',      1.15, 1, 5.23]] },
  'FLORA':      { desc: '6" x 6" Pool Tile',              variants: [['FLORA',     '6" x 6"',                1.00, 4, 7.15]] },
  'FUJI':       { desc: '4" x 4" Pool Tile',              variants: [['FUJI',      '4" x 4"',                1.00, 1, 4.95]] },
  'GLASSTEL':   { desc: '7/8" x 1 7/8" Pool Tile',        variants: [['GLASSTEL',  '7/8" x 1 7/8"',          1.00, 1, 7.15]] },
  'GS':         { desc: '6" x 6" Glossy Solid Pool Tile',  variants: [['GS',        '6" x 6" Glossy Solid',   1.00, 4, 6.60]] },
  'HEX':        { desc: '1" Hexagon Pool Tile',            variants: [['HEX',       '1" Hexagon',             0.83, 1, 7.15]] },
  'INKA':       { desc: '6" x 6" Pool Tile',              variants: [['INKA',      '6" x 6"',                1.00, 4, 7.15]] },
  'JAVA':       { desc: '6" x 6" Pool Tile',              variants: [['JAVA',      '6" x 6"',                1.00, 4, 7.15]] },
  'JOYA':       { desc: 'Pool Tile',                       variants: [
    ['JOYA-1x1',  '1" x 1"',   1.08, 1, 17.33],
    ['JOYA-3x3',  '3" x 3"',   1.08, 1, 17.33],
    ['JOYA-Deco', '6" Akron',   1.08, 1, 18.70],
    ['JOYA-6x6',  '6" x 6"',   1.00, 4, 18.70],
  ]},
  'KASURI':     { desc: '6" x 6" Pool Tile',              variants: [['KASURI',    '6" x 6"',                1.00, 4, 18.70]] },
  'KAWA':       { desc: '6" x 6" Pool Tile',              variants: [['KAWA',      '6" x 6"',                1.00, 4, 18.70]] },
  'KENJI':      { desc: '6" x 6" Pool Tile',              variants: [['KENJI',     '6" x 6"',                1.00, 4, 6.60]] },
  'KLM':        { desc: '3" x 3" Pool Tile',              variants: [['KLM',       '3" x 3"',                1.08, 1, 6.33]] },
  'KOLN':       { desc: '2" x 6" Pool Tile',              variants: [['KOLN',      '2" x 6"',                1.08, 1, 4.73]] },
  'LANTERN':    { desc: '2" Arabesque Pool Tile',          variants: [
    ['LANTERN',    '2" Arabesque (Matte)',    1.08, 1, 6.33],
    ['LANTERN-MT', '2" Arabesque (Metallic)', 1.08, 1, 8.25],
  ]},
  'LEGACY':     { desc: '2" Random Block Pool Tile',       variants: [['LEGACY',    '2" Random Block',        1.00, 1, 17.33]] },
  'LICATA':     { desc: '1 1/8" x 2 1/4" Pool Tile',      variants: [['LICATA',    '1 1/8" x 2 1/4"',        1.00, 1, 17.33]] },
  'LOMBO':      { desc: '1/2" x 3 1/4" Pool Tile',        variants: [
    ['LOMBO-Metallic',     '1/2" x 3 1/4" Metallic',     1.18, 1, 8.25],
    ['LOMBO-Non Metallic', '1/2" x 3 1/4" Non Metallic', 1.18, 1, 7.15],
  ]},
  'LUNAR':      { desc: '6" x 6" Pool Tile',              variants: [['LUNAR',     '6" x 6"',                1.00, 4, 18.70]] },
  'LYRA':       { desc: '6" x 6" Pool Tile',              variants: [['LYRA',      '6" x 6"',                1.00, 4, 7.15]] },
  'NAMI':       { desc: 'Pool Tile',                       variants: [
    ['NAMI-1X1', '1-1/8" x 1-1/8"', 1.00, 1, 17.33],
    ['NAMI-6X6', '6" x 6"',         1.00, 4, 18.70],
  ]},
  'NET':        { desc: '6" Pool Tile',                    variants: [['NET',       '6"',                     1.00, 4, 5.23]] },
  'OMEGA':      { desc: 'Random Pool Tile',                variants: [['OMEGA',     'Random',                 1.00, 1, 18.70]] },
  'PAD':        { desc: '1" x 1" Pool Tile',               variants: [['PAD',       '1" x 1"',                1.08, 1, 6.05]] },
  'PATINA':     { desc: '6" x 6" Pool Tile',              variants: [['PATINA',    '6" x 6"',                1.00, 4, 6.60]] },
  'PEB':        { desc: '1" x 1" Pool Tile',               variants: [['PEB',       '1" x 1"',                1.08, 1, 6.05]] },
  'PEBBLESTONE':{ desc: 'Pebblestone Pool Tile',           variants: [['PEBBLESTONE','Pebblestone',            0.83, 1, 6.33]], sellByUnit: true },
  'PILOS':      { desc: 'Random Pool Tile',                variants: [['PILOS',     'Random',                 1.00, 1, 17.33]] },
  'PLANET':     { desc: 'Pool Tile',                       variants: [
    ['PLANET-1x1', '1" x 1"', 1.08, 1, 17.33],
    ['PLANET-3x3', '3" x 3"', 1.08, 1, 17.33],
    ['PLANET-6x6', '6" x 6"', 1.00, 4, 18.70],
  ]},
  'PNR':        { desc: '3/4" Penny Round Pool Tile',      variants: [['PNR',       '3/4" Penny Round',       1.02, 1, 7.15]] },
  'PRIMA':      { desc: '4" x 4" Pool Tile',              variants: [['PRIMA',     '4" x 4"',                1.00, 1, 4.95]] },
  'QUARZO':     { desc: '6 1/4" x 16" Pool Tile',         variants: [['QUARZO',    '6 1/4" x 16"',           0.70, 1, 7.15]] },
  'RIO':        { desc: '6" x 6" Pool Tile',              variants: [['RIO',       '6" x 6"',                1.00, 4, 6.60]] },
  'RIVERA':     { desc: '1" x 2 1/4" Pool Tile',          variants: [['RIVERA',    '1" x 2 1/4"',            1.00, 1, 6.05]] },
  'RUST':       { desc: '3" x 3" Pool Tile',              variants: [['RUST',      '3" x 3"',                1.08, 1, 5.47]] },
  'SAGA':       { desc: 'Pool Tile',                       variants: [
    ['SAGA-1X1', '1-1/8" x 1-1/8"', 1.00, 1, 17.33],
    ['SAGA-6X6', '6" x 6"',         1.00, 4, 18.70],
  ]},
  'SEKIS':      { desc: '6" x 6" Pool Tile',              variants: [['SEKIS',     '6" x 6"',                1.00, 4, 6.05]] },
  'SIERRA':     { desc: '6" x 6" Pool Tile',              variants: [['SIERRA',    '6" x 6"',                1.00, 4, 5.23]] },
  'SMALT':      { desc: '6" x 6" Pool Tile',              variants: [['SMALT',     '6" x 6"',                1.00, 4, 5.23]] },
  'SORA':       { desc: '6" x 6" Pool Tile',              variants: [['SORA',      '6" x 6"',                1.00, 4, 18.70]] },
  'STAK':       { desc: '6" Akron Pool Tile',              variants: [['STAK',      '6" Akron',               1.08, 1, 18.70]] },
  'STAR':       { desc: '6" x 6" Pool Tile',              variants: [['STAR',      '6" x 6"',                1.00, 4, 18.70]] },
  'STONELEDGE': { desc: '6" x 6" Pool Tile',              variants: [['STONELEDGE','6" x 6"',                1.00, 4, 18.70]] },
  'STQ':        { desc: '1" x 1" Pool Tile',               variants: [['STQ',       '1" x 1"',                1.08, 1, 17.33]] },
  'STS':        { desc: '3" x 3" Pool Tile',              variants: [['STS',       '3" x 3"',                1.08, 1, 17.33]] },
  'SYDNEY':     { desc: '6" Akron Pool Tile',              variants: [['SYDNEY',    '6" Akron',               1.08, 1, 6.60]] },
  'TILIS':      { desc: '6" x 13.3/4" Listello Pool Tile', variants: [['TILIS',     '6" x 13-3/4" Listello',  1.15, 1, 8.25]] },
  'TITAN':      { desc: 'Pool Tile',                       variants: [
    ['TITAN-3X3',  '3" x 3"',   1.08, 1, 6.33],
    ['TITAN-Deco', '6" Akron',   1.08, 1, 8.25],
    ['TITAN-6X6',  '6" x 6"',   1.00, 4, 6.60],
  ]},
  'TNT':        { desc: '1" x 1" Pool Tile',               variants: [['TNT',       '1" x 1"',                1.08, 1, 6.05]] },
  'TOKYO':      { desc: 'Pool Tile',                       variants: [
    ['TOKYO-1x1', '1-1/8" x 1-1/8"', 1.00, 1, 17.33],
    ['TOKYO-2X3', '2" x 3"',         1.00, 1, 17.33],
    ['TOKYO-6x6', '6" x 6"',         1.00, 4, 18.70],
  ]},
  'UNG':        { desc: 'Unglazed Pool Tile',              variants: [
    ['UNG-BW',   '1" & 2" Black & White', 1.80, 1, 9.00],
    ['UNG-BLUE', '1" & 2" Blue',          1.80, 1, 10.20],
  ]},
  'VENIZ':      { desc: '3" x 3" Pool Tile',              variants: [['VENIZ',     '3" x 3"',                1.08, 1, 6.33]] },
  'VIGAN':      { desc: '6" x 6" Pool Tile',              variants: [['VIGAN',     '6" x 6"',                1.00, 4, 7.15]] },
  'VINTA':      { desc: '2" x 4" Pool Tile',              variants: [['VINTA',     '2" x 4"',                1.00, 1, 7.15]] },
  'VIP/S':      { desc: '3" x 3" Pool Tile',              variants: [['VIP-S',     '3" x 3"',                1.08, 1, 6.05]] },
  'YOMBA':      { desc: '6" x 6" Pool Tile',              variants: [['YOMBA',     '6" x 6"',                1.00, 4, 18.70]] },
  'YUCCA':      { desc: '6" x 6" Pool Tile',              variants: [['YUCCA',     '6" x 6"',                1.00, 4, 4.90]] },
};

// ==================== DEPTH MARKERS ====================
const DEPTH_MARKERS = [
  ['SMOOTH-FT',     '6" x 6" Smooth with black letter (with "FT")',          10.80],
  ['SMOOTH-NUM',    '6" x 6" Smooth with black letter (Numbers only)',        5.40],
  ['SMOOTH-NODIVE', '6" International No Diving Symbol',                      10.80],
  ['NONSKID-FT',    '6" x 6" Non-Skid with black letter (with "FT")',        10.80],
  ['NONSKID-NUM',   '6" x 6" Non-Skid with black letter (Numbers only)',      5.40],
  ['NONSKID-NODIVE','6" Non-Skid International No Diving Symbol',             10.80],
];

// ==================== SKIMMER LID KITS ====================
const SKIMMER_KITS = [
  ['HSL-12-04',  'Hide 12" Skimmer Lid Kit 0.4"',  240.00],
  ['HSL-12-08',  'Hide 12" Skimmer Lid Kit 0.8"',  240.00],
  ['HSL-12-12',  'Hide 12" Skimmer Lid Kit 1.2"',  240.00],
  ['HSL-12-16',  'Hide 12" Skimmer Lid Kit 1.6"',  270.00],
  ['HSL-12-2',   'Hide 12" Skimmer Lid Kit 2"',    270.00],
  ['HSL-12-25',  'Hide 12" Skimmer Lid Kit 2.5"',  270.00],
];

// ==================== TRIMS ====================
const TRIMS = [
  ['TRIM-3X3-ORE',     '3" x 3" O.R.E. / S.B.N Trim',           5.40, 'per_unit', 'Alex, KLM, RF, Titan-3", Veniz, VIP/S'],
  ['TRIM-3X3-TRE',     '3" x 3" T.R.E. / DA Trim',              5.40, 'per_unit', 'Alex, KLM, RF, Titan-3", Veniz, VIP/S'],
  ['TRIM-1X3-BEAD',    '1" x 3" BEAD/1/4 Round Trim',           5.40, 'per_unit', 'KLM, Lark, RA, RF, Veniz, VIP/S'],
  ['TRIM-BEAK',        'Beak Trim',                               5.40, 'per_unit', 'KLM, Lark, RA, RF, Veniz, VIP/S'],
  ['TRIM-3X6-SBN',     '3" x 6" SBN Trim',                       5.40, 'per_unit', 'Crossroad, Net'],
  ['TRIM-6X6-SBN',     '6" x 6" SBN Trim',                       5.40, 'per_unit', 'Rio, Kenji, Vigan, Lyra, Patina, Sekis, Titan-6", GS, Inka, Java'],
  ['TRIM-3X3-ORE-UP',  '3" x 3" O.R.E. / S.B.N Trim (Upgrade)', 10.80, 'per_unit', 'Joya, Planet, STS'],
  ['TRIM-1X6-BEAD-UP', '1" x 6" BEAD/1/4 Round Trim (Upgrade)',  5.40, 'per_unit', 'Kawa, Kasuri, Bohol, Eros, Epica, Troy, Joya + more'],
  ['TRIM-BEAK-UP',     'Beak Trim (Upgrade)',                     5.40, 'per_unit', 'Kawa, Kasuri, Bohol, Eros, Epica, Troy, Joya + more'],
];

// ==================== WATERMARK MOSAICS ====================
// Grouped by design. Keys match the canonical product names used post-overhaul
// (see fujiwa-naming-overhaul.cjs) — they mirror Fujiwa's own website naming.
// [itemCode, description, size, sizeLabel, cost]
const WATERMARK_FAMILIES = {
  'Angel Fish':           { variants: [['Z-FIL-13', '13" x 14"', 'Large', 132], ['Z-FIS-13', '8" x 8"', 'Small', 81]] },
  'Ball':                 { variants: [['Z-BALL-01', '8"', 'Standard', 66]] },
  'Butterfly Fish':       { variants: [['Z-FIL-11', '14" x 14"', 'Large', 132], ['Z-FIS-11', '9" x 9"', 'Small', 81]] },
  'Clown Fish':           { variants: [['Z-FIL-05', '16" x 11"', 'Large', 132], ['Z-FIS-05', '11" x 6"', 'Small', 81]] },
  'Coral Fish':           { variants: [['Z-FIL-01', '13" x 15"', 'Large', 132], ['Z-FIS-01', '9" x 10"', 'Small', 81]] },
  'Crab':                 { variants: [['Z-CRL-30', '13" x 8"', 'Large', 96], ['Z-CRS--32', '6" x 5"', 'Small', 48]] },
  'Circle Dolphin':       { variants: [['Z-CDG-101', '45" x 45"', 'Standard', 750]] },
  'Dolphin':              { variants: [['Z-DOL-81', '34" x 23"', 'Large', 225], ['Z-DOS-81', '21" x 14"', 'Small', 171]] },
  'Kelp Fish':            { variants: [['Z-FIL-03', '13" x 15"', 'Large', 132], ['Z-FIS-03', '10" x 8"', 'Small', 81]] },
  'Lobster':              { variants: [['Z-LBL-40', '13" x 10"', 'Large', 105], ['Z-LBS-41', '8" x 4"', 'Small', 66]] },
  'Mermaid With Dolphin': { variants: [['Z-MER-01', '47" x 57"', 'Standard', 960]] },
  'Porpoise':             { variants: [['Z-POL-90', '34" x 23"', 'Large', 225], ['Z-POS-90', '21" x 14"', 'Small', 171]] },
  'Puffer Fish':          { variants: [['Z-FIL-20', '10" x 7"', 'Standard', 81]] },
  'Sand Crab':            { variants: [['Z-SCL-34', '10" x 8"', 'Large', 87]] },
  'Sand Dollar':          { variants: [['Z-SHL-57', '4" x 4"', 'Standard', 48]] },
  'Seahorse Blue':        { variants: [['Z-SHL-60', '10" x 20"', 'Large', 132]] },
  'Seahorse':             { variants: [['Z-SHM-62', '5" x 10"', 'Medium', 81]] },
  'Spotted Fish':         { variants: [['Z-FIL-09', '15" x 9"', 'Large', 132], ['Z-FIS-09', '10" x 7"', 'Small', 81]] },
  'Star Shell':           { variants: [['Z-SHL-51', '5" x 4"', 'Standard', 48]] },
  'Starfish Blue':        { variants: [['Z-STS-100', '5" x 5"', 'Standard', 48]] },
  'Starfish Peach':       { variants: [['Z-STL-100', '7" x 7"', 'Standard', 48]] },
  'Starfish Red':         { variants: [['Z-STM-100', '8" x 4"', 'Standard', 48]] },
  'Starfish 2 Tone Blue': { variants: [['Z-STS-101', '5" x 5"', 'Standard', 48]] },
  'Starfish Orange':      { variants: [['Z-STL-101', '7" x 7"', 'Standard', 48]] },
  'Starfish Yellow':      { variants: [['Z-STM-101', '8" x 4"', 'Standard', 48]] },
  'Tetra Fish':           { variants: [['Z-FIL-07', '16" x 11"', 'Large', 132], ['Z-FIS-07', '9" x 7"', 'Small', 81]] },
  'Turrid Shell':         { variants: [['Z-SHL-53', '3" x 4"', 'Standard', 48]] },
  'Turtle Brown':         { variants: [['Z-CTL-60', '27" x 24"', 'Large', 237], ['Z-CTS-64', '15" x 13"', 'Small', 165]] },
  'Turtle':               { variants: [
    ['Z-TLL-50', '27" x 24"', 'Large', 198],
    ['Z-TLM-52', '19" x 11"', 'Medium', 147],
    ['Z-TIS-54', '15" x 13"', 'Small', 147],
    ['Z-TLB-58', '5" x 5"',   'Baby', 54],
  ]},
};

// ==================== Helpers ====================

async function upsertProduct(vendor_id, { name, collection, category_id, description_short }) {
  const result = await pool.query(`
    INSERT INTO products (vendor_id, name, collection, category_id, status, description_short)
    VALUES ($1, $2, $3, $4, 'draft', $5)
    ON CONFLICT ON CONSTRAINT products_vendor_collection_name_unique DO UPDATE SET
      category_id = COALESCE(EXCLUDED.category_id, products.category_id),
      description_short = COALESCE(EXCLUDED.description_short, products.description_short),
      updated_at = CURRENT_TIMESTAMP
    RETURNING id, (xmax = 0) AS is_new
  `, [vendor_id, name, collection || '', category_id || null, description_short || null]);
  return result.rows[0];
}

async function upsertSku(product_id, { vendor_sku, internal_sku, variant_name, sell_by, variant_type }) {
  const result = await pool.query(`
    INSERT INTO skus (product_id, vendor_sku, internal_sku, variant_name, sell_by, variant_type)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (internal_sku) DO UPDATE SET
      product_id = EXCLUDED.product_id,
      vendor_sku = COALESCE(EXCLUDED.vendor_sku, skus.vendor_sku),
      variant_name = COALESCE(EXCLUDED.variant_name, skus.variant_name),
      sell_by = COALESCE(EXCLUDED.sell_by, skus.sell_by),
      variant_type = COALESCE(EXCLUDED.variant_type, skus.variant_type),
      updated_at = CURRENT_TIMESTAMP
    RETURNING id, (xmax = 0) AS is_new
  `, [product_id, vendor_sku, internal_sku, variant_name || null, sell_by || 'sqft', variant_type || null]);
  return result.rows[0];
}

async function upsertPricing(sku_id, { cost, retail_price, price_basis }) {
  await pool.query(`
    INSERT INTO pricing (sku_id, cost, retail_price, price_basis)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (sku_id) DO UPDATE SET
      cost = EXCLUDED.cost,
      retail_price = EXCLUDED.retail_price,
      price_basis = EXCLUDED.price_basis
  `, [sku_id, cost, retail_price, price_basis || 'per_sqft']);
}

async function upsertPackaging(sku_id, { sqft_per_box }) {
  await pool.query(`
    INSERT INTO packaging (sku_id, sqft_per_box)
    VALUES ($1, $2)
    ON CONFLICT (sku_id) DO UPDATE SET
      sqft_per_box = COALESCE(EXCLUDED.sqft_per_box, packaging.sqft_per_box)
  `, [sku_id, sqft_per_box]);
}

async function setAttr(sku_id, slug, value) {
  if (!value) return;
  const attr = await pool.query('SELECT id FROM attributes WHERE slug = $1', [slug]);
  if (!attr.rows.length) return;
  await pool.query(`
    INSERT INTO sku_attributes (sku_id, attribute_id, value)
    VALUES ($1, $2, $3)
    ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value = EXCLUDED.value
  `, [sku_id, attr.rows[0].id, String(value).trim()]);
}

// ==================== Main ====================

async function main() {
  // Ensure vendor exists
  let vendorRes = await pool.query("SELECT id FROM vendors WHERE code = 'FUJIWA'");
  let vendorId;
  if (!vendorRes.rows.length) {
    const ins = await pool.query(`
      INSERT INTO vendors (name, code, website, email)
      VALUES ('Fujiwa Tile', 'FUJIWA', 'https://www.fujiwatiles.com', 'info@fujiwatiles.com')
      RETURNING id
    `);
    vendorId = ins.rows[0].id;
    console.log(`Created vendor: Fujiwa Tile (${vendorId})`);
  } else {
    vendorId = vendorRes.rows[0].id;
    console.log(`Using existing vendor: Fujiwa Tile (${vendorId})`);
  }

  // Create Pool Tile category if needed
  const poolCatRes = await pool.query("SELECT id FROM categories WHERE slug = 'pool-tile'");
  if (poolCatRes.rows.length) {
    CAT_POOL = poolCatRes.rows[0].id;
  } else {
    const catIns = await pool.query(`
      INSERT INTO categories (name, slug, parent_id)
      VALUES ('Pool Tile', 'pool-tile', $1)
      RETURNING id
    `, [CAT_TILE]);
    CAT_POOL = catIns.rows[0].id;
    console.log(`Created category: Pool Tile (${CAT_POOL})`);
  }

  let productsCreated = 0, productsUpdated = 0, skusCreated = 0, skusUpdated = 0;

  // ==================== 1. POOL TILES ====================
  // NOTE: product names here are the price-list codes ('ALCO', 'BORA', ...).
  // After first import, scripts/fujiwa-naming-overhaul.cjs renames these to
  // the canonical Fujiwa series names ('Alco Deco', 'Bora', ...) and the
  // Fujiwa scraper keeps them in sync via vendor_sku fallback lookup.
  console.log('\n--- Importing Pool Tiles ---');
  for (const [familyName, family] of Object.entries(POOL_TILE_FAMILIES)) {
    const product = await upsertProduct(vendorId, {
      name: familyName,
      collection: 'Pool Tile',
      category_id: CAT_POOL,
      description_short: family.desc,
    });
    if (product.is_new) productsCreated++; else productsUpdated++;

    for (const [seriesCode, tileSize, sqftPerUnit, pcsPerUnit, costPerSqft] of family.variants) {
      const internalSku = `FUJIWA-${seriesCode}`;
      const isSingleVariant = family.variants.length === 1;
      const variantName = isSingleVariant ? tileSize : tileSize;

      const sellBy = family.sellByUnit ? 'unit' : 'sqft';
      const priceBasis = family.sellByUnit ? 'per_unit' : 'per_sqft';

      const sku = await upsertSku(product.id, {
        vendor_sku: seriesCode,
        internal_sku: internalSku,
        variant_name: variantName,
        sell_by: sellBy,
      });
      if (sku.is_new) skusCreated++; else skusUpdated++;

      const retailPrice = +(costPerSqft * 2.0).toFixed(2);
      await upsertPricing(sku.id, { cost: costPerSqft, retail_price: retailPrice, price_basis: priceBasis });

      // Packaging: sqft per sheet/set
      if (!family.sellByUnit) {
        await upsertPackaging(sku.id, { sqft_per_box: sqftPerUnit });
      }

      // Attributes
      await setAttr(sku.id, 'size', tileSize);
      await setAttr(sku.id, 'material', 'Ceramic');
      await setAttr(sku.id, 'brand', 'Fujiwa');
    }

    const variantCount = family.variants.length;
    console.log(`  ${product.is_new ? '+' : '~'} ${familyName} (${variantCount} variant${variantCount > 1 ? 's' : ''})`);
  }

  // ==================== 2. DEPTH MARKERS ====================
  console.log('\n--- Importing Depth Markers ---');
  const dmProduct = await upsertProduct(vendorId, {
    name: 'Depth Markers',
    collection: 'Pool Accessories',
    category_id: CAT_POOL,
    description_short: 'Pool depth markers — smooth and non-skid options',
  });
  if (dmProduct.is_new) productsCreated++; else productsUpdated++;

  for (const [code, desc, cost] of DEPTH_MARKERS) {
    const internalSku = `FUJIWA-DM-${code}`;
    const sku = await upsertSku(dmProduct.id, {
      vendor_sku: `DM-${code}`,
      internal_sku: internalSku,
      variant_name: desc,
      sell_by: 'unit',
      variant_type: 'accessory',
    });
    if (sku.is_new) skusCreated++; else skusUpdated++;

    const retailPrice = +(cost * 2.0).toFixed(2);
    await upsertPricing(sku.id, { cost, retail_price: retailPrice, price_basis: 'per_unit' });
    await setAttr(sku.id, 'brand', 'Fujiwa');

    console.log(`  ${sku.is_new ? '+' : '~'} ${desc} — $${cost}`);
  }

  // ==================== 3. SKIMMER LID KITS ====================
  console.log('\n--- Importing Skimmer Lid Kits ---');
  const slProduct = await upsertProduct(vendorId, {
    name: 'Hide 12" Skimmer Lid Kit',
    collection: 'Pool Accessories',
    category_id: CAT_POOL,
    description_short: 'Hide 12" skimmer lid kit — various thicknesses',
  });
  if (slProduct.is_new) productsCreated++; else productsUpdated++;

  for (const [code, desc, cost] of SKIMMER_KITS) {
    const internalSku = `FUJIWA-${code}`;
    const sku = await upsertSku(slProduct.id, {
      vendor_sku: code,
      internal_sku: internalSku,
      variant_name: desc,
      sell_by: 'unit',
      variant_type: 'accessory',
    });
    if (sku.is_new) skusCreated++; else skusUpdated++;

    const retailPrice = +(cost * 1.5).toFixed(2);
    await upsertPricing(sku.id, { cost, retail_price: retailPrice, price_basis: 'per_unit' });
    await setAttr(sku.id, 'brand', 'Fujiwa');

    console.log(`  ${sku.is_new ? '+' : '~'} ${desc} — $${cost}`);
  }

  // ==================== 4. TRIMS ====================
  console.log('\n--- Importing Trims ---');
  const trimProduct = await upsertProduct(vendorId, {
    name: 'Pool Tile Trims',
    collection: 'Pool Accessories',
    category_id: CAT_POOL,
    description_short: 'Trim pieces for Fujiwa pool tile series',
  });
  if (trimProduct.is_new) productsCreated++; else productsUpdated++;

  for (const [code, desc, cost, _priceBasis, compatibleSeries] of TRIMS) {
    const internalSku = `FUJIWA-${code}`;
    const sku = await upsertSku(trimProduct.id, {
      vendor_sku: code,
      internal_sku: internalSku,
      variant_name: desc,
      sell_by: 'unit',
      variant_type: 'accessory',
    });
    if (sku.is_new) skusCreated++; else skusUpdated++;

    const retailPrice = +(cost * 2.0).toFixed(2);
    await upsertPricing(sku.id, { cost, retail_price: retailPrice, price_basis: 'per_unit' });
    await setAttr(sku.id, 'brand', 'Fujiwa');

    console.log(`  ${sku.is_new ? '+' : '~'} ${desc} — $${cost}`);
  }

  // ==================== 5. WATERMARK MOSAICS ====================
  console.log('\n--- Importing Watermark Mosaics ---');
  for (const [designName, family] of Object.entries(WATERMARK_FAMILIES)) {
    const product = await upsertProduct(vendorId, {
      name: designName,
      collection: 'Watermark Mosaics',
      category_id: CAT_MOSAIC,
      description_short: `Watermark Mosaic — ${designName} — Decorative Pool Art`,
    });
    if (product.is_new) productsCreated++; else productsUpdated++;

    for (const [itemCode, size, sizeLabel, cost] of family.variants) {
      const internalSku = `FUJIWA-${itemCode}`;
      const variantName = family.variants.length === 1 ? size : `${sizeLabel} (${size})`;

      const sku = await upsertSku(product.id, {
        vendor_sku: itemCode,
        internal_sku: internalSku,
        variant_name: variantName,
        sell_by: 'unit',
      });
      if (sku.is_new) skusCreated++; else skusUpdated++;

      const retailPrice = +(cost * 2.0).toFixed(2);
      await upsertPricing(sku.id, { cost, retail_price: retailPrice, price_basis: 'per_unit' });

      await setAttr(sku.id, 'size', size);
      await setAttr(sku.id, 'material', 'Ceramic Mosaic');
      await setAttr(sku.id, 'brand', 'Fujiwa');
    }

    const variantCount = family.variants.length;
    console.log(`  ${product.is_new ? '+' : '~'} ${designName} (${variantCount} size${variantCount > 1 ? 's' : ''})`);
  }

  // ==================== Summary ====================
  console.log('\n=== Import Complete ===');
  console.log(`Products: ${productsCreated} created, ${productsUpdated} updated`);
  console.log(`SKUs:     ${skusCreated} created, ${skusUpdated} updated`);
  console.log('');

  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
