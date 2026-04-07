import { upsertMediaAsset, appendLog, addJobError } from './base.js';

/**
 * Noble Company image enrichment scraper.
 *
 * Noble Company products (waterproofing membranes, drains, niches, shower bases,
 * installation accessories) are sold through Daltile but images come from
 * noblecompany.com directly. Products share images at the product-line level
 * (e.g., all AquaSeal variants share one image set).
 *
 * Strategy:
 *   1. Load DB products without images (vendor code 'DAL', collection 'Noble Company INC')
 *   2. Group by product line: extract base name from "Nob {ProductLine} {details}" format
 *   3. Crawl Noble category pages → extract product links + thumbnail images
 *   4. For each product detail page, fetch and extract image URLs
 *   5. Match crawled products to DB product lines by normalized name
 *   6. Save as product-level images (sku_id = null), primary + lifestyle
 *
 * No auth required — all pages and images are public, no bot protection.
 */

const SITE_BASE = 'https://noblecompany.com';

// Category pages under /products/tile-installation/ that contain Noble products
const CATEGORY_PAGES = [
  '/products/tile-installation/sheet-membranes/',
  '/products/tile-installation/drains/',
  '/products/tile-installation/niches-benches/',
  '/products/tile-installation/pre-slopes-shower-bases/',
  '/products/tile-installation/installation-products/',
];

// Noble image URL patterns
const IMAGE_DOMAIN = 'noblecompany.com';

