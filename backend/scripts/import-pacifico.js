#!/usr/bin/env node
/**
 * Import Pacifico Grande — AHF/Hartco 10mm WPC rigid-core waterproof vinyl plank,
 * sourced through Tri-West. Onboarded under the existing **Hartco** brand (code
 * HFD) as collection "Pacifico Grande". See [[mizunara-onboarding]] for the sibling
 * pattern; same feed shape and pricing/molding/color-match logic.
 *
 * Source: backend/data/triwest-instock.json (DNav dealer-portal feed). Its
 * per-sqft "Price" is Roma's COST. Retail = canonical upsertPricing (base.js):
 * keystone 1.6x, covering floor (planks, per_sqft), nine-ending. NOT in the 832,
 * so import-triwest-832.cjs never picks it up.
 *
 * Structure:
 *   Product (lvp-plank):
 *     • Pacifico Grande — 10" x 82.5" x 10mm WPC, 30 mil wear layer, attached pad,
 *       10 colors (HFDVCG10{CC}), all in stock. cost $6.49 → retail $10.39/sf.
 *   Accessory product (transitions-moldings), per piece:
 *     • Pacifico Grande Moldings — HFDPG{CC}{TYPE}, 4 types x 10 colors = 40 SKUs
 *       (End Cap $29.95, Flush Stair Nose $44.95, Quarter Round $15.95,
 *       Reducer $29.95). Color-matched to plank SKUs via sku_accessories.
 *
 * Item-number color codes (2 letters): AS Andes Summit, BE Bald Eagle,
 * CS Chest Springs, GV Grandview, HV Harvest, KV Kirk View, ML Moondust Lane,
 * SN Stonington, SS Sunnyside, WW Windmill Wings.
 *
 * Images: optional backend/data/mizunara/../pacifico/images.json keyed by
 * internal_sku (built by build-pacifico-images.js from the Woo Store API; the
 * VCG10{CC} code embedded in each filename = our vendor_sku minus the HFD prefix).
 *
 * Idempotent. Usage: docker compose exec api node scripts/import-pacifico.js
 */

import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { upsertPricing } from '../scrapers/base.js';

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INSTOCK = path.join(__dirname, '..', 'data', 'triwest-instock.json');
const IMAGES_PATH = path.join(__dirname, '..', 'data', 'pacifico', 'images.json');

const RETAIL_MARKUP = 1.6;

const CODE2COLOR = {
  AS: 'Andes Summit', BE: 'Bald Eagle', CS: 'Chest Springs', GV: 'Grandview',
  HV: 'Harvest', KV: 'Kirk View', ML: 'Moondust Lane', SN: 'Stonington',
  SS: 'Sunnyside', WW: 'Windmill Wings',
};
const TYPE2LABEL = { EC: 'End Cap', FSN: 'Flush Stair Nose', QR: 'Quarter Round', RD: 'Reducer' };

