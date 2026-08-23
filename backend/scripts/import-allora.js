#!/usr/bin/env node
/**
 * Import the Allora engineered-hardwood catalog (Made in Italy, European Oak).
 *
 * Allora is manufactured/distributed by Old Master Products — the SAME vendor
 * as Garrison Collection. This platform models Old Master Products as the vendor
 * (code GAR) with Garrison / Allora as sub-brands (products.brand_id). Run the
 * one-time SQL migration (allora-vendor-brand-migration.sql) FIRST — it renames
 * the vendor, creates the two brands, moves the Garrison public-name-hide onto
 * the Garrison brand, and backfills brand_id onto the existing Garrison products.
 * This importer only READS the vendor + Allora brand; it never mutates them.
 *
 * Source: backend/data/allora/catalog.json (build-allora-catalog.js) and an
 * optional images.json (build-allora-images.js) keyed by internal_sku.
 *
 * Pricing: dealer sheet price = Roma COST; retail = cost x1.6 keystone snapped
 * to a 9-ending with the covering floor (cost+$0.99), matching the store
 * standard and Garrison — see [[nine-ending-prices]] / [[covering-margin-floor]].
 * Planks sell per sqft by the box; mouldings sell per unit as accessories.
 *
 * Usage: docker compose exec api node scripts/import-allora.js
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
const DATA_DIR = process.env.ALLORA_DATA_DIR || path.join(__dirname, '..', 'data', 'allora');
const catalog = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'catalog.json'), 'utf8'));
let productImages = {}, skuImages = {};
try {
  const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'images.json'), 'utf8'));
  // New shape { products, skus }; fall back to legacy flat map (product-level only).
  productImages = raw.products || raw;
  skuImages = raw.skus || {};
} catch { console.warn('! images.json not found — importing without photos'); }

// ---- Pricing (mirrors scrapers/base.js upsertPricing) ----
const RETAIL_MARKUP = 1.6;
const RETAIL_MIN_MARGIN = 0.99;
const keystone = (cost) => Number(cost) * RETAIL_MARKUP;
const nearestNine = (v) => {
  const cents = Math.round(Number(v) * 100);
  const k = Math.floor((cents - 9) / 10);
  return Math.max(9, k * 10 + 9) / 100;
};
// price_basis 'per_sqft' → covering floor applies; 'per_unit' (mouldings) → 9-ending only.
const priceRetail = (cost, basis) => {
  const rn = keystone(cost);
  if (!(rn > 0)) return null;
  const cn = basis === 'per_sqft' ? (Number(cost) || 0) : 0;
  const floorMin = cn > 0 ? cn + RETAIL_MIN_MARGIN : 0;
  let nine = nearestNine(Math.max(rn, floorMin));
  if (floorMin > 0 && nine < floorMin - 1e-9) nine = Math.round((nine + 0.10) * 100) / 100;
  return nine;
};

// Moulding profile diagrams — generic per-type line art from Old Master's
// Garrison site (same manufacturer, same physical profiles). Stair-nosing types
// share the nosing diagram.
const MOULDING_IMG = {
  'T-Moulding': 'https://www.garrisoncollection.com/wordpress/wp-content/uploads/2019/06/t-moulding.png',
  'Reducer': 'https://www.garrisoncollection.com/wordpress/wp-content/uploads/2019/06/reducer.png',
  'Baby Threshold': 'https://www.garrisoncollection.com/wordpress/wp-content/uploads/2019/06/baby-threshold.png',
  'Square Stair Nosing': 'https://www.garrisoncollection.com/wordpress/wp-content/uploads/2019/06/nosing.png',
  'Bullnose Stair Nosing': 'https://www.garrisoncollection.com/wordpress/wp-content/uploads/2019/06/nosing.png',
};

// ==================== Helpers ====================
async function getVendorId(code) {
  const r = await pool.query('SELECT id, name FROM vendors WHERE code=$1', [code]);
  if (!r.rows.length) throw new Error(`vendor code ${code} not found — run allora-vendor-brand-migration.sql first`);
  return r.rows[0];
}
async function getBrandId(code) {
  const r = await pool.query('SELECT id, name FROM brands WHERE code=$1', [code]);
  if (!r.rows.length) throw new Error(`brand code ${code} not found — run allora-vendor-brand-migration.sql first`);
  return r.rows[0];
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
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT (internal_sku) DO UPDATE SET
      product_id=EXCLUDED.product_id, vendor_sku=EXCLUDED.vendor_sku,
      variant_name=EXCLUDED.variant_name, sell_by=EXCLUDED.sell_by,
      variant_type=EXCLUDED.variant_type, accessory_label=EXCLUDED.accessory_label,
      status=EXCLUDED.status, updated_at=CURRENT_TIMESTAMP
    RETURNING id, (xmax = 0) AS is_new
  `, [productId, s.vendor_sku, s.internal_sku, s.variant_name || null, s.sell_by || 'box',
      s.variant_type || null, s.accessory_label || null, s.status || 'active']);
  return res.rows[0];
}

async function upsertPricing(skuId, cost, basis) {
  await pool.query(`
    INSERT INTO pricing (sku_id, cost, retail_price, price_basis)
    VALUES ($1,$2,$3,$4)
    ON CONFLICT (sku_id) DO UPDATE SET cost=EXCLUDED.cost, retail_price=EXCLUDED.retail_price, price_basis=EXCLUDED.price_basis
  `, [skuId, cost, priceRetail(cost, basis), basis]);
}

async function upsertPackaging(skuId, sqftBox, lbsBox) {
  if (sqftBox == null && lbsBox == null) return;
  await pool.query(`
    INSERT INTO packaging (sku_id, sqft_per_box, weight_per_box_lbs) VALUES ($1,$2,$3)
    ON CONFLICT (sku_id) DO UPDATE SET sqft_per_box=EXCLUDED.sqft_per_box, weight_per_box_lbs=EXCLUDED.weight_per_box_lbs
  `, [skuId, sqftBox, lbsBox]);
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
async function upsertSkuMedia(productId, skuId, url, assetType, sortOrder) {
  if (!url) return;
  await pool.query(`
    INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
    VALUES ($1,$2,$3,$4,$4,$5)
    ON CONFLICT (product_id, sku_id, asset_type, sort_order) WHERE sku_id IS NOT NULL
    DO UPDATE SET url=EXCLUDED.url, original_url=EXCLUDED.original_url
  `, [productId, skuId, assetType, url, sortOrder]);
}
async function linkAccessory(parentSkuId, accessorySkuId, sortOrder) {
  await pool.query(`
    INSERT INTO sku_accessories (parent_sku_id, accessory_sku_id, sort_order)
    VALUES ($1,$2,$3)
    ON CONFLICT (parent_sku_id, accessory_sku_id) DO UPDATE SET sort_order=EXCLUDED.sort_order
  `, [parentSkuId, accessorySkuId, sortOrder]);
}

// ---- Descriptions ----
function buildDescriptions(p) {
  const s = p.skus[0];
  const grades = [...new Set(p.skus.map((x) => x.grade).filter(Boolean))];
  const widths = [...new Set(p.skus.map((x) => x.width).filter(Boolean))];
  const short = `Allora ${p.name} — Made in Italy European Oak engineered hardwood, ${THICKNESS_LABEL}, ${WEAR_LABEL} wear layer${p.finish ? `, ${p.finish.toLowerCase()}` : ''}.`;
  const long = [
    `Allora ${p.name} — Made in Italy, European Oak engineered hardwood (100% birch plywood core, micro-beveled edge).`,
    widths.length ? `Available in ${widths.join(' & ')}${p.skus.some((x) => x.pattern) ? ' plank and herringbone' : ''}.` : '',
    grades.length ? `${grades.join(' / ')} grade.` : '',
    `${p.finish}. ${p.specs.surface_texture} surface texture, ${WEAR_LABEL} wear layer.`,
    p.mould_note ? `Mouldings: ${p.mould_note}` : '',
  ].join(' ').replace(/\s+/g, ' ').trim();
  return { short, long };
}
const THICKNESS_LABEL = '5/8" (15 mm)';
const WEAR_LABEL = '4.0 mm';

async function setPlankAttrs(skuId, p, s) {
  await setAttr(skuId, 'material', p.material || 'Engineered Hardwood');
  await setAttr(skuId, 'color', p.color);
  await setAttr(skuId, 'collection', p.collection);
  await setAttr(skuId, 'species', p.species);
  await setAttr(skuId, 'finish', s.finish);
  await setAttr(skuId, 'size', s.size);
  await setAttr(skuId, 'thickness', s.thickness);
  await setAttr(skuId, 'width', s.width);
  await setAttr(skuId, 'length', s.length);
  await setAttr(skuId, 'wear_layer', s.wear_layer);
  await setAttr(skuId, 'grade', s.grade);
  await setAttr(skuId, 'edge_type', s.edge_type);
  await setAttr(skuId, 'construction', p.specs && p.specs.construction);
  await setAttr(skuId, 'installation_method', p.specs && p.specs.installation_method);
  await setAttr(skuId, 'surface_texture', (p.specs && p.specs.surface_texture) || s.finish);
  await setAttr(skuId, 'pattern', s.pattern);
}

// ==================== Main ====================
async function main() {
  console.log('=== Allora Import ===\n');
  const vendor = await getVendorId(catalog.vendor.code);
  const brand = await getBrandId(catalog.vendor.brand_code);
  console.log(`Vendor: ${vendor.name} (${vendor.id})`);
  console.log(`Brand:  ${brand.name} (${brand.id})\n`);

  const catHW = await getCategoryId('engineered-hardwood');
  const catMould = await getCategoryId('transitions-moldings');
  if (!catHW) throw new Error('engineered-hardwood category missing');

  let pNew = 0, pUpd = 0, sNew = 0, sUpd = 0, mediaN = 0, noImg = 0, skuMediaN = 0;
  const pending = [];

  // Clear existing SKU-level media on non-accessory Allora SKUs (herringbone)
  // so a re-run with a shorter gallery doesn't leave stale rows behind.
  await pool.query(`
    DELETE FROM media_assets WHERE sku_id IN (
      SELECT s.id FROM skus s WHERE s.internal_sku LIKE 'ALLORA-%' AND COALESCE(s.variant_type,'')<>'accessory')
  `);

  // ---- Pass 1: plank products ----
  for (const p of catalog.products) {
    const { short, long } = buildDescriptions(p);
    const prod = await upsertProduct(vendor.id, brand.id, catHW, {
      name: p.name, collection: p.collection, status: p.status || 'active',
      description_short: short, description_long: long,
    });
    prod.is_new ? pNew++ : pUpd++;

    const plankSkuIds = [];
    let productImg = null;
    for (const s of p.skus) {
      const sku = await upsertSku(prod.id, {
        vendor_sku: s.vendor_sku, internal_sku: s.internal_sku,
        variant_name: s.variant_name, sell_by: 'box', status: s.status,
      });
      sku.is_new ? sNew++ : sUpd++;
      await upsertPricing(sku.id, s.cost, 'per_sqft');
      await upsertPackaging(sku.id, s.sqft_box, s.lbs_box);
      await setPlankAttrs(sku.id, p, s);
      plankSkuIds.push(sku.id);
      if (!productImg && productImages[s.internal_sku]) productImg = productImages[s.internal_sku];

      // SKU-level media (herringbone): its own overhead + lifestyle so the
      // herringbone variant shows the real pattern, not the straight-plank photo.
      // The storefront gallery uses ONLY sku-level media when 2+ exist (no
      // product-level contamination) — see server.js sku detail media logic.
      const si = skuImages[s.internal_sku];
      if (si && si.primary) {
        await upsertSkuMedia(prod.id, sku.id, si.primary, 'primary', 0);
        let lo = 1;
        for (const url of si.lifestyle || []) {
          if (url && url !== si.primary) await upsertSkuMedia(prod.id, sku.id, url, 'lifestyle', lo++);
        }
        skuMediaN++;
      }
    }

    if (productImg && productImg.primary) {
      await upsertMedia(prod.id, productImg.primary, 'primary', 0);
      let so = 1;
      for (const url of productImg.lifestyle || []) {
        if (url && url !== productImg.primary) await upsertMedia(prod.id, url, 'lifestyle', so++);
      }
      mediaN++;
    } else { noImg++; }

    if (p.mouldings && p.mouldings.length) pending.push({ collection: p.collection, plankSkuIds, mouldings: p.mouldings, color: p.color });

    const priceRange = [...new Set(p.skus.map((x) => `$${x.cost}`))].join('/');
    console.log(`  ${prod.is_new ? '+' : '~'} ${p.name} (${p.skus.length} sku) ${priceRange}/sf${productImg ? '' : '  [no photo]'}`);
  }

  // ---- Pass 2: moulding accessory product + links ----
  // Wipe existing Allora accessory links so re-runs prune stale ones.
  await pool.query(`
    DELETE FROM sku_accessories WHERE accessory_sku_id IN (
      SELECT s.id FROM skus s WHERE s.internal_sku LIKE 'ALLORA-%' AND COALESCE(s.variant_type,'')='accessory')
  `);

  const mouldSkuByInternal = new Map();
  let mprod = null, mSku = 0, links = 0, mImg = 0;

  for (const item of pending) {
    if (!mprod) {
      mprod = await upsertProduct(vendor.id, brand.id, catMould, {
        name: 'Allora Mouldings', collection: 'Allora Mouldings', status: 'active',
        description_short: 'Color-matched hardwood mouldings for Allora engineered hardwood floors.',
        description_long: 'Prefinished color-matched transition mouldings (Reducer, Square & Bullnose Stair Nosing, Baby Threshold, T-Moulding) for Allora Made-in-Italy European Oak engineered hardwood floors. Sold per piece.',
      });
    }
    let so = 0;
    for (const m of item.mouldings) {
      let mid = mouldSkuByInternal.get(m.internal_sku);
      if (!mid) {
        const msku = await upsertSku(mprod.id, {
          vendor_sku: m.vendor_sku, internal_sku: m.internal_sku,
          variant_name: m.accessory_label, sell_by: 'unit',
          variant_type: 'accessory', accessory_label: m.accessory_label, status: 'active',
        });
        msku.is_new ? mSku++ : 0;
        await upsertPricing(msku.id, m.cost, 'per_unit');
        await setAttr(msku.id, 'material', 'Engineered Hardwood');
        await setAttr(msku.id, 'collection', 'Allora');
        await setAttr(msku.id, 'color', item.color);
        await setAttr(msku.id, 'size', m.size);
        if (MOULDING_IMG[m.type]) { await upsertSkuMedia(mprod.id, msku.id, MOULDING_IMG[m.type], 'primary', 0); mImg++; }
        mid = msku.id;
        mouldSkuByInternal.set(m.internal_sku, mid);
      }
      for (const parentId of item.plankSkuIds) { await linkAccessory(parentId, mid, so); links++; }
      so++;
    }
  }

  console.log(`\nPlank products: ${pNew} new, ${pUpd} updated`);
  console.log(`Plank SKUs:     ${sNew} new, ${sUpd} updated`);
  console.log(`Media:          ${mediaN} products with photos, ${noImg} without · ${skuMediaN} herringbone SKU galleries`);
  console.log(`Moulding SKUs:  ${mSku} new · Accessory links: ${links} · Moulding images: ${mImg}`);
  await pool.end();
  console.log('\nDone.');
}

main().catch((e) => { console.error(e); process.exit(1); });