export async function run(pool, job, source) {
  await appendLog(pool, job.id, 'Starting Noble Company image enrichment scraper');

  // Step 1: Load products without images
  const products = await loadNobleProducts(pool);
  await appendLog(pool, job.id, `Found ${products.length} Noble Company products without images`);

  if (products.length === 0) {
    await appendLog(pool, job.id, 'No Noble Company products need images — done');
    return;
  }

  // Step 2: Group products by product line
  const lineGroups = groupByProductLine(products);
  await appendLog(pool, job.id, `Grouped into ${lineGroups.size} distinct product lines`);

  // Step 3: Crawl category pages → build product catalog with images
  const crawledProducts = await crawlCategoryPages(pool, job);
  await appendLog(pool, job.id, `Crawled ${crawledProducts.length} products from Noble website`);

  // Step 4: Fetch detail pages for richer images
  const productImageMap = new Map(); // normalized name → { images: string[], pageUrl: string }

  for (const crawled of crawledProducts) {
    try {
      const detailImages = await fetchDetailPageImages(crawled.url);
      const allImages = deduplicateImages([...detailImages, ...crawled.images]);
      productImageMap.set(crawled.normalizedName, {
        images: allImages,
        pageUrl: crawled.url,
        rawName: crawled.name,
      });
    } catch (err) {
      // Fall back to category-page thumbnail images
      if (crawled.images.length > 0) {
        productImageMap.set(crawled.normalizedName, {
          images: crawled.images,
          pageUrl: crawled.url,
          rawName: crawled.name,
        });
      }
    }

    // Polite delay between page fetches
    await delay(300);
  }

  await appendLog(pool, job.id, `Built image map for ${productImageMap.size} Noble products`);

  // Step 5: Match product lines to crawled products and save images
  let stats = { linesSearched: 0, linesMatched: 0, productsMatched: 0, imagesSet: 0, errors: 0 };

  for (const [lineName, prods] of lineGroups) {
    try {
      const result = await matchAndSaveImages(pool, lineName, prods, productImageMap);
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

    // Progress every 10 lines
    if (stats.linesSearched % 10 === 0) {
      await appendLog(pool, job.id,
        `Progress: ${stats.linesSearched}/${lineGroups.size} lines — ` +
        `${stats.productsMatched} products matched, ${stats.imagesSet} images`,
        { products_found: products.length, products_updated: stats.productsMatched }
      );
    }
  }

  await appendLog(pool, job.id,
    `Complete. Lines searched: ${stats.linesSearched}, Lines with images: ${stats.linesMatched}, ` +
    `Products matched: ${stats.productsMatched}, Images saved: ${stats.imagesSet}, ` +
    `Errors: ${stats.errors}`,
    { products_found: products.length, products_updated: stats.productsMatched }
  );
}

// ─── DB Loading ──────────────────────────────────────────────────────────────

async function loadNobleProducts(pool) {
  const result = await pool.query(`
    SELECT DISTINCT ON (p.id)
      p.id AS product_id, p.name, p.collection
    FROM products p
    JOIN vendors v ON v.id = p.vendor_id
    LEFT JOIN media_assets ma ON ma.product_id = p.id
    WHERE v.code = 'DAL'
      AND p.collection = 'Noble Company INC'
      AND ma.id IS NULL
    ORDER BY p.id
  `);
  return result.rows;
}

// ─── Product Line Grouping ───────────────────────────────────────────────────

/**
 * Extract product line name from our DB product name.
 *
 * Our format: "Nob {ProductLine} {details...}"
 * The product line is everything after "Nob " up to where
 * size/quantity details begin (numbers, quotes, dimensions).
 *
 * Examples:
 *   "Nob Aquaseal 3' x 100' Roll"          → "Aquaseal"
 *   "Nob Clamping Ring Drain 1 Pc"          → "Clamping Ring Drain"
 *   "Nob Freedom Shower Base 1 Pc"          → "Freedom Shower Base"
 *   "Nob Linear Drain 1 Pc"                 → "Linear Drain"
 *   "Nob Shower Niche 1 Pc"                 → "Shower Niche"
 *   "Nob Nobleseal Ts 5" x 50' Roll"        → "Nobleseal Ts"
 *   "Nob Chloraloy Green 4' x 50' Roll"     → "Chloraloy Green"
 *   "Nob PVC Shower Pan Liner 4' x 50'"     → "PVC Shower Pan Liner"
 *   "Nob Pro-Slope Kit 1 Pc"                → "Pro-Slope Kit"
 */
function extractProductLine(name) {
  if (!name) return null;

  // Strip "Nob " prefix
  let rest = name.replace(/^Nob\s+/i, '').trim();
  if (!rest) return null;

  // Split into words and take everything before the first numeric/dimension token
  // Numeric tokens: digits, fractions, dimension patterns like 3', 5", 12x24
  const words = rest.split(/\s+/);
  const lineWords = [];

  for (const word of words) {
    // Stop at numeric/dimension tokens
    if (/^\d/.test(word)) break;         // starts with digit: "3'", "100'", "1", "5"", "12x24"
    if (/^['"]\d/.test(word)) break;     // starts with quote+digit
    if (/^\d+['"]/.test(word)) break;    // dimension like 4'
    lineWords.push(word);
  }

  return lineWords.length > 0 ? lineWords.join(' ') : rest.split(/\s+/)[0];
}

function groupByProductLine(products) {
  const groups = new Map();

  for (const prod of products) {
    const line = extractProductLine(prod.name);
    if (!line) continue;

    const key = normalizeName(line);
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

// ─── Category Page Crawling ──────────────────────────────────────────────────

/**
 * Crawl all Noble category pages and extract product links + thumbnail images.
 * Returns array of { name, url, normalizedName, images[] }
 */
async function crawlCategoryPages(pool, job) {
  const allProducts = [];
  const seenUrls = new Set();

  for (const categoryPath of CATEGORY_PAGES) {
    try {
      const url = SITE_BASE + categoryPath;
      const resp = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'text/html',
        },
        signal: AbortSignal.timeout(15000),
      });

      if (!resp.ok) {
        await addJobError(pool, job.id, `Category page ${categoryPath} returned ${resp.status}`);
        continue;
      }

      const html = await resp.text();
      const products = extractProductsFromCategoryPage(html);

      for (const prod of products) {
        if (!seenUrls.has(prod.url)) {
          seenUrls.add(prod.url);
          allProducts.push(prod);
        }
      }

      await appendLog(pool, job.id, `Category ${categoryPath}: found ${products.length} products`);
    } catch (err) {
      await addJobError(pool, job.id, `Category ${categoryPath}: ${err.message}`);
    }

    await delay(300);
  }

  return allProducts;
}

/**
 * Parse a category page HTML and extract product entries.
 * Looks for product links and their associated thumbnail images.
 *
 * Noble category pages typically have product cards with:
 *   - <a href="/products/tile-installation/.../{product-slug}/">
 *   - <img src="https://noblecompany.com/storage/...">
 */
function extractProductsFromCategoryPage(html) {
  const products = [];
  const seen = new Set();

  // Noble product cards use: <a class="Card" href="/products/{slug}/">
  // Product links are directly under /products/, NOT nested under tile-installation
  const cardRegex = /<a[^>]+href="(\/products\/([^/"]+)\/?)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;

  // Category slugs to skip (these are navigation links, not products)
  const skipSlugs = new Set([
    'tile-installation', 'plumbing', 'heating-cooling', 'fire-sprinkler',
    'sheet-membranes', 'drains', 'niches-benches', 'pre-slopes-shower-bases',
    'installation-products', 'waterproof-membranes', 'adhesives-sealants',
    'tub-o-towels', 'freeze-protection', 'system-maintenance', 'testing-equipment',
  ]);

  while ((match = cardRegex.exec(html)) !== null) {
    const path = match[1];
    const slug = match[2];
    const innerHtml = match[3];

    // Skip category links
    if (skipSlugs.has(slug)) continue;
    if (seen.has(slug)) continue;
    seen.add(slug);

    // Extract name from slug
    const name = deslugifyNoble(slug);

    // Extract thumbnail image from within the link
    const images = [];
    let imgMatch;

    // Check for img tags with absolute URLs
    const absImgRegex = /<img[^>]+src="(https?:\/\/[^"]+\.(png|jpg|jpeg|webp)[^"]*)"/gi;
    while ((imgMatch = absImgRegex.exec(innerHtml)) !== null) {
      images.push(imgMatch[1]);
    }

    // Check for img tags with relative paths (/storage/...)
    const relImgRegex = /<img[^>]+src="(\/storage\/[^"]+\.(png|jpg|jpeg|webp)[^"]*)"/gi;
    while ((imgMatch = relImgRegex.exec(innerHtml)) !== null) {
      images.push(SITE_BASE + imgMatch[1]);
    }

    const url = SITE_BASE + path;
    products.push({
      name,
      url,
      normalizedName: normalizeName(name),
      images,
    });
  }

  return products;
}

// ─── Detail Page Scraping ────────────────────────────────────────────────────

/**
 * Fetch a Noble product detail page and extract all product images.
 * Returns array of image URLs, best quality first.
 */
async function fetchDetailPageImages(pageUrl) {
  const resp = await fetch(pageUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'text/html',
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!resp.ok) return [];

  const html = await resp.text();
  return extractImagesFromDetailPage(html);
}

/**
 * Extract product images from a Noble detail page HTML.
 * Looks for multiple image sources in priority order.
 */
function extractImagesFromDetailPage(html) {
  const images = [];
  const seen = new Set();

  const addImage = (url) => {
    if (!url) return;
    // Ensure absolute URL
    if (url.startsWith('/')) url = SITE_BASE + url;
    if (!url.startsWith('http')) return;

    const normalized = url.toLowerCase().split('?')[0];
    if (seen.has(normalized)) return;
    if (!isProductImage(url)) return;

    seen.add(normalized);
    images.push(url);
  };

  // Method 1: og:image meta tag (usually the best single product image)
  const ogMatch = html.match(/<meta[^>]*property="og:image"[^>]*content="([^"]+)"/i);
  if (ogMatch) addImage(ogMatch[1]);

  // Method 2: High-res images from /storage/docs/resources/ path
  const resourceRegex = /(?:src|href)="([^"]*\/storage\/docs\/resources\/[^"]+\.(png|jpg|jpeg|webp)[^"]*)"/gi;
  let match;
  while ((match = resourceRegex.exec(html)) !== null) {
    addImage(match[1]);
  }

  // Method 3: Images from /storage/images/products/ path (product images)
  const productImgRegex = /(?:src|data-src|srcset)="([^"]*\/storage\/images\/products\/[^"]+\.(png|jpg|jpeg|webp)[^"]*)"/gi;
  while ((match = productImgRegex.exec(html)) !== null) {
    let url = match[1];
    // Try to get higher-res version by looking for the original (non-cached) URL
    // Cache pattern: /storage/cache/made/storage/images/products/{name}_{w}_{h}_int_c1.png
    // Original pattern: /storage/images/products/{name}.png
    addImage(url);
  }

  // Method 4: Images from /storage/cache/made/ path (cached/resized versions)
  const cacheImgRegex = /(?:src|data-src)="([^"]*\/storage\/cache\/made\/[^"]+\.(png|jpg|jpeg|webp)[^"]*)"/gi;
  while ((match = cacheImgRegex.exec(html)) !== null) {
    addImage(match[1]);
  }

  // Method 5: General img tags with noblecompany.com domain
  const generalImgRegex = /<img[^>]+src="((?:https?:\/\/(?:www\.)?noblecompany\.com)?\/storage\/[^"]+\.(png|jpg|jpeg|webp)[^"]*)"/gi;
  while ((match = generalImgRegex.exec(html)) !== null) {
    addImage(match[1]);
  }

  // Method 6: JSON-LD structured data
  const jsonLdBlocks = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const block of jsonLdBlocks) {
    const content = block.replace(/<script[^>]*>|<\/script>/gi, '').trim();
    try {
      const data = JSON.parse(content);
      extractJsonLdImages(data, addImage);
    } catch { /* skip invalid JSON */ }
  }

  return images;
}

