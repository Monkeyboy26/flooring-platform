import {
  delay, upsertProduct, upsertSku,
  upsertSkuAttribute, upsertPackaging, upsertPricing,
  appendLog, addJobError,
  downloadImage, upsertMediaAsset, resolveImageExtension,
  deslugify, buildVariantName, filterImageUrls,
  isLifestyleUrl
} from './base.js';
import { BASE_URL } from './arizona-auth.js';
import { loadAllPriceLists } from './arizona-prices.js';

const DEFAULT_CONFIG = {
  delayMs: 1000,
  downloadImages: true,
  perPage: 100,
};

// Max gallery images per SKU (primary + lifestyle + 6 alternate)
const MAX_GALLERY_IMAGES = 8;

/**
 * Re-parameterize a Widen CDN URL to fit within 765px wide without cropping.
 * Strips height, crop, and keep params so the CDN returns the natural aspect ratio.
 * Non-Widen URLs are returned unchanged.
 */
function reParamWidenUrl(url) {
  if (!url.includes('.widen.net')) return url;
  let u = url;
  // Set width to 765, remove height/crop/keep so image keeps natural aspect ratio
  if (/[?&]w=\d+/.test(u)) {
    u = u.replace(/([?&])w=\d+/, '$1w=765');
  } else {
    u += (u.includes('?') ? '&' : '?') + 'w=765';
  }
  u = u.replace(/[?&]h=\d+/g, '');
  u = u.replace(/[?&]crop=yes/g, '');
  u = u.replace(/[?&]keep=[a-z]+/gi, '');
  u = u.replace(/[?&]position=[a-z]+/gi, '');
  // Ensure quality param
  if (!/[?&]quality=/.test(u)) u += '&quality=80';
  // Strip x.app portal tracking param — causes intermittent 404/placeholder from CDN
  u = u.replace(/[?&]x\.app=[^&]*/gi, '');
  // Clean up dangling ampersands
  u = u.replace(/[&]+/g, '&').replace(/\?&/, '?').replace(/&$/, '');
  return u;
}

/**
 * Normalize Widen CDN URLs: re-parameterize to 765px wide without cropping.
 * Still rejects known placeholder filenames.
 */
function normalizeWidenUrls(urls) {
  return urls
    .filter(url => !/coming-soon/i.test(url))
    .map(url => reParamWidenUrl(url));
}

/**
 * Filter out Widen CDN placeholder images ("Preview Not Available").
 * The CDN returns HTTP 404 with `x-widen-error: resource unavailable` and an
 * 8,016-byte PNG placeholder for missing/removed assets.  Also rejects images
 * ≤ 4,000 bytes (corrupted or blank thumbnails).
 */
const WIDEN_PLACEHOLDER_BYTES = 8016; // "Preview Not Available" PNG placeholder size

async function filterWidenPlaceholders(urls) {
  if (!urls || urls.length === 0) return [];
  const checks = await Promise.allSettled(urls.map(async (url) => {
    if (!url.includes('.widen.net')) return { url, ok: true };
    try {
      const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
      if (!res.ok) return { url, ok: false };
      const len = parseInt(res.headers.get('content-length') || '0', 10);
      // Reject small/corrupt images AND the known 8,016-byte placeholder
      if (len > 0 && len <= WIDEN_PLACEHOLDER_BYTES) return { url, ok: false };
      return { url, ok: true };
    } catch { return { url, ok: false }; }
  }));
  return checks
    .filter(r => r.status === 'fulfilled' && r.value.ok)
    .map(r => r.value.url);
}

/**
 * Detect field-tile dimension patterns in Widen CDN image URLs.
 * Returns true if the filename contains standard tile/slab dimensions
 * (12x12, 18x18, etc.) or detail-shot markers (-DT-) that indicate
 * a non-mosaic product shot — these should NOT be used for mosaic SKUs.
 */
const FIELD_TILE_IMAGE_RE = /[-_](12x12|18x18|24x24|12x24|16x16|6x24|6x12|4x12|3x6)[-_.]/i;
const DETAIL_SHOT_RE = /[-_]DT[-_.]/i;
const MOSAIC_IMAGE_INDICATOR_RE = /mosaic|mesh|hex|herringbone|chevron|basket|penny|fan|flower|brick|bubble|scallop|picket|rhomboid|stanza|pinwheel|octagon|arabesque|lantern/i;
function isFieldTileUrl(url) {
  const filename = url.split('/').pop().split('?')[0];
  if (DETAIL_SHOT_RE.test(filename)) return true;
  if (FIELD_TILE_IMAGE_RE.test(filename)) {
    // Not a field tile if the filename also contains mosaic indicators
    if (MOSAIC_IMAGE_INDICATOR_RE.test(filename)) return false;
    return true;
  }
  return false;
}

// AZ Tile category slug → PIM category slug
/**
 * Arizona Tile → PIM category mapping.
 *
 * AZ products have MANY category tags (material, format, finish, look, collection).
 * Each entry maps an AZ slug to [pimSlug, priority].
 * When a product belongs to multiple AZ categories, the highest-priority match wins.
 *
 * Priority guide:
 *   90 — specific slab material (granite-slab, quartzite, della-terra-quartz)
 *   85 — format-specific (mosaic, stacked-stone, pavers) — beats material
 *   80 — specific tile material (porcelain-and-ceramic, marble-tile)
 *   70 — material from Outer Limits / Special Order subcategories
 *   55 — large-format, patterned, 3D
 *   50 — generic material parents (natural-stone-tile, natural-stone-slab)
 *   30 — generic cross-references (liners, special-order-series, outer-limits top-level)
 *    0 — skip (looks-like, recycled, made-in-usa, locations)
 */
const CATEGORY_MAP = {
  // ── Tile: specific material (priority 80) ──
  'porcelain-and-ceramic':          ['porcelain-tile', 80],
  'marble-tile':                    ['natural-stone', 80],
  'marble-dolomite-tile':           ['natural-stone', 80],
  'granite-tile':                   ['natural-stone', 80],
  'limestone-tile':                 ['natural-stone', 80],
  'travertine':                     ['natural-stone', 80],
  'basalt-tile':                    ['natural-stone', 80],
  'dolomite':                       ['natural-stone', 80],
  'tumbled-stone':                  ['natural-stone', 80],
  'glass':                          ['porcelain-tile', 80],
  'quarry-tile':                    ['ceramic-tile', 80],
  'agglomerate-marble':             ['natural-stone', 80],
  'metal':                          ['porcelain-tile', 60],

  // ── Slab: specific material (priority 90) ──
  'granite-slab':                   ['granite-countertops', 90],
  'marble-slab':                    ['marble-countertops', 90],
  'della-terra-quartz':             ['quartz-countertops', 90],
  'quartzite':                      ['quartzite-countertops', 90],
  'limestone-slab':                 ['marble-countertops', 90],
  'travertine-slab':                ['marble-countertops', 90],
  'agglomerate-marble-slab':        ['marble-countertops', 90],
  'della-terra-porcelain-slabs':    ['porcelain-slabs', 90],
  'della-terra-porcelain-slabs-outer-limits': ['porcelain-slabs', 90],

  // ── Outer Limits subcategories (priority 70) ──
  'granite':                        ['granite-countertops', 70],   // OL granite slab (2368)
  'limestone':                      ['marble-countertops', 70],    // OL limestone slab (2369)
  'marble':                         ['marble-countertops', 70],    // OL marble slab (2370)
  'travertine-natural-stone-slab':  ['marble-countertops', 70],    // OL travertine slab (2371)
  'quartzite-natural-stone-slab':   ['quartzite-countertops', 70], // OL quartzite slab (2425)
  'limestone-natural-stone-tile':   ['natural-stone', 70],         // OL limestone tile (2458)
  'travertine-natural-stone-tile':  ['natural-stone', 70],         // OL travertine tile (2457)
  'natural-stone-patterns-tile':    ['natural-stone', 70],         // OL patterns tile (2461)

  // ── Special Order subcategories (priority 70) ──
  'stone':                          ['natural-stone', 70],         // Special order natural stone (1437)
  'glass-special-order-series':     ['mosaic-tile', 70],           // Special order glass (1436)

  // ── Format-specific (priority 85) — beats material ──
  'decorative-mosaics-mesh-mounts': ['mosaic-tile', 85],
  'porcelain-mosaics-mesh-mounts':  ['mosaic-tile', 85],
  'natural-stone-mosaics-mesh-mounts': ['mosaic-tile', 85],
  'glass-mosaics-mesh-mounts':      ['mosaic-tile', 85],
  'stack':                          ['stacked-stone', 86],
  'porcelain-stack':                ['stacked-stone', 86],
  'natural-stone-stack':            ['stacked-stone', 86],
  'stack-tile':                     ['stacked-stone', 86],
  'pavers':                         ['pavers', 85],
  'special-order-pavers':           ['pavers', 85],
  'natural-stone-special-order-pavers': ['pavers', 85],
  'porcelain-special-order-pavers': ['pavers', 85],
  'large-format-tile':              ['large-format-tile', 55],
  'large-format-porcelain-tile':    ['large-format-tile', 55],
  'large-format-natural-stone-tile': ['natural-stone', 60],
  'patterned-tile':                 ['porcelain-tile', 55],
  'natural-stone-patterns':         ['natural-stone', 55],

  // ── Generic parents (priority 50) ──
  'natural-stone-tile':             ['natural-stone', 50],
  'natural-stone-slab':             ['natural-stone', 50],

  // ── 3D tile subcategories (priority 55) ──
  'porcelain-and-ceramic-3d-tile':  ['porcelain-tile', 55],
  'natural-stone-3d-tile':          ['natural-stone', 55],
  '3d-tile':                        ['porcelain-tile', 45],

  // ── R11 finish — porcelain tiles with slip resistance (priority 40) ──
  'r11-finish':                     ['porcelain-tile', 40],

  // ── Low-priority generic parents (priority 30) ──
  // These only win if no better category matched
  'liners-moldings-trim':           ['transitions-moldings', 30],
  'ceramic-porcelain':              ['transitions-moldings', 30],  // "Porcelain & Ceramic Liners"
  'natural-stone-liners':           ['transitions-moldings', 30],
  'glass-liners':                   ['transitions-moldings', 30],
  'outer-limits':                   ['porcelain-tile', 20],        // generic OL fallback only
  'special-order-series':           ['natural-stone', 20],         // generic SO fallback
  'porcelain':                      ['porcelain-tile', 20],        // generic porcelain (SO sub)
  'tile':                           ['porcelain-tile', 10],        // top-level "Tile" parent
  'slab':                           ['natural-stone', 10],         // top-level "Slab" parent

  // ── Defensive entries ──
  'slate':                          ['natural-stone', 80],
  'onyx':                           ['natural-stone', 80],
  'ceramic':                        ['ceramic-tile', 80],
  'basalt-natural-stone-slab':      ['marble-countertops', 70],
  'basalt':                         ['natural-stone', 70],
  'dolomite-slab':                  ['marble-countertops', 90],
  'soapstone':                      ['natural-stone', 80],
};

/**
 * AZ category slugs to skip entirely — these are cross-reference tags, not material types.
 * Products tagged with these also have a real material category.
 */
const CATEGORY_SKIP = new Set([
  'looks-like', 'natural-stone', 'concrete', 'geometric-shapes', 'hand-painted',
  'subway', 'wood',                          // "Looks Like" children (aesthetics)
  'recycled-material-content',               // eco-label, not material
  'made-in-usa', 'made-in-usa-slab',         // origin tag
  'uncategorized', 'test-video', 'slab-outlet', 'quartz',  // misc
]);

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const ACCESSORY_KEYWORDS = /\b(trim|molding|moulding|reducer|stair\s*nose|transition|threshold|t-molding|quarter\s*round|underlayment|adhesive|grout|sealer|caulk|bullnose|cove\s*base|pencil\s*liner)\b/i;

// Name-based format patterns — catch products whose AZ tags don't include format categories
// but whose collection name clearly indicates the format (e.g., "Basalt Hex" → mosaic)
const MOSAIC_NAME_PATTERN = /\b(hex|chevron|herringbone|basketweave|penny|geometric|labyrinth|fishing\s*net|combhex|arabesque|thin\s*brick|geometro|skywalk|trove|looming\s*stream|artistic\s*expression|fraser\s*river)\b/i;
const STACKED_NAME_PATTERN = /\b(ledger|splitface|split[-\s]?face)\b/i;

// WooCommerce product pages that list colors by format rather than by series.
// Colors on these pages usually also have their own WC product page, creating duplicates.
// Skip creating products from these pages when the color exists elsewhere.
const FORMAT_PAGE_TITLES = new Set(['Modella', 'Split']);

// Extract named shape/pattern from a mosaic size attribute for use in product naming.
// "Herringbone 1x2 Mesh" → "Herringbone", "Hex2x2 Mesh" → "Hex", "2x2 Mosaic" → ""
// Longer patterns listed first so they match before shorter prefixes.
const MOSAIC_SHAPE_RE = /\b(penny\s*round|mini\s*herringbone|large\s*chevron|small\s*chevron|small\s*hex|long\s*hex|basketweave\s*dogbone|basketweave|herringbone|chevron|hexagon|hex|bubble|fan|flower|scallop|oval|rhomboid|ellipse|bamboo|bevel|trapezoid|feather|ribbon|lotus|brick|picket|pinwheel|stanza|octagon|arch|wavy|linear|straight)\b/i;
function extractMosaicShape(sizeAttr) {
  if (!sizeAttr) return '';
  const m = sizeAttr.match(MOSAIC_SHAPE_RE);
  if (!m) return '';
  // Title-case the matched shape
  return m[1].replace(/\s+/g, ' ').split(' ')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}

