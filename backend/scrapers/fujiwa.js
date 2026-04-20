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
  launchBrowser, delay, upsertMediaAsset,
} from './base.js';

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: 5432,
  database: 'flooring_pim',
  user: 'postgres',
  password: 'postgres',
});

const BASE_URL = 'https://www.fujiwatiles.com';

// Tile-size tokens stripped when deriving display names from slugs.
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


// Extract ALL useful images from a Fujiwa WooCommerce product page.
//
// fujiwatiles.com has TWO page layouts:
//
// (1) Tile series pages (Alco Deco, Joya, Hex, Glasstel, ...)
//     - Divi hero section: 648x648 square studio shot from
//       `/wp-content/uploads/products/tiles/<slug>.jpg`
//     - Color swatches (`ul.attribute_pa_colors li img.bc-variation-image`):
//       ALL per-color 648x648 studio shots, each <li> has `data-value`
//       with color name (e.g., "joya-101-verde", "hex-10-white-matte")
//     - WooCommerce gallery: 510x145 banner crop (ignored, low quality)
//     - Lifestyle gallery (`a.glightbox`): install/lifestyle photos
//
// (2) Watermark mosaic pages (Angel Fish, Turtle, Dolphin, ...)
//     - No Divi hero section, no color swatches
//     - WooCommerce gallery (`img.wp-post-image`) IS the primary
//
// Returns: { swatches: [{src, dataValue}], hero: {src}|null,
//            mosaic: {src}|null, lifestyle: [{src}] }
async function extractAllImages(page, url) {
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
      return { swatches: [], hero: null, mosaic: null, lifestyle: [] };
    }
    await delay(1500);

    try {
      await page.waitForSelector('.woocommerce-product-gallery__image img, img.wp-post-image', { timeout: 8000 });
    } catch {
      // page has no gallery
    }

    return await page.evaluate(() => {
      function stripDims(rawUrl) {
        return rawUrl.replace(/-\d+x\d+(\.\w+)(?:\?.*)?$/, '$1');
      }
      function isValid(src) {
        if (!src || !src.includes('/wp-content/uploads/')) return false;
        const basename = (src.split('?')[0].split('/').pop() || '').toLowerCase();
        return basename && !/logo|icon|placeholder|banner|add-basket/i.test(basename);
      }

      // (1) Color swatches — per-color 648x648 studio shots
      const swatches = [];
      for (const li of document.querySelectorAll('ul.attribute_pa_colors li')) {
        const img = li.querySelector('img.bc-variation-image');
        if (!img) continue;
        const raw = img.getAttribute('data-src') || img.src || '';
        const src = stripDims(raw);
        if (!isValid(src)) continue;
        swatches.push({ src, dataValue: li.getAttribute('data-value') || '' });
      }

      // (2) Divi hero — the first /products/tiles/ img NOT in swatches/gallery
      let hero = null;
      for (const img of document.querySelectorAll('img')) {
        const raw = img.getAttribute('data-large_image')
          || img.getAttribute('data-src') || img.src || '';
        if (!raw.includes('/wp-content/uploads/products/tiles/')) continue;
        if (img.classList.contains('bc-variation-image')) continue;
        if (img.closest('ul.attribute_pa_colors')) continue;
        if (img.closest('.woocommerce-product-gallery')) continue;
        const src = stripDims(raw);
        if (isValid(src)) { hero = { src }; break; }
      }

      // (3) Mosaic primary — WooCommerce gallery (for pages w/o Divi hero)
      let mosaic = null;
      if (!hero && swatches.length === 0) {
        const galleryImg = document.querySelector('.woocommerce-product-gallery__image img');
        if (galleryImg) {
          const src = stripDims(
            galleryImg.getAttribute('data-large_image')
            || galleryImg.getAttribute('data-src')
            || galleryImg.src || ''
          );
          if (isValid(src)) mosaic = { src };
        }
        if (!mosaic) {
          const galleryA = document.querySelector('.woocommerce-product-gallery__image a');
          if (galleryA?.href) {
            const src = stripDims(galleryA.href);
            if (isValid(src)) mosaic = { src };
          }
        }
        if (!mosaic) {
          const featured = document.querySelector('img.wp-post-image');
          if (featured) {
            const src = stripDims(
              featured.getAttribute('data-large_image') || featured.src || ''
            );
            if (isValid(src)) mosaic = { src };
          }
        }
      }

      // (4) Lifestyle gallery — a.glightbox install/lifestyle photos
      const lifestyle = [];
      for (const a of document.querySelectorAll('a.glightbox')) {
        if (!a.href || !a.href.includes('/wp-content/uploads/')) continue;
        const src = stripDims(a.href);
        if (isValid(src)) lifestyle.push({ src });
      }

      return { swatches, hero, mosaic, lifestyle };
    });
  } catch (err) {
    console.log(`    Error loading ${url}: ${err.message}`);
    return { swatches: [], hero: null, mosaic: null, lifestyle: [] };
  }
}

