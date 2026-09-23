/**
 * Daltile Unified Scraper
 *
 * Coveo-first pipeline that reads the pre-built product map JSON and
 * enriches with EDI 832 pricing/packaging data from FTP.
 *
 * Product structure comes from Coveo (Series → Color → SKU variants).
 * EDI 832 provides: cost, retail_price, packaging, UPC.
 * Images come from Coveo Scene7 URLs (per-SKU).
 *
 * Replaces the old 5-step pipeline:
 *   daltile-832 → daltile-catalog → daltile-pricing → daltile-dam → daltile-inherit
 *
 * Config (vendor_sources.config):
 *   ftp_host, ftp_port, ftp_user, ftp_pass — FTP credentials for EDI 832
 *   product_map_path — optional override for product map JSON path
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { Client: FtpClient } = require('basic-ftp');
const { pickPrimaryImage } = require('./daltile-image-rank.cjs');
const { resolveMosaicPattern } = require('./daltile-mosaic-pattern.cjs');
import { daltileSkuDescriptors } from './daltile-832.js';

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  appendLog, addJobError,
  upsertProduct, upsertSku,
  upsertSkuAttribute, upsertPackaging, upsertPricing,
  upsertMediaAsset, applySheetSelling,
  resolveBrandId, slugify,
} from './base.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Constants ───────────────────────────────────────────────────────────────

const VENDOR_CODE = 'DAL';

const DEFAULT_PRODUCT_MAP = path.join(__dirname, '..', 'data', 'daltile-product-map.json');

// The DAL vendor carries three storefront brands, each with its own Coveo
// domain and product map. Product names are brand-prefixed ("Daltile Keystones
// Berry Blend") to match the storewide convention; slugs stay unprefixed
// ("keystones-berry-blend").
const DEFAULT_PRODUCT_MAPS = [
  { path: DEFAULT_PRODUCT_MAP, brand: 'Daltile' },
  { path: path.join(__dirname, '..', 'data', 'ao-product-map.json'), brand: 'American Olean' },
  { path: path.join(__dirname, '..', 'data', 'marazzi-product-map.json'), brand: 'Marazzi' },
];

const DEFAULT_FTP = {
  host: 'daltileb2b.daltile.com',
  port: 21,
  user: '7149990009',
  password: 'W5y5p6L6',
};

const REMOTE_DIRS = [
  '/users/7149990009/Outbox',
  '/users/7149990009/Outbox/Archive',
  '/Outbox', '/Outbox/Archive',
  '/832',
  '/',
];

// ─── EDI 832 Parser (reused from daltile-832.js) ────────────────────────────

const LIN_QUALIFIERS = {
  UP: 'upc', VN: 'vendor_item_number', SK: 'sku',
  MG: 'manufacturer_group', BP: 'buyer_part_number',
  IN: 'buyer_item_number', MN: 'model_number',
  GN: 'generic_name', UA: 'upc_case_code',
  CB: 'catalog_number', FS: 'standard_number',
  EC: 'ean', EN: 'ean', UK: 'upc_shipping',
  PI: 'purchaser_item', PN: 'part_number', VA: 'vendor_alpha',
};

const PID_CODES = {
  '08': 'description', GEN: 'category', '09': 'sub_product',
  '73': 'color', '74': 'pattern', '75': 'finish',
  '35': 'dye_code', '37': 'material', '38': 'style',
  DIM: 'dimensions', MAC: 'material_class', TRN: 'trade_name',
  '12': 'quality', '77': 'collection',
};

function tokenizeSegments(raw) {
  let text = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const tildeCount = (text.match(/~/g) || []).length;
  const lineCount = (text.match(/\n/g) || []).length;
  if (tildeCount > 10 && tildeCount >= lineCount * 0.5) {
    return text.split('~').map(s => s.trim()).filter(Boolean);
  }
  return text.split('\n').map(s => s.replace(/~\s*$/, '').trim()).filter(Boolean);
}

function parseSegment(segStr) {
  const elements = segStr.split('*');
  return { id: elements[0], el: elements };
}

function parseLIN(seg) {
  const result = { line_number: seg.el[1] || null, identifiers: {} };
  for (let i = 2; i < seg.el.length - 1; i += 2) {
    const qual = seg.el[i], val = seg.el[i + 1];
    if (qual && val) result.identifiers[LIN_QUALIFIERS[qual] || qual.toLowerCase()] = val;
  }
  return result;
}

function parseSLN(seg) {
  const result = { sub_line_number: seg.el[1] || null, relationship_code: seg.el[3] || null, identifiers: {} };
  for (let i = 9; i < seg.el.length - 1; i += 2) {
    const qual = seg.el[i], val = seg.el[i + 1];
    if (qual && val) result.identifiers[LIN_QUALIFIERS[qual] || qual.toLowerCase()] = val;
  }
  return result;
}

function parsePO4(seg) {
  return {
    pack: seg.el[1] || null,
    size_per_pack: seg.el[2] ? parseFloat(seg.el[2]) : null,
    unit_of_measure: seg.el[3] || null,
    pieces_per_pack: seg.el[14] ? parseInt(seg.el[14], 10) : null,
    packs_per_pallet: seg.el[17] ? parseInt(seg.el[17], 10) : null,
    gross_weight: seg.el[6] ? parseFloat(seg.el[6]) : null,
  };
}

function parseCTP(seg) {
  return {
    class_of_trade: seg.el[1] || null,
    price_type: seg.el[2] || null,
    unit_price: seg.el[3] ? parseFloat(seg.el[3]) : null,
    unit_of_measure: seg.el[5] || null,
    basis_code: seg.el[9] || null,
  };
}

function parsePID(seg) {
  return {
    characteristic_code: seg.el[2] || null,
    characteristic_label: PID_CODES[seg.el[2]] || seg.el[2] || null,
    description: seg.el[5] || null,
  };
}

function parseMEA(seg) {
  return {
    qualifier: seg.el[2] || null,
    value: seg.el[3] ? parseFloat(seg.el[3]) : null,
    unit_of_measure: seg.el[4] || null,
  };
}

function mergeProductContext(item, productCtx) {
  if (!productCtx) return;
  for (const [k, v] of Object.entries(productCtx.identifiers)) {
    if (!item.identifiers[k]) item.identifiers[k] = v;
  }
  item.descriptions = [...productCtx.descriptions, ...item.descriptions];
  if (!item.packaging && productCtx.packaging) item.packaging = productCtx.packaging;
  if (item.pricing.length === 0) item.pricing = [...productCtx.pricing];
  const slnQuals = new Set(item.measurements.map(m => m.qualifier));
  for (const pm of productCtx.measurements) {
    if (!slnQuals.has(pm.qualifier)) item.measurements.push(pm);
  }
}

function finalizeEdiItem(item) {
  if (!item.vendor_sku) {
    item.vendor_sku = item.identifiers.vendor_item_number || item.identifiers.model_number ||
      item.identifiers.sku || item.identifiers.part_number || null;
  }
  item.upc = item.identifiers.upc || null;

  // Pricing
  const lprPrices = item.pricing.filter(p => p.price_type === 'LPR');
  if (lprPrices.length > 0) {
    const ctPrice = lprPrices.find(p => p.basis_code === 'CT');
    const stPrice = lprPrices.find(p => p.basis_code === 'ST');
    const plPrice = lprPrices.find(p => p.basis_code === 'PL');
    const costEntry = ctPrice || plPrice || lprPrices[0];
    if (costEntry) { item.cost = costEntry.unit_price; item.unit_of_measure = costEntry.unit_of_measure || item.unit_of_measure; }
    const retailEntry = stPrice || ctPrice || lprPrices[0];
    if (retailEntry) item.retail_price = retailEntry.unit_price;
    const mapPrice = item.pricing.find(p => p.price_type === 'MAP');
    if (mapPrice) item.map_price = mapPrice.unit_price;
  } else {
    const netPrice = item.pricing.find(p => p.price_type === 'NET') || item.pricing.find(p => p.class_of_trade === 'WS') || item.pricing[0];
    if (netPrice) { item.cost = netPrice.unit_price; item.unit_of_measure = netPrice.unit_of_measure || item.unit_of_measure; }
    const retailPrice = item.pricing.find(p => p.price_type === 'MSR') || item.pricing.find(p => p.class_of_trade === 'RS');
    if (retailPrice) item.retail_price = retailPrice.unit_price;
    const mapPrice = item.pricing.find(p => p.price_type === 'MAP');
    if (mapPrice) item.map_price = mapPrice.unit_price;
  }

  // Convert SY to SF
  if (item.unit_of_measure && item.unit_of_measure.toUpperCase() === 'SY') {
    if (item.cost) item.cost = parseFloat((item.cost / 9).toFixed(4));
    if (item.retail_price) item.retail_price = parseFloat((item.retail_price / 9).toFixed(4));
    item.unit_of_measure = 'SF';
  }

  // Packaging
  if (item.packaging) {
    const uom = (item.packaging.unit_of_measure || '').toUpperCase();
    if (uom === 'SF' || uom === 'FT2') {
      item.sqft_per_box = item.packaging.size_per_pack;
      item.sell_by = 'box';
    } else if (uom === 'SY') {
      item.sqft_per_box = item.packaging.size_per_pack * 9;
      item.sell_by = 'box';
    } else if (uom === 'EA' || uom === 'PC' || uom === 'LF') {
      item.sell_by = 'unit';
    } else if (item.packaging.size_per_pack) {
      item.sqft_per_box = item.packaging.size_per_pack;
      item.sell_by = 'box';
    }
    item.pieces_per_box = item.packaging.pieces_per_pack || null;
    item.weight_per_box_lbs = item.packaging.gross_weight || null;
    item.boxes_per_pallet = item.packaging.packs_per_pallet || null;
  }

  // MEA SU for surface area
  const surfMea = item.measurements.find(m => m.qualifier === 'SU');
  if (surfMea && surfMea.value && !item.sqft_per_box) {
    const suUom = (surfMea.unit_of_measure || '').toUpperCase();
    if (suUom === 'SF' || suUom === 'FT2') item.sqft_per_box = surfMea.value;
    else if (suUom === 'SY') item.sqft_per_box = surfMea.value * 9;
  }

  if (!item.sell_by && item.unit_of_measure) {
    const puom = item.unit_of_measure.toUpperCase();
    if (puom === 'SF' || puom === 'SY') item.sell_by = 'box';
    else if (puom === 'EA' || puom === 'PC') item.sell_by = 'unit';
  }

  // (Removed: a "per-box price disguised as per-sqft" divide hack. With per-color CTP
  // now bound correctly, the EDI CTP is authoritative per-SF; the hack only mis-divided
  // legitimately expensive per-SF tile — marble ~$53/SF, metal mosaic ~$39/SF.)
}

function parse832(raw) {
  const segments = tokenizeSegments(raw).map(parseSegment);
  const items = [];
  let currentItem = null;
  let productContext = null;
  let hadSLN = false;

  function newItem(identifiers) {
    return {
      identifiers, descriptions: [], packaging: null, pricing: [], measurements: [],
      vendor_sku: identifiers.sku || null, upc: null,
      cost: null, retail_price: null, map_price: null,
      unit_of_measure: null, sqft_per_box: null, pieces_per_box: null,
      weight_per_box_lbs: null, boxes_per_pallet: null, sell_by: null,
    };
  }

  function flushCurrentItem() {
    if (!currentItem) return;
    if (productContext) mergeProductContext(currentItem, productContext);
    finalizeEdiItem(currentItem);
    items.push(currentItem);
    currentItem = null;
  }

  function flushProduct() {
    if (hadSLN && currentItem) {
      flushCurrentItem();
    } else if (currentItem && !hadSLN) {
      finalizeEdiItem(currentItem);
      items.push(currentItem);
      currentItem = null;
    }
    productContext = null;
    hadSLN = false;
  }

  for (const seg of segments) {
    switch (seg.id) {
      case 'LIN': {
        flushProduct();
        const lin = parseLIN(seg);
        currentItem = newItem(lin.identifiers);
        break;
      }
      case 'SLN': {
        if (!hadSLN && currentItem) {
          productContext = {
            identifiers: { ...currentItem.identifiers },
            descriptions: [...currentItem.descriptions],
            packaging: currentItem.packaging,
            pricing: [...currentItem.pricing],
            measurements: [...currentItem.measurements],
          };
          hadSLN = true;
          currentItem = null;
        } else if (currentItem) {
          flushCurrentItem();
        }
        const sln = parseSLN(seg);
        currentItem = newItem(sln.identifiers);
        break;
      }
      case 'PO4': {
        const target = productContext || currentItem;
        if (target) target.packaging = parsePO4(seg);
        break;
      }
      case 'CTP': {
        // Per-color CTP (following an SLN, e.g. marble Calacatta vs Carrara) must bind to
        // the current color line, not the shared LIN context. See daltile-832.js for detail.
        const target = currentItem || productContext;
        if (target) target.pricing.push(parseCTP(seg));
        break;
      }
      case 'PID': {
        if (currentItem) currentItem.descriptions.push(parsePID(seg));
        else if (productContext) productContext.descriptions.push(parsePID(seg));
        break;
      }
      case 'MEA': {
        if (currentItem) currentItem.measurements.push(parseMEA(seg));
        else if (productContext) productContext.measurements.push(parseMEA(seg));
        break;
      }
      case 'G39': {
        const target = productContext || currentItem;
        if (target) {
          for (let i = 2; i < Math.min(seg.el.length, 6); i += 2) {
            const qual = seg.el[i], val = seg.el[i + 1];
            if (qual && val) {
              const key = LIN_QUALIFIERS[qual] || qual.toLowerCase();
              if (!target.identifiers[key]) target.identifiers[key] = val;
            }
          }
          if (seg.el[9] && seg.el[10] && !target.packaging) {
            target.packaging = {
              size_per_pack: parseFloat(seg.el[9]),
              unit_of_measure: seg.el[10],
              pieces_per_pack: seg.el[11] ? parseInt(seg.el[11], 10) : null,
            };
          }
        }
        break;
      }
      case 'CTT': case 'SE': {
        flushProduct();
        break;
      }
    }
  }

  flushProduct();
  return items;
}

// ─── FTP helpers ─────────────────────────────────────────────────────────────

function getFtpConfig(source) {
  const cfg = source.config || {};
  return {
    host: cfg.ftp_host || process.env.DALTILE_FTP_HOST || DEFAULT_FTP.host,
    port: parseInt(cfg.ftp_port || process.env.DALTILE_FTP_PORT || DEFAULT_FTP.port, 10),
    user: cfg.ftp_user || process.env.DALTILE_FTP_USER || DEFAULT_FTP.user,
    password: cfg.ftp_pass || process.env.DALTILE_FTP_PASS || DEFAULT_FTP.password,
  };
}

async function findRemote832Files(ftpClient) {
  const allFiles = [];
  for (const dir of REMOTE_DIRS) {
    try {
      const listing = await ftpClient.list(dir);
      const matching = listing
        .filter(f => f.type === 1)
        .filter(f => {
          const name = f.name.toLowerCase();
          return name.includes('832') || name.includes('catalog') || name.includes('pricelist')
            || name.includes('price_catalog') || name.endsWith('.edi') || name.endsWith('.x12');
        })
        .map(f => ({ ...f, dir, remotePath: `${dir}/${f.name}`.replace('//', '/') }));
      allFiles.push(...matching);
    } catch { /* directory doesn't exist or no access */ }
  }
  allFiles.sort((a, b) => (b.size || 0) - (a.size || 0));
  return allFiles;
}

