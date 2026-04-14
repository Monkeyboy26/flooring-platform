#!/usr/bin/env node
/**
 * Import MegaClic (AJ Trading) — Full Catalog
 *
 * Source: MegaClic Q4-2025 PDF Price List + megaclicfloors.com (images & color names)
 * Brands: Morningstar (Engineered Hardwood), MegaClic (Laminate & SPC Vinyl)
 *
 * Features:
 *   - Creates products, SKUs, pricing, packaging for all collections
 *   - Attaches molding accessories to each flooring product (same product_id)
 *   - Adds standalone sundry products (underlayment, moisture barrier)
 *   - Imports product photos (primary) + room scene images (lifestyle) from megaclicfloors.com
 *   - Cleans up orphaned products/SKUs from prior runs
 *
 * Usage: docker compose exec api node scripts/import-megaclic.js
 */
import pg from 'pg';

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: 5432, database: 'flooring_pim', user: 'postgres', password: 'postgres',
});

// Category IDs from seed.sql
const CAT = {
  eng:      '650e8400-e29b-41d4-a716-446655440021', // Engineered Hardwood
  laminate: '650e8400-e29b-41d4-a716-446655440090', // Laminate
  lvp:      '650e8400-e29b-41d4-a716-446655440031', // LVP (Plank) — SPC
  sundries: '650e8400-e29b-41d4-a716-446655440110', // Installation & Sundries
};

const MARKUP = 2.0;
const IMG = 'https://www.megaclicfloors.com/wp-content/uploads';

// ============ MOLDING ACCESSORIES BY PRODUCT TYPE ============
// [suffix, name, costPerPiece]
const MOLDINGS = {
  morningstar: [
    ['EC', 'End Cap', 69],
    ['RD', 'Reducer', 69],
    ['TM', 'T-Mold', 69],
    ['SN', 'Stair Nose', 89],
  ],
  laminate: [
    ['QR', 'Quarter Round', 13.79],
    ['EC', 'End Cap', 19.99],
    ['TM', 'T-Mold', 19.99],
    ['RD', 'Reducer', 19.99],
    ['FSN', 'Flush Stair Nose', 29.99],
  ],
  spc: [
    ['QR', 'Quarter Round', 13.79],
    ['EC', 'End Cap', 19.99],
    ['TM', 'T-Mold', 19.99],
    ['RD', 'Reducer', 19.99],
    ['FSN', 'Flush Stair Nose', 25.99],
  ],
};

// ============ COLLECTION DATA ============
// Format: [collection, catKey, moldingTier, attrs, groups]
// attrs: { material, thickness, width, finish, wear_layer, installation }
// groups: [[sqftPerBox, pcsPerBox, boxesPerPallet, costPerSqft, [[vendorSku, colorName, primaryUrl, lifestyleUrl|null], ...]]]

