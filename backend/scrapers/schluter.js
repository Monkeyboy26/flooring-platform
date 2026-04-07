import { upsertMediaAsset, appendLog, addJobError } from './base.js';

/**
 * Schluter Systems image enrichment scraper.
 *
 * Schluter products (edge trims, membranes, drains, etc.) are sold through
 * Daltile but images come from schluter.com directly. Products share images
 * at the product-line level (e.g., all JOLLY variants share one image).
 *
 * Strategy:
 *   1. Fetch Schluter product sitemap → extract one URL per product line
 *   2. Fetch each product page → extract images from JSON-LD structured data
 *   3. Match to DB products by product line name
 *   4. Save as product-level images (sku_id = null)
 *
 * No auth required — all pages and images are public.
 */

const SITEMAP_INDEX = 'https://www.schluter.com/sitemap.xml';
const SITE_BASE = 'https://www.schluter.com';

// Image CDN domains used by Schluter
const IMAGE_CDNS = ['sccpublic.s3-external-1.amazonaws.com', 'assets.schluter.com'];

export async function run(pool, job, source) {
  await appendLog(pool, job.id, 'Starting Schluter image enrichment scraper');

  // Step 1: Load products without images
  const products = await loadSchluterProducts(pool);
  await appendLog(pool, job.id, `Found ${products.length} Schluter products without images`);

  if (products.length === 0) {
    await appendLog(pool, job.id, 'No Schluter products need images — done');
    return;
  }

  // Step 2: Group products by product line
  const lineGroups = groupByProductLine(products);
  await appendLog(pool, job.id, `Grouped into ${lineGroups.size} distinct product lines`);

  // Step 3: Fetch product sitemap → build line-to-URL mapping
  const sitemapUrls = await fetchProductSitemap();
  await appendLog(pool, job.id, `Fetched sitemap with ${sitemapUrls.length} product URLs`);

  const lineUrlMap = buildLineUrlMap(sitemapUrls);
  await appendLog(pool, job.id, `Mapped ${lineUrlMap.size} product lines to page URLs`);

  // Step 4: For each product line, fetch page and extract images
  let stats = { linesSearched: 0, linesMatched: 0, productsMatched: 0, imagesSet: 0, errors: 0 };

  for (const [lineName, prods] of lineGroups) {
    try {
      const result = await processProductLine(pool, lineName, prods, lineUrlMap);
      stats.linesSearched++;
      if (result.matched) {
        stats.linesMatched++;
        stats.productsMatched += result.productsMatched;
        stats.imagesSet += result.imagesSet;
      }
    } catch (err) {
      stats.errors++;
      if (stats.errors <= 30) {
        await addJobError(pool, job.id, `Line "${lineName}": ${err.message}`);
      }
    }

    // Progress every 20 lines
    if (stats.linesSearched % 20 === 0) {
      await appendLog(pool, job.id,
        `Progress: ${stats.linesSearched}/${lineGroups.size} lines — ` +
        `${stats.productsMatched} products matched, ${stats.imagesSet} images`,
        { products_found: products.length, products_updated: stats.productsMatched }
      );
    }

    // Polite delay between page fetches
    await delay(200);
  }

  await appendLog(pool, job.id,
    `Complete. Lines searched: ${stats.linesSearched}, Lines with images: ${stats.linesMatched}, ` +
    `Products matched: ${stats.productsMatched}, Images saved: ${stats.imagesSet}, ` +
    `Errors: ${stats.errors}`,
    { products_found: products.length, products_updated: stats.productsMatched }
  );
}

// ─── DB Loading ──────────────────────────────────────────────────────────────

async function loadSchluterProducts(pool) {
  const result = await pool.query(`
    SELECT DISTINCT ON (p.id)
      p.id AS product_id, p.name, p.collection
    FROM products p
    JOIN vendors v ON v.id = p.vendor_id
    LEFT JOIN media_assets ma ON ma.product_id = p.id
    WHERE v.code = 'DAL'
      AND p.collection = 'Schluter Systems LP'
      AND ma.id IS NULL
    ORDER BY p.id
  `);
  return result.rows;
}