async function downloadAndParse832(pool, job, source) {
  const ftpConfig = getFtpConfig(source);
  await appendLog(pool, job.id, `Connecting to ${ftpConfig.host} for EDI 832 data...`);

  const ftp = new FtpClient();
  ftp.ftp.verbose = false;

  try {
    await ftp.access({ ...ftpConfig, secure: false });
    const remoteFiles = await findRemote832Files(ftp);
    await appendLog(pool, job.id, `Found ${remoteFiles.length} 832 candidate file(s) on FTP`);

    if (remoteFiles.length === 0) {
      await appendLog(pool, job.id, 'No 832 files found. EDI enrichment will be skipped.');
      return [];
    }

    // Download and parse ALL 832 files, then merge/deduplicate.
    // Daltile FTP has separate 832 files for tiles vs installation materials,
    // and multiple versions over time. We want all of them.
    const allItems = [];
    const seenSkus = new Set();
    for (const target of remoteFiles) {
      const localPath = `/tmp/daltile_832_${Date.now()}_${target.name}`;
      try {
        await ftp.downloadTo(localPath, target.remotePath);
        await appendLog(pool, job.id, `Downloaded ${target.name} (${(target.size / 1024).toFixed(1)}KB)`);

        const raw = fs.readFileSync(localPath, 'utf-8');
        const items = parse832(raw);
        // Deduplicate: keep first occurrence of each vendor_sku
        let added = 0;
        for (const item of items) {
          const key = (item.vendor_sku || '').toUpperCase();
          if (key && !seenSkus.has(key)) {
            seenSkus.add(key);
            allItems.push(item);
            added++;
          }
        }
        await appendLog(pool, job.id, `  Parsed ${items.length} items, ${added} new unique SKUs`);
      } catch (dlErr) {
        await appendLog(pool, job.id, `  Skipped ${target.name}: ${dlErr.message}`);
      } finally {
        try { fs.unlinkSync(localPath); } catch { }
      }
    }
    await appendLog(pool, job.id, `Total EDI items: ${allItems.length} unique SKUs from ${remoteFiles.length} files`);
    return allItems;
  } catch (err) {
    await addJobError(pool, job.id, `FTP/EDI error: ${err.message}`);
    await appendLog(pool, job.id, `EDI 832 fetch failed: ${err.message}. Continuing without pricing data.`);
    return [];
  } finally {
    ftp.close();
  }
}

