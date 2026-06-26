import {
  launchBrowser, delay,
  upsertProduct, upsertSku, upsertSkuAttribute,
  upsertPricing, upsertPackaging, upsertInventorySnapshot,
  appendLog, addJobError,
  upsertMediaAsset,
  normalizeSize, buildVariantName,
} from './base.js';

// ──────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────

const DEFAULT_CONFIG = {
  delayMs: 2000,
  concurrency: 1,   // pages at a time (be polite to WooCommerce)
};

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// WooCommerce breadcrumb category → PIM category slug
const CATEGORY_MAP = {
  'porcelain':        'porcelain-tile',
  'vinyl':            'lvp-plank',
  'countertop slab':  'quartz-countertops',
  'countertop slabs': 'quartz-countertops',
  'kitchen cabinets': null,  // skip
};

// Title keywords that override category to wood-look-tile
const WOOD_LOOK_RE = /\bwood[\s-]*look\b|\bwood[\s-]*effect\b|\bsequoia\b|\baspen\b|\bhardwood\b|\bessenze[\s-]*lignee\b/i;

// Parse size from product title: "24x48", "24"×48"", "48x48", "8x48", "16x16", "32x32"
const TITLE_SIZE_RE = /(\d+\.?\d*)\s*["″]?\s*[x×X]\s*(\d+\.?\d*)\s*["″]?/;

// Detect SPC/vinyl products from title
const VINYL_RE = /\b(spc|vinyl|rigid[\s-]*core)\b/i;

// Countertop slab product names (from Page 6 + L-series of the dealer price list).
// These are large-format porcelain slabs priced $8-14/sf, distinct from regular tiles.
const SLAB_PRODUCT_NAMES = new Set([
  'alpine', 'aurelius', 'bianco superior', 'black raj', 'blue eagle', 'brown persa',
  'calacatta', 'calacatta black', 'calacatta da vinci', 'calacatta gold',
  'carrara', 'cristallo', 'delicattus',
  'ete et serena', 'feline', 'feline crystal', 'frost cz', 'fusion',
  'gabana', 'gold macaubas', 'gvx desert silver',
  'l01', 'l02', 'l03', 'l03m', 'l04', 'l05', 'l06', 'l07', 'l08',
  'lunar', 'marmorea carrara', 'marmorea verde alpi', 'matarazzo', 'matira',
  'matrix', 'meridian', 'mountain mist',
  'multifios bidese', 'multifios breton', 'multifios hedel',
  'natural granite', 'nebulato azul', 'nero marquinia', 'nilo',
  'onic', 'opus white', 'orinoco',
  'pedre', 'perla santana', 'platino',
  'quartzito azul', 'reverse', 'rosso verona', 'ruby fusion',
  'siberia', 'super white calacatta', 'tempest blue', 'titanium',
  'vancouver', 'waterfall', 'white paradise',
]);

// ──────────────────────────────────────────────
// Attribute Classification Data
// ──────────────────────────────────────────────

// Color overrides for products whose color isn't derivable from the title
const COLOR_OVERRIDES = {
  '7a101': 'Gray',
  'albany': 'Gray',
  'alpine': 'White',
  'aspen': 'Beige',
  'augusto': 'Gray',
  'bianco superior': 'White',
  'black raj': 'Black',
  'blond': 'Beige',
  'blue eagle': 'Blue',
  'blue forest': 'Blue',
  'boston': 'Gray',
  'brown persa': 'Brown',
  'calacatta': 'White',
  'carrara': 'White',
  'crema roma': 'Cream',
  'dallas': 'Gray',
  'dark rose': 'Brown',
  'delicattus': 'Beige',
  'feline': 'Gray',
  'fusion': 'White',
  'gabana': 'Gray',
  'gery': 'Gray',
  'gold macaubas': 'Gold',
  'houston': 'Brown',
  'jtf962861': 'Gray',
  'jtf962901': 'Gray',
  'jtf98007a01': 'Beige',
  'l01': 'White',
  'l02': 'Gray',
  'l03': 'White',
  'l03m': 'White',
  'l04': 'Gray',
  'l05': 'Beige',
  'l06': 'Brown',
  'l07': 'Black',
  'l08': 'Gray',
  'lunar': 'Gray',
  'matarazzo': 'Brown',
  'matira': 'Gray',
  'matrix': 'Gray',
  'meridian': 'Beige',
  'mountain mist': 'Gray',
  'natural granite': 'Gray',
  'natural terrazzo': 'Gray',
  'nero marquinia': 'Black',
  'nilo': 'Brown',
  'onic': 'White',
  'orinoco': 'Brown',
  'palma': 'Beige',
  'pedre': 'Gray',
  'perla santana': 'Beige',
  'platino': 'Gray',
  'reverse': 'Gray',
  'rigid core': 'Gray',
  'roma': 'Beige',
  'rosso verona': 'Red',
  'ruby fusion': 'Red',
  'sequoia maxi': 'Beige',
  'siberia': 'White',
  'taj mahal': 'Gold',
  'titanium': 'Gray',
  'vancouver': 'White',
  'waterfall': 'White',
  'white paradise': 'White',
};

// Finish: products with polished finish (default is Matte for porcelain)
const POLISHED_PRODUCTS = new Set([
  'bracciano pearl', 'calacatta', 'calacatta black', 'calacatta gold',
  'calacatta da vinci', 'carrara', 'feline', 'feline crystal',
  'fusion', 'gabana', 'gold macaubas', 'labradorite blue',
  'lilac purple', 'lunar', 'lux danae navi', 'marmorea carrara',
  'marmorea verde alpi', 'marvel gray', 'nebulato azul', 'nero marquinia',
  'oni coral super', 'oni pearl super', 'oni white super',
  'quartzito azul', 'ruby fusion', 'serene bianco',
  'star emerald', 'star indigo', 'star purple',
  'super white calacatta', 'taj mahal', 'tempest blue',
]);

// Finish: products with lappato finish
const LAPPATO_PRODUCTS = new Set([
  'aeterna grey', 'amazona jade', 'arno azzurro', 'augusto',
  'blue forest', 'crema roma', 'dark rose', 'ekali noir',
  'elegance white', 'gare white gray', 'horton white',
  'illusion snow', 'macauba azul', 'olympia white',
  'pisa gold', 'scarlet black', 'scarlet blle', 'scarlet white',
  'silke blanco', 'silke gris', 'viken beige',
]);

