/**
 * Mélange Boutique Tile — Image Enrichment Scraper
 *
 * Products already imported from PDF price list (scripts/import-melange.js).
 * This scraper visits melangetile.com, onetile.us/it, and emilgroup.it to
 * capture product images and associate them with existing DB products.
 *
 * Multi-source flow:
 *   Phase 1. melangetile.com product detail pages → carousel <a href> gallery images
 *            Alt text on carousel links provides color/size/finish for matching.
 *   Phase 2. onetile.it/us + emilgroup.it → finish-specific manufacturer images
 *   Phase 3. Priority waterfall assignment per SKU:
 *            gallery close-up (exact) > gallery close-up (color) >
 *            manufacturer override > manufacturer catalog > room scene > banner
 *
 * Usage: docker compose exec api node scrapers/melange.js
 */

import pg from 'pg';
import {
  launchBrowser, delay, collectSiteWideImages, extractLargeImages,
  filterImageUrls, upsertMediaAsset,
} from './base.js';

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: 5432,
  database: 'flooring_pim',
  user: 'postgres',
  password: 'postgres',
});

const BASE_URL = 'https://www.melangetile.com';

// Map COLLECTION names to product detail page URLs.
// Product detail pages have carousel galleries with <a href> linking to full-size images.
const PRODUCT_DETAIL_MAP = {
  'Block':                    ['/block-series'],
  "Ca'Foscari":               ['/CaFoscarSeries'],
  'Caprice':                  ['/CapriceCollection'],
  'Concrete Soul Infinity':   ['/concretoinfinitytile'],
  'Decoro':                   ['/Decoro_10x10_Porcelain_Tile'],
  'Evolution':                ['/evolution_series_4x16_polished_ceramic_wall_tile_grey_white'],
  'Factory':                  ['/Factory'],
  'Kauri':                    ['/kauri_series_8x48_wood_plank_porcelain_tile_natural_blue_grey_flooring'],
  'Memory':                   ['/memory_series_10x30_ceramic_wall_tile_gris_blanco_decor_mix_plata'],
  'Moonlit':                  ['/moonlit-porcelain-supergres'],
  'Nirvana':                  ['/Nirvana_Collection_Woodlook_Porcelain_Tile'],
  'Pearl':                    ['/PearlTile'],
  'Portland Stone':           ['/crosscutportlandstone', '/veincutportlandstone'],
  'Quartz Outdoor':           ['/QuartzOutdoorTile'],
  'Real Stone Travertino':    ['/realstone_tarvertino_cross_cut_ragno', '/realstone_travertino_vein_cut_ragno', '/realstone_travertino_3d_struttura_ragno'],
  'Shellstone':               ['/shellstone'],
  'Sicily':                   ['/Sicily_Tile_Flooring'],
  'Sixty 60 Silktech':       ['/60-sixty-silktech_emil'],
  'Snow':                     ['/SnowSeries'],
  'Stonetalk':                ['/STONETALK-Minimal-_p_80.html', '/STONETALK-Martellata-_p_81.html', '/STONETALK-Rullata-_p_82.html'],
  'Sublime':                  ['/sublimeseries'],
  'Sunstone':                 ['/SunstoneTile'],
  'Tele di Marmo':            ['/teledimarmo'],
  'Unique Bourgogne':         ['/uniquebourgogne'],
  'Unique Infinity':          ['/provenza-unique-infinity-arcade', '/provenza-unique-infinity-cobblestone'],
  'Woodbreak':                ['/woodbreak'],
};


// ── Manufacturer catalog maps ──────────────────────────────────────────

/** onetile.us/it — disabled: site restructured, old aspx URLs return soft 404s.
 *  Kept as reference for future re-mapping if onetile publishes new product pages. */
const ONETILE_MAP = {};

/** onetile.it — verified color+finish product images for Sixty.
 *  The onetile.it collection page only shows 4 of 11 colors on initial load
 *  (ASP.NET postback hides the rest), but the image URLs are deterministic.
 *  These were manually verified as 200 OK and provide high-quality close-ups
 *  for each color+finish combo that the generic melangetile category images miss.
 *  Melange calls it "Nero" but onetile calls it "Nero Assoluto". */
const SIXTY_IMAGE_OVERRIDES = [
  // ── Base tile (silk surface close-ups) — per-color, per-size ──
  // 30x60 (12x24in) variants:
  'https://www.onetile.it/public/webp/sixty-antracite-30x60-9-5-silk-1589780.webp',
  'https://www.onetile.it/public/webp/sixty-cielo-30x60-9-5-silk-1589787.webp',
  'https://www.onetile.it/public/webp/sixty-salvia-30x60-9-5-silk-1589796.webp',
  'https://www.onetile.it/public/webp/sixty-talco-30x60-9-5-silk-1589799.webp',
  // 60x120 (24x48in) variants:
  'https://www.onetile.it/public/webp/sixty-antracite-60x120-9-5-silk-1589843.webp',
  // Cenere base tile (from domita.it — no onetile.it size variants)
  'https://media.domita.it/uploads/domita/1/site/1000/3/z/3z__36707__cenere_1.jpg',
  // ── Timbro (textured surface) — per-color, per-size ──
  // 60x120 (24x48in) variants:
  'https://www.onetile.it/public/webp/sixty-antracite-timbro-60x120-9-5-silk-1589864.webp',
  'https://www.onetile.it/public/webp/sixty-cenere-timbro-60x120-9-5-silk-1589867.webp',
  'https://www.onetile.it/public/webp/sixty-cielo-timbro-60x120-9-5-silk-1589871.webp',
  'https://www.onetile.it/public/webp/sixty-salvia-timbro-60x120-9-5-silk-1589879.webp',
  'https://www.onetile.it/public/webp/sixty-talco-timbro-60x120-9-5-silk-1589882.webp',
  // 30x60 (12x24in) variants:
  'https://www.onetile.it/public/webp/sixty-antracite-timbro-30x60-9-5-silk-1589801.webp',
  // Nero Timbro does not exist on onetile — no base tiles for Nero Assoluto
  // ── Minibrick Matt — all 6 Melange colors ──
  'https://www.onetile.it/public/webp/sixty-minibrick-antracite-5x15-9-5-matt-1589663.webp',
  'https://www.onetile.it/public/webp/sixty-minibrick-cenere-5x15-9-5-matt-1589666.webp',
  'https://www.onetile.it/public/webp/sixty-minibrick-cielo-5x15-9-5-matt-1589669.webp',
  'https://www.onetile.it/public/webp/sixty-minibrick-nero-assoluto-5x15-9-5-matt-1589675.webp',
  'https://www.onetile.it/public/webp/sixty-minibrick-salvia-5x15-9-5-matt-1589682.webp',
  'https://www.onetile.it/public/webp/sixty-minibrick-talco-5x15-9-5-matt-1589684.webp',
  // ── Minibrick Lux — all colors (except Nero) ──
  'https://www.onetile.it/public/webp/sixty-minibrick-cenere-5x15-9-5-lux-1589642.webp',
  'https://www.onetile.it/public/webp/sixty-minibrick-cielo-5x15-9-5-lux-1589645.webp',
  'https://www.onetile.it/public/webp/sixty-minibrick-salvia-5x15-9-5-lux-1589657.webp',
  'https://www.onetile.it/public/webp/sixty-minibrick-talco-5x15-9-5-lux-1589661.webp',
  // ── Minibrick Timbro — nero only (no timbro minibrick images exist for other colors) ──
  'https://www.onetile.it/public/webp/sixty-minibrick-nero-assoluto-timbro-5x15-9-5-matt-1589699.webp',
  // ── Mosaico — all 6 Melange colors (except Nero) ──
  'https://www.onetile.it/public/webp/sixty-mosaico-antracite-30x30-9-5-silk-1589933.webp',
  'https://www.onetile.it/public/webp/sixty-mosaico-cenere-30x30-9-5-silk-1589936.webp',
  'https://www.onetile.it/public/webp/sixty-mosaico-cielo-30x30-9-5-silk-1589940.webp',
  'https://www.onetile.it/public/webp/sixty-mosaico-salvia-30x30-9-5-silk-1589949.webp',
  'https://www.onetile.it/public/webp/sixty-mosaico-talco-30x30-9-5-silk-1589952.webp',
  // ── Battiscopa / Bullnose — all 6 Melange colors (except Nero) ──
  'https://www.onetile.it/public/webp/sixty-battiscopa-antracite-7x60-9-5-silk-1600663.webp',
  'https://www.onetile.it/public/webp/sixty-battiscopa-cenere-7x60-9-5-silk-1600666.webp',
  'https://www.onetile.it/public/webp/sixty-battiscopa-cielo-7x60-9-5-silk-1600670.webp',
  'https://www.onetile.it/public/webp/sixty-battiscopa-salvia-7x60-9-5-silk-1600679.webp',
  'https://www.onetile.it/public/webp/sixty-battiscopa-talco-7x60-9-5-silk-1600682.webp',
  // Nero Battiscopa does not exist on onetile
  // ── Esagona / Hex — from landoftile CDN (opaque filenames, need URL_PATTERN_HINTS) ──
  'https://storage.landoftile.com/images-tile34/big_sixty_103676.webp', // antracite
  'https://storage.landoftile.com/images-tile34/big_sixty_103677.webp', // cenere
  'https://storage.landoftile.com/images-tile34/big_sixty_103678.webp', // cielo
  'https://storage.landoftile.com/images-tile34/big_sixty_103680.webp', // nero
  'https://storage.landoftile.com/images-tile34/big_sixty_103682.webp', // salvia
  'https://storage.landoftile.com/images-tile34/big_sixty_103683.webp', // talco
  // ── Esagona Timbro / Hex Timbro — from landoftile CDN ──
  'https://storage.landoftile.com/images-tile40/big_sixty_122753.webp', // antracite
  'https://storage.landoftile.com/images-tile40/big_sixty_122754.webp', // cenere
  'https://storage.landoftile.com/images-tile40/big_sixty_122755.webp', // cielo
  'https://storage.landoftile.com/images-tile40/big_sixty_122757.webp', // nero
  'https://storage.landoftile.com/images-tile40/big_sixty_122759.webp', // salvia
  'https://storage.landoftile.com/images-tile40/big_sixty_122760.webp', // talco
];

/** Woodbreak full-plank product images (800x800) from onetile.us.
 *  The default swatch images (ID+1) are 300x300 zoomed-in texture crops.
 *  These (ID-1) show the full plank on white background — much better for product cards. */
const WOODBREAK_IMAGE_OVERRIDES = [
  'https://www.onetile.us/public/webp/woodbreak-cherry-20x120-9-matt-2011433.webp',
  'https://www.onetile.us/public/webp/woodbreak-ebony-20x120-9-matt-2011439.webp',
  'https://www.onetile.us/public/webp/woodbreak-hemlock-20x120-9-matt-2011445.webp',
  'https://www.onetile.us/public/webp/woodbreak-larch-20x120-9-matt-2011451.webp',
  'https://www.onetile.us/public/webp/woodbreak-mahogany-20x120-9-matt-2011457.webp',
  'https://www.onetile.us/public/webp/woodbreak-oak-20x120-9-matt-2011463.webp',
];

/** Images known to have text overlays — deprioritized for primary, OK as lifestyle.
 *  These are filenames (substrings) that match images with embedded text like
 *  collection names, color labels, or branding. */
const TEXT_OVERLAY_FILENAMES = [
  'capriceblockbw1up',       // "BLOCK B&W" text label at bottom
  'sunstone-thumb',           // "SUNSTONE STONE" text overlay on room scene
  'decoro-bnr',               // "DECORO" large white text banner
  'sixty-main-cat',           // "60 SIXTY" logo overlay
  '-product-shot1',           // Concrete Soul Infinity: "COLOR" + "Wax/Natural Finish" labels
];

/** Check if an image URL has a known text overlay. */
function hasTextOverlay(url) {
  if (!url) return false;
  const lower = url.toLowerCase();
  return TEXT_OVERLAY_FILENAMES.some(pat => lower.includes(pat));
}

/** Gallery supplements — images that exist on melangetile.com but aren't linked
 *  on the gallery page carousel. Added to the Phase 1 image pool. */
const GALLERY_SUPPLEMENTS = {
  'Sunstone': [
    { url: 'https://www.melangetile.com/assets/images/sunstone-alof.jpg', altText: 'Alof' },
  ],
};

/** Direct primary image overrides — bypass gallery matching for products whose
 *  images have filenames that don't match the product name (e.g. "Decora" images
 *  for "Mediterranea" products). Map: collection → { productName → imageURL }. */
/** Direct primary image overrides — bypass gallery matching for products whose
 *  images have filenames that don't match the product name (e.g. "Decora" images
 *  for "Mediterranea" products), or for SKUs where no specific product close-up
 *  exists and the best fallback must be explicitly chosen.
 *
 *  Supports two map formats:
 *    collection → { productName → imageURL }           (for color-level overrides)
 *    collection → { productName → { finish → imageURL } }  (for finish-level overrides)
 */