const COLLECTIONS = [
  // ==================== MORNINGSTAR — ENGINEERED HARDWOOD ====================
  // Color names & images from morningstarhardwood.com + jcflooringdirect.com
  // SKU 2104 doesn't exist (same gap pattern as other collections)
  ['Northam Collection', 'eng', 'morningstar',
    { material: 'European Oak', thickness: '5/8"', width: '8.7"', finish: 'Wire Brushed', installation: 'Float' },
    [[31.26, null, null, 6.09, [
      ['MSR-2101', 'Fragile Beauty', 'https://morningstarhardwood.com/wp-content/uploads/fragile-beauty-t.jpg', null],
      ['MSR-2102', 'St. Laurent',    'https://morningstarhardwood.com/wp-content/uploads/st-laurent-t.jpg', null],
      ['MSR-2103', 'Hemingway',      'https://morningstarhardwood.com/wp-content/uploads/hemingway-t.jpg', null],
      ['MSR-2105', 'Portofino',      'https://morningstarhardwood.com/wp-content/uploads/portofino-t.jpg', null],
      ['MSR-2106', 'After Glow',     'https://morningstarhardwood.com/wp-content/uploads/after-glow-t.jpg', null],
      ['MSR-2107', 'Geneva',         'https://morningstarhardwood.com/wp-content/uploads/geneva-t.jpg', null],
      ['MSR-2108', 'Nebula',         'https://morningstarhardwood.com/wp-content/uploads/nebula-t.jpg', null],
      ['MSR-2109', 'Milan',          'https://morningstarhardwood.com/wp-content/uploads/milan-t.jpg', null],
      ['MSR-2110', 'Mink',           'https://morningstarhardwood.com/wp-content/uploads/mink-t.jpg', null],
      ['MSR-2111', 'Summer Day',     'https://morningstarhardwood.com/wp-content/uploads/summer-day-t.jpg', null],
      ['MSR-2112', 'Pegasus',        'https://morningstarhardwood.com/wp-content/uploads/pegasus-t.jpg', null],
    ]]],
  ],

  ['Monet Collection 8.7"', 'eng', 'morningstar',
    { material: 'Oak', thickness: '5/8"', width: '8.7"', finish: 'Wire Brushed', installation: 'Float' },
    [[31.26, null, null, 5.49, [
      ['MSR-2116', 'Belrose', 'https://morningstarhardwood.com/wp-content/uploads/belose-0224.jpg', null],
      ['MSR-2117', 'Capri',   'https://morningstarhardwood.com/wp-content/uploads/capri-0224.jpg', null],
      ['MSR-2118', 'Hemlock', 'https://morningstarhardwood.com/wp-content/uploads/hemlock-0224.jpg', null],
    ]]],
  ],

  ['Monet Collection 10.24"', 'eng', 'morningstar',
    { material: 'French Oak', thickness: '5/8"', width: '10.24"', finish: 'Wire Brushed', installation: 'Float' },
    [[36.95, null, null, 5.49, [
      ['MSR-2130', 'Berkeley Springs', 'https://morningstarhardwood.com/wp-content/uploads/berkeley-springs-0224.jpg', null],
      ['MSR-2131', 'Livorno',          'https://morningstarhardwood.com/wp-content/uploads/livorno-0224.jpg', null],
      ['MSR-2132', 'Gatsby',           'https://morningstarhardwood.com/wp-content/uploads/gatsby-0224.jpg', null],
      ['MSR-2133', 'Mont Blanc',       'https://morningstarhardwood.com/wp-content/uploads/mont-blanc-0224.jpg', null],
    ]]],
  ],

  // ==================== MEGACLIC — WATERPROOF LAMINATE ====================
  // Color names & images from megaclicfloors.com (SKUs skip 3104/3114)
  // Primary = product swatch (.png), Lifestyle = room scene (-RS-.jpg)
  ['AquaShield AC5', 'laminate', 'laminate',
    { material: 'Laminate', thickness: '12mm', width: '9.37"', finish: 'Textured', wear_layer: 'AC5', installation: 'Click-lock' },
    [[23.29, 6, 52, 2.25, [
      ['MCAS-3101', 'Crimson',      `${IMG}/2024/07/MCAS-3101-Crimson.png`,      `${IMG}/2024/07/MCAS-3101-Crimson-RS-1080x810.jpg`],
      ['MCAS-3102', 'Valentine',    `${IMG}/2024/07/MCAS-3102-Valentine.png`,    `${IMG}/2024/07/MCAS-3102-Valentine-RS-1-1080x810.jpg`],
      ['MCAS-3103', 'Hillcrest',    `${IMG}/2024/07/MCAS-3103-Hillcrest.png`,    `${IMG}/2024/07/Hillcrest-RS-1080x810.jpg`],
      ['MCAS-3105', 'Pasadena',     `${IMG}/2024/07/MCAS-3105-Pasadena.png`,     `${IMG}/2024/07/MCAS-3105-Pasadena-RS-1-1080x810.jpg`],
      ['MCAS-3106', 'Hampton Hall', `${IMG}/2024/07/MCAS-3106-Hampton-Hall.png`, `${IMG}/2024/07/MCAS-3106-Hampton-Hall-RS-1080x810.jpg`],
      ['MCAS-3107', 'Sun Kissed',   `${IMG}/2024/07/MCAS-3107-Sun-Kissed.png`,   `${IMG}/2024/07/MCAS-3107-Sun-Kissed-RS-1-1080x810.jpg`],
      ['MCAS-3108', 'Beach House',  `${IMG}/2024/07/MCAS-3108-Beach-House.png`,  `${IMG}/2024/07/MCAS-3108-Beach-House-RS-1080x810.jpg`],
      ['MCAS-3109', 'Moonlight',    `${IMG}/2024/07/MCAS-3109-Moonlight.png`,    `${IMG}/2024/07/MCAS-3109-Moonlight-RS-2-1080x810.jpg`],
      ['MCAS-3110', 'Riviera',      `${IMG}/2024/07/MCAS-3110-Riviera.png`,      `${IMG}/2024/07/MCAS-3110-Riviera-1-1080x810.jpg`],
      ['MCAS-3111', 'Honeycomb',    `${IMG}/2024/07/MCAS-3111-Honeycomb.png`,    `${IMG}/2024/07/MCAS-3111-Honeycomb-1080x810.jpg`],
      ['MCAS-3112', 'Westwood',     `${IMG}/2024/07/MCAS-3112-Westwood.png`,     `${IMG}/2024/07/MCAS-3112-Westwood-1080x810.jpg`],
      ['MCAS-3113', 'Cadiz',        `${IMG}/2024/07/MCAS-3113-Cadiz.png`,        `${IMG}/2024/07/MCAS-3113-Cadiz-1-1080x810.jpg`],
      ['MCAS-3115', 'Snowdrop',     `${IMG}/2024/07/MCAS-3115-Snowdrop.png`,     `${IMG}/2024/07/MCAS-3115-Snowdrop-1080x810.png`],
      ['MCAS-3116', 'Sana',         `${IMG}/2024/07/MCAS-3116-Sana.png`,         `${IMG}/2024/07/MCAS-3116-Sana-1-1080x810.jpg`],
      ['MCAS-3117', 'Cedar',        `${IMG}/2025/03/MCAS-3117-Cedar.png`,        `${IMG}/2025/03/MCAS-3117-Cedar-room-scene-2-1.jpg`],
    ]]],
  ],

  // AC4 has DIFFERENT colors from AC5 (SKUs skip 3204/3214)
  // Primary = product swatch ({SKU}.jpg), Lifestyle = room scene ({SKU}-N-1080x810.jpg)
  ['AquaShield AC4', 'laminate', 'laminate',
    { material: 'Laminate', thickness: '12mm', width: '9.37"', finish: 'Textured', wear_layer: 'AC4', installation: 'Click-lock' },
    [[23.29, 6, 52, 2.09, [
      ['MCAS-3201', 'Springtime',  `${IMG}/2024/10/MCAS-3201.jpg`, `${IMG}/2024/10/MCAS-3201-1-1080x810.jpg`],
      ['MCAS-3202', 'Cornwell',    `${IMG}/2024/10/MCAS-3202.jpg`, `${IMG}/2024/10/MCAS-3202-1080x810.jpg`],
      ['MCAS-3203', 'Arrowhead',   `${IMG}/2024/10/MCAS-3203.jpg`, `${IMG}/2024/10/MCAS-3203-1080x810.jpg`],
      ['MCAS-3205', 'Meridian',    `${IMG}/2024/10/MCAS-3205.jpg`, `${IMG}/2024/10/MCAS-3205-1080x810.jpg`],
      ['MCAS-3206', 'Arden',       `${IMG}/2024/10/MCAS-3206.jpg`, `${IMG}/2024/10/MCAS-3206-2-1080x810.jpg`],
      ['MCAS-3207', 'Sterling',    `${IMG}/2024/10/MCAS-3207.jpg`, `${IMG}/2024/10/MCAS-3207-3-1080x762.jpg`],
      ['MCAS-3208', 'Newton',      `${IMG}/2024/10/MCAS-3208.jpg`, `${IMG}/2024/10/MCAS-3208-1080x763.jpg`],
      ['MCAS-3209', 'Paxon',       `${IMG}/2024/10/MCAS-3209.jpg`, `${IMG}/2024/10/MCAS-3209-e1730430778628-1080x812.jpg`],
      ['MCAS-3210', 'Lava Falls',  `${IMG}/2024/10/MCAS-3210.jpg`, `${IMG}/2024/10/MCAS-3210-1080x810.jpg`],
      ['MCAS-3211', 'Ashville',    `${IMG}/2024/10/MCAS-3211.jpg`, `${IMG}/2024/10/MCAS-3211-1-1080x810.jpg`],
      ['MCAS-3212', 'Copen Hill',  `${IMG}/2024/10/MCAS-3212.jpg`, `${IMG}/2024/10/MCAS-3212-1080x810.jpg`],
      ['MCAS-3213', 'Milton',      `${IMG}/2024/10/MCAS-3213.jpg`, `${IMG}/2024/10/MCAS-3213-1080x810.jpg`],
      ['MCAS-3215', 'Ozark',       `${IMG}/2024/10/MCAS-3215.jpg`, `${IMG}/2024/10/MCAS-3215-1080x810.jpg`],
      ['MCAS-3216', 'Fox',         `${IMG}/2024/10/MCAS-3216.jpg`, `${IMG}/2024/10/MCAS-3216-1080x810.jpg`],
      ['MCAS-3217', 'Canoe',       `${IMG}/2024/10/MCAS-3217.jpg`, `${IMG}/2024/10/MCAS-3217-1080x810.jpg`],
    ]]],
  ],

  // Centennial SKUs: 3301, 3302, 3303, 3306 (no 3304/3305)
  // Already using product photos ({SKU}.jpg)
  ['Centennial AC4', 'laminate', 'laminate',
    { material: 'Laminate', thickness: '12mm', width: '12"', finish: 'Embossed', wear_layer: 'AC4', installation: 'Click-lock' },
    [[28.74, 4, 36, 2.19, [
      ['MCCT-3301', 'Astoria',     `${IMG}/2025/02/MCCT-3301.jpg`, `${IMG}/2025/02/MCCT-3301-1.jpg`],
      ['MCCT-3302', 'Brooklyn',    `${IMG}/2025/02/MCCT-3302.jpg`, null],
      ['MCCT-3303', 'Morning Dew', `${IMG}/2025/02/MCCT-3303.jpg`, null],
      ['MCCT-3306', 'Scarlet',     `${IMG}/2025/02/MCCT-3306.jpg`, null],
    ]]],
  ],

  // Diana SKUs skip 8704
  // No product swatch photos available on megaclicfloors.com — only room scenes
  ['Diana AC4', 'laminate', 'laminate',
    { material: 'Laminate', thickness: '10mm', width: '9.37"', finish: 'Textured', wear_layer: 'AC4', installation: 'Click-lock' },
    [[27.17, 7, 56, 1.75, [
      ['MCDN-8701', 'Oxford',   `${IMG}/2025/09/MCDN-8701-room-scene-1080x810.jpg`, null],
      ['MCDN-8702', 'Buckhead', `${IMG}/2025/09/MCDN-8702-room-scene-1080x810.jpg`, null],
      ['MCDN-8703', 'Oyster',   `${IMG}/2025/09/MCDN-8703-room-scene-1080x810.jpg`, null],
      ['MCDN-8705', 'Dover',    `${IMG}/2025/09/MCDN-8705-room-scene-1080x810.jpg`, null],
      ['MCDN-8706', 'Leeds',    `${IMG}/2025/09/MCDN-8706-room-scene-1080x810.jpg`, null],
      ['MCDN-8707', 'Palmier',  `${IMG}/2025/09/MCDN-8707-room-scene-1080x810.jpg`, null],
      ['MCDN-8708', 'Opal',     `${IMG}/2025/09/MCDN-8708-room-scene-1080x810.jpg`, null],
      ['MCDN-8709', 'Newport',  `${IMG}/2025/09/MCDN-8709-room-scene-1080x810.jpg`, null],
      ['MCDN-8710', 'Prince',   `${IMG}/2025/09/MCDN-8710-room-scene-1080x810.jpg`, null],
      ['MCDN-8711', 'Rivador',  `${IMG}/2025/09/MCDN-8711-room-scene-1080x810.jpg`, null],
      ['MCDN-8712', 'Tyler',    `${IMG}/2025/09/MCDN-8712-room-scene-1080x810.jpg`, null],
      ['MCDN-8713', 'Dawson',   `${IMG}/2025/09/MCDN-8713-room-scene-1080x810.jpg`, null],
    ]]],
  ],

  // ==================== MEGACLIC — SPC VINYL ====================
  // Athens 228x1535mm — SKUs skip 8504, 8514; 8519 Coral Springs discontinued
  // Product photos: {SKU}-{Color}-1-scaled.jpg (confirmed on individual product pages)
  ['Athens Collection 228x1535', 'lvp', 'spc',
    { material: 'SPC', thickness: '7mm', width: '228mm', finish: 'Embossed', wear_layer: '20mil', installation: 'Click-lock' },
    [[26.37, 7, 48, 1.99, [
      ['MCGL-8501', 'Fireweed',      `${IMG}/2024/07/MCGL-8501-Fireweed-2.png`,              `${IMG}/2024/07/MCGL-8501-Fireweed-RS-2-1080x810.jpg`],
      ['MCGL-8502', 'Laguna',        `${IMG}/2024/07/MCGL-8502-Laguna-1-scaled.jpg`,          `${IMG}/2024/07/MCGL-8502-Laguna-RS.jpg`],
      ['MCGL-8503', 'Salem',         `${IMG}/2024/07/MCGL-8503-Salem-1-scaled.jpg`,            `${IMG}/2024/07/MCGL-8503-Salem-RS-1080x810.jpg`],
      ['MCGL-8505', 'Rainforest',    `${IMG}/2024/07/MCGL-8505-Rainforest-1-scaled.jpg`,       `${IMG}/2024/07/MCGL-8505-Rainforest-RS-1080x810.jpg`],
      ['MCGL-8506', 'Blazing Ember', `${IMG}/2024/07/MCGL-8506-Blazing-Ember-1-scaled.jpg`,    `${IMG}/2024/07/MCGL-8506-Blazing-Ember-RS-1080x810.jpg`],
      ['MCGL-8507', 'Monte Beach',   `${IMG}/2024/07/MCGL-8507-Monte-Beach-1-scaled.jpg`,      `${IMG}/2024/07/MCGL-8507-Monte-Beach-1080x810.jpg`],
      ['MCGL-8508', 'Layton',        `${IMG}/2024/07/MCGL-8508-Layton-1-scaled.jpg`,           `${IMG}/2024/07/MCGL-8508-Layton-1080x810.jpg`],
      ['MCGL-8509', 'Fresno',        `${IMG}/2024/07/MCGL-8509-Fresno-1-scaled.jpg`,           `${IMG}/2024/07/MCGL-8509-Fresno-1080x810.jpg`],
      ['MCGL-8510', 'Baha',          `${IMG}/2024/07/MCGL-8510-Baha-1-scaled.jpg`,             `${IMG}/2024/07/MCGL-8510-Baha-1080x810.jpg`],
      ['MCGL-8511', 'Hampton',       `${IMG}/2024/07/MCGL-8511-Hampton-1-scaled.jpg`,          `${IMG}/2024/07/MCGL-8511-Hampton-1080x810.jpg`],
      ['MCGL-8512', 'Versailles',    `${IMG}/2024/07/MCGL-8512-Versailles-1-scaled.jpg`,       `${IMG}/2024/07/MCGL-8512-Versailles-1080x810.jpg`],
      ['MCGL-8513', 'Harlow',        `${IMG}/2024/07/MCGL-8513-Harlow-1-scaled.jpg`,           `${IMG}/2024/07/MCGL-8513-Harlow-1080x810.jpg`],
      ['MCGL-8515', 'Great Falls',   `${IMG}/2024/07/MCGL-8515-Great-Falls-1-scaled.jpg`,      `${IMG}/2024/07/MCGL-8515-Great-Falls-1-1080x810.jpg`],
      ['MCGL-8516', 'Russo',         `${IMG}/2024/07/MCGL-8516-Russo-1-scaled.jpg`,            `${IMG}/2024/07/MCGL-8516-Russo-1080x810.jpg`],
      ['MCGL-8517', 'Santa Fe',      `${IMG}/2024/07/MCGL-8517-Santa-Fe-1-scaled.jpg`,         `${IMG}/2024/07/MCGL-8517-Santa-Fe-RS-1080x810.jpg`],
      ['MCGL-8518', 'Ivy Point',     `${IMG}/2024/07/MCGL-8518-Ivy-Point-1-scaled.jpg`,        `${IMG}/2024/07/MCGL-8518-Ivy-Point-RS-1080x796.jpg`],
    ]]],
  ],

  // Athens 180x1535mm
  ['Athens Collection 180x1535', 'lvp', 'spc',
    { material: 'SPC', thickness: '7mm', width: '180mm', finish: 'Embossed', wear_layer: '20mil', installation: 'Click-lock' },
    [[26.77, 9, 50, 1.99, [
      ['MCGL-8520', 'New York', `${IMG}/2024/07/MCGL-8520-New-York-1-scaled.jpg`, `${IMG}/2024/07/MCGL-8520-New-York-RS-1080x810.jpg`],
      ['MCGL-8521', 'Avon',     `${IMG}/2024/07/MCGL-8521-Avon-1-scaled.jpg`,     `${IMG}/2024/07/MCGL-8521-Avon-RS-1080x810.jpg`],
      ['MCGL-8522', 'Lincoln',  `${IMG}/2024/07/MCGL-8522-Lincoln-1-scaled.jpg`,   `${IMG}/2024/07/MCGL-8522-Lincoln-RS-1080x810.jpg`],
    ]]],
  ],

  // Athens 180x1220mm — SKU 8524 doesn't exist
  ['Athens Collection 180x1220', 'lvp', 'spc',
    { material: 'SPC', thickness: '7mm', width: '180mm', finish: 'Embossed', wear_layer: '20mil', installation: 'Click-lock' },
    [[28.37, 12, 45, 1.99, [
      ['MCGL-8523', 'Russet Olive', `${IMG}/2024/07/MCGL-8523-Russet-Olive-1-scaled.jpg`, `${IMG}/2024/07/MCGL-8523-Russet-Olive-RS-1080x810.jpg`],
      ['MCGL-8525', 'Monaco',       `${IMG}/2024/07/MCGL-8525-Monaco-1-scaled.jpg`,       `${IMG}/2024/07/MCGL-8525-Monaco-RS-1080x810.jpg`],
      ['MCGL-8526', 'Messina',      `${IMG}/2024/07/MCGL-8526-Messina-1-scaled.jpg`,      `${IMG}/2024/07/MCGL-8526-Messina-RS-1-1080x810.jpg`],
    ]]],
  ],

  // Abbey Road — SKU 8804 doesn't exist
  // Already using product photos ({SKU}.jpg)
  ['Abbey Road Collection', 'lvp', 'spc',
    { material: 'SPC', thickness: '8mm', width: '228mm', finish: 'Embossed', wear_layer: '20mil', installation: 'Click-lock' },
    [[18.84, 5, 48, 1.99, [
      ['MCGL-8801', 'Lazio',    `${IMG}/2025/02/MCGL-8801.jpg`, null],
      ['MCGL-8802', 'Moneo',    `${IMG}/2025/02/MCGL-8802.jpg`, null],
      ['MCGL-8803', 'Anton',    `${IMG}/2025/02/MCGL-8803-1.jpg`, null],
      ['MCGL-8805', 'Kendall',  `${IMG}/2025/02/MCGL-8805.jpg`, null],
      ['MCGL-8806', 'Victoria', `${IMG}/2025/02/MCGL-8806.jpg`, null],
    ]]],
  ],
];

