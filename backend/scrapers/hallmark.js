/**
 * Hallmark Floors — Image Enrichment Scraper
 *
 * Products already imported from PDF price list. This scraper visits
 * hallmarkfloors.com to capture product swatch images.
 *
 * Strategy:
 *   1. Fetch product-sitemap.xml to discover all product URLs
 *   2. Match product URLs to DB products by name in URL slug
 *   3. Fetch each product page HTML and extract image from JSON-LD
 *   4. Save images to media_assets for all SKUs of each product
 *
 * Site structure:
 *   - WooCommerce with JSON-LD structured data
 *   - Product URLs: /product/{color}-{species}[-hardwood]/
 *   - Images in /wp-content/uploads/ (swatch images, 900x900)
 *   - Product sitemap: /product-sitemap.xml
 *
 * Usage: docker compose exec api node scrapers/hallmark.js
 */
import pg from 'pg';
import { delay, saveProductImages, saveSkuImages } from './base.js';

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: 5432, database: 'flooring_pim', user: 'postgres', password: 'postgres',
});

const BASE_URL = 'https://hallmarkfloors.com';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function normalizeForMatch(str) {
  return str.toLowerCase().replace(/[^a-z0-9]/g, '');
}

async function fetchHtml(url) {
  try {
    const resp = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow' });
    if (!resp.ok) return null;
    return resp.text();
  } catch { return null; }
}

// Get product URLs from sitemap
async function getProductUrlsFromSitemap() {
  const html = await fetchHtml(`${BASE_URL}/product-sitemap.xml`);
  if (!html) return [];
  const urls = [];
  const regex = /<loc>(https?:\/\/hallmarkfloors\.com\/product\/[^<]+)<\/loc>/gi;
  let m;
  while ((m = regex.exec(html)) !== null) {
    urls.push(m[1].replace(/\/$/, '') + '/');
  }
  return urls;
}

// Extract primary product image from HTML (JSON-LD or og:image)
function extractImageFromHtml(html) {
  // Strategy 1: JSON-LD thumbnailUrl or image
  const jsonLdRegex = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = jsonLdRegex.exec(html)) !== null) {
    try {
      const data = JSON.parse(m[1]);
      // Check for image in product schema
      const img = data.image || data.thumbnailUrl;
      if (img) {
        const src = typeof img === 'string' ? img : (Array.isArray(img) ? img[0] : img.url);
        if (src && src.includes('wp-content/uploads') && !src.includes('logo')) return src;
      }
      // Check @graph for product nodes
      if (data['@graph']) {
        for (const node of data['@graph']) {
          const nodeImg = node.image || node.thumbnailUrl;
          if (nodeImg) {
            const src = typeof nodeImg === 'string' ? nodeImg : (Array.isArray(nodeImg) ? nodeImg[0] : nodeImg.url);
            if (src && src.includes('wp-content/uploads') && !src.includes('logo')) return src;
          }
        }
      }
    } catch (_) {}
  }

  // Strategy 2: og:image meta tag
  const ogRegex = /<meta[^>]*property="og:image"[^>]*content="([^"]+)"/i;
  const ogMatch = ogRegex.exec(html);
  if (ogMatch && ogMatch[1].includes('wp-content/uploads') && !ogMatch[1].includes('logo')) {
    return ogMatch[1];
  }

  // Strategy 3: WooCommerce product image
  const wcRegex = /data-large_image="([^"]+)"/i;
  const wcMatch = wcRegex.exec(html);
  if (wcMatch && wcMatch[1].includes('wp-content/uploads')) return wcMatch[1];

  // Strategy 4: First wp-content/uploads image that looks like a product swatch
  const imgRegex = /(?:src|href)="(https?:\/\/hallmarkfloors\.com\/wp-content\/uploads\/[^"]+\.(?:jpg|jpeg|png|webp))"/gi;
  while ((m = imgRegex.exec(html)) !== null) {
    if (!m[1].includes('logo') && !m[1].includes('icon') && !m[1].includes('favicon')) {
      // Get full-size (strip thumbnail suffix)
      return m[1].replace(/-\d+x\d+(\.[a-zA-Z]+)$/, '$1');
    }
  }

  return null;
}

