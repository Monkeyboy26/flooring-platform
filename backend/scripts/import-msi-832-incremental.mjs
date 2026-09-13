/**
 * MSI EDI 832 — ADDITIVE incremental importer.
 *
 * Purpose: apply the latest MSI 832 catalog feed WITHOUT the destructive
 * re-grouping the full msi-unified pipeline does. The MSI catalog was built by
 * a richer web onboard (April) where sizes/finishes live as standalone products
 * and colorways group by hand. The metadata-poor incremental 832 can't rebuild
 * that grouping, so running the full pipeline orphans (ghost-deletes) existing
 * products. This importer is strictly INSERT/UPDATE-only:
 *
 *   • EXISTING SKUs (matched by vendor_sku, case-insensitive): refresh cost +
 *     recompute retail (upsertPricing keystone/nine-ending/floor rules), and
 *     backfill packaging. sell_by/grouping are PRESERVED (never re-derived).
 *   • NEW SKUs: attach to an existing colorway product when the base name
 *     matches (gray/grey-normalized); otherwise create a new product. Never
 *     repoints or deletes an existing product/SKU, so nothing is orphaned.
 *
 * Reconciliation (price-basis ↔ selling-basis, per-sheet, loose small-piece,
 * stone per-piece) mirrors msi-unified.js phase 2 exactly.
 *
 * Usage:
 *   DB_PASSWORD=postgres node scripts/import-msi-832-incremental.mjs            # DRY RUN (default)
 *   DB_PASSWORD=postgres node scripts/import-msi-832-incremental.mjs --apply    # write to DB
 *   ... --files=/path/a.832,/path/b.832    # parse local files instead of FTP
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { Client: FtpClient } = require('basic-ftp');
const { Pool } = require('pg');
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { parse832, cleanProductName, buildVariantName } from '../scrapers/msi-unified.js';
import {
  upsertProduct, upsertSku, upsertSkuAttribute, upsertPackaging, upsertPricing,
  applySheetSelling, isTrimPiece, PER_SHEET_CATEGORY_SLUGS,
} from '../scrapers/base.js';
import { classifyName } from '../lib/categoryClassifier.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VENDOR_CODE = 'MSI';
const APPLY = process.argv.includes('--apply');
const FILES_ARG = process.argv.find(a => a.startsWith('--files='));

let PACKAGING_REF = {};
try {
  PACKAGING_REF = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/msi/carton-packaging.json'), 'utf-8')).items || {};
} catch { /* optional */ }

const MOSAIC_NAME_PATTERN = /mosaic|hexagon|hexgon|herringbone|basketweave|chevron|arabesque|pinwheel|octagon|penny\s*round|pennyround|picket|pencil|dotty|lynx|fretwork|interlocking|peel.*stick|\btetris\b|\bpenny\b|scallop|ellipse/i;

// MSI EDI MAC/GEN category codes seen in the feed → our category slugs. The
// pipeline's MAC_CATEGORY_MAP keys on the *long* codes (CERTILR); the
// incremental feed carries the short forms, so map them here.
const MSI_CODE_CAT = {
  CERFLO: 'ceramic-tile', CERWAL: 'ceramic-tile', CER: 'ceramic-tile',
  PORFLO: 'porcelain-tile', PORWAL: 'porcelain-tile', POR: 'porcelain-tile',
  STOMOS: 'mosaic-tile', GLSMOS: 'mosaic-tile', MOS: 'mosaic-tile',
  STO: 'natural-stone', STN: 'natural-stone',
  VINTIL: 'lvp-plank', VIN: 'lvp-plank', SPC: 'lvp-plank', WPC: 'lvp-plank',
  CAR: 'installation-sundries', // turf install sundries (adhesive/sand/zeolite)
};

// Strip MSI's "( 16 Sf Per Box )" / "( 5.5 Sf Per Box )" coverage suffix that
// the original cleanProductName (strips only sqft/sqyd) leaves behind.
function stripBoxSuffix(s) {
  if (!s) return s;
  return s.replace(/\s*\(\s*[\d.]+\s*sf\s*per\s*box\s*\)/gi, '')
          .replace(/\s+[\d.]+\s*sf\s*per\s*box\s*$/gi, '')
          .replace(/\s{2,}/g, ' ').trim();
}

