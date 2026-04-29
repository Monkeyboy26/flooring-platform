/**
 * MSI Surfaces — Unified Pipeline
 *
 * Single script that replaces 50+ files (7 scrapers + 40+ post-processing scripts).
 * Runnable standalone or via scraper framework.
 *
 * Phases:
 *   1. Delete all existing MSI data (products, SKUs, media, pricing, etc.)
 *   2. EDI 832 import (FTP → parse → group → upsert)
 *   3. Per-SKU images (CDN probing + Puppeteer enrichment)
 *   4. Product map JSON
 *   5. Accessory attachment (trim → parent flooring)
 *
 * Usage:
 *   node backend/scrapers/msi-unified.js                # Full pipeline
 *   node backend/scrapers/msi-unified.js --skip-delete   # Skip Phase 1
 *   node backend/scrapers/msi-unified.js --skip-images   # Skip Phase 3
 *   node backend/scrapers/msi-unified.js --skip-puppeteer # CDN only, no browser
 *   node backend/scrapers/msi-unified.js --dry-run        # Preview deletes only
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { Client: FtpClient } = require('basic-ftp');

import fs from 'fs';
import path from 'path';
import https from 'https';
import { fileURLToPath } from 'url';

import {
  launchBrowser, delay,
  upsertProduct, upsertSku, upsertSkuAttribute,
  upsertPackaging, upsertPricing,
  upsertMediaAsset, saveSkuImages,
  preferProductShot, isLifestyleUrl, filterImageUrls,
  appendLog, addJobError,
} from './base.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ═══════════════════════════════════════════════════════════════════════════════
// CLI flags
// ═══════════════════════════════════════════════════════════════════════════════

const SKIP_EDI       = process.argv.includes('--skip-edi');
const SKIP_IMAGES    = process.argv.includes('--skip-images');
const SKIP_PUPPETEER = process.argv.includes('--skip-puppeteer');
const DRY_RUN        = process.argv.includes('--dry-run');
const VERBOSE        = process.argv.includes('--verbose');

// ═══════════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════════

const VENDOR_CODE = 'MSI';
const CDN = 'https://cdn.msisurfaces.com/images';

const DEFAULT_FTP = {
  host: 'cftp.msisurfaces.com',
  port: 21,
  user: 'ROMAFLO',
};

const REMOTE_DIRS = ['/out', '/in', '/'];

// ─── Category mapping ────────────────────────────────────────────────────────

const CATEGORY_MAP = {
  'porcelain': 'tile', 'porcelain tile': 'tile', 'ceramic': 'tile',
  'ceramic tile': 'tile', 'tile': 'tile', 'floor tile': 'tile',
  'wall tile': 'tile', 'wood look tile': 'tile', 'large format': 'tile',
  'natural stone': 'natural-stone', 'stone': 'natural-stone',
  'marble': 'natural-stone', 'travertine': 'natural-stone',
  'slate': 'natural-stone', 'granite': 'natural-stone',
  'limestone': 'natural-stone', 'quartzite': 'natural-stone',
  'onyx': 'natural-stone', 'sandstone': 'natural-stone',
  'mosaic': 'mosaic', 'glass': 'mosaic', 'glass tile': 'mosaic',
  'glass mosaic': 'mosaic', 'stone mosaic': 'mosaic',
  'metal mosaic': 'mosaic', 'decorative': 'mosaic',
  'stacked stone': 'stacked-stone', 'ledger panel': 'stacked-stone',
  'ledger': 'stacked-stone', 'stacked stone panel': 'stacked-stone',
  'luxury vinyl': 'luxury-vinyl', 'luxury vinyl plank': 'luxury-vinyl',
  'luxury vinyl tile': 'luxury-vinyl', 'lvp': 'luxury-vinyl',
  'lvt': 'luxury-vinyl', 'spc': 'luxury-vinyl', 'wpc': 'luxury-vinyl',
  'vinyl plank': 'luxury-vinyl', 'vinyl tile': 'luxury-vinyl',
  'rigid core': 'luxury-vinyl',
  'hardwood': 'hardwood', 'engineered hardwood': 'hardwood',
  'engineered wood': 'hardwood', 'wood flooring': 'hardwood',
  'quartz': 'countertops', 'quartz countertop': 'countertops',
  'quartz countertops': 'countertops', 'granite countertop': 'countertops',
  'granite countertops': 'countertops', 'marble countertop': 'countertops',
  'marble countertops': 'countertops', 'countertop': 'countertops',
  'countertops': 'countertops', 'slab': 'countertops', 'slabs': 'countertops',
  'prefab': 'countertops', 'prefab countertop': 'countertops',
  'outdoor': 'outdoor', 'paver': 'outdoor', 'pavers': 'outdoor',
  'pool tile': 'outdoor', 'pool coping': 'outdoor',
  'turf': 'outdoor', 'artificial turf': 'outdoor',
  'grout': 'installation-sundries', 'setting material': 'installation-sundries',
  'setting materials': 'installation-sundries', 'caulk': 'installation-sundries',
  'sealant': 'installation-sundries', 'adhesive': 'installation-sundries',
  'mortar': 'installation-sundries', 'backer board': 'installation-sundries',
  'membrane': 'installation-sundries', 'accessory': 'installation-sundries',
  'accessories': 'installation-sundries', 'trim': 'installation-sundries',
  'molding': 'installation-sundries', 'bullnose': 'installation-sundries',
  'quarter round': 'installation-sundries', 'underlayment': 'installation-sundries',
  'threshold': 'installation-sundries', 'transition': 'installation-sundries',
};

const MAC_CATEGORY_MAP = {
  PORTILR: 'tile', PORTILC: 'tile', CERTILR: 'tile', CERTILC: 'tile',
  STNTILR: 'natural-stone', STNTILC: 'natural-stone',
  MOSTILR: 'mosaic', MOSTILC: 'mosaic', GLSTILR: 'mosaic', GLSTILC: 'mosaic',
  VINTILR: 'luxury-vinyl', VINTILC: 'luxury-vinyl',
  VINFLR: 'luxury-vinyl', SPCFLR: 'luxury-vinyl', WPCFLR: 'luxury-vinyl',
  HRDWDR: 'hardwood', HRDWDC: 'hardwood', ENGWDR: 'hardwood', ENGWDC: 'hardwood',
  QRTZSL: 'countertops', GRNSL: 'countertops', MRBSL: 'countertops',
  SLBQTZ: 'countertops', SLBGRN: 'countertops', SLBMRB: 'countertops',
  PREFAB: 'countertops',
  STKSTL: 'stacked-stone', STKSTC: 'stacked-stone', LDGPNL: 'stacked-stone',
  PAVTIL: 'outdoor', OUTDOR: 'outdoor', ARTTURF: 'outdoor',
  SETMTL: 'installation-sundries', GRTCAU: 'installation-sundries',
  TRMACC: 'installation-sundries', VINMISR: 'installation-sundries',
};

// ─── EDI lookup tables ───────────────────────────────────────────────────────

const PID_CODES = {
  '08': 'description', GEN: 'category', '09': 'sub_product',
  '73': 'color', '74': 'pattern', '75': 'finish', '35': 'dye_code',
  '37': 'material', '38': 'style', DIM: 'dimensions', MAC: 'material_class',
  TRN: 'trade_name', '12': 'quality', '77': 'collection',
};

const LIN_QUALIFIERS = {
  UP: 'upc', VN: 'vendor_item_number', SK: 'sku', MG: 'manufacturer_group',
  BP: 'buyer_part_number', IN: 'buyer_item_number', MN: 'model_number',
  GN: 'generic_name', UA: 'upc_case_code', CB: 'catalog_number',
  FS: 'standard_number', EC: 'ean', EN: 'ean', UK: 'upc_shipping',
  PI: 'purchaser_item', PN: 'part_number', VA: 'vendor_alpha',
  GS: 'style_number', ST: 'style_code',
};

const MEA_CODES = {
  TH: 'thickness', WD: 'width', LN: 'length', WT: 'weight',
  WL: 'wear_layer', HT: 'height', SQ: 'area', SU: 'surface_area',
  SW: 'shipping_weight',
};

// ─── Trim code tables (shared by Phase 2 grouping + Phase 5 attachment) ─────

const TRIM_NAMES = {
  'FSNL-EE': 'Flush Stair Nose Long', 'FSN-EE': 'Flush Stair Nose',
  'ST-EE': 'Stair Tread', 'T-SR': 'T-Molding Reducer',
  '4-IN-1': '4-in-1 Transition', 'FSNL': 'Flush Stair Nose Long',
  'FSN': 'Flush Stair Nose', 'OSN': 'Overlapping Stair Nose',
  'SRL': 'Reducer Long', 'ECL': 'End Cap Long', 'EC': 'End Cap',
  'QR': 'Quarter Round', 'SR': 'Reducer', 'ST': 'Stair Tread',
  'RT': 'Riser Tread', 'T': 'T-Molding',
};

const _trimCodeAlt = Object.keys(TRIM_NAMES)
  .sort((a, b) => b.length - a.length)
  .map(c => c.replace(/-/g, '\\-'))
  .join('|');
const TRIM_CODE_REGEX = new RegExp(`-(${_trimCodeAlt})$`, 'i');

// Merge regex for Phase 2 grouping
const TRIM_CODES_FOR_MERGE = [
  'fsnl', 'ecl', 't-sr', '4-in-1',
  'fsn', 'osn', 'srl', 'ec', 'qr', 'sr', 'st', 'rt', 't',
];
const _mergeAlt = TRIM_CODES_FOR_MERGE.map(c => c.replace(/-/g, '\\-')).join('|');
const TRIM_MERGE_REGEX = new RegExp(
  `^(.+?)\\s+(${_mergeAlt})(-ee|-sr|-w)?\\s+[\\d.]+"?\\s*$`, 'i'
);

// Suffix names for tile/stone accessories (Phase 5)
const SUFFIX_NAMES = {
  'COR': 'Corner Piece', '3DH': 'Corner Piece',
  'BN': 'Bullnose', 'BNG': 'Bullnose', 'BNP': 'Bullnose Polished',
  'SB': 'Stair Bullnose', 'SB3': 'Stair Bullnose',
};


// ═══════════════════════════════════════════════════════════════════════════════
//  PHASE 1 — Delete All MSI Data
// ═══════════════════════════════════════════════════════════════════════════════

// Phase 1 (bulk delete) has been permanently removed to prevent accidental data loss.
// Use manual SQL or a separate maintenance script if you need to delete vendor data.


// ═══════════════════════════════════════════════════════════════════════════════
//  PHASE 2 — EDI 832 Import
// ═══════════════════════════════════════════════════════════════════════════════

// ─── EDI Parsing ─────────────────────────────────────────────────────────────

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

function parsePO4(seg) {
  return {
    pack: seg.el[1] || null,
    size_per_pack: seg.el[2] ? parseFloat(seg.el[2]) : null,
    unit_of_measure: seg.el[3] || null,
    packaging_code: seg.el[4] || null,
    weight_qualifier: seg.el[5] || null,
    gross_weight: seg.el[6] ? parseFloat(seg.el[6]) : null,
    weight_uom: seg.el[7] || null,
    pieces_per_pack: seg.el[14] ? parseInt(seg.el[14], 10) : null,
    packs_per_pallet: seg.el[17] ? parseInt(seg.el[17], 10) : null,
  };
}

function parseCTP(seg) {
  return {
    class_of_trade: seg.el[1] || null,
    price_type: seg.el[2] || null,
    unit_price: seg.el[3] ? parseFloat(seg.el[3]) : null,
    quantity: seg.el[4] ? parseFloat(seg.el[4]) : null,
    unit_of_measure: seg.el[5] || null,
    basis_code: seg.el[9] || null,
  };
}

function parsePID(seg) {
  return {
    description_type: seg.el[1] || null,
    characteristic_code: seg.el[2] || null,
    characteristic_label: PID_CODES[seg.el[2]] || seg.el[2] || null,
    description: seg.el[5] || null,
  };
}

function parseMEA(seg) {
  return {
    qualifier: seg.el[2] || null,
    qualifier_label: MEA_CODES[seg.el[2]] || seg.el[2] || null,
    value: seg.el[3] ? parseFloat(seg.el[3]) : null,
    unit_of_measure: seg.el[4] || null,
  };
}

function parseSLN(seg) {
  const result = { sub_line_number: seg.el[1] || null, relationship_code: seg.el[3] || null, identifiers: {} };
  for (let i = 9; i < seg.el.length - 1; i += 2) {
    const qual = seg.el[i], val = seg.el[i + 1];
    if (qual && val) result.identifiers[LIN_QUALIFIERS[qual] || qual.toLowerCase()] = val;
  }
  return result;
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

function makeNewItem(lineNumber) {
  return {
    line_number: lineNumber, identifiers: {},
    descriptions: [], packaging: null, pricing: [], measurements: [],
    vendor_sku: null, upc: null, product_name: null, color: null,
    collection: null, category: null, cost: null, retail_price: null,
    unit_of_measure: null, sqft_per_box: null, pieces_per_box: null,
    weight_per_box_lbs: null, sell_by: null,
    cut_price: null, roll_price: null, cut_cost: null, roll_cost: null,
    roll_min_sqft: null, roll_width_ft: null, map_price: null,
  };
}

function cleanProductName(raw) {
  if (!raw) return null;
  let name = raw
    .replace(/\s*\([^)]*sq(?:ft|yd)[^)]*\)/gi, '')
    .replace(/\s+\d+\.?\d*[xX]\d+\.?\d*/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  name = name.replace(/\b\w+/g, w =>
    w.length <= 3 && /^(i{1,3}|ii|iv|v|vi|vii|viii|ix|x|spc|lvp|lvt|wpc)$/i.test(w)
      ? w.toUpperCase()
      : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
  );
  return name || null;
}

