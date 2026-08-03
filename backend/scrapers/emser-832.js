/**
 * Emser Tile — EDI 832 Importer (SFTP/FTP)
 *
 * Connects to edi.emser.com, downloads the latest 832 (Price/Sales Catalog)
 * file, parses EDI segments, and upserts products/SKUs/pricing/packaging
 * into the database.
 *
 * Supports both SFTP (port 22, default) and FTP (port 21) based on config.
 * Modeled on engfloors-832.js / daltile-832.js — same EDI parsing logic,
 * adapted for Emser's tile product catalog (porcelain, ceramic, natural stone,
 * decorative, outdoor).
 *
 * Config (vendor_sources.config):
 *   transport — 'sftp' (default) or 'ftp'
 *   sftp_host/ftp_host, sftp_port/ftp_port, sftp_user/ftp_user, sftp_pass/ftp_pass
 *   processed_files — array of filenames already imported (auto-maintained)
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { Client: FtpClient } = require('basic-ftp');
const SftpClient = require('ssh2-sftp-client');

import fs from 'fs';
import {
  appendLog, addJobError,
  upsertProduct, upsertSku,
  upsertSkuAttribute, upsertPackaging, upsertPricing,
  normalizeAttributeValue, applySheetSelling,
} from './base.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VENDOR_CODE = 'EMSER';

// Default credentials (overridden by vendor_sources.config or env vars)
const DEFAULT_CONN = {
  host: 'ediftp.emser.com',
  port: 22,
  user: '345253',
  password: 'CnPrElB8v1I6TkInliQr',
  transport: 'sftp',
};

// Directories to scan on the remote server
// Emser drops 832 files into /Inbox (inbound to us)
const REMOTE_DIRS = [
  '/Inbox',
  '/',
];

// Map EDI category text → category slugs in our DB
// Must match slugs used by emser-catalog.js: porcelain-tile, ceramic-tile, natural-stone, mosaic-tile, luxury-vinyl
const CATEGORY_MAP = {
  'porcelain':             'porcelain-tile',
  'porcelain tile':        'porcelain-tile',
  'ceramic':               'ceramic-tile',
  'ceramic tile':          'ceramic-tile',
  'tile':                  'porcelain-tile',
  'floor tile':            'porcelain-tile',
  'wall tile':             'ceramic-tile',
  'natural stone':         'natural-stone',
  'stone':                 'natural-stone',
  'marble':                'natural-stone',
  'travertine':            'natural-stone',
  'slate':                 'natural-stone',
  'granite':               'natural-stone',
  'limestone':             'natural-stone',
  'quartzite':             'natural-stone',
  'onyx':                  'natural-stone',
  'mosaic':                'mosaic-tile',
  'glass':                 'mosaic-tile',
  'glass tile':            'mosaic-tile',
  'glass mosaic':          'mosaic-tile',
  'stone mosaic':          'mosaic-tile',
  'metal mosaic':          'mosaic-tile',
  'decorative':            'mosaic-tile',
  'luxury vinyl':          'luxury-vinyl',
  'luxury vinyl plank':    'luxury-vinyl',
  'luxury vinyl tile':     'luxury-vinyl',
  'lvp':                   'luxury-vinyl',
  'lvt':                   'luxury-vinyl',
  'spc':                   'luxury-vinyl',
  'wpc':                   'luxury-vinyl',
  'vinyl plank':           'luxury-vinyl',
  'vinyl tile':            'luxury-vinyl',
  'outdoor':               'porcelain-tile',
  'paver':                 'porcelain-tile',
  'pavers':                'porcelain-tile',
  'pool tile':             'porcelain-tile',
  'pool coping':           'natural-stone',
  'grout':                 'installation-sundries',
  'setting material':      'installation-sundries',
  'setting materials':     'installation-sundries',
  'caulk':                 'installation-sundries',
  'sealant':               'installation-sundries',
  'adhesive':              'installation-sundries',
  'mortar':                'installation-sundries',
  'backer board':          'installation-sundries',
  'membrane':              'installation-sundries',
  'accessory':             'installation-sundries',
  'accessories':           'installation-sundries',
  'trim':                  'installation-sundries',
  'molding':               'installation-sundries',
  'bullnose':              'installation-sundries',
  'quarter round':         'installation-sundries',
  'underlayment':          'installation-sundries',
};

// PID characteristic codes → human-readable
const PID_CODES = {
  '08': 'description',
  GEN: 'category',
  '09': 'sub_product',
  '73': 'color',
  '74': 'pattern',
  '75': 'finish',
  '35': 'dye_code',
  '37': 'material',
  '38': 'style',
  DIM: 'dimensions',
  MAC: 'material_class',
  TRN: 'trade_name',
  '12': 'quality',
  '77': 'collection',
};

// LIN qualifier codes → field names
const LIN_QUALIFIERS = {
  UP: 'upc', VN: 'vendor_item_number', SK: 'sku',
  MG: 'manufacturer_group', BP: 'buyer_part_number',
  IN: 'buyer_item_number', MN: 'model_number',
  GN: 'generic_name', UA: 'upc_case_code',
  CB: 'catalog_number', FS: 'standard_number',
  EC: 'ean', EN: 'ean', UK: 'upc_shipping',
  PI: 'purchaser_item', PN: 'part_number', VA: 'vendor_alpha',
};

// CTP class and type codes
const CTP_CLASS = { WS: 'wholesale', RS: 'retail', CT: 'contractor', DE: 'dealer', DI: 'distributor' };
const CTP_TYPE = { RES: 'resale', NET: 'net', MSR: 'msrp', UCP: 'unit_cost', PRP: 'promotional', CON: 'contract', MAP: 'map', CAT: 'catalog' };

// MEA qualifier codes
const MEA_CODES = { TH: 'thickness', WD: 'width', LN: 'length', WT: 'weight', WL: 'wear_layer', HT: 'height', SQ: 'area' };


// ---------------------------------------------------------------------------
// EDI 832 Parser
// ---------------------------------------------------------------------------

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
        currentItem = {
          line_number: lin.line_number, identifiers: lin.identifiers,
          descriptions: [], packaging: null, pricing: [], measurements: [],
          vendor_sku: null, upc: null, product_name: null, color: null,
          collection: null, category: null, cost: null, retail_price: null,
          unit_of_measure: null, sqft_per_box: null, pieces_per_box: null,
          weight_per_box_lbs: null, sell_by: null,
          cut_price: null, roll_price: null, cut_cost: null, roll_cost: null, roll_min_sqft: null,
          roll_width_ft: null, map_price: null,
        };
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
        currentItem = {
          line_number: productContext ? productContext.line_number : null,
          identifiers: sln.identifiers,
          descriptions: [], packaging: null, pricing: [], measurements: [],
          vendor_sku: sln.identifiers.sku || null,
          upc: null, product_name: null, color: null,
          collection: null, category: null, cost: null, retail_price: null,
          unit_of_measure: null, sqft_per_box: null, pieces_per_box: null,
          weight_per_box_lbs: null, sell_by: null,
          cut_price: null, roll_price: null, cut_cost: null, roll_cost: null, roll_min_sqft: null,
          roll_width_ft: null, map_price: null,
        };
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
        const mtxType = seg.el[1] || null;
        const mtxText = seg.el[2] || null;
        if (mtxText && currentItem) {
          if (!currentItem.images) currentItem.images = [];
          currentItem.images.push({ type: mtxType, url: mtxText });
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

// MAC (material class) → category slug mapping for Emser
// POR=porcelain, CER=ceramic, STN=stone, MOS=mosaic, GLS=glass, VIN=vinyl
// R=residential, C=commercial
const MAC_CATEGORY_MAP = {
  PORTILR: 'porcelain-tile',
  PORTILC: 'porcelain-tile',
  CERTILR: 'ceramic-tile',
  CERTILC: 'ceramic-tile',
  STNTILR: 'natural-stone',
  STNTILC: 'natural-stone',
  MOSTILR: 'mosaic-tile',
  MOSTILC: 'mosaic-tile',
  GLSTILR: 'mosaic-tile',
  GLSTILC: 'mosaic-tile',
  VINTILR: 'luxury-vinyl',
  VINTILC: 'luxury-vinyl',
  VINMISR: 'installation-sundries',
  SETMTL:  'installation-sundries',
  GRTCAU:  'installation-sundries',
  TRMACC:  'installation-sundries',
  OUTDOR:  'porcelain-tile',
  PAVTIL:  'porcelain-tile',
};

function cleanProductName(raw) {
  if (!raw) return null;
  let name = raw
    .replace(/(\d)\s*�/g, '$1°')  // mangled degree sign (90°)
    .replace(/�/g, '')                 // stray replacement chars (®, ™)
    .replace(/\s*\([^)]*sq(?:ft|yd)[^)]*\)/gi, '')
    .replace(/\s+\d+\.?\d*[xX]\d+\.?\d*/g, '')
    .replace(/\s*buy\s+mult[\d.]*/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  name = name.replace(/\b\w+/g, w =>
    w.length <= 3 && /^(i{1,3}|ii|iv|v|vi|vii|viii|ix|x|spc|lvp|lvt)$/i.test(w)
      ? w.toLowerCase()
      : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
  );
  // "Mosaic On" is a truncated "Mosaic On Mesh" — drop the dangling "On"
  name = name.replace(/\s+On$/i, '');
  return name || null;
}

