#!/usr/bin/env node
/**
 * Import Pink Floors — engineered hardwood distributor ("Every floor gives back.")
 *
 * Pink Floors (547 W 132nd St, Gardena, CA 90248 — info@pinkfloors.com) is
 * onboarded as its OWN vendor (code PINK, public_code 132). The name is a genuine
 * consumer brand, so it is NOT hidden. Engineered oak flooring across 5 collections:
 *   Blush Botanical — 5/8" x 9.5" x 86.6" wide plank (Natural ABCD), incl. a
 *                     narrow-width Walnut Noce at 7.5"
 *   Red Oak         — 5/8" x 9.5" random-length plank (Select red oak)
 *   Click           — 9/16" x 6.25" random-length click-lock plank
 *   Herringbone     — 5/8" x 5" x 27.5" chevron/herringbone pieces
 *   Chevron         — 5/8" x 5" x 23"
 *
 * Pricing: the "Vendor Price List PIA" $/sqft (and accessory $/length) are Roma's
 * COST. Retail = nine-ended keystone (cost x1.6, rounded to the nearest .x9 — store
 * standard, see [[nine-ending-prices]]). All costs >= $4.99 so the cost+$0.99
 * covering floor never binds. Flooring sold per box (sell_by='box' price_basis
 * 'per_sqft' → coverage calc rounds up to whole cartons); accessories per piece.
 *
 * Accessories (page 3) are made-to-order out of the flooring material, so they suit
 * every floor. Each accessory TYPE (stair nose / tread / riser / T-mold / reducer /
 * end mold) is one product with SKU variants for profile (5/8" vs 3/4") and edge
 * (round vs square, where offered); the 5-gal vapor-lock adhesive is its own
 * product. All accessory SKUs attach to ALL plank SKUs via sku_accessories so they
 * surface in the storefront "Matching Accessories" section (Mango/PDI model).
 *
 * Images: none yet (pinkfloors.com scrape is a separate follow-up pass, like Icon).
 *
 * Usage: docker compose exec api node scripts/import-pink.js
 */
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: 5432, database: 'flooring_pim', user: 'postgres', password: 'postgres',
});

const DATA_DIR = process.env.PINK_DATA_DIR || path.join(__dirname, '..', 'data', 'pink');
const catalog = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'catalog.json'), 'utf8'));
let images = {};
try { images = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'images.json'), 'utf8')); }
catch { console.warn('! images.json not found — importing without photos (run build-pink-images.js first)'); }

const RETAIL_MARKUP = 1.6;
// Nine-ended retail: cost x1.6 rounded to the nearest price ending in .x9 (store
// standard). e.g. 5.59 -> 8.944 -> 8.99; 4.99 -> 7.984 -> 7.99.
const nineEnd = (v) => parseFloat((Math.round((v - 0.09) / 0.10) * 0.10 + 0.09).toFixed(2));
const retailFor = (cost) => nineEnd(cost * RETAIL_MARKUP);

// "5/8 in" -> 0.625, "3/4 in" -> 0.75, "9/16 in" -> 0.5625 (for accessory<->plank matching)
const thickNum = (t) => {
  const m = String(t || '').match(/(\d+)\s*\/\s*(\d+)/);
  if (m) return +m[1] / +m[2];
  const d = parseFloat(t);
  return isNaN(d) ? null : d;
};

// PINK- prefixed internal sku from a vendor code (spaces -> dashes)
const internalSku = (code) => `PINK-${code.trim().replace(/\s+/g, '-')}`;

// ==================== Helpers ====================
async function upsertVendor(v) {
  const res = await pool.query(`
    INSERT INTO vendors (name, code, public_code, website, email, phone, address, notes, hide_public_name)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,false)
    ON CONFLICT (code) DO UPDATE SET
      name=EXCLUDED.name, public_code=COALESCE(vendors.public_code, EXCLUDED.public_code),
      website=EXCLUDED.website, email=COALESCE(EXCLUDED.email, vendors.email),
      phone=COALESCE(EXCLUDED.phone, vendors.phone), address=COALESCE(EXCLUDED.address, vendors.address),
      notes=EXCLUDED.notes, updated_at=CURRENT_TIMESTAMP
    RETURNING id
  `, [v.name, v.code, v.public_code, v.website, v.email, v.phone, v.address, v.notes]);
  return res.rows[0].id;
}

const catCache = {};
async function getCategoryId(slug) {
  if (slug in catCache) return catCache[slug];
  const r = await pool.query('SELECT id FROM categories WHERE slug=$1', [slug]);
  return (catCache[slug] = r.rows.length ? r.rows[0].id : null);
}

