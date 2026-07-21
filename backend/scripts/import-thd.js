#!/usr/bin/env node
/**
 * THD (Total Home Distributors) — Hybrid PDF + Shopify Importer
 *
 * Sources:
 *   1. Quarterly PDF price list — pricing, packaging, status data (~600+ SKUs)
 *   2. Shopify website (thdistributors.com) — product images, structured variant options
 *
 * PDF format (tab-separated table with columns):
 *   Image | Item Code | Description | Size | Color | Finish | SF/BX | SF/EA | EA/BX | BX/PLT | LBS/EA | LBS/BX | THICKNESS(mm) | UOM | PRICE | STATUS
 *   Collection headers appear in column header rows (e.g., "Image \tItem code \tAMALFI \tSize \t...")
 *   Item codes follow the pattern: THD####-#####[A-Z]?  (e.g., THD0114-00001, THD0015-00036N)
 *
 * Shopify JSON API (no auth required):
 *   GET /products.json?limit=250 → products with variants, images, options
 *   Variant SKUs match PDF item codes (THD####-#####)
 *   Images with variant_ids → SKU-level primary; without → color-matched to SKUs
 *
 * Usage:
 *   docker compose exec api node scripts/import-thd.js
 *   docker compose exec api node scripts/import-thd.js data/thd-q3-2026.pdf
 */

import pg from 'pg';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: 5432, database: 'flooring_pim', user: 'postgres', password: 'postgres',
});

// ─── Category IDs ───
const CAT = {
  porcelain:    '650e8400-e29b-41d4-a716-446655440012',
  ceramic:      '650e8400-e29b-41d4-a716-446655440013',
  naturalStone: '650e8400-e29b-41d4-a716-446655440011',
  mosaic:       '650e8400-e29b-41d4-a716-446655440014',
  stackedStone: '650e8400-e29b-41d4-a716-446655440061',
  pavers:       '650e8400-e29b-41d4-a716-446655440062',
  largeFormat:  '650e8400-e29b-41d4-a716-446655440016',
  backsplash:   '650e8400-e29b-41d4-a716-446655440051',
};

// ─── Attribute IDs ───
const ATTR = {
  color:     'd50e8400-e29b-41d4-a716-446655440001',
  material:  'd50e8400-e29b-41d4-a716-446655440002',
  finish:    'd50e8400-e29b-41d4-a716-446655440003',
  size:      'd50e8400-e29b-41d4-a716-446655440004',
  thickness: 'd50e8400-e29b-41d4-a716-446655440010',
};

const MARKUP = 1.6;
const SHOPIFY_DOMAIN = 'thdistributors.com';
const FETCH_DELAY_MS = 500;

// ─── Category mapping from collection name ───
function getCategoryId(collectionName) {
  const c = (collectionName || '').toUpperCase();
  if (c.includes('MARBLE') || c.includes('AURORA') || c.includes('EXOTIC STONE') ||
      c.includes('SELECT WHITE')) return CAT.naturalStone;
  if (c.includes('LIMESTONE') || c.includes('ALOHA') || c.includes('JERUSALEM')) return CAT.naturalStone;
  if (c.includes('TRAVERTINE')) return CAT.naturalStone;
  if (c.includes('ONIX') || c.includes('VIDROFINA') || c.includes('GLASS MOSAIC') ||
      c.includes('MOSAIC')) return CAT.mosaic;
  if (c.includes('LEDGESTONE') || c.includes('LEDGER') || c.includes('STACKED')) return CAT.stackedStone;
  if (c.includes('PAVER')) return CAT.pavers;
  return CAT.porcelain;
}

// ─── Derive material name from collection ───
function deriveMaterial(collectionName) {
  const c = (collectionName || '').toUpperCase();
  if (c.includes('MARBLE')) return 'Marble';
  if (c.includes('LIMESTONE') || c.includes('ALOHA') || c.includes('JERUSALEM')) return 'Limestone';
  if (c.includes('TRAVERTINE')) return 'Travertine';
  if (c.includes('GLASS')) return 'Glass';
  if (c.includes('MOSAIC')) return 'Mosaic';
  if (c.includes('LEDGESTONE') || c.includes('LEDGER')) return 'Stone Veneer';
  return 'Porcelain';
}

// ─── Title-case helper ───
function titleCase(str) {
  if (!str) return '';
  return str.toLowerCase().replace(/(?:^|\s)\S/g, c => c.toUpperCase())
    .replace(/\bOf\b/g, 'of').replace(/\bAnd\b/g, 'and')
    .replace(/\bDe\b/g, 'de').replace(/\bDi\b/g, 'di');
}

// ─── Status mapping ───
function mapStatus(flags) {
  const f = (flags || '').toUpperCase();
  if (f.includes('DISCONTINUED') || f.includes('PRE DROP') || f.includes('PREDROP')) return 'inactive';
  return 'active';
}

// ─── Detect trim/accessory from description ───
function formatVariantName(name) {
  if (!name) return name;
  // Title case: "24X48 / SILVER / MATTE" → "24x48 / Silver / Matte"
  let formatted = name.replace(/\b([A-Z])([A-Z]+)\b/g,
    (_, first, rest) => first + rest.toLowerCase());
  // Lowercase dimension separators: "2X8" → "2x8", "24X48" → "24x48"
  formatted = formatted.replace(/(\d)X(\d)/g, '$1x$2');
  // First " / " → space (keeps dimension+color together for storefront parsing)
  formatted = formatted.replace(' / ', ' ');
  // Remaining " / " → ", "
  formatted = formatted.replace(/ \/ /g, ', ');
  return formatted;
}

// Known Shopify typos (applied to both color attributes and variant names)
const TYPO_FIXES = [
  [/\bQUITE MOMENTS\b/gi, 'QUIET MOMENTS'],
];

function fixColor(color) {
  if (!color) return color;
  for (const [re, replacement] of TYPO_FIXES) {
    color = color.replace(re, replacement);
  }
  return color;
}

function fixTypos(str) {
  if (!str) return str;
  for (const [re, replacement] of TYPO_FIXES) {
    str = str.replace(re, replacement);
  }
  return str;
}

function isTrimItem(desc) {
  const d = (desc || '').toUpperCase();
  return d.includes('BULLNOSE') || d.includes('PENCIL') || d.includes('COVE') ||
    d.includes('V-CAP') || d.includes('QUARTER ROUND') || d.includes('CHAIR RAIL') ||
    d.includes('TRIM') || d.includes('MOLDING') || d.includes('LISTELLO') ||
    d.includes(' SBN') || d.endsWith(' BN') || d.includes('REDUCER');
}


// ─── Image color-matching helpers ───

