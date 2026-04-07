/**
 * Engineered Floors — EDI 832 FTP Importer
 *
 * Connects to ftp.engfloors.org via FTP, downloads the latest 832 (Price/Sales Catalog)
 * file, parses EDI segments, and upserts products/SKUs/pricing/packaging into the database.
 *
 * Unlike web scrapers, this module uses FTP + EDI parsing — no Puppeteer needed.
 *
 * Config (vendor_sources.config):
 *   ftp_host, ftp_port, ftp_user, ftp_pass — connection credentials
 *   processed_files — array of filenames already imported (auto-maintained)
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { Client: FtpClient } = require('basic-ftp');

import fs from 'fs';
import {
  appendLog, addJobError,
  upsertProduct, upsertSku,
  upsertSkuAttribute, upsertPackaging, upsertPricing,
} from './base.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VENDOR_CODE = 'EF';

// Default FTP credentials (overridden by vendor_sources.config or env vars)
const DEFAULT_FTP = {
  host: process.env.EF_FTP_HOST || 'ftp.engfloors.org',
  port: parseInt(process.env.EF_FTP_PORT || '21', 10),
  user: process.env.EF_FTP_USER || '18110',
  password: process.env.EF_FTP_PASS || '',
};

// Directories to scan on the remote server (OpenAS2 + standard EDI paths)
const REMOTE_DIRS = [
  '/opt/OpenAS2/data', '/opt/OpenAS2/data/toAny',
  '/opt/OpenAS2/data/fromAny', '/opt/OpenAS2',
  '/outbound', '/inbound', '/out', '/in', '/832',
  '/Outbound', '/Inbound', '/OUT', '/IN',
  '/data', '/data/outbound', '/data/inbound',
  '/edi', '/edi/outbound', '/edi/inbound',
  '/export', '/import',
  '/var/data', '/var/edi', '/var/spool',
  '/opt', '/tmp',
  '/home/18110', '/sftpusers/18110',
  '/',
];

// Transition suffix patterns — used to derive collection name from accessory products
const TRANSITION_SUFFIXES = /\s+(2-stair Treads|End Cap|Flush Stairnose|Overlap Stairnose|Quarter|Reducer|T-Mold|Wall Base|Universal Stairnose|Stair Tread)$/i;

// Map EDI category text → category slugs in our DB
const CATEGORY_MAP = {
  'luxury vinyl plank':  'luxury-vinyl',
  'luxury vinyl tile':   'luxury-vinyl',
  'lvp':                 'luxury-vinyl',
  'lvt':                 'luxury-vinyl',
  'spc':                 'luxury-vinyl',
  'wpc':                 'luxury-vinyl',
  'vinyl plank':         'luxury-vinyl',
  'vinyl tile':          'luxury-vinyl',
  'engineered hardwood': 'hardwood',
  'hardwood':            'hardwood',
  'laminate':            'laminate',
  'carpet':              'carpet-tile',
  'carpet tile':         'carpet-tile',
  'broadloom':           'carpet-tile',
  'tile':                'tile',
  'porcelain':           'tile',
  'ceramic':             'tile',
  'accessory':           'installation-sundries',
  'accessories':         'installation-sundries',
  'trim':                'installation-sundries',
  'molding':             'installation-sundries',
  'underlayment':        'installation-sundries',
  'adhesive':            'installation-sundries',
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
// EDI 832 Parser (same logic as import-engfloors-832.cjs)
// ---------------------------------------------------------------------------

function tokenizeSegments(raw) {
  let text = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  // Count tildes vs newlines to detect true segment terminator
  const tildeCount = (text.match(/~/g) || []).length;
  const lineCount = (text.match(/\n/g) || []).length;
  if (tildeCount > 10 && tildeCount >= lineCount * 0.5) {
    // ~ is the real segment terminator (standard EDI)
    return text.split('~').map(s => s.trim()).filter(Boolean);
  }
  // Newline-terminated (or ~ only in ISA envelope) — strip trailing ~
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
    basis_code: seg.el[9] || null, // ST=style/retail, CT=contract/cost, PL=pallet
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

// MAC (material class) → category slug mapping
const MAC_CATEGORY_MAP = {
  CARINDR: 'carpet-tile',   // Carpet Indoor Residential
  CARINDC: 'carpet-tile',   // Carpet Indoor Commercial
  CARTILR: 'carpet-tile',   // Carpet Tile Residential
  CARTILC: 'carpet-tile',   // Carpet Tile Commercial
  VINTILR: 'luxury-vinyl',  // Vinyl Tile/LVP Residential
  VINTILC: 'luxury-vinyl',  // Vinyl Tile/LVP Commercial
  VINMISR: 'installation-sundries', // Vinyl Misc (accessories)
};

function cleanProductName(raw) {
  if (!raw) return null;
  let name = raw
    .replace(/\s*\([^)]*sq(?:ft|yd)[^)]*\)/gi, '')
    .replace(/\s+\d+\.?\d*[xX]\d+\.?\d*/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  name = name.replace(/\b\w+/g, w =>
    w.length <= 3 && /^(i{1,3}|ii|iv|v|vi|vii|viii|ix|x|spc|lvp|lvt)$/i.test(w)
      ? w.toLowerCase()
      : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
  );
  return name || null;
}

