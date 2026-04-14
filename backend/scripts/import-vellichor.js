#!/usr/bin/env node

/**
 * Import Vellichor Floors product data from price list PDFs.
 * Source: SPC Floor Price List + Engineered Hardwood Price List (Feb 2026)
 *
 * Usage: node backend/scripts/import-vellichor.js
 * Run inside the API container: docker compose exec api node scripts/import-vellichor.js
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
const CAT_LVP = '650e8400-e29b-41d4-a716-446655440031';       // LVP (Plank)
const CAT_ENG = '650e8400-e29b-41d4-a716-446655440021';       // Engineered Hardwood
const CAT_MOLDING = '650e8400-e29b-41d4-a716-446655440114';   // Transitions & Moldings

// ==================== Product Data ====================

const SPC_PRODUCTS = [
  // Gemstone Collection — 6.5mm, 9"x60", 1.5mm IXPE, 0.5mm/20mil wear layer
  { collection: 'Gemstone Collection', sku: 'VC-502', name: 'Garnet',    sqft: 26.18, boxes_pallet: 52, cost: 1.89, thickness: '6.5mm', size: '9x60', wear_layer: '0.5mm (20mil)' },
  { collection: 'Gemstone Collection', sku: 'VC-505', name: 'Peridot',   sqft: 26.18, boxes_pallet: 52, cost: 1.69, thickness: '6.5mm', size: '9x60', wear_layer: '0.5mm (20mil)' },
  { collection: 'Gemstone Collection', sku: 'VC-509', name: 'Amber',     sqft: 26.18, boxes_pallet: 52, cost: 1.69, thickness: '6.5mm', size: '9x60', wear_layer: '0.5mm (20mil)' },
  { collection: 'Gemstone Collection', sku: 'VC-510', name: 'Onyx',      sqft: 26.18, boxes_pallet: 52, cost: 1.89, thickness: '6.5mm', size: '9x60', wear_layer: '0.5mm (20mil)' },
  { collection: 'Gemstone Collection', sku: 'VC-511', name: 'Sapphire',  sqft: 26.18, boxes_pallet: 52, cost: 1.89, thickness: '6.5mm', size: '9x60', wear_layer: '0.5mm (20mil)' },
  { collection: 'Gemstone Collection', sku: 'VC-512', name: 'Ruby',      sqft: 26.18, boxes_pallet: 52, cost: 1.89, thickness: '6.5mm', size: '9x60', wear_layer: '0.5mm (20mil)' },

  // Galaxy Collection — 7.5mm, 9"x60", 1.5mm IXPE, 0.5mm/20mil wear layer
  { collection: 'Galaxy Collection', sku: 'VC-601', name: 'Milky Way',   sqft: 22.44, boxes_pallet: 52, cost: 1.89, thickness: '7.5mm', size: '9x60', wear_layer: '0.5mm (20mil)' },
  { collection: 'Galaxy Collection', sku: 'VC-602', name: 'Black Eye',   sqft: 22.44, boxes_pallet: 52, cost: 1.89, thickness: '7.5mm', size: '9x60', wear_layer: '0.5mm (20mil)' },
  { collection: 'Galaxy Collection', sku: 'VC-603', name: 'Centaurus',   sqft: 22.44, boxes_pallet: 52, cost: 1.89, thickness: '7.5mm', size: '9x60', wear_layer: '0.5mm (20mil)' },
  { collection: 'Galaxy Collection', sku: 'VC-605', name: 'Whirlpool',   sqft: 22.44, boxes_pallet: 52, cost: 1.89, thickness: '7.5mm', size: '9x60', wear_layer: '0.5mm (20mil)' },
  { collection: 'Galaxy Collection', sku: 'VC-607', name: 'Andromeda',   sqft: 22.44, boxes_pallet: 52, cost: 1.89, thickness: '7.5mm', size: '9x60', wear_layer: '0.5mm (20mil)' },
  { collection: 'Galaxy Collection', sku: 'VC-608', name: 'Pinwheel',    sqft: 22.44, boxes_pallet: 52, cost: 1.89, thickness: '7.5mm', size: '9x60', wear_layer: '0.5mm (20mil)' },

  // Summit Collection — 8.5mm, 9"x60", 1.5mm IXPE, 0.5mm/20mil wear layer
  { collection: 'Summit Collection', sku: 'VC-701', name: 'Denali',   sqft: 18.70, boxes_pallet: 52, cost: 2.09, thickness: '8.5mm', size: '9x60', wear_layer: '0.5mm (20mil)' },
  { collection: 'Summit Collection', sku: 'VC-705', name: 'Torbert',  sqft: 18.70, boxes_pallet: 52, cost: 2.09, thickness: '8.5mm', size: '9x60', wear_layer: '0.5mm (20mil)' },
  { collection: 'Summit Collection', sku: 'VC-709', name: 'Shasta',   sqft: 18.70, boxes_pallet: 52, cost: 2.49, thickness: '8.5mm', size: '9x60', wear_layer: '0.5mm (20mil)' },
  { collection: 'Summit Collection', sku: 'VC-710', name: 'Rainier',  sqft: 18.70, boxes_pallet: 52, cost: 2.49, thickness: '8.5mm', size: '9x60', wear_layer: '0.5mm (20mil)' },
  { collection: 'Summit Collection', sku: 'VC-711', name: 'Ossa',     sqft: 18.70, boxes_pallet: 52, cost: 2.49, thickness: '8.5mm', size: '9x60', wear_layer: '0.5mm (20mil)' },
  { collection: 'Summit Collection', sku: 'VC-712', name: 'K2',       sqft: 18.70, boxes_pallet: 52, cost: 2.49, thickness: '8.5mm', size: '9x60', wear_layer: '0.5mm (20mil)' },

  // Summit Collection Herringbone — 8.5mm, 5"x25", 1.5mm IXPE, 0.5mm/20mil wear layer
  { collection: 'Summit Collection', sku: 'VC-709H', name: 'Shasta', variant_suffix: 'Herringbone', sqft: 8.41, boxes_pallet: 48, cost: 2.79, thickness: '8.5mm', size: '5x25', wear_layer: '0.5mm (20mil)', pattern: 'Herringbone' },
];

const ENG_PRODUCTS = [
  // Prime Collection — European Oak, Wire Brushed, UV Lacquer, 4mm wear layer
  { collection: 'Prime Collection', sku: 'VC-301', name: 'Prime 1', width: '9-1/2"', thick: '3/4"', sqft: 28.42, boxes_pallet: 36, cost: 8.79 },
  { collection: 'Prime Collection', sku: 'VC-302', name: 'Prime 2', width: '9-1/2"', thick: '3/4"', sqft: 28.42, boxes_pallet: 36, cost: 8.79 },
  { collection: 'Prime Collection', sku: 'VC-303', name: 'Prime 3', width: '7-1/2"', thick: '3/4"', sqft: 23.31, boxes_pallet: 40, cost: 6.89 },
  { collection: 'Prime Collection', sku: 'VC-304', name: 'Prime 4', width: '7-1/2"', thick: '3/4"', sqft: 23.31, boxes_pallet: 40, cost: 6.89 },
  { collection: 'Prime Collection', sku: 'VC-305', name: 'Prime 5', width: '7-1/2"', thick: '5/8"', sqft: 23.31, boxes_pallet: 50, cost: 6.39 },
  { collection: 'Prime Collection', sku: 'VC-306', name: 'Prime 6', width: '7-1/2"', thick: '5/8"', sqft: 23.31, boxes_pallet: 50, cost: 6.39 },
  { collection: 'Prime Collection', sku: 'VC-307', name: 'Prime 7', width: '7-1/2"', thick: '5/8"', sqft: 23.31, boxes_pallet: 50, cost: 5.89 },
  { collection: 'Prime Collection', sku: 'VC-308', name: 'Prime 8', width: '7-1/2"', thick: '5/8"', sqft: 23.31, boxes_pallet: 50, cost: 5.89 },
  { collection: 'Prime Collection', sku: 'VC-304SO', name: 'Prime 4', variant_suffix: 'Special Order', width: '10-1/4"', thick: '3/4"', sqft: 30.78, boxes_pallet: 36, cost: 9.09 },

  // River Run Collection — 7-1/2", 5/8", 4mm wear layer
  { collection: 'River Run Collection', sku: 'VC-801', name: 'Seine',    width: '7-1/2"', thick: '5/8"', sqft: 23.31, boxes_pallet: 50, cost: 5.29 },
  { collection: 'River Run Collection', sku: 'VC-802', name: 'Garonne',  width: '7-1/2"', thick: '5/8"', sqft: 23.31, boxes_pallet: 50, cost: 5.29 },
  { collection: 'River Run Collection', sku: 'VC-807', name: 'Moselle',  width: '7-1/2"', thick: '5/8"', sqft: 23.31, boxes_pallet: 50, cost: 5.29 },
  { collection: 'River Run Collection', sku: 'VC-810', name: 'Vienne',   width: '7-1/2"', thick: '5/8"', sqft: 23.31, boxes_pallet: 50, cost: 5.29 },

  // Artist Collection — 7-1/2", 3/4", 4mm wear layer
  { collection: 'Artist Collection', sku: 'VC-902', name: 'Degas',     width: '7-1/2"', thick: '3/4"', sqft: 23.31, boxes_pallet: 40, cost: 5.89 },
  { collection: 'Artist Collection', sku: 'VC-904', name: 'Pissarro',  width: '7-1/2"', thick: '3/4"', sqft: 23.31, boxes_pallet: 40, cost: 5.89 },
  { collection: 'Artist Collection', sku: 'VC-908', name: 'Morisot',   width: '7-1/2"', thick: '3/4"', sqft: 23.31, boxes_pallet: 40, cost: 5.89 },
  { collection: 'Artist Collection', sku: 'VC-914', name: 'Lepage',    width: '7-1/2"', thick: '3/4"', sqft: 23.31, boxes_pallet: 40, cost: 5.89 },

  // Metropolitan Collection — 9-1/2", 3/4", 4mm wear layer
  { collection: 'Metropolitan Collection', sku: 'VC-105', name: 'Marseille', width: '9-1/2"', thick: '3/4"', sqft: 28.42, boxes_pallet: 36, cost: 6.39 },
  { collection: 'Metropolitan Collection', sku: 'VC-110', name: 'Lille',     width: '9-1/2"', thick: '3/4"', sqft: 28.42, boxes_pallet: 36, cost: 6.39 },

  // Throne Collection — 9-1/2", 3/4", 4mm wear layer
  { collection: 'Throne Collection', sku: 'VC-205', name: 'Riverlands', width: '9-1/2"', thick: '3/4"', sqft: 34.10, boxes_pallet: 40, cost: 5.09 },
  { collection: 'Throne Collection', sku: 'VC-206', name: 'Seasmoke',   width: '9-1/2"', thick: '3/4"', sqft: 34.10, boxes_pallet: 40, cost: 5.09 },
  { collection: 'Throne Collection', sku: 'VC-207', name: 'Braavos',    width: '9-1/2"', thick: '3/4"', sqft: 34.10, boxes_pallet: 40, cost: 5.09 },
  { collection: 'Throne Collection', sku: 'VC-208', name: 'Pentos',     width: '9-1/2"', thick: '3/4"', sqft: 34.10, boxes_pallet: 40, cost: 5.09 },
];

// SPC Moldings — sold by unit, variant_type = accessory
const SPC_MOLDINGS = [
  { name: 'Stair Nose',        sku_suffix: 'SN',  cost: 28, length: '94-1/2"' },
  { name: 'Square Stair Nose', sku_suffix: 'SSN', cost: 35, length: '94-1/2"' },
  { name: 'T Molding',         sku_suffix: 'TM',  cost: 18, length: '94-1/2"' },
  { name: 'Reducer',           sku_suffix: 'RD',  cost: 18, length: '94-1/2"' },
  { name: 'End Cap',           sku_suffix: 'EC',  cost: 18, length: '94-1/2"' },
  { name: 'Quarter Round',     sku_suffix: 'QR',  cost: 12, length: '94-1/2"' },
];

// Engineered Moldings — sold by unit, variant_type = accessory
const ENG_MOLDINGS = [
  { name: 'Flush Stair Nose', sku_suffix: 'FSN', cost: 65, length: "8'" },
  { name: 'T-Molding',        sku_suffix: 'TM',  cost: 40, length: "8'" },
  { name: 'Reducer',          sku_suffix: 'RD',  cost: 40, length: "8'" },
  { name: 'End Cap',          sku_suffix: 'EC',  cost: 40, length: "8'" },
  { name: 'Quarter Round',    sku_suffix: 'QR',  cost: 30, length: "8'" },
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

async function upsertPricing(sku_id, { cost, retail_price }) {
  await pool.query(`
    INSERT INTO pricing (sku_id, cost, retail_price, price_basis)
    VALUES ($1, $2, $3, 'per_sqft')
    ON CONFLICT (sku_id) DO UPDATE SET
      cost = EXCLUDED.cost,
      retail_price = EXCLUDED.retail_price
  `, [sku_id, cost, retail_price]);
}

async function upsertPricingUnit(sku_id, { cost, retail_price }) {
  await pool.query(`
    INSERT INTO pricing (sku_id, cost, retail_price, price_basis)
    VALUES ($1, $2, $3, 'per_unit')
    ON CONFLICT (sku_id) DO UPDATE SET
      cost = EXCLUDED.cost,
      retail_price = EXCLUDED.retail_price
  `, [sku_id, cost, retail_price]);
}

async function upsertPackaging(sku_id, { sqft_per_box, boxes_per_pallet }) {
  const sqft_per_pallet = sqft_per_box && boxes_per_pallet ? sqft_per_box * boxes_per_pallet : null;
  await pool.query(`
    INSERT INTO packaging (sku_id, sqft_per_box, boxes_per_pallet, sqft_per_pallet)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (sku_id) DO UPDATE SET
      sqft_per_box = COALESCE(EXCLUDED.sqft_per_box, packaging.sqft_per_box),
      boxes_per_pallet = COALESCE(EXCLUDED.boxes_per_pallet, packaging.boxes_per_pallet),
      sqft_per_pallet = COALESCE(EXCLUDED.sqft_per_pallet, packaging.sqft_per_pallet)
  `, [sku_id, sqft_per_box || null, boxes_per_pallet || null, sqft_per_pallet]);
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
  // Get vendor
  const vendorRes = await pool.query("SELECT id FROM vendors WHERE code = 'VELLICHOR'");
  if (!vendorRes.rows.length) { console.error('Vellichor vendor not found'); process.exit(1); }
  const vendorId = vendorRes.rows[0].id;

  let productsCreated = 0, productsUpdated = 0, skusCreated = 0, skusUpdated = 0;

  // ==================== SPC Products ====================
  console.log('\n--- Importing SPC Floor products ---');
  for (const item of SPC_PRODUCTS) {
    const productName = item.name;
    const variantName = item.variant_suffix
      ? `${item.size}, ${item.variant_suffix}`
      : item.size;

    const product = await upsertProduct(vendorId, {
      name: productName,
      collection: item.collection,
      category_id: CAT_LVP,
      description_short: `Luxury SPC Flooring — Ceramic Bead Enhanced Urethane`,
    });
    if (product.is_new) productsCreated++; else productsUpdated++;

    const internalSku = `VELLICHOR-${item.sku}`;
    const sku = await upsertSku(product.id, {
      vendor_sku: item.sku,
      internal_sku: internalSku,
      variant_name: variantName,
      sell_by: 'sqft',
    });
    if (sku.is_new) skusCreated++; else skusUpdated++;

    // Pricing — cost is what Roma pays; retail marked up ~2x
    const retailPrice = +(item.cost * 2.0).toFixed(2);
    await upsertPricing(sku.id, { cost: item.cost, retail_price: retailPrice });

    // Packaging
    await upsertPackaging(sku.id, { sqft_per_box: item.sqft, boxes_per_pallet: item.boxes_pallet });

    // Attributes
    await setAttr(sku.id, 'color', item.name);
    await setAttr(sku.id, 'material', 'SPC');
    await setAttr(sku.id, 'size', item.size.replace('x', '" x ') + '"');
    await setAttr(sku.id, 'thickness', item.thickness);
    await setAttr(sku.id, 'wear_layer', item.wear_layer);
    await setAttr(sku.id, 'finish', 'Ceramic Bead Enhanced Urethane');
    await setAttr(sku.id, 'brand', 'Vellichor');
    if (item.pattern) await setAttr(sku.id, 'pattern', item.pattern);

    console.log(`  ${sku.is_new ? '+' : '~'} ${item.collection} / ${productName} / ${item.sku}`);
  }

  // ==================== SPC Moldings ====================
  console.log('\n--- Importing SPC Moldings ---');
  const spcMoldingProduct = await upsertProduct(vendorId, {
    name: 'SPC Moldings',
    collection: 'SPC Accessories',
    category_id: CAT_MOLDING,
    description_short: 'Coordinating moldings for Vellichor SPC flooring',
  });
  if (spcMoldingProduct.is_new) productsCreated++; else productsUpdated++;

  for (const m of SPC_MOLDINGS) {
    const internalSku = `VELLICHOR-SPC-${m.sku_suffix}`;
    const sku = await upsertSku(spcMoldingProduct.id, {
      vendor_sku: `SPC-${m.sku_suffix}`,
      internal_sku: internalSku,
      variant_name: `${m.name}, ${m.length}`,
      sell_by: 'unit',
      variant_type: 'accessory',
    });
    if (sku.is_new) skusCreated++; else skusUpdated++;

    const retailPrice = +(m.cost * 2.0).toFixed(2);
    await upsertPricingUnit(sku.id, { cost: m.cost, retail_price: retailPrice });

    console.log(`  ${sku.is_new ? '+' : '~'} SPC ${m.name} / ${internalSku}`);
  }

  // ==================== Engineered Hardwood Products ====================
  console.log('\n--- Importing Engineered Hardwood products ---');
  for (const item of ENG_PRODUCTS) {
    const productName = item.name;
    const variantName = item.variant_suffix
      ? `${item.width} x ${item.thick}, ${item.variant_suffix}`
      : `${item.width} x ${item.thick}`;

    const product = await upsertProduct(vendorId, {
      name: productName,
      collection: item.collection,
      category_id: CAT_ENG,
      description_short: 'European Oak — Wire Brushed — UV Lacquer Finish',
    });
    if (product.is_new) productsCreated++; else productsUpdated++;

    const internalSku = `VELLICHOR-${item.sku}`;
    const sku = await upsertSku(product.id, {
      vendor_sku: item.sku,
      internal_sku: internalSku,
      variant_name: variantName,
      sell_by: 'sqft',
    });
    if (sku.is_new) skusCreated++; else skusUpdated++;

    const retailPrice = +(item.cost * 2.0).toFixed(2);
    await upsertPricing(sku.id, { cost: item.cost, retail_price: retailPrice });

    await upsertPackaging(sku.id, { sqft_per_box: item.sqft, boxes_per_pallet: item.boxes_pallet });

    await setAttr(sku.id, 'color', item.name);
    await setAttr(sku.id, 'material', 'Engineered Hardwood');
    await setAttr(sku.id, 'species', 'European Oak');
    await setAttr(sku.id, 'finish', 'Wire Brushed, UV Lacquer');
    await setAttr(sku.id, 'thickness', item.thick);
    await setAttr(sku.id, 'width', item.width);
    await setAttr(sku.id, 'wear_layer', '4mm');
    await setAttr(sku.id, 'brand', 'Vellichor');

    console.log(`  ${sku.is_new ? '+' : '~'} ${item.collection} / ${productName} / ${item.sku}`);
  }

  // ==================== Engineered Moldings ====================
  console.log('\n--- Importing Engineered Hardwood Moldings ---');
  const engMoldingProduct = await upsertProduct(vendorId, {
    name: 'Engineered Hardwood Moldings',
    collection: 'Engineered Accessories',
    category_id: CAT_MOLDING,
    description_short: 'Coordinating moldings for Vellichor engineered hardwood flooring',
  });
  if (engMoldingProduct.is_new) productsCreated++; else productsUpdated++;

  for (const m of ENG_MOLDINGS) {
    const internalSku = `VELLICHOR-ENG-${m.sku_suffix}`;
    const sku = await upsertSku(engMoldingProduct.id, {
      vendor_sku: `ENG-${m.sku_suffix}`,
      internal_sku: internalSku,
      variant_name: `${m.name}, ${m.length}`,
      sell_by: 'unit',
      variant_type: 'accessory',
    });
    if (sku.is_new) skusCreated++; else skusUpdated++;

    const retailPrice = +(m.cost * 2.0).toFixed(2);
    await upsertPricingUnit(sku.id, { cost: m.cost, retail_price: retailPrice });

    console.log(`  ${sku.is_new ? '+' : '~'} ENG ${m.name} / ${internalSku}`);
  }

  // ==================== Summary ====================
  console.log('\n=== Import Complete ===');
  console.log(`Products: ${productsCreated} created, ${productsUpdated} updated`);
  console.log(`SKUs:     ${skusCreated} created, ${skusUpdated} updated`);
  console.log('');

  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