// Size classification patterns — handles both raw (12x24) and WC-slugified (12-x-24) formats
// Field tile: both dimensions ≥12, or specific large sizes (8x48, 6x36, etc.)
const FIELD_SIZE = /(\d{2,})-?x-?(\d{2,})|8-?x-?48|8-?x-?36|6-?x-?36|6-?x-?24/;
// Mosaic keywords in size attribute — these sizes are NOT field tile even if dimensions are large
const MOSAIC_KW = /mosaic|mesh|hex|penny|basketweave|herringbone|stack|sheet/i;

// Parse a size string into numeric [w, h] inches. Handles raw ("13-3/4x10-9/16")
// and WC-slugified ("13-3-4-x-10-9-16") forms, including fractional parts.
function parseSizeDims(s) {
  if (!s) return null;
  const t = String(s).toLowerCase().replace(/\//g, '-').replace(/-x-/g, 'x').replace(/\s+/g, '');
  const m = t.match(/(?:^|[^\d])(\d+)(?:-(\d+)-(\d+))?x(\d+)(?:-(\d+)-(\d+))?(?=[^\d]|$)/);
  if (!m) return null;
  const a = parseInt(m[1], 10) + (m[2] ? parseInt(m[2], 10) / parseInt(m[3], 10) : 0);
  const b = parseInt(m[4], 10) + (m[5] ? parseInt(m[5], 10) / parseInt(m[6], 10) : 0);
  if (!isFinite(a) || !isFinite(b)) return null;
  return [a, b];
}

// True field-tile size: both dims integer and ≥12, or a large plank format.
// Fractional dims (11-7/16x11-7/8, 13-3/4x10-9/16) are mesh-mounted sheet sizes,
// NOT field tile — the old FIELD_SIZE regex false-matched inside slugified
// sixteenths ("...-7-16-x-11-..." → "16-x-11") and demoted whole mosaic pages
// (Geometro, Geo-Tulle, Geo-Belfort) to their material category.
function isFieldTileSize(s) {
  if (!s || MOSAIC_KW.test(s)) return false;
  const dims = parseSizeDims(s);
  if (!dims) return false;
  const [a, b] = [Math.min(dims[0], dims[1]), Math.max(dims[0], dims[1])];
  if (!Number.isInteger(a) || !Number.isInteger(b)) return false;
  if (a >= 12 && b >= 12) return true;
  return (a === 8 && (b === 48 || b === 36)) || (a === 6 && (b === 36 || b === 24));
}

// Categories sold per piece/sheet (not per sqft in boxes)
const UNIT_CATEGORIES = new Set([
  'mosaic-tile', 'stacked-stone',
  'granite-countertops', 'marble-countertops', 'quartz-countertops',
  'quartzite-countertops', 'porcelain-slabs',
]);
// Slab categories eligible for multi-gauge (thickness) SKU splitting
const SLAB_CATEGORIES = new Set([
  'granite-countertops', 'marble-countertops', 'quartz-countertops',
  'quartzite-countertops', 'porcelain-slabs',
]);
// Format categories that need variant-level splitting when mixed with field tiles
const FORMAT_CATS = new Set(['mosaic-tile', 'stacked-stone', 'pavers']);
// Fallback tile category when slab products have tile-format variants but no tile
// WooCommerce category — AZ lumps marble tiles under marble-slab, for example.
const SLAB_TO_TILE_FALLBACK = {
  'marble-countertops': 'natural-stone',
  'granite-countertops': 'natural-stone',
  'quartzite-countertops': 'natural-stone',
  'porcelain-slabs': 'porcelain-tile',
};
// Categories that don't use box packaging (slabs, sheets)
const NO_BOX_CATEGORIES = new Set([
  'mosaic-tile', 'stacked-stone', 'granite-countertops', 'marble-countertops',
  'quartz-countertops', 'quartzite-countertops', 'porcelain-slabs',
]);

function resolveSellBy(pimSlug, accessory, parsedSoldBy) {
  if (accessory) return 'unit';
  if (pimSlug && UNIT_CATEGORIES.has(pimSlug)) return 'unit';
  return parsedSoldBy || 'box';
}

// Derive sell_by + cost + price_basis from a price-list entry.
// Mosaics, ledger/stack panels, and trim are sold per sheet/piece — always,
// even when they ship in boxes (business rule: customers can buy single
// sheets). SF-priced entries in per-piece categories convert to a per-sheet
// price via Sf/Pc so unit pricing is never left on a per-sqft basis; slabs
// (no piece coverage) keep per-sqft pricing for the inquire flow.
function planFromPriceList(plEntry, catSlug) {
  const perPiece = plEntry.unit === 'EA' || plEntry.unit === 'SHT';
  if (perPiece) {
    return { sellBy: 'unit', cost: plEntry.netPrice, priceBasis: 'per_unit' };
  }
  if (catSlug && UNIT_CATEGORIES.has(catSlug)) {
    if (plEntry.sfPerPc > 0) {
      return {
        sellBy: 'unit',
        cost: Math.round(plEntry.netPrice * plEntry.sfPerPc * 100) / 100,
        priceBasis: 'per_unit',
      };
    }
    return { sellBy: 'unit', cost: plEntry.netPrice, priceBasis: 'per_sqft' };
  }
  return { sellBy: 'box', cost: plEntry.netPrice, priceBasis: 'per_sqft' };
}

function isAccessory(title, description) {
  return ACCESSORY_KEYWORDS.test(title) || (description && ACCESSORY_KEYWORDS.test(description));
}

// AZ page titles sometimes carry internal series codes — expand or strip them
// for customer-facing names ("DT-Taj Mahal Polished" → "Della Terra Taj Mahal
// Polished"; "CS-Terra Nova" → "Terra Nova"). Price-list lookups must keep the
// RAW title — their keys are built from it.
function normalizeSeriesTitle(title) {
  return (title || '').replace(/^DT-\s*/i, 'Della Terra ').replace(/^CS-\s*/i, '').trim();
}

// Join collection + color collapsing a word-boundary overlap so shared words
// never double: "Cementine Evo" + "Evo 1" → "Cementine Evo 1". Hyphens count
// as boundaries on the collection side: "Geo-Dijon" + "Dijon Classic" →
// "Geo-Dijon Classic".
function joinDedupe(a, b) {
  const aw = a.split(/\s+/), bw = b.split(/\s+/);
  const aNorm = a.toLowerCase().replace(/-/g, ' ').trim().split(/\s+/);
  for (let n = Math.min(aNorm.length, bw.length); n > 0; n--) {
    const bHead = bw.slice(0, n).join(' ').toLowerCase().replace(/-/g, ' ');
    if (aNorm.slice(-n).join(' ') === bHead) {
      return aw.concat(bw.slice(n)).join(' ');
    }
  }
  return `${a} ${b}`;
}

/**
 * Resolve the best PIM category for a product from its AZ category tags.
 * Highest CATEGORY_MAP priority wins; parent categories get a -5 penalty.
 */
function resolveBestCategory(apiProduct, azCategoryMap, categoryLookup) {
  let categoryId = null, pimCatSlug = null, bestPriority = -1;
  for (const catId of apiProduct.categoryIds) {
    const azCat = azCategoryMap.get(catId);
    if (!azCat || CATEGORY_SKIP.has(azCat.slug)) continue;

    const mapping = CATEGORY_MAP[azCat.slug];
    if (mapping) {
      const [slug, priority] = mapping;
      if (priority > bestPriority && categoryLookup.has(slug)) {
        bestPriority = priority;
        categoryId = categoryLookup.get(slug);
        pimCatSlug = slug;
      }
    }
    // Also check parent category (lower priority since less specific)
    if (azCat.parent) {
      const parentCat = azCategoryMap.get(azCat.parent);
      if (parentCat && !CATEGORY_SKIP.has(parentCat.slug)) {
        const parentMapping = CATEGORY_MAP[parentCat.slug];
        if (parentMapping) {
          const [slug, priority] = parentMapping;
          // Parent match gets a small penalty
          const adjPriority = priority - 5;
          if (adjPriority > bestPriority && categoryLookup.has(slug)) {
            bestPriority = adjPriority;
            categoryId = categoryLookup.get(slug);
            pimCatSlug = slug;
          }
        }
      }
    }
  }
  return { categoryId, pimCatSlug, bestPriority };
}

/**
 * Classify a single variation by format based on its size attribute.
 * Used to sub-group variants within a color group so each format gets its own PIM product.
 * Returns 'mosaic', 'stacked', 'tile', or 'default'.
 */
function classifyVariation(sizeAttr, originalFormatSlug, originalSlabSlug) {
  const size = sizeAttr || '';
  // Explicitly mosaic keywords (subset of MOSAIC_KW without "stack"/"mesh" which
  // are ambiguous — stacked stone panels can also be mesh-mounted). Modella is
  // AZ's mesh-mounted multi-shape pattern format (sold per sheet).
  const MOSAIC_EXPLICIT = /mosaic|hex|penny|basketweave|herringbone|sheet|modella/i;
  // Mosaic-explicit sizes always win — even inside stacked-stone products,
  // a "2x2 Hex Mosaic" is a mosaic, not a ledger panel.
  if (MOSAIC_EXPLICIT.test(size)) return 'mosaic';
  // Tiny chips (1x1, 1x2, 5/8x1-1/4) are mesh-mounted mosaic sheets even when
  // the size attr carries no mosaic keyword — nothing ≤2.5" is sold loose.
  {
    const dims = parseSizeDims(size);
    if (dims && Math.max(dims[0], dims[1]) <= 2.5) return 'mosaic';
  }
  // Stacked stone: if product originally won stacked-stone, keep variants as
  // stacked unless BOTH dimensions are >=12 (real field tile).
  if (originalFormatSlug === 'stacked-stone') {
    const m = size.match(/(\d+)-?x-?(\d+)/);
    if (!m || Math.min(parseInt(m[1]), parseInt(m[2])) < 12) return 'stacked';
  }
  // Remaining MOSAIC_KW matches (mesh, stack) — only for non-stacked products
  if (MOSAIC_KW.test(size)) return 'mosaic';
  // Paver-sized variants (e.g., "24x24 Paver", "Paver 12x24")
  if (/paver/i.test(size)) return 'paver';
  // Slab-category product with tile-format variant
  if (originalSlabSlug && FIELD_SIZE.test(size)) return 'tile';
  return 'default';
}

/**
 * Arizona Tile catalog scraper.
 *
 * Uses WP REST API for listing + HTML scraping for detail specs.
 * No auth needed — catalog is public.
 *
 * Modes (set via source.config.mode):
 *   'full'      — (default) Full catalog scrape: products, SKUs, images, specs, packaging, pricing
 *   'inventory' — Lightweight pass: updates only pricing for existing AZT- SKUs
 *
 * No inventory data is written — Arizona Tile's site stock flags are not
 * meaningful for our warehouse, so inventory_snapshots is left untouched.
 *
 * Flow:
 *   1. Fetch products via WP REST API
 *   2. Fetch detail pages, parse specs/gallery/variations/packaging/pricing
 *   3. Full mode: upsert products/SKUs/images/specs/packaging/pricing + activate
 *      Inventory mode: update pricing for existing SKUs only
 */
// When the vendor is hidden (vendors.hide_public_name), the site descriptions we scrape carry the
// distributor name + marketing/logistics boilerplate. Strip them before storing so a re-scrape can't
// reintroduce the name. Best-effort code scrub; seoRenderer.cleanDescription is the render-time backstop.
let HIDE_VENDOR_NAME = null;
function scrubHiddenVendor(text) {
  if (!HIDE_VENDOR_NAME || !text) return text;
  const n = HIDE_VENDOR_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let t = text;
  // vendor-only marketing / logistics boilerplate tails
  t = t.replace(new RegExp('\\s*(at\\s+)?' + n + ' we have tile and slabs whether you are building your dream.*$', 'is'), '');
  t = t.replace(new RegExp('\\s*-?\\s*whether you are building your dream with ' + n + '\\.?\\s*$', 'i'), '');
  t = t.replace(new RegExp('\\s*just imagine how ' + n + ' products can enhance your project.*$', 'is'), '');
  t = t.replace(new RegExp("\\s*[^.]*\\b" + n + " (?:does not|will not|carries|features|Slab Warehouse|locations)[^.]*\\.", 'gi'), '');
  // attribution phrasings
  t = t.replace(new RegExp(n + "['’]s\\s+", 'g'), 'the ');
  t = t.replace(new RegExp('\\s*(?:,?\\s*crafted by|,?\\s*by|\\s*from)\\s+' + n + '\\b', 'gi'), '');
  t = t.replace(new RegExp('\\s*' + n + '\\b', 'gi'), '');   // any remaining
  t = t.replace(/\s{2,}/g, ' ').replace(/\s+([.,])/g, '$1').replace(/\s*-\s*$/, '').trim();
  return t || null;
}

export async function run(pool, job, source) {
  const config = { ...DEFAULT_CONFIG, ...(source.config || {}) };
  const vendor_id = source.vendor_id;
  {
    const vr = await pool.query('SELECT name, hide_public_name FROM vendors WHERE id=$1', [vendor_id]);
    HIDE_VENDOR_NAME = vr.rows[0]?.hide_public_name === true ? vr.rows[0].name : null;
    if (HIDE_VENDOR_NAME) console.log(`  [hidden vendor — scrubbing "${HIDE_VENDOR_NAME}" from scraped descriptions]`);
  }
  const isInventoryMode = config.mode === 'inventory';

  const stats = {
    found: 0, created: 0, updated: 0, skusCreated: 0,
    imagesSet: 0, skipped: 0, errors: 0,
    pricingUpdated: 0,
    priceListHits: 0, priceListMisses: 0,
    deactivated: 0,
  };

  // Load price list data (all 4 Excel files)
  let priceList = null;
  try {
    priceList = loadAllPriceLists();
    await appendLog(pool, job.id, `Price lists loaded: ${priceList.stats.total} entries (tile: ${priceList.stats.tile}, quartz: ${priceList.stats.quartz}, porcelain-slab: ${priceList.stats.porcelainSlab}, stone: ${priceList.stats.stone})`);
  } catch (err) {
    await appendLog(pool, job.id, `Warning: could not load price lists: ${err.message}. Falling back to web prices.`);
  }

  if (!isInventoryMode) {
    // Ensure all required attributes exist (idempotent)
    const requiredAttrs = [
      { name: 'Edge', slug: 'edge', display_order: 11 },
      { name: 'Look', slug: 'look', display_order: 12 },
      { name: 'Water Absorption', slug: 'water_absorption', display_order: 13 },
      { name: 'DCOF', slug: 'dcof', display_order: 14 },
      { name: 'Breaking Strength', slug: 'breaking_strength', display_order: 15 },
      { name: 'Frost Resistant', slug: 'frost_resistant', display_order: 16 },
      { name: 'Abrasion Resistance', slug: 'abrasion_resistance', display_order: 17 },
      { name: 'MOHS', slug: 'mohs', display_order: 18 },
      { name: 'Shade Variation', slug: 'shade_variation', display_order: 19 },
      { name: 'Staining Resistance', slug: 'staining_resistance', display_order: 20 },
      { name: 'Thermal Shock', slug: 'thermal_shock', display_order: 21 },
    ];
    for (const attr of requiredAttrs) {
      await pool.query(`
        INSERT INTO attributes (name, slug, display_order)
        VALUES ($1, $2, $3) ON CONFLICT (slug) DO NOTHING
      `, [attr.name, attr.slug, attr.display_order]);
    }
  }

  // Build slug → category_id lookup (only needed for full mode)
  const categoryLookup = new Map();
  if (!isInventoryMode) {
    try {
      const catRows = await pool.query('SELECT id, slug FROM categories WHERE is_active = true');
      for (const row of catRows.rows) categoryLookup.set(row.slug, row.id);
    } catch (err) {
      await appendLog(pool, job.id, 'Warning: category lookup failed: ' + err.message);
    }
  }

  const touchedProductIds = [];

  await appendLog(pool, job.id, `Mode: ${isInventoryMode ? 'INVENTORY' : 'FULL'}`);

  // ── Phase 1: Fetch all products via REST API + build category lookup ──

  // Fetch category taxonomy for mapping product_cat IDs → slugs
  await appendLog(pool, job.id, 'Phase 1: Fetching categories from REST API...');
  const azCategoryMap = new Map(); // cat_id → { name, slug, parent }
  try {
    const catResp = await fetch(`${BASE_URL}/api/wp/v2/product_cat?per_page=100`, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(60000)
    });
    if (catResp.ok) {
      const cats = await catResp.json();
      for (const cat of cats) {
        azCategoryMap.set(cat.id, { name: cat.name, slug: cat.slug, parent: cat.parent });
      }
      await appendLog(pool, job.id, `Fetched ${azCategoryMap.size} AZ Tile categories`);
    }
  } catch (err) {
    await appendLog(pool, job.id, `Warning: could not fetch categories: ${err.message}`);
  }

  // Fetch all products via paginated REST API
  await appendLog(pool, job.id, 'Fetching products from REST API...');
  const allProducts = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    try {
      const resp = await fetch(
        `${BASE_URL}/api/wp/v2/product?per_page=${config.perPage}&page=${page}`,
        { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(60000) }
      );

      if (!resp.ok) {
        if (resp.status === 400) {
          hasMore = false;
          break;
        }
        throw new Error(`REST API returned ${resp.status}`);
      }

      const products = await resp.json();
      if (!products.length) {
        hasMore = false;
        break;
      }

      for (const p of products) {
        const classListRaw = p.class_list || {};
        const classList = Array.isArray(classListRaw) ? classListRaw : Object.values(classListRaw);
        const isInStock = classList.some(c => c.includes('instock'));
        const isVariable = classList.some(c => c.includes('variable'));

        allProducts.push({
          wpId: p.id,
          slug: p.slug,
          title: stripTags(p.title?.rendered || ''),
          link: p.link,
          categoryIds: p.product_cat || [],
          isInStock,
          isVariable,
          description: p.yoast_head_json?.description || null,
        });
      }

      const totalPages = parseInt(resp.headers.get('X-WP-TotalPages') || '5', 10);
      hasMore = page < totalPages;
      page++;
      await delay(config.delayMs);
    } catch (err) {
      await appendLog(pool, job.id, `REST API page ${page} error: ${err.message}`);
      // Retry once after a longer delay
      await delay(5000);
      try {
        const retryResp = await fetch(
          `${BASE_URL}/api/wp/v2/product?per_page=${config.perPage}&page=${page}`,
          { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(90000) }
        );
        if (retryResp.ok) {
          const products = await retryResp.json();
          if (products.length) {
            for (const p of products) {
              const classListRaw = p.class_list || {};
              const classList = Array.isArray(classListRaw) ? classListRaw : Object.values(classListRaw);
              allProducts.push({
                wpId: p.id, slug: p.slug,
                title: stripTags(p.title?.rendered || ''),
                link: p.link, categoryIds: p.product_cat || [],
                isInStock: classList.some(c => c.includes('instock')),
                isVariable: classList.some(c => c.includes('variable')),
                description: p.yoast_head_json?.description || null,
              });
            }
            const totalPages = parseInt(retryResp.headers.get('X-WP-TotalPages') || '5', 10);
            hasMore = page < totalPages;
            page++;
            await appendLog(pool, job.id, `REST API page ${page - 1} retry succeeded`);
            await delay(config.delayMs);
            continue;
          }
        }
      } catch { /* retry also failed */ }
      await addJobError(pool, job.id, `REST API page ${page}: ${err.message} (retry also failed)`);
      hasMore = false;
    }
  }

  stats.found = allProducts.length;
  await appendLog(pool, job.id, `Phase 1 complete: ${stats.found} products from REST API`, {
    products_found: stats.found
  });

  // ── Phase 2: Fetch detail pages ──

  const detailDelayMs = Math.max(config.delayMs, 2000); // min 2s between requests to avoid throttling
  await appendLog(pool, job.id, `Phase 2: Fetching detail pages (sequential, ${detailDelayMs}ms delay)...`);

  // Cache parsed detail data per product
  const detailCache = new Map(); // wpId → parsedDetail | null

  const MAX_PAGE_RETRIES = 4;        // per-page retries on throttle before giving up
  const MAX_BACKOFF_MS = 90000;      // cap a single backoff sleep at 90s
  const ABORT_AFTER = 25;            // consecutive hard failures (post-retry) before bailing

  // Single fetch attempt. Distinguishes throttling (429/503, retryable) from a
  // genuine miss (404 etc, not retryable) so backoff only kicks in when the
  // server is actually rate-limiting us.
  async function fetchDetailOnce(apiProduct) {
    const resp = await fetch(apiProduct.link, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(45000)
    });
    if (resp.status === 429 || resp.status === 503 || resp.status === 403) {
      const raHeader = parseInt(resp.headers.get('retry-after') || '0', 10);
      return { ok: false, retryable: true, retryAfterMs: raHeader > 0 ? raHeader * 1000 : 0 };
    }
    if (!resp.ok) return { ok: false, retryable: false };
    const html = await resp.text();
    return { ok: true, data: parseDetailPage(html) };
  }

  // Fetch a detail page, backing off exponentially on throttle. Honors any
  // Retry-After the server sends. Returns parsed detail or null.
  async function fetchDetailPage(apiProduct) {
    let backoff = detailDelayMs * 2;
    for (let attempt = 0; attempt <= MAX_PAGE_RETRIES; attempt++) {
      let r;
      try {
        r = await fetchDetailOnce(apiProduct);
      } catch {
        r = { ok: false, retryable: true, retryAfterMs: 0 }; // timeout/network → treat as retryable
      }
      if (r.ok) return r.data;
      if (!r.retryable) return null; // genuine 404/etc — don't waste retries
      if (attempt < MAX_PAGE_RETRIES) {
        const wait = Math.min(r.retryAfterMs || backoff, MAX_BACKOFF_MS);
        await appendLog(pool, job.id,
          `  Throttled on ${apiProduct.wpId} — backing off ${Math.round(wait / 1000)}s (retry ${attempt + 1}/${MAX_PAGE_RETRIES})`);
        await delay(wait);
        backoff = Math.min(Math.round(backoff * 2.5), MAX_BACKOFF_MS);
      }
    }
    return null;
  }

  let consecutiveFailures = 0;
  for (let i = 0; i < allProducts.length; i++) {
    if (job.abortController?.signal?.aborted) {
      await appendLog(pool, job.id, `Phase 2 aborted at ${i}/${allProducts.length}`);
      break;
    }
    const apiProduct = allProducts[i];
    try {
      const result = await fetchDetailPage(apiProduct);
      detailCache.set(apiProduct.wpId, result);
      if (result) { consecutiveFailures = 0; } else { consecutiveFailures++; }
    } catch {
      detailCache.set(apiProduct.wpId, null);
      consecutiveFailures++;
    }

    if ((i + 1) % 10 === 0 || i === allProducts.length - 1) {
      const ok = [...detailCache.values()].filter(v => v != null).length;
      await appendLog(pool, job.id, `Fetch progress: ${i + 1}/${allProducts.length} (${ok} OK)`);
    }

    // Each page already retried with backoff above, so a run of hard failures
    // means a sustained block — cool off once, then bail if it persists.
    if (consecutiveFailures === Math.floor(ABORT_AFTER / 2)) {
      await appendLog(pool, job.id, `${consecutiveFailures} consecutive failures — cooling off 60s before continuing...`);
      await delay(60000);
    }
    if (consecutiveFailures >= ABORT_AFTER) {
      await appendLog(pool, job.id, `Aborting Phase 2: ${consecutiveFailures} consecutive failures after backoff — server is blocking us`);
      break;
    }

    await delay(detailDelayMs);
  }

  // Retry failed pages once more (fetchDetailPage already backs off internally)
  const failedProducts = allProducts.filter(p => detailCache.get(p.wpId) == null);
  if (failedProducts.length > 0 && failedProducts.length < allProducts.length) {
    await appendLog(pool, job.id, `Retrying ${failedProducts.length} failed detail pages...`);
    for (const apiProduct of failedProducts) {
      try {
        const result = await fetchDetailPage(apiProduct);
        if (result) detailCache.set(apiProduct.wpId, result);
      } catch { /* still failed */ }
      await delay(detailDelayMs);
    }
  }

  const fetchedCount = [...detailCache.values()].filter(v => v != null).length;
  await appendLog(pool, job.id, `Fetched ${fetchedCount}/${allProducts.length} detail pages`);

  // ── Phase 3 ──

  if (isInventoryMode) {
    // ── Inventory mode: update pricing for existing SKUs only ──
    await appendLog(pool, job.id, 'Phase 3: Updating pricing for existing SKUs...');

    // Build internal_sku → sku record lookup for all AZT- SKUs
    const existingSkus = await pool.query(`
      SELECT s.id, s.internal_sku, s.sell_by, c.slug AS cat_slug
      FROM skus s
      LEFT JOIN products p ON p.id = s.product_id
      LEFT JOIN categories c ON c.id = p.category_id
      WHERE s.internal_sku LIKE 'AZT-%'`);
    const skuLookup = new Map(existingSkus.rows.map(r => [r.internal_sku, { id: r.id, sell_by: r.sell_by, cat_slug: r.cat_slug }]));
    await appendLog(pool, job.id, `Found ${skuLookup.size} existing AZT- SKUs in DB`);

    let processIdx = 0;
    for (const apiProduct of allProducts) {
      const detail = detailCache.get(apiProduct.wpId);
      if (!detail) continue;

      try {
        const collectionName = apiProduct.title;

        if (apiProduct.isVariable && detail.variations.length > 0) {
          for (const v of detail.variations) {
            if (v.attributes?.attribute_pa_size === 'sample') continue;

            const internalSku = `AZT-${v.variation_id}`;
            const skuRec = skuLookup.get(internalSku);
            if (!skuRec) continue;
            const skuId = skuRec.id;

            // Update pricing from price list only (no WC fallback)
            const plEntry = priceList
              ? priceList.lookup(collectionName, v.attributes?.attribute_pa_color, v.attributes?.attribute_pa_size, v.attributes?.attribute_pa_finishes)
              : null;

            if (plEntry) {
              const plan = planFromPriceList(plEntry, skuRec.cat_slug);
              // Keep sell_by in sync with price list unit so price suffix matches
              if (skuRec.sell_by !== plan.sellBy) {
                await pool.query('UPDATE skus SET sell_by = $1, updated_at = NOW() WHERE id = $2', [plan.sellBy, skuId]);
              }
              await upsertPricing(pool, skuId, {
                cost: plan.cost,
                retail_price: Math.round(plan.cost * 2 * 100) / 100,
                price_basis: plan.priceBasis,
              });
              stats.pricingUpdated++;
            }
          }
        } else {
          const internalSku = `AZT-${apiProduct.wpId}`;
          const skuRec = skuLookup.get(internalSku);
          if (!skuRec) continue;
          const skuId = skuRec.id;

          // Update pricing: price list first, then page price fallback
          const plEntry = priceList ? priceList.lookup(collectionName, null, null, null) : null;

          if (plEntry) {
            const plan = planFromPriceList(plEntry, skuRec.cat_slug);
            if (skuRec.sell_by !== plan.sellBy) {
              await pool.query('UPDATE skus SET sell_by = $1, updated_at = NOW() WHERE id = $2', [plan.sellBy, skuId]);
            }
            await upsertPricing(pool, skuId, {
              cost: plan.cost,
              retail_price: Math.round(plan.cost * 2 * 100) / 100,
              price_basis: plan.priceBasis,
            });
            stats.pricingUpdated++;
          }
        }
      } catch (err) {
        stats.errors++;
      }

      processIdx++;
      if (processIdx % 100 === 0) {
        await appendLog(pool, job.id, `Pricing progress: ${processIdx}/${allProducts.length}, updated: ${stats.pricingUpdated}`);
      }
    }

    await appendLog(pool, job.id,
      `Pricing scrape complete. Entries: ${stats.found}, ` +
      `Pricing updated: ${stats.pricingUpdated}, ` +
      `Errors: ${stats.errors}`,
      { products_found: stats.found }
    );
  } else {
    // ── Full mode: upsert products + SKUs ──
    await appendLog(pool, job.id, 'Phase 3: Upserting products and SKUs...');

    // AZ lists some stones as separate WC pages for tile and slab with IDENTICAL
    // titles (e.g. "Bianco Carrara" tile page + slab page). Both resolve to the
    // same (vendor, collection, name) product row, merging tile SKUs into the
    // slab product with the slab category clobbering the tile category. Track
    // which titles also have a non-slab page so colliding slab pages get a
    // distinct " Slab" collection (and thus their own product row).
    const titleHasNonSlab = new Set();
    for (const p of allProducts) {
      const raw = resolveBestCategory(p, azCategoryMap, categoryLookup);
      if (raw.pimCatSlug && !SLAB_CATEGORIES.has(raw.pimCatSlug)) {
        titleHasNonSlab.add(p.title.toLowerCase());
      }
    }

    let idx = 0;
    for (const apiProduct of allProducts) {
      const detail = detailCache.get(apiProduct.wpId);
      if (!detail) {
        stats.skipped++;
        idx++;
        continue;
      }

      try {
        // Resolve PIM category — score all AZ categories and pick highest priority
        let { categoryId, pimCatSlug } = resolveBestCategory(apiProduct, azCategoryMap, categoryLookup);

        // Save pre-guard category state for variant-level format splitting
        const originalFormatSlug = FORMAT_CATS.has(pimCatSlug) ? pimCatSlug : null;
        const originalSlabSlug = SLAB_CATEGORIES.has(pimCatSlug) ? pimCatSlug : null;

        // ── Mixed-product guard: mosaic should not win for field-tile collections ──
        // Products like Marvel have both 12x24 field tiles AND 2x2 Mosaic variants.
        // If a format category won via priority but the product has field-tile sizes,
        // fall back to the best material category.
        if (FORMAT_CATS.has(pimCatSlug) && detail.variations.length > 0) {
          const varSizes = detail.variations
            .map(v => (v.attributes?.attribute_pa_size || ''))
            .filter(Boolean);
          const hasFieldTileSize = varSizes.some(s => isFieldTileSize(s));

          if (hasFieldTileSize) {
            // Re-resolve: find best non-mosaic category
            let altPriority = -1, altCatId = null, altSlug = null;
            for (const catId of apiProduct.categoryIds) {
              const azCat = azCategoryMap.get(catId);
              if (!azCat || CATEGORY_SKIP.has(azCat.slug)) continue;
              const mapping = CATEGORY_MAP[azCat.slug];
              if (!mapping) continue;
              const [slug, priority] = mapping;
              // Skip all format categories — the product has field-tile sizes
              if (slug === 'mosaic-tile' || slug === 'stacked-stone' || slug === 'pavers') continue;
              if (priority > altPriority && categoryLookup.has(slug)) {
                altPriority = priority;
                altCatId = categoryLookup.get(slug);
                altSlug = slug;
              }
            }
            // Only demote to a SPECIFIC material category (priority ≥80, e.g.
            // porcelain-and-ceramic, marble-tile). Generic special-order/OL tags
            // ('stone' 70, 'special-order-series' 20) must not steal glass-SO
            // mosaic sheets whose sizes look field-like (Geo-Solid Square 12x12,
            // Geo-Highland 15x15).
            if (altCatId && altPriority >= 80) {
              categoryId = altCatId;
              pimCatSlug = altSlug;
            }
          }
        }

        // Resolve non-slab material category for tile-format variants in slab products
        let tileCatId = null, tileCatSlug = null;
        if (originalSlabSlug && SLAB_CATEGORIES.has(pimCatSlug)) {
          let altP = -1;
          for (const catId of apiProduct.categoryIds) {
            const azCat = azCategoryMap.get(catId);
            if (!azCat || CATEGORY_SKIP.has(azCat.slug)) continue;
            const mapping = CATEGORY_MAP[azCat.slug];
            if (!mapping) continue;
            const [slug, priority] = mapping;
            if (SLAB_CATEGORIES.has(slug) || FORMAT_CATS.has(slug)) continue;
            if (priority > altP && categoryLookup.has(slug)) {
              altP = priority;
              tileCatId = categoryLookup.get(slug);
              tileCatSlug = slug;
            }
          }
        }

        // ── Wall/backsplash tile detection ──
        // Small-format porcelain tiles (3x6, 4x16, 2-1/4x9-3/4, etc.) are wall tiles
        // IF the product has NO field-tile-sized variants (12x24, 24x48, etc.).
        // This is size-based, not finish-based — many wall tiles aren't labeled glossy.
        if (pimCatSlug === 'porcelain-tile' && categoryLookup.has('backsplash-wall')
            && detail.variations.length > 0) {
          const varSizes = detail.variations
            .map(v => (v.attributes?.attribute_pa_size || ''))
            .filter(s => s && s !== 'sample');
          // Check if ANY variant has a field-tile size (≥12 in both dims)
          const hasFieldSize = varSizes.some(s => isFieldTileSize(s));
          // Check if at least one variant has a recognized wall-tile size
          // Handles raw (4x16), WC-slugified (4-x-16), and fractional (2-1-4-x-9-3-4)
          const WALL_PATTERN = /\b(3-?x-?6|4-?x-?12|4-?x-?16|2-?x-?6|2-?x-?8|2-?x-?12|2-?x-?16|3-?x-?12|3-?x-?9|2\.?5-?x-?8|6-?x-?6|8-?x-?24)\b|\d-\d+-?\d*-x-\d/;
          const hasWallSize = varSizes.some(s => WALL_PATTERN.test(s));
          if (hasWallSize && !hasFieldSize) {
            categoryId = categoryLookup.get('backsplash-wall');
            pimCatSlug = 'backsplash-wall';
          }
        }

        // ── Name-based format override ──
        // Products tagged only with generic material categories (natural-stone-tile,
        // porcelain-and-ceramic) but whose collection name clearly indicates a specific
        // format (mosaic, stacked stone) get reclassified here.
        if (!FORMAT_CATS.has(pimCatSlug) && !SLAB_CATEGORIES.has(pimCatSlug)) {
          // Ledger products aren't always named "Ledger" — Haisa Blue's only
          // size is "Split Honed Ledger 6x24". Treat as stacked stone when
          // every variant size is a ledger/splitface size.
          const nonSampleSizes = detail.variations
            .map(v => (v.attributes?.attribute_pa_size || ''))
            .filter(s => s && s !== 'sample');
          const allLedgerSizes = nonSampleSizes.length > 0
            && nonSampleSizes.every(s => STACKED_NAME_PATTERN.test(s));
          if (MOSAIC_NAME_PATTERN.test(apiProduct.title)) {
            const mosaicId = categoryLookup.get('mosaic-tile');
            if (mosaicId) { categoryId = mosaicId; pimCatSlug = 'mosaic-tile'; }
          } else if (STACKED_NAME_PATTERN.test(apiProduct.title) || allLedgerSizes) {
            const stackedId = categoryLookup.get('stacked-stone');
            if (stackedId) { categoryId = stackedId; pimCatSlug = 'stacked-stone'; }
          }
        }

        // ── Determine collection + name ──
        // Collection = product title from API (e.g., "3D")
        // For variable products, group by color — each color becomes its own product
        // For simple products, keep title as name with collection
        const collectionName = apiProduct.title;
        // Customer-facing collection/name base with series codes expanded/stripped.
        // (collectionName itself stays pristine: price-list lookups key off it.)
        const displayCollection = normalizeSeriesTitle(apiProduct.title);
        // Slab page whose title collides with a tile/mosaic page — needs its own
        // collection so it doesn't share a product row with the tile product.
        const slabCollision = SLAB_CATEGORIES.has(pimCatSlug) && titleHasNonSlab.has(apiProduct.title.toLowerCase());

        // ── Gallery images data ──
        const galleryData = detail.gallery; // { flat: [...], shared: [...], byVariationId: { 8683: [...], ... } }
        const galleryFlat = galleryData.flat || [];
        const galleryShared = galleryData.shared || [];

        // Handle SKUs based on product type
        if (apiProduct.isVariable && detail.variations.length > 0) {
          // Group variations by color to create one product per color
          const colorGroups = new Map(); // color → [{ vi, v }]
          for (let vi = 0; vi < detail.variations.length; vi++) {
            const v = detail.variations[vi];
            if (v.attributes?.attribute_pa_size === 'sample') continue;
            const color = v.attributes?.attribute_pa_color || '';
            if (!colorGroups.has(color)) colorGroups.set(color, []);
            colorGroups.get(color).push({ vi, v });
          }

          for (const [colorSlug, variations] of colorGroups) {
            // Product name = deslugified color (e.g., "white-ribbon" → "White Ribbon")
            // If no color, fall back to the API title
            const rawColor = colorSlug ? deslugify(colorSlug) : apiProduct.title;
            // Skip the collection prefix when the page title already CONTAINS the
            // color name ("CS-Terra Nova" + color "Terra Nova" would double into
            // "CS-Terra Nova Terra Nova ...") — the color is the identity there.
            const productName = (displayCollection
                && !rawColor.toLowerCase().startsWith(displayCollection.toLowerCase())
                && !displayCollection.toLowerCase().includes(rawColor.toLowerCase()))
              ? joinDedupe(displayCollection, rawColor)
              : rawColor;

            // Build best product-shot lookup from all sibling variations in this color group.
            // When a variant only has a lifestyle image, we can substitute a product shot from a sibling.
            let colorBestProductShot = null;
            for (const { v: sv } of variations) {
              const svImg = sv.image?.url || sv.image?.src || null;
              if (!svImg || /coming-soon/i.test(svImg)) continue;
              const svUrl = reParamWidenUrl(svImg);
              if (!isLifestyleUrl(svUrl, productName)) {
                // Found a product shot — prefer swatches over generic product images
                if (!colorBestProductShot || /swatch/i.test(svUrl)) {
                  colorBestProductShot = svUrl;
                  if (/swatch/i.test(svUrl)) break; // swatch is ideal, stop looking
                }
              }
            }

            // Sub-group variations by format for variant-level category splitting
            const formatGroups = new Map();
            for (const entry of variations) {
              const fmt = classifyVariation(
                entry.v.attributes?.attribute_pa_size,
                originalFormatSlug,
                originalSlabSlug
              );
              if (!formatGroups.has(fmt)) formatGroups.set(fmt, []);
              formatGroups.get(fmt).push(entry);
            }

            const needsSuffix = formatGroups.size > 1;

            for (const [fmt, fmtVariations] of formatGroups) {
              let effectiveCollection = displayCollection;
              let effectiveCatId = categoryId;
              let effectiveCatSlug = pimCatSlug;

              if (fmt === 'mosaic') {
                const mosaicId = categoryLookup.get('mosaic-tile');
                if (mosaicId) { effectiveCatId = mosaicId; effectiveCatSlug = 'mosaic-tile'; }
                if (needsSuffix) effectiveCollection += ' Mosaics';
              } else if (fmt === 'stacked') {
                // Porcelain series' "stack" groups (Canyon, Marvel, Shibusa, …)
                // are mesh-mounted stacked-LOOK mosaic sheets, not stone ledger
                // — browse them under mosaic-tile. Real stone pages keep
                // stacked-stone. The " Stacked Stone" collection suffix stays
                // either way: it names the look, and product identity keys on
                // (vendor, collection, name).
                const porcelainStack = apiProduct.categoryIds.some(id => {
                  const az = azCategoryMap.get(id);
                  return az && (az.slug === 'porcelain-and-ceramic' || az.slug === 'porcelain-stack');
                });
                const stackSlug = porcelainStack ? 'mosaic-tile' : 'stacked-stone';
                const stackedId = categoryLookup.get(stackSlug);
                if (stackedId) { effectiveCatId = stackedId; effectiveCatSlug = stackSlug; }
                if (needsSuffix) effectiveCollection += ' Stacked Stone';
              } else if (fmt === 'paver') {
                const paverId = categoryLookup.get('pavers');
                if (paverId) { effectiveCatId = paverId; effectiveCatSlug = 'pavers'; }
                if (needsSuffix) effectiveCollection += ' Pavers';
              } else if (fmt === 'tile') {
                if (tileCatId) {
                  effectiveCatId = tileCatId;
                  effectiveCatSlug = tileCatSlug;
                } else {
                  // No tile category from AZ WC tags — use slab-to-tile fallback
                  const fb = SLAB_TO_TILE_FALLBACK[originalSlabSlug];
                  if (fb && categoryLookup.has(fb)) {
                    effectiveCatId = categoryLookup.get(fb);
                    effectiveCatSlug = fb;
                  }
                }
                if (needsSuffix) effectiveCollection += ' Tile';
              } else if (fmt === 'default' && effectiveCatSlug === 'mosaic-tile') {
                // Piece-format leftovers of a mosaic-tagged series (Gem fluted
                // 2x16 strips, S-Series 2x12, Thin Brick 2x8, Atlantic Grey
                // 4x16 Split): the series page's mesh-mount tags describe the
                // sibling mosaic groups, not these loose pieces. Demote to the
                // material category when EVERY size in the group is a clean
                // integer piece size ≤4" on one side (mesh sheets have
                // fractional dims — Geometro et al. stay mosaics).
                const pieceSizes = fmtVariations
                  .map(e => e.v.attributes?.attribute_pa_size || '')
                  .filter(s => s && s !== 'sample');
                const allWallPieces = pieceSizes.length > 0 && pieceSizes.every(s => {
                  if (MOSAIC_KW.test(s)) return false;
                  const d = parseSizeDims(s);
                  return d && Number.isInteger(d[0]) && Number.isInteger(d[1])
                    && Math.min(d[0], d[1]) <= 4 && Math.max(d[0], d[1]) <= 24;
                });
                if (allWallPieces) {
                  // Strongest non-format material tag. The ≥50 floor skips the
                  // generic special-order/outer-limits fallbacks so tag-less
                  // glass mosaic series (Geo-Solid etc.) keep mosaic-tile.
                  let altSlug = null, altP = 49;
                  for (const catId of apiProduct.categoryIds) {
                    const azCat = azCategoryMap.get(catId);
                    if (!azCat || CATEGORY_SKIP.has(azCat.slug)) continue;
                    const mapping = CATEGORY_MAP[azCat.slug];
                    if (!mapping) continue;
                    const [slug, priority] = mapping;
                    if (FORMAT_CATS.has(slug) || SLAB_CATEGORIES.has(slug)) continue;
                    if (priority > altP && categoryLookup.has(slug)) { altP = priority; altSlug = slug; }
                  }
                  const fluted = /flut/i.test(`${apiProduct.title} ${apiProduct.description || ''}`);
                  const target = fluted && categoryLookup.has('fluted-tile') ? 'fluted-tile'
                    : (!altSlug || altSlug === 'porcelain-tile' || altSlug === 'ceramic-tile')
                      ? 'backsplash-wall' : altSlug;
                  if (categoryLookup.has(target)) {
                    effectiveCatId = categoryLookup.get(target);
                    effectiveCatSlug = target;
                  }
                }
              } else if (slabCollision && SLAB_CATEGORIES.has(effectiveCatSlug)) {
                effectiveCollection += ' Slab';
              }

            // ── Mosaic shape sub-grouping ──
            // For mosaics, group variants by shape/pattern so each shape gets its
            // own product with the shape in the name (e.g., "Bardiglio Herringbone").
            // Skip for 'stacked' groups routed to mosaic-tile: their sizes hit
            // shape words ("Straight Stack", "Long Rhomboid") and renaming would
            // fork existing products.
            const shapeSubGroups = [];
            if (effectiveCatSlug === 'mosaic-tile' && fmt !== 'stacked') {
              const shapeMap = new Map();
              for (const entry of fmtVariations) {
                const shape = extractMosaicShape(entry.v.attributes?.attribute_pa_size);
                if (!shapeMap.has(shape)) shapeMap.set(shape, []);
                shapeMap.get(shape).push(entry);
              }
              for (const [shape, vars] of shapeMap) {
                // Don't append a shape word the name already carries
                // ("Large Chevron Terra Nova" + shape "Chevron")
                const hasShape = shape && new RegExp('\\b' + shape.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + 's?\\b', 'i').test(productName);
                shapeSubGroups.push([shape && !hasShape ? `${productName} ${shape}` : productName, vars, shape]);
              }
            } else {
              shapeSubGroups.push([productName, fmtVariations, '']);
            }

            for (const [effectiveName, subVariations, mosaicShape] of shapeSubGroups) {

            // ── Skip format-page duplicates ──
            // Format pages (Modella, Split) list colors that usually have their own
            // WC product page. If this color already exists under a different collection,
            // skip to avoid creating a duplicate product.
            if (FORMAT_PAGE_TITLES.has(collectionName)) {
              const existsElsewhere = await pool.query(
                `SELECT 1 FROM products WHERE vendor_id = $1 AND name = $2
                 AND collection NOT LIKE $3 AND is_active = true LIMIT 1`,
                [vendor_id, effectiveName, collectionName + '%']
              );
              if (existsElsewhere.rows.length > 0) {
                continue;
              }
            }

            const product = await upsertProduct(pool, {
              vendor_id,
              name: effectiveName,
              collection: effectiveCollection,
              category_id: effectiveCatId,
              description_short: apiProduct.description ? scrubHiddenVendor(apiProduct.description.slice(0, 255)) : null,
              description_long: scrubHiddenVendor(apiProduct.description)
            });

            if (product.is_new) stats.created++;
            else stats.updated++;
            touchedProductIds.push(product.id);

            // ── Product-level primary image ──
            // Collect ALL candidate images from all subVariation galleries + variation.image,
            // then run preferProductShot to select the best product shot.
            const isMosaicCtx = effectiveCatSlug === 'mosaic-tile';
            let productPrimaryCandidates = [];
            for (const { v: cv } of subVariations) {
              const varGal = galleryData.byVariationId[cv.variation_id] || [];
              for (const url of varGal) {
                productPrimaryCandidates.push(reParamWidenUrl(url));
              }
              const cvImg = cv.image?.url || cv.image?.src || null;
              if (cvImg) productPrimaryCandidates.push(reParamWidenUrl(cvImg));
            }
            // Deduplicate and filter placeholders
            productPrimaryCandidates = await filterWidenPlaceholders(
              filterImageUrls([...new Set(productPrimaryCandidates)]
                .filter(u => !/coming-soon/i.test(u)))
            );
            // For mosaics, prefer non-field-tile images; keep field-tile as last resort
            if (isMosaicCtx) {
              const mosaicOnly = productPrimaryCandidates.filter(u => !isFieldTileUrl(u));
              if (mosaicOnly.length > 0) productPrimaryCandidates = mosaicOnly;
            }
            // Sibling propagation: if first candidate is lifestyle, use color group's product shot
            if (colorBestProductShot && productPrimaryCandidates.length > 0 && isLifestyleUrl(productPrimaryCandidates[0], effectiveName)) {
              productPrimaryCandidates.unshift(colorBestProductShot);
            } else if (colorBestProductShot && productPrimaryCandidates.length === 0) {
              productPrimaryCandidates.push(colorBestProductShot);
            }
            const productPrimaryUrl = productPrimaryCandidates.length > 0 ? productPrimaryCandidates[0] : null;

            if (productPrimaryUrl) {
              await upsertMediaAsset(pool, {
                product_id: product.id,
                sku_id: null,
                asset_type: 'primary',
                url: productPrimaryUrl,
                original_url: productPrimaryUrl,
                sort_order: 0,
              });
              stats.imagesSet++;
            }

            for (const { vi, v } of subVariations) {
              // Variant name: size + finish (color is now in product name)
              let sizePart = v.attributes?.attribute_pa_size ? deslugify(v.attributes.attribute_pa_size) : '';
              const finishPart = v.attributes?.attribute_pa_finishes ? deslugify(v.attributes.attribute_pa_finishes) : '';

              // Strip mosaic shape from sizePart — it's already in the product name
              if (mosaicShape && sizePart) {
                sizePart = sizePart.replace(new RegExp(`\\b${mosaicShape}\\b`, 'i'), '').replace(/\s{2,}/g, ' ').trim();
              }
              // Strip finish from sizePart when it appears as a leading/trailing word group
              // e.g. "Multi Finish Modella" + finish "Multi Finish" → "Modella"
              if (finishPart && sizePart) {
                const esc = finishPart.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                sizePart = sizePart
                  .replace(new RegExp(`^${esc}\\b\\s*`, 'i'), '')
                  .replace(new RegExp(`\\s*\\b${esc}$`, 'i'), '')
                  .trim();
              }

              const variantName = buildVariantName(sizePart, finishPart);

              const accessory = isAccessory(apiProduct.title, apiProduct.description);

              // ── Price list lookup ──
              const plEntry = priceList
                ? priceList.lookup(collectionName, colorSlug, v.attributes?.attribute_pa_size, v.attributes?.attribute_pa_finishes)
                : null;

              // Determine sell_by from price list unit or fallback
              const plPlan = plEntry ? planFromPriceList(plEntry, effectiveCatSlug) : null;
              const sellBy = plPlan ? plPlan.sellBy : resolveSellBy(effectiveCatSlug, accessory, detail.soldBy);

              const sku = await upsertSku(pool, {
                product_id: product.id,
                vendor_sku: String(v.variation_id),
                internal_sku: `AZT-${v.variation_id}`,
                variant_name: variantName,
                sell_by: sellBy,
                ...(accessory && { variant_type: 'accessory' }),
              });
              if (sku.is_new) stats.skusCreated++;

              // ── Pricing: price list only (no WC fallback — "Call for Price" if no match) ──
              if (plPlan) {
                await upsertPricing(pool, sku.id, {
                  cost: plPlan.cost,
                  retail_price: Math.round(plPlan.cost * 2 * 100) / 100,
                  price_basis: plPlan.priceBasis,
                });
                stats.priceListHits++;
              } else {
                stats.priceListMisses++;
              }

              // ── Packaging: price list first, then HTML-parsed fallback ──
              // Some price-list rows only give sf/pc + pcs/box — derive box sqft
              // from those, but only when the result is a plausible BOX (≤60 sqft):
              // large-format rows put CRATE counts in pcs/box (24x24 = 98 pcs =
              // 392 sqft), which must not be stored as a box.
              const plSfPerBox = plEntry
                ? (plEntry.sfPerBox
                    || ((plEntry.sfPerPc && plEntry.pcsPerBox && plEntry.sfPerPc * plEntry.pcsPerBox <= 60)
                        ? Math.round(plEntry.sfPerPc * plEntry.pcsPerBox * 10000) / 10000 : null))
                : null;
              if (plSfPerBox) {
                await upsertPackaging(pool, sku.id, {
                  sqft_per_box: plSfPerBox,
                  pieces_per_box: plEntry.pcsPerBox || null,
                  weight_per_box_lbs: null,
                  boxes_per_pallet: plEntry.boxesPerPallet || null,
                  sqft_per_pallet: plEntry.sfPerPallet || null,
                  weight_per_pallet_lbs: null,
                });
              } else if (detail.packaging && Object.keys(detail.packaging).length > 0 && !NO_BOX_CATEGORIES.has(effectiveCatSlug)
                         && detail.variations.length === 1) {
                // Page-level packaging block describes ONE variant — only safe to
                // apply when the page has a single variation (it used to smear the
                // default variant's box info across every size on the page).
                await upsertPackaging(pool, sku.id, {
                  sqft_per_box: detail.packaging.sqftPerBox || null,
                  pieces_per_box: detail.packaging.piecesPerBox || null,
                  weight_per_box_lbs: detail.packaging.weightPerBox || null,
                  boxes_per_pallet: detail.packaging.boxesPerPallet || null,
                  sqft_per_pallet: detail.packaging.sqftPerPallet || null,
                  weight_per_pallet_lbs: detail.packaging.weightPerPallet || null,
                });
              }

              // ── Variation-level attributes ──
              if (v.attributes?.attribute_pa_color) {
                await upsertSkuAttribute(pool, sku.id, 'color', cleanAttrValue(v.attributes.attribute_pa_color));
              }
              if (v.attributes?.attribute_pa_size) {
                await upsertSkuAttribute(pool, sku.id, 'size', cleanAttrValue(v.attributes.attribute_pa_size));
              }
              if (v.attributes?.attribute_pa_finishes) {
                let finishVal = cleanAttrValue(v.attributes.attribute_pa_finishes);
                if (finishPart && finishPart.toLowerCase() !== finishVal.toLowerCase()) {
                  finishVal = finishPart;
                }
                await upsertSkuAttribute(pool, sku.id, 'finish', finishVal);
              }

              // ── Product-level specs as SKU attributes ──
              await upsertAllSpecAttributes(pool, sku.id, detail.specs, detail.technicalSpecs, { skipFinish: !!v.attributes?.attribute_pa_finishes });

              // ── Per-variant images ──
              // Gallery first (first = primary), variation.image as fallback only
              const varImage = v.image?.url || v.image?.src || null;
              const sortBase = (vi + 1) * 100;

              const varGallery = galleryData.byVariationId[v.variation_id] || [];
              let allVarImages = await filterWidenPlaceholders(filterImageUrls(normalizeWidenUrls(varGallery)));

              // For mosaic SKUs, prefer non-field-tile images; keep field-tile as last resort
              if (isMosaicCtx) {
                const mosaicOnly = allVarImages.filter(u => !isFieldTileUrl(u));
                if (mosaicOnly.length > 0) allVarImages = mosaicOnly;
              }

              // If gallery is empty, fall back to variation.image (skip placeholders)
              if (allVarImages.length === 0 && varImage && !/coming-soon/i.test(varImage)) {
                const fallback = await filterWidenPlaceholders([reParamWidenUrl(varImage)]);
                if (fallback.length > 0) allVarImages.push(fallback[0]);
              }

              // Sibling propagation: if primary is a lifestyle image but a sibling variant
              // in the same color group has a product shot, use that instead
              if (colorBestProductShot && allVarImages.length > 0 && isLifestyleUrl(allVarImages[0], effectiveName)) {
                allVarImages.unshift(colorBestProductShot);
              } else if (colorBestProductShot && allVarImages.length === 0) {
                allVarImages.push(colorBestProductShot);
              }

              for (let gi = 0; gi < allVarImages.length && gi < MAX_GALLERY_IMAGES; gi++) {
                const imgUrl = allVarImages[gi];
                const isLife = isLifestyleUrl(imgUrl);
                const assetType = gi === 0 && !isLife ? 'primary'
                  : (isLife || gi > 2) ? 'lifestyle'
                  : 'alternate';
                await upsertMediaAsset(pool, {
                  product_id: product.id,
                  sku_id: sku.id,
                  asset_type: assetType,
                  url: imgUrl,
                  original_url: imgUrl,
                  sort_order: sortBase + gi,
                });
                stats.imagesSet++;
              }
            } // end for variations
            } // end for shapeSubGroups
            } // end for formatGroups
          } // end for colorGroups
        } else {
          // Simple product: single SKU — use title as name, no collection grouping
          const product = await upsertProduct(pool, {
            vendor_id,
            name: displayCollection,
            collection: slabCollision ? `${displayCollection} Slab` : displayCollection,
            category_id: categoryId,
            description_short: apiProduct.description ? scrubHiddenVendor(apiProduct.description.slice(0, 255)) : null,
            description_long: scrubHiddenVendor(apiProduct.description)
          });

          if (product.is_new) stats.created++;
          else stats.updated++;
          touchedProductIds.push(product.id);

          // Product-level primary image (filtered, vendor gallery order preserved)
          const simpleFiltered = await filterWidenPlaceholders(filterImageUrls(normalizeWidenUrls(galleryFlat)));
          if (simpleFiltered.length > 0) {
            await upsertMediaAsset(pool, {
              product_id: product.id,
              sku_id: null,
              asset_type: 'primary',
              url: simpleFiltered[0],
              original_url: simpleFiltered[0],
              sort_order: 0,
            });
            stats.imagesSet++;
          }

          const accessory = isAccessory(apiProduct.title, apiProduct.description);

          // ── Price list lookup for simple product ──
          // For slab categories, try multi-gauge lookup to create per-thickness SKUs
          const isSlab = pimCatSlug && SLAB_CATEGORIES.has(pimCatSlug);
          const gaugeEntries = (isSlab && priceList)
            ? priceList.lookupSimpleAllGauges(apiProduct.title, apiProduct.slug, detail.specs)
            : [];
          const plEntry = gaugeEntries.length > 0 ? gaugeEntries[0]
            : (priceList ? priceList.lookupSimple(apiProduct.title, apiProduct.slug, detail.specs, isSlab) : null);

          // Multi-gauge path: create one SKU per thickness
          if (gaugeEntries.length > 1) {
            for (const entry of gaugeEntries) {
              const gauge = entry.normalizedGauge; // e.g. "2CM", "3CM"
              const entryPlan = planFromPriceList(entry, pimCatSlug);

              const sku = await upsertSku(pool, {
                product_id: product.id,
                vendor_sku: `${apiProduct.wpId}-${gauge}`,
                internal_sku: `AZT-${apiProduct.wpId}-${gauge}`,
                variant_name: gauge,
                sell_by: entryPlan.sellBy,
                ...(accessory && { variant_type: 'accessory' }),
              });
              if (sku.is_new) stats.skusCreated++;

              // Pricing per gauge
              await upsertPricing(pool, sku.id, {
                cost: entryPlan.cost,
                retail_price: Math.round(entryPlan.cost * 2 * 100) / 100,
                price_basis: entryPlan.priceBasis,
              });
              stats.priceListHits++;

              // Spec attributes (shared across gauges)
              await upsertAllSpecAttributes(pool, sku.id, detail.specs, detail.technicalSpecs);
              // Override thickness with the specific gauge value
              await upsertSkuAttribute(pool, sku.id, 'thickness', gauge);
            }
            // Images at product level only (sku_id: null) — API falls back to product-level media
            if (simpleFiltered.length > 0) {
              for (let gi = 0; gi < simpleFiltered.length; gi++) {
                const imgUrl = simpleFiltered[gi];
                const isLife = isLifestyleUrl(imgUrl);
                let assetType;
                if (gi === 0) assetType = 'primary';
                else if (isLife || gi > 2) assetType = 'lifestyle';
                else assetType = 'alternate';

                await upsertMediaAsset(pool, {
                  product_id: product.id,
                  sku_id: null,
                  asset_type: assetType,
                  url: imgUrl,
                  original_url: imgUrl,
                  sort_order: gi,
                });
                stats.imagesSet++;
              }
            }
          } else {
            // Single SKU path (non-slab, or slab with only one gauge)
            const plPlan = plEntry ? planFromPriceList(plEntry, pimCatSlug) : null;
            const sellBy = plPlan ? plPlan.sellBy : resolveSellBy(pimCatSlug, accessory, detail.soldBy);

            const sku = await upsertSku(pool, {
              product_id: product.id,
              vendor_sku: String(apiProduct.wpId),
              internal_sku: `AZT-${apiProduct.wpId}`,
              variant_name: null,
              sell_by: sellBy,
              ...(accessory && { variant_type: 'accessory' }),
            });
            if (sku.is_new) stats.skusCreated++;

            // ── Pricing: price list only (no WC fallback — "Call for Price" if no match) ──
            if (plPlan) {
              await upsertPricing(pool, sku.id, {
                cost: plPlan.cost,
                retail_price: Math.round(plPlan.cost * 2 * 100) / 100,
                price_basis: plPlan.priceBasis,
              });
              stats.priceListHits++;
            } else {
              stats.priceListMisses++;
            }

            // ── Packaging: price list first, then HTML-parsed ──
            if (plEntry && plEntry.sfPerBox) {
              await upsertPackaging(pool, sku.id, {
                sqft_per_box: plEntry.sfPerBox || null,
                pieces_per_box: plEntry.pcsPerBox || null,
                weight_per_box_lbs: null,
                boxes_per_pallet: plEntry.boxesPerPallet || null,
                sqft_per_pallet: plEntry.sfPerPallet || null,
                weight_per_pallet_lbs: null,
              });
            } else if (detail.packaging && Object.keys(detail.packaging).length > 0 && !NO_BOX_CATEGORIES.has(pimCatSlug)) {
              if (detail.packaging._pdfOnly) {
                await appendLog(pool, job.id, `Info: ${apiProduct.slug} has packaging PDF (${detail.packaging.pdfUrl}) but no inline data`);
              } else {
                await upsertPackaging(pool, sku.id, {
                  sqft_per_box: detail.packaging.sqftPerBox || null,
                  pieces_per_box: detail.packaging.piecesPerBox || null,
                  weight_per_box_lbs: detail.packaging.weightPerBox || null,
                  boxes_per_pallet: detail.packaging.boxesPerPallet || null,
                  sqft_per_pallet: detail.packaging.sqftPerPallet || null,
                  weight_per_pallet_lbs: detail.packaging.weightPerPallet || null,
                });
              }
            }

            // ── All spec attributes ──
            await upsertAllSpecAttributes(pool, sku.id, detail.specs, detail.technicalSpecs);

            // ── Images (vendor gallery order preserved, filtered by filterImageUrls) ──
            if (simpleFiltered.length > 0) {
              for (let gi = 0; gi < simpleFiltered.length; gi++) {
                const imgUrl = simpleFiltered[gi];
                const isLife = isLifestyleUrl(imgUrl);
                let assetType;
                if (gi === 0) assetType = 'primary';
                else if (isLife || gi > 2) assetType = 'lifestyle';
                else assetType = 'alternate';

                await upsertMediaAsset(pool, {
                  product_id: product.id,
                  sku_id: sku.id,
                  asset_type: assetType,
                  url: imgUrl,
                  original_url: imgUrl,
                  sort_order: gi,
                });
                stats.imagesSet++;
              }
            }
          }
        }
      } catch (err) {
        await appendLog(pool, job.id, `ERROR upserting ${apiProduct.slug}: ${err.message}`);
        await addJobError(pool, job.id, `Product ${apiProduct.slug}: ${err.message}`);
        stats.errors++;
      }

      idx++;
      if (idx % 25 === 0 || idx === allProducts.length) {
        await appendLog(pool, job.id, `Upsert progress: ${idx}/${allProducts.length}`, {
          products_found: stats.found,
          products_created: stats.created,
          products_updated: stats.updated,
          skus_created: stats.skusCreated
        });
      }
    }

    // ── Phase 4: Bulk activate + fix missing primaries ──

    if (touchedProductIds.length > 0) {
      const activateResult = await pool.query(
        `UPDATE products SET status = 'active', updated_at = CURRENT_TIMESTAMP
         WHERE id = ANY($1) AND status = 'draft'`,
        [touchedProductIds]
      );
      await appendLog(pool, job.id, `Activated ${activateResult.rowCount} products (${touchedProductIds.length} total touched)`);

      // ── Phase 4b: Deactivate products no longer in catalog ──
      // Safety guards (ALL must pass):
      //   1. ≥50% of existing active products were touched (prevents partial-catalog issues)
      //   2. ≥80% of detail pages were successfully fetched (prevents fetch-failure cascades)
      const fetchRatio = allProducts.length > 0 ? fetchedCount / allProducts.length : 0;
      const activeResult = await pool.query(
        `SELECT id FROM products WHERE vendor_id = $1 AND status = 'active'`,
        [vendor_id]
      );
      const touchedSet = new Set(touchedProductIds);
      const orphanIds = activeResult.rows.filter(r => !touchedSet.has(r.id)).map(r => r.id);
      const ratio = activeResult.rows.length > 0 ? touchedProductIds.length / activeResult.rows.length : 0;

      if (orphanIds.length > 0 && ratio >= 0.5 && fetchRatio >= 0.8) {
        const deactivateResult = await pool.query(
          `UPDATE products SET status = 'inactive', updated_at = CURRENT_TIMESTAMP
           WHERE id = ANY($1)
           RETURNING id`,
          [orphanIds]
        );
        stats.deactivated = deactivateResult.rowCount;
        await appendLog(pool, job.id,
          `Deactivated ${deactivateResult.rowCount} products not found in latest catalog ` +
          `(coverage: ${(ratio * 100).toFixed(0)}%, fetch: ${(fetchRatio * 100).toFixed(0)}%, ` +
          `${orphanIds.length} orphans out of ${activeResult.rows.length} active)`
        );
      } else if (orphanIds.length > 0) {
        const reasons = [];
        if (ratio < 0.5) reasons.push(`coverage ${(ratio * 100).toFixed(0)}% < 50%`);
        if (fetchRatio < 0.8) reasons.push(`detail fetch ${(fetchRatio * 100).toFixed(0)}% < 80% (${fetchedCount}/${allProducts.length})`);
        await appendLog(pool, job.id,
          `Skipping deactivation of ${orphanIds.length} orphans: ${reasons.join(', ')}`
        );
      }
    }

    // Promote first alternate to primary for any AZT SKUs with images but no primary
    const missingPrimary = await pool.query(`
      SELECT DISTINCT s.id as sku_id, s.product_id
      FROM skus s
      JOIN media_assets ma ON ma.sku_id = s.id
      WHERE s.internal_sku LIKE 'AZT-%'
      AND NOT EXISTS (
        SELECT 1 FROM media_assets m2 WHERE m2.sku_id = s.id AND m2.asset_type = 'primary'
      )
    `);
    if (missingPrimary.rows.length > 0) {
      let promoted = 0;
      for (const row of missingPrimary.rows) {
        const ok = await promoteToPrimary(pool, row.product_id, row.sku_id);
        if (ok) promoted++;
      }
      await appendLog(pool, job.id, `Promoted ${promoted}/${missingPrimary.rows.length} SKUs missing primary image`);
    }

    // ── Phase 5: Audit & fix primary images — demote lifestyle primaries ──
    await appendLog(pool, job.id, 'Phase 5: Auditing primary images...');
    const primaryRows = await pool.query(`
      SELECT ma.id as media_id, ma.url, ma.product_id, ma.sku_id,
             s.internal_sku, p.name as product_name, p.collection
      FROM media_assets ma
      JOIN skus s ON s.id = ma.sku_id
      JOIN products p ON p.id = ma.product_id
      WHERE s.internal_sku LIKE 'AZT-%'
        AND ma.asset_type = 'primary'
    `);

    const suspects = [];
    for (const row of primaryRows.rows) {
      if (isLifestyleUrl(row.url, row.product_name)) {
        suspects.push(row);
      }
    }

    if (suspects.length > 0) {
      await appendLog(pool, job.id,
        `Primary image audit: ${suspects.length}/${primaryRows.rows.length} have lifestyle primary — fixing...`
      );
      let fixed = 0, keptAsOnly = 0;
      for (const s of suspects) {
        // Check if there's a non-lifestyle alternate we can promote
        const alt = await pool.query(`
          SELECT id, url FROM media_assets
          WHERE sku_id = $1 AND asset_type IN ('alternate', 'lifestyle')
            AND id != $2
          ORDER BY sort_order
        `, [s.sku_id, s.media_id]);

        const goodAlt = alt.rows.find(r => !isLifestyleUrl(r.url, s.product_name));
        if (goodAlt) {
          // Swap asset_type AND sort_order. A single-statement swap still trips
          // the unique (product_id, sku_id, asset_type, sort_order) index —
          // Postgres checks it per-row mid-statement — so park the old primary
          // at an unused negative sort first, then move each row. One bad image
          // must not fail the whole job.
          try {
            const pair = await pool.query(
              'SELECT id, asset_type, sort_order FROM media_assets WHERE id IN ($1, $2)',
              [s.media_id, goodAlt.id]);
            const oldP = pair.rows.find(r => r.id === s.media_id);
            const newP = pair.rows.find(r => r.id === goodAlt.id);
            await pool.query('UPDATE media_assets SET sort_order = $2 WHERE id = $1',
              [s.media_id, -1000 - fixed]);
            await pool.query('UPDATE media_assets SET asset_type = $2, sort_order = $3 WHERE id = $1',
              [goodAlt.id, oldP.asset_type, oldP.sort_order]);
            await pool.query('UPDATE media_assets SET asset_type = $2, sort_order = $3 WHERE id = $1',
              [s.media_id, newP.asset_type, newP.sort_order]);
            fixed++;
          } catch (err) {
            await appendLog(pool, job.id, `Primary image swap failed for ${s.internal_sku}: ${err.message}`);
          }
        } else {
          // No product shot available — keep lifestyle as primary (better than nothing)
          keptAsOnly++;
        }
      }
      await appendLog(pool, job.id,
        `Primary image audit: fixed ${fixed}, kept ${keptAsOnly} (no product shot available)`
      );
    } else {
      await appendLog(pool, job.id, `Primary image audit: all ${primaryRows.rows.length} primaries are product shots`);
    }

    await appendLog(pool, job.id,
      `Scrape complete. Found: ${stats.found}, Created: ${stats.created}, ` +
      `Updated: ${stats.updated}, SKUs: ${stats.skusCreated}, ` +
      `Images: ${stats.imagesSet}, Deactivated: ${stats.deactivated}, ` +
      `Skipped: ${stats.skipped}, Errors: ${stats.errors}, ` +
      `PriceList hits: ${stats.priceListHits}, misses: ${stats.priceListMisses}`,
      {
        products_found: stats.found,
        products_created: stats.created,
        products_updated: stats.updated,
        skus_created: stats.skusCreated
      }
    );
  }
}

