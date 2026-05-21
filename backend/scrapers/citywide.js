#!/usr/bin/env node
/**
 * Citywide LVT — Scraper + EDI 832 Enrichment
 *
 * Scrapes citywidelvt.com for product structure & images,
 * then enriches with pricing/packaging/specs from Tri-West EDI 832 data.
 *
 * Product lines:
 *   - Citywide Dryback  (CW12001–CW12014)
 *   - Citywide Pad Attached (CW12001PAD–CW12014PAD)
 *   - Citywide Q (CWQ12001P–CWQ12014P)
 *
 * Each line has 12 colors; images are per-SKU from the website.
 *
 * Usage:
 *   node backend/scrapers/citywide.js                     # Full scrape + 832 import
 *   node backend/scrapers/citywide.js --scrape-only       # Website scrape only (no 832)
 *   node backend/scrapers/citywide.js --832-only           # 832 enrichment only
 *   node backend/scrapers/citywide.js --dry-run            # Parse only, no DB writes
 *   node backend/scrapers/citywide.js --file /path/to/832  # Use local 832 file
 */

import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Client as FtpClient } from 'basic-ftp';
import { Writable } from 'stream';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Database connection
// ---------------------------------------------------------------------------
const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

// ---------------------------------------------------------------------------
// Vendor info
// ---------------------------------------------------------------------------
const VENDOR_NAME = 'Citywide LVT';
const VENDOR_CODE = 'CW';
const VENDOR_WEBSITE = 'https://www.citywidelvt.com';

// Tri-West FTP config (Citywide is distributed by Tri-West, brand code CFL)
const FTP_CONFIG = {
  host: process.env.TRIWEST_FTP_HOST || 'ftp.triwestltd.com',
  port: parseInt(process.env.TRIWEST_FTP_PORT || '21', 10),
  user: process.env.TRIWEST_FTP_USER || 'xpresfl',
  password: process.env.TRIWEST_FTP_PASS || 'xpf012728!',
};
const REMOTE_DIR = '/outbox';

// ---------------------------------------------------------------------------
// Citywide product catalog (scraped from citywidelvt.com)
// ---------------------------------------------------------------------------
const COLORS = [
  { name: 'Wilshire Boulevard', baseCode: '12001' },
  { name: 'Park Place',        baseCode: '12002' },
  { name: 'Lakeshore Drive',   baseCode: '12003' },
  { name: 'LaSalle Street',    baseCode: '12004' },
  { name: 'Lexington Street',  baseCode: '12005' },
  { name: 'Beacon Avenue',     baseCode: '12006' },
  { name: '2nd Avenue',        baseCode: '12007' },
  { name: 'Central Avenue',    baseCode: '12008' },
  { name: 'Campus Point',      baseCode: '12011' },
  { name: 'University Ave',    baseCode: '12012' },
  { name: 'Union Street',      baseCode: '12013' },
  { name: 'Sunset Blvd',       baseCode: '12014' },
];

// Extra colors only available in Pad Attached (from 832 data)
const PAD_EXTRA_COLORS = [
  { name: 'Chestnut Drive',    baseCode: '12009' },
  { name: 'Broadway',          baseCode: '12010' },
];

const PRODUCT_LINES = [
  {
    name: 'Citywide Dryback',
    slug: 'citywide-dryback',
    skuPrefix: 'CW',
    skuSuffix: '',
    description: 'Luxury vinyl tile with dry-back (glue-down) installation.',
    construction: 'LVT Dryback',
  },
  {
    name: 'Citywide Pad Attached',
    slug: 'citywide-pad-attached',
    skuPrefix: 'CW',
    skuSuffix: 'PAD',
    description: 'Luxury vinyl tile with factory-attached pad for floating installation.',
    construction: 'LVT Pad Attached',
  },
  {
    name: 'Citywide Q',
    slug: 'citywide-q',
    skuPrefix: 'CWQ',
    skuSuffix: 'P',
    description: 'Citywide Q series luxury vinyl tile.',
    construction: 'LVT',
  },
];