function normalizeForColor(str) {
  return str.replace(/[\s\-_]/g, '').toLowerCase();
}

function extractFilename(url) {
  const match = url.match(/\/([^/?]+?)(?:\?|$)/);
  return match ? match[1] : url;
}

function cleanImageFilename(filename) {
  return filename
    .replace(/\.jpe?g$|\.png$|\.webp$/i, '')
    .replace(/_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, '');
}

function isMultiColorScene(originalCaseFilename) {
  return /(?<=[a-z\d])and(?=[A-Z])/.test(originalCaseFilename);
}

/**
 * Match an image to a SKU color, handling both single-color and multi-color
 * scene filenames. For multi-color scenes, only matches the segment belonging
 * to this product (by checking for product name in the segment).
 */
function matchImageColor(url, displayName, collection, productName, colorToSkuId) {
  const rawFilename = extractFilename(url);
  const cleaned = cleanImageFilename(rawFilename);
  const colorKeys = Object.keys(colorToSkuId).sort((a, b) => b.length - a.length);

  if (isMultiColorScene(cleaned)) {
    // Split on "and" between camelCase names
    const segments = cleaned.split(/(?<=[a-z\d])and(?=[A-Z])/);
    const normCollection = normalizeForColor(collection);
    const normName = normalizeForColor(productName);
    const normDisplay = normalizeForColor(displayName);

    // Build prefixes (most specific first)
    const prefixes = [];
    if (normCollection !== normName) prefixes.push(normDisplay);
    prefixes.push(normCollection);

    // Phase 1: match segment starting with product prefix
    for (const segment of segments) {
      const normSeg = normalizeForColor(segment);
      for (const prefix of prefixes) {
        if (!normSeg.startsWith(prefix)) continue;
        let colorPart = normSeg.substring(prefix.length);
        // When collection prefix matched but product name is different, check it
        if (prefix === normCollection && normCollection !== normName) {
          const afterColl = normSeg.substring(normCollection.length);
          if (!afterColl.startsWith(normName)) continue;
          colorPart = afterColl.substring(normName.length);
        }
        colorPart = colorPart.replace(/\d+$/, '');
        if (!colorPart) continue;
        for (const c of colorKeys) {
          if (colorPart === c || colorPart.startsWith(c)) return colorToSkuId[c];
        }
      }
    }
    // Phase 2: bare color segment (same-product scenes that drop prefix)
    for (const segment of segments) {
      const normSeg = normalizeForColor(segment).replace(/\d+$/, '');
      for (const c of colorKeys) {
        if (normSeg === c) return colorToSkuId[c];
      }
    }
    return null;
  }

  // Single-color image: match color anywhere in filename
  const fnNorm = normalizeForColor(cleaned);
  for (const c of colorKeys) {
    if (fnNorm.includes(c)) return colorToSkuId[c];
  }
  return null;
}


// ═══════════════════════════════════════════════════════════
//   Phase 1: Parse PDF Price List
// ═══════════════════════════════════════════════════════════

const ITEM_CODE_RE = /^(THD\d{4}-\d{5}[A-Z]?)\s*/;
const STATUS_KEYWORDS = [
  'DISCONTINUED', 'PRE DROP', 'PREDROP', 'NEW/COMING SOON',
  'SPECIAL ORDER', 'PRICE UPDATE', 'UPDATED PACKING INFO',
  'UPDATED ITEM CODE',
];
const UOM_VALUES = ['SF', 'SHT', 'EA'];
const SIZE_RE = /^\d|^\./;  // Sizes start with digit or dot (e.g., .5X8)
const PAGE_MARKER_RE = /^-- \d+ of \d+ --$/;

async function parsePdf(pdfPath) {
  const { PDFParse } = await import('pdf-parse');
  const buf = fs.readFileSync(pdfPath);
  const parser = new PDFParse({ data: buf });
  const data = await parser.getText();
  await parser.destroy();
  const rawLines = data.text.split('\n').map(l => l.trim()).filter(Boolean);

  const records = [];
  let currentCollection = null;

  // Pre-process: join multi-line records and extract collection headers
  const merged = [];
  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];

    // Skip page markers
    if (PAGE_MARKER_RE.test(line)) continue;

    // Skip cover/terms pages (lines before first data/header)
    // Detect column header rows → extract collection name
    if (line.startsWith('Image\t') || line.startsWith('Image \t')) {
      const headerFields = line.split('\t').map(f => f.trim());
      // Collection name is in the 3rd field (index 2): "Image | Item code | COLLECTION | Size | ..."
      if (headerFields.length >= 4 && headerFields[2] && headerFields[2] !== 'Size') {
        currentCollection = headerFields[2];
      }
      continue;
    }

    // Try to match an item code at the start
    const itemMatch = line.match(ITEM_CODE_RE);
    if (itemMatch) {
      const itemCode = itemMatch[1];
      const rest = line.substring(itemMatch[0].length);
      // Check if this line has UOM (complete record) by looking for tab-separated UOM
      const hasUOM = rest.split('\t').some(f => UOM_VALUES.includes(f.trim().toUpperCase()));

      if (hasUOM) {
        // Complete single-line record
        merged.push({ itemCode, text: rest, collection: currentCollection });
      } else {
        // Multi-line: accumulate continuation lines
        let accumulated = rest;
        while (i + 1 < rawLines.length) {
          const nextLine = rawLines[i + 1];
          // Stop if next line is a new item code, header, or page marker
          if (ITEM_CODE_RE.test(nextLine)) break;
          if (nextLine.startsWith('Image\t') || nextLine.startsWith('Image \t')) break;
          if (PAGE_MARKER_RE.test(nextLine)) { i++; continue; }
          i++;
          accumulated += ' ' + nextLine;
          // Check if we now have UOM
          if (accumulated.split('\t').some(f => UOM_VALUES.includes(f.trim().toUpperCase()))) break;
        }
        merged.push({ itemCode, text: accumulated, collection: currentCollection });
      }
      continue;
    }

    // Non-item-code, non-header lines before any data are cover/terms — skip
    // Status continuation lines after a complete record — skip (already captured key flags)
  }

  // Parse each merged record, separating active from discontinued/pre-drop
  const inactiveItemCodes = [];
  let skippedInactive = 0;
  for (const { itemCode, text, collection } of merged) {
    const record = parseDataRow(itemCode, text, collection);
    if (!record) continue;
    if (record.status === 'inactive') {
      skippedInactive++;
      inactiveItemCodes.push(itemCode);
      continue;
    }
    records.push(record);
  }

  console.log(`PDF: Parsed ${records.length} active SKU records from ${new Set(records.map(r => r.collection)).size} collections (skipped ${skippedInactive} discontinued/pre-drop)`);
  return { records, inactiveItemCodes };
}