// ══════════════════════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════════════════════

/**
 * Promote the first alternate/lifestyle image to 'primary' for a SKU
 * that has images but no primary. Updates the record in-place.
 * Returns true if a promotion occurred.
 */
async function promoteToPrimary(pool, productId, skuId) {
  const result = await pool.query(`
    UPDATE media_assets SET asset_type = 'primary'
    WHERE id = (
      SELECT id FROM media_assets
      WHERE product_id = $1 AND sku_id = $2 AND asset_type IN ('alternate', 'lifestyle')
      ORDER BY sort_order LIMIT 1
    )
    RETURNING id
  `, [productId, skuId]);
  return result.rowCount > 0;
}

// ══════════════════════════════════════════════════════════════
// Parsers
// ══════════════════════════════════════════════════════════════

/**
 * Parse all data from a product detail page.
 * Returns a unified object matching the Elysium v3 pattern.
 */
function parseDetailPage(html) {
  // Merge table-based tech specs with regex-based; regex results take priority
  const tableTechSpecs = parseTechnicalSpecsTable(html);
  const regexTechSpecs = parseTechnicalSpecs(html);
  const technicalSpecs = { ...tableTechSpecs, ...regexTechSpecs };

  // Detect packaging PDF link (for future manual review)
  const pkgPdfMatch = html.match(/<a[^>]+href="([^"]+)"[^>]*>[\s\S]*?Thickness\s*(?:&amp;|&)\s*Packaging[\s\S]*?<\/a>/i);
  const packagingPdfUrl = pkgPdfMatch ? htmlDecode(pkgPdfMatch[1]) : null;

  const packaging = parsePackaging(html);
  if (packagingPdfUrl) {
    packaging.pdfUrl = packagingPdfUrl;
    if (Object.keys(packaging).length === 1) {
      // Only pdfUrl, no inline packaging data — log-worthy
      packaging._pdfOnly = true;
    }
  }

  return {
    specs: parseSpecs(html),
    technicalSpecs,
    packaging,
    pricing: parsePricing(html),
    gallery: parseGallery(html),
    variations: parseVariations(html),
    soldBy: parseSoldBy(html),
    stockStatus: parseStockStatus(html),
    swatchImages: parseSwatchImages(html),
  };
}