/**
 * Build a matcher for a product's SKUs that supports direct and suffix matching.
 * This handles cases where image filenames use abbreviations (e.g., `gs-black.jpg`)
 * but vendor_skus use full names (e.g., `GLOSS-SOLID-BLACK`).
 */
function buildSkuMatcher(productSkus) {
  const byExact = new Map();   // lowercase vendor_sku → sku row
  const bySuffix = new Map();  // all possible suffixes → sku row

  for (const sku of productSkus) {
    const key = sku.vendor_sku.toLowerCase();
    byExact.set(key, sku);

    // Index by ALL possible suffixes of the vendor_sku
    // e.g., GLOSS-SOLID-BLACK → ['solid-black', 'black']
    const parts = key.split('-');
    for (let i = 1; i < parts.length; i++) {
      const suffix = parts.slice(i).join('-');
      if (!bySuffix.has(suffix)) bySuffix.set(suffix, sku);
    }
  }

  return { byExact, bySuffix };
}

/**
 * Match a swatch image filename to a SKU.
 * Tries direct filename match first, then suffix matching.
 */
function matchSwatchToSku(filename, matcher) {
  const stem = filename.replace(/\.\w+$/, '').toLowerCase();

  // 1. Direct match: gs-black → gloss-solid-black? No, but joya-101 → joya-101 ✓
  if (matcher.byExact.has(stem)) return matcher.byExact.get(stem);

  // 2. Suffix match: strip progressive prefixes from the filename
  // e.g., gs-black → try 'black' → matches GLOSS-SOLID-BLACK ✓
  const parts = stem.split('-');
  for (let i = 1; i < parts.length; i++) {
    const suffix = parts.slice(i).join('-');
    if (matcher.bySuffix.has(suffix)) return matcher.bySuffix.get(suffix);
  }

  return null;
}

/**
 * Scrape a tile series product: visit every URL slug, collect per-color
 * swatch images (648x648 studio shots), map them to SKUs, and save
 * both product-level and SKU-level media assets.
 *
 * @returns {Promise<number>} number of images saved
 */
async function scrapeTileProduct({ pool, page, productId, label, slugs, productSkus }) {
  const matcher = buildSkuMatcher(productSkus);
  const allSwatches = [];
  const allLifestyle = [];
  const seenBasenames = new Set();
  let heroImage = null;

  for (const slug of slugs) {
    const url = `${BASE_URL}/products/${slug}/`;
    console.log(`  Visiting: ${url}`);
    const result = await extractAllImages(page, url);

    // Collect hero (first one wins)
    if (!heroImage && result.hero) heroImage = result.hero;

    // Collect swatch images, deduplicated by basename
    for (const sw of result.swatches) {
      const key = (sw.src.split('?')[0].split('/').pop() || '').toLowerCase();
      if (!key || seenBasenames.has(key)) continue;
      seenBasenames.add(key);
      allSwatches.push(sw);
    }

    // Collect lifestyle images, deduplicated
    for (const lf of result.lifestyle) {
      const key = (lf.src.split('?')[0].split('/').pop() || '').toLowerCase();
      if (!key || seenBasenames.has(key)) continue;
      seenBasenames.add(key);
      allLifestyle.push(lf);
    }

    const swatchCount = result.swatches.length;
    const lifeCount = result.lifestyle.length;
    console.log(`    Found ${swatchCount} swatch(es), ${lifeCount} lifestyle, hero: ${result.hero ? 'yes' : 'no'}`);
    await delay(600);
  }

  if (allSwatches.length === 0 && !heroImage) {
    console.log(`  [NO IMAGES] ${label}`);
    return 0;
  }

  let saved = 0;

  // Save product-level primary image (hero or first swatch)
  const primarySrc = heroImage?.src || allSwatches[0]?.src;
  if (primarySrc) {
    await upsertMediaAsset(pool, {
      product_id: productId, sku_id: null,
      asset_type: 'primary', url: primarySrc, original_url: primarySrc, sort_order: 0,
    });
    saved++;
  }

  // Save per-SKU primary images from swatches
  let skuMatched = 0;
  let skuMissed = 0;
  for (const sw of allSwatches) {
    const filename = sw.src.split('/').pop();
    const matchedSku = matchSwatchToSku(filename, matcher);
    if (matchedSku) {
      await upsertMediaAsset(pool, {
        product_id: productId, sku_id: matchedSku.id,
        asset_type: 'primary', url: sw.src, original_url: sw.src, sort_order: 0,
      });
      saved++;
      skuMatched++;
    } else {
      console.log(`    [NO SKU MATCH] swatch file: ${filename} (data-value: ${sw.dataValue})`);
      skuMissed++;
    }
  }

  // Save lifestyle images at product level (up to 4)
  for (let i = 0; i < allLifestyle.length && i < 4; i++) {
    await upsertMediaAsset(pool, {
      product_id: productId, sku_id: null,
      asset_type: 'lifestyle', url: allLifestyle[i].src,
      original_url: allLifestyle[i].src, sort_order: i,
    });
    saved++;
  }

  console.log(`  [SAVED] ${label} — ${skuMatched} SKU images, ${skuMissed} unmatched, ${allLifestyle.length > 4 ? 4 : allLifestyle.length} lifestyle\n`);
  return saved;
}

