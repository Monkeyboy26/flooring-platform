#!/usr/bin/env node
/**
 * Import Mango Flooring — SPC rigid-core waterproof vinyl plank.
 *
 * Mango Flooring Inc. (8230 Industry Ave, Pico Rivera, CA 90660) is onboarded
 * as a BRAND under the existing Bellezza Ceramica vendor (per business decision
 * — Roma sources Mango through Bellezza). See [[vendor-sub-brands]].
 *
 * Catalog: 20 wood-look plank designs across three thickness series, all
 * 9" x 60", 26 mil wear layer, IXPE-backed, Unilin click-lock:
 *   Series 7  (7mm,  5+2mm core)    — Mango 701-706 — 22.28 sf/box, cost $1.59/sf
 *   Series 8  (8mm,  6.5+1.5mm core)— Mango 801-808 — 18.57 sf/box, cost $1.79/sf
 *   Series 10 (10mm, 8+2mm core)    — Mango 101-106 — 14.85 sf/box, cost $2.19/sf
 *
 * Pricing: price book "Pricing/SQF" column is Roma's COST (wholesale). Retail =
 * cost x 1.6, nickel-rounded (store keystone standard). Planks sold per sqft
 * (by the box); moldings sold per piece.
 *
 * Moldings (Reducer / T-Molding / Quarter Round $12, Stair Nose $18 — cost):
 * modeled as one "Mango Moldings" accessory product and attached to every plank
 * SKU via sku_accessories so they surface in the storefront "Matching
 * Accessories" section (same mechanism as COREtec — see create-coretec-accessories).
 *
 * Images: scraped from mangoflooring.com product pages (GoHighLevel store).
 * Each product page shows a plank render (primary) + a room scene (lifestyle);
 * both are attached in that order, mirroring the vendor product page.
 * NOTE: Mango 802's vendor page reuses Mango 801's photos (vendor copy-page not
 * yet re-shot) — imported with the shared image as best available.
 *
 * Data: catalog.json + images.json in backend/data/mango/ (built by
 * build-mango-catalog from the PDF price book + scraped pages).
 *
 * Usage: docker compose exec api node scripts/import-mango.js
 */

import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: 5432,
  database: 'flooring_pim',
  user: 'postgres',
  password: 'postgres',
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.MANGO_DATA_DIR || path.join(__dirname, '..', 'data', 'mango');
const catalog = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'catalog.json'), 'utf8'));
let images = {};
try { images = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'images.json'), 'utf8')); }
catch { console.warn('! images.json not found — importing without photos'); }

const RETAIL_MARKUP = 1.6;
const keystone = (cost) => parseFloat((Math.round(cost * RETAIL_MARKUP / 0.05) * 0.05).toFixed(2));

