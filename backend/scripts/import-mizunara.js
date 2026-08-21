#!/usr/bin/env node
/**
 * Import Mizunara — AHF Products' Japanese White Oak engineered hardwood, sourced
 * through Tri-West (made by TMBR / AHF, tmbrflooring.com). Onboarded as a BRAND
 * ("Mizunara", code MIZUNARA) under the existing Tri-West vendor (code TW).
 * See [[vendor-sub-brands]].
 *
 * Source data: backend/data/triwest-instock.json (the Tri-West DNav dealer-portal
 * feed scraped by triwest-search.js). Its per-sqft/per-carton "Price" column is
 * Roma's COST (dealer pricing). Retail = canonical upsertPricing (base.js): keystone
 * 1.6x, then the covering margin floor (planks, per_sqft) and nine-ending charm
 * pricing. See [[nine-ending-prices]], [[covering-margin-floor]].
 *
 * These SKUs are NOT in the Tri-West EDI 832 catalog (different item-number scheme:
 * AHFEK7MW…, AHFEK…CR…, SUM…), so import-triwest-832.cjs never picks them up — this
 * dedicated importer reads the instock feed directly.
 *
 * Structure:
 *   Products (engineered-hardwood):
 *     • Mizunara Woods              — 7.5", 10 colors (AHFEK7MW…)
 *     • Mizunara Coastal Rift       — 5" + 3.5" straight, rift & quartered, 6 colors
 *     • Mizunara Coastal Rift Herringbone — 3.5" HB blocks, 6 colors
 *   Accessory products (transitions-moldings), sold per piece:
 *     • Mizunara Woods Moldings         — SUMAUMZ… (10 colors × 5 types = 50)
 *     • Mizunara Coastal Rift Moldings  — SUMMZCR… (6 colors × 5 types = 30)
 *   Moldings are color-matched to their plank SKUs via sku_accessories so the
 *   storefront "Matching Accessories" section shows same-color trim only.
 *
 * Woods specs (TMBR sell sheet): Japanese White Oak, 9/16" w/ 3mm sawn veneer
 * (9-ply), wire-brushed, low gloss, micro-beveled edges/ends, Urethane w/ AlOx,
 * Janka 2680, HydroPel 6-sided waterproof, 23.48 sf/carton, 50yr res / 10yr comm.
 * Coastal Rift is a new AHF (NWFA 2026) rift-&-quartered line with no public sell
 * sheet yet — only the shared/known specs are set; thickness/veneer left unset.
 *
 * Images: optional backend/data/mizunara/images.json ({ "<color>": {primary,
 * lifestyle} }); ships without photos if absent (enrich later).
 *
 * Idempotent — safe to re-run.
 * Usage: docker compose exec api node scripts/import-mizunara.js
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
const IMAGES_PATH = path.join(__dirname, '..', 'data', 'mizunara', 'images.json');

const RETAIL_MARKUP = 1.6;

// ---- Color-token → proper name (Japanese whisky-distillery names) ----
const titleColor = (tok) =>
  tok.charAt(0).toUpperCase() + tok.slice(1).toLowerCase();

const WOOD_COLORS = ['AKKESHI', 'CHICHIBU', 'HAKASHU', 'ICHIRO', 'KARUIZAWA',
  'NIKKA', 'SABUROMARU', 'SHIRIKAWA', 'SHIZUOKA', 'SUNTORY'];
const CR_COLORS = ['HIKARI', 'KIRI', 'KUMO', 'SUMI', 'SUNA', 'YUKI'];
const ALL_COLORS = [...WOOD_COLORS, ...CR_COLORS];

// ==================== DB helpers ====================
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

// Per-SKU media (color-specific swatch/room). Uses the sku-scoped unique index.
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
function loadMizunara() {
  const raw = JSON.parse(fs.readFileSync(INSTOCK, 'utf8'));
  const items = Array.isArray(raw) ? raw : Object.values(raw).find(Array.isArray) || [];
  return items.filter(x =>
    (x.itemNumber || '').match(/^(AHFEK\dMW|AHFEK\dCR|SUMAUMZ|SUMMZCR)/i) ||
    /MIZUNARA/i.test(x.productName || ''));
}

// Classify a plank item → { productKey, size, colorTok }
function classifyPlank(it) {
  const n = (it.itemNumber || '').toUpperCase();
  const colorTok = (it.pattern || '').split('-')[0].trim().toUpperCase();
  if (/^AHFEK\dMW/.test(n)) return { productKey: 'woods', size: '7.5"', colorTok };
  if (/^AHFEK5CR/.test(n)) return { productKey: 'coastal-rift', size: '5"', colorTok };
  if (/^AHFEK3CR7/.test(n)) return { productKey: 'coastal-rift-hb', size: '3.5"', colorTok };
  if (/^AHFEK3CR8/.test(n)) return { productKey: 'coastal-rift', size: '3.5"', colorTok };
  return null;
}

// Parse a molding item → { family: 'wood'|'cr', colorTok, type }
function parseMolding(it) {
  const n = (it.itemNumber || '').toUpperCase();
  const family = n.startsWith('SUMMZCR') ? 'cr' : n.startsWith('SUMAUMZ') ? 'wood' : null;
  if (!family) return null;
  const r = (it.rawDescription || '').toUpperCase();
  let type = null;
  if (r.includes('STAIR')) type = 'Stair Nose';
  else if (r.includes('QUARTER') || r.includes('QTR')) type = 'Quarter Round';
  else if (r.includes('REDUCER')) type = 'Reducer';
  else if (r.includes('T-MOLD') || r.includes('TMOLD')) type = 'T-Molding';
  else if (r.includes('THRESHOLD')) type = 'Threshold';
  const pool_ = family === 'cr' ? CR_COLORS : WOOD_COLORS;
  const colorTok = pool_.find(c => r.includes(c)) || null;
  if (!type || !colorTok) return null;
  return { family, colorTok, type };
}

const sizeAttr = (size) => size.replace(/"/, ' in'); // '7.5"' → '7.5 in'

// ==================== Product definitions ====================
const WOODS_LONG =
  'Mizunara Woods engineered hardwood by TMBR (AHF Products) — premium Japanese ' +
  'White Oak, historically prized for aging fine whisky. 7-1/2" wide planks, 9/16" ' +
  'thick with a 3.0 mm sawn face veneer over 9-ply engineered construction. ' +
  'Wire-brushed, low-gloss surface with micro-beveled edges and ends, finished in ' +
  'Maximus Urethane with Aluminum Oxide. Janka hardness 2680. HydroPel 6-sided ' +
  'waterproof technology and Cleantivity antimicrobial protection; FloorScore ' +
  'certified, NWFA member. Varying lengths 15.7"–75.6". 23.48 sq ft per carton. ' +
  '50-year limited residential / 10-year limited commercial warranty.';

const CR_LONG =
  'Mizunara Coastal Rift engineered hardwood by TMBR (AHF Products) — rift-and-' +
  'quartered Japanese White Oak with a tight, linear grain. Offered in 5" and 3.5" ' +
  'widths. Part of AHF\'s premium Mizunara program. Engineered construction for ' +
  'install on any level of the home.';

const CR_HB_LONG =
  'Mizunara Coastal Rift Herringbone by TMBR (AHF Products) — rift-and-quartered ' +
  'Japanese White Oak in 3.5" herringbone blocks for a classic angled parquet ' +
  'layout. Engineered construction.';

// ==================== Main ====================
async function main() {
  console.log('=== Mizunara (TMBR / AHF via Tri-West) Import ===\n');

  const vRes = await pool.query("SELECT id, name FROM vendors WHERE code = 'TW'");
  if (!vRes.rows.length) { console.error('! Tri-West vendor (code=TW) not found'); process.exit(1); }
  const vendorId = vRes.rows[0].id;
  console.log(`Vendor: ${vRes.rows[0].name} (${vendorId})`);

  // Brand is "Mizunara" (the collection line customers know); made by TMBR / AHF.
  const brandId = await upsertBrand('Mizunara', 'MIZUNARA', 'https://www.tmbrflooring.com');
  await linkVendorBrand(vendorId, brandId, false);
  console.log(`Brand:  Mizunara (${brandId})\n`);

  const catWood = await getCategoryId('engineered-hardwood');
  const catMold = await getCategoryId('transitions-moldings');
  if (!catWood) { console.error('! category engineered-hardwood not found'); process.exit(1); }
  if (!catMold) console.warn('! category transitions-moldings not found — moldings get null category');

  let images = {};
  try { images = JSON.parse(fs.readFileSync(IMAGES_PATH, 'utf8')); console.log(`Images: ${Object.keys(images).length} entries\n`); }
  catch { console.warn('! no images.json — importing without photos\n'); }

  const items = loadMizunara();
  const planks = items.filter(x => (x.itemNumber || '').toUpperCase().startsWith('AHF'));
  const molds  = items.filter(x => (x.itemNumber || '').toUpperCase().startsWith('SUM'));
  console.log(`Feed: ${planks.length} plank SKUs, ${molds.length} molding SKUs\n`);

  const stats = { pNew: 0, pUpd: 0, sNew: 0, sUpd: 0, links: 0, media: 0, skipped: 0 };

  // ---- Product shells for planks ----
  const PLANK_PRODUCTS = {
    'woods':           { name: 'Mizunara Woods',                    collection: 'Mizunara Woods',        long: WOODS_LONG, short: 'Engineered Japanese White Oak, 7-1/2" wide, wire-brushed, HydroPel waterproof.' },
    'coastal-rift':    { name: 'Mizunara Coastal Rift',             collection: 'Mizunara Coastal Rift', long: CR_LONG,    short: 'Rift-&-quartered engineered Japanese White Oak, 5" and 3.5" widths.' },
    'coastal-rift-hb': { name: 'Mizunara Coastal Rift Herringbone', collection: 'Mizunara Coastal Rift', long: CR_HB_LONG, short: 'Rift-&-quartered Japanese White Oak, 3.5" herringbone blocks.' },
  };

  const productIdByKey = {};
  // plankSkuByFamilyColor['wood'|'cr'][colorTok] = [skuId, ...]  (for accessory linking)
  const plankSkuByFamilyColor = { wood: {}, cr: {} };
  const heroSet = new Set(); // product ids that already have a browse-card hero

  // Group plank feed rows by product key
  const planksByKey = { woods: [], 'coastal-rift': [], 'coastal-rift-hb': [] };
  for (const it of planks) {
    const c = classifyPlank(it);
    if (!c) { stats.skipped++; console.warn('  ? unclassified plank', it.itemNumber); continue; }
    planksByKey[c.productKey].push({ it, ...c });
  }

  for (const [key, rows] of Object.entries(planksByKey)) {
    if (!rows.length) continue;
    const def = PLANK_PRODUCTS[key];
    const prod = await upsertProduct(vendorId, brandId, catWood, {
      name: def.name, collection: def.collection,
      description_short: def.short, description_long: def.long,
    });
    prod.is_new ? stats.pNew++ : stats.pUpd++;
    productIdByKey[key] = prod.id;
    console.log(`${prod.is_new ? '+' : '~'} ${def.name} (${rows.length} SKUs)`);

    for (const { it, size, colorTok } of rows) {
      const color = titleColor(colorTok);
      const family = key === 'woods' ? 'wood' : 'cr';
      const sku = await upsertSku(prod.id, {
        vendor_sku: it.itemNumber,
        internal_sku: `TW-${it.itemNumber}`,
        variant_name: color,
        sell_by: 'box', variant_type: null,
      });
      sku.is_new ? stats.sNew++ : stats.sUpd++;

      const cost = it.sqftPrice;
      if (cost) {
        await upsertPricing(pool, sku.id, {
          cost, retail_price: +(cost * RETAIL_MARKUP).toFixed(4), price_basis: 'per_sqft',
        });
      }
      await upsertPackaging(sku.id, it.sqftPerBox);

      await setAttr(sku.id, 'color', color);
      await setAttr(sku.id, 'size', sizeAttr(size));
      await setAttr(sku.id, 'width', sizeAttr(size));
      await setAttr(sku.id, 'species', 'Japanese White Oak');
      await setAttr(sku.id, 'material', 'Engineered Hardwood');
      await setAttr(sku.id, 'construction', 'Engineered Hardwood');
      await setAttr(sku.id, 'edge', 'Micro-Beveled');
      if (key === 'woods') {
        // Only the Woods line has a published sell sheet.
        await setAttr(sku.id, 'thickness', '9/16 in');
        await setAttr(sku.id, 'wear_layer', '3 mm sawn veneer');
        await setAttr(sku.id, 'finish', 'Urethane with Aluminum Oxide');
        await setAttr(sku.id, 'surface_texture', 'Wire-Brushed');
      }

      (plankSkuByFamilyColor[family][colorTok] ||= []).push(sku.id);

      // Media — per-SKU color swatch (primary) + room scene (lifestyle), keyed by
      // internal_sku. Also seed one product-level hero (sku_id NULL) for browse
      // cards / collection views that read the product's primary.
      const img = images[`TW-${it.itemNumber}`];
      if (img && img.primary) {
        await upsertSkuMedia(prod.id, sku.id, img.primary, 'primary', 0);
        if (img.lifestyle && img.lifestyle !== img.primary) await upsertSkuMedia(prod.id, sku.id, img.lifestyle, 'lifestyle', 1);
        if (!heroSet.has(prod.id)) { await upsertMedia(prod.id, img.primary, 'primary', 0); heroSet.add(prod.id); }
        stats.media++;
      }
    }
  }

  // ---- Molding accessory products ----
  const MOLD_PRODUCTS = {
    wood: { name: 'Mizunara Woods Moldings',        collection: 'Mizunara Woods Moldings',        planks: ['woods'] },
    cr:   { name: 'Mizunara Coastal Rift Moldings', collection: 'Mizunara Coastal Rift Moldings', planks: ['coastal-rift', 'coastal-rift-hb'] },
  };
  // moldSkuByFamilyColor['wood'|'cr'][colorTok] = [skuId,...]
  const moldSkuByFamilyColor = { wood: {}, cr: {} };

  const moldsByFamily = { wood: [], cr: [] };
  for (const it of molds) {
    const m = parseMolding(it);
    if (!m) { stats.skipped++; console.warn('  ? unparsed molding', it.itemNumber); continue; }
    moldsByFamily[m.family].push({ it, ...m });
  }

  for (const [family, rows] of Object.entries(moldsByFamily)) {
    if (!rows.length) continue;
    const def = MOLD_PRODUCTS[family];
    const prod = await upsertProduct(vendorId, brandId, catMold, {
      name: def.name, collection: def.collection,
      description_short: `Color-matched engineered-wood transition moldings for ${family === 'cr' ? 'Mizunara Coastal Rift' : 'Mizunara Woods'} floors. Sold per piece.`,
      description_long: `Matching stair nose, quarter round, reducer, T-molding, and threshold trims for ${family === 'cr' ? 'Mizunara Coastal Rift' : 'Mizunara Woods'} engineered hardwood by TMBR (AHF Products). Each trim is finished to match a specific floor color. Sold per piece.`,
    });
    prod.is_new ? stats.pNew++ : stats.pUpd++;
    console.log(`${prod.is_new ? '+' : '~'} ${def.name} (${rows.length} SKUs)`);

    for (const { it, colorTok, type } of rows) {
      const color = titleColor(colorTok);
      const sku = await upsertSku(prod.id, {
        vendor_sku: it.itemNumber,
        internal_sku: `TW-${it.itemNumber}`,
        variant_name: `${color} ${type}`,
        sell_by: 'unit', variant_type: 'accessory', accessory_label: type,
      });
      sku.is_new ? stats.sNew++ : stats.sUpd++;

      const cost = it.cartonPrice; // per-piece cost (unit = PC)
      if (cost) {
        await upsertPricing(pool, sku.id, {
          cost, retail_price: +(cost * RETAIL_MARKUP).toFixed(4), price_basis: 'per_unit',
        });
      }
      await setAttr(sku.id, 'color', color);
      await setAttr(sku.id, 'material', 'Engineered Hardwood');

      (moldSkuByFamilyColor[family][colorTok] ||= []).push(sku.id);
    }
  }

  // ---- Link color-matched moldings to their plank SKUs ----
  // plankSkuByFamilyColor['cr'] already spans both Coastal Rift products (straight
  // + herringbone), so a family+color match covers every relevant plank SKU.
  for (const family of Object.keys(moldSkuByFamilyColor)) {
    for (const [colorTok, accIds] of Object.entries(moldSkuByFamilyColor[family])) {
      const parents = plankSkuByFamilyColor[family][colorTok] || [];
      for (const parentId of parents) {
        let so = 0;
        for (const accId of accIds) { await linkAccessory(parentId, accId, so++); stats.links++; }
      }
    }
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
