#!/usr/bin/env node
/**
 * Import Pacific Direct Industries (PDI) — laminate, SPC vinyl, and engineered
 * hardwood from the "Local Stocking Dealer Pricing" price book (eff. 11/01/2025).
 *
 * PDI (2510 Malt Avenue, Commerce, CA 90040 — orders@pacificdirectindustries.com)
 * is onboarded as its OWN vendor (code PDI). Three product families:
 *   Laminate       — Poseidon / Poseidon XL / Poseidon Herringbone (waterproof, AC4)
 *   SPC vinyl      — Viva Las Vegas / Monaco Royale / Exotic Delights (20 mil, IXPE)
 *   Eng. hardwood  — Florence / Napa Valley / Manhattan / Riche / Custom (oak)
 *
 * Pricing: the price book "$ / Sf" / molding "Cost" columns are Roma's COST
 * (local stocking dealer / wholesale). Retail = cost x 1.6, nickel-rounded
 * (store keystone standard — see [[selling-conventions]]). Flooring sold per
 * sqft (by the box); moldings / treads / EVA pad / adhesive sold per piece
 * (unit). "Custom Flooring" (TZ-HH1007) is CALL FOR PRICING → imported as draft
 * with no pricing row.
 *
 * Each vendor item number = one product with a single field SKU (Mango model).
 * Moldings are modeled as one accessory product per family (transitions-moldings)
 * and attached to that family's planks via sku_accessories so they surface in the
 * storefront "Matching Accessories" section (see [[mango-onboarding]]).
 *
 * Images: scraped from pacificdirectflooring.com (Webflow) product/detail pages —
 * catalog.json built by build-pdi-catalog.js, images.json keyed by internal_sku
 * ({primary, lifestyle}). Many hardwood designs have no published page → no photo.
 *
 * Usage: docker compose exec api node scripts/import-pdi.js
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
const DATA_DIR = process.env.PDI_DATA_DIR || path.join(__dirname, '..', 'data', 'pdi');
const catalog = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'catalog.json'), 'utf8'));
let images = {};
try { images = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'images.json'), 'utf8')); }
catch { console.warn('! images.json not found — importing without photos'); }

const RETAIL_MARKUP = 1.6;
const keystone = (cost) => parseFloat((Math.round(cost * RETAIL_MARKUP / 0.05) * 0.05).toFixed(2));

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
  `, [productId, s.vendor_sku, s.internal_sku, s.variant_name || null, s.sell_by || 'sqft',
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

async function upsertPackaging(skuId, sqftBox) {
  if (sqftBox == null) return;
  await pool.query(`
    INSERT INTO packaging (sku_id, sqft_per_box) VALUES ($1,$2)
    ON CONFLICT (sku_id) DO UPDATE SET sqft_per_box=EXCLUDED.sqft_per_box
  `, [skuId, sqftBox]);
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

// ---- Description builders ----
function buildDescriptions(p) {
  const s = p.specs;
  const size = `${s.width}${s.length ? ` x ${s.length}` : ''}`;
  if (p.family === 'laminate') {
    const short = `Waterproof laminate — ${size}, ${s.thickness}, ${s.abrasion_resistance} rated${s.pattern ? `, ${s.pattern.toLowerCase()}` : ''}.`;
    const long = `PDI ${p.collection} ${p.name} — ${s.thickness} waterproof laminate plank, ${size}. ` +
      `${s.abrasion_resistance} abrasion rating with ${s.finish.toLowerCase()} edges and ${s.surface_texture}. ` +
      `${s.installation_method} installation. ${s.features}. ${p.sqft_box} sq ft per box.`;
    return { short, long };
  }
  if (p.family === 'spc') {
    const short = `SPC waterproof rigid-core vinyl plank — ${size}, ${s.thickness}, ${s.wear_layer} wear layer.`;
    const long = `PDI ${p.collection} ${p.name} — ${s.thickness} SPC rigid-core waterproof vinyl plank, ${size}, ` +
      `with a ${s.wear_layer} wear layer${s.surface_texture ? `, ${s.surface_texture}` : ''} and ${s.finish.toLowerCase()}. ` +
      `${s.underlayer}. ${s.installation_method} installation. ${s.features}. ${p.sqft_box} sq ft per box.`;
    return { short, long };
  }
  // hardwood
  const short = `Engineered ${s.species.toLowerCase()} — ${size}, ${s.thickness} thick, ${s.wear_layer} wear layer, ${s.surface_texture.toLowerCase()}.`;
  const long = `PDI ${p.collection} ${p.name} — engineered ${s.species} hardwood, ${size} planks, ` +
    `${s.thickness} thick with a ${s.wear_layer} sawn-face wear layer. ${s.surface_texture} texture${s.style ? `, ${s.style}` : ''}. ` +
    `${s.installation_method} installation. ${p.sqft_box} sq ft per box.` +
    (p.status === 'draft' ? ' Call for pricing.' : '');
  return { short, long };
}

// ==================== Main ====================
async function main() {
  console.log('=== Pacific Direct Industries (PDI) Import ===\n');

  const vendorId = await upsertVendor(catalog.vendor);
  console.log(`Vendor: ${catalog.vendor.name} (${vendorId})\n`);

  const catCache = {};
  const catId = async (slug) => (catCache[slug] ??= await getCategoryId(slug));

  let pNew = 0, pUpd = 0, sNew = 0, sUpd = 0, mediaN = 0, noImg = 0;
  const familySkuIds = { laminate: [], spc: [], hardwood: [] };
  const nine4LamSkuIds = [];   // 9.4"-wide laminate → eligible for stair treads
  const monacoSkuIds = [];     // Monaco Royale → eligible for SPC stair treads

  // ---- Flooring products ----
  for (const p of catalog.products) {
    const categoryId = await catId(p.category);
    if (!categoryId) { console.warn(`! category ${p.category} not found — skipping ${p.name}`); continue; }
    const { short, long } = buildDescriptions(p);

    const prod = await upsertProduct(vendorId, categoryId, {
      name: p.name, collection: p.collection, status: p.status,
      description_short: short, description_long: long,
    });
    prod.is_new ? pNew++ : pUpd++;

    const s = p.specs;
    const sku = await upsertSku(prod.id, {
      vendor_sku: p.code, internal_sku: p.internal_sku,
      variant_name: `${s.width}${s.length ? ` x ${s.length}` : ''} Plank`,
      // sell_by 'box' (not 'sqft') → storefront coverage calc rounds UP to whole
      // cartons (flooring ships by the box). 'sqft' routes to a charge-by-the-foot
      // calc. price_basis stays per_sqft (price shown /sqft). Store-wide convention.
      sell_by: 'box', status: p.status,
    });
    sku.is_new ? sNew++ : sUpd++;
    familySkuIds[p.family].push(sku.id);
    if (p.family === 'laminate' && s.width === '9.4 in') nine4LamSkuIds.push(sku.id);
    if (p.collection === 'Monaco Royale') monacoSkuIds.push(sku.id);

    if (p.cost != null) await upsertPricing(sku.id, p.cost, keystone(p.cost), 'per_sqft');
    await upsertPackaging(sku.id, p.sqft_box);

    await setAttr(sku.id, 'material', p.material);
    await setAttr(sku.id, 'color', p.name);
    await setAttr(sku.id, 'collection', p.collection);
    await setAttr(sku.id, 'size', `${s.width}${s.length ? ` x ${s.length}` : ''}`);
    for (const [slug, val] of Object.entries(s)) await setAttr(sku.id, slug, val);

    // Media: primary swatch + optional lifestyle scene (vendor page order)
    const img = images[p.internal_sku];
    if (img && img.primary) {
      await upsertMedia(prod.id, img.primary, 'primary', 0);
      if (img.lifestyle && img.lifestyle !== img.primary) await upsertMedia(prod.id, img.lifestyle, 'lifestyle', 1);
      mediaN++;
    } else { noImg++; }

    const priceStr = p.cost != null ? `$${p.cost} → $${keystone(p.cost)}/sf` : 'CALL FOR PRICING';
    console.log(`  ${prod.is_new ? '+' : '~'} [${p.collection}] ${p.name} (${p.code}) — ${priceStr}${img && img.primary ? '' : '  [no photo]'}`);
  }

  // ---- Accessory products (one per family) ----
  const catTrans = await catId('transitions-moldings');
  const accSkus = []; // { id, family, stairOnly } — attach rule per accessory SKU

  for (const acc of catalog.accessories) {
    const prod = await upsertProduct(vendorId, catTrans, {
      name: acc.name, collection: acc.name,
      description_short: acc.desc.split('.')[0] + '.', description_long: acc.desc,
    });
    prod.is_new ? pNew++ : pUpd++;
    console.log(`\n  ${prod.is_new ? '+' : '~'} ${acc.name} (accessory product)`);

    for (const it of acc.items) {
      const sku = await upsertSku(prod.id, {
        vendor_sku: it.code, internal_sku: `PDI-${it.code}`,
        variant_name: it.label, sell_by: 'unit',
        variant_type: 'accessory', accessory_label: it.label,
      });
      sku.is_new ? sNew++ : sUpd++;
      await upsertPricing(sku.id, it.cost, keystone(it.cost), 'per_unit');
      await setAttr(sku.id, 'material', catalog.products.find(p => p.family === acc.family)?.material || null);

      accSkus.push({ id: sku.id, family: acc.family, stairOnly: !!it.stairOnly });
      console.log(`    ${sku.is_new ? '+' : '~'} ${it.label} — $${it.cost} → $${keystone(it.cost)}/ea`);
    }
  }

  // ---- Attach accessories to eligible planks ----
  // Stair items (Square Nose, Flush Stair Nose, Flush Square Edged Stair Nose,
  // Stair Treads) go only on stair-capable lines: 9.4" laminate, Monaco Royale
  // SPC, all hardwood. Everything else attaches to the whole material family.
  // Wipe existing PDI accessory links first so re-runs prune stale attachments.
  await pool.query(`
    DELETE FROM sku_accessories WHERE accessory_sku_id IN (
      SELECT s.id FROM skus s JOIN products p ON p.id=s.product_id JOIN vendors v ON v.id=p.vendor_id
      WHERE v.code=$1 AND COALESCE(s.variant_type,'')='accessory')
  `, [catalog.vendor.code]);

  const eligibleParents = ({ family, stairOnly }) => {
    if (!stairOnly) return familySkuIds[family];
    if (family === 'laminate') return nine4LamSkuIds;   // 9.4"-wide planks only
    if (family === 'spc') return monacoSkuIds;           // Monaco Royale only
    return familySkuIds[family];                          // hardwood: all
  };

  // Iterate per plank so sort_order follows the catalog's accessory order.
  const allPlanks = [...familySkuIds.laminate, ...familySkuIds.spc, ...familySkuIds.hardwood];
  let links = 0;
  for (const parentId of allPlanks) {
    let so = 0;
    for (const acc of accSkus) {
      if (eligibleParents(acc).includes(parentId)) { await linkAccessory(parentId, acc.id, so++); links++; }
    }
  }

  console.log(`\nProducts: ${pNew} new, ${pUpd} updated`);
  console.log(`SKUs:     ${sNew} new, ${sUpd} updated`);
  console.log(`Media:    ${mediaN} products with photos, ${noImg} without`);
  console.log(`Accessory links: ${links}`);
  await pool.end();
  console.log('\nDone.');
}

main().catch(e => { console.error(e); process.exit(1); });
