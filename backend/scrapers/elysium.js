import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  delay, upsertProduct, upsertSku,
  upsertSkuAttribute, upsertPackaging, upsertPricing,
  upsertInventorySnapshot,
  appendLog, addJobError, upsertMediaAsset,
  buildVariantName, preferProductShot, isLifestyleUrl,
  saveSkuImages, saveProductImages, filterImageUrls,
} from './base.js';
import { elysiumLogin, elysiumFetch, BASE_URL } from './elysium-auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ──────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────

const DEFAULT_CSV_PATH = path.resolve(__dirname, '../data/elysium-pricelist.csv');

const DEFAULT_CONFIG = {
  csvPath: DEFAULT_CSV_PATH,
  mode: 'full',         // 'full' | 'inventory'
  delayMs: 1500,
  batchSize: 3,
  skipEnrichment: false,
};

// Max gallery images per SKU
const MAX_GALLERY_IMAGES = 8;

// ── Type Classification ──

const TYPE_CATEGORY_MAP = {
  'porcelain tile': 'porcelain-tile',
  'ceramic tile':   'ceramic-tile',
  'spc':            'lvp-plank',
  'paver':          'pavers',
  // slab, quartzite, quartz, granite, marble — skipped (not carried)
  'mosaic':         'mosaic-tile',
  'porcelain mosaic': 'mosaic-tile',
  'ceramic mosaic': 'mosaic-tile',
};

const TRIM_TYPES = new Set([
  'porcelain trim', 'ceramic trim', 'spct', 'porcelain deco',
]);

const MOSAIC_TYPES = new Set([
  'mosaic', 'porcelain mosaic', 'ceramic mosaic',
]);

// Types to skip entirely (not carried by Roma Flooring)
const SKIP_TYPES = new Set([
  'slab', 'quartzite', 'quartz', 'granite', 'marble', 'marble slab',
]);

// Collections that are wood-look porcelain → category 'wood-look-tile' instead of 'porcelain-tile'
const WOOD_LOOK_COLLECTIONS = new Set([
  '4ever', 'arte legno', 'artwood', 'clever', 'davinci', 'deck',
  'deco wood', 'details wood', 'ewood', 'faedo', 'harper', 'havana',
  'helsinki', 'larix', 'le plance', 'niara', 'norway', 'orto botanico',
  'planches', 'selection oak', 'sirouk', 'soft', 'taiga',
  'urban wood', 'wild wood', 'woodlands', 'woodtime',
]);

// ── Accessory Keywords (longer first to avoid partial matches) ──

const ACCESSORY_KEYWORDS = [
  'Stair Nose Round', 'Stair Nose', 'Quarter Round', 'Pencil Liner',
  'Chair Rail', 'Cove Base', 'T-Mold', 'Bullnose', 'Reducer',
  'Threshold', 'V-Cap', 'Jolly', 'Liner', 'Cane',
];

// ── Finish Words (used for name parsing) ──

const FINISH_WORDS = [
  'Matte', 'Polished', 'Honed', 'Glossy', 'Satin', 'Textured',
  'Lappato', 'Brushed', 'Tumbled', 'Grip', 'R11', 'Lux', 'Frosted',
  'Lucido', 'Levigato', 'Naturale', 'Lapado', 'Saw-Cut', 'Brillo',
  'Nat', 'Stripe 3D', '3D', 'Soft', 'Structured', 'Natural',
  'Silk', 'Glossy', 'Leather',
];

// Build regex: match one finish word at end, potentially repeated
const FINISH_RE = new RegExp(
  `\\s+(${FINISH_WORDS.map(escapeRegex).join('|')})\\s*$`, 'i'
);

// ── Size stripping regex ──
const SIZE_SUFFIX_RE = /\s+\d+\.?\d*\s*x\s*\d+\.?\d*(?:\s*x\s*\d+\.?\d*)?$/i;

// ──────────────────────────────────────────────
// Image scoring (Elysium-specific)
// ──────────────────────────────────────────────

// Elysium room-scene indicators (matched against base filename, case-insensitive)
// Only used for demotion — room scenes get pushed after product shots.
// Note: 'img_' removed — too many false positives (legitimate product shots use IMG_ prefix).
const ELY_ROOM_SCENE = [
  'csa_', 'csa-',   // CSA styled photos (manufacturer shoots)
  '_sto_', '_sto.',  // Store/showroom display
  'amb-', 'amb_', 'amb ', '_amb', // Room-scene abbreviation patterns
  'detalle',        // Spanish detail/scene
  '_bano', '-bano', // Spanish bathroom
  'bathroom', '_bath.', '_bath_',
  'restaurant', 'beauty center', 'smart working',
  '_shop.', '_shop_',
  'ambiente', 'bagno', 'cucina', 'ristorante', 'terrazza', 'soggiorno',
  'camera_', 'camera-',
  'room', 'scene', 'lifestyle', 'installed', 'showroom',
  'interior', 'kitchen', 'living', 'outdoor', 'pool',
  'insitu', 'in-situ', 'inspiration', 'styled',
  // Additional room-scene keywords found in Elysium filenames
  'reception', 'lobby', 'lounge', 'hotel', 'corridor', 'patio',
  'bedroom', 'dining', 'terrace', 'garden', 'hallway',
  'display', 'project', 'setting', 'vignette',
  // Italian room-scene words
  'posa', 'esterno', 'ingresso', 'veranda', 'giardino',
  'pavimento', 'rivestimento', 'vetrina', 'negozio',
  'parete', 'salotto', 'ufficio', 'balcone', 'realizzazione',
  // Spanish room-scene words
  'cocina', 'salon', 'exterior', 'proyecto',
  // Filename patterns indicating styled/layout shots
  '_int_', '_int.',
  // Renders and marketing
  'render', 'rendering', 'hero', 'banner', 'promo',
];

/**
 * Reorder Elysium gallery to ensure product shots come before room scenes.
 *
 * Strategy:
 *   1. Demote images with room-scene keywords (strong signal).
 *   2. Among remaining "clean" images, prefer LOW trailing file numbers (_1, _2)
 *      over HIGH ones (_5, _7, _10). Elysium's CMS puts recently-added images
 *      first in the gallery, but their original product shots are typically the
 *      low-numbered files while room scenes added later get higher numbers.
 *   3. Final safety net via base.js isLifestyleUrl.
 *
 * Returns a new array sorted by priority.
 */
function scoreElysiumImages(urls, colorHint, productName) {
  if (!urls || urls.length <= 1) return urls || [];

  const prodLow = (productName || '').toLowerCase();

  function isRoomScene(url) {
    const fn = url.toLowerCase().split('/').pop().split('?')[0];
    // Strip the 1000_ID- prefix to get the actual filename
    const baseFn = fn.replace(/^\d+_\d+-/, '');

    for (const kw of ELY_ROOM_SCENE) {
      if (baseFn.includes(kw) && !prodLow.includes(kw)) return true;
    }
    return false;
  }

  /**
   * Extract trailing number from filename (e.g., "dolomite_30x60_5.jpg" → 5).
   * Returns null if no trailing number found (e.g., named files like "amb_kitchen.jpg").
   */
  function getTrailingNumber(url) {
    const fn = url.split('/').pop().split('?')[0];
    const m = fn.match(/[_-](\d{1,2})\.(?:jpg|jpeg|png|webp)$/i);
    return m ? parseInt(m[1], 10) : null;
  }

  // Partition into keyword-matched room scenes vs clean images
  const clean = [];
  const roomScenes = [];
  for (const url of urls) {
    if (isRoomScene(url)) {
      roomScenes.push(url);
    } else {
      clean.push(url);
    }
  }

  // Sort clean images: prefer low trailing file numbers (product shots)
  // If an image has no trailing number, keep it in its original relative position
  // among images without numbers.
  clean.sort((a, b) => {
    const numA = getTrailingNumber(a);
    const numB = getTrailingNumber(b);
    // Both have numbers: lower number wins
    if (numA !== null && numB !== null) return numA - numB;
    // Only one has a number: numbered files come first (they're catalog images)
    if (numA !== null) return -1;
    if (numB !== null) return 1;
    // Neither has a number: preserve original gallery order
    return 0;
  });

  const sorted = [...clean, ...roomScenes];

  // Final safety net: if the top result is still caught by base.js isLifestyleUrl, swap
  if (sorted.length > 1 && isLifestyleUrl(sorted[0], productName)) {
    const swapIdx = sorted.findIndex(u => !isLifestyleUrl(u, productName));
    if (swapIdx > 0) [sorted[0], sorted[swapIdx]] = [sorted[swapIdx], sorted[0]];
  }

  return sorted;
}

