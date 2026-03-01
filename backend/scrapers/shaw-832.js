/**
 * Shaw Floors — EDI 832 SFTP Importer
 *
 * Connects to shawedi.shawfloors.com via SFTP, downloads the latest 832
 * (Price/Sales Catalog) file, parses EDI segments, and upserts
 * products/SKUs/pricing/packaging/attributes into the database.
 *
 * Structure: Each LIN = one product/style, each SLN = one color SKU.
 * Parses all segment types: LIN, SLN, PID, CTP, MEA, PO4, REF, DTM, G39.
 *
 * Config (vendor_sources.config):
 *   sftp_host, sftp_port, sftp_user, sftp_pass — connection credentials
 *   processed_files — array of filenames already imported (auto-maintained)
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const SftpClient = require('ssh2-sftp-client');

import fs from 'fs';
import {
  appendLog, addJobError,
  upsertProduct, upsertSku,
  upsertSkuAttribute, upsertPackaging, upsertPricing,
} from './base.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VENDOR_CODE = 'SHAW';

const DEFAULT_SFTP = {
  host: 'shawedi.shawfloors.com',
  port: 22,
  username: 'edi07408',
  password: 'ef6049',
};

// Directories to scan on the remote server
// Shaw's SFTP uses /Inbox, /Outbox with /Archive subdirectories
const REMOTE_DIRS = [
  '/Outbox', '/Outbox/Archive',
  '/Inbox', '/Inbox/Archive',
  '/outbound', '/outbound/832', '/outbound/catalog',
  '/inbound', '/inbound/832',
  '/832', '/catalog', '/pricelist',
  '/out', '/in', '/OUT', '/IN',
  '/Outbound', '/Inbound',
  '/data', '/data/outbound', '/data/inbound',
  '/edi', '/edi/outbound', '/edi/inbound', '/edi/832',
  '/export', '/home', '/home/edi07408',
  '/',
];

// Map EDI category text → category slugs in our DB
const CATEGORY_MAP = {
  // Carpet
  'carpet':              'carpet',
  'broadloom':           'carpet',
  'tuftex':              'carpet',
  'anso nylon':          'carpet',
  'caress':              'carpet',
  'lifeguard':           'carpet',
  'carpet tile':         'carpet-tile',
  // Hardwood
  'engineered hardwood': 'engineered-hardwood',
  'hardwood':            'hardwood',
  'solid hardwood':      'solid-hardwood',
  'epic hardwood':       'engineered-hardwood',
  // LVP / LVT
  'luxury vinyl plank':  'luxury-vinyl',
  'luxury vinyl tile':   'luxury-vinyl',
  'lvp':                 'luxury-vinyl',
  'lvt':                 'luxury-vinyl',
  'spc':                 'luxury-vinyl',
  'wpc':                 'luxury-vinyl',
  'vinyl plank':         'luxury-vinyl',
  'vinyl tile':          'luxury-vinyl',
  'floorte':             'luxury-vinyl',
  'floorte pro':         'luxury-vinyl',
  'floorte elite':       'luxury-vinyl',
  'resilient':           'luxury-vinyl',
  // Laminate
  'laminate':            'laminate',
  'repel laminate':      'laminate',
  // Tile
  'tile':                'tile',
  'porcelain':           'porcelain-tile',
  'ceramic':             'ceramic-tile',
  'stone':               'natural-stone',
  // Accessories
  'accessory':           'installation-sundries',
  'accessories':         'installation-sundries',
  'trim':                'transitions-moldings',
  'molding':             'transitions-moldings',
  'transition':          'transitions-moldings',
  'underlayment':        'underlayment',
  'adhesive':            'adhesives-sealants',
};

// PID*F*MAC material class → category slug
const MAC_CATEGORY_MAP = {
  CARIND: 'carpet',        // Broadloom / roll carpet
  CARTIL: 'carpet-tile',   // Modular carpet tile
  WOO:    'engineered-hardwood',
  WOOMIS: 'transitions-moldings',
  VINTIL: 'luxury-vinyl',
  VINMIS: 'transitions-moldings',
  CERFLO: 'tile',
  CERMIS: 'transitions-moldings',
  ACC:    'installation-sundries',
};

// PID characteristic codes → human-readable
const PID_CODES = {
  '08': 'description',
  GEN: 'category',
  '09': 'sub_product',
  '73': 'color',
  '74': 'pattern',
  '75': 'finish',
  '35': 'color_code',
  '37': 'material',
  '38': 'style',
  DIM: 'dimensions',
  MAC: 'material_class',
  '12': 'quality',
  '77': 'collection',
  TRN: 'trade_name',
  CO:  'co_collection',
  BLM: 'molding_type',
};

// LIN/SLN qualifier codes → field names
const LIN_QUALIFIERS = {
  UP: 'upc', VN: 'vendor_item_number', SK: 'sku',
  MG: 'manufacturer_group', BP: 'buyer_part_number',
  IN: 'buyer_item_number', MN: 'model_number',
  GN: 'generic_name', UA: 'upc_case_code',
  CB: 'catalog_number', FS: 'standard_number',
  EC: 'ean', EN: 'ean', UK: 'upc_shipping',
  PI: 'purchaser_item', PN: 'part_number', VA: 'vendor_alpha',
  // Shaw-specific
  GS: 'style_number', ST: 'style_code', MS: 'manufacturer_style',
  MF: 'manufacturer_name', UX: 'unit_code',
};

// CTP class and type codes
const CTP_CLASS = { WS: 'wholesale', RS: 'retail', CT: 'contractor', DE: 'dealer', DI: 'distributor' };
const CTP_TYPE = { RES: 'resale', NET: 'net', MSR: 'msrp', UCP: 'unit_cost', PRP: 'promotional', CON: 'contract', MAP: 'map', CAT: 'catalog' };

// MEA qualifier codes
const MEA_CODES = {
  TH: 'thickness', WD: 'width', LN: 'length', WT: 'weight',
  WL: 'wear_layer', HT: 'height', SQ: 'area',
  SW: 'shipping_weight', SU: 'sell_units', CF: 'cases',
  S: 'size',
};


// ---------------------------------------------------------------------------
// EDI Text Cleaning
// ---------------------------------------------------------------------------

// Common EDI truncations → full words (product/variant names)
const ABBREVIATION_MAP = {
  'ANODI':       'ANODIZED',
  'ANODIZ':      'ANODIZED',
  'TRHD':        'THRESHOLD',
  'SEALR':       'SEALER',
  'CLNR':        'CLEANER',
  'CONCENTRAT':  'CONCENTRATE',
  'ADH':         'ADHESIVE',
  'JMBO':        'JUMBO',
  'CPT':         'CARPET',
  'SLP':         'SLIP',
  'DRYBAC':      'DRYBACK',
  'INDENTIONS':  'INDENTIONS',
};

// Words/acronyms that should stay uppercase after title-casing
const KEEP_UPPER = new Set([
  'II', 'III', 'IV', 'VI', 'VII', 'VIII', 'IX', 'XI', 'XII',
  'HD', 'SPC', 'WPC', 'LVT', 'LVP', 'PVC', 'BCF', 'PET', 'SD',
  'HDF', 'MDF', 'COREtec', 'USA', 'UV',
]);

// Words that should stay lowercase in titles
const KEEP_LOWER = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'in', 'on', 'at', 'to', 'for', 'by', 'with']);

/**
 * Clean raw EDI text:
 * - Collapse multiple spaces to single
 * - Restore stripped special characters (apostrophes, ampersands, fractions)
 * - Expand known truncated abbreviations
 */