/**
 * Scrape a mosaic product: simpler layout with just a WooCommerce gallery
 * image as the primary (no swatches, no Divi hero).
 *
 * @returns {Promise<number>} number of images saved
 */
async function scrapeMosaicProduct({ pool, page, productId, label, slugs }) {
  const seenBasenames = new Set();
  let primaryImage = null;

  for (const slug of slugs) {
    const url = `${BASE_URL}/products/${slug}/`;
    console.log(`  Visiting: ${url}`);
    const result = await extractAllImages(page, url);

    // Use mosaic primary or hero as fallback
    const img = result.mosaic || result.hero;
    if (img && !primaryImage) {
      primaryImage = img;
    }

    // Some mosaic pages may have swatches — collect those too
    for (const sw of result.swatches) {
      const key = (sw.src.split('?')[0].split('/').pop() || '').toLowerCase();
      if (!key || seenBasenames.has(key)) continue;
      seenBasenames.add(key);
      if (!primaryImage) primaryImage = sw;
    }

    console.log(`    Found mosaic: ${result.mosaic ? 'yes' : 'no'}, swatches: ${result.swatches.length}`);
    await delay(600);
  }

  if (!primaryImage) {
    console.log(`  [NO IMAGES] ${label}`);
    return 0;
  }

  await upsertMediaAsset(pool, {
    product_id: productId, sku_id: null,
    asset_type: 'primary', url: primaryImage.src,
    original_url: primaryImage.src, sort_order: 0,
  });

  console.log(`  [SAVED] ${label} — 1 primary image\n`);
  return 1;
}

async function run() {
  const vendorRes = await pool.query("SELECT id FROM vendors WHERE code = 'FUJIWA'");
  if (!vendorRes.rows.length) { console.error('Fujiwa vendor not found'); return; }
  const vendorId = vendorRes.rows[0].id;

  // Pre-load ALL Fujiwa SKUs grouped by product_id for efficient matching
  const allSkusRes = await pool.query(`
    SELECT s.id, s.vendor_sku, s.product_id
    FROM skus s
    JOIN products p ON s.product_id = p.id
    WHERE p.vendor_id = $1
    ORDER BY s.product_id, s.vendor_sku
  `, [vendorId]);
  const skusByProduct = new Map();
  for (const row of allSkusRes.rows) {
    if (!skusByProduct.has(row.product_id)) skusByProduct.set(row.product_id, []);
    skusByProduct.get(row.product_id).push(row);
  }
  console.log(`Loaded ${allSkusRes.rowCount} SKUs across ${skusByProduct.size} products\n`);

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

      const productSkus = skusByProduct.get(productId) || [];
      const saved = await scrapeTileProduct({
        pool, page, productId, label, slugs, productSkus,
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

      const saved = await scrapeMosaicProduct({
        pool, page, productId, label: productName, slugs,
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
