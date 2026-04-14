#!/usr/bin/env node
/**
 * Engineered Floors — EDI 832 (Price/Sales Catalog) Importer
 *
 * Connects via FTP to ftp.engfloors.org, downloads the latest 832 file,
 * parses the EDI segments, and outputs clean JSON for database mapping.
 *
 * Usage:
 *   node backend/scripts/import-engfloors-832.cjs                  # FTP download + parse
 *   node backend/scripts/import-engfloors-832.cjs --file /tmp/832  # Parse local file only
 *   node backend/scripts/import-engfloors-832.cjs --list           # List remote directory
 *   node backend/scripts/import-engfloors-832.cjs --dry-run        # Parse only, no DB writes
 *
 * Output: /tmp/engfloors_832_catalog.json
 */

const { Client: FtpClient } = require('basic-ftp');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

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
const VENDOR_NAME = 'Engineered Floors';
const VENDOR_CODE = 'EF';
const VENDOR_WEBSITE = 'https://www.engineeredfloors.com';

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
  'carpet':              'carpet',
  'carpet tile':         'carpet-tile',
  'broadloom':           'carpet',
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
// Text Cleaning — Shaw-quality title-casing and EF abbreviation expansion
// ---------------------------------------------------------------------------

// Acronyms to keep uppercase
const KEEP_UPPER = new Set(['SPC','WPC','LVP','LVT','PVC','BCF','PET','HD','II','III','IV','EF']);

// Lowercase articles/prepositions (except first word)
const KEEP_LOWER = new Set(['a','an','the','and','or','of','in','at','to','for','by','on','with']);

// EF-specific abbreviation expansions
const EF_ABBREV_MAP = {
  'FLSHSTNS': 'Flush Stairnose', 'FLSHSTN': 'Flush Stairnose',
  'FLUSHSTR': 'Flush Stairnose',
  'OVRLPSTN': 'Overlap Stairnose', 'OVRLP': 'Overlap',
  '2STRTRDS': '2-Stair Treads', '2STRTR': '2-Stair Treads',
  'QTR': 'Quarter', 'TRHD': 'Threshold',
  'STRNSE': 'Stairnose', 'STRNOS': 'Stairnose',
  'TMLD': 'T-Mold', 'TMOLD': 'T-Mold', 'TMOLDING': 'T-Mold',
  'TPSTRTRD': 'Stair Tread',
  'USSTRNSA': 'Universal Stairnose',
  'RDCR': 'Reducer', 'ENDCP': 'End Cap',
  'ADH': 'Adhesive', 'UNDERLMT': 'Underlayment',
};

/**
 * Convert ALL-CAPS text → Title Case, respecting acronyms and articles.
 */
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

/**
 * Expand common EDI text quirks: fractions, apostrophes, abbreviations.
 */
function cleanEdiText(text) {
  if (!text) return '';
  let t = text;
  // Expand fractions: 1/2 → ½, 3/4 → ¾
  t = t.replace(/\b1\/2\b/g, '½').replace(/\b1\/4\b/g, '¼').replace(/\b3\/4\b/g, '¾');
  // Restore apostrophes in common patterns
  t = t.replace(/\bDONT\b/gi, "Don't").replace(/\bWONT\b/gi, "Won't")
    .replace(/\bCANT\b/gi, "Can't").replace(/\bISNT\b/gi, "Isn't");
  // Expand EF abbreviations
  for (const [abbr, full] of Object.entries(EF_ABBREV_MAP)) {
    t = t.replace(new RegExp('\\b' + abbr + '\\b', 'gi'), full);
  }
  return t;
}

/**
 * Clean fiber/material string: "PILE 100 NYLON" → "100% Nylon"
 */
function cleanFiber(raw) {
  if (!raw) return '';
  let f = raw.trim();
  // Strip leading "PILE" or "FACE" labels
  f = f.replace(/^(?:PILE|FACE)\s*/i, '');
  // Convert "100 NYLON" → "100% Nylon"
  f = f.replace(/(\d+)\s+([A-Za-z]+)/g, (_, pct, mat) => `${pct}% ${titleCaseEdi(mat)}`);
  // If no percentage, just title-case
  if (!/\d/.test(f)) f = titleCaseEdi(f);
  return f;
}

/**
 * Combined: cleanEdiText + titleCaseEdi
 */
function cleanAndTitle(raw) {
  if (!raw) return null;
  return titleCaseEdi(cleanEdiText(raw.trim()));
}

// ---------------------------------------------------------------------------
// FTP credentials — swap to process.env for production
// ---------------------------------------------------------------------------
const FTP_CONFIG = {
  host: process.env.ENGFLOORS_FTP_HOST || process.env.ENGFLOORS_SFTP_HOST || 'ftp.engfloors.org',
  port: parseInt(process.env.ENGFLOORS_FTP_PORT || process.env.ENGFLOORS_SFTP_PORT || '21', 10),
  user: process.env.ENGFLOORS_FTP_USER || process.env.ENGFLOORS_SFTP_USER || '18110',
  password: process.env.ENGFLOORS_FTP_PASS || process.env.ENGFLOORS_SFTP_PASS || 'wSQiFrDM',
};

// Directories to search on the remote server
// This server runs OpenAS2 — check its data paths + standard EDI paths
const REMOTE_DIRS = [
  // OpenAS2 standard data dirs
  '/opt/OpenAS2/data', '/opt/OpenAS2/data/toAny',
  '/opt/OpenAS2/data/fromAny', '/opt/OpenAS2',
  // fcB2B standard
  '/outbound', '/inbound', '/out', '/in', '/832',
  '/Outbound', '/Inbound', '/OUT', '/IN',
  // Common EDI paths
  '/data', '/data/outbound', '/data/inbound',
  '/edi', '/edi/outbound', '/edi/inbound',
  '/export', '/import',
  // Var paths
  '/var/data', '/var/edi', '/var/spool',
  '/opt', '/tmp',
  // User home paths
  '/home/18110', '/sftpusers/18110', '/sftpusers/chroot',
  '/sftpusers/chroot/CSffolder',
  '/home/rack', '/home/rack/data',
  // Root last
  '/',
];

const OUTPUT_PATH = '/tmp/engfloors_832_catalog.json';

// ---------------------------------------------------------------------------
// EDI 832 Parser
// ---------------------------------------------------------------------------

/**
 * Split raw EDI text into segments.
 * Handles both ~ terminated and newline-terminated variants.
 * Some files use ~ only in the ISA envelope but newlines elsewhere —
 * detect this by comparing ~ count to line count.
 */
function tokenizeSegments(raw) {
  // Normalise line endings
  let text = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // Count tildes vs newlines to detect true segment terminator
  const tildeCount = (text.match(/~/g) || []).length;
  const lineCount = (text.match(/\n/g) || []).length;

  let segments;
  if (tildeCount > 10 && tildeCount >= lineCount * 0.5) {
    // ~ is the real segment terminator (standard EDI)
    segments = text.split('~').map(s => s.trim()).filter(Boolean);
  } else {
    // Newline-terminated (or ~ only in ISA envelope) — strip trailing ~
    segments = text.split('\n').map(s => s.replace(/~\s*$/, '').trim()).filter(Boolean);
  }
  return segments;
}

/**
 * Parse a single segment string into { id, elements[] }.
 * Element separator is * (asterisk). Sub-element separator is : or >
 */
function parseSegment(segStr) {
  const elements = segStr.split('*');
  return {
    id: elements[0],
    el: elements,           // el[0] = segment ID, el[1] = first data element
  };
}

// Qualifier code → human-readable label for LIN identifiers
const LIN_QUALIFIERS = {
  UP: 'upc',
  VN: 'vendor_item_number',
  SK: 'sku',
  MG: 'manufacturer_group',
  BP: 'buyer_part_number',
  IN: 'buyer_item_number',
  MN: 'model_number',
  GN: 'generic_name',
  UA: 'upc_case_code',
  CB: 'catalog_number',
  FS: 'standard_number',
  EC: 'ean',
  EN: 'ean',
  UK: 'upc_shipping',
  PI: 'purchaser_item',
  PN: 'part_number',
  VA: 'vendor_alpha',
  MF: 'manufacturer_brand',   // EF brand lines: "Dream Weaver", "Pentz", etc.
  ST: 'style_number',         // Style/pattern code
  BK: 'book_code',            // Book/collection code
  SZ: 'size_code',            // Size identifier
  UX: 'upc_extended',         // Extended UPC
  GS: 'catalog_number_gs',    // General specification
};

// Qualifier code → human-readable label for CTP class of trade
const CTP_CLASS = {
  WS: 'wholesale',
  RS: 'retail',
  CT: 'contractor',
  DE: 'dealer',
  DI: 'distributor',
  ED: 'education',
  GP: 'government',
};

