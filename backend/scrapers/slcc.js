/**
 * SLCC Flooring — Image Enrichment Scraper
 *
 * Products already imported from PDF price list. This scraper visits
 * slccflooring.com to capture product images.
 *
 * Strategy:
 *   1. Crawl category pages → discover collection sub-pages
 *   2. Crawl each collection page → discover product URLs
 *   3. Match product URLs to DB by vendor_sku in the URL slug
 *   4. Visit each product page and extract images from JSON-LD + DOM
 *
 * Site structure: /product-category/products/{type}/ → /product-category/products/{type}/{collection}/ → /product/{slug}/
 * URL pattern: /product/{type}-{collection}-{item-code}-{color-slug}/
 * JSON-LD contains SKU field matching vendor_sku
 *
 * Usage: docker compose exec api node scrapers/slcc.js
 */
import pg from 'pg';
import puppeteer from 'puppeteer';
import { delay, filterImageUrls, preferProductShot, saveProductImages } from './base.js';

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: 5432, database: 'flooring_pim', user: 'postgres', password: 'postgres',
});

const BASE_URL = 'https://www.slccflooring.com';

// Top-level category pages — each contains links to collection sub-pages
const CATEGORY_PAGES = [
  '/product-category/products/engineered-wood-flooring/',
  '/product-category/products/spc-flooring/',
  '/product-category/products/wpc-flooring/',
  '/product-category/products/laminate-flooring/',
  '/product-category/products/solid-wood-flooring/',
  '/product-category/products/glue-down-lvt-flooring/',
];

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function launchBrowserWithTimeout() {
  return puppeteer.launch({
    headless: 'new',
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    protocolTimeout: 120000,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
}

function normalizeCode(code) {
  return code.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Check if an image filename is relevant to this product (not from another collection/product)
function isRelevantImage(url, productName, vendorSkus, collection) {
  const filename = url.toLowerCase().split('/').pop().split('?')[0];
  const normFilename = normalizeCode(filename);

  // Check product name (split into words, match any word >= 3 chars)
  const nameWords = productName.toLowerCase().split(/[\s-]+/).filter(w => w.length >= 3);
  for (const word of nameWords) {
    if (normFilename.includes(normalizeCode(word))) return true;
  }

  // Check vendor SKU codes
  if (vendorSkus) {
    for (const sku of vendorSkus) {
      if (!sku) continue;
      const normSku = normalizeCode(sku);
      if (normSku.length >= 4 && normFilename.includes(normSku)) return true;
    }
  }

  // Check collection name words
  if (collection) {
    const collWords = collection.toLowerCase().replace(/\bcollection\b/g, '').trim().split(/[\s-]+/).filter(w => w.length >= 4);
    for (const word of collWords) {
      if (normFilename.includes(normalizeCode(word))) return true;
    }
  }

  // Generic product image patterns (swatch, plank, top-view, etc.)
  if (/swatch|plank|top.?view|close.?up|detail|sample|single|board/i.test(filename)) return true;

  return false;
}

async function createPage(browser) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
  await page.setUserAgent(UA);
  return page;
}

// Fetch HTML via native fetch and extract links matching a pattern
async function fetchLinks(url, pattern) {
  try {
    const resp = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!resp.ok) return [];
    const html = await resp.text();
    const links = new Set();
    const regex = /href="(https?:\/\/[^"]*?)"/g;
    let m;
    while ((m = regex.exec(html)) !== null) {
      if (pattern.test(m[1])) links.add(m[1].replace(/\/$/, '') + '/');
    }
    return [...links];
  } catch (err) {
    console.log(`    fetch error for ${url}: ${err.message}`);
    return [];
  }
}