// ─── Category resolution ─────────────────────────────────────────────────────

async function loadCategoryMap(pool) {
  const result = await pool.query('SELECT id, slug FROM categories');
  const map = {};
  for (const row of result.rows) map[row.slug] = row.id;
  return map;
}

// ─── Retail price estimation ─────────────────────────────────────────────────

function retailFromCost(cost) {
  if (!cost || cost <= 0) return 0;
  // Flat 1.70x keystone — Daltile 832 only sends wholesale cost, so retail = cost × 1.70.
  return Math.round(cost * 1.70 * 100) / 100;
}

// ─── Internal SKU builder ────────────────────────────────────────────────────

function makeInternalSku(vendorSku) {
  if (!vendorSku) return null;
  return vendorSku.toUpperCase().startsWith('DAL-') ? vendorSku : `DAL-${vendorSku}`;
}

// ─── Sell-by detection for trims ─────────────────────────────────────────────

function isTrimProductType(productType) {
  return /trim/i.test(productType || '');
}

// ─── Per-product category resolution ─────────────────────────────────────────
// Uses SKU-level productType + bodyType to pick the right category slug.
// Much more accurate than the series-level fallback.

function resolveProductCategory(skus, seriesName, catMap) {
  // Count dominant productType across SKUs (ignoring trims)
  const typeCounts = {};
  const bodyTypes = new Set();
  const sizes = [];
  for (const sku of skus) {
    const pt = sku.productType || '';
    if (!isTrimProductType(pt) && pt) {
      typeCounts[pt] = (typeCounts[pt] || 0) + 1;
    }
    if (sku.bodyType) bodyTypes.add(sku.bodyType);
    if (sku.size) sizes.push(sku.size);
  }

  const dominant = Object.entries(typeCounts).sort((a, b) => b[1] - a[1])[0];
  const productType = dominant ? dominant[0] : '';
  const bodyArr = [...bodyTypes];
  const bodyStr = bodyArr.join(' ').toLowerCase();

  let slug;

  // ── Slabs → countertop subcategories ──
  if (productType === 'Quartz Slab') {
    slug = 'quartz-countertops';
  } else if (productType === 'Porcelain Slab') {
    slug = 'porcelain-slabs';
  } else if (productType === 'Natural Stone Slab') {
    if (/granite/i.test(seriesName)) slug = 'granite-countertops';
    else if (/quartzite/i.test(seriesName)) slug = 'quartzite-countertops';
    else if (/marble/i.test(seriesName)) slug = 'marble-countertops';
    else if (/soapstone/i.test(seriesName)) slug = 'soapstone-countertops';
    else slug = 'natural-stone';
  }

  // ── Vinyl → LVP (plank) vs LVT (tile) ──
  else if (/Luxury Vinyl|LVT/i.test(productType)) {
    // Planks: long narrow formats. Tiles: square/near-square.
    const hasPlank = sizes.some(s => {
      const m = s.match(/(\d+)\s*[Xx]\s*(\d+)/);
      return m && parseInt(m[2]) >= 36;
    });
    const hasTile = sizes.some(s => {
      const m = s.match(/(\d+)\s*[Xx]\s*(\d+)/);
      return m && parseInt(m[2]) < 36 && parseInt(m[1]) >= 12;
    });
    if (hasPlank && !hasTile) slug = 'lvp-plank';
    else if (hasTile && !hasPlank) slug = 'lvt-tile';
    else if (/rigid.*click/i.test(bodyStr)) slug = 'lvp-plank';
    else slug = 'lvt-tile';
  }

  // ── Natural stone tile ──
  else if (productType === 'Stone Tile') {
    // Ledger panel series ("Stacked Stone") sell as stacked stone, not field tile
    if (/stacked stone|ledger/i.test(seriesName)) slug = 'stacked-stone';
    else slug = 'natural-stone';
  }

  // ── Mosaic ──
  else if (productType === 'Mosaic Natural Stone Tile') {
    // Stone mosaics that also have Stone Tile SKUs → natural-stone
    if (typeCounts['Stone Tile']) slug = 'natural-stone';
    else slug = 'mosaic-tile';
  } else if (productType === 'Mosaic Tile') {
    slug = 'mosaic-tile';
  }

  // ── Quarry tile → ceramic ──
  else if (/Quarry/i.test(productType)) {
    slug = 'ceramic-tile';
  }

  // ── Wall tile ──
  else if (/Wall.*Bathroom.*Access/i.test(productType)) {
    // This productType mixes wall tile with bath fixtures (Armor grab bars,
    // ceramic Bath Accessories) — route the fixtures to bath-accessories
    if (/\barmor\b|bath accessories/i.test(seriesName)) slug = 'bath-accessories';
    else slug = 'backsplash-wall';
  } else if (/Wall Tile/i.test(productType)) {
    // Check body type for ceramic vs porcelain wall tile
    if (/ceramic|wall\s*body/i.test(bodyStr)) slug = 'ceramic-tile';
    else slug = 'backsplash-wall';
  }

  // ── Floor tile (largest bucket) ──
  else if (/Floor Tile/i.test(productType)) {
    // Wood-look detection: name, body type, or plank-only sizes (6x36, 6x48, 8x48)
    const nameIsWood = /wood|plank|timber|lumber|oak|maple|walnut|hickory|pine|cedar|birch/i.test(seriesName);
    const bodyIsWood = bodyStr.includes('wood');
    const plankSizes = sizes.filter(s => {
      const m = s.match(/(\d+)\s*[Xx]\s*(\d+)/);
      return m && parseInt(m[1]) <= 10 && parseInt(m[2]) >= 36;
    });
    const squareSizes = sizes.filter(s => {
      const m = s.match(/(\d+)\s*[Xx]\s*(\d+)/);
      return m && parseInt(m[1]) >= 12 && parseInt(m[2]) <= 30;
    });
    const isPlankOnly = plankSizes.length > 0 && squareSizes.length === 0;
    if (nameIsWood || bodyIsWood || isPlankOnly) slug = 'wood-look-tile';
    else if (/ceramic/i.test(bodyStr)) slug = 'ceramic-tile';
    else slug = 'porcelain-tile';
  }

  // ── Special ──
  else if (/Windowsills/i.test(productType)) {
    slug = 'natural-stone';
  }

  // ── Fallback ──
  else {
    slug = 'porcelain-tile';
  }

  return catMap[slug] || catMap['porcelain-tile'] || null;
}

