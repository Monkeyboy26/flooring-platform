#!/usr/bin/env node
/**
 * Import Tile World — trade tile distributor (Anaheim, CA — tileworldusa.com).
 *
 * Onboarded as its OWN vendor carrying a single house brand (Tile World). Source:
 * backend/data/tileworld/catalog.json (built by build-tileworld-catalog.js from the
 * MAR 2024 price sheet) + images.json (tileworldusa.com photos staged to
 * uploads/tileworld/, matched to designs by normalized name, per-size where the site
 * carries that size — see [[line-item-display]]).
 *
 * MODEL: each design/color name is ONE product; its size × finish × origin rows are
 *   its SKUs (sell_by 'box', per_sqft). No trim/accessories on this sheet.
 *   Category: Floor and Wall / Outdoor → porcelain-tile; Wood Design Planks →
 *   wood-look-tile; 12X36 Wall Tiles → ceramic-tile.
 *
 * PRICING: price sheet = Roma COST; retail = cost x1.6 nickel keystone. FOB Anaheim.
 *
 * Full rebuild: purges existing TWD products + dependents, then re-imports.
 * Usage: docker compose exec api node scripts/import-tileworld.js
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
const DATA_DIR = process.env.TWD_DATA_DIR || path.join(__dirname, '..', 'data', 'tileworld');
const catalog = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'catalog.json'), 'utf8'));
let images = {};
try { images = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'images.json'), 'utf8')); }
catch { console.warn('! images.json not found — importing without photos'); }

const MARKUP = catalog.markup || 1.6;
const keystone = (cost) => parseFloat((Math.round(cost * MARKUP / 0.05) * 0.05).toFixed(2));
const SOURCE = 'tileworldusa.com';

// ==================== DB helpers ====================
async function upsertVendor(v) {
  const r = await pool.query(`
    INSERT INTO vendors (name, code, website, email, phone, address, notes)
    VALUES ($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT (code) DO UPDATE SET name=EXCLUDED.name, website=EXCLUDED.website,
      email=COALESCE(EXCLUDED.email, vendors.email), phone=COALESCE(EXCLUDED.phone, vendors.phone),
      address=COALESCE(EXCLUDED.address, vendors.address), notes=EXCLUDED.notes, updated_at=CURRENT_TIMESTAMP
    RETURNING id`, [v.name, v.code, v.website, v.email, v.phone, v.address, v.notes]);
  return r.rows[0].id;
}
async function upsertBrand(b) {
  const r = await pool.query(`
    INSERT INTO brands (name, code, website) VALUES ($1,$2,$3)
    ON CONFLICT (code) DO UPDATE SET name=EXCLUDED.name, website=COALESCE(EXCLUDED.website, brands.website), updated_at=CURRENT_TIMESTAMP
    RETURNING id`, [b.name, b.code, b.website || null]);
  return r.rows[0].id;
}
async function linkVendorBrand(vendorId, brandId, isPrimary) {
  await pool.query(`
    INSERT INTO vendor_brands (vendor_id, brand_id, is_primary) VALUES ($1,$2,$3)
    ON CONFLICT (vendor_id, brand_id) DO UPDATE SET is_primary = vendor_brands.is_primary OR EXCLUDED.is_primary`,
    [vendorId, brandId, isPrimary]);
}
async function getCategoryId(slug) {
  const r = await pool.query('SELECT id FROM categories WHERE slug=$1', [slug]);
  if (!r.rows.length) throw new Error(`category missing: ${slug}`);
  return r.rows[0].id;
}
async function upsertProduct(p) {
  const r = await pool.query(`
    INSERT INTO products (vendor_id, brand_id, name, collection, category_id, status, description_short, description_long)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT ON CONSTRAINT products_vendor_collection_name_unique DO UPDATE SET
      brand_id=EXCLUDED.brand_id, category_id=EXCLUDED.category_id, status=EXCLUDED.status,
      description_short=EXCLUDED.description_short, description_long=EXCLUDED.description_long, updated_at=CURRENT_TIMESTAMP
    RETURNING id`,
    [p.vendorId, p.brandId, p.name, p.collection, p.categoryId, p.status || 'active', p.short, p.long]);
  return r.rows[0].id;
}
async function upsertSku(s) {
  const r = await pool.query(`
    INSERT INTO skus (product_id, vendor_sku, internal_sku, variant_name, sell_by, variant_type, status)
    VALUES ($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT (internal_sku) DO UPDATE SET product_id=EXCLUDED.product_id, vendor_sku=EXCLUDED.vendor_sku,
      variant_name=EXCLUDED.variant_name, sell_by=EXCLUDED.sell_by, variant_type=EXCLUDED.variant_type,
      status=EXCLUDED.status, updated_at=CURRENT_TIMESTAMP
    RETURNING id`,
    [s.productId, s.vendor_sku, s.internal_sku, s.variant_name || null, s.sell_by || 'box',
     s.variant_type || null, s.status || 'active']);
  return r.rows[0].id;
}
async function upsertPricing(skuId, cost, retail, basis) {
  await pool.query(`
    INSERT INTO pricing (sku_id, cost, retail_price, price_basis) VALUES ($1,$2,$3,$4)
    ON CONFLICT (sku_id) DO UPDATE SET cost=EXCLUDED.cost, retail_price=EXCLUDED.retail_price, price_basis=EXCLUDED.price_basis`,
    [skuId, cost, retail, basis]);
}
async function upsertPackaging(skuId, pk) {
  if (!pk || (pk.sqft_box == null && pk.pcs_box == null && pk.boxes_pallet == null)) return;
  await pool.query(`
    INSERT INTO packaging (sku_id, sqft_per_box, pieces_per_box, boxes_per_pallet)
    VALUES ($1,$2,$3,$4)
    ON CONFLICT (sku_id) DO UPDATE SET sqft_per_box=EXCLUDED.sqft_per_box,
      pieces_per_box=EXCLUDED.pieces_per_box, boxes_per_pallet=EXCLUDED.boxes_per_pallet`,
    [skuId, pk.sqft_box ?? null, pk.pcs_box ?? null, pk.boxes_pallet ?? null]);
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
    ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value=EXCLUDED.value`, [skuId, id, String(value).trim()]);
}
async function productMedia(productId, url, assetType, sortOrder) {
  if (!url) return;
  await pool.query(`
    INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order, source)
    VALUES ($1,NULL,$2,$3,$3,$4,$5)
    ON CONFLICT (product_id, asset_type, sort_order) WHERE sku_id IS NULL
    DO UPDATE SET url=EXCLUDED.url, original_url=EXCLUDED.original_url, source=EXCLUDED.source`,
    [productId, assetType, url, sortOrder, SOURCE]);
}
async function skuMedia(productId, skuId, url, assetType, sortOrder) {
  if (!url) return;
  await pool.query(`
    INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order, source)
    VALUES ($1,$2,$3,$4,$4,$5,$6)
    ON CONFLICT (product_id, sku_id, asset_type, sort_order) WHERE sku_id IS NOT NULL
    DO UPDATE SET url=EXCLUDED.url, original_url=EXCLUDED.original_url, source=EXCLUDED.source`,
    [productId, skuId, assetType, url, sortOrder, SOURCE]);
}

// ==================== derived fields ====================
// Set true in main() when vendors.hide_public_name — omits distributor name from descriptions.
let HIDE_VENDOR = false;
function descFor(p) {
  const sizes = [...new Set(p.skus.map((s) => s.size_nominal))].filter(Boolean);
  const origins = (p.origins && p.origins.length ? p.origins : [p.origin]).filter(Boolean);
  const looks = p.look ? `${p.look.toLowerCase()}-look ` : '';
  const mat = (p.material || 'Porcelain').toLowerCase();
  const saleNote = p.sale ? ' Closeout / sale item.' : '';
  return {
    short: `Imported ${looks}${mat} tile${sizes.length ? ' in ' + sizes.join(', ') : ''}`
      + `${origins.length ? ' — made in ' + origins.join(' & ') : ''}.${saleNote}`,
    long: `${p.name} — ${looks}${mat} tile${HIDE_VENDOR ? '' : ' distributed by Tile World (Anaheim, CA)'}.`
      + `${sizes.length ? ' Available sizes: ' + sizes.join(', ') + '.' : ''}`
      + `${origins.length ? ' Country of origin: ' + origins.join(' & ') + '.' : ''}`
      + `${saleNote} FOB Anaheim warehouse.`,
  };
}

const usedInternal = new Set();
function internalFor(pkey, suffix) {
  let base = `${pkey}-${suffix}`.replace(/-+/g, '-').replace(/-$/, '');
  let cand = base, i = 2;
  while (usedInternal.has(cand)) cand = `${base}-${i++}`;
  usedInternal.add(cand);
  return cand;
}

async function importProduct(p, vendorId, brandId, catId) {
  const { short, long } = descFor(p);
  const productId = await upsertProduct({
    vendorId, brandId, categoryId: catId, status: p.status || 'active',
    name: p.name, collection: p.collection, short, long,
  });

  const im = images[p.pkey];
  if (im && im.product) {
    if (im.product.primary) await productMedia(productId, im.product.primary, 'primary', 0);
    let so = 0;
    for (const u of (im.product.alternates || [])) await productMedia(productId, u, 'alternate', so++);
  }

  const skuIds = [];
  for (const s of p.skus) {
    const internal = internalFor(p.pkey, s.suffix);
    const vendorSku = internal.replace(/^TWD-/, '');
    const skuId = await upsertSku({
      productId, vendor_sku: vendorSku, internal_sku: internal,
      variant_name: s.variant_name, sell_by: s.sell_by, variant_type: s.variant_type, status: 'active',
    });
    await upsertPricing(skuId, s.cost, keystone(s.cost), s.price_basis);
    await upsertPackaging(skuId, { sqft_box: s.sqft_box, pcs_box: s.pcs_box, boxes_pallet: s.boxes_pallet });

    const sim = im && im.skus && im.skus[s.suffix];
    if (sim) {
      if (sim.primary) await skuMedia(productId, skuId, sim.primary, 'primary', 0);
      let so = 0;
      for (const u of (sim.alternates || [])) await skuMedia(productId, skuId, u, 'alternate', so++);
    }

    await setAttr(skuId, 'material', p.material);
    await setAttr(skuId, 'collection', p.collection);
    await setAttr(skuId, 'color', p.color);
    await setAttr(skuId, 'size', s.size);
    await setAttr(skuId, 'finish', s.finish);
    await setAttr(skuId, 'surface_texture', s.surface);
    await setAttr(skuId, 'look', p.look);
    await setAttr(skuId, 'application', s.application);
    skuIds.push(skuId);
  }
  return { productId, skuIds, hasImg: !!im };
}

// ==================== main ====================
async function main() {
  console.log('=== Tile World Import ===\n');
  const vendorId = await upsertVendor(catalog.vendor);
  HIDE_VENDOR = (await pool.query('SELECT hide_public_name FROM vendors WHERE id=$1', [vendorId])).rows[0]?.hide_public_name === true;
  console.log(`Vendor: ${catalog.vendor.name} (${vendorId})${HIDE_VENDOR ? ' [hidden — vendor name omitted from descriptions]' : ''}`);
  const brandId = await upsertBrand(catalog.brand);
  await linkVendorBrand(vendorId, brandId, true);
  console.log(`Brand:  ${catalog.brand.name} (${brandId})`);

  const CAT = {};
  for (const s of new Set(catalog.products.map((p) => p.category))) CAT[s] = await getCategoryId(s);

  // Full rebuild: purge existing Tile World products + dependents
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
    console.log(`Purged ${prodIds.length} existing Tile World products (${skuIds.length} SKUs)\n`);
  }

  let pN = 0, sN = 0, imgN = 0;
  for (const p of catalog.products) {
    const { skuIds, hasImg } = await importProduct(p, vendorId, brandId, CAT[p.category]);
    pN++; sN += skuIds.length; if (hasImg) imgN++;
  }
  console.log(`Imported ${pN} products (${sN} SKUs), ${imgN} with photos.`);
  console.log('\nDone.');
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