// ── FTP ──────────────────────────────────────────────────────────────────────
async function downloadFeed(pool) {
  if (FILES_ARG) {
    return FILES_ARG.split('=')[1].split(',').map(f => f.trim()).filter(Boolean);
  }
  const { rows } = await pool.query(
    `SELECT config FROM vendor_sources WHERE scraper_key='msi-832' LIMIT 1`);
  const cfg = (rows[0] && rows[0].config) || {};
  const client = new FtpClient(30000);
  await client.access({
    host: cfg.ftp_host || 'cftp.msisurfaces.com',
    port: parseInt(cfg.ftp_port || 21, 10),
    user: cfg.ftp_user || 'ROMAFLO',
    password: cfg.ftp_pass || process.env.MSI_FTP_PASS || '',
    secure: cfg.ftp_secure || false,
  });
  const listing = (await client.list('/out')).filter(f => f.type === 1 && f.name.toLowerCase().endsWith('.832'));
  const local = [];
  for (const f of listing) {
    const lp = `/tmp/msi832_${f.name}`;
    await client.downloadTo(lp, `/out/${f.name}`);
    local.push({ path: lp, modifiedAt: f.modifiedAt || new Date(0) });
  }
  client.close();
  // newest last so it wins the dedupe
  local.sort((a, b) => new Date(a.modifiedAt) - new Date(b.modifiedAt));
  return local.map(l => l.path);
}

// ── Name helpers ──────────────────────────────────────────────────────────────
const SIZE_TOKEN = /^\d+(?:\.\d+)?x\d+(?:\.\d+)?$/i;
const norm = (s) => (s || '').toLowerCase().replace(/\bgray\b/g, 'grey').replace(/\s+/g, ' ').trim();

