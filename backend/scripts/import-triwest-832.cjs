#!/usr/bin/env node
/**
 * Tri-West — EDI 832 (Price/Sales Catalog) Importer
 *
 * Connects via FTP to ftp.triwestltd.com, downloads all 832 files from /outbox,
 * parses the EDI segments, and upserts products/SKUs/pricing into the database.
 *
 * Usage:
 *   node backend/scripts/import-triwest-832.cjs                    # FTP download + import
 *   node backend/scripts/import-triwest-832.cjs --file /tmp/832    # Parse local file only
 *   node backend/scripts/import-triwest-832.cjs --list             # List remote directory
 *   node backend/scripts/import-triwest-832.cjs --dry-run          # Parse only, no DB writes
 *
 * FTP credentials come from env vars or defaults:
 *   TRIWEST_FTP_HOST, TRIWEST_FTP_USER, TRIWEST_FTP_PASS
 */

const { Client: FtpClient } = require('basic-ftp');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const { Writable } = require('stream');

// ---------------------------------------------------------------------------
// Database connection
// ---------------------------------------------------------------------------
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

// Vendor info
const VENDOR_NAME = 'Tri-West';
const VENDOR_CODE = 'TW';

// FTP config
const FTP_CONFIG = {
  host: process.env.TRIWEST_FTP_HOST || 'ftp.triwestltd.com',
  port: parseInt(process.env.TRIWEST_FTP_PORT || '21', 10),
  user: process.env.TRIWEST_FTP_USER || 'xpresfl',
  password: process.env.TRIWEST_FTP_PASS || 'xpf012728!',
};

const REMOTE_DIR = '/outbox';
const OUTPUT_DIR = '/tmp/triwest_832';

// ---------------------------------------------------------------------------
// Category Mapping — MAC material class code → category slug
// ---------------------------------------------------------------------------
const MAC_CATEGORY_MAP = {
  // Wood / Engineered Hardwood
  WOOENP: 'hardwood',            // Wood Engineered Plank
  WOOENG: 'hardwood',            // Wood Engineered
  WOOSOL: 'hardwood',            // Wood Solid
  WOO:    'hardwood',
  // Vinyl / LVP / SPC / WPC
  VINTIL: 'luxury-vinyl',
  VINTILR: 'luxury-vinyl',
  VINTILC: 'luxury-vinyl',
  VINPLK: 'luxury-vinyl',        // Vinyl Plank
  VINSPC: 'luxury-vinyl',        // SPC
  VINWPC: 'luxury-vinyl',        // WPC
  VIN:    'luxury-vinyl',
  // Laminate
  LAMFLO: 'laminate',
  LAM:    'laminate',
  // Tile / Porcelain / Ceramic
  CERFLO: 'tile',
  PORTIL: 'tile',
  CERTIL: 'tile',
  CER:    'tile',
  // Carpet
  CARINDR: 'carpet',
  CARINDC: 'carpet',
  CARIND:  'carpet',
  CARTILR: 'carpet-tile',
  CARTILC: 'carpet-tile',
  CARTIL:  'carpet-tile',
  // Accessories & Transitions
  VINMIS: 'transitions-moldings',
  VINMISR: 'transitions-moldings',
  VINMISC: 'transitions-moldings',
  WOOMIS: 'transitions-moldings',
  CERMIS: 'transitions-moldings',
  ACC: 'installation-sundries',
  // Adhesives
  ADH: 'adhesives-sealants',
  // Underlayment
  UND: 'underlayment',
};

// MAC → construction label
const MAC_CONSTRUCTION_MAP = {
  WOOENP: 'Engineered Hardwood', WOOENG: 'Engineered Hardwood', WOO: 'Engineered Hardwood',
  WOOSOL: 'Solid Hardwood',
  VINTIL: 'Luxury Vinyl', VINTILR: 'Luxury Vinyl', VINTILC: 'Luxury Vinyl',
  VINPLK: 'Luxury Vinyl Plank', VINSPC: 'SPC', VINWPC: 'WPC', VIN: 'Luxury Vinyl',
  LAMFLO: 'Laminate', LAM: 'Laminate',
  CERFLO: 'Ceramic Tile', PORTIL: 'Porcelain Tile', CERTIL: 'Ceramic Tile', CER: 'Tile',
  CARINDR: 'Broadloom Carpet', CARINDC: 'Broadloom Carpet', CARIND: 'Broadloom Carpet',
  CARTILR: 'Carpet Tile', CARTILC: 'Carpet Tile', CARTIL: 'Carpet Tile',
  VINMIS: 'Transition', VINMISR: 'Transition', VINMISC: 'Transition',
  WOOMIS: 'Hardwood Transition', CERMIS: 'Tile Transition',
  ACC: 'Installation Accessory', ADH: 'Adhesive', UND: 'Underlayment',
};

// Broader text → slug mapping
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
  'carpet':              'carpet',
  'carpet tile':         'carpet-tile',
  'tile':                'tile',
  'porcelain':           'tile',
  'ceramic':             'tile',
  'accessory':           'installation-sundries',
  'accessories':         'installation-sundries',
  'trim':                'transitions-moldings',
  'molding':             'transitions-moldings',
  'underlayment':        'underlayment',
  'adhesive':            'adhesives-sealants',
};

// ---------------------------------------------------------------------------
// Text Cleaning
// ---------------------------------------------------------------------------
const KEEP_UPPER = new Set(['SPC','WPC','LVP','LVT','PVC','HD','II','III','IV','AHF']);
const KEEP_LOWER = new Set(['a','an','the','and','or','of','in','at','to','for','by','on','with']);

