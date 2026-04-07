/**
 * Unicorn Tile Corp — Image Enrichment Scraper
 *
 * Products already imported from PDF price list. This scraper visits
 * unicorntiles.com to capture product images.
 *
 * Strategy:
 *   1. Fetch the /products/ listing page to discover product URLs
 *   2. Match product URLs to DB products by name in URL slug
 *   3. Fetch each product page HTML and extract image URLs from wp-content/uploads
 *   4. Save images to media_assets for all SKUs of each product
 *
 * Site structure:
 *   - Product listing: /products/ (grid of all product pages)
 *   - Product pages: /products/{slug}/ (static HTML, no JS rendering needed)
 *   - Images: /wp-content/uploads/YYYY/MM/filename.jpg
 *   - Thumbnails append -300x300 or -WxH suffix before extension
 *
 * Note: Deer Tile products are NOT on unicorntiles.com — only Unicorn Tile products.
 *
 * Usage: docker compose exec api node scrapers/unicorn.js
 */
import pg from 'pg';
import { delay, filterImageUrls, filterImagesByVariant, saveProductImages, saveSkuImages } from './base.js';

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: 5432, database: 'flooring_pim', user: 'postgres', password: 'postgres',
});

const BASE_URL = 'https://unicorntiles.com';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function normalizeForMatch(str) {
  return str.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function toSlug(name) {
  return name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}

// Manual aliases where product name doesn't match URL slug
const NAME_TO_SLUG = {
  'creative concrete': 'creacon',
};

async function fetchHtml(url) {
  const resp = await fetch(url, {
    headers: { 'User-Agent': UA },
    redirect: 'follow',
  });
  if (!resp.ok) return null;
  return resp.text();
}

// Step 1: Get product URLs from the /products/ and /glass-mosaics/ listing pages
async function getProductUrls() {
  const urls = new Set();

  // Discover from /products/ listing
  const html = await fetchHtml(`${BASE_URL}/products/`);
  if (html) {
    const regex = /href="(https?:\/\/unicorntiles\.com\/products\/[^"]+)"/gi;
    let m;
    while ((m = regex.exec(html)) !== null) {
      const u = m[1].replace(/\/$/, '') + '/';
      if (u !== `${BASE_URL}/products/`) urls.add(u);
    }
  }

  // Also discover from /glass-mosaics/ listing (separate section on site)
  const glassHtml = await fetchHtml(`${BASE_URL}/glass-mosaics/`);
  if (glassHtml) {
    const regex2 = /href="(https?:\/\/unicorntiles\.com\/glass-mosaics\/[^"]+)"/gi;
    let m2;
    while ((m2 = regex2.exec(glassHtml)) !== null) {
      const u = m2[1].replace(/\/$/, '') + '/';
      if (u !== `${BASE_URL}/glass-mosaics/`) urls.add(u);
    }
  }

  return [...urls];
}

// Extract full-size image URLs from a product page HTML
// Returns {url, alt}[] for variant-aware filtering
function extractImagesFromHtml(html) {
  const imgs = [];
  const seen = new Set();

  // Collect alt text from img tags for variant-aware filtering
  const altByUrl = new Map();
  const altPatterns = [
    /<img[^>]+(?:src|data-src|data-large_image)="([^"]*\/wp-content\/uploads\/[^"]+\.(?:jpg|jpeg|png|webp))"[^>]*\salt="([^"]*)"/gi,
    /<img[^>]+alt="([^"]*)"[^>]+(?:src|data-src|data-large_image)="([^"]*\/wp-content\/uploads\/[^"]+\.(?:jpg|jpeg|png|webp))"/gi,
  ];
  let am;
  while ((am = altPatterns[0].exec(html)) !== null) {
    if (am[1] && am[2]) altByUrl.set(am[1], am[2]);
  }
  while ((am = altPatterns[1].exec(html)) !== null) {
    if (am[2] && am[1]) altByUrl.set(am[2], am[1]);
  }

  // Find all image URLs from wp-content/uploads
  // Matches both img src and a href attributes
  const patterns = [
    /(?:src|href|data-src|data-large_image)="(https?:\/\/unicorntiles\.com\/wp-content\/uploads\/[^"]+\.(?:jpg|jpeg|png|webp))"/gi,
    /(?:src|href|data-src|data-large_image)="(\/wp-content\/uploads\/[^"]+\.(?:jpg|jpeg|png|webp))"/gi,
  ];

  for (const pattern of patterns) {
    let m;
    while ((m = pattern.exec(html)) !== null) {
      let src = m[1];
      if (src.startsWith('/')) src = BASE_URL + src;

      // Skip logos, icons, favicons
      if (/logo|icon|favicon|banner/i.test(src)) continue;

      // Get full-size URL (strip -300x300 thumbnails)
      const full = src.replace(/-\d+x\d+(\.[a-zA-Z]+)$/, '$1');

      if (!seen.has(full)) {
        seen.add(full);
        const alt = altByUrl.get(src) || altByUrl.get(full) || '';
        imgs.push({ url: full, alt });
      }
    }
  }

  return imgs;
}

