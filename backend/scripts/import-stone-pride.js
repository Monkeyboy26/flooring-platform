#!/usr/bin/env node
/**
 * Import Stone Pride International Corp — 2026 D+ price lists.
 *
 * Stone Pride (Anaheim, CA distributor) — natural marble/stone + engineered
 * terrazzo. Lines & categories (see build-stone-pride-catalog.py header):
 *   Tile-<stone>  field tiles              -> natural-stone / terrazzo-tile
 *   MS-<stone>    mosaics (per sheet)       -> mosaic-tile
 *   FR-<stone>    chairrails/pencils/
 *                 baseboards/quarter rounds -> trim-accessories (accessory)
 *   MM-...        aluminum-backed medallions-> medallions  [new leaf]
 *   ML-/MSL-...   waterjet borders / liners -> trim-accessories (accessory)
 *
 * Pricing: "D+ Price" = Stone Pride dealer price = Roma COST. Retail baked in the
 * build step = nearestNine(cost x 1.6) (min cost $1.90 clears the covering floor).
 *
 * Selling model ([[natural-stone-per-piece]] / [[mosaic-per-sheet-conversion]]):
 *   sqft tile -> sell_by=unit, price_basis=per_sqft, packaging.sqft_per_box = piece area
 *   everything else (hex tile, mosaic sheet, trim, medallion, border) -> per_unit
 *
 * Vendor name HIDDEN ([[hide-public-brand]]): hide_public_name=true, public_code 714.
 *
 * Data: backend/data/stone-pride/catalog.json (built by build-stone-pride-catalog.py).
 * Usage: docker compose exec -T api node scripts/import-stone-pride.js
 */
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: 5432,
  database: 'flooring_pim',
  user: 'postgres',
  password: 'postgres',
});

const DATA_DIR = process.env.SP_DATA_DIR || path.join(__dirname, '..', 'data', 'stone-pride');
const catalog = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'catalog.json'), 'utf8'));
let images = {};
try { images = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'images.json'), 'utf8')); }
catch { console.warn('! images.json not found — importing without photos (image pass is separate)'); }
// Per-SKU (per-pattern) photos matched from stone-pride.com by item code — give each
// mosaic/tile format its own image on its variant (storefront resolves SKU image first).
let skuImages = {};
try { skuImages = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'sku-images.json'), 'utf8')); }
catch { /* optional — website image pass may not have run */ }

const VENDOR_CODE = 'STPR';
const VENDOR_PUBLIC_CODE = '714';   // hidden vendor: customers see this instead of the name

async function upsertVendor() {
  const res = await pool.query(`
    INSERT INTO vendors (name, code, public_code, website, email, phone, address, notes, hide_public_name)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true)
    ON CONFLICT (code) DO UPDATE SET
      name=EXCLUDED.name,
      public_code=COALESCE(vendors.public_code, EXCLUDED.public_code),
      website=EXCLUDED.website, email=COALESCE(EXCLUDED.email, vendors.email),
      phone=COALESCE(EXCLUDED.phone, vendors.phone),
      address=COALESCE(EXCLUDED.address, vendors.address),
      notes=EXCLUDED.notes, hide_public_name=true, updated_at=CURRENT_TIMESTAMP
    RETURNING id
  `, ['Stone Pride', VENDOR_CODE, VENDOR_PUBLIC_CODE,
      'https://www.stone-pride.com', 'info@stone-pride.com', '714-827-7058',
      '1305 N Knollwood Cir, Anaheim, CA 92801',
      'Natural marble/stone & engineered terrazzo distributor (Anaheim, CA): field tiles, per-sheet mosaics, chairrail/pencil/baseboard trim, aluminum-backed marble medallions, waterjet borders & mosaic liners. 2026 D+ price list = Roma cost; retail = cost x1.6. Vendor name hidden from customers (public code 714).']);
  return res.rows[0].id;
}

async function upsertBrand(name, code) {
  const res = await pool.query(`
    INSERT INTO brands (name, code) VALUES ($1,$2)
    ON CONFLICT (code) DO UPDATE SET name=EXCLUDED.name, updated_at=CURRENT_TIMESTAMP
    RETURNING id
  `, [name, code]);
  return res.rows[0].id;
}
async function linkVendorBrand(vendorId, brandId) {
  await pool.query(`
    INSERT INTO vendor_brands (vendor_id, brand_id, is_primary) VALUES ($1,$2,true)
    ON CONFLICT (vendor_id, brand_id) DO UPDATE SET is_primary = vendor_brands.is_primary OR EXCLUDED.is_primary
  `, [vendorId, brandId]);
}

