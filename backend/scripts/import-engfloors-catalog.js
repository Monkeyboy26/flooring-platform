#!/usr/bin/env node

/**
 * Enrich Engineered Floors — DreamWeaver & PureGrain Product Catalog
 *
 * Source: EF_Full_Product_Catalog.csv from Lauryn Hill (EF Digital Marketing)
 * Contains: 248 products, ~3700 SKU/color combos, 5001 image rows
 *
 * This script ENRICHES existing EDI-created SKUs with:
 *   - Product descriptions (from construction, fiber brand, backing)
 *   - SKU attributes: fiber_brand, finish, installation_method, shade, collection
 *   - Images: swatch (SKU-level primary) + room scenes (product-level lifestyle)
 *
 * It does NOT create new SKUs — the EDI 832 importer is the source of truth
 * for SKU creation. Instead, it matches CSV colors to existing EDI SKUs by
 * style code + variant_name (color name).
 *
 * Usage:
 *   docker compose exec api node scripts/import-engfloors-catalog.js
 *   docker compose exec api node scripts/import-engfloors-catalog.js /path/to/custom.csv
 */

import pg from 'pg';
import fs from 'fs';

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

const VENDOR_CODE = 'EF';

// Category mapping
const CATEGORY_MAP = {
  'Carpet':       'carpet-tile',
  'Hard Surface': 'luxury-vinyl',
};

// ==================== Helpers ====================

