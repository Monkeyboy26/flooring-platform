/**
 * Alaska Tile — Image Enrichment Scraper
 *
 * Products already imported from PDF price list. This scraper visits
 * alaskatileusa.com (WordPress/Elementor) to capture product images
 * from individual product detail pages.
 *
 * Uses a direct URL → DB product mapping since the website only lists
 * "General Price List" products. Collection products (Fascino, Medley,
 * Arena, Alpine, Essence, Blossom) are not on the website.
 *
 * Usage: docker compose exec api node scrapers/alaska-tile.js
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

const BASE_URL = 'https://alaskatileusa.com';

// Direct URL mapping: website slug → DB product name(s)
// Product pages discovered from the website
const PRODUCT_PAGES = [
  { slug: 'calacatta-gold-polish',           dbNames: ['Calacatta Gold'] },
  { slug: 'botghini-matte',                  dbNames: ['Calacatta Gold'] },  // Website uses odd slug for Calacatta Matte
  { slug: 'statuario-ligth',                 dbNames: ['Della Statuario Light'] },
  { slug: 'lims-white',                      dbNames: ['Lims White'] },
  { slug: 'sandstone-gold',                  dbNames: ['Sandstone Gold'] },
  { slug: 'blue-gold-onix',                  dbNames: ['Blue Gold Onix'] },
  { slug: 'damore-blanco-grey',              dbNames: ['Damore Blanco Grey'] },
  { slug: 'sky-gold-onix',                   dbNames: ['Sky Gold Onix'] },
  { slug: 'pacific-onyx-crema',              dbNames: ['Pacific Onyx Crema'] },
  { slug: 'matte-mosaic-hexagon',            dbNames: ['Calacatta Mosaic Hex'] },
  { slug: 'della-statuario-mosaic-hexagon',  dbNames: ['Della Statuario Mosaic Hex'] },
];

function normalizeName(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

async function scrollToLoadAll(page) {
  await page.evaluate(async () => {
    const distance = 400;
    const delay = 250;
    const height = document.body.scrollHeight;
    for (let pos = 0; pos < height; pos += distance) {
      window.scrollTo(0, pos);
      await new Promise(r => setTimeout(r, delay));
    }
    window.scrollTo(0, 0);
  });
  await delay(1500);
}

// Extract product images (right-side gallery) and lifestyle images (left-side carousel)
// from an Elementor product detail page.
//
// Layout: two-column section
//   Left column  → elementor-widget-image-carousel (swiper) → lifestyle/room scenes
//   Right column → elementor-widget-image-gallery            → product close-ups (primary)
async function extractDetailImages(page, url) {
  try {
    const resp = await page.goto(url, { waitUntil: 'networkidle2', timeout: 25000 });
    if (!resp || resp.status() >= 400) {
      console.log(`    HTTP ${resp ? resp.status() : 'no response'} for ${url}`);
      return { product: [], lifestyle: [] };
    }
    await delay(2000);
    await scrollToLoadAll(page);

    const result = await page.evaluate(() => {
      const product = [];
      const lifestyle = [];
      const seen = new Set();

      function addUrl(url, list) {
        if (!url || seen.has(url)) return;
        if (!url.includes('/wp-content/uploads/')) return;
        if (/placeholder|logo|icon|banner|specification|favicon/i.test(url)) return;
        seen.add(url);
        list.push(url);
      }

      // Find the two-column product section: one column has an image-carousel,
      // the other has image-gallery widgets.
      const sections = document.querySelectorAll('[data-element_type="section"]');
      for (const section of sections) {
        const columns = section.querySelectorAll(':scope > .elementor-container > .elementor-column');
        if (columns.length < 2) continue;

        let carouselCol = null;
        let galleryCol = null;
        for (const col of columns) {
          if (col.querySelector('.elementor-widget-image-carousel')) carouselCol = col;
          if (col.querySelector('.elementor-widget-image-gallery')) galleryCol = col;
        }
        if (!carouselCol || !galleryCol) continue;

        // RIGHT SIDE — product images from image-gallery widgets
        // Prefer full-size URLs from <a> hrefs over thumbnail <img> srcs
        const galleryLinks = galleryCol.querySelectorAll('.elementor-widget-image-gallery a');
        for (const a of galleryLinks) {
          addUrl(a.href, product);
        }
        // Fallback: if no links, grab img srcs
        if (product.length === 0) {
          const galleryImgs = galleryCol.querySelectorAll('.elementor-widget-image-gallery img');
          for (const img of galleryImgs) {
            addUrl(img.src || img.getAttribute('data-src') || '', product);
          }
        }

        // LEFT SIDE — lifestyle images from image-carousel (swiper)
        // Skip duplicate slides added by swiper for looping
        const carouselImgs = carouselCol.querySelectorAll('.swiper-slide:not(.swiper-slide-duplicate) img');
        for (const img of carouselImgs) {
          addUrl(img.src || img.getAttribute('data-src') || '', lifestyle);
        }

        break; // Only process the first matching section
      }

      return { product, lifestyle };
    });

    return result;
  } catch (err) {
    console.log(`    Error loading ${url}: ${err.message}`);
    return { product: [], lifestyle: [] };
  }
}

async function run() {
  const vendorRes = await pool.query("SELECT id FROM vendors WHERE code = 'ALASKATILE'");
  if (!vendorRes.rows.length) { console.error('Alaska Tile vendor not found'); return; }
  const vendorId = vendorRes.rows[0].id;

  // Get all SKUs for this vendor
  const skuRows = await pool.query(`
    SELECT p.id as product_id, p.name as product_name, p.collection,
           s.id as sku_id, s.internal_sku, s.vendor_sku, s.variant_name
    FROM products p
    JOIN skus s ON s.product_id = p.id
    WHERE p.vendor_id = $1
    ORDER BY p.collection, p.name, s.variant_name
  `, [vendorId]);

  console.log(`Found ${skuRows.rowCount} SKUs total for Alaska Tile\n`);

  // Build lookup by normalized product name
  const productsByName = new Map();
  for (const row of skuRows.rows) {
    const key = normalizeName(row.product_name);
    if (!productsByName.has(key)) {
      productsByName.set(key, []);
    }
    productsByName.get(key).push(row);
  }

  const browser = await launchBrowser();
  let imagesSaved = 0;
  let productsMatched = 0;
  const matchedProducts = new Set();

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    console.log('=== Scraping Product Detail Pages ===\n');

    for (const { slug, dbNames } of PRODUCT_PAGES) {
      const url = `${BASE_URL}/${slug}/`;
      console.log(`  Visiting: ${url}`);

      // Find matching DB products
      const allMatched = [];
      for (const dbName of dbNames) {
        const key = normalizeName(dbName);
        const rows = productsByName.get(key);
        if (rows) {
          for (const row of rows) {
            if (!matchedProducts.has(row.product_id)) {
              allMatched.push(row);
            }
          }
        }
      }

      if (allMatched.length === 0) {
        console.log(`    [SKIP] No unmatched DB products for: ${dbNames.join(', ')}`);
        continue;
      }

      // Extract images from detail page (separated by type)
      const { product: productImages, lifestyle: lifestyleImages } = await extractDetailImages(page, url);

      if (productImages.length === 0 && lifestyleImages.length === 0) {
        console.log(`    [NO IMAGES] No images found`);
        continue;
      }

      // Strip WP thumbnail suffixes (-WIDTHxHEIGHT) to get full-size originals
      function toFullSize(urls) {
        const out = [];
        const seen = new Set();
        for (const u of urls) {
          const hqMatch = u.match(/^(.+\/wp-content\/uploads\/.+?)-\d+x\d+(\.[a-zA-Z]+)$/);
          const full = hqMatch ? `${hqMatch[1]}${hqMatch[2]}` : u;
          if (!seen.has(full)) { seen.add(full); out.push(full); }
        }
        return out;
      }

      const productUrls = toFullSize(productImages);
      const lifestyleUrls = toFullSize(lifestyleImages);

      // Mark matched product IDs
      const productIds = new Set(allMatched.map(r => r.product_id));
      for (const pid of productIds) matchedProducts.add(pid);

      // Save images to all matched SKUs
      // Product images → primary (first) + alternate (rest)
      // Lifestyle images → lifestyle
      let sortOrder = 0;
      for (const row of allMatched) {
        sortOrder = 0;
        for (let i = 0; i < productUrls.length; i++) {
          const assetType = i === 0 ? 'primary' : 'alternate';
          await upsertMediaAsset(pool, {
            product_id: row.product_id,
            sku_id: row.sku_id,
            asset_type: assetType,
            url: productUrls[i],
            original_url: productUrls[i],
            sort_order: sortOrder++,
          });
          imagesSaved++;
        }
        for (let i = 0; i < lifestyleUrls.length; i++) {
          await upsertMediaAsset(pool, {
            product_id: row.product_id,
            sku_id: row.sku_id,
            asset_type: 'lifestyle',
            url: lifestyleUrls[i],
            original_url: lifestyleUrls[i],
            sort_order: sortOrder++,
          });
          imagesSaved++;
        }
      }

      productsMatched += productIds.size;
      console.log(`    [SAVED] ${dbNames.join(', ')} — ${productUrls.length} product + ${lifestyleUrls.length} lifestyle image(s) for ${allMatched.length} SKU(s)`);

      await delay(800);
    }

    const totalProducts = productsByName.size;
    const websiteProducts = PRODUCT_PAGES.reduce((s, p) => s + p.dbNames.length, 0);
    console.log(`\n=== Scrape Complete ===`);
    console.log(`Products matched: ${productsMatched} / ${totalProducts}`);
    console.log(`Total images saved: ${imagesSaved}`);
    console.log(`Coverage: ${(productsMatched / totalProducts * 100).toFixed(1)}%`);
    console.log(`Note: ${totalProducts - new Set(PRODUCT_PAGES.flatMap(p => p.dbNames)).size} collection products have no website listing`);

  } finally {
    await browser.close();
    await pool.end();
  }
}

run().catch(err => { console.error(err); process.exit(1); });