/**
 * Parse general specs from Product Details tab.
 * Format: <strong>Label:</strong><br />value
 */
function parseSpecs(html) {
  const specs = {};
  const specPatterns = [
    { regex: /<strong>Product Type:?<\/strong>(?:<br\s*\/?>)?\s*([^<]+)/i, key: 'type' },
    { regex: /<strong>Origin:?<\/strong>(?:<br\s*\/?>)?\s*([^<]+)/i, key: 'countryOfOrigin' },
    { regex: /<strong>Stocked Finish(?:es)?(?:\(es\))?:?<\/strong>(?:<br\s*\/?>)?\s*([^<]+)/i, key: 'finish' },
    { regex: /<strong>Stocked Sizes?:?<\/strong>(?:<br\s*\/?>)?\s*([^<]+)/i, key: 'size' },
    { regex: /<strong>Stocked Thickness:?<\/strong>(?:<br\s*\/?>)?\s*([^<]+)/i, key: 'thickness' },
    { regex: /<strong>Recommended Uses?:?<\/strong>(?:<br\s*\/?>)?\s*([^<]+)/i, key: 'application' },
    { regex: /<strong>Stocked Color(?:s|\/Finishes)?:?<\/strong>(?:<br\s*\/?>)?\s*([^<]+)/i, key: 'colors' },
    { regex: /<strong>Edge:?<\/strong>(?:<br\s*\/?>)?\s*([^<]+)/i, key: 'edge' },
    { regex: /<strong>Look:?<\/strong>(?:<br\s*\/?>)?\s*([^<]+)/i, key: 'look' },
    { regex: /<strong>Collection:?<\/strong>(?:<br\s*\/?>)?\s*([^<]+)/i, key: 'collection' },
  ];

  for (const { regex, key } of specPatterns) {
    const match = html.match(regex);
    if (match) specs[key] = htmlDecode(match[1].trim());
  }

  // Multi-line value extraction: some specs span multiple <br>-separated lines
  const multiLineKeys = [
    { regex: /<strong>Stocked Color(?:s|\/Finishes)?:?<\/strong>\s*([\s\S]*?)(?=<strong>|<\/div>|<\/p>)/i, key: 'colors' },
    { regex: /<strong>Stocked Finish(?:es)?(?:\(es\))?:?<\/strong>\s*([\s\S]*?)(?=<strong>|<\/div>|<\/p>)/i, key: 'finish' },
    { regex: /<strong>Stocked Sizes?:?<\/strong>\s*([\s\S]*?)(?=<strong>|<\/div>|<\/p>)/i, key: 'size' },
    { regex: /<strong>Stocked Thickness:?<\/strong>\s*([\s\S]*?)(?=<strong>|<\/div>|<\/p>)/i, key: 'thickness' },
    { regex: /<strong>Recommended Uses?:?<\/strong>\s*([\s\S]*?)(?=<strong>|<\/div>|<\/p>)/i, key: 'application' },
  ];
  for (const { regex, key } of multiLineKeys) {
    const match = html.match(regex);
    if (match) {
      const lines = match[1]
        .split(/<br\s*\/?>/)
        .map(l => htmlDecode(l.replace(/<[^>]+>/g, '').trim()))
        .filter(Boolean);
      if (lines.length > 1) {
        specs[key] = lines.join(', ');
      }
    }
  }

  return specs;
}

