/**
 * Elite Stone Group — Image Enrichment Scraper
 *
 * Products already imported from PDF price lists. This scraper visits
 * elitestonegroup.com (Magento) to capture product images from category
 * listing pages and individual product detail pages.
 *
 * Categories scraped:
 *   /products/quartz-stone.html     (Quartz Stone)
 *   /products/e-quartz.html         (E Quartz / Printed Surface)
 *   /products/porcelain.html        (Porcelain Slabs)
 *   /products/shower-panel.html     (Shower Panels)
 *   /products/sinks/kitchen-sink.html  (Kitchen Sinks)
 *   /products/sinks/bathroom-sink.html (Bathroom Sinks)
 *
 * Usage: docker compose exec api node scrapers/elite-stone.js
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

const BASE_URL = 'https://elitestonegroup.com';

// Category pages to scrape
const CATEGORY_PAGES = [
  { url: '/products/quartz-stone.html', collection: 'Quartz Stone' },
  { url: '/products/e-quartz.html', collection: 'E Quartz Stone' },
  { url: '/products/porcelain.html', collection: 'Porcelain Slabs' },
  { url: '/products/shower-panel.html', collection: 'Shower Panels' },
  { url: '/products/sinks/kitchen-sink.html', collection: 'Stainless Steel Sinks' },
  { url: '/products/sinks/bathroom-sink.html', collection: null },
];

function normalizeName(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
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
  await delay(1000);
}

// Extract product links and thumbnail images from a Magento category page
async function extractProductCards(page) {
  return page.evaluate(() => {
    const cards = [];
    // Magento product list items
    const items = document.querySelectorAll('.product-item, .products-list .item, li.product-item');
    for (const item of items) {
      const link = item.querySelector('a.product-item-link, a.product-item-photo, a[href*=".html"]');
      const img = item.querySelector('.product-image-photo, img.product-image-photo, img');
      const nameEl = item.querySelector('.product-item-link, .product-name a, .product-item-name a');

      if (!link) continue;

      const href = link.href;
      const name = nameEl ? nameEl.textContent.trim() : '';
      let imgSrc = '';

      if (img) {
        imgSrc = img.src || img.getAttribute('data-src') || img.getAttribute('data-lazy') || '';
      }

      if (href && href.includes('.html')) {
        cards.push({ href, name, thumbnail: imgSrc });
      }
    }
    return cards;
  });
}

// Load all pages if paginated (Magento toolbar)
async function loadAllPages(page, categoryUrl) {
  const allCards = [];

  // Visit the first page
  await page.goto(`${BASE_URL}${categoryUrl}?product_list_limit=all`, {
    waitUntil: 'networkidle2',
    timeout: 30000,
  });
  await delay(2000);
  await scrollToLoadAll(page);

  // Check if "show all" worked, otherwise paginate
  let cards = await extractProductCards(page);

  if (cards.length > 0) {
    allCards.push(...cards);
  }

  // If there's pagination, try each page
  const pageCount = await page.evaluate(() => {
    const pages = document.querySelectorAll('.pages .items .item a');
    let max = 1;
    for (const p of pages) {
      const n = parseInt(p.textContent.trim(), 10);
      if (!isNaN(n) && n > max) max = n;
    }
    return max;
  });

  if (pageCount > 1 && allCards.length < 20) {
    // The show-all didn't work, paginate manually
    allCards.length = 0;
    for (let p = 1; p <= pageCount; p++) {
      console.log(`    Page ${p}/${pageCount}...`);
      await page.goto(`${BASE_URL}${categoryUrl}?p=${p}`, {
        waitUntil: 'networkidle2',
        timeout: 20000,
      });
      await delay(1500);
      await scrollToLoadAll(page);
      const pageCards = await extractProductCards(page);
      allCards.push(...pageCards);
    }
  }

  return allCards;
}

// Visit a product detail page and extract all gallery images
async function extractDetailImages(page, productUrl) {
  try {
    await page.goto(productUrl, { waitUntil: 'networkidle2', timeout: 20000 });
    await delay(1500);

    // Extract images from the Magento gallery
    const images = await page.evaluate(() => {
      const imgs = [];
      const seen = new Set();

      // Fotorama gallery (common Magento gallery)
      const fotoItems = document.querySelectorAll('.fotorama__stage__frame img, .gallery-placeholder img, [data-gallery-role="gallery"] img');
      for (const img of fotoItems) {
        const src = img.src || img.getAttribute('data-src') || '';
        if (src && !seen.has(src) && src.includes('/media/') && !src.includes('placeholder')) {
          seen.add(src);
          imgs.push({ src, alt: img.alt || '' });
        }
      }

      // Also check for gallery data in JSON config
      const galleryScripts = document.querySelectorAll('[data-gallery-images], script[type="text/x-magento-init"]');
      for (const el of galleryScripts) {
        try {
          let data;
          if (el.hasAttribute('data-gallery-images')) {
            data = JSON.parse(el.getAttribute('data-gallery-images'));
          } else {
            data = JSON.parse(el.textContent);
          }
          const jsonStr = JSON.stringify(data);
          // Extract image URLs from JSON
          const urlMatches = jsonStr.match(/https?:\/\/[^"]+\/media\/catalog\/product[^"]+/g);
          if (urlMatches) {
            for (const url of urlMatches) {
              // Prefer full-size images (no cache resize path, or largest cache)
              if (!seen.has(url) && !url.includes('placeholder')) {
                seen.add(url);
                imgs.push({ src: url, alt: '' });
              }
            }
          }
        } catch {}
      }

      // Fallback: look for any large product images
      if (imgs.length === 0) {
        const allImgs = document.querySelectorAll('img');
        for (const img of allImgs) {
          const src = img.src || '';
          if (src && src.includes('/media/catalog/product') && !seen.has(src) && !src.includes('placeholder')) {
            seen.add(src);
            imgs.push({ src, alt: img.alt || '' });
          }
        }
      }

      return imgs;
    });

    return images;
  } catch (err) {
    console.log(`    Error loading ${productUrl}: ${err.message}`);
    return [];
  }
}

async function run() {
  const vendorRes = await pool.query("SELECT id FROM vendors WHERE code = 'ELITESTONE'");
  if (!vendorRes.rows.length) { console.error('Elite Stone vendor not found'); return; }
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

  console.log(`Found ${skuRows.rowCount} SKUs to enrich with images\n`);

  // Build lookups by normalized product name AND by vendor SKU
  const productsByName = new Map();
  const productsByVendorSku = new Map();
  for (const row of skuRows.rows) {
    const key = normalizeName(row.product_name);
    if (!productsByName.has(key)) {
      productsByName.set(key, []);
    }
    productsByName.get(key).push(row);

    // Also index by vendor_sku (for sinks where website shows item code as name)
    if (row.vendor_sku) {
      const skuKey = normalizeName(row.vendor_sku);
      if (!productsByVendorSku.has(skuKey)) {
        productsByVendorSku.set(skuKey, []);
      }
      productsByVendorSku.get(skuKey).push(row);
    }
  }

  const browser = await launchBrowser();
  let imagesSaved = 0;
  let productsMatched = 0;
  const matchedProducts = new Set();

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    // Process each category
    for (const cat of CATEGORY_PAGES) {
      console.log(`\n=== Scraping: ${cat.url} ===`);

      let cards;
      try {
        cards = await loadAllPages(page, cat.url);
      } catch (err) {
        console.log(`  Error loading category: ${err.message}`);
        continue;
      }
      console.log(`  Found ${cards.length} product cards\n`);

      for (const card of cards) {
        const cardName = normalizeName(card.name);

        // Try to match to our database
        let matched = productsByName.get(cardName);

        // Try matching by vendor SKU (sinks use item codes as names on website)
        if (!matched) {
          matched = productsByVendorSku.get(cardName);
        }

        // Try partial matching if exact fails
        if (!matched) {
          for (const [key, rows] of productsByName.entries()) {
            if (key.includes(cardName) || cardName.includes(key)) {
              matched = rows;
              break;
            }
          }
        }

        // Try partial vendor SKU match (e.g., "RD3219D-BLACK(GRID)" vs "RD3219D-BLACK")
        if (!matched) {
          for (const [key, rows] of productsByVendorSku.entries()) {
            if (cardName.includes(key) || key.includes(cardName)) {
              matched = rows;
              break;
            }
          }
        }

        if (!matched || matched.length === 0) {
          console.log(`  [SKIP] No DB match for: "${card.name}"`);
          continue;
        }

        // Only visit detail page if we haven't already matched this product
        const productId = matched[0].product_id;
        if (matchedProducts.has(productId)) continue;
        matchedProducts.add(productId);

        console.log(`  [MATCH] ${card.name} → ${matched.length} SKU(s)`);

        // Get images from detail page
        const detailImages = await extractDetailImages(page, card.href);

        // Also include the thumbnail as fallback
        const allImageUrls = [];
        const seenUrls = new Set();

        for (const img of detailImages) {
          // Get the highest quality version: strip cache resize path
          let url = img.src;
          // Try to get original by removing /cache/HASH/ from URL
          const origMatch = url.match(/(.*\/media\/catalog\/product)\/cache\/[^/]+\/(.*)/);
          if (origMatch) {
            const origUrl = `${origMatch[1]}/${origMatch[2]}`;
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

        // Add thumbnail as fallback
        if (card.thumbnail && !seenUrls.has(card.thumbnail)) {
          allImageUrls.push(card.thumbnail);
        }

        if (allImageUrls.length === 0) {
          console.log(`    No images found`);
          continue;
        }

        // Save images — assign primary to all SKUs of this product
        const toSave = allImageUrls.slice(0, 6);
        for (const row of matched) {
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

        productsMatched++;
        console.log(`    Saved ${toSave.length} image(s) for ${matched.length} SKU(s)`);

        // Polite delay
        await delay(800);
      }
    }

    console.log(`\n=== Scrape Complete ===`);
    console.log(`Products matched: ${productsMatched}`);
    console.log(`Total images saved: ${imagesSaved}`);
    console.log(`Unmatched products in DB: ${productsByName.size - matchedProducts.size}`);

  } finally {
    await browser.close();
    await pool.end();
  }
}

run().catch(err => { console.error(err); process.exit(1); });