function parseDataRow(itemCode, text, collection) {
  // Strip trailing letter from item code for matching (THD0015-00036N → THD0015-00036)
  const codeBase = itemCode.match(/^(THD\d{4}-\d{5})/)[1];

  // Split by tab — the text after the item code is tab-separated
  const fields = text.split('\t').map(f => f.trim()).filter(Boolean);
  if (fields.length < 3) return null;  // Need at least description + UOM + something

  // Work from the right side to extract status, price, UOM
  let statusFlag = '';
  let price = null;
  let uom = 'SF';
  const remaining = [...fields];

  // Check last field for status keyword
  if (remaining.length > 0) {
    const last = remaining[remaining.length - 1].toUpperCase();
    if (STATUS_KEYWORDS.some(s => last.startsWith(s))) {
      statusFlag = remaining.pop().trim();
    }
  }

  // Check for price ($X.XX or bare decimal) — or status keyword in price position
  if (remaining.length > 0) {
    const last = remaining[remaining.length - 1].trim();
    const priceMatch = last.match(/^\$?(\d+(?:\.\d+)?)$/);
    if (priceMatch) {
      price = parseFloat(priceMatch[1]);
      remaining.pop();
    } else {
      // Price field might contain a status (e.g., "DISCONTINUED" in the price column)
      const upper = last.toUpperCase();
      if (STATUS_KEYWORDS.some(s => upper.startsWith(s))) {
        if (!statusFlag) statusFlag = last.trim();
        remaining.pop();
      }
    }
  }

  // Extract UOM
  if (remaining.length > 0) {
    const last = remaining[remaining.length - 1].trim().toUpperCase();
    if (UOM_VALUES.includes(last)) {
      uom = last;
      remaining.pop();
    }
  }

  // Now remaining = [description, size?, color?, finish?, ...packagingNums]
  // First field is always description
  const description = remaining.shift() || '';
  if (!description) return null;

  // Detect size, color, finish from the left of remaining
  let size = '', color = '', finish = '';

  if (remaining.length > 0 && SIZE_RE.test(remaining[0])) {
    size = remaining.shift();
  }
  // Color: next non-numeric text field
  if (remaining.length > 0 && isNaN(parseFloat(remaining[0]))) {
    color = remaining.shift();
  }
  // Finish: next non-numeric text field
  if (remaining.length > 0 && isNaN(parseFloat(remaining[0]))) {
    finish = remaining.shift();
  }

  // Remaining fields are packaging numbers
  const packNums = remaining.map(f => parseFloat(f.replace(/,/g, ''))).filter(n => !isNaN(n));

  // Map packaging numbers based on count
  // Full set (7): SF/BX, SF/EA, EA/BX, BX/PLT, LBS/EA, LBS/BX, THICKNESS
  let sfBox = null, sfEa = null, eaBx = null, bxPlt = null;
  let lbsEa = null, lbsBox = null, thickness = null;

  if (packNums.length >= 7) {
    [sfBox, sfEa, eaBx, bxPlt, lbsEa, lbsBox, thickness] = packNums;
  } else if (packNums.length === 6) {
    // Could be missing BX/PLT or THICKNESS — use heuristic:
    // If last value ≤ 25 and matches common thickness values, it's thickness (BX/PLT missing)
    const last = packNums[5];
    if (last <= 25 && [6.5, 8.0, 8.3, 8.5, 9.0, 10.0, 10.4, 10.5, 20.0].some(t => Math.abs(last - t) < 0.1)) {
      [sfBox, sfEa, eaBx, lbsEa, lbsBox, thickness] = packNums;
    } else {
      [sfBox, sfEa, eaBx, bxPlt, lbsEa, lbsBox] = packNums;
    }
  } else if (packNums.length === 5) {
    [sfBox, sfEa, eaBx, lbsEa, lbsBox] = packNums;
  } else if (packNums.length === 4) {
    [sfBox, sfEa, eaBx, lbsBox] = packNums;
  } else if (packNums.length === 3) {
    [sfBox, eaBx, lbsBox] = packNums;
  } else if (packNums.length === 2) {
    [eaBx, lbsBox] = packNums;
  }

  // Ensure integer fields
  if (eaBx != null) eaBx = Math.round(eaBx);
  if (bxPlt != null) bxPlt = Math.round(bxPlt);

  // Title-case the color from PDF (comes as uppercase)
  const colorTc = titleCase(color) || titleCase(description);

  return {
    itemCode: codeBase,
    collection: collection || 'Unknown',
    description,
    size,
    color: colorTc,
    finish: titleCase(finish),
    sfBox, sfEa, eaBx, bxPlt,
    lbsEa, lbsBox, thickness,
    uom,
    price,
    status: mapStatus(statusFlag),
    statusFlag,
  };
}


