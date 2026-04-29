/**
 * MSI Fetch-Based Image Scraper (no Puppeteer)
 *
 * Uses native fetch + HTML parsing to extract images from MSI product pages.
 * Much lighter than Puppeteer — no Chrome process needed.
 *
 * Usage: node backend/scripts/msi-fetch-images.cjs [--dry-run] [--category=porcelain-tile]
 */

const { Pool } = require('pg');

const VENDOR_ID = '550e8400-e29b-41d4-a716-446655440001';
const BASE_URL = 'https://www.msisurfaces.com';
const DRY_RUN = process.argv.includes('--dry-run');
const DEBUG = process.argv.includes('--debug');
const CATEGORY_FILTER = (process.argv.find(a => a.startsWith('--category=')) || '').replace('--category=', '');
const CONCURRENCY = 5; // parallel fetches

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// MSI category pages to crawl
const CATEGORY_PAGES = [
  { path: '/porcelain-tile/', cat: 'porcelain-tile' },
  { path: '/wood-look-tile-and-planks/', cat: 'porcelain-tile' },
  { path: '/large-format-tile/', cat: 'porcelain-tile' },
  { path: '/marble-tile/', cat: 'natural-stone' },
  { path: '/travertine-tile/', cat: 'natural-stone' },
  { path: '/granite-tile/', cat: 'natural-stone' },
  { path: '/quartzite-tile/', cat: 'natural-stone' },
  { path: '/slate-tile/', cat: 'natural-stone' },
  { path: '/sandstone-tile/', cat: 'natural-stone' },
  { path: '/limestone-tile/', cat: 'natural-stone' },
  { path: '/onyx-tile/', cat: 'natural-stone' },
  { path: '/backsplash-tile/subway-tile/', cat: 'mosaic-tile' },
  { path: '/backsplash-tile/glass-tile/', cat: 'mosaic-tile' },
  { path: '/backsplash-tile/mosaic-tile/', cat: 'mosaic-tile' },
  { path: '/backsplash-tile/natural-stone-tile/', cat: 'mosaic-tile' },
  { path: '/backsplash-tile/peel-and-stick-tile/', cat: 'mosaic-tile' },
  { path: '/backsplash-tile/porcelain-tile/', cat: 'mosaic-tile' },
  { path: '/backsplash-tile/marble-tile/', cat: 'mosaic-tile' },
  { path: '/backsplash-tile/travertine-tile/', cat: 'mosaic-tile' },
  { path: '/backsplash-tile/hexagon-tile/', cat: 'mosaic-tile' },
  { path: '/backsplash-tile/marble-look/', cat: 'mosaic-tile' },
  { path: '/backsplash-tile/pattern-tile/', cat: 'mosaic-tile' },
  { path: '/backsplash-tile/encaustic-tile/', cat: 'mosaic-tile' },
  { path: '/backsplash-tile/penny-round-tile/', cat: 'mosaic-tile' },
  { path: '/backsplash-tile/picket-tile/', cat: 'mosaic-tile' },
  { path: '/backsplash-tile/herringbone-tile/', cat: 'mosaic-tile' },
  { path: '/backsplash-tile/3d-tile/', cat: 'mosaic-tile' },
  { path: '/mosaics/collections-mosaics/', cat: 'mosaic-tile' },
  { path: '/luxury-vinyl-flooring/', cat: 'lvp-plank' },
  { path: '/waterproof-hybrid-rigid-core/', cat: 'lvp-plank' },
  { path: '/w-luxury-genuine-hardwood/', cat: 'engineered-hardwood' },
  { path: '/waterproof-wood-flooring/woodhills/', cat: 'waterproof-wood' },
  { path: '/hardscape/rockmount-stacked-stone/', cat: 'stacked-stone' },
];

const delay = (ms) => new Promise(r => setTimeout(r, ms));