// ──────────────────────────────────────────────
// Utility functions
// ──────────────────────────────────────────────

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripTags(str) {
  return str.replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

// ──────────────────────────────────────────────
// A1. Parse CSV
// ──────────────────────────────────────────────

/**
 * Load and parse the Elysium CSV price list.
 * Returns array of structured row objects.
 */
function loadCsvPriceList(csvPath) {
  const raw = fs.readFileSync(csvPath, 'utf-8');
  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);

  // Find the header line
  const headerIdx = lines.findIndex(l => l.startsWith('Item Code,'));
  if (headerIdx < 0) throw new Error('CSV header line not found');

  const rows = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    // Simple CSV split — the Elysium CSV has no embedded commas in quoted fields
    const cols = line.split(',');
    if (cols.length < 7) continue;

    const itemCode = cols[0].trim();
    const itemName = cols[1].trim();
    const collection = cols[2].trim();
    const priceStr = cols[3].trim();
    const per = cols[4].trim().toLowerCase();
    const type = cols[5].trim().toLowerCase();
    const sizeRaw = cols[6].trim();
    const packagingStr = cols[7] ? cols[7].trim() : '';
    const sfPerPc = cols[8] ? cols[8].trim() : '';
    const saleStr = cols[9] ? cols[9].trim() : '';
    const msrpStr = cols[10] ? cols[10].trim() : '';
    const poolRatedStr = cols[11] ? cols[11].trim() : '';

    if (!itemCode || !itemName) continue;
    if (type === 'type') continue; // header row duplicate

    // Parse price
    const cost = parseFloat(priceStr) || 0;
    const msrp = parseFloat(msrpStr) || (cost > 0 ? cost * 2 : 0);

    // Parse packaging: "6pc / 15.5sf" → { piecesPerBox: 6, sqftPerBox: 15.5 }
    let piecesPerBox = null;
    let sqftPerBox = null;
    const pkgMatch = packagingStr.match(/(\d+)pc\s*\/\s*([\d.]+)sf/i);
    if (pkgMatch) {
      piecesPerBox = parseInt(pkgMatch[1]) || null;
      sqftPerBox = parseFloat(pkgMatch[2]) || null;
    }

    // Parse sf/pc (square feet per piece, for sheet-sold mosaics)
    const sqftPerPiece = parseFloat(sfPerPc) || null;

    // Normalize size: strip quotes/inch marks
    const sizeNormalized = sizeRaw
      .replace(/["″'']/g, '')
      .replace(/\s*[xX×]\s*/g, ' x ')
      .trim();

    // Map per → sell_by and price_basis
    let sellBy = 'sqft';
    let priceBasis = 'per_sqft';
    if (per === 'sh' || per === 'pc' || per === 'set') {
      sellBy = 'unit';
      priceBasis = 'per_unit';
    }

    rows.push({
      itemCode,
      itemName,
      collection,
      cost,
      per,
      type,
      sizeRaw: sizeNormalized,
      piecesPerBox,
      sqftPerBox,
      sqftPerPiece,
      sellBy,
      priceBasis,
      msrp,
      onSale: saleStr.toLowerCase() === 'yes',
      poolRated: poolRatedStr.toLowerCase() === 'yes',
    });
  }

  return rows;
}

// ──────────────────────────────────────────────
// A2. Type Classification
// ──────────────────────────────────────────────

function classifyCsvType(type) {
  const isTrim = TRIM_TYPES.has(type);
  const isMosaic = MOSAIC_TYPES.has(type);
  const categorySlug = TYPE_CATEGORY_MAP[type] || null;
  return { isTrim, isMosaic, categorySlug };
}

// ──────────────────────────────────────────────
// A3. Name Parsing
// ──────────────────────────────────────────────

/**
 * Parse an Elysium item name into { colorName, finish, accessoryKeyword, mosaicLabel }.
 *
 * Strategy: strip trailing size, strip collection prefix, extract accessory keyword,
 * extract mosaic label, extract trailing finish words, remainder = color name.
 */
function parseItemName(itemName, collection, type) {
  let name = itemName;

  // 1. Strip trailing size
  name = name.replace(SIZE_SUFFIX_RE, '').trim();

  // 2. Strip collection prefix (case-insensitive)
  if (collection) {
    const re = new RegExp(`^${escapeRegex(collection)}\\s+`, 'i');
    name = name.replace(re, '');
  }

  // 3. Extract accessory keyword (for trims)
  let accessoryKeyword = null;
  const isTrim = TRIM_TYPES.has(type);
  if (isTrim) {
    for (const kw of ACCESSORY_KEYWORDS) {
      const kwRe = new RegExp(`\\s+${escapeRegex(kw)}\\s*$`, 'i');
      if (kwRe.test(name)) {
        accessoryKeyword = kw;
        name = name.replace(kwRe, '').trim();
        break;
      }
      // Also try in the middle of the name (before finish)
      const kwMidRe = new RegExp(`\\s+${escapeRegex(kw)}(?=\\s|$)`, 'i');
      if (kwMidRe.test(name)) {
        accessoryKeyword = kw;
        name = name.replace(kwMidRe, ' ').trim();
        break;
      }
    }
  }

  // 4. Extract mosaic label
  let mosaicLabel = null;
  const isMosaic = MOSAIC_TYPES.has(type);
  if (isMosaic) {
    // "Mosaic 2 x 2" or just "Mosaic"
    const mosaicMatch = name.match(/\s+Mosaic(?:\s+(\d+\.?\d*\s*x\s*\d+\.?\d*))?\s*$/i);
    if (mosaicMatch) {
      mosaicLabel = mosaicMatch[1] ? `Mosaic ${mosaicMatch[1].trim()}` : 'Mosaic';
      name = name.replace(mosaicMatch[0], '').trim();
    }
  }

  // 5. Strip parenthetical codes first (e.g., "(HAO210)", "(Silica Free)")
  name = name.replace(/\s*\([^)]+\)\s*$/, '').trim();

  // 6. Strip paver/slab qualifiers that aren't finishes
  name = name.replace(/\s+2cm\s+Paver\s*$/i, '').trim();
  name = name.replace(/\s+3cm\s*$/i, '').trim();
  name = name.replace(/\s+6MM\s*$/i, '').trim();

  // 7. Extract trailing finish words (may be multiple, e.g. "Matte Bullnose" → only finish left)
  const finishes = [];
  let m;
  while ((m = name.match(FINISH_RE)) !== null) {
    finishes.unshift(m[1]);
    name = name.slice(0, name.length - m[0].length).trim();
  }
  const finish = finishes.length > 0 ? finishes.join(' ') : null;

  // 8. Remainder = colorName
  const colorName = name || itemName;

  return { colorName, finish, accessoryKeyword, mosaicLabel };
}