// ═══════════════════════════════════════════════════════════
//   Phase 2: Fetch Shopify Product + Image Data
// ═══════════════════════════════════════════════════════════

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchShopifyData() {
  const shopifyMap = new Map(); // itemCode → shopify data

  console.log(`\nFetching product data from ${SHOPIFY_DOMAIN}...`);

  let page = 1;
  let allProducts = [];

  while (true) {
    const url = `https://${SHOPIFY_DOMAIN}/products.json?limit=250&page=${page}`;
    let res;
    try {
      res = await fetch(url);
    } catch (err) {
      console.warn(`  Warning: Network error fetching ${url}: ${err.message}`);
      break;
    }

    if (!res.ok) {
      if (res.status === 429) {
        console.log('  Rate limited — waiting 5s...');
        await sleep(5000);
        continue;
      }
      console.warn(`  Warning: Shopify returned ${res.status} for page ${page}`);
      break;
    }

    const data = await res.json();
    if (!data.products || data.products.length === 0) break;

    allProducts = allProducts.concat(data.products);
    console.log(`  Page ${page}: ${data.products.length} products (total: ${allProducts.length})`);

    if (data.products.length < 250) break;
    page++;
    await sleep(FETCH_DELAY_MS);
  }

  console.log(`Shopify: ${allProducts.length} products fetched`);

  // Fetch collection titles and match to products by title prefix
  // (e.g., product "Landscape Pavers Quartz" → collection "Landscape Pavers")
  const collectionTitles = [];
  const collectionMap = new Map(); // product_id → collection title
  try {
    let cPage = 1;
    while (true) {
      const cUrl = `https://${SHOPIFY_DOMAIN}/collections.json?limit=250&page=${cPage}`;
      const cRes = await fetch(cUrl);
      if (cRes.status !== 200) break;
      const cData = await cRes.json();
      if (!cData.collections || cData.collections.length === 0) break;

      for (const col of cData.collections) {
        collectionTitles.push(col.title);
      }

      if (cData.collections.length < 250) break;
      cPage++;
      await sleep(FETCH_DELAY_MS);
    }
    // Sort longest first so "Onix Glass - Icon" matches before "Onix Glass"
    collectionTitles.sort((a, b) => b.length - a.length);

    // Match each product to a collection by title prefix
    for (const product of allProducts) {
      const title = product.title;
      for (const colTitle of collectionTitles) {
        if (title.startsWith(colTitle + ' ') || title === colTitle) {
          collectionMap.set(product.id, colTitle);
          break;
        }
      }
    }
    console.log(`Shopify: ${collectionTitles.length} collections, ${collectionMap.size} products matched`);
  } catch (err) {
    console.warn(`  Warning: Collection fetch failed: ${err.message}`);
  }

  // Process each product — map variants by SKU
  for (const product of allProducts) {
    const variantImages = new Map(); // variant_id → image src
    const lifestyleImages = [];

    for (const img of (product.images || [])) {
      if (img.variant_ids && img.variant_ids.length > 0) {
        for (const vid of img.variant_ids) {
          variantImages.set(vid, img.src);
        }
      } else {
        lifestyleImages.push(img.src);
      }
    }

    const shopifyCollection = collectionMap.get(product.id) || product.product_type || '';

    for (const variant of (product.variants || [])) {
      const rawSku = (variant.sku || '').trim().toUpperCase();
      if (!rawSku) continue;

      // Normalize: accept THD####-#####, ####-#####, or THD####-#####X (trailing letter suffix)
      let normalizedSku = rawSku;
      if (/^\d{4}-\d{5}[A-Z]?$/.test(rawSku)) {
        normalizedSku = `THD${rawSku}`;
      }
      // Strip trailing letter suffix (e.g., THD0049-00032K → THD0049-00032)
      const skuBase = normalizedSku.match(/^(THD\d{4}-\d{5})[A-Z]?$/);
      if (!skuBase) continue; // skip non-THD SKUs
      normalizedSku = skuBase[1];

      const variantTitle = variant.title !== 'Default Title' ? variant.title : '';

      shopifyMap.set(normalizedSku, {
        productId: product.id,
        productTitle: product.title,
        productHandle: product.handle,
        collection: shopifyCollection,
        variantTitle,
        option1: variant.option1,
        option2: variant.option2,
        option3: variant.option3,
        shopifyPrice: variant.price ? parseFloat(variant.price) : null,
        primaryImageUrl: variantImages.get(variant.id) || null,
        lifestyleImageUrls: lifestyleImages,
      });
    }
  }

  console.log(`Shopify: ${shopifyMap.size} THD SKUs mapped\n`);
  return shopifyMap;
}


// ═══════════════════════════════════════════════════════════
//   Phase 3: Merge & Upsert into Database
// ═══════════════════════════════════════════════════════════

async function upsertAttr(client, skuId, attrId, value) {
  if (!value) return false;
  await client.query(`
    INSERT INTO sku_attributes (sku_id, attribute_id, value)
    VALUES ($1, $2, $3)
    ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value = EXCLUDED.value
  `, [skuId, attrId, String(value).trim()]);
  return true;
}

