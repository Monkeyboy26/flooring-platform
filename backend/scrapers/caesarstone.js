/**
 * Caesarstone — Image Enrichment Scraper
 *
 * Products already imported from PDF price list. This scraper visits
 * caesarstoneus.com to capture product images from individual color pages.
 *
 * URL pattern: /countertops/[item#]-[color-name-slug]/
 * Examples:
 *   /countertops/3100-jet-black/
 *   /countertops/551-travina/
 *   /countertops/5131-calacatta-nuvo/
 *
 * Many item#s appear across multiple product lines (Quartz, Mineral, ICON).
 * We visit each URL once and apply images to all SKUs sharing that item#.
 *
 * Usage: docker compose exec api node scrapers/caesarstone.js
 */

import pg from 'pg';
import puppeteer from 'puppeteer';
import {
  delay, upsertMediaAsset,
} from './base.js';

function launchBrowserWithTimeout() {
  return puppeteer.launch({
    headless: 'new',
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    protocolTimeout: 120000,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
}

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: 5432,
  database: 'flooring_pim',
  user: 'postgres',
  password: 'postgres',
});

const BASE_URL = 'https://www.caesarstoneus.com';

function slugify(name) {
  return name.toLowerCase()
    .replace(/['']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function scrollToLoadAll(page) {
  await page.evaluate(async () => {
    const distance = 400;
    const d = 200;
    const height = document.body.scrollHeight;
    for (let pos = 0; pos < height; pos += distance) {
      window.scrollTo(0, pos);
      await new Promise(r => setTimeout(r, d));
    }
    window.scrollTo(0, 0);
  });
  await delay(1000);
}

function getFullSizeUrl(url) {
  return url.replace(/-\d+x\d+(\.[a-zA-Z]+)$/, '$1');
}

async function extractImages(page, url, attempt = 1) {
  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    // Wait for images to load after DOM is ready
    await delay(3000);
    if (!resp || resp.status() >= 400) {
      console.log(`    HTTP ${resp ? resp.status() : 'no response'}`);
      return [];
    }
    await delay(2000);
    await scrollToLoadAll(page);

    return page.evaluate(() => {
      const imgs = [];
      const seen = new Set();

      // Collect product images from wp-content/uploads
      const allImgs = document.querySelectorAll('img');
      for (const img of allImgs) {
        const src = img.src || img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || '';
        if (!src || !src.includes('/wp-content/uploads/')) continue;
        if (src.includes('logo') || src.includes('icon') || src.includes('favicon') ||
            src.includes('banner') || src.includes('arrow') || src.includes('menu') ||
            src.includes('social') || src.includes('badge') || src.includes('cert')) continue;

        // Skip tiny images
        const w = img.naturalWidth || img.width || 0;
        if (w > 0 && w < 80) continue;

        if (!seen.has(src)) {
          seen.add(src);
          imgs.push({ src, alt: img.alt || '', w });
        }
      }

      // Check for full-size in gallery/lightbox links
      const links = document.querySelectorAll('a[href*="/wp-content/uploads/"]');
      for (const a of links) {
        const href = a.href || '';
        if (href && !seen.has(href) && !href.includes('logo') && !href.includes('.pdf') &&
            !href.includes('.svg')) {
          seen.add(href);
          imgs.push({ src: href, alt: '', w: 0 });
        }
      }

      // Also check srcset for high-res versions
      const allPictures = document.querySelectorAll('source[srcset*="/wp-content/uploads/"]');
      for (const source of allPictures) {
        const srcset = source.srcset || '';
        const urls = srcset.split(',').map(s => s.trim().split(' ')[0]);
        for (const u of urls) {
          if (u && !seen.has(u) && u.includes('/wp-content/uploads/')) {
            seen.add(u);
            imgs.push({ src: u, alt: '', w: 0 });
          }
        }
      }

      return imgs;
    });
  } catch (err) {
    console.log(`    Error: ${err.message}`);
    return [];
  }
}

const BATCH_SIZE = 15;  // Recycle browser every N pages to avoid rate limits

async function createPage(browser) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  return page;
}