/**
 * Recursively extract image URLs from JSON-LD data.
 */
function extractJsonLdImages(data, addImage) {
  if (!data) return;

  if (Array.isArray(data)) {
    for (const item of data) extractJsonLdImages(item, addImage);
    return;
  }

  if (data.image) {
    const imgList = Array.isArray(data.image) ? data.image : [data.image];
    for (const img of imgList) {
      const url = typeof img === 'string' ? img : img?.url;
      if (url && url.startsWith('http')) addImage(url);
    }
  }

  if (data['@graph']) {
    extractJsonLdImages(data['@graph'], addImage);
  }
}

// ─── Name Matching ───────────────────────────────────────────────────────────

/**
 * Match a product line to crawled products and save images.
 */
async function matchAndSaveImages(pool, lineName, products, productImageMap) {
  // Try exact normalized match first
  const normalizedLine = normalizeName(lineName);
  let bestMatch = productImageMap.get(normalizedLine);

  // If no exact match, try fuzzy matching
  if (!bestMatch) {
    let bestScore = 0;
    let bestKey = null;

    for (const [key, entry] of productImageMap) {
      const score = fuzzyMatchScore(normalizedLine, key);
      if (score > bestScore && score >= 0.5) {
        bestScore = score;
        bestKey = key;
        bestMatch = entry;
      }
    }
  }

  if (!bestMatch || bestMatch.images.length === 0) {
    return { matched: false, productsMatched: 0, imagesSet: 0 };
  }

  // Save images for all products in this line
  let imagesSet = 0;
  for (const prod of products) {
    // Primary image (sort_order: 0)
    await upsertMediaAsset(pool, {
      product_id: prod.product_id,
      sku_id: null,
      asset_type: 'primary',
      url: bestMatch.images[0],
      original_url: bestMatch.images[0],
      sort_order: 0,
    });
    imagesSet++;

    // Lifestyle/alternate image if available (sort_order: 1)
    if (bestMatch.images.length > 1) {
      await upsertMediaAsset(pool, {
        product_id: prod.product_id,
        sku_id: null,
        asset_type: 'lifestyle',
        url: bestMatch.images[1],
        original_url: bestMatch.images[1],
        sort_order: 1,
      });
      imagesSet++;
    }
  }

  return { matched: true, productsMatched: products.length, imagesSet };
}