// ──────────────────────────────────────────────
// A4. Product Grouping
// ──────────────────────────────────────────────

/**
 * Group CSV rows into product groups, separating trims and mosaics.
 *
 * Groups field tiles by collection + color ONLY — finish becomes part of
 * the variant name so "Ivory Matte 12x24" and "Ivory Polished 24x48"
 * live under one product "Ivory" with variant pills for each size+finish.
 *
 * Returns { products: Map, trimRows: [], mosaicRows: [] }
 * products Map key: "collection|colorName" (lowercase)
 * products Map value: { collection, colorName, categorySlug, skus: CsvRow[] }
 */
function buildProductGroups(csvRows) {
  const products = new Map();
  const trimRows = [];
  const mosaicRows = [];

  let skippedCount = 0;
  for (const row of csvRows) {
    if (SKIP_TYPES.has(row.type)) { skippedCount++; continue; }
    const { isTrim, isMosaic, categorySlug } = classifyCsvType(row.type);
    const { colorName, finish, accessoryKeyword, mosaicLabel } = parseItemName(
      row.itemName, row.collection, row.type
    );

    // Attach parsed fields to row for later use
    row._colorName = colorName;
    row._finish = finish;
    row._accessoryKeyword = accessoryKeyword;
    row._mosaicLabel = mosaicLabel;
    row._categorySlug = categorySlug;

    if (isTrim) {
      trimRows.push(row);
      continue;
    }

    if (isMosaic) {
      mosaicRows.push(row);
      continue;
    }

    // Override category for wood-look porcelain collections
    let finalCategorySlug = categorySlug;
    if (categorySlug === 'porcelain-tile' &&
        WOOD_LOOK_COLLECTIONS.has((row.collection || '').toLowerCase())) {
      finalCategorySlug = 'wood-look-tile';
    }

    // Field tile / slab / SPC / stone → group by collection + color (finish is per-SKU)
    const key = `${(row.collection || '').toLowerCase()}|${colorName.toLowerCase()}`;
    if (!products.has(key)) {
      products.set(key, {
        collection: row.collection,
        colorName,
        categorySlug: finalCategorySlug,
        skus: [],
      });
    }
    products.get(key).skus.push(row);
  }

  return { products, trimRows, mosaicRows, skippedCount };
}

/**
 * Match mosaics to parent field tile products.
 * Returns { matched: [{row, parentKey}], orphans: [] }
 */
function matchMosaicsToParents(mosaicRows, productsMap) {
  const matched = [];
  const orphans = [];

  for (const row of mosaicRows) {
    const coll = (row.collection || '').toLowerCase();
    const color = row._colorName.toLowerCase();

    // Direct match: collection + color
    const parentKey = `${coll}|${color}`;
    if (productsMap.has(parentKey)) {
      matched.push({ row, parentKey });
    } else {
      orphans.push(row);
    }
  }

  return { matched, orphans };
}

// ──────────────────────────────────────────────
// A5. Create Products/SKUs from CSV
// ──────────────────────────────────────────────

/**
 * Upsert products and SKUs from grouped CSV data.
 * Returns productMap: Map<productKey, { productId, skuIds: Map<itemCode, skuId> }>
 */
async function createProductsFromCsv(pool, productsMap, vendor_id, categoryLookup, job) {
  const productMap = new Map();
  let groupIdx = 0;
  const total = productsMap.size;

  for (const [key, group] of productsMap) {
    try {
      const { collection, colorName, categorySlug, skus } = group;
      const categoryId = categorySlug ? (categoryLookup.get(categorySlug) || null) : null;

      // Product name: just the color (finish lives on each SKU variant)
      const productName = colorName;

      const product = await upsertProduct(pool, {
        vendor_id,
        name: productName,
        collection: collection || '',
        category_id: categoryId,
      });

      const skuIds = new Map();

      for (const row of skus) {
        const internalSku = `ELY-${row.itemCode}`;

        // variant_name = size + finish (e.g., "12 x 24, Matte")
        const variantName = buildVariantName(row.sizeRaw, row._finish);

        const sku = await upsertSku(pool, {
          product_id: product.id,
          vendor_sku: row.itemCode,
          internal_sku: internalSku,
          variant_name: variantName,
          sell_by: row.sellBy,
        });

        skuIds.set(row.itemCode, sku.id);

        // Pricing
        await upsertPricing(pool, sku.id, {
          cost: row.cost,
          retail_price: row.msrp,
          price_basis: row.priceBasis,
        });

        // Packaging
        if (row.piecesPerBox || row.sqftPerBox) {
          await upsertPackaging(pool, sku.id, {
            pieces_per_box: row.piecesPerBox,
            sqft_per_box: row.sqftPerBox,
          });
        }

        // SKU Attributes
        if (row._colorName) await upsertSkuAttribute(pool, sku.id, 'color', row._colorName);
        if (row._finish) await upsertSkuAttribute(pool, sku.id, 'finish', row._finish);
        if (row.sizeRaw) await upsertSkuAttribute(pool, sku.id, 'size', row.sizeRaw);
        if (row.type) await upsertSkuAttribute(pool, sku.id, 'material', row.type);
        if (row.poolRated) await upsertSkuAttribute(pool, sku.id, 'pool_rated', 'Yes');
      }

      productMap.set(key, { productId: product.id, skuIds, productName, collection });
    } catch (err) {
      await addJobError(pool, job.id, `Product group ${key}: ${err.message}`);
    }

    groupIdx++;
    if (groupIdx % 100 === 0 || groupIdx === total) {
      await appendLog(pool, job.id, `CSV product upsert: ${groupIdx}/${total}`, {
        products_created: groupIdx,
      });
    }
  }

  return productMap;
}

// ──────────────────────────────────────────────
// A6. Attach Accessories
// ──────────────────────────────────────────────

/**
 * Attach trim rows as accessories to parent products.
 * Returns stats { attached, standalone }.
 */