// Split a full 832 description into { colorway, remainder } at the first size
// token, so "Brighton Gray 12x24 Matte" → colorway "Brighton Gray".
function splitColorway(fullName) {
  if (!fullName) return { colorway: fullName, remainder: null };
  const words = fullName.split(/\s+/);
  for (let i = 1; i < words.length; i++) {
    if (SIZE_TOKEN.test(words[i]) || /^\d+(?:\.\d+)?(?:mm|["”])$/i.test(words[i])) {
      return { colorway: words.slice(0, i).join(' '), remainder: words.slice(i).join(' ') };
    }
  }
  // no size token — strip trailing finish words
  const colorway = fullName.replace(/(\s+(?:satin|matte|polished|honed|glossy|brushed|tumbled|natural))+$/i, '');
  return { colorway, remainder: null };
}

// ── Category resolution for NEW items ──────────────────────────────────────────
function resolveCategorySlug(item) {
  const name = item.product_name || '';
  const vsku = (item.vendor_sku || '').toUpperCase();
  let slug = MSI_CODE_CAT[(item.category || '').toUpperCase()] || null;

  // Manufactured stone veneer (Terrado) → stacked stone
  if (/^LVEN/i.test(vsku) || /loose veneer/i.test(name)) slug = 'stacked-stone';
  // Ledger panels
  else if (/\bledger\b/i.test(name)) slug = 'stacked-stone';
  // Pool coping / pavers / outdoor → hardscaping
  else if (/\bcoping\b|\bpaver\b/i.test(name)) slug = 'hardscaping';
  // Turf install sundries
  else if (/^XTURF/i.test(vsku)) slug = 'adhesives-sealants';
  // Bullnose / trim pieces
  else if (/bull\s*nose|bullnose|quarter\s*round|\bv-?cap\b|pencil\s*liner/i.test(name)) slug = 'trim-accessories';
  // Mosaic / shaped-piece override when the material code said a flat tile
  else if (MOSAIC_NAME_PATTERN.test(name)) slug = 'mosaic-tile';

  // Fallback via keyword classifier for anything still unresolved
  if (!slug) {
    try {
      const fam = /vinyl|spc|wpc|lvp|lvt/i.test(name) ? 'luxury-vinyl'
        : /paver|coping|turf|veneer/i.test(name) ? 'hardscaping' : 'tile';
      const c = classifyName(name, fam);
      if (typeof c === 'string') slug = c;
    } catch { /* ignore */ }
  }
  return slug;
}
function resolveCategoryId(item, catCache) {
  const slug = resolveCategorySlug(item);
  return { categoryId: (slug && catCache[slug]) || null, slug };
}

// ── Reconcile price/selling basis (mirror of msi-unified phase 2) ──────────────
function reconcile({ item, vendorSku, sellByIn, variantName, categorySlug, isAccessory }) {
  let sellBy = sellByIn || item.sell_by || 'box';
  let _cost = item.cost || 0;
  let _retail = item.retail_price || Math.round(_cost * 2 * 100) / 100;
  const _ref = PACKAGING_REF[vendorSku.toUpperCase()] || null;
  const _perPieceSqft = item.sqft_per_piece || (_ref && _ref.sqft_per_piece) || null;
  const _priceUom = (item.unit_of_measure || '').toUpperCase();
  const _sfPriced = _priceUom === 'SF' || _priceUom === 'FT2';
  const _eaPriced = _priceUom === 'EA' || _priceUom === 'PC' || _priceUom === 'EACH';
  const _fullName = `${splitColorway(item.product_name || '').colorway} ${variantName || ''}`;
  const _trim = isTrimPiece(_fullName) || isAccessory;
  const _refCarton = !!(_ref && _ref.pieces_per_box > 0 && _ref.sqft_per_box > 0);
  const _looseSmallPiece = !!(_ref && _ref.pieces_per_box > 1 && _ref.sqft_per_box > 0
    && _perPieceSqft && _perPieceSqft < 0.5);
  const _sheetItem = !_looseSmallPiece
    && (PER_SHEET_CATEGORY_SLUGS.has(categorySlug) || /mosaic/i.test(_fullName));
  let sqftPerBox = item.sqft_per_box;
  let piecesPerBox = item.pieces_per_box;
  let stonePerPiece = false;
  if (item.cost || item.retail_price) {
    if (sellBy === 'unit' && _sfPriced && !_trim) {
      if (categorySlug === 'natural-stone') {
        stonePerPiece = true;
        if (!sqftPerBox && _perPieceSqft) sqftPerBox = _perPieceSqft;
      } else if (!_sheetItem && _refCarton) {
        sellBy = 'box'; sqftPerBox = _ref.sqft_per_box; piecesPerBox = _ref.pieces_per_box;
      } else if (_perPieceSqft) {
        _cost = Math.round(_cost * _perPieceSqft * 100) / 100;
        _retail = Math.round(_retail * _perPieceSqft * 100) / 100;
      }
    } else if (sellBy === 'unit' && _eaPriced && categorySlug === 'backsplash-wall'
        && !_trim && _refCarton && _perPieceSqft) {
      sellBy = 'box';
      _cost = Math.round(_cost / _perPieceSqft * 10000) / 10000;
      _retail = Math.round(_retail / _perPieceSqft * 100) / 100;
      sqftPerBox = _ref.sqft_per_box; piecesPerBox = _ref.pieces_per_box;
    } else if (sellBy === 'box' && _eaPriced && _perPieceSqft && Math.abs(_perPieceSqft - 1) > 0.02) {
      _cost = Math.round(_cost / _perPieceSqft * 10000) / 10000;
      _retail = Math.round(_retail / _perPieceSqft * 100) / 100;
    }
  }
  if (sellBy === 'box' && _refCarton && sqftPerBox
      && Math.abs(sqftPerBox - _ref.sqft_per_box) > 0.05 * _ref.sqft_per_box) {
    sqftPerBox = _ref.sqft_per_box;
    if (!piecesPerBox) piecesPerBox = _ref.pieces_per_box;
  }
  const sheet = _looseSmallPiece
    ? { sellBy, priceBasis: sellBy === 'box' ? 'per_sqft' : 'per_unit', cost: _cost, retail_price: _retail, coveringFloor: false }
    : applySheetSelling({ categorySlug, sellBy, name: _fullName, sqft_per_box: sqftPerBox, pieces_per_box: piecesPerBox, cost: _cost, retail_price: _retail });
  if (stonePerPiece) sheet.priceBasis = 'per_sqft';
  return { sheet, sqftPerBox, piecesPerBox, isAccessory: _trim };
}

// ── Main ───────────────────────────────────────────────────────────────────────
async function main() {
  const pool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    database: process.env.DB_NAME || 'flooring_pim',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
  });
  const log = (...a) => console.log(...a);
  log(`MSI 832 incremental importer — ${APPLY ? 'APPLY (writing)' : 'DRY RUN'}`);

  const { rows: vrows } = await pool.query('SELECT id FROM vendors WHERE code=$1', [VENDOR_CODE]);
  const vendorId = vrows[0].id;

  // Category cache
  const catCache = {};
  for (const r of (await pool.query('SELECT id, slug FROM categories')).rows) catCache[r.slug] = r.id;

  // Download + parse + dedupe by vendor_sku (newest file wins)
  const files = await downloadFeed(pool);
  log(`Parsing ${files.length} 832 file(s)...`);
  const itemMap = new Map();
  for (const fp of files) {
    const cat = parse832(fs.readFileSync(fp, 'utf-8'));
    for (const it of cat.items) {
      if (!it.vendor_sku) continue;
      itemMap.set(it.vendor_sku.toUpperCase(), it);
    }
  }
  const items = [...itemMap.values()];
  log(`  ${items.length} unique items in feed`);

  // Existing catalog lookups
  const skuByVsku = new Map();  // UPPER(vendor_sku) -> row
  for (const r of (await pool.query(
    `SELECT s.id, s.internal_sku, s.vendor_sku, s.product_id, s.sell_by, s.variant_type,
            pr.cost, pr.retail_price, pr.price_basis, pk.sqft_per_box, pk.pieces_per_box
     FROM skus s JOIN products p ON p.id=s.product_id
     LEFT JOIN pricing pr ON pr.sku_id=s.id
     LEFT JOIN packaging pk ON pk.sku_id=s.id
     WHERE p.vendor_id=$1`, [vendorId])).rows) {
    if (r.vendor_sku) skuByVsku.set(r.vendor_sku.toUpperCase(), r);
  }
  const productByNorm = new Map(); // normalized name -> {id, name, collection, category_id}
  for (const r of (await pool.query(
    'SELECT id, name, collection, category_id FROM products WHERE vendor_id=$1', [vendorId])).rows) {
    const k = norm(r.name);
    if (!productByNorm.has(k)) productByNorm.set(k, r);
  }

  const plan = { updateCost: [], updatePkg: [], attachNew: [], createNew: [], unchanged: [], newProducts: new Map() };
  const backup = { pricing: [], created_products: [], created_skus: [] };

  for (const item of items) {
    const vsku = item.vendor_sku.toUpperCase();
    const existing = skuByVsku.get(vsku);

    if (existing) {
      // EXISTING SKU — this catalog was priced by the April onboard; re-deriving
      // cost from the raw 832 through our reconciliation produces artifacts
      // (per-piece↔per-sqft replays differ from April's), so we do NOT touch
      // pricing on an already-priced SKU. Only genuinely-unpriced rows get a
      // price, and packaging is backfilled when missing. Grouping/sell_by kept.
      const catSlug = Object.keys(catCache).find(sl => catCache[sl] === existing.category_id) || null;
      const { sheet, sqftPerBox, piecesPerBox } = reconcile({
        item, vendorSku: vsku, sellByIn: existing.sell_by, variantName: null, categorySlug: catSlug,
        isAccessory: existing.variant_type === 'accessory',
      });
      const curCost = existing.cost != null ? Number(existing.cost) : null;
      const unpriced = (curCost == null || curCost <= 0);
      if (unpriced && sheet.cost > 0) {
        plan.updateCost.push({ vsku, from: curCost, to: sheet.cost, basis: sheet.priceBasis });
        backup.pricing.push({ sku_id: existing.id, vendor_sku: existing.vendor_sku, cost: existing.cost, retail_price: existing.retail_price, price_basis: existing.price_basis });
        if (APPLY) {
          await upsertPricing(pool, existing.id, {
            cost: sheet.cost, retail_price: sheet.retail_price, price_basis: sheet.priceBasis, map_price: item.map_price || null,
          }, { coveringFloor: sheet.coveringFloor });
        }
      } else {
        plan.unchanged.push(vsku);
      }
      if ((existing.sqft_per_box == null && sqftPerBox) || (existing.pieces_per_box == null && piecesPerBox)) {
        plan.updatePkg.push({ vsku, sqft_per_box: sqftPerBox, pieces_per_box: piecesPerBox });
        if (APPLY) {
          await upsertPackaging(pool, existing.id, {
            sqft_per_box: sqftPerBox || existing.sqft_per_box || null,
            pieces_per_box: piecesPerBox || existing.pieces_per_box || null,
            weight_per_box_lbs: item.weight_per_box_lbs || null,
          });
        }
      }
      continue;
    }

    // NEW SKU
    const cleanFullName = stripBoxSuffix(cleanProductName(item.product_name) || item.product_name || item.vendor_sku);
    const { colorway, remainder } = splitColorway(cleanFullName);
    const cleanColorway = stripBoxSuffix(cleanProductName(colorway) || colorway);
    const isAccessoryName = /accessory|sundries|\btrim\b|molding|bull\s*nose|bullnose|quarter\s*round|grout|caulk|adhesive|sealant|membrane|pencil\s*liner|chair\s*rail|v-cap|mud\s*cap|jolly|threshold|transition|stair\s*nose|reducer|t-mold/i.test(item.product_name || '') || /adhesive|caulk|grout/i.test(item.category || '') || /^XTURF/i.test(vsku);
    let variantName = stripBoxSuffix(buildVariantName(item, isAccessoryName) || remainder || cleanFullName);
    // Drop a redundant colorway prefix ("Durban Gray 24x48 Matte" → "24x48 Matte")
    if (variantName && cleanColorway) {
      const re = new RegExp('^' + cleanColorway.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/gr[ae]y/gi, 'gr[ae]y') + '\\s+', 'i');
      const stripped = variantName.replace(re, '').trim();
      if (stripped && stripped !== variantName) variantName = stripped;
    }

    // Find parent product by colorway (existing catalog first, then new-this-run)
    const nk = norm(cleanColorway);
    let parent = productByNorm.get(nk);
    let parentSource = 'existing';
    if (!parent) {
      // new-this-run product bucket
      const bkey = `${item.collection || ''}|||${nk}`;
      if (!plan.newProducts.has(bkey)) {
        plan.newProducts.set(bkey, { name: cleanColorway, collection: item.collection || '', items: [], category_slug: null });
      }
      plan.newProducts.get(bkey).items.push({ item, variantName, isAccessoryName, vsku });
      parentSource = 'new';
    }

    const { categoryId, slug: categorySlug } = resolveCategoryId(item, catCache);
    const { sheet, sqftPerBox, piecesPerBox, isAccessory } = reconcile({
      item, vendorSku: vsku, sellByIn: item.sell_by, variantName, categorySlug, isAccessory: isAccessoryName,
    });

    const rec = { vsku, colorway: cleanColorway, variantName, categorySlug, sellBy: sheet.sellBy, cost: sheet.cost, retail: sheet.retail_price, isAccessory, parentSource };
    if (parent) plan.attachNew.push({ ...rec, parentId: parent.id, parentName: parent.name });
    else plan.createNew.push(rec);

    if (APPLY) {
      // resolve/create parent product
      let productId;
      if (parent) {
        productId = parent.id;
      } else {
        const prow = await upsertProduct(pool, {
          vendor_id: vendorId, name: cleanColorway, collection: item.collection || '',
          category_id: categoryId, description_short: item.product_name || null,
        });
        productId = prow.id;
        parent = { id: productId, name: cleanColorway };
        productByNorm.set(nk, parent);
        if (prow.is_new) backup.created_products.push(productId);
      }
      const internalSku = vsku.startsWith('MSI-') ? item.vendor_sku : `MSI-${item.vendor_sku}`;
      const skuRow = await upsertSku(pool, {
        product_id: productId, vendor_sku: item.vendor_sku, internal_sku: internalSku,
        variant_name: variantName, sell_by: sheet.sellBy, variant_type: isAccessory ? 'accessory' : null,
      });
      if (skuRow.is_new) {
        backup.created_skus.push(skuRow.id);
        // New SKUs have no image yet — keep them out of the storefront until the
        // image pass + curation. Draft status hides the variant on active parents.
        await pool.query("UPDATE skus SET status='draft' WHERE id=$1", [skuRow.id]);
      }
      if (item.cost || item.retail_price) {
        await upsertPricing(pool, skuRow.id, {
          cost: sheet.cost, retail_price: sheet.retail_price, price_basis: sheet.priceBasis, map_price: item.map_price || null,
        }, { coveringFloor: sheet.coveringFloor });
      }
      if (sqftPerBox || piecesPerBox || item.weight_per_box_lbs) {
        await upsertPackaging(pool, skuRow.id, {
          sqft_per_box: sqftPerBox || null, pieces_per_box: piecesPerBox || null,
          weight_per_box_lbs: item.weight_per_box_lbs || null,
        });
      }
      if (item.color) await upsertSkuAttribute(pool, skuRow.id, 'color', item.color);
      if (item.upc) await upsertSkuAttribute(pool, skuRow.id, 'upc', item.upc);
      // register this sku so a later size-sibling in the same feed attaches here
      skuByVsku.set(vsku, { id: skuRow.id, product_id: productId, vendor_sku: item.vendor_sku, sell_by: sheet.sellBy });
    }
  }

  // ── Report ──
  const newProdCount = new Set([...plan.createNew].map(r => norm(r.colorway))).size;
  log('');
  log('════════════ PLAN ════════════');
  log(`  Existing SKUs — cost changed:   ${plan.updateCost.length}`);
  log(`  Existing SKUs — packaging fill: ${plan.updatePkg.length}`);
  log(`  Existing SKUs — unchanged:      ${plan.unchanged.length}`);
  log(`  New SKUs → attach to existing:  ${plan.attachNew.length}`);
  log(`  New SKUs → new products:        ${plan.createNew.length} (in ~${newProdCount} new products)`);
  log('');
  if (plan.updateCost.length) {
    log('  COST CHANGES:');
    for (const c of plan.updateCost) log(`    ${c.vsku}: ${c.from ?? 'none'} → ${c.to} (${c.basis})`);
  }
  log('');
  log('  NEW → ATTACH:');
  for (const a of plan.attachNew) log(`    ${a.vsku}  "${a.variantName}"  → ${a.parentName}  [${a.categorySlug || '?'}, ${a.sellBy}, $${a.cost}]`);
  log('');
  log('  NEW → CREATE PRODUCT:');
  for (const c of plan.createNew) log(`    ${c.vsku}  ${c.colorway} / "${c.variantName}"  [${c.categorySlug || '?'}, ${c.sellBy}, $${c.cost}]`);

  if (APPLY) {
    const stamp = Date.now();
    const bpath = path.join(__dirname, `../data/msi-832-incremental-backup-${stamp}.json`);
    fs.writeFileSync(bpath, JSON.stringify(backup, null, 2));
    log(`\n  Backup (for rollback) → ${bpath}`);
    log(`  Applied: ${plan.updateCost.length} cost, ${plan.updatePkg.length} pkg, ${plan.attachNew.length} attach, ${plan.createNew.length} new-sku, ${backup.created_products.length} new products`);
  } else {
    log('\n  DRY RUN — no changes written. Re-run with --apply to commit.');
  }
  await pool.end();
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
