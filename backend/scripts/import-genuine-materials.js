#!/usr/bin/env node
/**
 * Import Genuine Materials Inc — 2026 Q3 Price List.
 *
 * Genuine Materials (Ontario, CA) is a surfaces distributor. Lines:
 *   - Sintera        Zero-silica sintered surfaces (slab + prefab)      -> sintered-surfaces
 *   - Porcelain Top  Italian 12mm jumbo slabs (AtlasPlan / Florim)      -> porcelain-slabs
 *   - Hybrid Slab    Atlas Concorde 6mm 109x48 porcelain slabs          -> porcelain-slabs
 *   - 3296           MileStone USA 32x96 12mm panels + 4-pc shower kit  -> porcelain-slabs / shower-systems
 *   - Thinmaxx       Polyethylene foam backing forms                    -> installation-sundries
 *   - Sinks          Kitchen/bath sink collection                       -> kitchen-sinks / bathroom-sinks
 *   - Genuine Quartz Legacy quartz clearance (slab + prefab)            -> quartz-countertops
 *
 * Pricing: PDF lists Genuine Materials' dealer price = Roma's COST.
 * Retail = cost x 1.6 keystone (store standard since the 2026-07 reprice), rounded to $0.05.
 * Slabs & prefabs are whole pieces: sell_by='unit', price_basis='per_unit', with the
 * piece area in packaging.sqft_per_box so the storefront renders them as slabs (storefront.jsx:6817).
 *
 * Data source: catalog.json (transcribed from "Q3 PL 2026.pdf") + images.json (scraped
 * primary/gallery photos from genuinematerials.com). Place both next to this script's
 * DATA_DIR or pass GM_DATA_DIR.
 *
 * Usage: docker compose exec api node scripts/import-genuine-materials.js
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

const DATA_DIR = process.env.GM_DATA_DIR || '/data/genuine-materials';
const catalog = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'catalog.json'), 'utf8'));
let images = {};
try { images = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'images.json'), 'utf8')); }
catch { console.warn('! images.json not found — importing without photos'); }
// swatches.json holds the curated clean-swatch primary picks; prefer it over the raw
// images.json portrait picks so re-imports don't revert to lifestyle heroes.
let swatches = {};
try { swatches = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'swatches.json'), 'utf8')); } catch {}

// Prop 65: fabricating silica-bearing porcelain/quartz generates respirable crystalline silica.
// Sintera is marketed zero-silica; sinks/backing are inert.
const SILICA_LINES = new Set(['Porcelain Top', 'Hybrid Slab', '3296', 'Genuine Quartz (Clearance)']);

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

async function ensureCategories() {
  await ensureCategory('sintered-surfaces', 'Sintered & Zero-Silica Surfaces', 'countertops',
    'Sintered stone and zero-silica engineered surfaces — a safer, silica-free alternative to quartz for countertops.', 45);
  await ensureCategory('shower-panels', 'Shower Panels', 'bath',
    'Large-format porcelain shower & tub-surround panels — fewer grout lines, easy fabrication.', 30);
}

async function upsertProduct(vendorId, brandId, categoryId, p) {
  const silica = SILICA_LINES.has(p.line);
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
      variant_name=EXCLUDED.variant_name, sell_by=EXCLUDED.sell_by, updated_at=CURRENT_TIMESTAMP
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

// ==================== Main ====================
async function main() {
  console.log('=== Genuine Materials Import ===\n');

  const vendorId = await upsertVendor('Genuine Materials', 'GM', {
    website: 'https://www.genuinematerials.com',
    phone: '909-480-0707',
    address: '5095 E Airport Drive, Ontario, CA 91761',
    notes: 'Surfaces distributor: Sintera zero-silica, Porcelain Top (AtlasPlan/Florim), Hybrid Slab (Atlas Concorde), 3296 (MileStone), Thinmaxx, sinks, Genuine Quartz clearance. Prices in 2026 Q3 PL = dealer cost.',
  });
  console.log('Vendor:', vendorId);

  // Brands
  const brandDefs = [
    ['Sintera','SINTERA','https://www.genuinematerials.com'],
    ['AtlasPlan','ATLASPLAN','https://www.atlasplan.com'],
    ['Florim','FLORIM','https://www.florim.com'],
    ['Atlas Concorde','ATLAS_CONCORDE','https://www.atlasconcorde.com'],
    ['MileStone','MILESTONE',null],
    ['Thinmaxx','THINMAXX','https://www.thinmaxx.com'],
    ['Genuine Quartz','GENUINE_QUARTZ','https://www.genuinematerials.com'],
    ['Genuine Materials','GENUINE_MATERIALS_BRAND',null],
  ];
  const brandId = {};
  for (const [name, code, web] of brandDefs) {
    const id = await upsertBrand(name, code, web);
    brandId[name] = id;
    await linkVendorBrand(vendorId, id);
  }
  console.log('Brands:', Object.keys(brandId).length);

  await ensureCategories();
  const catCache = {};
  const catFor = async (slug) => (catCache[slug] ??= await getCategoryId(slug));

  let pNew=0,pUpd=0,sNew=0,sUpd=0,mediaN=0,noImg=[];
  for (const p of catalog) {
    const categoryId = await catFor(p.category_slug);
    if (!categoryId) { console.warn('! missing category', p.category_slug, 'for', p.name); continue; }
    const bId = brandId[p.brand_name] || brandId['Genuine Materials'];
    const prod = await upsertProduct(vendorId, bId, categoryId, p);
    prod.is_new ? pNew++ : pUpd++;

    for (const s of p.skus) {
      const sku = await upsertSku(prod.id, s);
      sku.is_new ? sNew++ : sUpd++;
      await upsertPricing(sku.id, s);
      await upsertPackaging(sku.id, s);
      // product-level attrs + sku-level attrs
      const merged = { ...(p.attrs||{}), ...(s.attrs||{}) };
      for (const [slug, val] of Object.entries(merged)) await setAttr(sku.id, slug, val);
    }

    // media (product-level; color is per product). Prefer the curated swatch pick.
    const sw = p.slug ? swatches[p.slug] : null;
    const img = p.slug ? images[p.slug] : null;
    const primary = (sw && sw.primary) || (img && img.primary) || null;
    const gallerySrc = (sw && sw.candidates && sw.candidates.length) ? sw.candidates : (img ? img.gallery : []);
    if (primary) {
      await upsertMedia(prod.id, primary, 'primary', 0);
      mediaN++;
      const gallery = (gallerySrc || []).filter(u => u !== primary);
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
