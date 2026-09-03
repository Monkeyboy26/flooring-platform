#!/usr/bin/env node
/**
 * Import Patricio Tile — handcrafted Talavera tile from Central Mexico.
 *
 * Patricio Tile (Long Beach, CA distributor, patriciotile.com). Q1 price list
 * (build-patricio-catalog.py -> catalog.json) parsed to per-piece COST; Woo store
 * (patriciotile.com wc/store API) supplies design names + product photos, matched
 * by model code / color (EXACT match only — never a wrong image).
 *
 * Sections & categories:
 *   La Paz relief, Santa Barbara, Hand Brush, Talavera Decorative (L-*),
 *   New Talavera, Solid Color, Subway, Rustico thin brick, Puro (PW*),
 *   Day of the Dead, Mexican Pavers (Saltillo/Lincoln) -> talavera-tile  [NEW leaf]
 *   Trim/liners/cornice/vcap/numbers, Aqua Mix sealers/cleaners/stains -> trim-accessories
 *   Talavera & relief murals -> medallions
 *
 * Selling model: EVERYTHING per piece ([[natural-stone-per-piece]] convention):
 *   sell_by='unit', price_basis='per_unit', packaging.sqft_per_box = one-piece area.
 * Pricing: PDF cost -> retail = base.js upsertPricing (keystone x1.6, nine-ending,
 *   covering floor on field tile/pavers). Vendor name HIDDEN (public code 562).
 *
 * Data: backend/data/patricio/catalog.json (built by build-patricio-catalog.py + attach-woo-images.py).
 * Usage: docker compose exec -T api node scripts/import-patricio.js
 */
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { upsertPricing as basePricing, upsertPackaging as basePackaging } from '../scrapers/base.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

const DATA_DIR = process.env.PATRICIO_DATA_DIR || path.join(__dirname, '..', 'data', 'patricio');
const catalog = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'catalog.json'), 'utf8'));

const VENDOR_CODE = 'PTCO';
const VENDOR_PUBLIC_CODE = '562';   // hidden vendor: customers see this instead of the name
const TALAVERA_CAT_ID = '650e8400-e29b-41d4-a716-4466554400f4';

const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/-+/g, '-');
function sizeLabel(sz) {
  const m = /^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/.exec(sz || '');
  if (m) return `${m[1]}" x ${m[2]}"`;
  return sz || null;
}

async function ensureCategory() {
  // NEW leaf "Talavera (Mexican Tile)" under the Tile parent (holds every Patricio field tile + paver)
  await pool.query(`
    INSERT INTO categories (id, name, slug, parent_id, sort_order, description)
    VALUES ($1, 'Talavera (Mexican Tile)', 'talavera-tile', '650e8400-e29b-41d4-a716-446655440010', 19,
            'Handcrafted Talavera & Mexican tile — hand-painted decorative, solid color, subway, relief, thin brick, saltillo pavers and more.')
    ON CONFLICT (slug) DO NOTHING
  `, [TALAVERA_CAT_ID]);
}

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
  `, ['Patricio Tile', VENDOR_CODE, VENDOR_PUBLIC_CODE,
      'https://patriciotile.com', 'Orders@PatricioTile.com', '562-505-6927',
      'P.O. Box 14526, Long Beach, CA 90853',
      'Handcrafted Talavera & Mexican tile distributor (Long Beach, CA): hand-painted decorative (La Paz, Talavera L-series), solid color, subway, hand-brush antique, Puro, Day of the Dead, Rustico thin clay brick, Saltillo/Lincoln pavers, trim/liners/murals, plus resold Aqua Mix care products. Sold PER PIECE. Q1 price list = Roma cost; retail = cost x1.6. Vendor name hidden from customers (public code 562).']);
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
async function getCategoryId(s) {
  if (s in catCache) return catCache[s];
  const r = await pool.query('SELECT id FROM categories WHERE slug=$1', [s]);
  return (catCache[s] = r.rows.length ? r.rows[0].id : null);
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
    VALUES ($1,$2,$3,$4,'unit',$5,'active')
    ON CONFLICT (internal_sku) DO UPDATE SET
      product_id=EXCLUDED.product_id, vendor_sku=EXCLUDED.vendor_sku,
      variant_name=EXCLUDED.variant_name, sell_by='unit',
      variant_type=EXCLUDED.variant_type, status='active', updated_at=CURRENT_TIMESTAMP
    RETURNING id, (xmax = 0) AS is_new
  `, [productId, s.vendor_sku, s.internal_sku, s.variant_name, s.variant_type || null]);
  return res.rows[0];
}

