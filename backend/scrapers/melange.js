/**
 * Mélange Boutique Tile — Image Enrichment Scraper
 *
 * Products already imported from PDF price list (scripts/import-melange.js).
 * This scraper visits melangetile.com to capture product images from
 * collection pages and associate them with existing DB products.
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
};

/** Normalize a string for fuzzy matching: lowercase, strip separators. */
function normalize(str) {
  return decodeURIComponent(str).toLowerCase().replace(/[-_\s]+/g, '');
}

/** Extract filename from URL (last path segment, no query string). */
function getFilename(url) {
  try { return new URL(url).pathname.split('/').pop() || ''; }
  catch { return url.split('/').pop().split('?')[0] || ''; }
}

/** Match an image URL to a color name. Returns matched color or null. */
function matchImageToColor(imageUrl, colorNames) {
  const filename = normalize(getFilename(imageUrl));
  for (const color of colorNames) {
    const normColor = normalize(color);
    if (normColor.length <= 2) continue;
    if (filename.includes(normColor)) return color;
  }
  return null;
}

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

  // Get all products with their collection field
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

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    // Collect site-wide images to exclude
    console.log('Collecting site-wide images to exclude...');
    const siteWideImages = await collectSiteWideImages(page, BASE_URL);
    console.log(`  Found ${siteWideImages.size} site-wide images\n`);

    console.log('=== Scraping Collection Pages ===\n');

    for (const [collectionName, slugs] of Object.entries(URL_MAP)) {
      const products = collectionProducts.get(collectionName);
      if (!products || products.length === 0) {
        console.log(`  [SKIP] No DB products for collection: ${collectionName}`);
        continue;
      }

      const colorNames = products.map(p => p.name);
      console.log(`[${collectionName}] Colors: ${colorNames.join(', ')}`);

      // Scrape all images from collection page(s)
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

      // Match each image to a color by filename analysis
      const colorImages = new Map();  // color name → [url]
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

      // Delete existing media_assets for all products in this collection
      const productIds = products.map(p => p.id);
      await pool.query('DELETE FROM media_assets WHERE product_id = ANY($1)', [productIds]);

      // Save per-product: color-specific images first, then generics as lifestyle
      for (const product of products) {
        const ownImages = colorImages.get(product.name) || [];
        const combined = [...ownImages, ...genericImages];
        const toSave = combined.slice(0, 6);

        if (toSave.length === 0) continue;

        for (let i = 0; i < toSave.length; i++) {
          const isOwn = i < ownImages.length;
          let assetType;
          if (!isOwn) {
            assetType = 'lifestyle';
          } else if (i === 0) {
            assetType = 'primary';
          } else if (i <= 2) {
            assetType = 'alternate';
          } else {
            assetType = 'lifestyle';
          }

          await upsertMediaAsset(pool, {
            product_id: product.id,
            sku_id: null,
            asset_type: assetType,
            url: toSave[i],
            original_url: toSave[i],
            sort_order: i,
          });
        }

        imagesSaved += toSave.length;
        productsMatched++;
        console.log(`  [SAVED] ${product.name}: ${ownImages.length} color-specific + ${Math.min(genericImages.length, toSave.length - ownImages.length)} generic`);
      }
      console.log();
    }

    console.log(`\n=== Scrape Complete ===`);
    console.log(`Products matched: ${productsMatched} / ${prodRows.rowCount}`);
    console.log(`Total images saved: ${imagesSaved}`);

  } finally {
    await browser.close();
    await pool.end();
  }
}

run().catch(err => { console.error(err); process.exit(1); });