// Qualifier code → human-readable label for CTP price type
const CTP_TYPE = {
  RES: 'resale',
  NET: 'net',
  MSR: 'msrp',
  UCP: 'unit_cost',
  PRP: 'promotional',
  CON: 'contract',
  CUP: 'confirmed',
  DIS: 'discount',
  INV: 'invoice',
  MAP: 'map',
  QUO: 'quoted',
  STA: 'standard',
  CAT: 'catalog',
  ALT: 'alternate',
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

// MEA qualifier codes
const MEA_CODES = {
  TH: 'thickness',
  WD: 'width',
  LN: 'length',
  WT: 'weight',
  WL: 'wear_layer',
  HT: 'height',
  SQ: 'area',
};

/**
 * Parse LIN segment into identifier pairs.
 * LIN*seq*qual1*id1*qual2*id2*...
 */
function parseLIN(seg) {
  const result = {
    line_number: seg.el[1] || null,
    identifiers: {},
  };
  // Walk qualifier/value pairs starting at el[2]
  for (let i = 2; i < seg.el.length - 1; i += 2) {
    const qual = seg.el[i];
    const val = seg.el[i + 1];
    if (qual && val) {
      const key = LIN_QUALIFIERS[qual] || qual.toLowerCase();
      result.identifiers[key] = val;
    }
  }
  return result;
}

/**
 * Parse PO4 — item physical details / packaging.
 * PO4*pack*size*uom*pkg_code*wt_qual*weight*wt_uom*vol*vol_uom*len*wid*ht*dim_uom*inner_pcs*...*outer_qty*outer_pkg
 */
function parsePO4(seg) {
  return {
    pack: seg.el[1] || null,
    size_per_pack: seg.el[2] ? parseFloat(seg.el[2]) : null,
    unit_of_measure: seg.el[3] || null,
    packaging_code: seg.el[4] || null,
    weight_qualifier: seg.el[5] || null,
    gross_weight: seg.el[6] ? parseFloat(seg.el[6]) : null,
    weight_uom: seg.el[7] || null,
    gross_volume: seg.el[8] ? parseFloat(seg.el[8]) : null,
    volume_uom: seg.el[9] || null,
    length: seg.el[10] ? parseFloat(seg.el[10]) : null,
    width: seg.el[11] ? parseFloat(seg.el[11]) : null,
    height: seg.el[12] ? parseFloat(seg.el[12]) : null,
    dimension_uom: seg.el[13] || null,
    pieces_per_pack: seg.el[14] ? parseInt(seg.el[14], 10) : null,
    surface_layer: seg.el[15] || null,
    assigned_id: seg.el[16] || null,
    packs_per_pallet: seg.el[17] ? parseInt(seg.el[17], 10) : null,
    outer_packaging: seg.el[18] || null,
  };
}

/**
 * Parse CTP — pricing.
 * CTP*class*type*price*qty*uom*mult_qual*multiplier*amount*basis*conditions*min_qty
 */
function parseCTP(seg) {
  return {
    class_of_trade: seg.el[1] || null,
    class_label: CTP_CLASS[seg.el[1]] || seg.el[1] || null,
    price_type: seg.el[2] || null,
    price_label: CTP_TYPE[seg.el[2]] || seg.el[2] || null,
    unit_price: seg.el[3] ? parseFloat(seg.el[3]) : null,
    quantity: seg.el[4] ? parseFloat(seg.el[4]) : null,
    unit_of_measure: seg.el[5] || null,
    multiplier_qualifier: seg.el[6] || null,
    multiplier: seg.el[7] ? parseFloat(seg.el[7]) : null,
    monetary_amount: seg.el[8] ? parseFloat(seg.el[8]) : null,
    basis_code: seg.el[9] || null,
    conditions: seg.el[10] || null,
    min_quantity: seg.el[11] ? parseFloat(seg.el[11]) : null,
  };
}

/**
 * Parse PID — product description.
 * PID*type*char_code*agency*prod_code*description*surface*source*yesno*lang
 */
function parsePID(seg) {
  return {
    description_type: seg.el[1] || null,   // F=free-form, S=structured
    characteristic_code: seg.el[2] || null,
    characteristic_label: PID_CODES[seg.el[2]] || seg.el[2] || null,
    agency: seg.el[3] || null,
    product_code: seg.el[4] || null,
    description: seg.el[5] || null,
    language: seg.el[9] || null,
  };
}

/**
 * Parse MEA — measurements.
 * MEA*ref*qualifier*value*uom
 */
function parseMEA(seg) {
  return {
    reference: seg.el[1] || null,
    qualifier: seg.el[2] || null,
    qualifier_label: MEA_CODES[seg.el[2]] || seg.el[2] || null,
    value: seg.el[3] ? parseFloat(seg.el[3]) : null,
    unit_of_measure: seg.el[4] || null,
  };
}

/**
 * Parse CTB — restrictions/conditions.
 * CTB*qualifier*description*quantity
 */
function parseCTB(seg) {
  return {
    qualifier: seg.el[1] || null,
    description: seg.el[2] || null,
    quantity: seg.el[3] ? parseFloat(seg.el[3]) : null,
  };
}

/**
 * Parse SLN (Sub-Line Item) segment — individual SKU variants within a LIN group.
 * SLN*sub_line*config_seq*relationship*qty*uom*price*basis*id_code*qual1*id1*...
 */
function parseSLN(seg) {
  const result = {
    sub_line_number: seg.el[1] || null,
    relationship_code: seg.el[3] || null,
    identifiers: {},
  };
  // Walk qualifier/value pairs starting at el[9] (same layout as LIN)
  for (let i = 9; i < seg.el.length - 1; i += 2) {
    const qual = seg.el[i];
    const val = seg.el[i + 1];
    if (qual && val) {
      const key = LIN_QUALIFIERS[qual] || qual.toLowerCase();
      result.identifiers[key] = val;
    }
  }
  return result;
}

/**
 * Merge product-level context (from LIN) into an SLN sub-item.
 * SLN-specific data takes priority over product-level defaults.
 */
function mergeProductContext(item, productCtx) {
  if (!productCtx) return;
  // Identifiers: product-level as defaults, SLN overrides
  for (const [k, v] of Object.entries(productCtx.identifiers)) {
    if (!item.identifiers[k]) item.identifiers[k] = v;
  }
  // Descriptions: product-level first, then SLN-specific
  item.descriptions = [...productCtx.descriptions, ...item.descriptions];
  // Packaging: inherit from product if SLN doesn't have its own
  if (!item.packaging && productCtx.packaging) item.packaging = productCtx.packaging;
  // Pricing: inherit from product (pricing is always product-level in this format)
  if (item.pricing.length === 0) item.pricing = [...productCtx.pricing];
  // Restrictions: inherit from product
  if (productCtx.restrictions) item.restrictions = [...(productCtx.restrictions || []), ...(item.restrictions || [])];
  // Measurements: SLN-specific overrides product-level for same qualifier
  const slnQuals = new Set(item.measurements.map(m => m.qualifier));
  for (const pm of productCtx.measurements) {
    if (!slnQuals.has(pm.qualifier)) item.measurements.push(pm);
  }
  // SAC charges, origin, effective_date — inherit from product
  if (productCtx.sac_charges && item.sac_charges.length === 0) item.sac_charges = [...productCtx.sac_charges];
  if (!item.origin && productCtx.origin) item.origin = productCtx.origin;
  if (!item.effective_date && productCtx.effective_date) item.effective_date = productCtx.effective_date;
}

/**
 * Main 832 parser.  Walks segments sequentially, grouping by LIN items.
 * Supports SLN (Sub-Line Item) segments for individual SKU variants within a LIN group.
 */
function parse832(raw) {
  const segments = tokenizeSegments(raw).map(parseSegment);

  const catalog = {
    interchange: {},
    functional_group: {},
    transaction: {},
    header: {
      catalog_info: null,
      dates: [],
      parties: [],
      references: [],
    },
    items: [],
    summary: {
      total_items: 0,
      segment_count: segments.length,
    },
  };

  let currentItem = null;
  let productContext = null; // LIN-level shared data (when SLN children exist)
  let hadSLN = false;        // Whether current LIN group has SLN children

  /**
   * Flush the current SLN item or standalone LIN item.
   */
  function flushCurrentItem() {
    if (!currentItem) return;
    if (productContext) {
      mergeProductContext(currentItem, productContext);
    }
    finalizeItem(currentItem);
    catalog.items.push(currentItem);
    currentItem = null;
  }

  /**
   * Flush everything for a product group (LIN + any SLN children).
   */
  function flushProduct() {
    if (hadSLN && currentItem) {
      flushCurrentItem(); // flush last SLN
    } else if (currentItem && !hadSLN) {
      // Standalone LIN (no SLN children) — treat as single item
      finalizeItem(currentItem);
      catalog.items.push(currentItem);
      currentItem = null;
    }
    productContext = null;
    hadSLN = false;
  }

  for (const seg of segments) {
    switch (seg.id) {

      // ── Envelope ──
      case 'ISA': {
        catalog.interchange = {
          sender_qualifier: seg.el[5] || null,
          sender_id: (seg.el[6] || '').trim(),
          receiver_qualifier: seg.el[7] || null,
          receiver_id: (seg.el[8] || '').trim(),
          date: seg.el[9] || null,
          time: seg.el[10] || null,
          control_number: seg.el[13] || null,
          usage: seg.el[15] === 'P' ? 'production' : 'test',
        };
        break;
      }

      case 'GS': {
        catalog.functional_group = {
          functional_id: seg.el[1] || null,
          sender: seg.el[2] || null,
          receiver: seg.el[3] || null,
          date: seg.el[4] || null,
          time: seg.el[5] || null,
          control_number: seg.el[6] || null,
          version: seg.el[8] || null,
        };
        break;
      }

      case 'ST': {
        catalog.transaction = {
          type: seg.el[1] || null,
          control_number: seg.el[2] || null,
        };
        break;
      }

      // ── Header ──
      case 'BCT': {
        catalog.header.catalog_info = {
          purpose: seg.el[1] || null,
          catalog_number: seg.el[2] || null,
          version: seg.el[3] || null,
          revision: seg.el[4] || null,
          effective_date: seg.el[7] || null,
          purpose_code: seg.el[10] || null,
        };
        break;
      }

      case 'DTM': {
        if (!currentItem && !productContext) {
          catalog.header.dates.push({
            qualifier: seg.el[1] || null,
            date: seg.el[2] || null,
            time: seg.el[3] || null,
          });
        } else {
          // Item-level DTM*007 = effective/shipment date
          const dtmTarget = productContext || currentItem;
          if (dtmTarget && seg.el[1] === '007' && seg.el[2] && !dtmTarget.effective_date) {
            dtmTarget.effective_date = seg.el[2];
          }
        }
        break;
      }

      case 'N1': {
        const party = {
          entity: seg.el[1] || null,
          name: seg.el[2] || null,
          id_qualifier: seg.el[3] || null,
          id: seg.el[4] || null,
        };
        catalog.header.parties.push(party);
        break;
      }

      case 'REF': {
        if (!currentItem && !productContext) {
          catalog.header.references.push({
            qualifier: seg.el[1] || null,
            value: seg.el[2] || null,
            description: seg.el[3] || null,
          });
        }
        break;
      }

      // ── Item Loop ──
      case 'LIN': {
        flushProduct();
        const lin = parseLIN(seg);
        currentItem = {
          line_number: lin.line_number,
          identifiers: lin.identifiers,
          descriptions: [],
          packaging: null,
          pricing: [],
          measurements: [],
          restrictions: [],
          images: [],
          vendor_sku: null,
          upc: null,
          product_name: null,
          color: null,
          collection: null,
          category: null,
          cost: null,
          retail_price: null,
          unit_of_measure: null,
          sqft_per_box: null,
          pieces_per_box: null,
          weight_per_box_lbs: null,
          sell_by: null,
          sac_charges: [],
          origin: null,
          effective_date: null,
        };
        break;
      }

      case 'SLN': {
        if (!hadSLN && currentItem) {
          // First SLN for this LIN — snapshot current item as product context
          productContext = {
            line_number: currentItem.line_number,
            identifiers: { ...currentItem.identifiers },
            descriptions: [...currentItem.descriptions],
            packaging: currentItem.packaging,
            pricing: [...currentItem.pricing],
            measurements: [...currentItem.measurements],
            restrictions: [...(currentItem.restrictions || [])],
            sac_charges: [...(currentItem.sac_charges || [])],
            origin: currentItem.origin,
            effective_date: currentItem.effective_date,
          };
          hadSLN = true;
          currentItem = null; // clear — will be replaced by SLN item
        } else if (currentItem) {
          // Subsequent SLN — flush previous SLN item
          flushCurrentItem();
        }

        const sln = parseSLN(seg);
        currentItem = {
          line_number: productContext ? productContext.line_number : null,
          identifiers: sln.identifiers,
          descriptions: [],
          packaging: null,
          pricing: [],
          measurements: [],
          restrictions: [],
          images: [],
          vendor_sku: sln.identifiers.sku || null, // Pre-set from SLN SK qualifier
          upc: null,
          product_name: null,
          color: null,
          collection: null,
          category: null,
          cost: null,
          retail_price: null,
          unit_of_measure: null,
          sqft_per_box: null,
          pieces_per_box: null,
          weight_per_box_lbs: null,
          sell_by: null,
          sac_charges: [],
          origin: null,
          effective_date: null,
        };
        break;
      }

      case 'G39': {
        const target = (hadSLN && !currentItem) ? null : (productContext || currentItem);
        if (target) {
          for (let i = 2; i < Math.min(seg.el.length, 6); i += 2) {
            const qual = seg.el[i];
            const val = seg.el[i + 1];
            if (qual && val) {
              const key = LIN_QUALIFIERS[qual] || qual.toLowerCase();
              if (!target.identifiers[key]) {
                target.identifiers[key] = val;
              }
            }
          }
          if (seg.el[17]) {
            target.descriptions.push({
              description_type: 'F',
              characteristic_code: '08',
              characteristic_label: 'description',
              description: seg.el[17],
            });
          }
          if (seg.el[9] && seg.el[10]) {
            if (!target.packaging) {
              target.packaging = {
                size_per_pack: parseFloat(seg.el[9]),
                unit_of_measure: seg.el[10],
                pieces_per_pack: seg.el[11] ? parseInt(seg.el[11], 10) : null,
              };
            }
          }
        }
        break;
      }

      case 'PO4': {
        // Packaging goes to product level
        const target = productContext || currentItem;
        if (target) target.packaging = parsePO4(seg);
        break;
      }

      case 'CTP': {
        // Pricing goes to product level
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
        // MTX*qualifier*text — image URLs and product detail links
        const mtxType = seg.el[1] || null;
        const mtxText = seg.el[2] || null;
        if (mtxText && currentItem) {
          currentItem.images.push({ type: mtxType, url: mtxText });
        }
        break;
      }

      case 'SAC': {
        // SAC*C*G090*14*CARE****multiplier*UOM*qty — care/maintenance charge
        const sacTarget = productContext || currentItem;
        if (sacTarget && seg.el[1] === 'C') {
          const multiplier = seg.el[9] ? parseFloat(seg.el[9]) : null;
          const sacDesc = seg.el[4] || null;
          const sacUom = seg.el[10] || null;
          if (multiplier) {
            sacTarget.sac_charges.push({ description: sacDesc, multiplier, uom: sacUom });
          }
        }
        break;
      }

      case 'G43': {
        // G43*003**MILL — origin/manufacturing info
        const g43Target = productContext || currentItem;
        if (g43Target && seg.el[3]) {
          g43Target.origin = seg.el[3];
        }
        break;
      }

      case 'CTB': {
        if (currentItem) currentItem.restrictions.push(parseCTB(seg));
        else if (productContext) productContext.restrictions.push(parseCTB(seg));
        break;
      }

      // ── Trailer ──
      case 'CTT': {
        flushProduct();
        catalog.summary.total_items = seg.el[1] ? parseInt(seg.el[1], 10) : catalog.items.length;
        break;
      }

      case 'SE': {
        flushProduct();
        catalog.summary.segment_count_reported = seg.el[1] ? parseInt(seg.el[1], 10) : null;
        break;
      }

      // Segments we skip: GE, IEA, N3, N4, PKG, CUR — add handlers as needed
      default:
        break;
    }
  }

  // Edge case: no CTT/SE (truncated file)
  flushProduct();

  // Final count
  if (!catalog.summary.total_items) {
    catalog.summary.total_items = catalog.items.length;
  }

  return catalog;
}

// MAC (material class) → category slug mapping
const MAC_CATEGORY_MAP = {
  // Carpet (broadloom)
  CARINDR: 'carpet',              // Carpet Indoor Residential
  CARINDC: 'carpet',              // Carpet Indoor Commercial
  CARIND:  'carpet',              // Carpet Indoor (no R/C suffix)
  // Carpet tile
  CARTILR: 'carpet-tile',         // Carpet Tile Residential
  CARTILC: 'carpet-tile',         // Carpet Tile Commercial
  CARTIL:  'carpet-tile',         // Carpet Tile (no R/C suffix)
  // Vinyl / LVP
  VINTILR: 'luxury-vinyl',        // Vinyl Tile/LVP Residential
  VINTILC: 'luxury-vinyl',        // Vinyl Tile/LVP Commercial
  VINTIL:  'luxury-vinyl',        // Vinyl Tile (no R/C suffix)
  // Accessories / transitions
  VINMISR: 'transitions-moldings', // Vinyl Misc Residential
  VINMISC: 'transitions-moldings', // Vinyl Misc Commercial
  VINMIS:  'transitions-moldings', // Vinyl Misc
  WOOMIS:  'transitions-moldings', // Wood Misc
  CERMIS:  'transitions-moldings', // Ceramic Misc
  ACC:     'installation-sundries',// General accessories
  // Hardwood / tile
  WOO:     'engineered-hardwood',  // Wood
  CERFLO:  'tile',                 // Ceramic Floor
};

// MAC code → inferred construction (since EF EDI lacks PID*F*12)
const MAC_CONSTRUCTION_MAP = {
  CARINDR: 'Broadloom Carpet', CARINDC: 'Broadloom Carpet', CARIND: 'Broadloom Carpet',
  CARTILR: 'Carpet Tile',      CARTILC: 'Carpet Tile',      CARTIL: 'Carpet Tile',
  VINTILR: 'Luxury Vinyl',     VINTILC: 'Luxury Vinyl',     VINTIL: 'Luxury Vinyl',
  VINMISR: 'Vinyl Transition', VINMISC: 'Vinyl Transition', VINMIS: 'Vinyl Transition',
  WOOMIS: 'Hardwood Transition', CERMIS: 'Tile Transition',
  ACC: 'Installation Accessory',
  WOO: 'Engineered Hardwood', CERFLO: 'Ceramic Tile',
};

// MAC suffix → application type
const MAC_APPLICATION_MAP = {
  R: 'Residential',
  C: 'Commercial',
};

/**
 * Strip dimension/sqft info from product names.
 * "Wood lux 7.60x54.45(17.24sqft/box)" → "Wood Lux"
 * "WOOD LUX QUARTER 1X94(.051sqyd)" → "Wood Lux Quarter"
 */
function cleanProductName(raw) {
  if (!raw) return null;
  let name = raw
    // Remove parenthetical sqft/sqyd info: (17.24sqft/box), (.051sqyd)
    .replace(/\s*\([^)]*sq(?:ft|yd)[^)]*\)/gi, '')
    // Remove dimension patterns: 7.60x54.45, 1X94, 2X94, 12X50, 6.65x48.00, etc.
    .replace(/\s+\d+\.?\d*[xX]\d+\.?\d*/g, '')
    // Strip trailing " BL" (broadloom — redundant with category)
    .replace(/\s+BL\s*$/i, '')
    // Strip raw dimensions like 1" X 94", 3 X 94, 2 X 94, 1X94
    .replace(/\s+\d+"?\s*[xX]\s*\d+"?\s*$/gi, '')
    // Clean up multiple spaces
    .replace(/\s{2,}/g, ' ')
    .trim();
  // Expand EF abbreviations before title-casing
  for (const [abbr, full] of Object.entries(EF_ABBREV_MAP)) {
    name = name.replace(new RegExp('\\b' + abbr + '\\b', 'gi'), full);
  }
  // Remove doubled phrases (e.g. "Flush Stairnose Flush Stairnose" → "Flush Stairnose")
  name = name.replace(/(\b\w[\w\s]+)\s+\1\b/gi, '$1');
  // Normalize "T MOLD" → "T-Mold" (raw EDI has two words, not abbreviation)
  name = name.replace(/\bT\s+MOLD\b/gi, 'T-Mold');
  // Strip secondary accessory type if multiple appear (e.g. "Nurture Universal Stairnose Flush Stairnose")
  const accTypes = ['Flush Stairnose', 'Overlap Stairnose', 'Universal Stairnose', 'Stair Tread', '2-Stair Treads', 'End Cap', 'Quarter', 'Reducer', 'T-Mold', 'Threshold'];
  let accFound = 0;
  for (const accType of accTypes) {
    const re = new RegExp('\\b' + accType.replace(/[-]/g, '\\$&') + '\\b', 'i');
    if (re.test(name)) accFound++;
  }
  if (accFound > 1) {
    // Keep only the first accessory type, strip subsequent ones
    let firstKept = false;
    for (const accType of accTypes) {
      const re = new RegExp('\\s+' + accType.replace(/[-]/g, '\\$&') + '\\b', 'gi');
      if (re.test(name)) {
        if (firstKept) {
          name = name.replace(re, '');
        } else {
          firstKept = true;
        }
      }
    }
    name = name.replace(/\s{2,}/g, ' ').trim();
  }
  return cleanAndTitle(name) || null;
}