// ==================== Helpers ====================

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
    INSERT INTO products (vendor_id, brand_id, name, collection, category_id, status, description_short, description_long)
    VALUES ($1,$2,$3,$4,$5,'active',$6,$7)
    ON CONFLICT ON CONSTRAINT products_vendor_collection_name_unique DO UPDATE SET
      brand_id=EXCLUDED.brand_id, category_id=EXCLUDED.category_id, status='active',
      description_short=EXCLUDED.description_short, description_long=EXCLUDED.description_long,
      updated_at=CURRENT_TIMESTAMP
    RETURNING id, (xmax = 0) AS is_new
  `, [vendorId, brandId, p.name, p.collection, categoryId, p.description_short, p.description_long]);
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
  `, [productId, s.vendor_sku, s.internal_sku, s.variant_name || null, s.sell_by || 'sqft',
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

async function upsertPackaging(skuId, pk) {
  await pool.query(`
    INSERT INTO packaging (sku_id, sqft_per_box, pieces_per_box, boxes_per_pallet)
    VALUES ($1,$2,$3,$4)
    ON CONFLICT (sku_id) DO UPDATE SET
      sqft_per_box=COALESCE(EXCLUDED.sqft_per_box, packaging.sqft_per_box),
      pieces_per_box=COALESCE(EXCLUDED.pieces_per_box, packaging.pieces_per_box),
      boxes_per_pallet=COALESCE(EXCLUDED.boxes_per_pallet, packaging.boxes_per_pallet)
  `, [skuId, pk.sqft_per_box || null, pk.pieces_per_box || null, pk.boxes_per_pallet || null]);
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

async function upsertMedia(productId, url, assetType, sortOrder) {
  if (!url) return;
  await pool.query(`
    INSERT INTO media_assets (product_id, asset_type, url, original_url, sort_order)
    VALUES ($1,$2,$3,$3,$4)
    ON CONFLICT (product_id, asset_type, sort_order) WHERE sku_id IS NULL
    DO UPDATE SET url=EXCLUDED.url, original_url=EXCLUDED.original_url
  `, [productId, assetType, url, sortOrder]);
}

async function linkAccessory(parentSkuId, accessorySkuId, sortOrder) {
  await pool.query(`
    INSERT INTO sku_accessories (parent_sku_id, accessory_sku_id, sort_order)
    VALUES ($1,$2,$3)
    ON CONFLICT (parent_sku_id, accessory_sku_id) DO UPDATE SET sort_order=EXCLUDED.sort_order
  `, [parentSkuId, accessorySkuId, sortOrder]);
}

// Moldings from the price book — cost per piece; retail = cost x 1.6.
const MOLDINGS = [
  { label: 'Reducer',       vendor_sku: 'MANGO-REDUCER', internal_sku: 'MANGO-ACC-REDUCER', cost: 12.00 },
  { label: 'T-Molding',     vendor_sku: 'MANGO-TMOLD',   internal_sku: 'MANGO-ACC-TMOLD',   cost: 12.00 },
  { label: 'Quarter Round', vendor_sku: 'MANGO-QRND',    internal_sku: 'MANGO-ACC-QRND',    cost: 12.00 },
  { label: 'Stair Nose',    vendor_sku: 'MANGO-STAIRN',  internal_sku: 'MANGO-ACC-STAIRN',  cost: 18.00 },
];

// ==================== Main ====================
async function main() {
  console.log('=== Mango Flooring Import ===\n');

  // Vendor: use existing Bellezza Ceramica (Mango is a brand under it).
  const vRes = await pool.query("SELECT id, name FROM vendors WHERE code = 'BLZ'");
  if (!vRes.rows.length) { console.error('! Bellezza vendor (code=BELLEZZA) not found — run import-bellezza first'); process.exit(1); }
  const vendorId = vRes.rows[0].id;
  console.log(`Vendor: ${vRes.rows[0].name} (${vendorId})`);

  const brandId = await upsertBrand('Mango Flooring', 'MANGO', 'https://mangoflooring.com');
  await linkVendorBrand(vendorId, brandId, false);
  console.log(`Brand:  Mango Flooring (${brandId})\n`);

  const catPlank = await getCategoryId('lvp-plank');
  const catMold  = await getCategoryId('transitions-moldings');
  if (!catPlank) { console.error('! category lvp-plank not found'); process.exit(1); }
  if (!catMold)  console.warn('! category transitions-moldings not found — moldings will have null category');

  let pNew = 0, pUpd = 0, sNew = 0, sUpd = 0, mediaN = 0;
  const plankSkuIds = [];

  // ---- Plank products (one product per design, single SKU) ----
  for (const c of catalog) {
    const descLong =
      `Mango ${c.series} SPC rigid-core waterproof vinyl plank. 9" x 60" planks, ` +
      `${c.thickness} overall (${c.core} core) with a 26 mil wear layer. Wood-texture ` +
      `surface with Super Protect UV coating and Unilin click-lock. Attached ` +
      `antibacterial acoustic IXPE pad. Lifetime limited residential / 15-year light ` +
      `commercial warranty. ${c.sqft_box} sq ft per box (${c.pcs_box} planks), ${c.box_pallet} boxes per pallet.`;
    const descShort = `SPC waterproof rigid-core vinyl plank — 9 x 60 in, ${c.thickness}, 26 mil wear layer.`;

    const prod = await upsertProduct(vendorId, brandId, catPlank, {
      name: c.name, collection: c.collection,
      description_short: descShort, description_long: descLong,
    });
    prod.is_new ? pNew++ : pUpd++;

    const sku = await upsertSku(prod.id, {
      vendor_sku: c.code,                 // e.g. MANGO701 → "Mango701"
      internal_sku: `MANGO-${c.num}`,     // e.g. MANGO-701
      variant_name: '9 x 60 in Plank',
      // sell_by 'box' (not 'sqft') → storefront coverage calc rounds UP to whole
      // cartons; 'sqft' charges exact footage. price_basis stays per_sqft (/sqft
      // label). Store-wide flooring convention.
      sell_by: 'box', variant_type: null,
    });
    sku.is_new ? sNew++ : sUpd++;
    plankSkuIds.push(sku.id);

    await upsertPricing(sku.id, c.cost, keystone(c.cost), 'per_sqft');
    await upsertPackaging(sku.id, { sqft_per_box: c.sqft_box, pieces_per_box: c.pcs_box, boxes_per_pallet: c.box_pallet });

    await setAttr(sku.id, 'material', 'SPC Vinyl');
    await setAttr(sku.id, 'construction', 'Rigid Core (SPC)');
    await setAttr(sku.id, 'size', '9 x 60 in');
    await setAttr(sku.id, 'width', '9 in');
    await setAttr(sku.id, 'length', '60 in');
    await setAttr(sku.id, 'thickness', c.thickness);
    await setAttr(sku.id, 'wear_layer', '26 mil');
    await setAttr(sku.id, 'finish', 'Painted Bevel');
    await setAttr(sku.id, 'surface_texture', 'Wood Texture');
    await setAttr(sku.id, 'underlayer', 'Attached IXPE Pad');

    // Media: primary plank render + lifestyle room scene (vendor product-page order)
    const img = images[c.slug];
    if (img && img.primary) {
      await upsertMedia(prod.id, img.primary, 'primary', 0);
      if (img.lifestyle && img.lifestyle !== img.primary) await upsertMedia(prod.id, img.lifestyle, 'lifestyle', 1);
      mediaN++;
    } else {
      console.warn(`  ! no image for ${c.name}`);
    }

    console.log(`  ${prod.is_new ? '+' : '~'} ${c.name} (${c.collection}) — cost $${c.cost} → retail $${keystone(c.cost)}/sf`);
  }

  // ---- Moldings: one accessory product, attached to every plank ----
  const moldProd = await upsertProduct(vendorId, brandId, catMold, {
    name: 'Mango Moldings',
    collection: 'Mango Moldings',
    description_short: 'Color-coordinated SPC transition moldings for Mango vinyl plank flooring.',
    description_long: 'Matching SPC transition and trim moldings for Mango rigid-core vinyl plank floors — reducer, T-molding, quarter round, and stair nose. Sold per piece.',
  });
  moldProd.is_new ? pNew++ : pUpd++;
  console.log(`\n  ${moldProd.is_new ? '+' : '~'} Mango Moldings (accessory product)`);

  const moldSkuIds = [];
  for (const m of MOLDINGS) {
    const sku = await upsertSku(moldProd.id, {
      vendor_sku: m.vendor_sku, internal_sku: m.internal_sku,
      variant_name: m.label, sell_by: 'unit', variant_type: 'accessory', accessory_label: m.label,
    });
    sku.is_new ? sNew++ : sUpd++;
    moldSkuIds.push(sku.id);
    await upsertPricing(sku.id, m.cost, keystone(m.cost), 'per_unit');
    await setAttr(sku.id, 'material', 'SPC Vinyl');
    console.log(`    ${sku.is_new ? '+' : '~'} ${m.label} — cost $${m.cost} → retail $${keystone(m.cost)}/ea`);
  }

  // Attach all 4 moldings to every plank SKU (Matching Accessories).
  let links = 0;
  for (const parentId of plankSkuIds) {
    let so = 0;
    for (const accId of moldSkuIds) { await linkAccessory(parentId, accId, so++); links++; }
  }

  console.log(`\nProducts: ${pNew} new, ${pUpd} updated`);
  console.log(`SKUs:     ${sNew} new, ${sUpd} updated`);
  console.log(`Media:    ${mediaN} plank products with photos`);
  console.log(`Accessory links: ${links} (${plankSkuIds.length} planks x ${moldSkuIds.length} moldings)`);
  await pool.end();
  console.log('\nDone.');
}

main().catch(e => { console.error(e); process.exit(1); });
