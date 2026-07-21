#!/usr/bin/env node
/**
 * Hartco SPC — XLS Price List Importer
 *
 * Parses the AHFHartcoSPC.xls dealer price list from the Triwest Decor 24
 * portal and upserts floor + trim SKUs into the database.
 *
 * Usage:
 *   node backend/scripts/import-triwest-hartco-spc.cjs [path-to-xls]
 *
 * Default file: /Users/kianassarpour/Downloads/AHFHartcoSPC.xls
 */

const XLSX = require('xlsx');
const { Pool } = require('pg');
const path = require('path');

// ---------------------------------------------------------------------------
// Database connection (same pattern as import-triwest-832.cjs)
// ---------------------------------------------------------------------------
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

const VENDOR_CODE = 'TW';
const CATEGORY_SLUG = 'luxury-vinyl';

// ---------------------------------------------------------------------------
// Trim types: column index (0-based) → { label, price }
// Prices come from the header row (row 8, cols 8-12)
// ---------------------------------------------------------------------------
const TRIM_TYPES = [
  { col: 8,  label: 'Reducer Strip',    price: 40.22 },
  { col: 9,  label: 'T-Molding',        price: 36.59 },
  { col: 10, label: 'Threshold',         price: 36.59 },
  { col: 11, label: 'Flush Stair Nose',  price: 43.01 },
  { col: 12, label: 'Quarter Round',     price: 7.76 },
];

