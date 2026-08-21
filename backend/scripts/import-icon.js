#!/usr/bin/env node
/**
 * Import Icon Tile — 2026 General Pricelist.
 *
 * Icon Tile (Los Angeles, own quarries) is a natural-stone + porcelain hardscape
 * distributor. Lines & categories:
 *   Pavers (travertine/limestone/sandstone/marble/porcelain)  -> pavers
 *   Pool & modern coping, steps, quarter round                -> pool-coping
 *   Split-face / rock-face ledger panels                      -> stacked-stone
 *   Mosaics                                                   -> mosaic-tile
 *   Porcelain / ceramic / natural-stone field tile            -> porcelain-tile / ceramic-tile / natural-stone
 *   Wall caps, column caps, wainscot sills, freeform walling  -> hardscaping
 *   Liners, pencils, needles, crowns, colosseo, edge trim     -> trim-accessories
 *
 * Pricing: pricelist "Unit price" = Icon's dealer price = Roma's COST.
 * Retail = nearestNine(cost x 1.6) — store-standard keystone + charm pricing, baked by
 * build-icon-catalog.py (all Icon costs >= ~$3, so the cost+$0.99 covering floor never binds).
 *
 * Selling model: area products (pavers/field tile) sell_by='box' price_basis='per_sqft'
 * (coverage calculator); everything sold by the piece/sheet (copings, steps, ledger
 * panels, mosaics, trim, caps) is sell_by='unit' price_basis='per_unit'. See
 * [[selling-conventions]] / [[natural-stone-per-piece]].
 *
 * Vendor name is HIDDEN ([[hide-public-brand]]): hide_public_name=true + a random
 * 3-digit public_code (640) — customers see "640" instead of "Icon Tile". Product
 * descriptions never name the vendor (build script omits the distributor clause).
 *
 * Data: backend/data/icon/catalog.json (built by build-icon-catalog.py from the xlsx).
 * Images are a separate follow-up pass (icontileus.com is WooCommerce behind mod_security).
 *
 * Usage: docker compose exec api node scripts/import-icon.js
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

const DATA_DIR = process.env.ICON_DATA_DIR || path.join(__dirname, '..', 'data', 'icon');
const catalog = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'catalog.json'), 'utf8'));
let images = {};
try { images = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'images.json'), 'utf8')); }
catch { console.warn('! images.json not found — importing without photos (image pass is separate)'); }

const VENDOR_CODE = 'ICON';
const VENDOR_PUBLIC_CODE = '640';   // hidden vendor: customers see this instead of the name

// ==================== Helpers ====================
async function upsertVendor() {
  const res = await pool.query(`
    INSERT INTO vendors (name, code, public_code, website, address, notes, hide_public_name)
    VALUES ($1,$2,$3,$4,$5,$6,true)
    ON CONFLICT (code) DO UPDATE SET
      name=EXCLUDED.name,
      public_code=COALESCE(vendors.public_code, EXCLUDED.public_code),
      website=EXCLUDED.website,
      address=COALESCE(EXCLUDED.address, vendors.address),
      notes=COALESCE(EXCLUDED.notes, vendors.notes),
      hide_public_name=true,
      updated_at=CURRENT_TIMESTAMP
    RETURNING id
  `, ['Icon Tile', VENDOR_CODE, VENDOR_PUBLIC_CODE,
      'https://icontileus.com',
      'Los Angeles, CA',
      'Natural-stone & porcelain hardscape distributor (own quarries): travertine/limestone/marble/granite/sandstone pavers & pool copings, porcelain pavers, split-face/rock-face ledger panels, mosaics, field tile, wall caps & walling. 2026 General Pricelist = Roma cost; retail = cost x1.6. Vendor name hidden from customers (public code 640).']);
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

// Ensure attribute rows exist so setAttr can persist them (it silently skips unknown slugs).
// 'profile' (edge profile) is new; it renders as an independent variant pill for copings.
async function ensureAttributes() {
  const defs = [
    ['profile', 'Edge Profile', 5],
    ['thickness', 'Thickness', 6],
  ];
  for (const [slug, name, order] of defs) {
    await pool.query(`
      INSERT INTO attributes (slug, name, display_order) VALUES ($1,$2,$3)
      ON CONFLICT (slug) DO NOTHING
    `, [slug, name, order]);
  }
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
    INSERT INTO skus (product_id, vendor_sku, internal_sku, variant_name, sell_by, variant_type)
    VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT (internal_sku) DO UPDATE SET
      product_id=EXCLUDED.product_id, vendor_sku=EXCLUDED.vendor_sku,
      variant_name=EXCLUDED.variant_name, sell_by=EXCLUDED.sell_by, updated_at=CURRENT_TIMESTAMP
    RETURNING id, (xmax = 0) AS is_new
  `, [productId, s.vendor_sku, s.internal_sku, s.variant_name, s.sell_by || 'unit', s.variant_type || null]);
  return res.rows[0];
}

async function upsertPricing(skuId, s) {
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
    VALUES ($1,$2,$3,$3,$4)
    ON CONFLICT DO NOTHING
  `, [productId, assetType, url, sortOrder]);
}

// ==================== Main ====================
async function main() {
  console.log('=== Icon Tile Import ===\n');

  const vendorId = await upsertVendor();
  console.log('Vendor:', vendorId, '(Icon Tile — hidden, public code', VENDOR_PUBLIC_CODE + ')');

  const brandId = await upsertBrand('Icon Tile', 'ICON');
  await linkVendorBrand(vendorId, brandId);
  await ensureAttributes();

  let pNew = 0, pUpd = 0, sNew = 0, sUpd = 0, mediaN = 0, noCat = new Set(), noImg = 0;
  for (const p of catalog) {
    const categoryId = await getCategoryId(p.category_slug);
    if (!categoryId) { noCat.add(p.category_slug); continue; }

    const prod = await upsertProduct(vendorId, brandId, categoryId, p);
    prod.is_new ? pNew++ : pUpd++;

    for (const s of p.skus) {
      const sku = await upsertSku(prod.id, s);
      sku.is_new ? sNew++ : sUpd++;
      await upsertPricing(sku.id, s);
      const merged = { ...(p.attrs || {}), ...(s.attrs || {}) };
      for (const [slug, val] of Object.entries(merged)) await setAttr(sku.id, slug, val);
    }

    // media (product-level) — present only if a later image pass populated images.json
    const img = p.slug ? images[p.slug] : (images[p.name] || null);
    const primary = img && (img.primary || (img.gallery && img.gallery[0]));
    if (primary) {
      await upsertMedia(prod.id, primary, 'primary', 0);
      mediaN++;
      const gallery = (img.gallery || []).filter(u => u !== primary);
      for (let i = 0; i < gallery.length && i < 5; i++) await upsertMedia(prod.id, gallery[i], 'alternate', i + 1);
    } else { noImg++; }
  }

  console.log(`\nProducts: ${pNew} new, ${pUpd} updated`);
  console.log(`SKUs:     ${sNew} new, ${sUpd} updated`);
  console.log(`Media:    ${mediaN} products with a primary photo (${noImg} without — image pass pending)`);
  if (noCat.size) console.log(`! MISSING categories (skipped): ${[...noCat].join(', ')}`);
  await pool.end();
  console.log('\nDone.');
}

main().catch(e => { console.error(e); process.exit(1); });
