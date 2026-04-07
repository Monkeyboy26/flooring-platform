/**
 * Daltile — EDI 832 FTP Importer
 *
 * Connects to daltileb2b.daltile.com via FTP, downloads the latest 832 (Price/Sales Catalog)
 * file, parses EDI segments, and upserts products/SKUs/pricing/packaging into the database.
 *
 * Modeled on engfloors-832.js — same EDI parsing logic, adapted for Daltile's
 * tile-focused product catalog (porcelain, ceramic, natural stone, mosaic, glass, trim).
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
  upsertMediaAsset, isLifestyleUrl,
} from './base.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VENDOR_CODE = 'DAL';

// Default FTP credentials (overridden by vendor_sources.config or env vars)
const DEFAULT_FTP = {
  host: 'daltileb2b.daltile.com',
  port: 21,
  user: '7149990009',
  password: 'W5y5p6L6',
};

// Directories to scan on the remote server
const REMOTE_DIRS = [
  '/users/7149990009/Outbox',
  '/users/7149990009/Outbox/Archive',
  '/Outbox', '/Outbox/Archive',
  '/832',
  '/',
];

// Map EDI category text → category slugs in our DB
const CATEGORY_MAP = {
  'porcelain':             'tile',
  'porcelain tile':        'tile',
  'ceramic':               'tile',
  'ceramic tile':          'tile',
  'tile':                  'tile',
  'floor tile':            'tile',
  'wall tile':             'tile',
  'natural stone':         'natural-stone',
  'stone':                 'natural-stone',
  'marble':                'natural-stone',
  'travertine':            'natural-stone',
  'slate':                 'natural-stone',
  'granite':               'natural-stone',
  'limestone':             'natural-stone',
  'quartzite':             'natural-stone',
  'mosaic':                'mosaic',
  'glass':                 'mosaic',
  'glass tile':            'mosaic',
  'glass mosaic':          'mosaic',
  'stone mosaic':          'mosaic',
  'metal mosaic':          'mosaic',
  'luxury vinyl':          'luxury-vinyl',
  'luxury vinyl plank':    'luxury-vinyl',
  'luxury vinyl tile':     'luxury-vinyl',
  'lvp':                   'luxury-vinyl',
  'lvt':                   'luxury-vinyl',
  'spc':                   'luxury-vinyl',
  'wpc':                   'luxury-vinyl',
  'vinyl plank':           'luxury-vinyl',
  'vinyl tile':            'luxury-vinyl',
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

// MAC (material class) → category slug mapping for Daltile
const MAC_CATEGORY_MAP = {
  PORTILR: 'tile',             // Porcelain Tile Residential
  PORTILC: 'tile',             // Porcelain Tile Commercial
  CERTILR: 'tile',             // Ceramic Tile Residential
  CERTILC: 'tile',             // Ceramic Tile Commercial
  STNTILR: 'natural-stone',    // Stone Tile Residential
  STNTILC: 'natural-stone',    // Stone Tile Commercial
  MOSTILR: 'mosaic',           // Mosaic Tile Residential
  MOSTILC: 'mosaic',           // Mosaic Tile Commercial
  GLSTILR: 'mosaic',           // Glass Tile Residential
  GLSTILC: 'mosaic',           // Glass Tile Commercial
  VINTILR: 'luxury-vinyl',     // Vinyl Tile/LVP Residential
  VINTILC: 'luxury-vinyl',     // Vinyl Tile/LVP Commercial
  VINMISR: 'installation-sundries', // Vinyl Misc (accessories)
  SETMTL:  'installation-sundries', // Setting Materials
  GRTCAU:  'installation-sundries', // Grout & Caulk
  TRMACC:  'installation-sundries', // Trim & Accessories
};

/**
 * Cost-based sliding retail markup. Higher-cost items get a lower multiplier
 * since Daltile 832 only provides wholesale costs, not retail/MAP prices.
 */