const DIRECT_PRIMARY_OVERRIDES = {
  'Caprice': {
    // "Block" only has 2 images: "bwrs" (room scene) and "bw1up" (product shot with text label).
    // The product shot is the better primary despite the text overlay.
    'Block': 'https://www.melangetile.com/assets/images/capriceblockbw1up.jpg',
  },
  'Evolution': {
    // Blanco Brillo Quarter Round has no specific image; use the base tile close-up
    'Blanco Brillo': {
      'quarter round': 'https://www.melangetile.com/assets/images/Evolution/evolution-blanco-brillo-4x16-wall-tile.jpg',
    },
  },
  'Sixty 60 Silktech': {
    // No Nero base tile or bullnose exists on onetile.it or melangetile.com.
    // Use the emilgroup.it Nero Assoluto base silk close-up (right color, no form).
    'Nero': {
      'bullnose lux': 'https://www.emilgroup.it/emil/prodotti/immaginiarticoli_emil/Sixty_Nero%20Assoluto_30x60_9%2C5_Silk.jpg',
      'bullnose matt': 'https://www.emilgroup.it/emil/prodotti/immaginiarticoli_emil/Sixty_Nero%20Assoluto_30x60_9%2C5_Silk.jpg',
    },
  },
  'Decoro': {
    'Marble & Wood #1': 'https://www.melangetile.com/assets/images/Marble-and-Wood-1-1-up.jpg',
    'Marble & Wood #2': 'https://www.melangetile.com/assets/images/Marble-and-Wood-2-1-up.jpg',
    'Marble & Wood #3': 'https://www.melangetile.com/assets/images/Marble-and-Wood-3-1-up.jpg',
    'Marble & Wood #4': 'https://www.melangetile.com/assets/images/Marble-and-Wood-4-1-up.jpg',
    'Marble & Wood #5': 'https://www.melangetile.com/assets/images/Marble-and-Wood-5-1-up.jpg',
    'Mediterranea #1': 'https://www.melangetile.com/assets/images/mediterranea/decora-1-1up.jpg',
    'Mediterranea #2': 'https://www.melangetile.com/assets/images/Decora-2-1up.jpg',
    'Mediterranea #3': 'https://www.melangetile.com/assets/images/Decora-3-1up.jpg',
    'Mediterranea #4': 'https://www.melangetile.com/assets/images/Decora-4-1up.jpg',
    'Mediterranea #5': 'https://www.melangetile.com/assets/images/Decora-5-1up.jpg',
  },
  'Unique Infinity': {
    // Puerstone finish: no images on melangetile.com (no Puerstone sub-page exists).
    // Product close-ups sourced from emilgroup.it (Provenza manufacturer catalog).
    'Beige': {
      'puerstone': 'https://www.emilgroup.it/emil/prodotti/immaginiarticoli_emil/EMKM%20INFINITY_BEIGE%20PURESTONE%2060X120_01.jpg',
      'puerstone mosaico': 'https://www.emilgroup.it/emil/prodotti/immaginiarticoli_emil/EMKM%20INFINITY_BEIGE%20PURESTONE%2060X120_01.jpg',
    },
    'Black': {
      'puerstone': 'https://www.emilgroup.it/emil/prodotti/immaginiarticoli_emil/EMKJ%20INFINITY_BLACK%20PURESTONE%2060X120_01.jpg',
      'puerstone mosaico': 'https://www.emilgroup.it/emil/prodotti/immaginiarticoli_emil/EMKJ%20INFINITY_BLACK%20PURESTONE%2060X120_01.jpg',
    },
    'Grey': {
      'puerstone': 'https://www.emilgroup.it/emil/prodotti/immaginiarticoli_emil/EMKK%20INFINITY_GRAY%20PURESTONE%2060X120_01.jpg',
      'puerstone mosaico': 'https://www.emilgroup.it/emil/prodotti/immaginiarticoli_emil/EMKK%20INFINITY_GRAY%20PURESTONE%2060X120_01.jpg',
    },
    'White': {
      'puerstone': 'https://www.emilgroup.it/emil/prodotti/immaginiarticoli_emil/EMKL%20INFINITY_WHITE%20PURESTONE%2060X120_01.jpg',
      'puerstone mosaico': 'https://www.emilgroup.it/emil/prodotti/immaginiarticoli_emil/EMKL%20INFINITY_WHITE%20PURESTONE%2060X120_01.jpg',
    },
  },
};

/** emilgroup.it catalog pages — finish-specific product images.
 *  Sixty is EmilCeramica; Stone Talk + Portland Stone are Ergon brand.
 *  Collection pages show ALL finish variants (Minimal, Rullata, Mosaico, etc.) with
 *  descriptive filenames like "98G78R_Stone Talk_Minimal_Grey_60x120_1.jpg". */
const EMILGROUP_MAP = {
  'Sixty 60 Silktech':      [
    'https://www.emilgroup.it/collezioni/brand/emilceramica/sixty/',
    'https://www.emilgroup.it/collezioni/piastrelle/emilceramica-sixty/',
  ],
  'Stonetalk':               [
    'https://www.emilgroup.it/collezioni/piastrelle/ergon-stone-talk/',
    'https://www.emilgroup.it/collezioni/brand/ergon/stone-talk/',
  ],
  'Portland Stone':          [
    'https://www.emilgroup.it/collezioni/brand/ergon/portland-stone/',
    'https://www.emilgroup.it/collezioni/piastrelle/ergon-portland-stone/',
  ],
  'Tele di Marmo':           [
    'https://www.emilgroup.it/collezioni/brand/emilceramica/tele-di-marmo-selection/',
    'https://www.emilgroup.it/collezioni/piastrelle/emilceramica-tele-di-marmo-selection/',
  ],
};

// ── Finish synonyms for multilingual scoring ───────────────────────────

const FINISH_SYNONYMS = {
  'bullnose':    ['bullnose', 'battiscopa', 'bn', 'bordo'],
  'mosaico':     ['mosaico', 'mosaic', 'mos', 'tessera'],
  'dado':        ['dado'],
  'sfalsati':    ['sfalsati', 'staggered'],
  'hex':         ['hex', 'esagona', 'hexagon', 'hexagonal'],
  'minibrick':   ['minibrick', 'mini', 'listello', 'brick', 'muretto'],
  'quarterround': ['quarterround', 'quarter', 'cornerround', 'corner'],
  'torello':     ['torello', 'liner'],
  'ogee':        ['ogee'],
  'timbro':      ['timbro', 'strutturato', 'textured', 'strutt'],
  'polished':    ['polished', 'lappato', 'lapato', 'lucido', 'lux', 'lap', 'brillo'],
  'natural':     ['natural', 'naturale', 'nat'],
  'matt':        ['matt', 'matte'],
  'carpet':      ['carpet', 'decor', 'deco', 'pattern'],
  'mix':         ['mix', 'mixed', 'random', 'variee'],
  'wax':         ['wax', 'cera', 'cerato'],
  'veincut':     ['veincut', 'vein', 'venatura', 'vien'],
  'crosscut':    ['crosscut', 'cross', 'trasversale'],
  'bocciardato': ['bocciardato', 'bush', 'hammered'],
  'silktech':    ['silktech', 'silk', 'seta'],
  'grid':        ['grid', 'griglia', 'decor'],
  'intrecci':    ['intrecci', 'braid', 'weave'],
  'struttura':   ['struttura', 'structure', '3d'],
  'minimal':     ['minimal', 'minimale'],
  'rullata':     ['rullata', 'rolled'],
  'martellata':  ['martellata', 'hammered', 'chiseled'],
  'decoro':      ['decoro', 'decor', 'decorato'],
  'cobblestone': ['cobblestone', 'cobble'],
  'puerstone':   ['puerstone', 'purestone'],
};


// ── Form vs Surface finish classification ─────────────────────────────
// Form finishes describe the PRODUCT SHAPE (bullnose, hex, minibrick, mosaico).
// Surface finishes describe the SURFACE TREATMENT (matt, timbro, silktech, polished).
// When matching images to SKUs, form MUST match; surface is a tiebreaker.

const FORM_FINISH_KEYS = new Set([
  'bullnose', 'mosaico', 'hex', 'minibrick', 'carpet', 'decoro',
  'grid', 'intrecci', 'cobblestone', 'puerstone',
  'quarterround', 'torello', 'ogee', 'dado', 'sfalsati',
]);

/**
 * Classify finish tokens into form (shape) and surface (treatment) components.
 * Uses FINISH_SYNONYMS to expand each token, then checks FORM_FINISH_KEYS.
 *
 * Examples:
 *   "bullnose matt"     → { forms: ['bullnose'], surfaces: ['matt'] }
 *   "hex timbro"        → { forms: ['hex'], surfaces: ['timbro'] }
 *   "minibrick timbro"  → { forms: ['minibrick'], surfaces: ['timbro'] }
 *   "timbro"            → { forms: [], surfaces: ['timbro'] }
 *   "mosaico"           → { forms: ['mosaico'], surfaces: [] }
 *   "natural rectified" → { forms: [], surfaces: [] }
 *
 * @param {string} text - Finish string (from variant name, alt text, or filename)
 * @returns {{ forms: string[], surfaces: string[], formSyns: Set<string>, surfaceSyns: Set<string> }}
 */
function detectFinishComponents(text) {
  const result = { forms: [], surfaces: [], formSyns: new Set(), surfaceSyns: new Set() };
  if (!text) return result;

  // Strip file extension before tokenizing (e.g. "mosaico.jpg" → "mosaico")
  const cleaned = decodeURIComponent(text).replace(/\.\w{2,4}$/i, '').toLowerCase();
  const words = cleaned.split(/[\s,_-]+/).filter(Boolean);
  const SKIP_WORDS = new Set(['cut', 'the', 'and', 'for', 'di', 'rectified', 'rect', 'ps']);

  for (const word of words) {
    if (SKIP_WORDS.has(word)) continue;

    // Find which canonical finish key this word belongs to
    let canonicalKey = null;
    if (FINISH_SYNONYMS[word]) {
      canonicalKey = word;
    } else {
      for (const [key, syns] of Object.entries(FINISH_SYNONYMS)) {
        if (syns.includes(word)) { canonicalKey = key; break; }
      }
    }
    if (!canonicalKey) continue;

    const allSyns = FINISH_SYNONYMS[canonicalKey] || [canonicalKey];
    const synSet = new Set([canonicalKey, ...allSyns].map(s => normalize(s)));

    if (FORM_FINISH_KEYS.has(canonicalKey)) {
      result.forms.push(canonicalKey);
      for (const s of synSet) result.formSyns.add(s);
    } else {
      result.surfaces.push(canonicalKey);
      for (const s of synSet) result.surfaceSyns.add(s);
    }
  }

  return result;
}

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Unwrap melangetile.com thumbnail.asp wrapper URLs to direct image paths.
 * These ASP wrappers return 403 when fetched server-side.
 * "https://www.melangetile.com/assets/images/thumbnail.asp?file=assets/images/Block-Iron-30x30.jpg&maxx=500&maxy=0"
 *   → "https://www.melangetile.com/assets/images/Block-Iron-30x30.jpg"
 */
function unwrapThumbnailUrl(url) {
  if (!url || !url.includes('thumbnail.asp')) return url;
  const fileMatch = url.match(/[?&]file=([^&]+)/);
  if (!fileMatch) return url;
  const filePath = decodeURIComponent(fileMatch[1]);
  return `https://www.melangetile.com/${filePath}`;
}

/**
 * Unwrap emilgroup.it Next.js image optimization URLs to direct image paths.
 * "_next/image/?url=https%3A%2F%2Fwww.emilgroup.it%2Fmedia%2F...jpg"
 *   → "https://www.emilgroup.it/media/...jpg"
 */
function unwrapNextImageUrl(url) {
  if (!url || !url.includes('/_next/image')) return url;
  const urlMatch = url.match(/[?&]url=([^&]+)/);
  if (!urlMatch) return url;
  return decodeURIComponent(urlMatch[1]);
}

/**
 * Apply all URL unwrapping passes: thumbnail.asp + Next.js _next/image.
 */
function unwrapImageUrl(url) {
  url = unwrapThumbnailUrl(url);
  url = unwrapNextImageUrl(url);
  return url;
}

/** Normalize a string for fuzzy matching: lowercase, strip separators. */
function normalize(str) {
  return decodeURIComponent(str).toLowerCase().replace(/[-_\s]+/g, '');
}

/** Extract filename from URL (last path segment, no query string). */
function getFilename(url) {
  try { return new URL(url).pathname.split('/').pop() || ''; }
  catch { return url.split('/').pop().split('?')[0] || ''; }
}

/**
 * URL → pattern hint map for manufacturer images with opaque filenames (product codes).
 * Maps partial URL substrings to a virtual "filename" used by the scoring algorithm.
 */
const URL_PATTERN_HINTS = {
  'EML8': 'arcade_black',
  'EML9': 'arcade_grey',
  'EMLK': 'arcade_white',
  'EMN0': 'arcade_white',
  'EML6': 'arcade_beige',
  'a_beige': 'arcade_beige',
  'a_white': 'arcade_white',
  // landoftile esagona (hex) — opaque filenames need color+finish hints
  'big_sixty_103676': 'sixty_esagona_antracite',
  'big_sixty_103677': 'sixty_esagona_cenere',
  'big_sixty_103678': 'sixty_esagona_cielo',
  'big_sixty_103680': 'sixty_esagona_nero',
  'big_sixty_103682': 'sixty_esagona_salvia',
  'big_sixty_103683': 'sixty_esagona_talco',
  // onetile.it Sixty Antracite — cm→in size hints for correct size matching
  // Without these, 30x60cm and 60x120cm never match 12x24in / 24x48in SKU sizes
  'antracite-30x60-9-5-silk-1589780': 'sixty_antracite_silk_12x24',
  'antracite-60x120-9-5-silk-1589843': 'sixty_antracite_silk_24x48',
  'antracite-timbro-30x60-9-5-silk-1589801': 'sixty_antracite_timbro_12x24',
  'antracite-timbro-60x120-9-5-silk-1589864': 'sixty_antracite_timbro_24x48',
  // landoftile esagona timbro (hex timbro)
  'big_sixty_122753': 'sixty_esagona_timbro_antracite',
  'big_sixty_122754': 'sixty_esagona_timbro_cenere',
  'big_sixty_122755': 'sixty_esagona_timbro_cielo',
  'big_sixty_122757': 'sixty_esagona_timbro_nero',
  'big_sixty_122759': 'sixty_esagona_timbro_salvia',
  'big_sixty_122760': 'sixty_esagona_timbro_talco',
};

