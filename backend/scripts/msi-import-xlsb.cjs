#!/usr/bin/env node
/**
 * MSI Import from XLSB Price List
 *
 * Imports MSI products/SKUs from backend/data/msi-pricelist-jan26.xlsb
 * into the database with pricing, packaging, and attributes.
 *
 * Usage:
 *   node backend/scripts/msi-import-xlsb.cjs --dry-run   # Preview
 *   node backend/scripts/msi-import-xlsb.cjs              # Execute
 */

const { Pool } = require('pg');
const xlsx = require('xlsx');
const path = require('path');

const DRY_RUN = process.argv.includes('--dry-run');
const VERBOSE = process.argv.includes('--verbose');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

const XLSB_PATH = path.resolve(__dirname, '..', 'data', 'msi-pricelist-jan26.xlsb');

// ─── Section → category slug mapping ────────────────────────────────────────

const SECTION_CATEGORY_MAP = {
  'BACKSPLASH/WALL TILE/DECORATIVE MOSAICS': 'mosaic-tile',
  'BACKSPLASH/WALL TILE/DECORATIVE MOSAICS - DOMINO COLLECTION': 'mosaic-tile',
  'BACKSPLASH/WALL TILE/DECORATIVE MOSAICS - HIGHLAND PARK COLLECTION': 'mosaic-tile',
  'BACKSPLASH/WALL TILE/DECORATIVE MOSAICS - RIO LAGO COLLECTION': 'mosaic-tile',
  'CERAMICS/PORCELAIN FLOOR TILES': 'porcelain-tile',
  'EVERLIFE LUXURY VINYL TILE (LVT) - DRYBACK': 'lvp-plank',
  'EVERLIFE LUXURY VINYL TILE (LVT) - HYBRID RIGIDCORE': 'lvp-plank',
  'EVERLIFE LUXURY VINYL TILE (LVT) - RIGIDCORE': 'lvp-plank',
  'EVERLIFE LUXURY VINYL TILE (LVT) - WATERPROOF WOOD': 'waterproof-wood',
  'EVERLIFE LUXURY VINYL TILE (LVT) - STUDIO COLLECTIONS': 'lvp-plank',
  'EVERLIFE LUXURY VINYL TILE (LVT) - WAYNE PARC COLLECTIONS': 'lvp-plank',
  'EVERLIFE LUXURY VINYL TILE (LVT) - TRIMS/ADHESIVE': 'lvp-plank',
  'W LUXURY GENUINE HARDWOOD': 'engineered-hardwood',
  'W LUXURY GENUINE HARDWOOD - TRIMS/ADHESIVE': 'engineered-hardwood',
  'NATURAL STONE GRANITE COLLECTIONS': 'natural-stone',
  'NATURAL STONE GRANITE TILE COLLECTION': 'natural-stone',
  'NATURAL STONE LIMESTONE TILE COLLECTION': 'natural-stone',
  'NATURAL STONE MARBLE COLLECTIONS': 'natural-stone',
  'NATURAL STONE SLATE/QUARTZITE COLLECTIONS': 'natural-stone',
  'NATURAL STONE TRAVERTINE COLLECTIONS': 'natural-stone',
  'STACKED STONE – DEKORA PORCELAIN PANELS': 'stacked-stone',
  'STACKED STONE – M SERIES': 'stacked-stone',
  'STACKED STONE – ROCKMOUNT NATURAL STONES': 'stacked-stone',
  'STACKED STONE – XL ROCKMOUNT NATURAL STONES': 'stacked-stone',
  'ROCKMOUNT  VENEERS NATURAL STONES': 'stacked-stone',
  'STACKED STONE - TERRADO MANUFACTURED STONES': 'stacked-stone',
  'SINKS': null,
  'SINK ACCESSORIES / FAUCETS': null,
  'THRESHOLDS AND SILLS': null,
};

// Categories that sell by sqft
const SQFT_CATEGORIES = new Set([
  'lvp-plank', 'engineered-hardwood', 'waterproof-wood',
  'porcelain-tile', 'natural-stone', 'mosaic-tile', 'stacked-stone',
]);

