#!/usr/bin/env node
/**
 * Import Forma Mondo — imported large-format porcelain tile distributor (Carson, CA — formamondo.com).
 *
 * Onboarded as its OWN vendor carrying a single house brand (Forma Mondo). Source:
 * backend/data/formamondo/catalog.json (built by build-formamondo-catalog.js from the 2026 price
 * list) + images.json (built by build-formamondo-pdf-images.js). Every (color, finish) uses its own
 * authoritative swatch cropped from the price-list PDF "IMAGE" column — guaranteeing each image
 * matches its exact color/finish with NO fallbacks (staged to uploads/formamondo/). + specs.json
 * (material "Family" scraped from each collection's product-info label).
 *
 * MODEL (see [[variant-pill-independence]] / [[line-item-display]]):
 *   - Each collection = a `collection`; each COLOR within it = ONE product; the finish x size
 *     rows are its SKUs. All SKUs sell_by 'box', per_sqft. Color pills come from
 *     collection_siblings; finish + size are the in-product variant pills.
 *   - 100% field tile — no trim/accessories exist in the line, so none are attached.
 *
 * PRICING (confirmed with owner 2026-08-01): the sheet "MSRP" is retail MSRP; Roma COST = MSRP/2;
 *   retail = cost x 1.6 nickel keystone (== 0.8 x MSRP, nickel-rounded). Costs baked into catalog.json.
 *
 * Full rebuild: purges existing FMO products + dependents, then re-imports.
 * Usage: docker compose exec api node scripts/import-formamondo.js
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
const DATA_DIR = process.env.FMO_DATA_DIR || path.join(__dirname, '..', 'data', 'formamondo');
const catalog = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'catalog.json'), 'utf8'));
let images = {};
try { images = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'images.json'), 'utf8')); }
catch { console.warn('! images.json not found — importing without photos'); }
let specs = {};
try { specs = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'specs.json'), 'utf8')); }
catch { /* optional — spec data scraped from each collection's product-info label */ }

const SOURCE = 'formamondo.com';

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
    [s.productId, s.vendor_sku, s.internal_sku, s.variant_name || null, s.sell_by || 'box', s.variant_type || null, s.status || 'active']);
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
  const finishes = [...new Set(p.skus.map((s) => s.finish))].filter(Boolean);
  const look = (p.look || 'Stone').toLowerCase();
  const short = `Imported ${look}-look porcelain tile — ${p.collection} ${p.color}` +
    `${sizes.length ? ' in ' + sizes.join(', ') : ''}.`;
  const long = `${p.collection} ${p.color} — ${look}-look rectified porcelain tile` +
    `${HIDE_VENDOR ? '' : ' distributed by Forma Mondo (Carson, CA)'}. ${p.blurb || ''}` +
    `${sizes.length ? ' Available sizes: ' + sizes.join(', ') + '.' : ''}` +
    `${finishes.length ? ' Finishes: ' + finishes.join(', ') + '.' : ''}` +
    `${p.finishNote ? ' ' + p.finishNote : ''} FOB Carson warehouse.`;
  return { short, long: long.replace(/\s+/g, ' ').trim() };
}

// ==================== main ====================
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
    for (const u of (im.product.alternates || [])) await productMedia(productId, u, 'lifestyle', so++);
  }

  let skuImgN = 0;
  for (const s of p.skus) {
    const internal = `${p.pkey}-${s.suffix}`;
    const vendorSku = internal.replace(/^FMO-/, '');
    const skuId = await upsertSku({
      productId, vendor_sku: vendorSku, internal_sku: internal,
      variant_name: s.variant_name, sell_by: s.sell_by, variant_type: null, status: 'active',
    });
    await upsertPricing(skuId, s.cost, s.retail, s.price_basis);
    await upsertPackaging(skuId, { sqft_box: s.sqft_box, pcs_box: s.pcs_box, boxes_pallet: s.boxes_pallet });

    // finish-specific press swatch, if matched
    const sim = im && im.skus && im.skus[s.suffix];
    if (sim && sim.primary) { await skuMedia(productId, skuId, sim.primary, 'primary', 0); skuImgN++; }

    // material refined by the scraped product-label "Family" (e.g. Glazed Porcelain,
    // Coloured Body Porcelain Stoneware) where available, else generic Porcelain
    const family = (specs[p.collectionSlug] || {}).family;
    await setAttr(skuId, 'material', family || p.material);
    await setAttr(skuId, 'collection', p.collection);
    await setAttr(skuId, 'color', p.color);
    await setAttr(skuId, 'size', s.size_nominal);
    await setAttr(skuId, 'finish', s.finish);
    await setAttr(skuId, 'look', p.look);
    await setAttr(skuId, 'application', 'Floor · Wall');
    await setAttr(skuId, 'rectified', 'Yes');
    await setAttr(skuId, 'edge', 'Rectified');
  }
  return { productId, skuN: p.skus.length, skuImgN, hasImg: !!(im && im.product && im.product.primary) };
}

async function main() {
  console.log('=== Forma Mondo Import ===\n');
  const vendorId = await upsertVendor(catalog.vendor);
  HIDE_VENDOR = (await pool.query('SELECT hide_public_name FROM vendors WHERE id=$1', [vendorId])).rows[0]?.hide_public_name === true;
  console.log(`Vendor: ${catalog.vendor.name} (${vendorId})${HIDE_VENDOR ? ' [hidden — vendor name omitted from descriptions]' : ''}`);
  const brandId = await upsertBrand(catalog.brand);
  await linkVendorBrand(vendorId, brandId, true);
  console.log(`Brand:  ${catalog.brand.name} (${brandId})`);

  const CAT = {};
  for (const s of new Set(catalog.products.map((p) => p.category))) CAT[s] = await getCategoryId(s);

  // Full rebuild: purge existing Forma Mondo products + dependents
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
    console.log(`Purged ${prodIds.length} existing Forma Mondo products (${skuIds.length} SKUs)\n`);
  }

  let pN = 0, sN = 0, imgN = 0, skuImg = 0;
  for (const p of catalog.products) {
    const { skuN, skuImgN, hasImg } = await importProduct(p, vendorId, brandId, CAT[p.category]);
    pN++; sN += skuN; skuImg += skuImgN; if (hasImg) imgN++;
  }
  console.log(`Products (colors): ${pN}`);
  console.log(`SKUs:              ${sN}`);
  console.log(`Product photos:    ${imgN}/${pN} with a primary`);
  console.log(`SKU finish photos: ${skuImg}`);
  console.log('\nDone.');
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
