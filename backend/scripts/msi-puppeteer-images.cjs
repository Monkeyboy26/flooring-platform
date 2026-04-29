/**
 * MSI Puppeteer Image Scraper
 *
 * Crawls MSI category pages → collects product page URLs → extracts images
 * → matches to our DB SKUs → saves per-SKU images.
 *
 * Only targets products that are MISSING images (no media_assets).
 *
 * Usage: node backend/scripts/msi-puppeteer-images.cjs [--dry-run] [--category=porcelain-tile]
 */

const { Pool } = require('pg');
const puppeteer = require('puppeteer');

const VENDOR_ID = '550e8400-e29b-41d4-a716-446655440001';
const BASE_URL = 'https://www.msisurfaces.com';
const DRY_RUN = process.argv.includes('--dry-run');
const CATEGORY_FILTER = (process.argv.find(a => a.startsWith('--category=')) || '').replace('--category=', '');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

// MSI category pages to crawl
const CATEGORY_PAGES = [
  // Porcelain / Ceramic
  { path: '/porcelain-tile/', cat: 'porcelain-tile' },
  { path: '/wood-look-tile-and-planks/', cat: 'porcelain-tile' },
  { path: '/large-format-tile/', cat: 'porcelain-tile' },
  // Natural Stone
  { path: '/marble-tile/', cat: 'natural-stone' },
  { path: '/travertine-tile/', cat: 'natural-stone' },
  { path: '/granite-tile/', cat: 'natural-stone' },
  { path: '/quartzite-tile/', cat: 'natural-stone' },
  { path: '/slate-tile/', cat: 'natural-stone' },
  { path: '/sandstone-tile/', cat: 'natural-stone' },
  { path: '/limestone-tile/', cat: 'natural-stone' },
  { path: '/onyx-tile/', cat: 'natural-stone' },
  // Backsplash / Mosaics
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
  // LVP / Vinyl
  { path: '/luxury-vinyl-flooring/', cat: 'lvp-plank' },
  { path: '/waterproof-hybrid-rigid-core/', cat: 'lvp-plank' },
  // Hardwood
  { path: '/w-luxury-genuine-hardwood/', cat: 'engineered-hardwood' },
  // Waterproof Wood
  { path: '/waterproof-wood-flooring/woodhills/', cat: 'waterproof-wood' },
  // Stacked Stone
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

// Build a name index for matching scraped products to DB products
function buildNameIndex(products) {
  const index = new Map(); // slug → [product]

  for (const p of products) {
    // Index by product name slug
    const nameSlug = slugify(p.name);
    if (nameSlug) {
      if (!index.has(nameSlug)) index.set(nameSlug, []);
      index.get(nameSlug).push(p);
    }

    // Also index by collection + name
    if (p.collection) {
      const fullSlug = slugify(p.collection + ' ' + p.name);
      if (fullSlug && fullSlug !== nameSlug) {
        if (!index.has(fullSlug)) index.set(fullSlug, []);
        index.get(fullSlug).push(p);
      }
    }
  }

  return index;
}

// ─── Phase 2: Crawl category pages ────────────────────────────────────────────

async function crawlCategoryPage(page, categoryPath) {
  const url = BASE_URL + categoryPath;
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
  } catch (e) {
    console.log(`  WARN: Failed to load ${categoryPath}: ${e.message}`);
    return [];
  }

  // Click "Load More" until all products visible
  try {
    let previousCount = 0;
    for (let attempt = 0; attempt < 50; attempt++) {
      const clicked = await page.evaluate(() => {
        const links = Array.from(document.querySelectorAll('a'));
        const btn = links.find(a =>
          a.textContent.trim().toLowerCase().includes('load more') &&
          window.getComputedStyle(a).display !== 'none' &&
          a.offsetParent !== null
        );
        if (btn) { btn.click(); return true; }
        return false;
      }).catch(() => false);
      if (!clicked) break;
      await delay(2500);

      const currentCount = await page.$$eval(
        '.new-filter-collection a[href], .product-listing a[href]',
        els => els.filter(a => a.href && !a.href.includes('javascript:')).length
      ).catch(() => 0);

      if (currentCount <= previousCount) break;
      if (currentCount >= 500) break;
      previousCount = currentCount;
    }
  } catch (e) {
    console.log(`  WARN: Load More loop error on ${categoryPath}: ${e.message}`);
  }

  // Collect product URLs
  try {
    const productUrls = await page.evaluate((baseUrl) => {
      const seen = new Set();
      const results = [];

      function extractPath(href) {
        try { return new URL(href).pathname; }
        catch { /* fallback */ }
        const m = href.match(/msisurfaces\.com(\/[^?#]*)/);
        return m ? m[1] : '';
      }

      function isValidProductUrl(href) {
        if (!href) return false;
        try {
          if (!href.includes('msisurfaces.com')) return false;
          const path = extractPath(href);
          if (path === '/' || path === '') return false;
          const segments = path.split('/').filter(Boolean);
          if (segments.length < 2) return false;
          if (/site-search|cart|account|contact|careers|vendor|inspiration|resources|design-tools|for-the-trade|dealer/i.test(path)) return false;
          return true;
        } catch { return false; }
      }

      // Grid links
      document.querySelectorAll('.new-filter-collection a[href], .product-listing a[href]').forEach(a => {
        try {
          let href = a.href;
          if (href && href.startsWith('/')) href = baseUrl + href;
          if (!isValidProductUrl(href)) return;
          if (seen.has(href)) return;
          seen.add(href);
          results.push(href);
        } catch {}
      });

      // Fallback: broader link search with img children (product tiles)
      if (results.length === 0) {
        document.querySelectorAll('a[href]').forEach(a => {
          try {
            let href = a.href;
            if (href && href.startsWith('/')) href = baseUrl + href;
            if (!isValidProductUrl(href)) return;
            if (seen.has(href)) return;
            const path = extractPath(href);
            const segments = path.split('/').filter(Boolean);
            if (segments.length >= 2 && a.querySelector('img')) {
              seen.add(href);
              results.push(href);
            }
          } catch {}
        });
      }

      return results;
    }, BASE_URL);

    return productUrls;
  } catch (e) {
    console.log(`  WARN: URL collection error on ${categoryPath}: ${e.message}`);
    return [];
  }
}

// Reject marketing/promotional/ad images that are NOT product photos
function isMarketingImage(url) {
  const lower = url.toLowerCase();
  if (/\/(soundproofing|aesthetic|versatile|waterproof-icon|scratch|stain-resist|pet-?proof|click-?lock|acclimation|installation-guide|warranty|certification|greenguard|floorscore|quality|durability|benefits?|features?|comparison|why-choose|how-to|faq|flyer|brochure|infographic|banner|promo|advertisement|sale|discount|free-?sample|hero-?image)\b/i.test(lower)) return true;
  if (/\/(icon|badge|logo|seal|stamp|cert|award|sprite|nav-|btn-|button|arrow|check-?mark|star-?rating)\b/i.test(lower)) return true;
  if (/\/images\/(misc|miscellaneous|flyers|brochures|banners|marketing|ads|promos|downloads|catalogs|catalogues)\//i.test(lower)) return true;
  if (/\/flooring\/w-/i.test(lower)) return true;
  return false;
}

// ─── Phase 3: Extract images from product page ────────────────────────────────

async function extractProductImages(page, productUrl) {
  try {
    await page.goto(productUrl, { waitUntil: 'networkidle2', timeout: 20000 });
  } catch (e) {
    return null;
  }

  // Wait a bit for lazy images
  await delay(1000);

  const data = await page.evaluate(() => {
    // Extract product name from breadcrumb or h1
    const h1 = document.querySelector('h1');
    let productName = h1 ? h1.textContent.trim() : '';

    // Strip material/category suffixes from product name
    productName = productName
      .replace(/[®™©]/g, '')
      .replace(/\s+(Porcelain|Ceramic|Marble|Granite|Travertine|Quartzite|Limestone|Slate|Sandstone|Onyx)\s*(Tiles?|Flooring|Planks?)?\s*$/i, '')
      .replace(/\s+(Luxury Vinyl|Vinyl Flooring|Vinyl Planks?|Vinyl Tiles?|LVP|LVT|SPC)\s*$/i, '')
      .replace(/\s+(Engineered Hardwood|Hardwood Flooring|Hardwood)\s*$/i, '')
      .replace(/\s+(Hybrid Rigid Core|Waterproof Flooring)\s*$/i, '')
      .replace(/\s+(Stacked Stone|Ledger Panel|Stacked Stone Panels?)\s*$/i, '')
      .replace(/\s+(Collection|Series)\s*$/i, '')
      .replace(/\s+(Tiles?|Planks?|Flooring)\s*$/i, '')
      .trim();

    // Extract collection from breadcrumb
    const breadcrumbs = document.querySelectorAll('.breadcrumb a, nav[aria-label="breadcrumb"] a, .breadcrumb-item a');
    let collection = '';
    if (breadcrumbs.length >= 3) {
      collection = breadcrumbs[breadcrumbs.length - 2]?.textContent?.trim() || '';
      collection = collection.replace(/[®™©]/g, '').trim();
    }

    // Collect images
    const images = [];
    const seen = new Set();

    function addImg(src) {
      if (!src) return;
      try {
        const u = new URL(src, window.location.origin);
        const href = u.href;
        if (seen.has(href)) return;
        if (!href.includes('cdn.msisurfaces.com')) return;
        if (/\.(svg|gif|ico)(\?|$)/i.test(href)) return;
        if (/icon|logo|badge|placeholder|miscellaneous|flyers|brochures|roomvo|wetcutting/i.test(href)) return;
        seen.add(href);
        images.push(href);
      } catch {}
    }

    // 1. og:image (most reliable)
    const ogImage = document.querySelector('meta[property="og:image"]');
    if (ogImage) addImg(ogImage.getAttribute('content'));

    // 2. JSON-LD
    document.querySelectorAll('script[type="application/ld+json"]').forEach(script => {
      try {
        const d = JSON.parse(script.textContent);
        const imgs = d.image ? (Array.isArray(d.image) ? d.image : [d.image]) : [];
        imgs.forEach(addImg);
        if (d['@graph']) {
          d['@graph'].forEach(item => {
            const gi = item.image ? (Array.isArray(item.image) ? item.image : [item.image]) : [];
            gi.forEach(addImg);
          });
        }
      } catch {}
    });

    // 3. Gallery / product images
    const selectors = [
      '.product-gallery img',
      '.slick-slide img',
      '.hero-image img',
      '.product-image img',
      '.product-detail img',
      'img[src*="cdn.msisurfaces.com"]',
    ];
    for (const sel of selectors) {
      document.querySelectorAll(sel).forEach(img => {
        addImg(img.src);
        addImg(img.dataset.src);
        addImg(img.dataset.lazy);
        addImg(img.getAttribute('data-original'));
      });
    }

    // 4. Extract SIZES section — per-SKU images with ID codes
    const sizesInfo = [];
    document.querySelectorAll('.size-item, .product-size-item, [class*="size"]').forEach(el => {
      const text = el.textContent || '';
      const idMatch = text.match(/ID#?\s*([A-Z0-9\-\/\.]+)/i);
      const img = el.querySelector('img');
      if (idMatch && img) {
        sizesInfo.push({
          code: idMatch[1].trim(),
          imageUrl: img.src || img.dataset.src || '',
        });
      }
    });

    // 5. Detect sub-product tiles (collection page with individual color links)
    const subProducts = [];
    document.querySelectorAll('.new-filter-collection a[href], .product-listing a[href], a[href]').forEach(a => {
      try {
        const href = a.href;
        if (!href || !href.includes('msisurfaces.com')) return;
        // Extract pathname without URL constructor (may not exist in evaluate context)
        const pathMatch = href.match(/msisurfaces\.com(\/[^?#]*)/);
        const path = pathMatch ? pathMatch[1] : '';
        const segments = path.split('/').filter(Boolean);
        // Collection pages have 3+ segments: /luxury-vinyl-planks/ashton/bergen-hills/
        if (segments.length < 3) return;
        // Must have an img child (product tile) or specific text
        const img = a.querySelector('img');
        const text = (a.textContent || '').trim().replace(/[®™©]/g, '').replace(/\s+/g, ' ');
        if (!img && text.length < 3) return;
        // Extract color name from the last URL segment
        const colorSlug = segments[segments.length - 1];
        if (/site-search|cart|account|contact|filter|sort|page|resources|design-tools|for-the-trade|dealer/i.test(colorSlug)) return;
        // Get image URL if available
        const imgUrl = img ? (img.src || img.dataset?.src || '') : '';
        subProducts.push({
          href,
          colorSlug,
          colorName: text.substring(0, 80),
          imageUrl: imgUrl,
        });
      } catch {}
    });

    return {
      productName,
      collection,
      images: images.slice(0, 8),
      sizesInfo,
      subProducts,
      url: window.location.href,
    };
  });

  return data;
}

// Extract color name from sub-product: "ASHTON™ BERGEN HILLS®®" → "Bergen Hills"
function cleanSubProductName(rawName, collectionName) {
  let name = (rawName || '')
    .replace(/[®™©]+/g, '')
    .replace(/\bSEE THIS IN MY SPACE\b/gi, '')
    .trim();
  // Remove collection prefix (e.g., "ASHTON BERGEN HILLS" → "BERGEN HILLS")
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
  // Title case
  name = name.replace(/\w\S*/g, w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
  return name.trim();
}

// ─── Phase 4: Match & Save ────────────────────────────────────────────────────

function matchProduct(nameIndex, scrapedName, scrapedCollection) {
  // Clean the scraped name
  let name = (scrapedName || '')
    .replace(/[®™©]/g, '')
    .replace(/\bTM\b/g, '')
    .trim();

  // Try direct slug match
  const slug = slugify(name);
  if (nameIndex.has(slug)) return nameIndex.get(slug);

  // Try with collection prefix stripped (e.g., "Cyrus 2.0 Akadia" → "Akadia")
  // Many MSI product pages title = "{Collection} {Version} {Color}"
  const words = name.split(/\s+/);
  for (let i = 1; i < words.length; i++) {
    const tail = slugify(words.slice(i).join(' '));
    if (tail && nameIndex.has(tail)) return nameIndex.get(tail);
  }

  // Try with collection prefix stripped using scraped collection
  if (scrapedCollection) {
    const collSlug = slugify(scrapedCollection);
    const stripped = slug.replace(new RegExp('^' + collSlug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '-?'), '');
    if (stripped && nameIndex.has(stripped)) return nameIndex.get(stripped);
  }

  // Try stripping version + collection prefixes: "2.0 Akadia" → "Akadia"
  const noVersion = slug
    .replace(/^(\d+-?\d*-)/g, '')  // strip leading version like "2-0-"
    .replace(/^(xl-|xxl-)/g, '');   // strip xl- prefix
  if (noVersion && noVersion !== slug && nameIndex.has(noVersion)) return nameIndex.get(noVersion);

  // Try stripping common suffixes
  const stripped = slug
    .replace(/-?(2-0|xl|xxl)$/g, '')
    .replace(/-?(porcelain|ceramic|vinyl|flooring|tile|plank|marble|granite|travertine|limestone|quartzite|sandstone|slate|onyx)$/g, '');
  if (stripped && stripped !== slug && nameIndex.has(stripped)) return nameIndex.get(stripped);

  // Try last word only (for "Regallo Calacatta" → "Calacatta" type names)
  if (words.length >= 2) {
    const lastWord = slugify(words[words.length - 1]);
    if (lastWord && lastWord.length >= 4 && nameIndex.has(lastWord)) return nameIndex.get(lastWord);
    // Try last two words
    const lastTwo = slugify(words.slice(-2).join(' '));
    if (lastTwo && nameIndex.has(lastTwo)) return nameIndex.get(lastTwo);
  }

  // Try partial match — check if any index key starts with our slug or vice versa
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

  log('MSI Puppeteer Image Scraper');
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

  // Build SKU code → product mapping for SIZES section matching
  const skuCodeIndex = new Map();
  for (const p of missingProducts) {
    for (const vsku of p.vendor_skus) {
      skuCodeIndex.set(vsku.toUpperCase(), p);
      // Also try MSI-{code}
      skuCodeIndex.set('MSI-' + vsku.toUpperCase(), p);
    }
  }

  // Filter categories if specified
  let categories = CATEGORY_PAGES;
  if (CATEGORY_FILTER) {
    categories = categories.filter(c => c.cat === CATEGORY_FILTER);
    log(`  Filtered to ${categories.length} category pages for: ${CATEGORY_FILTER}`);
  }

  // Phase 2: Launch browser and crawl
  log('');
  log('Phase 2: Crawling MSI category pages...');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-gpu', '--disable-extensions',
    ],
  });

  let page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  await page.setViewport({ width: 1440, height: 900 });

  // Collect all product URLs
  const allProductUrls = new Map(); // url → category
  for (const { path, cat } of categories) {
    log(`  Crawling ${path}...`);
    try {
      const urls = await crawlCategoryPage(page, path);
      let newCount = 0;
      for (const u of urls) {
        if (!allProductUrls.has(u)) {
          allProductUrls.set(u, cat);
          newCount++;
        }
      }
      log(`    Found ${urls.length} products (${newCount} new)`);
    } catch (e) {
      log(`    WARN: Category crawl failed for ${path}: ${e.message}`);
      // Recreate page in case browser context is broken
      try { await page.close(); } catch {}
      page = await browser.newPage();
      await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
      await page.setViewport({ width: 1440, height: 900 });
    }
    await delay(1000);
  }
  log(`  Total unique product URLs: ${allProductUrls.size}`);

  // Phase 3: Visit product pages and extract images
  log('');
  log('Phase 3: Extracting images from product pages...');

  let visited = 0, matched = 0, imagesAdded = 0;
  const total = allProductUrls.size;
  const matchedProducts = new Set();

  // Check which products already have images (from CDN probing or previous run)
  const { rows: alreadyImaged } = await pool.query(`
    SELECT DISTINCT p.id FROM products p
    JOIN skus s ON s.product_id = p.id
    JOIN media_assets ma ON ma.sku_id = s.id
    WHERE p.vendor_id = $1
  `, [VENDOR_ID]);
  const alreadyImagedSet = new Set(alreadyImaged.map(r => r.id));

  // Rotate pages every N visits to prevent memory buildup
  const PAGE_ROTATE_INTERVAL = 30;
  let pageVisitCount = 0;

  // Helper to (re)create a page with request interception for memory savings
  async function createLightPage() {
    const p = await browser.newPage();
    await p.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await p.setViewport({ width: 1440, height: 900 });
    await p.setRequestInterception(true);
    p.on('request', req => {
      const type = req.resourceType();
      if (['image', 'stylesheet', 'font', 'media'].includes(type)) {
        req.abort();
      } else {
        req.continue();
      }
    });
    return p;
  }

  // Function to save images for a matched product
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

  for (const [productUrl, cat] of allProductUrls) {
    visited++;
    if (visited % 25 === 0) {
      log(`  Progress: ${visited}/${total} visited, ${matched} matched, ${imagesAdded} images saved`);
    }

    // Rotate page every N visits to prevent memory leaks
    pageVisitCount++;
    if (pageVisitCount >= PAGE_ROTATE_INTERVAL) {
      try { await page.close(); } catch {}
      page = await createLightPage();
      pageVisitCount = 0;
    }

    try {
      const data = await extractProductImages(page, productUrl);
      if (!data) continue;

      // Filter out marketing images
      const goodImages = (data.images || []).filter(url => !isMarketingImage(url));

      // Try direct name match first (works for individual color pages)
      if (goodImages.length > 0) {
        const products = matchProduct(nameIndex, data.productName, data.collection);
        if (products && products.length > 0) {
          for (const product of products) {
            if (await saveProductImages(product, goodImages)) matched++;
          }
        }
      }

      // Handle collection pages: follow sub-product links to individual colors
      if (data.subProducts && data.subProducts.length > 0) {
        const uniqueSubs = [];
        const seenHrefs = new Set();
        for (const sub of data.subProducts) {
          if (seenHrefs.has(sub.href)) continue;
          seenHrefs.add(sub.href);
          uniqueSubs.push(sub);
        }

        for (const sub of uniqueSubs) {
          try {
            const colorName = cleanSubProductName(sub.colorName, data.productName);
            const colorSlug = slugify(colorName);
            const urlColorSlug = sub.colorSlug;

            let subMatch = null;
            if (colorSlug) subMatch = nameIndex.get(colorSlug);
            if (!subMatch && urlColorSlug) subMatch = nameIndex.get(urlColorSlug);
            if (!subMatch && colorName) {
              const cleaned = slugify(colorName.replace(/^(2\.?0|xl|xxl)\s+/i, ''));
              if (cleaned) subMatch = nameIndex.get(cleaned);
            }

            if (subMatch && subMatch.length > 0) {
              const subData = await extractProductImages(page, sub.href);
              if (subData) {
                const subImages = (subData.images || []).filter(url => !isMarketingImage(url));
                for (const product of subMatch) {
                  if (await saveProductImages(product, subImages.length > 0 ? subImages : (sub.imageUrl ? [sub.imageUrl] : []))) {
                    matched++;
                  }
                }
              }
              await delay(500);
            }
          } catch (subErr) {
            // Sub-product page failed, continue with others
          }
        }
      }

      // Also check SIZES section for per-SKU matches
      if (data.sizesInfo && data.sizesInfo.length > 0) {
        for (const sizeInfo of data.sizesInfo) {
          if (isMarketingImage(sizeInfo.imageUrl || '')) continue;
          const skuProduct = skuCodeIndex.get(sizeInfo.code.toUpperCase());
          if (skuProduct && sizeInfo.imageUrl) {
            if (alreadyImagedSet.has(skuProduct.product_id)) continue;
            const skuIdx = skuProduct.vendor_skus.findIndex(
              v => v.toUpperCase() === sizeInfo.code.toUpperCase()
            );
            if (skuIdx >= 0) {
              const skuId = skuProduct.sku_ids[skuIdx];
              await saveImage(skuProduct.product_id, skuId, sizeInfo.imageUrl, 'primary', 0);
              imagesAdded++;
            }
          }
        }
      }
    } catch (pageErr) {
      // If a product page crashes the browser tab, recreate it
      log(`  WARN: Product page error (${productUrl}): ${pageErr.message}`);
      try { await page.close(); } catch {}
      page = await createLightPage();
      pageVisitCount = 0;
    }

    // Small delay between pages
    await delay(500);
  }

  await browser.close();

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

// Catch unhandled errors so we get visibility into crashes
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err);
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  console.error('UNHANDLED REJECTION:', err);
  process.exit(1);
});

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