/** Italian/Spanish name variants and vendor typo corrections for fuzzy color matching. */
const COLOR_ALIASES = {
  'bianco': ['bianca', 'blanco'],
  'grigio': ['griggio', 'gris'],
  'grey': ['gray'],
  'gray': ['grey'],
  'darkgrey': ['darkgray'],
  'darkgray': ['darkgrey'],
  'noir': ['noire', 'nero'],
  'nero': ['neroassoluto', 'nero-assoluto'],
  'antheracite': ['anthracite', 'antracite', 'anthrazit'],
  'anthracite': ['antheracite', 'antracite', 'anthrazit'],
  'antracite': ['anthracite', 'antheracite', 'anthrazit'],
  // Vendor typos on melangetile.com and emilgroup.it
  'greige': ['griege', 'grège'],
  'tasman': ['tazman'],
  'tabacco': ['tobacco'],
  'neromarquina': ['neromarguinia', 'neromarquinia'],
  'arabescatocorochia': ['arabescatocorchia', 'arabescattocorchia', 'arabescatocorshia'],
};

/** Match an image URL to a color name. Returns matched color or null.
 *  Also checks URL_PATTERN_HINTS for opaque filenames (e.g. landoftile CDN).
 *  For multi-word color names (e.g. "Beige Minimal"), also tries individual words
 *  after stripping finish keywords. */