function titleCaseEdi(text) {
  if (!text) return '';
  return text
    .split(/\s+/)
    .map((w, i) => {
      const upper = w.toUpperCase();
      if (KEEP_UPPER.has(upper)) return upper;
      if (i > 0 && KEEP_LOWER.has(w.toLowerCase())) return w.toLowerCase();
      if (w.length <= 1) return w.toUpperCase();
      return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    })
    .join(' ');
}

function cleanAndTitle(raw) {
  if (!raw) return null;
  return titleCaseEdi(raw.trim());
}

function cleanProductName(raw) {
  if (!raw) return null;
  let name = raw
    .replace(/\s*\([^)]*sq(?:ft|yd)[^)]*\)/gi, '')
    .replace(/\s+\d+\.?\d*[xX]\d+\.?\d*/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return cleanAndTitle(name) || null;
}

// ---------------------------------------------------------------------------
// AHF Product Line Extraction
// ---------------------------------------------------------------------------
// AHF's 832 data lacks PID 77 (collection code), so TRN contains dimension
// strings like "3/4"X5"XRL 9"-84"" instead of real product line names.
// This function extracts the actual product line from those messy strings.
const AHF_PRODUCT_LINE_PATTERNS = [
  // Multi-word product lines (check first)
  { name: 'Coastal Comfort', pattern: /\bCOASTAL\s*COMFORT\b/i },
  { name: 'Coastal Highway', pattern: /\bCOASTAL\s*HIGHWAY\b/i },
  { name: 'American Scrape', pattern: /\bAMERICAN\s*SCRAPE\b/i },
  { name: 'Prime Harvest', pattern: /\bPRIME\s*HARVEST\b/i },
  { name: 'Dogwood Pro', pattern: /\bDOGWOOD\s*PRO\b/i },
  { name: 'Rural Living', pattern: /\bRURAL\s*LIVING\b/i },
  { name: 'Solid Color Welding', pattern: /\bSOLID\s*COLOR\s*WELD/i },
  { name: 'Appalachian Ridge', pattern: /\bAPPALACHIAN\s*RIDGE\b/i },
  { name: 'Sugar Creek', pattern: /\bSUGAR\s*CREEK\b/i },
  { name: 'Timber Brush', pattern: /\bTIMBER\s*BRUSH\b/i },
  { name: 'Lock & Fold', pattern: /\bLOCK\s*(?:&|AND)\s*FOLD\b/i },
  { name: 'Next Frontier', pattern: /\bNEXT\s*FRONTIER\b/i },
  { name: 'White Mountain', pattern: /\bWHITE\s*MOUNTAIN\b/i },
  { name: 'Woodland Relics', pattern: /\bWOODLAND\s*RELICS\b/i },
  { name: 'Heritage Classics', pattern: /\bHERITAGE\s*CLASSICS?\b/i },
  { name: 'Mountain Retreat', pattern: /\bMOUNTAIN\s*RETREAT\b/i },
  { name: 'Paragon Diamond', pattern: /\bPARAGON\s*(?:DIAMOND|D\s*10)\b/i },
  { name: 'Paragon', pattern: /\bPARAGON\b/i },
  { name: 'Turlington Signature', pattern: /\bTURLINGTON\s*SIGNATURE\b/i },
  { name: 'Turlington Lock & Fold', pattern: /\bTURLINGTON\s*LOCK/i },
  { name: 'Turlington', pattern: /\bTURLINGTON\b/i },
  { name: 'Westmoreland Strip', pattern: /\bWESTMORELAND\s*STRIP\b/i },
  { name: 'Westmoreland', pattern: /\bWESTMORELAND\b/i },
  { name: 'Performance Plus', pattern: /\bPERFORMANCE\s*PLUS\b/i },
  { name: 'Mystic Taupe', pattern: /\bMYSTIC\s*TAUPE\b/i },
  { name: 'Oak Pointe', pattern: /\bOAK\s*POINTE\b/i },
  { name: 'Highland Trail', pattern: /\bHIGHLAND\s*TRAIL\b/i },
  { name: 'Camden Hills', pattern: /\bCAMDEN\s*HILLS?\b/i },
  { name: 'Legacy Manor', pattern: /\bLEGACY\s*MANOR\b/i },
  { name: 'Barnwood Living', pattern: /\bBARNWOOD\s*LIVING\b/i },
  // Single-word product lines
  { name: 'Everest', pattern: /\bEVEREST\b/i },
  { name: 'Denali', pattern: /\bDENALI\b/i },
  { name: 'Dutton', pattern: /\bDUTTON\b/i },
  { name: 'Artisan', pattern: /\bARTISAN\b/i },
  { name: 'Beckford', pattern: /\bBECKFORD\b/i },
  { name: 'Somerset', pattern: /\bSOMERSET\b/i },
  { name: 'Dakota', pattern: /\bDAKOTA\b/i },
  { name: 'Dogwood', pattern: /\bDOGWOOD\b/i },
  { name: 'Kennedale', pattern: /\bKENNEDALE\b/i },
  { name: 'Gatehouse', pattern: /\bGATEHOUSE\b/i },
  { name: 'Pioneered', pattern: /\bPIONEERED\b/i },
  { name: 'Springdale', pattern: /\bSPRINGDALE\b/i },
  { name: 'Manchester', pattern: /\bMANCHESTER\b/i },
  { name: 'Waltham', pattern: /\bWALTHAM\b/i },
  { name: 'Downing', pattern: /\bDOWNING\b/i },
  { name: 'Robbins', pattern: /\bROBBINS\b/i },
  { name: 'Rockingham', pattern: /\bROCKINGHAM\b/i },
  { name: 'Dundee', pattern: /\bDUNDEE\b/i },
  { name: 'Laurel', pattern: /\bLAUREL\b/i },
  { name: 'Kingsford', pattern: /\bKINGSFORD\b/i },
  { name: 'Ascot', pattern: /\bASCOT\b/i },
  { name: 'Bristol', pattern: /\bBRISTOL\b/i },
  { name: 'Hartco', pattern: /\bHARTCO\b/i },
  { name: 'Bruce', pattern: /\bBRUCE\b/i },
  { name: 'Armstrong', pattern: /\bARMSTRONG\b/i },
  { name: 'Hydropel', pattern: /\bHYDROPEL\b/i },
  { name: 'Timbercuts', pattern: /\bTIMBERCUTS?\b/i },
  { name: 'Smokehouse', pattern: /\bSMOKEHOUSE\b/i },
  { name: 'Blackwater', pattern: /\bBLACKWATER\b/i },
  { name: 'Frontier', pattern: /\bFRONTIER\b/i },
  { name: 'Legacy', pattern: /\bLEGACY\b/i },
];