/**
 * Populate convenience fields on an item from its parsed sub-segments.
 * These flatten the data for easier database mapping.
 */
function finalizeItem(item) {
  // Vendor SKU: prefer pre-set (from SLN), then VN, then MN, then SK
  if (!item.vendor_sku) {
    item.vendor_sku = item.identifiers.vendor_item_number
      || item.identifiers.model_number
      || item.identifiers.sku
      || item.identifiers.part_number
      || null;
  }
  item.upc = item.identifiers.upc || null;

  // Product name: prefer TRN (trade name) PID, then 08 descriptions that aren't SKU cross-refs
  const trnPid = item.descriptions.find(d => d.characteristic_code === 'TRN');
  if (trnPid) {
    item.product_name = cleanProductName(trnPid.description);
  } else {
    // Fall back to PID 08, but skip entries that look like SKU codes (e.g. "1-D020-2001-2X94-EC")
    const descPid = item.descriptions.find(d =>
      d.characteristic_code === '08' && d.description && !/^\d+-[A-Z0-9]+-\d+-/.test(d.description)
    ) || item.descriptions.find(d => d.description_type === 'F' && d.characteristic_code !== '08');
    item.product_name = descPid ? cleanProductName(descPid.description) : null;
  }

  // Color from PID 73
  const colorPid = item.descriptions.find(d => d.characteristic_label === 'color');
  item.color = colorPid ? colorPid.description : null;

  // Collection: from PID 77 only (brand goes to item.brand, not collection)
  const collPid = item.descriptions.find(d => d.characteristic_label === 'collection');
  item.collection = collPid ? collPid.description : null;

  // Category: from PID GEN, or from MAC (material class) code
  const catPid = item.descriptions.find(d =>
    d.characteristic_label === 'category' || d.characteristic_code === 'GEN');
  if (catPid) {
    item.category = catPid.description;
  } else {
    const macPid = item.descriptions.find(d => d.characteristic_code === 'MAC');
    if (macPid && macPid.description) {
      // Store the mapped category slug directly (resolveCategory will look it up)
      const slug = MAC_CATEGORY_MAP[macPid.description.toUpperCase()];
      item.category = slug || macPid.description;
    }
  }

  // Extract material_class from MAC code
  const macPidFinal = item.descriptions.find(d => d.characteristic_code === 'MAC');
  item.material_class = macPidFinal ? macPidFinal.description.toUpperCase() : null;

  // Infer construction from MAC code (EF EDI lacks PID*F*12 subcategory data)
  item.construction = item.material_class ? (MAC_CONSTRUCTION_MAP[item.material_class] || null) : null;

  // Infer application from MAC suffix: ...R = Residential, ...C = Commercial
  if (item.material_class && item.material_class.length > 1) {
    const suffix = item.material_class.slice(-1);
    item.application = MAC_APPLICATION_MAP[suffix] || null;
  }

  // Brand from LIN MF identifier (e.g. "Dream Weaver", "Pentz", "J+J Flooring")
  item.brand = item.identifiers.manufacturer_brand || null;

  // Style code from LIN ST identifier
  item.style_code = item.identifiers.style_number || null;

  // Subcategory from PID*F*12 (if present — uncommon in EF EDI, but handle it)
  const qualPid = item.descriptions.find(d => d.characteristic_code === '12');
  item.subcategory = qualPid ? qualPid.description : null;

  // Refine category from subcategory if present
  if (item.subcategory) {
    const sub = item.subcategory.toUpperCase();
    if (/\bSPC\b|\bWPC\b/.test(sub)) item.category = 'luxury-vinyl';
    else if (/\bADHESIVE\b/.test(sub)) item.category = 'adhesives-sealants';
    else if (/\bUNDERLAYMENT\b|\bPAD\b/.test(sub)) item.category = 'underlayment';
    else if (/\bTRIM\b|\bMOLDING\b/.test(sub)) item.category = 'transitions-moldings';
  }

  // Also refine category from product name for accessories (in case MAC is missing)
  if (!item.category && item.product_name) {
    const pn = item.product_name.toUpperCase();
    if (/STAIRNOSE|T-MOLD|REDUCER|THRESHOLD|END CAP|QUARTER/.test(pn)) item.category = 'transitions-moldings';
    else if (/ADHESIVE/.test(pn)) item.category = 'adhesives-sealants';
    else if (/UNDERLAYMENT/.test(pn)) item.category = 'underlayment';
  }

  // Extract measurements (TH, WL may not exist in EF EDI but handle them)
  const thickMeaFinal = item.measurements.find(m => m.qualifier === 'TH');
  item.thickness = thickMeaFinal || null;
  const wearMea = item.measurements.find(m => m.qualifier === 'WL');
  item.wear_layer = wearMea || null;

  // MEA SU (surface area per unit) → sqft_per_box
  const surfMea = item.measurements.find(m => m.qualifier === 'SU');
  if (surfMea && surfMea.value) {
    const suUom = (surfMea.unit_of_measure || '').toUpperCase();
    if (suUom === 'SF' || suUom === 'FT2') {
      item.sqft_per_box = surfMea.value;
      if (!item.sell_by) item.sell_by = 'sqft';
    } else if (suUom === 'SY') {
      item.sqft_per_box = surfMea.value * 9; // 1 SY = 9 SF
      if (!item.sell_by) item.sell_by = 'sqft';
    } else if (suUom === 'EA') {
      if (!item.sell_by) item.sell_by = 'unit';
    }
  }

  // Packaging → sqft_per_box / pieces_per_box (if not already set from MEA SU)
  if (item.packaging) {
    const pkg = item.packaging;
    const uom = (pkg.unit_of_measure || '').toUpperCase();
    if (!item.sqft_per_box) {
      if (uom === 'SF' || uom === 'FT2') {
        item.sqft_per_box = pkg.size_per_pack;
        if (!item.sell_by) item.sell_by = 'sqft';
      } else if (uom === 'SY') {
        item.sqft_per_box = pkg.size_per_pack * 9;
        if (!item.sell_by) item.sell_by = 'sqft';
      } else if (uom === 'EA' || uom === 'PC') {
        if (!item.sell_by) item.sell_by = 'unit';
      } else if (uom === 'LF') {
        if (!item.sell_by) item.sell_by = 'unit';
      } else if (pkg.size_per_pack) {
        item.sqft_per_box = pkg.size_per_pack;
        if (!item.sell_by) item.sell_by = 'sqft';
      }
    }
    item.pieces_per_box = pkg.pieces_per_pack || null;
    item.weight_per_box_lbs = pkg.gross_weight || null;
  }

  // ── Pricing ──
  // Handle LPR (List Price Rate) with basis_code levels: CT=cost, ST=retail, PL=pallet
  const lprPrices = item.pricing.filter(p => p.price_type === 'LPR');
  if (lprPrices.length > 0) {
    const ctPrice = lprPrices.find(p => p.basis_code === 'CT');
    const stPrice = lprPrices.find(p => p.basis_code === 'ST');
    const plPrice = lprPrices.find(p => p.basis_code === 'PL');

    // Cost: CT (contract), or PL (pallet) if no CT, or first LPR as fallback
    const costEntry = ctPrice || plPrice || lprPrices[0];
    if (costEntry) {
      item.cost = costEntry.unit_price;
      item.unit_of_measure = costEntry.unit_of_measure || item.unit_of_measure;
    }

    // Retail: ST (style/standard), or CT if no ST
    const retailEntry = stPrice || ctPrice || lprPrices[0];
    if (retailEntry) {
      item.retail_price = retailEntry.unit_price;
    }
  } else {
    // Standard EDI pricing: NET/WS for cost, MSR/RS for retail
    const netPrice = item.pricing.find(p => p.price_type === 'NET')
      || item.pricing.find(p => p.class_of_trade === 'WS')
      || item.pricing.find(p => p.class_of_trade === 'DE')
      || item.pricing[0];
    if (netPrice) {
      item.cost = netPrice.unit_price;
      item.unit_of_measure = netPrice.unit_of_measure || item.unit_of_measure;
    }

    const retailPrice = item.pricing.find(p => p.price_type === 'MSR')
      || item.pricing.find(p => p.class_of_trade === 'RS')
      || item.pricing.find(p => p.price_type === 'CAT')
      || item.pricing.find(p => p.price_type === 'RES');
    if (retailPrice) {
      item.retail_price = retailPrice.unit_price;
    }
  }

  // Convert SY prices to SF (1 SY = 9 SF) — except broadloom carpet, which keeps sqyd pricing
  const isBroadloom = /CARIND/.test(item.material_class || '') && !/CARTIL/.test(item.material_class || '');
  if (item.unit_of_measure && item.unit_of_measure.toUpperCase() === 'SY') {
    if (isBroadloom) {
      // Broadloom carpet: keep sqyd pricing for cut_price/cut_cost
      item.cut_price = item.retail_price || null;
      item.cut_cost = item.cost || null;
      // Also store per-sqft versions for retail_price/cost
      if (item.cost) item.cost = parseFloat((item.cost / 9).toFixed(4));
      if (item.retail_price) item.retail_price = parseFloat((item.retail_price / 9).toFixed(4));
      item.sell_by = 'sqyd';
    } else {
      if (item.cost) item.cost = parseFloat((item.cost / 9).toFixed(4));
      if (item.retail_price) item.retail_price = parseFloat((item.retail_price / 9).toFixed(4));
    }
    item.unit_of_measure = 'SF';
  }

  // Infer sell_by from pricing UOM if not yet set
  if (!item.sell_by && item.unit_of_measure) {
    const puom = item.unit_of_measure.toUpperCase();
    if (puom === 'SF' || puom === 'SY') item.sell_by = 'sqft';
    else if (puom === 'EA' || puom === 'PC') item.sell_by = 'unit';
    else if (puom === 'LF') item.sell_by = 'unit';
  }

  // ── Weight Extraction ──
  // EF EDI uses MEA*SW in ounces (ON) — convert to lbs per SY
  const swMea = item.measurements.find(m => m.qualifier === 'SW');
  if (swMea && swMea.value) {
    const swUom = (swMea.unit_of_measure || '').toUpperCase();
    // ON = ounces → convert to lbs
    item.weight_per_sy_lbs = swUom === 'ON' ? Math.round(swMea.value / 16 * 1000) / 1000
      : swUom === 'LB' ? swMea.value
      : swMea.value; // raw fallback
  }

  // MEA*FW = freight weight (also in ounces for EF)
  const fwMea = item.measurements.find(m => m.qualifier === 'FW');
  if (fwMea && fwMea.value) {
    const fwUom = (fwMea.unit_of_measure || '').toUpperCase();
    item.freight_weight_lbs = fwUom === 'ON' ? Math.round(fwMea.value / 16 * 1000) / 1000
      : fwMea.value;
  }

  // ── Carpet-Specific Handling ──
  const isCarpetCat = /CARIND/.test(item.material_class || '') || /CARTIL/.test(item.material_class || '');
  if (isCarpetCat) {
    // Roll/tile dimensions
    const carpWidthMea = item.measurements.find(m => m.qualifier === 'WD');
    const carpLengthMea = item.measurements.find(m => m.qualifier === 'LN');
    // EZ = feet in EF EDI
    const toFt = (m) => {
      if (!m) return null;
      if (m.unit_of_measure === 'IN') return m.value / 12;
      return m.value; // EZ or FT or default = already feet
    };
    if (carpWidthMea) item.roll_width_ft = toFt(carpWidthMea);
    if (carpLengthMea) item.roll_length_ft = toFt(carpLengthMea);

    // Weight per SY (converted from oz)
    item.weight_per_sy = item.weight_per_sy_lbs || null;

    // Broadloom: null out box fields, set pallet = roll
    if (/CARIND/.test(item.material_class) && !/CARTIL/.test(item.material_class)) {
      item.freight_class = 55;
      item.sqft_per_pallet = item.roll_width_ft && item.roll_length_ft
        ? Math.round(item.roll_width_ft * item.roll_length_ft * 100) / 100 : null;
      if (item.weight_per_sy && item.sqft_per_pallet) {
        item.weight_per_pallet_lbs = Math.round(item.weight_per_sy * item.sqft_per_pallet / 9 * 100) / 100;
      }
      item.sqft_per_box = null; item.pieces_per_box = null; item.weight_per_box_lbs = null;
    }

    // Carpet tile: calculate pieces from tile dims + coverage, set freight class
    if (/CARTIL/.test(item.material_class)) {
      item.freight_class = 65;
      item.sell_by = 'sqft';
      // Calculate pieces: tile area × pieces = coverage
      if (item.roll_width_ft && item.roll_length_ft && item.sqft_per_box) {
        const tileSqft = item.roll_width_ft * item.roll_length_ft;
        if (tileSqft > 0 && !item.pieces_per_box) {
          item.pieces_per_box = Math.round(item.sqft_per_box / tileSqft);
        }
      }
      // Clear tile dimensions — they are not roll data
      item.roll_width_ft = null;
      item.roll_length_ft = null;
      // Weight per box from weight_per_sy and coverage
      if (item.weight_per_sy && item.sqft_per_box && !item.weight_per_box_lbs) {
        item.weight_per_box_lbs = Math.round(item.weight_per_sy * item.sqft_per_box / 9 * 100) / 100;
      }
    }
  }

  // ── Hard Surface Weight ──
  // For non-carpet: if SW weight available and sqft_per_box, compute weight_per_box
  if (!isCarpetCat && item.weight_per_sy_lbs && item.sqft_per_box && !item.weight_per_box_lbs) {
    // weight_per_sy_lbs × sqft / 9 = weight per box
    item.weight_per_box_lbs = Math.round(item.weight_per_sy_lbs * item.sqft_per_box / 9 * 100) / 100;
  }
}