// Look mapping: [name_prefix, look_value]
const LOOK_MAP = [
  // Specific collections first
  ['natural terrazzo', 'Terrazzo'],
  ['marmette', 'Terrazzo'],
  ['natural granite', 'Granite'],
  ['sequoia maxi', 'Wood'],
  ['cromatic', 'Solid'],
  ['paint ', 'Solid'],
  ['spark blanco', 'Solid'],

  // Wood-look tiles
  ['aspen', 'Wood'], ['au dusk', 'Wood'], ['axe', 'Wood'], ['blond', 'Wood'],
  ['bois de lille', 'Wood'], ['essential', 'Wood'], ['gery', 'Wood'],
  ['heisinki', 'Wood'], ['ikon amber', 'Wood'], ['jet antracita', 'Wood'],
  ['jungle blanco', 'Wood'], ['km blanco', 'Wood'], ['komi noce', 'Wood'],
  ['mukali', 'Wood'], ['neowood', 'Wood'], ['tmg', 'Wood'],
  ['wetwood', 'Wood'], ['multifios', 'Wood'],

  // LVP / SPC vinyl
  ['dallas', 'Wood'], ['houston', 'Wood'], ['7a101', 'Wood'],
  ['jtf', 'Wood'], ['rigid core', 'Wood'],

  // Marble-look
  ['calacatta', 'Marble'], ['carrara', 'Marble'], ['taj mahal', 'Marble'],
  ['bianco superior', 'Marble'], ['statuario', 'Marble'],
  ['marmorea', 'Marble'], ['nero marquinia', 'Marble'],
  ['bracciano', 'Marble'], ['crema roma', 'Marble'],
  ['oni ', 'Marble'], ['serene', 'Marble'], ['siberia', 'Marble'],
  ['super white calacatta', 'Marble'], ['olympia', 'Marble'],
  ['pamesa crema marfil', 'Marble'], ['white paradise', 'Marble'],
  ['elegance white', 'Marble'], ['illusion snow', 'Marble'],
  ['horton white', 'Marble'], ['gare white', 'Marble'],

  // Stone-look
  ['alpine', 'Stone'], ['black raj', 'Stone'], ['brown persa', 'Stone'],
  ['delicattus', 'Stone'], ['gold macaubas', 'Stone'],
  ['labradorite', 'Stone'], ['matarazzo', 'Stone'], ['matira', 'Stone'],
  ['matrix', 'Stone'], ['meridian', 'Stone'], ['mountain mist', 'Stone'],
  ['nilo', 'Stone'], ['orinoco', 'Stone'], ['pedre', 'Stone'],
  ['perla santana', 'Stone'], ['platino', 'Stone'], ['reverse', 'Stone'],
  ['rosso verona', 'Stone'], ['ruby fusion', 'Stone'],
  ['titanium', 'Stone'], ['vancouver', 'Stone'], ['waterfall', 'Stone'],
  ['aurelius', 'Stone'], ['feline', 'Stone'], ['frost cz', 'Stone'],
  ['fusion', 'Stone'], ['gabana', 'Stone'], ['lunar', 'Stone'],
  ['nebulato', 'Stone'], ['quartzito', 'Stone'], ['tempest', 'Stone'],
  ['star ', 'Stone'], ['onic', 'Stone'], ['opus white', 'Stone'],
  ['blue eagle', 'Stone'], ['cristallo', 'Stone'],
  ['gvx desert silver', 'Stone'], ['ete et serena', 'Stone'],
  ['mazero gold', 'Stone'], ['sybil silver', 'Stone'],
  ['pisa gold', 'Stone'], ['dark rose', 'Stone'],
  ['scarlet', 'Stone'], ['lilac purple', 'Stone'],
  ['macauba azul', 'Stone'], ['amazona jade', 'Stone'],
  ['arno azzurro', 'Stone'], ['augusto', 'Stone'],
  ['blue forest', 'Stone'], ['ekali noir', 'Stone'],
  ['lux danae', 'Stone'], ['marvel', 'Stone'],
  ['silke', 'Stone'], ['aeterna', 'Stone'], ['viken', 'Stone'],

  // Concrete/cement-look
  ['albany', 'Concrete'], ['boston', 'Concrete'], ['cf light', 'Concrete'],
  ['montclair', 'Concrete'], ['coreu gris', 'Concrete'],
  ['la blue', 'Concrete'], ['roma', 'Concrete'], ['palma', 'Concrete'],
  ['segesta', 'Concrete'], ['toscana', 'Concrete'], ['astro', 'Concrete'],

  // L-series slabs
  ['l01', 'Marble'], ['l02', 'Stone'], ['l03', 'Marble'],
  ['l03m', 'Marble'], ['l04', 'Stone'], ['l05', 'Stone'],
  ['l06', 'Stone'], ['l07', 'Stone'], ['l08', 'Stone'],
];

// Size mapping: product name prefix → tile size (from dealer price list)
const SIZE_MAP = [
  ['aeterna', '24x48'],
  ['albany', '24x24'],
  ['amazona jade', '24x48'],
  ['arno azzurro', '24x48'],
  ['aspen', '8x48'],
  ['astro', '24x48'],
  ['augusto', '24x48'],
  ['au dusk', '8x48'],
  ['axe', '8x48'],
  ['blond', '8x48'],
  ['blue forest', '24x48'],
  ['bois de lille', '8x48'],
  ['boston', '24x24'],
  ['bracciano', '24x48'],
  ['cf light', '32x32'],
  ['coreu gris', '24x24'],
  ['crema roma', '24x48'],
  ['cromatic black', '24x24'],
  ['cromatic blanco', '24x24'],
  ['dark rose', '24x48'],
  ['ekali noir', '24x48'],
  ['elegance white', '24x48'],
  ['essential', '8x48'],
  ['gare white', '24x48'],
  ['gery', '8x48'],
  ['heisinki', '8x48'],
  ['horton white', '24x48'],
  ['ikon amber', '8x48'],
  ['illusion snow', '24x48'],
  ['jet antracita', '8x48'],
  ['jungle blanco', '8x48'],
  ['km blanco', '8x48'],
  ['komi noce', '8x48'],
  ['la blue grigio', '24x24'],
  ['la blue nero', '24x24'],
  ['labradorite blue', '24x48'],
  ['lilac purple', '24x48'],
  ['lux danae', '24x48'],
  ['macauba azul', '24x48'],
  ['marmette bianco', '24x24'],
  ['marmette jeans', '24x24'],
  ['marmette mix', '24x24'],
  ['marvel', '24x48'],
  ['mazero gold', '24x48'],
  ['montclair blanco', '24x24'],
  ['montclair ivory', '24x24'],
  ['montclair perla', '24x24'],
  ['mukali', '8x48'],
  ['natural terrazzo', '16x16'],
  ['neowood', '8x48'],
  ['olympia white', '24x48'],
  ['oni coral', '24x48'],
  ['oni pearl', '24x48'],
  ['oni white', '24x48'],
  ['paint blue', '24x48'],
  ['paint gray', '24x48'],
  ['paint rose', '24x48'],
  ['paint salvia', '24x48'],
  ['paint white', '24x48'],
  ['palma', '24x48'],
  ['pamesa crema marfil', '24x48'],
  ['pisa gold', '24x48'],
  ['roma', '24x48'],
  ['scarlet black', '24x48'],
  ['scarlet blle', '24x48'],
  ['scarlet white', '24x48'],
  ['segesta ivory', '24x48'],
  ['sequoia maxi', '9x48'],
  ['serene', '24x48'],
  ['silke blanco', '24x48'],
  ['silke gris', '24x48'],
  ['spark blanco', '35x35'],
  ['star emerald', '24x48'],
  ['star indigo', '24x48'],
  ['star purple', '24x48'],
  ['sybil silver', '24x48'],
  ['taj mahal', '24x48'],
  ['toscana', '24x48'],
  ['viken', '24x48'],
  ['wetwood', '7x47'],
  ['tmg', '8x48'],

  // LVP / SPC vinyl
  ['dallas', '7x48'],
  ['houston', '7x48'],
  ['7a101', '7x48'],
  ['jtf962861', '7x48'],
  ['jtf962901', '7x48'],
  ['jtf98007', '7x48'],
  ['rigid core', '7x48'],
];