function cleanEdiText(text) {
  if (!text || typeof text !== 'string') return text;
  let s = text.trim();

  // Collapse multiple spaces → single
  s = s.replace(/\s{2,}/g, ' ');

  // Restore fractions in dimension names: "1 2" → "1/2", "3 8" → "3/8", "5 16" → "5/16", "7 16" → "7/16", "3 4" → "3/4", "9 16" → "9/16"
  // Only at word boundaries where both parts are small numbers typical of fractions
  s = s.replace(/\b(1) (2)\b/g, '$1/$2');
  s = s.replace(/\b(1) (4)\b/g, '$1/$2');
  s = s.replace(/\b(3) (8)\b/g, '$1/$2');
  s = s.replace(/\b(5) (16)\b/g, '$1/$2');
  s = s.replace(/\b(7) (16)\b/g, '$1/$2');
  s = s.replace(/\b(9) (16)\b/g, '$1/$2');
  s = s.replace(/\b(3) (4)\b/g, '$1/$2');

  // Restore apostrophes in known patterns: "DREAMIN " → "DREAMIN'", "FEELIN " → "FEELIN'"
  s = s.replace(/\b(DREAMIN|FEELIN|LOVIN|MOVIN|GROOVIN|LIVIN|ROCKIN|ROLLIN|CRUISIN|NOTHIN|SOMETHIN|EVERYTHIN)\b(?!\w)/gi, "$1'");

  // Restore contractions: "THAT S" → "THAT'S", "IT S" → "IT'S", "DON T" → "DON'T", etc.
  s = s.replace(/\b(THAT|IT|DON|CAN|WON|ISN|AIN|COULDN|WOULDN|SHOULDN|DIDN|WASN|WEREN|HASN|HAVEN|LET|WHAT|WHO|WHERE|THERE|HERE) (S|T|RE|VE|LL|D|M)\b/gi, "$1'$2");

  // Restore possessives: "NATURE S MARK" → "NATURE'S MARK", "BABY S BREATH" → "BABY'S BREATH"
  // Match word(3+ chars) + standalone S (not followed by another letter that would make it a real word)
  s = s.replace(/\b([A-Z]{3,}) S\b/gi, "$1'S");

  // Restore ampersands: "LOUD CLEAR" where & was stripped — harder to detect generically
  // We handle this via known patterns
  s = s.replace(/\bLOUD CLEAR\b/gi, 'LOUD & CLEAR');
  s = s.replace(/\bLAUGHS YAWNS\b/gi, 'LAUGHS & YAWNS');
  s = s.replace(/\bCUT UNCUT\b/gi, 'CUT & UNCUT');

  // Expand trailing abbreviations (only at end of string or before spaces)
  for (const [abbr, full] of Object.entries(ABBREVIATION_MAP)) {
    const re = new RegExp(`\\b${abbr}\\b`, 'gi');
    s = s.replace(re, full);
  }

  return s.trim();
}

/**
 * Title-case an ALL-CAPS EDI string.
 * Preserves known acronyms (HD, SPC, PVC, BCF, PET, etc.)
 */
