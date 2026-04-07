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

function normalizeName(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
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

const MOSAIC_URL_MAP = {
  'Angel Fish':             ['angel-fish'],
  'Ball':                   ['ball'],
  'Butterfly Fish':         ['butterfly-fish'],
  'Clown Fish':             ['clown-fish'],
  'Coral Fish':             ['coral-fish'],
  'Crab':                   ['crab'],
  'Circle Dolphin':         ['dolphin'],  // Circle Dolphin is listed under dolphin page
  'Dolphin':                ['dolphin'],
  'Kelp Fish':              ['kelp-fish'],
  'Lobster':                ['lobster'],
  'Mermaid w/ Dolphin':     ['mermaid-with-dolphin'],
  'Porpoise':               ['porpoise'],
  'Puffer Fish':            ['puffer-fish'],
  'Sand Crab':              ['sand-crab'],
  'Sanddollar':             ['sand-dollar'],
  'Seahorse (Teal)':        ['seahorse'],
  'Seahorse (Red)':         ['seahorse-blue'],
  'Spotted Fish':           ['spotted-fish'],
  'Star Shell':             ['star-shell'],
  'Starfish (Blue)':        ['starfish-blue'],
  'Starfish (Peach)':       ['starfish-peach'],
  'Starfish (Red)':         ['starfish-red'],
  'Starfish (2-Tone Blue)': ['starfish-2-tone-blue'],
  'Starfish (Peach-Orange)':['starfish-orange'],
  'Starfish (Red-Yellow)':  ['starfish-yellow'],
  'Tetra Fish':             ['tetra-fish'],
  'Turrid Shell':           ['turrid-shell'],
  'Turtle (Choco)':         ['turtle-brown'],
  'Turtle (Natural Green)': ['turtle', 'turtle-medium', 'turtle-baby'],
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

// Extract product images from a WooCommerce product page
async function extractProductImages(page, url) {
  try {
    const resp = await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 });
    if (!resp || resp.status() >= 400) {
      return [];
    }
    await delay(1500);
    await scrollToLoadAll(page);

    const images = await page.evaluate(() => {
      const imgs = [];
      const seen = new Set();

      // WooCommerce product gallery images
      const galleryImgs = document.querySelectorAll(
        '.woocommerce-product-gallery img, ' +
        '.et_pb_gallery_image img, ' +
        '.et_pb_image img, ' +
        '.product-gallery img, ' +
        '.wp-post-image, ' +
        'img.attachment-woocommerce_single'
      );
      for (const img of galleryImgs) {
        const src = img.src || img.getAttribute('data-src') || img.getAttribute('data-large_image') || '';
        if (src && !seen.has(src) && src.includes('/wp-content/uploads/') && !src.includes('placeholder')) {
          seen.add(src);
          imgs.push({ src, alt: img.alt || '' });
        }
      }

      // Also check for WooCommerce gallery data attributes
      const galleryLinks = document.querySelectorAll('.woocommerce-product-gallery__image a, a[data-src]');
      for (const a of galleryLinks) {
        const href = a.href || a.getAttribute('data-src') || '';
        if (href && !seen.has(href) && href.includes('/wp-content/uploads/')) {
          seen.add(href);
          imgs.push({ src: href, alt: '' });
        }
      }

      // Check for Divi gallery module images
      const diviImgs = document.querySelectorAll('.et_pb_gallery_item img, .et_pb_image_wrap img');
      for (const img of diviImgs) {
        const src = img.src || '';
        if (src && !seen.has(src) && src.includes('/wp-content/uploads/')) {
          seen.add(src);
          imgs.push({ src, alt: img.alt || '' });
        }
      }

      // JSON-LD structured data
      const ldScripts = document.querySelectorAll('script[type="application/ld+json"]');
      for (const script of ldScripts) {
        try {
          const data = JSON.parse(script.textContent);
          const imageArr = data.image || (data['@graph'] || []).flatMap(g => g.image || []);
          for (const imgUrl of [].concat(imageArr).filter(Boolean)) {
            const url = typeof imgUrl === 'string' ? imgUrl : imgUrl.url || imgUrl['@id'] || '';
            if (url && !seen.has(url) && url.includes('/wp-content/uploads/')) {
              seen.add(url);
              imgs.push({ src: url, alt: '' });
            }
          }
        } catch {}
      }

      // Fallback: any content images
      if (imgs.length === 0) {
        const allImgs = document.querySelectorAll('.entry-content img, .et_pb_module img, #content img');
        for (const img of allImgs) {
          const src = img.src || '';
          if (src && !seen.has(src) && src.includes('/wp-content/uploads/') &&
              !src.includes('logo') && !src.includes('icon') && !src.includes('banner')) {
            seen.add(src);
            imgs.push({ src, alt: img.alt || '' });
          }
        }
      }

      return imgs;
    });

    return images;
  } catch (err) {
    console.log(`    Error loading ${url}: ${err.message}`);
    return [];
  }
}

