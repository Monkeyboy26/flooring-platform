/**
 * Bellezza Ceramica — Image + Metadata Enrichment Scraper
 *
 * Products already imported from XLSX price list (scripts/import-bellezza.js).
 * This scraper visits bellezzaceramica.com (WooCommerce) to capture product
 * images, structured metadata, and generate descriptions.
 *
 * URL pattern: bellezzaceramica.com/product/<slug>/
 * WooCommerce gallery with flexslider, images in /wp-content/uploads/
 *
 * Usage: docker compose exec api node scrapers/bellezza.js
 */

import pg from 'pg';
import {
  launchBrowser, delay, upsertMediaAsset, upsertSkuAttribute,
} from './base.js';

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: 5432,
  database: 'flooring_pim',
  user: 'postgres',
  password: 'postgres',
});

const BASE_URL = 'https://bellezzaceramica.com';

// Map DB product names → website product page slugs (can be multiple slugs per product).
// Discovered by probing bellezzaceramica.com product pages (Mar 2026).
const URL_MAP = {
  // ── Porcelain & Ceramic Tiles ────────────────────────────────────
  'Angelo Silk Shimmer':      ['angelo-silk'],
  'Anima Antracita':          ['anima-antracita'],
  'Arena Chiaro':             ['arena-chiaro'],
  'Armani White':             ['armani-white'],
  'Austral Blanco':           ['austral-blanco', 'austral-blanco-calma-polished-wall-tile'],
  'Austral Essence Blanco':   ['austral-essence-blanco'],
  'Bolonia Marengo':          ['bolonia-marengo-polished', 'bolonia-marengo-matte'],
  'Calaca Gold':              ['calaca-gold', 'calaca-gold-matte'],
  'Calacatta Brick Gloss':    ['calacatta-gold-brick-gloss'],
  'Calacatta Gold':           ['calacatta-gold', 'calacatta-gold-lux'],
  'Calacatta Gloss':          ['calacatta-gloss-polished'],
  'Calacatta Hex Gloss':      ['calacatta-hex-gloss'],
  'Calacatta Natural':        ['calacatta-natural-polished'],
  'Calcutta Gold':            ['calcutta-gold'],
  'Ceppo':                    ['ceppo', 'ceppo-di-gres-avorio', 'ceppo-di-gres-grigio', 'ceppo-di-gres-nero', 'ceppo-di-gres-sabbia'],
  'Chamonix':                 ['chamonix-beige', 'chamonix-bianco', 'chamonix-dark-gray', 'chamonix-gray'],
  'Concretus':                ['concretus', 'concretus-light-matte', 'concretus-light-12x24-matte', 'concretus-light-36x36-matte'],
  'Connor Beige':             ['connor-beige-matte'],
  'District':                 ['district-denim-calma-matte', 'district-sabbia-calma', 'district-taupe-calma'],  // moon-calma-matte page 404'd; image handled via MANUAL_SKU_IMAGES
  'Docks':                    ['docks', 'docks-beige', 'docks-white'],
  'Dolomite':                 ['dolomite-matte'],
  'Emporio Calacatta':        ['emporio-calacatta-matte'],
  'Elegance Marble Pearl':    ['elegance-marble-pearl', 'elegance-marble'],
  'Epoque':                   ['epoque-white', 'epoque-black', 'epoque-ivory'],
  'Fry':                      ['fry', 'fry-bianco-matte-24x48', 'fry-nero-matte-12x24'],
  'Granby Beige':             ['granby'],
  'Grunge':                   ['grunge', 'grunge-beige', 'grunge-smoke', 'grunge-multi'],
  'Harley Lux':               ['harley-lux', 'harley-lux-black', 'harley-lux-graphite', 'harley-lux-super-white', 'harley-lux-black-semi-polish-18x36', 'harley-lux-super-white-semi-polish-18x36'],
  'Ibiza':                    ['ibiza', 'ibiza-blanco', 'ibiza-esmeralda', 'ibiza-navy', 'ibiza-perla', 'ibiza-decorado-indalo'],
  'Kadence':                  ['kadence-gris-polished', 'kadence-gris-matte', 'kadence-marfil', 'kadence-perla'],
  'Larin Marfil':             ['larin-marfil'],
  'Laurent Black':            ['laurent-black-matte', 'laurent-black-polish-36x36', 'laurent-black-matte-36x36', 'laurent-black-matte-17-1x46-5', 'laurent-black-polish-17-1x46-5'],
  'Leccese Cesellata':        ['leccese'],
  'Lingot':                   ['deco-lingot-aqua', 'deco-lingot-blue', 'deco-lingot-coral', 'deco-lingot-mint', 'deco-lingot-white'],
  'Markina Gold':             ['markina-gold'],
  'Marmo Marfil':             ['navarti-marmo-marfil'],
  'Milano Crema':             ['milano-crema'],
  'Milano Mosaic':            ['milano'],
  'Mixit Concept':            ['mixit-concept', 'mixit-concept-blanco'],
  'Modern Concrete Ivory':    ['modern-concrete-ivory'],
  'Montblanc Gold':           ['montblanc-gold'],
  'Myrcella':                 ['myrcella', 'myrcella-beige', 'myrcella-bone', 'myrcella-grey', 'myrcella-mocca'],
  'Naples White':             ['naples-white'],
  'Palatino':                 ['palatino', 'palatino-ivory', 'deco-palatino', 'deco-palatino-ivory'],
  'Pearl Onyx':               ['pearl-onyx-24x48'],
  'Puccini':                  ['puccini', 'puccini-blanco', 'puccini-marfil', 'puccini-perla'],
  'Sierra':                   ['sierra-matte-24x48'],
  'Scanda White':             ['scanda-white'],
  'Sekos White':              ['sekos-white'],
  'Spatula':                  ['spatula', 'spatula-antracite', 'spatula-grey', 'spatula-white', 'spatula-bone'],
  'Statuario Nice':           ['statuario-nice'],
  'Temper':                   ['temper', 'temper-coal', 'temper-frost', 'temper-golden', 'temper-iron'],
  'Unique Ceppo Bone':        ['unique-ceppo-bone'],
  'Volga':                    ['volga', 'volga-grafito', 'volga-gris'],
  'Westmount Beige':          ['westmount-beige'],
  'WG001':                    ['wg001m-matte', 'wg001g-24x24-polished', 'wg001g-32x32-polished', 'wg001m-matte-24x24'],

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
  'Dorset Hexagon':           ['dorset-black-hexagon', 'dorset-gray-hexagon', 'dorset-white-hexagon'],
  'Nero Marquina Matte Hexagon': ['nero-marquina-matte-hexagon'],
  'Metallic Dark Grey Mosaic': ['metallic-dark-grey-mosaic'],
  'Stainless Gold Hexagon Mosaic': ['stainless-gold-hexagon-mosaic'],

  // ── GIO Collection ──────────────────────────────────────────────
  'Gio':                      [// Hexagons
                               'gio-white-glossy-hexagon-2x2', 'gio-white-matte-hexagon-2x2', 'gio-white-matte-hexagon-4x4',
                               'gio-black-matte-hexagon-2x2', 'gio-black-matte-hexagon-4x4', 'gio-black-glossy-hexagon-2x2',
                               'gio-grey-matte-hexagon-4x4', 'gio-taupe-matte-hexagon-2x2',
                               // Stacked Linear .82x2.8
                               'gio-black-matte-stacked-linear-0-82x2-8', 'gio-white-matte-stacked-linear-0-82x2-8',
                               'gio-taupe-matte-stacked-linear-0-82x2-8',
                               // Stacked Linear .86x5.7
                               'gio-black-matte-stacked-linear-0-86x5-7', 'gio-black-glossy-stacked-linear-0-86x5-7',
                               'gio-white-matte-stacked-linear-0-86x5-7', 'gio-white-glossy-stacked-linear-0-86x5-7',
                               'gio-colbat-glossy-stacked-linear-0-86x5-7', 'gio-grey-glossy-stacked-linear-0-86x5-7',
                               // Stacked Linear 1.26x5.7
                               'gio-white-matte-stacked-linear-1-26x5-7', 'gio-white-glossy-stacked-linear-1-26x5-7',
                               'gio-colbat-glossy-stacked-linear-1-26x5-7', 'gio-grey-glossy-stacked-linear-1-26x5-7'],

  // ── Subway & Artisan ────────────────────────────────────────────
  'Altea':                    ['altea-ash-blue-4x4-3x6', 'altea-black-4x4-3x6', 'altea-dusty-pink-4x4-3x6', 'altea-matcha-4x4-3x6', 'altea-pine-green-4x4-3x6', 'altea-rosewood-4x4-3x6', 'altea-smoke-4x4-3x6', 'altea-thistle-blue-4x4-3x6', 'altea-white-4x4-3x6'],
  'Amazonia':                 ['amazonia-artic', 'amazonia-carbon', 'amazonia-chalk', 'amazonia-sand', 'amazonia-sapphire'],
  'Limit':                    ['limit-blanc-2%c2%bdx-10', 'limit-bleu-clair-2%c2%bdx-10', 'limit-bleu-izu-2%c2%bdx-10',
                               'limit-gris-2%c2%bdx-10', 'limit-jaune-2%c2%bdx-10', 'limit-menthe-2%c2%bdx-10',
                               'limit-noir-2%c2%bdx-10', 'limit-rose-2%c2%bdx-10', 'limit-sable-2%c2%bdx-10',
                               'limit-terre-2%c2%bdx-10', 'limit-vert-2%c2%bdx-10'],

  // ── Frammenti ───────────────────────────────────────────────────
  'Frammenti':                ['frammenti-fr-10-bianco-3-x16', 'frammenti-fr-10-bianco-8x8', 'frammenti-fr-12-blu-notte-3-x16',
                               'frammenti-fr-2-azzurro-3-x16', 'frammenti-fr-2-azzurro-micro-macro-8-x8',
                               'frammenti-fr-5-grigio-3-x16', 'frammenti-fr-8-nero-micro-macro-8x8'],

  // ── Recycled Glass (Union Station series on website) ────────────
  'NatureGlass Hex':          ['natureglass-black-hexagon', 'natureglass-smooth-grey-hex', 'natureglass-white-hexagon', 'grey-hexagon'],
  'Silver Matte Hex':         ['silver-matte-hexagon'],
  'Statuario Matte Hex':      ['statuario-white-matte-hexagon', 'white-hexagon-4x4'],
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

// Force a specific image URL as the product-level primary.
// Used when the vendor gallery doesn't contain a good swatch and the
// correct image only exists elsewhere in their WP media library.
const PRODUCT_PRIMARY_OVERRIDE = {
  'Calacatta Gold':         'https://bellezzaceramica.com/wp-content/uploads/2022/05/06-Calacatta-Gold-Lux.jpg',
  'Calacatta Natural':      'https://bellezzaceramica.com/wp-content/uploads/2022/05/calacatta-natural-36x36-768x766-1.jpeg',
  'Granby Beige':           'https://bellezzaceramica.com/wp-content/uploads/2024/09/granby-beige-30x60-rf-1-e1695022413413-768x384-1.jpg',
  'Granby Ivory':           'https://bellezzaceramica.com/wp-content/uploads/2024/09/Granby_beige_dark_grey_cam1.jpg',
  'Modern Concrete Ivory':  'https://bellezzaceramica.com/wp-content/uploads/2024/09/modern-concrete-ivory-detal-768x1086-1.jpg',
  'Montblanc Gold':         'https://bellezzaceramica.com/wp-content/uploads/2022/01/MONTBLANC-GOLD-24X48.jpg',
  'Westmount Beige':        'https://bellezzaceramica.com/wp-content/uploads/2024/09/westmount-beige-30x60-rf-1-e1695212563999-768x384-1.jpg',
};

/**
 * Strip WordPress intermediate-size suffixes from image URLs.
 * WP appends e.g. -600x582, -768x384-1 before the extension for resized copies.
 * Only strips widths that are known WP breakpoints (150–2048) to avoid
 * accidentally removing product dimensions like 12x24 or 120x120.
 */
function stripWpThumbnail(url) {
  return url.replace(/-(150|300|600|768|1024|1536|2048)x\d+(-\d+)?\.(jpe?g|png|gif|webp)$/i, '.$3');
}

// IMAGE_INDEX_OVERRIDE removed — primary selection now uses first non-lifestyle
// image in slider order, which matches the Bellezza product page layout.

// Manual SKU-level image overrides for variants where the vendor site has
// no dedicated page/gallery and automated scoring can't find the right image.
// Key format: "ProductName::VariantPrefix" → image URL.
// VariantPrefix is matched case-insensitively against the start of variant_name.
const MANUAL_SKU_IMAGES = {
  'Altea::Matcha':            'https://bellezzaceramica.com/wp-content/uploads/2022/04/27600_Altea_MATCHA_10x10.jpeg',
  'Angelo Silk Shimmer::Silver': 'https://bellezzaceramica.com/wp-content/uploads/2022/02/51799-angelo-silk-60-silver.jpg',
  'Angelo Silk Shimmer::Gold':   'https://bellezzaceramica.com/wp-content/uploads/2022/02/51800-angelo-silk-60-gold.jpg',
  'Concretus::Dark':          'https://bellezzaceramica.com/wp-content/uploads/2020/07/concretus-dark-36x36-1.jpg',
  'Fry::Grigio':              'https://bellezzaceramica.com/wp-content/uploads/2020/01/FryGrigioMatte12X2424X48-scaled.jpg',
  'Gio::Cobalt Matte Hexagon': 'https://bellezzaceramica.com/wp-content/uploads/2022/03/GIO-Colbat-Glossy-Stacked-Linear-0.86x5.7-3.jpg',
  'Gio::Cobalt Glossy Hexagon': 'https://bellezzaceramica.com/wp-content/uploads/2022/03/GIO-Colbat-Glossy-Stacked-Linear-0.86x5.7-3.jpg',
  'Mixit Concept::Gris':      'https://bellezzaceramica.com/wp-content/uploads/2022/05/restaurant-02-16-Mixit-Concept-Gris-Matte.jpg',
  'Metallic Dark Grey Mosaic::': 'https://bellezzaceramica.com/wp-content/uploads/2020/01/darkgreymattemosaic.jpg',
  'Elegance Marble Pearl::':  'https://bellezzaceramica.com/wp-content/uploads/2022/02/elegance-white-gloss-marble-effect-porcelain-floor-tile-sample_3663602471349_10i.jpeg',
  'Temper::Frost':             'https://bellezzaceramica.com/wp-content/uploads/2022/09/Temper-Frost-0.png',
  'Temper::Golden':            'https://bellezzaceramica.com/wp-content/uploads/2022/09/Temper-Golden-0.png',
  'Temper::Iron':              'https://bellezzaceramica.com/wp-content/uploads/2022/09/Temper-Iron-0.png',
  'Puccini::Marfil':           'https://bellezzaceramica.com/wp-content/uploads/2022/02/PUCCINO-Marfil-1.jpeg',
  'Limit::Sable':              'https://bellezzaceramica.com/wp-content/uploads/2022/04/27530_LIMIT_SABLE_60x246.jpeg',
  'Limit::Rose':               'https://bellezzaceramica.com/wp-content/uploads/2022/04/Limit_ROSE_lavabo_detalle.jpeg',

  // ── Fix broken 404 images ──────────────────────────────────────
  'Calacatta Natural::':       'https://bellezzaceramica.com/wp-content/uploads/2022/05/calacatta-natural-36x36-768x766-1.jpeg',
  'Granby Beige::':            'https://bellezzaceramica.com/wp-content/uploads/2024/09/granby-beige-30x60-rf-1-e1695022413413-768x384-1.jpg',
  'Modern Concrete Ivory::':   'https://bellezzaceramica.com/wp-content/uploads/2024/09/modern-concrete-ivory-detal-768x1086-1.jpg',
  'Westmount Beige::':         'https://bellezzaceramica.com/wp-content/uploads/2024/09/westmount-beige-30x60-rf-1-e1695212563999-768x384-1.jpg',

  // ── Fix wrong-color images ─────────────────────────────────────
  'Leccese Cesellata::Fossile': 'https://bellezzaceramica.com/wp-content/uploads/2023/12/ambi-Leccese_Fossile-60x120_2.jpg',
  'Leccese Cesellata::Fumo':    'https://bellezzaceramica.com/wp-content/uploads/2023/12/ambi_Leccese-Fumo_120x120.jpg',
  'Chamonix::Ocean':            'https://bellezzaceramica.com/wp-content/uploads/2023/10/Chamonix_Beige_Laydown.jpg',  // no Ocean image on vendor site; Beige as fallback
  'District::Moon':             'https://bellezzaceramica.com/wp-content/uploads/2020/01/DistrictMoonCalmaMatte97.8X291.2.jpg',  // product page 404'd but image file still exists
  'Milano Mosaic::Gold':        'https://bellezzaceramica.com/wp-content/uploads/2024/10/Milano-Crema-0.jpg',  // no Gold image on vendor site; Crema as fallback
  'Milano Mosaic::Silver':      'https://bellezzaceramica.com/wp-content/uploads/2024/10/Milano-Crema-0.jpg',  // no Silver image on vendor site; Crema as fallback
  'Elven::Grafito':             'https://bellezzaceramica.com/wp-content/uploads/2020/01/ElvenGrafitoLapattoWallTile15X60.jpg',

  // ── Fix wrong-product image ────────────────────────────────────
  'Montblanc Gold::':           'https://bellezzaceramica.com/wp-content/uploads/2022/01/MONTBLANC-GOLD-24X48.jpg',

  // ── Fix wrong-color (no correct source available) ──────────────
  'Granby Ivory::':             'https://bellezzaceramica.com/wp-content/uploads/2024/09/Granby_beige_dark_grey_cam1.jpg',  // vendor page only shows beige imagery
};

/** Look up a manual override for a SKU by product name + variant prefix */
function getManualSkuImage(productName, variantName) {
  if (!variantName) return null;
  const vLower = variantName.toLowerCase();
  for (const [key, url] of Object.entries(MANUAL_SKU_IMAGES)) {
    const [prod, prefix] = key.split('::');
    if (prod === productName && vLower.startsWith(prefix.toLowerCase())) return url;
  }
  return null;
}

async function scrollToLoadAll(page) {
  await page.evaluate(async () => {
    for (let i = 0; i < 15; i++) {
      window.scrollBy(0, 400);
      await new Promise(r => setTimeout(r, 200));
    }
    window.scrollTo(0, 0);
  });
  await delay(1000);
}

async function extractProductImages(page, url) {
  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    if (!resp || resp.status() >= 400) {
      console.log(`    HTTP ${resp?.status()} for ${url}`);
      return { images: [], metadata: null };
    }
    await delay(800);

    const result = await page.evaluate(() => {
      const imgs = [];
      const seen = new Set();
      let galleryIdx = 0;

      // 1. Gallery images with full-size URLs and dimensions + gallery position
      const galleryItems = document.querySelectorAll('.woocommerce-product-gallery__image');
      for (const item of galleryItems) {
        const a = item.querySelector('a');
        const img = item.querySelector('img');
        const href = a?.href || '';
        if (href && !seen.has(href) && href.includes('/wp-content/uploads/')) {
          seen.add(href);
          const w = parseInt(img?.getAttribute('data-large_image_width') || '0', 10);
          const h = parseInt(img?.getAttribute('data-large_image_height') || '0', 10);
          imgs.push({ url: href, width: w, height: h, galleryIndex: galleryIdx });
        }
        galleryIdx++;
      }

      // 2. data-large_image attributes on gallery imgs (full-size fallback)
      const galleryImgs = document.querySelectorAll(
        '.woocommerce-product-gallery img, ' +
        '.wp-post-image, ' +
        'img.attachment-woocommerce_single'
      );
      for (const img of galleryImgs) {
        const large = img.getAttribute('data-large_image') || '';
        if (large && !seen.has(large) && large.includes('/wp-content/uploads/')) {
          seen.add(large);
          const w = parseInt(img.getAttribute('data-large_image_width') || '0', 10);
          const h = parseInt(img.getAttribute('data-large_image_height') || '0', 10);
          imgs.push({ url: large, width: w, height: h });
        }
      }

      // 3. img.src — thumbnail fallback (only if no full-size found above)
      for (const img of galleryImgs) {
        const src = img.src || img.getAttribute('data-src') || '';
        if (src && !seen.has(src) && src.includes('/wp-content/uploads/') && !src.includes('placeholder')) {
          seen.add(src);
          imgs.push({ url: src, width: img.naturalWidth || 0, height: img.naturalHeight || 0 });
        }
      }

      // 4. JSON-LD structured data
      const ldScripts = document.querySelectorAll('script[type="application/ld+json"]');
      for (const script of ldScripts) {
        try {
          const data = JSON.parse(script.textContent);
          const imageArr = data.image || (data['@graph'] || []).flatMap(g => g.image || []);
          for (const imgUrl of [].concat(imageArr).filter(Boolean)) {
            const u = typeof imgUrl === 'string' ? imgUrl : imgUrl.url || '';
            if (u && !seen.has(u) && u.includes('/wp-content/uploads/')) {
              seen.add(u);
              imgs.push({ url: u, width: 0, height: 0 });
            }
          }
        } catch {}
      }

      // Fallback: any large content images
      if (imgs.length === 0) {
        const allImgs = document.querySelectorAll('.entry-content img, .et_pb_module img, #content img');
        for (const img of allImgs) {
          const src = img.src || '';
          if (src && !seen.has(src) && src.includes('/wp-content/uploads/') &&
              !src.includes('logo') && !src.includes('icon') && !src.includes('banner') &&
              img.naturalWidth > 100) {
            seen.add(src);
            imgs.push({ url: src, width: img.naturalWidth, height: img.naturalHeight });
          }
        }
      }

      // Extract structured metadata from WooCommerce product page
      const meta = {};
      // Method 1: WooCommerce additional info table
      const attrRows = document.querySelectorAll('.woocommerce-product-attributes tr');
      for (const row of attrRows) {
        const label = (row.querySelector('th')?.textContent || '').trim().toLowerCase();
        const value = (row.querySelector('td')?.textContent || '').trim();
        if (label && value) meta[label] = value;
      }
      // Method 2: product meta spans (Item #, Size, Finish, Color, Application)
      const metaEl = document.querySelector('.product_meta');
      if (metaEl) {
        const text = metaEl.innerText || '';
        for (const line of text.split('\n')) {
          const m = line.match(/^(Item\s*#|Size|Finish|Color|Application|Material)\s*:\s*(.+)/i);
          if (m) meta[m[1].toLowerCase().trim()] = m[2].trim();
        }
      }
      // Method 3: short description
      const shortDesc = document.querySelector('.woocommerce-product-details__short-description');
      if (shortDesc) {
        const text = shortDesc.innerText?.trim();
        if (text && text.length > 10 && !text.startsWith('http')) meta.short_description = text;
      }
      // Method 4: categories and tags
      const cats = [];
      document.querySelectorAll('.posted_in a').forEach(a => cats.push(a.textContent.trim()));
      if (cats.length) meta.categories = cats.join(', ');
      const tags = [];
      document.querySelectorAll('.tagged_as a').forEach(a => tags.push(a.textContent.trim()));
      if (tags.length) meta.tags = tags.join(', ');

      return { images: imgs, metadata: Object.keys(meta).length > 0 ? meta : null };
    });

    return result;
  } catch (err) {
    console.log(`    Error loading ${url}: ${err.message}`);
    return { images: [], metadata: null };
  }
}

/**
 * Check if an image URL is a lifestyle/room scene photo.
 * Bellezza product pages typically show the product swatch as the first slider
 * image. This function identifies lifestyle images so we can skip them when
 * selecting the primary — the first non-lifestyle image in slider order wins.
 */
function isLifestyleImage(imgObj) {
  const filename = (imgObj.url || '').split('/').pop().toLowerCase().normalize('NFC');

  // Room/scene keywords (multi-language)
  if (/wall|kitchen|bath|room|lobby|living|bedroom|shower|cocina|ba[nñ][oe]|lazienka|lavabo|ba[nñ]era|salon|interior|scene|installed|setting/i.test(filename)) return true;

  // Ambiance/lifestyle prefix (AMB_, ambi_, amb-)
  if (/^amb[_-i]|[_-]amb[_-i]/i.test(filename)) return true;

  // Camera render angles (cam1, cam2)
  if (/cam\d/i.test(filename)) return true;

  // Catalog/brochure scans
  if (/folder|katalog|catalog|brochure/i.test(filename)) return true;

  // Render resolution in filename
  if (filename.includes('1920x1080') || filename.includes('1280x720')) return true;

  return false;
}

/** Generate a description from scraped metadata + product name */
function generateDescription(productName, collection, meta) {
  const parts = [];
  const name = productName || collection;

  // Determine material type from categories or name
  let materialType = 'tile';
  const catStr = (meta?.categories || '').toLowerCase();
  const nameLC = (name || '').toLowerCase();
  if (catStr.includes('mosaic') || nameLC.includes('mosaic') || nameLC.includes('hex')) {
    materialType = 'mosaic tile';
  } else if (catStr.includes('porcelain') || nameLC.includes('porcelain')) {
    materialType = 'porcelain tile';
  } else if (catStr.includes('ceramic') || nameLC.includes('ceramic')) {
    materialType = 'ceramic tile';
  } else if (catStr.includes('glass') || nameLC.includes('glass')) {
    materialType = 'recycled glass tile';
  } else if (nameLC.includes('panel')) {
    materialType = 'panel';
  } else if (nameLC.includes('grout')) {
    materialType = 'grout';
  } else if (nameLC.includes('trim') || nameLC.includes('schluter')) {
    materialType = 'trim profile';
  } else if (catStr.includes('porcelain') || catStr.includes('stone look') || catStr.includes('marble look')) {
    materialType = 'porcelain tile';
  }

  // Build main sentence
  const finish = meta?.finish;
  const color = meta?.color;
  const size = meta?.size;
  const application = meta?.application;

  let desc = `The ${name} is a`;
  if (finish) desc += ` ${finish.toLowerCase()}`;
  if (color && !name.toLowerCase().includes(color.toLowerCase())) desc += ` ${color.toLowerCase()}`;
  desc += ` ${materialType} from the Bellezza Ceramica collection`;

  if (size) desc += `, available in ${size}`;
  desc += '.';

  if (application) {
    desc += ` Suitable for ${application.toLowerCase()} applications.`;
  }

  return desc;
}

/** Generate a basic description for products without website metadata */
function generateBasicDescription(productName, collection) {
  const nameLC = (productName || '').toLowerCase();
  let type = 'tile';
  if (nameLC.includes('mosaic') || nameLC.includes('hex')) type = 'mosaic tile';
  else if (nameLC.includes('panel')) type = 'panel';
  else if (nameLC.includes('grout')) type = 'grout';
  else if (nameLC.includes('trim') || nameLC.includes('schluter')) type = 'trim profile';
  else if (nameLC.includes('penny')) type = 'penny round mosaic tile';
  else if (nameLC.includes('linear') || nameLC.includes('stacked')) type = 'linear mosaic tile';

  return `The ${productName} is a ${type} from the Bellezza Ceramica collection.`;
}

/**
 * Normalize a slug into comparable tokens for variant matching.
 * e.g. "gio-black-glossy-hexagon-2x2" → ["black", "glossy", "hexagon", "2x2"]
 */
function slugToTokens(productName, slug) {
  // Remove product name prefix (e.g., "gio-" from "gio-black-glossy-...")
  const prefix = productName.toLowerCase().replace(/\s+/g, '-') + '-';
  let rest = slug.startsWith(prefix) ? slug.slice(prefix.length) : slug;

  // Normalize known quirks
  rest = rest
    .replace(/colbat/gi, 'cobalt')
    .replace(/0-82x2-8/g, '.82x2.8')
    .replace(/0-86x5-7/g, '.86x5.7')
    .replace(/1-26x5-7/g, '1.26x5.7')
    .replace(/(\d)x(\d)/g, '$1x$2');  // keep size tokens like 2x2, 4x4

  return rest.split('-').map(t => t.toLowerCase()).filter(Boolean);
}

// Color tokens get higher weight than finish/format tokens because
// color is far more visually distinctive in product photos
const COLOR_TOKENS = new Set([
  // English
  'black', 'white', 'cobalt', 'grey', 'gray', 'taupe', 'beige', 'brown',
  'cream', 'ivory', 'blue', 'green', 'red', 'gold', 'silver', 'charcoal',
  'sand', 'pearl', 'onyx', 'bone', 'smoke', 'chalk', 'frost', 'coal',
  'golden', 'iron', 'coral', 'aqua', 'mint', 'graphite', 'matcha', 'pink',
  'rosewood', 'denim', 'moon', 'carbon', 'sapphire', 'ocean',
  'dark', 'light', 'antracite',
  // Spanish/Italian/French
  'bianco', 'nero', 'grigio', 'marfil', 'perla', 'gris', 'blanco',
  'noir', 'rose', 'sable', 'vert', 'jaune', 'menthe', 'avorio',
  'fumo', 'sabbia', 'mocca', 'roble', 'grafito', 'chiaro', 'crema',
]);

/**
 * Score how well a slug matches a SKU variant_name.
 * Higher score = better match. Color tokens score 3, others score 2.
 */
function scoreSlugMatch(productName, slug, variantName) {
  const tokens = slugToTokens(productName, slug);
  const variant = variantName.toLowerCase();

  let score = 0;
  for (const token of tokens) {
    if (variant.includes(token)) {
      // Color match is worth more than finish/format match
      score += COLOR_TOKENS.has(token) ? 3 : 2;
    } else if (COLOR_TOKENS.has(token)) {
      // Wrong color in slug → strong penalty (e.g., nero slug for grigio variant)
      score -= 5;
    } else {
      // Partial match: check if size dimensions overlap (e.g., .86x5.7 shares "5.7" with 1.26x5.7)
      const sizeMatch = token.match(/[\d.]+x([\d.]+)/);
      if (sizeMatch && variant.includes('x' + sizeMatch[1])) {
        score += 1;  // partial credit for matching one size dimension
      } else if (!/^\d/.test(token)) {
        // Mild penalty for unmatched non-size, non-color tokens (breaks ties)
        score -= 1;
      }
    }
  }

  // Format mismatch penalty: showing a hexagon image for a stacked linear SKU
  // (or vice versa) is far worse than a color/size mismatch
  const slugHasHex = tokens.some(t => t === 'hexagon' || t === 'hex');
  const slugHasSL = tokens.some(t => t === 'stacked' || t === 'linear');
  const variantHasHex = variant.includes('hex');
  const variantHasSL = variant.includes('sl') || variant.includes('stacked') || variant.includes('linear');
  if ((slugHasHex && variantHasSL) || (slugHasSL && variantHasHex)) {
    score -= 10;
  }

  return score;
}

/**
 * Find the best-matching slug for a given SKU variant.
 * Returns the slug with highest token overlap.
 */
function findBestMatchingSlug(productName, variantName, slugs) {
  let bestSlug = slugs[0];
  let bestScore = -Infinity;

  for (const slug of slugs) {
    const score = scoreSlugMatch(productName, slug, variantName);
    if (score > bestScore) {
      bestScore = score;
      bestSlug = slug;
    }
  }
  return bestSlug;
}

// Normalize cross-language color synonyms so grey≈gray, bianco≈blanco≈white, etc.
const COLOR_NORMALIZE = {
  'grey': 'gray', 'grigio': 'gray',
  'bianco': 'white', 'blanco': 'white', 'blanc': 'white',
  'nero': 'black', 'noir': 'black',
  'avorio': 'ivory', 'marfil': 'ivory',
  'perla': 'pearl',
  'grafito': 'graphite',
  'fumo': 'smoke',
  'sabbia': 'sand',
  'chiaro': 'light',
  'gris': 'gray',
  'crema': 'cream',
  'golden': 'gold',
};

/**
 * Detect if an image filename has a clear color mismatch with a SKU variant.
 * Returns true if the image contains a color token that conflicts with the variant's color.
 * Used to prevent showing e.g. a Bianco image for a Gris variant.
 */
function detectColorMismatch(variantName, imageUrl) {
  const filename = (imageUrl || '').split('/').pop().toLowerCase().normalize('NFC');
  const variant = variantName.toLowerCase();

  // Extract color tokens from filename using both token splitting AND substring matching.
  // Substring matching catches CamelCase filenames like FryBiancoMatte → contains 'bianco'.
  const fileColors = new Set();
  const cleanName = filename.replace(/\.\w{3,4}$/, '');
  for (const t of cleanName.split(/[-_.]/)) {
    if (COLOR_TOKENS.has(t)) fileColors.add(t);
  }
  for (const color of COLOR_TOKENS) {
    if (color.length >= 4 && cleanName.includes(color)) fileColors.add(color);
  }

  // Extract color tokens from variant name
  const variantTokens = variant.split(/[\s-]+/);
  const variantColors = variantTokens.filter(t => COLOR_TOKENS.has(t));

  // Normalize to canonical forms (grey→gray, bianco→white, blanco→white, etc.)
  const norm = c => COLOR_NORMALIZE[c] || c;
  const normalizedFileColors = new Set([...fileColors].map(norm));
  const normalizedVariantColors = new Set(variantColors.map(norm));

  // Only flag mismatch when both sides have identifiable colors
  // AND the normalized colors don't overlap
  if (normalizedFileColors.size > 0 && normalizedVariantColors.size > 0) {
    const hasWrongColor = [...normalizedFileColors].some(c => !normalizedVariantColors.has(c));
    const hasMissingColor = [...normalizedVariantColors].some(c => !normalizedFileColors.has(c));
    return hasWrongColor && hasMissingColor;
  }

  return false;
}

async function run() {
  const vendorRes = await pool.query("SELECT id FROM vendors WHERE code = 'BELLEZZA'");
  if (!vendorRes.rows.length) {
    console.error('Bellezza vendor not found. Run import-bellezza.js first.');
    return;
  }
  const vendorId = vendorRes.rows[0].id;

  // Get all products for this vendor
  const prodRows = await pool.query(`
    SELECT id, name, collection, description_short FROM products WHERE vendor_id = $1 ORDER BY name
  `, [vendorId]);

  console.log(`Found ${prodRows.rowCount} Bellezza products to enrich\n`);

  const productMap = new Map();
  for (const row of prodRows.rows) {
    productMap.set(row.name, { id: row.id, collection: row.collection, description_short: row.description_short });
  }

  let browser = await launchBrowser();
  let imagesSaved = 0;
  let productsMatched = 0;
  let descriptionsSet = 0;
  let attributesSet = 0;

  // Helper to create a fresh page with anti-detection headers
  async function createPage(br) {
    const pg = await br.newPage();
    await pg.setViewport({ width: 1920, height: 1080 });
    await pg.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
    await pg.setExtraHTTPHeaders({
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Sec-Ch-Ua': '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': '"macOS"',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'Upgrade-Insecure-Requests': '1',
    });
    // Block images/media/fonts — we only need DOM attributes (href, data-large_image)
    await pg.setRequestInterception(true);
    pg.on('request', req => {
      const type = req.resourceType();
      if (type === 'image' || type === 'media' || type === 'font' || type === 'stylesheet') {
        req.abort();
      } else {
        req.continue();
      }
    });
    // Disable browser cache
    await pg.setCacheEnabled(false);
    await pg.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
      window.chrome = { runtime: {} };
    });
    return pg;
  }

  try {
    let page = await createPage(browser);
    let pagesVisited = 0;
    const RESTART_EVERY = 15; // restart browser every N page visits to avoid OOM

    console.log('=== Scraping Product Pages ===\n');

    for (const [productName, slugs] of Object.entries(URL_MAP)) {
      const prod = productMap.get(productName);
      if (!prod) {
        console.log(`  [SKIP] No DB match for: ${productName}`);
        continue;
      }
      const productId = prod.id;

      // Collect images per-slug (not flattened) for variant-aware assignment
      const slugImages = new Map();  // slug → images[]
      let collectedMeta = null;

      for (const slug of slugs) {
        const url = `${BASE_URL}/product/${slug}/`;
        console.log(`  Visiting: ${url}`);

        try {
          const { images, metadata } = await extractProductImages(page, url);
          if (images.length > 0) {
            // Upgrade WP thumbnail URLs to full-res before storing
            const cleaned = images.map(img => ({ ...img, url: stripWpThumbnail(img.url) }));
            slugImages.set(slug, cleaned);
          }
          // Keep first valid metadata
          if (!collectedMeta && metadata) collectedMeta = metadata;
          console.log(`    Found ${images.length} images${metadata ? ' + metadata' : ''}`);
        } catch (pageErr) {
          console.log(`    Error: ${pageErr.message}`);
          // Browser/page may have crashed — try to recover
          try {
            await page.goto('about:blank', { timeout: 5000 }).catch(() => {});
          } catch {
            console.log('    Relaunching browser...');
            try { await browser.close(); } catch {}
            browser = await launchBrowser();
            page = await createPage(browser);
          }
        }
        pagesVisited++;
        // Periodically restart browser to prevent OOM
        if (pagesVisited % RESTART_EVERY === 0) {
          console.log(`    [RESTART] Recycling browser after ${pagesVisited} pages...`);
          try { await page.close(); } catch {}
          try { await browser.close(); } catch {}
          browser = await launchBrowser();
          page = await createPage(browser);
        }
        await delay(800);
      }

      // Save images: product-level best swatch + per-SKU variant-aware swatches
      if (slugImages.size > 0) {
        // Collect all unique images (as objects) across all slugs
        const allImages = [];
        const seenUrls = new Set();
        for (const imgs of slugImages.values()) {
          for (const img of imgs) {
            const url = typeof img === 'string' ? img : img.url;
            if (!seenUrls.has(url)) {
              seenUrls.add(url);
              allImages.push(typeof img === 'string' ? { url: img, width: 0, height: 0 } : img);
            }
          }
        }

        // Check for product-level URL override first (forces a specific image URL)
        let bestImage;
        const primaryOverride = PRODUCT_PRIMARY_OVERRIDE[productName];
        if (primaryOverride) {
          bestImage = { url: primaryOverride, width: 0, height: 0 };
          console.log(`    [PRIMARY OVERRIDE] ${primaryOverride.split('/').pop()}`);
        } else {
          // Use first non-lifestyle image in slider order (matches Bellezza website)
          bestImage = allImages.find(img => !isLifestyleImage(img)) || allImages[0];
          console.log(`    Primary: ${bestImage.url.split('/').pop()} (slider order, ${allImages.length} total)`);
        }
        const bestFilename = bestImage.url.split('/').pop();

        // Helper: pick the best swatch image from a single slug's gallery.
        // Uses first non-lifestyle image in slider order.
        function bestImageForSlug(slug) {
          const imgs = slugImages.get(slug);
          if (!imgs || imgs.length === 0) return null;
          return imgs.find(img => !isLifestyleImage(img)) || imgs[0];
        }

        // Clear old product-level images
        await pool.query(`
          DELETE FROM media_assets
          WHERE product_id = $1 AND sku_id IS NULL AND asset_type IN ('primary', 'alternate', 'lifestyle')
        `, [productId]);

        // Clear old SKU-level images from previous runs
        await pool.query(`
          DELETE FROM media_assets
          WHERE product_id = $1 AND sku_id IS NOT NULL AND asset_type IN ('primary', 'alternate', 'lifestyle')
        `, [productId]);

        // Save ALL product-level images in slider order
        // First non-lifestyle image is primary, rest classified by type
        let primarySaved = false;
        for (let i = 0; i < allImages.length; i++) {
          const img = allImages[i];
          const isPrimary = img.url === bestImage.url;
          if (isPrimary) primarySaved = true;
          const isLifestyle = isLifestyleImage(img);
          const assetType = isPrimary ? 'primary' : (isLifestyle ? 'lifestyle' : 'alternate');
          await upsertMediaAsset(pool, {
            product_id: productId,
            asset_type: assetType,
            url: img.url,
            original_url: img.url,
            sort_order: i,
          });
        }

        // If the override URL didn't match any scraped image (e.g. WP thumbnail
        // suffix mismatch), save it as a separate primary asset at sort_order -1
        // so it appears first.
        if (!primarySaved && PRODUCT_PRIMARY_OVERRIDE[productName]) {
          console.log(`    [PRIMARY OVERRIDE] Saving override URL as separate primary (no match in slider)`);
          await upsertMediaAsset(pool, {
            product_id: productId,
            asset_type: 'primary',
            url: bestImage.url,
            original_url: bestImage.url,
            sort_order: -1,
          });
        } else if (!primarySaved && allImages.length > 0) {
          // Fallback: no override, but somehow no primary was assigned — mark first non-lifestyle
          const fallback = allImages.find(img => !isLifestyleImage(img)) || allImages[0];
          console.log(`    [PRIMARY FALLBACK] ${fallback.url.split('/').pop()}`);
          await pool.query(
            `UPDATE media_assets SET asset_type = 'primary' WHERE product_id = $1 AND url = $2`,
            [productId, fallback.url]
          );
        }

        // Save variant-aware SKU-level primaries
        // Each SKU gets the best swatch from its best-matching slug's gallery
        const skuRows = await pool.query('SELECT id, variant_name FROM skus WHERE product_id = $1', [productId]);
        let variantMatches = 0;
        let colorMismatches = 0;
        for (const skuRow of skuRows.rows) {
          let skuImage = bestImage; // default fallback

          // Check for manual SKU image override first
          const manualUrl = getManualSkuImage(productName, skuRow.variant_name);
          if (manualUrl) {
            skuImage = { url: manualUrl, width: 0, height: 0 };
            console.log(`    [MANUAL] ${skuRow.variant_name} → ${manualUrl.split('/').pop()}`);
            variantMatches++;
          } else if (skuRow.variant_name && slugs.length > 1) {
            // Find the best-matching slug for this SKU's variant
            const matchedSlug = findBestMatchingSlug(productName, skuRow.variant_name, slugs);
            const slugBest = bestImageForSlug(matchedSlug);
            if (slugBest) {
              // Check for color mismatch — don't assign a wrong-color image
              if (detectColorMismatch(skuRow.variant_name, slugBest.url)) {
                console.log(`    [COLOR MISMATCH] ${skuRow.variant_name} — skipping ${slugBest.url.split('/').pop()}, using product primary`);
                colorMismatches++;
              } else {
                skuImage = slugBest;
                if (skuImage.url !== bestImage.url) variantMatches++;
              }
            }
          }

          await upsertMediaAsset(pool, {
            product_id: productId,
            sku_id: skuRow.id,
            asset_type: 'primary',
            url: skuImage.url,
            original_url: skuImage.url,
            sort_order: 0,
          });
        }

        imagesSaved++;
        productsMatched++;
        const variantInfo = variantMatches > 0 ? `, ${variantMatches} variant-specific` : '';
        const mismatchInfo = colorMismatches > 0 ? `, ${colorMismatches} color-mismatch fallbacks` : '';
        console.log(`  [SAVED] ${productName} — ${bestFilename} (${allImages.length} images, ${skuRows.rows.length} SKUs${variantInfo}${mismatchInfo})`);
      } else {
        console.log(`  [NO IMAGES] ${productName}`);
      }

      // Save description if not already set
      if (!prod.description_short && collectedMeta) {
        const desc = generateDescription(productName, prod.collection, collectedMeta);
        await pool.query('UPDATE products SET description_short = $1 WHERE id = $2', [desc, productId]);
        descriptionsSet++;
        console.log(`  [DESC] ${desc}`);
      }

      // Save SKU attributes from metadata
      if (collectedMeta) {
        const skuRows = await pool.query('SELECT id FROM skus WHERE product_id = $1', [productId]);
        const attrMap = {
          'finish': collectedMeta.finish,
          'color': collectedMeta.color,
          'application': collectedMeta.application,
          'size': collectedMeta.size,
        };
        for (const skuRow of skuRows.rows) {
          for (const [attr, val] of Object.entries(attrMap)) {
            if (val) {
              await upsertSkuAttribute(pool, skuRow.id, attr, val);
              attributesSet++;
            }
          }
        }
      }

      console.log('');
    }

    // Pass 2: Generate descriptions for products still without one
    console.log('\n=== Generating descriptions for remaining products ===\n');
    const noDescRows = await pool.query(`
      SELECT id, name, collection FROM products
      WHERE vendor_id = $1 AND description_short IS NULL
      ORDER BY name
    `, [vendorId]);

    for (const row of noDescRows.rows) {
      const desc = generateBasicDescription(row.name, row.collection);
      await pool.query('UPDATE products SET description_short = $1 WHERE id = $2', [desc, row.id]);
      descriptionsSet++;
      console.log(`  [DESC] ${row.name}: ${desc}`);
    }

    // Pass 3: Activate products with images + pricing
    console.log('\n=== Activating products ===\n');
    // First activate SKUs that have pricing
    const skuActivated = await pool.query(`
      UPDATE skus SET status = 'active'
      WHERE product_id IN (SELECT id FROM products WHERE vendor_id = $1)
        AND status = 'draft'
        AND EXISTS (SELECT 1 FROM pricing pr WHERE pr.sku_id = skus.id AND pr.retail_price > 0)
      RETURNING id
    `, [vendorId]);
    console.log(`  Activated ${skuActivated.rowCount} SKUs with pricing`);

    // Then activate products that have active SKUs
    const prodActivated = await pool.query(`
      UPDATE products SET status = 'active'
      WHERE vendor_id = $1
        AND status = 'draft'
        AND EXISTS (SELECT 1 FROM skus s WHERE s.product_id = products.id AND s.status = 'active')
      RETURNING id
    `, [vendorId]);
    console.log(`  Activated ${prodActivated.rowCount} products`);

    // Refresh search vectors
    await pool.query(`
      UPDATE products SET search_vector = to_tsvector('english',
        COALESCE(name,'') || ' ' || COALESCE(collection,'') || ' ' ||
        COALESCE(description_short,'') || ' ' || COALESCE(description_long,''))
      WHERE vendor_id = $1
    `, [vendorId]);
    console.log('  Refreshed search vectors');

    console.log(`\n=== Scrape Complete ===`);
    console.log(`Products matched: ${productsMatched} / ${productMap.size}`);
    console.log(`Total images saved: ${imagesSaved}`);
    console.log(`Descriptions set: ${descriptionsSet}`);
    console.log(`Attributes set: ${attributesSet}`);

  } finally {
    await browser.close();
    await pool.end();
  }
}

run().catch(err => { console.error(err); process.exit(1); });