async function upsertProduct(vendorId, categoryId, p) {
  const res = await pool.query(`
    INSERT INTO products (vendor_id, name, collection, category_id, status, description_short, description_long)
    VALUES ($1,$2,$3,$4,'active',$5,$6)
    ON CONFLICT ON CONSTRAINT products_vendor_collection_name_unique DO UPDATE SET
      category_id=EXCLUDED.category_id, status='active',
      description_short=EXCLUDED.description_short, description_long=EXCLUDED.description_long,
      updated_at=CURRENT_TIMESTAMP
    RETURNING id, (xmax = 0) AS is_new
  `, [vendorId, p.name, p.collection, categoryId, (p.short || '').slice(0, 250), p.long || null]);
  return res.rows[0];
}

async function upsertSku(productId, s) {
  const res = await pool.query(`
    INSERT INTO skus (product_id, vendor_sku, internal_sku, variant_name, sell_by, variant_type, accessory_label, status)
    VALUES ($1,$2,$3,$4,$5,$6,$7,'active')
    ON CONFLICT (internal_sku) DO UPDATE SET
      product_id=EXCLUDED.product_id, vendor_sku=EXCLUDED.vendor_sku, variant_name=EXCLUDED.variant_name,
      sell_by=EXCLUDED.sell_by, variant_type=EXCLUDED.variant_type, accessory_label=EXCLUDED.accessory_label,
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

async function upsertPackaging(skuId, sqftBox, lbs) {
  if (sqftBox == null && lbs == null) return;
  await pool.query(`
    INSERT INTO packaging (sku_id, sqft_per_box, weight_per_box_lbs) VALUES ($1,$2,$3)
    ON CONFLICT (sku_id) DO UPDATE SET sqft_per_box=EXCLUDED.sqft_per_box, weight_per_box_lbs=EXCLUDED.weight_per_box_lbs
  `, [skuId, sqftBox, lbs]);
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
    ON CONFLICT DO NOTHING
  `, [productId, assetType, url, sortOrder]);
}

async function linkAccessory(parentSkuId, accessorySkuId, sortOrder) {
  await pool.query(`
    INSERT INTO sku_accessories (parent_sku_id, accessory_sku_id, sort_order)
    VALUES ($1,$2,$3)
    ON CONFLICT (parent_sku_id, accessory_sku_id) DO UPDATE SET sort_order=EXCLUDED.sort_order
  `, [parentSkuId, accessorySkuId, sortOrder]);
}

// ---- Description builder for flooring ----
function buildFloorDesc(p, c, size, width) {
  const patt = c.pattern ? `${c.pattern.toLowerCase()} ` : '';
  const short = `Engineered ${c.species.toLowerCase()} ${patt}flooring — ${size}, ${c.wear_layer} wear layer, ${c.grade} grade.`;
  const long = `Pink Floors ${p.collection} — ${p.name}. Engineered ${c.species} hardwood ` +
    `${c.pattern ? c.pattern.toLowerCase() + ' ' : ''}flooring, ${size} with a ${c.wear_layer} sawn-face ` +
    `wear layer over a ${c.thickness} engineered core. ${c.grade} grade, ${c.install.toLowerCase()} installation. ` +
    `${p.sqft_box} sq ft per box. "Every floor gives back."`;
  return { short, long };
}