function finalizeItem(item) {
  if (!item.vendor_sku) {
    item.vendor_sku = item.identifiers.vendor_item_number || item.identifiers.model_number || item.identifiers.sku || item.identifiers.part_number || null;
  }
  item.upc = item.identifiers.upc || null;

  // Product name: prefer TRN (trade name), skip PID 08 entries that look like SKU cross-refs
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

  // Collection: from PID 77, or manufacturer brand from LIN MF
  const collPid = item.descriptions.find(d => d.characteristic_label === 'collection');
  item.collection = collPid ? collPid.description : (item.identifiers.mf || null);

  // Category: from PID GEN, or MAC (material class) code
  const catPid = item.descriptions.find(d => d.characteristic_label === 'category' || d.characteristic_code === 'GEN');
  if (catPid) {
    item.category = catPid.description;
  } else {
    const macPid = item.descriptions.find(d => d.characteristic_code === 'MAC');
    if (macPid && macPid.description) {
      item.category = MAC_CATEGORY_MAP[macPid.description.toUpperCase()] || macPid.description;
    }
  }

  // Brand from LIN MF identifier (e.g. "Dream Weaver", "Pentz", "J+J Flooring")
  item.brand = item.identifiers.mf || item.identifiers.manufacturer_brand || null;

  // MEA SU (surface area per unit) → sqft_per_box
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

  // Packaging → sqft_per_box / pieces_per_box (if not already set from MEA SU)
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

  // ── Pricing ──
  // Handle LPR with basis_code levels: CT=cost, ST=retail, PL=pallet
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
    // Standard EDI pricing fallback
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
    if (puom === 'SF' || puom === 'SY') item.sell_by = 'sqft';
    else if (puom === 'EA' || puom === 'PC') item.sell_by = 'unit';
  }

  // Carpet pricing: extract cut/roll tiers from LPR basis codes
  const isCarpetCat = /carpet/i.test(item.category || '');
  if (isCarpetCat && lprPrices.length > 0) {
    const stP = lprPrices.find(p => p.basis_code === 'ST');
    const ctP = lprPrices.find(p => p.basis_code === 'CT');
    if (stP) { item.cut_price = stP.unit_price; item.roll_price = stP.unit_price; }
    if (ctP) { item.cut_cost = ctP.unit_price; item.roll_cost = ctP.unit_price; }
    // Convert SY to SF for carpet cut/roll prices
    if (stP && (stP.unit_of_measure || '').toUpperCase() === 'SY') {
      if (item.cut_price) item.cut_price = parseFloat((item.cut_price / 9).toFixed(4));
      if (item.roll_price) item.roll_price = parseFloat((item.roll_price / 9).toFixed(4));
    }
    if (ctP && (ctP.unit_of_measure || '').toUpperCase() === 'SY') {
      if (item.cut_cost) item.cut_cost = parseFloat((item.cut_cost / 9).toFixed(4));
      if (item.roll_cost) item.roll_cost = parseFloat((item.roll_cost / 9).toFixed(4));
    }
    // Roll width from WD measurement
    const widthMea = item.measurements.find(m => m.qualifier === 'WD');
    if (widthMea && widthMea.value) {
      const w = widthMea.value;
      const wuom = (widthMea.unit_of_measure || '').toUpperCase();
      item.roll_width_ft = (wuom === 'IN' || w > 24) ? w / 12 : w;
    }
  }
}