// ============ SUNDRIES (standalone products, not accessories) ============
const SUNDRIES = [
  { name: 'EVA Silver Underlayment', vendorSku: 'MC-UL-EVA', cost: 0.24, sellBy: 'sqft', priceBasis: 'per_sqft' },
  { name: 'Blue Foam Underlayment', vendorSku: 'MC-UL-FOAM', cost: 0.07, sellBy: 'sqft', priceBasis: 'per_sqft' },
  { name: 'Moisture Barrier', vendorSku: 'MC-MB', cost: 0.08, sellBy: 'sqft', priceBasis: 'per_sqft' },
];

// SKUs from prior import that don't exist (wrong numbers) — will be cleaned up
const BAD_SKUS = [
  'MSR-2104',                  // Northam gap
  'MCAS-3104', 'MCAS-3114',   // AC5 gaps
  'MCAS-3204', 'MCAS-3214',   // AC4 gaps
  'MCCT-3304',                 // Centennial gap (real 4th is 3306)
  'MCDN-8704',                 // Diana gap
  'MCGL-8504', 'MCGL-8514',   // Athens gaps
  'MCGL-8519',                 // Coral Springs — discontinued
  'MCGL-8524',                 // Athens 180x1220 gap
  'MCGL-8804',                 // Abbey Road gap
];