// ─── Product Line Grouping ───────────────────────────────────────────────────

/**
 * Extract product line name from our DB product name.
 *
 * Our format: "Sch {ProductLine} {details...}"
 * Examples:
 *   "Sch Jolly 3/8" Alum Anodized"  → "Jolly"
 *   "Sch Kerdi-Line 40" Tileable"    → "Kerdi-Line"
 *   "Sch Ditra-Heat 120v Cable"      → "Ditra-Heat"
 *   "Sch Bara-Rak 90 Degree Alum"    → "Bara-Rak"
 *   "Sch All-Set 50 Lb Modified"     → "All-Set"
 *   "Sch Rondec-Step 5/16" Alum"     → "Rondec-Step"
 */
function extractProductLine(name) {
  if (!name) return null;

  // Strip "Sch " prefix
  let rest = name.replace(/^Sch\s+/i, '').trim();
  if (!rest) return null;

  // The product line is the first word (or hyphenated compound word)
  // followed by details starting with a number, size, material, etc.
  // Match: word(-word)* until we hit a number, quote, or common detail word
  const match = rest.match(/^([A-Za-z]+(?:-[A-Za-z]+)*)/);
  return match ? match[1] : rest.split(/\s+/)[0];
}

function groupByProductLine(products) {
  const groups = new Map();

  for (const prod of products) {
    const line = extractProductLine(prod.name);
    if (!line) continue;

    const key = line.toUpperCase();
    if (!groups.has(key)) {
      groups.set(key, { lineName: line, products: [] });
    }
    groups.get(key).products.push(prod);
  }

  // Return as Map<lineName, products[]>
  const result = new Map();
  for (const [, val] of groups) {
    result.set(val.lineName, val.products);
  }
  return result;
}

// ─── Sitemap Processing ─────────────────────────────────────────────────────

async function fetchProductSitemap() {
  // Step 1: Get sitemap index
  const indexResp = await fetch(SITEMAP_INDEX, { signal: AbortSignal.timeout(15000) });
  const indexXml = await indexResp.text();

  // Find PRODUCT sitemap URL (en_US)
  const sitemapMatch = indexXml.match(/<loc>([^<]*PRODUCT-en_US[^<]*)<\/loc>/);
  if (!sitemapMatch) throw new Error('Product sitemap not found in sitemap index');

  // Step 2: Fetch product sitemap
  const sitemapResp = await fetch(sitemapMatch[1], { signal: AbortSignal.timeout(30000) });
  const sitemapXml = await sitemapResp.text();

  // Extract all URLs
  const urls = [];
  for (const m of sitemapXml.matchAll(/<loc>([^<]+)<\/loc>/g)) {
    urls.push(m[1]);
  }

  return urls;
}

/**
 * Build a mapping of product line names to one representative page URL.
 * Picks the shortest URL per line (most likely the base product page).
 */