/**
 * Parse technical specs (PEI, DCOF, Water Absorption, etc.)
 * from the detail page. Arizona Tile uses the same <strong>Label:</strong> pattern.
 */
function parseTechnicalSpecs(html) {
  const tech = {};
  const techPatterns = [
    { regex: /<strong>PEI(?: Rating)?:?<\/strong>(?:<br\s*\/?>)?\s*([^<]+)/i, key: 'peiRating' },
    { regex: /<strong>Shade Variation:?<\/strong>(?:<br\s*\/?>)?\s*([^<]+)/i, key: 'shadeVariation' },
    { regex: /<strong>Water Absorption:?<\/strong>(?:<br\s*\/?>)?\s*([^<]+)/i, key: 'waterAbsorption' },
    { regex: /<strong>DCOF(?: Acutest)?:?<\/strong>(?:<br\s*\/?>)?\s*([^<]+)/i, key: 'dcof' },
    { regex: /<strong>MOHS:?<\/strong>(?:<br\s*\/?>)?\s*([^<]+)/i, key: 'mohs' },
    { regex: /<strong>Breaking Strength:?<\/strong>(?:<br\s*\/?>)?\s*([^<]+)/i, key: 'breakingStrength' },
    { regex: /<strong>Frost Resistant:?<\/strong>(?:<br\s*\/?>)?\s*([^<]+)/i, key: 'frostResistant' },
    { regex: /<strong>Abrasion Resistance:?<\/strong>(?:<br\s*\/?>)?\s*([^<]+)/i, key: 'abrasionResistance' },
    { regex: /<strong>Coefficient of Friction:?<\/strong>(?:<br\s*\/?>)?\s*([^<]+)/i, key: 'dcof' },
  ];

  for (const { regex, key } of techPatterns) {
    if (tech[key]) continue; // Don't overwrite (dcof has two patterns)
    const match = html.match(regex);
    if (match) tech[key] = htmlDecode(match[1].trim());
  }

  return tech;
}