async function run() {
  const vendorRes = await pool.query("SELECT id FROM vendors WHERE code = 'HALLMARK'");
  if (!vendorRes.rows.length) { console.error('HALLMARK vendor not found'); return; }
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

  // Step 1: Get product URLs from sitemap
  console.log('=== Step 1: Fetching product URLs from sitemap ===');
  const productUrls = await getProductUrlsFromSitemap();
  console.log(`  Found ${productUrls.length} product URLs\n`);

  // Step 2: Match URLs to DB products
  console.log('=== Step 2: Matching URLs to DB products ===');
  const matches = [];
  const matchedProductIds = new Set();

  // Build lookup: normalized name → product
  const nameMap = new Map();
  for (const prod of needsImages) {
    nameMap.set(normalizeForMatch(prod.name), prod);
  }

  for (const url of productUrls) {
    const slug = url.replace(/\/+$/, '').split('/').pop() || '';
    // Clean slug: remove common suffixes like "-hardwood", "-hardwood-hallmark-floors"
    const cleanSlug = slug
      .replace(/-hardwood-hallmark-floors$/, '')
      .replace(/-hardwood$/, '')
      .replace(/-engineered$/, '');
    const normSlug = normalizeForMatch(cleanSlug);

    // Try exact match
    let prod = nameMap.get(normSlug);

    // Try matching with species variations
    if (!prod) {
      for (const [normName, p] of nameMap.entries()) {
        if (matchedProductIds.has(p.product_id)) continue;
        // Check if slug contains the full product name
        if (normName.length >= 4 && normSlug.includes(normName)) {
          prod = p;
          break;
        }
        // Check if product name contains slug (for shorter slugs)
        if (normSlug.length >= 5 && normName.includes(normSlug)) {
          prod = p;
          break;
        }
      }
    }

    if (prod && !matchedProductIds.has(prod.product_id)) {
      matches.push({ url, dbProd: prod });
      matchedProductIds.add(prod.product_id);
    }
  }

  console.log(`Matched: ${matches.length}`);
  const stillMissing = needsImages.filter(p => !matchedProductIds.has(p.product_id));
  if (stillMissing.length) {
    console.log(`Products without URL match: ${stillMissing.length}`);
    if (stillMissing.length <= 30) {
      for (const p of stillMissing) console.log(`  ${p.collection} / ${p.name}`);
    }
  }

  // Step 3: Scrape images
  console.log('\n=== Step 3: Scraping images ===');
  let imagesSaved = 0;
  let productsWithImages = 0;

  for (const { url, dbProd } of matches) {
    const html = await fetchHtml(url);
    if (!html) {
      console.log(`  ${dbProd.name} → [FETCH FAILED]`);
      await delay(500);
      continue;
    }

    const imgUrl = extractImageFromHtml(html);
    if (!imgUrl) {
      console.log(`  ${dbProd.name} → [NO IMAGE]`);
      await delay(300);
      continue;
    }

    // Save at SKU level if single non-accessory SKU, else product level
    const mainSkuIds = (dbProd.main_sku_ids || []).filter(Boolean);
    let saved;
    if (mainSkuIds.length === 1) {
      saved = await saveSkuImages(pool, dbProd.product_id, mainSkuIds[0], [imgUrl], { maxImages: 1 });
    } else {
      saved = await saveProductImages(pool, dbProd.product_id, [imgUrl], { maxImages: 1 });
    }
    imagesSaved += saved;

    productsWithImages++;
    console.log(`  ${dbProd.name} (${dbProd.collection}) ✓`);
    await delay(800);
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