// Application by PIM category slug
const APP_BY_SLUG = {
  'porcelain-tile': 'Floor & Wall',
  'wood-look-tile': 'Floor & Wall',
  'porcelain-slabs': 'Countertop',
  'lvp-plank': 'Floor',
};

// Material by PIM category slug
const MATERIAL_BY_SLUG = {
  'porcelain-tile': 'Porcelain',
  'wood-look-tile': 'Porcelain',
  'porcelain-slabs': 'Sintered Stone',
  'lvp-plank': 'SPC Vinyl',
};

/** Find look attribute from product name */
function findLook(productName) {
  const lower = productName.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  for (const [pattern, look] of LOOK_MAP) {
    if (lower.startsWith(pattern) || lower.includes(pattern)) return look;
  }
  return null;
}

/** Find size from the price list SIZE_MAP when title parsing doesn't extract one */
function findSize(productName) {
  const norm = normalizeName(productName);
  const sorted = [...SIZE_MAP].sort((a, b) => b[0].length - a[0].length);
  for (const [pattern, size] of sorted) {
    if (norm.startsWith(normalizeName(pattern))) return size;
  }
  return null;
}

// ──────────────────────────────────────────────
// Price List Filter
// ──────────────────────────────────────────────

// Unique name patterns from the Orion dealer price list (Q4-2025 PDF).
// Products not matching any pattern are skipped during scraping.
const PRICE_LIST_PATTERNS = [
  'AETERNA', 'ALBANY', 'AMAZONA JADE', 'ALPINE', 'ARNO AZZURRO', 'ASPEN',
  'ASTRO', 'AUGUSTO', 'AURELIUS', 'AU DUSK', 'AXE',
  'BIANCO SUPERIOR', 'BLACK RAJ', 'BLOND', 'BLUE EAGLE', 'BLUE FOREST',
  'BOIS DE LILLE', 'BOSTON', 'BRACCIANO', 'BROWN PERSA',
  'CF LIGHT', 'CALACATTA', 'CALACATTA BLACK', 'CALACATTA DA VINCI',
  'CALACATTA GOLD', 'CARRARA', 'COREU GRIS', 'CREMA ROMA',
  'CRISTALLO', 'CROMATIC BLACK', 'CROMATIC BLANCO',
  'DALLAS', 'DARK ROSE', 'DELICATTUS',
  'EKALI NOIR', 'ELEGANCE WHITE', 'ESSENTIAL', 'ETE ET SERENA',
  'FELINE', 'FELINE CRYSTAL', 'FROST CZ', 'FUSION',
  'GABANA', 'GARE WHITE', 'GERY', 'GOLD MACAUBAS', 'GVX DESERT SILVER',
  'HEISINKI', 'HORTON WHITE', 'HOUSTON',
  'IKON AMBER', 'ILLUSION SNOW', 'IVORY',
  'JET ANTRACITA', 'JTF962861', 'JTF962901', 'JTF98007', 'JUNGLE BLANCO',
  'KM BLANCO', 'KOMI NOCE',
  'L01', 'L02', 'L03', 'L03M', 'L04', 'L05', 'L06', 'L07', 'L08',
  'LA BLUE GRIGIO', 'LA BLUE NERO', 'LABRADORITE BLUE',
  'LILAC PURPLE', 'LUNAR', 'LUX DANAE',
  'MACAUBA AZUL', 'MARMETTE BIANCO', 'MARMETTE JEANS', 'MARMETTE MIX',
  'MARMOREA CARRARA', 'MARMOREA VERDE ALPI', 'MARVEL',
  'MATARAZZO', 'MATIRA', 'MATRIX', 'MAZERO GOLD', 'MERIDIAN',
  'MONTCLAIR BLANCO', 'MONTCLAIR IVORY', 'MONTCLAIR PERLA',
  'MOUNTAIN MIST', 'MUKALI', 'MULTIFIOS BIDESE', 'MULTIFIOS BRETON', 'MULTIFIOS HEDEL',
  'NATURAL GRANITE', 'NATURAL TERRAZZO', 'NEBULATO AZUL', 'NEOWOOD',
  'NERO MARQUINIA', 'NILO',
  'OLYMPIA WHITE', 'ONI CORAL', 'ONI PEARL', 'ONI WHITE', 'ONIC',
  'OPUS WHITE', 'ORINOCO',
  'PAINT BLUE', 'PAINT GRAY', 'PAINT ROSE', 'PAINT SALVIA', 'PAINT WHITE',
  'PALMA', 'PAMESA CREMA MARFIL', 'PEDRE', 'PERLA SANTANA', 'PISA GOLD', 'PLATINO',
  'QUARTZITO AZUL',
  'REVERSE', 'RIGID CORE', 'ROMA', 'ROSSO VERONA', 'RUBY FUSION',
  'SCARLET BLACK', 'SCARLET BLLE', 'SCARLET WHITE',
  'SEGESTA IVORY', 'SEQUOIA MAXI', 'SERENE', 'SIBERIA',
  'SILKE BLANCO', 'SILKE GRIS', 'SPARK BLANCO',
  'STAR EMERALD', 'STAR INDIGO', 'STAR PURPLE',
  'STUDIO', 'SUPER BLACK', 'SUPER WHITE', 'SUPER WHITE CALACATTA',
  'SWEDEN', 'SYBIL SILVER',
  'TAJ MAHAL', 'TARTAN', 'TEMPEST BLUE', 'TERRANOVA', 'TIME', 'TITANIUM',
  'TMG', 'TOSCANA', 'TRAZZO', 'TUDOR',
  'VANCOUVER', 'VERMONT MIX', 'VIKEN', 'VOSGES',
  'WATERFALL', 'WETWOOD', 'WHITE M3600H', 'WHITE M3900H', 'WHITE M3900HY',
  'WHITE PARADISE', 'WOOD NOCE', 'WOODEN WILLOW',
  '7A101',
];