async function run() {
  const vendorRes = await pool.query("SELECT id FROM vendors WHERE code = 'FUJIWA'");
  if (!vendorRes.rows.length) { console.error('Fujiwa vendor not found'); return; }
  const vendorId = vendorRes.rows[0].id;

  // Get all products+SKUs for this vendor
  const skuRows = await pool.query(`
    SELECT p.id as product_id, p.name as product_name, p.collection,
           s.id as sku_id, s.internal_sku, s.vendor_sku
    FROM products p
    JOIN skus s ON s.product_id = p.id
    WHERE p.vendor_id = $1
    ORDER BY p.collection, p.name
  `, [vendorId]);

  console.log(`Found ${skuRows.rowCount} SKUs to enrich\n`);

  // Build lookup by product name
  const productsByName = new Map();
  for (const row of skuRows.rows) {
    if (!productsByName.has(row.product_name)) {
      productsByName.set(row.product_name, []);
    }
    productsByName.get(row.product_name).push(row);
  }

  const browser = await launchBrowser();
  let imagesSaved = 0;
  let productsMatched = 0;
  const matchedProducts = new Set();

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    // ==================== Tile Series ====================
    console.log('=== Scraping Tile Series ===');
    for (const [productName, slugs] of Object.entries(TILE_URL_MAP)) {
      const matched = productsByName.get(productName);
      if (!matched || matched.length === 0) {
        console.log(`  [SKIP] No DB match for product: ${productName}`);
        continue;
      }

      const productId = matched[0].product_id;
      if (matchedProducts.has(productId)) continue;

      // Visit all URL variants for this product
      const allImages = [];
      const seenUrls = new Set();

      for (const slug of slugs) {
        const url = `${BASE_URL}/products/${slug}/`;
        console.log(`  Visiting: ${url}`);

        const images = await extractProductImages(page, url);
        for (const img of images) {
          if (!seenUrls.has(img.src)) {
            seenUrls.add(img.src);
            allImages.push(img);
          }
        }
        console.log(`    Found ${images.length} images`);
        await delay(600);
      }

      if (allImages.length === 0) {
        console.log(`  [NO IMAGES] ${productName}`);
        continue;
      }

      matchedProducts.add(productId);

      // Save images to all SKUs of this product
      const toSave = allImages.slice(0, 6);
      for (const row of matched) {
        for (let i = 0; i < toSave.length; i++) {
          const assetType = i === 0 ? 'primary' : (i <= 2 ? 'alternate' : 'lifestyle');
          await upsertMediaAsset(pool, {
            product_id: row.product_id,
            sku_id: row.sku_id,
            asset_type: assetType,
            url: toSave[i].src,
            original_url: toSave[i].src,
            sort_order: i,
          });
          imagesSaved++;
        }
      }
      productsMatched++;
      console.log(`  [SAVED] ${productName} — ${toSave.length} image(s) for ${matched.length} SKU(s)\n`);
    }

    // ==================== Watermark Mosaics ====================
    console.log('\n=== Scraping Watermark Mosaics ===');
    for (const [productName, slugs] of Object.entries(MOSAIC_URL_MAP)) {
      const matched = productsByName.get(productName);
      if (!matched || matched.length === 0) {
        console.log(`  [SKIP] No DB match for: ${productName}`);
        continue;
      }

      const productId = matched[0].product_id;
      if (matchedProducts.has(productId)) continue;

      const allImages = [];
      const seenUrls = new Set();

      for (const slug of slugs) {
        const url = `${BASE_URL}/products/${slug}/`;
        console.log(`  Visiting: ${url}`);

        const images = await extractProductImages(page, url);
        for (const img of images) {
          if (!seenUrls.has(img.src)) {
            seenUrls.add(img.src);
            allImages.push(img);
          }
        }
        console.log(`    Found ${images.length} images`);
        await delay(600);
      }

      if (allImages.length === 0) {
        console.log(`  [NO IMAGES] ${productName}`);
        continue;
      }

      matchedProducts.add(productId);

      const toSave = allImages.slice(0, 6);
      for (const row of matched) {
        for (let i = 0; i < toSave.length; i++) {
          const assetType = i === 0 ? 'primary' : (i <= 2 ? 'alternate' : 'lifestyle');
          await upsertMediaAsset(pool, {
            product_id: row.product_id,
            sku_id: row.sku_id,
            asset_type: assetType,
            url: toSave[i].src,
            original_url: toSave[i].src,
            sort_order: i,
          });
          imagesSaved++;
        }
      }
      productsMatched++;
      console.log(`  [SAVED] ${productName} — ${toSave.length} image(s) for ${matched.length} SKU(s)\n`);
    }

    console.log(`\n=== Scrape Complete ===`);
    console.log(`Products matched: ${productsMatched} / ${productsByName.size}`);
    console.log(`Total images saved: ${imagesSaved}`);

  } finally {
    await browser.close();
    await pool.end();
  }
}

run().catch(err => { console.error(err); process.exit(1); });