/**
 * Parse technical specs from HTML <table> elements with "TECHNICAL CHARACTERISTICS" header.
 * New Arizona Tile format uses tables instead of <strong> label blocks for some products.
 * Extracts label (col 1) → value (last col, typically "TYPICAL VALUE") pairs.
 */
function parseTechnicalSpecsTable(html) {
  const tech = {};

  // Find table sections containing technical characteristics
  const tableMatch = html.match(/<table[^>]*>[\s\S]*?TECHNICAL\s+CHARACTERISTICS[\s\S]*?<\/table>/i);
  if (!tableMatch) return tech;

  const tableHtml = tableMatch[0];

  // Map of label patterns → tech spec keys
  const labelMap = [
    { pattern: /water\s+absorption/i, key: 'waterAbsorption' },
    { pattern: /dcof|dynamic\s+coefficient/i, key: 'dcof' },
    { pattern: /breaking\s+strength/i, key: 'breakingStrength' },
    { pattern: /frost\s+resist/i, key: 'frostResistant' },
    { pattern: /abrasion\s+resist/i, key: 'abrasionResistance' },
    { pattern: /\bpei\b/i, key: 'peiRating' },
    { pattern: /\bmohs\b/i, key: 'mohs' },
    { pattern: /shade\s+variation/i, key: 'shadeVariation' },
    { pattern: /staining\s+resist/i, key: 'stainingResistance' },
    { pattern: /thermal\s+shock/i, key: 'thermalShock' },
  ];

  // Extract rows: <tr>...<td>Label</td>...<td>Value</td>...</tr>
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;
  while ((rowMatch = rowRegex.exec(tableHtml)) !== null) {
    const cells = [];
    const cellRegex = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let cellMatch;
    while ((cellMatch = cellRegex.exec(rowMatch[1])) !== null) {
      cells.push(cellMatch[1].replace(/<[^>]+>/g, '').trim());
    }
    if (cells.length < 2) continue;

    const label = cells[0];
    const value = cells[cells.length - 1]; // Last column = typical value
    if (!label || !value) continue;

    for (const { pattern, key } of labelMap) {
      if (pattern.test(label) && !tech[key]) {
        tech[key] = htmlDecode(value);
        break;
      }
    }
  }

  return tech;
}