async function attachTrimAccessories(pool, productsMap, productMap, trimRows, vendor_id, categoryLookup, job) {
  let attached = 0;
  let standalone = 0;

  for (const row of trimRows) {
    try {
      const coll = (row.collection || '').toLowerCase();
      const color = row._colorName.toLowerCase();

      // Direct match: collection + color
      const parentKey = `${coll}|${color}`;
      let parentData = productMap.get(parentKey);

      if (parentData) {
        // Create as accessory SKU under parent product
        const internalSku = `ELY-${row.itemCode}`;
        const accLabel = row._accessoryKeyword || 'Trim';
        const variantName = accLabel + (row.sizeRaw ? ` ${row.sizeRaw}` : '');

        const sku = await upsertSku(pool, {
          product_id: parentData.productId,
          vendor_sku: row.itemCode,
          internal_sku: internalSku,
          variant_name: variantName,
          sell_by: row.sellBy,
          variant_type: 'accessory',
        });

        // Set accessory_label
        await pool.query(
          'UPDATE skus SET accessory_label = $1 WHERE id = $2',
          [accLabel, sku.id]
        );

        // Pricing
        await upsertPricing(pool, sku.id, {
          cost: row.cost,
          retail_price: row.msrp,
          price_basis: row.priceBasis,
        });

        // Packaging
        if (row.piecesPerBox || row.sqftPerBox) {
          await upsertPackaging(pool, sku.id, {
            pieces_per_box: row.piecesPerBox,
            sqft_per_box: row.sqftPerBox,
          });
        }

        // Link to all parent SKUs via sku_accessories
        for (const [, parentSkuId] of parentData.skuIds) {
          await pool.query(`
            INSERT INTO sku_accessories (parent_sku_id, accessory_sku_id, sort_order)
            VALUES ($1, $2, 0)
            ON CONFLICT (parent_sku_id, accessory_sku_id) DO NOTHING
          `, [parentSkuId, sku.id]);
        }

        attached++;
      } else {
        // No parent found — create as standalone product
        const { categorySlug } = classifyCsvType(row.type);
        // SPCT = SPC transition pieces (quarter round, reducer, etc.) → transitions-moldings
        // Other trims → porcelain-tile fallback
        const catSlug = categorySlug || (row.type === 'spct' ? 'transitions-moldings' : 'porcelain-tile');
        const categoryId = categoryLookup.get(catSlug) || null;
        const product = await upsertProduct(pool, {
          vendor_id,
          name: row._colorName,
          collection: row.collection || '',
          category_id: categoryId,
        });

        const internalSku = `ELY-${row.itemCode}`;
        const accLabel = row._accessoryKeyword || 'Trim';
        const variantName = accLabel + (row.sizeRaw ? ` ${row.sizeRaw}` : '');

        const sku = await upsertSku(pool, {
          product_id: product.id,
          vendor_sku: row.itemCode,
          internal_sku: internalSku,
          variant_name: variantName,
          sell_by: row.sellBy,
        });

        await upsertPricing(pool, sku.id, {
          cost: row.cost,
          retail_price: row.msrp,
          price_basis: row.priceBasis,
        });

        if (row.piecesPerBox || row.sqftPerBox) {
          await upsertPackaging(pool, sku.id, {
            pieces_per_box: row.piecesPerBox,
            sqft_per_box: row.sqftPerBox,
          });
        }

        standalone++;
        await appendLog(pool, job.id, `WARN: Trim ${row.itemCode} (${row.itemName}) — no parent found, created standalone`);
      }
    } catch (err) {
      await addJobError(pool, job.id, `Trim ${row.itemCode}: ${err.message}`);
    }
  }

  return { attached, standalone };
}

/**
 * Attach matched mosaics as accessories, create orphans as standalone products.
 */
async function attachMosaicAccessories(pool, productsMap, productMap, matchedMosaics, orphanMosaics, vendor_id, categoryLookup, job) {
  let attached = 0;
  let orphanCreated = 0;

  // Matched mosaics → accessory under parent
  for (const { row, parentKey } of matchedMosaics) {
    try {
      const parentData = productMap.get(parentKey);
      if (!parentData) continue;

      const internalSku = `ELY-${row.itemCode}`;
      const accLabel = row._mosaicLabel || 'Mosaic';
      const variantName = accLabel + (row.sizeRaw ? ` ${row.sizeRaw}` : '');

      const sku = await upsertSku(pool, {
        product_id: parentData.productId,
        vendor_sku: row.itemCode,
        internal_sku: internalSku,
        variant_name: variantName,
        sell_by: row.sellBy,
        variant_type: 'accessory',
      });

      await pool.query(
        'UPDATE skus SET accessory_label = $1 WHERE id = $2',
        [accLabel, sku.id]
      );

      await upsertPricing(pool, sku.id, {
        cost: row.cost,
        retail_price: row.msrp,
        price_basis: row.priceBasis,
      });

      if (row.piecesPerBox || row.sqftPerBox) {
        await upsertPackaging(pool, sku.id, {
          pieces_per_box: row.piecesPerBox,
          sqft_per_box: row.sqftPerBox,
        });
      }

      // Link to all parent SKUs
      for (const [, parentSkuId] of parentData.skuIds) {
        await pool.query(`
          INSERT INTO sku_accessories (parent_sku_id, accessory_sku_id, sort_order)
          VALUES ($1, $2, 0)
          ON CONFLICT (parent_sku_id, accessory_sku_id) DO NOTHING
        `, [parentSkuId, sku.id]);
      }

      attached++;
    } catch (err) {
      await addJobError(pool, job.id, `Mosaic acc ${row.itemCode}: ${err.message}`);
    }
  }

  // Orphan mosaics → standalone products
  const orphanEnrichItems = [];
  for (const row of orphanMosaics) {
    try {
      const categoryId = categoryLookup.get('mosaic-tile') || null;

      const product = await upsertProduct(pool, {
        vendor_id,
        name: row._colorName,
        collection: row.collection || '',
        category_id: categoryId,
      });

      const internalSku = `ELY-${row.itemCode}`;
      const variantName = row.sizeRaw || null;

      const sku = await upsertSku(pool, {
        product_id: product.id,
        vendor_sku: row.itemCode,
        internal_sku: internalSku,
        variant_name: variantName,
        sell_by: row.sellBy,
      });

      await upsertPricing(pool, sku.id, {
        cost: row.cost,
        retail_price: row.msrp,
        price_basis: row.priceBasis,
      });

      if (row.piecesPerBox || row.sqftPerBox) {
        await upsertPackaging(pool, sku.id, {
          pieces_per_box: row.piecesPerBox,
          sqft_per_box: row.sqftPerBox,
        });
      }

      // Store mosaic-specific attributes
      if (row._colorName) await upsertSkuAttribute(pool, sku.id, 'color', row._colorName);
      if (row._finish) await upsertSkuAttribute(pool, sku.id, 'finish', row._finish);
      if (row.sizeRaw) await upsertSkuAttribute(pool, sku.id, 'size', row.sizeRaw);
      if (row.type) await upsertSkuAttribute(pool, sku.id, 'material', row.type);

      // Collect for enrichment
      orphanEnrichItems.push({
        itemName: row.itemName,
        itemCode: row.itemCode,
        productId: product.id,
        skuId: sku.id,
        colorName: row._colorName,
        collection: row.collection,
        productKey: `orphan-mosaic-${row.itemCode}`,
      });

      orphanCreated++;
    } catch (err) {
      await addJobError(pool, job.id, `Mosaic orphan ${row.itemCode}: ${err.message}`);
    }
  }

  return { attached, orphanCreated, orphanEnrichItems };
}

// ──────────────────────────────────────────────
// Phase B: Website Enrichment
// ──────────────────────────────────────────────

/**
 * Build a list of items to enrich from the website.
 * Includes field tiles, orphan mosaics, and standalone trims.
 * Each size variant has its own Elysium detail page.
 *
 * @param {Map} productsMap - field tile product groups
 * @param {Map} productMap - product/SKU ID lookup
 * @param {Array} extraItems - additional {itemName, itemCode, productId, skuId, colorName, collection} entries
 */
function buildEnrichmentList(productsMap, productMap, extraItems = []) {
  const list = [];

  for (const [key, group] of productsMap) {
    const data = productMap.get(key);
    if (!data) continue;

    // Each SKU (size variant) has its own detail page on Elysium
    for (const row of group.skus) {
      const skuId = data.skuIds.get(row.itemCode);
      if (!skuId) continue;
      list.push({
        itemName: row.itemName,
        itemCode: row.itemCode,
        productId: data.productId,
        skuId,
        colorName: row._colorName,
        collection: row.collection,
        productKey: key,
      });
    }
  }

  // Add orphan mosaics, standalone trims, etc.
  for (const item of extraItems) {
    list.push(item);
  }

  return list;
}

