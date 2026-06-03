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

// Extract the filename portion from a Magento cached image URL for dedup.
// e.g. /media/catalog/product/cache/HASH/c/a/calacatta.jpg → c/a/calacatta.jpg
function imageFilename(url) {
  const m = url.match(/\/media\/catalog\/product(?:\/cache\/[^/]+)?\/(.+)/);
  return m ? m[1] : url;
}

// Visit a product detail page and extract images from the Owl Carousel slider
async function extractDetailImages(page, productUrl) {
  try {
    await page.goto(productUrl, { waitUntil: 'networkidle2', timeout: 20000 });
    await delay(1500);

    const images = await page.evaluate(() => {
      const imgs = [];
      const seen = new Set();

      const addUrl = (src) => {
        if (!src || seen.has(src)) return;
        if (!src.includes('/media/catalog/product')) return;
        if (src.includes('placeholder')) return;
        seen.add(src);
        imgs.push(src);
      };

      // 1. Owl Carousel real slides only (skip .cloned items added by loop:true)
      //    Cloned slides appear before/after the real slides in the DOM and
      //    would corrupt our ordering if included.
      const realSlides = document.querySelectorAll('#owl-carousel-gallery .owl-item:not(.cloned)');
      for (const slide of realSlides) {
        const a = slide.querySelector('a.lb, a.imgzoom, a[href*="/media/catalog/product"]');
        if (a) { addUrl(a.href); continue; }
        const img = slide.querySelector('img');
        if (img) addUrl(img.src || img.getAttribute('data-src') || '');
      }

      // 2. Thumbnail strip fallback — no cloning, preserves correct order
      if (imgs.length === 0) {
        const thumbItems = document.querySelectorAll('#horizontal-thumbnail .owl-item:not(.cloned) img');
        for (const img of thumbItems) {
          addUrl(img.src || img.getAttribute('data-src') || '');
        }
      }

      // 3. Last resort: any product images on the page
      if (imgs.length === 0) {
        const allImgs = document.querySelectorAll('.product.media img, .gallery-placeholder img');
        for (const img of allImgs) {
          addUrl(img.src || '');
        }
      }

      return imgs;
    });

    // Deduplicate by filename across different cache hashes, keeping the first (largest) version
    const seenFiles = new Set();
    const deduped = [];
    for (const url of images) {
      const fname = imageFilename(url);
      if (!seenFiles.has(fname)) {
        seenFiles.add(fname);
        deduped.push(url);
      }
    }

    // Filter out images with thick black letterbox borders (common on ES lifestyle photos).
    // A letterboxed image has wide black bars (5%+ of image size) on at least two sides
    // with non-black content in the center.  We sample at 5% inset from each edge
    // to confirm the border is substantial, not just a thin dark rim on a slab photo.
    const clean = [];
    for (const url of deduped) {
      const letterboxed = await page.evaluate(async (src) => {
        return new Promise(resolve => {
          const img = new Image();
          img.onload = () => {
            try {
              const c = document.createElement('canvas');
              c.width = img.naturalWidth;
              c.height = img.naturalHeight;
              const ctx = c.getContext('2d');
              ctx.drawImage(img, 0, 0);
              const w = c.width;
              const h = c.height;
              if (w < 100 || h < 100) { resolve(false); return; }
              const px = (x, y) => ctx.getImageData(x, y, 1, 1).data;
              const isBlack = d => d[0] < 8 && d[1] < 8 && d[2] < 8;
              // Sample at 5% inset — well inside a real letterbox bar
              const mx = Math.floor(w * 0.05);
              const my = Math.floor(h * 0.05);
              const corners = [
                px(mx, my), px(w - mx, my),
                px(mx, h - my), px(w - mx, h - my),
              ];
              if (!corners.every(isBlack)) { resolve(false); return; }
              // Center must NOT be black (else it's a dark product photo, not a border)
              const center = px(Math.floor(w / 2), Math.floor(h / 2));
              if (isBlack(center)) { resolve(false); return; }
              resolve(true);
            } catch { resolve(false); }
          };
          img.onerror = () => resolve(false);
          img.src = src;
        });
      }, url);

      if (letterboxed) {
        console.log(`    [SKIP-BORDER] ${url.split('/').pop()}`);
      } else {
        clean.push(url);
      }
    }

    return clean;
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

        // Get images from the Owl Carousel slider on the detail page
        const allImageUrls = await extractDetailImages(page, card.href);

        // Add category-page thumbnail as fallback
        if (card.thumbnail && !allImageUrls.includes(card.thumbnail)) {
          const thumbFile = imageFilename(card.thumbnail);
          const alreadyHave = allImageUrls.some(u => imageFilename(u) === thumbFile);
          if (!alreadyHave) allImageUrls.push(card.thumbnail);
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