// ---------------------------------------------------------------------------
// FTP Download
// ---------------------------------------------------------------------------

/**
 * Connect to FTP, find the latest 832 file, download it.
 * Returns the local file path, or null on failure.
 */
async function downloadLatest832(listOnly = false) {
  const ftp = new FtpClient();
  ftp.ftp.verbose = false;
  let localPath = null;

  try {
    console.log(`Connecting to ${FTP_CONFIG.host}:${FTP_CONFIG.port} as ${FTP_CONFIG.user}...`);
    await ftp.access({ ...FTP_CONFIG, secure: false });
    console.log('Connected.');

    // Scan remote directories for 832 files
    let allFiles = [];

    for (const dir of REMOTE_DIRS) {
      try {
        const listing = await ftp.list(dir);
        const matching = listing
          .filter(f => f.type === 1)  // basic-ftp: 1=file
          .filter(f => {
            const name = f.name.toLowerCase();
            // Match common 832 naming: *832*, *.edi, *.x12, *.dat, *.txt
            return name.includes('832')
              || name.includes('catalog')
              || name.includes('pricelist')
              || name.includes('price_catalog')
              || name.endsWith('.edi')
              || name.endsWith('.x12');
          })
          .map(f => ({ ...f, dir, remotePath: `${dir}/${f.name}`.replace('//', '/') }));
        allFiles.push(...matching);

        if (listing.length > 0) {
          console.log(`\n${dir}/ — ${listing.length} file(s):`);
          for (const f of listing.slice(0, 50)) {
            const sizeKb = (f.size / 1024).toFixed(1);
            const mod = f.modifiedAt ? f.modifiedAt.toISOString().slice(0, 19) : 'unknown';
            const flag = matching.find(m => m.name === f.name) ? ' ← 832 candidate' : '';
            console.log(`  ${f.type === 2 ? '[DIR]' : sizeKb.padStart(8) + 'KB'}  ${mod}  ${f.name}${flag}`);
          }
        }
      } catch (e) {
        // Directory doesn't exist — skip silently
        if (e.code !== 550 && !e.message.includes('No such file') && !e.message.includes('Failed to change')) {
          console.log(`  ${dir}/ — ${e.message}`);
        }
      }
    }

    if (listOnly) {
      console.log(`\nTotal 832 candidates: ${allFiles.length}`);
      return null;
    }

    if (allFiles.length === 0) {
      // No obvious 832 files — recurse one level into subdirectories and list everything
      console.log('\nNo files matching 832 pattern. Scanning subdirectories for any data files...');
      const scannedDirs = new Set();
      for (const dir of REMOTE_DIRS) {
        if (scannedDirs.has(dir)) continue;
        scannedDirs.add(dir);
        try {
          const listing = await ftp.list(dir);
          // Check subdirectories too
          for (const entry of listing) {
            if (entry.type === 2 && !entry.name.startsWith('.')) {
              const subdir = `${dir}/${entry.name}`.replace('//', '/');
              if (scannedDirs.has(subdir)) continue;
              scannedDirs.add(subdir);
              try {
                const subListing = await ftp.list(subdir);
                const subFiles = subListing
                  .filter(f => f.type === 1 && f.size > 100)
                  .map(f => ({ ...f, dir: subdir, remotePath: `${subdir}/${f.name}` }));
                if (subFiles.length > 0) {
                  console.log(`\n  ${subdir}/ — ${subFiles.length} file(s):`);
                  for (const f of subFiles.slice(0, 20)) {
                    console.log(`    ${(f.size / 1024).toFixed(1).padStart(8)}KB  ${f.modifiedAt ? f.modifiedAt.toISOString().slice(0, 19) : 'unknown'}  ${f.name}`);
                  }
                  allFiles.push(...subFiles);
                }
              } catch (e) { /* skip inaccessible subdirs */ }
            } else if (entry.type === 1 && entry.size > 100) {
              const remotePath = `${dir}/${entry.name}`.replace('//', '/');
              allFiles.push({ ...entry, dir, remotePath });
            }
          }
        } catch (e) { /* skip */ }
      }
      // Filter to likely EDI/data files
      const dataFiles = allFiles.filter(f => {
        const n = f.name.toLowerCase();
        return n.endsWith('.edi') || n.endsWith('.x12') || n.endsWith('.dat')
          || n.endsWith('.txt') || n.endsWith('.csv') || n.endsWith('.832')
          || n.includes('price') || n.includes('catalog')
          || n.includes('832') || n.includes('product');
      });
      if (dataFiles.length > 0) {
        allFiles = dataFiles;
        console.log(`\nFiltered to ${dataFiles.length} likely data files.`);
      }
    }

    if (allFiles.length === 0) {
      console.error('No files found on remote server.');
      return null;
    }

    // Sort by modification time, newest first (basic-ftp returns Date objects)
    allFiles.sort((a, b) => (b.modifiedAt?.getTime() || 0) - (a.modifiedAt?.getTime() || 0));
    const target = allFiles[0];

    console.log(`\nDownloading: ${target.remotePath} (${(target.size / 1024).toFixed(1)}KB)`);
    localPath = `/tmp/engfloors_832_${Date.now()}.edi`;
    await ftp.downloadTo(localPath, target.remotePath);
    console.log(`Saved to: ${localPath}`);

  } catch (err) {
    console.error('FTP error:', err.message);
    // Show more detail for auth failures
    if (err.message.includes('Login') || err.message.includes('530') || err.message.includes('auth')) {
      console.error('  → Check credentials or server availability.');
      console.error(`  → Host: ${FTP_CONFIG.host}, User: ${FTP_CONFIG.user}`);
    }
  } finally {
    ftp.close();
  }

  return localPath;
}