async function run() {
  const vendorRes = await pool.query("SELECT id FROM vendors WHERE code = 'UNICORN'");
  if (!vendorRes.rows.length) { console.error('UNICORN vendor not found'); return; }
  const vendorId = vendorRes.rows[0].id;

  // Get all products and their SKU IDs
  const dbProducts = await pool.query(`
    SELECT p.id as product_id, p.name, p.collection,
           array_agg(DISTINCT s.id) as sku_ids,
           array_agg(DISTINCT s.id) FILTER (WHERE s.variant_type IS NULL) as main_sku_ids
    FROM products p
    JOIN skus s ON s.product_id = p.id
    WHERE p.vendor_id = $1
    GROUP BY p.id, p.name, p.collection
    ORDER BY p.collection, p.name
  `, [vendorId]);

  // Check which already have images
  const existingImages = await pool.query(`
    SELECT DISTINCT s.product_id
    FROM media_assets ma
    JOIN skus s ON s.id = ma.sku_id
    JOIN products p ON p.id = s.product_id
    WHERE p.vendor_id = $1 AND ma.asset_type = 'primary'
  `, [vendorId]);
  const alreadyHasImage = new Set(existingImages.rows.map(r => r.product_id));

  const needsImages = dbProducts.rows.filter(r => !alreadyHasImage.has(r.product_id));
  console.log(`Total products: ${dbProducts.rowCount}`);
  console.log(`Already have images: ${alreadyHasImage.size}`);
  console.log(`Need images: ${needsImages.length}\n`);

  if (!needsImages.length) { await pool.end(); return; }

  // Step 1: Discover product URLs
  console.log('=== Step 1: Discovering product URLs ===');
  const productUrls = await getProductUrls();
  console.log(`  Found ${productUrls.length} product URLs from /products/ page`);
  for (const u of productUrls) console.log(`    ${u}`);

  // Step 2: Match URLs to DB products by name
  console.log('\n=== Step 2: Matching URLs to DB products ===');
  const matches = [];
  const matchedProductIds = new Set();
  const unmatchedUrls = [];

  for (const url of productUrls) {
    const slug = url.replace(/\/+$/, '').split('/').pop() || '';
    const normSlug = normalizeForMatch(slug);
    const isGlassMosaic = url.includes('/glass-mosaics/');

    let matched = false;
    for (const prod of needsImages) {
      if (matchedProductIds.has(prod.product_id)) continue;

      const normName = normalizeForMatch(prod.name);
      const prodSlug = toSlug(prod.name);
      const aliasSlug = NAME_TO_SLUG[prod.name.toLowerCase()];

      // Match strategies:
      // 1. Exact name match
      // 2. Slug matches product name slug
      // 3. Manual alias match
      // 4. Name is contained in slug or vice versa (min 4 chars)
      if (normName === normSlug ||
          prodSlug === slug ||
          (aliasSlug && aliasSlug === slug) ||
          (normName.length >= 4 && normSlug.includes(normName)) ||
          (normSlug.length >= 4 && normName.includes(normSlug))) {
        matches.push({ url, dbProd: prod });
        matchedProductIds.add(prod.product_id);
        matched = true;
        break;
      }
    }
    if (!matched) unmatchedUrls.push(slug);
  }

  // Try manual aliases for remaining unmatched products
  for (const prod of needsImages) {
    if (matchedProductIds.has(prod.product_id)) continue;
    const alias = NAME_TO_SLUG[prod.name.toLowerCase()];
    if (alias) {
      const url = `${BASE_URL}/products/${alias}/`;
      matches.push({ url, dbProd: prod });
      matchedProductIds.add(prod.product_id);
    }
  }

  console.log(`Matched: ${matches.length}`);
  console.log(`Unmatched URLs: ${unmatchedUrls.length}`);
  if (unmatchedUrls.length) {
    console.log('Unmatched URL slugs:', unmatchedUrls.join(', '));
  }
  const stillMissing = needsImages.filter(p => !matchedProductIds.has(p.product_id));
  if (stillMissing.length) {
    console.log(`Products without URL match: ${stillMissing.length}`);
    for (const p of stillMissing) console.log(`  ${p.collection} / ${p.name}`);
  }

  // Pre-fetch color attributes for all SKUs to enable variant-aware filtering
  const allSkuIds = needsImages.flatMap(p => p.sku_ids || []).filter(Boolean);
  const colorMap = new Map(); // sku_id → color name
  if (allSkuIds.length) {
    const colorRes = await pool.query(`
      SELECT sa.sku_id, sa.value
      FROM sku_attributes sa
      JOIN attributes a ON a.id = sa.attribute_id
      WHERE a.slug = 'color' AND sa.sku_id = ANY($1)
    `, [allSkuIds]);
    for (const row of colorRes.rows) colorMap.set(row.sku_id, row.value);
  }

  // Build collection → other product names map for exclusion
  const collectionProducts = new Map(); // collection → product name[]
  for (const prod of dbProducts.rows) {
    if (!collectionProducts.has(prod.collection)) collectionProducts.set(prod.collection, []);
    collectionProducts.get(prod.collection).push(prod.name);
  }

  // Step 3: Scrape images from each matched product page
  console.log('\n=== Step 3: Scraping images ===');
  let imagesSaved = 0;
  let productsWithImages = 0;

  for (const { url, dbProd } of matches) {
    console.log(`  ${dbProd.name} (${dbProd.collection}) → ${url}`);

    const html = await fetchHtml(url);
    if (!html) {
      console.log(`    [FETCH FAILED]`);
      await delay(1000);
      continue;
    }

    const images = extractImagesFromHtml(html);
    if (!images.length) {
      console.log(`    [NO IMAGES]`);
      await delay(500);
      continue;
    }

    // Variant-aware filtering: use color name + other colors in collection
    const mainSkuIds = (dbProd.main_sku_ids || []).filter(Boolean);
    const colorName = mainSkuIds.length ? colorMap.get(mainSkuIds[0]) : null;
    const otherColors = (collectionProducts.get(dbProd.collection) || [])
      .filter(n => n !== dbProd.name);

    let urlsToSave;
    if (colorName) {
      const { matched, shared } = filterImagesByVariant(images, colorName, {
        otherColors,
        productName: dbProd.collection,
      });
      urlsToSave = [...matched, ...shared.slice(0, 2)];
      if (matched.length) {
        console.log(`    Variant filter: ${matched.length} matched, ${shared.length} shared → keeping ${urlsToSave.length}`);
      }
    } else {
      // No color attribute — fall back to all images as URL strings
      urlsToSave = images.map(img => img.url);
    }

    const cleaned = filterImageUrls(urlsToSave, { maxImages: 6 });
    if (!cleaned.length) {
      console.log(`    [NO IMAGES after filtering]`);
      await delay(500);
      continue;
    }

    // Save at SKU level if single non-accessory SKU, else product level
    let saved;
    if (mainSkuIds.length === 1) {
      saved = await saveSkuImages(pool, dbProd.product_id, mainSkuIds[0], cleaned, { maxImages: 6 });
    } else {
      saved = await saveProductImages(pool, dbProd.product_id, cleaned, { maxImages: 6 });
    }
    imagesSaved += saved;

    productsWithImages++;
    const level = mainSkuIds.length === 1 ? 'SKU' : 'product';
    console.log(`    Saved ${saved} image(s) at ${level} level`);
    await delay(1500);
  }

  console.log(`\n=== Scrape Complete ===`);
  console.log(`Products already had images: ${alreadyHasImage.size}`);
  console.log(`Products matched to URLs: ${matches.length}`);
  console.log(`Products scraped with images: ${productsWithImages}`);
  console.log(`Products still missing images: ${needsImages.length - productsWithImages}`);
  console.log(`Total images saved: ${imagesSaved}`);

  await pool.end();
}

run().catch(err => { console.error(err); process.exit(1); });
