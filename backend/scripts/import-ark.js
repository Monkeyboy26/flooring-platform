#!/usr/bin/env node
/**
 * Import the ARK Floors engineered + solid hardwood catalog (vendor ARK —
 * ark-floors.com, wholesale distributor/manufacturer in S. El Monte, CA).
 *
 * Source: backend/data/ark/catalog.json (built by build-ark-catalog.js from the
 * Q2-2026 Preferred + Close-Out price lists) and images.json (scraped from the
 * WooCommerce site, keyed by ARK item number).
 *
 * Pricing: Preferred sheet cost = Roma COST; retail = cost x1.6 nickel keystone
 * (store standard — see [[selling-conventions]], [[garrison-onboarding]]).
 * Flooring is sold per sqft, by the box (sell_by 'box'; price_basis per_sqft).
 *
 * Products split by construction: Engineered → engineered-hardwood category,
 * Solid → solid-hardwood. Same-color rows differing only by width / wear layer
 * are size-variant SKUs of one product.
 *
 * Moldings: two color-matched sets priced by base wood (A Oak/Maple, B Brazilian
 * Cherry). Each set is created once as a "{Set} Transition Moldings" product with
 * 5 per-piece accessory SKUs (QR/RD/TM/EC/SN) and attached via sku_accessories to
 * every floor whose species maps to that set, so they surface in the storefront
 * "Matching Accessories" section (see [[line-item-display]], [[garrison-onboarding]]).
 *
 * Usage: docker compose exec api node scripts/import-ark.js
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
const DATA_DIR = process.env.ARK_DATA_DIR || path.join(__dirname, '..', 'data', 'ark');
const catalog = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'catalog.json'), 'utf8'));
let images = {};
try { images = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'images.json'), 'utf8')); }
catch { console.warn('! images.json not found — importing without photos'); }

const RETAIL_MARKUP = 1.6;
const keystone = (cost) => parseFloat((Math.round(cost * RETAIL_MARKUP / 0.05) * 0.05).toFixed(2));
const slugify = (s) => s.toLowerCase().replace(/\([^)]*\)/g, '').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
const baseColorName = (name) => name.replace(/\s*\(Solid\)\s*$/, '').trim();

// Normalize an item code / internal_sku to the key form used in images.json
// (uppercase, no ARK- prefix). Returns the progressively-trimmed candidate list
// so a plain-natural variant (…-N) or 3mm variant (…-3M) falls back to the base
// product page photo when it shares a page.
function imageCandidates(internalSku) {
  const base = internalSku.replace(/^ARK-/i, '').toUpperCase();
  const cands = [base];
  if (base.endsWith('-N-3M')) cands.push(base.replace(/-N-3M$/, '-N'), base.replace(/-N-3M$/, ''));
  if (base.endsWith('-3M')) cands.push(base.replace(/-3M$/, ''));
  if (base.endsWith('-N')) cands.push(base.replace(/-N$/, ''));
  if (base.endsWith('-L')) cands.push(base.replace(/-L$/, ''));
  return cands;
}
function findImage(skus) {
  for (const s of skus) {
    for (const key of imageCandidates(s.internal_sku)) {
      if (images[key] && (images[key].primary || (images[key].alternate || []).length)) return images[key];
    }
  }
  return null;
}
function findDescription(skus) {
  for (const s of skus) {
    for (const key of imageCandidates(s.internal_sku)) {
      if (images[key] && images[key].description) return images[key].description;
    }
  }
  return null;
}

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

async function getCategoryId(slug) {
  const r = await pool.query('SELECT id FROM categories WHERE slug=$1', [slug]);
  return r.rows.length ? r.rows[0].id : null;
}

async function upsertProduct(vendorId, categoryId, p) {
  const res = await pool.query(`
    INSERT INTO products (vendor_id, name, collection, category_id, status, description_short, description_long, format_group, format_label)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    ON CONFLICT ON CONSTRAINT products_vendor_collection_name_unique DO UPDATE SET
      category_id=EXCLUDED.category_id, status=EXCLUDED.status,
      description_short=EXCLUDED.description_short, description_long=EXCLUDED.description_long,
      format_group=EXCLUDED.format_group, format_label=EXCLUDED.format_label,
      updated_at=CURRENT_TIMESTAMP
    RETURNING id, (xmax = 0) AS is_new
  `, [vendorId, p.name, p.collection, categoryId, p.status || 'active', p.description_short, p.description_long,
      p.format_group || null, p.format_label || null]);
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
function buildDescriptions(p, scraped) {
  const s = p.skus[0];
  const sizes = [...new Set(p.skus.map((x) => x.width).filter(Boolean))];
  const widths = sizes.length ? sizes.join(' / ') : s.width;
  const constr = p.construction;
  const tex = p.surface_texture ? `${p.surface_texture.toLowerCase()}, ` : '';
  const wl = s.wear_layer ? `${s.wear_layer} wear layer, ` : '';
  const short = `${constr} ${p.species.replace(/\s*\(.*\)/, '')} hardwood — ${s.thickness} x ${widths}${p.skus.length > 1 ? ' (multiple widths)' : ''}, ${tex}${wl}${p.color.toLowerCase()}.`;
  const parts = [
    `ARK Floors ${p.collection} Collection — ${p.name.replace(/ \(Solid\)$/, '')}, ${constr.toLowerCase()} ${p.species} hardwood.`,
    `${s.thickness} thick${s.wear_layer ? ` with a ${s.wear_layer} real-wood wear layer` : ''}, ${widths} wide, ${s.length ? `${s.length} random lengths.` : 'random lengths.'}`,
    p.surface_texture ? `${p.surface_texture} surface. ` : '',
    p.molding_set ? `Color-matched transition moldings available.` : '',
    p.closeout ? ' Close-out pricing — while supplies last; final sale, no returns or exchanges.' : '',
    p.discontinued ? ' Discontinued — final sale, no returns or exchanges.' : '',
  ];
  let long = parts.join(' ').replace(/\s+/g, ' ').trim();
  if (scraped) long = `${scraped.trim()} ${long}`.replace(/\s+/g, ' ').trim();
  return { short, long };
}

async function setPlankAttrs(skuId, p, s) {
  await setAttr(skuId, 'material', p.material);
  await setAttr(skuId, 'color', p.color);
  await setAttr(skuId, 'collection', p.collection);
  await setAttr(skuId, 'species', p.species);
  await setAttr(skuId, 'construction', p.construction);
  await setAttr(skuId, 'surface_texture', p.surface_texture);
  await setAttr(skuId, 'finish', p.surface_texture);
  await setAttr(skuId, 'size', s.size);
  await setAttr(skuId, 'thickness', s.thickness);
  await setAttr(skuId, 'width', s.width);
  await setAttr(skuId, 'length', s.length);
  await setAttr(skuId, 'wear_layer', s.wear_layer);
}

// ==================== Main ====================
async function main() {
  console.log('=== ARK Floors Import ===\n');
  const vendorId = await upsertVendor(catalog.vendor);
  console.log(`Vendor: ${catalog.vendor.name} (${vendorId})\n`);

  const catEng = await getCategoryId('engineered-hardwood');
  const catSolid = await getCategoryId('solid-hardwood');
  const catMould = await getCategoryId('transitions-moldings');
  if (!catEng || !catSolid || !catMould) throw new Error('required category missing (engineered-hardwood / solid-hardwood / transitions-moldings)');
  const CAT = { 'engineered-hardwood': catEng, 'solid-hardwood': catSolid };

  // All ARK photos are stored as product-level 'primary' gallery images; wipe
  // existing ARK product media first so re-runs don't leave stale alternate/
  // lifestyle rows behind.
  await pool.query(`
    DELETE FROM media_assets WHERE sku_id IS NULL AND product_id IN (
      SELECT p.id FROM products p JOIN vendors v ON v.id=p.vendor_id WHERE v.code=$1)
  `, [catalog.vendor.code]);

  let pNew = 0, pUpd = 0, sNew = 0, sUpd = 0, mediaN = 0, noImg = 0;
  // Color-matched moldings are per floor COLOR (species+color), so the accessory
  // names the parent floor (e.g. "Quarter Round — Genuine Mahogany Sable") instead
  // of the molding's base wood. Both the engineered and solid product of a color
  // share one molding group. key = species||color → { colorName, setKey, floorSkuIds }.
  const colorGroups = new Map();

  // ---- Pass 1: floor products ----
  for (const p of catalog.products) {
    const scraped = findDescription(p.skus);
    const { short, long } = buildDescriptions(p, scraped);
    const prod = await upsertProduct(vendorId, CAT[p.category], {
      name: p.name, collection: p.collection, status: p.status,
      description_short: short, description_long: long,
      format_group: p.format_group, format_label: p.format_label,
    });
    prod.is_new ? pNew++ : pUpd++;

    let grp = null;
    if (p.molding_set) {
      const ckey = `${p.species}||${p.color}`;
      grp = colorGroups.get(ckey);
      if (!grp) { grp = { colorName: baseColorName(p.name), setKey: p.molding_set, floorSkuIds: [] }; colorGroups.set(ckey, grp); }
    }

    for (const s of p.skus) {
      const sku = await upsertSku(prod.id, {
        vendor_sku: s.vendor_sku, internal_sku: s.internal_sku,
        variant_name: s.variant_name, sell_by: 'box', status: s.status,
      });
      sku.is_new ? sNew++ : sUpd++;
      await upsertPricing(sku.id, s.cost, keystone(s.cost), 'per_sqft');
      await upsertPackaging(sku.id, s.sqft_box, s.lbs_box, s.box_per_pallet);
      await setPlankAttrs(sku.id, p, s);
      if (grp) grp.floorSkuIds.push(sku.id);
    }

    // Media: every scraped photo is stored as a product-level 'primary' gallery
    // image (per request — all ARK photos are product primary), deduped, ordered
    // primary → alternates → lifestyle.
    const img = findImage(p.skus);
    const seen = new Set();
    const urls = img ? [img.primary, ...(img.alternate || []), ...(img.lifestyle || [])]
      .filter((u) => u && !seen.has(u) && seen.add(u)) : [];
    if (urls.length) {
      let so = 0;
      for (const url of urls) await upsertMedia(prod.id, url, 'primary', so++);
      mediaN++;
    } else { noImg++; }

    const flag = p.discontinued ? ' [disc/draft]' : p.closeout ? ' [closeout]' : '';
    console.log(`  ${prod.is_new ? '+' : '~'} [${p.collection}/${p.construction[0]}] ${p.name} (${p.skus.length} sku) $${p.skus[0].cost}/sf${img ? '' : '  [no photo]'}${flag}`);
  }

  // ---- Pass 2: per-color molding accessories + links ----
  // Wipe ALL existing ARK accessory SKUs (+ their dependents) first, so re-runs
  // prune stale rows and a scheme change (per-set → per-color) doesn't orphan the
  // old generic SKUs. sku_accessories cascades on sku delete; pricing / attrs /
  // media / packaging / cart_items do not, so remove those explicitly.
  const oldAcc = await pool.query(`
    SELECT s.id FROM skus s JOIN products p ON p.id=s.product_id JOIN vendors v ON v.id=p.vendor_id
    WHERE v.code=$1 AND COALESCE(s.variant_type,'')='accessory'
  `, [catalog.vendor.code]);
  const oldIds = oldAcc.rows.map((r) => r.id);
  if (oldIds.length) {
    for (const tbl of ['cart_items', 'sku_attributes', 'pricing', 'packaging', 'media_assets']) {
      await pool.query(`DELETE FROM ${tbl} WHERE sku_id = ANY($1)`, [oldIds]);
    }
    await pool.query(`DELETE FROM skus WHERE id = ANY($1)`, [oldIds]); // sku_accessories cascades
  }

  // Two base-wood molding container products (per set); per-color SKUs live inside.
  const mprodBySet = {};
  let mProd = 0, mSku = 0, links = 0;
  for (const key of ['A', 'B']) {
    const set = catalog.molding_sets[key];
    const mprod = await upsertProduct(vendorId, catMould, {
      name: `${set.name} Transition Moldings`, collection: `${set.name} Moldings`, status: 'active',
      description_short: `Custom color-matched ${set.base_wood.toLowerCase()} transition moldings — quarter round, reducer, T-molding, end cap & stair nose. Sold per 96" piece.`,
      description_long: `ARK Floors custom prefinished transition moldings milled from ${set.base_wood.toLowerCase()}, color-matched per floor to ${set.matches}. Available profiles: Quarter Round, Flush Reducer, T-Molding, End Cap (Threshold) and Flush Stair Nose. Each 96" piece is sold individually (produced to order, 5–10 business day lead time).`,
    });
    mprod.is_new ? mProd++ : 0;
    mprodBySet[key] = mprod;
  }

  // One matched molding set per floor color, labelled to the parent floor.
  for (const grp of colorGroups.values()) {
    const set = catalog.molding_sets[grp.setKey];
    const mprod = mprodBySet[grp.setKey];
    const cslug = slugify(grp.colorName);
    let so = 0;
    for (const piece of set.pieces) {
      const msku = await upsertSku(mprod.id, {
        vendor_sku: `ARK-${piece.code}`, internal_sku: `ARK-${piece.code}-${cslug}`,
        variant_name: `${piece.type} — ${grp.colorName}`, sell_by: 'unit',
        variant_type: 'accessory', accessory_label: `${piece.type} — ${grp.colorName}`, status: 'active',
      });
      msku.is_new ? mSku++ : 0;
      await upsertPricing(msku.id, piece.cost, keystone(piece.cost), 'per_unit');
      await setAttr(msku.id, 'material', grp.setKey === 'A' ? 'Solid Oak / Maple' : 'Solid Brazilian Cherry');
      await setAttr(msku.id, 'collection', `${set.name} Moldings`);
      // No 'color' attr on purpose: the storefront accessory query filters by
      // matching the parent's color attr (floor color is just "Sable", not the
      // full "Genuine Mahogany Sable"), so a color attr here would hide it. The
      // accessory_label already names the matched floor, and each molding is
      // linked only to its own color's floors.
      await setAttr(msku.id, 'size', `${piece.width} x 96"`);
      await setAttr(msku.id, 'width', piece.width);
      await setAttr(msku.id, 'length', '96"');
      for (const parentId of grp.floorSkuIds) { await linkAccessory(parentId, msku.id, so); links++; }
      so++;
    }
  }
  console.log(`  molding colors: ${colorGroups.size} → ${mSku} matched molding SKUs, ${links} accessory links`);

  console.log(`\nFloor products: ${pNew} new, ${pUpd} updated`);
  console.log(`Floor SKUs:     ${sNew} new, ${sUpd} updated`);
  console.log(`Media:          ${mediaN} products with photos, ${noImg} without`);
  console.log(`Molding products: ${mProd} new · Molding SKUs: ${mSku} new · Accessory links: ${links}`);
  await pool.end();
  console.log('\nDone.');
}

main().catch((e) => { console.error(e); process.exit(1); });