/** Normalize a name for fuzzy matching: lowercase, strip accents/punctuation, collapse whitespace */
function normalizeName(str) {
  return str.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[""''|()\/\\,\-–—.×&]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Check if a cleaned product name matches any price list pattern */
function isInPriceList(productName) {
  const norm = normalizeName(productName);
  // Sort longest first so more specific patterns match before generic ones
  for (const pattern of PRICE_LIST_PATTERNS) {
    const normPat = normalizeName(pattern);
    if (norm.startsWith(normPat)) return true;
  }
  return false;
}

// ──────────────────────────────────────────────
// Image Classification
// ──────────────────────────────────────────────

/**
 * Classify gallery images for an Orion product page.
 *
 * Uses full-size image dimensions (loaded in the browser) to distinguish:
 *   - Lifestyle room scenes: ratio ~0.88 (always image[0], 1200×1358)
 *   - Product swatches: very portrait, ratio < 0.7 (typically 0.34–0.56)
 *   - Orion branded cards: square or landscape, ratio >= 0.9 (logo + product name + size)
 *
 * Rules:
 *   1. Always skip image[0] (lifestyle room scene hero)
 *   2. Skip Orion branded cards (ratio >= 0.9 among non-hero images)
 *   3. Product primary = the most portrait image (lowest ratio, i.e. tallest)
 *   4. If multiple portrait images exist, first is primary, second is alternate
 *   5. Any remaining images with ratio 0.7–0.88 are additional lifestyle shots
 *
 * @param {Array<{url: string, w: number, h: number}>} images - Gallery images with dimensions
 * @returns {{ primary: string|null, alternate: string|null, lifestyle: string[] }}
 */
function classifyOrionImages(images) {
  const result = { primary: null, alternate: null, lifestyle: [] };
  if (!images || images.length === 0) return result;

  // Filter out branded cards — Orion composite marketing images are always 1200×1358
  const candidates = [];
  for (const img of images) {
    if (!img.url) continue;
    if (isBrandedCard(img)) continue;
    candidates.push(img);
  }

  if (candidates.length === 0) return result;

  // Pick the most portrait image (lowest w/h ratio) as primary — that's the
  // close-up product swatch/tile photo. Landscape images are room scenes/lifestyle.
  let primaryIdx = 0;
  let lowestRatio = Infinity;
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const ratio = (c.w && c.h) ? c.w / c.h : 1;
    if (ratio < lowestRatio) {
      lowestRatio = ratio;
      primaryIdx = i;
    }
  }

  result.primary = candidates[primaryIdx].url;
  for (let i = 0; i < candidates.length; i++) {
    if (i === primaryIdx) continue;
    if (!result.alternate) {
      result.alternate = candidates[i].url;
    } else {
      result.lifestyle.push(candidates[i].url);
    }
  }

  return result;
}

/** Detect Orion branded composite cards (lifestyle + swatch + logo overlay).
 *  They are always exactly 1200×1358 pixels.
 *  When Image() probing succeeds we trust the dimensions.
 *  Filename fallback ("Main"/"Mian") is only used when dimensions are unknown. */
function isBrandedCard(img) {
  // Exact dimension match (the branded card template is always this size)
  if (img.w === 1200 && img.h === 1358) return true;
  // Close match (within 5px tolerance for any rescaling)
  if (img.w && img.h
      && Math.abs(img.w - 1200) <= 5
      && Math.abs(img.h - 1358) <= 5) return true;
  // If we have valid dimensions that clearly aren't a branded card, trust them
  if (img.w && img.h) return false;
  // Filename-based detection (only when dimensions are unknown):
  // Branded cards use "Main" or "Mian" (typo) in filename.
  // Exclude "-imgN" suffixed variants (e.g. Mian-img3.jpg) which are real product photos.
  if (img.url) {
    const filename = img.url.split('/').pop() || '';
    if (/main|mian/i.test(filename) && !/(main|mian)-?img/i.test(filename)) return true;
  }
  return false;
}

/**
 * Strip WordPress thumbnail dimension suffix from image URL.
 * "https://...image-300x200.jpg" → "https://...image.jpg"
 */
function stripWpThumbSuffix(url) {
  if (!url) return url;
  return url.replace(/-\d+x\d+(\.\w+)(?:\?.*)?$/, '$1');
}

// ──────────────────────────────────────────────
// Title / Product Parsing
// ──────────────────────────────────────────────

/**
 * Parse an Orion product title into structured fields.
 *
 * Examples:
 *   "AETERNA Grey 24"x48" Stone effect" → { collection: "Aeterna", color: "Grey", size: "24x48" }
 *   "Paint Rosé Porcelain Tile – 24"×48"" → { collection: "Paint", color: "Rosé", size: "24x48" }
 *   "ASPEN – Wood Look Porcelain Tile" → { collection: "Aspen", color: null, size: null }
 *   "Dallas Premium Vinyl Flooring 8mm 22mil Wear Layer" → { collection: "Dallas", ... }
 */