// ─── Product name parsing ────────────────────────────────────────────────────

// Trim codes → accessory detection
const TRIM_SUFFIXES = {
  '-FSNL-EE': 'Flush Stair Nose Long', '-FSNL': 'Flush Stair Nose Long',
  '-FSN-EE': 'Flush Stair Nose', '-FSN': 'Flush Stair Nose',
  '-OSN': 'Overlapping Stair Nose',
  '-ECL': 'End Cap Long', '-EC': 'End Cap',
  '-SRL': 'Reducer Long', '-SR': 'Reducer',
  '-QR': 'Quarter Round',
  '-ST-EE': 'Stair Tread', '-ST': 'Stair Tread',
  '-RT': 'Riser Tread',
  '-T-SR': 'T-Molding Reducer', '-T': 'T-Molding',
  '-4-IN-1': '4-in-1 Transition',
};
const TRIM_SUFFIX_KEYS = Object.keys(TRIM_SUFFIXES).sort((a, b) => b.length - a.length);

function isAccessorySku(vendorSku) {
  const upper = vendorSku.toUpperCase();
  // VTT = Vinyl Trim Tile (actual accessory). TT = Travertine Tile (regular product, NOT trim).
  return upper.startsWith('VTT') || upper.startsWith('P-VTT');
}

function getTrimName(vendorSku) {
  const upper = vendorSku.toUpperCase();
  for (const suffix of TRIM_SUFFIX_KEYS) {
    if (upper.endsWith(suffix)) return TRIM_SUFFIXES[suffix];
  }
  return 'Trim';
}

/**
 * Extract collection and color from the PRODUCT COLLECTION field.
 * "ANDOVER ABINGDALE 7x48" → collection: "Andover", color: "Abingdale"
 * "CALACATTA CREMO 12X24" → collection: "Calacatta Cremo", color: null
 */
function parseProductName(fullName, vendorSku, section) {
  let name = fullName.trim();

  // Strip size from end: "ANDOVER ABINGDALE 7x48" → "ANDOVER ABINGDALE"
  name = name.replace(/\s+\d+\.?\d*\s*[xX×]\s*\d+\.?\d*\s*$/, '').trim();
  // Strip packaging info: "( 15 Sf Per Box )" etc
  name = name.replace(/\s*\(.*?\)\s*$/, '').trim();
  // Strip "MATTE", "POLISHED", "HONED" from end
  name = name.replace(/\s+(MATTE|POLISHED|HONED|GLOSSY|SATIN|BRUSHED|TUMBLED|TEXTURED|LOW GLOSS|LAPPATO)\s*$/i, '').trim();

  // Title case
  name = name.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());

  // For LVP: first word(s) are collection, last word is color
  // "Andover Abingdale" → collection "Andover", product name "Abingdale"
  // "Xl Cyrus Barrell" → collection "XL Cyrus", product name "Barrell"
  const isLvp = section && section.includes('VINYL');
  const isHardwood = section && section.includes('HARDWOOD');
  const isTrim = section && section.includes('TRIM');

  if (isTrim && isAccessorySku(vendorSku)) {
    // Accessories: use parent collection name
    // "ANDOVER ABINGDALE EC 94" → collection "Andover", variant "End Cap"
    return { collection: '', productName: name, isAccessory: true };
  }

  if (isLvp || isHardwood) {
    const words = name.split(/\s+/);
    // Handle XL prefix: "Xl Cyrus Barrell" → coll="XL Cyrus"
    let collWords = 1;
    if (words[0] && words[0].toLowerCase() === 'xl' && words.length > 2) collWords = 2;
    if (words[0] && words[0].toLowerCase() === 'xxl' && words.length > 2) collWords = 2;
    if (words.length > collWords) {
      const collection = words.slice(0, collWords).join(' ');
      const color = words.slice(collWords).join(' ');
      return { collection, productName: color, isAccessory: false };
    }
  }

  // For tile/stone: try to extract collection from name
  // "Adella Gris" → collection might be "Adella"
  // "Calacatta Cremo" → collection "Calacatta Cremo"
  // These are harder — use the full name as both collection and name
  const words = name.split(/\s+/);
  if (words.length >= 2) {
    return { collection: words[0], productName: name, isAccessory: false };
  }

  return { collection: '', productName: name, isAccessory: false };
}