// ==================== DB helpers (mirror import-mizunara.js) ====================
async function upsertBrand(name, code, website) {
  const r = await pool.query(`
    INSERT INTO brands (name, code, website) VALUES ($1,$2,$3)
    ON CONFLICT (code) DO UPDATE SET name=EXCLUDED.name,
      website=COALESCE(EXCLUDED.website, brands.website), updated_at=CURRENT_TIMESTAMP
    RETURNING id
  `, [name, code, website || null]);
  return r.rows[0].id;
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
  const r = await pool.query(`
    INSERT INTO products (vendor_id, brand_id, name, collection, category_id, status, description_short, description_long)
    VALUES ($1,$2,$3,$4,$5,'active',$6,$7)
    ON CONFLICT ON CONSTRAINT products_vendor_collection_name_unique DO UPDATE SET
      brand_id=EXCLUDED.brand_id, category_id=EXCLUDED.category_id, status='active',
      description_short=EXCLUDED.description_short, description_long=EXCLUDED.description_long,
      updated_at=CURRENT_TIMESTAMP
    RETURNING id, (xmax = 0) AS is_new
  `, [vendorId, brandId, p.name, p.collection, categoryId, p.description_short, p.description_long]);
  return r.rows[0];
}
async function upsertSku(productId, s) {
  const r = await pool.query(`
    INSERT INTO skus (product_id, vendor_sku, internal_sku, variant_name, sell_by, variant_type, accessory_label, status)
    VALUES ($1,$2,$3,$4,$5,$6,$7,'active')
    ON CONFLICT (internal_sku) DO UPDATE SET
      product_id=EXCLUDED.product_id, vendor_sku=EXCLUDED.vendor_sku,
      variant_name=EXCLUDED.variant_name, sell_by=EXCLUDED.sell_by,
      variant_type=EXCLUDED.variant_type, accessory_label=EXCLUDED.accessory_label,
      status='active', updated_at=CURRENT_TIMESTAMP
    RETURNING id, (xmax = 0) AS is_new
  `, [productId, s.vendor_sku, s.internal_sku, s.variant_name || null,
      s.sell_by || 'box', s.variant_type || null, s.accessory_label || null]);
  return r.rows[0];
}
async function upsertPackaging(skuId, sqftPerBox) {
  await pool.query(`
    INSERT INTO packaging (sku_id, sqft_per_box) VALUES ($1,$2)
    ON CONFLICT (sku_id) DO UPDATE SET sqft_per_box=COALESCE(EXCLUDED.sqft_per_box, packaging.sqft_per_box)
  `, [skuId, sqftPerBox || null]);
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

// ==================== Feed parsing ====================
function loadPacifico() {
  const raw = JSON.parse(fs.readFileSync(INSTOCK, 'utf8'));
  const items = Array.isArray(raw) ? raw : Object.values(raw).find(Array.isArray) || [];
  return items.filter(x => /PACIFICO/i.test(x.productName || '') && /^HFD/i.test(x.itemNumber || ''));
}

const PLANK_LONG =
  'Pacifico Grande waterproof rigid-core WPC vinyl plank by Hartco (AHF Products). ' +
  '10" x 82.5" planks, 10 mm thick with a 30 mil wear layer and an attached acoustic ' +
  'pad. 100% waterproof rigid core for install on any level of the home, with a ' +
  'realistic wood-texture surface. Sold by the box; ~22.6 sq ft per carton.';
const PLANK_SHORT = 'WPC waterproof rigid-core vinyl plank — 10 x 82.5 in, 10 mm, 30 mil wear layer.';

// ==================== Main ====================
async function main() {
  console.log('=== Pacifico Grande (Hartco / AHF via Tri-West) Import ===\n');

  const vRes = await pool.query("SELECT id, name FROM vendors WHERE code = 'TW'");
  if (!vRes.rows.length) { console.error('! Tri-West vendor (code=TW) not found'); process.exit(1); }
  const vendorId = vRes.rows[0].id;
  console.log(`Vendor: ${vRes.rows[0].name} (${vendorId})`);

  // Reuse existing Hartco brand (code HFD).
  const brandId = await upsertBrand('Hartco', 'HFD', 'https://www.hartco.com');
  await linkVendorBrand(vendorId, brandId, false);
  console.log(`Brand:  Hartco (${brandId})\n`);

  const catPlank = await getCategoryId('lvp-plank');
  const catMold = await getCategoryId('transitions-moldings');
  if (!catPlank) { console.error('! category lvp-plank not found'); process.exit(1); }

  let images = {};
  try { images = JSON.parse(fs.readFileSync(IMAGES_PATH, 'utf8')); console.log(`Images: ${Object.keys(images).length} entries\n`); }
  catch { console.warn('! no images.json — importing without photos\n'); }

  const items = loadPacifico();
  const planks = items.filter(x => /^HFDVCG10/i.test(x.itemNumber));
  const molds = items.filter(x => /^HFDPG/i.test(x.itemNumber));
  console.log(`Feed: ${planks.length} plank SKUs, ${molds.length} molding SKUs\n`);

  const stats = { pNew: 0, pUpd: 0, sNew: 0, sUpd: 0, links: 0, media: 0, skipped: 0 };
  const plankSkuByColorCode = {};

  // ---- Plank product ----
  const prod = await upsertProduct(vendorId, brandId, catPlank, {
    name: 'Pacifico Grande', collection: 'Pacifico Grande',
    description_short: PLANK_SHORT, description_long: PLANK_LONG,
  });
  prod.is_new ? stats.pNew++ : stats.pUpd++;
  console.log(`${prod.is_new ? '+' : '~'} Pacifico Grande (${planks.length} SKUs)`);
  let heroSet = false;

  for (const it of planks) {
    const code = it.itemNumber.slice(-2).toUpperCase();
    const color = CODE2COLOR[code];
    if (!color) { stats.skipped++; console.warn('  ? unknown plank color code', it.itemNumber); continue; }

    const sku = await upsertSku(prod.id, {
      vendor_sku: it.itemNumber, internal_sku: `TW-${it.itemNumber}`,
      variant_name: color, sell_by: 'box', variant_type: null,
    });
    sku.is_new ? stats.sNew++ : stats.sUpd++;
    plankSkuByColorCode[code] = sku.id;

    const cost = it.sqftPrice;
    if (cost) await upsertPricing(pool, sku.id, {
      cost, retail_price: +(cost * RETAIL_MARKUP).toFixed(4), price_basis: 'per_sqft',
    });
    await upsertPackaging(sku.id, it.sqftPerBox);

    await setAttr(sku.id, 'color', color);
    await setAttr(sku.id, 'size', '10 x 82.5 in');
    await setAttr(sku.id, 'width', '10 in');
    await setAttr(sku.id, 'length', '82.5 in');
    await setAttr(sku.id, 'thickness', '10 mm');
    await setAttr(sku.id, 'wear_layer', '30 mil');
    await setAttr(sku.id, 'material', 'WPC Vinyl');
    await setAttr(sku.id, 'construction', 'Rigid Core (WPC)');
    await setAttr(sku.id, 'surface_texture', 'Wood Texture');

    const img = images[`TW-${it.itemNumber}`];
    if (img && img.primary) {
      await upsertSkuMedia(prod.id, sku.id, img.primary, 'primary', 0);
      if (img.lifestyle && img.lifestyle !== img.primary) await upsertSkuMedia(prod.id, sku.id, img.lifestyle, 'lifestyle', 1);
      if (!heroSet) { await upsertMedia(prod.id, img.primary, 'primary', 0); heroSet = true; }
      stats.media++;
    }
  }

  // ---- Molding accessory product ----
  const moldProd = await upsertProduct(vendorId, brandId, catMold, {
    name: 'Pacifico Grande Moldings', collection: 'Pacifico Grande Moldings',
    description_short: 'Color-matched WPC transition moldings for Pacifico Grande vinyl plank floors. Sold per piece.',
    description_long: 'Matching end cap, flush stair nose, quarter round, and reducer trims for Pacifico Grande WPC rigid-core vinyl plank by Hartco (AHF Products). Each trim is finished to match a specific floor color. Sold per piece.',
  });
  moldProd.is_new ? stats.pNew++ : stats.pUpd++;
  console.log(`${moldProd.is_new ? '+' : '~'} Pacifico Grande Moldings (${molds.length} SKUs)`);

  const moldSkuByColorCode = {};
  for (const it of molds) {
    const m = it.itemNumber.toUpperCase().replace(/^HFDPG/, '');
    const code = m.slice(0, 2);
    const typeCode = m.slice(2);
    const color = CODE2COLOR[code];
    const type = TYPE2LABEL[typeCode];
    if (!color || !type) { stats.skipped++; console.warn('  ? unparsed molding', it.itemNumber); continue; }

    const sku = await upsertSku(moldProd.id, {
      vendor_sku: it.itemNumber, internal_sku: `TW-${it.itemNumber}`,
      variant_name: `${color} ${type}`, sell_by: 'unit', variant_type: 'accessory', accessory_label: type,
    });
    sku.is_new ? stats.sNew++ : stats.sUpd++;

    const cost = it.cartonPrice;
    if (cost) await upsertPricing(pool, sku.id, {
      cost, retail_price: +(cost * RETAIL_MARKUP).toFixed(4), price_basis: 'per_unit',
    });
    await setAttr(sku.id, 'color', color);
    await setAttr(sku.id, 'material', 'WPC Vinyl');

    (moldSkuByColorCode[code] ||= []).push(sku.id);
  }

  // ---- Color-matched accessory links ----
  for (const [code, accIds] of Object.entries(moldSkuByColorCode)) {
    const parentId = plankSkuByColorCode[code];
    if (!parentId) continue;
    let so = 0;
    for (const accId of accIds) { await linkAccessory(parentId, accId, so++); stats.links++; }
  }

  console.log('\n── Summary ──');
  console.log(`Products: ${stats.pNew} new, ${stats.pUpd} updated`);
  console.log(`SKUs:     ${stats.sNew} new, ${stats.sUpd} updated`);
  console.log(`Accessory links: ${stats.links}`);
  console.log(`Media:    ${stats.media} attached`);
  if (stats.skipped) console.log(`Skipped (unparsed): ${stats.skipped}`);
  await pool.end();
  console.log('\nDone.');
}

main().catch(e => { console.error(e); process.exit(1); });
