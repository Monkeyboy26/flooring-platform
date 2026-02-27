/**
 * Shaw Floors — EDI 832 SFTP Importer
 *
 * Connects to shawedi.shawfloors.com via SFTP, downloads the latest 832
 * (Price/Sales Catalog) file, parses EDI segments, and upserts
 * products/SKUs/pricing/packaging/attributes into the database.
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
  'carpet':              'carpet-tile',
  'carpet tile':         'carpet-tile',
  'broadloom':           'carpet-tile',
  'tuftex':              'carpet-tile',
  'anso nylon':          'carpet-tile',
  'caress':              'carpet-tile',
  'lifeguard':           'carpet-tile',
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

// PID characteristic codes → human-readable
const PID_CODES = {
  '08': 'description',
  GEN: 'category',
  '09': 'sub_product',
  '73': 'color',
  '74': 'pattern',
  '75': 'finish',
  '35': 'species',
  '37': 'material',
  '38': 'style',
  DIM: 'dimensions',
  MAC: 'material_class',
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
  const catalog = { items: [], summary: { total_items: 0, segment_count: segments.length } };
  let currentItem = null;

  for (const seg of segments) {
    switch (seg.id) {
      case 'LIN': {
        if (currentItem) { finalizeItem(currentItem); catalog.items.push(currentItem); }
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
      case 'PO4': { if (currentItem) currentItem.packaging = parsePO4(seg); break; }
      case 'CTP': { if (currentItem) currentItem.pricing.push(parseCTP(seg)); break; }
      case 'PID': { if (currentItem) currentItem.descriptions.push(parsePID(seg)); break; }
      case 'MEA': { if (currentItem) currentItem.measurements.push(parseMEA(seg)); break; }
      case 'G39': {
        if (currentItem) {
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
      case 'CTT': case 'SE': {
        if (currentItem) { finalizeItem(currentItem); catalog.items.push(currentItem); currentItem = null; }
        if (seg.id === 'CTT') catalog.summary.total_items = seg.el[1] ? parseInt(seg.el[1], 10) : catalog.items.length;
        break;
      }
      default: break;
    }
  }

  if (currentItem) { finalizeItem(currentItem); catalog.items.push(currentItem); }
  if (!catalog.summary.total_items) catalog.summary.total_items = catalog.items.length;
  return catalog;
}

function finalizeItem(item) {
  item.vendor_sku = item.identifiers.vendor_item_number || item.identifiers.model_number || item.identifiers.sku || item.identifiers.part_number || null;
  item.upc = item.identifiers.upc || null;

  const descPid = item.descriptions.find(d => d.characteristic_code === '08') || item.descriptions.find(d => d.description_type === 'F');
  item.product_name = descPid ? descPid.description : null;

  const colorPid = item.descriptions.find(d => d.characteristic_label === 'color');
  item.color = colorPid ? colorPid.description : null;

  const collPid = item.descriptions.find(d => d.characteristic_label === 'collection');
  item.collection = collPid ? collPid.description : null;

  const catPid = item.descriptions.find(d => d.characteristic_label === 'category' || d.characteristic_code === 'GEN');
  item.category = catPid ? catPid.description : null;

  // Packaging
  if (item.packaging) {
    const uom = (item.packaging.unit_of_measure || '').toUpperCase();
    if (uom === 'SF' || uom === 'SY' || uom === 'FT2') { item.sqft_per_box = item.packaging.size_per_pack; item.sell_by = 'sqft'; }
    else if (uom === 'EA' || uom === 'PC') { item.sell_by = 'unit'; }
    else if (uom === 'LF') { item.sell_by = 'unit'; }
    else if (item.packaging.size_per_pack) { item.sqft_per_box = item.packaging.size_per_pack; item.sell_by = 'sqft'; }
    item.pieces_per_box = item.packaging.pieces_per_pack || null;
    item.weight_per_box_lbs = item.packaging.gross_weight || null;
  }

  // Pricing — cost (wholesale net) and retail (MSRP)
  const netPrice = item.pricing.find(p => p.price_type === 'NET') || item.pricing.find(p => p.class_of_trade === 'WS') || item.pricing.find(p => p.class_of_trade === 'DE') || item.pricing[0];
  if (netPrice) { item.cost = netPrice.unit_price; item.unit_of_measure = netPrice.unit_of_measure || item.unit_of_measure; }

  const retailPrice = item.pricing.find(p => p.price_type === 'MSR') || item.pricing.find(p => p.class_of_trade === 'RS') || item.pricing.find(p => p.price_type === 'CAT');
  if (retailPrice) item.retail_price = retailPrice.unit_price;

  const mapPrice = item.pricing.find(p => p.price_type === 'MAP');
  if (mapPrice) item.map_price = mapPrice.unit_price;

  if (!item.sell_by && item.unit_of_measure) {
    const puom = item.unit_of_measure.toUpperCase();
    if (puom === 'SF' || puom === 'SY') item.sell_by = 'sqft';
    else if (puom === 'EA' || puom === 'PC') item.sell_by = 'unit';
  }

  // Carpet pricing: extract cut (MSRP/retail) and roll (contract/volume) prices
  const isCarpetCat = /carpet|broadloom|tuftex|caress|anso/i.test(item.category || '');
  if (isCarpetCat && item.pricing.length > 0) {
    const msrpPrice = item.pricing.find(p => p.price_type === 'MSR') || item.pricing.find(p => p.class_of_trade === 'RS');
    const contractPrice = item.pricing.find(p => p.price_type === 'CON') || item.pricing.find(p => p.class_of_trade === 'CT');

    if (msrpPrice) item.cut_price = msrpPrice.unit_price;
    if (contractPrice) item.roll_price = contractPrice.unit_price;

    if (item.cut_price && !item.roll_price) item.roll_price = item.cut_price;
    if (item.roll_price && !item.cut_price) item.cut_price = item.roll_price;

    const cutCostPrice = item.pricing.find(p => p.price_type === 'NET') || item.pricing.find(p => p.class_of_trade === 'WS');
    const rollCostPrice = item.pricing.find(p => p.class_of_trade === 'DI') || item.pricing.find(p => p.class_of_trade === 'DE');

    if (cutCostPrice) item.cut_cost = cutCostPrice.unit_price;
    if (rollCostPrice) item.roll_cost = rollCostPrice.unit_price;
    if (item.cut_cost && !item.roll_cost) item.roll_cost = item.cut_cost;
    if (item.roll_cost && !item.cut_cost) item.cut_cost = item.roll_cost;

    // Roll width from measurements
    const widthMea = item.measurements.find(m => m.qualifier === 'WD');
    if (widthMea && widthMea.value) {
      const w = widthMea.value;
      const uom = (widthMea.unit_of_measure || '').toUpperCase();
      item.roll_width_ft = (uom === 'IN' || w > 24) ? w / 12 : w;
    }

    // Roll min sqft
    if (item.roll_width_ft && item.packaging && item.packaging.size_per_pack) {
      const uom = (item.packaging.unit_of_measure || '').toUpperCase();
      if (uom === 'LF' || uom === 'FT') {
        item.roll_min_sqft = item.roll_width_ft * item.packaging.size_per_pack;
      }
    }
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
// Product grouping
// ---------------------------------------------------------------------------

function groupIntoProducts(items) {
  const products = new Map();

  for (const item of items) {
    if (!item.vendor_sku && !item.product_name) continue;

    const collection = item.collection || '';
    const category = item.category || '';
    const isAccessory = /accessory|trim|molding|transition|reducer|stairnose|t-bar|quarter.round|threshold/i.test(category)
      || /accessory|trim|molding|transition|reducer|stairnose|t-bar|quarter.round|threshold/i.test(item.product_name || '');

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
