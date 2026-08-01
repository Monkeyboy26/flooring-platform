#!/usr/bin/env node
/**
 * Import Patina Design — Lamont Floor "Modern Elegance" European White Oak.
 *
 * Patina Design (1250 Philadelphia St, Pomona CA 91766 — lamontfloor.com) is
 * onboarded as a NEW vendor carrying a single brand, Lamont Floor. Only the
 * "Modern Elegance" line is imported (European White Oak, 4mm sawn veneer, UV
 * lacquer). See [[vendor-sub-brands]] for the vendor→brand model.
 *
 * VARIANT MODEL (see [[variant-pill-independence]]): the storefront shows three
 * variant axes for this line —
 *   1. Color   → same-product SKU color swatches
 *   2. Grade   → same-product 'grade' attribute pills (Light Character | Selected Natural)
 *   3. Format  → cross-product format pills via products.format_group ("Style" row)
 * So the 16 priced SKUs are grouped into THREE products by format — "Modern
 * Elegance Plank / Herringbone / Chevron" — each holding its color/grade SKUs,
 * all sharing format_group 'LAMONT-modern-elegance'. Photos are attached per SKU
 * (media_assets.sku_id) so each color shows its own gallery within the shared
 * product. (Earlier revision modelled one product per SKU; regrouped 2026-08-01
 * per owner request for plank/herringbone/chevron pills.)
 *
 * Source: backend/data/patina/catalog.json (2025 Patina Engineer Wood Pricelist,
 * FOB Pomona Zone 1D) + images.json (lamontfloor.com WooCommerce Store API,
 * keyed by vendor SKU / img_key).
 *
 * Pricing: pricelist price = Roma COST; retail = cost x1.6 nickel keystone.
 * Planks sold per sqft by the box (sell_by 'box', per_sqft); moldings per piece.
 *
 * Scope: 16 priced grade/format combos only (8 Light-Character colors + Coastal
 * Breeze / Woodland Haze in Selected-Natural plank / 7-1/2" wide plank /
 * herringbone / chevron). The 17 extra unpriced website colors are excluded.
 * Coastal Breeze 7-1/2" S/N is not published on the site — swatch reuses LMT09.
 *
 * Accessories: one solid-wood molding product (Bullnose/Square stair nose, End
 * Cap, T-Molding, Reducer) linked via sku_accessories to ALL flooring SKUs.
 *
 * Usage: docker compose exec api node scripts/import-patina.js
 */
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: 5432, database: 'flooring_pim', user: 'postgres', password: 'postgres',
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.PATINA_DATA_DIR || path.join(__dirname, '..', 'data', 'patina');
const catalog = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'catalog.json'), 'utf8'));
let images = {};
try { images = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'images.json'), 'utf8')); }
catch { console.warn('! images.json not found — importing without photos'); }

const RETAIL_MARKUP = 1.6;
const keystone = (cost) => parseFloat((Math.round(cost * RETAIL_MARKUP / 0.05) * 0.05).toFixed(2));
const FORMAT_GROUP = 'LAMONT-modern-elegance';

// ==================== DB helpers ====================
async function upsertVendor(v) {
  const res = await pool.query(`
    INSERT INTO vendors (name, code, website, email, phone, address, notes)
    VALUES ($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT (code) DO UPDATE SET
      name=EXCLUDED.name, website=EXCLUDED.website, email=COALESCE(EXCLUDED.email, vendors.email),
      phone=COALESCE(EXCLUDED.phone, vendors.phone), address=COALESCE(EXCLUDED.address, vendors.address),
      notes=EXCLUDED.notes, updated_at=CURRENT_TIMESTAMP
    RETURNING id
  `, [v.name, v.code, v.website, v.email, v.phone, v.address, v.notes]);
  return res.rows[0].id;
}

