/**
 * Mélange Boutique Tile — Image Enrichment Scraper
 *
 * Products already imported from PDF price list (scripts/import-melange.js).
 * This scraper visits melangetile.com, onetile.us/it, and emilgroup.it to
 * capture product images and associate them with existing DB products.
 *
 * Multi-source flow:
 *   1. melangetile.com collection pages → color-matched images (existing)
 *   2. onetile.us/it collection pages  → finish-specific images
 *   3. emilgroup.it catalog pages      → finish-specific images
 *   4. Score ALL collected images against each SKU's variant_name → best match wins
 *
 * Collection pages show ALL colors together, so we parse filenames
 * to match images to the correct color product. Generic/unmatched
 * images are kept as lifestyle fallbacks.
 *
 * Site structure: melangetile.com uses flat URL slugs like
 *   /Block_Porcelain_Tile, /Cafoscari, /Sunstone_tile, etc.
 *
 * Usage: docker compose exec api node scrapers/melange.js
 */

import pg from 'pg';
import {
  launchBrowser, delay, collectSiteWideImages, extractLargeImages,
  filterImageUrls, saveProductImages, upsertMediaAsset,
} from './base.js';

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: 5432,
  database: 'flooring_pim',
  user: 'postgres',
  password: 'postgres',
});

const BASE_URL = 'https://www.melangetile.com';

