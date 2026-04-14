/**
 * Fujiwa Tiles — Image Enrichment Scraper
 *
 * Products already imported from PDF price list. This scraper visits
 * fujiwatiles.com (WooCommerce) to capture product images from series pages.
 *
 * URL patterns:
 *   Tiles:   /products/<series-name>-series/
 *   Mosaics: /products/<creature-name>/
 *
 * Usage: docker compose exec api node scrapers/fujiwa.js
 */

import pg from 'pg';
import {
  launchBrowser, delay, upsertMediaAsset, preferProductShot,
} from './base.js';

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: 5432,
  database: 'flooring_pim',
  user: 'postgres',
  password: 'postgres',
});

const BASE_URL = 'https://www.fujiwatiles.com';

function normalizeName(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

// Tile-size tokens that should be stripped when deriving display names
// and image-filter keywords (these are series numbers, not product identity).
const TILE_SIZE_RE = /-(100|200|300|400|500|600|700|800|900|1000|1200)(?=-|$)/g;
const TILE_SIZE_WORD = /^(100|200|300|400|500|600|700|800|900|1000|1200)$/;

// Codes that need a specific display name override (all-consonant acronyms,
// slash-delimited codes, or names where the slug doesn't convey intent).
const TILE_NAME_OVERRIDES = {
  'FGM':   'FGM',
  'KLM':   'KLM',
  'PEB':   'PEB',
  'STQ':   'STQ',
  'STS':   'STS',
  'TNT':   'TNT',
  'VIP/S': 'VIP',
};

// Codes where the image filename prefix on Fujiwa's site does NOT match the
// slug (e.g. `/products/gloss-solid-series/` but images are `gs-black.jpg`).
// When a code is here, these keywords are used instead of the slug-derived ones.
const TILE_KEYWORD_OVERRIDES = {
  'GS':          ['gs'],
  'PEBBLESTONE': ['pebble'],
  'PNR':         ['pnr'],
  'SMALT':       ['smalt'],
  'STAK':        ['stak'],
  'STAR':        ['star'],
  'UNG':         ['ung'],
};

// Mosaic pages where the main product image's filename doesn't begin with
// the page slug (mostly the starfish color variants and the brown turtle).
// Keys are the post-overhaul product names (see fujiwa-naming-overhaul.cjs).
const MOSAIC_KEYWORD_OVERRIDES = {
  'Starfish Blue':         ['starfish-light-blue', 'starfish-light'],
  'Starfish 2 Tone Blue':  ['starfish-blue-2-tone'],
  'Starfish Orange':       ['orange-peach-starfish'],
  'Starfish Yellow':       ['red-orange-starfish'],
  'Turtle Brown':          ['brown-turtle'],
};

/**
 * Derive a human-readable display name from a product's URL slug(s).
 *   'alco-deco-series'                                 → 'Alco Deco'
 *   'alex-series'                                      → 'Alex'
 *   'bora-600-series'                                  → 'Bora'
 *   ['planet-series','planet-300-series','planet-600-series'] → 'Planet'
 *   ['joya-100-series','joya-deco-series']             → 'Joya'
 *   'penny-round-series'                               → 'Penny Round'
 *   'gloss-solid-series'                               → 'Gloss Solid'
 */
function deriveDisplayName(slugs) {
  const cleaned = slugs.map(s =>
    s.replace(/-series$/, '')
     .split('-')
     .filter(w => w && !TILE_SIZE_WORD.test(w))
  );
  // Find the common word-level prefix across all slug variants
  let common = cleaned[0] || [];
  for (let i = 1; i < cleaned.length; i++) {
    const next = [];
    for (let j = 0; j < Math.min(common.length, cleaned[i].length); j++) {
      if (common[j] === cleaned[i][j]) next.push(common[j]);
      else break;
    }
    common = next;
  }
  if (!common.length) return null;
  return common.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/**
 * Build a set of filename prefixes used to recognise images that actually
 * belong to this product. Fujiwa's WordPress gallery shows "related product"
 * thumbnails on every page; those images must be filtered out.
 *   ['alco-deco-series']                → ['alco-deco']
 *   ['planet-600-series']               → ['planet']
 *   ['joya-100-series','joya-deco-series'] → ['joya','joya-deco']
 *   ['angel-fish']                      → ['angel-fish']
 *   ['starfish-red']                    → ['starfish-red']
 */
function buildImageKeywords(slugs) {
  const kws = new Set();
  for (const slug of slugs) {
    let clean = slug
      .replace(TILE_SIZE_RE, '')
      .replace(/-series$/, '')
      .replace(/--+/g, '-')
      .replace(/(^-|-$)/g, '');
    if (clean) kws.add(clean);
  }
  return [...kws];
}

/**
 * Look up a Fujiwa product ID by its price-list code. Checks both the
 * current product name (first run) and the vendor_sku prefix (idempotent
 * across re-runs after the product has been renamed).
 */
async function findProductIdByCode(pool, vendorId, code) {
  // 1. Exact name match (covers pre-rename state)
  const byName = await pool.query(
    `SELECT id FROM products WHERE vendor_id = $1 AND name = $2 LIMIT 1`,
    [vendorId, code]
  );
  if (byName.rows.length) return byName.rows[0].id;

  // 2. Vendor SKU pattern (covers post-rename state).
  //    'VIP/S' is stored in the DB as 'VIP-S'.
  const pattern = code.replace('/', '-');
  const bySku = await pool.query(
    `SELECT DISTINCT p.id FROM products p
       JOIN skus s ON s.product_id = p.id
      WHERE p.vendor_id = $1
        AND (s.vendor_sku = $2 OR s.vendor_sku LIKE $3)
      LIMIT 1`,
    [vendorId, pattern, pattern + '-%']
  );
  if (bySku.rows.length) return bySku.rows[0].id;

  return null;
}

// Map our product names to website URL slugs
// Some names differ between price list and website
const TILE_URL_MAP = {
  'ALCO':       ['alco-deco-series'],
  'ALEX':       ['alex-series'],
  'AMBON':      ['ambon-deco-series'],
  'BOHOL':      ['bohol-series'],
  'BORA':       ['bora-600-series'],
  'CEL':        ['celica-series'],
  'CRESTA':     ['cresta-series'],
  'EROS':       ['eros-100-series', 'eros-600-series'],
  'FGM':        ['fgm-series'],
  'FLORA':      ['flora-series'],
  'FUJI':       ['fuji-series'],
  'GLASSTEL':   ['glasstel-series'],
  'GS':         ['gloss-solid-series'],
  'HEX':        ['hex-series'],
  'INKA':       ['inka-series'],
  'JAVA':       ['java-series'],
  'JOYA':       ['joya-100-series', 'joya-300-series', 'joya-600-series', 'joya-deco-series'],
  'KASURI':     ['kasuri-series'],
  'KAWA':       ['kawa-series'],
  'KENJI':      ['kenji-series'],
  'KLM':        ['klm-series'],
  'KOLN':       ['koln-series'],
  'LANTERN':    ['lantern-series'],
  'LEGACY':     ['legacy-series'],
  'LICATA':     ['licata-series'],
  'LOMBO':      ['lombo-series'],
  'LUNAR':      ['lunar-series'],
  'LYRA':       ['lyra-600-series'],
  'NAMI':       ['nami-100-series', 'nami-600-series'],
  'NET':        ['net-600-series'],
  'OMEGA':      ['omega-series'],
  'PAD':        ['pad-series'],
  'PATINA':     ['patina-series'],
  'PEB':        ['peb-series'],
  'PEBBLESTONE':['pebblestone-series'],
  'PILOS':      ['pilos-series'],
  'PLANET':     ['planet-series', 'planet-300-series', 'planet-600-series'],
  'PNR':        ['penny-round-series'],
  'PRIMA':      ['prima-series'],
  'QUARZO':     ['quarzo-series'],
  'RIO':        ['rio-series'],
  'RIVERA':     ['rivera-series'],
  'RUST':       ['rust-series'],
  'SAGA':       ['saga-100-series', 'saga-600-series'],
  'SEKIS':      ['sekis-series'],
  'SIERRA':     ['sierra-series'],
  'SMALT':      ['smalt-art-series'],
  'SORA':       ['sora-700-series'],
  'STAK':       ['stak-deco-series'],
  'STAR':       ['stardon-series'],
  'STONELEDGE': ['stoneledge-series'],
  'STQ':        ['stq-series'],
  'STS':        ['sts-series'],
  'SYDNEY':     ['sydney-series'],
  'TILIS':      ['tilis-series'],
  'TITAN':      ['titan-300-series', 'titan-600-deco-series', 'titan-700-series'],
  'TNT':        ['tnt-series'],
  'TOKYO':      ['tokyo-100-series', 'tokyo-200-series', 'tokyo-600-series'],
  'UNG':        ['unglazed-100-series', 'unglazed-200-series'],
  'VENIZ':      ['veniz-series'],
  'VIGAN':      ['vigan-series'],
  'VINTA':      ['vinta-series'],
  'VIP/S':      ['vip-series'],
  'YOMBA':      ['yomba-series'],
  'YUCCA':      ['yuca-series'],
};

// Keys are the post-overhaul product names (see fujiwa-naming-overhaul.cjs).
// "Seahorse" / "Seahorse Blue" match Fujiwa's own URL structure — on their site
// the /seahorse/ page actually shows a blue-tinted seahorse file and the
// /seahorse-blue/ page shows a red-tinted one. We mirror their naming exactly.
const MOSAIC_URL_MAP = {
  'Angel Fish':            ['angel-fish'],
  'Ball':                  ['ball'],
  'Butterfly Fish':        ['butterfly-fish'],
  'Clown Fish':            ['clown-fish'],
  'Coral Fish':            ['coral-fish'],
  'Crab':                  ['crab'],
  'Circle Dolphin':        ['dolphin'],  // Circle Dolphin listed under dolphin page
  'Dolphin':               ['dolphin'],
  'Kelp Fish':             ['kelp-fish'],
  'Lobster':               ['lobster'],
  'Mermaid With Dolphin':  ['mermaid-with-dolphin'],
  'Porpoise':              ['porpoise'],
  'Puffer Fish':           ['puffer-fish'],
  'Sand Crab':             ['sand-crab'],
  'Sand Dollar':           ['sand-dollar'],
  'Seahorse':              ['seahorse'],
  'Seahorse Blue':         ['seahorse-blue'],
  'Spotted Fish':          ['spotted-fish'],
  'Star Shell':            ['star-shell'],
  'Starfish Blue':         ['starfish-blue'],
  'Starfish Peach':        ['starfish-peach'],
  'Starfish Red':          ['starfish-red'],
  'Starfish 2 Tone Blue':  ['starfish-2-tone-blue'],
  'Starfish Orange':       ['starfish-orange'],
  'Starfish Yellow':       ['starfish-yellow'],
  'Tetra Fish':            ['tetra-fish'],
  'Turrid Shell':          ['turrid-shell'],
  'Turtle Brown':          ['turtle-brown'],
  'Turtle':                ['turtle', 'turtle-medium', 'turtle-baby'],
};

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

// Extract the ONE primary product image from a Fujiwa WooCommerce product page.
//
// fujiwatiles.com has TWO page layouts and we need different selectors
// for each:
//
// (1) Tile series pages (Alco Deco, Joya, Hex, Glasstel, ...)
//     The TOP/hero photo is a Divi-theme section with a 648x648 square
//     studio shot served from `/wp-content/uploads/products/tiles/<slug>.jpg`.
//     This is the canonical primary image — it's what you see at the top
//     of the page. The WooCommerce gallery LOWER on the page contains a
//     cropped 510x145 wide BANNER crop from a different path
//     (`/wp-content/uploads/YYYY/MM/<slug>.jpg`) — that's the secondary.
//
// (2) Watermark mosaic pages (Angel Fish, Turtle, Dolphin, ...)
//     These have NO Divi hero section. The WooCommerce gallery
//     (`img.wp-post-image`) IS the primary, stored at
//     `/wp-content/uploads/YYYY/MM/<name>.jpg`.
//
// We deliberately IGNORE every other image source on the page:
//   - `img.bc-variation-image` / `ul.attribute_pa_colors ... swatch` —
//     the small 60x60 color-picker thumbnails for the OTHER colors in
//     the series. User explicitly asked us NOT to scrape these.
//   - `a.glightbox` — install/lifestyle photos from the bottom install
//     gallery (JOYA-102-ALBI.jpg-style).
//   - `img.attachment-woocommerce_thumbnail` — "You may also like"
//     related products that cross-contaminate every product page.
//   - `a.et_social_icon` — social-share duplicates.
//   - `img.zoomImg` — zoom-hover duplicate of the gallery image.
async function extractProductImages(page, url) {
  // Navigate with a generous timeout + one retry. fujiwatiles.com occasionally
  // takes a while to respond to `networkidle2`, and a page that fails
  // navigation gets a second chance on `domcontentloaded`.
  async function navigate() {
    try {
      return await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
    } catch (err) {
      console.log(`    Retrying ${url} (${err.message})`);
      try {
        return await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      } catch (err2) {
        console.log(`    Giving up on ${url}: ${err2.message}`);
        return null;
      }
    }
  }

  try {
    const resp = await navigate();
    if (!resp || resp.status() >= 400) {
      return [];
    }
    await delay(1500);

    // Wait up to 8s for the WooCommerce gallery to render.
    try {
      await page.waitForSelector('.woocommerce-product-gallery__image img, img.wp-post-image', { timeout: 8000 });
    } catch {
      // page has no gallery — probably a 404 or a landing page
    }

    const images = await page.evaluate(() => {
      // Strip WordPress dimension suffixes: -510x145.jpg → .jpg
      function stripDims(rawUrl) {
        return rawUrl.replace(/-\d+x\d+(\.\w+)(?:\?.*)?$/, '$1');
      }

      function clean(main) {
        if (!main || !main.src || !main.src.includes('/wp-content/uploads/')) return null;
        const src = stripDims(main.src);
        const basename = (src.split('?')[0].split('/').pop() || '').toLowerCase();
        if (!basename) return null;
        if (/logo|icon|placeholder|banner|add-basket/i.test(basename)) return null;
        return { src, alt: main.alt || '' };
      }

      // (1) TILE SERIES: the Divi hero section at the top of the page
      // serves its images from `/wp-content/uploads/products/tiles/<slug>.jpg`.
      // We look for the FIRST <img> on the page with that path that
      // isn't a color-picker swatch and isn't inside the WooCommerce
      // gallery. That's the 648x648 square studio shot the user wants.
      for (const img of document.querySelectorAll('img')) {
        const rawSrc = img.getAttribute('data-large_image')
          || img.getAttribute('data-src')
          || img.src || '';
        if (!rawSrc.includes('/wp-content/uploads/products/tiles/')) continue;
        // Skip color-picker swatches
        if (img.classList.contains('bc-variation-image')) continue;
        if (img.closest('ul.attribute_pa_colors')) continue;
        // Skip the WooCommerce gallery (wide banner crop from a
        // different /YYYY/MM/ upload path)
        if (img.closest('.woocommerce-product-gallery')) continue;
        const result = clean({ src: rawSrc, alt: img.alt });
        if (result) return [result];
      }

      // (2) MOSAIC PAGES: no Divi hero. The WooCommerce gallery is the
      // primary — stored at /wp-content/uploads/YYYY/MM/<name>.jpg.
      const galleryImg = document.querySelector('.woocommerce-product-gallery__image img');
      if (galleryImg) {
        const src = galleryImg.getAttribute('data-large_image')
          || galleryImg.getAttribute('data-src')
          || galleryImg.src || '';
        const result = clean({ src, alt: galleryImg.alt });
        if (result) return [result];
      }
      const gallerySrc = document.querySelector('.woocommerce-product-gallery__image a');
      if (gallerySrc && gallerySrc.href) {
        const result = clean({ src: gallerySrc.href, alt: '' });
        if (result) return [result];
      }
      const featured = document.querySelector('img.wp-post-image');
      if (featured) {
        const src = featured.getAttribute('data-large_image') || featured.src || '';
        const result = clean({ src, alt: featured.alt });
        if (result) return [result];
      }
      return [];
    });

    return images;
  } catch (err) {
    console.log(`    Error loading ${url}: ${err.message}`);
    return [];
  }
}

/**
 * Scrape a single product: visit every URL slug the product maps to,
 * collect the color-variation studio shots, and save them.
 *
 * @param {{ pool, page, productId, label, slugs, keywords, maxImages }} args
 * @returns {Promise<number>} number of images saved
 */
async function scrapeProduct({ pool, page, productId, label, slugs, keywords, maxImages = 16 }) {
  // `extractProductImages` targets `img.bc-variation-image` directly — the
  // color-variation plugin gives us exactly one 648x648 studio shot per
  // available colorway, in the vendor's intended display order. No noise,
  // no related-product contamination, no angle-suffix dupes. So this
  // function just collects from every slug the product maps to, dedupes
  // by exact basename (to handle multi-series products like Joya which
  // spans joya-100/300/600/deco URLs), and saves.
  const collected = [];
  const seenBasenames = new Set();

  for (const slug of slugs) {
    const url = `${BASE_URL}/products/${slug}/`;
    console.log(`  Visiting: ${url}`);
    const images = await extractProductImages(page, url);
    for (const img of images) {
      const key = (img.src.split('?')[0].split('/').pop() || '').toLowerCase();
      if (!key || seenBasenames.has(key)) continue;
      seenBasenames.add(key);
      collected.push(img);
    }
    console.log(`    Found ${images.length} colorway image(s)`);
    await delay(600);
  }

  if (collected.length === 0) {
    console.log(`  [NO IMAGES] ${label}`);
    return 0;
  }

  const toSave = collected.slice(0, maxImages);

  for (let i = 0; i < toSave.length; i++) {
    const assetType = i === 0 ? 'primary' : 'alternate';
    await upsertMediaAsset(pool, {
      product_id: productId,
      sku_id: null,
      asset_type: assetType,
      url: toSave[i].src,
      original_url: toSave[i].src,
      sort_order: i,
    });
  }

  console.log(`  [SAVED] ${label} — ${toSave.length} colorway image(s)\n`);
  return toSave.length;
}

async function run() {
  const vendorRes = await pool.query("SELECT id FROM vendors WHERE code = 'FUJIWA'");
  if (!vendorRes.rows.length) { console.error('Fujiwa vendor not found'); return; }
  const vendorId = vendorRes.rows[0].id;

  // Clean old media assets (will be replaced with properly-filtered images)
  const cleanResult = await pool.query(`
    DELETE FROM media_assets
    WHERE product_id IN (SELECT id FROM products WHERE vendor_id = $1)
  `, [vendorId]);
  console.log(`Cleaned ${cleanResult.rowCount} old media assets\n`);

  const browser = await launchBrowser();
  let imagesSaved = 0;
  let productsMatched = 0;
  let productsRenamed = 0;
  const matchedProducts = new Set();
  const tileTotal = Object.keys(TILE_URL_MAP).length;
  const mosaicTotal = Object.keys(MOSAIC_URL_MAP).length;

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    // ==================== Tile Series ====================
    console.log('=== Scraping Tile Series ===');
    for (const [code, slugs] of Object.entries(TILE_URL_MAP)) {
      const productId = await findProductIdByCode(pool, vendorId, code);
      if (!productId) {
        console.log(`  [SKIP] No DB match for code: ${code}`);
        continue;
      }
      if (matchedProducts.has(productId)) continue;

      // Rename product to a human-readable display name (idempotent).
      const displayName = TILE_NAME_OVERRIDES[code] || deriveDisplayName(slugs);
      if (displayName) {
        const ren = await pool.query(
          `UPDATE products SET name = $1, updated_at = CURRENT_TIMESTAMP
             WHERE id = $2 AND name <> $1
             RETURNING id`,
          [displayName, productId]
        );
        if (ren.rowCount > 0) productsRenamed++;
      }
      const label = `${code} → "${displayName}"`;

      const keywords = TILE_KEYWORD_OVERRIDES[code] || buildImageKeywords(slugs);
      const saved = await scrapeProduct({
        pool, page, productId, label, slugs, keywords, maxImages: 8,
      });
      if (saved > 0) {
        matchedProducts.add(productId);
        imagesSaved += saved;
        productsMatched++;
      }
    }

    // ==================== Watermark Mosaics ====================
    console.log('\n=== Scraping Watermark Mosaics ===');
    for (const [productName, slugs] of Object.entries(MOSAIC_URL_MAP)) {
      const r = await pool.query(
        `SELECT id FROM products WHERE vendor_id = $1 AND name = $2 LIMIT 1`,
        [vendorId, productName]
      );
      if (!r.rows.length) {
        console.log(`  [SKIP] No DB match for: ${productName}`);
        continue;
      }
      const productId = r.rows[0].id;
      if (matchedProducts.has(productId)) continue;

      const keywords = MOSAIC_KEYWORD_OVERRIDES[productName] || buildImageKeywords(slugs);
      const saved = await scrapeProduct({
        pool, page, productId, label: productName, slugs, keywords, maxImages: 6,
      });
      if (saved > 0) {
        matchedProducts.add(productId);
        imagesSaved += saved;
        productsMatched++;
      }
    }

    console.log(`\n=== Scrape Complete ===`);
    console.log(`Products matched: ${productsMatched} / ${tileTotal + mosaicTotal}`);
    console.log(`Products renamed: ${productsRenamed}`);
    console.log(`Total images saved: ${imagesSaved}`);

  } finally {
    await browser.close();
    await pool.end();
  }
}

run().catch(err => { console.error(err); process.exit(1); });
