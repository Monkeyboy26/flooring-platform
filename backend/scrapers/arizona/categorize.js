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
export const CATEGORY_MAP = {
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
export const CATEGORY_SKIP = new Set([
  'looks-like', 'natural-stone', 'concrete', 'geometric-shapes', 'hand-painted',
  'subway', 'wood',                          // "Looks Like" children (aesthetics)
  'recycled-material-content',               // eco-label, not material
  'made-in-usa', 'made-in-usa-slab',         // origin tag
  'uncategorized', 'test-video', 'slab-outlet', 'quartz',  // misc
]);

export const ACCESSORY_KEYWORDS = /\b(trim|molding|moulding|reducer|stair\s*nose|transition|threshold|t-molding|quarter\s*round|underlayment|adhesive|grout|sealer|caulk|bullnose|cove\s*base|pencil\s*liner)\b/i;

// Name-based format patterns — catch products whose AZ tags don't include format categories
// but whose collection name clearly indicates the format (e.g., "Basalt Hex" → mosaic)
export const MOSAIC_NAME_PATTERN = /\b(hex|chevron|herringbone|basketweave|penny|geometric|labyrinth|fishing\s*net|combhex|arabesque|thin\s*brick|geometro|skywalk|trove|looming\s*stream|artistic\s*expression|fraser\s*river)\b/i;
export const STACKED_NAME_PATTERN = /\b(ledger|splitface|split[-\s]?face)\b/i;

// WooCommerce product pages that list colors by format rather than by series.
// Colors on these pages usually also have their own WC product page, creating duplicates.
// Skip creating products from these pages when the color exists elsewhere.
export const FORMAT_PAGE_TITLES = new Set(['Modella', 'Split']);

// Extract named shape/pattern from a mosaic size attribute for use in product naming.
// "Herringbone 1x2 Mesh" → "Herringbone", "Hex2x2 Mesh" → "Hex", "2x2 Mosaic" → ""
// Longer patterns listed first so they match before shorter prefixes.
export const MOSAIC_SHAPE_RE = /\b(penny\s*round|mini\s*herringbone|large\s*chevron|small\s*chevron|small\s*hex|long\s*hex|basketweave\s*dogbone|basketweave|herringbone|chevron|hexagon|hex|bubble|fan|flower|scallop|oval|rhomboid|ellipse|bamboo|bevel|trapezoid|feather|ribbon|lotus|brick|picket|pinwheel|stanza|octagon|arch|wavy|linear|straight)\b/i;
export function extractMosaicShape(sizeAttr) {
  if (!sizeAttr) return '';
  const m = sizeAttr.match(MOSAIC_SHAPE_RE);
  if (!m) return '';
  // Title-case the matched shape
  return m[1].replace(/\s+/g, ' ').split(' ')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}

// Size classification patterns — handles both raw (12x24) and WC-slugified (12-x-24) formats
// Field tile: both dimensions ≥12, or specific large sizes (8x48, 6x36, etc.)
export const FIELD_SIZE = /(\d{2,})-?x-?(\d{2,})|8-?x-?48|8-?x-?36|6-?x-?36|6-?x-?24/;
// Mosaic keywords in size attribute — these sizes are NOT field tile even if dimensions are large
export const MOSAIC_KW = /mosaic|mesh|hex|penny|basketweave|herringbone|stack|sheet/i;

// Parse a size string into numeric [w, h] inches. Handles raw ("13-3/4x10-9/16")
// and WC-slugified ("13-3-4-x-10-9-16") forms, including fractional parts.
export function parseSizeDims(s) {
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
export function isFieldTileSize(s) {
  if (!s || MOSAIC_KW.test(s)) return false;
  const dims = parseSizeDims(s);
  if (!dims) return false;
  const [a, b] = [Math.min(dims[0], dims[1]), Math.max(dims[0], dims[1])];
  if (!Number.isInteger(a) || !Number.isInteger(b)) return false;
  if (a >= 12 && b >= 12) return true;
  return (a === 8 && (b === 48 || b === 36)) || (a === 6 && (b === 36 || b === 24));
}

// Categories sold per piece/sheet (not per sqft in boxes)
export const UNIT_CATEGORIES = new Set([
  'mosaic-tile', 'stacked-stone',
  'granite-countertops', 'marble-countertops', 'quartz-countertops',
  'quartzite-countertops', 'porcelain-slabs',
]);
// Slab categories eligible for multi-gauge (thickness) SKU splitting
export const SLAB_CATEGORIES = new Set([
  'granite-countertops', 'marble-countertops', 'quartz-countertops',
  'quartzite-countertops', 'porcelain-slabs',
]);
// Format categories that need variant-level splitting when mixed with field tiles
export const FORMAT_CATS = new Set(['mosaic-tile', 'stacked-stone', 'pavers']);
// Fallback tile category when slab products have tile-format variants but no tile
// WooCommerce category — AZ lumps marble tiles under marble-slab, for example.
export const SLAB_TO_TILE_FALLBACK = {
  'marble-countertops': 'natural-stone',
  'granite-countertops': 'natural-stone',
  'quartzite-countertops': 'natural-stone',
  'porcelain-slabs': 'porcelain-tile',
};
// Categories that don't use box packaging (slabs, sheets)
export const NO_BOX_CATEGORIES = new Set([
  'mosaic-tile', 'stacked-stone', 'granite-countertops', 'marble-countertops',
  'quartz-countertops', 'quartzite-countertops', 'porcelain-slabs',
]);

export function isAccessory(title, description) {
  return ACCESSORY_KEYWORDS.test(title) || (description && ACCESSORY_KEYWORDS.test(description));
}

// AZ page titles sometimes carry internal series codes — expand or strip them
// for customer-facing names ("DT-Taj Mahal Polished" → "Della Terra Taj Mahal
// Polished"; "CS-Terra Nova" → "Terra Nova"). Price-list lookups must keep the
// RAW title — their keys are built from it.
export function normalizeSeriesTitle(title) {
  return (title || '').replace(/^DT-\s*/i, 'Della Terra ').replace(/^CS-\s*/i, '').trim();
}

// Join collection + color collapsing a word-boundary overlap so shared words
// never double: "Cementine Evo" + "Evo 1" → "Cementine Evo 1". Hyphens count
// as boundaries on the collection side: "Geo-Dijon" + "Dijon Classic" →
// "Geo-Dijon Classic".
export function joinDedupe(a, b) {
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
export function resolveBestCategory(apiProduct, azCategoryMap, categoryLookup) {
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
  // Wood-look routing: AZ tags wood aesthetics with a 'wood' look category
  // (normally skipped as a "Looks Like" child). When a product otherwise
  // resolves to plain field-tile porcelain/ceramic AND carries the wood look,
  // route it to the dedicated wood-look-tile browse category instead of generic
  // porcelain. Mosaic/paver/stacked wood-looks resolve to their format category
  // above (higher priority) and are intentionally left alone.
  if ((pimCatSlug === 'porcelain-tile' || pimCatSlug === 'ceramic-tile')
      && categoryLookup.has('wood-look-tile')
      && apiProduct.categoryIds.some(id => azCategoryMap.get(id)?.slug === 'wood')) {
    categoryId = categoryLookup.get('wood-look-tile');
    pimCatSlug = 'wood-look-tile';
  }
  return { categoryId, pimCatSlug, bestPriority };
}

/**
 * Classify a single variation by format based on its size attribute.
 * Used to sub-group variants within a color group so each format gets its own PIM product.
 * Returns 'mosaic', 'stacked', 'tile', or 'default'.
 */
export function classifyVariation(sizeAttr, originalFormatSlug, originalSlabSlug) {
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