// ─── Utilities ───────────────────────────────────────────────────────────────

/**
 * Normalize a name for matching: lowercase, strip punctuation, collapse whitespace.
 */
function normalizeName(name) {
  if (!name) return '';
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Convert a URL slug to a readable product name.
 * "aquaseal-sheet-membrane" → "Aquaseal Sheet Membrane"
 */
function deslugifyNoble(slug) {
  if (!slug) return '';
  return slug
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())
    .trim();
}

/**
 * Check if an image URL looks like a product image (not a logo, icon, etc.)
 */
function isProductImage(url) {
  const lower = url.toLowerCase();

  // Must be from Noble's site
  if (!lower.includes(IMAGE_DOMAIN) && !lower.startsWith('/storage/')) return false;

  // Skip logos, icons, tiny images, and non-product elements
  const excludePatterns = [
    'logo', 'icon', 'favicon', 'social', 'sprite',
    'placeholder', 'spinner', 'loader', 'avatar',
    'arrow', 'chevron', 'close', 'search', 'cart',
    'footer', 'header', 'nav', 'menu', 'badge',
    'wp-content/themes', 'wp-includes',
  ];

  if (excludePatterns.some(p => lower.includes(p))) return false;

  return true;
}

/**
 * Fuzzy match score between two normalized names.
 * Returns 0–1 confidence score.
 */
function fuzzyMatchScore(a, b) {
  if (!a || !b) return 0;

  // Exact match
  if (a === b) return 1;

  // Containment check
  if (a.includes(b) || b.includes(a)) return 0.9;

  // Word overlap (Jaccard similarity)
  const wordsA = new Set(a.split(' ').filter(w => w.length >= 2));
  const wordsB = new Set(b.split(' ').filter(w => w.length >= 2));
  const intersection = [...wordsA].filter(w => wordsB.has(w));
  const union = new Set([...wordsA, ...wordsB]);

  if (union.size === 0) return 0;

  const jaccard = intersection.length / union.size;

  // Boost if all words from the shorter set are in the longer set
  const shorter = wordsA.size <= wordsB.size ? wordsA : wordsB;
  const longer = wordsA.size <= wordsB.size ? wordsB : wordsA;
  const allShorterInLonger = [...shorter].every(w => longer.has(w));
  if (allShorterInLonger && shorter.size >= 2) return Math.max(jaccard, 0.85);

  return jaccard;
}

/**
 * Deduplicate image URLs by normalized path (case-insensitive, no query params).
 * Preserves order, keeps the first occurrence.
 */
function deduplicateImages(urls) {
  const seen = new Set();
  const result = [];

  for (const url of urls) {
    const normalized = url.toLowerCase().split('?')[0];
    if (!seen.has(normalized)) {
      seen.add(normalized);
      result.push(url);
    }
  }

  return result;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