/**
 * Parse packaging info from the detail page.
 * Looks for patterns like "X pcs/box", "XX sf/box", "XX lbs/box", etc.
 */
function parsePackaging(html) {
  const pkg = {};

  const pcsMatch = html.match(/<strong>Pieces?\s*(?:Per|\/)\s*Box:?<\/strong>(?:<br\s*\/?>)?\s*([^<]+)/i)
    || html.match(/(\d+)\s*(?:pcs?|pieces?)\s*(?:per|\/)\s*box/i);
  if (pcsMatch) pkg.piecesPerBox = parseInt(pcsMatch[1]) || null;

  const sqftMatch = html.match(/<strong>(?:Sq\.?\s*Ft\.?|SF|Square Feet)\s*(?:Per|\/)\s*Box:?<\/strong>(?:<br\s*\/?>)?\s*([^<]+)/i)
    || html.match(/([\d.]+)\s*(?:sf|sq\.?\s*ft\.?)\s*(?:per|\/)\s*box/i);
  if (sqftMatch) pkg.sqftPerBox = parseFloat(sqftMatch[1]) || null;

  const weightMatch = html.match(/<strong>Weight\s*(?:Per|\/)\s*Box:?<\/strong>(?:<br\s*\/?>)?\s*([^<]+)/i)
    || html.match(/([\d.]+)\s*(?:lbs?\.?)\s*(?:per|\/)\s*box/i);
  if (weightMatch) pkg.weightPerBox = parseFloat(weightMatch[1].replace(/[^0-9.]/g, '')) || null;

  const bppMatch = html.match(/<strong>Boxes?\s*(?:Per|\/)\s*Pallet:?<\/strong>(?:<br\s*\/?>)?\s*([^<]+)/i)
    || html.match(/(\d+)\s*(?:boxes?)\s*(?:per|\/)\s*pallet/i);
  if (bppMatch) pkg.boxesPerPallet = parseInt(bppMatch[1]) || null;

  const sqftPalletMatch = html.match(/<strong>(?:Sq\.?\s*Ft\.?|SF)\s*(?:Per|\/)\s*Pallet:?<\/strong>(?:<br\s*\/?>)?\s*([^<]+)/i)
    || html.match(/([\d.,]+)\s*(?:sf|sq\.?\s*ft\.?)\s*(?:per|\/)\s*pallet/i);
  if (sqftPalletMatch) pkg.sqftPerPallet = parseFloat(sqftPalletMatch[1].replace(/,/g, '')) || null;

  const weightPalletMatch = html.match(/<strong>Weight\s*(?:Per|\/)\s*Pallet:?<\/strong>(?:<br\s*\/?>)?\s*([^<]+)/i)
    || html.match(/([\d.,]+)\s*(?:lbs?\.?)\s*(?:per|\/)\s*pallet/i);
  if (weightPalletMatch) pkg.weightPerPallet = parseFloat(weightPalletMatch[1].replace(/[^0-9.]/g, '')) || null;

  return pkg;
}

