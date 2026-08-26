#!/usr/bin/env node
/**
 * Import the Garrison Collection engineered-hardwood catalog (vendor GARRISON,
 * exclusively manufactured by Old Master Products, Inc. — garrisoncollection.com).
 *
 * Source: backend/data/garrison/catalog.json  (built by build-garrison-catalog.js
 * from the Preferred Customer Price List v2026.03) and images.json (built by
 * build-garrison-images.js from the live product pages).
 *
 * Pricing: the "Preferred Customer" sheet price is Roma's COST; retail = cost x
 * 1.6, nickel-rounded (store keystone standard — see [[selling-conventions]]).
 * Flooring is sold per sqft, by the box (sell_by 'box' → coverage calc rounds up
 * to whole cartons; price_basis stays per_sqft — see [[pdi-onboarding]]).
 *
 * Products are grouped by (collection, color, species); same-color/different-size
 * lines (Contractor's Choice, Crystal Valley, CV America) carry size-variant SKUs.
 *
 * Mouldings (T-Moulding / Reducer / Baby Threshold / Nosing) are the priced,
 * color-matched accessories. Each is created once (deduped globally by
 * internal_sku — Garrison II Smooth reuses some Garrison II Distressed moulding
 * SKUs) under a "{Collection} Mouldings" product and attached to that color's
 * plank SKU(s) via sku_accessories so they surface in the storefront "Matching
 * Accessories" section (see [[line-item-display]], [[mango-onboarding]]).
 *
 * Images: primary = the main plank/product photo; lifestyle = the collection
 * room scene (per user: "main photo is the primary, room photos below").
 *
 * Usage: docker compose exec api node scripts/import-garrison.js
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
const DATA_DIR = process.env.GARRISON_DATA_DIR || path.join(__dirname, '..', 'data', 'garrison');
const catalog = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'catalog.json'), 'utf8'));
let images = {};
try { images = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'images.json'), 'utf8')); }
catch { console.warn('! images.json not found — importing without photos'); }

const RETAIL_MARKUP = 1.6;
const keystone = (cost) => parseFloat((Math.round(cost * RETAIL_MARKUP / 0.05) * 0.05).toFixed(2));

// Moulding profile diagrams from the product-page "molding section" (garrison's
// `mouldings` JSON). Generic per moulding TYPE (same profile for every color).
const MOULDING_IMG = {
  'T-Moulding': 'https://www.garrisoncollection.com/wordpress/wp-content/uploads/2019/06/t-moulding.png',
  'Reducer': 'https://www.garrisoncollection.com/wordpress/wp-content/uploads/2019/06/reducer.png',
  'Baby Threshold': 'https://www.garrisoncollection.com/wordpress/wp-content/uploads/2019/06/baby-threshold.png',
  'Nosing': 'https://www.garrisoncollection.com/wordpress/wp-content/uploads/2019/06/nosing.png',
};

// ==================== Helpers ====================
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

async function getCategoryId(slug) {
  const r = await pool.query('SELECT id FROM categories WHERE slug=$1', [slug]);
  return r.rows.length ? r.rows[0].id : null;
}

async function upsertProduct(vendorId, categoryId, p) {
  const res = await pool.query(`
    INSERT INTO products (vendor_id, name, collection, category_id, status, description_short, description_long)
    VALUES ($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT ON CONSTRAINT products_vendor_collection_name_unique DO UPDATE SET
      category_id=EXCLUDED.category_id, status=EXCLUDED.status,
      description_short=EXCLUDED.description_short, description_long=EXCLUDED.description_long,
      updated_at=CURRENT_TIMESTAMP
    RETURNING id, (xmax = 0) AS is_new
  `, [vendorId, p.name, p.collection, categoryId, p.status || 'active', p.description_short, p.description_long]);
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

async function upsertPricing(skuId, cost, retail, basis) {
  await pool.query(`
    INSERT INTO pricing (sku_id, cost, retail_price, price_basis)
    VALUES ($1,$2,$3,$4)
    ON CONFLICT (sku_id) DO UPDATE SET cost=EXCLUDED.cost, retail_price=EXCLUDED.retail_price, price_basis=EXCLUDED.price_basis
  `, [skuId, cost, retail, basis]);
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
  const species = p.species || 'hardwood';
  const sizes = [...new Set(p.skus.map((x) => x.size).filter(Boolean))];
  const dims = sizes.length ? sizes.join(' / ') : [s.thickness, s.width].filter(Boolean).join(' x ');
  const finish = s.finish || '';
  const parts = [];
  if (s.thickness) parts.push(`${s.thickness} thick`);
  if (s.width && !sizes.length) parts.push(`${s.width} wide`);
  if (s.length) parts.push(`${s.length} lengths`);
  const short = `Engineered ${species} hardwood — ${dims}${s.wear_layer ? `, ${s.wear_layer} wear layer` : ''}${finish ? `, ${finish.toLowerCase()}` : ''}.`;
  const long = [
    `Garrison ${p.collection} ${p.name} — engineered ${species} hardwood`,
    parts.length ? `(${parts.join(', ')})` : '',
    `${finish ? `${finish} finish. ` : ''}${s.construction ? `${s.construction}. ` : ''}`,
    `${s.grade ? `${s.grade} grade. ` : ''}${s.installation_method ? `${s.installation_method} installation. ` : ''}`,
    `${s.sqft_box ? `${s.sqft_box} sq ft per box.` : ''}`,
    p.mould_note ? ` Mouldings: ${p.mould_note}` : '',
  ].join(' ').replace(/\s+/g, ' ').trim();
  return { short, long };
}

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
  console.log('=== Garrison Collection Import ===\n');
  const vendorId = await upsertVendor(catalog.vendor);
  console.log(`Vendor: ${catalog.vendor.name} (${vendorId})\n`);

  const catHW = await getCategoryId('engineered-hardwood');
  const catMould = await getCategoryId('transitions-moldings');
  if (!catHW) throw new Error('engineered-hardwood category missing');

  // Clear existing GARRISON lifestyle media (source changed to "See It in Action"
  // photos) so stale collection-banner rows don't linger on re-import.
  await pool.query(`
    DELETE FROM media_assets WHERE sku_id IS NULL AND asset_type='lifestyle' AND product_id IN (
      SELECT p.id FROM products p JOIN vendors v ON v.id=p.vendor_id WHERE v.code=$1)
  `, [catalog.vendor.code]);

  let pNew = 0, pUpd = 0, sNew = 0, sUpd = 0, mediaN = 0, noImg = 0, docN = 0;
  const pending = []; // { plankSkuIds, mouldings, collection } for accessory pass

  // ---- Pass 1: plank products ----
  for (const p of catalog.products) {
    const { short, long } = buildDescriptions(p);
    const prod = await upsertProduct(vendorId, catHW, {
      name: p.name, collection: p.collection, status: 'active',
      description_short: short, description_long: long,
    });
    prod.is_new ? pNew++ : pUpd++;

    const plankSkuIds = [];
    let productImg = null;
    for (const s of p.skus) {
      const sku = await upsertSku(prod.id, {
        vendor_sku: s.vendor_sku, internal_sku: s.internal_sku,
        variant_name: s.variant_name || s.width || 'Plank',
        sell_by: 'box', status: s.status,
      });
      sku.is_new ? sNew++ : sUpd++;
      await upsertPricing(sku.id, s.cost, keystone(s.cost), 'per_sqft');
      await upsertPackaging(sku.id, s.sqft_box, s.lbs_box);
      await setPlankAttrs(sku.id, p, s);
      plankSkuIds.push(sku.id);
      if (!productImg && images[s.internal_sku]) productImg = images[s.internal_sku];
    }

    // Media (product-level): primary plank photo + room/lifestyle scenes.
    if (productImg && productImg.primary) {
      await upsertMedia(prod.id, productImg.primary, 'primary', 0);
      let so = 1;
      for (const url of productImg.lifestyle || []) {
        if (url && url !== productImg.primary) await upsertMedia(prod.id, url, 'lifestyle', so++);
      }
      mediaN++;
    } else { noImg++; }

    // Documents (spec sheet, warranty, care, installation) → spec_pdf media,
    // rendered in the storefront PDP "Documentation" section.
    if (productImg && productImg.documents && productImg.documents.length) {
      let ds = 0;
      for (const url of productImg.documents) await upsertMedia(prod.id, url, 'spec_pdf', ds++);
      docN += productImg.documents.length;
    }

    pending.push({ collection: p.collection, plankSkuIds, mouldings: p.mouldings, color: p.color });

    const priceRange = [...new Set(p.skus.map((x) => `$${x.cost}`))].join('/');
    console.log(`  ${prod.is_new ? '+' : '~'} [${p.collection}] ${p.name} (${p.skus.length} sku) ${priceRange}/sf${productImg ? '' : '  [no photo]'}`);
  }

  // ---- Pass 2: moulding accessory products + links ----
  // Wipe existing GARRISON accessory links first so re-runs prune stale ones.
  await pool.query(`
    DELETE FROM sku_accessories WHERE accessory_sku_id IN (
      SELECT s.id FROM skus s JOIN products p ON p.id=s.product_id JOIN vendors v ON v.id=p.vendor_id
      WHERE v.code=$1 AND COALESCE(s.variant_type,'')='accessory')
  `, [catalog.vendor.code]);

  const mouldProdByCol = new Map();   // collection → product row
  const mouldSkuByInternal = new Map(); // internal_sku → sku id (global dedup)
  let mProd = 0, mSku = 0, links = 0, mImg = 0;

  for (const item of pending) {
    if (!item.mouldings || !item.mouldings.length) continue;
    let mprod = mouldProdByCol.get(item.collection);
    if (!mprod) {
      mprod = await upsertProduct(vendorId, catMould, {
        name: `${item.collection} Mouldings`, collection: `${item.collection} Mouldings`, status: 'active',
        description_short: `Color-matched hardwood mouldings for the Garrison ${item.collection} collection.`,
        description_long: `Prefinished color-matched transition mouldings (T-Moulding, Reducer, Baby Threshold, Stair Nosing) for Garrison ${item.collection} engineered hardwood floors. Sold per piece.`,
      });
      mprod.is_new ? mProd++ : 0;
      mouldProdByCol.set(item.collection, mprod);
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
        await upsertPricing(msku.id, m.cost, keystone(m.cost), 'per_unit');
        await setAttr(msku.id, 'material', 'Engineered Hardwood');
        await setAttr(msku.id, 'collection', item.collection);
        await setAttr(msku.id, 'color', item.color);
        await setAttr(msku.id, 'size', m.size);
        // Accessory pic: the moulding profile diagram from the page molding section.
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
  console.log(`Media:          ${mediaN} products with photos, ${noImg} without · ${docN} documents`);
  console.log(`Moulding products: ${mProd} new · Moulding SKUs: ${mSku} new · Accessory links: ${links} · Moulding images: ${mImg}`);
  await pool.end();
  console.log('\nDone.');
}

main().catch((e) => { console.error(e); process.exit(1); });
