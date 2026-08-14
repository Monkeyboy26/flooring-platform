#!/usr/bin/env node
/**
 * Import the GemCore catalog into the PIM.
 *
 * Reward Flooring = BRAND (code REWARD) under the Galleher Duffy vendor (code GALL).
 * Reward is Galleher's proprietary hardwood line. Heritage is solid; the rest engineered. See [[monarch-onboarding]], [[vendor-sub-brands]].
 *
 * Source: backend/data/monarch/catalog.json + images.json (built by
 * build-reward-catalog.js). Retail = cost x 1.6 nickel-rounded (keystone).
 * Flooring sold per sqft by the box. Collections with no published Galleher cost
 * (Premio/Regent/True Teak/Unfinished) import as DRAFT with no price.
 *
 * Accessories (moldings) grouped into "{Collection} Trims" products and linked to
 * their plank color via sku_accessories; color-unmatched priced trims go under a
 * "Monarch Trims & Moldings" product (unlinked). Garrison pattern.
 *
 * Usage: docker compose exec api node scripts/import-gemcore.js
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
const DATA = process.env.PALACIO_DATA_DIR || path.join(__dirname, '..', 'data', 'palacio');
const catalog = JSON.parse(fs.readFileSync(path.join(DATA, 'catalog.json'), 'utf8'));
let images = {};
try { images = JSON.parse(fs.readFileSync(path.join(DATA, 'images.json'), 'utf8')); }
catch { console.warn('! images.json not found — importing without photos'); }

const keystone = (cost) => parseFloat((Math.round(cost * catalog.markup / 0.05) * 0.05).toFixed(2));

// ==================== Helpers ====================
async function upsertVendor(v) {
  const r = await pool.query(`
    INSERT INTO vendors (name, code, website, address, notes)
    VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT (code) DO UPDATE SET
      name=EXCLUDED.name, website=EXCLUDED.website,
      address=COALESCE(EXCLUDED.address, vendors.address), notes=EXCLUDED.notes,
      updated_at=CURRENT_TIMESTAMP
    RETURNING id`, [v.name, v.code, v.website, v.address, v.notes]);
  return r.rows[0].id;
}
async function upsertBrand(b) {
  const r = await pool.query(`
    INSERT INTO brands (name, code, website) VALUES ($1,$2,$3)
    ON CONFLICT (code) DO UPDATE SET name=EXCLUDED.name,
      website=COALESCE(EXCLUDED.website, brands.website), updated_at=CURRENT_TIMESTAMP
    RETURNING id`, [b.name, b.code, b.website]);
  return r.rows[0].id;
}
async function linkVendorBrand(vendorId, brandId, isPrimary) {
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
  const r = await pool.query(`
    INSERT INTO products (vendor_id, brand_id, name, collection, category_id, status, description_short, description_long)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT ON CONSTRAINT products_vendor_collection_name_unique DO UPDATE SET
      brand_id=EXCLUDED.brand_id, category_id=EXCLUDED.category_id, status=EXCLUDED.status,
      description_short=EXCLUDED.description_short, description_long=EXCLUDED.description_long,
      updated_at=CURRENT_TIMESTAMP
    RETURNING id, (xmax = 0) AS is_new`,
    [vendorId, brandId, p.name, p.collection, categoryId, p.status || 'active', p.description_short, p.description_long]);
  return r.rows[0];
}
async function upsertSku(productId, s) {
  const r = await pool.query(`
    INSERT INTO skus (product_id, vendor_sku, internal_sku, variant_name, sell_by, variant_type, accessory_label, status)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT (internal_sku) DO UPDATE SET
      product_id=EXCLUDED.product_id, vendor_sku=EXCLUDED.vendor_sku, variant_name=EXCLUDED.variant_name,
      sell_by=EXCLUDED.sell_by, variant_type=EXCLUDED.variant_type, accessory_label=EXCLUDED.accessory_label,
      status=EXCLUDED.status, updated_at=CURRENT_TIMESTAMP
    RETURNING id, (xmax = 0) AS is_new`,
    [productId, s.vendor_sku, s.internal_sku, s.variant_name || null, s.sell_by || 'box',
     s.variant_type || null, s.accessory_label || null, s.status || 'active']);
  return r.rows[0];
}
async function upsertPricing(skuId, cost, retail, basis) {
  await pool.query(`
    INSERT INTO pricing (sku_id, cost, retail_price, price_basis) VALUES ($1,$2,$3,$4)
    ON CONFLICT (sku_id) DO UPDATE SET cost=EXCLUDED.cost, retail_price=EXCLUDED.retail_price, price_basis=EXCLUDED.price_basis
  `, [skuId, cost, retail, basis]);
}
async function upsertPackaging(skuId, sqftBox) {
  if (sqftBox == null) return;
  await pool.query(`
    INSERT INTO packaging (sku_id, sqft_per_box) VALUES ($1,$2)
    ON CONFLICT (sku_id) DO UPDATE SET sqft_per_box=EXCLUDED.sqft_per_box
  `, [skuId, sqftBox]);
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
  const id = await attrId(slug); if (!id) return;
  await pool.query(`
    INSERT INTO sku_attributes (sku_id, attribute_id, value) VALUES ($1,$2,$3)
    ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value=EXCLUDED.value
  `, [skuId, id, String(value).trim()]);
}
async function upsertMedia(productId, skuId, url, assetType, sortOrder) {
  if (!url) return;
  if (skuId) {
    await pool.query(`
      INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
      VALUES ($1,$2,$3,$4,$4,$5)
      ON CONFLICT (product_id, sku_id, asset_type, sort_order) WHERE sku_id IS NOT NULL
      DO UPDATE SET url=EXCLUDED.url, original_url=EXCLUDED.original_url`,
      [productId, skuId, assetType, url, sortOrder]);
  } else {
    await pool.query(`
      INSERT INTO media_assets (product_id, asset_type, url, original_url, sort_order)
      VALUES ($1,$2,$3,$3,$4)
      ON CONFLICT (product_id, asset_type, sort_order) WHERE sku_id IS NULL
      DO UPDATE SET url=EXCLUDED.url, original_url=EXCLUDED.original_url`,
      [productId, assetType, url, sortOrder]);
  }
}
async function linkAccessory(parentSkuId, accessorySkuId, sortOrder) {
  await pool.query(`
    INSERT INTO sku_accessories (parent_sku_id, accessory_sku_id, sort_order) VALUES ($1,$2,$3)
    ON CONFLICT (parent_sku_id, accessory_sku_id) DO UPDATE SET sort_order=EXCLUDED.sort_order
  `, [parentSkuId, accessorySkuId, sortOrder]);
}

function descFor(p, s) {
  const kind = s.material || 'Luxury Vinyl';
  const wp = /hardwood/i.test(kind) ? '' : ' Waterproof.';
  const bName = p.brandName || 'Palacio';
  const short = `${kind} — ${p.collection} ${p.name}${s.width ? `, ${s.width}" wide` : ''}${s.wear_layer ? `, ${s.wear_layer} wear layer` : ''}.${wp}`;
  const long = [
    `${bName} ${p.collection} ${p.name} — ${kind.toLowerCase()}.`,
    s.thickness ? `${s.thickness} thick${s.width ? ` x ${s.width}" wide` : ''}${s.length ? ` x ${s.length}" plank` : ''}.` : '',
    s.wear_layer ? `${s.wear_layer} wear layer.` : '',
    s.surface_texture ? `${s.surface_texture} texture.` : '',
    s.finish ? `${s.finish} finish.` : '',
    wp.trim(),
    s.sqft_box ? `${s.sqft_box} sq ft per carton.` : '',
  ].join(' ').replace(/\s+/g, ' ').trim();
  return { short, long };
}

// ==================== Main ====================
async function main() {
  console.log('=== Reward Flooring Import (Galleher Duffy) ===\n');
  const vendorId = await upsertVendor(catalog.vendor);
  const brandMap = {};
  for (const b of catalog.brands) { const id = await upsertBrand(b); await linkVendorBrand(vendorId, id, false); brandMap[b.code] = id; }
  console.log(`Vendor: ${catalog.vendor.name} (${vendorId})`);
  console.log(`Brands: ${catalog.brands.map((b) => `${b.name} (${brandMap[b.code]})`).join(', ')}\n`);

  const catTrim = await getCategoryId('transitions-moldings');
  const _catCache = {};
  const catId = async (slug) => (_catCache[slug] ??= await getCategoryId(slug));

  let pNew = 0, pUpd = 0, sNew = 0, sUpd = 0, mediaN = 0, noImg = 0, docN = 0;
  const skuByInternal = new Map(); // plank internal_sku -> sku id (for accessory linking)

  // ---- Pass 1: plank colors ----
  for (const p of catalog.products) {
    const s = p.skus[0];
    const { short, long } = descFor(p, s);
    const brandId = brandMap[p.brand] || Object.values(brandMap)[0];
    const cat = await catId(p.category || 'lvp-plank');
    const prod = await upsertProduct(vendorId, brandId, cat, {
      name: p.name, collection: p.collection, status: p.status, description_short: short, description_long: long,
    });
    prod.is_new ? pNew++ : pUpd++;

    const sku = await upsertSku(prod.id, {
      vendor_sku: s.vendor_sku || s.internal_sku, internal_sku: s.internal_sku, variant_name: s.variant_name,
      sell_by: 'box', status: s.status,
    });
    sku.is_new ? sNew++ : sUpd++;
    skuByInternal.set(s.internal_sku, sku.id);

    if (s.cost != null) await upsertPricing(sku.id, s.cost, keystone(s.cost), 'per_sqft');
    await upsertPackaging(sku.id, s.sqft_box);

    await setAttr(sku.id, 'material', s.material || 'Luxury Vinyl');
    await setAttr(sku.id, 'brand', p.brandName || (catalog.brands.find(b=>b.code===p.brand)||{}).name || '');
    await setAttr(sku.id, 'color', s.color);
    await setAttr(sku.id, 'collection', p.collection);
    await setAttr(sku.id, 'construction', s.construction);
    await setAttr(sku.id, 'finish', s.finish);
    await setAttr(sku.id, 'surface_texture', s.surface_texture);
    await setAttr(sku.id, 'wear_layer', s.wear_layer);
    await setAttr(sku.id, 'size', s.size);
    await setAttr(sku.id, 'thickness', s.thickness);
    await setAttr(sku.id, 'width', s.width);
    await setAttr(sku.id, 'length', s.length);
    await setAttr(sku.id, 'technology', s.waterproof);

    const img = images[s.internal_sku];
    if (img && img.primary) {
      await upsertMedia(prod.id, null, img.primary, 'primary', 0);
      let so = 1;
      for (const url of img.lifestyle || []) if (url && url !== img.primary) await upsertMedia(prod.id, null, url, 'lifestyle', so++);
      mediaN++;
    } else noImg++;

    if (p.spec_pdf) { await upsertMedia(prod.id, null, p.spec_pdf, 'spec_pdf', 0); docN++; }

    console.log(`  ${prod.is_new ? '+' : '~'} [${p.collection}] ${p.name} ${s.cost != null ? '$' + s.cost + '/sf' : '(draft, no price)'}${img ? '' : '  [no photo]'}`);
  }

  // ---- Pass 2: accessory (molding) products + links ----
  // Wipe existing Monarch accessory links so re-runs prune stale ones.
  await pool.query(`
    DELETE FROM sku_accessories WHERE accessory_sku_id IN (
      SELECT s.id FROM skus s JOIN products p ON p.id=s.product_id JOIN vendors v ON v.id=p.vendor_id
      WHERE v.code=$1 AND COALESCE(s.variant_type,'')='accessory')
  `, [catalog.vendor.code]);
  // Remove any legacy 'color' attribute on Monarch accessory SKUs (superseded by
  // matching_color) so the storefront's color-equality filter no longer hides them.
  await pool.query(`
    DELETE FROM sku_attributes WHERE attribute_id=(SELECT id FROM attributes WHERE slug='color')
      AND sku_id IN (
        SELECT s.id FROM skus s JOIN products p ON p.id=s.product_id JOIN vendors v ON v.id=p.vendor_id
        WHERE v.code=$1 AND COALESCE(s.variant_type,'')='accessory')
  `, [catalog.vendor.code]);

  const trimProdByCol = new Map();
  let mProd = 0, mSku = 0, links = 0, mSkipped = 0, linkedAcc = 0;

  async function trimProduct(brandCode, collection) {
    const key = `${brandCode}|${collection}`;
    if (trimProdByCol.has(key)) return trimProdByCol.get(key);
    const bName = (catalog.brands.find((b) => b.code === brandCode) || {}).name || 'Palacio';
    const name = collection === '__generic__' ? `${bName} Trims & Moldings` : `${collection} Trims`;
    const prod = await upsertProduct(vendorId, brandMap[brandCode] || Object.values(brandMap)[0], catTrim, {
      name, collection: name, status: 'active',
      description_short: `Color-matched moldings and stair parts for ${bName}${collection === '__generic__' ? '' : ' ' + collection} floors.`,
      description_long: `Color-matched transitions — T-molding, reducer, end cap/threshold, stair nose, quarter round — for ${bName} ${collection === '__generic__' ? 'floors' : collection}. Sold per piece.`,
    });
    prod.is_new ? mProd++ : 0;
    trimProdByCol.set(key, prod);
    return prod;
  }

  for (const a of catalog.accessories) {
    if (a.cost == null) { mSkipped++; continue; } // skip $0/unpriced trims
    const prod = await trimProduct(a.brand || 'PAL', a.collection || '__generic__');
    const msku = await upsertSku(prod.id, {
      vendor_sku: a.itemCode, internal_sku: a.itemCode, variant_name: a.color ? `${a.type} — ${a.color}` : a.type,
      sell_by: 'unit', variant_type: 'accessory', accessory_label: a.type, status: 'active',
    });
    msku.is_new ? mSku++ : 0;
    await upsertPricing(msku.id, a.cost, keystone(a.cost), 'per_unit');
    await setAttr(msku.id, 'material', a.material || 'Vinyl');
    await setAttr(msku.id, 'brand', (catalog.brands.find((b) => b.code === a.brand) || {}).name || '');
    if (a.collection) await setAttr(msku.id, 'collection', a.collection);
    // Store under matching_color (NOT the 'color' slug): the storefront gates
    // accessories on parent.color == accessory.color, which would hide a base-color
    // molding (e.g. "Allier") from its herringbone plank ("Allier Herringbone") or
    // a Vinland species molding from its graded planks. Our sku_accessories links
    // are already color-precise, so we don't want that second filter.
    if (a.color) await setAttr(msku.id, 'matching_color', a.color);
    await setAttr(msku.id, 'product_type', a.type);

    let linkedAny = false;
    for (const pis of a.plank_internal_skus || []) {
      if (skuByInternal.has(pis)) { await linkAccessory(skuByInternal.get(pis), msku.id, 0); links++; linkedAny = true; }
    }
    if (linkedAny) linkedAcc++;
  }

  console.log(`\nPlank products: ${pNew} new, ${pUpd} updated`);
  console.log(`Plank SKUs:     ${sNew} new, ${sUpd} updated`);
  console.log(`Media:          ${mediaN} with photos, ${noImg} without · ${docN} spec PDFs`);
  console.log(`Trim products:  ${mProd} new · Trim SKUs: ${mSku} new · Linked accessories: ${linkedAcc} (${links} plank links) · Skipped ($0): ${mSkipped}`);
  await pool.end();
  console.log('\nDone.');
}

main().catch((e) => { console.error(e); process.exit(1); });
