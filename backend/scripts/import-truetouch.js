#!/usr/bin/env node
/**
 * Import TrueTouch "Evolv" — MonoTech 100% waterproof engineered real-wood plank,
 * sourced through Tri-West. Onboarded as a new brand **TrueTouch** (code TTF) under
 * the Tri-West vendor. Same pattern as [[pacifico-onboarding]]/[[mizunara-onboarding]]
 * (feed line not in the 832; source = triwest-instock.json; cost = dealer sqftPrice;
 * retail via canonical upsertPricing = keystone x1.6 + covering floor + nine-ending).
 *
 * SCOPE — Evolv only. The other two TrueTouch lines in the feed are HELD:
 *   • Coast (European White Oak, TTF55xx, 14 SKUs) — the feed carries NO per-color
 *     names (color field is just "COAST COLL. 7.5\"X75'"), and retailer catalogs are
 *     an older/different lineup (French Oak, TT### SKUs) that doesn't map — naming
 *     them would be guesswork (wrong-color risk). Needs a real color list first.
 *   • Pure Pacific (TTF81xx, 10 SKUs) — no color names AND 100% out of stock.
 *   • Coast display samples (TTFCST…) — samples, skipped.
 *
 * Evolv colors come from the feed itself: each plank TTF62NN pairs with a square-nose
 * molding TTF62NN**SQN** whose `size` field embeds the color (e.g. "CLIFF-94.5\"").
 * 14 colors: Cliff, Timber, Mineral, Empire, Scout, Sierra, Spring, Big Sur, Granite,
 * Meadow, Ridge, Peak, Trail, Sunrise. 9-3/8" x 60" x 12mm, ~27.44 sf/box, cost
 * $7.68/sf. Moldings (per piece): Flush Stair Nose $49.95, Reducer $29.95, Square
 * Nose/End Cap $29.95, T-Molding $29.95, Quarter Round $19.95 — color-matched via
 * sku_accessories.
 *
 * IMAGES: none — Evolv isn't carried on any Woo/Shopify retailer and the maker's
 * Squarespace site has no per-color gallery. Ships photoless; enrich later.
 *
 * Idempotent. Usage: docker compose exec api node scripts/import-truetouch.js
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
const RETAIL_MARKUP = 1.6;

const TYPE2LABEL = {
  FSTN: 'Flush Stair Nose', QTR: 'Quarter Round', RED: 'Reducer',
  SQN: 'Square Nose / End Cap', TMD: 'T-Molding',
};

// ==================== DB helpers (mirror import-pacifico.js) ====================
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
async function linkAccessory(parentSkuId, accessorySkuId, sortOrder) {
  await pool.query(`
    INSERT INTO sku_accessories (parent_sku_id, accessory_sku_id, sort_order)
    VALUES ($1,$2,$3)
    ON CONFLICT (parent_sku_id, accessory_sku_id) DO UPDATE SET sort_order=EXCLUDED.sort_order
  `, [parentSkuId, accessorySkuId, sortOrder]);
}

// ==================== Feed parsing ====================
function loadTtf() {
  const raw = JSON.parse(fs.readFileSync(INSTOCK, 'utf8'));
  const items = Array.isArray(raw) ? raw : Object.values(raw).find(Array.isArray) || [];
  return items.filter(x => (x.itemNumber || '').toUpperCase().startsWith('TTF62'));
}

const PLANK_LONG =
  'Evolv by TrueTouch — MonoTech 100% waterproof engineered real-wood plank. ' +
  '9-3/8" (9.37") x 60" planks, 12 mm thick, built on a monolithic platform of ' +
  'solid real wood — 90% harder than oak and 30% denser than ipe. Fully ' +
  'waterproof, scratch-resistant and pet-proof, so it installs on any level of ' +
  'the home. ~27.44 sq ft per box; sold by the box. Warranty: limited lifetime ' +
  'residential (lifetime pet-proof, waterproof and scratch-resistant) plus a ' +
  '15-year limited commercial warranty.';
const PLANK_SHORT = 'MonoTech waterproof engineered real-wood plank — 9-3/8 x 60 in, 12 mm.';

// ==================== Main ====================
async function main() {
  console.log('=== TrueTouch Evolv (via Tri-West) Import ===\n');

  const vRes = await pool.query("SELECT id, name FROM vendors WHERE code = 'TW'");
  if (!vRes.rows.length) { console.error('! Tri-West vendor (code=TW) not found'); process.exit(1); }
  const vendorId = vRes.rows[0].id;
  console.log(`Vendor: ${vRes.rows[0].name} (${vendorId})`);

  const brandId = await upsertBrand('TrueTouch', 'TTF', 'https://www.truetouchfloors.com');
  await linkVendorBrand(vendorId, brandId, false);
  console.log(`Brand:  TrueTouch (${brandId})\n`);

  const catPlank = await getCategoryId('engineered-hardwood');
  const catMold = await getCategoryId('transitions-moldings');
  if (!catPlank) { console.error('! category engineered-hardwood not found'); process.exit(1); }

  const items = loadTtf();
  const planks = items.filter(x => /^TTF62\d\d$/i.test(x.itemNumber));
  const molds = items.filter(x => /^TTF62\d\d(FSTN|QTR|RED|SQN|TMD)$/i.test(x.itemNumber));
  console.log(`Feed: ${planks.length} Evolv plank SKUs, ${molds.length} molding SKUs\n`);

  // Color map from the SQN moldings (color lives in their `size` field).
  const colorByPlankNum = {};
  for (const m of molds) {
    if (!/SQN$/i.test(m.itemNumber)) continue;
    const num = m.itemNumber.slice(3, 7); // 62NN
    const color = (m.size || '').split('-')[0].trim()
      .toLowerCase().replace(/\b\w/g, c => c.toUpperCase()); // "BIG SUR" -> "Big Sur"
    if (color) colorByPlankNum[num] = color;
  }

  const stats = { pNew: 0, pUpd: 0, sNew: 0, sUpd: 0, links: 0, skipped: 0 };
  const plankSkuByNum = {};

  // ---- Plank product ----
  const prod = await upsertProduct(vendorId, brandId, catPlank, {
    name: 'Evolv', collection: 'Evolv',
    description_short: PLANK_SHORT, description_long: PLANK_LONG,
  });
  prod.is_new ? stats.pNew++ : stats.pUpd++;
  console.log(`${prod.is_new ? '+' : '~'} Evolv (${planks.length} SKUs)`);

  for (const it of planks) {
    const num = it.itemNumber.slice(3, 7);
    const color = colorByPlankNum[num];
    if (!color) { stats.skipped++; console.warn('  ? no color for plank', it.itemNumber); continue; }

    const sku = await upsertSku(prod.id, {
      vendor_sku: it.itemNumber, internal_sku: `TW-${it.itemNumber}`,
      variant_name: color, sell_by: 'box', variant_type: null,
    });
    sku.is_new ? stats.sNew++ : stats.sUpd++;
    plankSkuByNum[num] = sku.id;

    const cost = it.sqftPrice;
    if (cost) await upsertPricing(pool, sku.id, {
      cost, retail_price: +(cost * RETAIL_MARKUP).toFixed(4), price_basis: 'per_sqft',
    });
    await upsertPackaging(sku.id, it.sqftPerBox);

    await setAttr(sku.id, 'color', color);
    await setAttr(sku.id, 'size', '9-3/8 x 60 in');
    await setAttr(sku.id, 'width', '9-3/8 in');
    await setAttr(sku.id, 'length', '60 in');
    await setAttr(sku.id, 'thickness', '12 mm');
    await setAttr(sku.id, 'material', 'Engineered Hardwood');
    await setAttr(sku.id, 'construction', 'Waterproof Engineered (MonoTech)');
  }

  // ---- Molding accessory product ----
  const moldProd = await upsertProduct(vendorId, brandId, catMold, {
    name: 'Evolv Moldings', collection: 'Evolv Moldings',
    description_short: 'Color-matched transition moldings for TrueTouch Evolv waterproof wood floors. Sold per piece.',
    description_long: 'Matching flush stair nose, reducer, square nose / end cap, T-molding, and quarter round trims for TrueTouch Evolv MonoTech waterproof engineered wood. Each trim is finished to match a specific floor color. Sold per piece.',
  });
  moldProd.is_new ? stats.pNew++ : stats.pUpd++;
  console.log(`${moldProd.is_new ? '+' : '~'} Evolv Moldings (${molds.length} SKUs)`);

  const moldSkuByNum = {};
  for (const it of molds) {
    const mm = it.itemNumber.toUpperCase().match(/^TTF(62\d\d)(FSTN|QTR|RED|SQN|TMD)$/);
    if (!mm) { stats.skipped++; console.warn('  ? unparsed molding', it.itemNumber); continue; }
    const num = mm[1], type = TYPE2LABEL[mm[2]];
    const color = colorByPlankNum[num] || 'Evolv';

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
    await setAttr(sku.id, 'material', 'Engineered Hardwood');

    (moldSkuByNum[num] ||= []).push(sku.id);
  }

  // ---- Color-matched accessory links ----
  for (const [num, accIds] of Object.entries(moldSkuByNum)) {
    const parentId = plankSkuByNum[num];
    if (!parentId) continue;
    let so = 0;
    for (const accId of accIds) { await linkAccessory(parentId, accId, so++); stats.links++; }
  }

  console.log('\n── Summary ──');
  console.log(`Products: ${stats.pNew} new, ${stats.pUpd} updated`);
  console.log(`SKUs:     ${stats.sNew} new, ${stats.sUpd} updated`);
  console.log(`Accessory links: ${stats.links}`);
  if (stats.skipped) console.log(`Skipped (unparsed): ${stats.skipped}`);
  console.log('\nHELD (not imported): Coast (no color names), Pure Pacific (no names + 0 stock), display samples.');
  await pool.end();
  console.log('\nDone.');
}

main().catch(e => { console.error(e); process.exit(1); });
