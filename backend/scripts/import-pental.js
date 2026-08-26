#!/usr/bin/env node
/**
 * Import PentalQuartz — engineered quartz surfaces (Pental Surfaces / Architectural Surfaces Group).
 *
 * Onboarded as its OWN vendor (PENT) carrying a single brand (PentalQuartz). Source:
 * data/pental/catalog.json + images.json (built by build-pental-catalog.js from scrape-pental.js).
 * No published retail → every product/SKU imported as status 'draft' with NO pricing rows. Add costs +
 * flip to 'active' when the price sheet arrives.
 *
 * MODEL:
 *   - Each color = ONE product (collection = marketing collection). SKUs = finish × thickness
 *     (thickness = brand-standard 2cm + 3cm applied to every color, SPLIT into its own SKU/pill).
 *     sell_by 'unit'.
 *   - Images per-color (remote): primary = swatch/slab render, jumbo inventory slabs = alternate,
 *     og hero = lifestyle. One brand-level architectural spec PDF + terms attached as spec_pdf.
 *
 * Full rebuild: purges existing PENT products + dependents, then re-imports.
 * Usage: docker compose exec api node scripts/import-pental.js
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
const DATA_DIR = process.env.PENT_DATA_DIR || path.join(__dirname, '..', 'data', 'pental');
const catalog = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'catalog.json'), 'utf8'));
let images = {};
try { images = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'images.json'), 'utf8')); }
catch { console.warn('! images.json not found — importing without photos'); }

const SOURCE = 'arcsurfaces.com';
const BRAND_PDFS = catalog.brandPdfs || [];

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
    [p.vendorId, p.brandId, p.name, p.collection, p.categoryId, p.status || 'draft', p.short, p.long]);
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
    [s.productId, s.vendor_sku, s.internal_sku, s.variant_name || null, s.sell_by || 'unit', s.variant_type || null, s.status || 'draft']);
  return r.rows[0].id;
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

// ==================== derived fields ====================
function descFor(p) {
  const finishes = [...new Set(p.skus.map((s) => s.finish))].filter(Boolean);
  const thicks = [...new Set(p.skus.map((s) => s.thickness))].filter(Boolean);
  const short = `PentalQuartz ${p.name} — engineered quartz surface`
    + `${p.collection && p.collection !== 'PentalQuartz' ? ' (' + p.collection + ' collection)' : ''}. Contact for pricing.`;
  const long = `${p.name} — PentalQuartz engineered quartz slab`
    + `${p.collection && p.collection !== 'PentalQuartz' ? ' from the ' + p.collection + ' collection' : ''}. `
    + `${p.description || ''}`
    + `${finishes.length ? ' Finishes: ' + finishes.join(', ') + '.' : ''}`
    + `${thicks.length ? ' Thicknesses: ' + thicks.join(', ') + '.' : ''}`
    + `${p.skus[0] && p.skus[0].size_nominal ? ' Slab size: ' + p.skus[0].size_nominal + '.' : ''}`;
  return { short: short.replace(/\s+/g, ' ').trim(), long: long.replace(/\s+/g, ' ').trim() };
}

// ==================== main ====================
async function importProduct(p, vendorId, brandId, catId) {
  const { short, long } = descFor(p);
  const productId = await upsertProduct({
    vendorId, brandId, categoryId: catId, status: p.status || 'draft',
    name: p.name, collection: p.collection, short, long,
  });

  const im = images[p.pkey];
  let hasImg = false, pdfN = 0;
  if (im) {
    if (im.primary) { await productMedia(productId, im.primary, 'primary', 0); hasImg = true; }
    let a = 0;
    for (const u of (im.jumbo || [])) await productMedia(productId, u, 'alternate', a++);
    let so = 0;
    for (const u of (im.lifestyle || [])) await productMedia(productId, u, 'lifestyle', so++);
  }
  // brand-level spec docs (architectural spec + terms) on every color
  let ps = 0;
  for (const u of BRAND_PDFS) { await productMedia(productId, u, 'spec_pdf', ps++); pdfN++; }

  for (const s of p.skus) {
    const internal = `${p.pkey}-${s.suffix}`;
    const skuId = await upsertSku({
      productId, vendor_sku: s.vendor_sku, internal_sku: internal,
      variant_name: s.variant_name, sell_by: s.sell_by, variant_type: null, status: 'draft',
    });
    // NO upsertPricing — no price sheet yet (draft).
    await setAttr(skuId, 'material', p.material);
    await setAttr(skuId, 'collection', p.collection);
    await setAttr(skuId, 'color', p.color);
    if (s.size_nominal) await setAttr(skuId, 'size', s.size_nominal);
    if (s.finish) await setAttr(skuId, 'finish', s.finish);
    if (s.thickness) await setAttr(skuId, 'thickness', s.thickness);
    await setAttr(skuId, 'look', p.look);
    await setAttr(skuId, 'application', 'Countertop · Wall');
  }
  return { skuN: p.skus.length, hasImg, pdfN };
}

async function main() {
  console.log('=== PentalQuartz Import ===\n');
  const vendorId = await upsertVendor(catalog.vendor);
  console.log(`Vendor: ${catalog.vendor.name} (${vendorId})`);
  const brandId = await upsertBrand(catalog.brand);
  await linkVendorBrand(vendorId, brandId, true);
  console.log(`Brand:  ${catalog.brand.name} (${brandId})`);

  const catId = await getCategoryId('quartz-countertops');

  // Full rebuild: purge existing Pental products + dependents
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
    console.log(`\nPurged ${prodIds.length} existing Pental products (${skuIds.length} SKUs)\n`);
  }

  let pN = 0, sN = 0, imgN = 0, pdfTotal = 0;
  const byColl = {};
  for (const p of catalog.products) {
    const { skuN, hasImg, pdfN } = await importProduct(p, vendorId, brandId, catId);
    pN++; sN += skuN; if (hasImg) imgN++; pdfTotal += pdfN;
    byColl[p.collection] = (byColl[p.collection] || 0) + 1;
  }
  console.log('Imported (all DRAFT — no pricing):');
  for (const [c, n] of Object.entries(byColl)) console.log(`  ${c.padEnd(22)} ${n}`);
  console.log(`  ------`);
  console.log(`  Products (colors): ${pN}`);
  console.log(`  SKUs:              ${sN}`);
  console.log(`  Product photos:    ${imgN}/${pN} with a primary`);
  console.log(`  Spec PDFs:         ${pdfTotal} (brand architectural spec + terms per color)`);
  console.log('\nDone. DRAFT until pricing added + status flipped to active.');
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