async function upsertBrand(name, code, website) {
  const res = await pool.query(`
    INSERT INTO brands (name, code, website) VALUES ($1,$2,$3)
    ON CONFLICT (code) DO UPDATE SET name=EXCLUDED.name,
      website=COALESCE(EXCLUDED.website, brands.website), updated_at=CURRENT_TIMESTAMP
    RETURNING id
  `, [name, code, website || null]);
  return res.rows[0].id;
}
async function linkVendorBrand(vendorId, brandId, isPrimary = false) {
  await pool.query(`
    INSERT INTO vendor_brands (vendor_id, brand_id, is_primary) VALUES ($1,$2,$3)
    ON CONFLICT (vendor_id, brand_id) DO UPDATE SET is_primary = vendor_brands.is_primary OR EXCLUDED.is_primary
  `, [vendorId, brandId, isPrimary]);
}

async function getCategoryId(slug) {
  const r = await pool.query('SELECT id FROM categories WHERE slug=$1', [slug]);
  return r.rows.length ? r.rows[0].id : null;
}

async function upsertProduct(vendorId, brandId, categoryId, p) {
  const res = await pool.query(`
    INSERT INTO products (vendor_id, brand_id, name, collection, category_id, status,
      description_short, description_long, format_group, format_label)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    ON CONFLICT ON CONSTRAINT products_vendor_collection_name_unique DO UPDATE SET
      brand_id=EXCLUDED.brand_id, category_id=EXCLUDED.category_id, status=EXCLUDED.status,
      description_short=EXCLUDED.description_short, description_long=EXCLUDED.description_long,
      format_group=EXCLUDED.format_group, format_label=EXCLUDED.format_label,
      updated_at=CURRENT_TIMESTAMP
    RETURNING id, (xmax = 0) AS is_new
  `, [vendorId, brandId, p.name, p.collection, categoryId, p.status || 'active',
      p.description_short, p.description_long, p.format_group || null, p.format_label || null]);
  return res.rows[0];
}

async function upsertSku(productId, s) {
  const res = await pool.query(`
    INSERT INTO skus (product_id, vendor_sku, internal_sku, variant_name, sell_by, variant_type, accessory_label, status)
    VALUES ($1,$2,$3,$4,$5,$6,$7,'active')
    ON CONFLICT (internal_sku) DO UPDATE SET
      product_id=EXCLUDED.product_id, vendor_sku=EXCLUDED.vendor_sku,
      variant_name=EXCLUDED.variant_name, sell_by=EXCLUDED.sell_by,
      variant_type=EXCLUDED.variant_type, accessory_label=EXCLUDED.accessory_label,
      status='active', updated_at=CURRENT_TIMESTAMP
    RETURNING id, (xmax = 0) AS is_new
  `, [productId, s.vendor_sku, s.internal_sku, s.variant_name || null, s.sell_by || 'box',
      s.variant_type || null, s.accessory_label || null]);
  return res.rows[0];
}

async function upsertPricing(skuId, cost, retail, basis) {
  await pool.query(`
    INSERT INTO pricing (sku_id, cost, retail_price, price_basis)
    VALUES ($1,$2,$3,$4)
    ON CONFLICT (sku_id) DO UPDATE SET cost=EXCLUDED.cost, retail_price=EXCLUDED.retail_price, price_basis=EXCLUDED.price_basis
  `, [skuId, cost, retail, basis]);
}

async function upsertPackaging(skuId, sqftBox, lbsBox, boxesPallet) {
  if (sqftBox == null && lbsBox == null && boxesPallet == null) return;
  await pool.query(`
    INSERT INTO packaging (sku_id, sqft_per_box, weight_per_box_lbs, boxes_per_pallet) VALUES ($1,$2,$3,$4)
    ON CONFLICT (sku_id) DO UPDATE SET sqft_per_box=EXCLUDED.sqft_per_box,
      weight_per_box_lbs=EXCLUDED.weight_per_box_lbs, boxes_per_pallet=EXCLUDED.boxes_per_pallet
  `, [skuId, sqftBox, lbsBox, boxesPallet]);
}