const catCache = {};
async function getCategoryId(slug) {
  if (slug in catCache) return catCache[slug];
  const r = await pool.query('SELECT id FROM categories WHERE slug=$1', [slug]);
  return (catCache[slug] = r.rows.length ? r.rows[0].id : null);
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
  `, [vendorId, brandId, p.name, p.collection, categoryId, (p.description || '').slice(0, 250), p.description || null]);
  return res.rows[0];
}

async function upsertSku(productId, s) {
  const res = await pool.query(`
    INSERT INTO skus (product_id, vendor_sku, internal_sku, variant_name, sell_by, variant_type, status)
    VALUES ($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT (internal_sku) DO UPDATE SET
      product_id=EXCLUDED.product_id, vendor_sku=EXCLUDED.vendor_sku,
      variant_name=EXCLUDED.variant_name, sell_by=EXCLUDED.sell_by,
      variant_type=EXCLUDED.variant_type, status=EXCLUDED.status, updated_at=CURRENT_TIMESTAMP
    RETURNING id, (xmax = 0) AS is_new
  `, [productId, s.vendor_sku, s.internal_sku, s.variant_name, s.sell_by || 'unit', s.variant_type || null, s.status || 'active']);
  return res.rows[0];
}

async function upsertPackaging(skuId, pk) {
  if (!pk || !(parseFloat(pk.sqft_per_box) > 0)) return;
  await pool.query(`
    INSERT INTO packaging (sku_id, sqft_per_box, pieces_per_box)
    VALUES ($1,$2,$3)
    ON CONFLICT (sku_id) DO UPDATE SET sqft_per_box=EXCLUDED.sqft_per_box, pieces_per_box=EXCLUDED.pieces_per_box
  `, [skuId, pk.sqft_per_box, pk.pieces_per_box || 1]);
}

async function upsertPricing(skuId, s) {
  if (s.retail == null || s.cost == null) return;   // zero-cost SKUs stay unpriced/inactive
  await pool.query(`
    INSERT INTO pricing (sku_id, cost, retail_price, price_basis)
    VALUES ($1,$2,$3,$4)
    ON CONFLICT (sku_id) DO UPDATE SET cost=EXCLUDED.cost, retail_price=EXCLUDED.retail_price, price_basis=EXCLUDED.price_basis
  `, [skuId, s.cost, s.retail, s.price_basis || 'per_unit']);
}

const attrCache = new Map();
async function attrId(slug) {
  if (attrCache.has(slug)) return attrCache.get(slug);
  const r = await pool.query('SELECT id FROM attributes WHERE slug=$1', [slug]);
  const id = r.rows.length ? r.rows[0].id : null;
  attrCache.set(slug, id);
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
    VALUES ($1,$2,$3,$3,$4) ON CONFLICT DO NOTHING
  `, [productId, assetType, url, sortOrder]);
}

// SKU-level media (product_id AND sku_id set) — storefront resolves SKU images ahead of
// the shared product image, so a per-pattern photo wins on its own variant.
async function upsertMediaSku(productId, skuId, url, assetType, sortOrder) {
  if (!url) return;
  await pool.query(`
    INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
    VALUES ($1,$2,$3,$4,$4,$5) ON CONFLICT DO NOTHING
  `, [productId, skuId, assetType, url, sortOrder]);
}

async function main() {
  console.log('=== Stone Pride Import ===\n');
  const vendorId = await upsertVendor();
  console.log('Vendor:', vendorId, '(Stone Pride — hidden, public code', VENDOR_PUBLIC_CODE + ')');
  const brandId = await upsertBrand('Stone Pride', 'STPR');
  await linkVendorBrand(vendorId, brandId);

  let pNew = 0, pUpd = 0, sNew = 0, sUpd = 0, priced = 0, mediaN = 0, skuMediaN = 0, noCat = new Set();
  for (const p of catalog) {
    const categoryId = await getCategoryId(p.category_slug);
    if (!categoryId) { noCat.add(p.category_slug); continue; }
    const prod = await upsertProduct(vendorId, brandId, categoryId, p);
    prod.is_new ? pNew++ : pUpd++;
    for (const s of p.skus) {
      const sku = await upsertSku(prod.id, s);
      sku.is_new ? sNew++ : sUpd++;
      await upsertPricing(sku.id, s);
      if (s.retail != null) priced++;
      await upsertPackaging(sku.id, s.packaging);
      for (const [slug, val] of Object.entries(s.attrs || {})) await setAttr(sku.id, slug, val);
      // per-pattern photo matched from the website (if any)
      const si = skuImages[s.vendor_sku];
      if (si && si.primary) {
        await upsertMediaSku(prod.id, sku.id, si.primary, 'primary', 0);
        const gal = (si.gallery || []).filter(u => u !== si.primary);
        for (let i = 0; i < gal.length && i < 5; i++) await upsertMediaSku(prod.id, sku.id, gal[i], 'alternate', i + 1);
        skuMediaN++;
      }
    }
    // product-level media (only if a later image pass populated images.json, keyed by product name)
    const img = images[p.name];
    const primary = img && (img.primary || (img.gallery && img.gallery[0]));
    if (primary) {
      await upsertMedia(prod.id, primary, 'primary', 0);
      const gallery = (img.gallery || []).filter(u => u !== primary);
      for (let i = 0; i < gallery.length && i < 5; i++) await upsertMedia(prod.id, gallery[i], 'alternate', i + 1);
      mediaN++;
    }
  }

  console.log(`\nProducts: ${pNew} new, ${pUpd} updated`);
  console.log(`SKUs:     ${sNew} new, ${sUpd} updated (${priced} priced)`);
  console.log(`Media:    ${mediaN} products with a hero photo; ${skuMediaN} SKUs with a per-pattern photo`);
  if (noCat.size) console.log(`! MISSING categories (skipped): ${[...noCat].join(', ')}`);
  await pool.end();
  console.log('\nDone.');
}

main().catch(e => { console.error(e); process.exit(1); });
