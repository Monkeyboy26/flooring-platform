'use strict';

/**
 * rework-bellezza.cjs — Complete Bellezza vendor rework from the ground up.
 *
 * Single comprehensive script that replaces the old scraper + fix script combo.
 * Handles: image scraping, per-SKU assignment, primary selection, collection
 * grouping, and accessory linkage — all in one clean pass.
 *
 * Usage: docker compose exec api node scripts/rework-bellezza.cjs
 */

const { Pool } = require('pg');
const https = require('https');
const http = require('http');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: 5432,
  database: 'flooring_pim',
  user: 'postgres',
  password: 'postgres',
});

const BASE_URL = 'https://bellezzaceramica.com';
const delay = ms => new Promise(r => setTimeout(r, ms));

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 1: PRODUCT → URL MAP
// Maps our DB product names to website slugs. Each slug is a separate WooCommerce
// product page. Multi-color products have one slug per color.
// ═══════════════════════════════════════════════════════════════════════════════

const URL_MAP = {
  // ── Porcelain & Ceramic Tiles ────────────────────────────────────
  'Angelo Silk Shimmer':      ['angelo-silk'],
  'Anima Antracita':          ['anima-antracita'],
  'Arena Chiaro':             ['arena-chiaro'],
  'Armani White':             ['armani-white', 'armani-white-polished'],
  'Austral Blanco':           ['austral-blanco'],
  'Austral Essence Blanco':   ['austral-essence-blanco'],
  'Bolonia Marengo':          ['bolonia-marengo-polished', 'bolonia-marengo-matte'],
  'Calaca Gold':              ['calaca-gold', 'calaca-gold-matte'],
  'Calacatta Brick Gloss':    ['calacatta-gold-brick-gloss'],
  'Calacatta Gold':           ['calacatta-gold', 'calacatta-gold-lux'],
  'Calacatta Gloss':          ['calacatta-gloss-polished'],
  'Calacatta Hex Gloss':      ['calacatta-hex-gloss'],
  'Calacatta Natural':        ['calacatta-natural-polished', 'calacatta-natural'],
  'Calcutta Gold':            ['calcutta-gold', 'calcutta-gold-dc'],
  'Ceppo':                    ['ceppo', 'ceppo-di-gres-avorio', 'ceppo-di-gres-grigio', 'ceppo-di-gres-nero', 'ceppo-di-gres-sabbia'],
  'Chamonix':                 ['chamonix-beige', 'chamonix-bianco', 'chamonix-dark-gray', 'chamonix-gray', 'chamonix-ocean'],
  'Concretus':                ['concretus', 'concretus-light-matte', 'concretus-light-12x24-matte', 'concretus-light-36x36-matte', 'concretus-dark-matte'],
  'Connor Beige':             ['connor-beige-matte', 'connor-beige'],
  'District':                 ['district-denim-calma-matte', 'district-moon-calma-matte', 'district-sabbia-calma', 'district-taupe-calma'],
  'Docks':                    ['docks', 'docks-beige', 'docks-white'],
  'Dolomite':                 ['dolomite-matte', 'dolomite-polished', 'dolomite'],
  'Emporio Calacatta':        ['emporio-calacatta-matte', 'emporio-calacatta-polished', 'emporio-calacatta'],
  'Elegance Marble Pearl':    ['elegance-marble-pearl', 'elegance-marble'],
  'Enigma White':             ['enigma-white'],
  'Epoque':                   ['epoque-white', 'epoque-black', 'epoque-ivory'],
  'Fry':                      ['fry', 'fry-bianco-matte-24x48', 'fry-nero-matte-12x24', 'fry-bianco', 'fry-grigio', 'fry-nero'],
  'Granby Beige':             ['granby', 'granby-beige'],
  'Grunge':                   ['grunge', 'grunge-beige', 'grunge-smoke', 'grunge-multi'],
  'Harley Lux':               ['harley-lux', 'harley-lux-black', 'harley-lux-graphite', 'harley-lux-super-white',
                                'harley-lux-black-semi-polish-18x36', 'harley-lux-super-white-semi-polish-18x36'],
  'Ibiza':                    ['ibiza', 'ibiza-blanco', 'ibiza-esmeralda', 'ibiza-navy', 'ibiza-perla', 'ibiza-decorado-indalo'],
  'Kadence':                  ['kadence-gris-polished', 'kadence-gris-matte', 'kadence-marfil', 'kadence-perla'],
  'Larin Marfil':             ['larin-marfil'],
  'Laurent Black':            ['laurent-black-matte', 'laurent-black-polish-36x36', 'laurent-black-matte-36x36',
                                'laurent-black-matte-17-1x46-5', 'laurent-black-polish-17-1x46-5'],
  'Leccese Cesellata':        ['leccese', 'leccese-cesellata'],
  'Lingot':                   ['deco-lingot-aqua', 'deco-lingot-blue', 'deco-lingot-coral', 'deco-lingot-mint', 'deco-lingot-white'],
  'Magna White':              ['magna-white'],
  'Manhattan':                ['manhattan', 'manhattan-mud', 'manhattan-pearl'],
  'Markina Gold':             ['markina-gold'],
  'Marmo Marfil':             ['navarti-marmo-marfil', 'marmo-marfil'],
  'Milano Crema':             ['milano-crema'],
  'Mixit Concept':            ['mixit-concept', 'mixit-concept-blanco', 'mixit-concept-gris'],
  'Modern Concrete Ivory':    ['modern-concrete-ivory'],
  'Montblanc Gold':           ['montblanc-gold'],
  'Myrcella':                 ['myrcella', 'myrcella-beige', 'myrcella-bone', 'myrcella-grey', 'myrcella-mocca'],
  'Naples White':             ['naples-white'],
  'Palatino':                 ['palatino', 'palatino-ivory', 'deco-palatino', 'deco-palatino-ivory'],
  'Pearl Onyx':               ['pearl-onyx-24x48', 'pearl-onyx'],
  'Puccini':                  ['puccini', 'puccini-blanco', 'puccini-marfil', 'puccini-perla'],
  'Scanda White':             ['scanda-white'],
  'Sekos White':              ['sekos-white'],
  'Sierra':                   ['sierra-matte-24x48', 'sierra'],
  'Spatula':                  ['spatula', 'spatula-antracite', 'spatula-grey', 'spatula-white', 'spatula-bone'],
  'Statuario Nice':           ['statuario-nice'],
  'Sun Blanco':               ['sun-blanco'],
  'Temper':                   ['temper', 'temper-coal', 'temper-frost', 'temper-golden', 'temper-iron'],
  'Unique Ceppo Bone':        ['unique-ceppo-bone'],
  'Volga':                    ['volga', 'volga-grafito', 'volga-gris'],
  'WG001':                    ['wg001m-matte', 'wg001g-24x24-polished', 'wg001g-32x32-polished', 'wg001m-matte-24x24'],
  'Westmount Beige':          ['westmount-beige'],

  // ── New Porcelain (May 2026) ─────────────────────────────────────
  'Golden Blanco':            ['golden-blanco'],
  'Granby Ivory':             ['granby-ivory'],
  'Panda':                    ['panda'],
  'Statuario Spider':         ['statuario-spider'],
  'Staturio Blue':            ['staturio-blue'],
  'Vibrant Bianco':           ['vibrant-bianco'],
  'Vilema':                   ['vilema-beige', 'vilema-blanco', 'vilema-roble', 'vilema-taupe'],

  // ── New Wall Tiles (May 2026) ────────────────────────────────────
  'Artistic White Brillo':    ['artistic-white-brillo-wall-tile'],
  'Celian':                   ['celian-grafito', 'celian-ivory'],
  'Elven':                    ['elven-blanco-lapatto', 'elven-concept-blanco-lapatto', 'elven-grafito-lapatto-wall-tile'],
  'Insignia White':           ['insignia-white'],
  'Kube Blanco':              ['kube-blanco-wall-tile'],
  'Kyoto White':              ['kyoto-white-wall-tile'],
  'Odissey Saphire':          ['odissey-saphire-matte', 'odissey-saphire-wall'],
  'Scale Decor 3D':           ['scale-ivory-decor-3d-wall', 'scale-saphire-decor-3d-wall'],

  // ── Mosaics & Hex ───────────────────────────────────────────────
  'Black Marble Mosaic':      ['black-matte-mosaic'],
  'Hex XL Coimbra':           ['coimbra'],
  'Hex XL Fosco':             ['fosco'],
  'Hex XL Inverno Grey':      ['inverno-grey'],
  'Milano Mosaic':            ['milano'],
  'Dorset Hexagon':           ['dorset-black-hexagon', 'dorset-gray-hexagon', 'dorset-white-hexagon'],
  'Nero Marquina Matte Hexagon': ['nero-marquina-matte-hexagon'],
  'Metallic Dark Grey Mosaic': ['metallic-dark-grey-mosaic'],
  'Stainless Gold Hexagon Mosaic': ['stainless-gold-hexagon-mosaic'],
  'Chateau Mosaic':           ['chateau-mosaic'],
  'Penny Calacatta Gold':     ['penny-calacatta-gold'],
  'Penny Fosco':              ['penny-fosco'],
  'Penny Grafito':            ['penny-grafito'],
  'LN520 Stacked Linear':    ['ln520-stacked-linear'],

  // ── GIO Collection ──────────────────────────────────────────────
  'Gio':                      ['gio-white-glossy-hexagon-2x2', 'gio-white-matte-hexagon-2x2', 'gio-white-matte-hexagon-4x4',
                               'gio-black-matte-hexagon-2x2', 'gio-black-matte-hexagon-4x4', 'gio-black-glossy-hexagon-2x2',
                               'gio-grey-matte-hexagon-4x4', 'gio-taupe-matte-hexagon-2x2', 'gio-cobalt-matte-hexagon-2x2',
                               'gio-black-matte-stacked-linear-0-82x2-8', 'gio-taupe-matte-stacked-linear-0-82x2-8',
                               'gio-black-matte-stacked-linear-0-86x5-7', 'gio-black-glossy-stacked-linear-0-86x5-7',
                               'gio-colbat-glossy-stacked-linear-0-86x5-7', 'gio-grey-glossy-stacked-linear-0-86x5-7',
                               'gio-colbat-glossy-stacked-linear-1-26x5-7', 'gio-grey-glossy-stacked-linear-1-26x5-7',
                               'gio-white-matte-stacked-linear-0-86x5-7', 'gio-white-glossy-stacked-linear-1-26x5-7'],

  // ── Subway & Artisan ────────────────────────────────────────────
  'Altea':                    ['altea-ash-blue-4x4-3x6', 'altea-black-4x4-3x6', 'altea-dusty-pink-4x4-3x6',
                               'altea-matcha-4x4-3x6', 'altea-pine-green-4x4-3x6', 'altea-rosewood-4x4-3x6',
                               'altea-smoke-4x4-3x6', 'altea-thistle-blue-4x4-3x6', 'altea-white-4x4-3x6',
                               'altea-white', 'altea-ash-blue', 'altea-black', 'altea-dusty-pink',
                               'altea-matcha', 'altea-pine-green', 'altea-rosewood', 'altea-smoke', 'altea-thistle-blue'],
  'Amazonia':                 ['amazonia-artic', 'amazonia-carbon', 'amazonia-chalk', 'amazonia-sand', 'amazonia-sapphire'],
  'Limit':                    ['limit-blanc-2%c2%bdx-10', 'limit-bleu-clair-2%c2%bdx-10', 'limit-bleu-izu-2%c2%bdx-10',
                               'limit-gris-2%c2%bdx-10', 'limit-jaune-2%c2%bdx-10', 'limit-menthe-2%c2%bdx-10',
                               'limit-noir-2%c2%bdx-10', 'limit-rose-2%c2%bdx-10', 'limit-sable-2%c2%bdx-10',
                               'limit-terre-2%c2%bdx-10', 'limit-vert-2%c2%bdx-10'],

  // ── Frammenti ───────────────────────────────────────────────────
  'Frammenti':                ['frammenti-fr-10-bianco-3-x16', 'frammenti-fr-10-bianco-8x8', 'frammenti-fr-12-blu-notte-3-x16',
                               'frammenti-fr-2-azzurro-3-x16', 'frammenti-fr-2-azzurro-micro-macro-8-x8',
                               'frammenti-fr-5-grigio-3-x16', 'frammenti-fr-8-nero-micro-macro-8x8'],

  // ── Recycled Glass (Union Station series) ─────────────────────
  'NatureGlass Hex':          ['natureglass-black-hexagon', 'natureglass-smooth-grey-hex', 'natureglass-white-hexagon'],
  'Silver Matte Hex':         ['silver-matte-hexagon'],
  'Statuario Matte Hex':      ['statuario-white-matte-hexagon'],
  'Antwerp':                  ['union-station-antwerp-snow-mosaic'],
  'Camden':                   ['union-station-camden-cloud-mosaic'],
  'Grande':                   ['union-station-grande-cloud-mosaic'],
  'Hudson':                   ['union-station-hudson-oslo-mosaic'],
  'Nord':                     ['union-station-nord-rain-mosaic'],
  'Park':                     ['union-station-park-cloud-mosaic'],

  // ── Panels ──────────────────────────────────────────────────────
  'Acoustic MDF Sound Absorption Panel': ['mdf-acoustic-interior-medium-density-fiberboard'],
  'Exterior Composite Wall Panel':       ['wpc-exterior-wood-plastic-composite'],
  'BPC Interior Panel':       ['bpc-interior-bamboo-plastic-composite'],
};

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 2: COLLECTION GROUPING
// ═══════════════════════════════════════════════════════════════════════════════