// ─── DB upserts ──────────────────────────────────────────────────────────────

async function upsertProduct(vendorId, categoryId, collection, name, webLink) {
  if (DRY_RUN) return 'dry-run-pid';
  const { rows } = await pool.query(`
    INSERT INTO products (vendor_id, category_id, collection, name, status, is_active, created_at, updated_at)
    VALUES ($1, $2, $3, $4, 'active', true, NOW(), NOW())
    ON CONFLICT (vendor_id, collection, name)
    DO UPDATE SET category_id = COALESCE(EXCLUDED.category_id, products.category_id),
                  status = 'active', is_active = true, updated_at = NOW()
    RETURNING id
  `, [vendorId, categoryId, collection || '', name]);
  return rows[0].id;
}

async function upsertSkuRow(productId, vendorSku, internalSku, variantName, variantType, sellBy) {
  if (DRY_RUN) return 'dry-run-sid';
  const { rows } = await pool.query(`
    INSERT INTO skus (product_id, vendor_sku, internal_sku, variant_name, variant_type, sell_by, status, created_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, 'active', NOW(), NOW())
    ON CONFLICT (internal_sku)
    DO UPDATE SET product_id = $1, vendor_sku = $2, variant_name = $4, variant_type = $5,
                  sell_by = $6, status = 'active', updated_at = NOW()
    RETURNING id
  `, [productId, vendorSku, internalSku, variantName, variantType, sellBy]);
  return rows[0].id;
}

async function upsertPricing(skuId, cost, retailPrice, mapPrice) {
  if (DRY_RUN) return;
  // retail_price is NOT NULL — if missing, derive from cost with 1.6x markup (rounded to nickel)
  const c = parseFloat(cost) || 0;
  const r = parseFloat(retailPrice) || (Math.round(c * 1.6 / 0.05) * 0.05) || 0;
  await pool.query(`
    INSERT INTO pricing (sku_id, cost, retail_price, map_price, created_at)
    VALUES ($1, $2, $3, $4, NOW())
    ON CONFLICT (sku_id)
    DO UPDATE SET cost = $2, retail_price = $3, map_price = COALESCE($4, pricing.map_price)
  `, [skuId, c, r, mapPrice || null]);
}

async function upsertPackaging(skuId, piecesPerBox, sqftPerBox) {
  if (DRY_RUN) return;
  await pool.query(`
    INSERT INTO packaging (sku_id, pieces_per_box, sqft_per_box, created_at)
    VALUES ($1, $2, $3, NOW())
    ON CONFLICT (sku_id)
    DO UPDATE SET pieces_per_box = COALESCE($2, packaging.pieces_per_box),
                  sqft_per_box = COALESCE($3, packaging.sqft_per_box)
  `, [skuId, piecesPerBox || null, sqftPerBox || null]);
}

async function upsertAttribute(skuId, slug, value) {
  if (DRY_RUN || !value) return;
  let { rows } = await pool.query(`SELECT id FROM attributes WHERE slug = $1`, [slug]);
  let attrId;
  if (rows.length > 0) {
    attrId = rows[0].id;
  } else {
    const res = await pool.query(
      `INSERT INTO attributes (name, slug, data_type, created_at, updated_at)
       VALUES ($1, $2, 'text', NOW(), NOW()) ON CONFLICT (slug) DO UPDATE SET updated_at = NOW() RETURNING id`,
      [slug.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()), slug]
    );
    attrId = res.rows[0].id;
  }
  await pool.query(`
    INSERT INTO sku_attributes (sku_id, attribute_id, value)
    VALUES ($1, $2, $3)
    ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value = $3
  `, [skuId, attrId, value]);
}