// ---------------------------------------------------------------------------
// Collection definitions: where each section lives in the spreadsheet
// Rows are 0-indexed. sqftPrice/wearLayer come from the XLS first data row
// and the specs row below each section.
// ---------------------------------------------------------------------------
const COLLECTIONS = [
  {
    name: 'Hartco Pikes Peak SPC',
    dataRows: [8, 9, 10, 11],   // 0-indexed rows with SKU data
    sqftPrice: 2.47,
    wearLayer: '12mil',
  },
  {
    name: 'Hartco Denali SPC',
    dataRows: [15, 16, 17, 18, 19, 20, 21],
    sqftPrice: 2.73,
    wearLayer: '20mil',
  },
  {
    name: 'Hartco Everest SPC',
    dataRows: [25, 26, 27, 28, 29, 30, 31, 32, 33, 34],
    sqftPrice: 3.36,
    wearLayer: '22mil',
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function titleCase(text) {
  if (!text) return '';
  return text.trim().split(/\s+/)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

function makeInternalSku(vendorSku) {
  if (vendorSku && vendorSku.toUpperCase().startsWith('TW-')) return vendorSku;
  return `TW-${vendorSku}`;
}

// ---------------------------------------------------------------------------
// Parse XLS into structured items
// ---------------------------------------------------------------------------
function parseXls(filePath) {
  const wb = XLSX.readFile(filePath);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

  const allItems = [];

  for (const col of COLLECTIONS) {
    for (const rowIdx of col.dataRows) {
      const row = rows[rowIdx];
      if (!row) continue;

      const color = (row[1] || '').trim();
      const itemNumber = (row[2] || '').trim();
      const size = (row[3] || '').trim();
      const sqftPerCtn = parseFloat(row[4]) || null;
      const ctnsPerPallet = parseFloat(row[5]) || null;

      if (!itemNumber || !color) continue;

      // Floor SKU
      allItems.push({
        type: 'floor',
        collection: col.name,
        color: titleCase(color),
        vendorSku: itemNumber,
        size,
        sqftPerBox: sqftPerCtn,
        boxesPerPallet: ctnsPerPallet,
        cost: col.sqftPrice,
        sellBy: 'sqft',
        priceBasis: 'per_sqft',
        wearLayer: col.wearLayer,
      });

      // Trim SKUs
      for (const trim of TRIM_TYPES) {
        const trimSku = (row[trim.col] || '').trim();
        if (!trimSku) continue;

        allItems.push({
          type: 'trim',
          trimLabel: trim.label,
          collection: col.name,
          color: titleCase(color),
          vendorSku: trimSku,
          cost: trim.price,
          sellBy: 'unit',
          priceBasis: 'per_unit',
          wearLayer: col.wearLayer,
        });
      }
    }
  }

  return allItems;
}

// ---------------------------------------------------------------------------
// DB helpers (same patterns as import-triwest-832.cjs)
// ---------------------------------------------------------------------------
async function upsertSkuAttribute(skuId, slug, value) {
  if (!value || !String(value).trim()) return;
  const attr = await pool.query('SELECT id FROM attributes WHERE slug = $1', [slug]);
  if (!attr.rows.length) return;
  await pool.query(`
    INSERT INTO sku_attributes (sku_id, attribute_id, value)
    VALUES ($1, $2, $3)
    ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value = $3
  `, [skuId, attr.rows[0].id, String(value).trim()]);
  return true;
}

async function upsertProduct(vendorId, categoryId, collection, productName, descShort, descLong) {
  const existing = await pool.query(
    'SELECT id FROM products WHERE vendor_id = $1 AND collection = $2 AND name = $3',
    [vendorId, collection, productName]
  );
  if (existing.rows.length > 0) {
    const id = existing.rows[0].id;
    await pool.query(`
      UPDATE products SET category_id = COALESCE($1, category_id), status = 'active',
        description_short = COALESCE($2, description_short),
        description_long = COALESCE($3, description_long),
        updated_at = NOW()
      WHERE id = $4
    `, [categoryId, descShort, descLong, id]);
    return { id, created: false };
  }
  const result = await pool.query(`
    INSERT INTO products (vendor_id, name, collection, category_id, status, description_short, description_long)
    VALUES ($1, $2, $3, $4, 'active', $5, $6)
    RETURNING id
  `, [vendorId, productName, collection, categoryId, descShort, descLong]);
  return { id: result.rows[0].id, created: true };
}

async function upsertSku(productId, vendorSku, internalSku, variantName, sellBy, variantType) {
  const existing = await pool.query('SELECT id FROM skus WHERE internal_sku = $1', [internalSku]);
  if (existing.rows.length > 0) {
    const id = existing.rows[0].id;
    await pool.query(`
      UPDATE skus SET product_id = $1, vendor_sku = $2, variant_name = $3,
        sell_by = $4, variant_type = $5, status = 'active', updated_at = NOW()
      WHERE id = $6
    `, [productId, vendorSku, variantName, sellBy, variantType, id]);
    return { id, created: false };
  }
  const result = await pool.query(`
    INSERT INTO skus (product_id, vendor_sku, internal_sku, variant_name, sell_by, variant_type, status)
    VALUES ($1, $2, $3, $4, $5, $6, 'active')
    RETURNING id
  `, [productId, vendorSku, internalSku, variantName, sellBy, variantType]);
  return { id: result.rows[0].id, created: true };
}

async function upsertPricing(skuId, cost, priceBasis) {
  const retail = Math.round(cost * 1.6 / 0.05) * 0.05;
  await pool.query(`
    INSERT INTO pricing (sku_id, cost, retail_price, price_basis)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (sku_id) DO UPDATE SET cost = $2, retail_price = $3, price_basis = $4
  `, [skuId, cost, retail, priceBasis]);
}

async function upsertPackaging(skuId, sqftPerBox, boxesPerPallet) {
  await pool.query(`
    INSERT INTO packaging (sku_id, sqft_per_box, boxes_per_pallet)
    VALUES ($1, $2, $3)
    ON CONFLICT (sku_id) DO UPDATE SET
      sqft_per_box = COALESCE($2, packaging.sqft_per_box),
      boxes_per_pallet = COALESCE($3, packaging.boxes_per_pallet)
  `, [skuId, sqftPerBox, boxesPerPallet]);
}

// ---------------------------------------------------------------------------
// Main import
// ---------------------------------------------------------------------------
async function main() {
  const filePath = process.argv[2] || '/Users/kianassarpour/Downloads/AHFHartcoSPC.xls';
  console.log(`\nParsing: ${filePath}`);

  const items = parseXls(filePath);
  const floorItems = items.filter(i => i.type === 'floor');
  const trimItems = items.filter(i => i.type === 'trim');
  console.log(`Parsed ${floorItems.length} floor SKUs + ${trimItems.length} trim SKUs from XLS`);

  // Look up vendor
  const vendorResult = await pool.query('SELECT id FROM vendors WHERE code = $1', [VENDOR_CODE]);
  if (!vendorResult.rows.length) {
    console.error(`Vendor with code "${VENDOR_CODE}" not found. Run the main 832 importer first.`);
    process.exit(1);
  }
  const vendorId = vendorResult.rows[0].id;
  console.log(`Vendor: ${VENDOR_CODE} (${vendorId})`);

  // Look up category
  const catResult = await pool.query('SELECT id FROM categories WHERE slug = $1', [CATEGORY_SLUG]);
  const categoryId = catResult.rows.length ? catResult.rows[0].id : null;
  console.log(`Category: ${CATEGORY_SLUG} (${categoryId || 'not found — will be NULL'})`);

  const stats = {
    products_created: 0, products_updated: 0,
    skus_created: 0, skus_updated: 0,
    pricing: 0, packaging: 0, attributes: 0,
  };

  // --- Floor SKUs ---
  // Group by collection → one product per collection
  const floorByCollection = new Map();
  for (const item of floorItems) {
    if (!floorByCollection.has(item.collection)) floorByCollection.set(item.collection, []);
    floorByCollection.get(item.collection).push(item);
  }

  for (const [collection, skus] of floorByCollection) {
    const rep = skus[0];
    const descShort = `SPC | by Hartco | ${rep.wearLayer} wear layer | ${rep.sqftPerBox} SF/Box`;
    const descLong = `SPC flooring by Hartco. Part of the ${collection} collection. ${rep.sqftPerBox} sq ft per carton.`;

    const product = await upsertProduct(vendorId, categoryId, collection, collection, descShort, descLong);
    if (product.created) stats.products_created++; else stats.products_updated++;

    for (const item of skus) {
      const internalSku = makeInternalSku(item.vendorSku);
      const sku = await upsertSku(product.id, item.vendorSku, internalSku, item.color, item.sellBy, null);
      if (sku.created) stats.skus_created++; else stats.skus_updated++;

      await upsertPricing(sku.id, item.cost, item.priceBasis);
      stats.pricing++;

      if (item.sqftPerBox || item.boxesPerPallet) {
        await upsertPackaging(sku.id, item.sqftPerBox, item.boxesPerPallet);
        stats.packaging++;
      }

      // Attributes
      if (await upsertSkuAttribute(sku.id, 'brand', 'Hartco')) stats.attributes++;
      if (await upsertSkuAttribute(sku.id, 'collection', collection)) stats.attributes++;
      if (await upsertSkuAttribute(sku.id, 'construction', 'SPC')) stats.attributes++;
      if (await upsertSkuAttribute(sku.id, 'color', item.color)) stats.attributes++;
      if (await upsertSkuAttribute(sku.id, 'wear_layer', item.wearLayer)) stats.attributes++;
    }
  }

  // --- Trim SKUs ---
  // Group by collection + trimLabel → one product per trim type per collection
  const trimByGroup = new Map();
  for (const item of trimItems) {
    const key = `${item.collection}|||${item.trimLabel}`;
    if (!trimByGroup.has(key)) trimByGroup.set(key, []);
    trimByGroup.get(key).push(item);
  }

  for (const [key, skus] of trimByGroup) {
    const rep = skus[0];
    const productName = `${rep.collection} ${rep.trimLabel}`;
    const descShort = `${rep.trimLabel} | for ${rep.collection}`;
    const descLong = `${rep.trimLabel} trim accessory for the ${rep.collection} collection by Hartco.`;

    const product = await upsertProduct(vendorId, categoryId, rep.collection, productName, descShort, descLong);
    if (product.created) stats.products_created++; else stats.products_updated++;

    for (const item of skus) {
      const internalSku = makeInternalSku(item.vendorSku);
      const sku = await upsertSku(product.id, item.vendorSku, internalSku, item.color, item.sellBy, 'accessory');
      if (sku.created) stats.skus_created++; else stats.skus_updated++;

      await upsertPricing(sku.id, item.cost, item.priceBasis);
      stats.pricing++;

      // Attributes
      if (await upsertSkuAttribute(sku.id, 'brand', 'Hartco')) stats.attributes++;
      if (await upsertSkuAttribute(sku.id, 'collection', rep.collection)) stats.attributes++;
      if (await upsertSkuAttribute(sku.id, 'color', item.color)) stats.attributes++;
    }
  }

  console.log('\n--- Import Complete ---');
  console.log(`Products: ${stats.products_created} created, ${stats.products_updated} updated`);
  console.log(`SKUs:     ${stats.skus_created} created, ${stats.skus_updated} updated`);
  console.log(`Pricing:  ${stats.pricing} upserted`);
  console.log(`Packaging: ${stats.packaging} upserted`);
  console.log(`Attributes: ${stats.attributes} upserted`);

  await pool.end();
}

main().catch(err => {
  console.error('Fatal error:', err);
  pool.end();
  process.exit(1);
});
