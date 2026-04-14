#!/usr/bin/env node

/**
 * Import Alaska Tile product data from price list PDF.
 * Source: Alaska Tile Price List Q4 2025
 * Website: https://alaskatileusa.com
 *
 * Sections:
 *   1. General Price List 2025 — individual porcelain tiles (various sizes/finishes)
 *   2. 2024 Collections Limited Stock — Medley, Fascino, Arena, Alpine, Essence, Blossom collections
 *   3. Decor & Specialty — Ola Azul, Fuji Blue, Fabric tiles, Mosaic sheets
 *
 * Pricing strategy:
 *   - cost = Pallet Price (volume wholesale)
 *   - retail = Job Pack Price * 2.0 markup
 *   - Most tiles sold per sqft, mosaics/decor per piece/sheet
 *
 * Usage: docker compose exec api node scripts/import-alaska-tile.js
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
const CAT_PORCELAIN = '650e8400-e29b-41d4-a716-446655440012'; // Porcelain Tile
const CAT_MOSAIC    = '650e8400-e29b-41d4-a716-446655440014'; // Mosaic Tile
const CAT_BACKSPLASH = '650e8400-e29b-41d4-a716-446655440050'; // Backsplash & Wall Tile

// ==================== GENERAL PRICE LIST 2025 ====================
// [name, finish, size, skuCode, costPerSqft (pallet), jobPackPrice, sqftPerBox, pcsPerBox, boxesPerPallet, sellBy, priceBasis]
// For per-piece items: costPerSqft = cost per piece, sellBy = 'unit', priceBasis = 'per_unit'

const GENERAL_TILES = [
  // Calacatta Gold 24x48
  ['Calacatta Gold', 'Polish',  '24"x48"', 'PM126602QA1-P', 2.69, 3.29, 16, 2, 30, 'sqft', 'per_sqft'],
  ['Calacatta Gold', 'Matte',   '24"x48"', 'PM126602QA1-M', 2.59, 3.19, 16, 2, 30, 'sqft', 'per_sqft'],
  // Calacatta Gold Hex Mosaic
  ['Calacatta Gold Hex Mosaic', 'Polish', '3.5" Hexagon', 'PM126602QA1-HEX', 8.50, 9.80, null, null, null, 'unit', 'per_unit'],
  // Della Statuario Light 24x48
  ['Della Statuario Light', 'Polish', '24"x48"', 'DELLA-SL-P', 1.99, 2.49, 16, 2, 34, 'sqft', 'per_sqft'],
  ['Della Statuario Light', 'Matte',  '24"x48"', 'DELLA-SL-M', 1.99, 2.49, 16, 2, 34, 'sqft', 'per_sqft'],
  // Della Statuario Light Hex Mosaic
  ['Della Statuario Light Hex Mosaic', 'Polish', '3.5" Hexagon', 'DELLA-SL-HEX', 8.50, 9.80, null, null, null, 'unit', 'per_unit'],
  // Lims Stone White
  ['Lims Stone White', 'Matte', '24"x48"', 'LIMS-SW-M', 2.99, 3.29, 16, 2, 30, 'sqft', 'per_sqft'],
  // Sandstone
  ['Sandstone', 'Matte', '24"x48"', 'SANDSTONE-M', 2.99, 3.29, 16, 2, 30, 'sqft', 'per_sqft'],
  // Calacatta Gold 12x24
  ['Calacatta Gold', 'Polish', '12"x24"', 'CALCGOLD-12x24-P', 2.29, 2.69, 16, 8, 40, 'sqft', 'per_sqft'],
  ['Calacatta Gold', 'Matte',  '12"x24"', 'CALCGOLD-12x24-M', 2.29, 2.69, 16, 8, 40, 'sqft', 'per_sqft'],
  // Damore Blanco Grey
  ['Damore Blanco Grey', 'Polish', '24"x48"', 'DAMORE-BG-P', 2.49, 2.79, 16, 2, 34, 'sqft', 'per_sqft'],
  // Pacific Onyx Crema
  ['Pacific Onyx Crema', 'Polish', '24"x48"', 'PONYX-C-P', 2.49, 2.79, 16, 2, 34, 'sqft', 'per_sqft'],
  // Blue Gold Onyx
  ['Blue Gold Onyx', 'Polish', '24"x48"', 'BGONYX-P', 3.99, 4.49, 16, 2, 34, 'sqft', 'per_sqft'],
  // Sky Gold Onyx
  ['Sky Gold Onyx', 'Polish', '24"x48"', 'SGONYX-P', 3.99, 4.49, 16, 2, 34, 'sqft', 'per_sqft'],
];

// ==================== 2024 COLLECTIONS — LIMITED STOCK ====================
// Collections have shared pricing by size; individual designs are listed separately.
// Packing detail from PDF page 6:
//   12x24: 8 pcs/box, 16 sqft/box, 640 sqft/pallet (40 boxes)
//   24x24: 4 pcs/box, 16 sqft/box, 544 sqft/pallet (34 boxes)
//   24x48: 2 pcs/box, 16 sqft/box, 544 sqft/pallet (34 boxes)

// Fascino Collection — 13 designs, available in 12x24 / 24x24 / 24x48
const FASCINO_DESIGNS = [
  'Amaretto Grey', 'Amaretto Silver', 'Armani Harbor Grey', 'Armani Harbor Silver',
  'Effco Statuario', 'Smoke Statuario', 'Bleforis Black', 'Invisible Grey',
  'Carrara Grace', 'Picasso Grey', 'Lasa White', 'Thassos White', 'Emperador Grey',
];

// Medley Collection — 7 designs, available in 12x24 / 24x24 / 24x48
const MEDLEY_DESIGNS = [
  'Imperial Crema', 'Botochino Harmony', 'Calacatta Luxe', 'Onyx Puls',
  'Statuario Nova', 'Angel Statuario', 'Regal Statuario',
];

// Arena Collection — 6 designs, available in 12x24 / 24x24 / 24x48
const ARENA_DESIGNS = [
  'Arena Chiaro', 'Arena Medio', 'Arena Scuro',
  'Arena Grigio Chiaro', 'Arena Grigio Medio', 'Arena Grigio Scuro',
];

// Alpine Collection — 4 designs, 24x48 Punch Matt only
const ALPINE_DESIGNS = [
  'Alpine Tan', 'Alpine Seal', 'Alpine Thunder', 'Alpine Charcoal',
];

// Essence Collection — 4 designs, 24x48 Pro Matt
const ESSENCE_DESIGNS = [
  'Essence Beige', 'Essence Grigio', 'Essence Crest Beige', 'Essence Crest Grigio',
];

// Blossom Collection — regular colors (24x48 Pro Matt) + Florals (24x48, box pricing) + Decor
const BLOSSOM_REGULAR = [
  'Blossom Crema', 'Blossom Mustard', 'Blossom Ash', 'Blossom Silver',
  'Blossom Fossil', 'Blossom Salmon', 'Blossom Berry', 'Blossom Mint',
];
const BLOSSOM_FLORAL = [
  'Blossom Floral 1', 'Blossom Floral 2', 'Blossom Floral 3',
  'Blossom Floral 4', 'Blossom Floral 5',
];

// Collection pricing tiers (palletPrice / jobPackPrice per sqft)
// From PDF page 5: Medley/Fascino/Arena sizes: $2.99(pallet) / $3.29(job pack) per sqft
const COLLECTION_SIZES = {
  standard3:  [ // Available in 3 sizes
    { size: '12"x24"', pcsPerBox: 8, sqftPerBox: 16, boxesPerPallet: 40, finish: 'Matte' },
    { size: '24"x24"', pcsPerBox: 4, sqftPerBox: 16, boxesPerPallet: 34, finish: 'Matte' },
    { size: '24"x48"', pcsPerBox: 2, sqftPerBox: 16, boxesPerPallet: 34, finish: 'Matte' },
  ],
  single2448: [ // 24x48 only
    { size: '24"x48"', pcsPerBox: 2, sqftPerBox: 16, boxesPerPallet: 34, finish: null },
  ],
};

// ==================== DECOR & SPECIALTY ====================
// Ola Azul & Fuji Blue — 8x8 sold per piece
const DECOR_8X8 = [
  ['Ola Azul', '8"x8"', 'DECOR-OLAAZUL', 1.99, 2.49],
  ['Fuji Blue', '8"x8"', 'DECOR-FUJIBLUE', 1.99, 2.49],
];
// Fabric series — 3x12 sold per piece
const FABRIC_DESIGNS = [
  ['Fabric Sand',  '3"x12"', 'FABRIC-SAND',  1.79, 2.29],
  ['Fabric Grey',  '3"x12"', 'FABRIC-GREY',  1.79, 2.29],
  ['Fabric Ivory', '3"x12"', 'FABRIC-IVORY', 1.79, 2.29],
];

// Mosaic tiles — sold per sheet
const MOSAIC_TILES = [
  ['Penny Mosaic', 'Penny Round', 'MOSAIC-PENNY', 7.50, 8.50],
  ['Hexagon Mosaic', 'Hexagon', 'MOSAIC-HEX', 7.50, 8.50],
  ['Design Mosaic', 'Square', 'MOSAIC-DESIGN', 7.50, 8.50],
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

async function upsertPackaging(sku_id, { sqft_per_box, pieces_per_box, boxes_per_pallet }) {
  await pool.query(`
    INSERT INTO packaging (sku_id, sqft_per_box, pieces_per_box, boxes_per_pallet)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (sku_id) DO UPDATE SET
      sqft_per_box = COALESCE(EXCLUDED.sqft_per_box, packaging.sqft_per_box),
      pieces_per_box = COALESCE(EXCLUDED.pieces_per_box, packaging.pieces_per_box),
      boxes_per_pallet = COALESCE(EXCLUDED.boxes_per_pallet, packaging.boxes_per_pallet)
  `, [sku_id, sqft_per_box || null, pieces_per_box || null, boxes_per_pallet || null]);
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

function makeInternalSku(code) {
  return `ALASKATILE-${code}`;
}

function slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

// ==================== Main ====================

async function main() {
  // Ensure vendor exists
  let vendorRes = await pool.query("SELECT id FROM vendors WHERE code = 'ALASKATILE'");
  let vendorId;
  if (!vendorRes.rows.length) {
    const ins = await pool.query(`
      INSERT INTO vendors (name, code, website, email)
      VALUES ('Alaska Tile', 'ALASKATILE', 'https://alaskatileusa.com', 'alaskatilesusa@gmail.com')
      RETURNING id
    `);
    vendorId = ins.rows[0].id;
    console.log(`Created vendor: Alaska Tile (${vendorId})`);
  } else {
    vendorId = vendorRes.rows[0].id;
    console.log(`Using existing vendor: Alaska Tile (${vendorId})`);
  }

  let productsCreated = 0, productsUpdated = 0;
  let skusCreated = 0, skusUpdated = 0;

  // ==================== 1. General Price List tiles ====================
  console.log('\n=== Importing General Price List 2025 ===');

  // Group tiles by product name (some have multiple sizes/finishes)
  const generalByProduct = new Map();
  for (const t of GENERAL_TILES) {
    const [name] = t;
    if (!generalByProduct.has(name)) generalByProduct.set(name, []);
    generalByProduct.get(name).push(t);
  }

  for (const [productName, tiles] of generalByProduct) {
    const firstTile = tiles[0];
    const isMosaic = productName.includes('Mosaic');
    const catId = isMosaic ? CAT_MOSAIC : CAT_PORCELAIN;

    const prod = await upsertProduct(vendorId, {
      name: productName,
      collection: 'General',
      category_id: catId,
      description_short: `${productName} Porcelain Tile`,
    });
    if (prod.is_new) productsCreated++; else productsUpdated++;

    for (const [name, finish, size, skuCode, palletPrice, jobPackPrice, sqftPerBox, pcsPerBox, boxesPerPallet, sellBy, priceBasis] of tiles) {
      const variantName = tiles.length > 1 ? `${size} ${finish}` : finish;
      const sku = await upsertSku(prod.id, {
        vendor_sku: skuCode,
        internal_sku: makeInternalSku(skuCode),
        variant_name: variantName,
        sell_by: sellBy,
      });
      if (sku.is_new) skusCreated++; else skusUpdated++;

      // cost = pallet price, retail = job pack * 2.0
      await upsertPricing(sku.id, {
        cost: palletPrice,
        retail_price: (jobPackPrice * 2.0).toFixed(2),
        price_basis: priceBasis,
      });

      if (sqftPerBox) {
        await upsertPackaging(sku.id, { sqft_per_box: sqftPerBox, pieces_per_box: pcsPerBox, boxes_per_pallet: boxesPerPallet });
      }

      await setAttr(sku.id, 'material', 'Porcelain');
      await setAttr(sku.id, 'finish', finish);
      await setAttr(sku.id, 'size', size);
      await setAttr(sku.id, 'collection', 'General');
    }
    console.log(`  ${prod.is_new ? '+' : '~'} ${productName} (${tiles.length} SKU${tiles.length > 1 ? 's' : ''})`);
  }

  // ==================== 2. Fascino Collection ====================
  console.log('\n=== Importing Fascino Collection ===');
  for (const design of FASCINO_DESIGNS) {
    const prod = await upsertProduct(vendorId, {
      name: design,
      collection: 'Fascino',
      category_id: CAT_PORCELAIN,
      description_short: `${design} — Fascino Collection Porcelain Tile`,
    });
    if (prod.is_new) productsCreated++; else productsUpdated++;

    for (const sz of COLLECTION_SIZES.standard3) {
      const skuCode = `FASC-${slugify(design)}-${sz.size.replace(/"/g, '').replace('x', 'X')}`;
      const sku = await upsertSku(prod.id, {
        vendor_sku: skuCode,
        internal_sku: makeInternalSku(skuCode),
        variant_name: `${sz.size} ${sz.finish}`,
        sell_by: 'sqft',
      });
      if (sku.is_new) skusCreated++; else skusUpdated++;

      await upsertPricing(sku.id, { cost: 2.99, retail_price: (3.29 * 2.0).toFixed(2), price_basis: 'per_sqft' });
      await upsertPackaging(sku.id, { sqft_per_box: sz.sqftPerBox, pieces_per_box: sz.pcsPerBox, boxes_per_pallet: sz.boxesPerPallet });

      await setAttr(sku.id, 'material', 'Porcelain');
      await setAttr(sku.id, 'finish', sz.finish);
      await setAttr(sku.id, 'size', sz.size);
      await setAttr(sku.id, 'collection', 'Fascino');
    }
    console.log(`  + ${design} (3 sizes)`);
  }

  // ==================== 3. Medley Collection ====================
  console.log('\n=== Importing Medley Collection ===');
  for (const design of MEDLEY_DESIGNS) {
    const prod = await upsertProduct(vendorId, {
      name: design,
      collection: 'Medley',
      category_id: CAT_PORCELAIN,
      description_short: `${design} — Medley Collection Porcelain Tile`,
    });
    if (prod.is_new) productsCreated++; else productsUpdated++;

    for (const sz of COLLECTION_SIZES.standard3) {
      const skuCode = `MEDL-${slugify(design)}-${sz.size.replace(/"/g, '').replace('x', 'X')}`;
      const sku = await upsertSku(prod.id, {
        vendor_sku: skuCode,
        internal_sku: makeInternalSku(skuCode),
        variant_name: `${sz.size} ${sz.finish}`,
        sell_by: 'sqft',
      });
      if (sku.is_new) skusCreated++; else skusUpdated++;

      await upsertPricing(sku.id, { cost: 2.99, retail_price: (3.29 * 2.0).toFixed(2), price_basis: 'per_sqft' });
      await upsertPackaging(sku.id, { sqft_per_box: sz.sqftPerBox, pieces_per_box: sz.pcsPerBox, boxes_per_pallet: sz.boxesPerPallet });

      await setAttr(sku.id, 'material', 'Porcelain');
      await setAttr(sku.id, 'finish', sz.finish);
      await setAttr(sku.id, 'size', sz.size);
      await setAttr(sku.id, 'collection', 'Medley');
    }
    console.log(`  + ${design} (3 sizes)`);
  }

  // ==================== 4. Arena Collection ====================
  console.log('\n=== Importing Arena Collection ===');
  for (const design of ARENA_DESIGNS) {
    const prod = await upsertProduct(vendorId, {
      name: design,
      collection: 'Arena',
      category_id: CAT_PORCELAIN,
      description_short: `${design} — Arena Collection Porcelain Tile`,
    });
    if (prod.is_new) productsCreated++; else productsUpdated++;

    for (const sz of COLLECTION_SIZES.standard3) {
      const skuCode = `AREN-${slugify(design)}-${sz.size.replace(/"/g, '').replace('x', 'X')}`;
      const sku = await upsertSku(prod.id, {
        vendor_sku: skuCode,
        internal_sku: makeInternalSku(skuCode),
        variant_name: `${sz.size} ${sz.finish}`,
        sell_by: 'sqft',
      });
      if (sku.is_new) skusCreated++; else skusUpdated++;

      await upsertPricing(sku.id, { cost: 2.99, retail_price: (3.29 * 2.0).toFixed(2), price_basis: 'per_sqft' });
      await upsertPackaging(sku.id, { sqft_per_box: sz.sqftPerBox, pieces_per_box: sz.pcsPerBox, boxes_per_pallet: sz.boxesPerPallet });

      await setAttr(sku.id, 'material', 'Porcelain');
      await setAttr(sku.id, 'finish', sz.finish);
      await setAttr(sku.id, 'size', sz.size);
      await setAttr(sku.id, 'collection', 'Arena');
    }
    console.log(`  + ${design} (3 sizes)`);
  }

  // ==================== 5. Alpine Collection ====================
  console.log('\n=== Importing Alpine Collection ===');
  for (const design of ALPINE_DESIGNS) {
    const prod = await upsertProduct(vendorId, {
      name: design,
      collection: 'Alpine',
      category_id: CAT_PORCELAIN,
      description_short: `${design} — Alpine Collection Porcelain Tile`,
    });
    if (prod.is_new) productsCreated++; else productsUpdated++;

    const skuCode = `ALPN-${slugify(design)}-24X48`;
    const sku = await upsertSku(prod.id, {
      vendor_sku: skuCode,
      internal_sku: makeInternalSku(skuCode),
      variant_name: '24"x48" Punch Matt',
      sell_by: 'sqft',
    });
    if (sku.is_new) skusCreated++; else skusUpdated++;

    await upsertPricing(sku.id, { cost: 2.99, retail_price: (3.29 * 2.0).toFixed(2), price_basis: 'per_sqft' });
    await upsertPackaging(sku.id, { sqft_per_box: 16, pieces_per_box: 2, boxes_per_pallet: 34 });

    await setAttr(sku.id, 'material', 'Porcelain');
    await setAttr(sku.id, 'finish', 'Punch Matt');
    await setAttr(sku.id, 'size', '24"x48"');
    await setAttr(sku.id, 'collection', 'Alpine');
    console.log(`  + ${design}`);
  }

  // ==================== 6. Essence Collection ====================
  console.log('\n=== Importing Essence Collection ===');
  // Essence and Essence Crest have different pricing
  for (const design of ESSENCE_DESIGNS) {
    const isCrest = design.includes('Crest');
    const prod = await upsertProduct(vendorId, {
      name: design,
      collection: 'Essence',
      category_id: CAT_PORCELAIN,
      description_short: `${design} — Essence Collection Porcelain Tile`,
    });
    if (prod.is_new) productsCreated++; else productsUpdated++;

    const skuCode = `ESSN-${slugify(design)}-24X48`;
    const sku = await upsertSku(prod.id, {
      vendor_sku: skuCode,
      internal_sku: makeInternalSku(skuCode),
      variant_name: '24"x48" Pro Matt',
      sell_by: 'sqft',
    });
    if (sku.is_new) skusCreated++; else skusUpdated++;

    // Essence Crest: $2.99 pallet / $3.49 job pack; regular: $2.99 / $3.29
    const jobPack = isCrest ? 3.49 : 3.29;
    await upsertPricing(sku.id, { cost: 2.99, retail_price: (jobPack * 2.0).toFixed(2), price_basis: 'per_sqft' });
    await upsertPackaging(sku.id, { sqft_per_box: 16, pieces_per_box: 2, boxes_per_pallet: 34 });

    await setAttr(sku.id, 'material', 'Porcelain');
    await setAttr(sku.id, 'finish', 'Pro Matt');
    await setAttr(sku.id, 'size', '24"x48"');
    await setAttr(sku.id, 'collection', 'Essence');
    console.log(`  + ${design}`);
  }

  // ==================== 7. Blossom Collection ====================
  console.log('\n=== Importing Blossom Collection ===');
  // Regular Blossom — 24x48 Pro Matt, $2.99/$3.29
  for (const design of BLOSSOM_REGULAR) {
    const prod = await upsertProduct(vendorId, {
      name: design,
      collection: 'Blossom',
      category_id: CAT_PORCELAIN,
      description_short: `${design} — Blossom Collection Porcelain Tile`,
    });
    if (prod.is_new) productsCreated++; else productsUpdated++;

    const skuCode = `BLSM-${slugify(design)}-24X48`;
    const sku = await upsertSku(prod.id, {
      vendor_sku: skuCode,
      internal_sku: makeInternalSku(skuCode),
      variant_name: '24"x48" Pro Matt',
      sell_by: 'sqft',
    });
    if (sku.is_new) skusCreated++; else skusUpdated++;

    await upsertPricing(sku.id, { cost: 2.99, retail_price: (3.29 * 2.0).toFixed(2), price_basis: 'per_sqft' });
    await upsertPackaging(sku.id, { sqft_per_box: 16, pieces_per_box: 2, boxes_per_pallet: 34 });

    await setAttr(sku.id, 'material', 'Porcelain');
    await setAttr(sku.id, 'finish', 'Pro Matt');
    await setAttr(sku.id, 'size', '24"x48"');
    await setAttr(sku.id, 'collection', 'Blossom');
    console.log(`  + ${design}`);
  }

  // Blossom Floral — 24x48, sold per box ($90 pallet / $100 job pack per box)
  // Convert to per-sqft: $90/16sqft = $5.625/sqft cost
  for (const design of BLOSSOM_FLORAL) {
    const prod = await upsertProduct(vendorId, {
      name: design,
      collection: 'Blossom',
      category_id: CAT_PORCELAIN,
      description_short: `${design} — Blossom Collection Decorative Porcelain Tile`,
    });
    if (prod.is_new) productsCreated++; else productsUpdated++;

    const skuCode = `BLSM-${slugify(design)}-24X48`;
    const sku = await upsertSku(prod.id, {
      vendor_sku: skuCode,
      internal_sku: makeInternalSku(skuCode),
      variant_name: '24"x48" Pro Matt',
      sell_by: 'sqft',
    });
    if (sku.is_new) skusCreated++; else skusUpdated++;

    // $90/box pallet price = $5.625/sqft; $100/box job pack = $6.25/sqft
    await upsertPricing(sku.id, { cost: 5.63, retail_price: (6.25 * 2.0).toFixed(2), price_basis: 'per_sqft' });
    await upsertPackaging(sku.id, { sqft_per_box: 16, pieces_per_box: 2, boxes_per_pallet: 34 });

    await setAttr(sku.id, 'material', 'Porcelain');
    await setAttr(sku.id, 'finish', 'Pro Matt');
    await setAttr(sku.id, 'size', '24"x48"');
    await setAttr(sku.id, 'collection', 'Blossom');
    await setAttr(sku.id, 'pattern', 'Floral');
    console.log(`  + ${design}`);
  }

  // ==================== 8. Porcelain Tiles (thin 5mm) ====================
  console.log('\n=== Importing Thin Porcelain Tiles ===');
  // From the collections listing — these appear to be the Blossom/Essence in thin format
  // PDF lists "Porcelain Tiles Matt 24x48-5mm" at $2.49 pallet / $2.99 job pack
  // These are the thin-format versions of the collections
  // We'll skip creating separate products since they'd duplicate collection designs
  // unless there are distinct thin-only items. The PDF doesn't list specific design names for thin.

  // ==================== 9. Decor Items ====================
  console.log('\n=== Importing Decor Items ===');
  for (const [name, size, skuCode, palletPrice, jobPackPrice] of DECOR_8X8) {
    const prod = await upsertProduct(vendorId, {
      name,
      collection: 'Decor',
      category_id: CAT_BACKSPLASH,
      description_short: `${name} — Decorative Porcelain Tile`,
    });
    if (prod.is_new) productsCreated++; else productsUpdated++;

    const sku = await upsertSku(prod.id, {
      vendor_sku: skuCode,
      internal_sku: makeInternalSku(skuCode),
      variant_name: size,
      sell_by: 'unit',
    });
    if (sku.is_new) skusCreated++; else skusUpdated++;

    await upsertPricing(sku.id, { cost: palletPrice, retail_price: (jobPackPrice * 2.0).toFixed(2), price_basis: 'per_unit' });
    await setAttr(sku.id, 'material', 'Porcelain');
    await setAttr(sku.id, 'size', size);
    await setAttr(sku.id, 'collection', 'Decor');
    console.log(`  + ${name}`);
  }

  // Fabric series
  for (const [name, size, skuCode, palletPrice, jobPackPrice] of FABRIC_DESIGNS) {
    const prod = await upsertProduct(vendorId, {
      name,
      collection: 'Fabric',
      category_id: CAT_BACKSPLASH,
      description_short: `${name} — Fabric Collection Porcelain Tile`,
    });
    if (prod.is_new) productsCreated++; else productsUpdated++;

    const sku = await upsertSku(prod.id, {
      vendor_sku: skuCode,
      internal_sku: makeInternalSku(skuCode),
      variant_name: size,
      sell_by: 'unit',
    });
    if (sku.is_new) skusCreated++; else skusUpdated++;

    await upsertPricing(sku.id, { cost: palletPrice, retail_price: (jobPackPrice * 2.0).toFixed(2), price_basis: 'per_unit' });
    await setAttr(sku.id, 'material', 'Porcelain');
    await setAttr(sku.id, 'finish', 'Matte');
    await setAttr(sku.id, 'size', size);
    await setAttr(sku.id, 'collection', 'Fabric');
    console.log(`  + ${name}`);
  }

  // ==================== 10. Mosaic Tiles ====================
  console.log('\n=== Importing Mosaic Tiles ===');
  for (const [name, shape, skuCode, palletPrice, jobPackPrice] of MOSAIC_TILES) {
    const prod = await upsertProduct(vendorId, {
      name,
      collection: 'Mosaic',
      category_id: CAT_MOSAIC,
      description_short: `${name} — ${shape} Mosaic Tile Sheet`,
    });
    if (prod.is_new) productsCreated++; else productsUpdated++;

    const sku = await upsertSku(prod.id, {
      vendor_sku: skuCode,
      internal_sku: makeInternalSku(skuCode),
      variant_name: shape,
      sell_by: 'unit',
    });
    if (sku.is_new) skusCreated++; else skusUpdated++;

    await upsertPricing(sku.id, { cost: palletPrice, retail_price: (jobPackPrice * 2.0).toFixed(2), price_basis: 'per_unit' });
    await setAttr(sku.id, 'material', 'Porcelain');
    await setAttr(sku.id, 'size', shape);
    await setAttr(sku.id, 'collection', 'Mosaic');
    console.log(`  + ${name}`);
  }

  // ==================== Summary ====================
  console.log('\n=== Import Complete ===');
  console.log(`Products: ${productsCreated} created, ${productsUpdated} updated`);
  console.log(`SKUs: ${skusCreated} created, ${skusUpdated} updated`);

  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