// Step 1: Get collection sub-page URLs from a category page
async function getCollectionUrls(categoryPath) {
  const url = `${BASE_URL}${categoryPath}`;
  // Collection URLs look like: /product-category/products/{type}/{collection-slug}/
  // They are sub-paths of the category URL
  const links = await fetchLinks(url, /\/product-category\/products\/[^/]+\/[^/]+\//);
  // Filter out links that are the same as the parent category
  return links.filter(l => {
    const path = new URL(l).pathname;
    return path !== categoryPath && path.startsWith(categoryPath.replace(/\/$/, ''));
  });
}

// Step 2: Get product URLs from a collection page (may have pagination)
async function getProductUrls(collectionUrl) {
  const products = new Set();
  let url = collectionUrl;
  let pageNum = 1;

  while (url && pageNum <= 10) {
    const links = await fetchLinks(url, /\/product\/[^/]+\//);
    // Filter: must be /product/ not /product-category/
    for (const l of links) {
      if (l.includes('/product/') && !l.includes('/product-category/')) {
        products.add(l);
      }
    }

    // Check for pagination: /page/2/, /page/3/, etc.
    const nextPage = pageNum + 1;
    const nextUrl = collectionUrl.replace(/\/$/, '') + `/page/${nextPage}/`;
    // Try fetching to see if it exists
    try {
      const resp = await fetch(nextUrl, { method: 'HEAD', headers: { 'User-Agent': UA }, redirect: 'follow' });
      if (resp.ok) {
        url = nextUrl;
        pageNum++;
      } else {
        break;
      }
    } catch {
      break;
    }
  }
  return [...products];
}

// Extract images from a product page using Puppeteer
async function extractProductImages(page, url) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await delay(2500);

    return page.evaluate(() => {
      const imgs = [];
      const seen = new Set();

      // Strategy 1: JSON-LD structured data
      for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
        try {
          const data = JSON.parse(script.textContent);
          const images = data.image || (data['@graph'] && data['@graph'].find(n => n.image)?.image);
          if (Array.isArray(images)) {
            for (const img of images) {
              const src = typeof img === 'string' ? img : img.url || '';
              if (src && !seen.has(src)) { seen.add(src); imgs.push(src); }
            }
          } else if (typeof images === 'string' && !seen.has(images)) {
            seen.add(images); imgs.push(images);
          }
        } catch (_) {}
      }

      // Strategy 2: WooCommerce gallery
      for (const sel of ['.woocommerce-product-gallery img', '.woocommerce-product-gallery__image img', '.wp-post-image']) {
        for (const img of document.querySelectorAll(sel)) {
          const src = img.getAttribute('data-large_image') ||
            img.getAttribute('data-src') || img.src || '';
          if (!src || seen.has(src)) continue;
          if (src.includes('placeholder') || src.includes('woocommerce-placeholder')) continue;
          seen.add(src); imgs.push(src);
        }
      }

      // Strategies 3-5 (page-wide uploads) skipped — they pull in cross-product
      // room scenes from other collections. Strategies 1-2 (JSON-LD + WooCommerce
      // gallery) contain the product-specific images.

      return imgs;
    });
  } catch (err) {
    console.log(`    Error: ${err.message}`);
    return [];
  }
}

function getFullSizeUrl(url) {
  return url.replace(/-\d+x\d+(\.[a-zA-Z]+)$/, '$1');
}

const BATCH_SIZE = 20;