// ============ UPSERT HELPERS ============

async function upsertVendor() {
  const r = await pool.query(`
    INSERT INTO vendors (code, name, website)
    VALUES ('MEGACLIC', 'MegaClic (AJ Trading)', 'https://www.megaclicfloors.com')
    ON CONFLICT (code) DO UPDATE SET
      name = EXCLUDED.name,
      website = EXCLUDED.website
    RETURNING id
  `);
  return r.rows[0].id;
}

async function upsertProduct(vendorId, { name, collection, categoryId }) {
  const r = await pool.query(`
    INSERT INTO products (vendor_id, name, collection, category_id, status)
    VALUES ($1, $2, $3, $4, 'active')
    ON CONFLICT ON CONSTRAINT products_vendor_collection_name_unique
    DO UPDATE SET category_id = EXCLUDED.category_id, updated_at = CURRENT_TIMESTAMP
    RETURNING id, (xmax = 0) AS is_new
  `, [vendorId, name, collection, categoryId]);
  return r.rows[0];
}

async function upsertSku(productId, { vendorSku, internalSku, variantName, sellBy, variantType }) {
  const r = await pool.query(`
    INSERT INTO skus (product_id, vendor_sku, internal_sku, variant_name, sell_by, variant_type)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (internal_sku) DO UPDATE SET
      product_id = EXCLUDED.product_id,
      vendor_sku = EXCLUDED.vendor_sku,
      variant_name = COALESCE(EXCLUDED.variant_name, skus.variant_name),
      sell_by = EXCLUDED.sell_by,
      variant_type = EXCLUDED.variant_type,
      updated_at = CURRENT_TIMESTAMP
    RETURNING id, (xmax = 0) AS is_new
  `, [productId, vendorSku, internalSku, variantName, sellBy, variantType || null]);
  return r.rows[0];
}