function retailFromCost(cost) {
  if (!cost || cost <= 0) return 0;
  const multiplier = cost < 5 ? 2.5
    : cost < 15 ? 2.2
    : cost < 30 ? 2.0
    : cost < 50 ? 1.8
    : 1.6;
  return Math.round(cost * multiplier * 100) / 100;
}

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

  // Daltile-specific: detect accessories by name/category keywords
  const nameAndCat = `${item.product_name || ''} ${item.category || ''}`.toLowerCase();
  if (/trim|bullnose|quarter\s*round|grout|caulk|setting\s*material|mortar|adhesive|sealant|membrane|backer\s*board|pencil\s*liner|chair\s*rail|v-cap|mud\s*cap|jolly|schluter/i.test(nameAndCat)) {
    if (!item.sell_by) item.sell_by = 'unit';
  }

  // Detect per-box prices disguised as per-sqft. Some mosaic/multi-sheet items have
  // the box price in the CTP but UOM = SF. If cost ÷ sqft_per_box gives a reasonable
  // per-sqft figure ($3-30) while the raw cost seems too high, convert to true per-sqft.
  if (item.sell_by === 'sqft' && item.sqft_per_box >= 3 && item.cost > 30) {
    const perSqft = item.cost / item.sqft_per_box;
    if (perSqft >= 3 && perSqft <= 30) {
      item.cost = parseFloat(perSqft.toFixed(4));
      if (item.retail_price) {
        item.retail_price = parseFloat((item.retail_price / item.sqft_per_box).toFixed(4));
      }
    }
  }
}


// ---------------------------------------------------------------------------
// FTP helpers
// ---------------------------------------------------------------------------