const attrCache = new Map();
async function attrId(slug) {
  if (attrCache.has(slug)) return attrCache.get(slug);
  const r = await pool.query('SELECT id FROM attributes WHERE slug=$1', [slug]);
  const id = r.rows.length ? r.rows[0].id : null;
  attrCache.set(slug, id);
  if (!id) console.warn('  ! no attribute for slug', slug);
  return id;
}
async function setAttr(skuId, slug, value) {
  if (value == null || value === '') return;
  const id = await attrId(slug);
  if (!id) return;
  await pool.query(`
    INSERT INTO sku_attributes (sku_id, attribute_id, value) VALUES ($1,$2,$3)
    ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value=EXCLUDED.value
  `, [skuId, id, String(value).trim()]);
}

// SKU-level media (each color's own gallery inside a shared format product)
async function upsertSkuMedia(productId, skuId, url, assetType, sortOrder) {
  if (!url) return;
  await pool.query(`
    INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order, source)
    VALUES ($1,$2,$3,$4,$4,$5,'lamontfloor.com')
    ON CONFLICT (product_id, sku_id, asset_type, sort_order) WHERE sku_id IS NOT NULL
    DO UPDATE SET url=EXCLUDED.url, original_url=EXCLUDED.original_url, source=EXCLUDED.source
  `, [productId, skuId, assetType, url, sortOrder]);
}

async function linkAccessory(parentSkuId, accessorySkuId, sortOrder) {
  await pool.query(`
    INSERT INTO sku_accessories (parent_sku_id, accessory_sku_id, sort_order)
    VALUES ($1,$2,$3)
    ON CONFLICT (parent_sku_id, accessory_sku_id) DO UPDATE SET sort_order=EXCLUDED.sort_order
  `, [parentSkuId, accessorySkuId, sortOrder]);
}

// ==================== derived fields ====================
const LINE = catalog.line;

// Each format is its OWN product so dimensions stay uniform within a product —
// that keeps the color-swatch builder on its simple same-product path (a
// color×width matrix inside one product breaks it) and stops width/length from
// leaking in as pills. The 7-1/2" boards (3/4" thick, only Coastal Breeze /
// Woodland Haze) are their own "Wide Plank" format alongside the 9-1/2" plank.
const FORMAT_PRODUCTS = [
  { key: 'plank',       name: 'Modern Elegance Plank',       label: 'Plank' },
  { key: 'wide-plank',  name: 'Modern Elegance Wide Plank',  label: 'Wide Plank' },
  { key: 'herringbone', name: 'Modern Elegance Herringbone', label: 'Herringbone' },
  { key: 'chevron',     name: 'Modern Elegance Chevron',     label: 'Chevron' },
];

// Full board dimensions — stored only in the (NON_SELECTABLE) 'size' attribute so
// they show in the spec table without becoming pills.
const dims = (p) => `${p.thickness} x ${p.width} x ${p.length}`;
// Comma-free so the storefront's variant-name color parser doesn't mistake the
// trailing token for the color (color/grade come from attributes anyway).
function variantName(p) { return `${p.color} — ${p.grade}`; }