async function saveImageUrl(productId, skuId, url, assetType, sortOrder) {
  if (DRY_RUN || !url) return;
  await pool.query(`
    INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order, created_at, updated_at)
    VALUES ($1, $2, $3, $4, $4, $5, NOW(), NOW())
    ON CONFLICT DO NOTHING
  `, [productId, skuId, assetType, url, sortOrder]);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const startTime = Date.now();
  const log = (msg) => {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[${elapsed}s] ${msg}`);
  };

  log(`MSI Import from XLSB${DRY_RUN ? ' (DRY RUN)' : ''}`);
  log('═'.repeat(60));

  // Get vendor
  const { rows: [vendor] } = await pool.query(`SELECT id FROM vendors WHERE code = 'MSI'`);
  if (!vendor) { log('ERROR: MSI vendor not found'); return; }
  const vendorId = vendor.id;

  // Load category cache
  const catCache = {};
  const { rows: cats } = await pool.query(`SELECT id, slug FROM categories`);
  for (const c of cats) catCache[c.slug] = c.id;

  // First delete the 8 stale products from the failed EDI import
  log('Cleaning up stale EDI import data...');
  if (!DRY_RUN) {
    const { rows: staleProducts } = await pool.query(
      `SELECT id FROM products WHERE vendor_id = $1`, [vendorId]
    );
    if (staleProducts.length > 0) {
      const ids = staleProducts.map(r => r.id);
      const { rows: staleSkus } = await pool.query(
        `SELECT id FROM skus WHERE product_id = ANY($1)`, [ids]
      );
      const skuIds = staleSkus.map(r => r.id);
      if (skuIds.length > 0) {
        await pool.query(`DELETE FROM sku_attributes WHERE sku_id = ANY($1)`, [skuIds]);
        await pool.query(`DELETE FROM pricing WHERE sku_id = ANY($1)`, [skuIds]);
        await pool.query(`DELETE FROM packaging WHERE sku_id = ANY($1)`, [skuIds]);
        await pool.query(`DELETE FROM media_assets WHERE sku_id = ANY($1)`, [skuIds]);
        await pool.query(`DELETE FROM skus WHERE id = ANY($1)`, [skuIds]);
      }
      await pool.query(`DELETE FROM media_assets WHERE product_id = ANY($1)`, [ids]);
      await pool.query(`DELETE FROM products WHERE id = ANY($1)`, [ids]);
      log(`  Removed ${ids.length} stale products, ${skuIds.length} SKUs`);
    }
  }

  // Read XLSB
  log(`Reading ${XLSB_PATH}...`);
  const wb = xlsx.readFile(XLSB_PATH);
  const ws = wb.Sheets['PriceList'];
  const data = xlsx.utils.sheet_to_json(ws, { header: 1 });
  log(`  ${data.length} total rows`);

  // Parse rows
  let currentSection = '';
  let productsCreated = 0, productsUpdated = 0;
  let skusCreated = 0, skusUpdated = 0;
  let pricingCount = 0, packagingCount = 0, attrCount = 0;
  let skippedSections = 0;
  const productCache = new Map(); // "collection|||name" → productId

  for (let i = 5; i < data.length; i++) {
    const row = data[i];
    if (!row || !row[0]) continue;

    // Section header (no item number)
    if (!row[1]) {
      currentSection = String(row[0]).trim();
      continue;
    }

    const fullName = String(row[0]).trim();
    const vendorSku = String(row[1]).trim();
    const size = row[2] ? String(row[2]).trim() : null;
    const finish = row[3] ? String(row[3]).trim() : null;
    const thickness = row[4] ? String(row[4]).trim() : null;
    const sqftPerPiece = row[5] ? parseFloat(row[5]) : null;
    const piecesPerBox = row[6] ? parseInt(row[6], 10) : null;
    const sqftPerBox = row[7] ? parseFloat(row[7]) : null;
    const uom = row[8] ? String(row[8]).trim() : null;
    const pricePerUom = row[9] ? parseFloat(row[9]) : null;
    const priceEach = row[10] ? parseFloat(row[10]) : null;
    const priceBox = row[11] ? parseFloat(row[11]) : null;
    const webLink = row[16] ? String(row[16]).trim() : null;

    // Map section to category
    const categorySlug = SECTION_CATEGORY_MAP[currentSection];
    if (categorySlug === undefined) {
      // Unknown section — skip
      if (VERBOSE) log(`  Skipping unknown section: ${currentSection}`);
      skippedSections++;
      continue;
    }
    if (categorySlug === null) {
      // Explicitly skipped sections (sinks, faucets, thresholds)
      continue;
    }

    const categoryId = catCache[categorySlug] || null;

    // Parse product name
    const parsed = parseProductName(fullName, vendorSku, currentSection);
    const isAcc = parsed.isAccessory || isAccessorySku(vendorSku);
    const collection = parsed.collection;
    const productName = parsed.productName;

    if (!productName) continue;

    // Group SKUs into products by collection + productName
    const productKey = `${collection}|||${productName}`;
    let productId = productCache.get(productKey);

    if (!productId) {
      productId = await upsertProduct(vendorId, categoryId, collection, productName, webLink);
      productCache.set(productKey, productId);
      productsCreated++;
    } else {
      productsUpdated++;
    }

    // Determine variant info
    const internalSku = `MSI-${vendorSku}`;
    let variantName = null;
    let variantType = null;
    const sellBy = isAcc ? 'unit' : (SQFT_CATEGORIES.has(categorySlug) ? 'sqft' : 'unit');

    if (isAcc) {
      variantType = 'accessory';
      variantName = getTrimName(vendorSku);
    } else {
      // Use size as variant name, or size+finish
      const parts = [];
      if (size && size !== 'MISC.') parts.push(size);
      if (finish && finish !== 'MISC.' && finish !== 'N/A') parts.push(finish.toLowerCase().replace(/\b\w/g, c => c.toUpperCase()));
      variantName = parts.join(' ') || null;
    }

    // Extract color from product name for non-accessories
    let color = null;
    if (!isAcc && parsed.productName) {
      color = parsed.productName;
    }

    const skuId = await upsertSkuRow(productId, vendorSku, internalSku, variantName, variantType, sellBy);
    skusCreated++;

    // Pricing — pricePerUom = dealer cost, priceEach = retail per piece
    if (pricePerUom || priceEach) {
      await upsertPricing(skuId, pricePerUom, priceEach, null);
      pricingCount++;
    }

    // Packaging
    if (piecesPerBox || sqftPerBox) {
      await upsertPackaging(skuId, piecesPerBox, sqftPerBox);
      packagingCount++;
    }

    // Attributes (color + finish stored here since skus table doesn't have those columns)
    if (color) { await upsertAttribute(skuId, 'color', color); attrCount++; }
    if (finish && finish !== 'MISC.' && finish !== 'N/A') { await upsertAttribute(skuId, 'finish', finish); attrCount++; }
    if (size && size !== 'MISC.') { await upsertAttribute(skuId, 'size', size); attrCount++; }
    if (thickness && thickness !== 'N/A') { await upsertAttribute(skuId, 'thickness', thickness); attrCount++; }

    if ((skusCreated % 200) === 0) {
      log(`  Progress: ${skusCreated} SKUs, ${productsCreated} products...`);
    }
  }

  // Summary
  log('\n' + '═'.repeat(60));
  log(`IMPORT COMPLETE${DRY_RUN ? ' (DRY RUN)' : ''}`);
  log(`  Products created: ${productsCreated}`);
  log(`  SKUs created:     ${skusCreated}`);
  log(`  Pricing records:  ${pricingCount}`);
  log(`  Packaging records: ${packagingCount}`);
  log(`  Attributes:       ${attrCount}`);
  if (skippedSections > 0) log(`  Skipped (unknown sections): ${skippedSections}`);
  log(`  Total time: ${((Date.now() - startTime) / 1000).toFixed(1)}s`);

  await pool.end();
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
