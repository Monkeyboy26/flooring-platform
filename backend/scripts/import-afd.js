#!/usr/bin/env node
/**
 * Import American Flooring Distributor (AFD) — SPC rigid vinyl, glue-down LVT,
 * water-resistant laminate, acoustic wall panels, generic SPC trim, and
 * underlayment, from the "Metro Los Angeles Price List" (eff. 05/05/2025).
 * MDF baseboard / casing / crown are intentionally EXCLUDED per the store owner.
 *
 * AFD (3847 Capitol Ave, City of Industry, CA 90601 — orders@afdfloor.com) is
 * onboarded as its OWN vendor (code AFD).
 *
 * Pricing: cost = the sheet's JOB PACK price (per store owner — real small-lot buy
 * price, not the min-2-pallet Stock Price). Retail = cost x 1.6, nickel-rounded
 * (store keystone — see [[selling-conventions]]). Flooring + wall panels sold per
 * sqft by the box (sell_by 'box', price_basis 'per_sqft'); accessories + underlayment
 * sold per piece/roll (sell_by 'unit', price_basis 'per_unit').
 *
 * Each vendor item# = one product with a single field SKU (Mango/PDI model).
 * The 6 SPC trim pieces + 3 underlayment items are attached to every SPC/LVT/
 * laminate plank via sku_accessories (storefront "Matching Accessories").
 * Two product photos per color (per-color swatch as 'primary' + a second color
 * shot as 'alternate' — NOT a lifestyle scene) scraped from afdfloor.com →
 * data/afd/images.json keyed by internal_sku.
 *
 * Usage: docker compose exec api node scripts/import-afd.js
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
const DATA_DIR = process.env.AFD_DATA_DIR || path.join(__dirname, '..', 'data', 'afd');
const catalog = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'catalog.json'), 'utf8'));
let images = {};
try { images = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'images.json'), 'utf8')); }
catch { console.warn('! images.json not found — importing without photos'); }

const RETAIL_MARKUP = 1.6;
const keystone = (cost) => parseFloat((Math.round(cost * RETAIL_MARKUP / 0.05) * 0.05).toFixed(2));

// ==================== Helpers (mirror import-pdi.js) ====================
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
  const size = s.size;
  if (p.family === 'spc') {
    const short = `SPC rigid-core waterproof vinyl plank — ${size}, ${s.wear_layer} wear layer.`;
    const long = `AFD ${p.collection} ${p.name} — ${s.thickness} SPC rigid-core waterproof vinyl plank, ${size}, ` +
      `with a ${s.wear_layer} wear layer, ${s.surface_texture.toLowerCase()} and ${s.edge_type.toLowerCase()} edges. ` +
      `${s.underlayer}. ${s.installation_method} installation. 100% waterproof, FloorScore certified. ${p.sqft_box} sq ft per box.`;
    return { short, long };
  }
  if (p.family === 'lvt') {
    const short = `Glue-down luxury vinyl plank (LVT) — ${size}, ${s.wear_layer} wear layer.`;
    const long = `AFD ${p.collection} ${p.name} — ${s.thickness} glue-down luxury vinyl plank, ${size}, ` +
      `with a ${s.wear_layer} wear layer and ${s.surface_texture.toLowerCase()}. ${s.installation_method} installation. ` +
      `${p.sqft_box} sq ft per box.`;
    return { short, long };
  }
  if (p.family === 'laminate') {
    const short = `Water-resistant laminate — ${size}, ${s.abrasion_resistance} rated.`;
    const long = `AFD ${p.collection} ${p.name} — ${s.thickness} water-resistant laminate plank, ${size}. ` +
      `${s.abrasion_resistance} abrasion rating with ${s.surface_texture.toLowerCase()}. ` +
      `${s.installation_method} installation. ${p.sqft_box} sq ft per box.`;
    return { short, long };
  }
  if (p.family === 'wall_panel') {
    const short = `Acoustic slat wood wall panel — ${s.size}, sound absorbing.`;
    const long = `AFD ${p.name} acoustic slat wall panel — felt-backed wood slat, ${s.size}. ` +
      `Sound-absorbing decorative panel for feature walls and ceilings. ${s.installation_method}. ` +
      `${s.inner_quantity}, ${p.sqft_box} sq ft per box.`;
    return { short, long };
  }
  // moulding
  const short = `${p.name} — MDF, ${s.thickness} x ${s.width} x ${s.length}.`;
  const long = `AFD ${p.name} — primed MDF moulding profile, ${s.thickness} thick x ${s.width} wide x ${s.length} long. ` +
    `Item ${p.code}. Sold per piece.`;
  return { short, long };
}

// ==================== Main ====================
async function main() {
  console.log('=== American Flooring Distributor (AFD) Import ===\n');

  const vendorId = await upsertVendor(catalog.vendor);
  console.log(`Vendor: ${catalog.vendor.name} (${vendorId})\n`);

  const catCache = {};
  const catId = async (slug) => (catCache[slug] ??= await getCategoryId(slug));

  let pNew = 0, pUpd = 0, sNew = 0, sUpd = 0, mediaN = 0, noImg = 0;
  const plankSkuIds = [];   // SPC / LVT / laminate field SKUs → get accessories attached
  const accSkuIds = [];     // trim + underlayment accessory SKUs, in catalog order

  // Re-run hygiene: wipe AFD product media so the primary/alternate relabel and
  // any swapped images take effect cleanly (media upsert keys on asset_type).
  await pool.query(`
    DELETE FROM media_assets WHERE product_id IN (
      SELECT p.id FROM products p JOIN vendors v ON v.id=p.vendor_id WHERE v.code=$1)
  `, [catalog.vendor.code]);

  // Helper: import one "item = product + single field SKU" record.
  async function importItem(p, { variantSuffix, withImages }) {
    const categoryId = await catId(p.category);
    if (!categoryId) { console.warn(`! category ${p.category} not found — skipping ${p.name}`); return; }
    const { short, long } = buildDescriptions(p);
    const prod = await upsertProduct(vendorId, categoryId, {
      name: p.name, collection: p.collection, status: p.status,
      description_short: short, description_long: long,
    });
    prod.is_new ? pNew++ : pUpd++;

    const s = p.specs;
    const sku = await upsertSku(prod.id, {
      vendor_sku: p.code, internal_sku: p.internal_sku,
      variant_name: `${s.size}${variantSuffix ? ` ${variantSuffix}` : ''}`,
      sell_by: p.sell_by, status: p.status,
    });
    sku.is_new ? sNew++ : sUpd++;
    if (['spc', 'lvt', 'laminate'].includes(p.family)) plankSkuIds.push(sku.id);

    await upsertPricing(sku.id, p.cost, keystone(p.cost), p.price_basis);
    if (p.sqft_box != null) await upsertPackaging(sku.id, p.sqft_box);

    await setAttr(sku.id, 'material', p.material);
    if (p.family !== 'moulding') await setAttr(sku.id, 'color', p.name);
    await setAttr(sku.id, 'collection', p.collection);
    for (const [slug, val] of Object.entries(s)) await setAttr(sku.id, slug, val);

    if (withImages) {
      const img = images[p.internal_sku];
      if (img && img.primary) {
        await upsertMedia(prod.id, img.primary, 'primary', 0);
        // Secondary = the per-color room scene (last hero-gallery image on the
        // color's own Detail-pro page) → 'lifestyle'. 73 of 90 have one.
        if (img.lifestyle && img.lifestyle !== img.primary) await upsertMedia(prod.id, img.lifestyle, 'lifestyle', 1);
        mediaN++;
      } else { noImg++; }
      console.log(`  ${prod.is_new ? '+' : '~'} [${p.collection}] ${p.name} (${p.code}) — $${p.cost} → $${keystone(p.cost)}${img && img.primary ? '' : '  [no photo]'}`);
    } else {
      console.log(`  ${prod.is_new ? '+' : '~'} [${p.collection}] ${p.name} (${p.code}) — $${p.cost} → $${keystone(p.cost)}`);
    }
  }

  // ---- Flooring + wall panels (per-sqft, images) ----
  console.log('--- Flooring & wall panels ---');
  for (const p of catalog.products) {
    const suffix = p.family === 'wall_panel' ? 'Panel' : 'Plank';
    await importItem(p, { variantSuffix: suffix, withImages: true });
  }

  // ---- Generic SPC trim accessories (transitions-moldings, per unit) ----
  console.log('\n--- Accessories & underlayment ---');
  const unitProducts = [
    { list: catalog.accessories, category: 'transitions-moldings', collection: 'SPC Trim & Accessories', material: 'SPC' },
    { list: catalog.underlayment, category: 'underlayment', collection: 'Underlayment', material: 'Foam / Poly' },
  ];
  for (const grp of unitProducts) {
    const categoryId = await catId(grp.category);
    if (!categoryId) { console.warn(`! category ${grp.category} not found`); continue; }
    for (const it of grp.list) {
      const prod = await upsertProduct(vendorId, categoryId, {
        name: it.name, collection: grp.collection, status: 'active',
        description_short: it.desc.split('.')[0] + '.', description_long: it.desc,
      });
      prod.is_new ? pNew++ : pUpd++;
      const sku = await upsertSku(prod.id, {
        vendor_sku: it.code, internal_sku: it.code,
        variant_name: it.name, sell_by: 'unit',
        variant_type: 'accessory', accessory_label: it.name,
      });
      sku.is_new ? sNew++ : sUpd++;
      await upsertPricing(sku.id, it.cost, keystone(it.cost), 'per_unit');
      await setAttr(sku.id, 'material', grp.material);
      if (it.coverage) await setAttr(sku.id, 'roll_length', it.coverage);
      accSkuIds.push(sku.id);
      // Accessory product photo (T-mould/reducer/etc. from the site's accessory
      // strip). The 2 foam underlayments have no site photo.
      const aimg = images[it.code];
      if (aimg && aimg.primary) { await upsertMedia(prod.id, aimg.primary, 'primary', 0); mediaN++; }
      console.log(`  ${prod.is_new ? '+' : '~'} ${it.name} (${it.code}) — $${it.cost} → $${keystone(it.cost)}/ea${aimg && aimg.primary ? '' : '  [no photo]'}`);
    }
  }

  // ---- Attach accessories to every SPC / LVT / laminate plank ----
  // The 6 SPC trim pieces + 3 underlayment/moisture-barrier items are the universal
  // floating-floor add-ons AFD shows on its collection pages → surface them in the
  // storefront "Matching Accessories" section for each plank. Wipe existing AFD
  // links first so re-runs prune cleanly.
  await pool.query(`
    DELETE FROM sku_accessories WHERE accessory_sku_id IN (
      SELECT s.id FROM skus s JOIN products p ON p.id=s.product_id JOIN vendors v ON v.id=p.vendor_id
      WHERE v.code=$1 AND COALESCE(s.variant_type,'')='accessory')
  `, [catalog.vendor.code]);
  let links = 0;
  for (const parentId of plankSkuIds) {
    let so = 0;
    for (const accId of accSkuIds) { await linkAccessory(parentId, accId, so++); links++; }
  }
  console.log(`\nAccessory links: ${links} (${accSkuIds.length} accessories × ${plankSkuIds.length} planks)`);

  console.log(`\nProducts: ${pNew} new, ${pUpd} updated`);
  console.log(`SKUs:     ${sNew} new, ${sUpd} updated`);
  console.log(`Media:    ${mediaN} products with photos, ${noImg} flooring items without`);
  await pool.end();
  console.log('\nDone.');
}

main().catch(e => { console.error(e); process.exit(1); });
