#!/usr/bin/env node
/**
 * Import Stanza International LLC — 2025 Pebble & Marble Mosaic price list.
 *
 * Stanza (Chino, CA) is a natural-stone pebble / marble mosaic distributor
 * (established 2004, mostly Indonesian pebble stone + Chinese marble mosaics
 * and handcrafted stone vessel sinks). The PDF "WHOLESALE" column is Roma's
 * COST; retail = cost x 1.6 keystone rounded to $0.05.
 *
 * Selling conventions ([[selling-conventions]]):
 *   - Mosaic sheets sell PER SHEET (sell_by='unit', price_basis='per_unit',
 *     packaging.sqft_per_box = one-sheet coverage, pieces_per_box = 1).
 *   - Standing-pebble strips priced per-sqft sell by the box (sell_by='box',
 *     price_basis='per_sqft').
 *   - Vessel sinks sell per unit (variant_type='accessory').
 *
 * Data: catalog.json + images.json in DATA_DIR, produced by
 * build-stanza-catalog.js from the PDF and scraped product-page galleries.
 * The first image is the product-page main photo (primary); the rest are the
 * gallery (alternates) in page order.
 *
 * Usage: docker compose exec api node scripts/import-stanza.js
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
const DATA_DIR = process.env.STANZA_DATA_DIR || path.join(__dirname, '..', 'data', 'stanza');
const catalog = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'catalog.json'), 'utf8'));
let images = {};
try { images = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'images.json'), 'utf8')); }
catch { console.warn('! images.json not found — importing without photos'); }

// ==================== Helpers ====================
async function upsertVendor(name, code, extra = {}) {
  const res = await pool.query(`
    INSERT INTO vendors (name, code, website, email, phone, address, notes)
    VALUES ($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT (code) DO UPDATE SET
      name=EXCLUDED.name, website=EXCLUDED.website, email=COALESCE(EXCLUDED.email, vendors.email),
      phone=COALESCE(EXCLUDED.phone, vendors.phone), address=COALESCE(EXCLUDED.address, vendors.address),
      notes=COALESCE(EXCLUDED.notes, vendors.notes), updated_at=CURRENT_TIMESTAMP
    RETURNING id
  `, [name, code, extra.website||null, extra.email||null, extra.phone||null, extra.address||null, extra.notes||null]);
  return res.rows[0].id;
}

async function upsertBrand(name, code, website) {
  const res = await pool.query(`
    INSERT INTO brands (name, code, website) VALUES ($1,$2,$3)
    ON CONFLICT (code) DO UPDATE SET name=EXCLUDED.name, website=COALESCE(EXCLUDED.website, brands.website), updated_at=CURRENT_TIMESTAMP
    RETURNING id
  `, [name, code, website||null]);
  return res.rows[0].id;
}

async function linkVendorBrand(vendorId, brandId, isPrimary=false) {
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
  `, [vendorId, brandId, p.name, p.collection, categoryId, (p.description||'').slice(0, 250), p.description]);
  return res.rows[0];
}

async function upsertSku(productId, s) {
  const res = await pool.query(`
    INSERT INTO skus (product_id, vendor_sku, internal_sku, variant_name, sell_by, variant_type)
    VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT (internal_sku) DO UPDATE SET
      product_id=EXCLUDED.product_id, vendor_sku=EXCLUDED.vendor_sku,
      variant_name=EXCLUDED.variant_name, sell_by=EXCLUDED.sell_by,
      variant_type=EXCLUDED.variant_type, updated_at=CURRENT_TIMESTAMP
    RETURNING id, (xmax = 0) AS is_new
  `, [productId, s.vendor_sku, s.internal_sku, s.variant_name, s.sell_by||'unit', s.variant_type||null]);
  return res.rows[0];
}

async function upsertPricing(skuId, s) {
  await pool.query(`
    INSERT INTO pricing (sku_id, cost, retail_price, price_basis)
    VALUES ($1,$2,$3,$4)
    ON CONFLICT (sku_id) DO UPDATE SET cost=EXCLUDED.cost, retail_price=EXCLUDED.retail_price, price_basis=EXCLUDED.price_basis
  `, [skuId, s.cost, s.retail, s.price_basis||'per_unit']);
}

async function upsertPackaging(skuId, s) {
  if (s.sqft_per_box == null && s.pieces_per_box == null) return;
  await pool.query(`
    INSERT INTO packaging (sku_id, sqft_per_box, pieces_per_box)
    VALUES ($1,$2,$3)
    ON CONFLICT (sku_id) DO UPDATE SET
      sqft_per_box=COALESCE(EXCLUDED.sqft_per_box, packaging.sqft_per_box),
      pieces_per_box=COALESCE(EXCLUDED.pieces_per_box, packaging.pieces_per_box)
  `, [skuId, s.sqft_per_box, s.pieces_per_box]);
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

// ==================== Main ====================
async function main() {
  console.log('=== Stanza Import ===\n');

  const vendorId = await upsertVendor('Stanza International', 'STZ', {
    website: 'https://www.stanzawholesale.com',
    email: 'sales@stanzawholesale.com',
    phone: '909-548-3358',
    address: '13840 Magnolia Ave, Chino, CA 91710',
    notes: 'Natural-stone pebble & marble mosaic distributor (est. 2004). Indonesian pebble stone, jade/marble flat pebble, honeycomb hex, flower & 3D bubble mosaics, 2" hexagon marble mosaic, handcrafted stone vessel sinks. 2025 price list WHOLESALE column = Roma cost; retail = cost x 1.6. F.O.B. Chino; returns on stock only within 30 days, 20% restock.',
  });
  console.log('Vendor:', vendorId);

  const brandId = await upsertBrand('Stanza', 'STANZA', 'https://www.stanzawholesale.com');
  await linkVendorBrand(vendorId, brandId, true);
  console.log('Brand:', brandId);

  // Categories must already exist (mosaic-tile, bathroom-sinks).
  const catCache = {};
  const catFor = async (slug) => (catCache[slug] ??= await getCategoryId(slug));

  let pNew=0,pUpd=0,sNew=0,sUpd=0,mediaN=0,noImg=[];
  for (const p of catalog) {
    const categoryId = await catFor(p.category_slug);
    if (!categoryId) { console.warn('! missing category', p.category_slug, 'for', p.name); continue; }
    const prod = await upsertProduct(vendorId, brandId, categoryId, p);
    prod.is_new ? pNew++ : pUpd++;

    for (const s of p.skus) {
      const sku = await upsertSku(prod.id, s);
      sku.is_new ? sNew++ : sUpd++;
      await upsertPricing(sku.id, s);
      await upsertPackaging(sku.id, s);
      const merged = { ...(p.attrs||{}), ...(s.attrs||{}) };
      for (const [slug, val] of Object.entries(merged)) await setAttr(sku.id, slug, val);
    }

    // media: primary = product-page main photo, gallery = the rest (page order)
    const img = images[p.slug];
    if (img && img.primary) {
      await upsertMedia(prod.id, img.primary, 'primary', 0);
      mediaN++;
      const gallery = (img.gallery || []).filter(u => u && u !== img.primary);
      for (let i=0; i<gallery.length && i<8; i++) await upsertMedia(prod.id, gallery[i], 'alternate', i+1);
    } else {
      noImg.push(p.name);
    }
  }

  console.log(`\nProducts: ${pNew} new, ${pUpd} updated`);
  console.log(`SKUs:     ${sNew} new, ${sUpd} updated`);
  console.log(`Media:    ${mediaN} products with a primary photo`);
  if (noImg.length) console.log(`No photo (${noImg.length}): ${noImg.join(', ')}`);
  await pool.end();
  console.log('\nDone.');
}

main().catch(e => { console.error(e); process.exit(1); });