// Map COLLECTION names (not product/color names) to website URL slugs.
// Each collection page shows all colors together.
const URL_MAP = {
  'Block':                    ['/blockporcelaintile', '/block-series'],
  "Ca'Foscari":               ['/cafoscariseries', '/CaFoscarSeries'],
  'Concrete Soul Infinity':   ['/CONCRETE-SOUL-INFINITY_c_134.html', '/concretoinfinitytile'],
  'Decoro':                   ['/decorotile', '/Decoro_10x10_Porcelain_Tile'],
  'Factory':                  ['/factoryseries', '/Factory'],
  'Kauri':                    ['/wood_look_polished_porcelain_tile_kauri_8x48', '/kauri_series_8x48_wood_plank_porcelain_tile_natural_blue_grey_flooring'],
  'Moonlit':                  ['/supergres-moonlit-porcelain', '/moonlit-porcelain-supergres'],
  'Nirvana':                  ['/nirvanacollection', '/Nirvana_Collection_Woodlook_Porcelain_Tile'],
  'Portland Stone':           ['/portlandstone', '/veincutportlandstone', '/crosscutportlandstone'],
  'Real Stone Travertino':    ['/realstone-travertino.html', '/realstone_tarvertino_cross_cut_ragno', '/realstone_travertino_vein_cut_ragno'],
  'Sixty 60 Silktech':        ['/60-SIXTY-silktech-_c_155.html'],
  'Snow':                     ['/snowwhitetile', '/SnowSeries'],
  'Stonetalk':                ['/STONETALK-Minimal_c_126.html', '/STONETALK-Martellata_c_125.html', '/STONETALK-Rullata_c_127.html'],
  'Sublime':                  ['/SUBLIME-_c_159.html', '/sublimeseries'],
  'Sunstone':                 ['/sunstonetileseries', '/SunstoneTile'],
  'Tele di Marmo':            ['/TELE-DI-MARMO-slabs_c_141.html', '/teledimarmo'],
  'Unique Infinity':          ['/unique-infinity-provenza-emil', '/provenza-unique-infinity-arcade'],
  'Woodbreak':                ['/woodbreak'],
  'Memory':                   ['/wall_tile_memory_10x30', '/memory_series_10x30_ceramic_wall_tile_gris_blanco_decor_mix_plata'],
  'Pearl':                    ['/pearlseries', '/PearlTile'],
  'Quartz Outdoor':           ['/Quartz-Outdoor-20mm_c_112.html', '/QuartzOutdoorTile'],
  'Shellstone':               ['/shellstone'],
  'Sicily':                   ['/sicilytile', '/Sicily_Tile_Flooring'],
  'Caprice':                  ['/caprice', '/CapriceCollection'],
  'Evolution':                ['/wall_tile_evolution_4x16'],
  'Unique Bourgogne':         ['/unique-bourgogne'],
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
  // ── Base tile (silk surface close-ups) — per-color ──
  // Listed first so they win tie-breaks for "Natural Rectified" SKUs
  // (finish-specific images get +5 bonus, so they still win for their SKUs)
  'https://www.onetile.it/public/webp/sixty-antracite-30x60-9-5-silk-1589780.webp',
  'https://www.onetile.it/public/webp/sixty-cielo-30x60-9-5-silk-1589787.webp',
  'https://www.onetile.it/public/webp/sixty-salvia-30x60-9-5-silk-1589796.webp',
  'https://www.onetile.it/public/webp/sixty-talco-30x60-9-5-silk-1589799.webp',
  // Cenere base tile (from domita.it)
  'https://media.domita.it/uploads/domita/1/site/1000/3/z/3z__36707__cenere_1.jpg',
  // ── Timbro (textured surface) — all 6 Melange colors ──
  'https://www.onetile.it/public/webp/sixty-antracite-timbro-60x120-9-5-silk-1589864.webp',
  'https://www.onetile.it/public/webp/sixty-cenere-timbro-60x120-9-5-silk-1589867.webp',
  'https://www.onetile.it/public/webp/sixty-cielo-timbro-60x120-9-5-silk-1589871.webp',
  'https://www.onetile.it/public/webp/sixty-salvia-timbro-60x120-9-5-silk-1589879.webp',
  'https://www.onetile.it/public/webp/sixty-talco-timbro-60x120-9-5-silk-1589882.webp',
  // Nero Timbro does not exist on onetile — no base tiles for Nero Assoluto
  // ── Minibrick Matt — all 6 Melange colors ──
  'https://www.onetile.it/public/webp/sixty-minibrick-antracite-5x15-9-5-matt-1589663.webp',
  'https://www.onetile.it/public/webp/sixty-minibrick-cenere-5x15-9-5-matt-1589666.webp',
  'https://www.onetile.it/public/webp/sixty-minibrick-cielo-5x15-9-5-matt-1589669.webp',
  'https://www.onetile.it/public/webp/sixty-minibrick-nero-assoluto-5x15-9-5-matt-1589675.webp',
  'https://www.onetile.it/public/webp/sixty-minibrick-salvia-5x15-9-5-matt-1589682.webp',
  'https://www.onetile.it/public/webp/sixty-minibrick-talco-5x15-9-5-lux-1589661.webp',
  // ── Minibrick Timbro — nero only (rest share matt image) ──
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
  'mosaico':     ['mosaico', 'mosaic', 'mos', 'dado', 'tessera'],
  'hex':         ['hex', 'esagona', 'hexagon', 'hexagonal'],
  'minibrick':   ['minibrick', 'mini', 'listello', 'brick', 'muretto'],
  'timbro':      ['timbro', 'strutturato', 'textured', 'strutt'],
  'polished':    ['polished', 'lappato', 'lucido', 'lux', 'lap'],
  'matt':        ['matt', 'matte', 'naturale', 'natural'],
  'carpet':      ['carpet', 'decor', 'deco', 'pattern'],
  'mix':         ['mix', 'mixed', 'random'],
  'wax':         ['wax', 'cera', 'cerato'],
  'veincut':     ['veincut', 'vein', 'venatura'],
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
};

/** Finishes that must show visually distinct images (different product form). */
const MUST_DIFFER_FINISHES = new Set([
  'bullnose', 'mosaico', 'hex', 'minibrick', 'carpet', 'decoro', 'grid', 'intrecci',
]);

/** Finishes that should differ (different surface treatment). */
const SHOULD_DIFFER_FINISHES = new Set([
  'matt', 'polished', 'timbro', 'silktech', 'wax', 'veincut', 'crosscut',
  'bocciardato', 'struttura', 'minimal', 'rullata', 'martellata',
]);

// ── Helpers ────────────────────────────────────────────────────────────

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
  // landoftile esagona timbro (hex timbro)
  'big_sixty_122753': 'sixty_esagona_timbro_antracite',
  'big_sixty_122754': 'sixty_esagona_timbro_cenere',
  'big_sixty_122755': 'sixty_esagona_timbro_cielo',
  'big_sixty_122757': 'sixty_esagona_timbro_nero',
  'big_sixty_122759': 'sixty_esagona_timbro_salvia',
  'big_sixty_122760': 'sixty_esagona_timbro_talco',
};