function finalizeItem(item) {
  if (!item.vendor_sku) {
    item.vendor_sku = item.identifiers.vendor_item_number
      || item.identifiers.model_number || item.identifiers.sku
      || item.identifiers.part_number || null;
  }
  item.upc = item.identifiers.upc || null;

  const trnPid = item.descriptions.find(d => d.characteristic_code === 'TRN');
  if (trnPid) {
    item.product_name = cleanProductName(trnPid.description);
  } else {
    const descPid = item.descriptions.find(d =>
      d.characteristic_code === '08' && d.description && !/^\d+-[A-Z0-9]+-\d+-/.test(d.description)
    ) || item.descriptions.find(d => d.description_type === 'F' && d.characteristic_code !== '08');
    item.product_name = descPid ? cleanProductName(descPid.description) : null;
  }

  const colorPid = item.descriptions.find(d => d.characteristic_label === 'color');
  item.color = colorPid ? colorPid.description : null;

  const collPid = item.descriptions.find(d => d.characteristic_label === 'collection');
  item.collection = collPid ? collPid.description : null;

  const catPid = item.descriptions.find(d => d.characteristic_label === 'category' || d.characteristic_code === 'GEN');
  if (catPid) {
    item.category = catPid.description;
  } else {
    const macPid = item.descriptions.find(d => d.characteristic_code === 'MAC');
    if (macPid && macPid.description) {
      item.category = MAC_CATEGORY_MAP[macPid.description.toUpperCase()] || macPid.description;
    }
  }

  // MEA SU → sqft_per_box
  const surfMea = item.measurements.find(m => m.qualifier === 'SU');
  if (surfMea && surfMea.value) {
    const suUom = (surfMea.unit_of_measure || '').toUpperCase();
    if (suUom === 'SF' || suUom === 'FT2') {
      item.sqft_per_box = surfMea.value;
      if (!item.sell_by) item.sell_by = 'sqft';
    } else if (suUom === 'SY') {
      item.sqft_per_box = surfMea.value * 9;
      if (!item.sell_by) item.sell_by = 'sqft';
    } else if (suUom === 'EA') {
      if (!item.sell_by) item.sell_by = 'unit';
    }
  }

  // Packaging (PO4)
  if (item.packaging) {
    const uom = (item.packaging.unit_of_measure || '').toUpperCase();
    if (!item.sqft_per_box) {
      if (uom === 'SF' || uom === 'FT2') { item.sqft_per_box = item.packaging.size_per_pack; if (!item.sell_by) item.sell_by = 'sqft'; }
      else if (uom === 'SY') { item.sqft_per_box = item.packaging.size_per_pack * 9; if (!item.sell_by) item.sell_by = 'sqft'; }
      else if (uom === 'EA' || uom === 'PC') { if (!item.sell_by) item.sell_by = 'unit'; }
      else if (uom === 'LF') { if (!item.sell_by) item.sell_by = 'unit'; }
      else if (item.packaging.size_per_pack) { item.sqft_per_box = item.packaging.size_per_pack; if (!item.sell_by) item.sell_by = 'sqft'; }
    }
    item.pieces_per_box = item.packaging.pieces_per_pack || null;
    item.weight_per_box_lbs = item.packaging.gross_weight || null;
  }

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
    const netPrice = item.pricing.find(p => p.price_type === 'NET') || item.pricing.find(p => p.class_of_trade === 'WS') || item.pricing.find(p => p.class_of_trade === 'DE') || item.pricing[0];
    if (netPrice) { item.cost = netPrice.unit_price; item.unit_of_measure = netPrice.unit_of_measure || item.unit_of_measure; }
    const retailPrice = item.pricing.find(p => p.price_type === 'MSR') || item.pricing.find(p => p.class_of_trade === 'RS') || item.pricing.find(p => p.price_type === 'CAT');
    if (retailPrice) item.retail_price = retailPrice.unit_price;
    const mapPrice = item.pricing.find(p => p.price_type === 'MAP');
    if (mapPrice) item.map_price = mapPrice.unit_price;
  }

  // SY → SF conversion
  if (item.unit_of_measure && item.unit_of_measure.toUpperCase() === 'SY') {
    if (item.cost) item.cost = parseFloat((item.cost / 9).toFixed(4));
    if (item.retail_price) item.retail_price = parseFloat((item.retail_price / 9).toFixed(4));
    item.unit_of_measure = 'SF';
  }

  if (!item.sell_by && item.unit_of_measure) {
    const puom = item.unit_of_measure.toUpperCase();
    if (puom === 'SF' || puom === 'SY') item.sell_by = 'sqft';
    else if (puom === 'EA' || puom === 'PC') item.sell_by = 'unit';
  }

  const nameAndCat = `${item.product_name || ''} ${item.category || ''}`.toLowerCase();
  if (/countertop|slab|prefab/i.test(nameAndCat)) item.sell_by = 'unit';
  if (/trim|bullnose|quarter\s*round|grout|caulk|setting\s*material|mortar|adhesive|sealant|membrane|pencil\s*liner|chair\s*rail|v-cap|mud\s*cap|jolly|schluter|threshold|transition|molding|stair\s*nose|reducer|t-mold/i.test(nameAndCat)) {
    if (!item.sell_by) item.sell_by = 'unit';
  }
}

