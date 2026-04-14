#!/usr/bin/env node

/**
 * Import Johnson Hardwood product data from West Preferred Price List.
 * Source: Johnson Hardwood, Effective November 17, 2025
 * Website: https://johnsonhardwood.com
 *
 * Product categories:
 *   1. Engineered Hardwood (14 series, ~90 SKUs)
 *   2. SPC / Rigid Core Vinyl (4 series, ~47 SKUs)
 *   3. High Performance Flooring (2 series, ~24 SKUs)
 *
 * Pricing: "Preferred" = dealer cost. Retail = cost × 2.0 markup.
 * All products sold per sqft.
 *
 * Usage: docker compose exec api node scripts/import-johnson-hardwood.js
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
const CAT_ENG_HARDWOOD = '650e8400-e29b-41d4-a716-446655440021'; // Engineered Hardwood
const CAT_LVP          = '650e8400-e29b-41d4-a716-446655440031'; // LVP (Plank) — for SPC
const CAT_LAMINATE      = '650e8400-e29b-41d4-a716-446655440090'; // Laminate — for HPF

// ==================== DATA ====================
// Each series: { collection, category, colors: [[name, itemCode]], specs: {...}, cost }
// Species extracted from product names (MAPLE xxx → Maple, OAK xxx → Oak, etc.)

const SERIES = [
  // ======================== ENGINEERED HARDWOOD ========================

  // --- Alehouse Maple ---
  {
    collection: 'Alehouse', category: CAT_ENG_HARDWOOD,
    specs: { finish: 'Vintage', thickness: '1/2"', width: '7-1/2"', length: '11"-83"',
             sqftPerBox: 26, ctnPerPlt: 55, lbsPerCtn: 45, veneer: '2MM', material: 'Engineered Hardwood' },
    cost: 5.05,
    colors: [
      ['Maple Maibock',          'AME-AHM19001', 'Maple'],
      ['Maple Hefeweizen',       'AME-AHM19002', 'Maple'],
      ['Maple Copper Ale',       'AME-AHM19003', 'Maple'],
      ['Maple Barley Ale',       'AME-AHM19004', 'Maple'],
      ['Maple Strawberry Blonde','AME-AHM19005', 'Maple'],
      ['Maple Doppelbock',       'AME-AHM19006', 'Maple'],
    ],
  },
  // --- Alehouse Oak ---
  {
    collection: 'Alehouse', category: CAT_ENG_HARDWOOD,
    specs: { finish: 'Vintage', thickness: '1/2"', width: '7-1/2"', length: '11"-83"',
             sqftPerBox: 26, ctnPerPlt: 55, lbsPerCtn: 45, veneer: '2MM', material: 'Engineered Hardwood' },
    cost: 4.90,
    colors: [
      ['Oak Marzen',  'AME-AHO19008', 'Oak'],
      ['Oak Blonde',  'AME-AHO19009', 'Oak'],
      ['Oak Saison',  'AME-AHO19010', 'Oak'],
    ],
  },
  // --- English Pub Maple ---
  {
    collection: 'English Pub', category: CAT_ENG_HARDWOOD,
    specs: { finish: 'Handscraped', thickness: '1/2"', width: '7-1/2"', length: '11"-83"',
             sqftPerBox: 26, ctnPerPlt: 55, lbsPerCtn: 50, veneer: '2MM', material: 'Engineered Hardwood' },
    cost: 4.90,
    colors: [
      ['Maple Smoked Bourbon', 'AME-EM19001', 'Maple'],
      ['Maple Whiskey',        'AME-EM19002', 'Maple'],
      ['Maple Brandy Wine',    'AME-EM19003', 'Maple'],
      ['Maple Amber Ale',      'AME-EM19004', 'Maple'],
      ['Maple Stout',          'AME-EM19005', 'Maple'],
      ['Maple Cognac',         'AME-EM19006', 'Maple'],
      ['Maple Moonshine',      'AME-EM19007', 'Maple'],
    ],
  },
  // --- English Pub Hickory (Handscraped) ---
  {
    collection: 'English Pub', category: CAT_ENG_HARDWOOD,
    specs: { finish: 'Handscraped', thickness: '1/2"', width: '7-1/2"', length: '11"-83"',
             sqftPerBox: 26, ctnPerPlt: 55, lbsPerCtn: 50, veneer: '2MM', material: 'Engineered Hardwood' },
    cost: 5.50,
    colors: [
      ['Hickory Applejack', 'AME-EH19001', 'Hickory'],
      ['Hickory Rye',       'AME-EH19002', 'Hickory'],
    ],
  },
  // --- English Pub Hickory (Smooth) ---
  {
    collection: 'English Pub', category: CAT_ENG_HARDWOOD,
    specs: { finish: 'Smooth', thickness: '1/2"', width: '7-1/2"', length: '11"-83"',
             sqftPerBox: 26, ctnPerPlt: 55, lbsPerCtn: 50, veneer: '2MM', material: 'Engineered Hardwood' },
    cost: 5.50,
    colors: [
      ['Hickory Porter',  'AME-ESH19001', 'Hickory'],
      ['Hickory Scotch',  'AME-ESH19002', 'Hickory'],
      ['Hickory Pilsner', 'AME-ESH19003', 'Hickory'],
    ],
  },
  // --- Grand Chateau ---
  {
    collection: 'Grand Chateau', category: CAT_ENG_HARDWOOD,
    specs: { finish: 'Wire-Brushed', thickness: '9/16"', width: '8-5/8"', length: '11"-84"',
             sqftPerBox: 31.3, ctnPerPlt: 40, lbsPerCtn: 67, veneer: '3MM', material: 'Engineered Hardwood' },
    cost: 5.45,
    colors: [
      ['European Oak Chambord',   'AME-GC22001', 'European Oak'],
      ['European Oak Barnard',    'AME-GC22002', 'European Oak'],
      ['European Oak Valer',      'AME-GC22003', 'European Oak'],
      ['European Oak Alswick',    'AME-GC22004', 'European Oak'],
      ['European Oak Chillon',    'AME-GC22005', 'European Oak'],
      ['European Oak Corvin',     'AME-GC22006', 'European Oak'],
      ['European Oak Caerphilly', 'AME-GC22007', 'European Oak'],
      ['European Oak Malahide',   'AME-GC22008', 'European Oak'],
      ['European Oak Dover',      'AME-GC22009', 'European Oak'],
      ['European Oak Taunton',    'AME-GC22010', 'European Oak'],
      ['European Oak Aydon',      'AME-GC22011', 'European Oak'],
      ['European Oak Miranda',    'AME-GC22012', 'European Oak'],
    ],
  },
  // --- Oak Grove (standard) ---
  {
    collection: 'Oak Grove', category: CAT_ENG_HARDWOOD,
    specs: { finish: 'Wire-Brushed', thickness: '1/2"', width: '7-1/2"', length: '11"-75"',
             sqftPerBox: 23.4, ctnPerPlt: 55, lbsPerCtn: 42, veneer: '1.2MM', material: 'Engineered Hardwood' },
    cost: 4.30,
    colors: [
      ['Toumey',  'AME-OG19001', 'Oak'],
      ['Laurel',  'AME-OG19002', 'Oak'],
      ['Emory',   'AME-OG19003', 'Oak'],
      ['Willow',  'AME-OG19004', 'Oak'],
      ['Holm',    'AME-OG19005', 'Oak'],
      ['Mohr',    'AME-OG19006', 'Oak'],
      ['Shumard', 'AME-OG19009', 'Oak'],
    ],
  },
  // --- Oak Grove (Prime) ---
  {
    collection: 'Oak Grove', category: CAT_ENG_HARDWOOD,
    specs: { finish: 'Wire-Brushed', thickness: '1/2"', width: '7-1/2"', length: '20"-75"',
             sqftPerBox: 31.09, ctnPerPlt: 35, lbsPerCtn: 55, veneer: '1.8MM Prime', material: 'Engineered Hardwood' },
    cost: 5.50,
    colors: [
      ['Gambel',   'AME-OG19010', 'Oak'],
      ['Chestnut', 'AME-OG19011', 'Oak'],
      ['Bark',     'AME-OG19012', 'Oak'],
    ],
  },
  // --- Tuscan Hickory (Handscraped) ---
  {
    collection: 'Tuscan', category: CAT_ENG_HARDWOOD,
    specs: { finish: 'Handscraped', thickness: '9/16"', width: '4-1/2", 6", 7-1/2"', length: '11"-72"',
             sqftPerBox: 41.5, ctnPerPlt: 30, lbsPerCtn: 90, veneer: '2MM', material: 'Engineered Hardwood' },
    cost: 5.80,
    colors: [
      ['Hickory Sienna',    'AME-E46701', 'Hickory'],
      ['Hickory Florence',  'AME-E46702', 'Hickory'],
      ['Hickory Toscana',   'AME-E46703', 'Hickory'],
      ['Hickory Casentino', 'AME-E46707', 'Hickory'],
    ],
  },
  // --- Tuscan Walnut ---
  {
    collection: 'Tuscan', category: CAT_ENG_HARDWOOD,
    specs: { finish: 'Handscraped', thickness: '9/16"', width: '4-1/2", 6", 7-1/2"', length: '11"-72"',
             sqftPerBox: 41.5, ctnPerPlt: 30, lbsPerCtn: 90, veneer: '2MM', material: 'Engineered Hardwood' },
    cost: 6.10,
    colors: [
      ['Walnut Palazzo', 'AME-E46705', 'Walnut'],
    ],
  },
  // --- Tuscan Walnut (Smooth) ---
  {
    collection: 'Tuscan', category: CAT_ENG_HARDWOOD,
    specs: { finish: 'Smooth', thickness: '9/16"', width: '4-1/2", 6", 7-1/2"', length: '11"-72"',
             sqftPerBox: 41.5, ctnPerPlt: 30, lbsPerCtn: 90, veneer: '2MM', material: 'Engineered Hardwood' },
    cost: 6.10,
    colors: [
      ['Walnut Lucca', 'AME-E46706', 'Walnut'],
    ],
  },
  // --- Tuscan Hickory (Vintage) ---
  {
    collection: 'Tuscan', category: CAT_ENG_HARDWOOD,
    specs: { finish: 'Vintage', thickness: '9/16"', width: '4-1/2", 6", 7-1/2"', length: '11"-72"',
             sqftPerBox: 41.5, ctnPerPlt: 30, lbsPerCtn: 90, veneer: '2MM', material: 'Engineered Hardwood' },
    cost: 5.80,
    colors: [
      ['Hickory Genoa',   'AME-E46709', 'Hickory'],
      ['Hickory Catania', 'AME-E46710', 'Hickory'],
      ['Hickory Arrezo',  'AME-E46711', 'Hickory'],
      ['Hickory Prato',   'AME-E46712', 'Hickory'],
    ],
  },
  // --- Tuscan Maple ---
  {
    collection: 'Tuscan', category: CAT_ENG_HARDWOOD,
    specs: { finish: 'Handscraped', thickness: '1/2"', width: '4-1/2", 6", 7-1/2"', length: '11"-72"',
             sqftPerBox: 41.5, ctnPerPlt: 30, lbsPerCtn: 71, veneer: '2MM', material: 'Engineered Hardwood' },
    cost: 4.59,
    colors: [
      ['Maple Sunset', 'AME-EM46700', 'Maple'],
      ['Maple Verona', 'AME-EM46705', 'Maple'],
    ],
  },
  // --- Canyon Ridge (New Release) ---
  {
    collection: 'Canyon Ridge', category: CAT_ENG_HARDWOOD,
    specs: { finish: 'Light Wire-Brushed', thickness: '1/2"', width: '7-1/2"', length: '11"-75"',
             sqftPerBox: 23.4, ctnPerPlt: 55, lbsPerCtn: 45, veneer: '1.2MM', material: 'Engineered Hardwood' },
    cost: 4.25,
    colors: [
      ['Hickory Sandstone', 'AME-CRH19001', 'Hickory'],
      ['Hickory Amber',     'AME-CRH19002', 'Hickory'],
      ['Hickory Jasper',    'AME-CRH19003', 'Hickory'],
      ['Hickory Topaz',     'AME-CRH19004', 'Hickory'],
      ['Hickory Moonstone', 'AME-CRH19005', 'Hickory'],
      ['Hickory Flint',     'AME-CRH19006', 'Hickory'],
    ],
  },
  // --- Countryside Oak (New Release) ---
  {
    collection: 'Countryside Oak', category: CAT_ENG_HARDWOOD,
    specs: { finish: 'Light Wire-Brushed', thickness: '3/8"', width: '7-1/2"', length: '16"-67"',
             sqftPerBox: 43, ctnPerPlt: 45, lbsPerCtn: 55, veneer: '1.0MM', material: 'Engineered Hardwood' },
    cost: 3.25,
    colors: [
      ['European Oak Tortilla',   'AME-CSO19001', 'European Oak'],
      ['European Oak Buttermilk', 'AME-CSO19002', 'European Oak'],
      ['European Oak Driftwood',  'AME-CSO19003', 'European Oak'],
      ['European Oak Pebble',     'AME-CSO19004', 'European Oak'],
      ['European Oak Wheat',      'AME-CSO19005', 'European Oak'],
      ['European Oak Hazelnut',   'AME-CSO19006', 'European Oak'],
      ['European Oak Almond',     'AME-CSO19007', 'European Oak'],
      ['European Oak Biscuit',    'AME-CSO19008', 'European Oak'],
      ['European Oak Sandstone',  'AME-CSO19009', 'European Oak'],
      ['European Oak Caramel',    'AME-CSO19010', 'European Oak'],
    ],
  },
  // --- Olympus (New Release) ---
  {
    collection: 'Olympus', category: CAT_ENG_HARDWOOD,
    specs: { finish: 'Light Wire-Brushed', thickness: '1/2"', width: '11-7/8"', length: '16"-86"',
             sqftPerBox: 42.63, ctnPerPlt: 33, lbsPerCtn: 80, veneer: '1.2MM', material: 'Engineered Hardwood' },
    cost: 5.00,
    colors: [
      ['Hickory Athena', 'PL-OLH30001', 'Hickory'],
      ['Hickory Apollo', 'PL-OLH30002', 'Hickory'],
      ['Oak Ares',       'PL-OLO30003', 'Oak'],
      ['Oak Artemis',    'PL-OLO30004', 'Oak'],
      ['Oak Zeus',       'PL-OLO30005', 'Oak'],
      ['Oak Hera',       'PL-OLO30006', 'Oak'],
    ],
  },
  // --- Texas Timber (New Release) ---
  {
    collection: 'Texas Timber', category: CAT_ENG_HARDWOOD,
    specs: { finish: 'Light Wire-Brushed', thickness: '3/8"', width: '7-1/2"', length: '16"-75"',
             sqftPerBox: 38.9, ctnPerPlt: 45, lbsPerCtn: 52, veneer: '1.2MM', material: 'Engineered Hardwood' },
    cost: 3.25,
    colors: [
      ['European Oak Alabaster', 'AME-TTO19001', 'European Oak'],
      ['European Oak Parchment', 'AME-TTO19002', 'European Oak'],
      ['European Oak Sand',      'AME-TTO19003', 'European Oak'],
      ['European Oak Taupe',     'AME-TTO19004', 'European Oak'],
      ['European Oak Amber',     'AME-TTO19005', 'European Oak'],
      ['European Oak Tawny',     'AME-TTO19006', 'European Oak'],
      ['European Oak Honey',     'AME-TTO19007', 'European Oak'],
      ['European Oak Chestnut',  'AME-TTO19008', 'European Oak'],
      ['European Oak Labrador',  'AME-TTO19009', 'European Oak'],
      ['European Oak Carob',     'AME-TTO19010', 'European Oak'],
    ],
  },

  // ======================== SPC (RIGID CORE VINYL) ========================

  // --- Cellar House ---
  {
    collection: 'Cellar House', category: CAT_LVP,
    specs: { finish: 'Embossed', thickness: '5.5 MM', width: '7-1/8"', length: '60"',
             sqftPerBox: 29.86, ctnPerPlt: 45, lbsPerCtn: 51.2, wearLayer: '20 MIL', material: 'SPC' },
    cost: 1.89,
    colors: [
      ['Barbera',    'CELLAR-18201', null],
      ['Nebbiolo',   'CELLAR-18202', null],
      ['Carignan',   'CELLAR-18203', null],
      ['Sangiovese', 'CELLAR-18204', null],
      ['Charbono',   'CELLAR-18205', null],
      ['Dolcetto',   'CELLAR-18206', null],
      ['Grenache',   'CELLAR-18207', null],
      ['Primitivo',  'CELLAR-18208', null],
      ['Semillon',   'CELLAR-18209', null],
      ['Kerner',     'CELLAR-18210', null],
      ['Elbling',    'CELLAR-18211', null],
      ['Malvasia',   'CELLAR-18212', null],
    ],
  },
  // --- Farmhouse Manor ---
  {
    collection: 'Farmhouse Manor', category: CAT_LVP,
    specs: { finish: 'Embossed', thickness: '7.5 MM', width: '7-1/8"', length: '48"',
             sqftPerBox: 19.12, ctnPerPlt: 40, lbsPerCtn: 49, wearLayer: '20 MIL', material: 'SPC' },
    cost: 2.55,
    colors: [
      ['Cairnwood',  'FM-18201', null],
      ['Oxmoor',     'FM-18202', null],
      ['Glidden',    'FM-18203', null],
      ['New Haven',  'FM-18204', null],
      ['High Valley','FM-18205', null],
      ['Southwind',  'FM-18206', null],
      ['Nightfall',  'FM-18207', null],
      ['Iron Hill',  'FM-18208', null],
      ['Briarcliff', 'FM-18209', null],
      ['Ardenwood',  'FM-18210', null],
      ['Monticello', 'FM-18211', null],
    ],
  },
  // --- Public House ---
  {
    collection: 'Public House', category: CAT_LVP,
    specs: { finish: 'EIR', thickness: '7.5 MM', width: '7"', length: '60"',
             sqftPerBox: 17.52, ctnPerPlt: 55, lbsPerCtn: 45, wearLayer: '30 MIL', material: 'SPC' },
    cost: 2.99,
    colors: [
      ['French 75',     'PHS-17801', null],
      ['Gin Rickey',    'PHS-17802', null],
      ['Southside',     'PHS-17803', null],
      ['Sidecar',       'PHS-17804', null],
      ['Highball',      'PHS-17805', null],
      ['Whiskey Sour',  'PHS-17806', null],
      ['Manhattan',     'PHS-17807', null],
      ['Old Fashioned', 'PHS-17808', null],
    ],
  },
  // --- Sicily ---
  {
    collection: 'Sicily', category: CAT_LVP,
    specs: { finish: 'Embossed', thickness: '7.5 MM', width: '4", 6", 8"', length: '72"',
             sqftPerBox: 36.02, ctnPerPlt: 36, lbsPerCtn: 92, wearLayer: '20 MIL', material: 'SPC' },
    cost: 2.99,
    colors: [
      ['Messina',  '3WS-46801', null],
      ['Enna',     '3WS-46802', null],
      ['Trapani',  '3WS-46803', null],
      ['Syracuse', '3WS-46804', null],
    ],
  },
  // --- Skyview ---
  {
    collection: 'Skyview', category: CAT_LVP,
    specs: { finish: 'EIR', thickness: '7.5 MM', width: '9"', length: '60"',
             sqftPerBox: 21.95, ctnPerPlt: 44, lbsPerCtn: 56.5, wearLayer: '30 MIL', material: 'SPC' },
    cost: 2.69,
    colors: [
      ['Lightning',   'SV-22301', null],
      ['Celestial',   'SV-22302', null],
      ['Nimbus',      'SV-22303', null],
      ['Morning Fog', 'SV-22304', null],
      ['Storm',       'SV-22305', null],
      ['Cumulus',     'SV-22306', null],
      ['Aurora',      'SV-22307', null],
      ['Meteor',      'SV-22308', null],
      ['Nebula',      'SV-22309', null],
      ['Starlight',   'SV-22310', null],
      ['Horizon',     'SV-22311', null],
      ['Equinox',     'SV-22312', null],
    ],
  },

  // ======================== HIGH PERFORMANCE FLOORING ========================

  // --- Bella Vista ---
  {
    collection: 'Bella Vista', category: CAT_LAMINATE,
    specs: { finish: 'EIR', thickness: '13.5 MM', width: '7-5/8"', length: 'Multi-Length (23.5", 47", 71")',
             sqftPerBox: 22.6, ctnPerPlt: 55, lbsPerCtn: 50.3, wearLayer: 'AC5', material: 'High Performance Flooring' },
    cost: 2.69,
    colors: [
      ['Monza',     'BVS-19401', null],
      ['Capri',     'BVS-19402', null],
      ['Viceroy',   'BVS-19403', null],
      ['Sardinia',  'BVS-19404', null],
      ['Praiano',   'BVS-19405', null],
      ['Lorena',    'BVS-19406', null],
      ['Calabria',  'BVS-19407', null],
      ['Savoy',     'BVS-19408', null],
      ['Vienna',    'BVS-19409', null],
      ['Milan',     'BVS-19410', null],
      ['Lombardy',  'BVS-19411', null],
      ['Ferdinand', 'BVS-19412', null],
    ],
  },
  // --- Olde Tavern ---
  {
    collection: 'Olde Tavern', category: CAT_LAMINATE,
    specs: { finish: 'EIR', thickness: '13.5 MM', width: '6-1/2"', length: '48"',
             sqftPerBox: 15.2, ctnPerPlt: 50, lbsPerCtn: 33.8, wearLayer: 'AC4', material: 'High Performance Flooring' },
    cost: 2.55,
    colors: [
      ['Vesper',           'OTS-16501', null],
      ['Dark and Stormy',  'OTS-16502', null],
      ['Tom Collins',      'OTS-16503', null],
      ['Posset',           'OTS-16504', null],
      ['Espresso Martini', 'OTS-16505', null],
      ['Bramble',          'OTS-16506', null],
      ['Spritz',           'OTS-16507', null],
      ['Bellini',          'OTS-16508', null],
      ['Paloma',           'OTS-16509', null],
      ['Wassail',          'OTS-16510', null],
      ['Hemingway',        'OTS-16511', null],
      ['Gimlet',           'OTS-16512', null],
    ],
  },
];

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

async function upsertPackaging(sku_id, { sqft_per_box, pieces_per_box, boxes_per_pallet, weight_per_box_lbs }) {
  await pool.query(`
    INSERT INTO packaging (sku_id, sqft_per_box, pieces_per_box, boxes_per_pallet, weight_per_box_lbs)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (sku_id) DO UPDATE SET
      sqft_per_box = COALESCE(EXCLUDED.sqft_per_box, packaging.sqft_per_box),
      pieces_per_box = COALESCE(EXCLUDED.pieces_per_box, packaging.pieces_per_box),
      boxes_per_pallet = COALESCE(EXCLUDED.boxes_per_pallet, packaging.boxes_per_pallet),
      weight_per_box_lbs = COALESCE(EXCLUDED.weight_per_box_lbs, packaging.weight_per_box_lbs)
  `, [sku_id, sqft_per_box || null, pieces_per_box || null, boxes_per_pallet || null, weight_per_box_lbs || null]);
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

function makeInternalSku(itemCode) {
  return `JH-${itemCode}`;
}

// ==================== Main ====================

async function main() {
  // Ensure vendor exists
  let vendorRes = await pool.query("SELECT id FROM vendors WHERE code = 'JOHNSONHW'");
  let vendorId;
  if (!vendorRes.rows.length) {
    const ins = await pool.query(`
      INSERT INTO vendors (name, code, website)
      VALUES ('Johnson Hardwood', 'JOHNSONHW', 'https://johnsonhardwood.com')
      RETURNING id
    `);
    vendorId = ins.rows[0].id;
    console.log(`Created vendor: Johnson Hardwood (${vendorId})`);
  } else {
    vendorId = vendorRes.rows[0].id;
    console.log(`Using existing vendor: Johnson Hardwood (${vendorId})`);
  }

  let productsCreated = 0, productsUpdated = 0;
  let skusCreated = 0, skusUpdated = 0;

  for (const series of SERIES) {
    const { collection, category, specs, cost, colors } = series;
    console.log(`\n=== ${collection} (${colors.length} colors) ===`);

    for (const [name, itemCode, species] of colors) {
      // Determine color from name (strip species prefix)
      let colorName = name;
      if (species) {
        const prefix = species + ' ';
        if (name.startsWith(prefix)) {
          colorName = name.substring(prefix.length);
        }
      }

      const prod = await upsertProduct(vendorId, {
        name,
        collection,
        category_id: category,
        description_short: `${name} — ${collection} Collection ${specs.material}`,
      });
      if (prod.is_new) productsCreated++; else productsUpdated++;

      const sku = await upsertSku(prod.id, {
        vendor_sku: itemCode,
        internal_sku: makeInternalSku(itemCode),
        variant_name: specs.finish,
        sell_by: 'sqft',
      });
      if (sku.is_new) skusCreated++; else skusUpdated++;

      // Pricing: cost = Preferred, retail = cost × 2.0
      await upsertPricing(sku.id, {
        cost,
        retail_price: (cost * 2.0).toFixed(2),
        price_basis: 'per_sqft',
      });

      // Packaging
      await upsertPackaging(sku.id, {
        sqft_per_box: specs.sqftPerBox,
        boxes_per_pallet: specs.ctnPerPlt,
        weight_per_box_lbs: specs.lbsPerCtn,
      });

      // Attributes
      await setAttr(sku.id, 'material', specs.material);
      await setAttr(sku.id, 'finish', specs.finish);
      await setAttr(sku.id, 'thickness', specs.thickness);
      await setAttr(sku.id, 'size', `${specs.width} × ${specs.length}`);
      await setAttr(sku.id, 'collection', collection);
      await setAttr(sku.id, 'color', colorName);
      if (species) await setAttr(sku.id, 'species', species);
      if (specs.veneer) await setAttr(sku.id, 'wear_layer', specs.veneer);
      if (specs.wearLayer) await setAttr(sku.id, 'wear_layer', specs.wearLayer);

      console.log(`  ${prod.is_new ? '+' : '~'} ${name} (${itemCode})`);
    }
  }

  console.log('\n=== Import Complete ===');
  console.log(`Products: ${productsCreated} created, ${productsUpdated} updated`);
  console.log(`SKUs: ${skusCreated} created, ${skusUpdated} updated`);

  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