function buildLineUrlMap(sitemapUrls) {
  const map = new Map(); // normalized line name → URL

  for (const url of sitemapUrls) {
    // Extract product line from URL: /Schluter®-{LINE}/p/
    const lineMatch = url.match(/Schluter%C2%AE-([^/]+)\/p\//);
    if (!lineMatch) continue;

    const rawLine = decodeURIComponent(lineMatch[1]).replace(/-/g, ' ').trim();
    const key = rawLine.toUpperCase();

    // Keep the shortest URL per line (base product page, not variant)
    if (!map.has(key) || url.length < map.get(key).length) {
      map.set(key, url);
    }
  }

  return map;
}

// ─── Page Scraping ───────────────────────────────────────────────────────────

/**
 * Process a single product line: find URL, fetch page, extract images, save.
 */
async function processProductLine(pool, lineName, products, lineUrlMap) {
  // Normalize line name for lookup
  const lookupKey = lineName.toUpperCase();
  // Try multiple key formats
  const url = lineUrlMap.get(lookupKey)
    || lineUrlMap.get(lookupKey.replace(/-/g, ' '))
    || lineUrlMap.get(lookupKey.replace(/\s+/g, ' '));

  if (!url) {
    return { matched: false, productsMatched: 0, imagesSet: 0 };
  }

  // Fetch the product page
  const resp = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'text/html',
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!resp.ok) return { matched: false, productsMatched: 0, imagesSet: 0 };

  const html = await resp.text();
  const images = extractImagesFromPage(html);

  if (images.length === 0) {
    return { matched: false, productsMatched: 0, imagesSet: 0 };
  }

  // Save images for all products in this line
  let imagesSet = 0;
  for (const prod of products) {
    // Primary image
    await upsertMediaAsset(pool, {
      product_id: prod.product_id,
      sku_id: null,
      asset_type: 'primary',
      url: images[0],
      original_url: images[0],
      sort_order: 0,
    });
    imagesSet++;

    // Lifestyle/alternate image if available
    if (images.length > 1) {
      await upsertMediaAsset(pool, {
        product_id: prod.product_id,
        sku_id: null,
        asset_type: 'lifestyle',
        url: images[1],
        original_url: images[1],
        sort_order: 1,
      });
      imagesSet++;
    }
  }

  return { matched: true, productsMatched: products.length, imagesSet };
}

/**
 * Extract product image URLs from page HTML.
 * Looks for JSON-LD structured data and og:image meta tags.
 */
function extractImagesFromPage(html) {
  const images = [];
  const seen = new Set();

  // Method 1: JSON-LD structured data
  const jsonLdBlocks = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const block of jsonLdBlocks) {
    const content = block.replace(/<script[^>]*>|<\/script>/gi, '').trim();
    try {
      const data = JSON.parse(content);
      extractJsonLdImages(data, images, seen);
    } catch { /* skip invalid JSON */ }
  }

  // Method 2: og:image meta tag
  const ogMatch = html.match(/<meta[^>]*property="og:image"[^>]*content="([^"]+)"/i);
  if (ogMatch && !seen.has(normalizeUrl(ogMatch[1]))) {
    images.push(ogMatch[1]);
    seen.add(normalizeUrl(ogMatch[1]));
  }

  // Method 3: img tags with Schluter CDN URLs
  const imgRegex = /<img[^>]+src="(https:\/\/(?:sccpublic\.s3[^"]+|assets\.schluter\.com[^"]+))"/gi;
  let imgMatch;
  while ((imgMatch = imgRegex.exec(html)) !== null) {
    const url = imgMatch[1];
    const norm = normalizeUrl(url);
    if (!seen.has(norm) && isProductImage(url)) {
      images.push(url);
      seen.add(norm);
    }
  }

  return images;
}

function extractJsonLdImages(data, images, seen) {
  if (!data) return;

  if (Array.isArray(data)) {
    for (const item of data) extractJsonLdImages(item, images, seen);
    return;
  }

  // Product with image property
  if (data.image) {
    const imgList = Array.isArray(data.image) ? data.image : [data.image];
    for (const img of imgList) {
      const url = typeof img === 'string' ? img : img?.url;
      if (url && url.startsWith('http') && isProductImage(url)) {
        const norm = normalizeUrl(url);
        if (!seen.has(norm)) {
          images.push(url);
          seen.add(norm);
        }
      }
    }
  }

  // Recurse into @graph
  if (data['@graph']) {
    extractJsonLdImages(data['@graph'], images, seen);
  }
}

function isProductImage(url) {
  const lower = url.toLowerCase();
  // Skip logos, icons, tiny images
  if (lower.includes('logo') || lower.includes('icon') || lower.includes('favicon')) return false;
  if (lower.includes('placeholder') || lower.includes('spinner')) return false;
  // Must be from Schluter CDN
  return IMAGE_CDNS.some(cdn => lower.includes(cdn));
}

function normalizeUrl(url) {
  // Strip size parameters for dedup: -S430-FJPG, -S640-FJPG, -S100-FJPG
  return url.toLowerCase()
    .replace(/-S\d+-FJPG/gi, '')
    .split('?')[0];
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
