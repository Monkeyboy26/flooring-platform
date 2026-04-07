/**
 * MSI Surfaces — Image Enrichment Scraper (fetch-based, no Puppeteer)
 *
 * Fetches product pages from msisurfaces.com via the sitemap, extracts
 * CDN image URLs and SKU codes from the HTML, matches to existing DB
 * products by vendor_sku, and saves images to media_assets.
 *
 * Strategy:
 *   1. Fetch sitemap.xml → extract all product-level URLs
 *   2. Also crawl category listing pages (HTML) to find more product URLs
 *   3. For each product page, fetch HTML and extract:
 *      - CDN image URLs (cdn.msisurfaces.com/images/...)
 *      - SKU codes (ID#: XXXXX pattern)
 *   4. Match SKU codes → DB vendor_sku (case-insensitive)
 *   5. Save images via saveProductImages()
 *
 * No Puppeteer needed — MSI renders product data server-side.
 *
 * Usage: docker compose exec api node scrapers/msi-images.js [--category porcelain] [--limit 100]
 */
import pg from 'pg';
import { saveProductImages, filterImageUrls } from './base.js';

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: 5432, database: 'flooring_pim', user: 'postgres', password: 'postgres',
});

const BASE = 'https://www.msisurfaces.com';
const CDN = 'https://cdn.msisurfaces.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const DELAY_MS = 1500;

// Category listing pages to crawl for product URLs
const CATEGORY_PAGES = [
  // Porcelain tile series (use /flooring-tile/ hub which lists all)
  '/porcelain-tile/', '/marble-tile/', '/travertine-tile/',
  '/granite-tile/', '/quartzite-tile/', '/slate-tile/',
  '/sandstone-tile/', '/limestone-tile/', '/onyx-tile/',
  '/wood-look-tile-and-planks/', '/large-format-tile/',
  // LVP
  '/luxury-vinyl-flooring/', '/waterproof-hybrid-rigid-core/',
  // Hardwood
  '/w-luxury-genuine-hardwood/',
  // Hardscaping
  '/hardscape/rockmount-stacked-stone/', '/hardscape/arterra-porcelain-pavers/',
  '/hardscape/cobbles/', '/hardscape/stepping-stones/',
  '/hardscape/pavers/', '/hardscape/outdoor-tile/',
  // Mosaics & Backsplash
  '/mosaics/collections-mosaics/',
  '/backsplash-tile/subway-tile/', '/backsplash-tile/glass-tile/',
  '/backsplash-tile/geometric-pattern/', '/backsplash-tile/stacked-stone-collection/',
  '/backsplash-tile/encaustic-pattern/', '/backsplash-tile/specialty-shapes-wall-tile/',
  '/backsplash-tile/rio-lago-pebbles-mosaics/', '/backsplash-tile/waterjet-cut-mosaics/',
  '/backsplash-tile/acoustic-wood-slat/',
  // Stacked stone
  '/stacked-stone/',
  // Countertops (already have most images, but fill gaps)
  '/quartz-countertops/', '/granite-countertops/',
  '/marble-countertops/', '/quartzite-countertops/',
];

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function fetchText(url) {
  const resp = await fetch(url, {
    headers: { 'User-Agent': UA },
    redirect: 'follow',
    signal: AbortSignal.timeout(30000),
  });
  if (!resp.ok) return null;
  return resp.text();
}

// ─── Step 1: Get product URLs from sitemap ───

async function fetchSitemapUrls() {
  console.log('=== Fetching sitemap ===');
  const xml = await fetchText(`${BASE}/sitemap.xml`);
  if (!xml) { console.log('  Failed to fetch sitemap.xml'); return []; }

  const urls = [];
  const locRegex = /<loc>\s*(https?:\/\/[^<]+)\s*<\/loc>/g;
  let m;
  while ((m = locRegex.exec(xml)) !== null) {
    urls.push(m[1].trim());
  }

  // Filter to product-level URLs (2+ path segments, not category hubs)
  const productUrls = urls.filter(u => {
    const path = new URL(u).pathname;
    const segments = path.split('/').filter(Boolean);
    if (segments.length < 2) return false;
    // Reject non-product pages
    if (/\.(aspx|html)$/i.test(path)) return false;
    if (/\/(corporate|news|blog|locations|site-search|dealer|customer|vendor|room-visualizer|inspiration|merchandising|faq|privacy|brochures|flyers|silica|radon|sds|helpful|right-to|msivideo|slabphoto|linktomsi|msi-retailer|new-products|shopping)/i.test(path)) return false;
    return true;
  });

  console.log(`  Sitemap: ${urls.length} total URLs, ${productUrls.length} potential product pages`);
  return productUrls;
}

// ─── Step 2: Get product URLs from category listing pages ───