function parse832(raw) {
  const segments = tokenizeSegments(raw).map(parseSegment);
  const catalog = { items: [], summary: { total_items: 0, segment_count: segments.length } };
  let currentItem = null;
  let productContext = null;
  let hadSLN = false;

  function flushCurrentItem() {
    if (!currentItem) return;
    if (productContext) mergeProductContext(currentItem, productContext);
    finalizeItem(currentItem);
    catalog.items.push(currentItem);
    currentItem = null;
  }

  function flushProduct() {
    if (hadSLN && currentItem) {
      flushCurrentItem();
    } else if (currentItem && !hadSLN) {
      finalizeItem(currentItem);
      catalog.items.push(currentItem);
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
        currentItem = makeNewItem(lin.line_number);
        currentItem.identifiers = lin.identifiers;
        break;
      }
      case 'SLN': {
        if (!hadSLN && currentItem) {
          productContext = {
            line_number: currentItem.line_number,
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
        currentItem = makeNewItem(productContext ? productContext.line_number : null);
        currentItem.identifiers = sln.identifiers;
        currentItem.vendor_sku = sln.identifiers.sku || null;
        break;
      }
      case 'PO4': {
        const target = productContext || currentItem;
        if (target) target.packaging = parsePO4(seg);
        break;
      }
      case 'CTP': {
        const target = productContext || currentItem;
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
      case 'MTX': {
        const mtxText = seg.el[2] || null;
        if (mtxText && currentItem) {
          if (!currentItem.images) currentItem.images = [];
          currentItem.images.push({ type: seg.el[1] || null, url: mtxText });
        }
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
          if (seg.el[17]) {
            target.descriptions.push({ description_type: 'F', characteristic_code: '08', characteristic_label: 'description', description: seg.el[17] });
          }
          if (seg.el[9] && seg.el[10] && !target.packaging) {
            target.packaging = { size_per_pack: parseFloat(seg.el[9]), unit_of_measure: seg.el[10], pieces_per_pack: seg.el[11] ? parseInt(seg.el[11], 10) : null };
          }
        }
        break;
      }
      case 'CTT': case 'SE': {
        flushProduct();
        if (seg.id === 'CTT') catalog.summary.total_items = seg.el[1] ? parseInt(seg.el[1], 10) : catalog.items.length;
        break;
      }
      default: break;
    }
  }

  flushProduct();
  if (!catalog.summary.total_items) catalog.summary.total_items = catalog.items.length;
  return catalog;
}

// ─── Product Grouping ────────────────────────────────────────────────────────

function groupIntoProducts(items) {
  const products = new Map();

  for (const item of items) {
    if (!item.vendor_sku && !item.product_name) continue;
    const collection = item.collection || '';
    const category = item.category || '';
    const isAccessory = /accessory|sundries|trim|molding|bullnose|quarter\s*round|grout|caulk|setting\s*material|mortar|adhesive|sealant|membrane|pencil\s*liner|chair\s*rail|v-cap|mud\s*cap|jolly|schluter|threshold|transition|stair\s*nose|reducer|t-mold/i.test(category)
      || /accessory|sundries|trim|molding|bullnose|quarter\s*round|grout|caulk|setting\s*material|mortar|adhesive|sealant|membrane|pencil\s*liner|chair\s*rail|v-cap|mud\s*cap|jolly|schluter|threshold|transition|stair\s*nose|reducer|t-mold/i.test(item.product_name || '');

    let baseName = item.product_name || item.vendor_sku || 'Unknown';
    if (item.color && !isAccessory) {
      const colorWords = item.color.split(/\s+/);
      for (const word of colorWords) {
        if (word.length > 2) {
          baseName = baseName.replace(new RegExp('\\b' + word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i'), '').trim();
        }
      }
      baseName = baseName.replace(/\s{2,}/g, ' ').trim();
    }

    const key = `${collection}|||${baseName}|||${isAccessory ? 'acc' : 'main'}`;
    if (!products.has(key)) {
      products.set(key, { baseName, collection, category, isAccessory, items: [] });
    }
    products.get(key).items.push(item);
  }

  // Merge pass: fold trim-code accessory groups into parent main groups
  const nameOnlyIndex = new Map();
  for (const [key, group] of products) {
    if (key.endsWith('|||acc')) continue;
    const nameKey = group.baseName.toLowerCase().trim();
    if (!nameOnlyIndex.has(nameKey)) nameOnlyIndex.set(nameKey, group);
  }

  const keysToDelete = [];
  for (const [key, group] of products) {
    if (!key.endsWith('|||acc')) continue;
    const match = TRIM_MERGE_REGEX.exec(group.baseName);
    if (!match) continue;
    const parentBaseName = match[1].trim();
    const trimDesc = group.baseName.slice(parentBaseName.length).trim();
    const parentKey = `${group.collection}|||${parentBaseName}|||main`;
    const parentGroup = products.get(parentKey)
      || nameOnlyIndex.get(parentBaseName.toLowerCase().trim());
    if (!parentGroup) continue;
    for (const item of group.items) {
      item._isAccessory = true;
      item._trimDescription = trimDesc;
    }
    parentGroup.items.push(...group.items);
    keysToDelete.push(key);
  }

  for (const key of keysToDelete) products.delete(key);
  return Array.from(products.values());
}

function makeInternalSku(vendorSku, productName) {
  if (vendorSku) {
    return vendorSku.toUpperCase().startsWith('MSI-') ? vendorSku : `MSI-${vendorSku}`;
  }
  const slug = (productName || 'UNKNOWN').toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 30);
  return `MSI-${slug}`;
}

// ─── FTP ─────────────────────────────────────────────────────────────────────

function getConnConfig(source) {
  const cfg = (source && source.config) || {};
  return {
    host: cfg.ftp_host || process.env.MSI_FTP_HOST || DEFAULT_FTP.host,
    port: parseInt(cfg.ftp_port || process.env.MSI_FTP_PORT || DEFAULT_FTP.port, 10),
    user: cfg.ftp_user || process.env.MSI_FTP_USER || DEFAULT_FTP.user,
    password: cfg.ftp_pass || process.env.MSI_FTP_PASS || '',
    secure: cfg.ftp_secure || false,
  };
}

async function createTransport(connConfig) {
  const client = new FtpClient();
  client.ftp.verbose = false;
  await client.access({
    host: connConfig.host, port: connConfig.port,
    user: connConfig.user, password: connConfig.password,
    secure: connConfig.secure,
  });
  return {
    list: async (dir) => {
      const listing = await client.list(dir);
      return listing.filter(f => f.type === 1).map(f => ({
        name: f.name, size: f.size, modifiedAt: f.modifiedAt,
        remotePath: `${dir}/${f.name}`.replace('//', '/'),
      }));
    },
    download: async (remotePath, localPath) => {
      await client.downloadTo(localPath, remotePath);
    },
    close: () => client.close(),
  };
}

async function findRemote832Files(transport) {
  const allFiles = [];
  for (const dir of REMOTE_DIRS) {
    try {
      const files = await transport.list(dir);
      const matching = files.filter(f => {
        const name = f.name.toLowerCase();
        return name.includes('832') || name.includes('catalog') || name.includes('pricelist')
          || name.includes('price_catalog') || name.endsWith('.edi') || name.endsWith('.x12')
          || name.endsWith('.832') || name.endsWith('.txt') || name.endsWith('.dat');
      });
      allFiles.push(...matching);
    } catch { /* skip inaccessible dirs */ }
  }
  // Sort by size descending (largest file first = most complete catalog)
  allFiles.sort((a, b) => (b.size || 0) - (a.size || 0));
  return allFiles;
}

// ─── Phase 2 Main ────────────────────────────────────────────────────────────

async function phase2_edi832(pool, vendorId, source, log) {
  log('Phase 2: EDI 832 Import...');

  const connConfig = getConnConfig(source);
  log(`  Connecting to ${connConfig.host}:${connConfig.port} as ${connConfig.user}...`);

  let transport;
  const localPaths = [];

  try {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        transport = await createTransport(connConfig);
        break;
      } catch (err) {
        if (attempt === 3) throw err;
        log(`  FTP attempt ${attempt} failed: ${err.message}. Retrying...`);
        await delay(5000 * attempt);
      }
    }
    log('  FTP connected. Scanning for 832 files...');

    const remoteFiles = await findRemote832Files(transport);
    log(`  Found ${remoteFiles.length} candidate file(s)`);
    for (const f of remoteFiles) {
      log(`    ${f.remotePath} — ${(f.size / 1024).toFixed(1)}KB — ${f.modifiedAt ? f.modifiedAt.toISOString() : 'no date'}`);
    }

    if (remoteFiles.length === 0) {
      log('  No 832 files found. Cannot import.');
      return new Map();
    }

    // Download ALL available 832 files (incremental updates)
    for (const target of remoteFiles) {
      log(`  Downloading: ${target.remotePath} (${(target.size / 1024).toFixed(1)}KB)`);
      const lp = `/tmp/msi_832_${Date.now()}_${target.name}`;
      await transport.download(target.remotePath, lp);
      localPaths.push(lp);
    }
    log(`  Downloaded ${localPaths.length} files`);
  } finally {
    if (transport) try { transport.close(); } catch { }
  }

  // Parse all files and merge items
  log('  Parsing EDI 832 files...');
  let allItems = [];
  let totalSegments = 0;
  for (const lp of localPaths) {
    const raw = fs.readFileSync(lp, 'utf-8');
    const catalog = parse832(raw);
    log(`    ${path.basename(lp)}: ${catalog.items.length} items, ${catalog.summary.segment_count} segments`);
    allItems.push(...catalog.items);
    totalSegments += catalog.summary.segment_count;
    // Cleanup temp file
    try { fs.unlinkSync(lp); } catch { }
  }
  // Deduplicate by vendor_sku — latest file wins (remoteFiles sorted by size, but we want newest data to win)
  const itemMap = new Map();
  for (const item of allItems) {
    if (item.vendor_sku) itemMap.set(item.vendor_sku, item);
  }
  allItems = [...itemMap.values()];
  log(`  Merged: ${allItems.length} unique items from ${totalSegments} total segments`);

  if (allItems.length === 0) {
    log('  No items found in 832 files. Aborting import.');
    return new Map();
  }

  // Resolve categories
  const catCache = {};
  const catResult = await pool.query('SELECT id, slug FROM categories');
  for (const row of catResult.rows) catCache[row.slug] = row.id;
  const resolveCatId = (categoryText) => {
    if (!categoryText) return null;
    if (catCache[categoryText]) return catCache[categoryText];
    const slug = CATEGORY_MAP[categoryText.toLowerCase().trim()];
    return slug ? (catCache[slug] || null) : null;
  };

  // Group and import
  const productGroups = groupIntoProducts(allItems);
  log(`  Grouped into ${productGroups.length} products`);

  let productsCreated = 0, productsUpdated = 0, skusCreated = 0, skusUpdated = 0;
  let pricingUpserted = 0, packagingUpserted = 0, attrsUpserted = 0;

  // Build skuIndex for Phase 3 matching
  const skuIndex = new Map(); // internal_sku → { sku_id, product_id, vendor_sku, collection, product_name, category, color, sell_by }

  for (const group of productGroups) {
    const categoryId = resolveCatId(group.category);

    const productRow = await upsertProduct(pool, {
      vendor_id: vendorId,
      name: group.baseName,
      collection: group.collection || '',
      category_id: categoryId,
      description_short: group.items[0].product_name || null,
    });
    const productId = productRow.id;
    if (productRow.is_new) productsCreated++; else productsUpdated++;

    for (const item of group.items) {
      const internalSku = makeInternalSku(item.vendor_sku, item.product_name);
      const vendorSku = item.vendor_sku || internalSku;
      const sellBy = item.sell_by || 'sqft';
      const isItemAccessory = item._isAccessory || group.isAccessory;
      const variantType = isItemAccessory ? 'accessory' : null;
      const variantName = item._isAccessory
        ? (item._trimDescription || item.color || item.product_name || null)
        : (item.color || item.product_name || null);

      const skuRow = await upsertSku(pool, {
        product_id: productId, vendor_sku: vendorSku,
        internal_sku: internalSku, variant_name: variantName,
        sell_by: sellBy, variant_type: variantType,
      });
      const skuId = skuRow.id;
      if (skuRow.is_new) skusCreated++; else skusUpdated++;

      // Store in index for Phase 3
      skuIndex.set(internalSku, {
        sku_id: skuId, product_id: productId, vendor_sku: vendorSku,
        collection: group.collection, product_name: group.baseName,
        category: group.category, color: item.color, sell_by: sellBy,
      });

      // Pricing
      if (item.cost || item.retail_price) {
        const priceBasis = sellBy === 'sqft' ? 'per_sqft' : 'per_unit';
        await upsertPricing(pool, skuId, {
          cost: item.cost || 0,
          retail_price: item.retail_price || Math.round((item.cost || 0) * 2 * 100) / 100,
          price_basis: priceBasis,
          map_price: item.map_price || null,
        });
        pricingUpserted++;
      }

      // Packaging
      if (item.sqft_per_box || item.pieces_per_box || item.weight_per_box_lbs) {
        const bpp = item.packaging?.packs_per_pallet || null;
        const sqftPerPallet = (bpp && item.sqft_per_box) ? bpp * item.sqft_per_box : null;
        await upsertPackaging(pool, skuId, {
          sqft_per_box: item.sqft_per_box || null,
          pieces_per_box: item.pieces_per_box || null,
          weight_per_box_lbs: item.weight_per_box_lbs || null,
          boxes_per_pallet: bpp,
          sqft_per_pallet: sqftPerPallet,
        });
        packagingUpserted++;
      }

      // Attributes
      if (item.color) { await upsertSkuAttribute(pool, skuId, 'color', item.color); attrsUpserted++; }
      if (item.upc) { await upsertSkuAttribute(pool, skuId, 'upc', item.upc); attrsUpserted++; }

      const finishPid = item.descriptions.find(d => d.characteristic_label === 'finish');
      if (finishPid) { await upsertSkuAttribute(pool, skuId, 'finish', finishPid.description); attrsUpserted++; }

      const materialPid = item.descriptions.find(d => d.characteristic_label === 'material');
      if (materialPid) { await upsertSkuAttribute(pool, skuId, 'material', materialPid.description); attrsUpserted++; }

      const thickMea = item.measurements.find(m => m.qualifier === 'TH');
      if (thickMea) { await upsertSkuAttribute(pool, skuId, 'thickness', `${thickMea.value}${thickMea.unit_of_measure || ''}`); attrsUpserted++; }

      const widthMea = item.measurements.find(m => m.qualifier === 'WD');
      const lengthMea = item.measurements.find(m => m.qualifier === 'LN');
      if (widthMea && lengthMea) {
        await upsertSkuAttribute(pool, skuId, 'size', `${widthMea.value}x${lengthMea.value}${lengthMea.unit_of_measure || ''}`);
        attrsUpserted++;
      }

      const stylePid = item.descriptions.find(d => d.characteristic_label === 'style');
      if (stylePid) { await upsertSkuAttribute(pool, skuId, 'style', stylePid.description); attrsUpserted++; }

      const patternPid = item.descriptions.find(d => d.characteristic_label === 'pattern');
      if (patternPid) { await upsertSkuAttribute(pool, skuId, 'pattern', patternPid.description); attrsUpserted++; }

      const wearMea = item.measurements.find(m => m.qualifier === 'WL');
      if (wearMea) { await upsertSkuAttribute(pool, skuId, 'wear_layer', `${wearMea.value}${wearMea.unit_of_measure || 'mil'}`); attrsUpserted++; }

      const weightMea = item.measurements.find(m => m.qualifier === 'WT');
      if (weightMea) { await upsertSkuAttribute(pool, skuId, 'weight', `${weightMea.value}${weightMea.unit_of_measure || 'LB'}`); attrsUpserted++; }

      if (widthMea && !lengthMea) {
        await upsertSkuAttribute(pool, skuId, 'width', `${widthMea.value}${widthMea.unit_of_measure || ''}`);
        attrsUpserted++;
      }
    }
  }

  // Clean up ghost products (0 SKUs)
  const ghostIds = await pool.query(
    `SELECT id FROM products WHERE vendor_id = $1 AND id NOT IN (SELECT DISTINCT product_id FROM skus)`,
    [vendorId]
  );
  if (ghostIds.rows.length > 0) {
    const ids = ghostIds.rows.map(r => r.id);
    await pool.query('DELETE FROM media_assets WHERE product_id = ANY($1)', [ids]);
    await pool.query('DELETE FROM products WHERE id = ANY($1)', [ids]);
    log(`  Cleaned up ${ids.length} ghost products`);
  }

  log(`  Phase 2 complete: ${productsCreated} products created, ${productsUpdated} updated`);
  log(`    ${skusCreated} SKUs created, ${skusUpdated} updated`);
  log(`    Pricing: ${pricingUpserted}, Packaging: ${packagingUpserted}, Attributes: ${attrsUpserted}`);
  log(`    skuIndex: ${skuIndex.size} entries for Phase 3`);

  return skuIndex;
}


