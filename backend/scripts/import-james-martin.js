#!/usr/bin/env node
/**
 * James Martin Vanities — XLSX Import Script
 *
 * Imports the "Etail Feed" XLSX (8,104 SKUs, 232 columns) into the PIM.
 *
 * Usage:
 *   node backend/scripts/import-james-martin.js --file ~/Downloads/james-martin.xlsx
 *   node backend/scripts/import-james-martin.js --file ~/Downloads/james-martin.xlsx --dry-run
 *   node backend/scripts/import-james-martin.js --file ~/Downloads/james-martin.xlsx --limit 50
 */

import XLSX from 'xlsx';
import pg from 'pg';
import fs from 'fs';

const { Pool } = pg;

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
function flag(name) { return args.includes(`--${name}`); }
function opt(name) {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : null;
}

const filePath = opt('file');
const dryRun = flag('dry-run');
const limit = opt('limit') ? parseInt(opt('limit'), 10) : null;

if (!filePath) {
  console.error('Usage: node import-james-martin.js --file <path.xlsx> [--dry-run] [--limit N]');
  process.exit(1);
}
if (!fs.existsSync(filePath)) {
  console.error(`File not found: ${filePath}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// DB connection
// ---------------------------------------------------------------------------
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

// ---------------------------------------------------------------------------
// Category tree
// ---------------------------------------------------------------------------
const CATEGORY_TREE = [
  { name: 'Bath', slug: 'bath', parent: null, sort: 12 },
  { name: 'Vanities', slug: 'vanities', parent: 'bath', sort: 1 },
  { name: 'Mirrors', slug: 'bath-mirrors', parent: 'bath', sort: 2 },
  { name: 'Storage Cabinets', slug: 'storage-cabinets', parent: 'bath', sort: 3 },
  { name: 'Bath Accessories', slug: 'bath-accessories', parent: 'bath', sort: 4 },
];

const PRODUCT_TYPE_CATEGORY = {
  'Vanity': 'vanities',
  'Console': 'vanities',
  'Floating Console': 'vanities',
  'Console Base': 'vanities',
  'Top': 'vanity-tops',
  'Backsplash': 'vanity-tops',
  'Mirror': 'bath-mirrors',
  'Cabinet': 'storage-cabinets',
  'Side Cabinet': 'storage-cabinets',
  'Linen Cabinet': 'storage-cabinets',
  'Storage Cabinet': 'storage-cabinets',
};
const DEFAULT_CATEGORY = 'bath-accessories';

// ---------------------------------------------------------------------------
// Attributes to create
// ---------------------------------------------------------------------------
const NEW_ATTRIBUTES = [
  { slug: 'width', name: 'Width', display_order: 20 },
  { slug: 'height', name: 'Height', display_order: 21 },
  { slug: 'depth', name: 'Depth', display_order: 22 },
  { slug: 'weight', name: 'Weight', display_order: 23 },
  { slug: 'countertop_material', name: 'Countertop Material', display_order: 24 },
  { slug: 'countertop_finish', name: 'Countertop Finish', display_order: 25 },
  { slug: 'hardware_finish', name: 'Hardware Finish', display_order: 26 },
  { slug: 'vanity_type', name: 'Vanity Type', display_order: 27 },
  { slug: 'num_doors', name: 'Number of Doors', display_order: 28 },
  { slug: 'num_drawers', name: 'Number of Drawers', display_order: 29 },
  { slug: 'num_shelves', name: 'Number of Shelves', display_order: 30 },
  { slug: 'soft_close', name: 'Soft Close', display_order: 31 },
  { slug: 'num_sinks', name: 'Number of Sinks', display_order: 32 },
  { slug: 'sink_type', name: 'Sink Installation Type', display_order: 33 },
  { slug: 'sink_material', name: 'Sink Material', display_order: 34 },
  { slug: 'bowl_shape', name: 'Bowl Shape', display_order: 35 },
  { slug: 'style', name: 'Style', display_order: 36 },
  { slug: 'upc', name: 'UPC', display_order: 37, filterable: false },
  { slug: 'msrp', name: 'MSRP', display_order: 38, filterable: false },
  { slug: 'optional_accessories', name: 'Optional Accessories', display_order: 39, filterable: false },
  { slug: 'top_ref_sku', name: 'Top Reference SKU', display_order: 40, filterable: false },
  { slug: 'sink_ref_sku', name: 'Sink Reference SKU', display_order: 41, filterable: false },
  { slug: 'group_number', name: 'Group Number', display_order: 42, filterable: false },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function parsePrice(val) {
  if (val == null || val === '') return null;
  const n = parseFloat(String(val).replace(/[$,]/g, ''));
  return isNaN(n) ? null : n;
}

function col(row, name) {
  // Try exact match first, then try with trailing space (XLSX has some)
  let v = row[name];
  if (v === undefined) v = row[name + ' '];
  if (v == null || String(v).trim() === '') return null;
  return String(v).trim();
}

function deriveProductName(row) {
  const collection = col(row, 'Collection Name') || '';
  const type = col(row, 'Product Type') || '';
  const width = col(row, 'Product Width');

  // If no collection name, fall back to Product Name
  if (!collection) return col(row, 'Product Name') || 'Unknown Product';

  const vanityTypes = ['Vanity', 'Cabinet', 'Side Cabinet', 'Linen Cabinet',
    'Storage Cabinet', 'Console', 'Floating Console', 'Console Base'];

  if (vanityTypes.includes(type) && width) return `${collection} ${width}" ${type}`;
  if (type === 'Top' && width) return `${collection} ${width}" Top`;
  if (type === 'Backsplash' && width) return `${collection} ${width}" Backsplash`;
  if (['Mirror', 'Shelf'].includes(type)) return `${collection} ${type}`;
  if (type) return `${collection} ${type}`;
  return col(row, 'Product Name') || `${collection} Unknown`;
}

function deriveVariantName(row) {
  const parts = [];
  const base = col(row, 'Vanity Base Color/Finish');
  if (base) parts.push(base);
  const ct = col(row, 'Countertop Finish');
  if (ct) parts.push(ct);
  return parts.length ? parts.join(', ') : col(row, 'Product Name') || 'Default';
}

function buildDescription(row) {
  const para = col(row, 'One Paragraph Product Description') || '';
  const bullets = [];
  for (let i = 1; i <= 12; i++) {
    const b = col(row, `Bullet Feature ${i}`);
    if (b) bullets.push(b);
  }
  const short = para.slice(0, 500);
  const long = bullets.length
    ? para + '\n\n' + bullets.map(b => `• ${b}`).join('\n')
    : para;
  return { short, long };
}

function getCategorySlug(row) {
  const type = col(row, 'Product Type') || '';
  return PRODUCT_TYPE_CATEGORY[type] || DEFAULT_CATEGORY;
}

function getVariantType(row) {
  const gc = col(row, 'Group/Component') || col(row, 'Group or Component');
  if (gc === 'Component') return 'accessory';
  return 'primary';
}

function isSample(row) {
  const type = col(row, 'Product Type') || '';
  return type.toLowerCase().includes('sample');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log(`\n=== James Martin Vanities — XLSX Import ===`);
  console.log(`File: ${filePath}`);
  console.log(`Dry run: ${dryRun}`);
  if (limit) console.log(`Limit: ${limit} rows`);
  console.log('');

  // Determine query target — in dry-run we use a single client with transaction
  let db; // will be pool or client
  let client;
  if (dryRun) {
    client = await pool.connect();
    await client.query('BEGIN');
    db = client;
    console.log('[dry-run] Transaction started — will ROLLBACK at end\n');
  } else {
    db = pool;
  }

  try {
    // ------ Phase 1: Setup ------

    // 1a. Ensure vendor
    const vendorRes = await db.query(`
      INSERT INTO vendors (name, code, website, is_active)
      VALUES ('James Martin Vanities', 'JMV', 'https://www.jamesmartinvanities.com', true)
      ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, is_active = true
      RETURNING id
    `);
    const vendorId = vendorRes.rows[0].id;
    console.log(`Vendor: James Martin Vanities (${vendorId})`);

    // 1b. Ensure categories
    const catMap = new Map();
    // Load existing categories first
    const existingCats = await db.query(`SELECT id, slug FROM categories`);
    for (const c of existingCats.rows) catMap.set(c.slug, c.id);

    for (const cat of CATEGORY_TREE) {
      const parentId = cat.parent ? catMap.get(cat.parent) : null;
      if (!catMap.has(cat.slug)) {
        const res = await db.query(`
          INSERT INTO categories (name, slug, parent_id, sort_order, is_active)
          VALUES ($1, $2, $3, $4, true)
          ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, parent_id = EXCLUDED.parent_id
          RETURNING id
        `, [cat.name, cat.slug, parentId, cat.sort]);
        catMap.set(cat.slug, res.rows[0].id);
        console.log(`  Category created: ${cat.name} (${cat.slug})`);
      }
    }

    // 1c. Ensure attributes
    const attrMap = new Map();
    const existingAttrs = await db.query(`SELECT id, slug FROM attributes`);
    for (const a of existingAttrs.rows) attrMap.set(a.slug, a.id);

    for (const attr of NEW_ATTRIBUTES) {
      if (!attrMap.has(attr.slug)) {
        const res = await db.query(`
          INSERT INTO attributes (name, slug, display_order, is_filterable)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
          RETURNING id
        `, [attr.name, attr.slug, attr.display_order, attr.filterable !== false]);
        attrMap.set(attr.slug, res.rows[0].id);
      }
    }
    console.log(`Attributes loaded: ${attrMap.size} total\n`);

    // ------ Phase 2: Read XLSX ------
    console.log('Reading XLSX...');
    const workbook = XLSX.readFile(filePath);
    let allRows = [];
    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(sheet);
      console.log(`  Sheet "${sheetName}": ${rows.length} rows`);
      allRows = allRows.concat(rows);
    }

    // Filter active only
    const activeRows = allRows.filter(r => {
      const status = col(r, 'Item Status');
      return !status || status === 'Active';
    });
    console.log(`Active rows: ${activeRows.length} / ${allRows.length} total`);

    const rows = limit ? activeRows.slice(0, limit) : activeRows;
    console.log(`Processing: ${rows.length} rows\n`);

    // ------ Phase 3: Process rows ------
    const stats = {
      products_new: 0, products_existing: 0,
      skus_new: 0, skus_existing: 0,
      images: 0, pdfs: 0, attrs: 0,
      pricing: 0, packaging: 0,
      errors: 0, skipped_no_map: 0,
    };
    const productCache = new Map(); // "collection|name" → product_id

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const itemNumber = col(row, 'Item Number');
      if (!itemNumber) continue; // skip empty/header rows (e.g. Misc. sheet padding)

      try {
        // 3.1 Parse prices
        const mapPrice = parsePrice(col(row, 'MAP Price') || col(row, 'MAP'));
        const msrpPrice = parsePrice(col(row, 'MSRP'));

        // 3.2 Determine category
        const categorySlug = getCategorySlug(row);
        const categoryId = catMap.get(categorySlug) || null;

        // 3.3 Derive product identity
        const collection = col(row, 'Collection Name') || '';
        const productName = deriveProductName(row);
        const variantName = deriveVariantName(row);
        const variantType = getVariantType(row);
        const sample = isSample(row);

        // 3.4 Build descriptions
        const { short: descShort, long: descLong } = buildDescription(row);

        // 3.5 Upsert product
        const productKey = `${collection}|${productName}`;
        let productId = productCache.get(productKey);

        if (!productId) {
          const prodRes = await db.query(`
            INSERT INTO products (vendor_id, name, collection, category_id, description_short, description_long, status)
            VALUES ($1, $2, $3, $4, $5, $6, 'draft')
            ON CONFLICT (vendor_id, collection, name)
            DO UPDATE SET
              category_id = COALESCE(EXCLUDED.category_id, products.category_id),
              description_short = COALESCE(EXCLUDED.description_short, products.description_short),
              description_long = COALESCE(EXCLUDED.description_long, products.description_long),
              updated_at = CURRENT_TIMESTAMP
            RETURNING id, (xmax = 0) AS inserted
          `, [vendorId, productName, collection, categoryId, descShort || null, descLong || null]);

          productId = prodRes.rows[0].id;
          productCache.set(productKey, productId);
          if (prodRes.rows[0].inserted) stats.products_new++;
          else stats.products_existing++;
        }

        // 3.6 Upsert SKU
        const internalSku = `JMV-${itemNumber}`;
        const vendorSku = itemNumber;
        const sellBy = 'unit';

        const skuRes = await db.query(`
          INSERT INTO skus (product_id, vendor_sku, internal_sku, variant_name, sell_by, variant_type, is_sample, status)
          VALUES ($1, $2, $3, $4, $5, $6, $7, 'active')
          ON CONFLICT (internal_sku)
          DO UPDATE SET
            product_id = EXCLUDED.product_id,
            variant_name = EXCLUDED.variant_name,
            sell_by = EXCLUDED.sell_by,
            variant_type = EXCLUDED.variant_type,
            is_sample = EXCLUDED.is_sample,
            updated_at = CURRENT_TIMESTAMP
          RETURNING id, (xmax = 0) AS inserted
        `, [productId, vendorSku, internalSku, variantName, sellBy, variantType, sample]);

        const skuId = skuRes.rows[0].id;
        if (skuRes.rows[0].inserted) stats.skus_new++;
        else stats.skus_existing++;

        // 3.7 Upsert pricing
        if (mapPrice && mapPrice > 0) {
          const cost = parseFloat((mapPrice * 0.5).toFixed(2));
          const retail = parseFloat(mapPrice.toFixed(2));
          await db.query(`
            INSERT INTO pricing (sku_id, cost, retail_price, price_basis)
            VALUES ($1, $2, $3, 'per_unit')
            ON CONFLICT (sku_id) DO UPDATE SET
              cost = EXCLUDED.cost,
              retail_price = EXCLUDED.retail_price,
              price_basis = EXCLUDED.price_basis
          `, [skuId, cost, retail]);
          stats.pricing++;
        } else {
          stats.skipped_no_map++;
        }

        // 3.8 Upsert packaging
        const shippingWeight = parsePrice(col(row, 'Total Shipping Weight'));
        const freightClass = parseInt(col(row, 'Freight Class') || '125', 10);
        if (shippingWeight) {
          await db.query(`
            INSERT INTO packaging (sku_id, pieces_per_box, weight_per_box_lbs, freight_class)
            VALUES ($1, 1, $2, $3)
            ON CONFLICT (sku_id) DO UPDATE SET
              pieces_per_box = EXCLUDED.pieces_per_box,
              weight_per_box_lbs = EXCLUDED.weight_per_box_lbs,
              freight_class = EXCLUDED.freight_class
          `, [skuId, shippingWeight, freightClass]);
          stats.packaging++;
        }

        // 3.9 Upsert attributes
        const attrPairs = [];

        // Existing attribute slugs
        const baseColor = col(row, 'Vanity Base Color/Finish');
        if (baseColor) {
          attrPairs.push(['color', baseColor]);
          attrPairs.push(['finish', baseColor]);
        }
        const material = col(row, 'Primary Construction Material');
        if (material) attrPairs.push(['material', material]);
        const country = col(row, 'Country of Origin');
        if (country) attrPairs.push(['country', country]);

        // New attribute slugs
        const widthVal = col(row, 'Product Width');
        if (widthVal) attrPairs.push(['width', `${widthVal}"`]);
        const heightVal = col(row, 'Product Height');
        if (heightVal) attrPairs.push(['height', `${heightVal}"`]);
        const depthVal = col(row, 'Product Depth');
        if (depthVal) attrPairs.push(['depth', `${depthVal}"`]);
        const weightVal = col(row, 'Product Weight') || col(row, 'Total Shipping Weight');
        if (weightVal) attrPairs.push(['weight', `${weightVal} lbs`]);
        const ctMat = col(row, 'Vanity Countertop Material') || col(row, 'Countertop Material');
        if (ctMat) attrPairs.push(['countertop_material', ctMat]);
        const ctFin = col(row, 'Countertop Finish');
        if (ctFin) attrPairs.push(['countertop_finish', ctFin]);
        const hwFin = col(row, 'Hardware Finish');
        if (hwFin) attrPairs.push(['hardware_finish', hwFin]);
        const vanType = col(row, 'Vanity Type');
        if (vanType) attrPairs.push(['vanity_type', vanType]);
        const numDoors = col(row, 'Number of Doors');
        if (numDoors) attrPairs.push(['num_doors', numDoors]);
        const numDrawers = col(row, 'Number of Drawers');
        if (numDrawers) attrPairs.push(['num_drawers', numDrawers]);
        const numShelves = col(row, 'Number of Shelves');
        if (numShelves) attrPairs.push(['num_shelves', numShelves]);

        // Soft close: combine hinges + slides
        const scHinges = col(row, 'Soft Close Hinges? (Y/N)') || col(row, 'Soft Close Hinges');
        const scSlides = col(row, 'Soft Close Slides? (Y/N)') || col(row, 'Soft Close Slides');
        if (scHinges || scSlides) {
          const parts = [];
          if (scHinges) parts.push(`Hinges: ${scHinges}`);
          if (scSlides) parts.push(`Slides: ${scSlides}`);
          attrPairs.push(['soft_close', parts.join(', ')]);
        }

        const numSinks = col(row, 'Number of Sinks Included (0, 1, or 2)') || col(row, 'Number of Sinks Included');
        if (numSinks) attrPairs.push(['num_sinks', numSinks]);
        const sinkType = col(row, 'Sink Installation Type');
        if (sinkType) attrPairs.push(['sink_type', sinkType]);
        const sinkMat = col(row, 'Sink Material');
        if (sinkMat) attrPairs.push(['sink_material', sinkMat]);
        const bowlShape = col(row, 'Bowl Shape');
        if (bowlShape) attrPairs.push(['bowl_shape', bowlShape]);
        const styleVal = col(row, 'Theme (Contemporary/Modern, Transitional, Traditional, or Commercial)') || col(row, 'Theme/Style');
        if (styleVal) attrPairs.push(['style', styleVal]);
        const upcVal = col(row, 'UPC Code');
        if (upcVal) attrPairs.push(['upc', upcVal]);

        if (msrpPrice) {
          attrPairs.push(['msrp', `$${msrpPrice.toLocaleString('en-US', { minimumFractionDigits: 2 })}`]);
        }

        const optAcc = col(row, 'Optional Accessories (Part numbers that would be good accessories for this product)') || col(row, 'Optional Accessories');
        if (optAcc) attrPairs.push(['optional_accessories', optAcc]);

        const topRef1 = col(row, 'Top Reference SKU 1');
        const topRef2 = col(row, 'Top Reference SKU 2');
        if (topRef1) {
          const topRefs = topRef2 ? `${topRef1}, ${topRef2}` : topRef1;
          attrPairs.push(['top_ref_sku', topRefs]);
        }

        const sinkRef = col(row, 'Sink Reference SKU');
        if (sinkRef) attrPairs.push(['sink_ref_sku', sinkRef]);
        const groupNum = col(row, 'Group Number');
        if (groupNum) attrPairs.push(['group_number', groupNum]);

        for (const [slug, value] of attrPairs) {
          const attrId = attrMap.get(slug);
          if (!attrId) continue;
          await db.query(`
            INSERT INTO sku_attributes (sku_id, attribute_id, value)
            VALUES ($1, $2, $3)
            ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value = EXCLUDED.value
          `, [skuId, attrId, value]);
          stats.attrs++;
        }

        // 3.10 Upsert images
        // Delete existing media for this SKU to handle re-runs cleanly
        await db.query(`DELETE FROM media_assets WHERE sku_id = $1`, [skuId]);

        const imageUrls = [];
        const primaryImg = col(row, 'Images');
        if (primaryImg && primaryImg.startsWith('http')) imageUrls.push(primaryImg);
        for (let j = 1; j <= 29; j++) {
          const imgUrl = col(row, `Images_${j}`);
          if (imgUrl && imgUrl.startsWith('http')) imageUrls.push(imgUrl);
        }

        for (let j = 0; j < imageUrls.length; j++) {
          const assetType = j === 0 ? 'primary' : 'alternate';
          await db.query(`
            INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
            VALUES ($1, $2, $3, $4, $4, $5)
          `, [productId, skuId, assetType, imageUrls[j], j]);
          stats.images++;
        }

        // 3.11 Upsert spec PDFs
        const pdfFields = [
          { col: 'SPEC Sheet', sort: 100 },
          { col: 'Top SPEC Sheet', sort: 101 },
          { col: 'Component SPEC Sheet', sort: 102 },
          { col: 'Assembly Instructions', sort: 103 },
        ];
        for (const pf of pdfFields) {
          const pdfUrl = col(row, pf.col);
          if (pdfUrl && pdfUrl.startsWith('http')) {
            await db.query(`
              INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
              VALUES ($1, $2, 'spec_pdf', $3, $3, $4)
            `, [productId, skuId, pdfUrl, pf.sort]);
            stats.pdfs++;
          }
        }

      } catch (err) {
        stats.errors++;
        console.error(`  [ERROR] Row ${i + 1} (Item: ${itemNumber}): ${err.message}`);
        if (stats.errors > 100) {
          console.error('\nAborting — too many errors (>100)');
          break;
        }
      }

      // Progress log every 100 rows
      if ((i + 1) % 100 === 0 || i === rows.length - 1) {
        console.log(
          `[${i + 1}/${rows.length}] ` +
          `Products: ${stats.products_new} new, ${stats.products_existing} existing | ` +
          `SKUs: ${stats.skus_new + stats.skus_existing} | ` +
          `Images: ${stats.images} | PDFs: ${stats.pdfs} | ` +
          `Errors: ${stats.errors}`
        );
      }
    }

    // ------ Phase 4: Finalize ------
    if (!dryRun && stats.errors <= 100) {
      const activated = await db.query(`
        UPDATE products SET status = 'active', updated_at = CURRENT_TIMESTAMP
        WHERE vendor_id = $1 AND status = 'draft'
        RETURNING id
      `, [vendorId]);
      console.log(`\nActivated ${activated.rowCount} products`);
    }

    // Print summary
    console.log('\n=== Import Summary ===');
    console.log(`Products:     ${stats.products_new} new, ${stats.products_existing} existing`);
    console.log(`SKUs:         ${stats.skus_new} new, ${stats.skus_existing} existing`);
    console.log(`Pricing:      ${stats.pricing} upserted (${stats.skipped_no_map} skipped — no MAP)`);
    console.log(`Packaging:    ${stats.packaging} upserted`);
    console.log(`Attributes:   ${stats.attrs} values set`);
    console.log(`Images:       ${stats.images}`);
    console.log(`Spec PDFs:    ${stats.pdfs}`);
    console.log(`Errors:       ${stats.errors}`);
    if (dryRun) console.log(`\n[dry-run] Rolling back all changes...`);

    // Commit or rollback
    if (dryRun) {
      await client.query('ROLLBACK');
      console.log('[dry-run] Rolled back successfully.');
    }

  } catch (err) {
    if (dryRun && client) {
      await client.query('ROLLBACK');
    }
    console.error('\nFatal error:', err);
    process.exit(1);
  } finally {
    if (client) client.release();
    await pool.end();
  }
}

main();