const COLLECTION_MAP = {
  'Marble Look': [
    'Armani White', 'Calaca Gold', 'Calacatta Gold', 'Calacatta Natural',
    'Calcutta Gold', 'Elegance Marble Pearl', 'Emporio Calacatta',
    'Golden Blanco', 'Laurent Black', 'Magna White', 'Markina Gold',
    'Marmo Marfil', 'Montblanc Gold', 'Naples White', 'Panda',
    'Pearl Onyx', 'Statuario Nice', 'Statuario Spider', 'Staturio Blue',
    'Vibrant Bianco', 'Dolomite', 'Enigma White', 'Larin Marfil',
    'Milano Crema', 'Anima Antracita',
  ],
  'Concrete & Industrial': [
    'Chamonix', 'Concretus', 'District', 'Fry', 'Grunge',
    'Modern Concrete Ivory', 'Spatula', 'Temper', 'Epoque',
    'Ceppo', 'Unique Ceppo Bone', 'Bolonia Marengo', 'Kadence',
    'Frammenti', 'Volga',
  ],
  'Stone Look': [
    'Arena Chiaro', 'Westmount Beige', 'Connor Beige', 'Granby Beige',
    'Granby Ivory', 'Harley Lux', 'Leccese Cesellata', 'Palatino',
    'Sierra', 'Myrcella', 'Arhus',
  ],
  'Wood Look': [
    'Docks', 'Manhattan', 'Vilema',
  ],
  'Subway & Artisan': [
    'Altea', 'Limit', 'Amazonia', 'Ibiza', 'Lingot',
    'Austral Blanco', 'Austral Essence Blanco', 'Calacatta Brick Gloss',
    'Calacatta Gloss', 'Calacatta Hex Gloss', 'Sun Blanco',
    'Scanda White', 'Sekos White', 'Angelo Silk Shimmer',
    'Artistic White Brillo', 'Celian', 'Elven', 'Insignia White',
    'Kube Blanco', 'Kyoto White', 'Odissey Saphire', 'Scale Decor 3D',
    'Mixit Concept',
  ],
  'Hexagon & Mosaic': [
    'Hex XL Coimbra', 'Hex XL Fosco', 'Hex XL Inverno Grey',
    'NatureGlass Hex', 'Silver Matte Hex', 'Statuario Matte Hex',
    'Nero Marquina Matte Hexagon', 'Penny Calacatta Gold', 'Penny Fosco',
    'Penny Grafito', 'Black Marble Mosaic', 'Chateau Mosaic',
    'Milano Mosaic', 'Stainless Gold Hexagon Mosaic',
    'Metallic Dark Grey Mosaic', 'Dorset Hexagon', 'LN520 Stacked Linear',
    'Gio', 'Puccini',
  ],
  'Recycled Glass': [
    'WG001', 'Antwerp', 'Camden', 'Grande', 'Hudson', 'Nord', 'Park',
  ],
  'Wall Panels': [
    'Acoustic MDF Sound Absorption Panel', 'BPC Interior Panel',
    'Exterior Composite Wall Panel',
  ],
  'Trim & Accessories': [
    'Schluter Trim', 'MAPEI Grout Medium Grey',
  ],
};

