import { upsertMediaAsset, appendLog, addJobError, filterImageUrls } from './base.js';

/**
 * Custom Building Products (CBP) — Image Enrichment Scraper
 *
 * CBP products (thinset, grout, membranes, sealants, etc.) are distributed
 * through Daltile (vendor code 'DAL', collection 'Custom Building Products INC').
 * Products share images at the product-line level (e.g., all "Cbp Redgard" sizes
 * share one image).
 *
 * Strategy:
 *   1. Load DB products without images (vendor 'DAL', collection 'Custom Building Products INC')
 *   2. Group by product line: extract base name from "Cbp {ProductLine} {qty} {unit}" format
 *   3. Fetch product sitemap → extract all product page URLs
 *   4. Fetch each product page → extract image URLs from <img> tags and og:image
 *   5. Match sitemap products to DB product lines by normalized name
 *   6. Save as product-level images (sku_id: null)
 *
 * Website: www.custombuildingproducts.com (WordPress, no bot protection)
 * Sitemap: https://www.custombuildingproducts.com/products-sitemap.xml
 * Product URL pattern: /products/{product-slug}
 * Image URLs: /wp-content/uploads/{YEAR}/{MONTH}/{filename}.png (or .jpg/.webp)
 *
 * No auth required — all pages and images are public.
 */

const SITEMAP_URL = 'https://www.custombuildingproducts.com/products-sitemap.xml';
const SITE_BASE = 'https://www.custombuildingproducts.com';

// Quantity/unit patterns that mark the end of the product line name
// Matches things like "3.5 Gal", "50 Lb", "25 Lb", "1 Gal", "10sf Roll", "1 Qt"
const QTY_UNIT_REGEX = /\s+\d+(?:\.\d+)?\s*(?:gal|lb|lbs|qt|oz|sf|sqft|roll|pk|ct|ea|tube|bag|pail|bucket|kit|pt|fl)\b.*$/i;

// Additional trailing patterns to strip (sizes like "10sf", standalone numbers)
const TRAILING_SIZE_REGEX = /\s+\d+(?:\.\d+)?\s*$/;

export async function run(pool, job, source) {
  await appendLog(pool, job.id, 'Starting CBP image enrichment scraper');

  // Step 1: Load products without images
  const products = await loadCbpProducts(pool);
  await appendLog(pool, job.id, `Found ${products.length} CBP products without images`);

  if (products.length === 0) {
    await appendLog(pool, job.id, 'No CBP products need images — done');
    return;
  }

  // Step 2: Group products by product line
  const lineGroups = groupByProductLine(products);
  await appendLog(pool, job.id, `Grouped into ${lineGroups.size} distinct product lines`);

  // Step 3: Fetch product sitemap → extract product page URLs
  let sitemapUrls;
  try {
    sitemapUrls = await fetchProductSitemap();
    await appendLog(pool, job.id, `Fetched sitemap with ${sitemapUrls.length} product URLs`);
  } catch (err) {
    await addJobError(pool, job.id, `Failed to fetch sitemap: ${err.message}`);
    return;
  }

  // Step 4: Build sitemap slug-to-URL mapping and match to DB product lines
  const sitemapMap = buildSitemapMap(sitemapUrls);
  await appendLog(pool, job.id, `Parsed ${sitemapMap.size} product slugs from sitemap`);

  // Step 5: For each product line, find best sitemap match, fetch page, extract images
  let stats = { linesSearched: 0, linesMatched: 0, productsMatched: 0, imagesSet: 0, errors: 0 };

  for (const [lineName, prods] of lineGroups) {
    try {
      const result = await processProductLine(pool, lineName, prods, sitemapMap);
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

    // Polite delay between page fetches
    await delay(300);
  }

  await appendLog(pool, job.id,
    `Complete. Lines searched: ${stats.linesSearched}, Lines with images: ${stats.linesMatched}, ` +
    `Products matched: ${stats.productsMatched}, Images saved: ${stats.imagesSet}, ` +
    `Errors: ${stats.errors}`,
    { products_found: products.length, products_updated: stats.productsMatched }
  );
}

// ─── DB Loading ──────────────────────────────────────────────────────────────

async function loadCbpProducts(pool) {
  const result = await pool.query(`
    SELECT DISTINCT ON (p.id)
      p.id AS product_id, p.name, p.collection
    FROM products p
    JOIN vendors v ON v.id = p.vendor_id
    LEFT JOIN media_assets ma ON ma.product_id = p.id
    WHERE v.code = 'DAL'
      AND p.collection = 'Custom Building Products INC'
      AND ma.id IS NULL
    ORDER BY p.id
  `);
  return result.rows;
}

// ─── Product Line Grouping ───────────────────────────────────────────────────

/**
 * Extract product line name from our DB product name.
 *
 * Our format: "Cbp {ProductLine} {qty} {unit}"
 * Examples:
 *   "Cbp Acrylpro 3.5 Gal"                       → "Acrylpro"
 *   "Cbp Aqua Mix Grout & Tile Cleaner 1 Gal"     → "Aqua Mix Grout Tile Cleaner"
 *   "Cbp Redgard 3.5 Gal"                         → "Redgard"
 *   "Cbp Versabond 50 Lb"                         → "Versabond"
 *   "Cbp Polyblend Plus 25 Lb"                    → "Polyblend Plus"
 *   "Cbp Simplemat 10sf Roll"                     → "Simplemat"
 *   "Cbp Levelquik Rs 50 Lb"                      → "Levelquik Rs"
 */
function extractProductLine(name) {
  if (!name) return null;

  // Strip "Cbp " prefix (case-insensitive)
  let rest = name.replace(/^Cbp\s+/i, '').trim();
  if (!rest) return null;

  // Strip quantity + unit suffix (e.g., "3.5 Gal", "50 Lb", "10sf Roll")
  rest = rest.replace(QTY_UNIT_REGEX, '').trim();

  // Strip any trailing standalone numbers left over
  rest = rest.replace(TRAILING_SIZE_REGEX, '').trim();

  // Strip "&" symbol for cleaner matching
  rest = rest.replace(/&/g, '').replace(/\s+/g, ' ').trim();

  return rest || null;
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
  const resp = await fetch(SITEMAP_URL, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'application/xml, text/xml',
    },
    signal: AbortSignal.timeout(30000),
  });

  if (!resp.ok) throw new Error(`Sitemap HTTP ${resp.status}`);
  const xml = await resp.text();

  // Extract all <loc> URLs
  const urls = [];
  for (const m of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) {
    const url = m[1].trim();
    // Only keep product page URLs (under /products/ path)
    if (url.includes('/products/') && url !== `${SITE_BASE}/products/`) {
      urls.push(url);
    }
  }

  return urls;
}

