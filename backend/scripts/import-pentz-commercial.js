#!/usr/bin/env node

/**
 * Import Pentz Commercial — Carpet (Modular + Broadloom) & LVT Catalog
 *
 * Source: Pentz Commercial Product API (provided by Lauryn Hill, Engineered Floors)
 * Endpoint: POST https://www.pentzcommercial.com/product-api/export
 * Auth: Form-encoded body with apikey (NOT JSON — returns 401 with JSON body)
 * Returns: JSON array of ~826 product/color objects (~562KB)
 *
 * This is a CATALOG/IMAGERY import — no pricing data in the API.
 * Pricing comes separately via EDI 832 matched by fcb2b SKU.
 *
 * Data: 73 styles across Modular carpet tile, Broadloom carpet, and LVT
 *   - Each style has multiple color variants
 *   - Images: image_path + {1..jj_style_tile_variance}.jpg
 *
 * Usage:
 *   docker compose exec api node scripts/import-pentz-commercial.js
 */

import pg from 'pg';

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

const API_URL = 'https://www.pentzcommercial.com/product-api/export';
const API_KEY = process.env.PENTZ_API_KEY || 'r6@Tl!f7ApXMW#aN';
const VENDOR_CODE = 'PC';
const VENDOR_NAME = 'Pentz Commercial';
const VENDOR_WEBSITE = 'https://www.pentzcommercial.com';

const CATEGORY_MAP = {
  'Modular':   'carpet-tile',
  'Broadloom': 'carpet-tile',
  'LVT':       'luxury-vinyl',
};

/**
 * Derive a collection name from the style name by stripping format suffixes.
 * This groups related formats (e.g. "Amplify" tile + "Amplify Plank") together.
 */
function deriveCollection(styleName) {
  if (!styleName) return '';
  let name = styleName.trim();
  name = name.replace(/\s+Broadloom$/i, '');
  name = name.replace(/\s+Plank$/i, '');
  name = name.replace(/\s+LVT$/i, '');
  name = name.replace(/\s+\d{2}$/,  '');       // broadloom widths: " 20", " 26"
  name = name.replace(/\s+Plus$/i,  '');        // LVT variants: " Plus"
  return name.trim() || styleName.trim();
}

// ── DB helpers ──────────────────────────────────────────────────────────────

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

async function upsertPackaging(sku_id, pkg) {
  await pool.query(`
    INSERT INTO packaging (sku_id, sqft_per_box, pieces_per_box, roll_width_ft)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (sku_id) DO UPDATE SET
      sqft_per_box = COALESCE(EXCLUDED.sqft_per_box, packaging.sqft_per_box),
      pieces_per_box = COALESCE(EXCLUDED.pieces_per_box, packaging.pieces_per_box),
      roll_width_ft = COALESCE(EXCLUDED.roll_width_ft, packaging.roll_width_ft)
  `, [sku_id, pkg.sqft_per_box || null, pkg.pieces_per_box || null, pkg.roll_width_ft || null]);
}

async function setAttr(sku_id, slug, value) {
  if (!value || !String(value).trim()) return;
  const attr = await pool.query('SELECT id FROM attributes WHERE slug = $1', [slug]);
  if (!attr.rows.length) return;
  await pool.query(`
    INSERT INTO sku_attributes (sku_id, attribute_id, value)
    VALUES ($1, $2, $3)
    ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value = EXCLUDED.value
  `, [sku_id, attr.rows[0].id, String(value).trim()]);
}

