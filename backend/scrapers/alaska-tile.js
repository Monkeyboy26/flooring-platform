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
  { slug: 'calacatti-gold-polish',           dbNames: ['Calacatta Gold'] },
  { slug: 'botghini-matte',                  dbNames: ['Calacatta Gold'] },  // Website uses odd slug for Calacatta Matte
  { slug: 'statuario-ligth',                 dbNames: ['Della Statuario Light'] },
  { slug: 'lims-white',                      dbNames: ['Lims Stone White'] },
  { slug: 'sandstone-gold',                  dbNames: ['Sandstone'] },
  { slug: 'blue-gold-onix',                  dbNames: ['Blue Gold Onyx'] },
  { slug: 'damore-blanco-grey',              dbNames: ['Damore Blanco Grey'] },
  { slug: 'sky-gold-onix',                   dbNames: ['Sky Gold Onyx'] },
  { slug: 'pacific-onyx-crema',              dbNames: ['Pacific Onyx Crema'] },
  { slug: 'matte-mosaic-hexagon',            dbNames: ['Calacatta Gold Hex Mosaic'] },
  { slug: 'della-statuario-mosaic-hexagon',  dbNames: ['Della Statuario Light Hex Mosaic'] },
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

// Extract all product images from a detail page
async function extractDetailImages(page, url) {
  try {
    const resp = await page.goto(url, { waitUntil: 'networkidle2', timeout: 25000 });
    if (!resp || resp.status() >= 400) {
      console.log(`    HTTP ${resp ? resp.status() : 'no response'} for ${url}`);
      return [];
    }
    await delay(2000);
    await scrollToLoadAll(page);

    const images = await page.evaluate(() => {
      const imgs = [];
      const seen = new Set();

      // Collect ALL images on page that are product-related
      const allImgs = document.querySelectorAll('img');
      for (const img of allImgs) {
        // Try multiple sources: src, data-src, data-lazy-src
        const src = img.src || img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || '';
        if (!src || seen.has(src)) continue;
        if (!src.includes('/wp-content/uploads/')) continue;
        if (src.includes('placeholder') || src.includes('logo') || src.includes('icon') ||
            src.includes('banner') || src.includes('specification') || src.includes('favicon')) continue;

        seen.add(src);
        imgs.push({ src, alt: img.alt || '' });
      }

      // Check for WooCommerce gallery data attributes (full-size originals)
      const galleryImgWraps = document.querySelectorAll('.woocommerce-product-gallery__image, [data-thumb]');
      for (const wrap of galleryImgWraps) {
        // data-thumb gives the thumbnail, the a[href] gives the full-size
        const link = wrap.querySelector('a');
        if (link && link.href && link.href.includes('/wp-content/uploads/') && !seen.has(link.href)) {
          seen.add(link.href);
          imgs.push({ src: link.href, alt: '' });
        }
      }

      // Also check for Elementor lightbox data
      const lightboxLinks = document.querySelectorAll('a[data-elementor-open-lightbox]');
      for (const a of lightboxLinks) {
        const href = a.href || '';
        if (href && href.includes('/wp-content/uploads/') && !seen.has(href)) {
          seen.add(href);
          imgs.push({ src: href, alt: '' });
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

      // Extract images from detail page
      const detailImages = await extractDetailImages(page, url);

      if (detailImages.length === 0) {
        console.log(`    [NO IMAGES] No images found`);
        continue;
      }

      // Deduplicate and prefer high-quality versions
      const allImageUrls = [];
      const seenUrls = new Set();

      for (const img of detailImages) {
        let url = img.src;
        // Try to get original by removing -WIDTHxHEIGHT suffix
        const hqMatch = url.match(/^(.+\/wp-content\/uploads\/.+?)-\d+x\d+(\.[a-zA-Z]+)$/);
        if (hqMatch) {
          const origUrl = `${hqMatch[1]}${hqMatch[2]}`;
          if (!seenUrls.has(origUrl)) {
            seenUrls.add(origUrl);
            allImageUrls.push(origUrl);
          }
        }
        if (!seenUrls.has(url)) {
          seenUrls.add(url);
          allImageUrls.push(url);
        }
      }

      // Mark matched product IDs
      const productIds = new Set(allMatched.map(r => r.product_id));
      for (const pid of productIds) matchedProducts.add(pid);

      // Save images to all matched SKUs
      const toSave = allImageUrls.slice(0, 6);
      for (const row of allMatched) {
        for (let i = 0; i < toSave.length; i++) {
          const assetType = i === 0 ? 'primary' : (i <= 2 ? 'alternate' : 'lifestyle');
          await upsertMediaAsset(pool, {
            product_id: row.product_id,
            sku_id: row.sku_id,
            asset_type: assetType,
            url: toSave[i],
            original_url: toSave[i],
            sort_order: i,
          });
          imagesSaved++;
        }
      }

      productsMatched += productIds.size;
      console.log(`    [SAVED] ${dbNames.join(', ')} — ${toSave.length} image(s) for ${allMatched.length} SKU(s)`);

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