/**
 * Enrich products from website detail pages.
 * Fetches images, descriptions, specs, catalog PDFs.
 * Detects and marks discontinued products.
 */
async function enrichFromWebsite(pool, cookies, enrichmentList, productMap, job, config) {
  const batchSize = config.batchSize || 3;
  const delayMs = config.delayMs || 1500;

  // Track which products already have product-level images saved
  const productImagesSaved = new Set();
  // Track discontinued products
  const discontinuedProductIds = new Set();

  let fetchIdx = 0;
  const total = enrichmentList.length;

  await appendLog(pool, job.id, `Phase B: Enriching ${total} SKUs from website (batch ${batchSize})...`);

  for (let batchStart = 0; batchStart < total; batchStart += batchSize) {
    const batch = enrichmentList.slice(batchStart, batchStart + batchSize);

    const batchPromises = batch.map(async (item) => {
      try {
        // Construct URL from item name
        const encodedName = item.itemName.replace(/ /g, '+');
        const detailUrl = `/product?id=${encodedName}`;

        const resp = await elysiumFetch(detailUrl, cookies, {
          signal: AbortSignal.timeout(30000),
        });
        const html = await resp.text();

        if (!html.includes('product-title')) return;

        // Discontinued check
        const productTitleIdx = html.indexOf('product-title');
        if (productTitleIdx > 0) {
          const productInfoEnd = html.indexOf('<form action="/cart.php"');
          const productArea = productInfoEnd > productTitleIdx
            ? html.substring(productTitleIdx, productInfoEnd)
            : html.substring(productTitleIdx, productTitleIdx + 2000);
          if (/>\s*Discontinued\s*<\/(?:h[1-6]|div|span|p)/i.test(productArea) ||
              /Discontinued on \d{4}/i.test(productArea) ||
              /class="[^"]*discontinued/i.test(productArea)) {
            // Mark product as discontinued
            discontinuedProductIds.add(item.productId);
            await pool.query(
              `UPDATE products SET status = 'discontinued', updated_at = NOW() WHERE id = $1`,
              [item.productId]
            );
            await pool.query(
              `UPDATE skus SET status = 'inactive', updated_at = NOW() WHERE product_id = $1`,
              [item.productId]
            );
            return;
          }
        }

        const detail = parseDetailPage(html);

        // ── Description (product-level, save once) ──
        if (detail.description && !productImagesSaved.has(`desc-${item.productId}`)) {
          await pool.query(
            `UPDATE products SET description_long = COALESCE(description_long, $1),
             description_short = COALESCE(description_short, $2),
             updated_at = NOW() WHERE id = $3`,
            [detail.description, detail.description.slice(0, 255), item.productId]
          );
          productImagesSaved.add(`desc-${item.productId}`);
        }

        // ── Catalog PDF (product-level, save once) ──
        if (detail.catalogPdf && !productImagesSaved.has(`pdf-${item.productId}`)) {
          const pdfUrl = detail.catalogPdf.startsWith('http')
            ? detail.catalogPdf
            : `${BASE_URL}${detail.catalogPdf}`;
          await upsertMediaAsset(pool, {
            product_id: item.productId,
            sku_id: null,
            asset_type: 'spec_pdf',
            url: pdfUrl,
            original_url: pdfUrl,
            sort_order: 99,
          });
          productImagesSaved.add(`pdf-${item.productId}`);
        }

        // ── Specs / Technical Specs as SKU attributes ──
        if (detail.specs.thickness) await upsertSkuAttribute(pool, item.skuId, 'thickness', detail.specs.thickness);
        if (detail.specs.countryOfOrigin) await upsertSkuAttribute(pool, item.skuId, 'country', detail.specs.countryOfOrigin);
        if (detail.specs.edge) await upsertSkuAttribute(pool, item.skuId, 'edge', detail.specs.edge);
        if (detail.specs.look) await upsertSkuAttribute(pool, item.skuId, 'look', detail.specs.look);
        if (detail.technicalSpecs.application) await upsertSkuAttribute(pool, item.skuId, 'application', detail.technicalSpecs.application);
        if (detail.technicalSpecs.peiRating) await upsertSkuAttribute(pool, item.skuId, 'pei_rating', detail.technicalSpecs.peiRating);
        if (detail.technicalSpecs.shadeVariation) await upsertSkuAttribute(pool, item.skuId, 'shade_variation', detail.technicalSpecs.shadeVariation);
        if (detail.technicalSpecs.waterAbsorption) await upsertSkuAttribute(pool, item.skuId, 'water_absorption', detail.technicalSpecs.waterAbsorption);
        if (detail.technicalSpecs.dcof) await upsertSkuAttribute(pool, item.skuId, 'dcof', detail.technicalSpecs.dcof);

        // ── Packaging supplement (weight, pallet data from website) ──
        if (detail.packaging && Object.keys(detail.packaging).length > 0) {
          const pkg = detail.packaging;
          await upsertPackaging(pool, item.skuId, {
            weight_per_box_lbs: pkg.weightPerBox || null,
            boxes_per_pallet: pkg.boxesPerPallet || null,
            sqft_per_pallet: pkg.sqftPerPallet || null,
            weight_per_pallet_lbs: pkg.weightPerPallet || null,
          });
        }

        // ── Inventory (CA warehouse) ──
        if (detail.inventory.caSqft != null) {
          await upsertInventorySnapshot(pool, item.skuId, 'CA', {
            qty_on_hand_sqft: detail.inventory.caSqft,
            qty_in_transit_sqft: detail.inventory.caInTransitSqft || 0,
          });
        }

        // ── Images ──
        const gallery = detail.galleryImages;
        if (gallery.length > 0) {
          // Collect image URLs, preferring /1000/ versions
          const varUrls = gallery.map(img => {
            const u = img.url1000 || img.url750;
            return u.startsWith('http') ? u : `${BASE_URL}${u}`;
          });

          // Elysium-specific image sorting: their gallery often puts room scenes first.
          // Score each image to prefer product-only shots.
          const productName = `${item.colorName} ${item.collection || ''}`;
          const sortedUrls = scoreElysiumImages(varUrls, item.colorName, productName);

          // Save SKU-level images
          await saveSkuImages(pool, item.productId, item.skuId, sortedUrls.slice(0, MAX_GALLERY_IMAGES), { productName });

          // Product-level primary image (save once per product, from first enriched SKU)
          if (!productImagesSaved.has(`img-${item.productId}`) && sortedUrls.length > 0) {
            await saveProductImages(pool, item.productId, sortedUrls.slice(0, 4), { productName });
            productImagesSaved.add(`img-${item.productId}`);
          }
        }
      } catch (err) {
        // Non-fatal: log and continue
        if (fetchIdx < 10) {
          await appendLog(pool, job.id, `WARN enrich ${item.itemCode}: ${err.message}`);
        }
      }
    });

    await Promise.all(batchPromises);
    fetchIdx += batch.length;

    if (fetchIdx % 150 < batchSize || fetchIdx === total) {
      await appendLog(pool, job.id, `Enrich progress: ${fetchIdx}/${total} SKUs`);
    }

    await delay(delayMs);
  }

  return { discontinuedCount: discontinuedProductIds.size };
}

// ──────────────────────────────────────────────
// Detail Page Parser (reused from original)
// ──────────────────────────────────────────────

/**
 * Parse a product detail page (authenticated).
 * Extracts images, description, specs, packaging, inventory, pricing, catalog PDF.
 */