const attrCache = new Map();
async function attrId(s) {
  if (attrCache.has(s)) return attrCache.get(s);
  const r = await pool.query('SELECT id FROM attributes WHERE slug=$1', [s]);
  const id = r.rows.length ? r.rows[0].id : null;
  attrCache.set(s, id);
  return id;
}
async function setAttr(skuId, s, value) {
  if (value == null || value === '') return;
  const id = await attrId(s);
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

async function main() {
  console.log('=== Patricio Tile Import ===\n');
  await ensureCategory();
  const vendorId = await upsertVendor();
  console.log('Vendor:', vendorId, '(Patricio Tile — hidden, public code', VENDOR_PUBLIC_CODE + ')');
  const brandId = await upsertBrand('Patricio Tile', 'PTCO');
  await linkVendorBrand(vendorId, brandId);

  let pNew = 0, pUpd = 0, sNew = 0, sUpd = 0, priced = 0, withImg = 0, noCat = new Set();
  for (const p of catalog) {
    const categoryId = await getCategoryId(p.category);
    if (!categoryId) { noCat.add(p.category); continue; }
    if (!p.description) {
      p.description = `${p.name}. Handcrafted ${p.attrs?.material || 'Talavera'} tile from Central Mexico — sold per piece. Variation in color, size and surface is inherent to its handmade nature.`;
    }
    const prod = await upsertProduct(vendorId, brandId, categoryId, p);
    prod.is_new ? pNew++ : pUpd++;

    for (const s of p.skus) {
      const internal_sku = `PTCO-${slug(p.design)}-${slug(s.variant)}`;
      const variant_name = s.variant;
      const variant_type = p.accessory ? 'accessory' : null;
      const sku = await upsertSku(prod.id, { ...s, internal_sku, variant_name, variant_type });
      sku.is_new ? sNew++ : sUpd++;

      // pricing: cost from PDF; retail via base.js (keystone x1.6 -> nine-ending -> covering floor)
      const retail = Math.round(s.cost * 1.6 * 100) / 100;
      await basePricing(pool, sku.id, { cost: s.cost, retail_price: retail, price_basis: 'per_unit' },
                        { coveringFloor: !!p.covering });
      priced++;

      // packaging: area of one piece + per-piece weight (pavers)
      if (s.sqft > 0 || s.weight > 0) {
        await basePackaging(pool, sku.id, {
          sqft_per_box: s.sqft || null, pieces_per_box: 1, weight_per_box_lbs: s.weight || null,
        });
      }

      // attributes (per-sku): size + product-level material/finish/color/collection + per-sku color
      await setAttr(sku.id, 'size', sizeLabel(s.size));
      for (const key of ['material', 'finish', 'color', 'collection', 'style', 'pattern']) {
        if (p.attrs && p.attrs[key]) await setAttr(sku.id, key, p.attrs[key]);
      }
      if (s.color) await setAttr(sku.id, 'color', s.color);
    }

    // product-level media (Woo photos; exact-matched by code/color)
    const imgs = p.images || [];
    if (imgs.length) {
      await upsertMedia(prod.id, imgs[0], 'primary', 0);
      for (let i = 1; i < imgs.length && i < 6; i++) await upsertMedia(prod.id, imgs[i], 'alternate', i);
      withImg++;
    }
  }

  console.log(`\nProducts: ${pNew} new, ${pUpd} updated`);
  console.log(`SKUs:     ${sNew} new, ${sUpd} updated (${priced} priced)`);
  console.log(`Media:    ${withImg} products with photos (${catalog.length - withImg} photoless)`);
  if (noCat.size) console.log(`! MISSING categories (skipped): ${[...noCat].join(', ')}`);
  await pool.end();
  console.log('\nDone.');
}

main().catch(e => { console.error(e); process.exit(1); });
