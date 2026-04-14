#!/usr/bin/env node

/**
 * Import Bellezza Ceramica product data from JAN 2026 Dealer Price List.
 *
 * ~88 products, ~170 SKUs across:
 *   Porcelain Tile, Ceramic Wall Tile, Glass Mosaic, Porcelain Mosaic,
 *   Subway / Artisan Tile, Trim Accessories, Wall Panels
 *
 * Pricing: Excel lists dealer cost. Retail = cost × 2.5 (standard tile markup).
 * Most tiles sold per sqft. Mosaics sold per sheet. Trim/accessories per piece.
 *
 * Usage: docker compose exec api node scripts/import-bellezza.js
 */

import pg from 'pg';

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: 5432,
  database: 'flooring_pim',
  user: 'postgres',
  password: 'postgres',
});

const RETAIL_MARKUP = 2.5;

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

async function upsertPackaging(sku_id, pkg) {
  await pool.query(`
    INSERT INTO packaging (sku_id, sqft_per_box, pieces_per_box, boxes_per_pallet, sqft_per_pallet)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (sku_id) DO UPDATE SET
      sqft_per_box = COALESCE(EXCLUDED.sqft_per_box, packaging.sqft_per_box),
      pieces_per_box = COALESCE(EXCLUDED.pieces_per_box, packaging.pieces_per_box),
      boxes_per_pallet = COALESCE(EXCLUDED.boxes_per_pallet, packaging.boxes_per_pallet),
      sqft_per_pallet = COALESCE(EXCLUDED.sqft_per_pallet, packaging.sqft_per_pallet)
  `, [sku_id, pkg.sqft_per_box || null, pkg.pieces_per_box || null, pkg.boxes_per_pallet || null, pkg.sqft_per_pallet || null]);
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

// ==================== Product Data ====================
// Each product: { name, desc?, material, origin, colors?, disc?, skus }
// Each SKU: [rowNum, variantName, size, finish, price, sqftPc, pcsBox, sqftBox, um?]
//   rowNum = spreadsheet row (used as vendor_sku: R{num})
//   um: 'SF' (default, per sqft), 'SH' (per sheet/unit), 'PC' (per piece/accessory)

const PRODUCTS = [
  // ── PORCELAIN & CERAMIC TILES (pp. 3–7) ─────────────────────────

  { name: 'Anima Antracita', material: 'Porcelain', origin: 'Spain', disc: true,
    skus: [[103,'Polished 24x48','24x48','Polished',2.29,7.75,2,15.5]] },

  { name: 'Arena Chiaro', material: 'Porcelain', origin: 'India',
    skus: [
      [104,'24x48','24x48',null,3.99,8,2,16],
      [105,'Mosaic 2x2','2x2',null,6.99,null,7,null,'SH'],
    ] },

  { name: 'Arhus', material: 'Porcelain', origin: 'Spain', disc: true,
    colors: ['Gris','Tabaco'],
    skus: [[106,'9.19x47.2','9.19x47.2',null,1.95,3,4,12.05]] },

  { name: 'Armani White', material: 'Porcelain', origin: 'India', disc: true,
    skus: [[107,'Polished 24x24','24x24','Polished',1.99,4,4,15.5]] },

  { name: 'Angelo Silk Shimmer', material: 'Porcelain', origin: 'Spain',
    colors: ['Silver','Gold'],
    skus: [
      [108,'24x24','24x24',null,2.99,4,3,12],
      [109,'24x48','24x48',null,3.99,7.75,2,15.49],
    ] },

  { name: 'Austral Blanco', material: 'Ceramic', origin: 'Spain', disc: true,
    desc: 'Glossy Wall Tile',
    skus: [[110,'Glossy Wall 15.55x46.92','15.55x46.92','Glossy',1.99,5.078,5,25.39]] },

  { name: 'Austral Essence Blanco', material: 'Ceramic', origin: 'Spain',
    skus: [[111,'12.44x39.37','12.44x39.37',null,3.99,3.4,5,17]] },

  { name: 'Bolonia Marengo', material: 'Porcelain', origin: 'Spain', disc: true,
    skus: [[112,'Polished 24x24','24x24','Polished',3.99,3.87,4,15.49]] },

  { name: 'Calaca Gold', material: 'Porcelain', origin: 'Spain',
    desc: 'Deco Top Matte Tile',
    skus: [[113,'Deco Top Matte 15.75x47.24','15.75x47.24','Matte',3.91,5.16,3,15.49]] },

  { name: 'Calacatta Gold', material: 'Porcelain', origin: 'Spain',
    skus: [
      [114,'Lux Semi-Polished 24x48','24x48','Semi-Polished',2.29,7.745,2,15.49],
      [115,'Matte 15.75x47.24','15.75x47.24','Matte',2.29,5.16,3,15.49],
    ] },

  { name: 'Calacatta Gloss', material: 'Ceramic', origin: 'Spain',
    desc: 'Polished Wall Tile',
    skus: [
      [116,'Polished Wall 12.8x23.6','12.8x23.6','Polished',2.29,2.1,6,12.6],
      [117,'Polished Wall 12.45x35.46','12.45x35.46','Polished',2.29,3.04,4,12.16],
    ] },

  { name: 'Calacatta Hex Gloss', material: 'Ceramic', origin: 'Spain',
    desc: 'Polished Wall Tile',
    skus: [[118,'Polished Wall 12.45x35.46','12.45x35.46','Polished',2.29,3.04,4,12.16]] },

  { name: 'Calacatta Natural', material: 'Porcelain', origin: 'Spain',
    skus: [
      [119,'Polished 17.1x46.5','17.1x46.5','Polished',4.49,11.3,2,11.3],
      [120,'Polished 35.4x35.4','35.4x35.4','Polished',3.99,8.7,1,8.7],
      [121,'Matte 24x48','24x48','Matte',4.89,7.7,2,15.39],
      [122,'Polished 24x48','24x48','Polished',4.99,7.7,2,15.39],
      [306,'Polished Mosaic 3x3','3x3','Polished',11.99,null,null,null,'SH'],
    ] },

  { name: 'Calacatta Brick Gloss', material: 'Ceramic', origin: 'Spain',
    desc: 'Wall Tile',
    skus: [[123,'Wall 12.8x23.6','12.8x23.6','Glossy',1.99,2.1,6,12.6]] },

  { name: 'Calcutta Gold', material: 'Porcelain', origin: 'USA',
    skus: [[124,'Matte 24x48','24x48','Matte',2.29,7.75,2,15.5]] },

  { name: 'Ceppo', material: 'Porcelain', origin: 'Italy', disc: true,
    desc: 'Full Body Porcelain Tile',
    skus: [
      [128,'Nero REG 24x24','24x24','Matte',4.99,3.876,3,11.63],
      [129,'Grigio/Nero R11 24x24','24x24','R11',4.99,3.876,3,11.63],
      [293,'R11 Sabbia Mosaic 2x2','2x2','R11',9.99,null,null,null,'SH'],
    ] },

  { name: 'Chamonix', material: 'Porcelain', origin: 'USA', disc: true,
    desc: 'Color Body Porcelain',
    colors: ['Beige','Gray','Dark Gray','Ocean'],
    skus: [
      [130,'12x24','12x24',null,1.95,2,8,15.5],
      [131,'24x48','24x48',null,2.29,7.75,2,15.5],
      [132,'Dark Gray Brick Mosaic','12x24',null,22.00,null,null,null,'SH'],
      [294,'Beige Mosaic 2x2','2x2',null,9.99,null,null,null,'SH'],
    ] },

  { name: 'Concretus', material: 'Porcelain', origin: 'Taiwan',
    colors: ['Dark','Light'],
    skus: [
      [133,'Matte 12x24','12x24','Matte',2.99,2,8,16],
      [134,'Matte 36x36','36x36','Matte',4.79,8.69,2,17.38],
    ] },

  { name: 'Connor Beige', material: 'Porcelain', origin: 'Poland',
    skus: [[135,'24x48','24x48',null,3.69,7.69,2,15.39]] },

  { name: 'District', material: 'Porcelain', origin: 'Spain', disc: true,
    colors: ['Denim Calma','Sabbia Calma','Taupe Calma'],
    skus: [[136,'9.88x29.5','9.88x29.5',null,1.99,2,7,14.2]] },

  { name: 'Docks', material: 'Porcelain', origin: 'Italy',
    colors: ['Beige','White'],
    desc: 'Available in R10 & R11 finish',
    skus: [[137,'24x48','24x48','R10/R11',5.34,7.75,2,15.5]] },

  { name: 'Dolomite', material: 'Porcelain', origin: 'Spain',
    skus: [
      [138,'Polished 12x24','12x24','Polished',3.73,1.94,6,11.62],
      [139,'Polished 24x48','24x48','Polished',4.80,7.75,2,15.49],
      [140,'Matte 12x24','12x24','Matte',3.49,1.94,6,11.62],
      [141,'Matte 24x24','24x24','Matte',3.49,4,4,15.49],
      [142,'Matte 24x48','24x48','Matte',4.39,7.75,2,15.49],
      [296,'Matte Mosaic 2x2','2x2','Matte',9.99,null,null,null,'SH'],
    ] },

  { name: 'Emporio Calacatta', material: 'Porcelain', origin: 'Spain',
    skus: [
      [143,'Matte 12x24','12x24','Matte',3.49,1.94,6,11.62],
      [144,'Matte 24x48','24x48','Matte',4.49,7.75,2,15.49],
      [145,'Polished 12x24','12x24','Polished',3.73,1.94,6,11.62],
      [146,'Polished 24x48','24x48','Polished',4.99,7.75,2,15.49],
      [147,'Polished 48x48','48x48','Polished',5.99,15.5,1,15.5],
      [297,'Matte Mosaic 2x2','2x2','Matte',9.99,null,null,null,'SH'],
    ] },

  { name: 'Elegance Marble Pearl', material: 'Porcelain', origin: 'Spain',
    skus: [[148,'Matte 24x24','24x24','Matte',2.99,3.87,4,15.49]] },

  { name: 'Enigma White', material: 'Ceramic', origin: 'Spain', disc: true,
    desc: 'Matte Wall Tile',
    skus: [[151,'Matte Wall 15.55x46.92','15.55x46.92','Matte',1.99,5.085,4,20.34]] },

  { name: 'Epoque', material: 'Porcelain', origin: 'Italy',
    colors: ['White'],
    skus: [[152,'White 24x48','24x48',null,5.99,8,2,16]] },

  { name: 'Fry', material: 'Porcelain', origin: 'Italy', disc: true,
    colors: ['Grigio','Nero'],
    skus: [
      [153,'12x24','12x24',null,1.95,2,7,14],
      [298,'Bianco Mosaic 2x2','2x2',null,9.99,null,null,null,'SH'],
      [299,'Grigio Mosaic 2x2','2x2',null,9.99,null,null,null,'SH'],
    ] },

  { name: 'Granby Beige', material: 'Porcelain', origin: 'Poland',
    skus: [[154,'12x24','12x24',null,2.89,2,8,16]] },

  { name: 'Grunge', material: 'Porcelain', origin: 'Italy',
    colors: ['Beige','Multi','Smoke'],
    skus: [[155,'Matte 24x48','24x48','Matte',3.81,8,2,16]] },

  { name: 'Harley Lux', material: 'Porcelain', origin: 'Spain',
    colors: ['Black','Graphite','Super White'],
    skus: [
      [156,'12x24','12x24',null,3.99,2,6,12],
      [157,'18x36','18x36',null,4.99,4.5,3,13.5],
    ] },

  { name: 'Ibiza', material: 'Ceramic', origin: 'Spain', disc: true,
    desc: 'Ceramic Wall Tile',
    colors: ['Blanco','Esmeralda','Navy','Perla'],
    skus: [[158,'15.75x47.24','15.75x47.24',null,1.99,5.16,3,15.5]] },

  { name: 'Kadence', material: 'Porcelain', origin: 'Spain',
    colors: ['Gris','Marfil','Perla'],
    skus: [
      [159,'Gris Polished 12x24','12x24','Polished',3.99,1.94,6,11.62],
      [160,'Gris Polished 24x24','24x24','Polished',4.26,3.87,4,15.49],
      [161,'Gris Polished 24x48','24x48','Polished',5.33,7.745,2,15.49],
      [162,'Matte 24x48','24x48','Matte',5.33,7.745,2,15.49],
      [163,'Matte 36x36','36x36','Matte',5.69,8.7,2,17.4],
      [300,'Perla Matte Mosaic 2x2','2x2','Matte',9.99,null,null,null,'SH'],
    ] },

  { name: 'Larin Marfil', material: 'Porcelain', origin: 'Spain', disc: true,
    skus: [[164,'Polished 24x48','24x48','Polished',3.99,8,2,16]] },

  { name: 'Laurent Black', material: 'Porcelain', origin: 'Spain', disc: true,
    skus: [
      [166,'Matte 35.4x35.4','35.4x35.4','Matte',4.99,8.7,1,8.7],
      [167,'Polished 35.4x35.4','35.4x35.4','Polished',4.99,8.7,1,8.7],
    ] },

  { name: 'Leccese Cesellata', material: 'Porcelain', origin: 'Italy',
    colors: ['Fossile','Fumo','Pearla'],
    desc: 'R11 Anti-Slip Porcelain',
    skus: [
      [168,'12x24','12x24','R11',3.99,1.94,5,9.69],
      [169,'24x24','24x24','R11',4.29,3.87,3,11.63],
    ] },

  { name: 'Lingot', material: 'Porcelain', origin: 'Spain',
    desc: 'Glazed Porcelain Deco',
    colors: ['Aqua','Blue','Coral','Mint','White'],
    skus: [[170,'12.6x24.6','12.6x24.6',null,3.99,2.15,5,10.76]] },

  { name: 'MAPEI Grout Medium Grey', material: 'Grout', origin: null,
    desc: 'Suggested for Deco Lingot Series',
    skus: [[171,'11 LBS Bag','11lb',null,10.00,null,null,null,'PC']] },

  { name: 'Magna White', material: 'Ceramic', origin: 'Spain', disc: true,
    desc: 'Matte Wall Tile',
    skus: [[172,'Matte Wall 15.55x46.92','15.55x46.92','Matte',2.29,5.078,5,25.39]] },

  { name: 'Manhattan', material: 'Porcelain', origin: 'Italy',
    colors: ['Mud','Pearl'],
    skus: [[173,'Matte 36x36','36x36','Matte',3.99,8.715,2,17.43]] },

  { name: 'Markina Gold', material: 'Porcelain', origin: 'Spain',
    skus: [[177,'Polished 24x48','24x48','Polished',3.99,7.75,2,15.5]] },

  { name: 'Marmo Marfil', material: 'Porcelain', origin: 'Spain',
    skus: [
      [178,'Matte 24x48','24x48','Matte',3.89,7.75,2,15.5],
      [179,'Polished 24x48','24x48','Polished',3.99,7.75,2,15.5],
    ] },

  { name: 'Milano Crema', material: 'Porcelain', origin: 'Spain',
    skus: [[180,'Matte 24x48','24x48','Matte',4.49,8,2,16]] },

  { name: 'Mixit Concept', material: 'Porcelain', origin: 'Spain',
    colors: ['Blanco','Gris'],
    skus: [[181,'Matte 12x36','12x36','Matte',3.99,3,4,12]] },

  { name: 'Modern Concrete Ivory', material: 'Porcelain', origin: 'Poland',
    skus: [[182,'24x48','24x48',null,3.69,7.695,2,15.39]] },

  { name: 'Montblanc Gold', material: 'Porcelain', origin: 'Spain',
    skus: [
      [183,'Polished 12x24','12x24','Polished',4.26,2,6,11.62],
      [184,'Polished 24x24','24x24','Polished',4.26,3.87,4,15.49],
      [185,'Polished 36x36','36x36','Polished',4.99,8.72,2,17.44],
      [186,'Polished 24x48','24x48','Polished',5.33,8,2,15.5],
      [187,'Polished 48x48','48x48','Polished',6.40,15.5,1,15.5],
      [301,'Mosaic 2x2','2x2','Polished',9.99,null,null,null,'SH'],
      [307,'Mosaic 3x3','3x3','Polished',11.99,null,null,null,'SH'],
    ] },

  { name: 'Myrcella', material: 'Porcelain', origin: 'Spain',
    colors: ['Beige','Bone','Grey','Mocca'],
    skus: [[188,'9.13x47.25','9.13x47.25',null,1.99,3,4,12]] },

  { name: 'Naples White', material: 'Porcelain', origin: 'Spain',
    skus: [
      [189,'Polished 12x24','12x24','Polished',3.39,2,6,12],
      [190,'Polished 24x24','24x24','Polished',3.39,4,4,16],
      [191,'Polished 24x48','24x48','Polished',3.99,8,2,16],
      [192,'Matte 12x24','12x24','Matte',3.30,2,6,12],
      [193,'Matte 24x24','24x24','Matte',3.30,4,4,16],
      [302,'Matte Mosaic 2x2','2x2','Matte',9.99,null,null,null,'SH'],
      [303,'Polished Mosaic 2x2','2x2','Polished',9.99,null,null,null,'SH'],
    ] },

  { name: 'Palatino', material: 'Porcelain', origin: 'Spain',
    colors: ['Ivory'],
    skus: [
      [194,'Ivory Matte 24x48','24x48','Matte',4.89,7.59,2,15.18],
      [195,'Ivory Deco Matte 18x36','18x36','Matte',4.99,4.38,3,13.13],
    ] },

  { name: 'Pearl Onyx', material: 'Porcelain', origin: 'India',
    desc: 'Polished and Matte',
    skus: [[196,'24x48','24x48',null,3.49,8,2,16]] },

  { name: 'Puccini', material: 'Porcelain', origin: 'Spain',
    colors: ['Blanco','Marfil','Perla'],
    skus: [
      [197,'Blanco Polished 12x24','12x24','Polished',4.26,1.94,6,11.62],
      [198,'Blanco/Marfil Matte 12x24','12x24','Matte',4.26,1.94,6,11.62],
      [199,'Marfil/Perla Polished 12x24','12x24','Polished',4.26,1.94,6,11.62],
      [202,'Polished 24x24','24x24','Polished',4.36,3.87,4,15.49],
      [203,'Matte 24x24','24x24','Matte',4.26,3.87,4,15.49],
      [204,'Matte 24x48','24x48','Matte',5.23,7.745,2,15.5],
      [205,'Polished 24x48','24x48','Polished',5.33,7.745,2,15.5],
      [304,'Blanco Polished Mosaic 2x2','2x2','Polished',9.99,null,null,null,'SH'],
    ] },

  { name: 'Scanda White', material: 'Ceramic', origin: 'Spain', disc: true,
    desc: '3D Matte Wall Tile',
    skus: [[206,'3D Matte Wall 15.55x46.92','15.55x46.92','Matte',1.99,5.085,4,20.34]] },

  { name: 'Sekos White', material: 'Ceramic', origin: 'Spain', disc: true,
    skus: [[207,'12.44x39.37','12.44x39.37',null,1.99,3.4,5,17]] },

  { name: 'Sierra', material: 'Porcelain', origin: 'Middle East',
    skus: [[208,'Matte 24x48','24x48','Matte',3.49,8,2,16]] },

  { name: 'Spatula', material: 'Porcelain', origin: 'Italy',
    colors: ['Antracite','Grey','White','Bone'],
    desc: 'R10 Anti-Slip',
    skus: [[209,'12x24','12x24','R10',4.29,1.9375,6,11.625]] },

  { name: 'Statuario Nice', material: 'Porcelain', origin: 'India',
    skus: [[210,'Polished 24x48','24x48','Polished',3.99,7.75,2,15.5]] },

  { name: 'Sun Blanco', material: 'Ceramic', origin: 'Spain', disc: true,
    desc: 'Glazed Wall Tile',
    skus: [
      [211,'Glossy Shiny Wall 12x24','12x24','Glossy',2.89,1.94,9,17.44],
      [212,'Matte Wall 12x24','12x24','Matte',2.79,1.94,9,17.44],
    ] },

  { name: 'Temper', material: 'Porcelain', origin: 'Italy', disc: true,
    desc: 'Color Body Porcelain',
    colors: ['Coal','Frost','Golden','Iron'],
    skus: [
      [213,'Frost 24x48','24x48',null,4.99,7.75,2,15.5],
      [214,'48x48','48x48',null,5.99,15.5,1,15.5],
    ] },

  { name: 'Unique Ceppo Bone', material: 'Porcelain', origin: 'Mexico',
    skus: [[215,'24x48','24x48',null,4.29,8,2,16]] },

  { name: 'Volga', material: 'Porcelain', origin: 'Spain',
    colors: ['Grafito','Gris'],
    skus: [[216,'12x24','12x24',null,2.99,2,6,11.62]] },

  { name: 'Westmount Beige', material: 'Porcelain', origin: 'Poland',
    skus: [[217,'12x24','12x24',null,2.89,2,8,16]] },

  { name: 'WG001', material: 'Porcelain', origin: 'Vietnam',
    skus: [
      [218,'Polished 12x24','12x24','Polished',2.69,2,8,16],
      [219,'Polished 24x24','24x24','Polished',2.69,4,4,16],
      [220,'Matte 12x24','12x24','Matte',2.59,2,8,16],
      [221,'Matte 24x24','24x24','Matte',2.59,4,4,16],
      [305,'Matte Mosaic 2x2','2x2','Matte',9.99,null,null,null,'SH'],
    ] },

  // ── HEXAGON / MOSAIC (98% Recycled Glass, Pool Rated) ─────────

  { name: 'NatureGlass Hex', material: 'Glass', origin: 'Spain', disc: true,
    desc: '98% Recycled Glass, Pool Rated',
    skus: [
      [229,'Black 1x1','1x1',null,1.99,0.94,6,5.64,'SH'],
      [230,'Smooth Grey 1x1','1x1',null,1.99,0.94,6,5.64,'SH'],
      [231,'White 1x1','1x1',null,1.99,0.94,6,5.64,'SH'],
    ] },

  { name: 'Silver Matte Hex', material: 'Glass', origin: 'Spain', disc: true,
    desc: '98% Recycled Glass, Pool Rated',
    skus: [[232,'1x1','1x1','Matte',1.99,0.94,6,5.94,'SH']] },

  { name: 'Statuario Matte Hex', material: 'Glass', origin: 'Spain', disc: true,
    desc: '98% Recycled Glass, Pool Rated',
    skus: [[233,'1x1','1x1','Matte',1.99,0.94,6,5.94,'SH']] },

  // ── HEXAGON & PENNY ROUND MOSAICS ─────────────────────────────

  { name: 'Milano Mosaic', material: 'Porcelain', origin: 'Thailand',
    colors: ['Gold','Silver'],
    desc: 'Matte Anti-Slip Porcelain',
    skus: [[237,'2x2','2x2','Matte',5.99,0.99,20,19.8,'SH']] },

  { name: 'Hex XL Coimbra', material: 'Porcelain', origin: 'Spain',
    skus: [[238,'Matte 2x2','2x2','Matte',11.99,0.88,6,5.27,'SH']] },

  { name: 'Hex XL Fosco', material: 'Porcelain', origin: 'Spain',
    skus: [[239,'Matte 2x2','2x2','Matte',11.99,0.88,6,5.27,'SH']] },

  { name: 'Hex XL Inverno Grey', material: 'Porcelain', origin: 'Spain',
    skus: [[240,'Matte 2x2','2x2','Matte',11.99,0.88,6,5.27,'SH']] },

  { name: 'Penny Calacatta Gold', material: 'Porcelain', origin: 'Spain', disc: true,
    skus: [[241,'Matte 1x1','1x1','Matte',1.99,0.88,12,10.54,'SH']] },

  { name: 'Penny Fosco', material: 'Porcelain', origin: 'Spain', disc: true,
    skus: [[242,'Matte 1x1','1x1','Matte',1.99,0.88,12,10.54,'SH']] },

  { name: 'Penny Grafito', material: 'Porcelain', origin: 'Spain', disc: true,
    skus: [[243,'Matte 1x1','1x1','Matte',1.99,0.88,12,10.54,'SH']] },

  // ── 100% RECYCLED GLASS (Pool Rated) ──────────────────────────

  { name: 'Antwerp', material: 'Glass', origin: 'Far East', disc: true,
    desc: '100% Recycled Glass, Pool Rated',
    skus: [[247,'Sheet','14.88x10.81',null,1.99,1.05,10,11.19,'SH']] },

  { name: 'Camden', material: 'Glass', origin: 'Far East', disc: true,
    desc: '100% Recycled Glass, Pool Rated',
    skus: [[248,'Sheet','12.38x11.56',null,1.99,0.99,10,9.93,'SH']] },

  { name: 'Grande', material: 'Glass', origin: 'Far East', disc: true,
    desc: '100% Recycled Glass, Pool Rated',
    skus: [[249,'Sheet','11.56x12.38',null,1.99,0.99,10,9.9,'SH']] },

  { name: 'Hudson', material: 'Glass', origin: 'Far East', disc: true,
    desc: '100% Recycled Glass, Pool Rated',
    skus: [[250,'Sheet','8.25x17.31',null,1.99,0.99,10,9.88,'SH']] },

  { name: 'Nord', material: 'Glass', origin: 'Far East', disc: true,
    desc: '100% Recycled Glass, Pool Rated',
    skus: [[251,'Sheet','11.56x12.38',null,1.99,0.99,10,9.9,'SH']] },

  { name: 'Park', material: 'Glass', origin: 'Far East', disc: true,
    desc: '100% Recycled Glass, Pool Rated',
    skus: [[252,'Sheet','11.56x12.38',null,1.99,0.99,10,9.9,'SH']] },

  // ── GIO COLLECTION (Glazed Porcelain, Pool Rated) ──────────────

  { name: 'Gio', material: 'Porcelain', origin: 'Korea',
    desc: 'Glazed Porcelain Mosaic, Pool Rated',
    colors: ['Black','Grey','White','Taupe','Cobalt'],
    skus: [
      [255,'Matte Hexagon 4x4','4x4','Matte',1.99,0.9,null,null,'SH'],
      [256,'Matte Hexagon 2x2','2x2','Matte',1.99,0.82,null,null,'SH'],
      [257,'Glossy Hexagon 2x2','2x2','Glossy',1.99,0.82,null,null,'SH'],
      [258,'Matte Stacked Linear .82x2.8','0.82x2.8','Matte',1.99,0.95,null,null,'SH'],
      [259,'Matte Stacked Linear .86x5.7','0.86x5.7','Matte',1.99,0.95,null,null,'SH'],
      [260,'Glossy Stacked Linear .86x5.7','0.86x5.7','Glossy',1.99,0.95,null,null,'SH'],
      [261,'Matte Stacked Linear 1.26x5.7','1.26x5.7','Matte',1.99,0.89,null,null,'SH'],
      [262,'Glossy Stacked Linear 1.26x5.7','1.26x5.7','Glossy',1.99,0.89,null,null,'SH'],
    ] },

  { name: 'LN520 Stacked Linear', material: 'Porcelain', origin: 'Thailand',
    desc: 'Matte Anti-Slip Porcelain',
    skus: [[263,'1x6','1x6','Matte',1.99,0.96,null,null,'SH']] },

  // ── FRAMMENTI (Porcelain) ──────────────────────────────────────

  { name: 'Frammenti', material: 'Porcelain', origin: 'Italy', disc: true,
    skus: [
      [267,'Azzurro Macro Matte 8x8','8x8','Matte',1.99,0.43,29,12.49],
      [268,'Nero Macro Matte 8x8','8x8','Matte',1.99,0.43,29,12.49],
      [272,'Grigio Brick Glossy 3x16','3x16','Glossy',1.99,0.32,44,14.2],
    ] },

  // ── SUBWAY / ARTISAN SERIES ────────────────────────────────────

  { name: 'Altea', material: 'Ceramic', origin: 'Spain',
    desc: 'Mediterranean Glossy Finish, High Shade Variation',
    colors: ['Ash Blue','Black','Dusty Pink','Matcha','Pine Green','Rosewood','Smoke','Thistle Blue','White'],
    skus: [
      [276,'Square 4x4','4x4','Glossy',5.49,null,50,5.38],
      [277,'Subway 3x6','3x6','Glossy',5.49,null,44,5.38],
      [278,'Jolly Trim 1x8','1x8',null,9.60,null,66,null,'PC'],
    ] },

  { name: 'Amazonia', material: 'Ceramic', origin: 'Spain',
    desc: 'Irregular Metallic Effect Glossy Finish',
    colors: ['Aertic','Carbon','Chalk','Sand','Sapphire'],
    skus: [[281,'Subway 2.5x8','2.5x8','Glossy',4.24,null,48,6.67]] },

  { name: 'Limit', material: 'Ceramic', origin: 'Spain', disc: true,
    desc: 'Classic Vintage Glossy Finish',
    colors: ['Blanc','Blue Izu','Gris','Jaune','Noir','Sable','Terre Cuit','Vert'],
    skus: [
      [288,'Subway 2.5x10','2.5x10','Glossy',1.99,null,34,5.38],
      [289,'Jolly Trim 1x8','1x8',null,1.99,null,66,null,'PC'],
    ] },

  // ── SPECIAL ORDER MOSAICS (standalone) ─────────────────────────

  { name: 'Black Marble Mosaic', material: 'Porcelain', origin: 'Spain',
    skus: [[292,'Matte 2x2','2x2','Matte',9.99,null,null,null,'SH']] },

  { name: 'Chateau Mosaic', material: 'Porcelain', origin: null,
    skus: [[295,'Polished 2x2','2x2','Polished',3.99,null,null,null,'SH']] },

  // ── SCHLUTER STYLE TRIM ────────────────────────────────────────

  { name: 'Schluter Trim', material: 'Metal', origin: null,
    desc: 'Metal Edge Trim and Covebase',
    skus: [
      [310,'1/2 inch 8ft','8ft',null,15.99,null,null,null,'PC'],
      [311,'3/8 inch 8ft','8ft',null,15.99,null,null,null,'PC'],
      [312,'IN 10 M Covebase Matte 8ft','8ft','Matte',18.00,null,null,null,'PC'],
      [313,'10 P Covebase Polished 8ft','8ft','Polished',21.00,null,null,null,'PC'],
      [314,'SY 001 Stainless Covebase 8ft','8ft','Stainless',59.00,null,null,null,'PC'],
      [315,'SY 023 Stainless Covebase 8ft','8ft','Stainless',59.00,null,null,null,'PC'],
      [316,'SY 044 Stainless Covebase 8ft','8ft','Stainless',59.00,null,null,null,'PC'],
    ] },

  // ── 3D FLUTED AND FLAT WOOD PANELS ─────────────────────────────

  { name: 'Acoustic MDF Sound Absorption Panel', material: 'MDF', origin: null,
    desc: 'Indoor 3D Fluted Wall Panel',
    colors: ['Pine','Light Walnut','Dark Walnut','Black'],
    skus: [[320,'94.5x24 Panel','94.5x24',null,89.00,15.8,null,null,'PC']] },

  { name: 'Exterior Composite Wall Panel', material: 'WPC', origin: null,
    desc: 'Heavy Duty Outdoor Wall Panel',
    colors: ['Coffee Brown','Dark Coffee','Jet Black','Grey'],
    skus: [[327,'114x7.5 Panel','114x7.5',null,69.00,5.9,null,null,'PC']] },
];


// ==================== Main Import ====================

async function main() {
  // Ensure vendor exists
  let vendorRes = await pool.query("SELECT id FROM vendors WHERE code = 'BELLEZZA'");
  let vendorId;
  if (!vendorRes.rows.length) {
    const ins = await pool.query(`
      INSERT INTO vendors (name, code, website)
      VALUES ('Bellezza Ceramica', 'BELLEZZA', 'https://bellezzaceramica.com')
      RETURNING id
    `);
    vendorId = ins.rows[0].id;
    console.log(`Created vendor: Bellezza Ceramica (${vendorId})`);
  } else {
    vendorId = vendorRes.rows[0].id;
    console.log(`Using existing vendor: Bellezza Ceramica (${vendorId})`);
  }

  // Look up category IDs
  const catRes = await pool.query("SELECT id, slug FROM categories WHERE slug IN ('porcelain-tile', 'ceramic-tile', 'glass-mosaic', 'trim-accessories')");
  const catMap = {};
  for (const row of catRes.rows) catMap[row.slug] = row.id;

  const CAT_PORCELAIN = catMap['porcelain-tile'] || null;
  const CAT_CERAMIC = catMap['ceramic-tile'] || null;
  const CAT_GLASS = catMap['glass-mosaic'] || null;
  const CAT_TRIM = catMap['trim-accessories'] || null;

  let productsCreated = 0, productsUpdated = 0;
  let skusCreated = 0, skusUpdated = 0;

  for (const prod of PRODUCTS) {
    // Determine category
    let catId = CAT_PORCELAIN;
    if (prod.material === 'Ceramic') catId = CAT_CERAMIC || CAT_PORCELAIN;
    if (prod.material === 'Glass') catId = CAT_GLASS || CAT_PORCELAIN;
    if (prod.material === 'Metal') catId = CAT_TRIM || null;
    if (prod.material === 'MDF' || prod.material === 'WPC') catId = null;
    if (prod.material === 'Grout') catId = CAT_TRIM || null;

    const prodRec = await upsertProduct(vendorId, {
      name: prod.name,
      collection: prod.name,
      category_id: catId,
      description_short: prod.desc || null,
    });
    if (prodRec.is_new) productsCreated++; else productsUpdated++;

    let prodSkuCount = 0;

    for (const s of prod.skus) {
      const [rowNum, variantName, size, finish, price, sqftPc, pcsBox, sqftBox, um] = s;
      const unitMode = um || 'SF';

      const sellBy = unitMode === 'SF' ? 'sqft' : 'unit';
      const priceBasis = unitMode === 'SF' ? 'per_sqft' : 'per_unit';
      const isAccessory = unitMode === 'PC';
      const variantType = isAccessory ? 'accessory' : null;

      const vendorSku = `R${rowNum}`;
      const internalSku = `BLZ-R${rowNum}`;

      const sku = await upsertSku(prodRec.id, {
        vendor_sku: vendorSku,
        internal_sku: internalSku,
        variant_name: variantName,
        sell_by: sellBy,
        variant_type: variantType,
      });
      if (sku.is_new) skusCreated++; else skusUpdated++;

      // Pricing: dealer cost → retail × 2.5
      const cost = price;
      const retail = parseFloat((cost * RETAIL_MARKUP).toFixed(2));
      await upsertPricing(sku.id, { cost, retail_price: retail, price_basis: priceBasis });

      // Packaging
      if (pcsBox || sqftBox) {
        await upsertPackaging(sku.id, {
          sqft_per_box: sqftBox,
          pieces_per_box: pcsBox,
        });
      }

      // Attributes
      await setAttr(sku.id, 'size', size);
      if (finish) await setAttr(sku.id, 'finish', finish);
      await setAttr(sku.id, 'material', prod.material);
      if (prod.origin) await setAttr(sku.id, 'country_of_origin', prod.origin);
      if (prod.colors) await setAttr(sku.id, 'color', prod.colors.join(', '));

      prodSkuCount++;
    }

    const marker = prodRec.is_new ? '+' : '~';
    const discLabel = prod.disc ? ' [DISC]' : '';
    console.log(`  ${marker} ${prod.name}${discLabel} — ${prodSkuCount} SKU(s)`);
  }

  console.log('\n=== Bellezza Import Complete ===');
  console.log(`Products: ${productsCreated} created, ${productsUpdated} updated`);
  console.log(`SKUs: ${skusCreated} created, ${skusUpdated} updated`);

  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