// ---------------------------------------------------------------------------
// Database Import
// ---------------------------------------------------------------------------

/**
 * Generate an internal SKU from vendor code + vendor_sku.
 * e.g. "EF-DWC-OAK-NAT" → "EF-DWC-OAK-NAT"
 * If vendor_sku is missing, use a hash of the product name.
 */
function makeInternalSku(vendorSku, productName) {
  if (vendorSku) {
    // Don't double-prefix if vendor_sku already starts with EF-
    return vendorSku.toUpperCase().startsWith('EF-') ? vendorSku : `EF-${vendorSku}`;
  }
  // Fallback: slugify product name
  const slug = (productName || 'UNKNOWN')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 30);
  return `EF-${slug}`;
}

/**
 * Resolve category slug from EDI category text.
 * Returns category UUID or null.
 */
async function resolveCategory(categoryText) {
  if (!categoryText) return null;
  const normalized = categoryText.toLowerCase().trim();
  const slug = CATEGORY_MAP[normalized];
  if (!slug) return null;

  const result = await pool.query('SELECT id FROM categories WHERE slug = $1', [slug]);
  return result.rows[0] ? result.rows[0].id : null;
}

/**
 * Ensure the Engineered Floors vendor record exists.
 * Returns the vendor UUID.
 */
async function ensureVendor() {
  // Check if already exists
  const existing = await pool.query('SELECT id FROM vendors WHERE code = $1', [VENDOR_CODE]);
  if (existing.rows.length > 0) {
    console.log(`Vendor "${VENDOR_NAME}" already exists (${existing.rows[0].id})`);
    return existing.rows[0].id;
  }

  // Create it
  const result = await pool.query(`
    INSERT INTO vendors (name, code, website, is_active, has_public_inventory)
    VALUES ($1, $2, $3, true, false)
    RETURNING id
  `, [VENDOR_NAME, VENDOR_CODE, VENDOR_WEBSITE]);

  console.log(`Created vendor "${VENDOR_NAME}" (${result.rows[0].id})`);
  return result.rows[0].id;
}

