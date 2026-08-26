#!/usr/bin/env node
/**
 * Import Parliament Floors — SPC / WPC / laminate / engineered-hardwood.
 *
 * Parliament Floors (109 N McKinley St, Corona CA 92879 — parliamentfloors.com)
 * is onboarded as ONE new vendor carrying three brands (see [[vendor-sub-brands]]):
 *   - Parliament                 → SPC rigid core, WPC "Generations", EX laminate
 *                                  collections, WPL waterproof laminate
 *   - Elevate Premium Hardwood   → engineered European Oak
 *   - Visions                    → engineered hardwood (Cornerstone/Designer/Traditional)
 *
 * Source: backend/data/parliament/catalog.json (built by build-parliament-catalog.js
 * from the Jan-2025 dealer price lists) + images.json (scraped from parliamentfloors.com,
 * keyed by SPC/WPC/WPL item number, plus WPL-<COLOR> for the 2021-2032 range).
 *
 * Pricing: dealer price = Roma COST; retail = cost x1.6 nickel keystone (store
 * standard — see [[selling-conventions]], [[garrison-onboarding]]). Flooring sold
 * per sqft by the box (sell_by 'box', price_basis per_sqft); moldings per piece
 * (unit/per_unit); underlayment per sqft (sqft/per_sqft).
 *
 * Accessories ("Attach accessories"): one molding product per flooring family
 * (SPC / WPC / Laminate / Elevate / Visions), each with its per-profile accessory
 * SKUs, linked via sku_accessories to EVERY floor in that family so they surface
 * in the storefront "Matching Accessories" section (same mechanism as Mango/ARK —
 * see [[line-item-display]]). Laminate moldings attach to both EX laminate + WPL.
 * Underlayment/poly items are imported as standalone products in the underlayment
 * category (browsable), not force-linked to every plank.
 *
 * Only SPC + WPL have vendor-site photos; WPC Generations, EX laminate and the
 * hardwood lines import photoless (not published on the site).
 *
 * Usage: docker compose exec api node scripts/import-parliament.js
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
const DATA_DIR = process.env.PARLIAMENT_DATA_DIR || path.join(__dirname, '..', 'data', 'parliament');
const catalog = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'catalog.json'), 'utf8'));
let images = {};
try { images = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'images.json'), 'utf8')); }
catch { console.warn('! images.json not found — importing without photos'); }

const RETAIL_MARKUP = 1.6;
const keystone = (cost) => parseFloat((Math.round(cost * RETAIL_MARKUP / 0.05) * 0.05).toFixed(2));
const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

// ==================== DB helpers ====================
async function upsertVendor(v) {
  const res = await pool.query(`
    INSERT INTO vendors (name, code, website, email, phone, address, notes)
    VALUES ($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT (code) DO UPDATE SET
      name=EXCLUDED.name, website=EXCLUDED.website, email=COALESCE(EXCLUDED.email, vendors.email),
      phone=COALESCE(EXCLUDED.phone, vendors.phone), address=COALESCE(EXCLUDED.address, vendors.address),
      notes=EXCLUDED.notes, updated_at=CURRENT_TIMESTAMP
    RETURNING id
  `, [v.name, v.code, v.website, v.email, v.phone, v.address, v.notes]);
  return res.rows[0].id;
}

async function upsertBrand(name, code, website) {
  const res = await pool.query(`
    INSERT INTO brands (name, code, website) VALUES ($1,$2,$3)
    ON CONFLICT (code) DO UPDATE SET name=EXCLUDED.name,
      website=COALESCE(EXCLUDED.website, brands.website), updated_at=CURRENT_TIMESTAMP
    RETURNING id
  `, [name, code, website || null]);
  return res.rows[0].id;
}
async function linkVendorBrand(vendorId, brandId, isPrimary = false) {
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
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT ON CONSTRAINT products_vendor_collection_name_unique DO UPDATE SET
      brand_id=EXCLUDED.brand_id, category_id=EXCLUDED.category_id, status=EXCLUDED.status,
      description_short=EXCLUDED.description_short, description_long=EXCLUDED.description_long,
      updated_at=CURRENT_TIMESTAMP
    RETURNING id, (xmax = 0) AS is_new
  `, [vendorId, brandId, p.name, p.collection, categoryId, p.status || 'active', p.description_short, p.description_long]);
  return res.rows[0];
}

async function upsertSku(productId, s) {
  const res = await pool.query(`
    INSERT INTO skus (product_id, vendor_sku, internal_sku, variant_name, sell_by, variant_type, accessory_label, status)
    VALUES ($1,$2,$3,$4,$5,$6,$7,'active')
    ON CONFLICT (internal_sku) DO UPDATE SET
      product_id=EXCLUDED.product_id, vendor_sku=EXCLUDED.vendor_sku,
      variant_name=EXCLUDED.variant_name, sell_by=EXCLUDED.sell_by,
      variant_type=EXCLUDED.variant_type, accessory_label=EXCLUDED.accessory_label,
      status='active', updated_at=CURRENT_TIMESTAMP
    RETURNING id, (xmax = 0) AS is_new
  `, [productId, s.vendor_sku, s.internal_sku, s.variant_name || null, s.sell_by || 'box',
      s.variant_type || null, s.accessory_label || null]);
  return res.rows[0];
}

async function upsertPricing(skuId, cost, retail, basis) {
  await pool.query(`
    INSERT INTO pricing (sku_id, cost, retail_price, price_basis)
    VALUES ($1,$2,$3,$4)
    ON CONFLICT (sku_id) DO UPDATE SET cost=EXCLUDED.cost, retail_price=EXCLUDED.retail_price, price_basis=EXCLUDED.price_basis
  `, [skuId, cost, retail, basis]);
}

async function upsertPackaging(skuId, sqftBox, lbsBox, boxesPallet) {
  if (sqftBox == null && lbsBox == null && boxesPallet == null) return;
  await pool.query(`
    INSERT INTO packaging (sku_id, sqft_per_box, weight_per_box_lbs, boxes_per_pallet) VALUES ($1,$2,$3,$4)
    ON CONFLICT (sku_id) DO UPDATE SET sqft_per_box=EXCLUDED.sqft_per_box,
      weight_per_box_lbs=EXCLUDED.weight_per_box_lbs, boxes_per_pallet=EXCLUDED.boxes_per_pallet
  `, [skuId, sqftBox, lbsBox, boxesPallet]);
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

async function linkAccessory(parentSkuId, accessorySkuId, sortOrder) {
  await pool.query(`
    INSERT INTO sku_accessories (parent_sku_id, accessory_sku_id, sort_order)
    VALUES ($1,$2,$3)
    ON CONFLICT (parent_sku_id, accessory_sku_id) DO UPDATE SET sort_order=EXCLUDED.sort_order
  `, [parentSkuId, accessorySkuId, sortOrder]);
}

// ---- image lookup (num first, then WPL-<COLOR> key) ----
function findImage(p) {
  if (p.num && images[p.num]) return images[p.num];
  if (p.img_color_key && images[p.img_color_key.toUpperCase()]) return images[p.img_color_key.toUpperCase()];
  if (p.item && images[p.item]) return images[p.item]; // Elevate/Visions keyed by item code
  return null;
}

// ---- descriptions ----
function buildDesc(p) {
  const isWood = p.category === 'engineered-hardwood';
  const isLam = p.category === 'laminate';
  const dims = p.size || [p.thickness, p.width, p.length].filter(Boolean).join(' x ');
  let type;
  if (p.material === 'SPC Vinyl') type = 'SPC rigid-core waterproof vinyl plank';
  else if (p.material === 'WPC Vinyl') type = 'WPC waterproof vinyl plank';
  else if (p.material === 'Waterproof Laminate') type = 'waterproof laminate plank';
  else if (isLam) type = 'laminate plank';
  else type = `engineered ${(p.species || 'hardwood')} flooring`;

  const short = `${p.color} — ${type}, ${dims}${p.wear_layer ? `, ${p.wear_layer} wear layer` : ''}.`;

  const parts = [];
  const brandLabel = p.brand === 'ELEVATE' ? 'Elevate Premium Hardwood' : p.brand === 'VISIONS' ? 'Visions' : 'Parliament Floors';
  parts.push(`${brandLabel} ${p.collection}${p.series ? ` (${p.series})` : ''} — ${p.color}.`);
  if (isWood) {
    parts.push(`Engineered ${p.species} hardwood, ${dims}${p.wear_layer ? ` with a ${p.wear_layer.toLowerCase()} real-wood wear layer` : ''}.`);
    if (p.surface_texture) parts.push(`${p.surface_texture}${p.finish ? `, ${p.finish.toLowerCase()}` : ''} surface.`);
    if (p.grade) parts.push(`${p.grade}.`);
    parts.push('Installs glue-down, float or staple.');
  } else if (isLam) {
    parts.push(`${type[0].toUpperCase()}${type.slice(1)}, ${dims}, ${p.thickness} thick${p.abrasion_resistance ? ` (${p.abrasion_resistance} rated)` : ''}.`);
    if (p.surface_texture) parts.push(`${p.surface_texture} finish.`);
    if (p.material === 'Waterproof Laminate') parts.push('100% waterproof HDF core.');
  } else {
    parts.push(`${dims} planks, ${p.thickness} overall${p.wear_layer ? ` with a ${p.wear_layer} wear layer` : ''}.`);
    if (p.underlayer) parts.push(`${p.underlayer}.`);
    if (p.surface_texture) parts.push(`${p.surface_texture} surface.`);
    if (p.closeout) parts.push('Closeout inventory — while supplies last.');
  }
  if (p.sqft_box) parts.push(`${p.sqft_box} sq ft per box, ${p.box_pallet} boxes per pallet.`);
  return { short, long: parts.join(' ').replace(/\s+/g, ' ').trim() };
}

async function setPlankAttrs(skuId, p) {
  await setAttr(skuId, 'material', p.material);
  await setAttr(skuId, 'construction', p.construction);
  await setAttr(skuId, 'color', p.color);
  await setAttr(skuId, 'collection', p.collection);
  await setAttr(skuId, 'species', p.species);
  await setAttr(skuId, 'surface_texture', p.surface_texture);
  await setAttr(skuId, 'finish', p.finish);
  await setAttr(skuId, 'size', p.size);
  await setAttr(skuId, 'thickness', p.thickness);
  await setAttr(skuId, 'width', p.width);
  await setAttr(skuId, 'length', p.length);
  await setAttr(skuId, 'wear_layer', p.wear_layer);
  await setAttr(skuId, 'underlayer', p.underlayer);
  await setAttr(skuId, 'abrasion_resistance', p.abrasion_resistance);
  await setAttr(skuId, 'water_absorption', p.water_absorption);
}

// ==================== Main ====================
async function main() {
  console.log('=== Parliament Floors Import ===\n');
  const vendorId = await upsertVendor(catalog.vendor);
  console.log(`Vendor: ${catalog.vendor.name} (${vendorId})`);

  // Brands (Parliament / Elevate / Visions) — map catalog brand code → brand id.
  const brandId = {};
  for (const b of catalog.brands) {
    const id = await upsertBrand(b.name, b.code, b.website);
    await linkVendorBrand(vendorId, id, b.code === 'PARLIAMENT_BRAND');
    brandId[b.code === 'PARLIAMENT_BRAND' ? 'PARLIAMENT' : b.code] = id;
    console.log(`  brand: ${b.name} (${id})`);
  }
  console.log('');

  const CAT = {};
  for (const slug of ['lvp-plank', 'laminate', 'engineered-hardwood', 'transitions-moldings', 'underlayment']) {
    CAT[slug] = await getCategoryId(slug);
    if (!CAT[slug]) throw new Error(`required category missing: ${slug}`);
  }

  // Full rebuild: purge ALL existing Parliament products + SKUs + dependents before
  // re-importing. Required because the product upsert matches on
  // (vendor, collection, name) — a collection rename (e.g. "Generations" → "WPC")
  // would otherwise miss the old row and leave a stale duplicate behind. Safe here:
  // single-vendor, brand-new data with no real orders/carts referencing it.
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
    console.log(`Purged ${prodIds.length} existing Parliament products (${skuIds.length} SKUs) for clean rebuild\n`);
  }

  let pNew = 0, pUpd = 0, sNew = 0, sUpd = 0, mediaN = 0, noImg = 0;
  // acc family → array of plank SKU ids (for molding attachment)
  const familySkus = { SPC: [], WPC: [], LAM: [], ELEVATE: [], VISIONS: [] };

  // ---- Pass 1: floor products (one product / one SKU each) ----
  for (const p of catalog.products) {
    const { short, long } = buildDesc(p);
    const prod = await upsertProduct(vendorId, brandId[p.brand], CAT[p.category], {
      name: p.name, collection: p.collection, status: p.status || 'active',
      description_short: short, description_long: long,
    });
    prod.is_new ? pNew++ : pUpd++;

    const sku = await upsertSku(prod.id, {
      vendor_sku: p.item, internal_sku: `PARL-${p.item}`,
      variant_name: p.size || null, sell_by: 'box',
    });
    sku.is_new ? sNew++ : sUpd++;
    if (familySkus[p.acc]) familySkus[p.acc].push(sku.id);

    await upsertPricing(sku.id, p.cost, keystone(p.cost), 'per_sqft');
    await upsertPackaging(sku.id, p.sqft_box, p.lbs_box, p.box_pallet);
    await setPlankAttrs(sku.id, p);

    const img = findImage(p);
    if (img && img.primary) {
      let so = 0;
      await upsertMedia(prod.id, img.primary, 'primary', so++);
      if (img.lifestyle && img.lifestyle !== img.primary) await upsertMedia(prod.id, img.lifestyle, 'lifestyle', so++);
      mediaN++;
    } else { noImg++; }
  }
  console.log(`Floors: ${pNew} new / ${pUpd} updated products, ${sNew} new / ${sUpd} updated SKUs`);
  console.log(`Media:  ${mediaN} with photo, ${noImg} without (WPC/EX-laminate/hardwood not on site)`);

  // ---- Pass 2: molding accessory products (one per family) + links ----
  const moldBrand = { SPC: 'PARLIAMENT', WPC: 'PARLIAMENT', LAM: 'PARLIAMENT', ELEVATE: 'ELEVATE', VISIONS: 'VISIONS' };
  let mProd = 0, mSku = 0, links = 0;
  for (const fam of Object.keys(catalog.molding_sets)) {
    const set = catalog.molding_sets[fam];
    const parents = familySkus[fam] || [];
    if (!parents.length) { console.warn(`  ! no ${fam} floors to attach ${set.name} to`); continue; }

    const mprod = await upsertProduct(vendorId, brandId[moldBrand[fam]], CAT['transitions-moldings'], {
      name: set.name, collection: set.name, status: 'active',
      description_short: set.desc,
      description_long: `${set.desc} Available profiles: ${set.pieces.map((x) => x.type).join(', ')}. Each piece sold individually.`,
    });
    mprod.is_new ? mProd++ : 0;

    const moldSkuIds = [];
    let so = 0;
    for (const piece of set.pieces) {
      const msku = await upsertSku(mprod.id, {
        vendor_sku: `${piece.code}-${fam}`, internal_sku: `PARL-MOLD-${fam}-${piece.code}`,
        variant_name: piece.type, sell_by: 'unit', variant_type: 'accessory', accessory_label: piece.type,
      });
      msku.is_new ? mSku++ : 0;
      moldSkuIds.push(msku.id);
      await upsertPricing(msku.id, piece.cost, keystone(piece.cost), 'per_unit');
      await setAttr(msku.id, 'material', set.material);
      await setAttr(msku.id, 'collection', set.name);
      await setAttr(msku.id, 'length', piece.length || set.length);
      await setAttr(msku.id, 'size', `${piece.length || set.length} piece`);
    }
    // attach every profile to every floor in the family
    for (const parentId of parents) { let k = 0; for (const accId of moldSkuIds) { await linkAccessory(parentId, accId, k++); links++; } }
    console.log(`  ${set.name}: ${moldSkuIds.length} profiles × ${parents.length} floors = ${parents.length * moldSkuIds.length} links`);
  }

  // ---- Pass 3: underlayments & poly (standalone products, category underlayment) ----
  let uProd = 0, uSku = 0;
  const uParent = await upsertProduct(vendorId, brandId['PARLIAMENT'], CAT['underlayment'], {
    name: 'Parliament Underlayment & Moisture Barrier', collection: 'Underlayment & Accessories', status: 'active',
    description_short: 'Foam, EVA, cork and poly underlayment / moisture-barrier options for Parliament floating floors. Sold per sq ft.',
    description_long: 'Parliament underlayment and moisture-barrier accessories for floating SPC, WPC and laminate installations — basic silver foam, blue & grey EVA, IXPE sound solution, 1/4" and 1/2" cork, and 6-mil poly film. Sold per square foot.',
  });
  uParent.is_new ? uProd++ : 0;
  for (const u of catalog.underlayments) {
    const usku = await upsertSku(uParent.id, {
      vendor_sku: u.item, internal_sku: `PARL-${u.item}`,
      variant_name: u.name, sell_by: 'sqft', variant_type: 'accessory', accessory_label: u.name,
    });
    usku.is_new ? uSku++ : 0;
    await upsertPricing(usku.id, u.cost, keystone(u.cost), 'per_sqft');
    await setAttr(usku.id, 'material', 'Underlayment');
    await setAttr(usku.id, 'thickness', u.thickness);
    await setAttr(usku.id, 'size', u.spec);
  }
  console.log(`Underlayment: ${uProd} product, ${uSku} SKUs`);

  console.log(`\nMoldings: ${mProd} products, ${mSku} SKUs, ${links} accessory links`);
  console.log('\nDone.');
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
