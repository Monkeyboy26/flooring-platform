#!/usr/bin/env node

/**
 * Import Elite Stone product data from price list PDFs.
 * Source: Stone Price List (May 2025) + Sink Price List (Apr 2025)
 * Website: https://www.elitestonegroup.com
 *
 * Sections:
 *   1. Quartz Stone (~90 colors, up to 5 slab sizes each)
 *   2. E Quartz Stone / Printed Surface (~12 colors)
 *   3. Porcelain Slabs Made in Italy (~21 colors, slab-only)
 *   4. Shower Panels — Engineer Marble (~7 items, 2 sizes)
 *   5. Stainless Steel Sinks (~19 items)
 *
 * Usage: docker compose exec api node scripts/import-elite-stone.js
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
const CAT_QUARTZ      = '650e8400-e29b-41d4-a716-446655440041'; // Quartz Countertops
const CAT_PORCELAIN   = '650e8400-e29b-41d4-a716-446655440045'; // Porcelain Slabs
const CAT_NAT_STONE   = '650e8400-e29b-41d4-a716-446655440011'; // Natural Stone
const CAT_KITCHEN_SINK = '650e8400-e29b-41d4-a716-446655440071'; // Kitchen Sinks
const CAT_BATH_SINK   = '650e8400-e29b-41d4-a716-446655440072'; // Bathroom Sinks
const CAT_WALL        = '650e8400-e29b-41d4-a716-446655440050'; // Backsplash & Wall Tile (shower panels)

// Quartz slab size labels (used as variant_name)
const SIZE_LABELS = ['9\'x2\' Set', '9\'x3\' Piece', '9\'x42" Piece', '9\'x52" Piece', '122"-126"x63" Slab'];
const SIZE_CODES  = ['9X2', '9X3', '9X42', '9X52', 'SLAB'];

// ==================== QUARTZ STONE DATA ====================
// Each entry: [name, itemCode, 9x2$, 9x3$, 9x42$, 9x52$, slab$, ...opts]
// null = size not available. opts: { finish, note }

const QUARTZ_STONE = [
  // Page 1
  ['Absolute Black', 'ES702', 309, 414, 513, 624, null],
  ['Acqurella White', null, 432, 615, 775, 908, 1056],
  ['Alpine Glacier', 'ES9270V', 387, 579, 726, 824, 969, { note: 'Silica Free' }],
  ['Alps White', null, 410, 599, 763, 870, null],
  ['Amazonite', 'ES8610', 432, 614, 776, 908, 1057],
  ['Arabescato Gold', null, 410, 599, 763, 870, 1031],
  ['Athens Grey', 'ES816', 337, 509, 616, 728, null],
  ['Atlantic Ocean', 'ES9115', 387, 579, 726, 824, 969],
  ['Aurora Calacatta', 'ES8536', 369, 547, 661, 777, 930],
  ['Bella Calacatta', 'ES837', 387, 579, 726, 824, 969],
  ['Black Sparkle', 'ES037A', 198, 313, 377, 452, null],
  ['Blanco Midnight', 'ES701', 306, 410, 494, 603, null],
  ['Bologna', 'ES9356', 369, 539, 687, 783, 928],
  ['Calacatas Alaska', 'ES822', 299, 432, 564, 629, 775],
  ['Calacatas Dorada', 'ES826', 299, 432, 564, 629, 775],
  ['Calacatas Marquina', 'ES823', 377, 554, 686, 821, 946],
  ['Calacatas Phoenix', 'ES6203', 387, 579, 726, 824, 969],
  ['Calacatas Pietra', 'ES828', 388, 542, 692, 786, null],
  ['Calacatas River', 'ES8507', 387, 579, 726, 824, 969],
  ['Calacatas Rocky', 'ES824', 315, 468, 566, 666, 795],
  ['Calacatas Tesoro', 'ES825', 418, 621, 760, 921, null],
  ['Calacatas Vega', 'ES829', 332, 492, 595, 699, 837],
  ['Calacatas White', 'ES820', 299, 432, 564, 629, 775],
  ['Calacatta Eternal', null, 369, 547, 661, 777, 930],
  // Page 2
  ['Cappuccino', 'ES4030', 259, 341, 386, 464, null],
  ['Capri Calacatta', 'ES9324', 387, 579, 726, 824, 969],
  ['Carrara Gold', null, 288, 398, 478, 566, null],
  ['Carrara White', 'ES021/430', 273, 378, 454, 542, 584],
  ['Concrete Grey', 'ES112', 233, 314, 356, 425, null],
  ['Crema Marfil', null, 376, 528, 690, 787, null],
  ['Dolomiti', null, 432, 615, 775, 908, 1056],
  ['Fairy White', 'ES428', 246, 340, 409, 488, 526],
  ['Fantasy Gold', null, 387, 579, 726, 824, 969],
  ['Galatic', 'ES3211', 432, 615, 775, 908, null, { finish: 'Leather' }],
  ['Grey Galaxy', 'ES110', 198, 313, 377, 452, 494],
  ['Grey Sand', 'ES713', 288, 379, 429, 516, null],
  ['Havana Encore', null, 432, 615, 775, 908, 1056],
  ['Helix', 'ES811', 342, 484, 629, 730, 837],
  ['Himalaya', 'ES9355', 369, 539, 687, 783, 928],
  ['Ice Wave', 'ES432', 320, 400, 481, 581, null],
  ['Kashmere', 'ES035', 373, 519, 666, 760, null],
  ['Latte', 'ES801', 279, 399, 515, 599, null],
  ['Light Brown', 'ES026/202', 298, 406, 472, 581, null],
  ['Luna Bianca', 'ES8321', 432, 615, 775, 908, 1056],
  ['Macaubas', 'ES6305', 410, 599, 763, 870, 1031],
  ['Marble Onyx', 'ES831', 329, 499, 663, 739, null],
  ['Marmo Black', 'ES8593', 348, 521, 653, 742, null],
  ['Maruggio Gold', null, 387, 579, 726, 824, 969],
  ['Moon Grey', 'ES830', 432, 615, 775, 908, 1057, { finish: 'Leather' }],
  ['Mountain Grey', 'ES423A', 362, 460, 549, 660, 883, { finish: 'Leather' }],
  ['Nevada Fusion', null, 348, 521, 653, 742, null],
  // Page 3
  ['New Calacatas Gold', null, null, null, null, null, 1110],
  ['New Sahara Gold', null, null, null, null, null, 599],
  ['Nile Calacatta', null, 399, 586, 714, 865, 999],
  ['Obsidian', 'ES848', 342, 487, 614, 719, 837],
  ['Ombre Lavasa', 'ES9208', 387, 579, 726, 824, 969],
  ['Panda White', null, 369, 539, 697, 783, 928],
  ['Pepper Grey', 'ES415', 298, 406, 472, 581, null],
  ['Prado Gold', 'ES845', 369, 539, 687, 783, 928],
  ['Pure White', 'ES001/300', 269, 377, 432, 541, 553],
  ['Roma Calacatta', 'ES838', 387, 579, 726, 824, 969],
  ['Royal Green', null, 432, 615, 775, 908, 1056],
  ['Sahara Gold', 'ES834', 410, 599, 763, 870, 1031],
  ['Silk Carmel', 'ES413', 298, 406, 472, 581, null],
  ['Silver Birch', 'ES9733', 387, 579, 726, 824, 969],
  ['Taj Mahal', null, 369, 539, 687, 783, 928],
  ['Thunder Black', 'ES9117', 387, 579, 726, 824, 969],
  ['Travertine Gold', 'ES8810', 432, 614, 776, 908, 1057],
  ['Truffle Gold', 'ES8532K', 387, 579, 726, 824, null],
  // Page 4
  ['Truffle White', 'ES8132', 387, 579, 726, 824, 969],
  ['Tuscany', null, 410, 599, 763, 870, 1031],
  ['Venation Oro', 'ES6306', 410, 599, 763, 870, 1031],
  ['Verde Alpi', 'ES8386', 432, 615, 775, 908, 1056],
  ['Volakano White', null, 308, 436, 566, 657, 753],
  ['Wavy Mirage', 'ES6307', 369, 539, 687, 783, 928],
  ['White Beach', 'ES009', 242, 351, 410, 490, null],
  ['White Cloud', 'ES508', 340, 439, 521, 608, 696],
  ['White Crystal', 'ES010', 198, 313, 377, 452, 494],
  ['White Sparkle', 'ES103', 198, 313, 377, 452, 494],
  ['Zircon Blue', 'ES027', 249, 351, 412, 499, null],
  ['Zircon Whitney', 'ES017/417', 249, 351, 412, 499, null],
];

// ==================== E QUARTZ STONE (Printed Surface) ====================
const E_QUARTZ_STONE = [
  ['Amber Calacatta', 'PT-S012', null, null, null, null, 1057],
  ['Calacatas Venata', 'PT21', 432, 614, 776, 908, 1057],
  ['Calacatta Giada', null, 432, 614, 776, 908, 1057],
  ['Caramel Cloud', 'PT27', 432, 614, 776, 908, null],
  ['Cedar Gold', 'PT-E09', 432, 614, 776, 908, null],
  ['Cedar White', 'PT-E10', 432, 614, 776, 908, null],
  ['Graphite Cascade', 'PT-S006', 432, 614, 776, 908, null],
  ['Naica', 'PT89861', 432, 614, 776, 908, 1057],
  ['Nautica Ivory', 'PT-E06', 432, 614, 776, 908, null],
  ['New Taj Mahal', null, 432, 614, 776, 908, 1057],
  ['Noir Feathers', 'PT-S019', 432, 614, 776, 908, 1057],
  ['Sofitel Gold', 'PT-S003', 432, 614, 776, 908, 1057],
];

// ==================== PORCELAIN SLABS (Made in Italy, 1/2" Thick) ====================
// Only 122"-126"x63" slab size available
const PORCELAIN_SLABS = [
  ['Appennino', 'Silk / Matte', 888],
  ['Bianco Dolomite', 'Polished', 943],
  ['Black Atlantis', 'Silk / Matte', 888],
  ['Black Lava', 'Leather', 888],
  ['Black Tempest', 'Silk / Matte', 888],
  ['Boost Mineral Grey', 'Hammered', 499],
  ['Calacatta Antique', 'Polished', 849],
  ['Calacatta Borghini', 'Polished', 943],
  ['Calacatta Gold', 'Polished', 943],
  ['Calacatta Meraviglia', 'Polished', 943],
  ['Calacatta Prestigio', 'Silk / Matte', 888],
  ['Crystal White', 'Polished', 888],
  ['Fior Di Bosco Silk', 'Polished', 943],
  ['Grey Stone', 'Silk / Matte', 799],
  ['Onyx White', 'Polished', 943],
  ['Silver Root', 'Silk / Matte', 888],
  ['Sky Stone', 'Silk / Matte', 888],
  ['Satuario Suppremo', 'Polished', 943],
  ['Taj Mahal', 'Polished', 943],
  ['Travertino Pearl', 'Hammered', 888],
  ['White Cloud', 'Silk / Matte', 799],
];

// ==================== SHOWER PANELS (Engineer Marble, 1/2" Thick) ====================
// Two sizes: 96"x36" and 96"x59"
const SHOWER_PANELS = [
  ['Ajax White', 'Polished', 199, 332],
  ['Calacatas Azure', 'Polished, Print Surface', 199, 332],
  ['Calacatas White', 'Polished', 199, 332],
  ['Mist White', 'Polished', 199, 332],
  ['Pure White', 'Polished', 199, 332],
  ['Statuarietto', 'Polished, Print Surface', 199, 332],
  ['White Crystal', 'Polished', 188, 309],
];

// ==================== STAINLESS STEEL SINKS ====================
// [itemCode, description, cost]
const SS_SINKS = [
  ['AP3522D', 'Double Apron Sink Undermount', 317],
  ['AP3522S', 'Single Apron Sink Undermount', 278],
  ['AP3322D-RD-BLACK', 'Double Apron Sink Undermount, Black', 344],
  ['AP3322S-RD-BLACK', 'Single Apron Sink Undermount, Black', 306],
  ['F2318', 'Square Sink Undermount', 150],
  ['RR3219D', 'Double Square Sink Undermount, Round Corner', 206],
  ['RR3219S', 'Single Square Sink Undermount, Round Corner', 183],
  ['RD3219D-BLACK', 'Double Square Sink Undermount, Round Corner, Black', 233],
  ['RD3219S-BLACK', 'Single Square Sink Undermount, Round Corner, Black', 211],
  ['RD2318', 'Undermount Laundry Sink', 206],
  ['RD4045', 'Square Undermount', 133],
  ['SM1512', 'Undermount 15-1/16"x12-3/4"', 58],
  ['SM1815', 'Undermount', 67],
  ['SM2318', 'Undermount', 80],
  ['SM3018', 'Single Undermount', 88],
  ['SM502', '50/50 Same Size Undermount', 88],
  ['SM503R', '40/60 Undermount', 88],
  ['SM560-820D', 'Top Mount Sink Double Bowl', 88],
  ['SM560-820S', 'Top Mount Sink Single Bowl', 88],
];

// ==================== Helpers ====================

function nameToCode(name) {
  return name.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

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
  `, [product_id, vendor_sku, internal_sku, variant_name || null, sell_by || 'unit', variant_type || null]);
  return result.rows[0];
}

async function upsertPricing(sku_id, { cost, retail_price }) {
  await pool.query(`
    INSERT INTO pricing (sku_id, cost, retail_price, price_basis)
    VALUES ($1, $2, $3, 'per_unit')
    ON CONFLICT (sku_id) DO UPDATE SET
      cost = EXCLUDED.cost,
      retail_price = EXCLUDED.retail_price
  `, [sku_id, cost, retail_price]);
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

// Ensure required attributes exist
async function ensureAttribute(slug, name) {
  const existing = await pool.query('SELECT id FROM attributes WHERE slug = $1', [slug]);
  if (existing.rows.length) return;
  await pool.query(
    'INSERT INTO attributes (slug, name) VALUES ($1, $2) ON CONFLICT (slug) DO NOTHING',
    [slug, name]
  );
}

// ==================== Main ====================

async function main() {
  // Ensure vendor exists
  let vendorRes = await pool.query("SELECT id FROM vendors WHERE code = 'ELITESTONE'");
  let vendorId;
  if (!vendorRes.rows.length) {
    const ins = await pool.query(`
      INSERT INTO vendors (name, code, website)
      VALUES ('Elite Stone', 'ELITESTONE', 'https://www.elitestonegroup.com')
      RETURNING id
    `);
    vendorId = ins.rows[0].id;
    console.log(`Created vendor: Elite Stone (${vendorId})`);
  } else {
    vendorId = vendorRes.rows[0].id;
    console.log(`Using existing vendor: Elite Stone (${vendorId})`);
  }

  // Ensure attributes exist
  await ensureAttribute('mount_type', 'Mount Type', 'text');
  await ensureAttribute('bowl_configuration', 'Bowl Configuration', 'text');

  let productsCreated = 0, productsUpdated = 0, skusCreated = 0, skusUpdated = 0;

  // ==================== 1. QUARTZ STONE ====================
  console.log('\n--- Importing Quartz Stone ---');
  for (const entry of QUARTZ_STONE) {
    const [name, itemCode, ...rest] = entry;
    const lastEl = rest[rest.length - 1];
    const opts = (lastEl && typeof lastEl === 'object') ? rest.pop() : {};
    const prices = rest; // [9x2, 9x3, 9x42, 9x52, slab]

    const finishStr = opts.finish ? `${opts.finish} Finish` : 'Polished';
    const noteStr = opts.note || '';
    const desc = `Quartz Stone Slab${noteStr ? ' — ' + noteStr : ''}`;

    const product = await upsertProduct(vendorId, {
      name,
      collection: 'Quartz Stone',
      category_id: CAT_QUARTZ,
      description_short: desc,
    });
    if (product.is_new) productsCreated++; else productsUpdated++;

    let sizesAdded = 0;
    for (let i = 0; i < 5; i++) {
      if (!prices[i]) continue;

      const code = itemCode || nameToCode(name);
      const vendorSku = itemCode ? `${itemCode}-${SIZE_CODES[i]}` : `${nameToCode(name)}-${SIZE_CODES[i]}`;
      const internalSku = `ELITESTONE-${code}-${SIZE_CODES[i]}`;

      const sku = await upsertSku(product.id, {
        vendor_sku: vendorSku,
        internal_sku: internalSku,
        variant_name: SIZE_LABELS[i],
        sell_by: 'unit',
      });
      if (sku.is_new) skusCreated++; else skusUpdated++;

      const retailPrice = +(prices[i] * 1.65).toFixed(2); // ~65% markup for slabs
      await upsertPricing(sku.id, { cost: prices[i], retail_price: retailPrice });

      await setAttr(sku.id, 'color', name);
      await setAttr(sku.id, 'countertop_material', 'Quartz');
      await setAttr(sku.id, 'countertop_finish', opts.finish || 'Polished');
      await setAttr(sku.id, 'size', SIZE_LABELS[i]);
      await setAttr(sku.id, 'brand', 'Elite Stone');
      if (noteStr) await setAttr(sku.id, 'material', noteStr);

      sizesAdded++;
    }
    console.log(`  ${product.is_new ? '+' : '~'} ${name} (${sizesAdded} sizes)`);
  }

  // ==================== 2. E QUARTZ STONE (Printed Surface) ====================
  console.log('\n--- Importing E Quartz Stone (Printed Surface) ---');
  for (const entry of E_QUARTZ_STONE) {
    const [name, itemCode, ...prices] = entry;

    const product = await upsertProduct(vendorId, {
      name,
      collection: 'E Quartz Stone',
      category_id: CAT_QUARTZ,
      description_short: 'E Quartz — Printed Surface Technology',
    });
    if (product.is_new) productsCreated++; else productsUpdated++;

    let sizesAdded = 0;
    for (let i = 0; i < 5; i++) {
      if (!prices[i]) continue;

      const code = itemCode || nameToCode(name);
      const vendorSku = itemCode ? `${itemCode}-${SIZE_CODES[i]}` : `${nameToCode(name)}-${SIZE_CODES[i]}`;
      const internalSku = `ELITESTONE-${code}-${SIZE_CODES[i]}`;

      const sku = await upsertSku(product.id, {
        vendor_sku: vendorSku,
        internal_sku: internalSku,
        variant_name: SIZE_LABELS[i],
        sell_by: 'unit',
      });
      if (sku.is_new) skusCreated++; else skusUpdated++;

      const retailPrice = +(prices[i] * 1.65).toFixed(2);
      await upsertPricing(sku.id, { cost: prices[i], retail_price: retailPrice });

      await setAttr(sku.id, 'color', name);
      await setAttr(sku.id, 'countertop_material', 'E Quartz');
      await setAttr(sku.id, 'countertop_finish', 'Printed Surface');
      await setAttr(sku.id, 'size', SIZE_LABELS[i]);
      await setAttr(sku.id, 'brand', 'Elite Stone');

      sizesAdded++;
    }
    console.log(`  ${product.is_new ? '+' : '~'} ${name} (${sizesAdded} sizes)`);
  }

  // ==================== 3. PORCELAIN SLABS (Made in Italy) ====================
  console.log('\n--- Importing Porcelain Slabs (Made in Italy) ---');
  for (const [name, finish, cost] of PORCELAIN_SLABS) {
    const product = await upsertProduct(vendorId, {
      name,
      collection: 'Porcelain Slabs',
      category_id: CAT_PORCELAIN,
      description_short: 'Porcelain Slab — Made in Italy — 1/2" Thick',
    });
    if (product.is_new) productsCreated++; else productsUpdated++;

    const code = nameToCode(name);
    const internalSku = `ELITESTONE-PS-${code}`;

    const sku = await upsertSku(product.id, {
      vendor_sku: `PS-${code}`,
      internal_sku: internalSku,
      variant_name: '122"-126"x63" Slab',
      sell_by: 'unit',
    });
    if (sku.is_new) skusCreated++; else skusUpdated++;

    const retailPrice = +(cost * 1.65).toFixed(2);
    await upsertPricing(sku.id, { cost, retail_price: retailPrice });

    await setAttr(sku.id, 'color', name);
    await setAttr(sku.id, 'material', 'Porcelain');
    await setAttr(sku.id, 'countertop_finish', finish);
    await setAttr(sku.id, 'thickness', '1/2"');
    await setAttr(sku.id, 'size', '122"-126"x63"');
    await setAttr(sku.id, 'brand', 'Elite Stone');

    console.log(`  ${product.is_new ? '+' : '~'} ${name} (${finish}) — $${cost}`);
  }

  // ==================== 4. SHOWER PANELS (Engineer Marble) ====================
  console.log('\n--- Importing Shower Panels (Engineer Marble) ---');
  const SHOWER_SIZE_LABELS = ['96"x36" Panel', '96"x59" Panel'];
  const SHOWER_SIZE_CODES  = ['96X36', '96X59'];

  for (const [name, finish, cost36, cost59] of SHOWER_PANELS) {
    const product = await upsertProduct(vendorId, {
      name,
      collection: 'Shower Panels',
      category_id: CAT_WALL,
      description_short: 'Shower Panel — Engineer Marble — 1/2" Thick',
    });
    if (product.is_new) productsCreated++; else productsUpdated++;

    const code = nameToCode(name);
    const costs = [cost36, cost59];

    for (let i = 0; i < 2; i++) {
      const internalSku = `ELITESTONE-SP-${code}-${SHOWER_SIZE_CODES[i]}`;
      const sku = await upsertSku(product.id, {
        vendor_sku: `SP-${code}-${SHOWER_SIZE_CODES[i]}`,
        internal_sku: internalSku,
        variant_name: SHOWER_SIZE_LABELS[i],
        sell_by: 'unit',
      });
      if (sku.is_new) skusCreated++; else skusUpdated++;

      const retailPrice = +(costs[i] * 1.65).toFixed(2);
      await upsertPricing(sku.id, { cost: costs[i], retail_price: retailPrice });

      await setAttr(sku.id, 'color', name);
      await setAttr(sku.id, 'material', 'Engineer Marble');
      await setAttr(sku.id, 'countertop_finish', finish);
      await setAttr(sku.id, 'thickness', '1/2"');
      await setAttr(sku.id, 'size', SHOWER_SIZE_LABELS[i]);
      await setAttr(sku.id, 'brand', 'Elite Stone');
    }
    console.log(`  ${product.is_new ? '+' : '~'} ${name} (${finish})`);
  }

  // ==================== 5. STAINLESS STEEL SINKS ====================
  console.log('\n--- Importing Stainless Steel Sinks ---');
  for (const [itemCode, description, cost] of SS_SINKS) {
    // Determine mount type and bowl config from description
    const descLower = description.toLowerCase();
    const mountType = descLower.includes('top mount') ? 'Top Mount' : 'Undermount';
    let bowlConfig = 'Single';
    if (descLower.includes('double') || descLower.includes('50/50')) bowlConfig = 'Double';
    else if (descLower.includes('40/60')) bowlConfig = 'Double (40/60)';

    const isBlack = descLower.includes('black');
    const sinkName = description.replace(/, Black$/i, '').replace(/BLACK, /i, '');

    const product = await upsertProduct(vendorId, {
      name: sinkName,
      collection: 'Stainless Steel Sinks',
      category_id: CAT_KITCHEN_SINK,
      description_short: `Stainless Steel ${description}`,
    });
    if (product.is_new) productsCreated++; else productsUpdated++;

    const internalSku = `ELITESTONE-${itemCode}`;
    const variantName = isBlack ? 'Black' : 'Stainless Steel';

    const sku = await upsertSku(product.id, {
      vendor_sku: itemCode,
      internal_sku: internalSku,
      variant_name: variantName,
      sell_by: 'unit',
    });
    if (sku.is_new) skusCreated++; else skusUpdated++;

    const retailPrice = +(cost * 2.0).toFixed(2); // 2x markup for sinks
    await upsertPricing(sku.id, { cost, retail_price: retailPrice });

    await setAttr(sku.id, 'sink_material', 'Stainless Steel');
    await setAttr(sku.id, 'sink_type', mountType);
    await setAttr(sku.id, 'mount_type', mountType);
    await setAttr(sku.id, 'bowl_configuration', bowlConfig);
    await setAttr(sku.id, 'color', isBlack ? 'Black' : 'Stainless Steel');
    await setAttr(sku.id, 'brand', 'Elite Stone');

    console.log(`  ${product.is_new ? '+' : '~'} ${itemCode} — ${description} — $${cost}`);
  }

  // ==================== Summary ====================
  console.log('\n=== Import Complete ===');
  console.log(`Products: ${productsCreated} created, ${productsUpdated} updated`);
  console.log(`SKUs:     ${skusCreated} created, ${skusUpdated} updated`);
  console.log('');

  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