// ==================== Main ====================
async function main() {
  console.log('=== Pink Floors Import ===\n');

  const vendorId = await upsertVendor(catalog.vendor);
  console.log(`Vendor: ${catalog.vendor.name} (${vendorId}) — public code ${catalog.vendor.public_code}\n`);

  const hardwoodCat = await getCategoryId('engineered-hardwood');
  if (!hardwoodCat) throw new Error('engineered-hardwood category missing');

  let pNew = 0, pUpd = 0, sNew = 0, sUpd = 0, mediaN = 0, noImg = 0;
  const planks = [];  // { id, thick } — thick drives accessory matching

  // ---- Flooring ----
  for (const p of catalog.products) {
    const c = catalog.collections[p.collection];
    const size = p.size || c.size;
    const width = p.width || c.width;
    const { short, long } = buildFloorDesc(p, c, size, width);

    const prod = await upsertProduct(vendorId, hardwoodCat, {
      name: p.name, collection: p.collection, short, long,
    });
    prod.is_new ? pNew++ : pUpd++;

    const sku = await upsertSku(prod.id, {
      vendor_sku: p.vendor_sku, internal_sku: internalSku(p.vendor_sku),
      variant_name: `${width} Plank`, sell_by: 'box',
    });
    sku.is_new ? sNew++ : sUpd++;
    planks.push({ id: sku.id, thick: thickNum(c.thickness) });

    const retail = retailFor(p.cost);
    await upsertPricing(sku.id, p.cost, retail, 'per_sqft');
    await upsertPackaging(sku.id, p.sqft_box, p.lbs_ctn);

    await setAttr(sku.id, 'material', 'Engineered Hardwood');
    await setAttr(sku.id, 'species', c.species);
    await setAttr(sku.id, 'color', p.color);
    await setAttr(sku.id, 'collection', p.collection);
    await setAttr(sku.id, 'construction', 'Engineered');
    await setAttr(sku.id, 'size', size);
    await setAttr(sku.id, 'width', width);
    await setAttr(sku.id, 'length', p.length || c.length);
    await setAttr(sku.id, 'thickness', c.thickness);
    await setAttr(sku.id, 'wear_layer', c.wear_layer);
    await setAttr(sku.id, 'grade', c.grade);
    await setAttr(sku.id, 'installation_method', c.install);
    if (c.pattern) await setAttr(sku.id, 'features', `${c.pattern} pattern`);

    const img = images[internalSku(p.vendor_sku)];
    if (img && img.primary) { await upsertMedia(prod.id, img.primary, 'primary', 0); mediaN++; }
    else noImg++;

    console.log(`  ${prod.is_new ? '+' : '~'} [${p.collection}] ${p.name} (${p.vendor_sku}) — $${p.cost} → $${retail}/sf${img && img.primary ? '' : '  [no photo]'}`);
  }

  // ---- Accessories (one product per type, SKU variants for profile/edge) ----
  const accSkus = [];  // { id, thick, universal } — thick/universal drive plank matching
  for (const acc of catalog.accessories) {
    const catId = await getCategoryId(acc.category);
    if (!catId) { console.warn(`! category ${acc.category} not found — skipping ${acc.product_name}`); continue; }

    const prod = await upsertProduct(vendorId, catId, {
      name: acc.product_name, collection: acc.product_name,
      short: acc.description.split('.')[0] + '.', long: acc.description,
    });
    prod.is_new ? pNew++ : pUpd++;
    console.log(`\n  ${prod.is_new ? '+' : '~'} ${acc.product_name} (accessory)`);

    let vi = 0;
    for (const it of acc.items) {
      const code = `${acc.product_name.replace(/[^A-Za-z0-9]+/g, '-')}-${vi++}`;
      const sku = await upsertSku(prod.id, {
        vendor_sku: code, internal_sku: internalSku(code),
        variant_name: it.label, sell_by: 'unit',
        variant_type: 'accessory', accessory_label: `${acc.product_name.replace(/^Pink Floors /, '')} — ${it.label}`,
      });
      sku.is_new ? sNew++ : sUpd++;
      const retail = retailFor(it.cost);
      await upsertPricing(sku.id, it.cost, retail, 'per_unit');
      await setAttr(sku.id, 'material', 'Engineered Hardwood');
      if (it.thickness) await setAttr(sku.id, 'thickness', it.thickness);
      accSkus.push({ id: sku.id, thick: thickNum(it.thickness), universal: !!acc.universal });
      console.log(`    ${sku.is_new ? '+' : '~'} ${it.label} — $${it.cost} → $${retail}/ea`);
    }
  }

  // ---- Attach accessories to planks by matching profile thickness ----
  // A molding's profile thickness must finish flush with the floor. Pink Floors
  // pairs each floor thickness with a profile thickness via catalog's
  // accessory_profile_by_floor_thickness: 5/8" floors -> 5/8" profiles, and the
  // 9/16" Click line -> the 3/4" profiles (per vendor). The vapor-lock adhesive
  // (universal, no thickness) attaches to every floor. Any unmapped thickness
  // falls back to the nearest stocked profile.
  // Wipe existing PINK accessory links first so re-runs prune stale attachments.
  await pool.query(`
    DELETE FROM sku_accessories WHERE accessory_sku_id IN (
      SELECT s.id FROM skus s JOIN products p ON p.id=s.product_id JOIN vendors v ON v.id=p.vendor_id
      WHERE v.code='PINK' AND COALESCE(s.variant_type,'')='accessory')
  `);
  const profileMap = new Map(
    Object.entries(catalog.accessory_profile_by_floor_thickness || {}).map(([f, prof]) => [thickNum(f), thickNum(prof)])
  );
  const stockedThicks = [...new Set(accSkus.filter(a => a.thick != null).map(a => a.thick))];
  const targetThick = (plankThick) => profileMap.get(plankThick)
    ?? (stockedThicks.includes(plankThick)
      ? plankThick
      : stockedThicks.reduce((best, t) => Math.abs(t - plankThick) < Math.abs(best - plankThick) ? t : best, stockedThicks[0]));

  let links = 0;
  for (const plank of planks) {
    const tgt = targetThick(plank.thick);
    let so = 0;
    for (const acc of accSkus) {
      if (acc.universal || acc.thick === tgt) { await linkAccessory(plank.id, acc.id, so++); links++; }
    }
  }

  console.log(`\nProducts: ${pNew} new, ${pUpd} updated`);
  console.log(`SKUs:     ${sNew} new, ${sUpd} updated`);
  console.log(`Media:    ${mediaN} planks with a photo, ${noImg} without`);
  console.log(`Accessory links: ${links} (thickness-matched across ${accSkus.length} accessories × ${planks.length} planks)`);
  await pool.end();
  console.log('\nDone.');
}

main().catch(e => { console.error(e); process.exit(1); });