function matchImageToColor(imageUrl, colorNames) {
  const filename = normalize(getFilename(imageUrl));
  // Build effective string with hint for opaque filenames
  const hint = Object.entries(URL_PATTERN_HINTS).find(([k]) => imageUrl.includes(k));
  const effective = hint ? normalize(hint[1]) + ' ' + filename : filename;
  const sorted = [...colorNames].sort((a, b) => b.length - a.length);
  // Pass 1: exact full-name match (e.g. "darkgrey" in filename)
  for (const color of sorted) {
    const baseColor = color.replace(/\s*#\d+$/, '');
    const normColor = normalize(baseColor);
    if (normColor.length <= 2) continue;
    if (effective.includes(normColor)) return color;
    const aliases = COLOR_ALIASES[normColor] || [];
    for (const alias of aliases) {
      if (effective.includes(alias)) return color;
    }
  }
  // Pass 2: for multi-word color names, try individual words after stripping finish keywords.
  // Handles cases like "Beige Minimal" where filename is "Minimal---Beige.jpg" (reversed order)
  // or "Variee- Beige.jpeg" (partial). Returns the BASE color word (e.g., "beige") so that
  // colorGallery matching works for ALL products sharing that base color.
  const allFinishWords = new Set();
  for (const [key, syns] of Object.entries(FINISH_SYNONYMS)) {
    allFinishWords.add(key);
    for (const s of syns) allFinishWords.add(s);
  }
  for (const color of sorted) {
    const baseColor = color.replace(/\s*#\d+$/, '');
    const words = baseColor.split(/\s+/);
    if (words.length < 2) continue;
    // Extract only the non-finish words as the "base color"
    const colorOnlyWords = words.filter(w => !allFinishWords.has(w.toLowerCase()));
    if (colorOnlyWords.length === 0) continue;
    for (const word of colorOnlyWords) {
      const normWord = normalize(word);
      if (normWord.length < 3) continue;
      if (effective.includes(normWord)) return color;
      const aliases = COLOR_ALIASES[normWord] || [];
      for (const alias of aliases) {
        if (effective.includes(alias)) return color;
      }
    }
  }
  return null;
}

/**
 * Extract the finish portion from a variant_name.
 * "Beige, 24x48, Timbro" → "timbro"
 * "Dark Grey, 12x24, Mosaico Hex" → "mosaico hex"
 * "White, 24x48" → null (no finish, just size)
 */
function getFinishFromVariant(variantName) {
  if (!variantName) return null;
  const parts = variantName.split(',').map(p => p.trim());
  // Skip first part (color) and size-only parts (contain "x" digit pattern)
  const finishParts = parts.slice(1).filter(p => !/^\d+(\.\d+)?x\d+/i.test(p));
  if (finishParts.length === 0) return null;
  return finishParts.join(' ').toLowerCase();
}

/**
 * Expand a finish string into all synonym tokens.
 * "timbro" → ["timbro", "strutturato", "textured", "strutt"]
 * "mosaico hex" → ["mosaico", "mosaic", "mos", "dado", "tessera", "hex", "esagona", "hexagon", "hexagonal"]
 */
function expandFinishSynonyms(finishStr) {
  if (!finishStr) return [];
  // Try to match compound finish keys first (e.g., "vein cut" → "veincut")
  const normalizedFull = finishStr.toLowerCase().replace(/[\s,]+/g, '');
  const words = finishStr.toLowerCase().split(/[\s,]+/).filter(Boolean);
  const expanded = new Set();
  // Skip ambiguous short words that cause false matches (e.g., "cut" matches "crosscut")
  const SKIP_WORDS = new Set(['cut', 'natural', 'the', 'and', 'for', 'di']);
  for (const word of words) {
    if (SKIP_WORDS.has(word)) continue;
    expanded.add(word);
    // Check if this word is a key in FINISH_SYNONYMS
    if (FINISH_SYNONYMS[word]) {
      for (const syn of FINISH_SYNONYMS[word]) expanded.add(syn);
    }
    // Check if this word appears as a value in any synonym group
    for (const [key, syns] of Object.entries(FINISH_SYNONYMS)) {
      if (syns.includes(word)) {
        expanded.add(key);
        for (const syn of syns) expanded.add(syn);
      }
    }
  }
  // Also try the full concatenated string (e.g., "veincut", "crosscut")
  for (const [key, syns] of Object.entries(FINISH_SYNONYMS)) {
    if (normalizedFull.includes(key) || syns.some(s => normalizedFull.includes(s))) {
      expanded.add(key);
      for (const syn of syns) expanded.add(syn);
    }
  }
  return [...expanded];
}


// ── Page interaction ───────────────────────────────────────────────────

async function scrollToLoadAll(page) {
  await page.evaluate(async () => {
    const totalHeight = document.body.scrollHeight;
    const step = 400;
    for (let pos = 0; pos < totalHeight; pos += step) {
      window.scrollTo(0, pos);
      await new Promise(r => setTimeout(r, 150));
    }
    window.scrollTo(0, 0);
  });
  await delay(1500);
}

/** Extract images from manufacturer catalog pages (emilgroup).
 *  Aggressively extracts images including lazy-loaded ones
 *  via data-src, srcset, noscript, and CSS background URLs.
 *  Returns up to 50 images per page (many finishes = many images). */
async function extractManufacturerImages(page, url, siteWideImages) {
  try {
    const resp = await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
    if (!resp || resp.status() >= 400) {
      console.log(`    HTTP ${resp?.status()} for ${url}`);
      return [];
    }
    await delay(3000);
    await scrollToLoadAll(page);
    await delay(2000); // extra wait for lazy images

    // First try normal extraction
    const rawImages = await extractLargeImages(page, siteWideImages, 120);
    let urls = rawImages.map(img => img.src);

    // If few images found, also extract lazy-loaded sources from DOM
    if (urls.length < 5) {
      const lazyUrls = await page.evaluate(() => {
        const results = new Set();
        // data-src, data-lazy, data-original, srcset (first entry)
        for (const img of document.querySelectorAll('img[data-src], img[data-lazy], img[data-original], img[srcset], img[data-srcset]')) {
          const src = img.dataset?.src || img.dataset?.lazy || img.dataset?.original || '';
          if (src && src.startsWith('http')) results.add(src);
          const srcset = img.srcset || img.dataset?.srcset || '';
          if (srcset) {
            const first = srcset.split(',')[0]?.trim()?.split(/\s+/)[0];
            if (first?.startsWith('http')) results.add(first);
          }
        }
        // noscript img tags (common lazy-loading pattern)
        for (const ns of document.querySelectorAll('noscript')) {
          const m = ns.innerHTML?.match(/src=["']([^"']+\.(?:jpg|jpeg|png|webp)[^"']*)/gi) || [];
          for (const match of m) {
            const u = match.replace(/src=["']/i, '');
            if (u.startsWith('http')) results.add(u);
          }
        }
        // CSS background-image on product cards/tiles
        for (const el of document.querySelectorAll('[style*="background-image"]')) {
          const m = el.style.backgroundImage?.match(/url\(["']?([^"')]+)/);
          if (m?.[1]?.startsWith('http')) results.add(m[1]);
        }
        return [...results];
      });
      console.log(`      (lazy extraction found ${lazyUrls.length} additional URLs)`);
      urls = [...new Set([...urls, ...lazyUrls])];
    }

    // Extract product image URLs from page source.
    // emilgroup uses _next/image wrappers and various patterns.
    // Always run source extraction (not just when < 5 images) to find
    // per-color per-finish product close-ups that lazy loading misses.
    {
      const pageSource = await page.content();
      const baseUrl = 'https://www.emilgroup.it';
      const allMatches = [];

      // 1. Direct emilgroup URLs in HTML source
      const srcMatches = pageSource.match(/https?:\/\/www\.emilgroup\.it\/[^"'\s>]+\.(?:jpg|jpeg|png|webp)(?:\?[^"'\s>]*)?/gi) || [];
      allMatches.push(...srcMatches);

      // 2. Relative paths in data attributes and img src
      const relMatches = pageSource.match(/(?:src|data-src|data-lazy|content)=["'](\/emil\/[^"']+\.(?:jpg|jpeg|png|webp)[^"']*)/gi) || [];
      for (const m of relMatches) {
        const path = m.replace(/^(?:src|data-src|data-lazy|content)=["']/i, '');
        allMatches.push(path.startsWith('/') ? baseUrl + path : path);
      }

      // 3. Extract inner URLs from _next/image?url=... wrappers in page source.
      //    emilgroup.it uses Next.js image optimization, so product images appear as:
      //    /_next/image?url=%2Femil%2Fprodotti%2Fimmaginiarticoli_emil%2F...jpg&w=640&q=75
      //    or with full domain: _next/image?url=https%3A%2F%2Fwww.emilgroup.it%2F...
      const nextImageMatches = pageSource.match(/_next\/image[^"']*\?url=([^&"']+)/gi) || [];
      for (const match of nextImageMatches) {
        const m = match.match(/url=([^&"']+)/i);
        if (!m) continue;
        let decoded = decodeURIComponent(m[1]);
        // Handle double-encoding: %2Femil → /emil
        if (decoded.includes('%2F') || decoded.includes('%20')) {
          decoded = decodeURIComponent(decoded);
        }
        if (decoded.startsWith('/')) decoded = baseUrl + decoded;
        if (/\.(jpg|jpeg|png|webp)/i.test(decoded)) {
          allMatches.push(decoded);
        }
      }

      // Filter to only product images (exclude icons, logos, banners, certs)
      const productMatches = allMatches.filter(u =>
        (u.includes('/prodotti/') || u.includes('PANNELLO') || u.includes('MOSAICO') ||
         u.includes('_60x') || u.includes('_30x') || u.includes('_120x') ||
         u.includes('immaginiarticoli') || u.includes('immaginicollezioni')) &&
        !u.includes('logo') && !u.includes('icon') && !u.includes('banner') &&
        !u.includes('certificazioni') && !u.includes('loghi_') && !u.includes('/awards/')
      );
      if (productMatches.length > 0) {
        console.log(`      (source extraction found ${productMatches.length} product image URLs)`);
        urls = [...new Set([...urls, ...productMatches])];
      }
    }

    // Unwrap Next.js _next/image wrappers and filter
    urls = urls.map(u => unwrapImageUrl(u));
    return filterImageUrls(urls, { maxImages: 50, extraExclude: ['_thumbnail', '/thumbs/', 'logo', 'banner', 'icon', 'sprite', 'certificazioni', 'loghi_', '/loghi/', '/awards/', 'caratteristiche'] });
  } catch (err) {
    console.log(`    Error loading ${url}: ${err.message}`);
    return [];
  }
}

// ── Product detail page image extraction ───────────────────────────────

/**
 * Extract gallery images from a melangetile.com product detail page.
 * The actual full-size images are in <a href> attributes inside the
 * carousel <li> elements. The link text / nested <img alt> contains
 * descriptive color+size+finish info for matching.
 *
 * @param {import('puppeteer').Page} page
 * @param {string} url - Full URL of the product detail page
 * @returns {Promise<Array<{url: string, filename: string, altText: string}>>}
 */
async function extractProductDetailImages(page, url) {
  // Try up to 2 attempts with increased timeout (melangetile.com can be slow)
  let resp;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      resp = await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
      if (resp && resp.status() < 400) break;
      console.log(`    HTTP ${resp?.status()} for ${url} (attempt ${attempt})`);
      if (attempt < 2) await delay(3000);
    } catch (navErr) {
      console.log(`    ${navErr.message} (attempt ${attempt})`);
      if (attempt < 2) await delay(3000);
      else return [];
    }
  }
  try {
    if (!resp || resp.status() >= 400) {
      return [];
    }
    await delay(2000);
    await scrollToLoadAll(page);

    // Extract <a href> + alt text from carousel list items
    const images = await page.evaluate(() => {
      const results = [];
      const seen = new Set();

      // Primary: carousel anchor links with image hrefs
      const selectors = [
        '[aria-label="Carousel"] li a[href]',
        '.more-views-items li a[href]',
        '.slides li a[href]',
        '.product-gallery li a[href]',
        '.gallery-thumbs li a[href]',
        'ul.slides a[href]',
        '.flexslider li a[href]',
      ];

      for (const sel of selectors) {
        for (const a of document.querySelectorAll(sel)) {
          const href = a.getAttribute('href');
          if (!href) continue;
          if (!/\.(jpg|jpeg|png|webp|gif)/i.test(href)) continue;
          if (seen.has(href)) continue;
          seen.add(href);
          // Alt text: try link text, then nested img alt, then empty
          const altText = a.textContent?.trim() || a.querySelector('img')?.alt?.trim() || '';
          results.push({ href, altText });
        }
      }

      // Broader fallback: any <a> linking to an image file in the page
      if (results.length === 0) {
        for (const a of document.querySelectorAll('a[href]')) {
          const href = a.getAttribute('href');
          if (!href) continue;
          if (!/\.(jpg|jpeg|png|webp|gif)/i.test(href)) continue;
          if (seen.has(href)) continue;
          // Skip navigation/external links
          if (/^https?:\/\/(?!www\.melangetile\.com)/i.test(href)) continue;
          seen.add(href);
          const altText = a.textContent?.trim() || a.querySelector('img')?.alt?.trim() || '';
          results.push({ href, altText });
        }
      }

      return results;
    });

    // Build full URLs, unwrap thumbnail.asp wrappers, and extract filenames
    const result = [];
    for (const img of images) {
      let fullUrl;
      if (img.href.startsWith('http')) {
        fullUrl = img.href;
      } else if (img.href.startsWith('/')) {
        fullUrl = `https://www.melangetile.com${img.href}`;
      } else {
        // Relative path (e.g. "assets/images/Block-Iron-30x30.jpg")
        fullUrl = `https://www.melangetile.com/${img.href}`;
      }

      // Unwrap thumbnail.asp wrapper URLs (return 403 when fetched server-side)
      fullUrl = unwrapImageUrl(fullUrl);

      const filename = fullUrl.split('/').pop().split('?')[0] || '';
      result.push({ url: fullUrl, filename, altText: img.altText });
    }

    return result;
  } catch (err) {
    console.log(`    Error loading ${url}: ${err.message}`);
    return [];
  }
}

// ── Filename-based SKU matching ────────────────────────────────────────

/**
 * Parse a product detail image filename into normalized tokens for matching.
 * Examples:
 *   "Block-Iron-30x30.jpg"            → { tokens: ['block','iron','30x30'], raw: 'block-iron-30x30' }
 *   "Cenere-Silktech-12x24.jpg"       → { tokens: ['cenere','silktech','12x24'], raw: 'cenere-silktech-12x24' }
 *   "Dark-Grey-Mix-15x30.jpg"         → { tokens: ['dark','grey','mix','15x30'], raw: 'dark-grey-mix-15x30' }
 *   "block-main-cat.jpg"              → { tokens: ['block','main','cat'], raw: 'block-main-cat', isGeneric: true }
 */
function parseImageFilename(filename) {
  if (!filename) return { tokens: [], raw: '', isGeneric: false };
  // Strip extension
  const base = filename.replace(/\.\w+$/, '').toLowerCase();
  // Split on hyphens, underscores, spaces
  const tokens = base.split(/[-_\s]+/).filter(Boolean);
  // Detect generic/lifestyle filenames
  const genericPatterns = ['icon', 'main-cat', 'maincat', 'banner', 'hero', 'logo', 'category', 'cat-img', 'thumb'];
  const isGeneric = genericPatterns.some(p => base.includes(p));
  return { tokens, raw: base, isGeneric };
}

// ── Alt-text parsing and image classification ──────────────────────────

/**
 * Parse carousel alt text into structured data for matching.
 * Examples:
 *   "Iron-30x30"              → { color: "iron", size: "30x30" }
 *   "Cenere-Silktech-12x24 | 24x48" → { color: "cenere", finish: "silktech", size: "12x24" }
 *   "Kauri Nelson Polished"   → { color: "nelson", finish: "polished" }
 *   "Iron RS 1"               → { color: "iron", isRoomScene: true }
 *   "Tazman Tech 24x48 Room"  → { color: "tazman", finish: "tech", size: "24x48", isRoomScene: true }
 */
function parseAltText(altText) {
  if (!altText || altText.trim().length === 0) return null;

  const text = altText.trim();
  const result = {};

  // Detect room scene markers (including Italian: bagno=bathroom, parte=part, ambiente=scene)
  const roomPatterns = /\b(RS|room|scene|ambiente|amb|interior|bagno|living|part[e]?\s+(?:bagno|living|cucina))\b/i;
  result.isRoomScene = roomPatterns.test(text);

  // Extract size dimensions (e.g., "30x30", "12x24", "8x48")
  const sizeMatch = text.match(/(\d+(?:\.\d+)?)\s*[xX×]\s*(\d+(?:\.\d+)?)/);
  if (sizeMatch) {
    result.size = `${sizeMatch[1]}x${sizeMatch[2]}`;
  }

  // Strip the size, pipe-separated alt sizes, RS markers, and numbers for color/finish parsing
  let cleaned = text
    .replace(/\s*\|.*$/, '')                          // Remove pipe and everything after
    .replace(/\d+(?:\.\d+)?\s*[xX×]\s*\d+(?:\.\d+)?/g, '')  // Remove size dimensions
    .replace(/\b(RS|room|scene|ambiente|amb|interior)\s*\d*/gi, '')  // Remove room scene markers
    .replace(/\s+\d+\s*$/, '')                        // Remove trailing numbers (e.g., "Iron RS 1" → "Iron")
    .replace(/[-_]+/g, ' ')                           // Normalize separators
    .trim();

  if (!cleaned) return result;

  const words = cleaned.split(/\s+/).filter(Boolean);

  // Identify finish words using FINISH_SYNONYMS
  const finishWords = [];
  const colorWords = [];
  for (const word of words) {
    const lower = word.toLowerCase();
    let isFinish = false;
    for (const [, syns] of Object.entries(FINISH_SYNONYMS)) {
      if (syns.includes(lower)) { isFinish = true; break; }
    }
    if (isFinish) {
      finishWords.push(lower);
    } else {
      colorWords.push(lower);
    }
  }

  if (colorWords.length > 0) {
    result.color = colorWords.join(' ').toLowerCase();
  }
  if (finishWords.length > 0) {
    result.finish = finishWords.join(' ');
  }

  return Object.keys(result).length > 0 ? result : null;
}

/**
 * Classify an image into one of 3 tiers based on alt text + filename.
 * Returns: 'closeup' | 'roomscene' | 'banner'
 */
function classifyImage(image) {
  const { altText, filename, url } = image;
  const fnLower = (filename || '').toLowerCase();
  const urlLower = (url || '').toLowerCase();

  // Banner: path contains /banner/, filename contains main-cat, icon, hero
  if (urlLower.includes('/banner/') || /\b(main-?cat|icon|hero|category|cat-img)\b/.test(fnLower)) {
    return 'banner';
  }
  // Banner: alt text empty or matches only collection name (no color info)
  if (!altText || altText.trim().length === 0) {
    // If filename also has no color info, it's likely a banner
    if (/^(block|sixty|kauri|sunstone|woodbreak|moonlit)[-_]?(pg|series|tile)?[-_]?(br|banner)?/i.test(fnLower)) {
      return 'banner';
    }
  }

  // Room scene: RS in filename, room/scene in filename or alt, or Italian room terms
  const parsed = altText ? parseAltText(altText) : null;
  if (parsed?.isRoomScene) return 'roomscene';
  if (/\bRS\s*\d*/i.test(fnLower)) return 'roomscene';
  if (/room.?scene/i.test(fnLower)) return 'roomscene';
  // Italian room scene terms: Part(e) Bagno (bathroom), Part(e) Living, amb_ (ambiente = room scene)
  if (/\bpart[e]?\s*(bagno|living|cucina|camera|soggiorno)\b/i.test(fnLower)) return 'roomscene';
  if (/\bamb[_\s]/i.test(fnLower)) return 'roomscene';
  // Sequential numbered variants without a size (e.g., kauriFiordland2.jpg, kauriFiordland3.jpg)
  // Exclude "product-shot1" and "ps1" patterns (product shots, not room scenes)
  if (/[a-z]\d\.(jpg|jpeg|png|webp|gif)$/i.test(fnLower) && !/\d+x\d+/.test(fnLower) &&
      !/product.?shot/i.test(fnLower) && !/[_-]ps\d/i.test(fnLower)) return 'roomscene';

  // Product close-up: has a size dimension in filename or alt text, or is a clear product shot
  return 'closeup';
}

// ── Direct image-to-SKU matching ──────────────────────────────────────

/**
 * Match a gallery image against a list of SKUs using alt text as the primary signal,
 * falling back to filename parsing when alt text is empty.
 *
 * Scoring:
 *   color + size + finish → 100 (exact SKU match)
 *   color + size          → 80
 *   color + finish        → 60
 *   color only            → 40
 *   no match              → 0
 *
 * @param {object} image - { url, filename, altText }
 * @param {Array<{sku_id: number, variant_name: string}>} collectionSkus
 * @param {string[]} colorNames - Product/color names in this collection
 * @returns {{ sku_id: number|null, color: string|null, score: number, classification: string }}
 */
function matchImageToSkus(image, collectionSkus, colorNames) {
  const classification = classifyImage(image);
  if (classification === 'banner') {
    return { sku_id: null, color: null, score: 0, classification };
  }

  // Get structured info from alt text (primary) or filename (fallback)
  let info = parseAltText(image.altText);
  if (!info || !info.color) {
    // Fall back to filename parsing
    const parsed = parseImageFilename(image.filename);
    if (parsed.isGeneric) {
      return { sku_id: null, color: null, score: 0, classification: 'banner' };
    }
    // Try to extract color from filename tokens
    const fnNorm = normalize(image.filename);
    const sorted = [...colorNames].sort((a, b) => b.length - a.length);
    // Pass 1: full color name match
    for (const color of sorted) {
      const normColor = normalize(color);
      if (normColor.length <= 2) continue;
      if (fnNorm.includes(normColor)) {
        info = info || {};
        info.color = color.toLowerCase();
        break;
      }
      const aliases = COLOR_ALIASES[normColor] || [];
      for (const alias of aliases) {
        if (fnNorm.includes(alias)) {
          info = info || {};
          info.color = color.toLowerCase();
          break;
        }
      }
      if (info?.color) break;
    }
    // Pass 1b: pattern-numbered colors (e.g. "Marble & Wood #3")
    // Handles & → and conversion and disambiguates by pattern number in filename
    if (!info?.color) {
      for (const color of sorted) {
        const hashMatch = color.match(/^(.+?)\s*#(\d+)$/);
        if (!hashMatch) continue;
        const baseName = hashMatch[1].trim();
        const patternNum = hashMatch[2];
        const tryNames = [normalize(baseName)];
        if (baseName.includes('&')) tryNames.push(normalize(baseName.replace(/&/g, ' and ')));
        for (const bn of tryNames) {
          if (bn.length <= 2) continue;
          if (fnNorm.includes(bn + patternNum)) {
            info = info || {};
            info.color = color.toLowerCase();
            break;
          }
        }
        if (info?.color) break;
      }
    }
    // Pass 2: individual words for multi-word color names (e.g. "Beige Minimal")
    if (!info?.color) {
      const allFinishWords = new Set();
      for (const [key, syns] of Object.entries(FINISH_SYNONYMS)) {
        allFinishWords.add(key);
        for (const s of syns) allFinishWords.add(s);
      }
      for (const color of sorted) {
        const words = color.replace(/\s*#\d+$/, '').split(/\s+/);
        if (words.length < 2) continue;
        const colorOnlyWords = words.filter(w => !allFinishWords.has(w.toLowerCase()));
        if (colorOnlyWords.length === 0) continue;
        for (const word of colorOnlyWords) {
          const normWord = normalize(word);
          if (normWord.length < 3) continue;
          if (fnNorm.includes(normWord)) {
            info = info || {};
            info.color = color.toLowerCase();
            break;
          }
        }
        if (info?.color) break;
      }
    }
    // Extract size from filename
    const sizeMatch = image.filename?.match(/(\d+(?:\.\d+)?)\s*[xX×]\s*(\d+(?:\.\d+)?)/);
    if (sizeMatch) {
      info = info || {};
      info.size = `${sizeMatch[1]}x${sizeMatch[2]}`;
    }
    // Extract finish from filename tokens
    if (!info?.finish && parsed.tokens.length > 0) {
      for (const token of parsed.tokens) {
        for (const [, syns] of Object.entries(FINISH_SYNONYMS)) {
          if (syns.includes(token)) {
            info = info || {};
            info.finish = token;
            break;
          }
        }
        if (info?.finish) break;
      }
    }
  }

  if (!info?.color) {
    return { sku_id: null, color: null, score: 0, classification };
  }

  // Match color against product names (with alias support)
  const imgColor = normalize(info.color);
  let matchedColorName = null;
  const sortedColors = [...colorNames].sort((a, b) => b.length - a.length);
  // Pass 0: pattern-number disambiguation using filename
  // When alt text yields "marble and wood" (without #N), use the filename
  // to determine the specific pattern (e.g. "Marble-and-Wood-3-1-up.jpg" → #3)
  const fnNormForPattern = normalize(image.filename || '');
  for (const color of sortedColors) {
    const hashMatch = color.match(/^(.+?)\s*#(\d+)$/);
    if (!hashMatch) continue;
    const baseName = hashMatch[1].trim();
    const patternNum = hashMatch[2];
    const tryNames = [normalize(baseName)];
    if (baseName.includes('&')) tryNames.push(normalize(baseName.replace(/&/g, ' and ')));
    for (const bn of tryNames) {
      if (bn.length <= 2) continue;
      if (fnNormForPattern.includes(bn + patternNum)) {
        matchedColorName = color;
        break;
      }
    }
    if (matchedColorName) break;
  }
  // Pass 1: full name match
  if (!matchedColorName) for (const color of sortedColors) {
    const normColor = normalize(color);
    if (normColor.length <= 2) continue;
    if (imgColor.includes(normColor) || normColor.includes(imgColor)) {
      matchedColorName = color;
      break;
    }
    const aliases = COLOR_ALIASES[normColor] || [];
    for (const alias of aliases) {
      if (imgColor.includes(alias) || alias.includes(imgColor)) {
        matchedColorName = color;
        break;
      }
    }
    if (matchedColorName) break;
  }
  // Pass 2: individual word match for multi-word color names (e.g., "Beige Minimal")
  if (!matchedColorName) {
    const allFinishWords = new Set();
    for (const [key, syns] of Object.entries(FINISH_SYNONYMS)) {
      allFinishWords.add(key);
      for (const s of syns) allFinishWords.add(s);
    }
    for (const color of sortedColors) {
      const words = color.replace(/\s*#\d+$/, '').split(/\s+/);
      if (words.length < 2) continue;
      const colorOnlyWords = words.filter(w => !allFinishWords.has(w.toLowerCase()));
      if (colorOnlyWords.length === 0) continue;
      for (const word of colorOnlyWords) {
        const normWord = normalize(word);
        if (normWord.length < 3) continue;
        if (imgColor.includes(normWord) || normWord.includes(imgColor)) {
          matchedColorName = color;
          break;
        }
      }
      if (matchedColorName) break;
    }
  }

  if (!matchedColorName) {
    return { sku_id: null, color: null, score: 0, classification };
  }

  // Now match against SKUs for this color
  const imgSize = info.size ? info.size.toLowerCase() : null;
  const imgFC = detectFinishComponents(info.finish || '');

  let bestSkuId = null;
  let bestScore = 40; // Base color-only score

  for (const sku of collectionSkus) {
    if (!sku.variant_name) continue;
    const parts = sku.variant_name.split(',').map(p => p.trim());
    const skuColor = (parts[0] || '').toLowerCase();
    const skuSize = (parts[1] || '').toLowerCase().replace(/\s/g, '');
    const skuFinish = parts.slice(2).join(' ').toLowerCase();

    // Must match color
    const normSkuColor = normalize(skuColor);
    const normMatchedColor = normalize(matchedColorName);
    if (normSkuColor !== normMatchedColor) {
      // Check aliases
      const aliases = COLOR_ALIASES[normSkuColor] || [];
      const reverseAliases = COLOR_ALIASES[normMatchedColor] || [];
      if (!aliases.some(a => normalize(a) === normMatchedColor) &&
          !reverseAliases.some(a => normalize(a) === normSkuColor)) {
        continue;
      }
    }

    let score = 40; // Color match base

    // Size match
    const skuSizeNorm = skuSize.replace(/\s*x\s*/g, 'x');
    const sizeMatches = imgSize && skuSizeNorm && imgSize === skuSizeNorm;
    if (sizeMatches) score += 40;

    // Form/surface finish match using form/surface distinction
    const skuFC = detectFinishComponents(skuFinish);

    // Form match
    if (skuFC.forms.length > 0 && imgFC.forms.length > 0) {
      const formMatch = skuFC.forms.some(f => imgFC.forms.includes(f));
      if (formMatch) score += 30;
      else score -= 40; // Wrong form
    } else if (skuFC.forms.length === 0 && imgFC.forms.length === 0) {
      // Both are base tiles — compatible
      score += 10;
    } else if (skuFC.forms.length > 0 && imgFC.forms.length === 0) {
      score -= 15; // SKU needs a form but image doesn't have one
    } else if (skuFC.forms.length === 0 && imgFC.forms.length > 0) {
      score -= 20; // Image has a form but SKU doesn't need one
    }

    // Surface match
    if (skuFC.surfaces.length > 0 && imgFC.surfaces.length > 0) {
      const surfaceMatch = skuFC.surfaces.some(s => imgFC.surfaces.includes(s));
      if (surfaceMatch) score += 20;
      else score -= 25;
    } else if (skuFC.surfaces.length === 0 && imgFC.surfaces.length > 0) {
      score -= 5;
    }

    if (score > bestScore) {
      bestScore = score;
      bestSkuId = sku.sku_id;
    }
  }

  return { sku_id: bestSkuId, color: matchedColorName, score: bestScore, classification };
}

// ── Manufacturer catalog scraping ──────────────────────────────────────

/**
 * Collection name tokens for filtering manufacturer images.
 * Maps collection names to normalized tokens that should appear in URLs
 * from the correct collection (not related/recommended collections).
 */
function getCollectionFilterTokens(collectionName) {
  const tokens = [];
  // Primary: collection name words (normalized)
  const words = collectionName.toLowerCase().split(/[\s'-]+/).filter(w => w.length >= 3);
  tokens.push(...words);
  // Special cases where emilgroup uses different naming
  const aliases = {
    'Sixty 60 Silktech': ['sixty', 'silktech'],
    'Stonetalk': ['stonetalk', 'stone_talk', 'stone-talk'],
    'Portland Stone': ['portland'],
    'Tele di Marmo': ['tele', 'marmo'],
    'Real Stone Travertino': ['realstone', 'travertino'],
    'Concrete Soul Infinity': ['concrete', 'infinity'],
    'Unique Bourgogne': ['bourgogne', 'unique'],
    'Unique Infinity': ['unique', 'infinity'],
  };
  if (aliases[collectionName]) tokens.push(...aliases[collectionName]);
  return [...new Set(tokens)];
}

/**
 * Filter manufacturer images to only keep those belonging to the target collection.
 * Removes images from "related collections" sections on emilgroup.it pages
 * (e.g., pietra_essenza, lombarda images appearing on Portland Stone page).
 *
 * An image passes if:
 *   - Its URL/filename contains a collection filter token, OR
 *   - Its URL/filename contains a known color name from the collection, OR
 *   - It's from a generic path (no other collection names detected)
 */
function filterCollectionImages(imageUrls, collectionName, colorNames) {
  const collTokens = getCollectionFilterTokens(collectionName);
  const normColors = colorNames.map(c => normalize(c)).filter(c => c.length > 2);

  // Known other collection names to detect cross-contamination
  const otherCollections = [
    'pietra_essenza', 'lombarda', 'kauri', 'moonlit', 'nirvana', 'woodbreak',
    'factory', 'sicily', 'shellstone', 'memory', 'caprice', 'pearl', 'snow',
    'evolution', 'sunstone', 'sublime', 'decoro', 'cafoscari', 'block',
    'quartz', 'unique_infinity', 'unique_bourgogne', 'sixty', 'stonetalk',
    'portland', 'tele_di_marmo', 'real_stone', 'concrete_soul',
    'level', 'gemmastone', 'dual', 'lumia', 'circles', 'orosei', 'provenza',
  ];
  // Remove tokens that ARE our collection (so we don't filter ourselves out)
  const foreignCollections = otherCollections.filter(oc =>
    !collTokens.some(ct => normalize(ct) === normalize(oc) || normalize(oc).includes(normalize(ct)))
  );

  return imageUrls.filter(url => {
    const normUrl = normalize(url);
    const fn = normalize(getFilename(url));

    // Check if image belongs to our collection (by collection token) — highest priority
    const hasCollToken = collTokens.some(t => normUrl.includes(normalize(t)));
    if (hasCollToken) return true;

    // Check foreign collection BEFORE color match — reject images from other collections
    // even if they happen to share a color name (e.g., "lombarda_grey" on a Stonetalk page)
    const hasForeignColl = foreignCollections.some(fc => {
      const nfc = normalize(fc);
      return nfc.length > 4 && (fn.includes(nfc) || normUrl.includes(nfc));
    });
    if (hasForeignColl) return false;

    // Check if image matches a known color in our collection
    const hasColor = normColors.some(c => fn.includes(c));
    if (hasColor) return true;

    // Generic image (no collection detected) — keep as potential lifestyle
    return true;
  });
}

/**
 * Scrape finish-specific images from onetile.us/it and emilgroup.it.
 * Returns Map<collectionName, [{url, source}]> — all images per collection.
 */
async function scrapeManufacturerCatalogs(page, collectionProducts) {
  const catalogImages = new Map(); // collection → [{url, source: 'manufacturer'}]
  const siteWideCache = new Map(); // domain → Set<excludeUrls>

  const allMaps = [
    { map: ONETILE_MAP, label: 'onetile' },
    { map: EMILGROUP_MAP, label: 'emilgroup' },
  ];

  for (const { map, label } of allMaps) {
    for (const [collectionName, urls] of Object.entries(map)) {
      const products = collectionProducts.get(collectionName);
      if (!products || products.length === 0) continue;

      const colorNames = products.map(p => p.name);

      for (const url of urls) {
        // Collect site-wide images per domain (once)
        let domain;
        try { domain = new URL(url).origin; } catch { continue; }

        if (!siteWideCache.has(domain)) {
          console.log(`  Collecting site-wide images for ${domain}...`);
          const swImages = await collectSiteWideImages(page, domain);
          siteWideCache.set(domain, swImages);
          console.log(`    ${swImages.size} site-wide images excluded`);
        }

        console.log(`  [${label}] ${collectionName}: ${url}`);
        let images = await extractManufacturerImages(page, url, siteWideCache.get(domain));

        // Filter out cross-collection contamination (e.g., pietra_essenza on Portland Stone page)
        const beforeCount = images.length;
        images = filterCollectionImages(images, collectionName, colorNames);
        const filtered = beforeCount - images.length;
        if (filtered > 0) {
          console.log(`    Found ${beforeCount} images, filtered ${filtered} cross-collection → ${images.length} kept`);
        } else {
          console.log(`    Found ${images.length} images`);
        }

        if (!catalogImages.has(collectionName)) catalogImages.set(collectionName, []);
        for (const imgUrl of images) {
          catalogImages.get(collectionName).push({ url: imgUrl, source: 'manufacturer' });
        }

        await delay(1500); // Polite delay between pages
      }
    }
  }

  return catalogImages;
}

/**
 * Score an image URL against a specific SKU's color/size/finish.
 * Works for both gallery images (via filename) and manufacturer images (via URL hints).
 * Returns 0 if color doesn't match.
 *
 * Uses form/surface finish distinction:
 *   +40 color match (required)
 *   +40 size match
 *   +30 form finish match (bullnose, hex, minibrick, mosaico)
 *   -40 wrong form finish (image has different form than SKU)
 *   +20 surface finish match (matt, timbro, silktech, polished, natural)
 *   -25 wrong surface finish
 */
function scoreImageForVariant(imageUrl, skuColor, skuSize, skuFinish) {
  const fn = normalize(getFilename(imageUrl));
  const hint = Object.entries(URL_PATTERN_HINTS).find(([k]) => imageUrl.includes(k));
  const effective = hint ? normalize(hint[1]) + ' ' + fn : fn;

  let score = 0;

  // Color match (required)
  const normColor = normalize(skuColor);
  if (normColor.length > 2 && effective.includes(normColor)) {
    score += 40;
  } else {
    const aliases = COLOR_ALIASES[normColor] || [];
    if (aliases.some(a => effective.includes(a))) {
      score += 40;
    } else {
      // Try individual words for multi-word color names (e.g. "beige minimal")
      // Strip finish keywords so "Beige Variee" only tries "beige", not "variee"
      const allFinishWordsSet = new Set();
      for (const [key, syns] of Object.entries(FINISH_SYNONYMS)) { allFinishWordsSet.add(key); for (const s of syns) allFinishWordsSet.add(s); }
      const colorWords = skuColor.split(/\s+/).filter(w => w.length >= 3 && !allFinishWordsSet.has(w.toLowerCase()));
      if (colorWords.length > 0) {
        for (const word of colorWords) {
          const nw = normalize(word);
          if (nw.length >= 3 && effective.includes(nw)) { score += 40; break; }
        }
      }
    }
  }
  if (score === 0) return 0;

  // Size match
  if (skuSize) {
    const sizeNorm = skuSize.replace(/\s*x\s*/g, 'x').toLowerCase();
    if (effective.includes(sizeNorm)) {
      score += 40;
    } else {
      // Check if image has a different size embedded — if so, prefer larger format as fallback
      const imgSizeMatch = effective.match(/(\d+)x(\d+)/);
      const skuSizeMatch = sizeNorm.match(/(\d+)x(\d+)/);
      if (imgSizeMatch && skuSizeMatch) {
        const imgArea = Number(imgSizeMatch[1]) * Number(imgSizeMatch[2]);
        const skuArea = Number(skuSizeMatch[1]) * Number(skuSizeMatch[2]);
        score += imgArea >= skuArea ? 3 : (imgArea > 1000 ? 2 : 1);
      }
    }
  }

  // Form/surface finish scoring
  const skuFC = detectFinishComponents(skuFinish || '');

  // Detect what finishes the IMAGE contains by scanning the effective string
  const imgForms = new Set();
  const imgSurfaces = new Set();
  for (const [key, syns] of Object.entries(FINISH_SYNONYMS)) {
    const found = [key, ...syns].some(s => s.length > 2 && effective.includes(normalize(s)));
    if (found) {
      if (FORM_FINISH_KEYS.has(key)) imgForms.add(key);
      else imgSurfaces.add(key);
    }
  }

  // Form finish scoring (MUST match — shapes are non-interchangeable)
  if (skuFC.forms.length > 0) {
    const formMatch = skuFC.forms.some(f => imgForms.has(f));
    if (formMatch) {
      score += 30;
      // Subtype mismatch penalty: e.g. SKU is "Mosaico Dado" but image is "Sfalsati"
      const MOSAIC_SUBTYPES = new Set(['dado', 'sfalsati']);
      const skuSubtypes = skuFC.forms.filter(f => MOSAIC_SUBTYPES.has(f));
      const imgSubtypes = [...imgForms].filter(f => MOSAIC_SUBTYPES.has(f));
      if (skuSubtypes.length > 0 && imgSubtypes.length > 0 &&
          !skuSubtypes.some(s => imgSubtypes.includes(s))) {
        score -= 35; // Wrong mosaic subtype
      }
    } else if (imgForms.size > 0) {
      score -= 40; // Image has a DIFFERENT form (e.g., minibrick vs bullnose)
    } else {
      score -= 15; // Image has no form info but SKU needs one
    }
  } else if (imgForms.size > 0) {
    score -= 20; // SKU is a base tile but image shows a form finish (hex, minibrick, etc.)
  }

  // Surface finish scoring
  // "Natural" = base surface (varies by collection), treat as surface-neutral
  const skuSurfaceOnlyNatural = skuFC.surfaces.length === 1 && skuFC.surfaces[0] === 'natural';
  if (skuFC.surfaces.length > 0 && !skuSurfaceOnlyNatural) {
    const surfaceMatch = skuFC.surfaces.some(s => imgSurfaces.has(s));
    if (surfaceMatch) {
      score += 20;
    } else if (imgSurfaces.size > 0) {
      score -= 25; // Different surface finish (e.g., polished vs timbro)
    }
  } else if (skuSurfaceOnlyNatural) {
    // "Natural" SKU — don't penalize any surface
    if (imgSurfaces.has('natural')) score += 5;
  } else if (imgSurfaces.size > 0) {
    score -= 5; // SKU has no detected surface but image does
  }

  // Room scene penalty for manufacturer images
  // Decode %20 etc. so regex word boundaries work on URL-encoded filenames
  const fnLower = decodeURIComponent(getFilename(imageUrl)).toLowerCase();
  if (/\bpart[e]?\s*(bagno|living|cucina)\b/i.test(fnLower) ||
      /\bamb[_\s]/i.test(fnLower) || /room.?scene/i.test(fnLower)) {
    score -= 25;
  }

  return score;
}

/**
 * Score a gallery image against a specific SKU using alt text data (if available)
 * plus filename. Uses form/surface finish distinction for accurate compound finish matching.
 *
 * Scoring:
 *   +40 size match
 *   +30 form finish match (bullnose, hex, minibrick, mosaico)
 *   -40 wrong form finish
 *   +20 surface finish match (matt, timbro, silktech, natural, polished)
 *   -25 wrong surface finish
 *   -5  room scene penalty
 *   -20 banner penalty
 */
function scoreGalleryImageForVariant(image, skuSize, skuFinish) {
  const parsed = image.altText ? parseAltText(image.altText) : null;

  // Get size from alt text or filename
  const imgSize = parsed?.size || null;
  const fnSize = image.filename?.match(/(\d+(?:\.\d+)?)\s*[xX×]\s*(\d+(?:\.\d+)?)/);
  const effectiveSize = imgSize || (fnSize ? `${fnSize[1]}x${fnSize[2]}` : null);

  // Gather ALL finish tokens from alt text + filename for form/surface detection
  const finishTokens = [];
  if (parsed?.finish) {
    finishTokens.push(...parsed.finish.split(/\s+/));
  }
  if (image.filename) {
    const fnParsed = parseImageFilename(image.filename);
    for (const token of fnParsed.tokens) {
      for (const [, syns] of Object.entries(FINISH_SYNONYMS)) {
        if (syns.includes(token)) { finishTokens.push(token); break; }
      }
    }
  }
  const effectiveFinishStr = finishTokens.join(' ');

  let score = 0;

  // Size match / mismatch
  if (skuSize && effectiveSize) {
    const skuSizeNorm = skuSize.replace(/\s*x\s*/g, 'x').toLowerCase();
    if (effectiveSize.toLowerCase() === skuSizeNorm) {
      score += 40;
    } else {
      score -= 25; // Explicit size mismatch — image is for a different tile dimension
      // Tiebreaker: prefer larger format images as fallback (they show more of the tile)
      const [imgW, imgH] = effectiveSize.split(/x/i).map(Number);
      const [skuW, skuH] = skuSizeNorm.split(/x/i).map(Number);
      if (imgW && imgH && skuW && skuH) {
        const imgArea = imgW * imgH;
        score += imgArea >= (skuW * skuH) ? 3 : (imgArea > 1000 ? 2 : 1);
      }
    }
  }

  // Form/surface finish scoring
  const skuFC = detectFinishComponents(skuFinish || '');
  const imgFC = detectFinishComponents(effectiveFinishStr);

  // Form finish scoring
  if (skuFC.forms.length > 0) {
    const formMatch = skuFC.forms.some(f => imgFC.forms.includes(f));
    if (formMatch) {
      score += 30;
      // Subtype mismatch penalty: SKU has "mosaico dado" but image has "mosaico sfalsati"
      // Both match on 'mosaico' but the subtype differs — penalize
      const MOSAIC_SUBTYPES = new Set(['dado', 'sfalsati']);
      const skuSubtypes = skuFC.forms.filter(f => MOSAIC_SUBTYPES.has(f));
      const imgSubtypes = imgFC.forms.filter(f => MOSAIC_SUBTYPES.has(f));
      if (skuSubtypes.length > 0 && imgSubtypes.length > 0 &&
          !skuSubtypes.some(s => imgSubtypes.includes(s))) {
        score -= 35; // Wrong subtype (e.g., dado SKU but sfalsati image)
      }
    } else if (imgFC.forms.length > 0) {
      score -= 40; // Wrong form (e.g., image is minibrick but SKU is bullnose)
    } else {
      score -= 15; // Image has no form info but SKU needs one
    }
  } else if (imgFC.forms.length > 0) {
    score -= 20; // SKU is base tile but image shows a form variant
  }

  // Surface finish scoring
  // "Natural" means "base surface" (varies by collection) — treat as surface-neutral
  // e.g., Sixty collection's base surface is "Silktech", so Natural Rectified ≈ Silktech
  const skuSurfaceIsOnlyNatural = skuFC.surfaces.length === 1 && skuFC.surfaces[0] === 'natural';
  if (skuFC.surfaces.length > 0 && !skuSurfaceIsOnlyNatural) {
    const surfaceMatch = skuFC.surfaces.some(s => imgFC.surfaces.includes(s));
    if (surfaceMatch) {
      score += 20;
      // Penalize extra surfaces in image not requested by SKU (e.g., "matt-timbro" for Matt SKU)
      const unmatchedImgSurfaces = imgFC.surfaces.filter(s => !skuFC.surfaces.includes(s));
      if (unmatchedImgSurfaces.length > 0) score -= 5 * unmatchedImgSurfaces.length;
    } else if (imgFC.surfaces.length > 0) {
      score -= 45; // Wrong surface — must outweigh size match (+40)
    }
  } else if (skuSurfaceIsOnlyNatural) {
    // SKU is "Natural" = base surface. Don't penalize any surface; slight bonus for explicit "natural"
    if (imgFC.surfaces.includes('natural')) score += 5;
  } else if (imgFC.surfaces.length > 0) {
    // SKU has no detected surface but image does — slight penalty
    score -= 5;
  }

  // Room scene penalty for primary (prefer close-ups over room scenes)
  // Must outweigh surface match (+20) so a close-up without exact surface beats a room scene with it
  if (image.classification === 'roomscene') score -= 25;
  // Banner penalty
  if (image.classification === 'banner') score -= 40;

  return score;
}

// ── Main ───────────────────────────────────────────────────────────────

async function run() {
  const vendorRes = await pool.query("SELECT id FROM vendors WHERE code = 'MELANGE'");
  if (!vendorRes.rows.length) {
    console.error('Melange vendor not found. Run import-melange.js first.');
    return;
  }
  const vendorId = vendorRes.rows[0].id;

  const prodRows = await pool.query(`
    SELECT id, name, collection FROM products WHERE vendor_id = $1 ORDER BY collection, name
  `, [vendorId]);

  console.log(`Found ${prodRows.rowCount} Melange products to enrich\n`);

  // Build collection → [{id, name (color)}] map
  const collectionProducts = new Map();
  for (const row of prodRows.rows) {
    if (!collectionProducts.has(row.collection)) {
      collectionProducts.set(row.collection, []);
    }
    collectionProducts.get(row.collection).push({ id: row.id, name: row.name });
  }

  const browser = await launchBrowser();
  let imagesSaved = 0;
  let productsMatched = 0;
  const finishMissingLog = []; // Track finishes that fell back to shared image

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    // ── Phase 1: Scrape melangetile.com Product Detail Pages ─────────

    console.log('=== Phase 1: Scraping melangetile.com Product Detail Pages ===\n');

    // Collect gallery images per collection, matched via alt text + filename:
    //   galleryImages: collection → [{ url, filename, altText, color, score, classification }]
    const galleryImages = new Map(); // collection → matched images

    // Pre-fetch all SKUs for matching
    const allProductIds = [...collectionProducts.values()].flat().map(p => p.id);
    const allSkuRes = await pool.query(
      `SELECT id AS sku_id, product_id, variant_name FROM skus WHERE product_id = ANY($1)`,
      [allProductIds]
    );
    const skusByProduct = new Map();
    for (const row of allSkuRes.rows) {
      if (!skusByProduct.has(row.product_id)) skusByProduct.set(row.product_id, []);
      skusByProduct.get(row.product_id).push({ sku_id: row.sku_id, variant_name: row.variant_name });
    }

    for (const [collectionName, slugs] of Object.entries(PRODUCT_DETAIL_MAP)) {
      const products = collectionProducts.get(collectionName);
      if (!products || products.length === 0) {
        console.log(`  [SKIP] No DB products for collection: ${collectionName}`);
        continue;
      }

      const colorNames = products.map(p => p.name);
      const collectionSkus = [];
      for (const p of products) {
        const skus = skusByProduct.get(p.id) || [];
        collectionSkus.push(...skus);
      }

      console.log(`[${collectionName}] Colors: ${colorNames.join(', ')} (${collectionSkus.length} SKUs)`);

      const allImages = [];
      const seenUrls = new Set();

      for (const slug of slugs) {
        const url = `${BASE_URL}${slug}`;
        console.log(`  Visiting: ${url}`);

        const images = await extractProductDetailImages(page, url);
        for (const img of images) {
          if (!seenUrls.has(img.url)) {
            seenUrls.add(img.url);
            allImages.push(img);
          }
        }
        console.log(`    Found ${images.length} gallery images`);
        await delay(800);
      }

      // Add gallery supplements (images that exist but aren't linked on gallery pages)
      const supplements = GALLERY_SUPPLEMENTS[collectionName] || [];
      for (const supp of supplements) {
        if (!seenUrls.has(supp.url)) {
          seenUrls.add(supp.url);
          allImages.push({
            url: supp.url,
            filename: getFilename(supp.url),
            altText: supp.altText || '',
            classification: 'closeup',
          });
          console.log(`    Added supplement: ${getFilename(supp.url)} (alt: ${supp.altText || ''})`);
        }
      }

      if (allImages.length === 0) {
        console.log(`  [NO IMAGES] ${collectionName}\n`);
        galleryImages.set(collectionName, []);
        continue;
      }

      // Match each image using alt text + filename
      const matched = [];
      let skuCount = 0, colorCount = 0, bannerCount = 0;

      for (const img of allImages) {
        const result = matchImageToSkus(img, collectionSkus, colorNames);
        matched.push({
          url: img.url,
          filename: img.filename,
          altText: img.altText,
          sku_id: result.sku_id,
          color: result.color,
          score: result.score,
          classification: result.classification,
        });
        if (result.sku_id) skuCount++;
        else if (result.color) colorCount++;
        else bannerCount++;
      }

      galleryImages.set(collectionName, matched);
      console.log(`  Matched: ${skuCount} to SKU, ${colorCount} to color, ${bannerCount} banners/generic\n`);
    }

    // ── Phase 2: Scrape manufacturer catalogs ────────────────────────

    console.log('=== Phase 2: Scraping Manufacturer Catalogs ===\n');
    const catalogImages = await scrapeManufacturerCatalogs(page, collectionProducts);
    console.log();

    // ── Phase 3: Assign images per SKU (priority waterfall) ──────────
    //   For each SKU: 1 primary (best close-up) + up to 2 alternates + 1 lifestyle
    //   Priority: gallery close-up (exact SKU) > gallery close-up (color) >
    //             manufacturer override > manufacturer catalog > gallery room scene

    console.log('=== Phase 3: Image Assignment ===\n');

    const MAX_IMAGES_PER_SKU = 4;

    for (const [collectionName, products] of collectionProducts) {
      if (!products || products.length === 0) continue;

      const colorNames = products.map(p => p.name);
      const gallery = galleryImages.get(collectionName) || [];

      // Gather manufacturer catalog + override images for this collection
      let mfrImages = catalogImages.get(collectionName) || [];
      if (collectionName === 'Sixty 60 Silktech' && SIXTY_IMAGE_OVERRIDES.length > 0) {
        const overrides = SIXTY_IMAGE_OVERRIDES.map(url => ({ url, source: 'override' }));
        mfrImages = [...overrides, ...mfrImages];
      }
      if (collectionName === 'Woodbreak' && WOODBREAK_IMAGE_OVERRIDES.length > 0) {
        const overrides = WOODBREAK_IMAGE_OVERRIDES.map(url => ({ url, source: 'override' }));
        mfrImages = [...overrides, ...mfrImages];
      }

      const productIds = products.map(p => p.id);

      // Clean slate: delete ALL media_assets for these products before re-assigning
      await pool.query("DELETE FROM media_assets WHERE product_id = ANY($1)", [productIds]);

      for (const product of products) {
        const skuDetails = skusByProduct.get(product.id) || [];
        if (skuDetails.length === 0) { productsMatched++; continue; }

        const colorNorm = normalize(product.name);
        let skuAssigned = 0;

        // Pre-filter gallery images for this product's color
        const finishWordSet = new Set();
        for (const [key, syns] of Object.entries(FINISH_SYNONYMS)) { finishWordSet.add(key); for (const s of syns) finishWordSet.add(s); }
        // Build set of all product color norms in this collection for cross-color guard
        const allColorNorms = new Set(products.map(p => normalize(p.name)));
        const colorGallery = gallery.filter(img => {
          if (!img.color) return false;
          const nc = normalize(img.color);
          if (nc === colorNorm) return true;
          // Substring match with cross-color guard:
          // Allow substring matching ONLY if the image's matched color doesn't exactly match
          // a DIFFERENT product in the collection (prevents "dark grey" images appearing
          // for "grey" when both "Dark Grey" and "Grey" are separate products)
          if (nc !== colorNorm && (colorNorm.includes(nc) || nc.includes(colorNorm))) {
            const matchesOtherProduct = allColorNorms.has(nc) && nc !== colorNorm;
            if (!matchesOtherProduct) return true;
          }
          // Finish-variant sharing: for compound product names differing only by finish keywords,
          // share images by base color word. E.g. "Beige Minimal" and "Beige Variee" both
          // match images for base color "Beige", since "Minimal" and "Variee" are finish keywords.
          // Skip for pattern-numbered products ("#1", "#2", etc.) — these are distinct designs,
          // NOT finish variants (e.g. "Marble & Wood #3" is a completely different pattern from #1)
          const isPatternNumbered = /#\d+$/.test(product.name.trim());
          const prodWords = product.name.split(/\s+/);
          if (!isPatternNumbered && prodWords.length >= 2) {
            const prodBaseWords = prodWords
              .filter(w => w.length >= 3 && !finishWordSet.has(w.toLowerCase()))
              .map(w => normalize(w));
            if (prodBaseWords.length > 0 && prodBaseWords.length < prodWords.length) {
              // Product name has finish keywords removed → it's a compound like "Beige Minimal"
              const imgBaseWords = img.color.split(/\s+/)
                .filter(w => w.length >= 3 && !finishWordSet.has(w.toLowerCase()))
                .map(w => normalize(w));
              if (imgBaseWords.length > 0 && imgBaseWords.some(iw => prodBaseWords.includes(iw))) {
                return true;
              }
            }
          }
          return false;
        });

        // Collection-level banners for lifestyle slot — must be truly generic (no specific color)
        const banners = gallery.filter(img => {
          if (img.classification === 'banner') return true;
          if (!img.color && img.score === 0) {
            // Double-check filename doesn't contain a specific color name
            const fn = normalize(img.filename || '');
            const hasColor = colorNames.some(c => {
              const nc = normalize(c.replace(/\s*#\d+$/, ''));
              return nc.length > 2 && fn.includes(nc);
            });
            return !hasColor;
          }
          return false;
        });

        // Track primaries assigned to sibling SKUs within this product.
        // Alternates should not reuse a sibling's primary when the sibling has a
        // different finish (prevents e.g., 24x48 Tech image as alternate for 8x48 Polished).
        // Same-finish siblings can share images (e.g., 12x24 Martellata alt for 24x48 Martellata).
        const siblingPrimaries = new Map(); // filename → first skuFinish that used it

        for (const sku of skuDetails) {
          const assignedUrls = [];
          const assignedFilenames = new Set();

          const parts = (sku.variant_name || '').split(',').map(p => p.trim());
          const skuColor = (parts[0] || '').toLowerCase();
          const skuSize = (parts[1] || '').toLowerCase().replace(/\s/g, '');
          let skuFinish = getFinishFromVariant(sku.variant_name);
          // If no explicit finish but color name contains finish keywords (e.g. "Beige Variee"),
          // extract them as the effective finish for scoring
          if (!skuFinish) {
            const colorFinishTokens = skuColor.split(/\s+/).filter(w => finishWordSet.has(w));
            if (colorFinishTokens.length > 0) skuFinish = colorFinishTokens.join(' ');
          }
          const skuFC = detectFinishComponents(skuFinish || '');

          // ── Score ALL candidate images against THIS specific SKU ──
          // Combine gallery + manufacturer into one scored pool

          const candidates = [];

          // Score gallery images (use alt text + filename for precise matching)
          for (const img of colorGallery) {
            const variantScore = scoreGalleryImageForVariant(img, skuSize, skuFinish);
            candidates.push({
              url: img.url,
              filename: img.filename,
              altText: img.altText || '',
              classification: img.classification,
              source: 'gallery',
              score: variantScore,
            });
          }

          // Score manufacturer override + catalog images (from Phase 2 scraping)
          const normSkuColorForMfr = normalize(skuColor);
          for (const img of mfrImages) {
            const imgUrl = img.url || img;
            const s = scoreImageForVariant(imgUrl, skuColor, skuSize, skuFinish);
            if (s <= 0) continue; // Must at least match color
            // Cross-color guard: if filename matches a DIFFERENT color in the collection
            // (e.g. "darkgrey" for "grey" SKU when "Dark Grey" is also a product), skip.
            // Uses position-based compound detection: if "dark" appears before "grey" in
            // "darkgrey", the image belongs to "Dark" product, not "Grey".
            const mfrFn = normalize(getFilename(imgUrl));
            const otherColorBetter = colorNames.some(otherName => {
              const no = normalize(otherName);
              if (no.length <= 2 || no === normSkuColorForMfr) return false;
              if (normSkuColorForMfr.includes(no)) return false;
              if (!mfrFn.includes(no)) return false;
              // Strictly longer color name always wins
              if (no.length > normSkuColorForMfr.length) return true;
              // Same-length or shorter: check compound position.
              // If both colors appear and the other comes first (e.g. "darkgrey"),
              // the image belongs to the other product.
              const ourPos = mfrFn.indexOf(normSkuColorForMfr);
              const otherPos = mfrFn.indexOf(no);
              if (ourPos >= 0 && otherPos >= 0 && otherPos < ourPos) return true;
              return false;
            });
            if (otherColorBetter) continue;
            // Classify manufacturer images (detect room scenes in filenames)
            // Decode %20 etc. so regex word boundaries work on URL-encoded filenames
            const mfrFnLower = decodeURIComponent(getFilename(imgUrl)).toLowerCase();
            let mfrClassification = 'closeup';
            if (/\bpart[e]?\s*(bagno|living|cucina)\b/i.test(mfrFnLower) ||
                /\bamb[_\s]/i.test(mfrFnLower) || /room.?scene/i.test(mfrFnLower) ||
                /\bRS\s*\d*/i.test(mfrFnLower)) {
              mfrClassification = 'roomscene';
            }
            candidates.push({
              url: imgUrl,
              filename: getFilename(imgUrl),
              classification: mfrClassification,
              source: 'manufacturer',
              score: s - 40, // Normalize: remove the +40 color base (gallery doesn't include it)
            });
          }

          // Sort by score descending
          candidates.sort((a, b) => b.score - a.score);

          // Filter out size-only filenames (e.g., "24x48.jpg") and generic banners
          const validCandidates = candidates.filter(c => {
            const fnLower = (c.filename || '').toLowerCase();
            if (/^\d+x\d+\.\w+$/.test(fnLower)) return false; // Size-only filename
            return true;
          });

          // Build effective name including URL pattern hints (for opaque CDN filenames)
          // IMPORTANT: Preserve separators (hyphens, underscores) — DO NOT use normalize() here.
          // detectFinishComponents splits on [\s,_-]+ and needs e.g. 'sixty_esagona_talco'
          // to tokenize as ['sixty','esagona','talco'], or 'nero-minibrick-lux.jpg'
          // as ['nero','minibrick','lux.jpg']. normalize() would strip all separators.
          const getEffectiveName = (cand) => {
            const fn = (cand.filename || '').toLowerCase();
            const hint = Object.entries(URL_PATTERN_HINTS).find(([k]) => (cand.url || '').includes(k));
            return hint ? hint[1].toLowerCase() + ' ' + fn : fn;
          };

          // ── Form-aware + surface-aware candidate ranking ──
          // Split candidates by form compatibility, then sub-sort by surface compatibility.
          // Form tiers: exact-form > partial-form > form-neutral > wrong-form
          // Surface sub-tiers (within each form tier): surface-match > surface-neutral > surface-wrong
          let rankedCandidates = validCandidates;

          // Surface sub-ranking: within a tier, prefer surface-compatible images
          // 4 sub-tiers: exact > partial > neutral > wrong
          //   exact:   all candidate surfaces are in SKU's set (no extra strong surfaces)
          //   partial: shares a surface but candidate has extra strong surfaces
          //   neutral: candidate has no surface keywords
          //   wrong:   no surfaces in common
          const STRONG_SURFACES = new Set([
            'polished', 'timbro', 'struttura', 'martellata', 'rullata',
            'minimal', 'bocciardato', 'wax', 'crosscut', 'veincut',
          ]);
          const rankBySurface = (arr) => {
            if (skuFC.surfaces.length === 0) return arr;
            // Treat "natural" as surface-neutral (base surface varies by collection)
            const skuSurfOnlyNatural = skuFC.surfaces.length === 1 && skuFC.surfaces[0] === 'natural';
            if (skuSurfOnlyNatural) return arr;
            const exact = [], partial = [], neutral = [], wrong = [];
            const skuSurfSet = new Set(skuFC.surfaces);
            for (const cand of arr) {
              const candFC = detectFinishComponents(getEffectiveName(cand));
              if (candFC.surfaces.length === 0) {
                neutral.push(cand);
              } else if (skuFC.surfaces.some(s => candFC.surfaces.includes(s))) {
                // Shares at least one surface — check for extra strong surfaces
                const extraStrong = candFC.surfaces.filter(
                  s => !skuSurfSet.has(s) && STRONG_SURFACES.has(s)
                );
                if (extraStrong.length > 0) {
                  partial.push(cand); // Has conflicting extra surface
                } else {
                  exact.push(cand);   // All candidate surfaces are compatible
                }
              } else {
                wrong.push(cand);
              }
            }
            // Within exact matches, prefer images that cover MORE of the SKU's
            // unique surfaces. E.g., for SKU with surfaces [struttura, crosscut],
            // an image with [struttura, crosscut] ranks above one with just [crosscut].
            if (exact.length > 1) {
              const uniqueSkuSurfs = [...new Set(skuFC.surfaces)];
              exact.sort((a, b) => {
                const aFC = detectFinishComponents(getEffectiveName(a));
                const bFC = detectFinishComponents(getEffectiveName(b));
                const aHits = uniqueSkuSurfs.filter(s => aFC.surfaces.includes(s)).length;
                const bHits = uniqueSkuSurfs.filter(s => bFC.surfaces.includes(s)).length;
                return bHits - aHits; // More surface coverage = higher rank
              });
            }
            return [...exact, ...partial, ...neutral, ...wrong];
          };

          if (skuFC.forms.length > 0) {
            const formExact = [];     // Has ALL of SKU's forms (e.g. cobblestone+mosaico)
            const formPartial = [];   // Has SOME of SKU's forms (e.g. cobblestone only)
            const formNeutral = [];   // No form info (base tiles, banners)
            const formWrong = [];     // Has a DIFFERENT form
            for (const cand of validCandidates) {
              const effectiveFn = getEffectiveName(cand);
              const candFC = detectFinishComponents(effectiveFn);
              if (candFC.forms.length === 0) {
                formNeutral.push(cand);
              } else if (skuFC.forms.every(f => candFC.forms.includes(f))) {
                formExact.push(cand);
              } else if (skuFC.forms.some(f => candFC.forms.includes(f))) {
                formPartial.push(cand);
              } else {
                formWrong.push(cand);
              }
            }
            rankedCandidates = [
              ...rankBySurface(formExact),
              ...rankBySurface(formPartial),
              ...rankBySurface(formNeutral),
              ...rankBySurface(formWrong),
            ];
          } else {
            // No form requirement: just rank by surface compatibility
            rankedCandidates = rankBySurface(validCandidates);
          }

          // ── Text overlay deprioritization ──
          // Images with known text overlays (collection names, labels) are pushed
          // behind clean close-ups, but kept AHEAD of room scenes and banners.
          // A product shot with text labels is still better than a room scene.
          {
            const clean = rankedCandidates.filter(c => !hasTextOverlay(c.url));
            const textOverlay = rankedCandidates.filter(c => hasTextOverlay(c.url));
            if (clean.length > 0 && textOverlay.length > 0) {
              const cleanCloseups = clean.filter(c => c.classification === 'closeup');
              const cleanNonCloseups = clean.filter(c => c.classification !== 'closeup');
              rankedCandidates = [...cleanCloseups, ...textOverlay, ...cleanNonCloseups];
            }
          }

          // ── Form compatibility helper ──
          // Returns true if image is form-compatible with the SKU:
          //   - Image has no form info → OK (neutral/generic, works for any SKU)
          //   - SKU has no form, image HAS form → REJECT (don't show mosaico for base tiles)
          //   - Both have forms → all image forms must exist in SKU's forms
          //     (prevents "cobblestone mosaico" image for plain "cobblestone" SKU)
          const isFormOk = (cand) => {
            const effectiveFn = typeof cand === 'string' ? cand : getEffectiveName(cand);
            const candFC = detectFinishComponents(effectiveFn);
            if (candFC.forms.length === 0) return true; // No form info = neutral
            if (skuFC.forms.length === 0) return false;  // SKU has no form, image does
            return candFC.forms.every(f => skuFC.forms.includes(f));
          };

          // ── PRIMARY: Best scoring image for this SKU ──
          // Cross-color safety: verify the primary's filename (or URL hint) contains our color
          // (prevents wrong-color images when no color-specific images exist for this SKU)
          let primary = null;

          // Check for direct primary override (e.g. Decoro "Mediterranea" patterns
          // whose gallery images are named "Decora-N" and can't be color-matched)
          // Supports two formats:
          //   string → applies to ALL SKUs of this product
          //   object → finish-level override (e.g. { 'quarter round': url })
          let directOverrideUrl = null;
          const overrideEntry = DIRECT_PRIMARY_OVERRIDES[collectionName]?.[product.name];
          if (typeof overrideEntry === 'string') {
            directOverrideUrl = overrideEntry;
          } else if (overrideEntry && typeof overrideEntry === 'object') {
            const finishLower = (skuFinish || '').toLowerCase();
            directOverrideUrl = overrideEntry[finishLower] || null;
          }
          if (directOverrideUrl) {
            primary = { url: directOverrideUrl, source: 'override', classification: 'closeup' };
          }

          const normSkuColorPrim = normalize(skuColor);

          if (!primary) for (const cand of rankedCandidates) {
            // Form check: skip images with wrong product shape
            if (!isFormOk(cand)) continue;
            const effective = getEffectiveName(cand);
            // Normalize effective name for color substring matching (strip separators)
            const effectiveNorm = normalize(effective);
            // Also check alt text for color (gallery images matched by alt text may have
            // opaque filenames like "newkauri.jpg" for color "Awanui")
            const altNorm = cand.altText ? normalize(cand.altText) : '';
            const colorSearchStr = effectiveNorm + ' ' + altNorm;
            // Accept if: filename/hint/alt contains our color, or our color is too short to check
            if (normSkuColorPrim.length <= 2 || colorSearchStr.includes(normSkuColorPrim)) {
              primary = cand; break;
            }
            // Also try color aliases
            const aliases = COLOR_ALIASES[normSkuColorPrim] || [];
            if (aliases.some(a => colorSearchStr.includes(a))) { primary = cand; break; }
            // Try individual base words for multi-word colors
            const baseWords = skuColor.split(/\s+/)
              .filter(w => w.length >= 3 && !finishWordSet.has(w.toLowerCase()));
            if (baseWords.some(w => colorSearchStr.includes(normalize(w)))) { primary = cand; break; }
            // Skip wrong-color candidates
          }
          // Fallback: if filename check failed but candidate is from colorGallery (already
          // color-verified via alt text), trust that verification. Prefer closeups.
          if (!primary) {
            for (const cand of rankedCandidates) {
              if (!isFormOk(cand)) continue;
              if (cand.source === 'gallery' && cand.classification === 'closeup') {
                primary = cand; break;
              }
            }
          }
          // Last resort: any form-compatible gallery image (room scene, banner, etc.)
          if (!primary) {
            for (const cand of rankedCandidates) {
              if (!isFormOk(cand)) continue;
              if (cand.source === 'gallery') {
                primary = cand; break;
              }
            }
          }
          // Final fallback: any form-compatible candidate
          if (!primary) {
            for (const cand of rankedCandidates) {
              if (!isFormOk(cand)) continue;
              primary = cand; break;
            }
          }
          // If still nothing (all candidates had wrong form), use a collection banner
          // over a wrong-form product image — generic is better than misleading
          if (!primary && banners.length > 0) {
            const banner = banners[0];
            primary = { url: banner.url, filename: banner.filename, classification: 'banner', source: 'gallery', score: -20 };
          }
          if (!primary && rankedCandidates.length > 0) {
            primary = rankedCandidates[0]; // Absolute last resort
          }
          if (primary) {
            const url = unwrapImageUrl(primary.url);
            assignedUrls.push(url);
            const primaryFn = getFilename(primary.url).toLowerCase();
            assignedFilenames.add(primaryFn);
            // Track for sibling alternate filtering (only store first usage)
            if (!siblingPrimaries.has(primaryFn)) {
              siblingPrimaries.set(primaryFn, skuFinish || '');
            }
          }

          // ── ALTERNATES: Next best images (up to 2) ──
          for (const cand of rankedCandidates) {
            if (assignedUrls.length >= 3) break; // 1 primary + 2 alternates
            const fn = getFilename(cand.url).toLowerCase();
            if (assignedFilenames.has(fn)) continue;
            const url = unwrapImageUrl(cand.url);
            if (assignedUrls.includes(url)) continue;
            // Skip images that are a sibling's primary with a DIFFERENT finish
            // (e.g., 24x48 Tech Polished primary shouldn't be alternate for 8x48 Polished)
            // Same-finish siblings can share (e.g., 12x24 Martellata alt for 24x48 Martellata)
            if (siblingPrimaries.has(fn)) {
              const sibFinish = siblingPrimaries.get(fn);
              if (sibFinish !== (skuFinish || '')) continue;
            }
            // Score threshold for alternates
            if (cand.score < -10) continue;
            // Block wrong-form and wrong-surface alternates
            {
              const altEffective = getEffectiveName(cand);
              const candFC = detectFinishComponents(altEffective);
              // Form check: block images with wrong product shape
              if (candFC.forms.length > 0) {
                if (skuFC.forms.length > 0) {
                  // SKU has form → all candidate forms must be in SKU's forms
                  if (!candFC.forms.every(f => skuFC.forms.includes(f))) continue;
                } else {
                  // SKU has NO form (base tile) → don't show hex/minibrick/mosaico
                  continue;
                }
              }
              // Surface check: block alternates with wrong/extra surface treatment
              // Two-tier check:
              //   1. Base: at least one surface must match (or SKU has none)
              //   2. Extra: block if candidate has additional "strong" surface keywords
              //      not in SKU's set (prevents e.g., lapato alt for non-lapato SKU)
              if (skuFC.surfaces.length > 0 && candFC.surfaces.length > 0) {
                if (!skuFC.surfaces.some(s => candFC.surfaces.includes(s))) continue;
                // Block if candidate has strong surfaces NOT in SKU's surface set
                // "Strong" = visually distinct surface treatments (not collection-level labels)
                const STRONG_SURFACES = new Set([
                  'polished', 'timbro', 'struttura', 'martellata', 'rullata',
                  'minimal', 'bocciardato', 'wax', 'crosscut', 'veincut',
                ]);
                const skuSurfSet = new Set(skuFC.surfaces);
                const extraStrong = candFC.surfaces.filter(
                  s => !skuSurfSet.has(s) && STRONG_SURFACES.has(s)
                );
                if (extraStrong.length > 0) continue;
              }
            }
            // Block wrong-color alternates: verify filename contains the right color
            // and doesn't also match a DIFFERENT product color in this collection
            const fnNorm = normalize(fn);
            const normSkuColor = normalize(skuColor);
            if (normSkuColor.length > 2) {
              const effectiveAlt = (() => {
                const hint = Object.entries(URL_PATTERN_HINTS).find(([k]) => cand.url.includes(k));
                return hint ? normalize(hint[1]) + ' ' + fnNorm : fnNorm;
              })();
              let colorInFn = effectiveAlt.includes(normSkuColor);
              if (!colorInFn) {
                const aliases = COLOR_ALIASES[normSkuColor] || [];
                colorInFn = aliases.some(a => effectiveAlt.includes(a));
              }
              // Try individual words for multi-word color names (e.g. "beige minimal")
              if (!colorInFn) {
                const allFW = new Set();
                for (const [key, syns] of Object.entries(FINISH_SYNONYMS)) { allFW.add(key); for (const s of syns) allFW.add(s); }
                const skuColorWords = skuColor.split(/\s+/).filter(w => w.length >= 3 && !allFW.has(w.toLowerCase()));
                colorInFn = skuColorWords.some(w => {
                  const nw = normalize(w);
                  return nw.length >= 3 && effectiveAlt.includes(nw);
                });
              }
              if (!colorInFn) continue; // Wrong color — skip
              // Also reject if filename matches a DIFFERENT product color more
              // specifically. E.g. "darkgrey" → Dark product owns this, Grey should not get it.
              // Logic: if another color appears in the filename AND that other color starts
              // at an earlier or same position as our color, the image belongs to them.
              const ourPos = effectiveAlt.indexOf(normSkuColor);
              const otherColorMatch = colorNames.some(otherName => {
                const no = normalize(otherName);
                if (no.length <= 2) return false;
                if (no === normSkuColor) return false;
                if (normSkuColor.includes(no)) return false; // our color contains this one (sub-word)
                if (!effectiveAlt.includes(no)) return false;
                // Both colors are in the filename — reject if the other color
                // comes first (it's a compound like "darkgrey" → Dark's image)
                const otherPos = effectiveAlt.indexOf(no);
                return otherPos <= ourPos;
              });
              if (otherColorMatch) continue;
            }
            assignedUrls.push(url);
            assignedFilenames.add(fn);
          }

          // ── LIFESTYLE: Collection banner or generic room scene ──
          if (assignedUrls.length < MAX_IMAGES_PER_SKU && banners.length > 0) {
            const banner = banners[0];
            const fn = getFilename(banner.url).toLowerCase();
            if (!assignedFilenames.has(fn)) {
              const url = unwrapImageUrl(banner.url);
              if (!assignedUrls.includes(url)) {
                assignedUrls.push(url);
              }
            }
          }

          // Upsert assigned images
          for (let i = 0; i < assignedUrls.length; i++) {
            const assetType = i === 0 ? 'primary' : (i <= 2 ? 'alternate' : 'lifestyle');
            await upsertMediaAsset(pool, {
              product_id: product.id,
              sku_id: sku.sku_id,
              asset_type: assetType,
              url: assignedUrls[i],
              original_url: assignedUrls[i],
              sort_order: i,
            });
          }

          imagesSaved += assignedUrls.length;
          if (assignedUrls.length > 0) skuAssigned++;
        }

        productsMatched++;
        console.log(`  [ASSIGNED] ${collectionName} / ${product.name}: ${colorGallery.length} gallery → ${skuAssigned}/${skuDetails.length} SKUs`);
      }
    }

    // ── Summary ──────────────────────────────────────────────────────

    console.log(`\n=== Scrape Complete ===`);
    console.log(`Products matched: ${productsMatched} / ${prodRows.rowCount}`);
    console.log(`Total images saved: ${imagesSaved}`);

    // Coverage stats
    const coverageRes = await pool.query(`
      SELECT COUNT(DISTINCT s.id) AS with_images,
             (SELECT COUNT(*) FROM skus s2 JOIN products p2 ON s2.product_id = p2.id
              JOIN vendors v2 ON p2.vendor_id = v2.id WHERE v2.code = 'MELANGE') AS total
      FROM skus s
      JOIN products p ON s.product_id = p.id
      JOIN vendors v ON p.vendor_id = v.id
      JOIN media_assets ma ON ma.sku_id = s.id
      WHERE v.code = 'MELANGE'
    `);
    if (coverageRes.rows.length > 0) {
      const { with_images, total } = coverageRes.rows[0];
      const pct = total > 0 ? ((with_images / total) * 100).toFixed(1) : '0';
      console.log(`Coverage: ${with_images}/${total} SKUs with images (${pct}%)`);
    }

  } finally {
    await browser.close();
    await pool.end();
  }
}

run().catch(err => { console.error(err); process.exit(1); });