// ─── Build skuIndex from DB (for --skip-edi mode) ────────────────────────────

async function buildSkuIndexFromDb(pool, vendorId, log) {
  log('Building skuIndex from existing DB data...');
  const { rows } = await pool.query(`
    SELECT s.id AS sku_id, s.product_id, s.vendor_sku, s.internal_sku,
           s.variant_name, s.variant_type, s.sell_by,
           p.name AS product_name, p.collection,
           c.slug AS category
    FROM skus s
    JOIN products p ON p.id = s.product_id
    LEFT JOIN categories c ON c.id = p.category_id
    WHERE p.vendor_id = $1 AND s.status = 'active'
  `, [vendorId]);

  const skuIndex = new Map();
  for (const r of rows) {
    // Get color from sku_attributes if available
    const colorRes = await pool.query(
      `SELECT sa.value FROM sku_attributes sa JOIN attributes a ON a.id = sa.attribute_id
       WHERE sa.sku_id = $1 AND a.slug = 'color' LIMIT 1`, [r.sku_id]
    );
    const color = colorRes.rows[0]?.value || null;

    skuIndex.set(r.internal_sku, {
      sku_id: r.sku_id, product_id: r.product_id, vendor_sku: r.vendor_sku,
      collection: r.collection, product_name: r.product_name,
      category: r.category, color, sell_by: r.sell_by,
    });
  }
  log(`  Loaded ${skuIndex.size} SKUs from DB`);
  return skuIndex;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  PHASE 3 — Per-SKU Images (CDN Probing + Puppeteer Enrichment)
// ═══════════════════════════════════════════════════════════════════════════════

// ─── HTTP HEAD helpers ───────────────────────────────────────────────────────

function headUrl(url) {
  return new Promise(resolve => {
    let resolved = false;
    const done = (val) => { if (!resolved) { resolved = true; resolve(val); } };
    const req = https.request(url, { method: 'HEAD', timeout: 10000 }, res => {
      res.resume();
      done(res.statusCode === 200 ? url : null);
    });
    req.on('error', () => done(null));
    req.on('timeout', () => { req.destroy(); done(null); });
    req.end();
  });
}

async function probeBatch(urls, concurrency = 15) {
  const results = new Array(urls.length).fill(null);
  let idx = 0;
  async function worker() {
    while (idx < urls.length) {
      const i = idx++;
      results[i] = await headUrl(urls[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, () => worker()));
  return results;
}

async function probeFirst(urls, concurrency = 10) {
  for (let i = 0; i < urls.length; i += concurrency) {
    const batch = urls.slice(i, i + concurrency);
    const results = await probeBatch(batch, concurrency);
    const hit = results.find(r => r !== null);
    if (hit) return hit;
  }
  return null;
}

// ─── URL slugifier ───────────────────────────────────────────────────────────

function slugify(text) {
  return (text || '').toLowerCase()
    .replace(/['']/g, '')
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/^-|-$/g, '');
}

// ─── CDN URL Builders ────────────────────────────────────────────────────────

function buildLvpUrls(collection, variantName, productName) {
  const urls = [];
  const collSlug = slugify(collection);
  const colorSlug = slugify(variantName);
  const nameSlug = slugify(productName);
  if (!colorSlug) return urls;

  if (collSlug) {
    urls.push(`${CDN}/lvt/detail/${collSlug}-${colorSlug}-vinyl-flooring.jpg`);
    urls.push(`${CDN}/lvt/detail/${colorSlug}-${collSlug}-vinyl-flooring.jpg`);
  }
  urls.push(`${CDN}/lvt/detail/${colorSlug}-vinyl-flooring.jpg`);
  if (nameSlug && nameSlug !== colorSlug) {
    urls.push(`${CDN}/lvt/detail/${nameSlug}-vinyl-flooring.jpg`);
  }
  if (/\bres\.?\s/i.test(productName || '')) {
    const noRes = slugify((productName || '').replace(/\bres\.?\s*/i, ''));
    urls.push(`${CDN}/lvt/detail/${noRes}-resrve-vinyl-flooring.jpg`);
    urls.push(`${CDN}/lvt/detail/${noRes}-reserve-vinyl-flooring.jpg`);
  }
  if (collSlug) {
    urls.push(`${CDN}/colornames/${colorSlug}-${collSlug}.jpg`);
    urls.push(`${CDN}/colornames/${collSlug}-${colorSlug}.jpg`);
  }
  urls.push(`${CDN}/colornames/${colorSlug}.jpg`);
  if (nameSlug && nameSlug !== colorSlug) urls.push(`${CDN}/colornames/${nameSlug}.jpg`);
  if (collSlug) {
    urls.push(`${CDN}/lvt/iso/${collSlug}-${colorSlug}-vinyl-flooring-iso.jpg`);
    urls.push(`${CDN}/lvt/detail/${collSlug}-${colorSlug}.jpg`);
  }
  return [...new Set(urls)];
}

function buildPorcelainUrls(collection, variantName, productName, vendorSku) {
  const urls = [];
  const collSlug = slugify(collection);
  const colorSlug = slugify(variantName);
  const nameSlug = slugify(productName);
  if (!collSlug && !nameSlug) return urls;

  const collWords = (collection || '').split(/\s+/);
  const baseCollSlug = collWords.length > 1 ? slugify(collWords[0]) : null;
  const uniqueCollSlugs = [...new Set([collSlug, baseCollSlug].filter(Boolean))];

  // Decode vendor_sku color code
  const colorCode = decodePorcelainColor(vendorSku, collection);
  if (colorCode) {
    const mappedColors = PORCELAIN_COLOR_MAP[colorCode] || [];
    const allColors = [...new Set([...mappedColors, colorCode.toLowerCase()])];
    for (const coll of uniqueCollSlugs) {
      for (const color of allColors) {
        urls.push(`${CDN}/porcelainceramic/iso/${color}-${coll}-porcelain-iso.jpg`);
        urls.push(`${CDN}/porcelainceramic/iso/${coll}-${color}-porcelain-iso.jpg`);
        urls.push(`${CDN}/porcelainceramic/${color}-${coll}-porcelain.jpg`);
        urls.push(`${CDN}/porcelainceramic/${color}-${coll}-ceramic.jpg`);
        urls.push(`${CDN}/porcelainceramic/${coll}-${color}-porcelain.jpg`);
        urls.push(`${CDN}/colornames/${color}-${coll}.jpg`);
        urls.push(`${CDN}/colornames/${coll}-${color}.jpg`);
      }
    }
  }

  if (colorSlug) {
    const pureColor = colorSlug.replace(/-?\d+x?\d*$/i, '').replace(/-$/, '');
    for (const coll of uniqueCollSlugs) {
      for (const cs of [pureColor, colorSlug].filter(Boolean)) {
        urls.push(`${CDN}/porcelainceramic/iso/${cs}-${coll}-porcelain-iso.jpg`);
        urls.push(`${CDN}/porcelainceramic/${cs}-${coll}-porcelain.jpg`);
        urls.push(`${CDN}/porcelainceramic/${cs}-${coll}-ceramic.jpg`);
        urls.push(`${CDN}/colornames/${cs}-${coll}.jpg`);
      }
    }
  }

  if (nameSlug) {
    urls.push(`${CDN}/porcelainceramic/iso/${nameSlug}-porcelain-iso.jpg`);
    urls.push(`${CDN}/porcelainceramic/${nameSlug}-porcelain.jpg`);
    urls.push(`${CDN}/colornames/${nameSlug}.jpg`);
  }

  return [...new Set(urls)];
}

const PORCELAIN_COLOR_MAP = {
  'AMB': ['amber'], 'ASH': ['ash'], 'BIA': ['bianco'],
  'BLA': ['blanca', 'blanco'], 'CAF': ['cafe'], 'CAM': ['camo'],
  'CAR': ['carbone'], 'CHA': ['charcoal'], 'CON': ['concrete'],
  'CRE': ['cremita', 'cream', 'crema'], 'GLA': ['glacier'],
  'GRA': ['graphite'], 'GRE': ['greige', 'grey'],
  'GRI': ['gris', 'grigia', 'grigio'], 'ICE': ['ice'], 'IVO': ['ivory'],
  'MID': ['midnight'], 'MOK': ['moka'], 'NER': ['nero'], 'ORO': ['oro'],
  'PEA': ['pearl'], 'PLA': ['platinum'], 'SAD': ['saddle'],
  'TAU': ['taupe'], 'WAL': ['walnut'], 'WEN': ['wenge'], 'RED': ['red'],
  'RUS': ['rustique'], 'CRO': ['criollo'], 'FOR': ['forest'],
  'MAR': ['marble'], 'OAK': ['oak'], 'SAB': ['sable'], 'SIE': ['sienna'],
};

function decodePorcelainColor(vendorSku, collection) {
  if (!vendorSku || !collection) return null;
  let sku = vendorSku.replace(/^(P-)?N(WG)?/i, '');
  const sizeMatch = sku.match(/\d+[X×]/i) || sku.match(/\d{3,}/);
  const sizeIdx = sizeMatch ? sku.indexOf(sizeMatch[0]) : sku.length;
  const prefix = sku.substring(0, sizeIdx);
  const collUpper = collection.toUpperCase().replace(/[^A-Z]/g, '');
  for (let len = 4; len >= 2; len--) {
    const abbrev = collUpper.substring(0, len);
    if (prefix.startsWith(abbrev) && prefix.length > len) {
      const colorCode = prefix.substring(len);
      if (colorCode.length >= 2 && colorCode.length <= 6) return colorCode;
    }
  }
  return null;
}

function buildEngHardwoodUrls(collection, vendorSku, variantName, productName) {
  const urls = [];
  const collSlug = slugify(collection);
  const subProduct = decodeEngHardwoodVendorSku(vendorSku);
  if (subProduct && collSlug) {
    urls.push(`${CDN}/lvt/detail/${collSlug}-${subProduct}.jpg`);
    urls.push(`${CDN}/lvt/iso/${collSlug}-${subProduct}-iso.jpg`);
    urls.push(`${CDN}/lvt/detail/${subProduct}-${collSlug}.jpg`);
    urls.push(`${CDN}/colornames/${collSlug}-${subProduct}.jpg`);
    urls.push(`${CDN}/colornames/${subProduct}.jpg`);
  }
  const colorSlug = slugify(variantName);
  if (colorSlug && collSlug) {
    urls.push(`${CDN}/lvt/detail/${collSlug}-${colorSlug}.jpg`);
    urls.push(`${CDN}/lvt/iso/${collSlug}-${colorSlug}-iso.jpg`);
  }
  return [...new Set(urls)];
}

function decodeEngHardwoodVendorSku(vendorSku) {
  if (!vendorSku) return null;
  const plankMatch = vendorSku.match(/^VTW([A-Z]+?)(\d+[.X×]|$)/i);
  if (plankMatch) return plankMatch[1].toLowerCase();
  const trimMatch = vendorSku.match(/^VTT([A-Z]+?)-(EC|FSN|FSNL|QR|SR|SRL|RT|ST|T)(-|$)/i);
  if (trimMatch) return trimMatch[1].toLowerCase();
  return null;
}

function buildStackedStoneUrls(productName, collection, vendorSku) {
  const urls = [];
  const cleanName = productName
    .replace(/^(?:XL\s+)?Rockmount\s+/i, '')
    .replace(/^Terrado\s+/i, '')
    .replace(/\s+Trim\s*&\s*Accessories$/i, '')
    .replace(/\s+(Gray|Grey|Brown|Black|White|Beige|Ivory|Charcoal|Multicolor|Blue|Green|Gold|Orange|Peach|Red)\s*$/i, '');
  const cleanSlug = slugify(cleanName);
  const withColorSlug = slugify(productName.replace(/^(?:XL\s+)?Rockmount\s+/i, '').replace(/^Terrado\s+/i, '').replace(/\s+Trim\s*&\s*Accessories$/i, ''));

  const { slugs: patternSlugs, isCorner } = decodeStackedStoneVendorSku(vendorSku);

  if (cleanSlug) {
    if (patternSlugs) {
      for (const pat of patternSlugs) {
        if (isCorner) {
          urls.push(`${CDN}/hardscaping/detail/${cleanSlug}-${pat}-corner.jpg`);
          urls.push(`${CDN}/hardscaping/variations/${cleanSlug}-${pat}-var-corner.jpg`);
        } else {
          urls.push(`${CDN}/hardscaping/detail/${cleanSlug}-${pat}.jpg`);
          urls.push(`${CDN}/hardscaping/iso/${cleanSlug}-${pat}-iso.jpg`);
        }
      }
    } else {
      if (isCorner) {
        urls.push(`${CDN}/hardscaping/variations/${cleanSlug}-stacked-stone-panels-corner2.jpg`);
      } else {
        urls.push(`${CDN}/hardscaping/detail/${cleanSlug}-stacked-stone-panels.jpg`);
        urls.push(`${CDN}/hardscaping/detail/${cleanSlug}-ledgestone.jpg`);
        urls.push(`${CDN}/hardscaping/detail/${cleanSlug}-fieldstone.jpg`);
      }
    }
    urls.push(`${CDN}/colornames/${cleanSlug}.jpg`);
  }
  return [...new Set(urls)];
}

const STACKED_STONE_PATTERNS = {
  'LED': ['ledgestone'], 'FLD': ['fieldstone', 'veneer-fieldstone'],
  'ASH': ['sawn-ashlar', 'sawn-ashlar-light-tumbled'],
  'ASHTUM': ['sawn-ashlar-light-tumbled', 'sawn-ashlar'],
  'SQREC': ['squares-rectangles', 'sq-and-rec'],
};

function decodeStackedStoneVendorSku(vendorSku) {
  if (!vendorSku) return { pattern: null, slugs: null, isCorner: false };
  const isCorner = vendorSku.endsWith('-COR');
  const clean = vendorSku.replace(/-COR$/, '');
  for (const [code, slugs] of Object.entries(STACKED_STONE_PATTERNS)) {
    if (clean.endsWith(code)) return { pattern: code, slugs, isCorner };
  }
  return { pattern: null, slugs: null, isCorner };
}

function buildNaturalStoneUrls(productName, collection, category) {
  const urls = [];
  const nameSlug = slugify(productName);
  const collSlug = slugify(collection);
  const materialSuffixes = [];
  if (category) {
    const cat = category.toLowerCase();
    if (cat.includes('granite')) materialSuffixes.push('granite');
    else if (cat.includes('marble')) materialSuffixes.push('marble');
    else if (cat.includes('quartzite')) materialSuffixes.push('quartzite');
    else if (cat.includes('quartz')) materialSuffixes.push('quartz');
    else materialSuffixes.push('granite', 'marble', 'quartzite');
  } else {
    materialSuffixes.push('granite', 'marble', 'quartzite');
  }
  const isQuartz = materialSuffixes.includes('quartz');

  for (const slug of [nameSlug, collSlug].filter(Boolean)) {
    for (const suffix of materialSuffixes) urls.push(`${CDN}/colornames/${slug}-${suffix}.jpg`);
    if (isQuartz) {
      urls.push(`${CDN}/quartz-countertops/products/slab/large/${slug}-quartz.jpg`);
    }
    urls.push(`${CDN}/natural-stone/detail/${slug}.jpg`);
    urls.push(`${CDN}/colornames/${slug}.jpg`);
  }
  return [...new Set(urls)];
}

function buildHardscapingUrls(productName, collection, variantName) {
  const urls = [];
  const nameSlug = slugify(productName);
  const collSlug = slugify(collection);
  const colorSlug = slugify(variantName);
  if (nameSlug) {
    urls.push(`${CDN}/hardscaping/detail/${nameSlug}.jpg`);
    urls.push(`${CDN}/hardscaping/detail/${nameSlug}-pavers.jpg`);
    urls.push(`${CDN}/hardscaping/${nameSlug}.jpg`);
  }
  if (collSlug && colorSlug) {
    urls.push(`${CDN}/hardscaping/detail/${collSlug}-${colorSlug}.jpg`);
    urls.push(`${CDN}/colornames/${collSlug}-${colorSlug}.jpg`);
  }
  if (collSlug) urls.push(`${CDN}/colornames/${collSlug}.jpg`);
  return [...new Set(urls)];
}

// ─── CDN URL selector by category ────────────────────────────────────────────

function buildCdnUrlsForSku(entry) {
  const { vendor_sku, collection, product_name, category, color } = entry;
  const variantName = color || product_name;
  const catLower = (category || '').toLowerCase();

  if (/luxury.vinyl|lvp|spc|wpc|vinyl.plank|vinyl.tile|rigid.core/i.test(catLower)) {
    return buildLvpUrls(collection, variantName, product_name);
  }
  if (/hardwood|engineered/i.test(catLower)) {
    return [
      ...buildEngHardwoodUrls(collection, vendor_sku, variantName, product_name),
      ...buildLvpUrls(collection, variantName, product_name),
    ];
  }
  if (/porcelain|ceramic|tile/i.test(catLower) && !/mosaic|stacked|glass/i.test(catLower)) {
    return buildPorcelainUrls(collection, variantName, product_name, vendor_sku);
  }
  if (/stacked.stone|ledger/i.test(catLower)) {
    return buildStackedStoneUrls(product_name, collection, vendor_sku);
  }
  if (/natural.stone|marble|granite|travertine|quartzite|limestone|slate|sandstone|onyx/i.test(catLower)) {
    return buildNaturalStoneUrls(product_name, collection, category);
  }
  if (/countertop|slab|quartz|prefab/i.test(catLower)) {
    return buildNaturalStoneUrls(product_name, collection, category);
  }
  if (/outdoor|paver|hardscap/i.test(catLower)) {
    return buildHardscapingUrls(product_name, collection, variantName);
  }
  // Fallback: try all patterns
  return [
    ...buildLvpUrls(collection, variantName, product_name),
    ...buildPorcelainUrls(collection, variantName, product_name, vendor_sku),
    ...buildNaturalStoneUrls(product_name, collection, category),
  ];
}

// ─── Tier 1: CDN Probing ─────────────────────────────────────────────────────

async function phase3_tier1_cdnProbe(pool, skuIndex, log) {
  log('  Tier 1: CDN image probing...');
  let matched = 0, skipped = 0, noUrl = 0;
  let processed = 0;
  const total = skuIndex.size;

  for (const [internalSku, entry] of skuIndex) {
    processed++;
    if (processed % 500 === 0) log(`    Progress: ${processed}/${total} (${matched} matched)`);

    // Skip accessories — they inherit from parent in Phase 5
    if (/^VTT|^TT/i.test(entry.vendor_sku) && entry.sell_by === 'unit') {
      skipped++;
      continue;
    }

    const candidates = buildCdnUrlsForSku(entry);
    if (candidates.length === 0) { noUrl++; continue; }

    const hit = await probeFirst(candidates, 15);
    if (hit) {
      await saveSkuImages(pool, entry.product_id, entry.sku_id, [hit], { maxImages: 1 });
      entry._hasImage = true;
      matched++;
    }
  }

  log(`  Tier 1 complete: ${matched} CDN matches, ${skipped} accessories skipped, ${noUrl} no candidates`);
  return matched;
}

// ─── Tier 2: Puppeteer Enrichment ────────────────────────────────────────────

const MSI_CATEGORIES = [
  // Porcelain / ceramic
  '/porcelain-tile/',
  // Natural stone
  '/marble-tile/', '/travertine-tile/', '/granite-tile/',
  '/quartzite-tile/', '/slate-tile/', '/limestone-tile/', '/sandstone-tile/',
  // LVP — sub-collection pages that actually list products
  '/luxury-vinyl-flooring/cyrus/', '/luxury-vinyl-flooring/andover/',
  '/luxury-vinyl-flooring/everlife-xl-cyrus/', '/luxury-vinyl-flooring/xl-cyrus/',
  '/luxury-vinyl-flooring/xxl-cyrus/', '/luxury-vinyl-flooring/prescott/',
  '/luxury-vinyl-flooring/everlife-prescott/', '/luxury-vinyl-flooring/bracken-hill/',
  '/luxury-vinyl-flooring/everlife/',
  '/waterproof-hybrid-rigid-core/',
  // Hardwood
  '/w-luxury-genuine-hardwood/',
  '/waterproof-wood-flooring/woodhills/',
  // Backsplash & Mosaics
  '/backsplash-tile/subway-tile/', '/backsplash-tile/glass-tile/',
  '/backsplash-tile/natural-stone-backsplash/',
  '/mosaics/collections-mosaics/',
  '/mosaics/peel-and-stick/',
  // Stacked stone & hardscape
  '/hardscape/rockmount-stacked-stone/',
  '/hardscape/arterra-porcelain-pavers/',
  '/hardscape/natural-stone-coping/',
];

async function phase3_tier2_puppeteer(pool, skuIndex, log) {
  log('  Tier 2: Puppeteer enrichment (SKUs missing images)...');

  const baseUrl = 'https://www.msisurfaces.com';
  let browser;
  let totalEnriched = 0;
  let totalImages = 0;

  try {
    browser = await launchBrowser();
    const visitedUrls = new Set();

    for (const categoryPath of MSI_CATEGORIES) {
      const categoryUrl = baseUrl + categoryPath;
      log(`    Category: ${categoryPath}`);

      let productUrls;
      try {
        productUrls = await collectProductUrls(browser, categoryUrl);
        log(`      Found ${productUrls.length} products`);
      } catch (err) {
        log(`      ERROR: ${err.message}`);
        continue;
      }

      for (let i = 0; i < productUrls.length; i++) {
        const url = productUrls[i];
        const normalizedUrl = url.replace(/\/$/, '').toLowerCase();
        if (visitedUrls.has(normalizedUrl)) continue;
        visitedUrls.add(normalizedUrl);

        try {
          const data = await scrapeProductPage(browser, url);
          if (!data || !data.name) continue;

          // Match scraped SKU codes to our index
          const matchedSkus = [];
          for (const entry of (data.skus || [])) {
            if (!/\d/.test(entry.code)) continue;
            const cleanCode = entry.code.replace(/\s+/g, '-').toUpperCase();
            const match = skuIndex.get('MSI-' + cleanCode);
            if (match) {
              matchedSkus.push({ ...match, code: entry.code, scraped: entry });
            }
          }

          if (matchedSkus.length === 0) continue;

          const productId = matchedSkus[0].product_id;

          // Enrich descriptions
          if (data.description) {
            await pool.query(`
              UPDATE products SET
                description_short = CASE WHEN description_short IS NULL OR length(description_short) < 40
                  THEN $2 ELSE description_short END,
                description_long = CASE WHEN description_long IS NULL OR length(description_long) < 40
                  THEN $3 ELSE description_long END,
                updated_at = CURRENT_TIMESTAMP
              WHERE id = $1
            `, [productId, (data.description || '').slice(0, 255), data.description]);
          }

          // Save per-SKU images (from page scrape)
          for (const match of matchedSkus) {
            if (match._hasImage) continue;

            // Prefer per-size image if available
            const perSizeImg = match.scraped?.sizeImage;
            let imageUrls = [];
            if (perSizeImg) imageUrls.push(perSizeImg);
            if (data.images && data.images.length > 0) {
              imageUrls.push(...data.images.map(img => img.url));
            }

            if (imageUrls.length > 0) {
              const sorted = preferProductShot(imageUrls, match.color);
              const filtered = filterImageUrls(sorted, { maxImages: 4 });
              if (filtered.length > 0) {
                await saveSkuImages(pool, match.product_id, match.sku_id, filtered, { maxImages: 4 });
                match._hasImage = true;
                totalImages += filtered.length;
              }
            }
          }

          // Upsert spec attributes
          for (const match of matchedSkus) {
            for (const [attrSlug, value] of Object.entries(data.attributes || {})) {
              await upsertSkuAttribute(pool, match.sku_id, attrSlug, value);
            }
            if (match.scraped.size) await upsertSkuAttribute(pool, match.sku_id, 'size', match.scraped.size);
            if (match.scraped.finish) await upsertSkuAttribute(pool, match.sku_id, 'finish', match.scraped.finish);
          }

          totalEnriched++;
        } catch (err) {
          if (VERBOSE) log(`      ERROR scraping ${url}: ${err.message}`);
        }

        await delay(2500);
      }
    }

    log(`  Tier 2 complete: ${totalEnriched} pages enriched, ${totalImages} images added`);
  } finally {
    if (browser) await browser.close();
  }

  return totalEnriched;
}

// ─── Puppeteer helpers (from msi.js) ─────────────────────────────────────────

async function collectProductUrls(browser, categoryUrl) {
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  await page.setRequestInterception(true);
  page.on('request', req => {
    if (['font', 'media'].includes(req.resourceType())) req.abort();
    else req.continue();
  });

  try {
    await page.goto(categoryUrl, { waitUntil: 'networkidle2', timeout: 60000 });
    // Wait for either old or new selectors
    await page.waitForSelector('[data-href], .new-filter-collection a[href], a.owl-log', { timeout: 15000 }).catch(() => {});
    await delay(2000);

    // Click "Load More Products" repeatedly to load all items
    let previousCount = 0;
    for (let attempt = 0; attempt < 50; attempt++) {
      const loadMoreBtn = await page.evaluateHandle(() => {
        const links = Array.from(document.querySelectorAll('a, button'));
        return links.find(el => {
          const text = el.textContent.trim().toLowerCase();
          if (!text.includes('load more')) return false;
          // Accept visible load-more buttons/links
          const style = window.getComputedStyle(el);
          return style.display !== 'none' && style.visibility !== 'hidden' && el.offsetParent !== null;
        }) || null;
      });
      const isElement = await loadMoreBtn.evaluate(el => el !== null).catch(() => false);
      if (!isElement) break;
      await loadMoreBtn.click().catch(() => {});
      await delay(2000);
      const currentCount = await page.$$eval('[data-href]', els => els.length).catch(() => 0);
      if (currentCount <= previousCount) break;
      previousCount = currentCount;
    }

    const baseHost = new URL(categoryUrl).origin;
    const urls = await page.evaluate((baseHost) => {
      const seen = new Set();
      const results = [];

      // Strategy 1: data-href attributes (new MSI site structure)
      document.querySelectorAll('[data-href]').forEach(el => {
        let href = el.getAttribute('data-href');
        if (!href || href === '#' || href.includes('javascript:')) return;
        if (href.startsWith('/')) href = baseHost + href;
        if (seen.has(href)) return;
        seen.add(href);
        results.push(href);
      });

      // Strategy 2: .new-filter-collection a[href] (legacy)
      document.querySelectorAll('.new-filter-collection a[href]').forEach(a => {
        let href = a.href || a.getAttribute('href');
        if (href && href.startsWith('/')) href = baseHost + href;
        if (!href || href.includes('javascript:') || href === '#') return;
        try { if (new URL(href).origin !== baseHost) return; } catch { return; }
        if (/\.(pdf|jpg|png|gif|svg|mp4)(\?|$)/i.test(href)) return;
        if (seen.has(href)) return;
        seen.add(href);
        results.push(href);
      });

      // Strategy 3: owl-log links (carousel items)
      document.querySelectorAll('a.owl-log[href]').forEach(a => {
        let href = a.href || a.getAttribute('href');
        if (href && href.startsWith('/')) href = baseHost + href;
        if (!href || href.includes('javascript:') || href === '#') return;
        try { if (new URL(href).origin !== baseHost) return; } catch { return; }
        if (/\.(pdf|jpg|png|gif|svg|mp4)(\?|$)/i.test(href)) return;
        if (seen.has(href)) return;
        seen.add(href);
        results.push(href);
      });

      // Filter out non-product URLs
      return results.filter(url => {
        return !url.includes('/site-search') &&
               !url.includes('/gallery/') &&
               !url.includes('/videos/') &&
               !url.includes('/blog/') &&
               !url.includes('?');
      });
    }, baseHost);
    return urls.slice(0, 800);
  } finally {
    await page.close();
  }
}

async function scrapeProductPage(browser, url) {
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
  await page.setRequestInterception(true);
  page.on('request', req => {
    if (['font', 'media'].includes(req.resourceType())) req.abort();
    else req.continue();
  });

  try {
    let retries = 0;
    while (retries < 3) {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
      const bodySnippet = await page.evaluate(() => document.body?.innerText?.slice(0, 200) || '').catch(() => '');
      if (/too many requests|429|rate limit/i.test(bodySnippet)) {
        retries++;
        await delay(5000 * retries);
        continue;
      }
      break;
    }
    await page.waitForSelector('h1', { timeout: 10000 }).catch(() => {});

    // Expand accordions
    await page.evaluate(() => {
      document.querySelectorAll('.accordion-header, [data-toggle="collapse"], button[aria-expanded="false"]')
        .forEach(t => { try { t.click(); } catch { } });
      document.querySelectorAll('.collapse').forEach(el => {
        el.classList.add('in', 'show');
        el.style.display = '';
        el.style.height = 'auto';
      });
      document.querySelectorAll('.tab-pane').forEach(el => {
        el.classList.add('active', 'in', 'show');
        el.style.display = '';
      });
    });
    await delay(800);

    return await page.evaluate(() => {
      const result = { name: '', skus: [], collection: '', description: '', attributes: {}, images: [] };

      // Product name
      const h1 = document.querySelector('h1');
      if (h1) {
        result.name = h1.textContent.trim()
          .replace(/[®™©]/g, '').replace(/\bTM\b/g, '')
          .replace(/\s+(Porcelain|Ceramic|Marble|Granite|Travertine|Vinyl|Tile|Plank|Flooring|Luxury|Collection|Series)\s*$/i, '')
          .trim();
      }

      // SKU variants — Strategy 1: button[data-id] (new site structure)
      const seen = new Set();
      document.querySelectorAll('button[data-id], [data-id]').forEach(el => {
        const code = el.getAttribute('data-id');
        if (!code || code.length < 5 || seen.has(code)) return;
        // Filter out non-SKU data-ids (e.g. numeric IDs, CSS ids)
        if (/^[0-9]+$/.test(code)) return;
        seen.add(code);
        // Try to find size from nearby .size-spec or parent context
        const sizeSpec = el.closest('.size-spec, .border-bottom');
        let size = '';
        if (sizeSpec) {
          const sizeMatch = sizeSpec.textContent.match(/(\d+)\s*[xX×]\s*(\d+)/);
          if (sizeMatch) size = sizeMatch[1] + 'x' + sizeMatch[2];
        }
        // Try to find per-size image
        let sizeImage = '';
        if (sizeSpec) {
          const img = sizeSpec.querySelector('img[src*="cdn.msisurfaces.com"]');
          if (img && img.src.indexOf('.svg') === -1) sizeImage = img.src;
        }
        result.skus.push({ code, size, finish: '', sizeImage });
      });

      // Strategy 2: ID# lines in text (fallback for old pages)
      const lines = (document.body.innerText || '').split('\n').map(l => l.trim()).filter(Boolean);
      for (let i = 0; i < lines.length; i++) {
        const idMatch = lines[i].match(/^ID#:\s*([A-Z0-9][\w-]{4,})/i);
        if (!idMatch) continue;
        const code = idMatch[1].trim();
        if (code.length < 5 || seen.has(code)) continue;
        seen.add(code);

        let size = '', finish = '';
        if (i > 0) {
          const sizeMatch = lines[i - 1].match(/(\d+)\s*[xX×]\s*(\d+)/);
          if (sizeMatch) size = sizeMatch[1] + 'x' + sizeMatch[2];
        }
        for (let j = i + 1; j < Math.min(i + 3, lines.length); j++) {
          const fm = lines[j].match(/^Finish:\s*(.+)/i);
          if (fm) { finish = fm[1].trim(); break; }
        }
        result.skus.push({ code, size, finish, sizeImage: '' });
      }

      // Specs from dt/dd
      const SPEC_MAP = {
        'primary color': 'color', 'primary color(s)': 'color',
        'pei rating': 'pei_rating', 'style': 'style', 'tile type': 'material',
        'finish': 'finish', 'material': 'material', 'thickness': 'thickness',
        'total thickness': 'thickness', 'wear layer': 'wear_layer',
        'wear layer thickness': 'wear_layer', 'country of origin': 'country',
        'edge type': 'edge_type', 'core type': 'core_type',
        'installation method': 'installation_method', 'dcof': 'dcof',
      };
      for (const dt of document.querySelectorAll('dt')) {
        const label = dt.textContent.trim().toLowerCase();
        const dd = dt.nextElementSibling;
        if (!dd || dd.tagName !== 'DD') continue;
        const value = dd.textContent.trim();
        const slug = SPEC_MAP[label];
        if (slug && value && !result.attributes[slug]) result.attributes[slug] = value;
      }

      // Description
      const metaDesc = document.querySelector('meta[name="description"]');
      if (metaDesc) {
        const content = metaDesc.getAttribute('content');
        if (content && content.length > 20) result.description = content.trim();
      }
      if (!result.description) {
        const root = document.querySelector('main, [role="main"], article') || document.body;
        for (const p of root.querySelectorAll('p')) {
          if (p.closest('footer, header, nav, .modal')) continue;
          const text = p.textContent.trim();
          if (text.length > 50 && text.length < 2000 && !text.includes('ID#:')) {
            result.description = text;
            break;
          }
        }
      }

      // Images — prioritize product shots, room scenes, then thumbnails
      const seenUrls = new Set();
      const productImages = [];
      const roomScenes = [];
      const otherImages = [];

      function categorizeImage(src) {
        if (!src) return;
        try {
          const u = new URL(src, window.location.origin);
          const href = u.href;
          if (seenUrls.has(href)) return;
          if (href.indexOf('cdn.msisurfaces.com') === -1 && href.indexOf('/files/') === -1) return;
          if (/\.(svg|gif|ico)(\?|$)/i.test(href)) return;
          if (/icon|logo|badge|placeholder|miscellaneous|roomvo|wetcutting|flyers/i.test(href)) return;
          seenUrls.add(href);
          if (/roomscene/i.test(href)) {
            roomScenes.push(href);
          } else if (/thumbnails/i.test(href)) {
            otherImages.push(href);
          } else {
            productImages.push(href);
          }
        } catch { }
      }

      // og:image first
      const ogImage = document.querySelector('meta[property="og:image"]');
      if (ogImage) categorizeImage(ogImage.getAttribute('content'));
      // MagicZoom gallery images (main product photos)
      document.querySelectorAll('.mz-figure img, .MagicZoom img').forEach(img => {
        categorizeImage(img.src);
        categorizeImage(img.getAttribute('data-src'));
        categorizeImage(img.getAttribute('data-zoom-image'));
      });
      // All CDN images
      document.querySelectorAll('img[src*="cdn.msisurfaces.com"]').forEach(img => {
        categorizeImage(img.src);
        categorizeImage(img.getAttribute('data-src'));
      });

      // Build final image list: product shots first, then room scenes, then thumbnails
      const allImgs = [...productImages, ...roomScenes, ...otherImages].slice(0, 8);
      result.images = allImgs.map((url, i) => ({
        url,
        type: i === 0 ? 'primary' : (url.includes('roomscene') ? 'lifestyle' : 'alternate'),
      }));

      // Collection from breadcrumb
      for (const bc of document.querySelectorAll('.breadcrumb a, nav[aria-label*="bread"] a')) {
        const text = bc.textContent.trim();
        if (text && text.length < 40 && text.length > 2 &&
            !text.toLowerCase().includes('home') && !text.toLowerCase().includes('tile')) {
          result.collection = text;
          break;
        }
      }

      return result;
    });
  } finally {
    await page.close();
  }
}

// ─── Phase 3 Orchestrator ────────────────────────────────────────────────────

async function phase3_images(pool, skuIndex, log) {
  log('Phase 3: Per-SKU images...');

  const cdnMatched = await phase3_tier1_cdnProbe(pool, skuIndex, log);

  if (!SKIP_PUPPETEER) {
    // Count SKUs still missing images
    const missing = [...skuIndex.values()].filter(e => !e._hasImage).length;
    log(`  ${missing} SKUs still missing images — launching Puppeteer...`);
    try {
      await phase3_tier2_puppeteer(pool, skuIndex, log);
    } catch (err) {
      log(`  WARNING: Puppeteer Tier 2 failed (non-fatal): ${err.message}`);
      log('  Continuing without browser enrichment...');
    }
  } else {
    log('  Skipping Puppeteer enrichment (--skip-puppeteer)');
  }

  // Sibling inheritance: if one SKU of a color matched, share with same-color siblings
  log('  Sibling inheritance pass...');
  let inherited = 0;

  // Group by product_id
  const byProduct = new Map();
  for (const [, entry] of skuIndex) {
    if (!byProduct.has(entry.product_id)) byProduct.set(entry.product_id, []);
    byProduct.get(entry.product_id).push(entry);
  }

  for (const [productId, entries] of byProduct) {
    const withImage = entries.filter(e => e._hasImage);
    const withoutImage = entries.filter(e => !e._hasImage);
    if (withImage.length === 0 || withoutImage.length === 0) continue;

    // Build color → imageUrl map from DB
    for (const entry of withoutImage) {
      // Find a sibling with same color
      const sibling = withImage.find(e => e.color && entry.color && e.color === entry.color);
      if (!sibling) continue;

      // Get sibling's image URL from DB
      const { rows } = await pool.query(
        "SELECT url FROM media_assets WHERE sku_id = $1 AND asset_type = 'primary' LIMIT 1",
        [sibling.sku_id]
      );
      if (rows.length === 0) continue;

      await saveSkuImages(pool, entry.product_id, entry.sku_id, [rows[0].url], { maxImages: 1 });
      entry._hasImage = true;
      inherited++;
    }
  }

  log(`  Sibling inheritance: ${inherited} additional SKUs`);
  log('Phase 3 complete.');
}


// ═══════════════════════════════════════════════════════════════════════════════
//  PHASE 4 — Product Map
// ═══════════════════════════════════════════════════════════════════════════════

async function phase4_productMap(pool, vendorId, log) {
  log('Phase 4: Building product map...');

  const { rows } = await pool.query(`
    SELECT
      p.id as product_id, p.name as product_name, p.collection,
      c.slug as category_slug,
      s.id as sku_id, s.vendor_sku, s.variant_name, s.variant_type, s.sell_by,
      sa_size.value as size
    FROM products p
    JOIN skus s ON s.product_id = p.id
    LEFT JOIN categories c ON c.id = p.category_id
    LEFT JOIN sku_attributes sa_size ON sa_size.sku_id = s.id
      AND sa_size.attribute_id = (SELECT id FROM attributes WHERE slug = 'size' LIMIT 1)
    WHERE p.vendor_id = $1
    ORDER BY p.collection, p.name, s.vendor_sku
  `, [vendorId]);

  const collections = {};
  let productCount = 0, skuCount = 0;

  for (const row of rows) {
    const coll = row.collection || 'Uncategorized';
    if (!collections[coll]) {
      collections[coll] = { category: row.category_slug || 'unknown', products: {} };
    }
    const prodName = row.product_name;
    if (!collections[coll].products[prodName]) {
      collections[coll].products[prodName] = { skus: [], accessories: [] };
      productCount++;
    }
    const product = collections[coll].products[prodName];
    const skuEntry = {
      vendorSku: row.vendor_sku,
      size: row.size || null,
      variantName: row.variant_name || null,
    };

    if (row.variant_type === 'accessory') {
      skuEntry.type = row.variant_name || 'Trim';
      product.accessories.push(skuEntry);
    } else {
      product.skus.push(skuEntry);
    }
    skuCount++;
  }

  const map = {
    generated: new Date().toISOString(),
    summary: {
      collections: Object.keys(collections).length,
      products: productCount,
      skus: skuCount,
    },
    collections,
  };

  const outPath = path.join(__dirname, '..', 'data', 'msi-product-map.json');
  fs.writeFileSync(outPath, JSON.stringify(map, null, 2));
  log(`  Written to ${outPath}`);
  log(`  Summary: ${map.summary.collections} collections, ${map.summary.products} products, ${map.summary.skus} SKUs`);
  log('Phase 4 complete.');

  return map;
}


// ═══════════════════════════════════════════════════════════════════════════════
//  PHASE 5 — Accessory Attachment
// ═══════════════════════════════════════════════════════════════════════════════

// Color-code extraction helpers

function extractAccColorCode(sku) {
  let m;
  m = sku.match(/^P-VTT(?:HD)?([A-Z]+)-/i);
  if (m) return m[1].toUpperCase();
  m = sku.match(/^VTTHD([A-Z]+)-/i);
  if (m) return m[1].toUpperCase();
  m = sku.match(/^VTT([A-Z]+)-/i);
  if (m) return m[1].toUpperCase();
  m = sku.match(/^TT([A-Z]+)-/i);
  if (m) return m[1].toUpperCase();
  return null;
}

function extractMainColorCodes(sku) {
  let m;
  m = sku.match(/^(?:P-)?(?:VTR|VTW|QUTR|QUPO)(?:HD)?([A-Z]+)/i);
  if (m && m[1].length >= 3) {
    const code = m[1].toUpperCase();
    const codes = [code];
    if (code.startsWith('XL') && code.length > 4) codes.push(code.slice(2));
    return codes;
  }
  return [];
}

function parseTrimVariantName(vendorSku) {
  const m = vendorSku.match(TRIM_CODE_REGEX);
  if (m) return TRIM_NAMES[m[1].toUpperCase()] || m[1];
  return null;
}

function parseSuffixVariantName(accSku) {
  for (const [suffix, name] of Object.entries(SUFFIX_NAMES)) {
    const re = new RegExp(suffix + '(?:[\\-_]|$)', 'i');
    if (re.test(accSku)) return name;
  }
  if (/-COR\b/i.test(accSku) || /COR$/i.test(accSku)) return 'Corner Piece';
  if (/\dBN[GPK]?[-\d]?/i.test(accSku)) return 'Bullnose';
  if (/SB\d?$/i.test(accSku)) return 'Stair Bullnose';
  return 'Trim';
}

const COLOR_CODE_CATEGORIES = new Set([
  'luxury-vinyl', 'hardwood',
]);

async function phase5_attachAccessories(pool, vendorId, log) {
  log('Phase 5: Attaching accessories...');

  // Find catch-all accessory products (products with ONLY accessory SKUs)
  const { rows: catchAllProducts } = await pool.query(`
    SELECT p.id, p.name, p.collection, c.slug as category_slug,
      COUNT(s.id) FILTER (WHERE s.variant_type = 'accessory') as acc_count,
      COUNT(s.id) FILTER (WHERE s.variant_type IS DISTINCT FROM 'accessory') as main_count
    FROM products p
    LEFT JOIN categories c ON c.id = p.category_id
    LEFT JOIN skus s ON s.product_id = p.id
    WHERE p.vendor_id = $1
    GROUP BY p.id, p.name, p.collection, c.slug
    HAVING COUNT(s.id) FILTER (WHERE s.variant_type = 'accessory') > 0
       AND COUNT(s.id) FILTER (WHERE s.variant_type IS DISTINCT FROM 'accessory') = 0
    ORDER BY c.slug, p.collection
  `, [vendorId]);

  log(`  Found ${catchAllProducts.length} catch-all accessory products`);

  let totalMoved = 0, totalUnmatched = 0, totalDeactivated = 0;
  const affectedParentIds = new Set();

  // Group by collection
  const byCollection = new Map();
  for (const p of catchAllProducts) {
    const key = `${p.category_slug}\0${p.collection}`;
    if (!byCollection.has(key)) byCollection.set(key, []);
    byCollection.get(key).push(p);
  }

  for (const [key, catchAlls] of byCollection) {
    const [categorySlug, collection] = key.split('\0');
    const useColorCode = COLOR_CODE_CATEGORIES.has(categorySlug);

    // Get main products in this collection
    const { rows: mainProducts } = await pool.query(`
      SELECT p.id, p.name, p.collection
      FROM products p
      WHERE p.vendor_id = $1 AND p.collection = $2
        AND p.id NOT IN (${catchAlls.map((_, i) => `$${i + 3}`).join(',')})
      ORDER BY p.name
    `, [vendorId, collection, ...catchAlls.map(p => p.id)]);

    if (mainProducts.length === 0) {
      for (const ca of catchAlls) {
        const { rows: accSkus } = await pool.query(
          'SELECT id FROM skus WHERE product_id = $1', [ca.id]
        );
        totalUnmatched += accSkus.length;
      }
      continue;
    }

    // Build color-code → product_id mapping
    const colorToProductId = {};
    const mainSkuPrefixes = [];

    for (const mp of mainProducts) {
      const { rows: mainSkus } = await pool.query(
        `SELECT vendor_sku FROM skus WHERE product_id = $1 AND (variant_type IS NULL OR variant_type <> 'accessory')`,
        [mp.id]
      );
      for (const ms of mainSkus) {
        if (useColorCode) {
          for (const code of extractMainColorCodes(ms.vendor_sku)) {
            colorToProductId[code] = mp.id;
          }
        }
        mainSkuPrefixes.push({ sku: ms.vendor_sku, productId: mp.id });
      }
    }

    // Process each catch-all's accessory SKUs
    for (const ca of catchAlls) {
      const { rows: accSkus } = await pool.query(
        `SELECT id, vendor_sku, variant_name FROM skus WHERE product_id = $1 AND variant_type = 'accessory'`,
        [ca.id]
      );

      let movedFromThis = 0;

      for (const acc of accSkus) {
        let targetProductId = null;
        let variantName = null;

        if (useColorCode) {
          const accColor = extractAccColorCode(acc.vendor_sku);
          if (accColor) {
            targetProductId = colorToProductId[accColor];
            if (!targetProductId) {
              for (const [code, pid] of Object.entries(colorToProductId)) {
                if (code.includes(accColor) || accColor.includes(code)) {
                  targetProductId = pid; break;
                }
              }
            }
          }
          variantName = parseTrimVariantName(acc.vendor_sku);
        } else {
          if (mainProducts.length === 1) {
            targetProductId = mainProducts[0].id;
          } else {
            const accBase = acc.vendor_sku
              .replace(/[-_]?COR[-_]?/gi, '')
              .replace(/[-_]?\d*BN[GPK]?[-_]?.*$/i, '')
              .replace(/[-_]?SB\d?$/i, '')
              .replace(/[-_]?HF\d?$/i, '')
              .replace(/[-_](EE|DB)$/i, '');

            let bestMatch = null, bestLen = 0;
            for (const { sku, productId } of mainSkuPrefixes) {
              let len = 0;
              const minLen = Math.min(accBase.length, sku.length);
              while (len < minLen && accBase[len].toUpperCase() === sku[len].toUpperCase()) len++;
              if (len > bestLen && len >= 6) { bestLen = len; bestMatch = productId; }
            }
            if (!bestMatch) {
              const accUpper = acc.vendor_sku.toUpperCase();
              for (const { sku, productId } of mainSkuPrefixes) {
                const tokens = accUpper.match(/[A-Z]{7,}/g) || [];
                for (const tok of tokens) {
                  if (sku.toUpperCase().includes(tok)) { bestMatch = productId; break; }
                }
                if (bestMatch) break;
              }
            }
            targetProductId = bestMatch;
          }
          variantName = parseSuffixVariantName(acc.vendor_sku);
        }

        if (!variantName) variantName = 'Trim';

        if (targetProductId) {
          await pool.query(
            'UPDATE skus SET product_id = $1, variant_name = $2, updated_at = NOW() WHERE id = $3',
            [targetProductId, variantName, acc.id]
          );
          affectedParentIds.add(targetProductId);
          movedFromThis++;
          totalMoved++;
        } else {
          totalUnmatched++;
        }
      }

      // Deactivate empty catch-all
      if (movedFromThis === accSkus.length && movedFromThis > 0) {
        await pool.query(
          "UPDATE products SET status = 'discontinued', updated_at = NOW() WHERE id = $1",
          [ca.id]
        );
        totalDeactivated++;
      }
    }
  }

  // Clean up ghost products
  const ghostIds = await pool.query(
    `SELECT id FROM products WHERE vendor_id = $1 AND id NOT IN (SELECT DISTINCT product_id FROM skus)`,
    [vendorId]
  );
  if (ghostIds.rows.length > 0) {
    const ids = ghostIds.rows.map(r => r.id);
    await pool.query('DELETE FROM media_assets WHERE product_id = ANY($1)', [ids]);
    await pool.query('DELETE FROM products WHERE id = ANY($1)', [ids]);
    log(`  Cleaned up ${ids.length} ghost products`);
  }

  // Rebuild search vectors
  if (affectedParentIds.size > 0) {
    log(`  Rebuilding search vectors for ${affectedParentIds.size} parent products...`);
    for (const pid of affectedParentIds) {
      try { await pool.query('SELECT refresh_search_vectors($1)', [pid]); } catch { }
    }
  }

  log(`  Phase 5 complete: ${totalMoved} accessories linked, ${totalDeactivated} catch-alls removed, ${totalUnmatched} unmatched`);
}


// ═══════════════════════════════════════════════════════════════════════════════
//  MAIN — Standalone execution
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
  const Pool = require('pg').Pool;
  const pool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    database: process.env.DB_NAME || 'flooring_pim',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
  });

  const startTime = Date.now();
  const log = (msg) => {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[${elapsed}s] ${msg}`);
  };

  log('═══════════════════════════════════════════════════════');
  log('  MSI Unified Pipeline');
  log('═══════════════════════════════════════════════════════');

  try {
    // Resolve vendor
    const vendorResult = await pool.query('SELECT id FROM vendors WHERE code = $1', [VENDOR_CODE]);
    if (!vendorResult.rows.length) {
      throw new Error(`Vendor with code "${VENDOR_CODE}" not found. Create the vendor record first.`);
    }
    const vendorId = vendorResult.rows[0].id;
    log(`Vendor: ${VENDOR_CODE} (${vendorId})`);

    // Get source config (for FTP credentials)
    const sourceResult = await pool.query(
      `SELECT * FROM vendor_sources WHERE vendor_id = $1 AND source_type IN ('edi_832', 'edi_ftp') LIMIT 1`,
      [vendorId]
    );
    const source = sourceResult.rows[0] || null;

    let skuIndex;

    if (SKIP_EDI) {
      log('Phase 2: SKIPPED (--skip-edi)');
      skuIndex = await buildSkuIndexFromDb(pool, vendorId, log);
    } else {
      // ── Phase 2: EDI 832 Import (upsert — never deletes) ──
      skuIndex = await phase2_edi832(pool, vendorId, source, log);
    }

    if (skuIndex.size === 0) {
      log('No SKUs found. Pipeline cannot continue.');
      return;
    }

    // ── Phase 3: Images ──
    if (!SKIP_IMAGES) {
      await phase3_images(pool, skuIndex, log);
    } else {
      log('Phase 3: SKIPPED (--skip-images)');
    }

    // ── Phase 4: Product Map ──
    await phase4_productMap(pool, vendorId, log);

    // ── Phase 5: Accessory Attachment ──
    await phase5_attachAccessories(pool, vendorId, log);

    // ── Final stats ──
    const { rows: [stats] } = await pool.query(`
      SELECT
        COUNT(DISTINCT p.id) as products,
        COUNT(DISTINCT s.id) as skus,
        COUNT(DISTINCT ma.id) as media_assets,
        COUNT(DISTINCT s.id) FILTER (WHERE EXISTS (
          SELECT 1 FROM media_assets m2 WHERE m2.sku_id = s.id
        )) as skus_with_images,
        COUNT(DISTINCT s.id) FILTER (WHERE s.variant_type = 'accessory') as accessories
      FROM products p
      LEFT JOIN skus s ON s.product_id = p.id
      LEFT JOIN media_assets ma ON ma.product_id = p.id
      WHERE p.vendor_id = $1
    `, [vendorId]);

    log('');
    log('═══════════════════════════════════════════════════════');
    log('  FINAL RESULTS');
    log('═══════════════════════════════════════════════════════');
    log(`  Products:          ${stats.products}`);
    log(`  SKUs:              ${stats.skus}`);
    log(`  Media assets:      ${stats.media_assets}`);
    log(`  SKUs with images:  ${stats.skus_with_images} (${stats.skus > 0 ? (100 * stats.skus_with_images / stats.skus).toFixed(1) : 0}%)`);
    log(`  Accessories:       ${stats.accessories}`);
    log(`  Total time:        ${((Date.now() - startTime) / 1000 / 60).toFixed(1)} minutes`);

  } finally {
    await pool.end();
  }
}


// ═══════════════════════════════════════════════════════════════════════════════
//  Framework export — compatible with scraper framework's run() interface
// ═══════════════════════════════════════════════════════════════════════════════

export async function run(pool, job, source) {
  const log = async (msg) => {
    console.log(msg);
    try { await appendLog(pool, job.id, msg); } catch { }
  };

  const vendorResult = await pool.query('SELECT id FROM vendors WHERE code = $1', [VENDOR_CODE]);
  if (!vendorResult.rows.length) throw new Error('MSI vendor not found');
  const vendorId = vendorResult.rows[0].id;

  await log('Starting MSI Unified Pipeline...');

  let skuIndex;
  if (SKIP_EDI) {
    skuIndex = await buildSkuIndexFromDb(pool, vendorId, log);
  } else {
    skuIndex = await phase2_edi832(pool, vendorId, source, log);
  }
  if (skuIndex.size === 0) { await log('No SKUs found. Aborting.'); return; }
  if (!SKIP_IMAGES) await phase3_images(pool, skuIndex, log);
  await phase4_productMap(pool, vendorId, log);
  await phase5_attachAccessories(pool, vendorId, log);

  await log('MSI Unified Pipeline complete.');
}


// ─── Standalone entry point ──────────────────────────────────────────────────

const isMain = process.argv[1] && (
  process.argv[1].endsWith('msi-unified.js') ||
  process.argv[1] === fileURLToPath(import.meta.url)
);

if (isMain) {
  main().catch(err => {
    console.error('\nFATAL:', err);
    process.exit(1);
  });
}