function productDesc(fmt, members) {
  const colors = [...new Set(members.map((m) => m.color))];
  const grades = [...new Set(members.map((m) => m.grade))];
  const noun = fmt.key === 'plank' ? 'plank flooring'
    : fmt.key === 'wide-plank' ? 'wide plank flooring'
    : fmt.key === 'herringbone' ? 'herringbone parquet' : 'chevron parquet';
  const short = `European White Oak engineered ${noun} — ${LINE.finish} finish, ${LINE.veneer} sawn veneer. ${colors.length} color${colors.length > 1 ? 's' : ''}${grades.length > 1 ? `, ${grades.join(' & ')} grades` : ` (${grades[0]})`}.`;
  const parts = [];
  parts.push(`Lamont Floor ${catalog.collection} — engineered European White Oak ${noun} with a ${LINE.veneer} sawn veneer and a ${LINE.finish.toLowerCase()} finish.`);
  if (fmt.key === 'plank') parts.push('Wide, long boards for a clean contemporary floor; available in Light Character and Selected Natural grades.');
  else if (fmt.key === 'wide-plank') parts.push('Extra-wide 7-1/2" boards on a 3/4" engineered core (Selected Natural grade).');
  else if (fmt.key === 'herringbone') parts.push('Precision-cut blocks for a classic herringbone lay (Selected Natural grade).');
  else parts.push('Angle-cut boards that meet point-to-point for a chevron pattern (Selected Natural grade).');
  parts.push(`Colors: ${colors.join(', ')}.`);
  parts.push('Choose a color, grade and format (plank, wide plank, herringbone or chevron) above. Some colors are special order — see the selected option for lead time.');
  return { short, long: parts.join(' ').replace(/\s+/g, ' ').trim() };
}

async function setPlankAttrs(skuId, p) {
  const c = catalog.colors[p.color] || {};
  await setAttr(skuId, 'material', 'Engineered Hardwood');
  await setAttr(skuId, 'construction', LINE.construction);
  await setAttr(skuId, 'species', LINE.species);
  await setAttr(skuId, 'finish', LINE.finish);
  await setAttr(skuId, 'color', p.color);       // → color swatches
  await setAttr(skuId, 'grade', p.grade);        // → grade pills
  await setAttr(skuId, 'collection', catalog.collection);
  await setAttr(skuId, 'surface_texture', c.surface_texture);
  // Dimensions live only in 'size' (NON_SELECTABLE) so they appear in the spec
  // table but never as pills; format (plank/wide/HB/chevron) carries the shape.
  await setAttr(skuId, 'size', dims(p));
  await setAttr(skuId, 'wear_layer', `${LINE.veneer} veneer`);
}