// Build reverse map
const PRODUCT_TO_COLLECTION = {};
for (const [collection, products] of Object.entries(COLLECTION_MAP)) {
  for (const name of products) PRODUCT_TO_COLLECTION[name] = collection;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 3: IMAGE CLASSIFICATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Determine if an image URL is a product/laydown photo (good primary candidate).
 * Product photos show the tile on a flat surface or as a swatch.
 */
function isProductPhoto(url) {
  const fn = url.split('/').pop().toLowerCase();
  if (fn.includes('laydown')) return true;
  if (fn.includes('swatch')) return true;
  // Numbered product codes (e.g., "27599_Altea_WHITE_10x10.jpeg")
  if (/^\d{4,6}[_-]/.test(fn)) return true;
  // Small PNG color swatches (e.g., "Antracite.png", "Grey.png")
  if (/^[a-z_-]+\.png$/i.test(fn) && !fn.includes('brochure') && !fn.includes('logo')) return true;
  // Product-style images with dimensions in name
  if (/\d+x\d+/.test(fn) && !fn.includes('kitchen') && !fn.includes('bath') && !fn.includes('room') && !fn.includes('wall') && !fn.includes('interior') && !fn.includes('living')) return true;
  return false;
}

/**
 * Determine if an image URL is a lifestyle/room scene photo.
 */
function isLifestylePhoto(url) {
  const fn = url.split('/').pop().toLowerCase();
  if (fn.includes('kitchen')) return true;
  if (fn.includes('bath')) return true;
  if (fn.includes('room')) return true;
  if (fn.includes('living')) return true;
  if (fn.includes('interior')) return true;
  if (fn.includes('wall') && !fn.includes('wall-tile') && !fn.includes('walnut')) return true;
  if (fn.includes('1920x')) return true;
  if (fn.includes('1080')) return true;
  if (fn.includes('-min.')) return true;
  if (fn.includes('floor') && !fn.includes('flooring-')) return true;
  return false;
}

/**
 * Determine if an image is a brochure/catalog page (skip these).
 */
function isBrochure(url) {
  const fn = url.split('/').pop().toLowerCase();
  return fn.includes('brochure') || fn.includes('catalog') || fn.includes('catalogue') || fn.includes('spec-sheet');
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 4: COLOR EXTRACTION FROM URLs
// ═══════════════════════════════════════════════════════════════════════════════

const COLOR_PATTERNS = [
  { pattern: /ash[_-]?blue/i, colors: ['Ash Blue'] },
  { pattern: /dusty[_-]?pink/i, colors: ['Dusty Pink'] },
  { pattern: /pine[_-]?green/i, colors: ['Pine Green'] },
  { pattern: /thistle[_-]?blue/i, colors: ['Thistle Blue'] },
  { pattern: /dark[_-]?gr[ae]y/i, colors: ['Dark Gray'] },
  { pattern: /dark[_-]?walnut/i, colors: ['Dark Walnut'] },
  { pattern: /light[_-]?walnut/i, colors: ['Light Walnut'] },
  { pattern: /dark[_-]?coffee/i, colors: ['Dark Coffee'] },
  { pattern: /coffee[_-]?brown/i, colors: ['Coffee Brown'] },
  { pattern: /jet[_-]?black/i, colors: ['Jet Black'] },
  { pattern: /super[_-]?white/i, colors: ['Super White'] },
  { pattern: /bleu[_-]?clair/i, colors: ['Bleu Clair'] },
  { pattern: /bleu[_-]?izu/i, colors: ['Bleu Izu'] },
  { pattern: /blu[_-]?notte/i, colors: ['Blu Notte'] },
  { pattern: /denim[_-]?calma/i, colors: ['Denim Calma'] },
  { pattern: /moon[_-]?calma/i, colors: ['Moon Calma'] },
  { pattern: /sabbia[_-]?calma/i, colors: ['Sabbia Calma'] },
  { pattern: /taupe[_-]?calma/i, colors: ['Taupe Calma'] },
  { pattern: /beige/i, colors: ['Beige'] },
  { pattern: /bianco/i, colors: ['Bianco', 'White'] },
  { pattern: /blanco/i, colors: ['Blanco', 'White'] },
  { pattern: /blanc(?!o)/i, colors: ['Blanc', 'White'] },
  { pattern: /white/i, colors: ['White', 'Bianco', 'Blanc', 'Blanco'] },
  { pattern: /gr[ae]y(?!stone)/i, colors: ['Gray', 'Grey', 'Gris', 'Grigio'] },
  { pattern: /gris/i, colors: ['Gris', 'Gray', 'Grey'] },
  { pattern: /grigio/i, colors: ['Grigio', 'Gray', 'Grey'] },
  { pattern: /ocean/i, colors: ['Ocean'] },
  { pattern: /antracit[ea]/i, colors: ['Antracite'] },
  { pattern: /bone/i, colors: ['Bone'] },
  { pattern: /noir/i, colors: ['Noir', 'Black'] },
  { pattern: /nero/i, colors: ['Nero', 'Black'] },
  { pattern: /black/i, colors: ['Black', 'Noir', 'Nero'] },
  { pattern: /matcha/i, colors: ['Matcha'] },
  { pattern: /rosewood/i, colors: ['Rosewood'] },
  { pattern: /smoke/i, colors: ['Smoke'] },
  { pattern: /coral/i, colors: ['Coral'] },
  { pattern: /aqua/i, colors: ['Aqua'] },
  { pattern: /mint(?!e)/i, colors: ['Mint'] },
  { pattern: /ivory/i, colors: ['Ivory'] },
  { pattern: /golden/i, colors: ['Golden'] },
  { pattern: /gold(?!en)/i, colors: ['Gold'] },
  { pattern: /silver/i, colors: ['Silver'] },
  { pattern: /iron/i, colors: ['Iron'] },
  { pattern: /frost/i, colors: ['Frost'] },
  { pattern: /coal/i, colors: ['Coal'] },
  { pattern: /sand/i, colors: ['Sand'] },
  { pattern: /sapphire/i, colors: ['Sapphire'] },
  { pattern: /cobalt/i, colors: ['Cobalt'] },
  { pattern: /taupe(?![_-]?calma)/i, colors: ['Taupe'] },
  { pattern: /terra/i, colors: ['Terre'] },
  { pattern: /sable/i, colors: ['Sable'] },
  { pattern: /jaune/i, colors: ['Jaune'] },
  { pattern: /vert(?!ical)/i, colors: ['Vert'] },
  { pattern: /menthe/i, colors: ['Menthe'] },
  { pattern: /rose(?!wood)/i, colors: ['Rose'] },
  { pattern: /bleu(?![_-])/i, colors: ['Bleu Izu'] },
  { pattern: /walnut/i, colors: ['Walnut'] },
  { pattern: /pine(?![_-]?green)/i, colors: ['Pine'] },
  { pattern: /oak/i, colors: ['Oak'] },
  { pattern: /coffee/i, colors: ['Coffee Brown'] },
  { pattern: /graphite/i, colors: ['Graphite'] },
  { pattern: /chalk/i, colors: ['Chalk'] },
  { pattern: /carbon/i, colors: ['Carbon'] },
  { pattern: /artic/i, colors: ['Aertic'] },
  { pattern: /aertic/i, colors: ['Aertic'] },
  { pattern: /marfil/i, colors: ['Marfil'] },
  { pattern: /perla/i, colors: ['Perla'] },
  { pattern: /mocca/i, colors: ['Mocca'] },
  { pattern: /roble/i, colors: ['Roble'] },
  { pattern: /multi/i, colors: ['Multi'] },
  { pattern: /mud/i, colors: ['Mud'] },
  { pattern: /pearl/i, colors: ['Pearl'] },
  { pattern: /fossile/i, colors: ['Fossile'] },
  { pattern: /fumo/i, colors: ['Fumo'] },
  { pattern: /avorio/i, colors: ['Avorio', 'Ivory'] },
  { pattern: /sabbia/i, colors: ['Sabbia'] },
  { pattern: /esmeralda/i, colors: ['Esmeralda'] },
  { pattern: /navy/i, colors: ['Navy'] },
  { pattern: /azzurro/i, colors: ['Azzurro'] },
];

/**
 * Extract color hint from URL filename.
 * Returns array of potential color names.
 */
function extractColorsFromUrl(url) {
  const filename = url.split('/').pop().split('?')[0].toLowerCase();
  const colors = new Set();
  for (const { pattern, colors: matchColors } of COLOR_PATTERNS) {
    if (pattern.test(filename)) {
      for (const c of matchColors) colors.add(c);
    }
  }
  return [...colors];
}

/**
 * Extract color hint from a slug.
 */
function extractColorsFromSlug(slug) {
  const colors = new Set();
  for (const { pattern, colors: matchColors } of COLOR_PATTERNS) {
    if (pattern.test(slug)) {
      for (const c of matchColors) colors.add(c);
    }
  }
  return [...colors];
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 4B: WORDPRESS THUMBNAIL DEDUPLICATION
// WordPress generates resize variants like "image-600x300.jpg" alongside
// "image.jpg". We want only the full-size originals.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Check if a URL is a WordPress-generated resize variant.
 */
function isWordPressResize(url) {
  return /-\d+x\d+\.(jpg|jpeg|png|webp)(\?.*)?$/i.test(url);
}

/**
 * Get the canonical (full-size) version of a WordPress URL by stripping resize suffix.
 */
function stripWpResize(url) {
  return url.replace(/-\d+x\d+(?=\.(jpg|jpeg|png|webp)(\?.*)?$)/i, '');
}

/**
 * Deduplicate WordPress resize variants from an array of URLs.
 * If both full-size and resized versions exist, keep only full-size.
 * If only resized exists, keep it.
 */
function deduplicateWpResizes(urls) {
  const canonical = new Map(); // stripped URL → best URL
  for (const url of urls) {
    const stripped = stripWpResize(url);
    const existing = canonical.get(stripped);
    if (!existing) {
      canonical.set(stripped, url);
    } else if (isWordPressResize(existing) && !isWordPressResize(url)) {
      // Replace resize with full-size
      canonical.set(stripped, url);
    }
  }
  return [...canonical.values()];
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 5: FAST HTTP IMAGE EXTRACTION (no Puppeteer needed)
// Parse WooCommerce product pages via HTTP fetch + regex.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Fetch a URL's HTML content via HTTPS with redirect following.
 */
function fetchHtml(url, maxRedirects = 3) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { timeout: 15000, headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Accept': 'text/html,application/xhtml+xml',
    }}, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && maxRedirects > 0) {
        const redir = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        res.resume();
        return fetchHtml(redir, maxRedirects - 1).then(resolve, reject);
      }
      if (res.statusCode >= 400) {
        res.resume();
        return resolve('');
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });
    req.on('timeout', () => { req.destroy(); resolve(''); });
    req.on('error', () => resolve(''));
  });
}