async function upsertPricing(skuId, cost, retail, priceBasis) {
  await pool.query(`
    INSERT INTO pricing (sku_id, cost, retail_price, price_basis)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (sku_id) DO UPDATE SET
      cost = EXCLUDED.cost,
      retail_price = EXCLUDED.retail_price,
      price_basis = EXCLUDED.price_basis
  `, [skuId, cost, retail, priceBasis]);
}

async function upsertPackaging(skuId, { sqftPerBox, pcsPerBox, boxesPerPallet }) {
  await pool.query(`
    INSERT INTO packaging (sku_id, sqft_per_box, pieces_per_box, boxes_per_pallet)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (sku_id) DO UPDATE SET
      sqft_per_box = COALESCE(EXCLUDED.sqft_per_box, packaging.sqft_per_box),
      pieces_per_box = COALESCE(EXCLUDED.pieces_per_box, packaging.pieces_per_box),
      boxes_per_pallet = COALESCE(EXCLUDED.boxes_per_pallet, packaging.boxes_per_pallet)
  `, [skuId, sqftPerBox, pcsPerBox || null, boxesPerPallet || null]);
}

async function upsertAttribute(skuId, attrName, attrValue) {
  let attrRes = await pool.query(`SELECT id FROM attributes WHERE name = $1`, [attrName]);
  if (!attrRes.rows.length) {
    attrRes = await pool.query(
      `INSERT INTO attributes (name, slug) VALUES ($1, $2) ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      [attrName, attrName.toLowerCase().replace(/[^a-z0-9]+/g, '-')]
    );
  }
  const attrId = attrRes.rows[0].id;
  await pool.query(`
    INSERT INTO sku_attributes (sku_id, attribute_id, value)
    VALUES ($1, $2, $3)
    ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value = EXCLUDED.value
  `, [skuId, attrId, attrValue]);
}

async function upsertMediaAsset(productId, skuId, url) {
  await pool.query(`
    INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
    VALUES ($1, $2, 'primary', $3, $3, 0)
    ON CONFLICT (product_id, sku_id, asset_type, sort_order) WHERE sku_id IS NOT NULL
    DO UPDATE SET url = EXCLUDED.url, original_url = EXCLUDED.original_url
  `, [productId, skuId, url]);
}

async function upsertLifestyleAsset(productId, skuId, url) {
  await pool.query(`
    INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
    VALUES ($1, $2, 'lifestyle', $3, $3, 1)
    ON CONFLICT (product_id, sku_id, asset_type, sort_order) WHERE sku_id IS NOT NULL
    DO UPDATE SET url = EXCLUDED.url, original_url = EXCLUDED.original_url
  `, [productId, skuId, url]);
}

// ============ CLEANUP ============

async function cleanupBadSkus(vendorId) {
  if (!BAD_SKUS.length) return;

  // Build LIKE patterns for each bad SKU + its accessories
  const patterns = BAD_SKUS.map(s => `MEGACLIC-${s}%`);
  const placeholders = patterns.map((_, i) => `$${i + 1}`).join(', ');

  // Find SKU IDs to delete
  const skuRes = await pool.query(
    `SELECT id FROM skus WHERE ${patterns.map((_, i) => `internal_sku LIKE $${i + 1}`).join(' OR ')}`,
    patterns
  );
  const skuIds = skuRes.rows.map(r => r.id);
  if (!skuIds.length) return;

  const idPlaceholders = skuIds.map((_, i) => `$${i + 1}`).join(', ');

  // Delete dependent data
  await pool.query(`DELETE FROM pricing WHERE sku_id IN (${idPlaceholders})`, skuIds);
  await pool.query(`DELETE FROM packaging WHERE sku_id IN (${idPlaceholders})`, skuIds);
  await pool.query(`DELETE FROM sku_attributes WHERE sku_id IN (${idPlaceholders})`, skuIds);
  await pool.query(`DELETE FROM media_assets WHERE sku_id IN (${idPlaceholders})`, skuIds);
  const delRes = await pool.query(`DELETE FROM skus WHERE id IN (${idPlaceholders})`, skuIds);
  console.log(`\nCleaned up ${delRes.rowCount} bad SKUs (wrong numbers from prior import)`);

  // Delete orphaned products (no remaining SKUs)
  const orphanRes = await pool.query(`
    DELETE FROM products
    WHERE vendor_id = $1
      AND id NOT IN (SELECT DISTINCT product_id FROM skus)
  `, [vendorId]);
  if (orphanRes.rowCount) console.log(`Removed ${orphanRes.rowCount} orphaned products`);
}

// ============ MAIN ============

async function main() {
  const vendorId = await upsertVendor();
  console.log(`Vendor MegaClic: ${vendorId}\n`);

  let productsCreated = 0, productsUpdated = 0;
  let skusCreated = 0, skusUpdated = 0;
  let accessoriesCreated = 0;
  let imagesAdded = 0;

  for (const [collection, catKey, moldingTier, attrs, groups] of COLLECTIONS) {
    const categoryId = CAT[catKey];
    console.log(`\n--- ${collection} (${catKey}) ---`);

    for (const [sqftPerBox, pcsPerBox, boxesPerPallet, costPerSqft, items] of groups) {
      for (const [vendorSku, colorName, imageUrl, lifestyleUrl] of items) {
        // Create product
        const product = await upsertProduct(vendorId, {
          name: colorName,
          collection,
          categoryId,
        });
        if (product.is_new) productsCreated++;
        else productsUpdated++;

        // Create main flooring SKU
        const internalSku = `MEGACLIC-${vendorSku}`;
        const sku = await upsertSku(product.id, {
          vendorSku,
          internalSku,
          variantName: colorName,
          sellBy: 'sqft',
          variantType: null,
        });
        if (sku.is_new) skusCreated++;
        else skusUpdated++;

        // Pricing: cost = PDF price, retail = cost x 2
        const cost = costPerSqft;
        const retail = parseFloat((cost * MARKUP).toFixed(2));
        await upsertPricing(sku.id, cost, retail, 'per_sqft');

        // Packaging
        await upsertPackaging(sku.id, { sqftPerBox, pcsPerBox, boxesPerPallet });

        // Primary image (product swatch/closeup)
        if (imageUrl) {
          await upsertMediaAsset(product.id, sku.id, imageUrl);
          imagesAdded++;
        }

        // Lifestyle image (room scene)
        if (lifestyleUrl) {
          await upsertLifestyleAsset(product.id, sku.id, lifestyleUrl);
          imagesAdded++;
        }

        // Attributes
        if (attrs.material) await upsertAttribute(sku.id, 'Material', attrs.material);
        if (attrs.thickness) await upsertAttribute(sku.id, 'Thickness', attrs.thickness);
        if (attrs.width) await upsertAttribute(sku.id, 'Width', attrs.width);
        if (attrs.finish) await upsertAttribute(sku.id, 'Finish', attrs.finish);
        if (attrs.wear_layer) await upsertAttribute(sku.id, 'Wear Layer', attrs.wear_layer);
        if (attrs.installation) await upsertAttribute(sku.id, 'Installation', attrs.installation);
        await upsertAttribute(sku.id, 'Color', colorName);
        await upsertAttribute(sku.id, 'Collection', collection);

        // Create accessory SKUs (moldings) under the SAME product_id
        const moldings = MOLDINGS[moldingTier] || [];
        for (const [suffix, accName, accCost] of moldings) {
          const accInternalSku = `MEGACLIC-${vendorSku}-${suffix}`;
          const accSku = await upsertSku(product.id, {
            vendorSku: `${vendorSku}-${suffix}`,
            internalSku: accInternalSku,
            variantName: accName,
            sellBy: 'unit',
            variantType: 'accessory',
          });
          if (accSku.is_new) accessoriesCreated++;

          const accRetail = parseFloat((accCost * MARKUP).toFixed(2));
          await upsertPricing(accSku.id, accCost, accRetail, 'per_unit');
        }
      }
    }

    const count = groups.reduce((n, g) => n + g[4].length, 0);
    const moldingCount = (MOLDINGS[moldingTier] || []).length;
    console.log(`  ${count} products, each with ${moldingCount} accessories`);
  }

  // ==================== SUNDRIES ====================
  console.log('\n--- Sundries ---');
  for (const s of SUNDRIES) {
    const product = await upsertProduct(vendorId, {
      name: s.name,
      collection: 'Sundries',
      categoryId: CAT.sundries,
    });
    if (product.is_new) productsCreated++;
    else productsUpdated++;

    const internalSku = `MEGACLIC-${s.vendorSku}`;
    const sku = await upsertSku(product.id, {
      vendorSku: s.vendorSku,
      internalSku,
      variantName: s.name,
      sellBy: s.sellBy,
      variantType: null,
    });
    if (sku.is_new) skusCreated++;
    else skusUpdated++;

    const retail = parseFloat((s.cost * MARKUP).toFixed(2));
    await upsertPricing(sku.id, s.cost, retail, s.priceBasis);

    console.log(`  ${s.name}: $${s.cost}/${s.sellBy}`);
  }

  // ==================== CLEANUP ====================
  await cleanupBadSkus(vendorId);

  console.log('\n=== MegaClic Import Complete ===');
  console.log(`Products created: ${productsCreated}`);
  console.log(`Products updated: ${productsUpdated}`);
  console.log(`Flooring SKUs created: ${skusCreated}`);
  console.log(`Flooring SKUs updated: ${skusUpdated}`);
  console.log(`Accessory SKUs created: ${accessoriesCreated}`);
  console.log(`Images added: ${imagesAdded}`);
  console.log(`Total SKUs: ${skusCreated + skusUpdated + accessoriesCreated}`);

  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