async function fetchCategoryProductUrls(categoryPath) {
  const html = await fetchText(`${BASE}${categoryPath}`);
  if (!html) return [];

  const urls = new Set();
  // Find all internal links that look like product pages
  const linkRegex = /href="(\/[^"]+\/[^"]+\/)"/g;
  let m;
  while ((m = linkRegex.exec(html)) !== null) {
    const path = m[1];
    const segments = path.split('/').filter(Boolean);
    if (segments.length < 2) continue;
    // Reject known non-product paths
    if (/\/(colors|features|benefits|faq|resources|installation|gallery|videos?|warranty|care|cleaning|about|how-to|design-trends|site-search|corporate|news|blog)\/?$/i.test(path)) continue;
    if (/\.(aspx|html|pdf|jpg|png)$/i.test(path)) continue;
    // Reject size-only paths like /48-x-48-porcelain-tile/
    const last = segments[segments.length - 1];
    if (/^\d+\s*[-x]\s*\d+/.test(last)) continue;
    urls.add(`${BASE}${path}`);
  }
  return [...urls];
}

// ─── Step 3: Extract images and SKU codes from a product page ───

function extractProductData(html, url) {
  const data = { images: [], skuCodes: [], name: '' };

  // Extract product name from <h1>
  const h1Match = html.match(/<h1[^>]*>(.*?)<\/h1>/is);
  if (h1Match) {
    data.name = h1Match[1].replace(/<[^>]+>/g, '').trim();
  }

  // Extract SKU codes: ID#: XXXXX pattern
  const skuRegex = /ID#:\s*([A-Z0-9][-A-Z0-9]{4,})/gi;
  let m;
  while ((m = skuRegex.exec(html)) !== null) {
    const code = m[1].toUpperCase();
    if (!data.skuCodes.includes(code)) {
      data.skuCodes.push(code);
    }
  }

  // Extract CDN image URLs (decode HTML entities like &amp; → &)
  const imgRegex = /https?:\/\/cdn\.msisurfaces\.com\/images\/[^"'\s)]+\.(?:jpg|jpeg|png|webp)/gi;
  while ((m = imgRegex.exec(html)) !== null) {
    const imgUrl = m[0].replace(/&amp;/g, '&');
    if (!data.images.includes(imgUrl)) {
      data.images.push(imgUrl);
    }
  }

  // Prioritize: detail/colornames first, then iso/edge/vignette, then roomscenes
  data.images.sort((a, b) => {
    const scoreA = imageScore(a);
    const scoreB = imageScore(b);
    return scoreB - scoreA;
  });

  return data;
}

function imageScore(url) {
  const lower = url.toLowerCase();
  if (lower.includes('/detail/') || lower.includes('/colornames/')) return 100;
  if (lower.includes('/front/')) return 80;
  if (lower.includes('/iso/')) return 60;
  if (lower.includes('/edge/')) return 50;
  if (lower.includes('/vignette/')) return 40;
  if (lower.includes('/variations/')) return 35;
  if (lower.includes('/roomscenes/')) return 20;
  if (lower.includes('/trims/')) return 5;
  if (lower.includes('/thumbnails/')) return 1;
  return 30;
}

// ─── Main ───

async function run() {
  const args = process.argv.slice(2);
  const categoryFilter = args.includes('--category') ? args[args.indexOf('--category') + 1] : null;
  const limitArg = args.includes('--limit') ? parseInt(args[args.indexOf('--limit') + 1]) : null;

  // Load MSI vendor
  const vendorRes = await pool.query("SELECT id FROM vendors WHERE code = 'MSI'");
  if (!vendorRes.rows.length) { console.error('MSI vendor not found'); await pool.end(); return; }
  const vendorId = vendorRes.rows[0].id;

  // Load all MSI products needing images, with their SKUs
  const dbResult = await pool.query(`
    SELECT p.id as product_id, p.name, p.collection,
           array_agg(DISTINCT s.vendor_sku) FILTER (WHERE s.vendor_sku IS NOT NULL) as vendor_skus,
           array_agg(DISTINCT s.internal_sku) FILTER (WHERE s.internal_sku IS NOT NULL) as internal_skus
    FROM products p
    JOIN skus s ON s.product_id = p.id
    LEFT JOIN media_assets ma ON ma.product_id = p.id AND ma.asset_type = 'primary'
    WHERE p.vendor_id = $1 AND p.is_active = true AND ma.id IS NULL
    GROUP BY p.id, p.name, p.collection
    ORDER BY p.name
  `, [vendorId]);

  const needsImages = dbResult.rows;
  console.log(`Products needing images: ${needsImages.length}\n`);

  if (!needsImages.length) { console.log('All MSI products have images.'); await pool.end(); return; }

  // Build SKU lookup: UPPER(vendor_sku) → product row, UPPER(internal_sku) → product row
  const skuToProduct = new Map();
  for (const row of needsImages) {
    for (const sku of (row.vendor_skus || [])) {
      skuToProduct.set(sku.toUpperCase(), row);
    }
    for (const sku of (row.internal_skus || [])) {
      // internal_sku is like "MSI-NADEGRI1818", strip prefix for matching
      skuToProduct.set(sku.toUpperCase(), row);
      const withoutPrefix = sku.replace(/^MSI-/i, '').toUpperCase();
      skuToProduct.set(withoutPrefix, row);
    }
  }
  console.log(`SKU lookup entries: ${skuToProduct.size}`);

  // Also build name lookup for fuzzy matching
  const nameToProduct = new Map();
  for (const row of needsImages) {
    const norm = row.name.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (norm.length >= 4) nameToProduct.set(norm, row);
  }

  // Step 1: Collect product URLs
  console.log('\n=== Collecting product URLs ===');
  const allProductUrls = new Set();

  // From sitemap
  const sitemapUrls = await fetchSitemapUrls();
  sitemapUrls.forEach(u => allProductUrls.add(u));

  // From category pages
  const categories = categoryFilter
    ? CATEGORY_PAGES.filter(c => c.includes(categoryFilter))
    : CATEGORY_PAGES;

  for (const cat of categories) {
    try {
      const urls = await fetchCategoryProductUrls(cat);
      console.log(`  ${cat} → ${urls.length} product links`);
      urls.forEach(u => allProductUrls.add(u));
      await delay(800);
    } catch (err) {
      console.log(`  ${cat} → ERROR: ${err.message}`);
    }
  }

  console.log(`\nTotal unique product URLs to visit: ${allProductUrls.size}\n`);

  // Step 2: Visit each product page, extract images + SKUs, match to DB
  let visited = 0;
  let matched = 0;
  let saved = 0;
  const matchedProductIds = new Set();
  const limit = limitArg || allProductUrls.size;

  console.log('=== Fetching product pages ===');
  for (const url of allProductUrls) {
    if (visited >= limit) break;
    visited++;

    try {
      const html = await fetchText(url);
      if (!html) { continue; }

      // Check for rate limiting
      if (/too many requests|429|rate limit/i.test(html.slice(0, 1000))) {
        console.log(`  Rate limited at ${url}, waiting 10s...`);
        await delay(10000);
        continue;
      }

      const data = extractProductData(html, url);

      if (data.images.length === 0) continue;

      // Match SKU codes to DB products
      let dbProd = null;
      for (const code of data.skuCodes) {
        dbProd = skuToProduct.get(code);
        if (dbProd) break;
        // Try with MSI- prefix
        dbProd = skuToProduct.get('MSI-' + code);
        if (dbProd) break;
      }

      // Fallback: match by product name from page vs DB name
      if (!dbProd && data.name) {
        const pageNameNorm = data.name
          .replace(/[®™©]/g, '')
          .replace(/\s+(Porcelain|Ceramic|Marble|Granite|Travertine|Quartzite|Limestone|Vinyl|Tile|Plank|Flooring|Slab|Stone|Wood|Luxury|Stacked|Mosaic|Backsplash|Collection|Series)\b/gi, '')
          .toLowerCase().replace(/[^a-z0-9]/g, '');
        if (pageNameNorm.length >= 4) {
          dbProd = nameToProduct.get(pageNameNorm);
        }
      }

      if (!dbProd) {
        if (visited <= 30 || visited % 100 === 0) {
          console.log(`  [${visited}] No match: ${url.split('/').slice(3).join('/')} (SKUs: ${data.skuCodes.slice(0, 3).join(', ') || 'none'}, imgs: ${data.images.length})`);
        }
        continue;
      }
      if (matchedProductIds.has(dbProd.product_id)) {
        continue;
      }
      matchedProductIds.add(dbProd.product_id);

      // Filter and save images (exclude thumbnails, trims, small images)
      const cleaned = filterImageUrls(data.images, {
        maxImages: 5,
        extraExclude: ['thumbnails/', '/trims/', 'video', 'play-button'],
      });
      if (cleaned.length === 0) continue;

      const count = await saveProductImages(pool, dbProd.product_id, cleaned, { maxImages: 5 });
      matched++;
      saved += count;

      if (matched % 25 === 0) {
        console.log(`  Progress: visited ${visited}, matched ${matched}, images saved ${saved}`);
      }
    } catch (err) {
      // Non-fatal — continue
    }

    await delay(DELAY_MS);
  }

  // Report
  const stillMissing = needsImages.filter(p => !matchedProductIds.has(p.product_id));
  console.log(`\n=== Complete ===`);
  console.log(`Product pages visited: ${visited}`);
  console.log(`Products matched & enriched: ${matched}`);
  console.log(`Total images saved: ${saved}`);
  console.log(`Still missing images: ${stillMissing.length}`);

  if (stillMissing.length > 0 && stillMissing.length <= 50) {
    console.log('\nStill missing:');
    for (const p of stillMissing.slice(0, 50)) {
      console.log(`  ${p.name} (${(p.vendor_skus || []).slice(0, 3).join(', ')})`);
    }
  }

  await pool.end();
}

run().catch(err => { console.error(err); process.exit(1); });