async function run() {
  // Determine PDF path
  const pdfArg = process.argv[2];
  const pdfPath = pdfArg
    ? (pdfArg.startsWith('/') ? pdfArg : join(__dirname, '..', pdfArg))
    : join(__dirname, '..', 'data', 'thd-q3-2026.pdf');

  // ── Phase 1: Parse PDF ──
  let pdfRecords = [];
  let inactiveItemCodes = [];
  if (fs.existsSync(pdfPath)) {
    console.log(`Reading PDF: ${pdfPath}\n`);
    const pdfResult = await parsePdf(pdfPath);
    pdfRecords = pdfResult.records;
    inactiveItemCodes = pdfResult.inactiveItemCodes;
  } else {
    console.warn(`PDF not found at ${pdfPath} — running Shopify-only import\n`);
  }

  const pdfMap = new Map();
  for (const rec of pdfRecords) {
    pdfMap.set(rec.itemCode, rec);
  }

  // ── Phase 2: Fetch Shopify data ──
  let shopifyMap = new Map();
  try {
    shopifyMap = await fetchShopifyData();
  } catch (err) {
    console.warn(`Shopify fetch failed: ${err.message} — running PDF-only import\n`);
  }

  // ── Merge: union of all item codes ──
  const allItemCodes = new Set([...pdfMap.keys(), ...shopifyMap.keys()]);
  console.log(`Merged: ${allItemCodes.size} unique item codes (${pdfMap.size} PDF, ${shopifyMap.size} Shopify)`);

  if (allItemCodes.size === 0) {
    console.error('No data found from either source. Ensure the PDF exists or the Shopify site is reachable.');
    await pool.end();
    process.exit(1);
  }

  // ── Group by product (collection + product name) ──
  // Process Shopify items first so groups exist before PDF-only items try to merge
  const productGroups = new Map(); // key → { collection, productName, categoryId, items[] }
  const sortedItemCodes = [...allItemCodes].sort((a, b) => {
    const aHasShopify = shopifyMap.has(a) ? 0 : 1;
    const bHasShopify = shopifyMap.has(b) ? 0 : 1;
    return aHasShopify - bHasShopify;
  });

  for (const itemCode of sortedItemCodes) {
    const pdf = pdfMap.get(itemCode);
    const shopify = shopifyMap.get(itemCode);

    let productName, collection;
    if (shopify && shopify.productTitle) {
      // If matched to a collection, strip the collection prefix from product title
      // e.g., collection "Landscape Pavers" + title "Landscape Pavers Quartz" → name "Quartz"
      if (shopify.collection && shopify.productTitle.startsWith(shopify.collection + ' ')) {
        collection = shopify.collection;
        productName = shopify.productTitle.substring(shopify.collection.length + 1).trim();
      } else if (shopify.collection && shopify.productTitle === shopify.collection) {
        collection = shopify.collection;
        productName = shopify.collection; // product IS the collection
      } else {
        // Unmatched product — use title as product name, derive collection from PDF or title
        collection = (pdf ? titleCase(pdf.collection) : null) || shopify.productTitle;
        productName = shopify.productTitle;
      }
    } else if (pdf) {
      collection = titleCase(pdf.collection);
      // Try to merge PDF-only items into an existing Shopify product group
      // in the same collection (e.g., PDF item "ROKU / WHITE" → main "Roku" product)
      let targetGroup = null;
      const mainKey = `${collection}|${collection}`;
      if (productGroups.has(mainKey)) {
        targetGroup = productGroups.get(mainKey);
      } else {
        const collGroups = [];
        for (const [k, g] of productGroups) {
          if (g.collection === collection) collGroups.push(g);
        }
        if (collGroups.length === 1) targetGroup = collGroups[0];
      }
      if (targetGroup) {
        // Check if an existing item in the group already has the same color
        // (PDF uses a different item code for the same tile)
        const pdfColor = normalizeForColor(pdf.color || '');
        if (pdfColor) {
          const existing = targetGroup.items.find(item => {
            const c = normalizeForColor(
              (item.shopify && item.shopify.option2) || (item.pdf && item.pdf.color) || ''
            );
            return c === pdfColor;
          });
          if (existing) {
            // Attach PDF pricing/packaging to the existing item instead of duplicating
            if (!existing.pdf) existing.pdf = pdf;
            continue;
          }
        }
        targetGroup.items.push({ itemCode, pdf, shopify });
        continue;
      }
      productName = pdf.color || pdf.description;
    } else {
      continue;
    }

    if (!collection) collection = 'THD';
    const key = `${collection}|${productName}`;

    if (!productGroups.has(key)) {
      productGroups.set(key, {
        collection,
        productName,
        categoryId: getCategoryId(collection),
        items: [],
      });
    }
    productGroups.get(key).items.push({ itemCode, pdf, shopify });
  }

  console.log(`Grouped into ${productGroups.size} products\n`);

  // ── Phase 3: DB upserts ──
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Upsert vendor
    const vendorRes = await client.query(`
      INSERT INTO vendors (id, name, code, website)
      VALUES (gen_random_uuid(), 'Total Home Distributors', 'THD', 'https://thdistributors.com')
      ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, website = EXCLUDED.website
      RETURNING id
    `);
    const vendorId = vendorRes.rows[0].id;
    console.log(`Vendor: Total Home Distributors (${vendorId})\n`);

    let totalProducts = 0, totalSkus = 0, totalTrimSkus = 0;
    let totalPricing = 0, totalPkg = 0, totalAttrs = 0, totalImages = 0;
    const processedSkuIds = new Set();

    for (const [, group] of productGroups) {
      // Upsert product
      const prodRes = await client.query(`
        INSERT INTO products (id, vendor_id, name, collection, category_id, status)
        VALUES (gen_random_uuid(), $1, $2, $3, $4, 'active')
        ON CONFLICT ON CONSTRAINT products_vendor_collection_name_unique
        DO UPDATE SET category_id = EXCLUDED.category_id, status = 'active'
        RETURNING id
      `, [vendorId, group.productName, group.collection, group.categoryId]);
      const productId = prodRes.rows[0].id;
      totalProducts++;

      // Set display_name = "Collection Name" when name alone is ambiguous
      if (group.collection && group.collection !== group.productName
          && !group.collection.includes(' - ')) {
        await client.query(`
          UPDATE products SET display_name = $1 || ' ' || $2
          WHERE id = $3 AND display_name IS NULL
        `, [group.collection, group.productName, productId]);
      }

      const colorToSkuId = {};  // normalized color → skuId (for image matching)

      for (const { itemCode, pdf, shopify } of group.items) {
        const internalSku = `THD-${itemCode}`;

        // Variant name: prefer Shopify's structured title, fall back to PDF fields
        let variantName;
        if (shopify && shopify.variantTitle) {
          variantName = formatVariantName(fixTypos(shopify.variantTitle));
        } else if (pdf) {
          const parts = [pdf.color, pdf.size, pdf.finish].filter(Boolean);
          variantName = parts.join(' ') || pdf.description;
        } else {
          variantName = itemCode;
        }

        // Determine sell_by from PDF UOM field, fall back to description heuristic
        // SF/SHT → 'box' (tiles/mosaics sold by the box), EA → 'unit' (trim pieces)
        const desc = pdf ? pdf.description : (shopify ? shopify.variantTitle : '');
        let trimItem;
        let sellBy;
        if (pdf && pdf.uom) {
          trimItem = pdf.uom === 'EA';
          sellBy = trimItem ? 'unit' : 'box';
        } else {
          trimItem = isTrimItem(desc);
          sellBy = trimItem ? 'unit' : 'box';
        }
        const variantType = trimItem ? 'accessory' : null;
        const status = pdf ? pdf.status : 'active';

        const skuRes = await client.query(`
          INSERT INTO skus (id, product_id, vendor_sku, internal_sku, variant_name, sell_by, variant_type, status)
          VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7)
          ON CONFLICT ON CONSTRAINT skus_internal_sku_key
          DO UPDATE SET product_id = EXCLUDED.product_id, variant_name = EXCLUDED.variant_name,
            sell_by = EXCLUDED.sell_by, variant_type = COALESCE(EXCLUDED.variant_type, skus.variant_type),
            status = EXCLUDED.status
          RETURNING id
        `, [productId, itemCode, internalSku, variantName, sellBy, variantType, status]);
        const skuId = skuRes.rows[0].id;
        processedSkuIds.add(skuId);
        if (trimItem) totalTrimSkus++; else totalSkus++;

        // ── Pricing (from PDF) ──
        if (pdf && pdf.price) {
          const cost = pdf.price.toFixed(2);
          const retail = (pdf.price * MARKUP).toFixed(2);
          const priceBasis = sellBy === 'unit' ? 'unit' : 'sqft';
          await client.query(`
            INSERT INTO pricing (sku_id, cost, retail_price, price_basis)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (sku_id) DO UPDATE SET cost = EXCLUDED.cost,
              retail_price = EXCLUDED.retail_price, price_basis = EXCLUDED.price_basis
          `, [skuId, cost, retail, priceBasis]);
          totalPricing++;
        }

        // ── Packaging (from PDF) ──
        if (pdf && (pdf.sfBox || pdf.eaBx)) {
          const sfPlt = (pdf.sfBox && pdf.bxPlt)
            ? +(pdf.sfBox * pdf.bxPlt).toFixed(2)
            : null;
          // lbsBox from PDF, or compute from lbsEa * eaBx
          const lbsBox = pdf.lbsBox || ((pdf.lbsEa && pdf.eaBx) ? +(pdf.lbsEa * pdf.eaBx).toFixed(2) : null);
          const lbsPlt = (lbsBox && pdf.bxPlt) ? +(lbsBox * pdf.bxPlt).toFixed(2) : null;
          await client.query(`
            INSERT INTO packaging (sku_id, sqft_per_box, pieces_per_box, weight_per_box_lbs,
              boxes_per_pallet, sqft_per_pallet, weight_per_pallet_lbs)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (sku_id) DO UPDATE SET
              sqft_per_box = COALESCE(EXCLUDED.sqft_per_box, packaging.sqft_per_box),
              pieces_per_box = COALESCE(EXCLUDED.pieces_per_box, packaging.pieces_per_box),
              weight_per_box_lbs = COALESCE(EXCLUDED.weight_per_box_lbs, packaging.weight_per_box_lbs),
              boxes_per_pallet = COALESCE(EXCLUDED.boxes_per_pallet, packaging.boxes_per_pallet),
              sqft_per_pallet = COALESCE(EXCLUDED.sqft_per_pallet, packaging.sqft_per_pallet),
              weight_per_pallet_lbs = COALESCE(EXCLUDED.weight_per_pallet_lbs, packaging.weight_per_pallet_lbs)
          `, [skuId, pdf.sfBox || null, pdf.eaBx || null, lbsBox,
              pdf.bxPlt || null, sfPlt, lbsPlt]);
          totalPkg++;
        }

        // ── Attributes ──
        // Color: prefer Shopify option2, then PDF color
        const color = fixColor((shopify && shopify.option2) || (pdf && pdf.color) || null);
        if (await upsertAttr(client, skuId, ATTR.color, color)) totalAttrs++;
        if (color) {
          const normColor = normalizeForColor(color);
          if (!colorToSkuId[normColor]) colorToSkuId[normColor] = skuId;
        }

        // Size: prefer Shopify option1, then PDF size
        const size = (shopify && shopify.option1) || (pdf && pdf.size) || null;
        if (await upsertAttr(client, skuId, ATTR.size, size)) totalAttrs++;

        // Finish: prefer Shopify option3, then PDF finish
        const finishVal = (shopify && shopify.option3) || (pdf && pdf.finish) || null;
        if (await upsertAttr(client, skuId, ATTR.finish, finishVal)) totalAttrs++;

        // Material: derived from collection name
        const material = deriveMaterial(group.collection);
        if (await upsertAttr(client, skuId, ATTR.material, material)) totalAttrs++;

        // Thickness: from PDF (in mm)
        if (pdf && pdf.thickness) {
          if (await upsertAttr(client, skuId, ATTR.thickness, `${pdf.thickness}mm`)) totalAttrs++;
        }

        // ── Images (from Shopify) ──
        if (shopify) {
          // Primary image (variant-linked)
          if (shopify.primaryImageUrl) {
            await client.query(`
              INSERT INTO media_assets (id, product_id, sku_id, asset_type, url, original_url, sort_order)
              VALUES (gen_random_uuid(), $1, $2, 'primary', $3, $3, 0)
              ON CONFLICT (product_id, sku_id, asset_type, sort_order) WHERE sku_id IS NOT NULL
              DO UPDATE SET url = EXCLUDED.url, original_url = EXCLUDED.original_url
            `, [productId, skuId, shopify.primaryImageUrl]);
            totalImages++;
          }

        }
      }

      // ── Color-aware lifestyle image assignment (after all SKUs collected) ──
      // Match each non-variant image to a SKU by color in filename
      const lifestyleUrls = group.items.find(i => i.shopify)?.shopify?.lifestyleImageUrls || [];
      if (lifestyleUrls.length > 0 && Object.keys(colorToSkuId).length > 0) {
        const displayName = (group.collection && group.collection !== group.productName)
          ? `${group.collection} ${group.productName}` : group.productName;
        const skuFirstLifestyle = {}; // skuId → first matching lifestyle url

        for (let i = 0; i < lifestyleUrls.length; i++) {
          const url = lifestyleUrls[i];
          const matchedSkuId = matchImageColor(
            url, displayName, group.collection, group.productName, colorToSkuId
          );

          if (matchedSkuId) {
            // Insert as SKU-level lifestyle
            await client.query(`
              INSERT INTO media_assets (id, product_id, sku_id, asset_type, url, original_url, sort_order)
              VALUES (gen_random_uuid(), $1, $2, 'lifestyle', $3, $3, $4)
              ON CONFLICT (product_id, sku_id, asset_type, sort_order) WHERE sku_id IS NOT NULL
              DO UPDATE SET url = EXCLUDED.url, original_url = EXCLUDED.original_url
            `, [productId, matchedSkuId, url, i]);
            totalImages++;

            if (!skuFirstLifestyle[matchedSkuId]) {
              skuFirstLifestyle[matchedSkuId] = url;
            }
          }
          // Unmatched images are skipped (no product-level insertion)
        }

        // Create SKU-level alternates from first matched lifestyle per SKU
        for (const [skuId, url] of Object.entries(skuFirstLifestyle)) {
          await client.query(`
            INSERT INTO media_assets (id, product_id, sku_id, asset_type, url, original_url, sort_order)
            VALUES (gen_random_uuid(), $1, $2, 'alternate', $3, $3, 0)
            ON CONFLICT (product_id, sku_id, asset_type, sort_order) WHERE sku_id IS NOT NULL
            DO UPDATE SET url = EXCLUDED.url, original_url = EXCLUDED.original_url
          `, [productId, skuId, url]);
          totalImages++;
        }
      }

      if (totalProducts % 50 === 0 && totalProducts > 0) {
        console.log(`  ... ${totalProducts} products processed`);
      }
    }

    // ── Deactivate SKUs that are DISCONTINUED or PRE DROP in the PDF ──
    if (inactiveItemCodes.length > 0) {
      // Build internal_sku patterns: THD-THD0016-00094 from THD0016-00094
      const internalSkuPatterns = inactiveItemCodes.map(code => `THD-${code}`);
      // Also match base codes (strip trailing letter): THD0016-00094N → THD-THD0016-00094
      const basePatterns = inactiveItemCodes.map(code => {
        const base = code.match(/^(THD\d{4}-\d{5})/);
        return base ? `THD-${base[1]}` : `THD-${code}`;
      });
      const allPatterns = [...new Set([...internalSkuPatterns, ...basePatterns])];

      const deactivateRes = await client.query(`
        UPDATE skus SET status = 'inactive'
        WHERE internal_sku = ANY($1)
          AND product_id IN (SELECT id FROM products WHERE vendor_id = $2)
          AND status = 'active'
        RETURNING id, internal_sku
      `, [allPatterns, vendorId]);

      if (deactivateRes.rowCount > 0) {
        console.log(`Deactivated ${deactivateRes.rowCount} discontinued/pre-drop SKUs`);
      }

      // Also deactivate products where ALL SKUs are now inactive
      const deactivateProdsRes = await client.query(`
        UPDATE products SET status = 'inactive'
        WHERE vendor_id = $1 AND status = 'active'
          AND id NOT IN (
            SELECT DISTINCT product_id FROM skus
            WHERE product_id IN (SELECT id FROM products WHERE vendor_id = $1)
              AND status = 'active'
          )
        RETURNING id, name
      `, [vendorId]);

      if (deactivateProdsRes.rowCount > 0) {
        console.log(`Deactivated ${deactivateProdsRes.rowCount} products (all SKUs discontinued)`);
      }
    }

    // ── Fix media_assets product_id when SKUs moved between products ──
    const fixMediaRes = await client.query(`
      UPDATE media_assets ma
      SET product_id = s.product_id
      FROM skus s
      JOIN products p ON p.id = s.product_id
      WHERE ma.sku_id = s.id AND ma.product_id <> s.product_id
        AND p.vendor_id = $1
    `, [vendorId]);
    if (fixMediaRes.rowCount > 0) {
      console.log(`Fixed ${fixMediaRes.rowCount} media_assets with stale product_id`);
    }

    // ── Clean up orphaned products (0 SKUs) from previous runs ──
    const orphanMediaDel = await client.query(`
      DELETE FROM media_assets WHERE product_id IN (
        SELECT p.id FROM products p
        LEFT JOIN skus s ON s.product_id = p.id
        WHERE p.vendor_id = $1 AND s.id IS NULL
      )
    `, [vendorId]);
    const orphanProdDel = await client.query(`
      DELETE FROM products WHERE id IN (
        SELECT p.id FROM products p
        LEFT JOIN skus s ON s.product_id = p.id
        WHERE p.vendor_id = $1 AND s.id IS NULL
      )
    `, [vendorId]);
    if (orphanProdDel.rowCount > 0) {
      console.log(`Cleaned up ${orphanProdDel.rowCount} orphaned products (${orphanMediaDel.rowCount} media)`);
    }

    // ── Clean up stale SKUs not processed in this run ──
    if (processedSkuIds.size > 0) {
      const staleRes = await client.query(`
        SELECT s.id FROM skus s
        JOIN products p ON p.id = s.product_id
        WHERE p.vendor_id = $1 AND s.id <> ALL($2::uuid[])
      `, [vendorId, [...processedSkuIds]]);

      if (staleRes.rows.length > 0) {
        const staleIds = staleRes.rows.map(r => r.id);
        await client.query(`DELETE FROM media_assets WHERE sku_id = ANY($1::uuid[])`, [staleIds]);
        await client.query(`DELETE FROM sku_attributes WHERE sku_id = ANY($1::uuid[])`, [staleIds]);
        await client.query(`DELETE FROM pricing WHERE sku_id = ANY($1::uuid[])`, [staleIds]);
        await client.query(`DELETE FROM packaging WHERE sku_id = ANY($1::uuid[])`, [staleIds]);
        await client.query(`DELETE FROM cart_items WHERE sku_id = ANY($1::uuid[])`, [staleIds]);
        await client.query(`DELETE FROM skus WHERE id = ANY($1::uuid[])`, [staleIds]);
        console.log(`Cleaned up ${staleIds.length} stale SKUs from previous runs`);
      }
    }

    // ── Post-processing: fill missing primary images ──

    // Pass 1: Same-collection, same-color sibling (handles Roku-style duplicates)
    const colorFillRes = await client.query(`
      WITH missing AS (
        SELECT s.id as sku_id, s.product_id, p.collection, LOWER(TRIM(sa.value)) as color
        FROM skus s
        JOIN products p ON p.id = s.product_id
        JOIN sku_attributes sa ON sa.sku_id = s.id AND sa.attribute_id = $2
        LEFT JOIN media_assets existing ON existing.sku_id = s.id AND existing.asset_type = 'primary'
        WHERE p.vendor_id = $1 AND existing.id IS NULL
      ),
      sources AS (
        SELECT DISTINCT ON (m.sku_id) m.sku_id, m.product_id, source.url
        FROM missing m
        JOIN sku_attributes sib_sa ON sib_sa.attribute_id = $2
          AND LOWER(TRIM(sib_sa.value)) = m.color
          AND sib_sa.sku_id <> m.sku_id
        JOIN skus sib_s ON sib_s.id = sib_sa.sku_id
        JOIN products sib_p ON sib_p.id = sib_s.product_id
          AND sib_p.vendor_id = $1 AND sib_p.collection = m.collection
        JOIN media_assets source ON source.sku_id = sib_s.id AND source.asset_type = 'primary'
        ORDER BY m.sku_id
      )
      INSERT INTO media_assets (id, product_id, sku_id, asset_type, url, original_url, sort_order)
      SELECT gen_random_uuid(), product_id, sku_id, 'primary', url, url, 0
      FROM sources
      ON CONFLICT (product_id, sku_id, asset_type, sort_order) WHERE sku_id IS NOT NULL
      DO NOTHING
    `, [vendorId, ATTR.color]);
    console.log(`Primary fill (same-collection color match): ${colorFillRes.rowCount}`);

    // Pass 2: Same-product any-sibling fallback (handles Manhattan Jolly-style 1-image products)
    const sibFillRes = await client.query(`
      WITH missing AS (
        SELECT s.id as sku_id, s.product_id
        FROM skus s
        JOIN products p ON p.id = s.product_id
        LEFT JOIN media_assets existing ON existing.sku_id = s.id AND existing.asset_type = 'primary'
        WHERE p.vendor_id = $1 AND existing.id IS NULL
      ),
      sources AS (
        SELECT DISTINCT ON (m.sku_id) m.sku_id, m.product_id, source.url
        FROM missing m
        JOIN skus sib_s ON sib_s.product_id = m.product_id AND sib_s.id <> m.sku_id
        JOIN media_assets source ON source.sku_id = sib_s.id AND source.asset_type = 'primary'
        ORDER BY m.sku_id
      )
      INSERT INTO media_assets (id, product_id, sku_id, asset_type, url, original_url, sort_order)
      SELECT gen_random_uuid(), product_id, sku_id, 'primary', url, url, 0
      FROM sources
      ON CONFLICT (product_id, sku_id, asset_type, sort_order) WHERE sku_id IS NOT NULL
      DO NOTHING
    `, [vendorId]);
    console.log(`Primary fill (same-product sibling fallback): ${sibFillRes.rowCount}`);

    // ── Post-processing: fill missing pricing from same-product siblings ──
    // Different colors of the same tile product share the same price
    const priceFillRes = await client.query(`
      WITH missing AS (
        SELECT s.id as sku_id, s.product_id
        FROM skus s
        JOIN products p ON p.id = s.product_id
        LEFT JOIN pricing pr ON pr.sku_id = s.id
        WHERE p.vendor_id = $1 AND pr.sku_id IS NULL
      ),
      sources AS (
        SELECT DISTINCT ON (m.sku_id) m.sku_id,
          sib_pr.cost, sib_pr.retail_price, sib_pr.price_basis
        FROM missing m
        JOIN skus sib_s ON sib_s.product_id = m.product_id AND sib_s.id <> m.sku_id
        JOIN pricing sib_pr ON sib_pr.sku_id = sib_s.id
        ORDER BY m.sku_id
      )
      INSERT INTO pricing (sku_id, cost, retail_price, price_basis)
      SELECT sku_id, cost, retail_price, price_basis
      FROM sources
      ON CONFLICT (sku_id) DO NOTHING
    `, [vendorId]);
    console.log(`Pricing fill (same-product sibling): ${priceFillRes.rowCount}`);

    // Fill pricing from same-collection, same-color sibling (Roku-style duplicates)
    const priceColorFillRes = await client.query(`
      WITH missing AS (
        SELECT s.id as sku_id, p.collection, LOWER(TRIM(sa.value)) as color
        FROM skus s
        JOIN products p ON p.id = s.product_id
        JOIN sku_attributes sa ON sa.sku_id = s.id AND sa.attribute_id = $2
        LEFT JOIN pricing pr ON pr.sku_id = s.id
        WHERE p.vendor_id = $1 AND pr.sku_id IS NULL
      ),
      sources AS (
        SELECT DISTINCT ON (m.sku_id) m.sku_id,
          sib_pr.cost, sib_pr.retail_price, sib_pr.price_basis
        FROM missing m
        JOIN sku_attributes sib_sa ON sib_sa.attribute_id = $2
          AND LOWER(TRIM(sib_sa.value)) = m.color
          AND sib_sa.sku_id <> m.sku_id
        JOIN skus sib_s ON sib_s.id = sib_sa.sku_id
        JOIN products sib_p ON sib_p.id = sib_s.product_id
          AND sib_p.vendor_id = $1 AND sib_p.collection = m.collection
        JOIN pricing sib_pr ON sib_pr.sku_id = sib_s.id
        ORDER BY m.sku_id
      )
      INSERT INTO pricing (sku_id, cost, retail_price, price_basis)
      SELECT sku_id, cost, retail_price, price_basis
      FROM sources
      ON CONFLICT (sku_id) DO NOTHING
    `, [vendorId, ATTR.color]);
    console.log(`Pricing fill (same-collection color match): ${priceColorFillRes.rowCount}`);

    // ── Post-processing: fill missing packaging from same-product siblings ──
    const pkgFillRes = await client.query(`
      WITH missing AS (
        SELECT s.id as sku_id, s.product_id
        FROM skus s
        JOIN products p ON p.id = s.product_id
        LEFT JOIN packaging pkg ON pkg.sku_id = s.id
        WHERE p.vendor_id = $1 AND pkg.sku_id IS NULL
      ),
      sources AS (
        SELECT DISTINCT ON (m.sku_id) m.sku_id,
          sib_pkg.sqft_per_box, sib_pkg.pieces_per_box, sib_pkg.weight_per_box_lbs,
          sib_pkg.boxes_per_pallet, sib_pkg.sqft_per_pallet, sib_pkg.weight_per_pallet_lbs
        FROM missing m
        JOIN skus sib_s ON sib_s.product_id = m.product_id AND sib_s.id <> m.sku_id
        JOIN packaging sib_pkg ON sib_pkg.sku_id = sib_s.id
        ORDER BY m.sku_id
      )
      INSERT INTO packaging (sku_id, sqft_per_box, pieces_per_box, weight_per_box_lbs,
        boxes_per_pallet, sqft_per_pallet, weight_per_pallet_lbs)
      SELECT sku_id, sqft_per_box, pieces_per_box, weight_per_box_lbs,
        boxes_per_pallet, sqft_per_pallet, weight_per_pallet_lbs
      FROM sources
      ON CONFLICT (sku_id) DO NOTHING
    `, [vendorId]);
    console.log(`Packaging fill (same-product sibling): ${pkgFillRes.rowCount}`);

    // Fill packaging from same-collection, same-color sibling
    const pkgColorFillRes = await client.query(`
      WITH missing AS (
        SELECT s.id as sku_id, p.collection, LOWER(TRIM(sa.value)) as color
        FROM skus s
        JOIN products p ON p.id = s.product_id
        JOIN sku_attributes sa ON sa.sku_id = s.id AND sa.attribute_id = $2
        LEFT JOIN packaging pkg ON pkg.sku_id = s.id
        WHERE p.vendor_id = $1 AND pkg.sku_id IS NULL
      ),
      sources AS (
        SELECT DISTINCT ON (m.sku_id) m.sku_id,
          sib_pkg.sqft_per_box, sib_pkg.pieces_per_box, sib_pkg.weight_per_box_lbs,
          sib_pkg.boxes_per_pallet, sib_pkg.sqft_per_pallet, sib_pkg.weight_per_pallet_lbs
        FROM missing m
        JOIN sku_attributes sib_sa ON sib_sa.attribute_id = $2
          AND LOWER(TRIM(sib_sa.value)) = m.color
          AND sib_sa.sku_id <> m.sku_id
        JOIN skus sib_s ON sib_s.id = sib_sa.sku_id
        JOIN products sib_p ON sib_p.id = sib_s.product_id
          AND sib_p.vendor_id = $1 AND sib_p.collection = m.collection
        JOIN packaging sib_pkg ON sib_pkg.sku_id = sib_s.id
        ORDER BY m.sku_id
      )
      INSERT INTO packaging (sku_id, sqft_per_box, pieces_per_box, weight_per_box_lbs,
        boxes_per_pallet, sqft_per_pallet, weight_per_pallet_lbs)
      SELECT sku_id, sqft_per_box, pieces_per_box, weight_per_box_lbs,
        boxes_per_pallet, sqft_per_pallet, weight_per_pallet_lbs
      FROM sources
      ON CONFLICT (sku_id) DO NOTHING
    `, [vendorId, ATTR.color]);
    console.log(`Packaging fill (same-collection color match): ${pkgColorFillRes.rowCount}`);

    await client.query('COMMIT');

    console.log(`\n=== Import Complete ===`);
    console.log(`Products:            ${totalProducts}`);
    console.log(`Field SKUs:          ${totalSkus}`);
    console.log(`Trim/Accessory SKUs: ${totalTrimSkus}`);
    console.log(`Total SKUs:          ${totalSkus + totalTrimSkus}`);
    console.log(`Pricing records:     ${totalPricing}`);
    console.log(`Packaging records:   ${totalPkg}`);
    console.log(`Attribute records:   ${totalAttrs}`);
    console.log(`Image records:       ${totalImages}`);

  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch(err => { console.error(err); process.exit(1); });
