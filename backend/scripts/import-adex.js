#!/usr/bin/env node

/**
 * Import ADEX USA handcrafted tile catalog from Quick Import Excel.
 *
 * ~1,340 SKUs across 9 collections:
 *   Floor, Habitat, Hampton, Horizon, Levante, Mosaic, Neri, Ocean, Studio
 *
 * Pricing: Excel lists dealer cost. Retail = cost × 2.5 (standard tile markup).
 * Field tiles sold per sqft (UM=SQFT). Trim/mosaics/decorative sold per piece (UM=EA).
 * CT rows are carton-level pricing for SQFT items — we skip those and store
 * packaging from the matching SQFT row instead.
 *
 * Usage:
 *   docker compose exec api node scripts/import-adex.js [path-to-xlsx]
 *   Default path: /data/ADEXUSA-Price-List-Quick-Import-v.113.xlsx
 *
 * The file must be mounted into the container or copied in first:
 *   docker cp ~/Downloads/ADEXUSA-Price-List-Quick-Import-v.113.xlsx flooring-platform-api-1:/data/
 */

import pg from 'pg';
import XLSX from 'xlsx';

// ==================== Config ====================

const RETAIL_MARKUP = 2.5;

const CAT = {
  ceramic:  '650e8400-e29b-41d4-a716-446655440013',
  porcelain:'650e8400-e29b-41d4-a716-446655440012',
  mosaic:   '650e8400-e29b-41d4-a716-446655440014',
};

// Collections that are porcelain floor tile
const PORCELAIN_COLLECTIONS = new Set(['FLOOR']);

const ATTR_SLUGS = ['color', 'size', 'material', 'finish', 'collection'];

const FINISHES = ['GLOSSY', 'MATTE', 'SATIN', 'POLISHED', 'HONED', 'TEXTURED', 'CRACKLE', 'METALLIC'];

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: 5432,
  database: 'flooring_pim',
  user: 'postgres',
  password: 'postgres',
});

// ==================== Helpers ====================

async function upsertProduct(vendorId, { name, collection, categoryId, descriptionShort }) {
  const result = await pool.query(`
    INSERT INTO products (vendor_id, name, collection, category_id, status, description_short)
    VALUES ($1, $2, $3, $4, 'active', $5)
    ON CONFLICT ON CONSTRAINT products_vendor_collection_name_unique DO UPDATE SET
      category_id = COALESCE(EXCLUDED.category_id, products.category_id),
      description_short = COALESCE(EXCLUDED.description_short, products.description_short),
      updated_at = CURRENT_TIMESTAMP
    RETURNING id, (xmax = 0) AS is_new
  `, [vendorId, name, collection || '', categoryId || null, descriptionShort || null]);
  return result.rows[0];
}

