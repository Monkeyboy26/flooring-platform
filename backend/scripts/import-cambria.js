#!/usr/bin/env node
/**
 * Import Cambria — American-made natural quartz surfaces (Eden Prairie/Le Sueur, MN — cambriausa.com).
 *
 * Onboarded as its OWN vendor carrying a single house brand (Cambria). Source:
 * data/cambria/catalog.json + images.json (built by build-cambria-catalog.js from the public
 * Algolia scrape, scrape-cambria.js). Cambria does not publish per-slab retail → every product/SKU
 * imported as status 'draft' with NO pricing rows. Add costs + flip to 'active' when the distributor
 * price sheet arrives.
 *
 * MODEL:
 *   - Each design = ONE product (collection = design series: Signature/Luxury/Classic/Coordinates/Grandeur).
 *   - SKUs fan out over finish × thickness (thickness SPLIT into its own SKU/pill). sell_by 'unit'.
 *   - Images per-design (Scene7, remote): primary = flat slab swatch, jumbo = full slab (alternate),
 *     lifestyle = hover kitchen scene.
 *
 * Full rebuild: purges existing CAMB products + dependents, then re-imports.
 * Usage: docker compose exec api node scripts/import-cambria.js
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
const DATA_DIR = process.env.CAMB_DATA_DIR || path.join(__dirname, '..', 'data', 'cambria');
const catalog = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'catalog.json'), 'utf8'));
let images = {};
try { images = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'images.json'), 'utf8')); }
catch { console.warn('! images.json not found — importing without photos'); }

const SOURCE = 'cambriausa.com';

// Spec docs attached per design as spec_pdf media (storefront renders these in a
// downloads section, keyed off filename, and excludes them from image galleries).
// The per-design "Specifications (PDF)" tear sheet (images.json.specPdf) is attached
// first (sort 0), then Cambria's brand-wide Care & Maintenance + Lifetime Warranty.
const CAMB = 'https://www.cambriausa.com';
const BRAND_PDFS = [
  `${CAMB}/content/dam/cusa/sales-marketing-collateral/warranty-care-maintenance/cambria-product-care-and-maintenance-information-english.pdf`,
  `${CAMB}/content/dam/cusa/sales-marketing-collateral/warranty-care-maintenance/full-lifetime-warranty-english.pdf`,
];

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
  const short = `Cambria ${p.name} — American-made natural quartz surface`
    + `${p.collection && p.collection !== 'Cambria' ? ' (' + p.collection + ' series)' : ''}. Contact for pricing.`;
  const long = `${p.name} — Cambria natural quartz countertop surface`
    + `${p.collection && p.collection !== 'Cambria' ? ' from the ' + p.collection + ' series' : ''}. `
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
    if (im.jumbo) await productMedia(productId, im.jumbo, 'alternate', 0);
    let so = 0;
    for (const u of (im.lifestyle || [])) await productMedia(productId, u, 'lifestyle', so++);
    // Spec docs: per-design Specifications tear sheet first, then brand-wide care + warranty.
    let ps = 0;
    if (im.specPdf) { await productMedia(productId, im.specPdf, 'spec_pdf', ps++); pdfN++; }
    for (const u of BRAND_PDFS) { await productMedia(productId, u, 'spec_pdf', ps++); pdfN++; }
  }

  for (const s of p.skus) {
    const internal = `${p.pkey}-${s.suffix}`;
    const vendorSku = (p.designcode ? p.designcode + '-' : '') + s.suffix;
    const skuId = await upsertSku({
      productId, vendor_sku: vendorSku, internal_sku: internal,
      variant_name: s.variant_name, sell_by: s.sell_by, variant_type: null, status: 'draft',
    });
    // NO upsertPricing — Cambria doesn't publish retail (draft until price sheet).
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
  console.log('=== Cambria Import ===\n');
  const vendorId = await upsertVendor(catalog.vendor);
  console.log(`Vendor: ${catalog.vendor.name} (${vendorId})`);
  const brandId = await upsertBrand(catalog.brand);
  await linkVendorBrand(vendorId, brandId, true);
  console.log(`Brand:  ${catalog.brand.name} (${brandId})`);

  const catId = await getCategoryId('quartz-countertops');

  // Full rebuild: purge existing Cambria products + dependents
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
    console.log(`\nPurged ${prodIds.length} existing Cambria products (${skuIds.length} SKUs)\n`);
  }

  let pN = 0, sN = 0, imgN = 0, pdfTotal = 0;
  const bySeries = {};
  for (const p of catalog.products) {
    const { skuN, hasImg, pdfN } = await importProduct(p, vendorId, brandId, catId);
    pN++; sN += skuN; if (hasImg) imgN++; pdfTotal += pdfN;
    bySeries[p.collection] = (bySeries[p.collection] || 0) + 1;
  }
  console.log('Imported (all DRAFT — no pricing):');
  for (const [s, n] of Object.entries(bySeries)) console.log(`  ${s.padEnd(12)} ${n} designs`);
  console.log(`  ------`);
  console.log(`  Products (designs): ${pN}`);
  console.log(`  SKUs:               ${sN}`);
  console.log(`  Product photos:     ${imgN}/${pN} with a primary slab render`);
  console.log(`  Spec PDFs:          ${pdfTotal} (Specifications tear sheet + care + warranty per design)`);
  console.log('\nDone. DRAFT until pricing added + status flipped to active.');
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