// ==================== Main ====================
async function main() {
  console.log('=== Patina Design / Lamont Floor Import (grouped variants) ===\n');
  const vendorId = await upsertVendor(catalog.vendor);
  console.log(`Vendor: ${catalog.vendor.name} (${vendorId})`);
  const brandId = await upsertBrand(catalog.brand.name, catalog.brand.code, catalog.brand.website);
  await linkVendorBrand(vendorId, brandId, true);
  console.log(`Brand:  ${catalog.brand.name} (${brandId})\n`);

  const CAT = {};
  for (const slug of ['engineered-hardwood', 'transitions-moldings']) {
    CAT[slug] = await getCategoryId(slug);
    if (!CAT[slug]) throw new Error(`required category missing: ${slug}`);
  }

  // Full rebuild: purge existing Patina products + dependents before re-importing.
  const prodRows = await pool.query(
    `SELECT p.id FROM products p JOIN vendors v ON v.id=p.vendor_id WHERE v.code=$1`, [catalog.vendor.code]);
  const prodIds = prodRows.rows.map((r) => r.id);
  if (prodIds.length) {
    const skuRows = await pool.query(`SELECT id FROM skus WHERE product_id = ANY($1)`, [prodIds]);
    const skuIds = skuRows.rows.map((r) => r.id);
    if (skuIds.length) {
      await pool.query(`DELETE FROM sku_accessories WHERE parent_sku_id = ANY($1) OR accessory_sku_id = ANY($1)`, [skuIds]);
      for (const tbl of ['cart_items', 'sku_attributes', 'pricing', 'packaging', 'media_assets']) {
        await pool.query(`DELETE FROM ${tbl} WHERE sku_id = ANY($1)`, [skuIds]);
      }
      await pool.query(`DELETE FROM skus WHERE id = ANY($1)`, [skuIds]);
    }
    await pool.query(`DELETE FROM media_assets WHERE product_id = ANY($1)`, [prodIds]);
    await pool.query(`DELETE FROM products WHERE id = ANY($1)`, [prodIds]);
    console.log(`Purged ${prodIds.length} existing Patina products (${skuIds.length} SKUs) for clean rebuild\n`);
  }

  let pNew = 0, sNew = 0, mediaN = 0, noImg = 0;
  const flooringSkuIds = [];

  // ---- Pass 1: three format products (Plank / Herringbone / Chevron) ----
  for (const fmt of FORMAT_PRODUCTS) {
    const members = catalog.products.filter((p) => p.format === fmt.key);
    if (!members.length) continue;
    const { short, long } = productDesc(fmt, members);
    const prod = await upsertProduct(vendorId, brandId, CAT['engineered-hardwood'], {
      name: fmt.name, collection: catalog.collection, status: 'active',
      description_short: short, description_long: long,
      format_group: FORMAT_GROUP, format_label: fmt.label,
    });
    prod.is_new ? pNew++ : 0;

    for (const p of members) {
      const sku = await upsertSku(prod.id, {
        vendor_sku: p.vendor_sku, internal_sku: `PAT-${p.vendor_sku}`,
        variant_name: variantName(p), sell_by: 'box',
      });
      sku.is_new ? sNew++ : 0;
      flooringSkuIds.push(sku.id);

      await upsertPricing(sku.id, p.cost, keystone(p.cost), 'per_sqft');
      await upsertPackaging(sku.id, p.sqft_box, p.lbs_box, p.box_pallet);
      await setPlankAttrs(sku.id, p);

      const img = images[p.img_key];
      if (img && img.primary) {
        await upsertSkuMedia(prod.id, sku.id, img.primary, 'primary', 0);
        let so = 0;
        for (const url of (img.lifestyle || [])) await upsertSkuMedia(prod.id, sku.id, url, 'lifestyle', so++);
        mediaN++;
      } else { noImg++; console.warn(`  ! no image for ${p.vendor_sku} (${variantName(p)})`); }
    }
    console.log(`  ${fmt.name}: ${members.length} SKUs (${[...new Set(members.map(m => m.color))].length} colors)`);
  }
  console.log(`\nFloors: ${pNew} products, ${sNew} SKUs, ${mediaN} with photo / ${noImg} without`);

  // ---- Pass 2: solid-wood molding product + attach to every flooring SKU ----
  const set = catalog.molding_set;
  const mprod = await upsertProduct(vendorId, brandId, CAT['transitions-moldings'], {
    name: set.name, collection: catalog.collection, status: 'active',
    description_short: set.desc,
    description_long: `${set.desc} Profiles: ${set.pieces.map((x) => x.type).join(', ')}. Each piece sold individually. Bullnose and square stair nose ship 4 pieces per box; End Cap, T-Molding and Reducer are special order (approx. 2 weeks lead time).`,
  });
  let mSku = 0;
  const moldSkuIds = [];
  for (const piece of set.pieces) {
    const msku = await upsertSku(mprod.id, {
      vendor_sku: `${piece.code}`, internal_sku: `PAT-MOLD-${piece.code}`,
      variant_name: piece.type, sell_by: 'unit', variant_type: 'accessory', accessory_label: piece.type,
    });
    mSku++;
    moldSkuIds.push(msku.id);
    await upsertPricing(msku.id, piece.cost, keystone(piece.cost), 'per_unit');
    await setAttr(msku.id, 'material', set.material);
    await setAttr(msku.id, 'finish', set.finish);
    await setAttr(msku.id, 'collection', catalog.collection);
    if (piece.length) { await setAttr(msku.id, 'length', piece.length); await setAttr(msku.id, 'size', `${piece.length} piece`); }
  }
  let links = 0;
  for (const parentId of flooringSkuIds) { let k = 0; for (const accId of moldSkuIds) { await linkAccessory(parentId, accId, k++); links++; } }
  console.log(`Moldings: 1 product, ${mSku} accessory SKUs, ${links} links (${moldSkuIds.length} profiles x ${flooringSkuIds.length} floors)`);

  console.log('\nDone.');
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