function parseOrionTitle(title) {
  if (!title) return { collection: '', color: null, size: null, finish: null, rawName: '' };

  let name = title.trim();

  // Extract size before cleaning (24x48, 24"×48", etc.)
  const sizeMatch = name.match(TITLE_SIZE_RE);
  const size = sizeMatch ? normalizeSize(`${sizeMatch[1]}x${sizeMatch[2]}`) : null;

  // Extract finish keywords before heavy cleaning
  let finish = null;
  const finishMatch = name.match(/\b(Matte|Polished|Glossy|Honed|Satin|Textured|Lappato|Pul|Matt)\b/i);
  if (finishMatch) {
    finish = finishMatch[1];
    if (finish.toLowerCase() === 'pul') finish = 'Polished';
  }

  // ── Name cleaning pipeline (matches fix-orion-names.mjs) ──
  let cleanName = name;
  // Strip "Orion Flooring" prefix first (before em-dash stripping)
  cleanName = cleanName.replace(/^Orion\s*Flooring\s*[–—]\s*/i, '');
  // Strip pipe-separated marketing text
  cleanName = cleanName.replace(/\s*\|.*$/, '');
  // Strip em-dash separated suffixes (e.g., "Blue Forest – 60X120 Cm")
  cleanName = cleanName.replace(/\s*[–—]\s*.*$/, '');
  // Strip sizes (with Unicode smart quotes)
  cleanName = cleanName
    .replace(/\d+\.?\d*\s*[\u201C\u201D\u2033\u2032"″''"]?\s*[x×X]\s*\d+\.?\d*\s*[\u201C\u201D\u2033\u2032"″''"]?/g, '')
    .replace(/\d+\s*cm/gi, '');
  // Strip junk parenthetical text
  cleanName = cleanName.replace(/\([^)]*\)/g, '');
  // Strip descriptors
  cleanName = cleanName
    .replace(/\bRigid\s*Core\s*SPC\s*Vinyl\b/gi, '')
    .replace(/\bSPC\s*Vinyl\s*Flooring\b/gi, '')
    .replace(/\bVinyl\s*Flooring\b/gi, '')
    .replace(/\bVinyl\b/gi, '')
    .replace(/\bPremium\s*Collection\b/gi, '')
    .replace(/\bPremium\b/gi, '')
    .replace(/\bFinish\s*Terrazzo\b/gi, '')
    .replace(/\bTerrazzo\s*look\b/gi, '')
    .replace(/\bSlab\s*Countertop\b/gi, '')
    .replace(/\bGlossy\s*White\b/gi, '')
    .replace(/\bPolished\b/gi, '')
    .replace(/\bMatte\b/gi, '')
    .replace(/\bItalian\b/gi, '')
    .replace(/\bRettificato\b/gi, '')
    .replace(/\bPorcelain\b/gi, '')
    .replace(/\bCeramic\b/gi, '')
    .replace(/\bWaterproof\b/gi, '')
    .replace(/\bDurable\b/gi, '')
    .replace(/\bWood\s*Effect\b/gi, '')
    .replace(/\bWood\s*Look\b/gi, '')
    .replace(/\bStone\s*effect\b/gi, '')
    .replace(/\bMarble\s*Look\b/gi, '')
    .replace(/\bMarble\b/gi, '')
    .replace(/\bOnyx\b/gi, '')
    .replace(/\bOnix\b/gi, '')
    .replace(/\bSuper\s*Polished\b/gi, '')
    .replace(/\bMatt\b/gi, '')
    .replace(/\bPul\b/gi, '')
    .replace(/\bTile\b/gi, '')
    .replace(/\bFlooring\b/gi, '')
    .replace(/\bORION\b/gi, '')
    .replace(/\bWall\b/gi, '')
    .replace(/\bFloor\b/gi, '')
    .replace(/\binch\b/gi, '')
    .replace(/\b\d+mm\b/gi, '')
    .replace(/\b\d+mil\b/gi, '')
    .replace(/\bWear\s*Layer\b/gi, '')
    .replace(/\bCollection\b/gi, '')
    .replace(/\bfor\s+(Any|Modern|Every)\s+\w+\b/gi, '')
    .replace(/\bESSENZE\s*LIGNEE\b/gi, '')
    .replace(/\bStoneware\b/gi, '')
    .replace(/\b\d{7,}\b/g, '')
    .replace(/\b\d+\s+\d+\b/g, '')
    .replace(/\b0\d\b/g, '');
  // Clean punctuation
  cleanName = cleanName
    .replace(/[\u201C\u201D\u2033\u2032"″]+/g, '')
    .replace(/,\s+/g, ' ')
    .replace(/[,;:\-–—]+\s*$/, '')
    .replace(/^\s*[,;:\-–—]+/, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Handle empty result
  if (!cleanName) cleanName = name.replace(/\([^)]*\)/g, '').trim();
  // Normalize Unicode: compose accented characters (e.g., n + combining tilde → ñ)
  cleanName = cleanName.normalize('NFC');

  // Title case with uppercase code preservation
  const SMALL_WORDS = new Set(['de', 'du', 'da', 'di', 'le', 'la', 'les']);
  const UPPERCASE_CODES = new Set(['AU', 'CF', 'CZ', 'ET', 'GVX', 'KM', 'ONI', 'ETE', 'SPC']);
  cleanName = cleanName.split(/\s+/).filter(Boolean).map((word, i) => {
    const lower = word.toLowerCase();
    const upper = word.toUpperCase();
    if (i > 0 && SMALL_WORDS.has(lower)) return lower;
    if (UPPERCASE_CODES.has(upper)) return upper;
    if (/^[A-Z0-9]+$/i.test(word) && /\d/.test(word) && /[A-Za-z]/.test(word)) return upper;
    return lower.charAt(0).toUpperCase() + lower.slice(1);
  }).join(' ');

  // Apply collection casing overrides (KM, CF, GVX, ONI, AU, ETE ET)
  for (const col of KNOWN_ORION_COLLECTIONS) {
    if (/^[A-Z]{2,3}$/.test(col) || /\b[A-Z]{2,3}\b/.test(col)) {
      const re = new RegExp(`\\b${col.toLowerCase().replace(/\s+/g, '\\s+')}\\b`, 'gi');
      cleanName = cleanName.replace(re, col);
    }
  }

  // ── Extract collection from cleaned name ──
  const stripAccents = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const lowerClean = stripAccents(cleanName.toLowerCase());
  let collection = cleanName.split(' ')[0]; // fallback: first word
  const sortedCols = [...KNOWN_ORION_COLLECTIONS].sort((a, b) => b.length - a.length);
  for (const col of sortedCols) {
    if (lowerClean.startsWith(stripAccents(col.toLowerCase()))) {
      collection = col;
      break;
    }
  }

  // ── Extract color (words after collection) ──
  let color = null;
  if (cleanName.length > collection.length) {
    color = cleanName.slice(collection.length).trim() || null;
  }

  return {
    collection,
    color,
    size,
    finish,
    rawName: name,
  };
}

/** Known Orion collection names for collection extraction and casing */
const KNOWN_ORION_COLLECTIONS = [
  'Aeterna', 'Albany', 'Alpine', 'Amazona', 'Arno', 'Aspen', 'Astro', 'Augusto',
  'Aurelius', 'Axe', 'AU',
  'Bianco Superior', 'Black Raj', 'Blond', 'Blue Eagle', 'Blue Forest',
  'Bois de Lille', 'Boston', 'Bracciano', 'Brown Persa',
  'CF', 'Calacatta', 'Carrara', 'Coreu', 'Crema Roma', 'Cristallo', 'Cromatic',
  'Dallas', 'Dark Rose', 'Delicattus',
  'ETE ET', 'Ekali', 'Elegance', 'Essential',
  'Feline', 'Frost', 'Fusion',
  'GVX', 'Gabana', 'Gare', 'Gery', 'Gold Macaubas',
  'Heisinki', 'Horton', 'Houston',
  'Ikon', 'Illusion', 'Ivory',
  'Jet', 'Jungle',
  'KM', 'Komi',
  'La Blue', 'Labradorite', 'Lilac', 'Living', 'Lunar', 'Lux Danae',
  'Macauba', 'Marmette', 'Marmorea', 'Marvel', 'Matarazzo', 'Matira',
  'Matrix', 'Mazero', 'Meridian', 'Montclair', 'Mountain Mist',
  'Mukali', 'Multifios',
  'Natural Granite', 'Natural Terrazzo', 'Nebulato', 'Neowood', 'Nero Marquinia', 'Nilo',
  'ONI', 'Olympia', 'Onic', 'Opus', 'Orinoco',
  'Paint', 'Palma', 'Pamesa', 'Pedre', 'Perla Santana', 'Pisa', 'Platino',
  'Quartzito',
  'Reverse', 'Rigid Core', 'Roma', 'Rosso Verona', 'Ruby Fusion',
  'Scarlet', 'Segesta', 'Sequoia Maxi', 'Serene', 'Siberia', 'Silke',
  'Spark', 'Star', 'Super White', 'Sybil',
  'Taj Mahal', 'Tempest', 'Titanium', 'Tmg', 'Toscana',
  'Vancouver', 'Viken',
  'Waterfall', 'Wetwood', 'White Paradise',
];

/**
 * Determine PIM category from product name and WooCommerce breadcrumb.
 * Returns { id, slug } where slug is used for attribute lookups.
 * Priority: slab names > vinyl detection > wood-look detection > breadcrumb > default.
 */
function resolveCategory(wcCategory, title, categoryLookup, productName) {
  const catLower = (wcCategory || '').toLowerCase().trim();
  const nameLower = (productName || '').toLowerCase().trim();

  // 1. Check slab names first (most reliable — from the dealer price list)
  if (SLAB_PRODUCT_NAMES.has(nameLower)) {
    return { id: categoryLookup.get('porcelain-slabs') || categoryLookup.get('porcelain-tile') || null, slug: 'porcelain-slabs' };
  }

  // 2. Vinyl/SPC detection from title
  if (VINYL_RE.test(title)) {
    return { id: categoryLookup.get('lvp-plank') || null, slug: 'lvp-plank' };
  }

  // 3. Wood-look detection from title
  if (WOOD_LOOK_RE.test(title)) {
    return { id: categoryLookup.get('wood-look-tile') || null, slug: 'wood-look-tile' };
  }

  // 4. WooCommerce breadcrumb mapping
  for (const [key, slug] of Object.entries(CATEGORY_MAP)) {
    if (catLower.includes(key)) {
      if (!slug) return { id: null, slug: null }; // skip (e.g., kitchen cabinets)
      return { id: categoryLookup.get(slug) || null, slug };
    }
  }

  // 5. Default to porcelain-tile
  return { id: categoryLookup.get('porcelain-tile') || null, slug: 'porcelain-tile' };
}

/**
 * Determine sell_by and variant_type from product characteristics.
 */
function classifyProduct(wcCategory, title, productName) {
  const catLower = (wcCategory || '').toLowerCase();
  const nameLower = (productName || '').toLowerCase().trim();

  // Countertop slabs sold by sqft
  if (SLAB_PRODUCT_NAMES.has(nameLower) || catLower.includes('countertop') || catLower.includes('slab')) {
    return { sellBy: 'sqft', variantType: 'stone_tile', priceBasis: 'per_sqft' };
  }

  // Vinyl/SPC sold by box
  if (VINYL_RE.test(title)) {
    return { sellBy: 'box', variantType: 'lvt', priceBasis: 'per_sqft' };
  }

  // Wood-look porcelain
  if (WOOD_LOOK_RE.test(title)) {
    return { sellBy: 'box', variantType: 'floor_tile', priceBasis: 'per_sqft' };
  }

  // Wall tile detection
  const titleLower = (title || '').toLowerCase();
  if (titleLower.includes('wall tile') || titleLower.includes('wall')) {
    return { sellBy: 'box', variantType: 'wall_tile', priceBasis: 'per_sqft' };
  }

  // Default: porcelain floor tile
  return { sellBy: 'box', variantType: 'floor_tile', priceBasis: 'per_sqft' };
}

// ──────────────────────────────────────────────
// Page Scraping
// ──────────────────────────────────────────────

/**
 * Extract all product URLs from the WooCommerce product sitemap.
 */
async function getProductUrls(page, baseUrl) {
  await page.goto(`${baseUrl}/product-sitemap.xml`, {
    waitUntil: 'networkidle2',
    timeout: 30000,
  });

  // WP sitemaps render as HTML table in browser — extract URLs from text content
  const urls = await page.evaluate(() => {
    const text = document.body.innerText;
    const matches = text.match(/https:\/\/orionflooring\.com\/product\/[^\s]+/g);
    return matches ? [...new Set(matches)] : [];
  });

  // Filter out /shop/ and non-product pages
  return urls.filter(u =>
    u.includes('/product/') &&
    !u.endsWith('/shop/') &&
    !u.includes('add-to-cart')
  );
}

/**
 * Scrape a single Orion product detail page.
 * Returns structured product data or null if page is not a valid product.
 */
async function scrapeProductPage(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  // Wait a bit for images/gallery to render
  await delay(1500);

  return page.evaluate(async () => {
    const title = document.querySelector('.product_title')?.textContent?.trim();
    if (!title) return null;

    // Breadcrumb category
    const breadcrumbs = Array.from(document.querySelectorAll('.woocommerce-breadcrumb a'));
    const category = breadcrumbs.length >= 2
      ? breadcrumbs[breadcrumbs.length - 1].textContent?.trim()
      : null;

    // Prices
    const priceEl = document.querySelector('.price');
    const regularPrice = priceEl?.querySelector('del .amount bdi')?.textContent?.trim()
      || priceEl?.querySelector('del .amount')?.textContent?.trim();
    const salePrice = priceEl?.querySelector('ins .amount bdi')?.textContent?.trim()
      || priceEl?.querySelector('ins .amount')?.textContent?.trim();
    const singlePrice = !regularPrice
      ? (priceEl?.querySelector('.amount bdi')?.textContent?.trim()
         || priceEl?.querySelector('.amount')?.textContent?.trim())
      : null;

    // Parse price values (remove $ and commas)
    const parsePrice = (p) => {
      if (!p) return null;
      const n = parseFloat(p.replace(/[$,]/g, ''));
      return isNaN(n) ? null : n;
    };

    // Description
    const descEl = document.querySelector('.woocommerce-product-details__short-description');
    const description = descEl?.innerText?.trim() || null;

    // Gallery images — probe actual dimensions via Image() since Woodmart theme
    // doesn't include data-large_image_width/height attributes
    const gallery = document.querySelector('.woocommerce-product-gallery');
    const imageEls = gallery
      ? Array.from(gallery.querySelectorAll('.woocommerce-product-gallery__image'))
      : [];

    // Collect raw URLs first
    const rawImages = imageEls.map(div => {
      const a = div.querySelector('a');
      const img = div.querySelector('img');
      return a?.href || img?.src || '';
    }).filter(Boolean);

    // Probe dimensions for each image (with 5s timeout per image)
    function probeImage(src) {
      return new Promise(resolve => {
        const img = new Image();
        const timer = setTimeout(() => {
          resolve({ url: src, w: 0, h: 0 });
        }, 5000);
        img.onload = () => {
          clearTimeout(timer);
          resolve({ url: src, w: img.naturalWidth, h: img.naturalHeight });
        };
        img.onerror = () => {
          clearTimeout(timer);
          resolve({ url: src, w: 0, h: 0 });
        };
        img.src = src;
      });
    }

    const images = await Promise.all(rawImages.map(probeImage));

    // SKU (if WooCommerce exposes it)
    const sku = document.querySelector('.sku')?.textContent?.trim() || null;

    // Additional info table (specs)
    const attrsTable = document.querySelector('.woocommerce-product-attributes, table.shop_attributes');
    const attrs = {};
    if (attrsTable) {
      for (const tr of attrsTable.querySelectorAll('tr')) {
        const label = tr.querySelector('th')?.textContent?.trim()?.toLowerCase();
        const value = tr.querySelector('td')?.textContent?.trim();
        if (label && value) attrs[label] = value;
      }
    }

    // WooCommerce product tags
    const tags = Array.from(document.querySelectorAll('.tagged_as a'))
      .map(a => a.textContent?.trim()).filter(Boolean);

    return {
      title,
      category,
      regularPrice: parsePrice(regularPrice),
      salePrice: parsePrice(salePrice),
      singlePrice: parsePrice(singlePrice),
      description,
      images,
      sku,
      attrs,
      tags,
      url: window.location.href,
    };
  });
}

// ──────────────────────────────────────────────
// Main run()
// ──────────────────────────────────────────────

/**
 * Orion Flooring scraper.
 *
 * WooCommerce-based site — scrapes product pages from the sitemap.
 *
 * Image handling (per vendor guidance):
 *   - Skip image[0] on every product page (always a lifestyle/room-scene hero)
 *   - Detect product primary among remaining images using aspect ratio heuristics
 *   - Landscape images (spec/branding cards with Orion logo) are deprioritized
 *
 * Product structure:
 *   - Porcelain tile (majority): sold by box, per_sqft pricing
 *   - Vinyl/SPC: sold by box, per_sqft pricing
 *   - Countertop slabs: sold by unit, per_unit pricing
 */
export async function run(pool, job, source) {
  const config = { ...DEFAULT_CONFIG, ...(source.config || {}) };
  const baseUrl = (source.base_url || 'https://orionflooring.com').replace(/\/$/, '');
  const vendor_id = source.vendor_id;

  let browser;
  const stats = {
    found: 0, created: 0, updated: 0, skusCreated: 0,
    imagesSet: 0, pricingSet: 0, errors: 0, skipped: 0,
  };

  // Build category lookup
  const categoryLookup = new Map();
  try {
    const catRows = await pool.query('SELECT id, slug FROM categories WHERE is_active = true');
    for (const row of catRows.rows) categoryLookup.set(row.slug, row.id);
  } catch {}

  const touchedProductIds = [];

  try {
    await appendLog(pool, job.id, 'Launching browser...');
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setUserAgent(USER_AGENT);
    await page.setViewport({ width: 1440, height: 900 });

    // ════════════════════════════════════════════
    // Phase 1: Product Discovery
    // ════════════════════════════════════════════

    await appendLog(pool, job.id, 'Fetching product sitemap...');
    const productUrls = await getProductUrls(page, baseUrl);
    stats.found = productUrls.length;
    await appendLog(pool, job.id, `Found ${productUrls.length} product URLs in sitemap`, {
      products_found: productUrls.length,
    });

    // ════════════════════════════════════════════
    // Phase 2: Scrape Each Product Page
    // ════════════════════════════════════════════

    for (let i = 0; i < productUrls.length; i++) {
      const url = productUrls[i];

      try {
        await delay(config.delayMs);

        const data = await scrapeProductPage(page, url);
        if (!data || !data.title) {
          stats.skipped++;
          continue;
        }

        // ── Parse product fields ──
        const parsed = parseOrionTitle(data.title);

        // Build product name (collection + color if available)
        const productName = parsed.color
          ? `${parsed.collection} ${parsed.color}`
          : parsed.collection;

        // Skip kitchen cabinets
        if (data.category && data.category.toLowerCase().includes('kitchen cabinet')) {
          stats.skipped++;
          continue;
        }

        // Skip products not in the dealer price list
        if (!isInPriceList(productName)) {
          stats.skipped++;
          continue;
        }

        const { sellBy, variantType, priceBasis } = classifyProduct(data.category, data.title, productName);
        const { id: categoryId, slug: categorySlug } = resolveCategory(data.category, data.title, categoryLookup, productName);

        // ── Upsert Product ──
        const product = await upsertProduct(pool, {
          vendor_id,
          name: productName,
          collection: parsed.collection,
          category_id: categoryId,
          description_long: data.description,
        });

        if (product.is_new) stats.created++;
        else stats.updated++;
        touchedProductIds.push(product.id);

        // ── Build internal SKU ──
        // Use URL slug as stable identifier
        const urlSlug = url.split('/product/')[1]?.replace(/\/$/, '') || '';
        const vendorSku = data.sku || urlSlug;
        const internalSku = `ORN-${urlSlug}`.slice(0, 100);

        const variantName = parsed.size
          ? buildVariantName(parsed.size, parsed.finish)
          : (parsed.finish || null);

        // ── Upsert SKU ──
        const sku = await upsertSku(pool, {
          product_id: product.id,
          vendor_sku: vendorSku,
          internal_sku: internalSku,
          variant_name: variantName,
          sell_by: sellBy,
          variant_type: variantType,
        });
        if (sku.is_new) stats.skusCreated++;

        // ── Pricing — always create a row so cost-import scripts can UPDATE
        // without hitting the retail_price NOT NULL constraint ──
        const retailPrice = data.salePrice || data.singlePrice || data.regularPrice;
        const mapPrice = data.regularPrice && data.salePrice ? data.regularPrice : null;
        await upsertPricing(pool, sku.id, {
          cost: 0,  // dealer cost from PDF — set separately
          retail_price: retailPrice || 0,
          price_basis: priceBasis,
          map_price: mapPrice,
        });
        stats.pricingSet++;

        // ── Attributes ──
        const nameLower = productName.toLowerCase();

        // Color: parsed from title, fall back to override map
        const color = parsed.color || COLOR_OVERRIDES[nameLower] || null;
        if (color) await upsertSkuAttribute(pool, sku.id, 'color', color);

        // Finish: parsed from title, fall back to product/category-based defaults
        let finish = parsed.finish;
        if (!finish) {
          if (POLISHED_PRODUCTS.has(nameLower)) finish = 'Polished';
          else if (LAPPATO_PRODUCTS.has(nameLower)) finish = 'Lappato';
          else if (categorySlug === 'lvp-plank') finish = 'Embossed';
          else if (categorySlug === 'porcelain-slabs') finish = 'Polished';
          else finish = 'Matte';
        }
        await upsertSkuAttribute(pool, sku.id, 'finish', finish);

        // Size: parsed from title, fall back to price list SIZE_MAP
        const size = parsed.size || findSize(productName);
        if (size) await upsertSkuAttribute(pool, sku.id, 'size', size);

        // Look
        const look = findLook(productName);
        if (look) await upsertSkuAttribute(pool, sku.id, 'look', look);

        // Application (based on PIM category)
        const application = APP_BY_SLUG[categorySlug];
        if (application) await upsertSkuAttribute(pool, sku.id, 'application', application);

        // Material (corrected per category, not raw WooCommerce breadcrumb)
        const material = MATERIAL_BY_SLUG[categorySlug];
        if (material) await upsertSkuAttribute(pool, sku.id, 'material', material);

        // Edge: all non-LVP Orion tiles are rectified
        if (categorySlug !== 'lvp-plank') {
          await upsertSkuAttribute(pool, sku.id, 'edge', 'Rectified');
        }

        // Weight from WooCommerce specs table (if available)
        for (const [label, value] of Object.entries(data.attrs || {})) {
          if (label.includes('weight')) await upsertSkuAttribute(pool, sku.id, 'weight', value);
        }

        // ── Images ──
        // data.images now contains [{url, w, h}, ...] with full-size dimensions
        if (data.images && data.images.length > 0) {
          // Delete existing media assets for this SKU before re-importing
          await pool.query(
            'DELETE FROM media_assets WHERE product_id = $1 AND sku_id = $2',
            [product.id, sku.id]
          );

          const classified = classifyOrionImages(data.images);

          let sortOrder = 0;
          if (classified.primary) {
            await upsertMediaAsset(pool, {
              product_id: product.id,
              sku_id: sku.id,
              asset_type: 'primary',
              url: classified.primary,
              original_url: classified.primary,
              sort_order: sortOrder++,
            });
            stats.imagesSet++;
          }

          if (classified.alternate) {
            await upsertMediaAsset(pool, {
              product_id: product.id,
              sku_id: sku.id,
              asset_type: 'alternate',
              url: classified.alternate,
              original_url: classified.alternate,
              sort_order: sortOrder++,
            });
            stats.imagesSet++;
          }

          for (const lifestyleUrl of classified.lifestyle) {
            await upsertMediaAsset(pool, {
              product_id: product.id,
              sku_id: sku.id,
              asset_type: 'lifestyle',
              url: lifestyleUrl,
              original_url: lifestyleUrl,
              sort_order: sortOrder++,
            });
            stats.imagesSet++;
          }
        }

        // ── Inventory (mark as in-stock since Orion lists them) ──
        await upsertInventorySnapshot(pool, sku.id, 'default', {
          qty_on_hand_sqft: 1,
          qty_in_transit_sqft: 0,
        });

        // Log progress
        if ((i + 1) % 10 === 0 || i === productUrls.length - 1) {
          await appendLog(pool, job.id, `Progress: ${i + 1}/${productUrls.length}`, {
            products_found: stats.found,
            products_created: stats.created,
            products_updated: stats.updated,
            skus_created: stats.skusCreated,
          });
        }

      } catch (err) {
        stats.errors++;
        await addJobError(pool, job.id, `${url}: ${err.message}`);
        if (stats.errors > 20) {
          await appendLog(pool, job.id, 'Too many errors (>20), aborting...');
          break;
        }
      }
    }

    // ════════════════════════════════════════════
    // Phase 3: Activate Products
    // ════════════════════════════════════════════

    if (touchedProductIds.length > 0) {
      const activateResult = await pool.query(
        `UPDATE products SET status = 'active', updated_at = CURRENT_TIMESTAMP
         WHERE id = ANY($1) AND status = 'draft'`,
        [touchedProductIds]
      );
      await appendLog(pool, job.id, `Activated ${activateResult.rowCount} products`);
    }

  } finally {
    if (browser) await browser.close();
  }

  // ════════════════════════════════════════════
  // Summary
  // ════════════════════════════════════════════

  await appendLog(pool, job.id,
    `Scrape complete. Found: ${stats.found}, Created: ${stats.created}, Updated: ${stats.updated}, ` +
    `SKUs: ${stats.skusCreated}, Images: ${stats.imagesSet}, Pricing: ${stats.pricingSet}, ` +
    `Skipped: ${stats.skipped}, Errors: ${stats.errors}`,
    {
      products_found: stats.found,
      products_created: stats.created,
      skus_created: stats.skusCreated,
    }
  );
}
