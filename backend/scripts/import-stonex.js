#!/usr/bin/env node
/**
 * Import StoneX Tile and Stone Inc. — April-2026 price list.
 *
 * StoneX (1207 N. East St, Anaheim, CA 92805) is a natural-stone importer/
 * distributor: porcelain tiles/pavers/pool-copings, marble/limestone/travertine/
 * basalt/dolomite tiles + mosaics + pencils/chair-rails, pavers, pool copings,
 * ledger panels/corners and stone veneers. The price-list PRICE column is Roma's
 * COST (FOB Anaheim, full-box quantities); retail = cost x 1.6 keystone rounded
 * to $0.05 (computed in build-stonex-catalog.js — this importer writes it as-is).
 *
 * Selling conventions ([[selling-conventions]]):
 *   - Field tiles / pavers / pool-copings / ledger panels / veneers sell per SF
 *     (sell_by='sqft', price_basis='per_sqft').
 *   - Mosaic sheets sell PER SHEET (sell_by='unit', price_basis='per_unit',
 *     packaging.sqft_per_box = one-sheet coverage, pieces_per_box = 1).
 *   - Pencils / chair-rails / corners / slabs sell per piece (variant_type
 *     'accessory' for the linear trims).
 *
 * Data: catalog.json + images.json in DATA_DIR, produced by build-stonex-catalog.js
 * from the PDF and scraped stonextile.com product photos.
 *
 * Usage: docker compose exec api node scripts/import-stonex.js
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
const DATA_DIR = process.env.STONEX_DATA_DIR || path.join(__dirname, '..', 'data', 'stonex');
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

async function ensureCategory(slug, name, parentSlug, description, sortOrder) {
  let id = await getCategoryId(slug);
  if (id) return id;
  const parent = await getCategoryId(parentSlug);
  const r = await pool.query(`
    INSERT INTO categories (parent_id, name, slug, description, sort_order)
    VALUES ($1,$2,$3,$4,$5) RETURNING id
  `, [parent, name, slug, description, sortOrder]);
  console.log('  + created category ' + slug);
  return r.rows[0].id;
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
  console.log('=== StoneX Import ===\n');

  const vendorId = await upsertVendor('StoneX Tile and Stone Inc.', 'STX', {
    website: 'https://www.stonextile.com',
    email: 'orders@stonextile.com',
    phone: '714-635-3434',
    address: '1207 N. East St, Anaheim, CA 92805',
    notes: 'Natural-stone importer/distributor (Anaheim, CA). Porcelain tiles/pavers/pool-copings (incl. Made-in-USA pavers), marble/limestone/travertine/basalt/dolomite tiles + mosaics + pencils/chair-rails, pavers, pool copings, ledger panels/corners, stone veneers. April-2026 price list PRICE column = Roma COST; retail = cost x 1.6 keystone rounded to $0.05. FOB Anaheim; full-box quantities; 25% restock on approved returns within 30 days (store credit only); 3% credit-card processing fee.',
  });
  console.log('Vendor:', vendorId);

  const brandId = await upsertBrand('StoneX', 'STONEX', 'https://www.stonextile.com');
  await linkVendorBrand(vendorId, brandId, true);
  console.log('Brand:', brandId);

  // New leaf category for pool coping (sibling of pavers / stacked-stone under hardscaping).
  await ensureCategory('pool-coping', 'Pool Coping', 'hardscaping',
    'Finished stone and porcelain pool-edge coping — bullnose and eased-edge border pieces for pool decks and water features.', 3);

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
      if (s._flags && s._flags.made_usa) merged.country = 'USA (Made in USA)';
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
  if (noImg.length) console.log(`No photo (${noImg.length}): ${noImg.slice(0,40).join(', ')}${noImg.length>40?' …':''}`);
  await pool.end();
  console.log('\nDone.');
}

main().catch(e => { console.error(e); process.exit(1); });