function getFtpConfig(source) {
  const cfg = source.config || {};
  return {
    host: cfg.ftp_host || process.env.DALTILE_FTP_HOST || DEFAULT_FTP.host,
    port: parseInt(cfg.ftp_port || process.env.DALTILE_FTP_PORT || DEFAULT_FTP.port, 10),
    user: cfg.ftp_user || process.env.DALTILE_FTP_USER || DEFAULT_FTP.user,
    password: cfg.ftp_pass || process.env.DALTILE_FTP_PASS || DEFAULT_FTP.password,
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

  // Sort largest first so full catalogs import before deltas
  allFiles.sort((a, b) => (b.size || 0) - (a.size || 0));
  return allFiles;
}


// ---------------------------------------------------------------------------
// Product grouping
// ---------------------------------------------------------------------------

// Finish suffix codes → human-readable
const FINISH_SUFFIX_MAP = {
  Mt: 'Matte', Pl: 'Polished', Hn: 'Honed', St: 'Structured',
  Gl: 'Gloss', Sx: 'Textured', Lp: 'Lappato',
};
const FINISH_SUFFIX_RE = /\s+(Mt|Pl|Hn|St|Gl|Sx|Lp)\s*$/i;

// Shape words to strip from baseName so shape variants group into one product.
// Compound phrases first so "Four Square" matches before "Square".
const SHAPE_WORDS = [
  'Four Square', 'Pillow', 'Pyramid', 'Star', 'Rectangle', 'Dot', 'Insert',
  'Hexagon', 'Herringbone', 'Penny', 'Chevron', 'Arabesque', 'Picket',
  'Basketweave', 'Oval', 'Trapezoid', 'Elongated', 'Fan', 'Diamond',
  'Lantern', 'Round',
];
const SHAPE_RE = new RegExp(
  '\\b(' + SHAPE_WORDS.map(w => w.replace(/\s+/g, '\\s+')).join('|') + ')\\b', 'i'
);

function groupIntoProducts(items) {
  const products = new Map();

  for (const item of items) {
    if (!item.vendor_sku && !item.product_name) continue;

    const collection = item.collection || '';
    const category = item.category || '';
    const isAccessory = /accessory|sundries|trim|molding|bullnose|quarter\s*round|grout|caulk|setting\s*material|mortar|adhesive|sealant|membrane|pencil\s*liner|chair\s*rail|v-cap|mud\s*cap|jolly|schluter/i.test(category)
      || /accessory|sundries|trim|molding|bullnose|quarter\s*round|grout|caulk|setting\s*material|mortar|adhesive|sealant|membrane|pencil\s*liner|chair\s*rail|v-cap|mud\s*cap|jolly|schluter/i.test(item.product_name || '');

    let baseName = item.product_name || item.vendor_sku || 'Unknown';

    // ── Extract finish suffix (Mt, Pl, Hn, etc.) before grouping ──
    const finishMatch = baseName.match(FINISH_SUFFIX_RE);
    if (finishMatch) {
      item._finishFromName = finishMatch[1]; // raw code e.g. "Mt"
    }

    // ── Strip shape word (Rectangle, Hexagon, etc.) ──
    const shapeMatch = baseName.match(SHAPE_RE);
    if (shapeMatch) {
      item._shapeFromName = shapeMatch[1].replace(/\s+/g, ' ');
    }

    // ── Detect Bn (bullnose/trim) items → per-item accessory ──
    if (/\sBn\s/i.test(baseName)) {
      item._isAccessory = true;
    }

    // ── Group key: collection + color (not baseName) ──
    // Accessories grouped together; field tiles grouped by color.
    const colorKey = (item.color || '').toLowerCase().trim();
    let key;
    let productName;

    if (isAccessory || item._isAccessory) {
      key = `${collection}|||ACCESSORIES`;
      productName = `${collection} Trim & Accessories`;
    } else if (colorKey) {
      key = `${collection}|||${colorKey}`;
      productName = `${collection} ${titleCaseColor(item.color)}`;
    } else {
      // No color — fall back to baseName grouping for catchall
      const cleanBase = baseName
        .replace(FINISH_SUFFIX_RE, '')
        .replace(SHAPE_RE, '')
        .replace(/\s+Grp\d+\s*$/i, '')
        .replace(/^\s*Lvf\s+/i, '')
        .replace(/\s+Bn\s+.*$/i, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
      key = `${collection}|||${cleanBase}`;
      productName = cleanBase;
    }

    if (!products.has(key)) {
      products.set(key, { baseName: productName, collection, category, isAccessory, items: [] });
    }
    products.get(key).items.push(item);
  }

  return Array.from(products.values());
}

function titleCaseColor(s) {
  if (!s) return '';
  return s.replace(/\b\w+/g, w =>
    w.length <= 2 ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
  );
}

function makeInternalSku(vendorSku, productName) {
  if (vendorSku) {
    return vendorSku.toUpperCase().startsWith('DAL-') ? vendorSku : `DAL-${vendorSku}`;
  }
  const slug = (productName || 'UNKNOWN').toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 30);
  return `DAL-${slug}`;
}


// ---------------------------------------------------------------------------
// Main run() — called by the scraper framework
// ---------------------------------------------------------------------------

export async function run(pool, job, source) {
  const ftpConfig = getFtpConfig(source);
  let processedFiles = (source.config || {}).processed_files || [];

  await appendLog(pool, job.id, `Connecting to ${ftpConfig.host}:${ftpConfig.port} as ${ftpConfig.user}...`);

  const ftp = new FtpClient();
  ftp.ftp.verbose = false;
  const downloadedFiles = []; // { localPath, remoteName }

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

    // Find all unprocessed files
    const unprocessed = remoteFiles.filter(f => !processedFiles.includes(f.name));
    if (unprocessed.length === 0) {
      await appendLog(pool, job.id, 'All files have been processed already. Nothing new to import.');
      return;
    }

    await appendLog(pool, job.id, `Downloading ${unprocessed.length} unprocessed file(s)...`);

    // ── Step 2: Download all unprocessed files ──
    for (const target of unprocessed) {
      const localPath = `/tmp/daltile_832_${Date.now()}_${target.name}`;
      await ftp.downloadTo(localPath, target.remotePath);
      downloadedFiles.push({ localPath, remoteName: target.name, sizeKb: (target.size / 1024).toFixed(1) });
      await appendLog(pool, job.id, `  Downloaded ${target.name} (${(target.size / 1024).toFixed(1)}KB)`);
    }

  } catch (err) {
    await addJobError(pool, job.id, `FTP error: ${err.message}`);
    await appendLog(pool, job.id, `FTP connection failed: ${err.message}`);
    throw err;
  } finally {
    ftp.close();
  }

  if (downloadedFiles.length === 0) return;

  // ── Step 3: Resolve vendor and categories ──
  const vendorResult = await pool.query('SELECT id FROM vendors WHERE code = $1', [VENDOR_CODE]);
  if (!vendorResult.rows.length) {
    throw new Error(`Vendor with code "${VENDOR_CODE}" not found. Create the vendor record first.`);
  }
  const vendorId = vendorResult.rows[0].id;

  const catCache = {};
  const catResult = await pool.query('SELECT id, slug FROM categories');
  for (const row of catResult.rows) catCache[row.slug] = row.id;
  const resolveCatId = (categoryText) => {
    if (!categoryText) return null;
    if (catCache[categoryText]) return catCache[categoryText];
    const slug = CATEGORY_MAP[categoryText.toLowerCase().trim()];
    return slug ? (catCache[slug] || null) : null;
  };

  // Track all imported SKUs across all files for deactivation at the end
  const allImportedSkusByCollection = new Map(); // collection → Set of internal_skus

  let totalProductsCreated = 0, totalProductsUpdated = 0;
  let totalSkusCreated = 0, totalSkusUpdated = 0;
  let totalPricing = 0, totalPackaging = 0, totalAttrs = 0;

  // ── Step 4: Parse and import each file ──
  for (const file of downloadedFiles) {
    await appendLog(pool, job.id, `\nParsing ${file.remoteName} (${file.sizeKb}KB)...`);
    const raw = fs.readFileSync(file.localPath, 'utf-8');
    const catalog = parse832(raw);
    await appendLog(pool, job.id, `  Parsed ${catalog.items.length} items from ${catalog.summary.segment_count} segments`);

    if (catalog.items.length === 0) {
      await appendLog(pool, job.id, '  No items found — skipping file.');
      processedFiles = [...processedFiles, file.remoteName];
      continue;
    }

    const productGroups = groupIntoProducts(catalog.items);
    await appendLog(pool, job.id, `  Grouped into ${productGroups.length} products`);

    let productsCreated = 0, productsUpdated = 0, skusCreated = 0, skusUpdated = 0;
    let pricingUpserted = 0, packagingUpserted = 0, attrsUpserted = 0;

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
        // Per-item accessory detection (Bn items) takes priority, then group-level
        const variantType = item._isAccessory ? 'accessory'
          : (group.isAccessory ? 'accessory' : null);
        let variantName = item.color || item.product_name || null;
        if (item._shapeFromName && variantName) {
          variantName = `${variantName}, ${item._shapeFromName}`;
        } else if (item._shapeFromName) {
          variantName = item._shapeFromName;
        }

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

        // Track for per-collection deactivation
        const collKey = (group.collection || '').toLowerCase().trim();
        if (!allImportedSkusByCollection.has(collKey)) allImportedSkusByCollection.set(collKey, new Set());
        allImportedSkusByCollection.get(collKey).add(internalSku);

        if (item.cost || item.retail_price) {
          const priceBasis = sellBy === 'sqft' ? 'per_sqft' : 'per_unit';
          await upsertPricing(pool, skuId, {
            cost: item.cost || 0,
            retail_price: item.retail_price || retailFromCost(item.cost || 0),
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

        if (item.color) { await upsertSkuAttribute(pool, skuId, 'color', item.color); attrsUpserted++; }
        if (item.upc) { await upsertSkuAttribute(pool, skuId, 'upc', item.upc); attrsUpserted++; }

        const finishPid = item.descriptions.find(d => d.characteristic_label === 'finish');
        if (finishPid) { await upsertSkuAttribute(pool, skuId, 'finish', finishPid.description); attrsUpserted++; }
        else if (item._finishFromName) {
          const finishVal = FINISH_SUFFIX_MAP[item._finishFromName] || item._finishFromName;
          await upsertSkuAttribute(pool, skuId, 'finish', finishVal);
          attrsUpserted++;
        }

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

        if (item._shapeFromName) { await upsertSkuAttribute(pool, skuId, 'shape', item._shapeFromName); attrsUpserted++; }

        const wearMea = item.measurements.find(m => m.qualifier === 'WL');
        if (wearMea) { await upsertSkuAttribute(pool, skuId, 'wear_layer', `${wearMea.value}${wearMea.unit_of_measure || 'mil'}`); attrsUpserted++; }

        const weightMea = item.measurements.find(m => m.qualifier === 'WT');
        if (weightMea) { await upsertSkuAttribute(pool, skuId, 'weight', `${weightMea.value}${weightMea.unit_of_measure || 'LB'}`); attrsUpserted++; }

        if (widthMea && !lengthMea) {
          await upsertSkuAttribute(pool, skuId, 'width', `${widthMea.value}${widthMea.unit_of_measure || ''}`);
          attrsUpserted++;
        }

        // Save images from MTX segments (EDI image URLs)
        // Filter out lifestyle/banner images so they don't become primary
        if (item.images && item.images.length > 0) {
          const productUrls = [];
          const lifestyleUrls = [];
          for (const img of item.images) {
            if (img.url && (img.url.startsWith('http://') || img.url.startsWith('https://'))) {
              if (isLifestyleUrl(img.url)) {
                lifestyleUrls.push(img.url);
              } else {
                productUrls.push(img.url);
              }
            }
          }
          // Save product shots as primary/alternate
          for (let i = 0; i < productUrls.length; i++) {
            await upsertMediaAsset(pool, {
              product_id: productId,
              sku_id: skuId,
              asset_type: i === 0 ? 'primary' : 'alternate',
              url: productUrls[i],
              original_url: productUrls[i],
              sort_order: i,
            });
          }
          // Save lifestyle/banner images as lifestyle (product-level, not SKU-level)
          for (let i = 0; i < lifestyleUrls.length; i++) {
            await upsertMediaAsset(pool, {
              product_id: productId,
              sku_id: null,
              asset_type: 'lifestyle',
              url: lifestyleUrls[i],
              original_url: lifestyleUrls[i],
              sort_order: 100 + i,
            });
          }
        }
      }
    }

    totalProductsCreated += productsCreated;
    totalProductsUpdated += productsUpdated;
    totalSkusCreated += skusCreated;
    totalSkusUpdated += skusUpdated;
    totalPricing += pricingUpserted;
    totalPackaging += packagingUpserted;
    totalAttrs += attrsUpserted;

    await appendLog(pool, job.id, `  ${file.remoteName}: ${productsCreated} new / ${productsUpdated} updated products, ${skusCreated} new / ${skusUpdated} updated SKUs, ${pricingUpserted} pricing, ${packagingUpserted} packaging`);

    // Mark file as processed
    processedFiles = [...processedFiles, file.remoteName];
    await pool.query(
      `UPDATE vendor_sources SET config = jsonb_set(COALESCE(config, '{}'), '{processed_files}', $1::jsonb), updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
      [JSON.stringify(processedFiles), source.id]
    );

    // Cleanup temp file
    try { fs.unlinkSync(file.localPath); } catch { }
  }

  // ── Step 5: Per-collection discontinuation detection ──
  // Only deactivate SKUs within collections that appeared in this import batch.
  // This prevents File A (brand X) from deactivating File B (brand Y) SKUs.
  let totalDeactivated = 0;
  for (const [collKey, importedSkus] of allImportedSkusByCollection) {
    if (importedSkus.size < 5) continue; // skip tiny collections — likely a delta, not a full refresh

    const activeResult = await pool.query(
      `SELECT s.id, s.internal_sku FROM skus s
       JOIN products p ON s.product_id = p.id
       WHERE p.vendor_id = $1 AND s.status = 'active' AND LOWER(TRIM(p.collection)) = $2`,
      [vendorId, collKey]
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
    if (deactivated > 0) totalDeactivated += deactivated;
  }

  if (totalDeactivated > 0) {
    await appendLog(pool, job.id, `Deactivated ${totalDeactivated} SKUs not found in latest 832 (per-collection)`);
  }

  // Log final stats
  await appendLog(pool, job.id, `Import complete (${downloadedFiles.length} files): ${totalProductsCreated} products created, ${totalProductsUpdated} updated, ${totalSkusCreated} SKUs created, ${totalSkusUpdated} updated`, {
    products_created: totalProductsCreated,
    products_updated: totalProductsUpdated,
    skus_created: totalSkusCreated,
  });
  await appendLog(pool, job.id, `  Pricing: ${totalPricing}, Packaging: ${totalPackaging}, Attributes: ${totalAttrs}`);
}
