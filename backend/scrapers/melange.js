/**
 * Mélange Boutique Tile — Image Enrichment Scraper
 *
 * Products already imported from PDF price list (scripts/import-melange.js).
 * This scraper visits melangetile.com to capture product images from
 * collection pages and associate them with existing DB products.
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

// Map our product names to website URL slugs.
// Discovered by browsing the site's category index and product pages.
// URL slugs discovered from melangetile.com category_index and product_index pages.
// Multiple slugs per collection to try alternate URL patterns.
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
};

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

    // Extract large product images, excluding site-wide ones
    const rawImages = await extractLargeImages(page, siteWideImages, 120);
    const urls = rawImages.map(img => img.src);
    return filterImageUrls(urls, { maxImages: 8 });
  } catch (err) {
    console.log(`    Error loading ${url}: ${err.message}`);
    return [];
  }
}

async function run() {
  const vendorRes = await pool.query("SELECT id FROM vendors WHERE code = 'MELANGE'");
  if (!vendorRes.rows.length) {
    console.error('Melange vendor not found. Run import-melange.js first.');
    return;
  }
  const vendorId = vendorRes.rows[0].id;

  // Get all products for this vendor
  const prodRows = await pool.query(`
    SELECT id, name FROM products WHERE vendor_id = $1 ORDER BY name
  `, [vendorId]);

  console.log(`Found ${prodRows.rowCount} Melange products to enrich\n`);

  const productMap = new Map();
  for (const row of prodRows.rows) {
    productMap.set(row.name, row.id);
  }

  const browser = await launchBrowser();
  let imagesSaved = 0;
  let productsMatched = 0;

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    // Collect site-wide images to exclude
    console.log('Collecting site-wide images to exclude...');
    const siteWideImages = await collectSiteWideImages(page, BASE_URL);
    console.log(`  Found ${siteWideImages.size} site-wide images\n`);

    console.log('=== Scraping Collection Pages ===\n');

    for (const [productName, slugs] of Object.entries(URL_MAP)) {
      const productId = productMap.get(productName);
      if (!productId) {
        console.log(`  [SKIP] No DB match for: ${productName}`);
        continue;
      }

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
        console.log(`  [NO IMAGES] ${productName}\n`);
        continue;
      }

      // Save at the product level (shared across all SKUs of this product)
      const saved = await saveProductImages(pool, productId, allImageUrls, { maxImages: 6 });
      imagesSaved += saved;
      productsMatched++;
      console.log(`  [SAVED] ${productName} — ${saved} image(s)\n`);
    }

    console.log(`\n=== Scrape Complete ===`);
    console.log(`Products matched: ${productsMatched} / ${productMap.size}`);
    console.log(`Total images saved: ${imagesSaved}`);

  } finally {
    await browser.close();
    await pool.end();
  }
}

run().catch(err => { console.error(err); process.exit(1); });