/**
 * Extract image URLs from a WooCommerce product page HTML string.
 * Parses gallery links, data-large_image attributes, and JSON-LD data.
 */
function extractImagesFromHtml(html) {
  const imgs = [];
  const seen = new Set();

  const addUrl = (u) => {
    if (!u || seen.has(u)) return;
    if (!u.includes('/wp-content/uploads/')) return;
    if (!/\.(jpg|jpeg|png|webp)/i.test(u)) return;
    if (u.includes('placeholder') || u.includes('logo') || u.includes('icon')) return;
    seen.add(u);
    imgs.push(u);
  };

  // 1. Gallery link hrefs (full-size — best quality)
  //    <div class="woocommerce-product-gallery__image" ...><a href="FULL_SIZE_URL">
  const galleryLinkRe = /woocommerce-product-gallery[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"/gi;
  let m;
  while ((m = galleryLinkRe.exec(html)) !== null) addUrl(m[1]);

  // 2. data-large_image attributes (WooCommerce gallery images)
  const dataLargeRe = /data-large_image="([^"]+)"/gi;
  while ((m = dataLargeRe.exec(html)) !== null) addUrl(m[1]);

  // 3. Gallery image data-src (lazy load)
  const dataSrcRe = /woocommerce-product-gallery[\s\S]*?<img[^>]+(?:data-src|src)="([^"]+wp-content\/uploads\/[^"]+)"/gi;
  while ((m = dataSrcRe.exec(html)) !== null) addUrl(m[1]);

  // 4. JSON-LD structured data
  const jsonLdRe = /<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  while ((m = jsonLdRe.exec(html)) !== null) {
    try {
      const data = JSON.parse(m[1]);
      const imageArr = data.image || (data['@graph'] || []).flatMap(g => g.image || []);
      for (const imgUrl of [].concat(imageArr).filter(Boolean)) {
        const u = typeof imgUrl === 'string' ? imgUrl : imgUrl.url || '';
        addUrl(u);
      }
    } catch {}
  }

  // 5. Fallback: any wp-content/uploads image in the product content area
  if (imgs.length === 0) {
    const contentImgRe = /(?:entry-content|id="content"|class="product")[\s\S]*?<img[^>]+src="([^"]+wp-content\/uploads\/[^"]+)"/gi;
    while ((m = contentImgRe.exec(html)) !== null) addUrl(m[1]);
    // Broader fallback — any wp-content/uploads image on the page
    if (imgs.length === 0) {
      const anyImgRe = /(?:src|href)="(https?:\/\/[^"]*\/wp-content\/uploads\/[^"]+\.(?:jpg|jpeg|png|webp))/gi;
      while ((m = anyImgRe.exec(html)) !== null) {
        const u = m[1];
        if (!u.includes('logo') && !u.includes('icon') && !u.includes('banner') && !u.includes('favicon')) {
          addUrl(u);
        }
      }
    }
  }

  return imgs;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 6: SKU COLOR MATCHING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Match a SKU's color to an image's detected colors.
 * Uses exact matching only (case-insensitive) to prevent cross-contamination
 * between similar colors like "Gray" and "Dark Gray".
 */
function colorMatchesSku(imageColors, skuColor) {
  if (!skuColor || imageColors.length === 0) return false;
  const skuLower = skuColor.toLowerCase().trim();
  const skuCompact = skuLower.replace(/[\s_-]+/g, '');
  for (const ic of imageColors) {
    const icLower = ic.toLowerCase().trim();
    if (icLower === skuLower) return true;
    // Space/separator-normalized exact match (e.g., "AshBlue" == "Ash Blue")
    if (icLower.replace(/[\s_-]+/g, '') === skuCompact) return true;
  }
  return false;
}

/**
 * Match a slug to a SKU's color.
 * E.g., slug "chamonix-bianco" → matches SKU with color "Bianco"
 */
function slugMatchesSku(slug, skuColor) {
  if (!skuColor) return false;
  const slugColors = extractColorsFromSlug(slug);
  return colorMatchesSku(slugColors, skuColor);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 7: MAIN REWORK LOGIC
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║       BELLEZZA COMPLETE REWORK — FROM THE GROUND UP        ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  // ── Get vendor ──────────────────────────────────────────────────────
  const vendorRow = await pool.query("SELECT id FROM vendors WHERE code = 'BELLEZZA'");
  if (!vendorRow.rows.length) { console.error('Vendor BELLEZZA not found'); process.exit(1); }
  const vendorId = vendorRow.rows[0].id;

  // ── Load all Bellezza products + SKUs ───────────────────────────────
  const prodRows = await pool.query(`
    SELECT p.id, p.name, p.collection, p.status FROM products p
    WHERE p.vendor_id = $1 ORDER BY p.name
  `, [vendorId]);

  const skuRows = await pool.query(`
    SELECT s.id, s.product_id, s.internal_sku, s.variant_name, s.variant_type,
           (SELECT value FROM sku_attributes sa
            JOIN attributes a ON sa.attribute_id = a.id
            WHERE sa.sku_id = s.id AND a.slug = 'color' LIMIT 1) as color
    FROM skus s
    JOIN products p ON s.product_id = p.id
    WHERE p.vendor_id = $1
    ORDER BY s.internal_sku
  `, [vendorId]);

  // Build lookup maps
  const productByName = new Map();
  for (const p of prodRows.rows) productByName.set(p.name, p);

  const skusByProduct = new Map();
  for (const s of skuRows.rows) {
    if (!skusByProduct.has(s.product_id)) skusByProduct.set(s.product_id, []);
    skusByProduct.get(s.product_id).push(s);
  }

  console.log(`Loaded ${prodRows.rowCount} products, ${skuRows.rowCount} SKUs\n`);

  // ══════════════════════════════════════════════════════════════════════
  // STEP 1: CLEAR EXISTING DATA
  // ══════════════════════════════════════════════════════════════════════
  console.log('━━━ Step 1: Clearing existing images & accessories ━━━\n');

  const deletedImages = await pool.query(`
    DELETE FROM media_assets WHERE product_id IN (
      SELECT id FROM products WHERE vendor_id = $1
    ) RETURNING id
  `, [vendorId]);
  console.log(`  Deleted ${deletedImages.rowCount} media_assets rows`);

  const deletedAccessories = await pool.query(`
    DELETE FROM sku_accessories WHERE parent_sku_id IN (
      SELECT s.id FROM skus s JOIN products p ON s.product_id = p.id WHERE p.vendor_id = $1
    ) OR accessory_sku_id IN (
      SELECT s.id FROM skus s JOIN products p ON s.product_id = p.id WHERE p.vendor_id = $1
    ) RETURNING parent_sku_id
  `, [vendorId]);
  console.log(`  Deleted ${deletedAccessories.rowCount} sku_accessories rows\n`);

  // ══════════════════════════════════════════════════════════════════════
  // STEP 2: UPDATE COLLECTION GROUPING
  // ══════════════════════════════════════════════════════════════════════
  console.log('━━━ Step 2: Updating collection grouping ━━━\n');
  let collectionsUpdated = 0;

  for (const prod of prodRows.rows) {
    const newCollection = PRODUCT_TO_COLLECTION[prod.name];
    if (newCollection && newCollection !== prod.collection) {
      await pool.query('UPDATE products SET collection = $1 WHERE id = $2', [newCollection, prod.id]);
      collectionsUpdated++;
      console.log(`  ${prod.name}: "${prod.collection || '(none)'}" → "${newCollection}"`);
    } else if (!newCollection) {
      console.log(`  [UNMAPPED] ${prod.name} — keeping "${prod.collection || '(none)'}"`);
    }
  }
  console.log(`\n  Collections updated: ${collectionsUpdated}\n`);

  // ══════════════════════════════════════════════════════════════════════
  // STEP 3: SCRAPE IMAGES & ASSIGN PER-SKU
  // ══════════════════════════════════════════════════════════════════════
  console.log('━━━ Step 3: Fetching images & assigning per-SKU ━━━\n');

  let totalImagesSaved = 0;
  let productsWithImages = 0;
  let productsNoImages = 0;

  for (const [productName, slugs] of Object.entries(URL_MAP)) {
    const prod = productByName.get(productName);
    if (!prod) {
      console.log(`  [SKIP] No DB match: ${productName}`);
      continue;
    }

    const skus = skusByProduct.get(prod.id) || [];
    if (skus.length === 0) {
      console.log(`  [SKIP] No SKUs: ${productName}`);
      continue;
    }

    // Separate color-specific SKUs from generic/parent SKUs.
    // A SKU is color-specific if it has a single color value (no commas).
    // Parent/generic SKUs have multi-value colors (e.g., "Beige, Gray, Dark Gray") or no color.
    const childSkus = skus.filter(s => s.color && !s.color.includes(','));
    const parentSkus = skus.filter(s => !s.color || s.color.includes(','));
    const isMultiColor = childSkus.length > 0 && new Set(childSkus.map(s => s.color)).size > 1;

    // ── Collect images PER SLUG (not pooled) ──────────────────────────
    // Each slug is a separate WooCommerce page for one color variant.
    // Images from slug "chamonix-beige" belong ONLY to Beige SKUs.
    const imagesBySlug = new Map(); // slug → [{ url, isProduct, isLifestyle }]

    for (const slug of slugs) {
      const pageUrl = `${BASE_URL}/product/${slug}/`;
      const html = await fetchHtml(pageUrl);
      const images = extractImagesFromHtml(html);

      // Filter brochures, then deduplicate WordPress resize variants
      const filtered = deduplicateWpResizes(
        images.filter(u => !isBrochure(u))
      );

      const classified = filtered.map(u => ({
        url: u,
        isProduct: isProductPhoto(u),
        isLifestyle: isLifestylePhoto(u),
      }));

      imagesBySlug.set(slug, classified);
      await delay(200);
    }

    // Count total unique images across all slugs
    const allUniqueUrls = new Set();
    for (const imgs of imagesBySlug.values()) {
      for (const img of imgs) allUniqueUrls.add(img.url);
    }

    if (allUniqueUrls.size === 0) {
      productsNoImages++;
      console.log(`  [NO IMAGES] ${productName}`);
      continue;
    }

    // ── Helper: sort product photos first ─────────────────────────────
    const sortImages = (imgs) => [...imgs].sort((a, b) => {
      if (a.isProduct && !b.isProduct) return -1;
      if (!a.isProduct && b.isProduct) return 1;
      if (!a.isLifestyle && b.isLifestyle) return -1;
      if (a.isLifestyle && !b.isLifestyle) return 1;
      return 0;
    });

    // ── Helper: save images for a single SKU ──────────────────────────
    const saveSkuImages = async (skuId, images, maxImages = 6) => {
      const toSave = images.slice(0, maxImages);
      for (let i = 0; i < toSave.length; i++) {
        const img = toSave[i];
        const assetType = i === 0 ? 'primary' : (img.isLifestyle ? 'lifestyle' : 'alternate');
        await pool.query(`
          INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
          VALUES ($1, $2, $3, $4, $4, $5)
        `, [prod.id, skuId, assetType, img.url, i]);
        totalImagesSaved++;
      }
    };

    // ── Assign images to SKUs ────────────────────────────────────────

    if (isMultiColor) {
      // MULTI-COLOR: each slug's images go ONLY to SKUs matching that slug's color.
      // This prevents images from leaking across color variants.

      // Classify slugs by color
      const colorSlugs = []; // { slug, colors }
      const genericSlugs = []; // slugs with no detectable color
      for (const slug of slugs) {
        const colors = extractColorsFromSlug(slug);
        if (colors.length > 0) {
          colorSlugs.push({ slug, colors });
        } else {
          genericSlugs.push(slug);
        }
      }

      // Assign child SKUs: only images from slugs matching their color
      for (const sku of childSkus) {
        const skuColor = sku.color;
        if (!skuColor) continue;

        // Find slugs that match this SKU's color
        const matchingSlugs = colorSlugs
          .filter(({ colors }) => colorMatchesSku(colors, skuColor))
          .map(({ slug }) => slug);

        // Collect images from matching slugs only (deduplicate)
        const skuImages = [];
        const seenUrls = new Set();
        for (const slug of matchingSlugs) {
          for (const img of (imagesBySlug.get(slug) || [])) {
            if (!seenUrls.has(img.url)) {
              seenUrls.add(img.url);
              skuImages.push(img);
            }
          }
        }

        // Fallback: if no slug matched, try matching by image filename color
        if (skuImages.length === 0) {
          for (const imgs of imagesBySlug.values()) {
            for (const img of imgs) {
              const imgColors = extractColorsFromUrl(img.url);
              if (colorMatchesSku(imgColors, skuColor) && !seenUrls.has(img.url)) {
                seenUrls.add(img.url);
                skuImages.push(img);
              }
            }
          }
        }

        if (skuImages.length > 0) {
          await saveSkuImages(sku.id, sortImages(skuImages));
        }
      }

      // Parent SKUs (no color suffix) get images from generic slugs only
      if (parentSkus.length > 0) {
        const parentImages = [];
        const seenUrls = new Set();

        // Try generic slugs first
        for (const slug of genericSlugs) {
          for (const img of (imagesBySlug.get(slug) || [])) {
            if (!seenUrls.has(img.url)) {
              seenUrls.add(img.url);
              parentImages.push(img);
            }
          }
        }

        // If no generic slugs had images, use first slug's images
        if (parentImages.length === 0 && slugs.length > 0) {
          for (const img of (imagesBySlug.get(slugs[0]) || [])) {
            if (!seenUrls.has(img.url)) {
              seenUrls.add(img.url);
              parentImages.push(img);
            }
          }
        }

        for (const sku of parentSkus) {
          await saveSkuImages(sku.id, sortImages(parentImages));
        }
      }

    } else {
      // SINGLE-COLOR: all SKUs are size/finish variants of the same visual product.
      // Pool all images (deduplicated) and assign to each SKU.
      const allImages = [];
      const seenUrls = new Set();
      for (const imgs of imagesBySlug.values()) {
        for (const img of imgs) {
          if (!seenUrls.has(img.url)) {
            seenUrls.add(img.url);
            allImages.push(img);
          }
        }
      }

      const sorted = sortImages(allImages);
      for (const sku of skus) {
        await saveSkuImages(sku.id, sorted);
      }
    }

    productsWithImages++;
    // Stats for logging
    const allImgsFlat = [];
    const seenLog = new Set();
    for (const imgs of imagesBySlug.values()) {
      for (const img of imgs) {
        if (!seenLog.has(img.url)) { seenLog.add(img.url); allImgsFlat.push(img); }
      }
    }
    const productCount = allImgsFlat.filter(i => i.isProduct).length;
    const lifestyleCount = allImgsFlat.filter(i => i.isLifestyle).length;
    const otherCount = allImgsFlat.length - productCount - lifestyleCount;
    console.log(`  ✓ ${productName}: ${allImgsFlat.length} imgs (${productCount} product, ${lifestyleCount} lifestyle, ${otherCount} other) → ${skus.length} SKUs`);
  }

  console.log(`\n  Products with images: ${productsWithImages}`);
  console.log(`  Products no images: ${productsNoImages}`);
  console.log(`  Total image rows saved: ${totalImagesSaved}\n`);

  // ══════════════════════════════════════════════════════════════════════
  // STEP 4: ATTACH ACCESSORIES
  // ══════════════════════════════════════════════════════════════════════
  console.log('━━━ Step 4: Attaching accessories ━━━\n');
  let accessoriesLinked = 0;

  // 4a: Altea Jolly Trim → Altea tile SKUs (per-color matching)
  console.log('  Altea Jolly Trim → Altea tiles...');
  accessoriesLinked += await linkPerColorAccessories(vendorId,
    'Altea', 'Jolly Trim', 'Altea', ['Square', 'Subway']);

  // 4b: Limit Jolly Trim → Limit tile SKUs (per-color matching)
  console.log('  Limit Jolly Trim → Limit tiles...');
  accessoriesLinked += await linkPerColorAccessories(vendorId,
    'Limit', 'Jolly Trim', 'Limit', ['Subway']);

  // 4c: Schluter Trim → All porcelain tile SKUs (generic)
  console.log('  Schluter Trim → Porcelain tile products...');
  const schluterSkus = await pool.query(`
    SELECT s.id FROM skus s
    JOIN products p ON s.product_id = p.id
    WHERE p.vendor_id = $1 AND p.name = 'Schluter Trim'
  `, [vendorId]);

  const porcelainParents = await pool.query(`
    SELECT DISTINCT ON (p.id) s.id as sku_id
    FROM skus s
    JOIN products p ON s.product_id = p.id
    LEFT JOIN categories c ON p.category_id = c.id
    WHERE p.vendor_id = $1 AND p.status = 'active'
    AND s.variant_type IS DISTINCT FROM 'accessory'
    AND p.name NOT IN ('Schluter Trim', 'MAPEI Grout Medium Grey')
    AND (c.slug = 'porcelain-tile' OR p.name IN (
      SELECT unnest(ARRAY[
        'Chamonix','Concretus','District','Fry','Grunge','Spatula','Temper',
        'Ceppo','Bolonia Marengo','Kadence','Dolomite','Emporio Calacatta',
        'Calacatta Gold','Calacatta Natural','Naples White','Montblanc Gold',
        'WG001','Arena Chiaro','Harley Lux','Leccese Cesellata','Palatino'
      ])
    ))
    ORDER BY p.id, s.internal_sku
  `, [vendorId]);

  for (const parent of porcelainParents.rows) {
    for (let i = 0; i < schluterSkus.rows.length; i++) {
      await pool.query(`
        INSERT INTO sku_accessories (parent_sku_id, accessory_sku_id, sort_order)
        VALUES ($1, $2, $3) ON CONFLICT DO NOTHING
      `, [parent.sku_id, schluterSkus.rows[i].id, i]);
      accessoriesLinked++;
    }
  }
  console.log(`    → ${schluterSkus.rows.length} trims × ${porcelainParents.rows.length} products`);

  // 4d: MAPEI Grout → Lingot tiles
  console.log('  MAPEI Grout → Lingot tiles...');
  const groutSkus = await pool.query(`
    SELECT s.id FROM skus s JOIN products p ON s.product_id = p.id
    WHERE p.vendor_id = $1 AND p.name = 'MAPEI Grout Medium Grey'
  `, [vendorId]);

  const lingotSkus = await pool.query(`
    SELECT s.id FROM skus s JOIN products p ON s.product_id = p.id
    WHERE p.vendor_id = $1 AND p.name = 'Lingot' AND s.variant_type IS DISTINCT FROM 'accessory'
  `, [vendorId]);

  for (const lingot of lingotSkus.rows) {
    for (let i = 0; i < groutSkus.rows.length; i++) {
      await pool.query(`
        INSERT INTO sku_accessories (parent_sku_id, accessory_sku_id, sort_order)
        VALUES ($1, $2, $3) ON CONFLICT DO NOTHING
      `, [lingot.id, groutSkus.rows[i].id, i]);
      accessoriesLinked++;
    }
  }
  console.log(`    → ${groutSkus.rows.length} grout × ${lingotSkus.rows.length} Lingot SKUs`);

  console.log(`\n  Total accessories linked: ${accessoriesLinked}\n`);

  // ══════════════════════════════════════════════════════════════════════
  // STEP 5: REFRESH SEARCH VECTORS
  // ══════════════════════════════════════════════════════════════════════
  console.log('━━━ Step 5: Refreshing search vectors ━━━\n');
  await pool.query(`
    UPDATE products SET search_vector = to_tsvector('english',
      COALESCE(name,'') || ' ' || COALESCE(collection,'') || ' ' ||
      COALESCE(description_short,'') || ' ' || COALESCE(description_long,''))
    WHERE vendor_id = $1
  `, [vendorId]);
  console.log('  Search vectors refreshed\n');

  // ══════════════════════════════════════════════════════════════════════
  // SUMMARY
  // ══════════════════════════════════════════════════════════════════════
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║                        SUMMARY                             ║');
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log(`║  Collections updated:     ${String(collectionsUpdated).padStart(5)}                         ║`);
  console.log(`║  Products with images:    ${String(productsWithImages).padStart(5)}                         ║`);
  console.log(`║  Products no images:      ${String(productsNoImages).padStart(5)}                         ║`);
  console.log(`║  Total image rows saved:  ${String(totalImagesSaved).padStart(5)}                         ║`);
  console.log(`║  Accessories linked:      ${String(accessoriesLinked).padStart(5)}                         ║`);
  console.log('╚══════════════════════════════════════════════════════════════╝');

  await pool.end();
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPER: Link per-color accessories to matching parent tile SKUs
// ═══════════════════════════════════════════════════════════════════════════════

async function linkPerColorAccessories(vendorId, accessoryProductName, accessoryPattern, parentProductName, parentPatterns) {
  let linked = 0;

  // Get accessory SKUs (color-specific child SKUs)
  const accessorySkus = await pool.query(`
    SELECT s.id, s.internal_sku, s.variant_name,
           (SELECT value FROM sku_attributes sa JOIN attributes a ON sa.attribute_id = a.id
            WHERE sa.sku_id = s.id AND a.slug = 'color' LIMIT 1) as color
    FROM skus s JOIN products p ON s.product_id = p.id
    WHERE p.vendor_id = $1 AND p.name = $2
    AND s.variant_name ILIKE $3
    AND s.internal_sku ~ '-[A-Z]{3,5}$'
  `, [vendorId, accessoryProductName, `%${accessoryPattern}%`]);

  // Get parent tile SKUs (color-specific child SKUs)
  const parentSkus = await pool.query(`
    SELECT s.id, s.internal_sku, s.variant_name,
           (SELECT value FROM sku_attributes sa JOIN attributes a ON sa.attribute_id = a.id
            WHERE sa.sku_id = s.id AND a.slug = 'color' LIMIT 1) as color
    FROM skus s JOIN products p ON s.product_id = p.id
    WHERE p.vendor_id = $1 AND p.name = $2
    AND s.variant_type IS DISTINCT FROM 'accessory'
    AND s.internal_sku ~ '-[A-Z]{3,5}$'
  `, [vendorId, parentProductName]);

  // Filter parents by variant patterns
  const filteredParents = parentSkus.rows.filter(p =>
    parentPatterns.some(pat => (p.variant_name || '').toLowerCase().includes(pat.toLowerCase()))
  );

  // Match by color
  for (const parent of filteredParents) {
    const parentColor = (parent.color || '').toLowerCase();
    if (!parentColor) continue;

    const matchingAcc = accessorySkus.rows.find(a =>
      (a.color || '').toLowerCase() === parentColor
    );

    if (matchingAcc) {
      await pool.query(`
        INSERT INTO sku_accessories (parent_sku_id, accessory_sku_id, sort_order)
        VALUES ($1, $2, 0) ON CONFLICT DO NOTHING
      `, [parent.id, matchingAcc.id]);
      linked++;
    }
  }

  // Also link generic parent SKUs to generic accessory
  const genericAcc = await pool.query(`
    SELECT s.id FROM skus s JOIN products p ON s.product_id = p.id
    WHERE p.vendor_id = $1 AND p.name = $2
    AND s.variant_name ILIKE $3
    AND s.internal_sku !~ '-[A-Z]{3,5}$'
  `, [vendorId, accessoryProductName, `%${accessoryPattern}%`]);

  const genericParents = parentSkus.rows.filter(p =>
    !/-[A-Z]{3,5}$/.test(p.internal_sku) &&
    parentPatterns.some(pat => (p.variant_name || '').toLowerCase().includes(pat.toLowerCase()))
  );

  if (genericAcc.rows.length > 0) {
    for (const parent of genericParents) {
      await pool.query(`
        INSERT INTO sku_accessories (parent_sku_id, accessory_sku_id, sort_order)
        VALUES ($1, $2, 0) ON CONFLICT DO NOTHING
      `, [parent.id, genericAcc.rows[0].id]);
      linked++;
    }
  }

  console.log(`    → ${linked} color-matched pairs`);
  return linked;
}

main().catch(err => { console.error(err); process.exit(1); });
