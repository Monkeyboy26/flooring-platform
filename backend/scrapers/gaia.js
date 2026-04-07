/**
 * Gaia Flooring — Image Enrichment Scraper
 *
 * Products already imported from PDF price list. This scraper visits
 * gaiafloor.com to capture product images.
 *
 * Strategy:
 *   1. Use sitemap URLs + product listing pages to discover product URLs
 *   2. Match URLs to DB products by color name in URL slug
 *   3. Fetch each product page and extract images
 *   4. Save images to media_assets for all SKUs of each product
 *
 * Site structure:
 *   - Product pages at root: /alpaca, /torino, /athena, etc.
 *   - Also under /flooring/eterra-espc-spc/ and /flooring/nearwood/
 *   - Magento-based (not WooCommerce)
 *
 * Usage: docker compose exec api node scrapers/gaia.js
 */
import pg from 'pg';
import { delay, filterImageUrls, saveProductImages, saveSkuImages } from './base.js';

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: 5432, database: 'flooring_pim', user: 'postgres', password: 'postgres',
});

const BASE_URL = 'https://gaiafloor.com';
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
async function getSitemapUrls() {
  const html = await fetchHtml(`${BASE_URL}/sitemap.xml`);
  if (!html) return [];
  const urls = [];
  const regex = /<loc>(https?:\/\/gaiafloor\.com\/[^<]+)<\/loc>/gi;
  let m;
  while ((m = regex.exec(html)) !== null) {
    const u = m[1].replace(/\/$/, '');
    // Skip non-product pages
    if (u.includes('/flooring/') || u.includes('/about') || u.includes('/career') ||
        u.includes('/privacy') || u.includes('/dealer') || u.includes('/galleries') ||
        u.includes('/resources') || u.includes('/define') || u.includes('/every-step') ||
        u.includes('/gaiaview') || u.includes('/catalog/') || u.includes('-endcap') ||
        u === BASE_URL) continue;
    urls.push(u + '/');
  }
  return urls;
}

// Extract images from a product page
function extractImagesFromHtml(html, url) {
  const imgs = [];
  const seen = new Set();

  // Strategy 1: og:image
  const ogMatch = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i) ||
                  html.match(/<meta\s+content="([^"]+)"\s+property="og:image"/i);
  if (ogMatch && !ogMatch[1].includes('logo') && !ogMatch[1].includes('favicon')) {
    const src = ogMatch[1];
    if (!seen.has(src)) { seen.add(src); imgs.push(src); }
  }

  // Strategy 2: Product gallery images (Magento catalog/product media)
  const patterns = [
    /(?:src|data-src|href)="(https?:\/\/gaiafloor\.com\/[^"]*?\/catalog\/product[^"]+\.(?:jpg|jpeg|png|webp))"/gi,
    /(?:src|data-src|href)="(https?:\/\/gaiafloor\.com\/media\/[^"]+\.(?:jpg|jpeg|png|webp))"/gi,
    /(?:src|data-src|href)="(\/media\/[^"]+\.(?:jpg|jpeg|png|webp))"/gi,
    /(?:src|data-src|href)="(https?:\/\/gaiafloor\.com\/pub\/media\/[^"]+\.(?:jpg|jpeg|png|webp))"/gi,
  ];

  for (const pattern of patterns) {
    let m;
    while ((m = pattern.exec(html)) !== null) {
      let src = m[1];
      if (src.startsWith('/')) src = BASE_URL + src;
      if (src.includes('logo') || src.includes('icon') || src.includes('favicon') ||
          src.includes('placeholder') || src.includes('small_image')) continue;
      // Get full-size
      const full = src.replace(/\/cache\/[^/]+\//, '/');
      if (!seen.has(full)) { seen.add(full); imgs.push(full); }
    }
  }

  // Strategy 3: Any image with product-related content
  const anyImgPattern = /(?:src|data-src)="(https?:\/\/[^"]+\.(?:jpg|jpeg|png|webp))"/gi;
  let m2;
  while ((m2 = anyImgPattern.exec(html)) !== null) {
    const src = m2[1];
    if (src.includes('logo') || src.includes('icon') || src.includes('favicon') ||
        src.includes('placeholder') || src.includes('banner') || src.includes('widget') ||
        src.includes('google') || src.includes('facebook') || src.includes('instagram') ||
        seen.has(src)) continue;
    if (src.includes('gaiafloor.com') && (src.includes('catalog') || src.includes('media') || src.includes('product'))) {
      const full = src.replace(/-\d+x\d+(\.[a-zA-Z]+)$/, '$1');
      if (!seen.has(full)) { seen.add(full); imgs.push(full); }
    }
  }

  return imgs;
}

async function run() {
  const vendorRes = await pool.query("SELECT id FROM vendors WHERE code = 'GAIA'");
  if (!vendorRes.rows.length) { console.error('GAIA vendor not found'); return; }
  const vendorId = vendorRes.rows[0].id;

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

  // Step 1: Get URLs from sitemap
  console.log('=== Step 1: Fetching product URLs from sitemap ===');
  const sitemapUrls = await getSitemapUrls();
  console.log(`  Found ${sitemapUrls.length} product URLs\n`);

  // Step 2: Match
  console.log('=== Step 2: Matching URLs to DB products ===');
  const matches = [];
  const matchedProductIds = new Set();

  const nameMap = new Map();
  for (const prod of needsImages) {
    nameMap.set(normalizeForMatch(prod.name), prod);
  }

  for (const url of sitemapUrls) {
    const slug = url.replace(/\/+$/, '').split('/').pop() || '';
    const normSlug = normalizeForMatch(slug);

    // Try exact normalized name match
    let prod = nameMap.get(normSlug);

    // Try fuzzy: slug contains name or name contains slug
    if (!prod) {
      for (const [normName, p] of nameMap.entries()) {
        if (matchedProductIds.has(p.product_id)) continue;
        if (normName.length >= 4 && (normSlug.includes(normName) || normName.includes(normSlug))) {
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
    for (const p of stillMissing) console.log(`  ${p.collection} / ${p.name}`);
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

    const images = extractImagesFromHtml(html, url);
    if (!images.length) {
      console.log(`  ${dbProd.name} → [NO IMAGES]`);
      await delay(300);
      continue;
    }

    const cleaned = filterImageUrls(images, { maxImages: 6 });
    const mainSkuIds = (dbProd.main_sku_ids || []).filter(Boolean);
    let saved;
    if (mainSkuIds.length === 1) {
      saved = await saveSkuImages(pool, dbProd.product_id, mainSkuIds[0], cleaned, { maxImages: 6 });
    } else {
      saved = await saveProductImages(pool, dbProd.product_id, cleaned, { maxImages: 6 });
    }
    imagesSaved += saved;

    productsWithImages++;
    const level = mainSkuIds.length === 1 ? 'SKU' : 'product';
    console.log(`  ${dbProd.name} (${dbProd.collection}) → ${saved} image(s) at ${level} level`);
    await delay(1000);
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
