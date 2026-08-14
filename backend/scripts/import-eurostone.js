#!/usr/bin/env node
/**
 * Import Eurostone (Surfaces Unlimited) — 2026 Distributor Price List.
 *
 * Eurostone / Surfaces Unlimited (Beverly Hills, CA HQ; yard in Downtown LA, by appointment)
 * is a slab distributor. Lines:
 *   - Quartz     2cm engineered quartz slabs (Zero-silica + CMT recycled)  -> quartz-countertops
 *   - Porcelain  1/2" large-format porcelain slabs                         -> porcelain-slabs
 *   - Sealer     Stain-Proof impregnating sealer                           -> adhesives-sealants
 *
 * Pricing: PDF lists Eurostone's distributor price = Roma's COST.
 * Retail = cost x 1.6 keystone (store standard), rounded to $0.05 (computed in build script).
 * Slabs are whole pieces: sell_by='unit', price_basis='per_unit', piece area in
 * packaging.sqft_per_box so the storefront renders them as slabs (/ea).
 *
 * Data: catalog.json (from build-eurostone-catalog.js) + images.json (scraped swatches/galleries
 * from eurostonequartzcountertops.com, keyed by product slug).
 *
 * Usage: docker compose exec -e ES_DATA_DIR=/app/data/eurostone api node scripts/import-eurostone.js
 */

import pg from 'pg';
import fs from 'fs';
import path from 'path';

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: 5432,
  database: 'flooring_pim',
  user: 'postgres',
  password: 'postgres',
});

const DATA_DIR = process.env.ES_DATA_DIR || path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'data', 'eurostone');
const catalog = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'catalog.json'), 'utf8'));
// Prefer locally-mirrored images (images-local.json → /uploads/... paths). i.ibb.co
// hotlink-protects against the platform image proxy's UA, so remote ibb URLs render as
// "image not found" on the storefront; mirror-eurostone-images.mjs downloads them local.
let images = {};
try { images = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'images-local.json'), 'utf8')); console.log('Using images-local.json (mirrored)'); }
catch {
  try { images = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'images.json'), 'utf8')); console.warn('! images-local.json not found — falling back to remote images.json (may not render via proxy)'); }
  catch { console.warn('! no images file — importing without photos'); }
}

// Prop 65: fabricating silica-bearing quartz/porcelain generates respirable crystalline silica.
// Zero-silica lines are exempt; sealer is inert.
const hasSilica = (p) => p.silica === 'cmt' || p.silica === 'porcelain' || (p.silica === '' && p.line === 'Quartz');

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
  const silica = hasSilica(p);
  const res = await pool.query(`
    INSERT INTO products (vendor_id, brand_id, name, collection, category_id, status, description_short, description_long, prop65_warning, prop65_chemicals)
    VALUES ($1,$2,$3,$4,$5,'active',$6,$7,$8,$9)
    ON CONFLICT ON CONSTRAINT products_vendor_collection_name_unique DO UPDATE SET
      brand_id=EXCLUDED.brand_id, category_id=EXCLUDED.category_id, status='active',
      description_short=EXCLUDED.description_short, description_long=EXCLUDED.description_long,
      prop65_warning=EXCLUDED.prop65_warning, prop65_chemicals=EXCLUDED.prop65_chemicals,
      updated_at=CURRENT_TIMESTAMP
    RETURNING id, (xmax = 0) AS is_new
  `, [vendorId, brandId, p.name, p.collection, categoryId,
      p.description.slice(0, 250), p.description,
      silica, silica ? 'Crystalline silica (respirable — generated during fabrication)' : null]);
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

async function main() {
  console.log('=== Eurostone Import ===\n');

  const vendorId = await upsertVendor('Eurostone', 'EURO', {
    website: 'https://www.eurostone.us',
    email: 'info@eurostone.us',
    phone: '310-967-8000',
    address: '215 S. La Cienega Blvd. #300, Beverly Hills, CA 90211',
    notes: 'Surfaces Unlimited (dba Eurostone). Slab distributor: 2cm engineered quartz (Zero-silica + CMT recycled) + 1/2" porcelain slabs. Yard in Downtown LA, by appointment only. 2026 distributor price list = Roma cost; retail = cost x 1.6.',
  });
  console.log('Vendor:', vendorId);

  const brandId = await upsertBrand('Eurostone', 'EUROSTONE', 'https://www.eurostone.us');
  await linkVendorBrand(vendorId, brandId, true);
  console.log('Brand:', brandId);

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

    const img = images[p.slug];
    const primary = img && img.primary || null;
    if (primary) {
      await upsertMedia(prod.id, primary, 'primary', 0);
      mediaN++;
      const gallery = (img.gallery || []).filter(u => u && u !== primary);
      for (let i=0; i<gallery.length && i<5; i++) await upsertMedia(prod.id, gallery[i], 'alternate', i+1);
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