async function upsertSku(productId, { vendorSku, internalSku, variantName, sellBy, variantType }) {
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
  `, [productId, vendorSku, internalSku, variantName || null, sellBy || 'sqft', variantType || null]);
  return result.rows[0];
}

async function upsertPricing(skuId, { cost, retailPrice, priceBasis }) {
  await pool.query(`
    INSERT INTO pricing (sku_id, cost, retail_price, price_basis)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (sku_id) DO UPDATE SET
      cost = EXCLUDED.cost,
      retail_price = EXCLUDED.retail_price,
      price_basis = EXCLUDED.price_basis
  `, [skuId, cost, retailPrice, priceBasis || 'per_sqft']);
}

async function upsertPackaging(skuId, pkg) {
  await pool.query(`
    INSERT INTO packaging (sku_id, sqft_per_box, pieces_per_box, boxes_per_pallet, sqft_per_pallet, weight_per_box_lbs)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (sku_id) DO UPDATE SET
      sqft_per_box = COALESCE(EXCLUDED.sqft_per_box, packaging.sqft_per_box),
      pieces_per_box = COALESCE(EXCLUDED.pieces_per_box, packaging.pieces_per_box),
      boxes_per_pallet = COALESCE(EXCLUDED.boxes_per_pallet, packaging.boxes_per_pallet),
      sqft_per_pallet = COALESCE(EXCLUDED.sqft_per_pallet, packaging.sqft_per_pallet),
      weight_per_box_lbs = COALESCE(EXCLUDED.weight_per_box_lbs, packaging.weight_per_box_lbs)
  `, [
    skuId,
    pkg.sqftPerBox || null,
    pkg.piecesPerBox || null,
    pkg.boxesPerPallet || null,
    pkg.sqftPerPallet || null,
    pkg.weightPerBoxLbs || null,
  ]);
}

async function setAttr(skuId, slug, value) {
  if (!value) return;
  const attr = await pool.query('SELECT id FROM attributes WHERE slug = $1', [slug]);
  if (!attr.rows.length) return;
  await pool.query(`
    INSERT INTO sku_attributes (sku_id, attribute_id, value)
    VALUES ($1, $2, $3)
    ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value = EXCLUDED.value
  `, [skuId, attr.rows[0].id, String(value).trim()]);
}

// ==================== Data Parsing ====================

function titleCase(str) {
  if (!str) return '';
  return str.toLowerCase()
    .split(/\s+/)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
    .replace(/\bX\b/g, 'x');    // "3 X 12" → "3 x 12"
}

/**
 * Extract finish from color string.
 * "FROST GLOSSY" → { color: "Frost", finish: "Glossy" }
 * "AZURE" → { color: "Azure", finish: null }
 */
function parseColorFinish(rawColor) {
  if (!rawColor) return { color: null, finish: null };
  const upper = rawColor.trim().toUpperCase();
  for (const f of FINISHES) {
    if (upper.endsWith(' ' + f)) {
      const colorPart = rawColor.trim().slice(0, -(f.length + 1)).trim();
      return { color: titleCase(colorPart), finish: titleCase(f) };
    }
  }
  return { color: titleCase(rawColor.trim()), finish: null };
}

/**
 * Extract size from description.
 * "FIELD TILE 3 X 12" → { type: "Field Tile", size: "3x12" }
 * "HEX 8 X 9" → { type: "Hex", size: "8x9" }
 * "QUARTER ROUND 0.75 X 6" → { type: "Quarter Round", size: "0.75x6" }
 * "1 X 1 MOSAIC ON 12 X 12 SHEET" → { type: "1x1 Mosaic On 12x12 Sheet", size: "1x1" }
 */
function parseDescription(desc) {
  if (!desc) return { type: null, size: null };
  const clean = desc.trim();

  // Match dimension pattern: number X number (possibly with decimals and fractions)
  const sizeMatch = clean.match(/(\d+(?:\.\d+)?(?:\s*\/\s*\d+)?)\s*[xX×]\s*(\d+(?:\.\d+)?(?:\s*\/\s*\d+)?)/);
  let size = null;
  let type = clean;

  if (sizeMatch) {
    size = sizeMatch[1].replace(/\s/g, '') + 'x' + sizeMatch[2].replace(/\s/g, '');
    // Type is everything before the first dimension
    const idx = clean.indexOf(sizeMatch[0]);
    type = clean.slice(0, idx).trim();
    if (!type) type = clean; // If description starts with size, use full string
  }

  return { type: titleCase(type), size };
}

/**
 * Build the base description key for product grouping.
 * Strips the color from the description if it appears at the end.
 */
function getBaseDescription(desc, color) {
  if (!desc) return '';
  let base = desc.trim();

  // Some descriptions embed the color at the end (e.g., "HEX 8 X 9 AZURE")
  if (color) {
    const colorUpper = color.trim().toUpperCase();
    // Also try just the base color without finish
    const { color: baseColor } = parseColorFinish(color);
    const baseColorUpper = baseColor ? baseColor.toUpperCase() : '';

    if (base.toUpperCase().endsWith(' ' + colorUpper)) {
      base = base.slice(0, -(colorUpper.length + 1)).trim();
    } else if (baseColorUpper && base.toUpperCase().endsWith(' ' + baseColorUpper)) {
      base = base.slice(0, -(baseColorUpper.length + 1)).trim();
    }
  }

  // Normalize multiple spaces
  return base.replace(/\s+/g, ' ').trim();
}

/**
 * Determine category for a collection.
 */
function getCategoryId(collection) {
  const upper = (collection || '').toUpperCase();
  if (upper === 'MOSAIC') return CAT.mosaic;
  if (PORCELAIN_COLLECTIONS.has(upper)) return CAT.porcelain;
  return CAT.ceramic; // Default: handcrafted ceramic
}

// ==================== Main Import ====================

async function main() {
  const filePath = process.argv[2] || '/data/ADEXUSA-Price-List-Quick-Import-v.113.xlsx';

  console.log(`Reading ${filePath}...`);
  const wb = XLSX.readFile(filePath);

  // Parse all sheets
  const allRows = [];
  for (const sheetName of wb.SheetNames) {
    const sheet = wb.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json(sheet);
    console.log(`  Sheet "${sheetName}": ${data.length} rows`);
    allRows.push(...data);
  }

  // Deduplicate: when an item code has both SQFT and EA rows, prefer SQFT
  // (field tiles should be sold by sqft; EA is just per-piece alternate pricing)
  const byCode = new Map();
  for (const r of allRows) {
    if (!r['ITEM CODE'] || !r.UM) continue;
    if (r.UM === 'CT') continue; // Skip carton-level rows entirely
    const code = String(r['ITEM CODE']).trim();
    const existing = byCode.get(code);
    if (!existing) {
      byCode.set(code, r);
    } else if (r.UM === 'SQFT' && existing.UM !== 'SQFT') {
      // Prefer SQFT over EA
      byCode.set(code, r);
    }
    // else keep existing (first seen or already SQFT)
  }
  const dataRows = [...byCode.values()];
  const totalNonCt = allRows.filter(r => r['ITEM CODE'] && r.UM && r.UM !== 'CT').length;
  console.log(`\nDeduplicated to ${dataRows.length} unique SKUs (${totalNonCt - dataRows.length} dual SQFT/EA duplicates resolved, ${allRows.length - totalNonCt} CT rows skipped)`);

  // Group into products by collection + base description
  const productMap = new Map();
  for (const row of dataRows) {
    const baseDesc = getBaseDescription(row.DESCRIPTION, row.COLOR);
    const key = `${(row.COLLECTION || '').trim()}|${baseDesc.toUpperCase()}`;

    if (!productMap.has(key)) {
      productMap.set(key, {
        collection: (row.COLLECTION || '').trim(),
        baseDesc,
        skus: [],
      });
    }
    productMap.get(key).skus.push(row);
  }

  console.log(`\nGrouped into ${productMap.size} products`);

  // Show collection breakdown
  const collCounts = new Map();
  for (const [, prod] of productMap) {
    const c = prod.collection;
    collCounts.set(c, (collCounts.get(c) || 0) + 1);
  }
  for (const [c, n] of [...collCounts.entries()].sort()) {
    console.log(`  ${c}: ${n} products`);
  }

  // ── Connect to DB ──

  const client = await pool.connect();
  const stats = { products: 0, skus: 0, pricing: 0, packaging: 0, attrs: 0 };

  try {
    await client.query('BEGIN');

    // Create vendor
    const vendorRes = await pool.query(`
      INSERT INTO vendors (id, name, code, website)
      VALUES (gen_random_uuid(), 'ADEX USA', 'ADEX', 'https://adexusa.com')
      ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, website = EXCLUDED.website
      RETURNING id
    `);
    const vendorId = vendorRes.rows[0].id;
    console.log(`\nVendor: ADEX USA (${vendorId})`);

    // Pre-fetch attribute IDs
    const attrRes = await pool.query(
      `SELECT id, slug FROM attributes WHERE slug = ANY($1)`,
      [ATTR_SLUGS]
    );
    const attrIds = {};
    for (const row of attrRes.rows) attrIds[row.slug] = row.id;

    // Fast attribute setter using pre-fetched IDs
    async function setAttrFast(skuId, slug, value) {
      if (!value || !attrIds[slug]) return;
      await client.query(`
        INSERT INTO sku_attributes (sku_id, attribute_id, value)
        VALUES ($1, $2, $3)
        ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value = EXCLUDED.value
      `, [skuId, attrIds[slug], String(value).trim()]);
      stats.attrs++;
    }

    // ── Import each product ──

    let processed = 0;
    for (const [, prod] of productMap) {
      const categoryId = getCategoryId(prod.collection);
      const productName = titleCase(prod.baseDesc);
      const collectionName = titleCase(prod.collection);

      // Determine material based on collection
      const material = PORCELAIN_COLLECTIONS.has(prod.collection.toUpperCase())
        ? 'Porcelain' : prod.collection.toUpperCase() === 'MOSAIC' ? 'Glass/Ceramic' : 'Ceramic';

      const prodRec = await upsertProduct(vendorId, {
        name: productName,
        collection: collectionName,
        categoryId,
        descriptionShort: `ADEX ${collectionName} ${productName}`,
      });
      stats.products++;

      for (const row of prod.skus) {
        const itemCode = String(row['ITEM CODE']).trim();
        const internalSku = 'ADEX-' + itemCode;
        const sellBy = row.UM === 'SQFT' ? 'sqft' : 'unit';
        const { color, finish } = parseColorFinish(row.COLOR);
        const { size } = parseDescription(row.DESCRIPTION);

        // Variant name: color + finish if present
        let variantName = color || '';
        if (finish) variantName += (variantName ? ' ' : '') + finish;
        if (!variantName) variantName = itemCode; // Fallback to item code

        const skuRec = await upsertSku(prodRec.id, {
          vendorSku: itemCode,
          internalSku,
          variantName,
          sellBy,
          variantType: null,
        });
        stats.skus++;

        // Pricing
        const cost = parseFloat(row.PRICE);
        if (!isNaN(cost) && cost > 0) {
          const retailPrice = (cost * RETAIL_MARKUP).toFixed(2);
          await upsertPricing(skuRec.id, {
            cost: cost.toFixed(2),
            retailPrice,
            priceBasis: sellBy === 'sqft' ? 'per_sqft' : 'per_unit',
          });
          stats.pricing++;
        }

        // Packaging
        const sfCtn = parseFloat(row['SF/CTN']);
        const pcCtn = parseFloat(row['PC/CTN']);
        const ctnPlt = parseFloat(row['CTN/PLT']);
        const sfPlt = parseFloat(row['SF/PLT']);
        const lbCt = parseFloat(row['LB/CT']);

        if (!isNaN(pcCtn) || !isNaN(sfCtn)) {
          await upsertPackaging(skuRec.id, {
            sqftPerBox: !isNaN(sfCtn) ? sfCtn : null,
            piecesPerBox: !isNaN(pcCtn) ? pcCtn : null,
            boxesPerPallet: !isNaN(ctnPlt) ? ctnPlt : null,
            sqftPerPallet: !isNaN(sfPlt) ? sfPlt : null,
            weightPerBoxLbs: !isNaN(lbCt) ? lbCt : null,
          });
          stats.packaging++;
        }

        // Attributes
        await setAttrFast(skuRec.id, 'color', color);
        await setAttrFast(skuRec.id, 'size', size);
        await setAttrFast(skuRec.id, 'finish', finish);
        await setAttrFast(skuRec.id, 'material', material);
        await setAttrFast(skuRec.id, 'collection', collectionName);
      }

      processed++;
      if (processed % 50 === 0) {
        console.log(`  Imported ${processed}/${productMap.size} products (${stats.skus} SKUs)...`);
      }
    }

    await client.query('COMMIT');

    console.log('\n=== ADEX USA Import Complete ===');
    console.log(`Products:   ${stats.products}`);
    console.log(`SKUs:       ${stats.skus}`);
    console.log(`Pricing:    ${stats.pricing}`);
    console.log(`Packaging:  ${stats.packaging}`);
    console.log(`Attributes: ${stats.attrs}`);

    // Per-collection summary
    console.log('\nPer-collection breakdown:');
    const collSkus = new Map();
    for (const [, prod] of productMap) {
      const c = prod.collection;
      collSkus.set(c, (collSkus.get(c) || 0) + prod.skus.length);
    }
    for (const [c, n] of [...collSkus.entries()].sort()) {
      const prods = collCounts.get(c);
      console.log(`  ${titleCase(c)}: ${prods} products, ${n} SKUs`);
    }

    // Refresh search vectors for all ADEX collections
    console.log('\nRefreshing search vectors...');
    const collections = [...collCounts.keys()].map(c => titleCase(c));
    for (const collection of collections) {
      const result = await pool.query(`
        UPDATE products p SET search_vector =
          setweight(to_tsvector('english', unaccent(coalesce(p.name, ''))), 'A') ||
          setweight(to_tsvector('english', unaccent(coalesce(p.collection, ''))), 'A') ||
          setweight(to_tsvector('english', unaccent(coalesce(v.name, ''))), 'B') ||
          setweight(to_tsvector('english', unaccent(coalesce(
            (SELECT c.name FROM categories c WHERE c.id = p.category_id), ''))), 'B') ||
          setweight(to_tsvector('english', unaccent(coalesce(p.description_short, ''))), 'C') ||
          setweight(to_tsvector('english', unaccent(coalesce(
            (SELECT string_agg(DISTINCT sa.value, ' ')
             FROM skus s2 JOIN sku_attributes sa ON sa.sku_id = s2.id
             WHERE s2.product_id = p.id AND s2.status = 'active'), ''))), 'D')
        FROM vendors v
        WHERE v.id = p.vendor_id
          AND p.collection = $1
          AND v.code = 'ADEX'
      `, [collection]);
      console.log(`  ${collection}: ${result.rowCount} search vectors refreshed`);
    }

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Import failed, rolled back:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