// ---------------------------------------------------------------------------
// FTP helpers
// ---------------------------------------------------------------------------

function getFtpConfig(source) {
  const cfg = source.config || {};
  return {
    host: cfg.ftp_host || process.env.ENGFLOORS_FTP_HOST || process.env.ENGFLOORS_SFTP_HOST || DEFAULT_FTP.host,
    port: parseInt(cfg.ftp_port || process.env.ENGFLOORS_FTP_PORT || process.env.ENGFLOORS_SFTP_PORT || DEFAULT_FTP.port, 10),
    user: cfg.ftp_user || process.env.ENGFLOORS_FTP_USER || process.env.ENGFLOORS_SFTP_USER || DEFAULT_FTP.user,
    password: cfg.ftp_pass || process.env.ENGFLOORS_FTP_PASS || process.env.ENGFLOORS_SFTP_PASS || DEFAULT_FTP.password,
  };
}

/**
 * Scan remote directories for 832-like files.
 * Returns array of { name, size, modifiedAt, remotePath }.
 */
async function findRemote832Files(ftpClient) {
  const allFiles = [];

  for (const dir of REMOTE_DIRS) {
    try {
      const listing = await ftpClient.list(dir);
      const matching = listing
        .filter(f => f.type === 1) // basic-ftp: 1=file, 2=directory
        .filter(f => {
          const name = f.name.toLowerCase();
          return name.includes('832') || name.includes('catalog') || name.includes('pricelist')
            || name.includes('price_catalog') || name.endsWith('.edi') || name.endsWith('.x12');
        })
        .map(f => ({ ...f, dir, remotePath: `${dir}/${f.name}`.replace('//', '/') }));
      allFiles.push(...matching);
    } catch {
      // Directory doesn't exist or no access — skip
    }
  }

  // Sort newest first (basic-ftp returns Date objects for modifiedAt)
  allFiles.sort((a, b) => (b.modifiedAt?.getTime() || 0) - (a.modifiedAt?.getTime() || 0));
  return allFiles;
}


// ---------------------------------------------------------------------------
// Product grouping (same logic as import script)
// ---------------------------------------------------------------------------

function groupIntoProducts(items) {
  const products = new Map();

  for (const item of items) {
    if (!item.vendor_sku && !item.product_name) continue;

    // Skip Pentz brand items — these are handled by the PC vendor importer
    if (item.brand && /^pentz$/i.test(item.brand.trim())) continue;

    const collection = item.collection || '';
    const category = item.category || '';
    const isAccessory = /accessory|sundries|trim|molding|transition|reducer|stairnose|t-bar|quarter|threshold|end.?cap|t.?mold|ovrlp|flshst|2strtr/i.test(category)
      || /accessory|sundries|trim|molding|transition|reducer|stairnose|t-bar|quarter|threshold|end.?cap|t.?mold|ovrlp|flshst|2strtr/i.test(item.product_name || '');

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

    // Derive collection: strip transition suffixes and roman numerals from base name
    let derivedCollection = collection;
    if (!derivedCollection) {
      derivedCollection = baseName
        .replace(TRANSITION_SUFFIXES, '')
        .replace(/\s+(I{1,3}|IV|V|VI{0,3})\s*$/, '')
        .trim();
    }

    const key = `${collection}|||${baseName}|||${isAccessory ? 'acc' : 'main'}`;
    if (!products.has(key)) {
      products.set(key, { baseName, collection: derivedCollection, category, isAccessory, items: [] });
    }
    products.get(key).items.push(item);
  }

  return Array.from(products.values());
}