/**
 * Group 832 items into products.
 * Items sharing the same collection + base product name = one product with multiple SKUs (color variants).
 * Accessories are grouped separately.
 */
function groupIntoProducts(items) {
  const products = new Map(); // key → { productName, collection, category, items[] }

  for (const item of items) {
    if (!item.vendor_sku && !item.product_name) continue; // skip empty

    // Skip Pentz brand items — these are handled by the PC vendor importer
    if (item.brand && /^pentz$/i.test(item.brand.trim())) continue;

    const collection = item.collection || '';
    const category = item.category || '';
    const isAccessory = /accessory|sundries|trim|molding|transition|reducer|stairnose|t-bar|quarter|threshold|end.?cap|t.?mold|ovrlp|flshst|2strtr/i.test(category)
      || /accessory|sundries|trim|molding|transition|reducer|stairnose|t-bar|quarter|threshold|end.?cap|t.?mold|ovrlp|flshst|2strtr/i.test(item.product_name || '');

    // Build a product-level name by stripping the color from the full description
    let baseName = item.product_name || item.vendor_sku || 'Unknown';
    if (item.color && !isAccessory) {
      const origName = baseName;
      // Try removing the full color string first (exact match)
      const colorEsc = item.color.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      let stripped = baseName.replace(new RegExp('\\b' + colorEsc + '\\b', 'i'), '').replace(/\s{2,}/g, ' ').trim();
      if (stripped && stripped.length >= 3) {
        baseName = stripped;
      } else {
        // Fall back to word-by-word removal, but protect product name integrity
        const origWords = baseName.split(/\s+/).length;
        const colorWords = item.color.split(/\s+/);
        for (const word of colorWords) {
          if (word.length > 2) {
            const candidate = baseName.replace(new RegExp('\\b' + word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i'), '').replace(/\s{2,}/g, ' ').trim();
            const candidateWords = candidate.split(/\s+/).filter(w => w).length;
            // Only apply if result retains enough words (avoid "Wood Tech" → "Tech")
            if (candidateWords >= Math.min(origWords, 2)) {
              baseName = candidate;
            }
          }
        }
      }
    }

    // Product grouping key
    const key = `${collection}|||${baseName}|||${isAccessory ? 'acc' : 'main'}`;

    if (!products.has(key)) {
      products.set(key, {
        baseName,
        collection,
        category,
        isAccessory,
        items: [],
      });
    }
    products.get(key).items.push(item);
  }

  return Array.from(products.values());
}

/**
 * Upsert a SKU attribute by attribute slug (not UUID).
 */
async function upsertSkuAttributeBySlug(skuId, slug, value) {
  if (!value || !String(value).trim()) return;
  const attr = await pool.query('SELECT id FROM attributes WHERE slug = $1', [slug]);
  if (!attr.rows.length) return;
  await pool.query(`
    INSERT INTO sku_attributes (sku_id, attribute_id, value)
    VALUES ($1, $2, $3)
    ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value = $3
  `, [skuId, attr.rows[0].id, String(value).trim()]);
}

/**
 * Import parsed catalog items into the database.
 */
async function importToDatabase(catalog) {
  const vendorId = await ensureVendor();

  // Pre-fetch category IDs
  const catCache = {};
  const catResult = await pool.query('SELECT id, slug FROM categories');
  for (const row of catResult.rows) catCache[row.slug] = row.id;

  const resolveCatId = (categoryText) => {
    if (!categoryText) return null;
    // Check if it's already a slug (from MAC code mapping)
    if (catCache[categoryText]) return catCache[categoryText];
    // Otherwise look up via CATEGORY_MAP
    const slug = CATEGORY_MAP[categoryText.toLowerCase().trim()];
    return slug ? (catCache[slug] || null) : null;
  };

  // Group items into products
  const productGroups = groupIntoProducts(catalog.items);
  console.log(`\nGrouped ${catalog.items.length} items into ${productGroups.length} products`);

  const stats = { products_created: 0, products_updated: 0, skus_created: 0, skus_updated: 0, pricing_upserted: 0, packaging_upserted: 0, attributes_upserted: 0, images_upserted: 0 };

  for (const group of productGroups) {
    const categoryId = resolveCatId(group.category);
    const collection = group.collection || null;

    // Build description_short and description_long from first item's EDI data
    const repItem = group.items[0];
    const descParts = [];
    const longParts = [];

    // Construction from MAC code (EF lacks PID*F*12; fall back to subcategory if present)
    const construction = repItem.construction
      || (repItem.subcategory ? cleanAndTitle(repItem.subcategory) : null);
    const brand = repItem.brand ? cleanAndTitle(repItem.brand) : 'Engineered Floors';

    // Fiber/material from PID*F*37 (if present — rare in EF EDI)
    const fiberPid = repItem.descriptions.find(d => d.characteristic_code === '37');
    const fiberText = fiberPid ? cleanFiber(fiberPid.description) : null;

    // Dimensions
    const repWidthMea = repItem.measurements.find(m => m.qualifier === 'WD');
    const repLengthMea = repItem.measurements.find(m => m.qualifier === 'LN');
    const isCarpetProduct = /CARIND|CARTIL/.test(repItem.material_class || '');

    if (isCarpetProduct) {
      // Carpet descriptions: construction | fiber | W' Wide | L' Roll (or WxW tiles)
      if (construction) descParts.push(construction);
      if (fiberText) descParts.push(fiberText);
      if (/CARIND/.test(repItem.material_class || '') && !/CARTIL/.test(repItem.material_class || '')) {
        // Broadloom
        if (repItem.roll_width_ft) descParts.push(`${repItem.roll_width_ft}' Wide`);
        if (repItem.roll_length_ft) descParts.push(`${repItem.roll_length_ft}' Roll`);
        if (construction) longParts.push(`${construction} by ${brand}.`);
        if (repItem.roll_width_ft && repItem.roll_length_ft) {
          const rollSqft = Math.round(repItem.roll_width_ft * repItem.roll_length_ft);
          longParts.push(`Available in ${repItem.roll_width_ft}' x ${repItem.roll_length_ft}' rolls (${rollSqft} sq ft per roll).`);
        }
        if (repItem.weight_per_sy) longParts.push(`Weight: ${repItem.weight_per_sy} lbs/sq yd.`);
      } else {
        // Carpet tile
        if (repItem.roll_width_ft && repItem.roll_length_ft) {
          const tileInW = Math.round(repItem.roll_width_ft * 12);
          const tileInL = Math.round(repItem.roll_length_ft * 12);
          descParts.push(`${tileInW}" x ${tileInL}"`);
        }
        if (repItem.sqft_per_box) descParts.push(`${repItem.sqft_per_box} SF/Carton`);
        if (construction) longParts.push(`${construction} by ${brand}.`);
        if (repItem.sqft_per_box) longParts.push(`${repItem.sqft_per_box} sq ft per carton.`);
        if (repItem.pieces_per_box) longParts.push(`${repItem.pieces_per_box} tiles per carton.`);
      }
    } else if (group.isAccessory) {
      // Accessories/transitions
      const accType = construction || repItem.product_name || 'Flooring accessory';
      descParts.push(accType);
      if (repWidthMea && repLengthMea) {
        const wIn = repWidthMea.unit_of_measure === 'EZ' ? repWidthMea.value * 12 : repWidthMea.value;
        const lIn = repLengthMea.unit_of_measure === 'EZ' ? repLengthMea.value * 12 : repLengthMea.value;
        const wFmt = wIn.toFixed(1).replace(/\.0$/, '');
        const lFmt = lIn.toFixed(1).replace(/\.0$/, '');
        descParts.push(`${wFmt}" x ${lFmt}"`);
      }
      longParts.push(`${accType} by ${brand}.`);
    } else {
      // Hard surface (LVP/SPC/WPC, hardwood, tile)
      if (construction) descParts.push(construction);
      if (fiberText) descParts.push(fiberText);
      if (repItem.sqft_per_box) descParts.push(`${repItem.sqft_per_box} SF/Carton`);
      if (repWidthMea && repLengthMea) {
        const wIn = repWidthMea.unit_of_measure === 'EZ' ? repWidthMea.value * 12 : repWidthMea.value;
        const lIn = repLengthMea.unit_of_measure === 'EZ' ? repLengthMea.value * 12 : repLengthMea.value;
        const wFmt = wIn.toFixed(2).replace(/\.?0+$/, '');
        const lFmt = lIn.toFixed(2).replace(/\.?0+$/, '');
        descParts.push(`${wFmt}" x ${lFmt}"`);
      }
      if (construction) longParts.push(`${construction} flooring by ${brand}.`);
      if (repItem.sqft_per_box) longParts.push(`${repItem.sqft_per_box} sq ft per carton.`);
    }

    if (collection) longParts.push(`Part of the ${cleanAndTitle(collection)} collection.`);
    if (repItem.application) longParts.push(`${repItem.application} application.`);

    const descShort = descParts.length > 0 ? descParts.join(' | ') : null;
    const descLong = longParts.length > 0 ? longParts.join(' ') : null;

    // Upsert product
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

    // Upsert each item as a SKU
    for (const item of group.items) {
      const internalSku = makeInternalSku(item.vendor_sku, item.product_name);
      const vendorSku = item.vendor_sku || internalSku;
      let variantName = cleanAndTitle(item.color || item.product_name || null);
      if (group.isAccessory && variantName) {
        // Strip trailing accessory type from color variant (product name already has it)
        variantName = variantName.replace(/\s+(Flush Stairnose|Overlap Stairnose|Universal Stairnose|Stair Tread|2-stair Treads|End Cap|Quarter|Reducer|T-Mold|T Mold|Threshold)\b.*/i, '').trim();
      }
      // Disambiguate variant names by SKU suffix (construction/backing type)
      if (vendorSku) {
        const skuSuffix = vendorSku.match(/-([A-Z]+)$/)?.[1];
        if (skuSuffix === 'DB') variantName = (variantName || '') + ' (Dry Back)';
        else if (skuSuffix === 'LV') variantName = (variantName || '') + ' (Click)';
        else if (skuSuffix === 'IL') variantName = (variantName || '') + ' (LifeGuard)';
        else if (skuSuffix === 'K') variantName = (variantName || '') + ' (KangaBack)';
      }
      const sellBy = item.sell_by || 'sqft';
      const variantType = group.isAccessory ? 'accessory' : null;

      // Upsert SKU
      let skuId;
      const existingSku = await pool.query(
        'SELECT id FROM skus WHERE internal_sku = $1', [internalSku]
      );

      if (existingSku.rows.length > 0) {
        skuId = existingSku.rows[0].id;
        await pool.query(`
          UPDATE skus SET product_id = $1, vendor_sku = $2, variant_name = $3, sell_by = $4, variant_type = $5, status = 'active', updated_at = NOW()
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

      // Upsert pricing — 2× markup like Shaw when retail = cost
      if (item.cost || item.retail_price) {
        const priceBasis = sellBy === 'sqyd' ? 'per_sqyd' : sellBy === 'sqft' ? 'per_sqft' : 'per_unit';
        const cost = item.cost || 0;
        const retail = (item.retail_price && item.retail_price !== item.cost)
          ? item.retail_price
          : Math.round(cost * 2 * 100) / 100;
        const cutPrice = item.cut_price || null;
        const cutCost = item.cut_cost || null;
        await pool.query(`
          INSERT INTO pricing (sku_id, cost, retail_price, price_basis, cut_price, cut_cost)
          VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (sku_id)
          DO UPDATE SET cost = $2, retail_price = $3, price_basis = $4, cut_price = $5, cut_cost = $6
        `, [skuId, cost, retail, priceBasis, cutPrice, cutCost]);
        stats.pricing_upserted++;
      }

      // Upsert packaging — full fields including carpet roll data
      const rawWt = item.weight_per_box_lbs || null;
      const weightPerBox = (rawWt && item.sqft_per_box && rawWt < 10)
        ? Math.round(rawWt * item.sqft_per_box * 10) / 10   // weight_per_sqft × sqft
        : rawWt;
      const sqftPerBox = item.sqft_per_box || null;
      const piecesPerBox = item.pieces_per_box || null;
      const rollWidthFt = item.roll_width_ft || null;
      const rollLengthFt = item.roll_length_ft || null;
      const sqftPerPallet = item.sqft_per_pallet || null;
      const weightPerPalletLbs = item.weight_per_pallet_lbs || null;
      const freightClass = item.freight_class || null;

      if (sqftPerBox || piecesPerBox || weightPerBox || rollWidthFt || freightClass || sqftPerPallet) {
        await pool.query(`
          INSERT INTO packaging (sku_id, sqft_per_box, pieces_per_box, weight_per_box_lbs,
            sqft_per_pallet, weight_per_pallet_lbs,
            roll_width_ft, roll_length_ft, freight_class)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
          ON CONFLICT (sku_id) DO UPDATE SET
            sqft_per_box = COALESCE($2, packaging.sqft_per_box),
            pieces_per_box = COALESCE($3, packaging.pieces_per_box),
            weight_per_box_lbs = COALESCE($4, packaging.weight_per_box_lbs),
            sqft_per_pallet = COALESCE($5, packaging.sqft_per_pallet),
            weight_per_pallet_lbs = COALESCE($6, packaging.weight_per_pallet_lbs),
            roll_width_ft = COALESCE($7, packaging.roll_width_ft),
            roll_length_ft = COALESCE($8, packaging.roll_length_ft),
            freight_class = COALESCE($9, packaging.freight_class)
        `, [skuId, sqftPerBox, piecesPerBox, weightPerBox,
            sqftPerPallet, weightPerPalletLbs,
            rollWidthFt, rollLengthFt, freightClass]);
        stats.packaging_upserted++;
      }

      // ── Upsert Attributes (slug-based, like Shaw) ──

      // Color (title-cased)
      if (item.color) {
        await upsertSkuAttributeBySlug(skuId, 'color', cleanAndTitle(item.color));
        stats.attributes_upserted++;
      }

      // Color code from PID*F*35 (present in EF EDI)
      const colorCodePid = item.descriptions.find(d => d.characteristic_code === '35');
      if (colorCodePid) {
        await upsertSkuAttributeBySlug(skuId, 'color_code', colorCodePid.description);
        stats.attributes_upserted++;
      }

      // Material class from MAC code
      if (item.material_class) {
        await upsertSkuAttributeBySlug(skuId, 'material_class', item.material_class);
        stats.attributes_upserted++;
      }

      // Construction (from MAC inference since EF lacks PID*F*12)
      if (item.construction) {
        await upsertSkuAttributeBySlug(skuId, 'construction', item.construction);
        stats.attributes_upserted++;
      }

      // Subcategory (from PID*F*12 if present, otherwise from construction)
      const subcat = item.subcategory ? cleanAndTitle(item.subcategory) : item.construction;
      if (subcat) {
        await upsertSkuAttributeBySlug(skuId, 'subcategory', subcat);
        stats.attributes_upserted++;
      }

      // Material / Fiber from PID*F*37 (if present — rare in EF EDI)
      const materialPid = item.descriptions.find(d => d.characteristic_code === '37');
      if (materialPid) {
        await upsertSkuAttributeBySlug(skuId, 'material', cleanFiber(materialPid.description));
        await upsertSkuAttributeBySlug(skuId, 'fiber', cleanFiber(materialPid.description));
        stats.attributes_upserted += 2;
      }

      // Finish from PID*F*75 (if present)
      const finishPid = item.descriptions.find(d => d.characteristic_code === '75');
      if (finishPid) {
        await upsertSkuAttributeBySlug(skuId, 'finish', cleanAndTitle(finishPid.description));
        stats.attributes_upserted++;
      }

      // Style from PID*F*38 (if present)
      const stylePid = item.descriptions.find(d => d.characteristic_code === '38');
      if (stylePid) {
        await upsertSkuAttributeBySlug(skuId, 'style', cleanAndTitle(stylePid.description));
        stats.attributes_upserted++;
      }

      // Style code from LIN ST identifier (e.g. "4046")
      if (item.style_code) {
        await upsertSkuAttributeBySlug(skuId, 'style_code', item.style_code);
        stats.attributes_upserted++;
      }

      // Brand from LIN MF identifier (e.g. "Dream Weaver", "Pentz")
      if (item.brand) {
        await upsertSkuAttributeBySlug(skuId, 'brand', cleanAndTitle(item.brand));
        stats.attributes_upserted++;
      }

      // Collection as attribute
      if (item.collection) {
        await upsertSkuAttributeBySlug(skuId, 'collection', cleanAndTitle(item.collection));
        stats.attributes_upserted++;
      }

      // Thickness from MEA*TH (if present)
      if (item.thickness) {
        await upsertSkuAttributeBySlug(skuId, 'thickness', `${item.thickness.value}${item.thickness.unit_of_measure || ''}`);
        stats.attributes_upserted++;
      }

      // Wear layer from MEA*WL (if present)
      if (item.wear_layer) {
        await upsertSkuAttributeBySlug(skuId, 'wear_layer', `${item.wear_layer.value}${item.wear_layer.unit_of_measure || 'mil'}`);
        stats.attributes_upserted++;
      }

      // Size — formatted properly
      const widthMea = item.measurements.find(m => m.qualifier === 'WD');
      const lengthMea = item.measurements.find(m => m.qualifier === 'LN');
      if (widthMea && lengthMea) {
        const isCarpet = /CARIND|CARTIL/.test(item.material_class || '');
        if (isCarpet) {
          // Carpet: show in feet for broadloom, inches for tile
          if (/CARTIL/.test(item.material_class || '')) {
            const tW = Math.round(widthMea.value * 12);
            const tL = Math.round(lengthMea.value * 12);
            await upsertSkuAttributeBySlug(skuId, 'size', `${tW}" x ${tL}"`);
          } else {
            await upsertSkuAttributeBySlug(skuId, 'size', `${widthMea.value}' x ${lengthMea.value}'`);
          }
        } else {
          const wIn = widthMea.unit_of_measure === 'EZ' ? widthMea.value * 12 : widthMea.value;
          const lIn = lengthMea.unit_of_measure === 'EZ' ? lengthMea.value * 12 : lengthMea.value;
          const wFmt = wIn.toFixed(2).replace(/\.?0+$/, '');
          const lFmt = lIn.toFixed(2).replace(/\.?0+$/, '');
          await upsertSkuAttributeBySlug(skuId, 'size', `${wFmt}" x ${lFmt}"`);
          // Store width as standalone attribute for filtering (e.g. 7" wide plank)
          await upsertSkuAttributeBySlug(skuId, 'width', `${wFmt}"`);
          stats.attributes_upserted++;
          // Compute pieces_per_box from plank area and sqft_per_box
          if (item.sqft_per_box && wIn > 0 && lIn > 0) {
            const plankSqft = (wIn * lIn) / 144;
            const computedPieces = Math.round(item.sqft_per_box / plankSqft);
            if (computedPieces > 0 && !item.pieces_per_box) {
              item.pieces_per_box = computedPieces;
            }
          }
        }
        stats.attributes_upserted++;
      }

      // UPC
      if (item.upc) {
        await upsertSkuAttributeBySlug(skuId, 'upc', item.upc);
        stats.attributes_upserted++;
      }

      // Carpet-specific: roll_width, roll_length, weight_per_sqyd
      if (/CARIND|CARTIL/.test(item.material_class || '')) {
        if (item.roll_width_ft) {
          await upsertSkuAttributeBySlug(skuId, 'roll_width', `${item.roll_width_ft}ft`);
          stats.attributes_upserted++;
        }
        if (item.roll_length_ft) {
          await upsertSkuAttributeBySlug(skuId, 'roll_length', `${item.roll_length_ft}ft`);
          stats.attributes_upserted++;
        }
        if (item.weight_per_sy) {
          await upsertSkuAttributeBySlug(skuId, 'weight_per_sqyd', `${item.weight_per_sy} lbs`);
          stats.attributes_upserted++;
        }
      }

      // Application (from MAC suffix: ...R = Residential, ...C = Commercial)
      if (item.application) {
        await upsertSkuAttributeBySlug(skuId, 'application', item.application);
        stats.attributes_upserted++;
      }

      // ── Store Images in media_assets ──
      if (item.images && item.images.length > 0) {
        for (const img of item.images) {
          if (!img.url) continue;
          // POB = swatch/product image, PDS = product detail page
          const assetType = img.type === 'POB' ? 'primary' : img.type === 'PDS' ? 'spec_pdf' : 'alternate';
          try {
            // SKU-level image
            await pool.query(`
              INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
              VALUES ($1, $2, $3, $4, $4, 0)
              ON CONFLICT (product_id, sku_id, asset_type, sort_order) WHERE sku_id IS NOT NULL
              DO UPDATE SET url = $4, original_url = $4
            `, [productId, skuId, assetType, img.url]);
            stats.images_upserted = (stats.images_upserted || 0) + 1;
          } catch (imgErr) {
            // Ignore duplicate/conflict errors
          }
        }
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
  let localFile = fileIdx !== -1 ? args[fileIdx + 1] : null;

  console.log('=== Engineered Floors EDI 832 Importer ===\n');

  // Step 1: Get the file
  if (localFile) {
    if (!fs.existsSync(localFile)) {
      console.error(`File not found: ${localFile}`);
      process.exit(1);
    }
    console.log(`Using local file: ${localFile}`);
  } else {
    localFile = await downloadLatest832(listOnly);
    if (listOnly) {
      process.exit(0);
    }
    if (!localFile) {
      console.error('\nFailed to download 832 file. Use --file to parse a local file instead.');
      process.exit(1);
    }
  }

  // Step 2: Read and parse
  console.log('\nParsing EDI 832...');
  const raw = fs.readFileSync(localFile, 'utf-8');
  console.log(`File size: ${(raw.length / 1024).toFixed(1)}KB, ${raw.split('\n').length} lines`);

  const catalog = parse832(raw);

  // Step 3: Report
  console.log('\n── Catalog Summary ──');
  console.log(`Interchange: ${catalog.interchange.sender_id || '?'} → ${catalog.interchange.receiver_id || '?'}`);
  console.log(`Transaction: ${catalog.transaction.type || '?'} #${catalog.transaction.control_number || '?'}`);
  if (catalog.header.catalog_info) {
    console.log(`Catalog: ${catalog.header.catalog_info.catalog_number || '?'} (${catalog.header.catalog_info.purpose || '?'})`);
    if (catalog.header.catalog_info.effective_date) {
      console.log(`Effective: ${catalog.header.catalog_info.effective_date}`);
    }
  }
  for (const party of catalog.header.parties) {
    const label = party.entity === 'SE' ? 'Seller' : party.entity === 'BY' ? 'Buyer' : party.entity;
    console.log(`${label}: ${party.name || '?'} (${party.id || '?'})`);
  }
  console.log(`Items parsed: ${catalog.items.length}`);
  console.log(`Segments processed: ${catalog.summary.segment_count}`);

  // Stats
  const withPrice = catalog.items.filter(i => i.cost || i.retail_price).length;
  const withPkg = catalog.items.filter(i => i.packaging).length;
  const withDesc = catalog.items.filter(i => i.product_name).length;
  const bySqft = catalog.items.filter(i => i.sell_by === 'sqft').length;
  const byUnit = catalog.items.filter(i => i.sell_by === 'unit').length;

  console.log(`  With pricing: ${withPrice}`);
  console.log(`  With packaging: ${withPkg}`);
  console.log(`  With product name: ${withDesc}`);
  console.log(`  Sold by sqft: ${bySqft}`);
  console.log(`  Sold by unit: ${byUnit}`);

  // Show first few items as sample
  console.log('\n── Sample Items (first 3) ──');
  for (const item of catalog.items.slice(0, 3)) {
    console.log(JSON.stringify({
      vendor_sku: item.vendor_sku,
      upc: item.upc,
      product_name: item.product_name,
      color: item.color,
      collection: item.collection,
      brand: item.brand,
      category: item.category,
      material_class: item.material_class,
      construction: item.construction,
      application: item.application,
      cost: item.cost,
      retail_price: item.retail_price,
      sell_by: item.sell_by,
      sqft_per_box: item.sqft_per_box,
      pieces_per_box: item.pieces_per_box,
      weight_per_box_lbs: item.weight_per_box_lbs,
      roll_width_ft: item.roll_width_ft,
      roll_length_ft: item.roll_length_ft,
      weight_per_sy: item.weight_per_sy,
      sac_charges: item.sac_charges,
      effective_date: item.effective_date,
      images: item.images ? item.images.length : 0,
      pricing_tiers: item.pricing.length,
      descriptions: item.descriptions.length,
      measurements: item.measurements.length,
    }, null, 2));
  }

  // Step 4: Write JSON output
  const output = {
    meta: {
      source: 'Engineered Floors',
      ftp_host: FTP_CONFIG.host,
      parsed_at: new Date().toISOString(),
      file: localFile,
      interchange: catalog.interchange,
      functional_group: catalog.functional_group,
      catalog_info: catalog.header.catalog_info,
      parties: catalog.header.parties,
    },
    summary: {
      total_items: catalog.items.length,
      with_pricing: withPrice,
      with_packaging: withPkg,
      sold_by_sqft: bySqft,
      sold_by_unit: byUnit,
    },
    items: catalog.items.map(item => ({
      // Flat fields for easy DB mapping
      vendor_sku: item.vendor_sku,
      upc: item.upc,
      product_name: item.product_name,
      color: item.color,
      collection: item.collection,
      brand: item.brand,
      category: item.category,
      material_class: item.material_class,
      construction: item.construction,
      application: item.application,
      cost: item.cost,
      retail_price: item.retail_price,
      sell_by: item.sell_by,
      unit_of_measure: item.unit_of_measure,
      sqft_per_box: item.sqft_per_box,
      pieces_per_box: item.pieces_per_box,
      weight_per_box_lbs: item.weight_per_box_lbs,
      roll_width_ft: item.roll_width_ft || null,
      roll_length_ft: item.roll_length_ft || null,
      weight_per_sy: item.weight_per_sy || null,
      freight_class: item.freight_class || null,
      effective_date: item.effective_date || null,
      sac_charges: item.sac_charges || [],
      style_code: item.style_code || null,
      // Full parsed data
      identifiers: item.identifiers,
      pricing: item.pricing,
      descriptions: item.descriptions,
      measurements: item.measurements,
      packaging: item.packaging,
      restrictions: item.restrictions,
      images: item.images,
    })),
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
  console.log(`\nJSON output written to: ${OUTPUT_PATH}`);
  console.log(`  ${catalog.items.length} items, ${(fs.statSync(OUTPUT_PATH).size / 1024).toFixed(1)}KB`);

  // Step 5: Import to database (unless --dry-run)
  if (dryRun) {
    console.log('\n[DRY RUN] No database writes performed.');
  } else {
    console.log('\n── Importing to Database ──');
    try {
      const stats = await importToDatabase(catalog);
      console.log('\nImport complete:');
      console.log(`  Products created:    ${stats.products_created}`);
      console.log(`  Products updated:    ${stats.products_updated}`);
      console.log(`  SKUs created:        ${stats.skus_created}`);
      console.log(`  SKUs updated:        ${stats.skus_updated}`);
      console.log(`  Pricing upserted:    ${stats.pricing_upserted}`);
      console.log(`  Packaging upserted:  ${stats.packaging_upserted}`);
      console.log(`  Attributes upserted: ${stats.attributes_upserted}`);
      console.log(`  Images upserted:     ${stats.images_upserted}`);
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