/** Italian/Spanish name variants for fuzzy color matching. */
const COLOR_ALIASES = {
  'bianco': ['bianca', 'blanco'],
  'grigio': ['griggio', 'gris'],
  'grey': ['gray'],
  'gray': ['grey'],
  'darkgrey': ['darkgray'],
  'darkgray': ['darkgrey'],
  'noir': ['noire', 'nero'],
  'nero': ['neroassoluto', 'nero-assoluto'],
};

/** Match an image URL to a color name. Returns matched color or null.
 *  Also checks URL_PATTERN_HINTS for opaque filenames (e.g. landoftile CDN). */
function matchImageToColor(imageUrl, colorNames) {
  const filename = normalize(getFilename(imageUrl));
  // Build effective string with hint (same logic as scoreImageForSku)
  const hint = Object.entries(URL_PATTERN_HINTS).find(([k]) => imageUrl.includes(k));
  const effective = hint ? normalize(hint[1]) + ' ' + filename : filename;
  const sorted = [...colorNames].sort((a, b) => b.length - a.length);
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
  const words = finishStr.toLowerCase().split(/[\s,]+/).filter(Boolean);
  const expanded = new Set();
  for (const word of words) {
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
  return [...expanded];
}

/**
 * Classify a finish for fallback tolerance logging.
 * Returns 'must_differ' | 'should_differ' | 'ok_to_share'
 */
function classifyFinish(finishStr) {
  if (!finishStr) return 'ok_to_share';
  const words = finishStr.toLowerCase().split(/[\s,]+/);
  for (const w of words) {
    if (MUST_DIFFER_FINISHES.has(w)) return 'must_differ';
    // Also check synonym keys
    for (const [key, syns] of Object.entries(FINISH_SYNONYMS)) {
      if (syns.includes(w) && MUST_DIFFER_FINISHES.has(key)) return 'must_differ';
    }
  }
  for (const w of words) {
    if (SHOULD_DIFFER_FINISHES.has(w)) return 'should_differ';
    for (const [key, syns] of Object.entries(FINISH_SYNONYMS)) {
      if (syns.includes(w) && SHOULD_DIFFER_FINISHES.has(key)) return 'should_differ';
    }
  }
  return 'ok_to_share';
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

async function extractImages(page, url, siteWideImages) {
  try {
    const resp = await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    if (!resp || resp.status() >= 400) {
      console.log(`    HTTP ${resp?.status()} for ${url}`);
      return [];
    }
    await delay(2000);
    await scrollToLoadAll(page);

    const rawImages = await extractLargeImages(page, siteWideImages, 120);
    const urls = rawImages.map(img => img.src);
    return filterImageUrls(urls, { maxImages: 8, extraExclude: ['_thumbnail', '/thumbs/', 'terrazzo-white-th', 'newquartzthumb', 'chart-2'] });
  } catch (err) {
    console.log(`    Error loading ${url}: ${err.message}`);
    return [];
  }
}

/** Extract images from manufacturer catalog pages (emilgroup).
 *  More aggressive than extractImages: also captures lazy-loaded images
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

    // If STILL few images, extract product image URLs from page source as fallback.
    // emilgroup uses various patterns: /emil/prodotti/immaginiarticoli_emil/,
    // /emil/prodotti/immaginicollezioni_emil/, and direct .jpg/.webp in data attributes
    if (urls.length < 5) {
      const pageSource = await page.content();
      // Match emilgroup product images (broad: any /prodotti/ or /emil/ path with image ext)
      const srcMatches = pageSource.match(/https?:\/\/www\.emilgroup\.it\/[^"'\s>]+\.(?:jpg|jpeg|png|webp)(?:\?[^"'\s>]*)?/gi) || [];
      // Also look for relative paths in data attributes and img src
      const relMatches = pageSource.match(/(?:src|data-src|data-lazy|content)=["'](\/emil\/[^"']+\.(?:jpg|jpeg|png|webp)[^"']*)/gi) || [];
      const baseUrl = 'https://www.emilgroup.it';
      const allMatches = [
        ...srcMatches,
        ...relMatches.map(m => {
          const path = m.replace(/^(?:src|data-src|data-lazy|content)=["']/i, '');
          return path.startsWith('/') ? baseUrl + path : path;
        }),
      ];
      // Filter to only product images (exclude icons, logos, banners)
      const productMatches = allMatches.filter(u =>
        (u.includes('/prodotti/') || u.includes('PANNELLO') || u.includes('MOSAICO') ||
         u.includes('_60x') || u.includes('_30x') || u.includes('_120x')) &&
        !u.includes('logo') && !u.includes('icon') && !u.includes('banner') &&
        !u.includes('certificazioni') && !u.includes('loghi_') && !u.includes('/awards/')
      );
      if (productMatches.length > 0) {
        console.log(`      (source extraction found ${productMatches.length} product image URLs)`);
        urls = [...new Set([...urls, ...productMatches])];
      }
    }

    return filterImageUrls(urls, { maxImages: 50, extraExclude: ['_thumbnail', '/thumbs/', 'logo', 'banner', 'icon', 'sprite', 'certificazioni', 'loghi_', '/awards/'] });
  } catch (err) {
    console.log(`    Error loading ${url}: ${err.message}`);
    return [];
  }
}

// ── Manufacturer catalog scraping ──────────────────────────────────────

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
        const images = await extractManufacturerImages(page, url, siteWideCache.get(domain));
        console.log(`    Found ${images.length} images`);

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

// ── Unified image scoring ──────────────────────────────────────────────

/** All canonical finish keys from FINISH_SYNONYMS that represent distinct product forms. */
const ALL_FINISH_KEYS = Object.keys(FINISH_SYNONYMS);

/**
 * Score a single image URL against a SKU's variant tokens + expanded finish synonyms.
 * Higher score = better match.
 *
 * Scoring:
 *   +5 for finish synonym match in filename
 *   +4 for finish synonym match in full URL path
 *   +3 for regular token match in filename
 *   +2 for regular token match in URL path
 *   +1 for consonant-skeleton match (typo tolerance)
 *   -20 penalty if image contains a DIFFERENT product's color name (wrong color)
 *   -15 penalty if image contains a DIFFERENT finish name (wrong finish)
 *
 * @param {string} imageUrl - Image URL to score
 * @param {string[]} tokens - Variant tokens (excluding the product color)
 * @param {string[]} finishTokens - Expanded finish synonym tokens
 * @param {string} productColor - This product's color name (normalized)
 * @param {string[]} otherColors - Other color names in this collection (normalized)
 */
function scoreImageForSku(imageUrl, tokens, finishTokens, productColor, otherColors) {
  const fn = normalize(getFilename(imageUrl));
  const hint = Object.entries(URL_PATTERN_HINTS).find(([k]) => imageUrl.includes(k));
  const effective = hint ? normalize(hint[1]) + ' ' + fn : fn;
  const fullPath = normalize(imageUrl);
  const effConsonants = effective.replace(/[aeiou]/g, '');
  const pathConsonants = fullPath.replace(/[aeiou]/g, '');
  const finishSet = new Set(finishTokens.map(t => normalize(t)));

  let score = 0;

  // Heavy penalty if the image filename contains a DIFFERENT color name.
  // Check both raw filename and hint-enhanced effective string to catch
  // opaque filenames with URL_PATTERN_HINTS (e.g. landoftile esagona).
  const normProduct = normalize(productColor);
  for (const otherColor of otherColors) {
    const normOther = normalize(otherColor);
    if (normOther.length <= 2) continue;
    if (normOther === normProduct) continue;
    const hasOther = fn.includes(normOther) || effective.includes(normOther);
    const hasOwn = fn.includes(normProduct) || effective.includes(normProduct);
    if (hasOther && !hasOwn) {
      score -= 20;
      break;
    }
    const aliases = COLOR_ALIASES[normOther] || [];
    for (const alias of aliases) {
      if ((fn.includes(alias) || effective.includes(alias)) && !hasOwn) {
        score -= 20;
        break;
      }
    }
  }

  // Wrong-finish penalty: if the image filename contains a finish keyword
  // from a DIFFERENT finish group than the SKU's finish, penalize heavily.
  // e.g. "minibrick" image penalized for "Natural Rectified" SKU.
  // Only applies to must-differ finishes (distinct product forms).
  // Check both fn and effective to catch URL_PATTERN_HINTS.
  for (const finishKey of ALL_FINISH_KEYS) {
    if (!MUST_DIFFER_FINISHES.has(finishKey)) continue;
    const syns = FINISH_SYNONYMS[finishKey];
    const imageHasFinish = syns.some(s => s.length > 2 && (fn.includes(normalize(s)) || effective.includes(normalize(s))));
    if (!imageHasFinish) continue;
    // Image contains this must-differ finish — check if SKU also has it
    const skuHasFinish = syns.some(s => finishSet.has(normalize(s)));
    if (!skuHasFinish) {
      // Image has "minibrick" but SKU is not minibrick → penalize
      score -= 15;
      break;
    }
  }

  // Score finish tokens (higher weight).
  // Award bonus once per synonym group to avoid double-counting overlapping
  // synonyms (e.g. "silktech" and "silk" are in the same group).
  const scoredGroups = new Set();
  for (const ft of finishTokens) {
    const nt = normalize(ft);
    if (nt.length <= 2) continue;
    // Find which synonym group this token belongs to
    const group = Object.entries(FINISH_SYNONYMS).find(([, syns]) => syns.includes(nt));
    const groupKey = group ? group[0] : nt;
    if (scoredGroups.has(groupKey)) continue; // Already scored this group
    // Must-differ finishes (hex, mosaico, bullnose, minibrick…) get higher
    // weight so they beat should-differ matches (silktech, timbro…) in ties.
    const md = MUST_DIFFER_FINISHES.has(groupKey);
    if (effective.includes(nt)) { score += md ? 6 : 5; scoredGroups.add(groupKey); continue; }
    if (fullPath.includes(nt)) { score += md ? 5 : 4; scoredGroups.add(groupKey); continue; }
    const tc = nt.replace(/[aeiou]/g, '');
    if (tc.length > 3 && effConsonants.includes(tc)) { score += md ? 3 : 2; scoredGroups.add(groupKey); continue; }
    if (tc.length > 3 && pathConsonants.includes(tc)) { score += md ? 3 : 2; scoredGroups.add(groupKey); continue; }
  }

  // Score regular tokens (color already excluded)
  for (const tok of tokens) {
    const nt = normalize(tok);
    if (nt.length <= 2) continue;
    if (finishSet.has(nt)) continue; // Already scored as finish token
    if (effective.includes(nt)) { score += 3; continue; }
    if (fullPath.includes(nt)) { score += 2; continue; }
    const tc = nt.replace(/[aeiou]/g, '');
    if (tc.length > 3 && effConsonants.includes(tc)) { score += 1; continue; }
    if (tc.length > 3 && pathConsonants.includes(tc)) { score += 1; continue; }
  }

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

    // ── Phase 1: Scrape melangetile.com ──────────────────────────────

    console.log('Collecting site-wide images to exclude...');
    const siteWideImages = await collectSiteWideImages(page, BASE_URL);
    console.log(`  Found ${siteWideImages.size} site-wide images\n`);

    console.log('=== Phase 1: Scraping melangetile.com Collection Pages ===\n');

    // Collect scraped images per collection: Map<collection, Map<color, [url]>>
    const scrapedColorImages = new Map();   // collection → Map<color, [url]>
    const scrapedGenericImages = new Map();  // collection → [url]

    for (const [collectionName, slugs] of Object.entries(URL_MAP)) {
      const products = collectionProducts.get(collectionName);
      if (!products || products.length === 0) {
        console.log(`  [SKIP] No DB products for collection: ${collectionName}`);
        continue;
      }

      const colorNames = products.map(p => p.name);
      console.log(`[${collectionName}] Colors: ${colorNames.join(', ')}`);

      const allImageUrls = [];
      const seenUrls = new Set();

      for (const slug of slugs) {
        const url = `${BASE_URL}${slug}`;
        console.log(`  Visiting: ${url}`);

        const images = await extractImages(page, url, siteWideImages);
        for (const imgUrl of images) {
          if (!seenUrls.has(imgUrl)) {
            seenUrls.add(imgUrl);
            allImageUrls.push(imgUrl);
          }
        }
        console.log(`    Found ${images.length} images`);
        await delay(800);
      }

      if (allImageUrls.length === 0) {
        console.log(`  [NO IMAGES] ${collectionName}\n`);
        continue;
      }

      // Match each image to a color
      const colorImages = new Map();
      const genericImages = [];

      for (const url of allImageUrls) {
        const matchedColor = matchImageToColor(url, colorNames);
        if (matchedColor) {
          if (!colorImages.has(matchedColor)) colorImages.set(matchedColor, []);
          colorImages.get(matchedColor).push(url);
        } else {
          genericImages.push(url);
        }
      }

      scrapedColorImages.set(collectionName, colorImages);
      scrapedGenericImages.set(collectionName, genericImages);
      console.log(`  Matched: ${colorImages.size} colors, ${genericImages.length} generic\n`);
    }

    // ── Phase 2: Scrape manufacturer catalogs ────────────────────────

    console.log('=== Phase 2: Scraping Manufacturer Catalogs ===\n');
    const catalogImages = await scrapeManufacturerCatalogs(page, collectionProducts);
    console.log();

    // ── Phase 3: Unified scoring — assign best image per SKU ─────────

    console.log('=== Phase 3: Unified Image Scoring ===\n');

    for (const [collectionName, products] of collectionProducts) {
      if (!products || products.length === 0) continue;

      const colorNames = products.map(p => p.name);
      const colorImages = scrapedColorImages.get(collectionName) || new Map();
      const genericImages = scrapedGenericImages.get(collectionName) || [];

      // Gather manufacturer catalog images for this collection
      let mfrCatalogImgs = catalogImages.get(collectionName) || [];

      // Inject verified image overrides for specific collections
      if (collectionName === 'Sixty 60 Silktech' && SIXTY_IMAGE_OVERRIDES.length > 0) {
        const overrides = SIXTY_IMAGE_OVERRIDES.map(url => ({ url, source: 'override' }));
        mfrCatalogImgs = [...overrides, ...mfrCatalogImgs];
      }
      if (collectionName === 'Woodbreak' && WOODBREAK_IMAGE_OVERRIDES.length > 0) {
        const overrides = WOODBREAK_IMAGE_OVERRIDES.map(url => ({ url, source: 'override' }));
        mfrCatalogImgs = [...overrides, ...mfrCatalogImgs];
      }

      const productIds = products.map(p => p.id);

      // Get existing manufacturer images (from prior imports/other scrapers)
      const existMfrRes = await pool.query(
        `SELECT product_id, url, asset_type FROM media_assets WHERE product_id = ANY($1) AND source = 'manufacturer' ORDER BY sort_order`,
        [productIds]
      );
      const existingMfrByProduct = new Map();
      for (const row of existMfrRes.rows) {
        if (!existingMfrByProduct.has(row.product_id)) existingMfrByProduct.set(row.product_id, []);
        existingMfrByProduct.get(row.product_id).push(row);
      }

      // Delete only scraper-sourced media_assets (preserve manufacturer images)
      await pool.query("DELETE FROM media_assets WHERE product_id = ANY($1) AND (source = 'scraper' OR source IS NULL)", [productIds]);

      // Look up all SKUs
      const skuRes = await pool.query(
        `SELECT id AS sku_id, product_id, variant_name FROM skus WHERE product_id = ANY($1)`,
        [productIds]
      );
      const productSkuDetails = new Map();
      for (const row of skuRes.rows) {
        if (!productSkuDetails.has(row.product_id)) productSkuDetails.set(row.product_id, []);
        productSkuDetails.get(row.product_id).push({ sku_id: row.sku_id, variant_name: row.variant_name });
      }

      for (const product of products) {
        const skuDetails = productSkuDetails.get(product.id) || [];
        if (skuDetails.length === 0) { productsMatched++; continue; }

        // Build unified image pool for this product:
        //   1. Existing manufacturer images (already in DB for this product)
        //   2. Catalog images from onetile/emilgroup matched to this color
        //   3. Scraped color-specific images from melangetile.com
        //   4. Generic/fallback images
        const imagePool = [];
        const seenUrls = new Set();

        // Add existing manufacturer images
        const existMfr = existingMfrByProduct.get(product.id) || [];
        for (const img of existMfr) {
          if (!seenUrls.has(img.url)) {
            seenUrls.add(img.url);
            imagePool.push({ url: img.url, source: 'manufacturer', priority: 3 });
          }
        }

        // Add catalog images matched to this product's color
        for (const catImg of mfrCatalogImgs) {
          const matchedColor = matchImageToColor(catImg.url, colorNames);
          if (matchedColor === product.name && !seenUrls.has(catImg.url)) {
            seenUrls.add(catImg.url);
            imagePool.push({ url: catImg.url, source: 'catalog', priority: 2 });
          }
        }
        // Also add catalog images that didn't match any color (might match by finish)
        for (const catImg of mfrCatalogImgs) {
          if (!seenUrls.has(catImg.url)) {
            const matchedColor = matchImageToColor(catImg.url, colorNames);
            if (!matchedColor) {
              seenUrls.add(catImg.url);
              imagePool.push({ url: catImg.url, source: 'catalog_generic', priority: 0 });
            }
          }
        }

        // Add scraped color-matched images
        const ownImages = colorImages.get(product.name) || [];
        for (const imgUrl of ownImages) {
          if (!seenUrls.has(imgUrl)) {
            seenUrls.add(imgUrl);
            imagePool.push({ url: imgUrl, source: 'scraper', priority: 1 });
          }
        }

        // Add generic images as last resort
        for (const imgUrl of genericImages) {
          if (!seenUrls.has(imgUrl)) {
            seenUrls.add(imgUrl);
            imagePool.push({ url: imgUrl, source: 'scraper_generic', priority: 0 });
          }
        }

        if (imagePool.length === 0) {
          console.log(`  [NO POOL] ${collectionName} / ${product.name}`);
          productsMatched++;
          continue;
        }

        // Score each image against each SKU
        let skuAssigned = 0;
        const colorNorm = normalize(product.name);

        for (const sku of skuDetails) {
          const allTokens = (sku.variant_name || '').split(/[\s,]+/).filter(t => t.length > 2);
          const tokens = allTokens.filter(t => normalize(t) !== colorNorm);

          // Extract finish and expand to synonyms
          const finishStr = getFinishFromVariant(sku.variant_name);
          const finishTokens = expandFinishSynonyms(finishStr);

          let bestImg = null;
          let bestScore = -1;

          for (const img of imagePool) {
            let score = scoreImageForSku(img.url, tokens, finishTokens, product.name, colorNames);
            // Small bonus for higher-priority sources (manufacturer > catalog > scraper)
            score += img.priority * 0.1;
            if (score > bestScore) { bestScore = score; bestImg = img; }
          }

          // Fallback: use first available image if no scoring match
          if (!bestImg) bestImg = imagePool[0];

          // Log when a finish-specific SKU gets a low/zero finish score
          if (finishStr && bestScore <= 0.5) {
            const cls = classifyFinish(finishStr);
            if (cls !== 'ok_to_share') {
              finishMissingLog.push({
                collection: collectionName,
                color: product.name,
                variant: sku.variant_name,
                finish: finishStr,
                classification: cls,
                bestScore: bestScore.toFixed(1),
                imageUsed: getFilename(bestImg.url),
              });
            }
          }

          await upsertMediaAsset(pool, {
            product_id: product.id,
            sku_id: sku.sku_id,
            asset_type: 'primary',
            url: bestImg.url,
            original_url: bestImg.url,
            sort_order: 0,
          });
          skuAssigned++;
        }

        imagesSaved += skuAssigned;
        productsMatched++;
        console.log(`  [SCORED] ${collectionName} / ${product.name}: ${imagePool.length} images → ${skuAssigned} SKUs (pool: ${existMfr.length} mfr + ${ownImages.length} scraped + ${mfrCatalogImgs.length > 0 ? 'catalog' : 'no catalog'})`);
      }
    }

    // ── Summary ──────────────────────────────────────────────────────

    console.log(`\n=== Scrape Complete ===`);
    console.log(`Products matched: ${productsMatched} / ${prodRows.rowCount}`);
    console.log(`Total images saved: ${imagesSaved}`);

    if (finishMissingLog.length > 0) {
      console.log(`\n=== Finish-Specific Image Gaps (${finishMissingLog.length}) ===`);
      console.log('These SKUs have distinct finishes but no finish-specific image was found:');
      for (const entry of finishMissingLog) {
        const marker = entry.classification === 'must_differ' ? '!!!' : '..';
        console.log(`  ${marker} ${entry.collection} / ${entry.color} / ${entry.variant} [${entry.finish}] → ${entry.imageUsed} (score: ${entry.bestScore})`);
      }
      const mustCount = finishMissingLog.filter(e => e.classification === 'must_differ').length;
      const shouldCount = finishMissingLog.filter(e => e.classification === 'should_differ').length;
      console.log(`\n  Must-differ gaps: ${mustCount}  |  Should-differ gaps: ${shouldCount}`);
    }

  } finally {
    await browser.close();
    await pool.end();
  }
}

run().catch(err => { console.error(err); process.exit(1); });