async function upsertMediaAsset({ product_id, sku_id, asset_type, url, sort_order }) {
  if (!url) return;
  if (url.startsWith('http://')) url = url.replace('http://', 'https://');
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

// ── Ensure attributes exist ─────────────────────────────────────────────────

const REQUIRED_ATTRS = [
  { slug: 'color',               name: 'Color',               display_order: 1 },
  { slug: 'material',            name: 'Material',            display_order: 2 },
  { slug: 'size',                name: 'Size',                display_order: 4 },
  { slug: 'construction',        name: 'Construction',        display_order: 15 },
  { slug: 'fiber_brand',         name: 'Fiber Brand',         display_order: 16 },
  { slug: 'installation_method', name: 'Installation Method', display_order: 17 },
  { slug: 'underlayer',          name: 'Underlayer',          display_order: 18 },
];

async function ensureAttributes() {
  for (const attr of REQUIRED_ATTRS) {
    await pool.query(`
      INSERT INTO attributes (name, slug, display_order)
      VALUES ($1, $2, $3) ON CONFLICT (slug) DO NOTHING
    `, [attr.name, attr.slug, attr.display_order]);
  }
}

// ── API fetch ───────────────────────────────────────────────────────────────

async function fetchPentzApi() {
  console.log(`Fetching Pentz Commercial API...`);
  const body = new URLSearchParams({ apikey: API_KEY });
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    throw new Error(`API returned ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  console.log(`  Received ${data.length} items from API`);
  return data;
}

// ── Packaging helpers ───────────────────────────────────────────────────────

function buildPackaging(item) {
  const carpetType = item.jj_style_carpet_type;
  const widthFt = parseFloat(item.jj_style_width) || 0;
  const heightFt = parseFloat(item.jj_style_height) || 0;

  if (carpetType === 'Broadloom') {
    return { roll_width_ft: 12 };
  }

  // Modular tiles or LVT planks — sqft per piece from dimensions
  if (widthFt > 0 && heightFt > 0) {
    const sqftPerPiece = widthFt * heightFt;
    return { sqft_per_box: sqftPerPiece, pieces_per_box: 1 };
  }

  return {};
}

function buildSizeString(item) {
  const carpetType = item.jj_style_carpet_type;
  if (carpetType === 'Broadloom') return '12ft wide';

  const wFt = parseFloat(item.jj_style_width) || 0;
  const hFt = parseFloat(item.jj_style_height) || 0;
  if (wFt > 0 && hFt > 0) {
    // Convert feet to inches for display (2ft = 24in, 0.583ft ≈ 7in)
    const wIn = Math.round(wFt * 12);
    const hIn = Math.round(hFt * 12);
    return `${wIn}" x ${hIn}"`;
  }
  return null;
}

// ── Main import ─────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Pentz Commercial Catalog Import ===\n');

  // 1. Fetch API data
  const items = await fetchPentzApi();

  // 2. Group by style number → products
  const styleMap = new Map();
  for (const item of items) {
    const styleNum = item.jj_style_num;
    if (!styleMap.has(styleNum)) {
      styleMap.set(styleNum, {
        styleName: item.style,
        carpetType: item.jj_style_carpet_type,
        brand: item.jj_style_brand,
        colors: [],
      });
    }
    styleMap.get(styleNum).colors.push(item);
  }
  console.log(`  Grouped into ${styleMap.size} products\n`);

  // 3. Resolve vendor
  const vendorResult = await pool.query('SELECT id FROM vendors WHERE code = $1', [VENDOR_CODE]);
  let vendorId;
  if (!vendorResult.rows.length) {
    const ins = await pool.query(
      `INSERT INTO vendors (name, code, website) VALUES ($1, $2, $3) RETURNING id`,
      [VENDOR_NAME, VENDOR_CODE, VENDOR_WEBSITE]
    );
    vendorId = ins.rows[0].id;
    console.log(`  Created vendor "${VENDOR_NAME}" (${VENDOR_CODE})`);
  } else {
    vendorId = vendorResult.rows[0].id;
    console.log(`  Found vendor "${VENDOR_NAME}" (${VENDOR_CODE})`);
  }

  // 4. Ensure attribute slugs exist
  await ensureAttributes();

  // 5. Load categories
  const catResult = await pool.query('SELECT id, slug FROM categories');
  const catMap = {};
  for (const row of catResult.rows) catMap[row.slug] = row.id;

  // 6. Import products + SKUs
  let stats = { products: 0, newProducts: 0, skus: 0, newSkus: 0, images: 0 };

  for (const [styleNum, product] of styleMap) {
    const categorySlug = CATEGORY_MAP[product.carpetType];
    const categoryId = categorySlug ? (catMap[categorySlug] || null) : null;

    // Build description from first color's data
    const sample = product.colors[0];
    const descParts = [];
    if (sample.backing) descParts.push(`Backing: ${sample.backing}`);
    if (sample.fiber) descParts.push(`Fiber: ${sample.fiber}`);
    if (sample.install_methods) descParts.push(`Install: ${sample.install_methods}`);
    const descShort = descParts.length ? descParts.join(' | ') : null;

    const prod = await upsertProduct(vendorId, {
      name: product.styleName,
      collection: deriveCollection(product.styleName),
      category_id: categoryId,
      description_short: descShort,
    });
    stats.products++;
    if (prod.is_new) stats.newProducts++;

    for (const item of product.colors) {
      const internalSku = `PC-${item.jj_style_num}-${item._color_num}`;
      const vendorSku = item.fcb2b || null;

      const sku = await upsertSku(prod.id, {
        vendor_sku: vendorSku,
        internal_sku: internalSku,
        variant_name: item.color,
        sell_by: 'sqft',
        variant_type: null,
      });
      stats.skus++;
      if (sku.is_new) stats.newSkus++;

      // Placeholder pricing (DO NOTHING if exists)
      await upsertPricing(sku.id, { cost: 0, retail_price: 0, price_basis: 'per_sqft' });

      // Packaging
      const pkg = buildPackaging(item);
      if (Object.keys(pkg).length) {
        await upsertPackaging(sku.id, pkg);
      }

      // Attributes
      await setAttr(sku.id, 'color', item.color);
      await setAttr(sku.id, 'material', item.backing);
      await setAttr(sku.id, 'fiber_brand', item.fiber);
      await setAttr(sku.id, 'installation_method', item.install_methods);
      await setAttr(sku.id, 'construction', item.jj_style_carpet_type);
      await setAttr(sku.id, 'underlayer', item.virtual_sample_underlayer);
      const sizeStr = buildSizeString(item);
      if (sizeStr) await setAttr(sku.id, 'size', sizeStr);

      // Images: image_path + {1..variance}.jpg
      const variance = parseInt(item.jj_style_tile_variance, 10) || 1;
      const basePath = item.image_path || '';
      if (basePath) {
        for (let i = 1; i <= variance; i++) {
          const url = `${basePath}${i}.jpg`;
          await upsertMediaAsset({
            product_id: prod.id,
            sku_id: sku.id,
            asset_type: i === 1 ? 'primary' : 'alternate',
            url,
            sort_order: i - 1,
          });
          stats.images++;
        }
      }
    }
  }

  console.log('\n=== Import Complete ===');
  console.log(`  Products: ${stats.products} total (${stats.newProducts} new)`);
  console.log(`  SKUs:     ${stats.skus} total (${stats.newSkus} new)`);
  console.log(`  Images:   ${stats.images} upserted`);

  await pool.end();
}

main().catch(err => {
  console.error('Import failed:', err);
  pool.end();
  process.exit(1);
});