function makeInternalSku(vendorSku, productName) {
  if (vendorSku) {
    return vendorSku.toUpperCase().startsWith('EF-') ? vendorSku : `EF-${vendorSku}`;
  }
  const slug = (productName || 'UNKNOWN').toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 30);
  return `EF-${slug}`;
}


// ---------------------------------------------------------------------------
// Main run() — called by the scraper framework
// ---------------------------------------------------------------------------

export async function run(pool, job, source) {
  const ftpConfig = getFtpConfig(source);
  const processedFiles = (source.config || {}).processed_files || [];

  await appendLog(pool, job.id, `Connecting to ${ftpConfig.host}:${ftpConfig.port} as ${ftpConfig.user}...`);

  const ftp = new FtpClient();
  ftp.ftp.verbose = false;
  let localPath = null;
  let downloadedFileName = null;

  try {
    // ── Step 1: Connect and find files ──
    await ftp.access({ ...ftpConfig, secure: false });
    await appendLog(pool, job.id, 'FTP connected. Scanning for 832 files...');

    const remoteFiles = await findRemote832Files(ftp);
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

    const target = unprocessed[0]; // newest first (already sorted)
    downloadedFileName = target.name;
    await appendLog(pool, job.id, `Downloading: ${target.remotePath} (${(target.size / 1024).toFixed(1)}KB)`);

    // ── Step 2: Download ──
    localPath = `/tmp/engfloors_832_${Date.now()}.edi`;
    await ftp.downloadTo(localPath, target.remotePath);
    await appendLog(pool, job.id, `Downloaded to ${localPath}`);

  } catch (err) {
    await addJobError(pool, job.id, `FTP error: ${err.message}`);
    await appendLog(pool, job.id, `FTP connection failed: ${err.message}`);
    throw err;
  } finally {
    ftp.close();
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

  // Pre-fetch category IDs
  const catCache = {};
  const catResult = await pool.query('SELECT id, slug FROM categories');
  for (const row of catResult.rows) catCache[row.slug] = row.id;
  const resolveCatId = (categoryText) => {
    if (!categoryText) return null;
    if (catCache[categoryText]) return catCache[categoryText]; // already a slug (from MAC)
    const slug = CATEGORY_MAP[categoryText.toLowerCase().trim()];
    return slug ? (catCache[slug] || null) : null;
  };

  // ── Step 5: Group and import ──
  const productGroups = groupIntoProducts(catalog.items);
  await appendLog(pool, job.id, `Grouped into ${productGroups.length} products`, { products_found: catalog.items.length });

  let productsCreated = 0, productsUpdated = 0, skusCreated = 0, skusUpdated = 0;
  let pricingUpserted = 0, packagingUpserted = 0, attrsUpserted = 0;

  for (const group of productGroups) {
    const categoryId = resolveCatId(group.category);

    // Upsert product using base.js helper
    const productRow = await upsertProduct(pool, {
      vendor_id: vendorId,
      name: group.baseName,
      collection: group.collection || '',
      category_id: categoryId,
      description_short: group.items[0].product_name || null,
    });
    const productId = productRow.id;
    if (productRow.is_new) productsCreated++; else productsUpdated++;

    // Upsert each SKU
    for (const item of group.items) {
      const internalSku = makeInternalSku(item.vendor_sku, item.product_name);
      const vendorSku = item.vendor_sku || internalSku;
      const sellBy = item.sell_by || 'sqft';
      const variantType = group.isAccessory ? 'accessory' : null;
      const variantName = item.color || item.product_name || null;

      const skuRow = await upsertSku(pool, {
        product_id: productId,
        vendor_sku: vendorSku,
        internal_sku: internalSku,
        variant_name: variantName,
        sell_by: sellBy,
        variant_type: variantType,
      });
      const skuId = skuRow.id;
      if (skuRow.is_new) skusCreated++; else skusUpdated++;

      // Pricing
      if (item.cost || item.retail_price) {
        const priceBasis = sellBy === 'sqft' ? 'per_sqft' : 'per_unit';
        await upsertPricing(pool, skuId, {
          cost: item.cost || 0,
          retail_price: item.retail_price || item.cost || 0,
          price_basis: priceBasis,
          cut_price: item.cut_price || null,
          roll_price: item.roll_price || null,
          cut_cost: item.cut_cost || null,
          roll_cost: item.roll_cost || null,
          roll_min_sqft: item.roll_min_sqft || null,
          map_price: item.map_price || null,
        });
        pricingUpserted++;
      }

      // Packaging
      if (item.sqft_per_box || item.pieces_per_box || item.weight_per_box_lbs || item.roll_width_ft) {
        const bpp = item.packaging?.packs_per_pallet || null;
        const sqftPerPallet = (bpp && item.sqft_per_box) ? bpp * item.sqft_per_box : null;

        await upsertPackaging(pool, skuId, {
          sqft_per_box: item.sqft_per_box || null,
          pieces_per_box: item.pieces_per_box || null,
          weight_per_box_lbs: item.weight_per_box_lbs || null,
          boxes_per_pallet: bpp,
          sqft_per_pallet: sqftPerPallet,
          roll_width_ft: item.roll_width_ft || null,
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

      // Species (PID code 35)
      const speciesPid = item.descriptions.find(d => d.characteristic_label === 'species');
      if (speciesPid) { await upsertSkuAttribute(pool, skuId, 'species', speciesPid.description); attrsUpserted++; }

      // Style (PID code 38)
      const stylePid = item.descriptions.find(d => d.characteristic_label === 'style');
      if (stylePid) { await upsertSkuAttribute(pool, skuId, 'style', stylePid.description); attrsUpserted++; }

      // Pattern (PID code 74)
      const patternPid = item.descriptions.find(d => d.characteristic_label === 'pattern');
      if (patternPid) { await upsertSkuAttribute(pool, skuId, 'pattern', patternPid.description); attrsUpserted++; }

      // Wear layer (MEA qualifier WL)
      const wearMea = item.measurements.find(m => m.qualifier === 'WL');
      if (wearMea) { await upsertSkuAttribute(pool, skuId, 'wear_layer', `${wearMea.value}${wearMea.unit_of_measure || 'mil'}`); attrsUpserted++; }

      // Weight (MEA qualifier WT)
      const weightMea = item.measurements.find(m => m.qualifier === 'WT');
      if (weightMea) { await upsertSkuAttribute(pool, skuId, 'weight', `${weightMea.value}${weightMea.unit_of_measure || 'LB'}`); attrsUpserted++; }

      // Width standalone (when length not available — e.g., plank width)
      if (widthMea && !lengthMea) {
        await upsertSkuAttribute(pool, skuId, 'width', `${widthMea.value}${widthMea.unit_of_measure || ''}`);
        attrsUpserted++;
      }
    }
  }

  // ── Step 5b: Discontinuation detection ──
  if (catalog.items.length >= 10) {
    const importedSkus = new Set();
    for (const group of productGroups) {
      for (const item of group.items) {
        importedSkus.add(makeInternalSku(item.vendor_sku, item.product_name));
      }
    }

    const activeResult = await pool.query(
      `SELECT s.id, s.internal_sku FROM skus s
       JOIN products p ON s.product_id = p.id
       WHERE p.vendor_id = $1 AND s.status = 'active'`,
      [vendorId]
    );

    let deactivated = 0;
    for (const row of activeResult.rows) {
      if (!importedSkus.has(row.internal_sku)) {
        await pool.query(
          `UPDATE skus SET status = 'inactive', updated_at = NOW() WHERE id = $1`,
          [row.id]
        );
        deactivated++;
      }
    }

    if (deactivated > 0) {
      await appendLog(pool, job.id, `Deactivated ${deactivated} SKUs not found in latest 832`);
    }
  }

  // Log final stats
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