function titleCaseEdi(text) {
  if (!text || typeof text !== 'string') return text;
  // Don't title-case if it's already mixed case
  if (text !== text.toUpperCase()) return text;

  return text
    .toLowerCase()
    .split(/(\s+|[-/])/)
    .map((word, i) => {
      if (!word.trim()) return word; // whitespace/separator
      if (word === '-' || word === '/') return word;
      const upper = word.toUpperCase();
      if (KEEP_UPPER.has(upper)) return upper;
      // Keep lowercase for articles/prepositions (except first word)
      if (i > 0 && KEEP_LOWER.has(word)) return word;
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join('');
}

/**
 * Clean + title-case EDI text for customer-facing display.
 */
function cleanAndTitle(text) {
  return titleCaseEdi(cleanEdiText(text));
}

/**
 * Check if a string looks like a real SKU code (has digits) vs a style/product name (all alpha+spaces).
 */
function looksLikeSkuCode(val) {
  if (!val) return false;
  // Real Shaw SKUs have digits: "5480101210", "SW84300130", "155TS00001"
  // Style names are all alpha+spaces: "ABBEY S ROAD", "ON THE MOVE"
  return /\d/.test(val);
}

/**
 * Clean fiber value: "PILE 100 NYLON" → "100% Nylon"
 */
function cleanFiber(raw) {
  if (!raw) return raw;
  // Match "PILE 100 NYLON" or "100 NYLON" patterns
  const m = raw.match(/(?:PILE\s+)?(\d+)\s+(.+)/i);
  if (m) {
    const pct = m[1];
    const fiber = m[2].trim();
    // Title-case fiber but preserve acronyms like PET, BCF
    const cleanFiberName = fiber.split(/\s+/).map(w => {
      const u = w.toUpperCase();
      if (KEEP_UPPER.has(u)) return u;
      return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    }).join(' ');
    return `${pct}% ${cleanFiberName}`;
  }
  return titleCaseEdi(raw);
}

/**
 * Clean construction value: collapse spaces, title-case, expand abbreviations.
 * "CUT UNCUT  R" → "Cut & Uncut" (drop trailing single chars)
 * "GRAPHICS   HS LOOP" → "Graphics HS Loop"
 * "TEXTURE BCF" → "Texture BCF"
 */
function cleanConstruction(raw) {
  if (!raw) return raw;
  let s = cleanEdiText(raw);
  // Drop trailing single character that's clearly truncated (e.g. " R", " S", " T", " B", " D")
  s = s.replace(/\s+[A-Z]$/i, '');
  return titleCaseEdi(s);
}


// ---------------------------------------------------------------------------
// EDI 832 Parser
// ---------------------------------------------------------------------------

function tokenizeSegments(raw) {
  let text = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (text.includes('~')) {
    return text.split('~').map(s => s.trim()).filter(Boolean);
  }
  return text.split('\n').map(s => s.trim()).filter(Boolean);
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
  const result = {
    sub_line_number: seg.el[1] || null,
    identifiers: {},
    descriptions: [],
    color: null,
    color_code: null,
    vendor_sku: null,
    companions: [],
  };
  // Scan for qualifier/value pairs after the fixed SLN fields
  for (let i = 4; i < seg.el.length - 1; i++) {
    const qual = seg.el[i];
    if (qual && LIN_QUALIFIERS[qual] && seg.el[i + 1]) {
      result.identifiers[LIN_QUALIFIERS[qual]] = seg.el[i + 1];
      i++; // skip value element
    }
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
    qualifier: seg.el[9] || null, // ST = standard, CT = contract
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

function parse832(raw) {
  const segments = tokenizeSegments(raw).map(parseSegment);
  const catalog = { items: [], summary: { total_items: 0, segment_count: segments.length, total_skus: 0 } };
  let currentItem = null;
  let currentSubLine = null;
  let inSubLine = false;

  for (const seg of segments) {
    switch (seg.id) {
      case 'LIN': {
        // Finalize previous sub-line and item
        if (currentSubLine && currentItem) { currentItem.sub_lines.push(currentSubLine); currentSubLine = null; }
        if (currentItem) { finalizeItem(currentItem); catalog.items.push(currentItem); }
        inSubLine = false;
        const lin = parseLIN(seg);
        currentItem = {
          line_number: lin.line_number, identifiers: lin.identifiers,
          descriptions: [], packaging: null, pricing: [], measurements: [],
          sub_lines: [], companion_refs: [],
          vendor_sku: null, upc: null, product_name: null, color: null,
          collection: null, category: null, cost: null, retail_price: null,
          unit_of_measure: null, sqft_per_box: null, pieces_per_box: null,
          weight_per_box_lbs: null, sell_by: null,
          cut_price: null, roll_price: null, cut_cost: null, roll_cost: null, roll_min_sqft: null,
          roll_width_ft: null, roll_length_ft: null, map_price: null,
          freight_class: null, weight_per_sy: null,
          sqft_per_pallet: null, weight_per_pallet_lbs: null,
          // New fields from extended segment parsing
          trade_name: null, material_class: null, subcategory: null,
          price_list: null, effective_date: null,
          shipping_weight: null, sell_units: null, sell_unit_uom: null,
          pieces_per_carton: null, cartons_per_pallet: null,
        };
        break;
      }

      case 'SLN': {
        // Finalize previous sub-line
        if (currentSubLine && currentItem) currentItem.sub_lines.push(currentSubLine);
        currentSubLine = parseSLN(seg);
        inSubLine = true;
        break;
      }

      case 'PO4': {
        if (currentItem && !inSubLine) currentItem.packaging = parsePO4(seg);
        break;
      }

      case 'CTP': {
        if (currentItem && !inSubLine) currentItem.pricing.push(parseCTP(seg));
        break;
      }

      case 'PID': {
        const pid = parsePID(seg);
        if (inSubLine && currentSubLine) {
          currentSubLine.descriptions.push(pid);
        } else if (currentItem) {
          currentItem.descriptions.push(pid);
        }
        break;
      }

      case 'MEA': {
        if (currentItem && !inSubLine) currentItem.measurements.push(parseMEA(seg));
        break;
      }

      case 'REF': {
        if (currentItem && !inSubLine) {
          const qual = seg.el[1];
          if (qual === '19') currentItem.price_list = seg.el[3] || seg.el[2] || null;
          else if (qual === 'DM') currentItem.companion_refs.push(seg.el[2] || '');
        }
        break;
      }

      case 'DTM': {
        if (currentItem && !inSubLine && !currentItem.effective_date) {
          if (seg.el[1] === '007' && seg.el[2]) currentItem.effective_date = seg.el[2];
        }
        break;
      }

      case 'G39': {
        if (currentItem && !inSubLine) {
          for (let i = 2; i < Math.min(seg.el.length, 6); i += 2) {
            const qual = seg.el[i], val = seg.el[i + 1];
            if (qual && val) {
              const key = LIN_QUALIFIERS[qual] || qual.toLowerCase();
              if (!currentItem.identifiers[key]) currentItem.identifiers[key] = val;
            }
          }
          if (seg.el[17]) {
            currentItem.descriptions.push({ description_type: 'F', characteristic_code: '08', characteristic_label: 'description', description: seg.el[17] });
          }
          if (seg.el[9] && seg.el[10] && !currentItem.packaging) {
            currentItem.packaging = { size_per_pack: parseFloat(seg.el[9]), unit_of_measure: seg.el[10], pieces_per_pack: seg.el[11] ? parseInt(seg.el[11], 10) : null };
          }
        }
        break;
      }

      case 'G43': break; // Tax jurisdiction — not needed for import

      case 'CTT': case 'SE': {
        if (currentSubLine && currentItem) { currentItem.sub_lines.push(currentSubLine); currentSubLine = null; }
        if (currentItem) { finalizeItem(currentItem); catalog.items.push(currentItem); currentItem = null; }
        inSubLine = false;
        if (seg.id === 'CTT') catalog.summary.total_items = seg.el[1] ? parseInt(seg.el[1], 10) : catalog.items.length;
        break;
      }
      default: break;
    }
  }

  // Handle last item
  if (currentSubLine && currentItem) currentItem.sub_lines.push(currentSubLine);
  if (currentItem) { finalizeItem(currentItem); catalog.items.push(currentItem); }
  if (!catalog.summary.total_items) catalog.summary.total_items = catalog.items.length;

  // Count total SKUs across all items
  catalog.summary.total_skus = catalog.items.reduce((sum, item) => sum + item.sub_lines.length, 0);

  return catalog;
}

function finalizeItem(item) {
  // --- Identifiers ---
  // Prefer style_number (GS code) as the parent style identifier
  item.vendor_sku = item.identifiers.style_number || item.identifiers.style_code
    || item.identifiers.sku || item.identifiers.vendor_item_number
    || item.identifiers.model_number || item.identifiers.part_number || null;
  item.upc = item.identifiers.upc || null;

  // --- Product name from PID*F*TRN (trade name) ---
  const trnPid = item.descriptions.find(d => d.characteristic_code === 'TRN');
  item.trade_name = trnPid ? trnPid.description : null;
  // Fallback to model_number identifier, then PID*F*08
  const rawProductName = item.trade_name
    || item.identifiers.model_number
    || (item.descriptions.find(d => d.characteristic_code === '08') || {}).description
    || null;
  item.product_name = cleanAndTitle(rawProductName);

  // --- Material class from PID*F*MAC ---
  const macPid = item.descriptions.find(d => d.characteristic_code === 'MAC');
  item.material_class = macPid ? macPid.description : null;

  // --- Subcategory / quality from PID*F*12 ---
  const qualPid = item.descriptions.find(d => d.characteristic_code === '12');
  item.subcategory = qualPid ? cleanEdiText(qualPid.description) : null;

  // --- Collection from PID*F*CO (preferred) or PID*F*77 ---
  const coPid = item.descriptions.find(d => d.characteristic_code === 'CO');
  const collPid = item.descriptions.find(d => d.characteristic_code === '77');
  const rawCollection = coPid ? coPid.description : (collPid ? collPid.description : null);
  item.collection = cleanAndTitle(rawCollection);

  // --- Color (from LIN-level PID, if present) ---
  const colorPid = item.descriptions.find(d => d.characteristic_code === '73');
  item.color = colorPid ? cleanAndTitle(colorPid.description) : null;

  // --- Category resolution: MAC → subcategory refinement → GEN → inference ---
  const catPid = item.descriptions.find(d => d.characteristic_code === 'GEN');

  // Primary: material class code
  if (item.material_class && MAC_CATEGORY_MAP[item.material_class]) {
    item.category = MAC_CATEGORY_MAP[item.material_class];
  } else if (catPid) {
    item.category = catPid.description;
  }

  // Refine using PID*F*12 subcategory
  if (item.subcategory) {
    const sub = item.subcategory.toUpperCase();
    if (/\bSPC\b|\bWPC\b/.test(sub)) item.category = 'luxury-vinyl';
    else if (/DRYBACK|DRYBAC/.test(sub)) item.category = 'luxury-vinyl';
    else if (/ENGINEERED HARDWOOD/.test(sub)) item.category = 'engineered-hardwood';
    else if (/RESIDENTIAL FLOOR TILE|COMMERCIAL FLOOR TILE/.test(sub)) item.category = 'tile';
    else if (/\bADHESIVE\b/.test(sub) && !/CARIND|CARTIL/.test(item.material_class || '')) item.category = 'adhesives-sealants';
    else if (/\bCLEANER\b|\bSUNDRIES\b/.test(sub)) item.category = 'installation-sundries';
    else if (/\bUNDERLAYMENT\b|\bPAD\b|\bREBOND\b/.test(sub) && item.material_class !== 'CARIND') item.category = 'underlayment';
    else if (/\bTRIM\b|\bMOLDING\b/.test(sub) && !/CARIND|CARTIL/.test(item.material_class || '')) item.category = 'transitions-moldings';
  }

  // Fallback: infer from fiber content / name
  if (!item.category) {
    const mat = (item.descriptions.find(d => d.characteristic_code === '37') || {}).description || '';
    const name = (item.product_name || '').toLowerCase();
    if (/pile|nylon|polyester|pet|olefin|wool/i.test(mat)) item.category = 'carpet';
    else if (/adhesive|adh\b/i.test(name)) item.category = 'adhesives-sealants';
    else if (/underlayment|pad\b/i.test(name)) item.category = 'underlayment';
    else if (/stairnose|threshold|reducer|bullnose|t.?mold|quarter.?round|transition|l.?shape|u.?shape|q.?shape/i.test(name)) item.category = 'transitions-moldings';
    else if (/seam|sealer|poly\b/i.test(name)) item.category = 'installation-sundries';
  }

  // --- Measurements ---

  // Sellable units (sqft per carton or units per carton) from MEA**SU
  const suMea = item.measurements.find(m => m.qualifier === 'SU');
  if (suMea && suMea.value) {
    item.sell_units = suMea.value;
    item.sell_unit_uom = suMea.unit_of_measure;
    const uom = (suMea.unit_of_measure || '').toUpperCase();
    if (uom === 'SF') { item.sqft_per_box = suMea.value; item.sell_by = 'sqft'; }
    else if (uom === 'SY') { item.sqft_per_box = suMea.value * 9; item.sell_by = 'sqyd'; }
    else if (uom === 'EA' || uom === 'BX' || uom === 'PC') { item.sell_by = 'unit'; }
  }

  // Shipping weight from MEA**SW (Shaw EDI reports weight per sqft for box products)
  const swMea = item.measurements.find(m => m.qualifier === 'SW');
  if (swMea && swMea.value) item.shipping_weight = swMea.value;
  // Store raw weight-per-sqft for later conversion
  item._weight_per_sqft = swMea && swMea.value ? swMea.value : null;

  // Cases per carton (CF*n*CT) and cartons per pallet (CF*n*PL)
  const cfMeas = item.measurements.filter(m => m.qualifier === 'CF');
  for (const cf of cfMeas) {
    const container = (cf.unit_of_measure || '').toUpperCase();
    if (container === 'CT' && cf.value) item.pieces_per_carton = cf.value;
    else if (container === 'PL' && cf.value) item.cartons_per_pallet = cf.value;
  }

  // --- Packaging from PO4 (fallback if MEA didn't provide) ---
  if (item.packaging) {
    const uom = (item.packaging.unit_of_measure || '').toUpperCase();
    if (!item.sqft_per_box) {
      if (uom === 'SF' || uom === 'SY' || uom === 'FT2') { item.sqft_per_box = item.packaging.size_per_pack; item.sell_by = 'sqft'; }
      else if (uom === 'EA' || uom === 'PC') { item.sell_by = 'unit'; }
      else if (uom === 'LF') { item.sell_by = 'unit'; }
      else if (item.packaging.size_per_pack) { item.sqft_per_box = item.packaging.size_per_pack; item.sell_by = 'sqft'; }
    }
    if (!item.pieces_per_box) item.pieces_per_box = item.packaging.pieces_per_pack || null;
    if (!item.weight_per_box_lbs) item.weight_per_box_lbs = item.packaging.gross_weight || null;
  }

  // --- Pricing ---
  // Shaw 832 uses CTP with ST (standard) and CT (contract) qualifiers
  const stdPrice = item.pricing.find(p => p.qualifier === 'ST');
  const ctPrice = item.pricing.find(p => p.qualifier === 'CT');

  if (stdPrice) {
    item.cost = stdPrice.unit_price;
    item.unit_of_measure = stdPrice.unit_of_measure || item.unit_of_measure;
  }
  if (ctPrice && ctPrice.unit_price > 0) {
    item.retail_price = ctPrice.unit_price; // Contract price as secondary
  }

  // Fallback to generic CTP parsing (for non-Shaw 832 files)
  if (!item.cost) {
    const netPrice = item.pricing.find(p => p.price_type === 'NET')
      || item.pricing.find(p => p.class_of_trade === 'WS')
      || item.pricing.find(p => p.class_of_trade === 'DE')
      || item.pricing[0];
    if (netPrice) { item.cost = netPrice.unit_price; item.unit_of_measure = netPrice.unit_of_measure || item.unit_of_measure; }
  }
  if (!item.retail_price) {
    const msrpPrice = item.pricing.find(p => p.price_type === 'MSR')
      || item.pricing.find(p => p.class_of_trade === 'RS')
      || item.pricing.find(p => p.price_type === 'CAT');
    if (msrpPrice) item.retail_price = msrpPrice.unit_price;
  }

  const mapPrice = item.pricing.find(p => p.price_type === 'MAP');
  if (mapPrice) item.map_price = mapPrice.unit_price;

  if (!item.sell_by && item.unit_of_measure) {
    const puom = item.unit_of_measure.toUpperCase();
    if (puom === 'SF') item.sell_by = 'sqft';
    else if (puom === 'SY') item.sell_by = 'sqyd';
    else if (puom === 'EA' || puom === 'PC' || puom === 'BX') item.sell_by = 'unit';
  }

  // --- Carpet-specific pricing (both broadloom and carpet tile) ---
  const isCarpetCat = item.material_class === 'CARIND' || item.material_class === 'CARTIL'
    || item.category === 'carpet' || item.category === 'carpet-tile';
  if (isCarpetCat && item.pricing.length > 0) {
    // Standard (qty break 125+ SY) = roll/volume price
    // Contract (qty 1 SY) = cut/piece price (higher per unit)
    if (stdPrice) { item.roll_price = stdPrice.unit_price; item.roll_cost = stdPrice.unit_price; }
    if (ctPrice && ctPrice.unit_price > 0) { item.cut_price = ctPrice.unit_price; item.cut_cost = ctPrice.unit_price; }

    // Fallback
    if (!item.roll_price) {
      const volPrice = item.pricing.find(p => p.price_type === 'NET') || item.pricing.find(p => p.class_of_trade === 'WS');
      if (volPrice) { item.roll_price = volPrice.unit_price; item.roll_cost = volPrice.unit_price; }
    }
    if (!item.cut_price) {
      const msrpPrice = item.pricing.find(p => p.price_type === 'MSR') || item.pricing.find(p => p.class_of_trade === 'RS');
      if (msrpPrice) { item.cut_price = msrpPrice.unit_price; item.cut_cost = msrpPrice.unit_price; }
    }

    if (item.cut_price && !item.roll_price) { item.roll_price = item.cut_price; item.roll_cost = item.cut_cost; }
    if (item.roll_price && !item.cut_price) { item.cut_price = item.roll_price; item.cut_cost = item.roll_cost; }

    // Roll width from MEA**WD (12ft, 15ft, 6ft)
    const widthMea = item.measurements.find(m => m.qualifier === 'WD');
    if (widthMea && widthMea.value) {
      const w = widthMea.value;
      const uom = (widthMea.unit_of_measure || '').toUpperCase();
      item.roll_width_ft = (uom === 'IN' || w > 24) ? w / 12 : w;
    }

    // Roll length from MEA**LN (125ft, 150ft, etc.)
    const lengthMea = item.measurements.find(m => m.qualifier === 'LN');
    if (lengthMea && lengthMea.value) {
      const l = lengthMea.value;
      const uom = (lengthMea.unit_of_measure || '').toUpperCase();
      item.roll_length_ft = (uom === 'IN') ? l / 12 : (uom === 'EZ') ? l : l;
    }

    // Shipping weight per SY from MEA**SW
    const swMea = item.measurements.find(m => m.qualifier === 'SW');
    if (swMea && swMea.value) {
      item.weight_per_sy = swMea.value;
    }

    // Roll area (sqft) = width_ft * length_ft — stored as pallet-level data (roll = shipping unit)
    if (item.roll_width_ft && item.roll_length_ft) {
      item.sqft_per_pallet = Math.round(item.roll_width_ft * item.roll_length_ft * 100) / 100;
      // Total roll weight = weight_per_SY * roll_area_SY
      if (item.weight_per_sy) {
        const rollAreaSY = item.sqft_per_pallet / 9;
        item.weight_per_pallet_lbs = Math.round(item.weight_per_sy * rollAreaSY * 100) / 100;
      }
    }

    // Roll min sqft from CTP*ST quantity field (qty is in SY, convert to sqft)
    if (stdPrice && stdPrice.quantity > 0) {
      const qtyUom = (stdPrice.unit_of_measure || '').toUpperCase();
      if (qtyUom === 'SY' || item.sell_by === 'sqyd') {
        item.roll_min_sqft = Math.round(stdPrice.quantity * 9 * 100) / 100;
      } else if (qtyUom === 'SF') {
        item.roll_min_sqft = stdPrice.quantity;
      } else {
        // Default: assume SY for broadloom
        item.roll_min_sqft = Math.round(stdPrice.quantity * 9 * 100) / 100;
      }
    }
    // Fallback: roll min from PO4 size_per_pack (LF * width)
    if (!item.roll_min_sqft && item.roll_width_ft && item.packaging && item.packaging.size_per_pack) {
      const uom = (item.packaging.unit_of_measure || '').toUpperCase();
      if (uom === 'LF' || uom === 'FT') {
        item.roll_min_sqft = item.roll_width_ft * item.packaging.size_per_pack;
      }
    }

    // Broadloom carpet: null out box fields, set freight class 55
    // Roll data goes to pallet-level fields (roll = shipping unit)
    if (item.material_class === 'CARIND') {
      item.sqft_per_box = null;
      item.weight_per_box_lbs = null;
      item.pieces_per_box = null;
      item.pieces_per_carton = null;
      item.cartons_per_pallet = null;
      item.freight_class = 55;
    }

    // Carpet tile: sold in boxes (sqft), not rolls
    if (item.material_class === 'CARTIL') {
      item.freight_class = 65;
      item.sell_by = 'sqft';
      // WD/LN for carpet tile are tile dimensions, not roll dimensions — clear roll fields
      item.roll_width_ft = null;
      item.roll_length_ft = null;
      // MEA**SU value is sqft per PIECE for carpet tile, not per box
      // sqft_per_box = sqft_per_piece * pieces_per_box
      const widthMea2 = item.measurements.find(m => m.qualifier === 'WD');
      const lengthMea2 = item.measurements.find(m => m.qualifier === 'LN');
      if (widthMea2 && lengthMea2 && item.pieces_per_carton) {
        const tileSqft = widthMea2.value * lengthMea2.value;
        item.sqft_per_box = Math.round(tileSqft * item.pieces_per_carton * 100) / 100;
      } else if (item.sqft_per_box && item.pieces_per_carton && item.sqft_per_box < item.pieces_per_carton) {
        // sqft_per_box looks like per-piece — multiply by pieces
        item.sqft_per_box = Math.round(item.sqft_per_box * item.pieces_per_carton * 100) / 100;
      }
      // Convert pricing from $/SY to $/SF for carpet tile
      if (item.cost) item.cost = Math.round(item.cost / 9 * 100) / 100;
      if (item.retail_price) item.retail_price = Math.round(item.retail_price / 9 * 100) / 100;
      if (item.cut_price) item.cut_price = Math.round(item.cut_price / 9 * 100) / 100;
      if (item.roll_price) item.roll_price = Math.round(item.roll_price / 9 * 100) / 100;
      if (item.cut_cost) item.cut_cost = Math.round(item.cut_cost / 9 * 100) / 100;
      if (item.roll_cost) item.roll_cost = Math.round(item.roll_cost / 9 * 100) / 100;
      // Clear roll min — carpet tile has no roll minimums
      item.roll_min_sqft = null;
      // Clear cut/roll pricing — carpet tile is box-priced, no cut vs roll distinction
      item.cut_price = null; item.cut_cost = null;
      item.roll_price = null; item.roll_cost = null;
    }
  }

  // --- Process SLN sub-lines ---
  for (const sl of item.sub_lines) {
    const colorPid73 = sl.descriptions.find(d => d.characteristic_code === '73');
    const codePid35 = sl.descriptions.find(d => d.characteristic_code === '35');
    sl.color = colorPid73 ? cleanAndTitle(colorPid73.description) : null;
    sl.color_code = codePid35 ? codePid35.description : null;
    sl.vendor_sku = sl.identifiers.sku || sl.identifiers.style_number || sl.identifiers.vendor_item_number || null;
    // Companion accessory SKU codes (PID*F*08 after SLN)
    sl.companions = sl.descriptions.filter(d => d.characteristic_code === '08').map(d => d.description);
  }

  // If no sub-lines exist, create a default one from the parent item
  if (item.sub_lines.length === 0) {
    item.sub_lines.push({
      sub_line_number: '00001',
      identifiers: item.identifiers,
      descriptions: [],
      color: item.color,
      color_code: null,
      vendor_sku: item.vendor_sku,
      companions: [],
    });
  }
}


// ---------------------------------------------------------------------------
// SFTP helpers
// ---------------------------------------------------------------------------

function getSftpConfig(source) {
  const cfg = source.config || {};
  return {
    host: cfg.sftp_host || process.env.SHAW_SFTP_HOST || DEFAULT_SFTP.host,
    port: parseInt(cfg.sftp_port || process.env.SHAW_SFTP_PORT || DEFAULT_SFTP.port, 10),
    username: cfg.sftp_user || process.env.SHAW_SFTP_USER || DEFAULT_SFTP.username,
    password: cfg.sftp_pass || process.env.SHAW_SFTP_PASS || DEFAULT_SFTP.password,
  };
}

/**
 * Scan remote directories for 832-like files.
 * Returns array of { name, size, modifyTime, remotePath }.
 */
async function findRemote832Files(sftp, log) {
  const allFiles = [];
  const unmatchedSample = [];

  for (const dir of REMOTE_DIRS) {
    try {
      const listing = await sftp.list(dir);
      const files = listing.filter(f => f.type === '-');
      const matching = files
        .filter(f => {
          const name = f.name.toLowerCase();
          return name.includes('832') || name.includes('catalog') || name.includes('pricelist')
            || name.includes('price_catalog') || name.endsWith('.edi') || name.endsWith('.x12')
            || name.endsWith('.dat') || name.endsWith('.txt');
        })
        .map(f => ({ ...f, dir, remotePath: `${dir}/${f.name}`.replace('//', '/') }));
      allFiles.push(...matching);
      // Collect unmatched files for debugging on empty results
      for (const f of files.filter(ff => !matching.some(m => m.name === ff.name)).slice(0, 5)) {
        unmatchedSample.push(`${dir}/${f.name} (${(f.size / 1024).toFixed(1)}KB)`);
      }
    } catch {
      // Directory doesn't exist or no access — skip
    }
  }

  // Log unmatched files if nothing was found (helps debug naming conventions)
  if (allFiles.length === 0 && unmatchedSample.length > 0 && log) {
    for (const entry of unmatchedSample) log(`  [unmatched file] ${entry}`);
  }

  // Sort newest first
  allFiles.sort((a, b) => b.modifyTime - a.modifyTime);
  return allFiles;
}


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeInternalSku(vendorSku, productName) {
  if (vendorSku) {
    return vendorSku.toUpperCase().startsWith('SHAW-') ? vendorSku : `SHAW-${vendorSku}`;
  }
  const slug = (productName || 'UNKNOWN').toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 30);
  return `SHAW-${slug}`;
}


// ---------------------------------------------------------------------------
// Main run() — called by the scraper framework
// ---------------------------------------------------------------------------

export async function run(pool, job, source) {
  const sftpConfig = getSftpConfig(source);
  const processedFiles = (source.config || {}).processed_files || [];

  await appendLog(pool, job.id, `Connecting to ${sftpConfig.host}:${sftpConfig.port} as ${sftpConfig.username}...`);

  const sftp = new SftpClient();
  let localPath = null;
  let downloadedFileName = null;

  try {
    // ── Step 1: Connect and find files ──
    await sftp.connect(sftpConfig);
    await appendLog(pool, job.id, 'SFTP connected. Scanning for 832 files...');

    const logLine = (msg) => appendLog(pool, job.id, msg);
    const remoteFiles = await findRemote832Files(sftp, logLine);
    await appendLog(pool, job.id, `Found ${remoteFiles.length} 832 candidate file(s)`);

    if (remoteFiles.length === 0) {
      await appendLog(pool, job.id, 'No 832 files found on remote server. Nothing to import.');
      return;
    }

    // Log all found files
    for (const f of remoteFiles) {
      const sizeKb = (f.size / 1024).toFixed(1);
      const mod = new Date(f.modifyTime).toISOString().slice(0, 19);
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
    localPath = `/tmp/shaw_832_${Date.now()}.edi`;
    await sftp.fastGet(target.remotePath, localPath);
    await appendLog(pool, job.id, `Downloaded to ${localPath}`);

  } catch (err) {
    await addJobError(pool, job.id, `SFTP error: ${err.message}`);
    await appendLog(pool, job.id, `SFTP connection failed: ${err.message}`);
    throw err;
  } finally {
    await sftp.end().catch(() => {});
  }

  // ── Step 3: Parse EDI ──
  await appendLog(pool, job.id, 'Parsing EDI 832...');
  const raw = fs.readFileSync(localPath, 'utf-8');
  const catalog = parse832(raw);
  await appendLog(pool, job.id, `Parsed ${catalog.items.length} products with ${catalog.summary.total_skus} color SKUs from ${catalog.summary.segment_count} segments`);

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
    const lower = categoryText.toLowerCase().trim();
    // Direct slug match (category already resolved to a slug)
    if (catCache[lower]) return catCache[lower];
    // Map through CATEGORY_MAP
    const slug = CATEGORY_MAP[lower];
    return slug ? (catCache[slug] || null) : null;
  };

  // ── Step 5: Import — each LIN is a product, each SLN is a SKU ──
  let productsCreated = 0, productsUpdated = 0, skusCreated = 0, skusUpdated = 0;
  let pricingUpserted = 0, packagingUpserted = 0, attrsUpserted = 0;

  // Accessory detection pattern
  const accPattern = /transitions|moldings|installation|sundries|adhesive|sealant|underlayment|trim|molding|transition|reducer|stairnose|t-bar|quarter.round|threshold|seam|sealer|l.?shape|u.?shape|q.?shape|bullnose|cleaner/i;

  // Track all imported internal_skus for discontinuation detection
  const importedSkus = new Set();

  for (const item of catalog.items) {
    if (!item.vendor_sku && !item.product_name) continue;

    const categoryId = resolveCatId(item.category);

    // Determine if this is an accessory product
    const isAccessory = accPattern.test(item.category || '')
      || ['WOOMIS', 'VINMIS', 'CERMIS', 'ACC'].includes(item.material_class);

    // Build product descriptions from EDI data
    const descParts = [];
    const longParts = [];

    // Fiber / material content (PID*F*37, e.g. "PILE 100 NYLON")
    const fiberPid = item.descriptions.find(d => d.characteristic_code === '37');
    const fiberRaw = fiberPid ? fiberPid.description : null;
    let fiberText = null;
    if (fiberRaw) {
      // Parse "PILE 100 NYLON" → "100% Nylon"
      const fiberMatch = fiberRaw.match(/(\d+)\s+(.+)/);
      if (fiberMatch) {
        const pct = fiberMatch[1];
        const fiber = fiberMatch[2].replace(/^PILE\s*/i, '');
        fiberText = `${pct}% ${fiber.charAt(0).toUpperCase() + fiber.slice(1).toLowerCase()}`;
      } else {
        fiberText = fiberRaw;
      }
    }

    // Construction type from subcategory (PID*F*12, e.g. "TEXTURE BCF")
    const construction = item.subcategory
      ? item.subcategory.split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ')
      : null;

    // Roll width for carpet
    const isCarpet = item.material_class === 'CARIND' || item.material_class === 'CARTIL';
    if (isCarpet) {
      if (construction) descParts.push(construction);
      if (fiberText) descParts.push(fiberText);
      if (item.roll_width_ft) descParts.push(`${item.roll_width_ft}' Wide`);
      if (item.roll_length_ft) descParts.push(`${item.roll_length_ft}' Roll`);

      if (construction) longParts.push(`${construction} ${item.material_class === 'CARTIL' ? 'carpet tile' : 'broadloom carpet'}.`);
      if (fiberText) longParts.push(`${fiberText} fiber.`);
      if (item.roll_width_ft && item.roll_length_ft) {
        longParts.push(`Available in ${item.roll_width_ft}' x ${item.roll_length_ft}' rolls (${item.sqft_per_pallet || (item.roll_width_ft * item.roll_length_ft)} sq ft per roll).`);
      } else if (item.roll_width_ft) {
        longParts.push(`Available in ${item.roll_width_ft}-foot wide rolls.`);
      }
      if (item.weight_per_sy) longParts.push(`Weight: ${item.weight_per_sy} lbs/sq yd.`);
      if (item.collection) longParts.push(`Part of the ${item.collection.split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ')} collection.`);
    } else if (item.material_class === 'VINTIL' || item.material_class === 'WOO' || item.material_class === 'CERFLO') {
      // Hard surface (LVT/SPC/WPC, hardwood, tile)
      if (construction) descParts.push(construction);
      if (item.sqft_per_box) descParts.push(`${item.sqft_per_box} SF/Carton`);
      const widthMea = item.measurements.find(m => m.qualifier === 'WD');
      const lengthMea = item.measurements.find(m => m.qualifier === 'LN');
      if (widthMea && lengthMea) {
        const wIn = widthMea.value * (widthMea.unit_of_measure === 'EZ' ? 12 : 1);
        const lIn = lengthMea.value * (lengthMea.unit_of_measure === 'EZ' ? 12 : 1);
        descParts.push(`${wIn}" x ${lIn}"`);
      }
      if (construction) longParts.push(`${construction} flooring.`);
      if (item.sqft_per_box) longParts.push(`${item.sqft_per_box} sq ft per carton.`);
      if (item.collection) longParts.push(`Part of the ${item.collection.split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ')} collection.`);
    } else {
      // Accessories, trims, sundries, underlayment
      const subcat = item.subcategory ? item.subcategory.split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ') : null;
      const matClass = item.material_class || '';
      // Friendly category label
      const typeLabel = /ADHESIVE/i.test(item.subcategory) ? 'Flooring adhesive'
        : /UNDERLAYMENT/i.test(item.subcategory) ? 'Underlayment'
        : /HW TRIMS/i.test(item.subcategory) ? 'Hardwood transition molding'
        : /TILE TRIMS/i.test(item.subcategory) ? 'Tile trim profile'
        : /TRIMS/i.test(item.subcategory || '') ? 'Transition trim'
        : /RESILIENT SUNDRIES/i.test(item.subcategory) ? 'Resilient flooring sundry'
        : /SUNDRIES|MISC/i.test(item.subcategory || '') ? 'Installation sundry'
        : subcat || 'Flooring accessory';
      if (subcat) descParts.push(subcat);
      // Parse size for trims (e.g. "0.083x8.208EZ" → dimensions)
      const widthMea = item.measurements.find(m => m.qualifier === 'WD');
      const lengthMea = item.measurements.find(m => m.qualifier === 'LN');
      if (widthMea && lengthMea && widthMea.value > 0 && lengthMea.value > 0) {
        const wIn = (widthMea.value * (widthMea.unit_of_measure === 'EZ' ? 12 : 1)).toFixed(1).replace(/\.0$/, '');
        const lIn = (lengthMea.value * (lengthMea.unit_of_measure === 'EZ' ? 12 : 1)).toFixed(1).replace(/\.0$/, '');
        descParts.push(`${wIn}" x ${lIn}"`);
      }
      // Brand from price_list
      const brandLine = item.price_list ? item.price_list.replace(/\s+\d+$/, '') : null;
      longParts.push(`${typeLabel} by Shaw Floors.`);
      if (brandLine) longParts.push(`${brandLine.split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ')} line.`);
      if (widthMea && lengthMea && widthMea.value > 0 && lengthMea.value > 0) {
        const wIn = (widthMea.value * (widthMea.unit_of_measure === 'EZ' ? 12 : 1)).toFixed(1).replace(/\.0$/, '');
        const lIn = (lengthMea.value * (lengthMea.unit_of_measure === 'EZ' ? 12 : 1)).toFixed(1).replace(/\.0$/, '');
        longParts.push(`Dimensions: ${wIn}" x ${lIn}".`);
      }
    }

    const descShort = descParts.length > 0 ? descParts.join(' | ') : (item.subcategory || null);
    const descLong = longParts.length > 0 ? longParts.join(' ') : null;

    // Migrate existing empty-collection product to new collection if applicable
    const productName = item.product_name || (looksLikeSkuCode(item.vendor_sku) ? null : cleanAndTitle(item.vendor_sku)) || 'Unknown';
    const productCollection = item.collection || '';
    if (productCollection) {
      await pool.query(
        `UPDATE products SET collection = $1, updated_at = NOW()
         WHERE vendor_id = $2 AND name = $3 AND collection = ''
         AND NOT EXISTS (
           SELECT 1 FROM products p2
           WHERE p2.vendor_id = $2 AND p2.name = $3 AND p2.collection = $1
         )`,
        [productCollection, vendorId, productName]
      );
    }

    const productRow = await upsertProduct(pool, {
      vendor_id: vendorId,
      name: productName,
      collection: productCollection,
      category_id: categoryId,
      description_short: descShort,
      description_long: descLong,
    });
    const productId = productRow.id;
    if (productRow.is_new) productsCreated++; else productsUpdated++;

    // Force-update category from EDI (base upsertProduct uses COALESCE which won't overwrite)
    if (categoryId) {
      await pool.query('UPDATE products SET category_id = $1 WHERE id = $2 AND category_id IS DISTINCT FROM $1', [categoryId, productId]);
    }

    // Create one SKU per SLN sub-line
    for (const sl of item.sub_lines) {
      const rawSlVendorSku = sl.vendor_sku || item.vendor_sku;
      // Skip SKU rows where vendor_sku is actually a product/style name (no digits)
      // These are duplicates — the real SKU code row will also be imported
      if (rawSlVendorSku && !looksLikeSkuCode(rawSlVendorSku) && item.sub_lines.length > 1) continue;
      const slVendorSku = rawSlVendorSku;
      const internalSku = makeInternalSku(slVendorSku, item.product_name);
      const sellBy = item.sell_by || 'sqft';
      const variantType = isAccessory ? 'accessory' : null;
      const rawVariant = sl.color || item.color || item.product_name || null;
      const variantName = rawVariant ? cleanAndTitle(rawVariant) : null;

      importedSkus.add(internalSku);

      const skuRow = await upsertSku(pool, {
        product_id: productId,
        vendor_sku: slVendorSku,
        internal_sku: internalSku,
        variant_name: variantName,
        sell_by: sellBy,
        variant_type: variantType,
      });
      const skuId = skuRow.id;
      if (skuRow.is_new) skusCreated++; else skusUpdated++;

      // --- Pricing (shared across all sub-lines from parent LIN) ---
      if (item.cost || item.retail_price) {
        // Carpet: keep native $/SY pricing, price_basis = 'per_sqyd'
        // Hard surface: keep native $/SF pricing, price_basis = 'per_sqft'
        // Accessories: per_unit
        const priceBasis = sellBy === 'sqyd' ? 'per_sqyd'
          : sellBy === 'sqft' ? 'per_sqft' : 'per_unit';

        const markup = (v) => v ? Math.round(v * 2 * 100) / 100 : null;

        const cost = item.cost || 0;
        const retail = item.retail_price && item.retail_price !== item.cost
          ? item.retail_price
          : markup(cost);

        await upsertPricing(pool, skuId, {
          cost,
          retail_price: retail,
          price_basis: priceBasis,
          // Cut = CT (contract, higher per-unit price), Roll = ST (standard, volume/roll price)
          cut_price: markup(item.cut_cost) || null,
          roll_price: markup(item.roll_cost) || null,
          cut_cost: item.cut_cost || null,
          roll_cost: item.roll_cost || null,
          roll_min_sqft: item.roll_min_sqft || null,
          map_price: item.map_price || null,
        });
        pricingUpserted++;
      }

      // --- Packaging (shared across all sub-lines from parent LIN) ---
      const isBroadloom = item.material_class === 'CARIND';
      // Shaw EDI packs_per_pallet values are container/truckload quantities, not actual pallet counts
      // (produces 30,000-50,000 lb calculated pallet weights). Don't store for box products.
      const hasPackaging = item.sqft_per_box || item.pieces_per_box || item.weight_per_box_lbs
        || item.roll_width_ft || item.roll_length_ft || item.shipping_weight
        || item.freight_class || item.sqft_per_pallet || item.weight_per_pallet_lbs;
      if (hasPackaging) {
        // For broadloom: sqft_per_pallet = roll area, weight_per_pallet = roll weight
        const sqftPerPallet = isBroadloom ? (item.sqft_per_pallet || null) : null;
        const weightPerPallet = isBroadloom ? (item.weight_per_pallet_lbs || null) : null;
        await upsertPackaging(pool, skuId, {
          sqft_per_box: item.sqft_per_box || null,
          pieces_per_box: isBroadloom ? null : (item.pieces_per_box || item.pieces_per_carton || null),
          weight_per_box_lbs: isBroadloom ? null : (() => {
            const rawWt = item.weight_per_box_lbs || item.shipping_weight || null;
            // Shaw EDI reports weight per sqft for box products — multiply by sqft_per_box
            if (rawWt && item.sqft_per_box && rawWt < 10) return Math.round(rawWt * item.sqft_per_box * 10) / 10;
            return rawWt;
          })(),
          boxes_per_pallet: null,
          sqft_per_pallet: sqftPerPallet,
          weight_per_pallet_lbs: weightPerPallet,
          roll_width_ft: item.roll_width_ft || null,
          roll_length_ft: item.roll_length_ft || null,
          freight_class: item.freight_class || null,
        });
        packagingUpserted++;
      }

      // --- Attributes ---
      // Color from sub-line
      if (sl.color) { await upsertSkuAttribute(pool, skuId, 'color', sl.color); attrsUpserted++; }
      if (sl.color_code) { await upsertSkuAttribute(pool, skuId, 'color_code', sl.color_code); attrsUpserted++; }

      // Style code (LIN-level identifier) from parent
      if (item.vendor_sku) { await upsertSkuAttribute(pool, skuId, 'style_code', item.vendor_sku); attrsUpserted++; }

      // UPC from parent
      if (item.upc) { await upsertSkuAttribute(pool, skuId, 'upc', item.upc); attrsUpserted++; }

      // Material class and subcategory
      if (item.material_class) { await upsertSkuAttribute(pool, skuId, 'material_class', item.material_class); attrsUpserted++; }
      if (item.subcategory) { await upsertSkuAttribute(pool, skuId, 'subcategory', cleanConstruction(item.subcategory)); attrsUpserted++; }
      if (item.price_list) { await upsertSkuAttribute(pool, skuId, 'price_list', cleanAndTitle(item.price_list)); attrsUpserted++; }

      // Application type derived from EDI price list (CTP qualifier 19)
      if (item.price_list) {
        const pl = item.price_list.toUpperCase();
        const appMap = {
          'PHILADELPHIA CONTRACT': 'Commercial',
          'MAINSTREET COMMERCIAL': 'Commercial',
          'PHILADELPHIA MAINSTREET': 'Commercial / Residential',
          'SHAW RESIL T P': 'Residential / Commercial',
          'SHAW RESIL ROLL': 'Residential / Commercial',
          'SHAW FLOORS RETAIL': 'Residential',
          'SHAW FLOORS VALUE': 'Residential',
          'USF RESIDENTIAL': 'Residential',
          'BUILDER HARD SURFACE': 'Residential',
          'TUFTEX': 'Residential',
          'ANDERSON WOOD': 'Residential',
          'SHAW WOOD': 'Residential',
          'SHAW TILE STONE': 'Residential',
        };
        const appType = Object.entries(appMap).find(([k]) => pl.includes(k));
        if (appType) { await upsertSkuAttribute(pool, skuId, 'application', appType[1]); attrsUpserted++; }
      }

      // Fiber / material from PID*F*37
      const materialPid = item.descriptions.find(d => d.characteristic_code === '37');
      if (materialPid) { await upsertSkuAttribute(pool, skuId, 'material', cleanFiber(materialPid.description)); attrsUpserted++; }

      // Finish, style, pattern from LIN-level PIDs
      const finishPid = item.descriptions.find(d => d.characteristic_label === 'finish');
      if (finishPid) { await upsertSkuAttribute(pool, skuId, 'finish', cleanAndTitle(finishPid.description)); attrsUpserted++; }

      const stylePid = item.descriptions.find(d => d.characteristic_label === 'style');
      if (stylePid) { await upsertSkuAttribute(pool, skuId, 'style', cleanAndTitle(stylePid.description)); attrsUpserted++; }

      const patternPid = item.descriptions.find(d => d.characteristic_label === 'pattern');
      if (patternPid) { await upsertSkuAttribute(pool, skuId, 'pattern', cleanAndTitle(patternPid.description)); attrsUpserted++; }

      // Measurements as attributes
      const thickMea = item.measurements.find(m => m.qualifier === 'TH');
      if (thickMea) { await upsertSkuAttribute(pool, skuId, 'thickness', `${thickMea.value}${thickMea.unit_of_measure || ''}`); attrsUpserted++; }

      const widthMea = item.measurements.find(m => m.qualifier === 'WD');
      const lengthMea = item.measurements.find(m => m.qualifier === 'LN');
      // Convert EZ (feet) to inches for display
      const toInches = (m) => {
        if (!m || !m.value || m.value <= 0) return 0;
        return m.unit_of_measure === 'EZ' ? m.value * 12 : m.value;
      };
      const fmtIn = (v) => { const r = Math.round(v * 100) / 100; return r % 1 === 0 ? r.toFixed(0) : r.toFixed(r % 0.1 === 0 ? 1 : 2).replace(/0+$/, ''); };
      if (widthMea && lengthMea) {
        const wIn = toInches(widthMea);
        const lIn = toInches(lengthMea);
        // Carpet uses FT directly (12x150FT); hard surface converts to inches
        if (isCarpet) {
          await upsertSkuAttribute(pool, skuId, 'size', `${widthMea.value}x${lengthMea.value}${lengthMea.unit_of_measure === 'EZ' ? 'FT' : (lengthMea.unit_of_measure || '')}`);
        } else if (wIn > 0 && lIn > 0) {
          await upsertSkuAttribute(pool, skuId, 'size', `${fmtIn(wIn)}" x ${fmtIn(lIn)}"`);
        } else if (wIn > 0) {
          await upsertSkuAttribute(pool, skuId, 'size', `${fmtIn(wIn)}" Wide`);
        }
        attrsUpserted++;
      } else if (widthMea) {
        const wIn = toInches(widthMea);
        if (wIn > 0) {
          await upsertSkuAttribute(pool, skuId, 'width', `${fmtIn(wIn)}"`);
        }
        attrsUpserted++;
      }

      // Wear layer
      const wearMea = item.measurements.find(m => m.qualifier === 'WL');
      if (wearMea) { await upsertSkuAttribute(pool, skuId, 'wear_layer', `${wearMea.value}${wearMea.unit_of_measure || 'mil'}`); attrsUpserted++; }

      // Weight
      const weightMea = item.measurements.find(m => m.qualifier === 'WT');
      if (weightMea) { await upsertSkuAttribute(pool, skuId, 'weight', `${weightMea.value}${weightMea.unit_of_measure || 'LB'}`); attrsUpserted++; }

      // Companion accessory SKU cross-references
      if (sl.companions.length > 0) {
        await upsertSkuAttribute(pool, skuId, 'companion_skus', sl.companions.join(','));
        attrsUpserted++;
      }

      // Carpet-specific attributes
      if (item.material_class === 'CARIND' || item.material_class === 'CARTIL') {
        if (item.roll_width_ft) { await upsertSkuAttribute(pool, skuId, 'roll_width', `${item.roll_width_ft}ft`); attrsUpserted++; }
        if (item.roll_length_ft) { await upsertSkuAttribute(pool, skuId, 'roll_length', `${item.roll_length_ft}ft`); attrsUpserted++; }
        if (item.weight_per_sy) { await upsertSkuAttribute(pool, skuId, 'weight_per_sqyd', `${item.weight_per_sy} lbs`); attrsUpserted++; }
        if (item.collection) { await upsertSkuAttribute(pool, skuId, 'collection', item.collection); attrsUpserted++; }
        // Construction type from PID*F*12 — cleaned
        if (item.subcategory) { await upsertSkuAttribute(pool, skuId, 'construction', cleanConstruction(item.subcategory)); attrsUpserted++; }
        // Fiber content from PID*F*37 — cleaned: "PILE 100 NYLON" → "100% Nylon"
        const fiberPid2 = item.descriptions.find(d => d.characteristic_code === '37');
        if (fiberPid2) { await upsertSkuAttribute(pool, skuId, 'fiber', cleanFiber(fiberPid2.description)); attrsUpserted++; }
      }
    }
  }

  // ── Step 5b: Discontinuation detection ──
  if (importedSkus.size >= 10) {
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