function slugify(text) {
  return text.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
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
  // Refresh full-text search vectors
  pool.query('SELECT refresh_search_vectors($1)', [result.rows[0].id]).catch(() => {});
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
    ON CONFLICT (sku_id) DO NOTHING
  `, [sku_id, cost, retail_price, price_basis || 'per_sqft']);
}

async function setAttr(sku_id, slug, value) {
  if (!value || !value.trim()) return;
  const attr = await pool.query('SELECT id FROM attributes WHERE slug = $1', [slug]);
  if (!attr.rows.length) return;
  await pool.query(`
    INSERT INTO sku_attributes (sku_id, attribute_id, value)
    VALUES ($1, $2, $3)
    ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value = EXCLUDED.value
  `, [sku_id, attr.rows[0].id, String(value).trim()]);
}

async function upsertMediaAsset({ product_id, sku_id, asset_type, url, sort_order }) {
  if (url && url.startsWith('http://')) url = url.replace('http://', 'https://');
  const at = asset_type || 'primary';
  const so = sort_order || 0;

  if (sku_id) {
    await pool.query(`
      INSERT INTO media_assets (product_id, sku_id, asset_type, url, sort_order)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (product_id, sku_id, asset_type, sort_order) WHERE sku_id IS NOT NULL DO UPDATE SET
        url = EXCLUDED.url
      RETURNING id
    `, [product_id, sku_id, at, url, so]);
  } else {
    await pool.query(`
      INSERT INTO media_assets (product_id, sku_id, asset_type, url, sort_order)
      VALUES ($1, NULL, $2, $3, $4)
      ON CONFLICT (product_id, asset_type, sort_order) WHERE sku_id IS NULL DO UPDATE SET
        url = EXCLUDED.url
      RETURNING id
    `, [product_id, at, url, so]);
  }
}

// ==================== CSV Parsing (no external deps) ====================

function parseCSV(filePath) {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const lines = [];
  let current = '';
  let inQuotes = false;

  // Handle quoted fields that span multiple lines
  for (const char of raw) {
    if (char === '"') {
      inQuotes = !inQuotes;
      current += char;
    } else if (char === '\n' && !inQuotes) {
      if (current.trim()) lines.push(current);
      current = '';
    } else if (char === '\r') {
      // skip CR
    } else {
      current += char;
    }
  }
  if (current.trim()) lines.push(current);

  if (lines.length < 2) return [];

  // Parse a single CSV line into fields (handles quoted fields with commas)
  function parseLine(line) {
    const fields = [];
    let field = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quoted) {
        if (ch === '"' && line[i + 1] === '"') {
          field += '"'; i++; // escaped quote
        } else if (ch === '"') {
          quoted = false;
        } else {
          field += ch;
        }
      } else {
        if (ch === '"') {
          quoted = true;
        } else if (ch === ',') {
          fields.push(field.trim());
          field = '';
        } else {
          field += ch;
        }
      }
    }
    fields.push(field.trim());
    return fields;
  }

  const headers = parseLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = parseLine(lines[i]);
    const obj = {};
    for (let j = 0; j < headers.length; j++) {
      obj[headers[j]] = vals[j] || '';
    }
    rows.push(obj);
  }
  return rows;
}

/**
 * Group flat CSV rows into a product → colors → images structure.
 *
 * Returns Map<productSku, {
 *   sku, name, brand, productType, url,
 *   backing, color, construction, fiberBrand, collection, finish, installMethod, shade,
 *   colors: Map<colorName, { swatches: [], roomScenes: [], sampleSize }>
 * }>
 */
function groupRows(rows) {
  const products = new Map();

  for (const row of rows) {
    if (row['Availability'] !== 'Yes') continue;

    const productSku = row['Product SKU'];
    const productName = row['Product Name'];
    const colorName = row['Color Name'];
    const imageType = row['Image Type'];
    const imageUrl = row['Image Sample URL'];

    if (!productSku || !productName) continue;

    // Get or create product entry
    if (!products.has(productSku)) {
      products.set(productSku, {
        sku: productSku,
        name: productName,
        brand: row['Brand'],
        productType: row['Product Type'],
        url: row['Product URL'],
        backing: row['Backing'],
        color: row['Color'],           // product-level color family (e.g., "Gray, Taupe, Multicolor")
        construction: row['Construction'],
        fiberBrand: row['Fiber Brand'],
        collection: row['Collection'],
        finish: row['Finish'],
        installMethod: row['Installation Method'],
        shade: row['Shade'],
        colors: new Map(),
      });
    }

    const product = products.get(productSku);

    // Get or create color entry
    if (!product.colors.has(colorName)) {
      product.colors.set(colorName, {
        swatches: [],
        roomScenes: [],
        sampleSize: null,
      });
    }

    const colorEntry = product.colors.get(colorName);

    if (imageUrl) {
      if (imageType === 'Swatch') {
        colorEntry.swatches.push(imageUrl);
        if (row['Image Sample Size']) {
          colorEntry.sampleSize = row['Image Sample Size'];
        }
      } else if (imageType === 'Room Scene') {
        colorEntry.roomScenes.push(imageUrl);
      }
    }
  }

  return products;
}

// ==================== Main Import ====================

async function main() {
  const csvPath = process.argv[2] || '/app/data/EF_Full_Product_Catalog.csv';

  if (!fs.existsSync(csvPath)) {
    console.error(`CSV file not found: ${csvPath}`);
    console.error('Usage: node scripts/import-engfloors-catalog.js [path/to/csv]');
    console.error('Default location: /app/data/EF_Full_Product_Catalog.csv');
    console.error('  Copy the CSV into backend/data/ and rebuild, or pass the path directly.');
    process.exit(1);
  }

  console.log(`Reading CSV: ${csvPath}`);
  const rows = parseCSV(csvPath);
  console.log(`Parsed ${rows.length} rows`);

  const products = groupRows(rows);
  console.log(`Grouped into ${products.size} products\n`);

  // ── Resolve vendor ──
  const vendorResult = await pool.query('SELECT id FROM vendors WHERE code = $1', [VENDOR_CODE]);
  let vendorId;
  if (!vendorResult.rows.length) {
    const ins = await pool.query(
      `INSERT INTO vendors (name, code, website) VALUES ($1, $2, $3) RETURNING id`,
      ['Engineered Floors', VENDOR_CODE, 'https://www.engineeredfloors.com']
    );
    vendorId = ins.rows[0].id;
    console.log(`Created vendor: Engineered Floors (${vendorId})`);
  } else {
    vendorId = vendorResult.rows[0].id;
    console.log(`Using existing vendor: EF (${vendorId})`);
  }

  // ── Resolve categories ──
  const catResult = await pool.query('SELECT id, slug FROM categories');
  const catMap = {};
  for (const row of catResult.rows) catMap[row.slug] = row.id;

  // ── Pre-cache attribute IDs ──
  const attrResult = await pool.query('SELECT id, slug FROM attributes');
  const attrExists = new Set(attrResult.rows.map(r => r.slug));
  console.log(`Attribute slugs available: ${[...attrExists].join(', ')}\n`);

  // ── Pre-load ALL EF SKUs for matching ──
  // EDI-created SKUs have vendor_sku like '1-{styleCode}-{colorCode}-{size}-{back}'
  // We match CSV colors to EDI SKUs by style code + variant_name (color name)
  const allSkusRes = await pool.query(`
    SELECT s.id, s.vendor_sku, s.internal_sku, s.variant_name, s.product_id
    FROM skus s
    JOIN products p ON s.product_id = p.id
    WHERE p.vendor_id = $1 AND s.status = 'active'
      AND (s.variant_type IS NULL OR s.variant_type = '')
  `, [vendorId]);

  // Build lookup: styleCode → { normalizedColorName → [sku rows] }
  const ediSkuIndex = {};
  for (const sku of allSkusRes.rows) {
    const parts = sku.vendor_sku.split('-');
    if (parts.length < 3) continue;
    const styleCode = parts[1];
    if (!ediSkuIndex[styleCode]) ediSkuIndex[styleCode] = {};
    const normColor = (sku.variant_name || '').toLowerCase().trim();
    if (!ediSkuIndex[styleCode][normColor]) ediSkuIndex[styleCode][normColor] = [];
    ediSkuIndex[styleCode][normColor].push(sku);
  }
  console.log(`Pre-loaded ${allSkusRes.rows.length} EDI SKUs for matching\n`);

  // ── Counters ──
  let productsCreated = 0, productsUpdated = 0;
  let skusMatched = 0, skusUnmatched = 0;
  let imagesCreated = 0;
  let attrsSet = 0;

  // ── Iterate products ──
  for (const [productSku, prod] of products) {
    const categorySlug = CATEGORY_MAP[prod.productType];
    const categoryId = categorySlug ? (catMap[categorySlug] || null) : null;

    // Collection = brand (DreamWeaver, PureGrain HD, etc.)
    const collection = prod.brand || '';

    // Build description
    const descParts = [];
    if (prod.construction) descParts.push(prod.construction);
    if (prod.fiberBrand) descParts.push(prod.fiberBrand);
    if (prod.backing) descParts.push(prod.backing);
    const descShort = descParts.length ? descParts.join(' | ') : null;

    // Upsert product (always update descriptions)
    const prodRec = await upsertProduct(vendorId, {
      name: prod.name,
      collection,
      category_id: categoryId,
      description_short: descShort,
    });
    if (prodRec.is_new) productsCreated++; else productsUpdated++;

    const productId = prodRec.id;

    // Collect all room scenes across colors for product-level lifestyle images
    const allRoomScenes = new Set();

    // Look up EDI SKUs for this product's style code
    const styleSkus = ediSkuIndex[productSku] || {};

    // ── Iterate colors ──
    for (const [colorName, colorData] of prod.colors) {
      const normColor = colorName.toLowerCase().trim();

      // Match to existing EDI SKU by color name
      // The EDI SKUs may have multiple entries per color (different sizes/variants)
      // We want to enrich ALL matching SKUs with attributes
      const matchedSkus = styleSkus[normColor] || [];

      if (matchedSkus.length === 0) {
        skusUnmatched++;
        // Still collect room scenes even if no SKU match
        for (const rsUrl of colorData.roomScenes) {
          allRoomScenes.add(rsUrl);
        }
        continue;
      }

      skusMatched += matchedSkus.length;

      // ── Swatch → SKU-level primary image (use first matching SKU) ──
      // Apply swatch to ALL matching SKUs for this color
      for (const sku of matchedSkus) {
        for (let i = 0; i < colorData.swatches.length; i++) {
          await upsertMediaAsset({
            product_id: productId,
            sku_id: sku.id,
            asset_type: i === 0 ? 'primary' : 'alternate',
            url: colorData.swatches[i],
            sort_order: i,
          });
          imagesCreated++;
        }

        // ── Attributes — set on ALL matching EDI SKUs ──
        await setAttr(sku.id, 'color', colorName);
        attrsSet++;

        if (prod.construction) { await setAttr(sku.id, 'construction', prod.construction); attrsSet++; }
        if (prod.backing) { await setAttr(sku.id, 'material', prod.backing); attrsSet++; }
        if (prod.fiberBrand) { await setAttr(sku.id, 'fiber_brand', prod.fiberBrand); attrsSet++; }
        if (prod.finish) { await setAttr(sku.id, 'finish', prod.finish); attrsSet++; }
        if (prod.shade) { await setAttr(sku.id, 'shade', prod.shade); attrsSet++; }
        if (prod.installMethod) { await setAttr(sku.id, 'installation_method', prod.installMethod); attrsSet++; }
        if (prod.collection) { await setAttr(sku.id, 'collection', prod.collection); attrsSet++; }
      }

      // ── Room scenes → product-level lifestyle (deduplicated below) ──
      for (const rsUrl of colorData.roomScenes) {
        allRoomScenes.add(rsUrl);
      }
    }

    // ── Product-level lifestyle images (room scenes, deduplicated) ──
    let rsIndex = 0;
    for (const rsUrl of allRoomScenes) {
      await upsertMediaAsset({
        product_id: productId,
        sku_id: null,
        asset_type: 'lifestyle',
        url: rsUrl,
        sort_order: rsIndex,
      });
      imagesCreated++;
      rsIndex++;
    }

    // Log progress
    const matchCount = Object.values(styleSkus).flat().length;
    const unmatchedColors = [...prod.colors.keys()].filter(c => !(styleSkus[c.toLowerCase().trim()] || []).length);
    const marker = prodRec.is_new ? '+' : '~';
    console.log(`  ${marker} ${prod.name} (${productSku}) — ${prod.colors.size} colors, ${matchCount} EDI SKUs matched, ${unmatchedColors.length} unmatched | ${prod.brand}`);
  }

  // ── Summary ──
  console.log('\n=== Engineered Floors Catalog Enrichment Complete ===');
  console.log(`Products: ${productsCreated} created, ${productsUpdated} updated`);
  console.log(`SKUs:     ${skusMatched} enriched (matched to EDI), ${skusUnmatched} CSV colors with no EDI match`);
  console.log(`Images:   ${imagesCreated} upserted`);
  console.log(`Attrs:    ${attrsSet} set`);

  await pool.end();
}

main().catch(err => {
  console.error('Import failed:', err);
  process.exit(1);
});