/**
 * Parse pricing from the detail page HTML.
 * WooCommerce puts price in <span class="woocommerce-Price-amount">.
 */
function parsePricing(html) {
  const result = { retailPrice: null, priceBasis: 'per_sqft' };

  // Cascading price extraction:
  // 1. WooCommerce price element (legacy pages)
  const priceMatch = html.match(/class="woocommerce-Price-amount[^"]*"[^>]*>[^$]*\$([\d,.]+)/);
  if (priceMatch) {
    result.retailPrice = parseFloat(priceMatch[1].replace(/,/g, '')) || null;
  }

  // 2. Extract display_price from data-product_variations JSON
  //    Some "simple" products are rendered as single-variation
  if (!result.retailPrice) {
    const varMatch = html.match(/data-product_variations="([^"]+)"/);
    if (varMatch) {
      try {
        let json = varMatch[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#039;/g, "'");
        const vars = JSON.parse(json);
        if (Array.isArray(vars) && vars.length > 0 && vars[0].display_price) {
          result.retailPrice = parseFloat(vars[0].display_price) || null;
        }
      } catch { /* ignore parse errors */ }
    }
  }

  // 3. JSON-LD structured data (application/ld+json)
  if (!result.retailPrice) {
    const ldMatch = html.match(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/i);
    if (ldMatch) {
      try {
        const ld = JSON.parse(ldMatch[1]);
        const offers = ld.offers || (Array.isArray(ld['@graph']) && ld['@graph'].find(g => g.offers))?.offers;
        if (offers) {
          const price = offers.price || offers.lowPrice || (Array.isArray(offers) && offers[0]?.price);
          if (price) result.retailPrice = parseFloat(price) || null;
        }
      } catch { /* ignore parse errors */ }
    }
  }

  // 4. data-price attribute on cart form elements
  if (!result.retailPrice) {
    const dataPriceMatch = html.match(/data-price="([\d.]+)"/);
    if (dataPriceMatch) {
      result.retailPrice = parseFloat(dataPriceMatch[1]) || null;
    }
  }

  if (!result.retailPrice) {
    // Log-worthy: simple product with no pricing found
    result._noPricing = true;
  }

  // Check for "per sqft" / "per piece" / "per box" indicator
  const basisMatch = html.match(/per\s+(sq\.?\s*ft\.?|piece|box|unit|square\s*foot)/i);
  if (basisMatch) {
    const raw = basisMatch[1].toLowerCase();
    if (raw.includes('box')) result.priceBasis = 'per_unit';
    else if (raw.includes('piece') || raw.includes('unit')) result.priceBasis = 'per_unit';
    else result.priceBasis = 'per_sqft';
  }

  return result;
}

/**
 * Parse sold-by from page content.
 */
function parseSoldBy(html) {
  const soldByMatch = html.match(/sold\s+(?:by\s+)?(?:the\s+)?(box|sq\.?\s*ft\.?|piece|square\s*foot|unit)/i);
  if (soldByMatch) {
    const raw = soldByMatch[1].toLowerCase();
    if (raw.includes('box')) return 'box';
    if (raw.includes('piece') || raw.includes('unit')) return 'unit';
    return 'box';
  }
  return null;
}

/**
 * Parse stock status from page HTML.
 */
function parseStockStatus(html) {
  if (/class=['"][^'"]*in-stock/i.test(html)) return 'In Stock';
  if (/class=['"][^'"]*out-of-stock/i.test(html)) return 'Out of Stock';
  if (/class=['"][^'"]*on-backorder/i.test(html)) return 'Backorder';
  return null;
}

/**
 * Parse gallery images from aztiles_product_gallery JS variable.
 * Format can be:
 *   - Array of arrays: [[{thumb, medium, zoom}, ...]]  (simple products)
 *   - Object with numeric keys: {"0": [{...},...], "8683": [{...},...]}  (variable products)
 *     Key "0" = shared/product-level images
 *     Other keys = WooCommerce variation_id → per-variant gallery images
 * Items have thumb/medium/zoom keys — prefer zoom (highest res), fallback to medium.
 * URLs contain &amp; HTML entities that need decoding.
 *
 * Returns { flat: [url, ...], shared: [url, ...], byVariationId: { 8683: [url, ...], ... } }
 * - flat: all images combined (used for simple products)
 * - shared: key "0" images (product-level, used when no per-variant images exist)
 * - byVariationId: keyed by WooCommerce variation_id (NOT sequential index)
 */
function parseGallery(html) {
  const match = html.match(/aztiles_product_gallery\s*=\s*(\{[\s\S]*?\}|\[[\s\S]*?\]);/);
  if (!match) return { flat: [], shared: [], byVariationId: {} };

  function extractUrls(items) {
    const urls = items
      .map(item => {
        if (typeof item === 'string') return item;
        if (typeof item === 'object' && item) {
          // Prefer zoom (highest res square crop), then medium, then full
          // Skip full if it's a .tif (400KB+ uncompressed)
          const full = item.full && !/\.tif(\?|$)/i.test(item.full) ? item.full : null;
          return item.zoom || item.medium || full || item.thumb || item.url || item.src || null;
        }
        return null;
      })
      .filter(Boolean)
      .map(u => reParamWidenUrl(u.replace(/&amp;/g, '&')));

    // Deduplicate by base filename
    const seen = new Set();
    const unique = [];
    for (const url of urls) {
      const base = url.split('?')[0];
      if (seen.has(base)) continue;
      seen.add(base);
      unique.push(url);
    }
    return unique.slice(0, MAX_GALLERY_IMAGES);
  }

  try {
    const raw = match[1].replace(/&amp;/g, '&');
    const gallery = JSON.parse(raw);

    const byVariationId = {};
    let shared = [];
    let allItems = [];

    if (Array.isArray(gallery)) {
      // [[{thumb,medium,zoom},...]] or [{thumb,medium,zoom},...]
      for (const entry of gallery) {
        if (Array.isArray(entry)) allItems.push(...entry);
        else allItems.push(entry);
      }
    } else if (typeof gallery === 'object') {
      // {"0": [{...},...], "8683": [{...},...]} — key 0 is shared, others are variation_ids
      for (const key of Object.keys(gallery)) {
        const arr = gallery[key];
        if (!Array.isArray(arr)) continue;
        allItems.push(...arr);
        if (key === '0') {
          shared = extractUrls(arr);
        } else {
          byVariationId[Number(key)] = extractUrls(arr);
        }
      }
    }

    return { flat: extractUrls(allItems), shared, byVariationId };
  } catch {
    return { flat: [], shared: [], byVariationId: {} };
  }
}

/**
 * Parse variations from data-product_variations attribute.
 * The JSON is double HTML-encoded on the page.
 */
function parseVariations(html) {
  const match = html.match(/data-product_variations="([^"]+)"/);
  if (!match) return [];

  try {
    let json = match[1];
    json = htmlDecode(json);
    json = htmlDecode(json);
    return JSON.parse(json);
  } catch {
    return [];
  }
}

/**
 * Upsert all spec + technical spec attributes for a SKU.
 */
async function upsertAllSpecAttributes(pool, skuId, specs, technicalSpecs, { skipFinish = false } = {}) {
  // General specs → attribute slugs
  // Note: 'colors' (Stocked Colors) is intentionally excluded — it lists all
  // colors in the collection, not the SKU's actual color.  The accurate color
  // comes from attribute_pa_color on each variation.
  const specMap = {
    type: 'material',
    countryOfOrigin: 'country',
    finish: 'finish',
    thickness: 'thickness',
    application: 'application',
    edge: 'edge',
    look: 'look',
  };
  for (const [specKey, attrSlug] of Object.entries(specMap)) {
    if (!specs[specKey]) continue;
    // "Stocked Finish(es)" has the same hazard as Stocked Colors: it lists every
    // finish in the collection (e.g. "Honed (H), Polished (P)"), not this SKU's
    // finish. Never overwrite a variation-supplied finish with it, and never
    // write a multi-finish list at all — only a single finish (markers stripped).
    if (attrSlug === 'finish') {
      if (skipFinish) continue;
      const single = specs[specKey].replace(/\s*\([A-Z]\)/g, '').trim();
      if (single.includes(',')) continue;
      await upsertSkuAttribute(pool, skuId, 'finish', single);
      continue;
    }
    await upsertSkuAttribute(pool, skuId, attrSlug, specs[specKey]);
  }

  // Technical specs → attribute slugs
  const techMap = {
    peiRating: 'pei_rating',
    shadeVariation: 'shade_variation',
    waterAbsorption: 'water_absorption',
    dcof: 'dcof',
    breakingStrength: 'breaking_strength',
    frostResistant: 'frost_resistant',
    abrasionResistance: 'abrasion_resistance',
    mohs: 'mohs',
    stainingResistance: 'staining_resistance',
    thermalShock: 'thermal_shock',
  };
  for (const [techKey, attrSlug] of Object.entries(techMap)) {
    if (technicalSpecs[techKey]) await upsertSkuAttribute(pool, skuId, attrSlug, technicalSpecs[techKey]);
  }
}

/**
 * Parse color swatch images from the detail page.
 * These are per-color product photos (e.g., "Aequa-Castor-12x48-variation.webp")
 * displayed as clickable color option buttons.
 *
 * Structure: <span class="...color-variation..." data-parent-id="pa_color" data-value="castor" ...>
 *              <i><img src="..." alt="Castor"></i>
 *            </span>
 *
 * Returns Map<colorSlug, imageUrl>
 */
function parseSwatchImages(html) {
  const swatches = new Map();
  // Match color-variation spans with data-parent-id="pa_color" and data-value, then find inner img src
  const regex = /data-parent-id="pa_color"[^>]*data-value="([^"]+)"[^>]*>[\s\S]*?<img[^>]+src="([^"]+)"/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    const colorSlug = match[1].trim();
    const url = htmlDecode(match[2]);
    if (url && colorSlug && !url.includes('placeholder') && !url.includes('Line-Art')) {
      swatches.set(colorSlug, url);
    }
  }
  // Also try reverse attribute order: data-value before data-parent-id
  const regex2 = /data-value="([^"]+)"[^>]*data-parent-id="pa_color"[^>]*>[\s\S]*?<img[^>]+src="([^"]+)"/gi;
  while ((match = regex2.exec(html)) !== null) {
    const colorSlug = match[1].trim();
    const url = htmlDecode(match[2]);
    if (url && colorSlug && !swatches.has(colorSlug) && !url.includes('placeholder') && !url.includes('Line-Art')) {
      swatches.set(colorSlug, url);
    }
  }
  return swatches;
}

/**
 * Decode HTML entities (named and numeric).
 */
function htmlDecode(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

/**
 * Clean attribute value slug (e.g., "matte-finish" → "Matte Finish").
 * Uses deslugify for proper fraction handling.
 */
function cleanAttrValue(slug) {
  return deslugify(slug);
}

/**
 * Strip HTML tags from a string.
 */
function stripTags(str) {
  return htmlDecode(str.replace(/<[^>]+>/g, ''));
}