// ─── Main run() ──────────────────────────────────────────────────────────────

export async function run(pool, job, source) {
  // Step 1: Load product maps (one per brand). Config may override with either
  // the legacy single product_map_path or an array product_maps: [{path, brand}].
  let mapSpecs;
  if (Array.isArray(source.config?.product_maps) && source.config.product_maps.length) {
    mapSpecs = source.config.product_maps;
  } else if (source.config?.product_map_path) {
    mapSpecs = [{ path: source.config.product_map_path, brand: 'Daltile' }];
  } else {
    mapSpecs = DEFAULT_PRODUCT_MAPS;
  }

  const loadedMaps = [];
  for (const spec of mapSpecs) {
    if (!fs.existsSync(spec.path)) {
      if (spec.brand === 'Daltile') {
        throw new Error(`Product map not found at ${spec.path}. Run build-daltile-product-map.cjs first.`);
      }
      await appendLog(pool, job.id, `WARNING: ${spec.brand} product map missing at ${spec.path} — that brand will not be imported.`);
      continue;
    }
    const map = JSON.parse(fs.readFileSync(spec.path, 'utf-8'));
    loadedMaps.push({ brand: spec.brand, map });
    await appendLog(pool, job.id, `Loaded ${spec.brand} map: ${map.summary.series} series, ${map.summary.products} products, ${map.summary.skus} SKUs`);
  }

  // Step 2: Download and parse EDI 832
  const ediItems = await downloadAndParse832(pool, job, source);

  // Build EDI lookups:
  // 1. Exact: UPPER(vendor_sku) → parsed item
  // 2. Fuzzy: colorCode:dimensions → [parsed items] (for fallback matching)
  // Coveo SKUs look like EP20RCT1224MT, EDI SKUs look like EP20SQ1818MTJ1 or EP201224J1PV
  // The color code prefix (first 4 chars) is consistent, dimensions (4-digit numbers) match.
  const ediLookup = new Map();
  const ediFuzzy = new Map(); // colorCode:dims → [ediItem, ...]
  const dimPattern = /(\d{3,4})/g;
  for (const item of ediItems) {
    if (!item.vendor_sku) continue;
    const key = item.vendor_sku.toUpperCase();
    ediLookup.set(key, item);

    // Build fuzzy key: first 4 chars of SKU + extracted dimensions
    const colorPrefix = key.slice(0, 4);
    const dims = key.match(dimPattern);
    if (dims) {
      const fuzzyKey = `${colorPrefix}:${dims.sort().join(',')}`;
      if (!ediFuzzy.has(fuzzyKey)) ediFuzzy.set(fuzzyKey, []);
      ediFuzzy.get(fuzzyKey).push(item);
    }
  }
  await appendLog(pool, job.id, `EDI lookup map: ${ediLookup.size} exact, ${ediFuzzy.size} fuzzy keys`);

  // Step 3: Resolve vendor and categories
  const vendorResult = await pool.query('SELECT id FROM vendors WHERE code = $1', [VENDOR_CODE]);
  if (!vendorResult.rows.length) {
    throw new Error(`Vendor with code "${VENDOR_CODE}" not found. Create the vendor record first.`);
  }
  const vendorId = vendorResult.rows[0].id;
  const catMap = await loadCategoryMap(pool);

  // Resolve brand ids up front
  for (const lm of loadedMaps) {
    lm.brandId = await resolveBrandId(pool, lm.brand);
    if (!lm.brandId) await appendLog(pool, job.id, `WARNING: brand "${lm.brand}" not found in brands table — products import without brand_id.`);
  }

  // Step 3a: Snapshot the outgoing catalog BEFORE the wipe — used to (1) write a
  // recovery backup file and (2) carry paid SEO content + slugs onto the fresh
  // import (matched by slug, then by normalized name).
  const snapRes = await pool.query(`
    SELECT p.id, p.name, p.slug, p.status, p.collection,
           p.meta_title, p.meta_description, p.seo_h1,
           p.content_html, p.content_status, p.content_hash
    FROM products p WHERE p.vendor_id = $1`, [vendorId]);
  const snapshot = snapRes.rows;
  const snapBySlug = new Map();
  const snapByName = new Map();
  const nameKey = (n) => (n || '').toLowerCase().replace(/\s+/g, ' ').trim();
  for (const row of snapshot) {
    if (row.slug && !snapBySlug.has(row.slug)) snapBySlug.set(row.slug, row);
    const nk = nameKey(row.name);
    // Prefer active rows when names collide across statuses
    if (nk && (!snapByName.has(nk) || row.status === 'active')) snapByName.set(nk, row);
  }
  try {
    const skuSnap = await pool.query(`
      SELECT s.vendor_sku, s.internal_sku, s.variant_name, s.status, s.sell_by,
             p.name AS product_name, pr.cost, pr.retail_price, pr.price_basis,
             pk.sqft_per_box, pk.pieces_per_box, pk.weight_per_box_lbs,
             pk.boxes_per_pallet, pk.sqft_per_pallet
      FROM skus s JOIN products p ON p.id = s.product_id
      LEFT JOIN pricing pr ON pr.sku_id = s.id
      LEFT JOIN packaging pk ON pk.sku_id = s.id
      WHERE p.vendor_id = $1`, [vendorId]);
    const backupPath = path.join(__dirname, '..', 'data',
      `daltile-reonboard-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(backupPath, JSON.stringify({ products: snapshot, skus: skuSnap.rows }, null, 1));
    await appendLog(pool, job.id, `Backed up ${snapshot.length} products / ${skuSnap.rows.length} SKUs to ${backupPath}`);
  } catch (bkErr) {
    throw new Error(`Refusing to wipe without a backup: ${bkErr.message}`);
  }

  // Step 3b: Clean slate — remove old Daltile products to prevent duplicates
  // The old 832 pipeline grouped products differently (by EDI collection+color).
  // Coveo uses Series→Color grouping with different names, so old products would
  // persist as orphans.
  const oldProducts = await pool.query(
    `SELECT COUNT(*) FROM products WHERE vendor_id = $1`, [vendorId]
  );
  if (parseInt(oldProducts.rows[0].count) > 0) {
    await appendLog(pool, job.id, `Clearing ${oldProducts.rows[0].count} existing Daltile products for clean import...`);

    // Use a dedicated client with a single transaction for atomic cleanup
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET statement_timeout = 300000'); // 5 min for large deletes

      const skuSubquery = `SELECT s.id FROM skus s JOIN products p ON s.product_id = p.id WHERE p.vendor_id = $1`;
      const prodSubquery = `SELECT id FROM products WHERE vendor_id = $1`;

      // 1. Delete pure scraper data (no business records)
      await client.query(`DELETE FROM sku_accessories WHERE parent_sku_id IN (${skuSubquery}) OR accessory_sku_id IN (${skuSubquery})`, [vendorId]);
      await client.query(`DELETE FROM media_assets WHERE product_id IN (${prodSubquery})`, [vendorId]);
      await client.query(`DELETE FROM media_assets WHERE sku_id IN (${skuSubquery})`, [vendorId]);
      await client.query(`DELETE FROM sku_attributes WHERE sku_id IN (${skuSubquery})`, [vendorId]);
      await client.query(`DELETE FROM pricing WHERE sku_id IN (${skuSubquery})`, [vendorId]);
      await client.query(`DELETE FROM packaging WHERE sku_id IN (${skuSubquery})`, [vendorId]);
      await client.query(`DELETE FROM inventory_snapshots WHERE sku_id IN (${skuSubquery})`, [vendorId]);
      await client.query(`DELETE FROM stock_alerts WHERE sku_id IN (${skuSubquery})`, [vendorId]);

      // 2. Nullify FK refs in business tables (orders, carts, POs, quotes, etc.)
      await client.query(`UPDATE order_items SET sku_id = NULL WHERE sku_id IN (${skuSubquery})`, [vendorId]);
      await client.query(`UPDATE order_items SET product_id = NULL WHERE product_id IN (${prodSubquery})`, [vendorId]);
      await client.query(`UPDATE cart_items SET sku_id = NULL WHERE sku_id IN (${skuSubquery})`, [vendorId]);
      await client.query(`UPDATE cart_items SET product_id = NULL WHERE product_id IN (${prodSubquery})`, [vendorId]);
      await client.query(`UPDATE purchase_order_items SET sku_id = NULL WHERE sku_id IN (${skuSubquery})`, [vendorId]);
      await client.query(`UPDATE quote_items SET sku_id = NULL WHERE sku_id IN (${skuSubquery})`, [vendorId]);
      await client.query(`UPDATE quote_items SET product_id = NULL WHERE product_id IN (${prodSubquery})`, [vendorId]);
      await client.query(`UPDATE invoice_items SET sku_id = NULL WHERE sku_id IN (${skuSubquery})`, [vendorId]);
      await client.query(`UPDATE estimate_items SET sku_id = NULL WHERE sku_id IN (${skuSubquery})`, [vendorId]);
      await client.query(`UPDATE estimate_items SET product_id = NULL WHERE product_id IN (${prodSubquery})`, [vendorId]);
      await client.query(`UPDATE trade_favorite_items SET sku_id = NULL WHERE sku_id IN (${skuSubquery})`, [vendorId]);
      await client.query(`UPDATE trade_favorite_items SET product_id = NULL WHERE product_id IN (${prodSubquery})`, [vendorId]);
      await client.query(`UPDATE showroom_visit_items SET sku_id = NULL WHERE sku_id IN (${skuSubquery})`, [vendorId]);
      await client.query(`UPDATE showroom_visit_items SET product_id = NULL WHERE product_id IN (${prodSubquery})`, [vendorId]);
      await client.query(`UPDATE sample_request_items SET sku_id = NULL WHERE sku_id IN (${skuSubquery})`, [vendorId]);
      await client.query(`UPDATE sample_request_items SET product_id = NULL WHERE product_id IN (${prodSubquery})`, [vendorId]);
      await client.query(`UPDATE installation_inquiries SET product_id = NULL WHERE product_id IN (${prodSubquery})`, [vendorId]);
      await client.query(`DELETE FROM product_reviews WHERE product_id IN (${prodSubquery})`, [vendorId]);
      await client.query(`DELETE FROM wishlists WHERE product_id IN (${prodSubquery})`, [vendorId]);
      await client.query(`DELETE FROM product_tags WHERE product_id IN (${prodSubquery})`, [vendorId]);

      // 3. Delete SKUs, then products
      await client.query(`DELETE FROM skus WHERE product_id IN (${prodSubquery})`, [vendorId]);
      await client.query(`DELETE FROM products WHERE vendor_id = $1`, [vendorId]);

      await client.query('COMMIT');
    } catch (cleanupErr) {
      await client.query('ROLLBACK');
      throw new Error(`Cleanup failed: ${cleanupErr.message}`);
    } finally {
      client.release();
    }
    await appendLog(pool, job.id, `Cleared old Daltile data. Starting fresh import.`);
  }

  // Step 4: Process each series, per brand map
  let stats = {
    productsCreated: 0, productsUpdated: 0,
    skusCreated: 0, skusUpdated: 0,
    imagesSet: 0, attributesSet: 0,
    pricingSet: 0, packagingSet: 0,
    ediMatches: 0, ediMisses: 0,
    seoCarried: 0, slugsCarried: 0,
    errors: 0,
  };

  // The brand sites cross-list some SKUs (americanolean.com re-lists Daltile
  // items with the same SKU code). internal_sku is globally unique, so a later
  // brand would silently yank the SKU off the earlier brand's product
  // (upsertSku moves product_id) and leave a 0-SKU husk. First brand wins.
  const importedSkusGlobal = new Set();

  for (const { brand, brandId, map } of loadedMaps) {
    const seriesEntries = Object.entries(map.series);
    await appendLog(pool, job.id, `Importing brand ${brand}: ${seriesEntries.length} series…`);

    for (let si = 0; si < seriesEntries.length; si++) {
      const [seriesName, seriesData] = seriesEntries[si];

      // Process main products (series + color)
      for (const [colorName, colorData] of Object.entries(seriesData.products)) {
        try {
          await processProduct(pool, {
            vendorId, brandName: brand, brandId, seriesName, colorName, colorData,
            category: seriesData.category, catMap,
            ediLookup, ediFuzzy, stats, isAccessory: false,
            snapBySlug, snapByName, nameKey, importedSkusGlobal,
          });
        } catch (err) {
          stats.errors++;
          if (stats.errors <= 50) {
            await addJobError(pool, job.id, `${seriesName} / ${colorName}: ${err.message}`);
          }
        }
      }

      // Process accessories
      for (const [accName, accData] of Object.entries(seriesData.accessories)) {
        try {
          await processProduct(pool, {
            vendorId, brandName: brand, brandId, seriesName, colorName: accName, colorData: accData,
            category: seriesData.category, catMap,
            ediLookup, ediFuzzy, stats, isAccessory: true,
            snapBySlug, snapByName, nameKey, importedSkusGlobal,
          });
        } catch (err) {
          stats.errors++;
          if (stats.errors <= 50) {
            await addJobError(pool, job.id, `${seriesName} / ${accName} (acc): ${err.message}`);
          }
        }
      }

      // Progress log every 20 series
      if ((si + 1) % 20 === 0 || si === seriesEntries.length - 1) {
        await appendLog(pool, job.id,
          `[${brand}] ${si + 1}/${seriesEntries.length} series — ` +
          `products: ${stats.productsCreated + stats.productsUpdated}, ` +
          `SKUs: ${stats.skusCreated + stats.skusUpdated}, ` +
          `images: ${stats.imagesSet}, EDI matches: ${stats.ediMatches}`,
          { products_found: si + 1, products_updated: stats.productsCreated + stats.productsUpdated }
        );
      }
    }
  }

  // Final summary
  await appendLog(pool, job.id,
    `Complete. Products: ${stats.productsCreated} new + ${stats.productsUpdated} updated. ` +
    `SKUs: ${stats.skusCreated} new + ${stats.skusUpdated} updated. ` +
    `Images: ${stats.imagesSet}. Attributes: ${stats.attributesSet}. ` +
    `Pricing: ${stats.pricingSet}. Packaging: ${stats.packagingSet}. ` +
    `EDI matches: ${stats.ediMatches}/${stats.ediMatches + stats.ediMisses} (${stats.ediFuzzyMatches || 0} fuzzy). ` +
    `SEO carried over: ${stats.seoCarried}. Errors: ${stats.errors}.`,
    {
      products_created: stats.productsCreated,
      products_updated: stats.productsUpdated,
      skus_created: stats.skusCreated,
    }
  );
}

// ─── Process a single product (series + color) ──────────────────────────────

async function processProduct(pool, ctx) {
  const {
    vendorId, brandName, brandId, seriesName, colorName, colorData,
    category, catMap, ediLookup, ediFuzzy, stats, isAccessory,
    snapBySlug, snapByName, nameKey, importedSkusGlobal,
  } = ctx;

  // Product name: brand-prefixed to match the storewide convention
  // ("Daltile Keystones Berry Blend", "American Olean Color Story Floor Matte Shadow").
  const baseName = isAccessory
    ? `${seriesName} Trim & Accessories`
    : `${seriesName} ${colorName}`;
  const productName = brandName ? `${brandName} ${baseName}` : baseName;

  // Resolve category per-product from SKU-level productType/bodyType.
  // Accessory bundles ("X Trim & Accessories") always live in trim-accessories —
  // their SKUs are all trim productTypes, which resolveProductCategory ignores,
  // so they'd otherwise fall through to the porcelain-tile default and pollute
  // the tile browse grids.
  const categoryId = isAccessory
    ? (catMap['trim-accessories'] || null)
    : resolveProductCategory(colorData.skus || [], seriesName, catMap);
  const categorySlug = Object.keys(catMap).find(sl => catMap[sl] === categoryId) || null;

  // Upsert product: conflict key is (vendor_id, collection, name)
  const productRow = await upsertProduct(pool, {
    vendor_id: vendorId,
    name: productName,
    collection: seriesName,
    category_id: categoryId,
    brand_id: brandId || null,
  });
  const productId = productRow.id;
  if (productRow.is_new) stats.productsCreated++;
  else stats.productsUpdated++;

  // Slug: unprefixed "{series}-{color}" per the live URL convention. The
  // brand-prefixed name would otherwise make base.js build a
  // "keystones-daltile-keystones-…" slug (the historical doubled-slug bug), so
  // set it explicitly, deduping with numeric suffixes on cross-vendor collisions.
  const desiredSlug = slugify(baseName);
  let finalSlug = null;
  if (desiredSlug) {
    for (const candidate of [desiredSlug, `${desiredSlug}-2`, `${desiredSlug}-3`]) {
      try {
        await pool.query(
          `UPDATE products SET slug = $1 WHERE id = $2 AND slug IS DISTINCT FROM $1`,
          [candidate, productId]
        );
        finalSlug = candidate;
        break;
      } catch (err) {
        if (err.code !== '23505') throw err; // keep trying only on slug collisions
      }
    }
  }

  // Carry over paid SEO content (+ nothing else) from the pre-wipe snapshot,
  // matched by slug first, then by normalized name.
  const snap = (finalSlug && snapBySlug?.get(finalSlug)) || snapByName?.get(nameKey(productName)) || null;
  if (snap && (snap.meta_title || snap.meta_description || snap.seo_h1 || snap.content_html)) {
    await pool.query(`
      UPDATE products SET
        meta_title = COALESCE($1, meta_title),
        meta_description = COALESCE($2, meta_description),
        seo_h1 = COALESCE($3, seo_h1),
        content_html = COALESCE($4, content_html),
        content_status = CASE WHEN $4 IS NOT NULL THEN $5 ELSE content_status END,
        content_hash = COALESCE($6, content_hash)
      WHERE id = $7`,
      [snap.meta_title, snap.meta_description, snap.seo_h1,
       snap.content_html, snap.content_status, snap.content_hash, productId]);
    stats.seoCarried++;
  }

  // Process each SKU variant
  for (const sku of colorData.skus) {
    const coveoSku = sku.coveoSku;
    if (!coveoSku) continue;

    const internalSku = makeInternalSku(coveoSku);
    // Cross-listed SKU already imported this run (americanolean.com re-lists
    // some Daltile items under the same SKU code) — first brand wins. A second
    // upsert would silently move the SKU onto the later brand's product and
    // leave the first as a 0-SKU husk.
    if (importedSkusGlobal.has(internalSku)) continue;
    importedSkusGlobal.add(internalSku);
    const isTrim = isAccessory || isTrimProductType(sku.productType);

    // Build variant name from size + finish + pattern
    // Coveo may return multi-size values like "12X24, 3X24" — use only the first size
    let skuSize = sku.size || '';
    if (skuSize.includes(',')) {
      skuSize = skuSize.split(',')[0].trim();
    }
    // Mosaic piece sizes come through as a bare number ("2" = 2-inch pieces) —
    // render with an inch mark so the variant reads "2\", Honed, Hexagon".
    if (/^\d+(\.\d+)?$/.test(skuSize)) skuSize = `${skuSize}"`;
    // Accessory buckets lump every trim piece of a color under one product
    // ("Color Wheel Classic Trim & Accessories"), so the color and the trim
    // profile (Bullnose / Cove Base / Quarter Round — only encoded in the
    // vendor SKU) are what tell 50+ SKUs apart. Lead with the color and append
    // the decoded profile, mirroring the old 832 naming.
    const accColor = isAccessory ? colorName.replace(/\s+Trim$/i, '').trim() : null;
    // Skip SKU-code trim decoding for Liners — liner codes (S1/2…) false-match
    // the bullnose pattern, producing "Liner, Bullnose" contradictions.
    const skuDescriptors = (isTrim && sku.shape !== 'Liner') ? daltileSkuDescriptors(coveoSku) : [];
    let variantParts = [accColor, skuSize, sku.finish, sku.designPattern, sku.shape].filter(Boolean);
    for (const d of skuDescriptors) {
      if (!variantParts.join(' ').toLowerCase().includes(d.toLowerCase())) variantParts.push(d);
    }
    // Coveo sometimes echoes the same word in designPattern and shape
    // ("Liner, Liner") — keep first occurrence only.
    const seenParts = new Set();
    variantParts = variantParts.filter(pt => {
      const k = pt.toLowerCase();
      if (seenParts.has(k)) return false;
      seenParts.add(k); return true;
    });
    let variantName = variantParts.join(', ') || colorName;

    // State the mosaic layout (Brick Joint, Penny Round, …) when Coveo left
    // designPattern blank — decoded from the vendor_sku shape code. Shared with
    // the one-time enrichment script so imports and backfills agree.
    const mosaicPattern = resolveMosaicPattern({
      vendorSku: coveoSku,
      imageUrl: sku.productImageUrl,
      currentName: variantName,
      productType: sku.productType,
      productName,
    });
    if (mosaicPattern) variantName = `${variantName}, ${mosaicPattern}`;

    // Determine sell_by
    let sellBy = isTrim ? 'unit' : 'box';

    // Trim/accessory SKUs are marked variant_type='accessory' — the storewide
    // convention (attach-daltile-accessories.cjs keys on it to build
    // sku_accessories links, and browse/PDP default-SKU queries exclude it so
    // trim pieces surface on parent tile PDPs instead of the browse grid).
    const variantType = isTrim ? 'accessory' : null;

    // Match EDI data — try exact first, then fuzzy (colorCode + dimensions)
    const coveoKey = coveoSku.toUpperCase();
    let ediItem = ediLookup.get(coveoKey);
    if (!ediItem && ediFuzzy) {
      const colorPrefix = coveoKey.slice(0, 4);
      const dims = coveoKey.match(/(\d{3,4})/g);
      if (dims) {
        const fuzzyKey = `${colorPrefix}:${dims.sort().join(',')}`;
        const candidates = ediFuzzy.get(fuzzyKey);
        if (candidates && candidates.length > 0) {
          ediItem = candidates[0]; // Use first match (same color + dims = same price)
          stats.ediFuzzyMatches = (stats.ediFuzzyMatches || 0) + 1;
        }
      }
    }
    if (ediItem) {
      stats.ediMatches++;
      // Only let EDI override sell_by for trims — regular tiles are always box
      if (ediItem.sell_by && isTrim) sellBy = ediItem.sell_by;
      // Refresh the persistent live↔EDI crosswalk so the 6-hourly
      // daltile-edi-overlay keeps repricing this SKU after the re-onboard.
      const wasFuzzy = !ediLookup.get(coveoKey);
      await pool.query(`
        INSERT INTO daltile_edi_map (live_vendor_sku, edi_vendor_sku, confidence, method, updated_at)
        VALUES ($1, $2, $3, 'unified-import', now())
        ON CONFLICT (live_vendor_sku) DO UPDATE SET
          edi_vendor_sku = EXCLUDED.edi_vendor_sku,
          confidence = EXCLUDED.confidence,
          method = EXCLUDED.method,
          updated_at = now()`,
        [coveoSku, ediItem.vendor_sku, wasFuzzy ? 'fuzzy' : 'exact']);
    } else {
      stats.ediMisses++;
    }

    // ── Pricing (from EDI) — computed BEFORE the SKU upsert so the per-sheet
    // rule for mosaics / stacked stone can also drive sell_by. ──
    let priceCost = null, priceRetail = null;
    if (ediItem && (ediItem.cost || ediItem.retail_price)) {
      let cost = parseFloat(ediItem.cost) || 0;
      let retail = parseFloat(ediItem.retail_price) || 0;
      // When EDI has no list price (ST), retail_price = cost (0% margin).
      // Apply markup to derive a retail price from cost.
      if (!retail || (cost > 0 && Math.abs(retail - cost) < 0.01)) {
        retail = retailFromCost(cost);
      }
      // Detect per-piece prices mislabeled as per-sqft: if sell_by is box, price > $30,
      // and no sqft_per_box to trigger the 832 parser's detection, compute sqft from tile dims
      if (sellBy === 'box' && cost > 30 && !ediItem.sqft_per_box) {
        const sizeMatch = (sku.size || '').match(/^(\d+)X(\d+)$/i);
        if (sizeMatch) {
          const sqftPerPiece = (parseInt(sizeMatch[1]) * parseInt(sizeMatch[2])) / 144;
          if (sqftPerPiece >= 1) {
            const adjCost = cost / sqftPerPiece;
            if (adjCost >= 2 && adjCost <= 50) {
              cost = parseFloat(adjCost.toFixed(2));
              retail = parseFloat((retail / sqftPerPiece).toFixed(2));
            }
          }
        }
      }
      priceCost = cost;
      priceRetail = retail;
    }

    // Mosaics / stacked stone sell per sheet, not by the box — convert the
    // per-sqft price to a per-sheet price from EDI packaging (see
    // selling-conventions). Ambiguous boxes (no piece count) stay as boxes.
    const sheet = applySheetSelling({
      categorySlug, sellBy, name: `${seriesName} ${colorName} ${variantName}`,
      sqft_per_box: ediItem?.sqft_per_box, pieces_per_box: ediItem?.pieces_per_box,
      cost: priceCost, retail_price: priceRetail,
    });
    sellBy = sheet.sellBy;

    // Upsert SKU
    const skuRow = await upsertSku(pool, {
      product_id: productId,
      vendor_sku: coveoSku,
      internal_sku: internalSku,
      variant_name: variantName,
      sell_by: sellBy,
      variant_type: variantType,
    });
    const skuId = skuRow.id;
    if (skuRow.is_new) stats.skusCreated++;
    else stats.skusUpdated++;

    // ── Media assets (per-SKU) ──
    // Clean DAM URLs: upgrade TIF/170x170 renditions to web-quality JPEG
    const cleanImageUrl = (url) => {
      if (!url) return null;
      if (url.includes('digitalassets.daltile.com') && url.includes('/jcr:content/renditions/')) {
        return url.replace(/\/jcr:content\/renditions\/[^/]+$/, '/jcr:content/renditions/cq5dam.web.1280.1280.jpeg');
      }
      return url;
    };

    // Primary: prefer the authoritative product render; fall back to the swatch
    // when it is missing/placeholder so the SKU still gets an image (never store
    // a placeholder). Shared with the reconcile script so imports stay consistent.
    const primaryUrl = pickPrimaryImage({
      productImageUrl: sku.productImageUrl,
      swatchUrl: sku.swatchUrl,
    });
    if (primaryUrl) {
      await upsertMediaAsset(pool, {
        product_id: productId, sku_id: skuId,
        asset_type: 'primary', url: primaryUrl,
        original_url: primaryUrl, sort_order: 0,
      });
      stats.imagesSet++;
    }
    if (sku.swatchUrl) {
      const swUrl = cleanImageUrl(sku.swatchUrl);
      await upsertMediaAsset(pool, {
        product_id: productId, sku_id: skuId,
        asset_type: 'swatch', url: swUrl,
        original_url: sku.swatchUrl, sort_order: 0,
      });
      stats.imagesSet++;
    }
    if (sku.roomSceneUrl) {
      const rsUrl = cleanImageUrl(sku.roomSceneUrl);
      await upsertMediaAsset(pool, {
        product_id: productId, sku_id: skuId,
        asset_type: 'lifestyle', url: rsUrl,
        original_url: sku.roomSceneUrl, sort_order: 0,
      });
      stats.imagesSet++;
    }

    // ── Attributes ──
    const cleanedColor = colorName;
    const attrPairs = [
      ['color', cleanedColor],
      ['size', sku.size],
      ['finish', sku.finish],
      ['material', sku.bodyType],
      ['shape', sku.shape],
      ['country', sku.country],
      ['shade_variation', sku.shadeVariation],
      ['thickness', sku.thickness],
      ['pattern', sku.designPattern || mosaicPattern],
    ];
    for (const [slug, value] of attrPairs) {
      if (value) {
        await upsertSkuAttribute(pool, skuId, slug, value);
        stats.attributesSet++;
      }
    }
    if (ediItem?.upc) {
      await upsertSkuAttribute(pool, skuId, 'upc', ediItem.upc);
      stats.attributesSet++;
    }

    // ── Pricing (computed above, converted to per-sheet where applicable) ──
    if (priceCost !== null || priceRetail !== null) {
      await upsertPricing(pool, skuId, {
        cost: sheet.cost,
        retail_price: sheet.retail_price,
        price_basis: sheet.priceBasis,
        map_price: ediItem?.map_price || null,
      }, { coveringFloor: sheet.coveringFloor });
      stats.pricingSet++;
    }

    // ── Packaging (from EDI) ──
    if (ediItem && (ediItem.sqft_per_box || ediItem.pieces_per_box || ediItem.weight_per_box_lbs)) {
      const sqftPerPallet = (ediItem.boxes_per_pallet && ediItem.sqft_per_box)
        ? ediItem.boxes_per_pallet * ediItem.sqft_per_box : null;
      await upsertPackaging(pool, skuId, {
        sqft_per_box: ediItem.sqft_per_box || null,
        pieces_per_box: ediItem.pieces_per_box || null,
        weight_per_box_lbs: ediItem.weight_per_box_lbs || null,
        boxes_per_pallet: ediItem.boxes_per_pallet || null,
        sqft_per_pallet: sqftPerPallet,
      });
      stats.packagingSet++;
    }
  }
}