function extractAhfProductLine(text) {
  if (!text) return null;
  for (const { name, pattern } of AHF_PRODUCT_LINE_PATTERNS) {
    if (pattern.test(text)) return `AHF - ${name}`;
  }
  // Fallback: strip dimensions and try to salvage a usable name
  let cleaned = text
    .replace(/\b\d+\/\d+"?\s*[xX×]\s*\d+[\/\d]*"?\s*(?:[xX×]\s*(?:RL|[A-Z]+))?\s*(?:\d+[."'\-]*\d*[."'\-]*\d*)*/g, '')
    .replace(/\s*(?:XRL|XRG|XR)\s*\d+.*$/i, '')
    .replace(/\b(?:OAK|MAPLE|HICKORY|WALNUT|CHERRY|ASH|BIRCH|BEECH|PINE|ACACIA|TEAK|MAHOGANY|ELM|BAMBOO|PECAN)\b/gi, '')
    .replace(/\s*COLL\.?\s*$/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (cleaned && cleaned.length >= 3 && !/^\d+$/.test(cleaned)) {
    return `AHF - ${cleanAndTitle(cleaned)}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// EDI 832 Parser — segment-level helpers
// ---------------------------------------------------------------------------
const LIN_QUALIFIERS = {
  UP: 'upc', VN: 'vendor_item_number', SK: 'sku', MG: 'manufacturer_group',
  MF: 'manufacturer_brand', ST: 'style_number', GS: 'catalog_number_gs',
  BP: 'buyer_part_number', IN: 'buyer_item_number', MN: 'model_number',
  UA: 'upc_case_code', PN: 'part_number',
};

const PID_CODES = {
  '08': 'description', GEN: 'category', '09': 'sub_product',
  '73': 'color', '74': 'pattern', '75': 'finish', '35': 'dye_code',
  '37': 'material', '38': 'style', DIM: 'dimensions',
  MAC: 'material_class', TRN: 'trade_name', '12': 'quality', '77': 'collection',
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
  const result = { sub_line_number: seg.el[1] || null, identifiers: {} };
  for (let i = 9; i < seg.el.length - 1; i += 2) {
    const qual = seg.el[i], val = seg.el[i + 1];
    if (qual && val) result.identifiers[LIN_QUALIFIERS[qual] || qual.toLowerCase()] = val;
  }
  return result;
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
    reference: seg.el[1] || null,
    qualifier: seg.el[2] || null,
    value: seg.el[3] ? parseFloat(seg.el[3]) : null,
    unit_of_measure: seg.el[4] || null,
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

// ---------------------------------------------------------------------------
// Main 832 Parser
// ---------------------------------------------------------------------------
function parse832(raw) {
  const segments = tokenizeSegments(raw).map(parseSegment);

  const catalog = {
    interchange: {}, functional_group: {}, transaction: {},
    header: { catalog_info: null, dates: [], parties: [], references: [] },
    items: [],
    summary: { total_items: 0, segment_count: segments.length },
  };

  let currentItem = null;
  let productContext = null;
  let hadSLN = false;

  function makeItem(identifiers) {
    return {
      identifiers: identifiers || {},
      descriptions: [], pricing: [], measurements: [],
      vendor_sku: null, upc: null, product_name: null,
      color: null, collection: null, category: null,
      brand: null, style_code: null, material_class: null,
      construction: null,
      cost: null, retail_price: null, unit_of_measure: null,
      sell_by: null, sqft_per_box: null, pieces_per_box: null,
      weight_per_box_lbs: null, origin: null, effective_date: null,
    };
  }

  function finalizeItem(item) {
    // Vendor SKU
    if (!item.vendor_sku) {
      item.vendor_sku = item.identifiers.sku
        || item.identifiers.vendor_item_number
        || item.identifiers.model_number
        || null;
    }
    item.upc = item.identifiers.upc || null;

    // Brand from LIN MF
    item.brand = item.identifiers.manufacturer_brand || null;
    // Style code from LIN ST
    item.style_code = item.identifiers.style_number || null;

    // Product name from PID TRN (trade name)
    const trnPid = item.descriptions.find(d => d.characteristic_code === 'TRN');
    if (trnPid) {
      item.product_name = cleanProductName(trnPid.description);
    } else {
      const descPid = item.descriptions.find(d =>
        d.characteristic_code === '08' && d.description && !/^[A-Z]{2,5}T[A-Z0-9]/.test(d.description));
      item.product_name = descPid ? cleanProductName(descPid.description) : null;
    }

    // Color from PID 73
    const colorPid = item.descriptions.find(d => d.characteristic_label === 'color');
    item.color = colorPid ? cleanAndTitle(colorPid.description) : null;

    // Collection: prefer PID 77, fallback to TRN (trade name = collection in Tri-West 832s)
    // Special handling for AHF: TRN contains dimension strings, not collection names
    const collPid = item.descriptions.find(d => d.characteristic_label === 'collection');
    if (collPid) {
      item.collection = collPid.description;
    } else if (item.brand && item.brand.toUpperCase() === 'AHF') {
      // AHF lacks PID 77 — extract product line from TRN instead of using raw dimensions
      const productLine = extractAhfProductLine(trnPid ? trnPid.description : null);
      item.collection = productLine || cleanAndTitle(trnPid ? trnPid.description : null);
    } else if (trnPid) {
      item.collection = cleanAndTitle(trnPid.description);
    }

    // Material class from MAC
    const macPid = item.descriptions.find(d => d.characteristic_code === 'MAC');
    item.material_class = macPid ? macPid.description.toUpperCase() : null;

    // Category from MAC → slug
    if (item.material_class) {
      item.category = MAC_CATEGORY_MAP[item.material_class] || null;
    }
    if (!item.category) {
      const catPid = item.descriptions.find(d => d.characteristic_label === 'category');
      if (catPid) {
        const slug = CATEGORY_MAP[catPid.description.toLowerCase().trim()];
        item.category = slug || catPid.description;
      }
    }

    // Construction from MAC
    item.construction = item.material_class ? (MAC_CONSTRUCTION_MAP[item.material_class] || null) : null;

    // Measurements → sqft_per_box, weight
    const surfMea = item.measurements.find(m => m.qualifier === 'SU');
    if (surfMea && surfMea.value) {
      const uom = (surfMea.unit_of_measure || '').toUpperCase();
      if (uom === 'SF' || uom === 'FT2') {
        item.sqft_per_box = surfMea.value;
        if (!item.sell_by) item.sell_by = 'sqft';
      } else if (uom === 'SY') {
        item.sqft_per_box = surfMea.value * 9;
        if (!item.sell_by) item.sell_by = 'sqft';
      }
    }

    const swMea = item.measurements.find(m => m.qualifier === 'SW');
    if (swMea && swMea.value) {
      const uom = (swMea.unit_of_measure || '').toUpperCase();
      if (uom === 'FP') {
        // FP = "flat piece" — weight per individual piece in lbs
        // Store raw piece weight; box weight computed below after sqft_per_box is set
        item.weight_per_piece_lbs = swMea.value;
      } else if (uom === 'LB') {
        item.weight_per_box_lbs = swMea.value;
      } else if (uom === 'ON') {
        item.weight_per_box_lbs = Math.round(swMea.value / 16 * 1000) / 1000;
      }
    }

    // Compute box weight from per-piece weight × estimated pieces per box
    if (item.weight_per_piece_lbs && item.sqft_per_box && !item.weight_per_box_lbs) {
      // Approximate: total box weight = weight_per_piece × sqft / avg_piece_sqft
      // But without piece dimensions, use a simpler heuristic:
      // Many EDI sources use FP weight as "per sqft" equivalent — test if value makes sense
      if (item.weight_per_piece_lbs < 5 && item.sqft_per_box > 10) {
        // Likely per-sqft weight: multiply by coverage
        item.weight_per_box_lbs = Math.round(item.weight_per_piece_lbs * item.sqft_per_box * 100) / 100;
      } else {
        // Likely per-piece weight: keep as-is (will be refined when pieces_per_box is known)
        item.weight_per_box_lbs = item.weight_per_piece_lbs;
      }
    }

    // Pricing — Tri-West uses CTP**LPR*price**SF (list price rate per sqft)
    const lprPrices = item.pricing.filter(p => p.price_type === 'LPR');
    if (lprPrices.length > 0) {
      const costEntry = lprPrices.find(p => p.basis_code === 'CT') || lprPrices[0];
      if (costEntry) {
        item.cost = costEntry.unit_price;
        item.unit_of_measure = costEntry.unit_of_measure || item.unit_of_measure;
      }
      // Tri-West 832 typically has one LPR price = dealer cost
      // Retail will be calculated via margin_tiers during upsert
    } else {
      const netPrice = item.pricing.find(p => p.price_type === 'NET')
        || item.pricing.find(p => p.class_of_trade === 'WS')
        || item.pricing.find(p => p.class_of_trade === 'DE')
        || item.pricing[0];
      if (netPrice) {
        item.cost = netPrice.unit_price;
        item.unit_of_measure = netPrice.unit_of_measure || item.unit_of_measure;
      }
      const retailPrice = item.pricing.find(p => p.price_type === 'MSR')
        || item.pricing.find(p => p.class_of_trade === 'RS');
      if (retailPrice) item.retail_price = retailPrice.unit_price;
    }

    // Convert SY → SF pricing
    if (item.unit_of_measure && item.unit_of_measure.toUpperCase() === 'SY') {
      if (item.cost) item.cost = parseFloat((item.cost / 9).toFixed(4));
      if (item.retail_price) item.retail_price = parseFloat((item.retail_price / 9).toFixed(4));
      item.unit_of_measure = 'SF';
    }

    // Infer sell_by from pricing UOM
    if (!item.sell_by && item.unit_of_measure) {
      const puom = item.unit_of_measure.toUpperCase();
      if (puom === 'SF' || puom === 'SY') item.sell_by = 'sqft';
      else if (puom === 'EA' || puom === 'PC') item.sell_by = 'unit';
      else if (puom === 'LF') item.sell_by = 'unit';
    }

    // Infer category from product name for accessories
    if (!item.category && item.product_name) {
      const pn = item.product_name.toUpperCase();
      if (/STAIRNOSE|T-MOLD|REDUCER|THRESHOLD|END CAP|QUARTER/.test(pn)) item.category = 'transitions-moldings';
      else if (/ADHESIVE/.test(pn)) item.category = 'adhesives-sealants';
      else if (/UNDERLAYMENT/.test(pn)) item.category = 'underlayment';
    }
  }

  function mergeProductContext(item, ctx) {
    if (!ctx) return;
    for (const [k, v] of Object.entries(ctx.identifiers)) {
      if (!item.identifiers[k]) item.identifiers[k] = v;
    }
    item.descriptions = [...ctx.descriptions, ...item.descriptions];
    if (item.pricing.length === 0) item.pricing = [...ctx.pricing];
    const slnQuals = new Set(item.measurements.map(m => m.qualifier));
    for (const pm of ctx.measurements) {
      if (!slnQuals.has(pm.qualifier)) item.measurements.push(pm);
    }
    if (!item.origin && ctx.origin) item.origin = ctx.origin;
    if (!item.effective_date && ctx.effective_date) item.effective_date = ctx.effective_date;
  }

  function flushCurrentItem() {
    if (!currentItem) return;
    if (productContext) mergeProductContext(currentItem, productContext);
    finalizeItem(currentItem);
    catalog.items.push(currentItem);
    currentItem = null;
  }

  function flushProduct() {
    if (hadSLN && currentItem) flushCurrentItem();
    else if (currentItem && !hadSLN) {
      finalizeItem(currentItem);
      catalog.items.push(currentItem);
      currentItem = null;
    }
    productContext = null;
    hadSLN = false;
  }

  for (const seg of segments) {
    switch (seg.id) {
      case 'ISA':
        catalog.interchange = {
          sender_id: (seg.el[6] || '').trim(),
          receiver_id: (seg.el[8] || '').trim(),
          date: seg.el[9] || null,
          control_number: seg.el[13] || null,
        };
        break;

      case 'GS':
        catalog.functional_group = {
          functional_id: seg.el[1] || null,
          sender: seg.el[2] || null,
          receiver: seg.el[3] || null,
          date: seg.el[4] || null,
          control_number: seg.el[6] || null,
          version: seg.el[8] || null,
        };
        break;

      case 'ST':
        catalog.transaction = { type: seg.el[1] || null, control_number: seg.el[2] || null };
        break;

      case 'BCT':
        catalog.header.catalog_info = {
          purpose: seg.el[1] || null,
          catalog_number: seg.el[2] || null,
        };
        break;

      case 'CUR':
        // Currency segment — just note it
        catalog.header.currency = seg.el[2] || 'USD';
        break;

      case 'REF':
        if (!currentItem && !productContext) {
          catalog.header.references.push({
            qualifier: seg.el[1] || null,
            value: seg.el[2] || null,
            description: seg.el[3] || null,
          });
        }
        break;

      case 'DTM': {
        if (!currentItem && !productContext) {
          catalog.header.dates.push({ qualifier: seg.el[1], date: seg.el[2] });
        } else {
          const target = productContext || currentItem;
          if (target && seg.el[1] === '007' && seg.el[2] && !target.effective_date) {
            target.effective_date = seg.el[2];
          }
        }
        break;
      }

      case 'LIN': {
        flushProduct();
        const lin = parseLIN(seg);
        currentItem = makeItem(lin.identifiers);
        currentItem.line_number = lin.line_number;
        break;
      }

      case 'SLN': {
        if (!hadSLN && currentItem) {
          productContext = {
            line_number: currentItem.line_number,
            identifiers: { ...currentItem.identifiers },
            descriptions: [...currentItem.descriptions],
            pricing: [...currentItem.pricing],
            measurements: [...currentItem.measurements],
            origin: currentItem.origin,
            effective_date: currentItem.effective_date,
          };
          hadSLN = true;
          currentItem = null;
        } else if (currentItem) {
          flushCurrentItem();
        }
        const sln = parseSLN(seg);
        currentItem = makeItem(sln.identifiers);
        if (sln.identifiers.sku) currentItem.vendor_sku = sln.identifiers.sku;
        currentItem.line_number = productContext ? productContext.line_number : null;
        break;
      }

      case 'PID':
        if (currentItem) currentItem.descriptions.push(parsePID(seg));
        else if (productContext) productContext.descriptions.push(parsePID(seg));
        break;

      case 'MEA':
        if (currentItem) currentItem.measurements.push(parseMEA(seg));
        else if (productContext) productContext.measurements.push(parseMEA(seg));
        break;

      case 'CTP':
        if (productContext) productContext.pricing.push(parseCTP(seg));
        else if (currentItem) currentItem.pricing.push(parseCTP(seg));
        break;

      case 'G43': {
        const target = productContext || currentItem;
        if (target && seg.el[3]) target.origin = seg.el[3];
        break;
      }

      case 'CTT':
        flushProduct();
        catalog.summary.total_items = seg.el[1] ? parseInt(seg.el[1], 10) : catalog.items.length;
        break;

      case 'SE':
        flushProduct();
        break;

      default:
        break;
    }
  }

  flushProduct();
  if (!catalog.summary.total_items) catalog.summary.total_items = catalog.items.length;
  return catalog;
}


// ---------------------------------------------------------------------------
// FTP Download — downloads ALL 832 files from /outbox
// ---------------------------------------------------------------------------
async function downloadAll832(listOnly = false) {
  const ftp = new FtpClient();
  ftp.ftp.verbose = false;
  const localFiles = [];

  try {
    console.log(`Connecting to ${FTP_CONFIG.host}:${FTP_CONFIG.port} as ${FTP_CONFIG.user}...`);
    await ftp.access({ ...FTP_CONFIG, secure: false });
    console.log('Connected.');

    const listing = await ftp.list(REMOTE_DIR);
    const ediFiles = listing
      .filter(f => f.type === 1 && f.name.endsWith('.832'))
      .sort((a, b) => a.name.localeCompare(b.name));

    console.log(`\n${REMOTE_DIR}/ — ${listing.length} total entries, ${ediFiles.length} .832 file(s):`);
    for (const f of ediFiles) {
      const sizeKb = (f.size / 1024).toFixed(1);
      const mod = f.rawModifiedAt || 'unknown';
      console.log(`  ${sizeKb.padStart(8)}KB  ${mod}  ${f.name}`);
    }

    if (listOnly) return [];

    if (ediFiles.length === 0) {
      console.log('\nNo .832 files found in outbox. Catalogs may still be generating.');
      return [];
    }

    // Ensure output directory
    if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

    // Download each file
    for (const f of ediFiles) {
      const remotePath = `${REMOTE_DIR}/${f.name}`;
      const localPath = path.join(OUTPUT_DIR, f.name);

      console.log(`\nDownloading: ${remotePath}...`);
      const chunks = [];
      const writable = new Writable({
        write(chunk, enc, cb) { chunks.push(chunk); cb(); },
      });

      try {
        await ftp.downloadTo(writable, remotePath);
        const content = Buffer.concat(chunks).toString('utf-8');
        if (content.length > 0) {
          fs.writeFileSync(localPath, content);
          console.log(`  Saved: ${localPath} (${(content.length / 1024).toFixed(1)}KB)`);
          localFiles.push(localPath);
        } else {
          console.log(`  Skipped: empty file`);
        }
      } catch (dlErr) {
        console.error(`  Download error: ${dlErr.message}`);
        // Try reconnecting for next file
        try {
          await ftp.access({ ...FTP_CONFIG, secure: false });
        } catch (_) {}
      }
    }
  } catch (err) {
    console.error('FTP error:', err.message);
    if (err.message.includes('Login') || err.message.includes('530')) {
      console.error('  → Check FTP credentials.');
    }
  } finally {
    ftp.close();
  }

  return localFiles;
}


// ---------------------------------------------------------------------------
// Database Import
// ---------------------------------------------------------------------------
function makeInternalSku(vendorSku, brand) {
  const prefix = 'TW';
  if (vendorSku) {
    return vendorSku.toUpperCase().startsWith('TW-') ? vendorSku : `${prefix}-${vendorSku}`;
  }
  return `${prefix}-UNKNOWN-${Date.now()}`;
}

async function ensureVendor() {
  const existing = await pool.query('SELECT id FROM vendors WHERE code = $1', [VENDOR_CODE]);
  if (existing.rows.length > 0) {
    console.log(`Vendor "${VENDOR_NAME}" exists (${existing.rows[0].id})`);
    return existing.rows[0].id;
  }
  const result = await pool.query(
    `INSERT INTO vendors (name, code, is_active) VALUES ($1, $2, true) RETURNING id`,
    [VENDOR_NAME, VENDOR_CODE]
  );
  console.log(`Created vendor "${VENDOR_NAME}" (${result.rows[0].id})`);
  return result.rows[0].id;
}

async function upsertSkuAttribute(skuId, slug, value) {
  if (!value || !String(value).trim()) return;
  const attr = await pool.query('SELECT id FROM attributes WHERE slug = $1', [slug]);
  if (!attr.rows.length) return;
  await pool.query(`
    INSERT INTO sku_attributes (sku_id, attribute_id, value)
    VALUES ($1, $2, $3)
    ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value = $3
  `, [skuId, attr.rows[0].id, String(value).trim()]);
}

function groupIntoProducts(items) {
  const products = new Map();

  for (const item of items) {
    if (!item.vendor_sku && !item.product_name) continue;

    const collection = item.collection || item.product_name || '';
    const brand = item.brand || '';
    const category = item.category || '';
    const isAccessory = /accessory|sundries|trim|molding|transition|reducer|stairnose|quarter|threshold|end.?cap|t.?mold/i.test(category)
      || /accessory|sundries|trim|molding|transition|reducer|stairnose|quarter|threshold|end.?cap|t.?mold/i.test(item.product_name || '');

    // Product name = collection/trade name (in Tri-West 832, each LIN group is a collection/product)
    let baseName = item.product_name || item.vendor_sku || 'Unknown';

    // Strip color from product name for grouping
    if (item.color && !isAccessory) {
      const colorEsc = item.color.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const stripped = baseName.replace(new RegExp('\\b' + colorEsc + '\\b', 'i'), '').replace(/\s{2,}/g, ' ').trim();
      if (stripped && stripped.length >= 3) baseName = stripped;
    }

    // Group by brand + baseName (not collection — collection encodes color, not product)
    const key = `${brand}|||${baseName}|||${isAccessory ? 'acc' : 'main'}`;

    if (!products.has(key)) {
      products.set(key, { baseName, collection, brand, category, isAccessory, items: [] });
    }
    products.get(key).items.push(item);
  }

  return Array.from(products.values());
}

async function importToDatabase(allItems) {
  const vendorId = await ensureVendor();

  // Pre-fetch category IDs
  const catCache = {};
  const catResult = await pool.query('SELECT id, slug FROM categories');
  for (const row of catResult.rows) catCache[row.slug] = row.id;

  const resolveCatId = (categoryText) => {
    if (!categoryText) return null;
    if (catCache[categoryText]) return catCache[categoryText];
    const slug = CATEGORY_MAP[categoryText.toLowerCase().trim()];
    return slug ? (catCache[slug] || null) : null;
  };

  const productGroups = groupIntoProducts(allItems);
  console.log(`\nGrouped ${allItems.length} SKUs into ${productGroups.length} products`);

  const stats = {
    products_created: 0, products_updated: 0,
    skus_created: 0, skus_updated: 0,
    pricing_upserted: 0, packaging_upserted: 0,
    attributes_upserted: 0,
  };

  for (const group of productGroups) {
    const categoryId = resolveCatId(group.category);
    const collection = group.brand ? cleanAndTitle(group.brand) : (group.collection ? cleanAndTitle(group.collection) : null);
    const brand = group.brand ? cleanAndTitle(group.brand) : null;

    // Description
    const rep = group.items[0];
    const descParts = [];
    if (rep.construction) descParts.push(rep.construction);
    if (brand) descParts.push(`by ${brand}`);
    if (rep.sqft_per_box) descParts.push(`${rep.sqft_per_box} SF/Box`);
    const descShort = descParts.length > 0 ? descParts.join(' | ') : null;

    const longParts = [];
    if (rep.construction && brand) longParts.push(`${rep.construction} flooring by ${brand}.`);
    if (collection) longParts.push(`Part of the ${collection} collection.`);
    if (rep.sqft_per_box) longParts.push(`${rep.sqft_per_box} sq ft per carton.`);
    const descLong = longParts.length > 0 ? longParts.join(' ') : null;

    // Upsert product — match by vendor + brand (collection) + name
    let productId;
    const existingProduct = await pool.query(
      'SELECT id FROM products WHERE vendor_id = $1 AND collection = $2 AND name = $3',
      [vendorId, collection || '', group.baseName]
    );

    if (existingProduct.rows.length > 0) {
      productId = existingProduct.rows[0].id;
      await pool.query(`
        UPDATE products SET category_id = COALESCE($1, category_id), status = 'active',
          description_short = COALESCE($2, description_short),
          description_long = COALESCE($3, description_long),
          updated_at = NOW()
        WHERE id = $4
      `, [categoryId, descShort, descLong, productId]);
      stats.products_updated++;
    } else {
      const pResult = await pool.query(`
        INSERT INTO products (vendor_id, name, collection, category_id, status, description_short, description_long)
        VALUES ($1, $2, $3, $4, 'active', $5, $6)
        RETURNING id
      `, [vendorId, group.baseName, collection || '', categoryId, descShort, descLong]);
      productId = pResult.rows[0].id;
      stats.products_created++;
    }

    // Upsert SKUs
    for (const item of group.items) {
      const internalSku = makeInternalSku(item.vendor_sku, item.brand);
      const vendorSku = item.vendor_sku || internalSku;
      const variantName = item.color ? cleanAndTitle(item.color) : cleanAndTitle(item.product_name);
      const sellBy = item.sell_by || 'sqft';
      const variantType = group.isAccessory ? 'accessory' : null;

      let skuId;
      const existingSku = await pool.query('SELECT id FROM skus WHERE internal_sku = $1', [internalSku]);

      if (existingSku.rows.length > 0) {
        skuId = existingSku.rows[0].id;
        await pool.query(`
          UPDATE skus SET product_id = $1, vendor_sku = $2, variant_name = $3,
            sell_by = $4, variant_type = $5, status = 'active', updated_at = NOW()
          WHERE id = $6
        `, [productId, vendorSku, variantName, sellBy, variantType, skuId]);
        stats.skus_updated++;
      } else {
        const sResult = await pool.query(`
          INSERT INTO skus (product_id, vendor_sku, internal_sku, variant_name, sell_by, variant_type, status)
          VALUES ($1, $2, $3, $4, $5, $6, 'active')
          RETURNING id
        `, [productId, vendorSku, internalSku, variantName, sellBy, variantType]);
        skuId = sResult.rows[0].id;
        stats.skus_created++;
      }

      // Upsert pricing — 2× markup for retail when only cost is available
      if (item.cost || item.retail_price) {
        const priceBasis = sellBy === 'sqft' ? 'per_sqft' : 'per_unit';
        const cost = item.cost || 0;
        const retail = (item.retail_price && item.retail_price !== item.cost)
          ? item.retail_price
          : Math.round(cost * 2 * 100) / 100;
        await pool.query(`
          INSERT INTO pricing (sku_id, cost, retail_price, price_basis)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (sku_id) DO UPDATE SET cost = $2, retail_price = $3, price_basis = $4
        `, [skuId, cost, retail, priceBasis]);
        stats.pricing_upserted++;
      }

      // Upsert packaging
      if (item.sqft_per_box || item.pieces_per_box || item.weight_per_box_lbs) {
        await pool.query(`
          INSERT INTO packaging (sku_id, sqft_per_box, pieces_per_box, weight_per_box_lbs)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (sku_id) DO UPDATE SET
            sqft_per_box = COALESCE($2, packaging.sqft_per_box),
            pieces_per_box = COALESCE($3, packaging.pieces_per_box),
            weight_per_box_lbs = COALESCE($4, packaging.weight_per_box_lbs)
        `, [skuId, item.sqft_per_box, item.pieces_per_box, item.weight_per_box_lbs]);
        stats.packaging_upserted++;
      }

      // Upsert attributes
      if (item.color) { await upsertSkuAttribute(skuId, 'color', item.color); stats.attributes_upserted++; }
      if (item.brand) { await upsertSkuAttribute(skuId, 'brand', cleanAndTitle(item.brand)); stats.attributes_upserted++; }
      if (item.collection) { await upsertSkuAttribute(skuId, 'collection', cleanAndTitle(item.collection)); stats.attributes_upserted++; }
      if (item.material_class) { await upsertSkuAttribute(skuId, 'material_class', item.material_class); stats.attributes_upserted++; }
      if (item.construction) { await upsertSkuAttribute(skuId, 'construction', item.construction); stats.attributes_upserted++; }
      if (item.style_code) { await upsertSkuAttribute(skuId, 'style_code', item.style_code); stats.attributes_upserted++; }
      if (item.upc) { await upsertSkuAttribute(skuId, 'upc', item.upc); stats.attributes_upserted++; }

      // Vendor SKU cross-references from PID 08 (Tri-West includes related SKUs here)
      const crossRefs = item.descriptions
        .filter(d => d.characteristic_code === '08' && d.description)
        .map(d => d.description);
      if (crossRefs.length > 0) {
        await upsertSkuAttribute(skuId, 'vendor_cross_refs', crossRefs.join(', '));
        stats.attributes_upserted++;
      }

      // Dye code from PID 35
      const dyeCodePid = item.descriptions.find(d => d.characteristic_code === '35');
      if (dyeCodePid) {
        await upsertSkuAttribute(skuId, 'color_code', dyeCodePid.description);
        stats.attributes_upserted++;
      }
    }
  }

  return stats;
}


// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2);
  const listOnly = args.includes('--list');
  const dryRun = args.includes('--dry-run');
  const fileIdx = args.indexOf('--file');
  let localFiles = [];

  console.log('=== Tri-West EDI 832 Catalog Importer ===\n');

  // Step 1: Get the files
  if (fileIdx !== -1) {
    const filePath = args[fileIdx + 1];
    if (!filePath || !fs.existsSync(filePath)) {
      console.error(`File not found: ${filePath}`);
      process.exit(1);
    }
    // Support directory or single file
    if (fs.statSync(filePath).isDirectory()) {
      localFiles = fs.readdirSync(filePath)
        .filter(f => f.endsWith('.832'))
        .map(f => path.join(filePath, f));
    } else {
      localFiles = [filePath];
    }
    console.log(`Using local file(s): ${localFiles.length}`);
  } else {
    localFiles = await downloadAll832(listOnly);
    if (listOnly) {
      await pool.end();
      process.exit(0);
    }
  }

  if (localFiles.length === 0) {
    console.log('\nNo files to process.');
    await pool.end();
    process.exit(0);
  }

  // Step 2: Parse all files
  let allItems = [];
  const brandSummary = {};

  for (const filePath of localFiles) {
    console.log(`\n── Parsing: ${path.basename(filePath)} ──`);
    const raw = fs.readFileSync(filePath, 'utf-8');
    console.log(`File size: ${(raw.length / 1024).toFixed(1)}KB, ${raw.split('\n').length} lines`);

    const catalog = parse832(raw);

    console.log(`Interchange: ${catalog.interchange.sender_id || '?'} → ${catalog.interchange.receiver_id || '?'}`);
    console.log(`Transaction: ${catalog.transaction.type || '?'} #${catalog.transaction.control_number || '?'}`);
    console.log(`Items parsed: ${catalog.items.length}`);

    // Collect brand stats
    for (const item of catalog.items) {
      const brand = item.brand || 'Unknown';
      brandSummary[brand] = (brandSummary[brand] || 0) + 1;
    }

    allItems.push(...catalog.items);
  }

  // Step 3: Summary
  console.log('\n── Combined Summary ──');
  console.log(`Total files: ${localFiles.length}`);
  console.log(`Total SKUs: ${allItems.length}`);
  console.log(`With pricing: ${allItems.filter(i => i.cost || i.retail_price).length}`);
  console.log(`With product name: ${allItems.filter(i => i.product_name).length}`);
  console.log(`Sold by sqft: ${allItems.filter(i => i.sell_by === 'sqft').length}`);
  console.log(`Sold by unit: ${allItems.filter(i => i.sell_by === 'unit').length}`);

  console.log('\nBrands found:');
  for (const [brand, count] of Object.entries(brandSummary).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${brand}: ${count} SKUs`);
  }

  // Show sample items
  console.log('\n── Sample Items (first 3) ──');
  for (const item of allItems.slice(0, 3)) {
    console.log(JSON.stringify({
      vendor_sku: item.vendor_sku,
      product_name: item.product_name,
      color: item.color,
      collection: item.collection,
      brand: item.brand,
      category: item.category,
      construction: item.construction,
      cost: item.cost,
      retail_price: item.retail_price,
      sell_by: item.sell_by,
      sqft_per_box: item.sqft_per_box,
      weight_per_box_lbs: item.weight_per_box_lbs,
    }, null, 2));
  }

  // Step 4: Write JSON output
  const outputPath = path.join(OUTPUT_DIR, 'triwest_832_combined.json');
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify({
    meta: {
      source: 'Tri-West',
      parsed_at: new Date().toISOString(),
      files: localFiles.map(f => path.basename(f)),
    },
    summary: {
      total_items: allItems.length,
      brands: brandSummary,
    },
    items: allItems.map(item => ({
      vendor_sku: item.vendor_sku, upc: item.upc,
      product_name: item.product_name, color: item.color,
      collection: item.collection, brand: item.brand,
      category: item.category, construction: item.construction,
      cost: item.cost, retail_price: item.retail_price,
      sell_by: item.sell_by, sqft_per_box: item.sqft_per_box,
      pieces_per_box: item.pieces_per_box,
      weight_per_box_lbs: item.weight_per_box_lbs,
      style_code: item.style_code,
    })),
  }, null, 2));
  console.log(`\nJSON output: ${outputPath}`);

  // Step 5: Import to database
  if (dryRun) {
    console.log('\n[DRY RUN] No database writes performed.');
  } else {
    console.log('\n── Importing to Database ──');
    try {
      const stats = await importToDatabase(allItems);
      console.log('\nImport complete:');
      console.log(`  Products created:    ${stats.products_created}`);
      console.log(`  Products updated:    ${stats.products_updated}`);
      console.log(`  SKUs created:        ${stats.skus_created}`);
      console.log(`  SKUs updated:        ${stats.skus_updated}`);
      console.log(`  Pricing upserted:    ${stats.pricing_upserted}`);
      console.log(`  Packaging upserted:  ${stats.packaging_upserted}`);
      console.log(`  Attributes upserted: ${stats.attributes_upserted}`);
    } catch (err) {
      console.error('Database import error:', err);
    }
  }

  await pool.end();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