// Size is encoded as the last 4-digit run of the item code (F78STMOTA1818 →
// 18x18); the feed's own WD/LN measurements are feet-rounded garbage (0x0FT).
// Large-format panels use a 5-digit W(2)+L(3) code (C17EXPA…24142 → 24x142).
function emserSkuSize(vendorSku) {
  const s = String(vendorSku || '');
  const m5 = s.match(/\d{5}(?!.*\d{5})/);
  if (m5) {
    const w = parseInt(m5[0].slice(0, 2), 10);
    const l = parseInt(m5[0].slice(2), 10);
    if (w >= 1 && w <= 60 && l >= 60 && l <= 200) return `${w}x${l}`;
  }
  const m = s.match(/\d{4}(?!.*\d{4})/);
  if (!m) return null;
  const w = parseInt(m[0].slice(0, 2), 10);
  const l = parseInt(m[0].slice(2), 10);
  if (w < 1 || w > 60 || l < 1 || l > 96) return null;
  return `${w}x${l}`;
}

function finalizeItem(item) {
  if (!item.vendor_sku) {
    item.vendor_sku = item.identifiers.vendor_item_number || item.identifiers.model_number || item.identifiers.sku || item.identifiers.part_number || null;
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
  item.collection = collPid ? collPid.description : (item.identifiers.mf || null);

  const catPid = item.descriptions.find(d => d.characteristic_label === 'category' || d.characteristic_code === 'GEN');
  if (catPid) {
    item.category = catPid.description;
  } else {
    const macPid = item.descriptions.find(d => d.characteristic_code === 'MAC');
    if (macPid && macPid.description) {
      item.category = MAC_CATEGORY_MAP[macPid.description.toUpperCase()] || macPid.description;
    }
  }

  // MEA SU (surface area per unit) → sqft_per_box
  const surfMea = item.measurements.find(m => m.qualifier === 'SU');
  if (surfMea && surfMea.value) {
    const suUom = (surfMea.unit_of_measure || '').toUpperCase();
    if (suUom === 'SF' || suUom === 'FT2') {
      item.sqft_per_box = surfMea.value;
      if (!item.sell_by) item.sell_by = 'box';
    } else if (suUom === 'SY') {
      item.sqft_per_box = surfMea.value * 9;
      if (!item.sell_by) item.sell_by = 'box';
    } else if (suUom === 'EA') {
      if (!item.sell_by) item.sell_by = 'unit';
    }
  }

  if (item.packaging) {
    const uom = (item.packaging.unit_of_measure || '').toUpperCase();
    if (!item.sqft_per_box) {
      if (uom === 'SF' || uom === 'FT2') { item.sqft_per_box = item.packaging.size_per_pack; if (!item.sell_by) item.sell_by = 'box'; }
      else if (uom === 'SY') { item.sqft_per_box = item.packaging.size_per_pack * 9; if (!item.sell_by) item.sell_by = 'box'; }
      else if (uom === 'EA' || uom === 'PC') { if (!item.sell_by) item.sell_by = 'unit'; }
      else if (uom === 'LF') { if (!item.sell_by) item.sell_by = 'unit'; }
      else if (item.packaging.size_per_pack) { item.sqft_per_box = item.packaging.size_per_pack; if (!item.sell_by) item.sell_by = 'box'; }
    }
    item.pieces_per_box = item.packaging.pieces_per_pack || null;
    item.weight_per_box_lbs = item.packaging.gross_weight || null;
  }

  // ── Pricing ──
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

  // Convert SY prices to SF (1 SY = 9 SF)
  if (item.unit_of_measure && item.unit_of_measure.toUpperCase() === 'SY') {
    if (item.cost) item.cost = parseFloat((item.cost / 9).toFixed(4));
    if (item.retail_price) item.retail_price = parseFloat((item.retail_price / 9).toFixed(4));
    item.unit_of_measure = 'SF';
  }

  if (!item.sell_by && item.unit_of_measure) {
    const puom = item.unit_of_measure.toUpperCase();
    if (puom === 'SF' || puom === 'SY') item.sell_by = 'box';
    else if (puom === 'EA' || puom === 'PC') item.sell_by = 'unit';
  }

  // Detect accessories by name/category keywords
  const nameAndCat = `${item.product_name || ''} ${item.category || ''}`.toLowerCase();
  if (/trim|bullnose|quarter\s*round|grout|caulk|setting\s*material|mortar|adhesive|sealant|membrane|pencil\s*liner|chair\s*rail|v-cap|mud\s*cap|jolly|schluter/i.test(nameAndCat)) {
    if (!item.sell_by) item.sell_by = 'unit';
  }
}


// ---------------------------------------------------------------------------
// Connection helpers — supports both SFTP and FTP
// ---------------------------------------------------------------------------

function getConnConfig(source) {
  const cfg = source.config || {};
  const transport = (cfg.transport || DEFAULT_CONN.transport).toLowerCase();

  if (transport === 'ftp') {
    return {
      transport: 'ftp',
      host: cfg.ftp_host || process.env.EMSER_FTP_HOST || DEFAULT_CONN.host,
      port: parseInt(cfg.ftp_port || process.env.EMSER_FTP_PORT || 21, 10),
      user: cfg.ftp_user || process.env.EMSER_FTP_USER || DEFAULT_CONN.user,
      password: cfg.ftp_pass || process.env.EMSER_FTP_PASS || DEFAULT_CONN.password,
      secure: cfg.ftp_secure || false,
    };
  }

  return {
    transport: 'sftp',
    host: cfg.sftp_host || process.env.EMSER_SFTP_HOST || DEFAULT_CONN.host,
    port: parseInt(cfg.sftp_port || process.env.EMSER_SFTP_PORT || DEFAULT_CONN.port, 10),
    user: cfg.sftp_user || process.env.EMSER_SFTP_USER || DEFAULT_CONN.user,
    password: cfg.sftp_pass || process.env.EMSER_SFTP_PASS || DEFAULT_CONN.password,
  };
}

/**
 * Create a transport adapter that normalizes SFTP and FTP directory listing/download.
 */
async function createTransport(connConfig, job, pool) {
  if (connConfig.transport === 'ftp') {
    const ftp = new FtpClient();
    ftp.ftp.verbose = false;
    await ftp.access({ host: connConfig.host, port: connConfig.port, user: connConfig.user, password: connConfig.password, secure: connConfig.secure });
    return {
      type: 'ftp',
      list: async (dir) => {
        const listing = await ftp.list(dir);
        return listing.filter(f => f.type === 1).map(f => ({
          name: f.name,
          size: f.size,
          modifiedAt: f.modifiedAt,
          remotePath: `${dir}/${f.name}`.replace('//', '/'),
        }));
      },
      download: async (remotePath, localPath) => {
        await ftp.downloadTo(localPath, remotePath);
      },
      close: () => ftp.close(),
    };
  }

  // SFTP
  const sftp = new SftpClient();
  await sftp.connect({
    host: connConfig.host,
    port: connConfig.port,
    username: connConfig.user,
    password: connConfig.password,
    readyTimeout: 20000,
    retries: 2,
  });
  return {
    type: 'sftp',
    list: async (dir) => {
      const listing = await sftp.list(dir);
      return listing.filter(f => f.type === '-').map(f => ({
        name: f.name,
        size: f.size,
        modifiedAt: new Date(f.modifyTime),
        remotePath: `${dir}/${f.name}`.replace('//', '/'),
      }));
    },
    download: async (remotePath, localPath) => {
      await sftp.fastGet(remotePath, localPath);
    },
    close: async () => { try { await sftp.end(); } catch (_) {} },
  };
}

/**
 * Scan remote directories for 832-like files.
 */
async function findRemote832Files(transport) {
  const allFiles = [];

  for (const dir of REMOTE_DIRS) {
    try {
      const files = await transport.list(dir);
      const matching = files.filter(f => {
        const name = f.name.toLowerCase();
        return name.includes('832') || name.includes('catalog') || name.includes('pricelist')
          || name.includes('price_catalog') || name.endsWith('.edi') || name.endsWith('.x12')
          || name.endsWith('.832');
      });
      allFiles.push(...matching);
    } catch {
      // Directory doesn't exist or no access — skip
    }
  }

  allFiles.sort((a, b) => (b.modifiedAt?.getTime() || 0) - (a.modifiedAt?.getTime() || 0));
  return allFiles;
}


// ---------------------------------------------------------------------------
// Product grouping
// ---------------------------------------------------------------------------

function groupIntoProducts(items) {
  const products = new Map();

  for (const item of items) {
    if (!item.vendor_sku && !item.product_name) continue;
    // Feed placeholder rows with no usable description ("ZITEMS" bucket)
    if (/^z-?items$/i.test((item.product_name || '').trim())) continue;

    const collection = item.collection || '';
    const category = item.category || '';
    // The 832 "collection" is the manufacturer. Anything not from Emser's own
    // tile line (Laticrete, Rubi, Nuheat, ... plus Emser's Signature Series
    // profiles and Empervious shower systems) is an installation sundry or
    // hardware — classify as accessory so it stays out of the tile browse.
    const isSundry = collection !== '' && !/^EMSER TILE/i.test(collection);
    // A mosaic sheet is a field product, never an installation sundry — don't let
    // a non-"EMSER TILE" manufacturer string (isSundry) tag it as accessory.
    // Genuine mosaic trim (bullnose/pencil/…) is still caught by the trim checks.
    const looksMosaic = /mosaic/i.test(category) || /mosaic/i.test(item.product_name || '');
    const isAccessory = (isSundry && !looksMosaic)
      || /accessory|sundries|trim|molding|bullnose|quarter\s*round|grout|caulk|setting\s*material|mortar|adhesive|sealant|membrane|pencil\s*liner|chair\s*rail|v-cap|mud\s*cap|jolly|schluter|elevel|\b(?:sbn|cove|og|tread|riser|skirting|shelf|corner)\b/i.test(category)
      || /accessory|sundries|trim|molding|bullnose|quarter\s*round|grout|caulk|setting\s*material|mortar|adhesive|sealant|membrane|pencil\s*liner|chair\s*rail|v-cap|mud\s*cap|jolly|schluter|elevel|\b(?:sbn|cove|og|tread|riser|skirting|shelf|corner)\b/i.test(item.product_name || '');

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

  return Array.from(products.values());
}

function makeInternalSku(vendorSku, productName) {
  if (vendorSku) {
    return vendorSku.toUpperCase().startsWith('EMSER-') ? vendorSku : `EMSER-${vendorSku}`;
  }
  const slug = (productName || 'UNKNOWN').toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 30);
  return `EMSER-${slug}`;
}


// ---------------------------------------------------------------------------
// Main run() — called by the scraper framework
// ---------------------------------------------------------------------------

export async function run(pool, job, source) {
  const connConfig = getConnConfig(source);
  const processedFiles = (source.config || {}).processed_files || [];

  await appendLog(pool, job.id, `Connecting to ${connConfig.host}:${connConfig.port} via ${connConfig.transport} as ${connConfig.user}...`);

  let transport;
  let localPath = null;
  let downloadedFileName = null;

  try {
    // ── Step 1: Connect and find files ──
    transport = await createTransport(connConfig, job, pool);
    await appendLog(pool, job.id, `${connConfig.transport.toUpperCase()} connected. Scanning for 832 files...`);

    const remoteFiles = await findRemote832Files(transport);
    await appendLog(pool, job.id, `Found ${remoteFiles.length} 832 candidate file(s)`);

    if (remoteFiles.length === 0) {
      await appendLog(pool, job.id, 'No 832 files found on remote server. Nothing to import.');
      return;
    }

    // Log all found files
    for (const f of remoteFiles) {
      const sizeKb = (f.size / 1024).toFixed(1);
      const mod = f.modifiedAt ? f.modifiedAt.toISOString().slice(0, 19) : 'unknown';
      const already = processedFiles.includes(f.name) ? ' [already processed]' : '';
      await appendLog(pool, job.id, `  ${f.remotePath} (${sizeKb}KB, ${mod})${already}`);
    }

    // Find newest unprocessed file
    const unprocessed = remoteFiles.filter(f => !processedFiles.includes(f.name));
    if (unprocessed.length === 0) {
      await appendLog(pool, job.id, 'All files have been processed already. Nothing new to import.');
      return;
    }

    const target = unprocessed[0];
    downloadedFileName = target.name;
    await appendLog(pool, job.id, `Downloading: ${target.remotePath} (${(target.size / 1024).toFixed(1)}KB)`);

    // ── Step 2: Download ──
    localPath = `/tmp/emser_832_${Date.now()}.edi`;
    await transport.download(target.remotePath, localPath);
    await appendLog(pool, job.id, `Downloaded to ${localPath}`);

  } catch (err) {
    await addJobError(pool, job.id, `${connConfig.transport.toUpperCase()} error: ${err.message}`);
    await appendLog(pool, job.id, `Connection failed: ${err.message}`);
    throw err;
  } finally {
    if (transport) {
      try { await transport.close(); } catch (_) {}
    }
  }

  // ── Step 3: Parse EDI ──
  await appendLog(pool, job.id, 'Parsing EDI 832...');
  const raw = fs.readFileSync(localPath, 'utf-8');
  const catalog = parse832(raw);
  await appendLog(pool, job.id, `Parsed ${catalog.items.length} items from ${catalog.summary.segment_count} segments`);

  if (catalog.items.length === 0) {
    await appendLog(pool, job.id, 'No items found in 832 file. Skipping import.');
    return;
  }

  // ── Step 4: Resolve vendor and categories ──
  const vendorResult = await pool.query('SELECT id FROM vendors WHERE code = $1', [VENDOR_CODE]);
  if (!vendorResult.rows.length) {
    throw new Error(`Vendor with code "${VENDOR_CODE}" not found. Create the vendor record first.`);
  }
  const vendorId = vendorResult.rows[0].id;

  const catCache = {};
  const catResult = await pool.query('SELECT id, slug FROM categories');
  for (const row of catResult.rows) catCache[row.slug] = row.id;
  const unmappedCats = new Map();
  const resolveCatId = (categoryText) => {
    if (!categoryText) return null;
    if (catCache[categoryText]) return catCache[categoryText];
    const slug = CATEGORY_MAP[categoryText.toLowerCase().trim()];
    const id = slug ? (catCache[slug] || null) : null;
    if (!id) unmappedCats.set(categoryText, (unmappedCats.get(categoryText) || 0) + 1);
    return id;
  };
  // Resolve just the canonical category slug (mosaic-tile, stacked-stone, …) so
  // the per-sheet selling rule can be applied before writing pricing.
  const resolveCatSlug = (categoryText) => {
    if (!categoryText) return null;
    if (catCache[categoryText]) return categoryText;
    return CATEGORY_MAP[categoryText.toLowerCase().trim()] || null;
  };

  // ── Step 5: Group and import ──
  const productGroups = groupIntoProducts(catalog.items);
  await appendLog(pool, job.id, `Grouped into ${productGroups.length} products`, { products_found: catalog.items.length });

  // Pre-cache attribute IDs to avoid per-item lookups (~56K redundant queries)
  const attrIdCache = new Map();
  const attrRows = await pool.query('SELECT id, slug FROM attributes');
  for (const row of attrRows.rows) attrIdCache.set(row.slug, row.id);

  async function cachedUpsertAttr(skuId, slug, rawValue) {
    const value = normalizeAttributeValue(slug, rawValue);
    if (!value) return;
    const attrId = attrIdCache.get(slug);
    if (!attrId) return;
    await pool.query(`
      INSERT INTO sku_attributes (sku_id, attribute_id, value)
      VALUES ($1, $2, $3)
      ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value = EXCLUDED.value
    `, [skuId, attrId, value]);
  }

  let productsCreated = 0, productsUpdated = 0, skusCreated = 0, skusUpdated = 0;
  let pricingUpserted = 0, packagingUpserted = 0, attrsUpserted = 0;
  let totalItems = 0;
  let importErrors = 0;

  for (let gi = 0; gi < productGroups.length; gi++) {
   try {
    const group = productGroups[gi];
    const categoryId = resolveCatId(group.category);
    const categorySlug = resolveCatSlug(group.category);

    // SKU-first product resolution: the catalog scraper renames product
    // collections (part of the (vendor, collection, name) upsert key), so an
    // upsert here would fork a duplicate product row for every renamed product.
    // If any of this group's SKUs already exist, reuse their product.
    let productId = null;
    const groupInternalSkus = group.items
      .map(it => makeInternalSku(it.vendor_sku, it.product_name))
      .filter(Boolean);
    if (groupInternalSkus.length) {
      const existing = await pool.query(
        `SELECT s.product_id FROM skus s
         WHERE s.internal_sku = ANY($1) AND s.product_id IS NOT NULL
         GROUP BY s.product_id ORDER BY COUNT(*) DESC LIMIT 1`,
        [groupInternalSkus]
      );
      if (existing.rows.length) {
        productId = existing.rows[0].product_id;
        productsUpdated++;
      }
    }
    if (!productId) {
      const productRow = await upsertProduct(pool, {
        vendor_id: vendorId,
        name: group.baseName,
        // The feed's "collection" is the manufacturer. For Emser's own tile
        // that is display noise ("EMSER TILE LLC") — leave blank and let the
        // catalog scraper fill in the real series for website-listed items.
        collection: /^EMSER TILE/i.test(group.collection || '') ? '' : (group.collection || ''),
        category_id: categoryId,
        description_short: group.items[0].product_name || null,
      });
      productId = productRow.id;
      if (productRow.is_new) productsCreated++; else productsUpdated++;
    }

    // Emser publishes superseded twin codes for the same physical item (legacy
    // code + its V2 reissue, and SW-prefixed sample twins). Skip the stale twin
    // so it isn't upserted/reactivated — the discontinuation grace window then
    // retires it naturally.
    const groupCodes = new Set(group.items.map(it => it.vendor_sku).filter(Boolean));
    const importItems = group.items.filter(it => {
      if (!it.vendor_sku) return true;
      if (groupCodes.has(it.vendor_sku + 'V2')) return false;
      if (it.vendor_sku.startsWith('SW') && groupCodes.has(it.vendor_sku.slice(2))) return false;
      return true;
    });

    // Same color in multiple sizes within a product needs the size in the
    // variant name, or the variant pills collapse to identical labels.
    const colorCounts = new Map();
    for (const it of importItems) {
      const c = (it.color || '').trim().toUpperCase();
      if (c) colorCounts.set(c, (colorCounts.get(c) || 0) + 1);
    }

    for (const item of importItems) {
      totalItems++;
      const internalSku = makeInternalSku(item.vendor_sku, item.product_name);
      const vendorSku = item.vendor_sku || internalSku;
      const sellBy = item.sell_by || 'box';
      const variantType = group.isAccessory ? 'accessory' : null;
      // Strip trailing size pattern from color (e.g. "Fawn 2x8" → "Fawn");
      // the feed uses XXX / N/A as color placeholders — treat as no color.
      let rawColor = item.color || item.product_name || null;
      if (rawColor && /^(x{2,}|n\/?a)$/i.test(rawColor.trim())) rawColor = null;
      let variantName = rawColor ? rawColor.replace(/\s+\d+x\d+$/i, '').trim() || rawColor : null;
      if (variantName && (colorCounts.get((item.color || '').trim().toUpperCase()) || 0) > 1) {
        const size = emserSkuSize(item.vendor_sku);
        if (size) variantName = `${variantName} ${size}`;
      }

      // Pricing — always create a row so downstream scrapers can UPDATE
      // without hitting the retail_price NOT NULL constraint.
      const cost = item.cost || 0;
      // If retail == cost (Emser 832 often has single price tier), apply 2x markup
      const retail = (item.retail_price && item.retail_price !== cost)
        ? item.retail_price
        : Math.round(cost * 2 * 100) / 100;
      // Mosaics / stacked stone sell per sheet, not by the box — convert the
      // per-sqft price to a per-sheet price using the box packaging (see
      // selling-conventions). Ambiguous boxes (no piece count) stay as-is.
      const sheet = applySheetSelling({
        categorySlug, sellBy, name: `${group.baseName} ${variantName || ''}`,
        sqft_per_box: item.sqft_per_box, pieces_per_box: item.pieces_per_box,
        cost, retail_price: retail,
      });

      const skuRow = await upsertSku(pool, {
        product_id: productId,
        vendor_sku: vendorSku,
        internal_sku: internalSku,
        variant_name: variantName,
        sell_by: sheet.sellBy,
        variant_type: variantType,
      });
      const skuId = skuRow.id;
      if (skuRow.is_new) skusCreated++; else skusUpdated++;

      // Re-activate SKUs that reappear in the 832 feed
      await pool.query(
        `UPDATE skus SET status = 'active', updated_at = NOW() WHERE id = $1 AND status != 'active'`,
        [skuId]
      );

      await upsertPricing(pool, skuId, {
        cost: sheet.cost,
        retail_price: sheet.retail_price,
        price_basis: sheet.priceBasis,
        cut_price: item.cut_price || null,
        roll_price: item.roll_price || null,
        cut_cost: item.cut_cost || null,
        roll_cost: item.roll_cost || null,
        roll_min_sqft: item.roll_min_sqft || null,
        map_price: item.map_price || null,
      });
      pricingUpserted++;

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

      // Attributes (using cached attribute IDs — avoids per-call DB lookups)
      if (item.color) { await cachedUpsertAttr(skuId, 'color', item.color); attrsUpserted++; }
      if (item.upc) { await cachedUpsertAttr(skuId, 'upc', item.upc); attrsUpserted++; }

      const finishPid = item.descriptions.find(d => d.characteristic_label === 'finish');
      if (finishPid) { await cachedUpsertAttr(skuId, 'finish', finishPid.description); attrsUpserted++; }

      const materialPid = item.descriptions.find(d => d.characteristic_label === 'material');
      if (materialPid) { await cachedUpsertAttr(skuId, 'material', materialPid.description); attrsUpserted++; }

      const thickMea = item.measurements.find(m => m.qualifier === 'TH');
      if (thickMea) { await cachedUpsertAttr(skuId, 'thickness', `${thickMea.value}${thickMea.unit_of_measure || ''}`); attrsUpserted++; }

      const widthMea = item.measurements.find(m => m.qualifier === 'WD');
      const lengthMea = item.measurements.find(m => m.qualifier === 'LN');
      // Feed WD/LN come in rounded feet ("2x2FT" for a 24x24) — useless for
      // display and they poison size filtering. Prefer the inch size decoded
      // from the item code; only fall back to measurements in non-FT units.
      const decodedSize = emserSkuSize(item.vendor_sku);
      if (decodedSize) {
        await cachedUpsertAttr(skuId, 'size', decodedSize);
        attrsUpserted++;
      } else if (widthMea && lengthMea && !/^ft$/i.test(lengthMea.unit_of_measure || '')) {
        await cachedUpsertAttr(skuId, 'size', `${widthMea.value}x${lengthMea.value}${lengthMea.unit_of_measure || ''}`);
        attrsUpserted++;
      }

      const stylePid = item.descriptions.find(d => d.characteristic_label === 'style');
      if (stylePid) { await cachedUpsertAttr(skuId, 'style', stylePid.description); attrsUpserted++; }

      const patternPid = item.descriptions.find(d => d.characteristic_label === 'pattern');
      if (patternPid) { await cachedUpsertAttr(skuId, 'pattern', patternPid.description); attrsUpserted++; }

      const wearMea = item.measurements.find(m => m.qualifier === 'WL');
      if (wearMea) { await cachedUpsertAttr(skuId, 'wear_layer', `${wearMea.value}${wearMea.unit_of_measure || 'mil'}`); attrsUpserted++; }

      const weightMea = item.measurements.find(m => m.qualifier === 'WT');
      if (weightMea) { await cachedUpsertAttr(skuId, 'weight', `${weightMea.value}${weightMea.unit_of_measure || 'LB'}`); attrsUpserted++; }

      if (widthMea && !lengthMea) {
        await cachedUpsertAttr(skuId, 'width', `${widthMea.value}${widthMea.unit_of_measure || ''}`);
        attrsUpserted++;
      }
    }

    if ((gi + 1) % 200 === 0) {
      await appendLog(pool, job.id,
        `Import progress: ${gi + 1}/${productGroups.length} products, ${totalItems} items, ` +
        `${skusCreated} SKUs created, ${pricingUpserted} pricing, ${attrsUpserted} attrs`,
        { products_found: catalog.items.length, products_created: productsCreated, skus_created: skusCreated }
      );
    }
   } catch (groupErr) {
      importErrors++;
      await addJobError(pool, job.id, `Product group ${gi} (${productGroups[gi]?.baseName || '?'}): ${groupErr.message}`);
      if (importErrors > 50) {
        await appendLog(pool, job.id, `Too many import errors (${importErrors}), aborting...`);
        break;
      }
   }
  }

  // ── Step 5b: Discontinuation detection ──
  // Emser publishes multiple 832 catalog streams (e.g. legacy + Z-series item codes),
  // so a single file is NOT the full catalog. A SKU is only considered discontinued
  // when it has been absent from every processed 832 for a grace period — in-file
  // SKUs get updated_at bumped by the upsert above, so updated_at doubles as last-seen.
  const DISCONTINUE_GRACE_DAYS = 21;
  if (catalog.items.length >= 10) {
    const importedSkus = new Set();
    for (const group of productGroups) {
      for (const item of group.items) {
        importedSkus.add(makeInternalSku(item.vendor_sku, item.product_name));
      }
    }

    const activeResult = await pool.query(
      `SELECT s.id, s.internal_sku,
              (s.updated_at < NOW() - INTERVAL '1 day' * $2) AS past_grace
       FROM skus s
       JOIN products p ON s.product_id = p.id
       WHERE p.vendor_id = $1 AND s.status = 'active'`,
      [vendorId, DISCONTINUE_GRACE_DAYS]
    );

    const stale = activeResult.rows.filter(r => !importedSkus.has(r.internal_sku) && r.past_grace);
    const missingButRecent = activeResult.rows.filter(r => !importedSkus.has(r.internal_sku) && !r.past_grace).length;

    // Safety valve: never mass-deactivate. A vendor feed anomaly (partial file,
    // format change) should be investigated, not silently applied.
    const cap = Math.floor(activeResult.rows.length * 0.2);
    if (stale.length > cap) {
      await appendLog(pool, job.id, `WARNING: ${stale.length} SKUs eligible for deactivation exceeds 20% safety cap (${cap}) — skipping discontinuation. Investigate the 832 feed.`);
    } else {
      let deactivated = 0;
      for (const row of stale) {
        await pool.query(
          `UPDATE skus SET status = 'inactive', updated_at = NOW() WHERE id = $1`,
          [row.id]
        );
        deactivated++;
      }
      if (deactivated > 0) {
        await appendLog(pool, job.id, `Deactivated ${deactivated} SKUs absent from all 832s for ${DISCONTINUE_GRACE_DAYS}+ days`);
      }
    }
    if (missingButRecent > 0) {
      await appendLog(pool, job.id, `${missingButRecent} SKUs missing from this 832 but seen recently (other catalog stream) — left active`);
    }
  }

  // ── Step 5c: Product status reconciliation ──
  // Vendor-wide (not just products touched this run) because the 832 streams are
  // split catalogs — a product created by an earlier file may only become sellable
  // (priced, active SKUs) after a later file lands.
  const activateResult = await pool.query(
    `UPDATE products p SET status = 'active', updated_at = NOW()
     WHERE p.vendor_id = $1 AND p.status = 'draft'
       AND EXISTS (
         SELECT 1 FROM skus s
         JOIN pricing pr ON pr.sku_id = s.id
         WHERE s.product_id = p.id AND s.status = 'active' AND pr.retail_price > 0
       )`,
    [vendorId]
  );
  const emptyResult = await pool.query(
    `UPDATE products p SET status = 'inactive', updated_at = NOW()
     WHERE p.vendor_id = $1 AND p.status = 'active'
       AND NOT EXISTS (
         SELECT 1 FROM skus s WHERE s.product_id = p.id AND s.status = 'active'
       )`,
    [vendorId]
  );
  if (activateResult.rowCount > 0 || emptyResult.rowCount > 0) {
    await appendLog(pool, job.id, `Product status: activated ${activateResult.rowCount} drafts with priced active SKUs, deactivated ${emptyResult.rowCount} with no active SKUs`);
  }

  if (unmappedCats.size) {
    const top = [...unmappedCats.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)
      .map(([c, n]) => `${c} (${n})`).join(', ');
    await appendLog(pool, job.id, `Unmapped category codes — extend CATEGORY_MAP/MAC_CATEGORY_MAP: ${top}`);
  }

  await appendLog(pool, job.id, `Import complete: ${productsCreated} products created, ${productsUpdated} updated, ${skusCreated} SKUs created, ${skusUpdated} updated`, {
    products_created: productsCreated,
    products_updated: productsUpdated,
    skus_created: skusCreated,
  });
  await appendLog(pool, job.id, `  Pricing: ${pricingUpserted}, Packaging: ${packagingUpserted}, Attributes: ${attrsUpserted}`);

  // ── Step 6: Mark file as processed ──
  if (downloadedFileName) {
    const newProcessed = [...processedFiles, downloadedFileName];
    await pool.query(
      `UPDATE vendor_sources SET config = jsonb_set(COALESCE(config, '{}'), '{processed_files}', $1::jsonb), updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
      [JSON.stringify(newProcessed), source.id]
    );
    await appendLog(pool, job.id, `Marked "${downloadedFileName}" as processed (${newProcessed.length} total files tracked)`);
  }

  // Cleanup temp file
  try { fs.unlinkSync(localPath); } catch { }
}