// Per-SKU image URL mapping — scraped from citywidelvt.com/products
// Each product line has its own set of images (different uploads per section).
// Key structure: IMAGE_MAPS[lineSlug][baseCode] = Squarespace CDN URL
const IMAGE_MAPS = {
  // Dryback section images
  'citywide-dryback': {
    '12001': 'https://images.squarespace-cdn.com/content/v1/5eb59f64eb3c5377ed0d9832/1591372994251-P9SL1BNLPUGPHRACLO16/CW12001+CITYWIDE+WILSHIRE+BOULEVARD+%281%29.jpg',
    '12002': 'https://images.squarespace-cdn.com/content/v1/5eb59f64eb3c5377ed0d9832/1591373159301-X1OPV44M5OSRGX4SZDZ6/CW12002+CITYWIDE+PARK+PLACE-Edit.jpg',
    '12003': 'https://images.squarespace-cdn.com/content/v1/5eb59f64eb3c5377ed0d9832/1591376170701-QG8WZN9BOTYMRWGO7022/CW12003+CITYWIDE+LAKESHORE+DRIVE-Edit.jpg',
    '12004': 'https://images.squarespace-cdn.com/content/v1/5eb59f64eb3c5377ed0d9832/1591384325989-SYUFVQ5P65Q625FAKZVX/CW12004+CITYWIDE+LASALLE+STREET.jpg',
    '12005': 'https://images.squarespace-cdn.com/content/v1/5eb59f64eb3c5377ed0d9832/1591384422815-UMCS6XA1NS0W7EUFDUHE/CW12005+CITYWID+LEXINGTON+STREET.jpg',
    '12006': 'https://images.squarespace-cdn.com/content/v1/5eb59f64eb3c5377ed0d9832/1591384569314-US4X9BZI906SVBS5AC18/CW12006+CITYWIDE+BEACON+AVENUE.jpg',
    '12007': 'https://images.squarespace-cdn.com/content/v1/5eb59f64eb3c5377ed0d9832/1591384691185-8U2XGD93A6DM2GA2LRRZ/CW12007+CITYWIDE+2nd+AVENUE-Edit.jpg',
    '12008': 'https://images.squarespace-cdn.com/content/v1/5eb59f64eb3c5377ed0d9832/1591384806622-NUAVIDZGUX8I98BL5MH2/CW12008+CITYWIDE+CENTRAL+AVENUE-Edit.jpg',
    '12011': 'https://images.squarespace-cdn.com/content/v1/5eb59f64eb3c5377ed0d9832/79b51bc2-8c79-427d-ae49-87e77ec8d523/CityWide__0002_Campus-Point.png',
    '12012': 'https://images.squarespace-cdn.com/content/v1/5eb59f64eb3c5377ed0d9832/a44568e4-bee0-4a00-b4d9-982bb11e3e0f/CityWide__0001_University-Ave.png',
    '12013': 'https://images.squarespace-cdn.com/content/v1/5eb59f64eb3c5377ed0d9832/9ec19ea9-4093-4215-9e64-6090e5683464/CityWide__0000_Union-Street.png',
    '12014': 'https://images.squarespace-cdn.com/content/v1/5eb59f64eb3c5377ed0d9832/3c75f0d3-6bf3-428d-b6a7-67047dd51c00/CityWide__0003_Sunset-Blvd.png',
  },
  // Pad Attached section images (distinct uploads from Dryback)
  'citywide-pad-attached': {
    '12001': 'https://images.squarespace-cdn.com/content/v1/5eb59f64eb3c5377ed0d9832/1687367929546-DE1J6CDGVDBOQ0OFYLTK/CW12001+CITYWIDE+WILSHIRE+BOULEVARD.jpg',
    '12002': 'https://images.squarespace-cdn.com/content/v1/5eb59f64eb3c5377ed0d9832/1687368180437-4IMA90PDAMIVIQAMSVIQ/CW12002+CITYWIDE+PARK+PLACE-Edit.jpg',
    '12003': 'https://images.squarespace-cdn.com/content/v1/5eb59f64eb3c5377ed0d9832/1687368246628-UWVQNE1E1BXCROUC9KH9/CW12003+CITYWIDE+LAKESHORE+DRIVE-Edit.jpg',
    '12004': 'https://images.squarespace-cdn.com/content/v1/5eb59f64eb3c5377ed0d9832/1687368344882-V61T13OKBM0NUVZ8VYO8/CW12004+CITYWIDE+LASALLE+STREET.jpg',
    '12005': 'https://images.squarespace-cdn.com/content/v1/5eb59f64eb3c5377ed0d9832/1687368426495-IOY2GMPDOXDILF2W2GXF/CW12005+CITYWID+LEXINGTON+STREET.jpg',
    '12006': 'https://images.squarespace-cdn.com/content/v1/5eb59f64eb3c5377ed0d9832/1687368689898-HOT1HB7S5XKQ95EJPFRA/CW12006+CITYWIDE+BEACON+AVENUE.jpg',
    '12007': 'https://images.squarespace-cdn.com/content/v1/5eb59f64eb3c5377ed0d9832/1687368597374-HHJSKPLZWH6Z348C3KLD/CW12007+CITYWIDE+2nd+AVENUE-Edit.jpg',
    '12008': 'https://images.squarespace-cdn.com/content/v1/5eb59f64eb3c5377ed0d9832/1687368776075-I94HUTIDC9CCOL0FWV22/CW12008+CITYWIDE+CENTRAL+AVENUE-Edit.jpg',
    '12011': 'https://images.squarespace-cdn.com/content/v1/5eb59f64eb3c5377ed0d9832/b793b4cf-8504-424d-ba10-ad167ae00d0e/CityWide__0002_Campus-Point.png',
    '12012': 'https://images.squarespace-cdn.com/content/v1/5eb59f64eb3c5377ed0d9832/22665258-089c-4b88-b6f1-58041c95f0db/CityWide__0001_University-Ave.png',
    '12013': 'https://images.squarespace-cdn.com/content/v1/5eb59f64eb3c5377ed0d9832/4e06e600-45e1-498a-9b3a-268a0b00b373/CityWide__0000_Union-Street.png',
    '12014': 'https://images.squarespace-cdn.com/content/v1/5eb59f64eb3c5377ed0d9832/0f7eca24-951d-4fb6-a547-5a7a9cc2526e/CityWide__0003_Sunset-Blvd.png',
  },
  // Q section reuses Dryback images (same Squarespace uploads)
  'citywide-q': null, // falls back to dryback
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build vendor SKU code from product line and color */
function buildVendorSku(line, color) {
  if (line.skuPrefix === 'CWQ') {
    return `CWQ${color.baseCode}P`;
  }
  return `CW${color.baseCode}${line.skuSuffix}`;
}

/** Build internal SKU for our database */
function makeInternalSku(vendorSku) {
  return `CW-${vendorSku}`;
}

// ---------------------------------------------------------------------------
// EDI 832 Parser (reused from triwest-832 pattern)
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

function parsePID(seg) {
  // PID02 (el[2]) = Product/Process Characteristic Code (TRN, MAC, 73, 35, 08, etc.)
  // PID04 (el[4]) = Product Description Code (often empty in Tri-West 832)
  const charCode = seg.el[2] || seg.el[4] || '';
  return {
    item_description_type: seg.el[1] || '',
    product_process_id: seg.el[2] || '',
    agency_code: seg.el[3] || '',
    characteristic_code: charCode,
    description: seg.el[5] || '',
    characteristic_label: PID_CODES[charCode] || charCode || null,
  };
}

function parseCTP(seg) {
  return {
    class_of_trade: seg.el[1] || '',
    price_type: seg.el[2] || '',
    unit_price: parseFloat(seg.el[3]) || null,
    quantity: parseFloat(seg.el[4]) || null,
    uom: seg.el[5] || '',
    price_multiplier_code: seg.el[6] || '',
    amount: parseFloat(seg.el[7]) || null,
    basis_code: seg.el[8] || '',
  };
}

function parseMEA(seg) {
  return {
    reference_code: seg.el[1] || '',
    qualifier: seg.el[2] || '',
    value: parseFloat(seg.el[3]) || null,
    uom: seg.el[4] || '',
    range_min: parseFloat(seg.el[5]) || null,
    range_max: parseFloat(seg.el[6]) || null,
  };
}

function parsePO4(seg) {
  return {
    pack: parseInt(seg.el[1]) || null,
    size: parseFloat(seg.el[2]) || null,
    uom: seg.el[3] || '',
    packaging_code: seg.el[4] || '',
    weight_qualifier: seg.el[5] || '',
    gross_weight: parseFloat(seg.el[6]) || null,
    weight_uom: seg.el[7] || '',
    volume: parseFloat(seg.el[8]) || null,
    volume_uom: seg.el[9] || '',
    length: parseFloat(seg.el[10]) || null,
    width: parseFloat(seg.el[11]) || null,
    height: parseFloat(seg.el[12]) || null,
    dim_uom: seg.el[13] || '',
    inner_pack: parseInt(seg.el[14]) || null,
  };
}

/**
 * Parse EDI 832 with SLN (sub-line) support.
 *
 * Citywide data uses LIN→SLN structure:
 *   LIN = product line header (pricing, packaging, measurements shared)
 *   SLN = individual color/SKU (has own SKU, UPC, color, dye code)
 *
 * We flatten SLN children into individual items, inheriting parent LIN data.
 */
function parse832(raw) {
  const segments = tokenizeSegments(raw);
  const catalog = {
    interchange: { sender_id: null, receiver_id: null },
    transaction: { type: null, control_number: null },
    items: [],
  };

  let currentLIN = null;   // Parent LIN context
  let currentSLN = null;   // Current SLN child
  let inSLN = false;

  function flushSLN() {
    if (currentSLN && currentLIN) {
      // Merge SLN child with parent LIN context
      currentSLN._parentLIN = currentLIN;
      catalog.items.push(currentSLN);
    }
    currentSLN = null;
  }

  function flushLIN() {
    flushSLN();
    // If LIN has no SLN children, push LIN itself
    if (currentLIN && !currentLIN._hasSLN) {
      catalog.items.push(currentLIN);
    }
    currentLIN = null;
    inSLN = false;
  }

  for (const segStr of segments) {
    const seg = parseSegment(segStr);

    switch (seg.id) {
      case 'ISA':
        catalog.interchange.sender_id = (seg.el[6] || '').trim();
        catalog.interchange.receiver_id = (seg.el[8] || '').trim();
        break;

      case 'ST':
        catalog.transaction.type = seg.el[1];
        catalog.transaction.control_number = seg.el[2];
        break;

      case 'LIN':
        flushLIN();
        currentLIN = {
          ...parseLIN(seg),
          descriptions: [], pricing: [], measurements: [],
          packaging: null, _hasSLN: false,
        };
        inSLN = false;
        break;

      case 'SLN': {
        flushSLN();
        inSLN = true;
        if (currentLIN) currentLIN._hasSLN = true;
        // Parse SLN identifiers (same qualifier pairs as LIN)
        const slnIdents = {};
        for (let i = 7; i < seg.el.length - 1; i += 2) {
          const qual = seg.el[i], val = seg.el[i + 1];
          if (qual && val) slnIdents[LIN_QUALIFIERS[qual] || qual.toLowerCase()] = val;
        }
        currentSLN = {
          identifiers: slnIdents,
          descriptions: [],
          sln_number: seg.el[1] || null,
        };
        break;
      }

      case 'PID':
        if (inSLN && currentSLN) {
          currentSLN.descriptions.push(parsePID(seg));
        } else if (currentLIN) {
          currentLIN.descriptions.push(parsePID(seg));
        }
        break;

      case 'CTP':
        if (currentLIN) currentLIN.pricing.push(parseCTP(seg));
        break;

      case 'MEA':
        if (currentLIN) currentLIN.measurements.push(parseMEA(seg));
        break;

      case 'PO4':
        if (currentLIN) currentLIN.packaging = parsePO4(seg);
        break;

      case 'SE':
      case 'GE':
      case 'IEA':
        flushLIN();
        break;
    }
  }

  flushLIN();

  // Post-process: extract fields (handles both LIN-only and SLN items)
  for (const item of catalog.items) {
    const parentLIN = item._parentLIN || item;

    // Vendor SKU: from SLN identifiers or LIN identifiers
    const idents = item.identifiers || {};
    const parentIdents = parentLIN.identifiers || {};

    item.vendor_sku = idents.sku || idents.vendor_item_number
      || parentIdents.vendor_item_number || parentIdents.sku || null;

    // Strip TDT prefix for matching (TDTCW12001 → CW12001)
    if (item.vendor_sku && item.vendor_sku.startsWith('TDT')) {
      item.vendor_sku_raw = item.vendor_sku;
      item.vendor_sku = item.vendor_sku.slice(3);
    }

    item.upc = idents.upc || parentIdents.upc || null;
    item.brand = parentIdents.manufacturer_brand || idents.manufacturer_brand || null;

    // Product name from parent LIN TRN
    const allDescs = [...(parentLIN.descriptions || []), ...(item.descriptions || [])];
    const trnPid = allDescs.find(d => d.characteristic_label === 'trade_name');
    item.product_name = trnPid ? trnPid.description.trim() : null;

    // Color from SLN PID 73 (or LIN)
    const slnDescs = item.descriptions || [];
    const colorPid = slnDescs.find(d => d.characteristic_label === 'color')
      || allDescs.find(d => d.characteristic_label === 'color');
    item.color = colorPid ? colorPid.description.trim() : null;

    // Dye code from PID 35 (CW12001, CW12002, etc.)
    const dyePid = slnDescs.find(d => d.characteristic_code === '35')
      || allDescs.find(d => d.characteristic_code === '35');
    item.dye_code = dyePid ? dyePid.description.trim() : null;

    // Cross-references from PID 08
    item.cross_refs = slnDescs
      .filter(d => d.characteristic_code === '08')
      .map(d => d.description.trim());

    // Material class from parent
    const macPid = allDescs.find(d => d.characteristic_label === 'material_class');
    item.material_class = macPid ? macPid.description.trim() : null;

    // Category
    const genPid = allDescs.find(d => d.characteristic_label === 'category');
    item.category = genPid ? genPid.description.trim() : null;

    // Construction from material class
    const constructionMap = {
      VINLVP: 'Luxury Vinyl Plank', VINTIL: 'Luxury Vinyl', VINTILR: 'Luxury Vinyl',
      VINPLK: 'Luxury Vinyl Plank', VINSPC: 'SPC', VINWPC: 'WPC',
      VINMIS: 'Transition', VINMISR: 'Transition', VINMISC: 'Transition',
    };
    item.construction = item.material_class ? (constructionMap[item.material_class] || null) : null;

    // Pricing from parent LIN
    const pricing = parentLIN.pricing || [];
    const lprPrices = pricing.filter(p => p.price_type === 'LPR');
    if (lprPrices.length > 0) {
      const ctPrice = lprPrices.find(p => p.basis_code === 'CT');
      const stPrice = lprPrices.find(p => p.basis_code === 'ST');
      item.cost = ctPrice?.unit_price || lprPrices[0]?.unit_price || null;
      item.retail_price = stPrice?.unit_price || item.cost;
    }
    const mapPrice = pricing.find(p => p.price_type === 'MAP');
    item.map_price = mapPrice?.unit_price || null;

    // Packaging from parent LIN
    const measurements = parentLIN.measurements || [];
    const suMea = measurements.find(m => m.qualifier === 'SU');
    if (suMea && suMea.value) {
      const uom = (suMea.uom || '').toUpperCase();
      item.sqft_per_box = uom === 'SY' ? Math.round(suMea.value * 9 * 100) / 100 : suMea.value;
    } else {
      item.sqft_per_box = null;
    }

    const packaging = parentLIN.packaging;
    item.pieces_per_box = packaging?.inner_pack || packaging?.pack || null;

    const swMea = measurements.find(m => m.qualifier === 'SW');
    item.weight_per_box_lbs = swMea?.value || packaging?.gross_weight || null;

    // Sell by
    const uomHint = lprPrices[0]?.uom || suMea?.uom || '';
    item.sell_by = /^(EA|PC|LF)$/i.test(uomHint) ? 'unit' : 'box';

    // Detect accessories
    item.is_accessory = /accessory|trim|molding|transition|reducer|stairnose|quarter|threshold|end.?cap|t.?mold/i
      .test(item.category || '') || /accessory|trim|molding|transition|reducer|stairnose|quarter|threshold|end.?cap|t.?mold/i
      .test(item.product_name || '');
  }

  return catalog;
}

// ---------------------------------------------------------------------------
// FTP Download — only CFL brand items from Tri-West 832
// ---------------------------------------------------------------------------
async function download832Files(localFile) {
  if (localFile) {
    if (fs.statSync(localFile).isDirectory()) {
      return fs.readdirSync(localFile)
        .filter(f => f.endsWith('.832'))
        .map(f => path.join(localFile, f));
    }
    return [localFile];
  }

  const ftp = new FtpClient();
  ftp.ftp.verbose = false;
  const localFiles = [];
  const tmpDir = '/tmp/citywide_832';
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  try {
    await ftp.access({
      host: FTP_CONFIG.host,
      port: FTP_CONFIG.port,
      user: FTP_CONFIG.user,
      password: FTP_CONFIG.password,
      secure: false,
    });
    console.log('Connected to Tri-West FTP');

    const listing = await ftp.list(REMOTE_DIR);
    const ediFiles = listing
      .filter(f => f.name.endsWith('.832') || f.name.includes('832'))
      .sort((a, b) => (b.modifiedAt || 0) - (a.modifiedAt || 0));

    console.log(`Found ${ediFiles.length} 832 file(s) in ${REMOTE_DIR}`);

    for (const file of ediFiles.slice(0, 5)) {
      const localPath = path.join(tmpDir, file.name);
      if (fs.existsSync(localPath)) {
        localFiles.push(localPath);
        continue;
      }

      console.log(`  Downloading: ${file.name} (${(file.size / 1024).toFixed(1)} KB)`);
      const chunks = [];
      const writable = new Writable({
        write(chunk, _enc, cb) { chunks.push(chunk); cb(); },
      });
      await ftp.downloadTo(writable, `${REMOTE_DIR}/${file.name}`);
      fs.writeFileSync(localPath, Buffer.concat(chunks));
      localFiles.push(localPath);
    }
  } catch (err) {
    console.error('FTP error:', err.message);
  } finally {
    ftp.close();
  }

  return localFiles;
}

// ---------------------------------------------------------------------------
// Extract CFL (Citywide) items from parsed 832 data
// ---------------------------------------------------------------------------
function filterCitywideItems(catalog) {
  return catalog.items.filter(item => {
    const sku = (item.vendor_sku || '').toUpperCase();
    const rawSku = (item.vendor_sku_raw || '').toUpperCase();
    const name = (item.product_name || '').toUpperCase();
    // After TDT strip, Citywide SKUs start with CW (CW12001, CW12001PAD, CWQ12001P)
    // Don't match on brand alone — TRIDENT INDUSTRY also makes non-Citywide items (FSN, SUC)
    return name.includes('CITYWIDE')
      || sku.startsWith('CW')
      || rawSku.startsWith('TDTCW') || rawSku.startsWith('TDTCTY');
  });
}

// ---------------------------------------------------------------------------
// Database import
// ---------------------------------------------------------------------------
async function ensureVendor() {
  const existing = await pool.query('SELECT id FROM vendors WHERE code = $1', [VENDOR_CODE]);
  if (existing.rows.length > 0) {
    console.log(`Vendor "${VENDOR_NAME}" exists (${existing.rows[0].id})`);
    return existing.rows[0].id;
  }
  const result = await pool.query(
    `INSERT INTO vendors (name, code, website, is_active)
     VALUES ($1, $2, $3, true) RETURNING id`,
    [VENDOR_NAME, VENDOR_CODE, VENDOR_WEBSITE]
  );
  console.log(`Created vendor "${VENDOR_NAME}" (${result.rows[0].id})`);
  return result.rows[0].id;
}

async function getCategoryId(slug) {
  const res = await pool.query('SELECT id FROM categories WHERE slug = $1', [slug]);
  return res.rows[0]?.id || null;
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

async function upsertMediaAsset(productId, skuId, url, assetType = 'primary') {
  const existing = await pool.query(
    'SELECT id FROM media_assets WHERE sku_id = $1 AND asset_type = $2 AND sort_order = 0',
    [skuId, assetType]
  );
  if (existing.rows.length > 0) {
    await pool.query(
      'UPDATE media_assets SET url = $1 WHERE id = $2',
      [url, existing.rows[0].id]
    );
  } else {
    await pool.query(
      `INSERT INTO media_assets (product_id, sku_id, url, asset_type, sort_order, source)
       VALUES ($1, $2, $3, $4, 0, 'scraper')`,
      [productId, skuId, url, assetType]
    );
  }
}

async function importProducts(vendorId, edi832Map, dryRun = false) {
  const lvtCategoryId = await getCategoryId('luxury-vinyl');
  const transitionsCategoryId = await getCategoryId('transitions-moldings');

  const stats = {
    products_created: 0, products_updated: 0,
    skus_created: 0, skus_updated: 0,
    pricing_upserted: 0, packaging_upserted: 0,
    attributes_upserted: 0, images_upserted: 0,
    accessories_created: 0,
  };

  // ------------------------------------------------------------------
  // Part 1: Main products (3 lines × 12 colors)
  // ------------------------------------------------------------------
  for (const line of PRODUCT_LINES) {
    console.log(`\n── ${line.name} ──`);

    // Pad Attached has 2 extra colors only found in 832 data
    const lineColors = line.slug === 'citywide-pad-attached'
      ? [...COLORS, ...PAD_EXTRA_COLORS]
      : COLORS;

    // Upsert product record
    let productId;
    const existingProduct = await pool.query(
      'SELECT id FROM products WHERE vendor_id = $1 AND name = $2',
      [vendorId, line.name]
    );

    if (existingProduct.rows.length > 0) {
      productId = existingProduct.rows[0].id;
      await pool.query(`
        UPDATE products SET category_id = COALESCE($1, category_id),
          collection = 'Citywide', status = 'active',
          description_short = $2, updated_at = NOW()
        WHERE id = $3
      `, [lvtCategoryId, line.description, productId]);
      stats.products_updated++;
      console.log(`  Updated product: ${line.name}`);
    } else if (!dryRun) {
      const pResult = await pool.query(`
        INSERT INTO products (vendor_id, name, slug, collection, category_id, status,
          description_short, description_long)
        VALUES ($1, $2, $3, 'Citywide', $4, 'active', $5, $6)
        RETURNING id
      `, [vendorId, line.name, line.slug, lvtCategoryId, line.description,
          `${line.description} Available in ${lineColors.length} wood-look colors.`]);
      productId = pResult.rows[0].id;
      stats.products_created++;
      console.log(`  Created product: ${line.name}`);
    }

    if (!productId) continue;

    for (const color of lineColors) {
      const vendorSku = buildVendorSku(line, color);
      const internalSku = makeInternalSku(vendorSku);
      const ediData = edi832Map.get(vendorSku.toUpperCase()) || null;

      let skuId;
      const existingSku = await pool.query(
        'SELECT id FROM skus WHERE internal_sku = $1',
        [internalSku]
      );

      const sellBy = ediData?.sell_by || 'box';
      const variantName = color.name;

      if (existingSku.rows.length > 0) {
        skuId = existingSku.rows[0].id;
        if (!dryRun) {
          await pool.query(`
            UPDATE skus SET product_id = $1, vendor_sku = $2, variant_name = $3,
              sell_by = $4, status = 'active', updated_at = NOW()
            WHERE id = $5
          `, [productId, vendorSku, variantName, sellBy, skuId]);
        }
        stats.skus_updated++;
      } else if (!dryRun) {
        const sResult = await pool.query(`
          INSERT INTO skus (product_id, vendor_sku, internal_sku, variant_name, sell_by, status)
          VALUES ($1, $2, $3, $4, $5, 'active')
          RETURNING id
        `, [productId, vendorSku, internalSku, variantName, sellBy]);
        skuId = sResult.rows[0].id;
        stats.skus_created++;
      }

      if (!skuId || dryRun) {
        console.log(`  [${dryRun ? 'DRY' : 'SKIP'}] ${vendorSku} — ${color.name}`);
        continue;
      }

      // Assign per-SKU image from website (each line has its own image set)
      const lineImages = IMAGE_MAPS[line.slug] || IMAGE_MAPS['citywide-dryback'];
      const imageUrl = lineImages[color.baseCode];
      if (imageUrl) {
        await upsertMediaAsset(productId, skuId, imageUrl, 'primary');
        stats.images_upserted++;
      }

      // Enrich from 832 data if available
      if (ediData) {
        // Pricing
        if (ediData.cost || ediData.retail_price) {
          const priceBasis = sellBy === 'box' ? 'per_sqft' : 'per_unit';
          const cost = ediData.cost || 0;
          const retail = ediData.map_price
            || ((ediData.retail_price && ediData.retail_price !== ediData.cost)
              ? ediData.retail_price : null)
            || Math.round(cost * 2 * 100) / 100;
          await pool.query(`
            INSERT INTO pricing (sku_id, cost, retail_price, map_price, price_basis)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (sku_id) DO UPDATE SET cost = $2, retail_price = $3,
              map_price = COALESCE($4, pricing.map_price), price_basis = $5
          `, [skuId, cost, retail, ediData.map_price, priceBasis]);
          stats.pricing_upserted++;
        }

        // Packaging
        if (ediData.sqft_per_box || ediData.pieces_per_box || ediData.weight_per_box_lbs) {
          await pool.query(`
            INSERT INTO packaging (sku_id, sqft_per_box, pieces_per_box, weight_per_box_lbs)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (sku_id) DO UPDATE SET
              sqft_per_box = COALESCE($2, packaging.sqft_per_box),
              pieces_per_box = COALESCE($3, packaging.pieces_per_box),
              weight_per_box_lbs = COALESCE($4, packaging.weight_per_box_lbs)
          `, [skuId, ediData.sqft_per_box, ediData.pieces_per_box, ediData.weight_per_box_lbs]);
          stats.packaging_upserted++;
        }

        // Attributes from 832
        if (ediData.color) { await upsertSkuAttribute(skuId, 'color', ediData.color); stats.attributes_upserted++; }
        if (ediData.construction) { await upsertSkuAttribute(skuId, 'construction', ediData.construction); stats.attributes_upserted++; }
        if (ediData.material_class) { await upsertSkuAttribute(skuId, 'material_class', ediData.material_class); stats.attributes_upserted++; }
        if (ediData.finish) { await upsertSkuAttribute(skuId, 'finish', ediData.finish); stats.attributes_upserted++; }
        if (ediData.thickness) { await upsertSkuAttribute(skuId, 'thickness', ediData.thickness); stats.attributes_upserted++; }
        if (ediData.wear_layer) { await upsertSkuAttribute(skuId, 'wear_layer', ediData.wear_layer); stats.attributes_upserted++; }
        if (ediData.width) { await upsertSkuAttribute(skuId, 'width', ediData.width); stats.attributes_upserted++; }
        if (ediData.length) { await upsertSkuAttribute(skuId, 'length', ediData.length); stats.attributes_upserted++; }
        if (ediData.upc) { await upsertSkuAttribute(skuId, 'upc', ediData.upc); stats.attributes_upserted++; }
      }

      // Always set brand + construction attributes even without 832
      await upsertSkuAttribute(skuId, 'brand', 'Citywide');
      await upsertSkuAttribute(skuId, 'construction', ediData?.construction || line.construction);
      stats.attributes_upserted += 2;

      const suffix = ediData
        ? ` (cost=$${ediData.cost || '?'}, ${ediData.sqft_per_box || '?'} SF/box)`
        : ' (no 832 data)';
      console.log(`  ${vendorSku} — ${color.name}${suffix}`);
    }
  }

  // ------------------------------------------------------------------
  // Part 2: Accessories from 832 data
  // ------------------------------------------------------------------
  const accessoryItems = [...edi832Map.values()].filter(item => item.is_accessory);
  if (accessoryItems.length > 0) {
    console.log(`\n── Accessories (${accessoryItems.length} items) ──`);

    // Group accessories by product name
    const accGroups = new Map();
    for (const item of accessoryItems) {
      const groupKey = item.product_name || item.vendor_sku;
      if (!accGroups.has(groupKey)) {
        accGroups.set(groupKey, []);
      }
      accGroups.get(groupKey).push(item);
    }

    for (const [groupName, items] of accGroups) {
      // Create accessory product
      let productId;
      const accProductName = `Citywide ${titleCase(groupName)}`;
      const existingProduct = await pool.query(
        'SELECT id FROM products WHERE vendor_id = $1 AND name = $2',
        [vendorId, accProductName]
      );

      if (existingProduct.rows.length > 0) {
        productId = existingProduct.rows[0].id;
        stats.products_updated++;
      } else if (!dryRun) {
        const slug = accProductName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        const pResult = await pool.query(`
          INSERT INTO products (vendor_id, name, slug, collection, category_id, status,
            description_short)
          VALUES ($1, $2, $3, 'Citywide', $4, 'active', $5)
          RETURNING id
        `, [vendorId, accProductName, slug, transitionsCategoryId,
            `Matching transition/molding for Citywide LVT flooring.`]);
        productId = pResult.rows[0].id;
        stats.products_created++;
      }

      if (!productId) continue;

      for (const item of items) {
        const internalSku = makeInternalSku(item.vendor_sku);
        const sellBy = item.sell_by || 'unit';

        let skuId;
        const existingSku = await pool.query('SELECT id FROM skus WHERE internal_sku = $1', [internalSku]);

        if (existingSku.rows.length > 0) {
          skuId = existingSku.rows[0].id;
          if (!dryRun) {
            await pool.query(`
              UPDATE skus SET product_id = $1, vendor_sku = $2, variant_name = $3,
                sell_by = $4, variant_type = 'accessory', status = 'active', updated_at = NOW()
              WHERE id = $5
            `, [productId, item.vendor_sku, titleCase(item.color || item.product_name), sellBy, skuId]);
          }
          stats.skus_updated++;
        } else if (!dryRun) {
          const sResult = await pool.query(`
            INSERT INTO skus (product_id, vendor_sku, internal_sku, variant_name, sell_by,
              variant_type, status)
            VALUES ($1, $2, $3, $4, $5, 'accessory', 'active')
            RETURNING id
          `, [productId, item.vendor_sku, internalSku,
              titleCase(item.color || item.product_name), sellBy]);
          skuId = sResult.rows[0].id;
          stats.skus_created++;
          stats.accessories_created++;
        }

        if (!skuId || dryRun) continue;

        // Pricing
        if (item.cost || item.retail_price) {
          const priceBasis = sellBy === 'box' ? 'per_sqft' : 'per_unit';
          const cost = item.cost || 0;
          const retail = item.map_price || item.retail_price || Math.round(cost * 2 * 100) / 100;
          await pool.query(`
            INSERT INTO pricing (sku_id, cost, retail_price, map_price, price_basis)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (sku_id) DO UPDATE SET cost = $2, retail_price = $3,
              map_price = COALESCE($4, pricing.map_price), price_basis = $5
          `, [skuId, cost, retail, item.map_price, priceBasis]);
          stats.pricing_upserted++;
        }

        // Packaging
        if (item.sqft_per_box || item.pieces_per_box) {
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

        await upsertSkuAttribute(skuId, 'brand', 'Citywide');
        stats.attributes_upserted++;
        console.log(`  ACC: ${item.vendor_sku} — ${item.color || item.product_name} (cost=$${item.cost || '?'})`);
      }
    }
  }

  return stats;
}

function titleCase(str) {
  if (!str) return '';
  return str.split(/\s+/).map((w, i) => {
    if (w.length <= 1) return w.toUpperCase();
    return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  }).join(' ');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const scrapeOnly = args.includes('--scrape-only');
  const edi832Only = args.includes('--832-only');
  const fileIdx = args.indexOf('--file');
  const localFile = fileIdx !== -1 ? args[fileIdx + 1] : null;

  console.log('=== Citywide LVT — Scraper + EDI 832 Import ===\n');
  console.log(`Product lines: ${PRODUCT_LINES.length}`);
  console.log(`Colors: ${COLORS.length}`);
  console.log(`Total main SKUs: ${PRODUCT_LINES.length * COLORS.length}`);

  // Step 1: Parse 832 data (unless --scrape-only)
  const edi832Map = new Map();

  if (!scrapeOnly) {
    console.log('\n── Downloading & parsing EDI 832 data ──');
    const files = await download832Files(localFile);
    console.log(`Downloaded ${files.length} 832 file(s)`);

    let totalCflItems = 0;
    let totalAccessories = 0;

    for (const filePath of files) {
      console.log(`\nParsing: ${path.basename(filePath)}`);
      const raw = fs.readFileSync(filePath, 'utf-8');
      const catalog = parse832(raw);
      console.log(`  Total items: ${catalog.items.length}`);

      const cflItems = filterCitywideItems(catalog);
      console.log(`  CFL (Citywide) items: ${cflItems.length}`);

      for (const item of cflItems) {
        const key = (item.vendor_sku || '').toUpperCase();
        if (key && !edi832Map.has(key)) {
          edi832Map.set(key, item);
          if (item.is_accessory) totalAccessories++;
        }
      }
      totalCflItems += cflItems.length;
    }

    console.log(`\n── 832 Summary ──`);
    console.log(`Total CFL items found: ${totalCflItems}`);
    console.log(`Unique SKUs mapped: ${edi832Map.size}`);
    console.log(`Accessories: ${totalAccessories}`);
    console.log(`With pricing: ${[...edi832Map.values()].filter(i => i.cost).length}`);
    console.log(`With packaging: ${[...edi832Map.values()].filter(i => i.sqft_per_box).length}`);

    // Show sample
    if (edi832Map.size > 0) {
      console.log('\nSample 832 items:');
      let shown = 0;
      for (const [sku, item] of edi832Map) {
        if (shown >= 3) break;
        console.log(`  ${sku}: ${item.product_name || '?'} / ${item.color || '?'} — cost=$${item.cost || '?'}, ${item.sqft_per_box || '?'} SF/box`);
        shown++;
      }
    }
  }

  if (edi832Only) {
    console.log('\n[832-only mode] Skipping website scrape.');
    await pool.end();
    return;
  }

  // Step 2: Import to database
  if (dryRun) {
    console.log('\n[DRY RUN] No database writes will be performed.');
  }

  console.log('\n── Importing to Database ──');
  const vendorId = await ensureVendor();
  const stats = await importProducts(vendorId, edi832Map, dryRun);

  console.log('\n── Import Complete ──');
  console.log(`  Products created:    ${stats.products_created}`);
  console.log(`  Products updated:    ${stats.products_updated}`);
  console.log(`  SKUs created:        ${stats.skus_created}`);
  console.log(`  SKUs updated:        ${stats.skus_updated}`);
  console.log(`  Pricing upserted:    ${stats.pricing_upserted}`);
  console.log(`  Packaging upserted:  ${stats.packaging_upserted}`);
  console.log(`  Attributes upserted: ${stats.attributes_upserted}`);
  console.log(`  Images upserted:     ${stats.images_upserted}`);
  console.log(`  Accessories created: ${stats.accessories_created}`);

  await pool.end();
}

main().catch(err => {
  console.error('Fatal error:', err);
  pool.end();
  process.exit(1);
});