async function run() {
  const vendorRes = await pool.query("SELECT id FROM vendors WHERE code = 'CAESARSTONE'");
  if (!vendorRes.rows.length) { console.error('Caesarstone vendor not found'); return; }
  const vendorId = vendorRes.rows[0].id;

  // Get all SKUs grouped by vendor_sku (item#)
  const skuRows = await pool.query(`
    SELECT p.id as product_id, p.name as product_name, p.collection,
           s.id as sku_id, s.vendor_sku, s.internal_sku
    FROM products p
    JOIN skus s ON s.product_id = p.id
    WHERE p.vendor_id = $1
    ORDER BY s.vendor_sku, p.collection
  `, [vendorId]);

  // Find which SKUs already have a primary image
  const existingImages = await pool.query(`
    SELECT DISTINCT s.vendor_sku
    FROM media_assets ma
    JOIN skus s ON s.id = ma.sku_id
    JOIN products p ON p.id = s.product_id
    WHERE p.vendor_id = $1 AND ma.asset_type = 'primary'
  `, [vendorId]);
  const alreadyScraped = new Set(existingImages.rows.map(r => r.vendor_sku));

  // Group by vendor_sku — visit each URL once, apply images to all matching SKUs
  const byItemCode = new Map();
  for (const row of skuRows.rows) {
    const key = row.vendor_sku;
    if (!byItemCode.has(key)) {
      byItemCode.set(key, { name: row.product_name, rows: [] });
    }
    byItemCode.get(key).rows.push(row);
  }

  // Filter to only items that still need images
  const toScrape = [...byItemCode.entries()].filter(([code]) => !alreadyScraped.has(code));
  const skipped = byItemCode.size - toScrape.length;

  console.log(`Found ${byItemCode.size} unique item codes (${skuRows.rowCount} total SKUs)`);
  console.log(`Already have images: ${skipped}, need to scrape: ${toScrape.length}\n`);

  let imagesSaved = 0;
  let productsMatched = 0;
  let productsFailed = 0;
  let browser = await launchBrowserWithTimeout();
  let pagesSinceLaunch = 0;

  try {
    let page = await createPage(browser);

    for (const [itemCode, { name, rows }] of toScrape) {
      // Recycle browser to avoid rate limiting
      if (pagesSinceLaunch >= BATCH_SIZE) {
        console.log(`\n  [Recycling browser after ${BATCH_SIZE} pages, pausing 15s...]\n`);
        try { await page.close(); } catch (_) {}
        try { await browser.close(); } catch (_) {}
        await delay(15000);
        browser = await launchBrowserWithTimeout();
        page = await createPage(browser);
        pagesSinceLaunch = 0;
      }

      const slug = slugify(name);
      const url = `${BASE_URL}/countertops/${itemCode}-${slug}/`;
      console.log(`  ${itemCode} ${name} → ${url}`);

      const images = await extractImages(page, url);
      pagesSinceLaunch++;

      // Deduplicate, prefer full-size
      const allUrls = [];
      const seenUrls = new Set();
      for (const img of images) {
        const full = getFullSizeUrl(img.src);
        if (!seenUrls.has(full)) {
          seenUrls.add(full);
          // Prefer JPG over WebP for compatibility
          if (!full.endsWith('.webp') || !seenUrls.has(full.replace('.webp', '.jpg'))) {
            allUrls.push(full);
          }
        }
      }

      if (allUrls.length === 0) {
        console.log(`    [NO IMAGES]`);
        productsFailed++;
        continue;
      }

      // Save up to 6 images to all SKUs sharing this item code
      const toSave = allUrls.slice(0, 6);
      const productIds = new Set();

      for (const row of rows) {
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
        productIds.add(row.product_id);
      }

      productsMatched++;
      console.log(`    Saved ${toSave.length} image(s) → ${rows.length} SKUs (${productIds.size} products)`);
      await delay(1500);
    }

    console.log(`\n=== Scrape Complete ===`);
    console.log(`Item codes already had images: ${skipped}`);
    console.log(`Item codes matched this run: ${productsMatched} / ${toScrape.length}`);
    console.log(`Item codes with no images: ${productsFailed}`);
    console.log(`Total images saved: ${imagesSaved}`);

  } finally {
    await browser.close();
    await pool.end();
  }
}

run().catch(err => { console.error(err); process.exit(1); });