function parseDetailPage(html) {
  const result = {
    title: null,
    itemCode: null,
    detailCategory: null,
    collection: null,
    finish: null,
    description: null,
    catalogPdf: null,
    galleryImages: [],
    specs: {},
    technicalSpecs: {},
    packaging: {},
    inventory: { caSqft: null, caInTransitSqft: 0 },
    pricing: { retailPerSqft: null },
    soldBy: null,
  };

  // Title
  const titleMatch = html.match(/class="product-title">\s*([\s\S]*?)\s*<\/div>/)
                  || html.match(/<h1[^>]*>\s*([\s\S]*?)\s*<\/h1>/);
  if (titleMatch) result.title = stripTags(titleMatch[1]).trim();

  // Category from h5.blue
  const blueH5 = html.match(/<h5[^>]*class="blue"[^>]*>\s*([\s\S]*?)\s*<\/h5>/);
  if (blueH5) result.detailCategory = stripTags(blueH5[1]).trim();

  // Item code
  const codeMatch = html.match(/item\s+code:\s*([A-Z0-9][\w-]*)/i);
  if (codeMatch) result.itemCode = codeMatch[1].trim();

  // Collection
  const collMatch = html.match(/<h4>([^<]+?)\s+Collection<\/h4>/i);
  if (collMatch) result.collection = collMatch[1].trim();

  // Finish
  const finishMatch = html.match(/available finish(?:es)?:\s*([^<\n]+)/i);
  if (finishMatch) result.finish = finishMatch[1].trim();

  // Catalog PDF
  const pdfMatch = html.match(/href="([^"]*products-pdf[^"]*\.pdf)"/i);
  if (pdfMatch) result.catalogPdf = pdfMatch[1];

  // Description
  const descMatch = html.match(/id="description"[^>]*>([\s\S]*?)(?:<div id="detailDescription|<div style="padding)/);
  if (descMatch) {
    let desc = descMatch[1]
      .replace(/<br\s*\/?>/g, ' ')
      .replace(/<[^>]+>/g, '')
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim();
    if (desc) result.description = desc;
  }

  // ── Specification tab ──
  const specSection = html.match(/id="specification"[^>]*>([\s\S]*?)(?:<\/div>\s*<\/div>\s*<\/div>|<div[^>]*id="packaging")/);
  if (specSection) {
    const specHtml = specSection[1];
    const thTdPairs = [...specHtml.matchAll(/<th[^>]*>([\s\S]*?)<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/gi)];

    const specFieldMap = {
      'collection': 'collection', 'type': 'type', 'thickness': 'thickness',
      'weight per piece': 'weightPerPiece', 'edge': 'edge',
      'country of origin': 'countryOfOrigin', 'look': 'look',
      'finish': 'finish', 'colors': 'colors',
    };
    const techFieldMap = {
      'application': 'application', 'abrasion resistance': 'abrasionResistance',
      'breaking strength': 'breakingStrength', 'dcof acutest': 'dcof', 'dcof': 'dcof',
      'din 51130': 'din51130', 'frost resistant': 'frostResistant', 'mohs': 'mohs',
      'pei rating': 'peiRating', 'shade variation': 'shadeVariation',
      'staining resistance': 'stainingResistance', 'thermal shock': 'thermalShock',
      'type of porcelain': 'typeOfPorcelain', 'water absorption': 'waterAbsorption',
    };

    let inTechnical = false;
    for (const pair of thTdPairs) {
      const rawLabel = stripTags(pair[1]).trim().toLowerCase();
      const rawValue = stripTags(pair[2]).replace(/\s+/g, ' ').trim();

      if (rawLabel === 'technical specification' || rawLabel === 'technical specifications') {
        inTechnical = true;
        continue;
      }
      if (!rawValue) continue;

      if (!inTechnical && specFieldMap[rawLabel]) {
        result.specs[specFieldMap[rawLabel]] = rawValue;
      } else if (inTechnical && techFieldMap[rawLabel]) {
        result.technicalSpecs[techFieldMap[rawLabel]] = rawValue;
      } else if (techFieldMap[rawLabel]) {
        result.technicalSpecs[techFieldMap[rawLabel]] = rawValue;
      }
    }

    if (result.specs.finish) result.finish = result.specs.finish;
    if (result.specs.collection && !result.collection) result.collection = result.specs.collection;
  }

  // ── Packaging tab ──
  const pkgSection = html.match(/id="packaging"[^>]*>([\s\S]*?)(?:<\/div>\s*<\/div>\s*<\/div>|<div[^>]*id=")/);
  if (pkgSection) {
    const pkgHtml = pkgSection[1];
    const pkgPairs = [...pkgHtml.matchAll(/<th[^>]*>([\s\S]*?)<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/gi)];

    for (const pair of pkgPairs) {
      const label = stripTags(pair[1]).trim().toLowerCase();
      const rawVal = stripTags(pair[2]).replace(/\s+/g, ' ').trim();

      if (label.includes('pieces per box')) {
        result.packaging.piecesPerBox = parseInt(rawVal) || null;
      } else if (label.includes('square feet per box') || label.includes('sqft per box')) {
        result.packaging.sqftPerBox = parseFloat(rawVal) || null;
      } else if (label.includes('weight per box')) {
        result.packaging.weightPerBox = parseFloat(rawVal.replace(/[^0-9.]/g, '')) || null;
      } else if (label.includes('boxes per pallet')) {
        result.packaging.boxesPerPallet = parseInt(rawVal) || null;
      } else if (label.includes('sqft per pallet') || label.includes('square feet per pallet')) {
        result.packaging.sqftPerPallet = parseFloat(rawVal.replace(/[^0-9.]/g, '')) || null;
      } else if (label.includes('weight per pallet')) {
        const weightStr = stripTags(pair[2]).replace(/,/g, '').trim();
        result.packaging.weightPerPallet = parseFloat(weightStr.replace(/[^0-9.]/g, '')) || null;
      }
    }
  }

  // ── Inventory (CA warehouse) ──
  const caInvMatch = html.match(/CA\s*-\s*\(([\d,]+)\s*SqFt\)/);
  if (caInvMatch) {
    result.inventory.caSqft = parseInt(caInvMatch[1].replace(/,/g, '')) || 0;
  }

  // ── ETA (incoming shipment for CA) ──
  const etaMatch = html.match(/ETA\s+CA:\s*([^<\n]+)/i);
  if (etaMatch) {
    const etaSqftMatch = etaMatch[1].match(/\[([\d,]+)\s*sf\]/i);
    if (etaSqftMatch) {
      result.inventory.caInTransitSqft = parseInt(etaSqftMatch[1].replace(/,/g, '')) || 0;
    }
  }

  // ── Pricing ──
  const priceMatch = html.match(/\$([\d.]+)\s*Per SqFt/i);
  if (priceMatch) {
    result.pricing.retailPerSqft = parseFloat(priceMatch[1]) || null;
  }

  // ── Sold By ──
  const soldByMatch = html.match(/Product Sold By ([^<\n]+)/i);
  if (soldByMatch) {
    const raw = soldByMatch[1].trim().toLowerCase();
    if (raw.includes('piece')) result.soldBy = 'unit';
    else result.soldBy = 'sqft';
  }

  // ── Gallery images from id="img_N" tags ──
  const galleryImgs = [...html.matchAll(/id="img_(\d+)"\s+src="([^"]+)"/g)];

  const img1000Map = new Map();
  const all1000 = [...html.matchAll(/src="(\/static\/images\/product\/1000\/[^"]+)"/g)];
  for (const m of all1000) {
    const base = m[1].replace('/static/images/product/1000/1000_', '');
    img1000Map.set(base, m[1]);
  }

  const seenBases = new Set();
  for (const m of galleryImgs) {
    const url750 = m[2];
    const base750 = url750.replace(/^.*\/750\/750_/, '');
    if (seenBases.has(base750)) continue;
    seenBases.add(base750);
    const url1000 = img1000Map.get(base750) || null;
    result.galleryImages.push({ url750, url1000 });
  }

  // Fallback to /750/ images
  if (result.galleryImages.length === 0) {
    const fallback750 = [...html.matchAll(/src="(\/static\/images\/product\/750\/[^"]+)"/g)];
    const seen = new Set();
    for (const m of fallback750) {
      if (seen.has(m[1])) continue;
      seen.add(m[1]);
      const base = m[1].replace('/static/images/product/750/750_', '');
      const url1000 = img1000Map.get(base) || null;
      result.galleryImages.push({ url750: m[1], url1000 });
    }
  }

  if (result.galleryImages.length > MAX_GALLERY_IMAGES) {
    result.galleryImages = result.galleryImages.slice(0, MAX_GALLERY_IMAGES);
  }

  return result;
}

// ──────────────────────────────────────────────
// Listing page parser (reused for inventory mode)
// ──────────────────────────────────────────────

const LISTING_SIZE_RE = /^(.+?)\s+(\d+\.?\d*\s*x\s*\d+\.?\d*(?:\s*x\s*\d+\.?\d*)?)$/i;

function parseListingPage(html, listingCategory) {
  const entries = [];
  const cardRegex = /<a\s+href="\/product\?id=([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let match;

  while ((match = cardRegex.exec(html)) !== null) {
    const productId = match[1];
    const cardContent = match[2];

    if (/Discontinued/i.test(cardContent) || /Coming Soon/i.test(cardContent)) continue;

    const fullName = decodeURIComponent(productId.replace(/\+/g, ' ')).trim();
    if (/\bsample\b/i.test(fullName)) continue;

    const thumbMatch = cardContent.match(/src="([^"]*\/static\/images\/product\/200\/[^"]+)"/);
    const thumbUrl = thumbMatch ? thumbMatch[1] : null;

    let itemCode = null;
    if (thumbUrl) {
      const idMatch = thumbUrl.match(/\/200_(\d+)-/);
      if (idMatch) itemCode = idMatch[1];
    }

    const sizeMatch = fullName.match(LISTING_SIZE_RE);
    const baseName = sizeMatch ? sizeMatch[1].trim() : fullName;
    const size = sizeMatch ? sizeMatch[2].trim() : null;

    entries.push({
      fullName, baseName, size,
      url: `/product?id=${productId}`,
      listingCategory, thumbUrl, itemCode,
    });
  }

  return entries;
}

// ──────────────────────────────────────────────
// Main run() function
// ──────────────────────────────────────────────

/**
 * Elysium Tile scraper — CSV-first with website enrichment.
 *
 * Modes (set via source.config.mode):
 *   'full'      — (default) CSV import + website enrichment
 *   'inventory' — Lightweight pass: fetches detail pages, updates inventory/pricing for existing SKUs
 *
 * Config options:
 *   csvPath: path to CSV price list (defaults to backend/data/elysium-pricelist.csv)
 *   skipEnrichment: true to skip Phase B (CSV-only import)
 *   delayMs: delay between batches (default 1500)
 *   batchSize: concurrent detail page fetches (default 3)
 */
export async function run(pool, job, source) {
  const config = { ...DEFAULT_CONFIG, ...(source.config || {}) };
  const vendor_id = source.vendor_id;
  const isInventoryMode = config.mode === 'inventory';

  await appendLog(pool, job.id, `Mode: ${isInventoryMode ? 'INVENTORY' : 'FULL'}`);

  // ── Inventory mode: unchanged legacy flow ──
  if (isInventoryMode) {
    await runInventoryMode(pool, job, source, config);
    return;
  }

  // ── Full mode: CSV-first pipeline ──

  const stats = {
    csvRows: 0, products: 0, skus: 0,
    trimsAttached: 0, trimsStandalone: 0,
    mosaicsAttached: 0, mosaicOrphans: 0,
    enriched: 0, discontinued: 0, errors: 0,
  };

  // Ensure required attributes exist
  const requiredAttrs = [
    { name: 'Edge', slug: 'edge', display_order: 11 },
    { name: 'Look', slug: 'look', display_order: 12 },
    { name: 'Water Absorption', slug: 'water_absorption', display_order: 13 },
    { name: 'DCOF', slug: 'dcof', display_order: 14 },
    { name: 'Pool Rated', slug: 'pool_rated', display_order: 15 },
  ];
  for (const attr of requiredAttrs) {
    await pool.query(`
      INSERT INTO attributes (name, slug, display_order)
      VALUES ($1, $2, $3) ON CONFLICT (slug) DO NOTHING
    `, [attr.name, attr.slug, attr.display_order]);
  }

  // Build category lookup
  const categoryLookup = new Map();
  try {
    const catRows = await pool.query('SELECT id, slug FROM categories WHERE is_active = true');
    for (const row of catRows.rows) categoryLookup.set(row.slug, row.id);
  } catch {}

  // ════════════════════════════════════════════
  // Phase A: CSV Import
  // ════════════════════════════════════════════

  await appendLog(pool, job.id, `Phase A: Loading CSV from ${config.csvPath}...`);

  let csvRows;
  try {
    csvRows = loadCsvPriceList(config.csvPath);
  } catch (err) {
    await addJobError(pool, job.id, `CSV load failed: ${err.message}`);
    throw err;
  }
  stats.csvRows = csvRows.length;
  await appendLog(pool, job.id, `Parsed ${csvRows.length} CSV rows`, { products_found: csvRows.length });

  // A4: Group products, separate trims/mosaics
  const { products: productsMap, trimRows, mosaicRows, skippedCount } = buildProductGroups(csvRows);
  await appendLog(pool, job.id,
    `Grouped: ${productsMap.size} products, ${trimRows.length} trims, ${mosaicRows.length} mosaics` +
    (skippedCount ? `, ${skippedCount} skipped` : '')
  );

  // A4b: Match mosaics to parents
  const { matched: matchedMosaics, orphans: orphanMosaics } = matchMosaicsToParents(mosaicRows, productsMap);
  await appendLog(pool, job.id,
    `Mosaics: ${matchedMosaics.length} matched to parents, ${orphanMosaics.length} orphans`
  );

  // A5: Create products and SKUs from CSV
  await appendLog(pool, job.id, 'Creating products and SKUs from CSV...');
  const productMap = await createProductsFromCsv(pool, productsMap, vendor_id, categoryLookup, job);
  stats.products = productMap.size;
  // Count total SKUs
  for (const [, data] of productMap) stats.skus += data.skuIds.size;

  await appendLog(pool, job.id, `Created ${stats.products} products, ${stats.skus} SKUs`);

  // A6: Attach trims as accessories
  await appendLog(pool, job.id, `Attaching ${trimRows.length} trims as accessories...`);
  const trimStats = await attachTrimAccessories(pool, productsMap, productMap, trimRows, vendor_id, categoryLookup, job);
  stats.trimsAttached = trimStats.attached;
  stats.trimsStandalone = trimStats.standalone;
  await appendLog(pool, job.id, `Trims: ${trimStats.attached} attached, ${trimStats.standalone} standalone`);

  // A6b: Attach mosaics as accessories + create orphans
  await appendLog(pool, job.id, `Attaching ${matchedMosaics.length} mosaics, creating ${orphanMosaics.length} orphans...`);
  const mosaicStats = await attachMosaicAccessories(pool, productsMap, productMap, matchedMosaics, orphanMosaics, vendor_id, categoryLookup, job);
  stats.mosaicsAttached = mosaicStats.attached;
  stats.mosaicOrphans = mosaicStats.orphanCreated;
  await appendLog(pool, job.id, `Mosaics: ${mosaicStats.attached} attached, ${mosaicStats.orphanCreated} orphans created`);

  // ════════════════════════════════════════════
  // Phase B: Website Enrichment
  // ════════════════════════════════════════════

  if (!config.skipEnrichment) {
    await appendLog(pool, job.id, 'Phase B: Website enrichment...');

    // Login
    const cookies = await elysiumLogin(pool, job.id);

    // Build enrichment list (field tiles + orphan mosaics)
    const orphanItems = mosaicStats.orphanEnrichItems || [];
    const enrichmentList = buildEnrichmentList(productsMap, productMap, orphanItems);
    await appendLog(pool, job.id, `Enrichment list: ${enrichmentList.length} SKUs (${orphanItems.length} orphan mosaics)`);

    const enrichResult = await enrichFromWebsite(pool, cookies, enrichmentList, productMap, job, config);
    stats.discontinued = enrichResult.discontinuedCount;
  } else {
    await appendLog(pool, job.id, 'Phase B: SKIPPED (skipEnrichment = true)');
  }

  // ════════════════════════════════════════════
  // Activate Products
  // ════════════════════════════════════════════

  const touchedProductIds = [...productMap.values()].map(d => d.productId);
  if (touchedProductIds.length > 0) {
    const activateResult = await pool.query(
      `UPDATE products SET status = 'active', updated_at = CURRENT_TIMESTAMP
       WHERE id = ANY($1) AND status = 'draft'`,
      [touchedProductIds]
    );
    await appendLog(pool, job.id, `Activated ${activateResult.rowCount} products`);
  }

  // ════════════════════════════════════════════
  // Summary
  // ════════════════════════════════════════════

  await appendLog(pool, job.id,
    `Scrape complete. CSV rows: ${stats.csvRows}, Products: ${stats.products}, SKUs: ${stats.skus}, ` +
    `Trims attached: ${stats.trimsAttached} (${stats.trimsStandalone} standalone), ` +
    `Mosaics attached: ${stats.mosaicsAttached} (${stats.mosaicOrphans} orphans), ` +
    `Discontinued: ${stats.discontinued}`,
    {
      products_found: stats.csvRows,
      products_created: stats.products,
      skus_created: stats.skus,
    }
  );
}

// ──────────────────────────────────────────────
// Inventory Mode (unchanged from original)
// ──────────────────────────────────────────────

const INVENTORY_CATEGORIES = [
  { name: 'Mosaic', type: 'Mosaic' },
  { name: 'Porcelain Tile', type: 'Porcelain+Tile' },
  { name: 'SPC Vinyl', type: 'SPC+Vinyl' },
  { name: 'Marble Slab', type: 'Marble+Slab' },
  { name: 'Thin Porcelain Slab 6mm', type: 'Thin+Porcelain+Slab+6mm' },
  { name: 'Ceramic Tile', type: 'Ceramic+Tile' },
  { name: 'Marble Tile', type: 'Marble+Tile' },
];

async function runInventoryMode(pool, job, source, config) {
  const stats = {
    found: 0, inventoryUpdated: 0, pricingUpdated: 0, skipped: 0, errors: 0,
  };

  const cookies = await elysiumLogin(pool, job.id);

  // Build internal_sku → sku_id lookup
  const existingSkus = await pool.query(`SELECT id, internal_sku FROM skus WHERE internal_sku LIKE 'ELY-%'`);
  const skuLookup = new Map(existingSkus.rows.map(r => [r.internal_sku, r.id]));
  await appendLog(pool, job.id, `Found ${skuLookup.size} existing ELY- SKUs in DB`);

  // Collect listing entries
  const allEntries = [];
  const seenUrls = new Set();

  for (const cat of INVENTORY_CATEGORIES) {
    try {
      let page = 1;
      let hasMore = true;

      while (hasMore) {
        const listUrl = `/category?type=${cat.type}&order_by=name&page=${page}`;
        const resp = await elysiumFetch(listUrl, cookies);
        const html = await resp.text();

        const cardEntries = parseListingPage(html, cat.name);
        for (const entry of cardEntries) {
          if (seenUrls.has(entry.url)) continue;
          seenUrls.add(entry.url);
          allEntries.push(entry);
        }

        const nextPageRegex = new RegExp(`page=(${page + 1})`, 'g');
        hasMore = nextPageRegex.test(html) && cardEntries.length > 0;
        page++;
        await delay(Math.floor(config.delayMs * 0.7));
      }
    } catch (err) {
      await addJobError(pool, job.id, `Category ${cat.name}: ${err.message}`);
      stats.errors++;
    }
  }

  stats.found = allEntries.length;
  await appendLog(pool, job.id, `Inventory: ${allEntries.length} entries found`);

  // Fetch detail pages and update inventory/pricing
  const batchSize = 5;
  for (let batchStart = 0; batchStart < allEntries.length; batchStart += batchSize) {
    const batch = allEntries.slice(batchStart, batchStart + batchSize);

    const batchPromises = batch.map(async (entry) => {
      try {
        const resp = await elysiumFetch(entry.url, cookies, {
          signal: AbortSignal.timeout(30000),
        });
        const html = await resp.text();

        if (!html.includes('product-title')) return;

        // Discontinued check
        if (/>\s*Discontinued\s*</i.test(html)) {
          stats.skipped++;
          return;
        }

        const detail = parseDetailPage(html);

        const itemCode = detail.itemCode || entry.itemCode;
        const internalSku = itemCode
          ? `ELY-${itemCode}`
          : `ELY-${entry.fullName.replace(/[^a-zA-Z0-9]/g, '').slice(0, 25)}`;

        const skuId = skuLookup.get(internalSku);
        if (!skuId) return;

        if (detail.inventory.caSqft != null) {
          await upsertInventorySnapshot(pool, skuId, 'CA', {
            qty_on_hand_sqft: detail.inventory.caSqft,
            qty_in_transit_sqft: detail.inventory.caInTransitSqft || 0,
          });
          stats.inventoryUpdated++;
        }

        if (detail.pricing.retailPerSqft) {
          const elyCost = detail.pricing.retailPerSqft;
          await upsertPricing(pool, skuId, {
            cost: elyCost,
            retail_price: Math.round(elyCost * 2 * 100) / 100,
            price_basis: 'per_sqft',
          });
          stats.pricingUpdated++;
        }
      } catch (err) {
        stats.errors++;
      }
    });

    await Promise.all(batchPromises);

    if ((batchStart + batchSize) % 200 < batchSize) {
      await appendLog(pool, job.id, `Inventory progress: ${Math.min(batchStart + batchSize, allEntries.length)}/${allEntries.length}`);
    }

    await delay(Math.floor(config.delayMs * 0.7));
  }

  await appendLog(pool, job.id,
    `Inventory scrape complete. Entries: ${stats.found}, ` +
    `Inventory updated: ${stats.inventoryUpdated}, Pricing updated: ${stats.pricingUpdated}, ` +
    `Skipped: ${stats.skipped}, Errors: ${stats.errors}`,
    { products_found: stats.found }
  );
}