/**
 * Build a mapping of normalized slug words to sitemap URLs.
 * Each entry maps a set of normalized words to the product URL.
 *
 * URL pattern: /products/{product-slug}
 * Example: /products/acrylpro-professional-tile-adhesive/ → ["acrylpro", "professional", "tile", "adhesive"]
 */
function buildSitemapMap(sitemapUrls) {
  const map = new Map(); // normalized key → { url, slug, words }

  for (const url of sitemapUrls) {
    // Extract slug from URL path: /products/{slug}/
    const pathMatch = url.match(/\/products\/([^/?#]+)/);
    if (!pathMatch) continue;

    const slug = pathMatch[1].replace(/\/$/, '');
    // Normalize: split on hyphens, lowercase
    const words = slug.toLowerCase().split('-').filter(w => w.length > 0);
    const key = words.join(' ');

    map.set(key, { url, slug, words });
  }

  return map;
}

// ─── Name Matching ───────────────────────────────────────────────────────────

/**
 * Normalize a name to lowercase words for matching.
 * Strips punctuation, collapses whitespace.
 */
function normalizeForMatch(name) {
  return name.toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(w => w.length > 0);
}

/**
 * Find the best matching sitemap entry for a given product line name.
 * Uses word overlap scoring — the sitemap entry whose slug contains the
 * most words from the product line name (and vice versa) wins.
 *
 * Returns { url, score } or null if no match found.
 */
function findBestMatch(lineName, sitemapMap) {
  const lineWords = normalizeForMatch(lineName);
  if (lineWords.length === 0) return null;

  let bestUrl = null;
  let bestScore = 0;

  for (const [, entry] of sitemapMap) {
    const slugWords = entry.words;

    // Count how many line words appear in the slug
    const lineInSlug = lineWords.filter(w => slugWords.some(sw => sw.includes(w) || w.includes(sw))).length;

    // Require at least one significant word match
    if (lineInSlug === 0) continue;

    // Score: fraction of line words found in slug, weighted by coverage
    // Prioritize matches where all line words are present
    const coverage = lineInSlug / lineWords.length;

    // Bonus for exact word matches (not just substring containment)
    const exactMatches = lineWords.filter(w => slugWords.includes(w)).length;
    const exactBonus = exactMatches / lineWords.length * 0.2;

    // Penalty for slug being much longer (less specific match)
    const lengthPenalty = Math.max(0, (slugWords.length - lineWords.length - 3)) * 0.05;

    const score = coverage + exactBonus - lengthPenalty;

    if (score > bestScore) {
      bestScore = score;
      bestUrl = entry.url;
    }
  }

  // Require a minimum score to avoid false positives
  if (bestScore < 0.5) return null;

  return { url: bestUrl, score: bestScore };
}

// ─── Page Scraping ───────────────────────────────────────────────────────────

/**
 * Process a single product line: find matching URL, fetch page, extract images, save.
 */
async function processProductLine(pool, lineName, products, sitemapMap) {
  // Find best matching sitemap URL
  const match = findBestMatch(lineName, sitemapMap);

  if (!match) {
    return { matched: false, productsMatched: 0, imagesSet: 0 };
  }

  // Fetch the product page
  const resp = await fetch(match.url, {
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

  // Filter through base.js guardrails (strips junk, dedupes WP thumbnails)
  const filtered = filterImageUrls(images, { maxImages: 6 });

  if (filtered.length === 0) {
    return { matched: false, productsMatched: 0, imagesSet: 0 };
  }

  // Save images for all products in this line (product-level, sku_id = null)
  let imagesSet = 0;
  for (const prod of products) {
    for (let i = 0; i < filtered.length; i++) {
      const assetType = i === 0 ? 'primary' : (i <= 2 ? 'alternate' : 'lifestyle');
      await upsertMediaAsset(pool, {
        product_id: prod.product_id,
        sku_id: null,
        asset_type: assetType,
        url: filtered[i],
        original_url: filtered[i],
        sort_order: i,
      });
      imagesSet++;
    }
  }

  return { matched: true, productsMatched: products.length, imagesSet };
}

/**
 * Extract product image URLs from page HTML using regex (no DOM parser needed).
 * Looks for og:image, JSON-LD, and <img> tags pointing to wp-content/uploads.
 */
function extractImagesFromPage(html) {
  const images = [];
  const seen = new Set();

  function addImage(url) {
    if (!url || typeof url !== 'string') return;
    // Ensure absolute URL
    if (url.startsWith('//')) url = 'https:' + url;
    if (url.startsWith('/')) url = SITE_BASE + url;
    if (!url.startsWith('http')) return;

    // Only keep wp-content/uploads images (actual product photos)
    if (!url.includes('/wp-content/uploads/')) return;

    // Strip WP thumbnail suffixes for dedup comparison
    const normalized = url.toLowerCase().replace(/-\d+x\d+(\.[a-z]+)$/, '$1').split('?')[0];
    if (seen.has(normalized)) return;
    seen.add(normalized);

    // Keep full-size version (strip thumbnail suffix from actual URL)
    const fullSize = url.replace(/-\d+x\d+(\.[a-zA-Z]+)(\?|$)/, '$1$2');
    images.push(fullSize);
  }

  // Method 1: og:image meta tag (highest priority — usually the hero product image)
  const ogMatch = html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:image["']/i);
  if (ogMatch) {
    addImage(ogMatch[1]);
  }

  // Method 2: JSON-LD structured data
  const jsonLdBlocks = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const block of jsonLdBlocks) {
    const content = block.replace(/<script[^>]*>|<\/script>/gi, '').trim();
    try {
      const data = JSON.parse(content);
      extractJsonLdImages(data, addImage);
    } catch { /* skip invalid JSON */ }
  }

  // Method 3: <img> tags with wp-content/uploads URLs
  const imgRegex = /<img[^>]+(?:src|data-src|data-lazy-src)=["']([^"']*\/wp-content\/uploads\/[^"']+)["']/gi;
  let imgMatch;
  while ((imgMatch = imgRegex.exec(html)) !== null) {
    addImage(imgMatch[1]);
  }

  // Method 4: srcset attributes containing wp-content/uploads URLs
  const srcsetRegex = /srcset=["']([^"']+)["']/gi;
  let srcsetMatch;
  while ((srcsetMatch = srcsetRegex.exec(html)) !== null) {
    const urls = srcsetMatch[1].split(',').map(s => s.trim().split(/\s+/)[0]);
    for (const u of urls) {
      if (u.includes('/wp-content/uploads/')) {
        addImage(u);
      }
    }
  }

  // Method 5: Gallery/lightbox links to full-size images
  const linkRegex = /<a[^>]+href=["']([^"']*\/wp-content\/uploads\/[^"']+)["']/gi;
  let linkMatch;
  while ((linkMatch = linkRegex.exec(html)) !== null) {
    const href = linkMatch[1];
    if (!href.match(/\.(pdf|svg|mp4|webm)(\?|$)/i)) {
      addImage(href);
    }
  }

  return images;
}

/**
 * Recursively extract image URLs from JSON-LD structured data.
 */
function extractJsonLdImages(data, addImage) {
  if (!data) return;

  if (Array.isArray(data)) {
    for (const item of data) extractJsonLdImages(item, addImage);
    return;
  }

  // Product/Thing with image property
  if (data.image) {
    const imgList = Array.isArray(data.image) ? data.image : [data.image];
    for (const img of imgList) {
      const url = typeof img === 'string' ? img : img?.url;
      if (url) addImage(url);
    }
  }

  // Recurse into @graph
  if (data['@graph']) {
    extractJsonLdImages(data['@graph'], addImage);
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
