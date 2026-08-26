#!/usr/bin/env node
/**
 * Import Moma Ceramiche Group (MCG Los Angeles) — Italian porcelain tile.
 *
 * Moma Ceramiche Group (301 S State College Blvd, Fullerton CA — momaceramichegroup.com)
 * is onboarded as a NEW vendor carrying a single brand (Moma Ceramiche Group).
 * Source: backend/data/moma/catalog.json (MCG Los Angeles May 2025 price list) +
 * images.json (self-hosted under /uploads/moma from the site's per-collection
 * "Product Images" + "Room Settings HD" zips — files are color-named so room
 * scenes are matched to the correct variant).
 *
 * VARIANT MODEL (see [[variant-pill-independence]]): SKUs are grouped into products
 * by (size + finish); each product holds one SKU per color offered in that size/finish.
 * The storefront then renders three clean rows from the standard tile path (NOT
 * format_group, which would add a redundant "Style" row on top of Size):
 *   - Color  → same-product color swatches (the 'color' attribute)
 *   - Size   → native Size pills built from collection siblings (same collection +
 *              category), parsed from product_name "<Collection> <Size>".
 *   - Finish → native Finish pills, shown only where a collection offers >1 finish
 *              at the SAME size (Marmi Lux Nat/Pol, Italian Stones/Levante/Travertine
 *              Nat/R11). Those products carry ", <Finish>" in the name + a finish attr.
 * Photos attach per SKU (media_assets.sku_id): face shots by role (field vs
 * wall/structured/lineal vs paver, with field fallback) + color-matched room
 * lifestyle. Per-collection catalog PDF attaches product-level as spec_pdf.
 *
 * Pricing: pricelist Net Price = Roma COST; retail = cost x1.6 nickel keystone.
 * Tile sold per sqft by the box (sell_by 'box', per_sqft). Courtesy bullnose +
 * mosaic trims (from the pricelist trims note) are per-collection accessory SKUs
 * linked via sku_accessories to the collection's field SKUs. 63x126 slabs are
 * unpriced in the LA list → imported as DRAFT (no pricing/photos).
 *
 * Usage: docker compose exec api node scripts/import-moma.js
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
const DATA_DIR = process.env.MOMA_DATA_DIR || path.join(__dirname, '..', 'data', 'moma');
const catalog = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'catalog.json'), 'utf8'));
let images = {};
try { images = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'images.json'), 'utf8')); }
catch { console.warn('! images.json not found — importing without photos'); }

const MARKUP = catalog.markup || 1.6;
const keystone = (cost) => parseFloat((Math.round(cost * MARKUP / 0.05) * 0.05).toFixed(2));

// collection slug -> catalog PDF path (7 collection-specific + shared general for the rest)
const GENERAL_PDF = '/uploads/moma/_general-catalog.pdf';
const CATALOG_PDF = {
  chalet: '/uploads/moma/chalet/chalet-catalog.pdf',
  ecoslate: '/uploads/moma/ecoslate/ecoslate-catalog.pdf',
  'italian-stones': '/uploads/moma/italian-stones/italian-stones-catalog.pdf',
  'marmi-lux': '/uploads/moma/marmi-lux/marmi-lux-catalog.pdf',
  'pl-stone': '/uploads/moma/pl-stone/pl-stone-catalog.pdf',
  travertine: '/uploads/moma/travertine/travertine-catalog.pdf',
  vintage: '/uploads/moma/vintage/vintage-catalog.pdf',
  // general catalog for the rest
  alaska: GENERAL_PDF, dea: GENERAL_PDF, levante: GENERAL_PDF,
  limestone: GENERAL_PDF, savage: GENERAL_PDF, trex: GENERAL_PDF,
};

const FINISH_SUFFIX = { Natural: '', Polished: 'POL', R11: 'R11', Structured: 'STR', Lineal: 'LIN' };
const sizeCompact = (s) => s.replace(/x/i, '');
const sizeNominal = (s) => { const [a, b] = s.split('x'); return `${a}"x${b}"`; };
const appOf = (role) => role === 'wall' ? 'Wall' : role === 'paver' ? 'Floor · Outdoor' : 'Floor · Wall';

// Collections that offer >1 finish at the SAME size → finish is an independent axis,
// so field product names carry ", <Finish>" and the storefront shows a Finish pill row.
// (Chalet's Natural/R11 are on different sizes → finish is 1:1 with size, so it's left
// as size-only pills.) Wall/paver products carry a "Wall"/"Paver" tag (plus the finish
// when it's a distinguishing one, e.g. Structured/Lineal) so the name conveys the product
// type and stays unique against the same-size field product. A bare "Natural" finish is
// dropped from wall names — it's the default and adds no information.
const FINISH_AXIS = new Set(['marmi-lux', 'italian-stones', 'levante', 'travertine']);
function productName(col, prod) {
  const base = `${col.name} ${prod.size}`;
  if (prod.role === 'paver') return `${base}, ${prod.finish} Paver`;
  if (prod.role === 'wall') return prod.finish === 'Natural' ? `${base} Wall` : `${base}, ${prod.finish} Wall`;
  if (FINISH_AXIS.has(col.slug)) return `${base}, ${prod.finish}`;
  return base;
}

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
    INSERT INTO products (vendor_id, brand_id, name, collection, category_id, status,
      description_short, description_long, format_group, format_label)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    ON CONFLICT ON CONSTRAINT products_vendor_collection_name_unique DO UPDATE SET
      brand_id=EXCLUDED.brand_id, category_id=EXCLUDED.category_id, status=EXCLUDED.status,
      description_short=EXCLUDED.description_short, description_long=EXCLUDED.description_long,
      format_group=EXCLUDED.format_group, format_label=EXCLUDED.format_label, updated_at=CURRENT_TIMESTAMP
    RETURNING id, (xmax = 0) AS is_new`,
    [p.vendorId, p.brandId, p.name, p.collection, p.categoryId, p.status || 'active',
     p.short, p.long, p.format_group || null, p.format_label || null]);
  return r.rows[0];
}
async function upsertSku(s) {
  const r = await pool.query(`
    INSERT INTO skus (product_id, vendor_sku, internal_sku, variant_name, sell_by, variant_type, accessory_label, status)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT (internal_sku) DO UPDATE SET product_id=EXCLUDED.product_id, vendor_sku=EXCLUDED.vendor_sku,
      variant_name=EXCLUDED.variant_name, sell_by=EXCLUDED.sell_by, variant_type=EXCLUDED.variant_type,
      accessory_label=EXCLUDED.accessory_label, status=EXCLUDED.status, updated_at=CURRENT_TIMESTAMP
    RETURNING id, (xmax = 0) AS is_new`,
    [s.productId, s.vendor_sku, s.internal_sku, s.variant_name || null, s.sell_by || 'box',
     s.variant_type || null, s.accessory_label || null, s.status || 'active']);
  return r.rows[0];
}
async function upsertPricing(skuId, cost, retail, basis) {
  await pool.query(`
    INSERT INTO pricing (sku_id, cost, retail_price, price_basis) VALUES ($1,$2,$3,$4)
    ON CONFLICT (sku_id) DO UPDATE SET cost=EXCLUDED.cost, retail_price=EXCLUDED.retail_price, price_basis=EXCLUDED.price_basis`,
    [skuId, cost, retail, basis]);
}
async function upsertPackaging(skuId, pk) {
  if (!pk) return;
  await pool.query(`
    INSERT INTO packaging (sku_id, sqft_per_box, pieces_per_box, weight_per_box_lbs, boxes_per_pallet, sqft_per_pallet)
    VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT (sku_id) DO UPDATE SET sqft_per_box=EXCLUDED.sqft_per_box, pieces_per_box=EXCLUDED.pieces_per_box,
      weight_per_box_lbs=EXCLUDED.weight_per_box_lbs, boxes_per_pallet=EXCLUDED.boxes_per_pallet, sqft_per_pallet=EXCLUDED.sqft_per_pallet`,
    [skuId, pk.sqft_box ?? null, pk.pcs_box ?? null, pk.lbs_box ?? null, pk.boxes_pallet ?? null, pk.sqft_pallet ?? null]);
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
async function skuMedia(productId, skuId, url, assetType, sortOrder) {
  if (!url) return;
  await pool.query(`
    INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order, source)
    VALUES ($1,$2,$3,$4,$4,$5,'momaceramichegroup.com')
    ON CONFLICT (product_id, sku_id, asset_type, sort_order) WHERE sku_id IS NOT NULL
    DO UPDATE SET url=EXCLUDED.url, original_url=EXCLUDED.original_url, source=EXCLUDED.source`,
    [productId, skuId, assetType, url, sortOrder]);
}
async function productMedia(productId, url, assetType, sortOrder) {
  if (!url) return;
  await pool.query(`
    INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order, source)
    VALUES ($1,NULL,$2,$3,$3,$4,'momaceramichegroup.com')
    ON CONFLICT (product_id, asset_type, sort_order) WHERE sku_id IS NULL
    DO UPDATE SET url=EXCLUDED.url, original_url=EXCLUDED.original_url, source=EXCLUDED.source`,
    [productId, assetType, url, sortOrder]);
}
async function linkAccessory(parentSkuId, accessorySkuId, sortOrder) {
  await pool.query(`
    INSERT INTO sku_accessories (parent_sku_id, accessory_sku_id, sort_order) VALUES ($1,$2,$3)
    ON CONFLICT (parent_sku_id, accessory_sku_id) DO UPDATE SET sort_order=EXCLUDED.sort_order`,
    [parentSkuId, accessorySkuId, sortOrder]);
}

// attach a color's images to one SKU (role-specific faces + shared lifestyle)
async function attachColorMedia(productId, skuId, code, role) {
  const im = images[code];
  if (!im) return false;
  const faces = (role !== 'field' && im[role]) ? im[role] : im.field;
  let any = false;
  if (faces && faces.primary) { await skuMedia(productId, skuId, faces.primary, 'primary', 0); any = true; }
  let so = 0;
  for (const u of (faces && faces.alternates || [])) await skuMedia(productId, skuId, u, 'alternate', so++);
  so = 0;
  for (const u of (im.lifestyle || [])) await skuMedia(productId, skuId, u, 'lifestyle', so++);
  return any;
}

// ==================== Main ====================
async function main() {
  console.log('=== Moma Ceramiche Group Import ===\n');
  const vendorId = await upsertVendor(catalog.vendor);
  console.log(`Vendor: ${catalog.vendor.name} (${vendorId})`);
  const brandId = await upsertBrand(catalog.brand);
  await linkVendorBrand(vendorId, brandId, true);
  console.log(`Brand:  ${catalog.brand.name} (${brandId})`);

  // category cache
  const CAT = {};
  const catSlugs = new Set(['trim-accessories', 'porcelain-slabs']);
  for (const c of catalog.collections) {
    catSlugs.add(c.category); if (c.wall_category) catSlugs.add(c.wall_category); if (c.paver_category) catSlugs.add(c.paver_category);
  }
  for (const s of catSlugs) CAT[s] = await getCategoryId(s);

  // Full rebuild: purge existing MOMA products + dependents
  const prodRows = await pool.query(`SELECT p.id FROM products p JOIN vendors v ON v.id=p.vendor_id WHERE v.code=$1`, [catalog.vendor.code]);
  const prodIds = prodRows.rows.map(r => r.id);
  if (prodIds.length) {
    const skuRows = await pool.query(`SELECT id FROM skus WHERE product_id = ANY($1)`, [prodIds]);
    const skuIds = skuRows.rows.map(r => r.id);
    if (skuIds.length) {
      await pool.query(`DELETE FROM sku_accessories WHERE parent_sku_id = ANY($1) OR accessory_sku_id = ANY($1)`, [skuIds]);
      for (const tbl of ['cart_items', 'sku_attributes', 'pricing', 'packaging', 'media_assets']) {
        await pool.query(`DELETE FROM ${tbl} WHERE sku_id = ANY($1)`, [skuIds]);
      }
      await pool.query(`DELETE FROM skus WHERE id = ANY($1)`, [skuIds]);
    }
    await pool.query(`DELETE FROM media_assets WHERE product_id = ANY($1)`, [prodIds]);
    await pool.query(`DELETE FROM products WHERE id = ANY($1)`, [prodIds]);
    console.log(`Purged ${prodIds.length} existing MOMA products (${skuIds.length} SKUs)\n`);
  }

  let pN = 0, sN = 0, mN = 0, noImg = 0, accN = 0, linkN = 0;

  for (const col of catalog.collections) {
    const colorMeta = Object.fromEntries(col.colors.map(c => [c.name, c]));
    const fieldSkuIds = [];
    let colProducts = 0, colSkus = 0;

    for (const prod of col.products) {
      const cat = prod.role === 'wall' ? (col.wall_category ? CAT[col.wall_category] : CAT[col.category])
        : prod.role === 'paver' ? (col.paver_category ? CAT[col.paver_category] : CAT[col.category])
        : CAT[col.category];
      const P = await upsertProduct({
        vendorId, brandId, categoryId: cat, status: 'active',
        name: productName(col, prod), collection: col.name,
        short: col.description_short, long: col.description_long,
        format_group: null, format_label: null,
      });
      if (P.is_new) pN++; colProducts++;

      // spec_pdf at product level
      if (CATALOG_PDF[col.slug]) await productMedia(P.id, CATALOG_PDF[col.slug], 'spec_pdf', 0);

      for (const colorName of prod.colors) {
        const cm = colorMeta[colorName];
        if (!cm) { console.warn(`  ! ${col.slug}: unknown color ${colorName}`); continue; }
        const ov = (prod.color_overrides || {})[colorName] || {};
        const cost = ov.cost ?? prod.cost;
        const pkg = ov.pkg || prod.pkg;
        const suf = FINISH_SUFFIX[prod.finish] ?? '';
        const skuCode = `${cm.code}-${sizeCompact(prod.size)}${suf ? '-' + suf : ''}`;
        const S = await upsertSku({
          productId: P.id, vendor_sku: skuCode, internal_sku: `MOMA-${skuCode}`,
          variant_name: colorName, sell_by: 'box',
        });
        if (S.is_new) sN++; colSkus++;
        if (prod.role === 'field') fieldSkuIds.push(S.id);

        await upsertPricing(S.id, cost, keystone(cost), 'per_sqft');
        await upsertPackaging(S.id, pkg);

        // attributes
        await setAttr(S.id, 'material', 'Porcelain');
        await setAttr(S.id, 'look', col.look);
        await setAttr(S.id, 'collection', col.name);
        await setAttr(S.id, 'color', colorName);
        await setAttr(S.id, 'color_code', cm.code);
        await setAttr(S.id, 'finish', prod.finish);
        await setAttr(S.id, 'size', sizeNominal(prod.size));
        await setAttr(S.id, 'application', appOf(prod.role));
        await setAttr(S.id, 'rectified', 'Yes');
        await setAttr(S.id, 'shade_variation', col.shade);
        await setAttr(S.id, 'pei_rating', col.pei);
        await setAttr(S.id, 'mohs', col.mohs);
        await setAttr(S.id, 'dcof', col.dcof);
        await setAttr(S.id, 'frost_resistant', col.frost);
        if (prod.role === 'paver') await setAttr(S.id, 'thickness', '20 mm');

        const gotImg = await attachColorMedia(P.id, S.id, cm.code, prod.role);
        if (gotImg) mN++; else noImg++;
      }
    }

    // ---- accessories: bullnose + mosaic per collection, linked to field SKUs ----
    if (col.accessories && fieldSkuIds.length) {
      const AP = await upsertProduct({
        vendorId, brandId, categoryId: CAT['trim-accessories'], status: 'active',
        name: `${col.name} Trim Kit`, collection: col.name,
        short: `Matching bullnose and mosaic trims for the ${col.name} collection (sourced locally as a courtesy).`,
        long: `Coordinating single-bullnose (3"x24") and 2"x2" mosaic trims for Moma ${col.name}. Sourced locally as a courtesy to match your field tile — minimum 10 pieces, allow 2-3 weeks.`,
      });
      if (AP.is_new) pN++;
      const accSkuIds = [];
      for (const [key, a] of Object.entries(catalog.accessories)) {
        const S = await upsertSku({
          productId: AP.id, vendor_sku: `${col.code}-${key.toUpperCase()}`, internal_sku: `MOMA-${col.code}-${key.toUpperCase()}`,
          variant_name: a.label, sell_by: 'unit', variant_type: 'accessory', accessory_label: a.label,
        });
        if (S.is_new) accN++;
        const cost = parseFloat((Math.round(a.retail / MARKUP / 0.05) * 0.05).toFixed(2));
        await upsertPricing(S.id, cost, a.retail, 'per_unit');
        await setAttr(S.id, 'material', 'Porcelain');
        await setAttr(S.id, 'collection', col.name);
        await setAttr(S.id, 'size', a.size);
        accSkuIds.push(S.id);
      }
      for (const parent of fieldSkuIds) { let k = 0; for (const acc of accSkuIds) { await linkAccessory(parent, acc, k++); linkN++; } }
    }

    console.log(`  ${col.name}: ${colProducts} products, ${colSkus} SKUs`);
  }
  console.log(`\nFields/walls: ${pN} products, ${sN} SKUs, ${mN} SKUs with photo / ${noImg} without`);
  console.log(`Accessories: ${accN} SKUs, ${linkN} links`);

  // ---- Slabs (draft, unpriced) ----
  const sl = catalog.slabs;
  if (sl) {
    const SP = await upsertProduct({
      vendorId, brandId, categoryId: CAT[sl.category] || await getCategoryId(sl.category), status: 'draft',
      name: sl.name, collection: sl.name, short: `Porcelain stoneware slabs (${sizeNominal(sl.size)}), matte & polished. ${sl.note}`,
      long: sl.note,
    });
    let slN = 0;
    for (const color of sl.colors) {
      for (const fin of sl.finishes) {
        const code = color.replace(/[^A-Za-z0-9]+/g, '').toUpperCase().slice(0, 10);
        const S = await upsertSku({
          productId: SP.id, vendor_sku: `SLAB-${code}-${fin[0]}`, internal_sku: `MOMA-SLAB-${code}-${fin[0]}`,
          variant_name: `${color} — ${fin}`, sell_by: 'unit', status: 'draft',
        });
        if (S.is_new) slN++;
        await setAttr(S.id, 'material', 'Porcelain');
        await setAttr(S.id, 'look', 'Marble');
        await setAttr(S.id, 'collection', sl.name);
        await setAttr(S.id, 'color', color);
        await setAttr(S.id, 'finish', fin);
        await setAttr(S.id, 'size', sizeNominal(sl.size));
      }
    }
    console.log(`Slabs (draft): 1 product, ${slN} SKUs (no pricing/photos — contact territory manager)`);
  }

  console.log('\nDone.');
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