function slugify(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[®™©]+/g, '')
    .replace(/[''`]/g, '')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

// Reject marketing/promotional/ad images
function isMarketingImage(url) {
  const lower = url.toLowerCase();
  if (/\/(soundproofing|aesthetic|versatile|waterproof-icon|scratch|stain-resist|pet-?proof|click-?lock|acclimation|installation-guide|warranty|certification|greenguard|floorscore|quality|durability|benefits?|features?|comparison|why-choose|how-to|faq|flyer|brochure|infographic|banner|promo|advertisement|sale|discount|free-?sample|hero-?image)\b/i.test(lower)) return true;
  if (/\/(icon|badge|logo|seal|stamp|cert|award|sprite|nav-|btn-|button|arrow|check-?mark|star-?rating)\b/i.test(lower)) return true;
  if (/\/images\/(misc|miscellaneous|flyers|brochures|banners|marketing|ads|promos|downloads|catalogs|catalogues|svg|trends|home)\//i.test(lower)) return true;
  if (/\/flooring\/w-/i.test(lower)) return true;
  if (/\/(backsplash-redesign|stacked-stone-installation|installation-instructions|videos|slider|popup|new-branding)\//i.test(lower)) return true;
  if (/expansive-selection|subway-mosaics|inspiration-gallery/i.test(lower)) return true;
  if (/\.(svg|mp4|webm)(\?|$)/i.test(lower)) return true;
  return false;
}

// Check if URL is from a known product-photo CDN directory
function isProductPhotoUrl(url) {
  const lower = url.toLowerCase();
  return /\/(lvt|porcelainceramic|mosaics|hardscaping|hardwood|naturalstone|stackedstone|colornames|backsplash|wallpanels)\//i.test(lower)
    && !isMarketingImage(url);
}

// ─── Fetch helpers ──────────────────────────────────────────────────────────

async function fetchHtml(url, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const resp = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept': 'text/html' },
        redirect: 'follow',
        signal: AbortSignal.timeout(15000),
      });
      if (!resp.ok) return null;
      return await resp.text();
    } catch (e) {
      if (i === retries) return null;
      await delay(1000);
    }
  }
  return null;
}

// ─── Phase 1: Load DB products missing images ─────────────────────────────────

async function loadMissingProducts() {
  const { rows } = await pool.query(`
    SELECT DISTINCT p.id AS product_id, p.name, p.collection, c.slug AS category,
      array_agg(DISTINCT s.id) AS sku_ids,
      array_agg(DISTINCT s.vendor_sku) AS vendor_skus
    FROM products p
    JOIN skus s ON s.product_id = p.id
    LEFT JOIN categories c ON c.id = p.category_id
    WHERE p.vendor_id = $1 AND s.status = 'active'
      AND NOT EXISTS (SELECT 1 FROM media_assets ma WHERE ma.sku_id = s.id)
    GROUP BY p.id, p.name, p.collection, c.slug
    ORDER BY c.slug, p.collection, p.name
  `, [VENDOR_ID]);
  return rows;
}

// Clean product name by removing dimension suffixes, prefixes, and noise
function cleanProductName(name) {
  return (name || '')
    .replace(/^[-–—\s]+/, '')                                  // leading dashes/spaces
    .replace(/\s*\d+\.?\d*\s*x\s*\d+\.?\d*\s*/gi, ' ')       // dimensions like 8.98x48.03
    .replace(/\s*[-–]\s*\d+\s*m+\b/gi, '')                     // -9mm, -12mm, -12m
    .replace(/\s*[-–]\s*\d+\s*mil\b/gi, '')                   // -30mil, -22mil
    .replace(/\s*[-–]\s*ac\b.*/i, '')                          // -Ac suffix
    .replace(/\s*[-–]\s*\d+\s*$/i, '')                         // trailing " - 12"
    .replace(/[-–]+\s*$/, '')                                  // trailing dashes
    .replace(/\s+/g, ' ')
    .trim();
}

function buildNameIndex(products) {
  const index = new Map();

  function addToIndex(slug, product) {
    if (!slug || slug.length < 2) return;
    if (!index.has(slug)) index.set(slug, []);
    // Avoid duplicates
    const arr = index.get(slug);
    if (!arr.find(p => p.product_id === product.product_id)) arr.push(product);
  }

  for (const p of products) {
    const rawName = p.name;
    const nameSlug = slugify(rawName);
    addToIndex(nameSlug, p);

    // collection + name
    if (p.collection) {
      addToIndex(slugify(p.collection + ' ' + rawName), p);
    }

    // Clean name (strip dimensions, dashes, etc.)
    const cleaned = cleanProductName(rawName);
    const cleanedSlug = slugify(cleaned);
    if (cleanedSlug && cleanedSlug !== nameSlug) addToIndex(cleanedSlug, p);

    // Strip common prefixes: "2.0", "Reserve", "Res.", "Plus", "Parc", "Parc Res.-"
    const prefixStripped = cleaned
      .replace(/^(2\.?0|xl|xxl|reserve|res\.?|plus|parc\s*res\.?[-–]?|parc[-–]?)\s*/i, '')
      .trim();
    const prefixSlug = slugify(prefixStripped);
    if (prefixSlug && prefixSlug !== cleanedSlug) addToIndex(prefixSlug, p);

    // Double-strip: "Parc - Andaz 8.98x60-10mm-22mil" → "Andaz"
    const doubleStripped = prefixStripped
      .replace(/^(2\.?0|xl|xxl|reserve|res\.?|plus|parc\s*res\.?[-–]?|parc[-–]?)\s*/i, '')
      .trim();
    const doubleSlug = slugify(doubleStripped);
    if (doubleSlug && doubleSlug !== prefixSlug) addToIndex(doubleSlug, p);

    // Also index individual words that are long enough to be unique color names
    // Exclude common words that cause false matches
    const COMMON_WORDS = new Set(['white', 'black', 'brown', 'beige', 'cream', 'ivory', 'natural', 'golden', 'silver', 'light', 'stone', 'marble', 'panel', 'blend', 'mosaic', 'matte', 'polished', 'honed', 'tumbled', 'stacked', 'linear', 'round', 'square', 'brick', 'herringbone', 'pattern', 'classic', 'modern', 'premier', 'premier', 'reserve', 'select', 'plus', 'rigid', 'core', 'vinyl', 'plank', 'tile', 'floor', 'wood', 'slat', 'blonde', 'tawny', 'ebony', 'walnut', 'smoke', 'frost', 'blush', 'slate', 'onyx', 'cedar', 'amber', 'ivory', 'sahara', 'drift', 'cloud']);
    const words = prefixStripped.split(/\s+/);
    if (words.length >= 2) {
      for (const word of words) {
        const ws = slugify(word);
        if (ws && ws.length >= 7 && !COMMON_WORDS.has(ws)) addToIndex(ws, p);
      }
    }

    // Index collection + cleaned color name (for sub-product matching)
    if (p.collection && prefixSlug) {
      addToIndex(slugify(p.collection + ' ' + prefixStripped), p);
    }
  }
  return index;
}

// ─── Phase 2: Crawl category pages (HTML-based) ────────────────────────────

function extractLinksFromHtml(html, baseUrl) {
  const results = [];
  const seen = new Set();

  // Skip patterns: navigation, utility, informational pages
  const SKIP_PATTERNS = /\/(site-search|shoppingcart|cart|account|contact|careers|vendor|inspiration|resources|design-tools|for-the-trade|dealer|blog|about|news|corporate|slabinventory|new-products)\b/i;
  const SKIP_SUFFIXES = /\/(all|videos|gallery|color-trends|benefits|installation|costs?|comparison|guide|pros-and-cons|where-to-buy|accessories|care-and-maintenance|downloads|custom-program|faq|sun-washed|definitive|vinyl-flooring-or-lvt|lvt-vs-lvp|everlife|best-practices|instructions)\/?$/i;

  // Match all <a href="..."> that point to MSI product pages
  const linkRegex = /<a[^>]+href=["']([^"']+)["'][^>]*>/gi;
  let match;
  while ((match = linkRegex.exec(html)) !== null) {
    let href = match[1];
    if (href.startsWith('//')) href = 'https:' + href;
    if (href.startsWith('/')) href = baseUrl + href;
    if (!href.includes('msisurfaces.com')) continue;

    // Extract pathname
    const pathMatch = href.match(/msisurfaces\.com(\/[^?#"']*)/);
    if (!pathMatch) continue;
    const path = pathMatch[1].replace(/\/+$/, '/'); // normalize trailing slash
    const segments = path.split('/').filter(Boolean);
    if (segments.length < 2) continue;
    if (SKIP_PATTERNS.test(path)) continue;
    if (SKIP_SUFFIXES.test(path)) continue;
    // Skip image/css/js file URLs
    if (/\.(jpg|jpeg|png|gif|svg|css|js|pdf|aspx)(\?|$)/i.test(path)) continue;

    const fullUrl = 'https://www.msisurfaces.com/' + segments.join('/') + '/';
    if (seen.has(fullUrl)) continue;
    seen.add(fullUrl);
    results.push(fullUrl);
  }
  return results;
}

async function crawlCategoryPage(categoryPath, log) {
  const url = BASE_URL + categoryPath;
  const html = await fetchHtml(url);
  if (!html) {
    if (log) log(`    WARN: Empty response for ${categoryPath}`);
    return [];
  }
  if (log && DEBUG) log(`    HTML size: ${html.length} bytes`);
  return extractLinksFromHtml(html, BASE_URL);
}

// ─── Phase 3: Extract images from product page HTML ────���───────────────────

function extractProductData(html, pageUrl) {
  const images = [];
  const seen = new Set();

  function addImg(src) {
    if (!src) return;
    if (!src.includes('cdn.msisurfaces.com')) return;
    if (/\.(svg|gif|ico|mp4|webm)(\?|$)/i.test(src)) return;
    if (/icon|logo|badge|placeholder|miscellaneous|flyers|brochures|roomvo|wetcutting|trends|new-branding/i.test(src)) return;
    // Clean up URL
    src = src.replace(/&amp;/g, '&').trim();
    if (seen.has(src)) return;
    seen.add(src);
    // Only keep images from known product-photo CDN directories
    if (isProductPhotoUrl(src)) images.push(src);
  }

  // 1. og:image
  const ogMatch = html.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i);
  if (ogMatch) addImg(ogMatch[1]);

  // 2. JSON-LD image data
  const ldRegex = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let ldMatch;
  while ((ldMatch = ldRegex.exec(html)) !== null) {
    try {
      const d = JSON.parse(ldMatch[1]);
      const imgs = d.image ? (Array.isArray(d.image) ? d.image : [d.image]) : [];
      imgs.forEach(addImg);
      if (d['@graph']) {
        d['@graph'].forEach(item => {
          const gi = item.image ? (Array.isArray(item.image) ? item.image : [item.image]) : [];
          gi.forEach(addImg);
        });
      }
    } catch {}
  }

  // 3. All img tags with cdn.msisurfaces.com
  const imgRegex = /<img[^>]+(?:src|data-src|data-lazy|data-original)=["']([^"']*cdn\.msisurfaces\.com[^"']*)["']/gi;
  let imgMatch;
  while ((imgMatch = imgRegex.exec(html)) !== null) {
    addImg(imgMatch[1]);
  }

  // Also check for image URLs in data attributes and inline styles
  const cdnUrlRegex = /https?:\/\/cdn\.msisurfaces\.com\/[^"'\s<>]+\.(jpg|jpeg|png|webp)/gi;
  let cdnMatch;
  while ((cdnMatch = cdnUrlRegex.exec(html)) !== null) {
    addImg(cdnMatch[0]);
  }

  // Extract product name from <h1>
  const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  let productName = '';
  if (h1Match) {
    productName = h1Match[1]
      .replace(/<[^>]+>/g, '') // strip HTML tags
      .replace(/[®™©]/g, '')
      .replace(/\s+(Porcelain|Ceramic|Marble|Granite|Travertine|Quartzite|Limestone|Slate|Sandstone|Onyx)\s*(Tiles?|Flooring|Planks?)?\s*$/i, '')
      .replace(/\s+(Luxury Vinyl|Vinyl Flooring|Vinyl Planks?|Vinyl Tiles?|LVP|LVT|SPC)\s*$/i, '')
      .replace(/\s+(Engineered Hardwood|Hardwood Flooring|Hardwood)\s*$/i, '')
      .replace(/\s+(Hybrid Rigid Core|Waterproof Flooring)\s*$/i, '')
      .replace(/\s+(Stacked Stone|Ledger Panel|Stacked Stone Panels?)\s*$/i, '')
      .replace(/\s+(Collection|Series)\s*$/i, '')
      .replace(/\s+(Tiles?|Planks?|Flooring)\s*$/i, '')
      .trim();
  }

  // Extract sub-product links (collection pages link to individual color pages)
  // Look for links that are deeper than the current URL path
  const subProducts = [];
  const currentPath = (() => {
    const m = pageUrl.match(/msisurfaces\.com(\/[^?#]*)/);
    return m ? m[1] : '';
  })();
  const currentSegments = currentPath.split('/').filter(Boolean);

  // Find links that are children of the current page (deeper path)
  const subLinkRegex = /<a[^>]+href=["'](\/[^"']+|https?:\/\/www\.msisurfaces\.com\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const subSeen = new Set();
  let subMatch;
  while ((subMatch = subLinkRegex.exec(html)) !== null) {
    try {
      let href = subMatch[1];
      const linkText = subMatch[2].replace(/<[^>]+>/g, '').replace(/[®™��]/g, '').replace(/\s+/g, ' ').trim();

      if (href.startsWith('/')) href = BASE_URL + href;
      if (!href.includes('msisurfaces.com')) continue;

      const pathM = href.match(/msisurfaces\.com(\/[^?#"']*)/);
      if (!pathM) continue;
      const path = pathM[1];
      const segments = path.split('/').filter(Boolean);

      // Sub-products should be deeper path (more segments) or at least 3 segments
      if (segments.length < 3) continue;
      if (segments.length <= currentSegments.length) continue;

      // Skip navigation/utility links
      const colorSlug = segments[segments.length - 1];
      if (/site-search|cart|account|contact|filter|sort|page|resources|design-tools|for-the-trade|dealer|blog|about|faq/i.test(colorSlug)) continue;

      const fullUrl = 'https://www.msisurfaces.com' + path;
      if (subSeen.has(fullUrl)) continue;
      subSeen.add(fullUrl);

      // Look for an img in this <a> tag content
      const imgInLink = subMatch[0].match(/src=["']([^"']*cdn\.msisurfaces\.com[^"']*)["']/i);

      subProducts.push({
        href: fullUrl,
        colorSlug,
        colorName: linkText.substring(0, 80),
        imageUrl: imgInLink ? imgInLink[1] : '',
      });
    } catch {}
  }

  // Extract SIZES section — per-SKU images with ID codes
  const sizesInfo = [];
  const sizeRegex = /ID#?\s*([A-Z0-9\-\/\.]+)/gi;
  let sizeMatch;
  while ((sizeMatch = sizeRegex.exec(html)) !== null) {
    sizesInfo.push({ code: sizeMatch[1].trim(), imageUrl: '' });
  }

  return {
    productName,
    images: images.filter(url => !isMarketingImage(url)).slice(0, 8),
    subProducts,
    sizesInfo,
    url: pageUrl,
  };
}

// ─── Matching & Saving ────────────────────────────────────────────────────────

function cleanSubProductName(rawName, collectionName) {
  let name = (rawName || '')
    .replace(/[®™©]+/g, '')
    .replace(/\bSEE THIS IN MY SPACE\b/gi, '')
    .trim();
  if (collectionName) {
    const coll = collectionName.replace(/[®™©]/g, '').trim();
    const collUpper = coll.toUpperCase();
    const nameUpper = name.toUpperCase();
    if (nameUpper.startsWith(collUpper + ' ')) {
      name = name.slice(coll.length).trim();
    } else if (nameUpper.startsWith(collUpper)) {
      name = name.slice(coll.length).trim();
    }
  }
  name = name.replace(/\w\S*/g, w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
  return name.trim();
}

function matchProduct(nameIndex, scrapedName, scrapedCollection) {
  let name = (scrapedName || '').replace(/[®™©]/g, '').replace(/\bTM\b/g, '').trim();
  const slug = slugify(name);
  if (nameIndex.has(slug)) return nameIndex.get(slug);

  const words = name.split(/\s+/);
  for (let i = 1; i < words.length; i++) {
    const tail = slugify(words.slice(i).join(' '));
    if (tail && nameIndex.has(tail)) return nameIndex.get(tail);
  }

  if (scrapedCollection) {
    const collSlug = slugify(scrapedCollection);
    const stripped = slug.replace(new RegExp('^' + collSlug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '-?'), '');
    if (stripped && nameIndex.has(stripped)) return nameIndex.get(stripped);
  }

  const noVersion = slug.replace(/^(\d+-?\d*-)/g, '').replace(/^(xl-|xxl-)/g, '');
  if (noVersion && noVersion !== slug && nameIndex.has(noVersion)) return nameIndex.get(noVersion);

  const stripped2 = slug
    .replace(/-?(2-0|xl|xxl)$/g, '')
    .replace(/-?(porcelain|ceramic|vinyl|flooring|tile|plank|marble|granite|travertine|limestone|quartzite|sandstone|slate|onyx)$/g, '');
  if (stripped2 && stripped2 !== slug && nameIndex.has(stripped2)) return nameIndex.get(stripped2);

  if (words.length >= 2) {
    const lastWord = slugify(words[words.length - 1]);
    if (lastWord && lastWord.length >= 4 && nameIndex.has(lastWord)) return nameIndex.get(lastWord);
    const lastTwo = slugify(words.slice(-2).join(' '));
    if (lastTwo && nameIndex.has(lastTwo)) return nameIndex.get(lastTwo);
  }

  for (const [key, products] of nameIndex) {
    if (key.length >= 4 && (key.startsWith(slug + '-') || slug.startsWith(key + '-'))) {
      return products;
    }
  }
  return null;
}

async function saveImage(productId, skuId, url, assetType, sortOrder) {
  if (DRY_RUN) return;
  await pool.query(`
    INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order, created_at)
    VALUES ($1, $2, $3, $4, $4, $5, NOW())
    ON CONFLICT DO NOTHING
  `, [productId, skuId, assetType, url, sortOrder]);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const startTime = Date.now();
  const log = (msg) => {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[${elapsed}s] ${msg}`);
  };

  log('MSI Fetch-Based Image Scraper');
  log('═'.repeat(60));
  if (DRY_RUN) log('DRY RUN — no DB writes');

  // Phase 1: Load missing products
  log('Phase 1: Loading products missing images...');
  const missingProducts = await loadMissingProducts();
  log(`  ${missingProducts.length} products missing images`);

  if (missingProducts.length === 0) {
    log('Nothing to do!');
    await pool.end();
    return;
  }

  const nameIndex = buildNameIndex(missingProducts);
  log(`  Name index: ${nameIndex.size} entries`);

  const skuCodeIndex = new Map();
  for (const p of missingProducts) {
    for (const vsku of p.vendor_skus) {
      skuCodeIndex.set(vsku.toUpperCase(), p);
      skuCodeIndex.set('MSI-' + vsku.toUpperCase(), p);
    }
  }

  let categories = CATEGORY_PAGES;
  if (CATEGORY_FILTER) {
    categories = categories.filter(c => c.cat === CATEGORY_FILTER);
    log(`  Filtered to ${categories.length} category pages for: ${CATEGORY_FILTER}`);
  }

  // Phase 2: Crawl category pages
  log('');
  log('Phase 2: Crawling MSI category pages...');
  const allProductUrls = new Map();
  for (const { path, cat } of categories) {
    log(`  Crawling ${path}...`);
    try {
      const urls = await crawlCategoryPage(path, log);
      let newCount = 0;
      for (const u of urls) {
        if (!allProductUrls.has(u)) {
          allProductUrls.set(u, cat);
          newCount++;
        }
      }
      log(`    Found ${urls.length} links (${newCount} new)`);
    } catch (e) {
      log(`    WARN: Failed: ${e.message}`);
    }
    await delay(800); // longer delay to avoid rate limiting
  }
  log(`  Total unique product URLs: ${allProductUrls.size}`);

  // Phase 3: Visit product pages and extract images
  log('');
  log('Phase 3: Extracting images from product pages...');

  let visited = 0, matched = 0, imagesAdded = 0;
  const total = allProductUrls.size;
  const matchedProducts = new Set();

  const { rows: alreadyImaged } = await pool.query(`
    SELECT DISTINCT p.id FROM products p
    JOIN skus s ON s.product_id = p.id
    JOIN media_assets ma ON ma.sku_id = s.id
    WHERE p.vendor_id = $1
  `, [VENDOR_ID]);
  const alreadyImagedSet = new Set(alreadyImaged.map(r => r.id));

  const saveProductImages = async (product, imageUrls) => {
    if (matchedProducts.has(product.product_id)) return false;
    if (alreadyImagedSet.has(product.product_id)) return false;
    if (!imageUrls || imageUrls.length === 0) return false;
    matchedProducts.add(product.product_id);

    const sortedImages = [...imageUrls].map(url => {
      const u = url.replace('/thumbnails/', '/detail/');
      let pri = 20;
      if (/\/thumbnails\//i.test(url)) pri = 100;
      if (/\/iso\//i.test(url)) pri = 70;
      if (/\/edge\//i.test(url)) pri = 80;
      if (/roomscen/i.test(url)) pri = 90;
      if (/\/lvt\/detail\//i.test(u)) pri = 5;
      else if (/\/porcelainceramic\//i.test(u) && !/\/thumbnails\//.test(u)) pri = 5;
      else if (/\/mosaics\//i.test(u) && !/\/thumbnails\//.test(u)) pri = 5;
      else if (/\/hardscaping\/detail\//i.test(u)) pri = 5;
      else if (/\/colornames\//i.test(u) && product.category && /lvp|vinyl/i.test(product.category)) pri = 60;
      else if (/\/colornames\//i.test(u)) pri = 10;
      return { url: u, pri };
    }).sort((a, b) => a.pri - b.pri).slice(0, 4);

    for (const skuId of product.sku_ids) {
      let sortOrder = 0;
      for (const img of sortedImages) {
        const assetType = sortOrder === 0 ? 'primary' : 'alternate';
        await saveImage(product.product_id, skuId, img.url, assetType, sortOrder);
        imagesAdded++;
        sortOrder++;
      }
    }
    return true;
  };

  // Process in batches for concurrency
  const urls = [...allProductUrls.entries()];

  for (let i = 0; i < urls.length; i += CONCURRENCY) {
    const batch = urls.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map(async ([productUrl, cat]) => {
        try {
          const html = await fetchHtml(productUrl);
          if (!html) return null;
          return { productUrl, cat, data: extractProductData(html, productUrl) };
        } catch { return null; }
      })
    );

    for (const result of results) {
      if (!result) { visited++; continue; }
      visited++;
      const { productUrl, cat, data } = result;

      if (data.images.length > 0) {
        const products = matchProduct(nameIndex, data.productName, null);
        if (products && products.length > 0) {
          for (const product of products) {
            if (await saveProductImages(product, data.images)) matched++;
          }
        }
      }

      // Handle collection pages: follow sub-product links
      if (data.subProducts && data.subProducts.length > 0) {
        const uniqueSubs = [];
        const seenHrefs = new Set();
        for (const sub of data.subProducts) {
          if (seenHrefs.has(sub.href)) continue;
          seenHrefs.add(sub.href);
          uniqueSubs.push(sub);
        }

        // Fetch sub-pages in parallel
        const subResults = await Promise.all(
          uniqueSubs.slice(0, 20).map(async (sub) => { // limit to 20 sub-products per page
            try {
              const subHtml = await fetchHtml(sub.href);
              if (!subHtml) return null;
              return { sub, data: extractProductData(subHtml, sub.href) };
            } catch { return null; }
          })
        );

        for (const subResult of subResults) {
          if (!subResult) continue;
          const { sub, data: subData } = subResult;

          // Try multiple matching strategies for sub-products
          const candidates = new Set();

          // 1. Color name from link text
          const colorName = cleanSubProductName(sub.colorName, data.productName);
          if (colorName) candidates.add(slugify(colorName));

          // 2. URL slug (last segment of path)
          if (sub.colorSlug) candidates.add(sub.colorSlug);

          // 3. h1 from the sub-page (most reliable)
          if (subData.productName) {
            candidates.add(slugify(subData.productName));
            // Also try stripping collection from sub-page h1
            const stripped = subData.productName
              .replace(/[®™©]/g, '')
              .replace(/^(2\.?0|xl|xxl|reserve|res\.?|plus|parc\s*res\.?[-–]?|parc[-–]?)\s*/i, '')
              .trim();
            candidates.add(slugify(stripped));
          }

          // 4. Clean variants
          if (colorName) {
            const cleaned = colorName
              .replace(/^(2\.?0|xl|xxl|reserve|res\.?|plus)\s*/i, '')
              .trim();
            candidates.add(slugify(cleaned));
          }

          let subMatch = null;
          for (const slug of candidates) {
            if (!slug) continue;
            subMatch = nameIndex.get(slug);
            if (subMatch) break;
            // Also try matchProduct for fuzzy matching
          }

          // Fallback: use full matchProduct function
          if (!subMatch && subData.productName) {
            subMatch = matchProduct(nameIndex, subData.productName, null);
          }

          if (subMatch && subMatch.length > 0 && subData.images.length > 0) {
            for (const product of subMatch) {
              if (await saveProductImages(product, subData.images)) matched++;
            }
          }
        }
      }
    }

    if (visited % 25 < CONCURRENCY || visited >= total) {
      log(`  Progress: ${visited}/${total} visited, ${matched} matched, ${imagesAdded} images saved`);
    }

    await delay(200); // polite delay between batches
  }

  // Phase 4: Report
  log('');
  log('Phase 4: Coverage report...');

  const { rows: coverage } = await pool.query(`
    SELECT c.slug as category,
      COUNT(DISTINCT s.id) as total_skus,
      COUNT(DISTINCT CASE WHEN ma.id IS NOT NULL THEN s.id END) as with_images
    FROM skus s
    JOIN products p ON s.product_id = p.id
    LEFT JOIN categories c ON c.id = p.category_id
    LEFT JOIN media_assets ma ON ma.sku_id = s.id
    WHERE p.vendor_id = $1 AND s.status = 'active'
    GROUP BY c.slug
    ORDER BY total_skus DESC
  `, [VENDOR_ID]);

  let totalSkus = 0, totalWithImages = 0;
  for (const row of coverage) {
    const pct = row.total_skus > 0 ? Math.round(100 * row.with_images / row.total_skus) : 0;
    const missing = row.total_skus - row.with_images;
    log(`  ${row.category}: ${row.with_images}/${row.total_skus} (${pct}%) — ${missing} missing`);
    totalSkus += parseInt(row.total_skus);
    totalWithImages += parseInt(row.with_images);
  }

  log('');
  log('═'.repeat(60));
  log(`  RESULTS`);
  log(`  Product pages visited: ${visited}`);
  log(`  Products matched:      ${matched}`);
  log(`  Images saved:          ${imagesAdded}`);
  log(`  Total SKUs:            ${totalSkus}`);
  log(`  With images:           ${totalWithImages} (${(100 * totalWithImages / totalSkus).toFixed(1)}%)`);
  log(`  Still missing:         ${totalSkus - totalWithImages}`);
  log(`  Time:                  ${Math.round((Date.now() - startTime) / 1000)}s`);
  log('═'.repeat(60));

  await pool.end();
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