async function run() {
  const vendorRes = await pool.query("SELECT id FROM vendors WHERE code = 'SLCC'");
  if (!vendorRes.rows.length) { console.error('SLCC vendor not found'); return; }
  const vendorId = vendorRes.rows[0].id;

  // Get all products and their main SKU vendor codes
  const dbProducts = await pool.query(`
    SELECT p.id as product_id, p.name, p.collection,
           array_agg(DISTINCT s.id) as sku_ids,
           array_agg(DISTINCT s.vendor_sku) FILTER (WHERE s.variant_type IS NULL) as vendor_skus,
           array_agg(DISTINCT s.id) FILTER (WHERE s.variant_type IS NULL) as main_sku_ids
    FROM products p
    JOIN skus s ON s.product_id = p.id
    WHERE p.vendor_id = $1
    GROUP BY p.id, p.name, p.collection
    ORDER BY p.collection, p.name
  `, [vendorId]);

  // Check which already have images (product-level)
  const existingImages = await pool.query(`
    SELECT DISTINCT ma.product_id
    FROM media_assets ma
    JOIN products p ON p.id = ma.product_id
    WHERE p.vendor_id = $1 AND ma.sku_id IS NULL AND ma.asset_type = 'primary'
  `, [vendorId]);
  const alreadyHasImage = new Set(existingImages.rows.map(r => r.product_id));

  const needsImages = dbProducts.rows.filter(r => !alreadyHasImage.has(r.product_id));
  console.log(`Total products: ${dbProducts.rowCount}`);
  console.log(`Already have images: ${alreadyHasImage.size}`);
  console.log(`Need images: ${needsImages.length}\n`);

  if (!needsImages.length) { await pool.end(); return; }

  // Build lookup by normalized vendor_sku
  const productByCode = new Map();
  for (const row of needsImages) {
    if (row.vendor_skus) {
      for (const code of row.vendor_skus) {
        if (code) productByCode.set(normalizeCode(code), row);
      }
    }
  }

  // Step 1: Discover collection sub-pages from category pages
  console.log('=== Step 1: Discovering collection pages ===');
  const allCollectionUrls = [];
  for (const cat of CATEGORY_PAGES) {
    console.log(`\nCategory: ${cat}`);
    const collections = await getCollectionUrls(cat);
    console.log(`  Found ${collections.length} collection pages`);
    for (const c of collections) console.log(`    ${c}`);
    allCollectionUrls.push(...collections);
    await delay(1500);
  }
  const uniqueCollections = [...new Set(allCollectionUrls)];
  console.log(`\nTotal unique collection pages: ${uniqueCollections.length}\n`);

  // Step 2: Discover product URLs from each collection page
  console.log('=== Step 2: Discovering product URLs ===');
  const allProductUrls = new Set();
  for (const collUrl of uniqueCollections) {
    const products = await getProductUrls(collUrl);
    for (const p of products) allProductUrls.add(p);
    const name = collUrl.split('/').filter(Boolean).pop();
    if (products.length > 0) console.log(`  ${name}: ${products.length} products`);
    await delay(1000);
  }
  const uniqueUrls = [...allProductUrls];
  console.log(`\nTotal unique product URLs: ${uniqueUrls.length}\n`);

  // Step 3: Match URLs to DB products by vendor_sku in slug
  console.log('=== Step 3: Matching URLs to DB products ===');
  const matches = [];
  const unmatched = [];

  for (const url of uniqueUrls) {
    const slug = url.replace(/\/+$/, '').split('/').pop() || '';
    const normSlug = normalizeCode(slug);
    let dbProd = null;

    // Try to find the vendor_sku in the URL slug
    // Sort by longest code first to avoid partial matches
    const sortedCodes = [...productByCode.entries()].sort((a, b) => b[0].length - a[0].length);
    for (const [normCode, prod] of sortedCodes) {
      if (normCode.length >= 4 && normSlug.includes(normCode)) {
        dbProd = prod;
        break;
      }
    }

    // Also try matching by product name at end of slug
    if (!dbProd) {
      for (const prod of needsImages) {
        const nameSlug = normalizeCode(prod.name);
        if (nameSlug.length >= 4 && normSlug.endsWith(nameSlug)) {
          dbProd = prod;
          break;
        }
      }
    }

    if (dbProd) {
      matches.push({ url, dbProd });
    } else {
      unmatched.push(slug);
    }
  }

  console.log(`Matched: ${matches.length}`);
  console.log(`Unmatched: ${unmatched.length}`);
  if (unmatched.length > 0 && unmatched.length <= 30) {
    console.log('Unmatched slugs:');
    for (const s of unmatched) console.log(`  ${s}`);
  }
  console.log();

  // Step 4: Scrape images with Puppeteer
  console.log('=== Step 4: Scraping images ===');
  let browser = await launchBrowserWithTimeout();
  let page = await createPage(browser);
  let imagesSaved = 0;
  let productsMatched = 0;
  let pagesSinceLaunch = 0;
  const matchedProductIds = new Set();

  try {
    for (const { url, dbProd } of matches) {
      if (matchedProductIds.has(dbProd.product_id)) continue;

      // Recycle browser periodically
      if (pagesSinceLaunch >= BATCH_SIZE) {
        console.log(`\n  [Recycling browser after ${BATCH_SIZE} pages, pausing 10s...]\n`);
        try { await page.close(); } catch (_) {}
        try { await browser.close(); } catch (_) {}
        await delay(10000);
        browser = await launchBrowserWithTimeout();
        page = await createPage(browser);
        pagesSinceLaunch = 0;
      }

      console.log(`  ${dbProd.name} (${dbProd.collection}) → ${url}`);
      const images = await extractProductImages(page, url);
      pagesSinceLaunch++;

      // Deduplicate, prefer full-size, filter junk
      const fullSized = images.map(src => getFullSizeUrl(src));
      const cleaned = filterImageUrls(fullSized, { maxImages: 10 });

      // Filter to only images relevant to this product (not cross-product room scenes)
      const relevant = cleaned.filter(url => isRelevantImage(url, dbProd.name, dbProd.vendor_skus, dbProd.collection));

      if (relevant.length === 0) {
        console.log(`    [NO RELEVANT IMAGES] (${cleaned.length} scraped but none matched product)`);
        continue;
      }

      // Sort: product shots first, lifestyle last
      const sorted = preferProductShot(relevant, dbProd.name);

      // Always save at product level — SKU variants share the same images
      const saved = await saveProductImages(pool, dbProd.product_id, sorted, { maxImages: 6 });
      console.log(`    Saved ${saved} image(s) at product level`);
      imagesSaved += saved;

      productsMatched++;
      matchedProductIds.add(dbProd.product_id);
      await delay(1500);
    }

    console.log(`\n=== Scrape Complete ===`);
    console.log(`Products already had images: ${alreadyHasImage.size}`);
    console.log(`Products matched this run: ${productsMatched}`);
    console.log(`Products still missing images: ${needsImages.length - productsMatched}`);
    console.log(`Total images saved: ${imagesSaved}`);

  } finally {
    try { await browser.close(); } catch (_) {}
    await pool.end();
  }
}

run().catch(err => { console.error(err); process.exit(1); });
