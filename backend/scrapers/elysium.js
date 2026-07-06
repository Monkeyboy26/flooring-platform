import {
  delay, upsertProduct, upsertSku,
  upsertSkuAttribute, upsertPackaging, upsertPricing,
  upsertInventorySnapshot,
  appendLog, addJobError, upsertMediaAsset,
  buildVariantName, isLifestyleUrl,
  saveSkuImages, saveProductImages,
} from './base.js';
import { elysiumLogin, elysiumFetch, BASE_URL } from './elysium-auth.js';

// ──────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────

const DEFAULT_CONFIG = {
  delayMs: 2000,        // delay between detail-page batches — keep well under the portal's rate limit
  batchSize: 2,         // concurrent detail page fetches
  deepDay: 0,           // day of week (0 = Sunday) for full re-enrichment of existing SKUs
  deep: false,          // force full enrichment for every SKU this run
  maxDeactivate: 600,   // safety cap: skip absence-based deactivation above this count
};

const MAX_GALLERY_IMAGES = 8;

// Site categories crawled daily. `carried: false` categories (slabs) only get
// price/inventory updates on existing SKUs — no new products are created.
const CATEGORY_SOURCES = [
  { name: 'Mosaic',                  type: 'Mosaic',                  slug: 'mosaic-tile',    carried: true },
  { name: 'Porcelain Tile',          type: 'Porcelain+Tile',          slug: 'porcelain-tile', carried: true },
  { name: 'SPC Vinyl',               type: 'SPC+Vinyl',               slug: 'lvp-plank',      carried: true },
  { name: 'Ceramic Tile',            type: 'Ceramic+Tile',            slug: 'ceramic-tile',   carried: true },
  { name: 'Marble Tile',             type: 'Marble+Tile',             slug: 'natural-stone',  carried: true },
  { name: 'Marble Slab',             type: 'Marble+Slab',             slug: null,             carried: false },
  { name: 'Thin Porcelain Slab 6mm', type: 'Thin+Porcelain+Slab+6mm', slug: null,             carried: false },
];

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
  clean.sort((a, b) => {
    const numA = getTrailingNumber(a);
    const numB = getTrailingNumber(b);
    if (numA !== null && numB !== null) return numA - numB;
    if (numA !== null) return -1;
    if (numB !== null) return 1;
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
// Item name parsing
// ──────────────────────────────────────────────

/**
 * Parse an Elysium item name into { colorName, finish, accessoryKeyword, mosaicLabel }.
 *
 * Strategy: strip trailing size, strip collection prefix, extract accessory keyword,
 * extract mosaic label, extract trailing finish words, remainder = color name.
 * Accessory keywords and mosaic labels are always attempted — they self-identify
 * trims and mosaic variants regardless of which listing category they came from.
 */
function parseItemName(itemName, collection) {
  let name = itemName;

  // 1. Strip trailing size
  name = name.replace(SIZE_SUFFIX_RE, '').trim();

  // 2. Strip collection prefix (case-insensitive)
  if (collection) {
    const re = new RegExp(`^${escapeRegex(collection)}\\s+`, 'i');
    name = name.replace(re, '');
  }

  // 3. Extract accessory keyword (self-identifies trims)
  let accessoryKeyword = null;
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

  // 4. Extract mosaic label ("Mosaic 2 x 2" or trailing "Mosaic")
  let mosaicLabel = null;
  const mosaicMatch = name.match(/\s+Mosaic(?:\s+(\d+\.?\d*\s*x\s*\d+\.?\d*))?\s*$/i);
  if (mosaicMatch) {
    mosaicLabel = mosaicMatch[1] ? `Mosaic ${mosaicMatch[1].trim()}` : 'Mosaic';
    name = name.replace(mosaicMatch[0], '').trim();
  }

  // 5. Strip parenthetical codes (e.g., "(HAO210)", "(Silica Free)")
  name = name.replace(/\s*\([^)]+\)\s*$/, '').trim();

  // 6. Strip paver/slab qualifiers that aren't finishes
  name = name.replace(/\s+2cm\s+Paver\s*$/i, '').trim();
  name = name.replace(/\s+3cm\s*$/i, '').trim();
  name = name.replace(/\s+6MM\s*$/i, '').trim();

  // 7. Extract trailing finish words (may be multiple)
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
// Detail page parser
// ──────────────────────────────────────────────

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
    pricing: { price: null, per: null },
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

  // ── Pricing ("$4.80 Per SqFt", "$17.28 Per Sheet", "$12.25 Per Piece") ──
  const priceMatch = html.match(/\$([\d.,]+)\s*Per\s+(SqFt|Sheet|Piece|Pc|Set|Each)\b/i);
  if (priceMatch) {
    result.pricing.price = parseFloat(priceMatch[1].replace(/,/g, '')) || null;
    result.pricing.per = priceMatch[2].toLowerCase() === 'sqft' ? 'sqft' : 'unit';
  }

  // ── Sold By ──
  const soldByMatch = html.match(/Product Sold By ([^<\n]+)/i);
  if (soldByMatch) {
    const raw = soldByMatch[1].trim().toLowerCase();
    if (raw.includes('piece') || raw.includes('sheet') || raw.includes('set') || raw.includes('each')) {
      result.soldBy = 'unit';
    } else {
      result.soldBy = 'box';
    }
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
// Listing page parser
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
// Main run() — unified daily site-first pipeline
// ──────────────────────────────────────────────

/**
 * Elysium Tile scraper — unified daily job, site-first (no price list).
 *
 * Every run (daily):
 *   - Crawls the regular category listings (which exclude discontinued items).
 *   - Fetches every product detail page.
 *   - Always updates pricing + CA inventory.
 *   - Fully enriches (specs, packaging, images, description) any SKU that is
 *     new to the DB, and ALL SKUs on the weekly deep day (Sunday by default).
 *   - Activates seen products/SKUs; deactivates active SKUs no longer listed
 *     (guarded: only when every category crawled cleanly, with a hard cap).
 *
 * Config: delayMs, batchSize, deepDay (0-6), deep (force full), maxDeactivate.
 */
export async function run(pool, job, source) {
  const config = { ...DEFAULT_CONFIG, ...(source.config || {}) };
  const vendor_id = source.vendor_id;
  const deepAll = config.deep === true || new Date().getDay() === config.deepDay;

  const stats = {
    entries: 0, skusSeen: 0, skusCreated: 0, deepEnriched: 0,
    priced: 0, inventoried: 0, accessories: 0,
    activatedProducts: 0, reactivatedSkus: 0, deactivatedSkus: 0,
    errors: 0,
  };

  await appendLog(pool, job.id, `Unified daily run — mode: ${deepAll ? 'DEEP (full enrichment)' : 'LIGHT (price/inventory + new items)'}`);

  // Category lookup
  const categoryLookup = new Map();
  try {
    const catRows = await pool.query('SELECT id, slug FROM categories WHERE is_active = true');
    for (const row of catRows.rows) categoryLookup.set(row.slug, row.id);
  } catch {}

  const cookies = await elysiumLogin(pool, job.id);

  // ── 1. Crawl category listings ──
  const entries = [];
  const seenUrls = new Set();
  let listingFailures = 0;

  for (const cat of CATEGORY_SOURCES) {
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
          entries.push(entry);
        }

        const nextPageRegex = new RegExp(`page=(${page + 1})`, 'g');
        hasMore = nextPageRegex.test(html) && cardEntries.length > 0;
        page++;
        await delay(Math.floor(config.delayMs * 0.7));
      }
    } catch (err) {
      listingFailures++;
      stats.errors++;
      await addJobError(pool, job.id, `Category ${cat.name}: ${err.message}`);
    }
  }

  stats.entries = entries.length;
  await appendLog(pool, job.id, `Listings: ${entries.length} products across ${CATEGORY_SOURCES.length - listingFailures}/${CATEGORY_SOURCES.length} categories`, { products_found: entries.length });

  // ── 2. Existing SKU map (internal_sku → sku row) ──
  const existingRows = await pool.query(`
    SELECT s.id, s.internal_sku, s.product_id
    FROM skus s
    JOIN products p ON p.id = s.product_id
    WHERE p.vendor_id = $1 AND s.internal_sku IS NOT NULL
  `, [vendor_id]);
  const skuMap = new Map(existingRows.rows.map(r => [r.internal_sku, r]));
  await appendLog(pool, job.id, `Found ${skuMap.size} existing Elysium SKUs in DB`);

  const catBySite = new Map(CATEGORY_SOURCES.map(c => [c.name, c]));

  // ── 3. Process every entry ──
  const seenSkuIds = [];
  const touchedProductIds = new Set();
  const accessoryProductIds = new Set();
  const productLevelDone = new Set(); // `${kind}-${productId}` for once-per-product writes

  const processEntry = async (entry) => {
        const resp = await elysiumFetch(entry.url, cookies, { signal: AbortSignal.timeout(30000) });
        const html = await resp.text();
        if (!html.includes('product-title')) return;

        const detail = parseDetailPage(html);

        const itemCode = detail.itemCode || entry.itemCode;
        const internalSku = itemCode
          ? `ELY-${itemCode}`
          : `ELY-${entry.fullName.replace(/[^a-zA-Z0-9]/g, '').slice(0, 25)}`;

        const existing = skuMap.get(internalSku);
        const catSrc = catBySite.get(entry.listingCategory) || { carried: false, slug: null, name: entry.listingCategory };
        if (!existing && !catSrc.carried) return; // don't create products for non-carried categories

        const deep = deepAll || !existing;

        // ── Name parsing / grouping ──
        const collection = detail.collection || null;
        const { colorName, finish, accessoryKeyword, mosaicLabel } = parseItemName(entry.fullName, collection);

        let categorySlug = catSrc.slug;
        if (categorySlug === 'porcelain-tile' && WOOD_LOOK_COLLECTIONS.has((collection || '').toLowerCase())) {
          categorySlug = 'wood-look-tile';
        }
        const categoryId = categorySlug ? (categoryLookup.get(categorySlug) || null) : null;

        const productName = (collection && !colorName.toLowerCase().startsWith(collection.toLowerCase()))
          ? `${collection} ${colorName}`
          : colorName;

        const product = await upsertProduct(pool, {
          vendor_id,
          name: productName,
          collection: collection || '',
          category_id: categoryId,
        });

        // ── SKU ──
        const variantName = accessoryKeyword
          ? `${accessoryKeyword}${entry.size ? ' ' + entry.size : ''}`
          : buildVariantName(entry.size, finish, mosaicLabel);
        const sellBy = detail.soldBy || (mosaicLabel ? 'unit' : 'box');

        const sku = await upsertSku(pool, {
          product_id: product.id,
          vendor_sku: itemCode || null,
          internal_sku: internalSku,
          variant_name: variantName,
          sell_by: sellBy,
          variant_type: accessoryKeyword ? 'accessory' : null,
        });
        if (sku.is_new) stats.skusCreated++;
        if (accessoryKeyword) {
          await pool.query('UPDATE skus SET accessory_label = $1 WHERE id = $2', [accessoryKeyword, sku.id]);
          accessoryProductIds.add(product.id);
        }

        seenSkuIds.push(sku.id);
        touchedProductIds.add(product.id);
        skuMap.set(internalSku, { id: sku.id, internal_sku: internalSku, product_id: product.id });

        // ── Always: pricing + inventory ──
        if (detail.pricing.price) {
          await upsertPricing(pool, sku.id, {
            cost: detail.pricing.price,
            retail_price: Math.round(detail.pricing.price * 2 * 100) / 100,
            price_basis: detail.pricing.per === 'sqft' ? 'per_sqft' : 'per_unit',
          });
          stats.priced++;
        }
        if (detail.inventory.caSqft != null) {
          await upsertInventorySnapshot(pool, sku.id, 'CA', {
            qty_on_hand_sqft: detail.inventory.caSqft,
            qty_in_transit_sqft: detail.inventory.caInTransitSqft || 0,
          });
          stats.inventoried++;
        }

        if (!deep) return;

        // ── Deep enrichment: packaging, attributes, description, PDF, images ──
        stats.deepEnriched++;

        if (Object.keys(detail.packaging).length > 0) {
          const pkg = detail.packaging;
          await upsertPackaging(pool, sku.id, {
            pieces_per_box: pkg.piecesPerBox || null,
            sqft_per_box: pkg.sqftPerBox || null,
            weight_per_box_lbs: pkg.weightPerBox || null,
            boxes_per_pallet: pkg.boxesPerPallet || null,
            sqft_per_pallet: pkg.sqftPerPallet || null,
            weight_per_pallet_lbs: pkg.weightPerPallet || null,
          });
        }

        if (colorName) await upsertSkuAttribute(pool, sku.id, 'color', colorName);
        if (finish) await upsertSkuAttribute(pool, sku.id, 'finish', finish);
        if (entry.size) await upsertSkuAttribute(pool, sku.id, 'size', entry.size);
        await upsertSkuAttribute(pool, sku.id, 'material', catSrc.name.toLowerCase());
        if (detail.specs.thickness) await upsertSkuAttribute(pool, sku.id, 'thickness', detail.specs.thickness);
        if (detail.specs.countryOfOrigin) await upsertSkuAttribute(pool, sku.id, 'country', detail.specs.countryOfOrigin);
        if (detail.specs.edge) await upsertSkuAttribute(pool, sku.id, 'edge', detail.specs.edge);
        if (detail.specs.look) await upsertSkuAttribute(pool, sku.id, 'look', detail.specs.look);
        if (detail.technicalSpecs.application) await upsertSkuAttribute(pool, sku.id, 'application', detail.technicalSpecs.application);
        if (detail.technicalSpecs.peiRating) await upsertSkuAttribute(pool, sku.id, 'pei_rating', detail.technicalSpecs.peiRating);
        if (detail.technicalSpecs.shadeVariation) await upsertSkuAttribute(pool, sku.id, 'shade_variation', detail.technicalSpecs.shadeVariation);
        if (detail.technicalSpecs.waterAbsorption) await upsertSkuAttribute(pool, sku.id, 'water_absorption', detail.technicalSpecs.waterAbsorption);
        if (detail.technicalSpecs.dcof) await upsertSkuAttribute(pool, sku.id, 'dcof', detail.technicalSpecs.dcof);

        if (detail.description && !productLevelDone.has(`desc-${product.id}`)) {
          await pool.query(
            `UPDATE products SET description_long = COALESCE(description_long, $1),
             description_short = COALESCE(description_short, $2),
             updated_at = NOW() WHERE id = $3`,
            [detail.description, detail.description.slice(0, 255), product.id]
          );
          productLevelDone.add(`desc-${product.id}`);
        }

        if (detail.catalogPdf && !productLevelDone.has(`pdf-${product.id}`)) {
          const pdfUrl = detail.catalogPdf.startsWith('http') ? detail.catalogPdf : `${BASE_URL}${detail.catalogPdf}`;
          await upsertMediaAsset(pool, {
            product_id: product.id,
            sku_id: null,
            asset_type: 'spec_pdf',
            url: pdfUrl,
            original_url: pdfUrl,
            sort_order: 99,
          });
          productLevelDone.add(`pdf-${product.id}`);
        }

        const gallery = detail.galleryImages;
        if (gallery.length > 0) {
          const varUrls = gallery.map(img => {
            const u = img.url1000 || img.url750;
            return u.startsWith('http') ? u : `${BASE_URL}${u}`;
          });
          const sortedUrls = scoreElysiumImages(varUrls, colorName, productName);
          await saveSkuImages(pool, product.id, sku.id, sortedUrls.slice(0, MAX_GALLERY_IMAGES), { productName });
          if (!productLevelDone.has(`img-${product.id}`)) {
            await saveProductImages(pool, product.id, sortedUrls.slice(0, 4), { productName });
            productLevelDone.add(`img-${product.id}`);
          }
        }
  };

  let processed = 0;
  for (let batchStart = 0; batchStart < entries.length; batchStart += config.batchSize) {
    const batch = entries.slice(batchStart, batchStart + config.batchSize);

    await Promise.all(batch.map(async (entry) => {
      // Cheap skip: non-carried categories (slabs) whose SKU isn't in the DB —
      // no reason to fetch pages we'd discard, and these pages are the ones
      // that hang the portal.
      const catSrc0 = catBySite.get(entry.listingCategory);
      if (catSrc0 && !catSrc0.carried && entry.itemCode && !skuMap.has(`ELY-${entry.itemCode}`)) return;

      // Hard per-entry timeout: fetch-level abort signals have not been enough
      // to prevent permanent hangs (three runs stalled in the same zone) — a
      // race guarantees the batch always settles.
      let hardTimer;
      try {
        await Promise.race([
          processEntry(entry),
          new Promise((_, reject) => { hardTimer = setTimeout(() => reject(new Error('entry hard-timeout (90s)')), 90000); }),
        ]);
      } catch (err) {
        stats.errors++;
        if (stats.errors <= 10) {
          await addJobError(pool, job.id, `Entry ${entry.fullName}: ${err.message}`);
        }
      } finally {
        clearTimeout(hardTimer);
      }
    }));

    processed = Math.min(batchStart + config.batchSize, entries.length);
    if (processed % 150 < config.batchSize || processed === entries.length) {
      await appendLog(pool, job.id, `Progress: ${processed}/${entries.length}`);
    }
    await delay(config.delayMs);
  }

  stats.skusSeen = seenSkuIds.length;

  // ── 4. Link accessory SKUs to their non-accessory siblings ──
  if (accessoryProductIds.size > 0) {
    const linkResult = await pool.query(`
      INSERT INTO sku_accessories (parent_sku_id, accessory_sku_id, sort_order)
      SELECT parent.id, acc.id, 0
      FROM skus parent
      JOIN skus acc ON acc.product_id = parent.product_id
      WHERE parent.product_id = ANY($1::uuid[])
        AND COALESCE(parent.variant_type, '') != 'accessory'
        AND acc.variant_type = 'accessory'
        AND parent.is_sample = false
      ON CONFLICT (parent_sku_id, accessory_sku_id) DO NOTHING
    `, [[...accessoryProductIds]]);
    stats.accessories = linkResult.rowCount;
  }

  // ── 5. Activate everything seen this run ──
  if (seenSkuIds.length > 0) {
    const reactivate = await pool.query(
      `UPDATE skus SET status = 'active', updated_at = NOW() WHERE id = ANY($1::uuid[]) AND status != 'active'`,
      [seenSkuIds]
    );
    stats.reactivatedSkus = reactivate.rowCount;
  }
  if (touchedProductIds.size > 0) {
    const activate = await pool.query(
      `UPDATE products SET status = 'active', updated_at = NOW() WHERE id = ANY($1::uuid[]) AND status != 'active'`,
      [[...touchedProductIds]]
    );
    stats.activatedProducts = activate.rowCount;
  }

  // ── 6. Absence-based deactivation (guarded) ──
  // Regular listings exclude discontinued items, so an active SKU we didn't see
  // is discontinued. Only runs when every category crawled cleanly AND detail
  // fetches were healthy — a flaky night shrinks the "seen" set and would
  // otherwise deactivate live products. Also hard-capped.
  const errorRate = entries.length > 0 ? stats.errors / entries.length : 1;
  if (errorRate > 0.05) {
    await appendLog(pool, job.id, `Deactivation skipped — error rate ${(errorRate * 100).toFixed(1)}% exceeds 5%`);
  } else if (listingFailures === 0 && entries.length >= 1500) {
    const candidates = await pool.query(`
      SELECT COUNT(*)::int AS n
      FROM skus s JOIN products p ON p.id = s.product_id
      WHERE p.vendor_id = $1 AND s.status = 'active' AND s.is_sample = false
        AND NOT (s.id = ANY($2::uuid[]))
    `, [vendor_id, seenSkuIds]);
    const n = candidates.rows[0].n;

    if (n > config.maxDeactivate) {
      await appendLog(pool, job.id, `WARN: ${n} unlisted SKUs exceeds maxDeactivate (${config.maxDeactivate}) — skipping deactivation`);
    } else if (n > 0) {
      const deact = await pool.query(`
        UPDATE skus s SET status = 'inactive', updated_at = NOW()
        FROM products p
        WHERE p.id = s.product_id AND p.vendor_id = $1
          AND s.status = 'active' AND s.is_sample = false
          AND NOT (s.id = ANY($2::uuid[]))
      `, [vendor_id, seenSkuIds]);
      stats.deactivatedSkus = deact.rowCount;

      await pool.query(`
        UPDATE products p SET status = 'inactive', updated_at = NOW()
        WHERE p.vendor_id = $1 AND p.status = 'active'
          AND NOT EXISTS (SELECT 1 FROM skus s WHERE s.product_id = p.id AND s.status = 'active')
      `, [vendor_id]);
    }
  } else if (listingFailures > 0) {
    await appendLog(pool, job.id, 'Deactivation skipped — one or more category crawls failed');
  }

  await appendLog(pool, job.id,
    `Run complete. Entries: ${stats.entries}, SKUs seen: ${stats.skusSeen} (${stats.skusCreated} new), ` +
    `Deep enriched: ${stats.deepEnriched}, Priced: ${stats.priced}, Inventory: ${stats.inventoried}, ` +
    `Accessory links: ${stats.accessories}, Activated products: ${stats.activatedProducts}, ` +
    `Reactivated SKUs: ${stats.reactivatedSkus}, Deactivated SKUs: ${stats.deactivatedSkus}, Errors: ${stats.errors}`,
    { products_found: stats.entries, skus_created: stats.skusCreated }
  );
}
