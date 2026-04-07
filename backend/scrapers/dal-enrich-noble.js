/**
 * Noble Company enrichment module for dal-enrich.js
 *
 * Crawls noblecompany.com category + detail pages to get proper product names,
 * descriptions, categories, and images for 233 Noble products that came through
 * Daltile's 832 EDI with truncated names like "Nob Chloraloy 40mil 3.3 Gal".
 *
 * Exports: crawl() → Map<normalizedKey, { fullName, descShort, descLong, category, images[] }>
 *
 * Reuses category crawling and fuzzy matching patterns from noble.js.
 */

const SITE_BASE = 'https://noblecompany.com';

const CATEGORY_PAGES = [
  '/products/tile-installation/sheet-membranes/',
  '/products/tile-installation/drains/',
  '/products/tile-installation/niches-benches/',
  '/products/tile-installation/pre-slopes-shower-bases/',
  '/products/tile-installation/installation-products/',
];

// Noble product line → DB category slug mapping
const CATEGORY_MAP = {
  'chloraloy':       'underlayment',
  'nobleseal':       'underlayment',
  'aquaseal':        'underlayment',
  'pvc shower pan':  'underlayment',
  'freeform':        'underlayment',
  'nobleflex':       'underlayment',
  'clamping ring':   'installation-sundries',
  'linear drain':    'installation-sundries',
  'shower drain':    'installation-sundries',
  'drain':           'installation-sundries',
  'shower niche':    'installation-sundries',
  'freedom shower':  'installation-sundries',
  'pro-slope':       'installation-sundries',
  'shower base':     'installation-sundries',
  'bench':           'installation-sundries',
  'curb':            'installation-sundries',
  'ramp':            'installation-sundries',
  'corner':          'installation-sundries',
  'pipe':            'installation-sundries',
  'valve':           'installation-sundries',
  'mixing valve':    'installation-sundries',
};

/**
 * Main entry point — crawl noblecompany.com and return enrichment data.
 * @returns {Map<string, { fullName, descShort, descLong, category, images }>}
 */
export async function crawl() {
  const enrichmentMap = new Map();

  // Step 1: Load category map
  const categoryMap = await loadCategoryMap();

  // Step 2: Crawl category pages → collect product links + thumbnails
  const crawledProducts = await crawlCategoryPages();
  console.log(`    Noble category pages: ${crawledProducts.length} products found`);

  // Step 3: Fetch detail pages for descriptions and higher-res images
  let detailCount = 0;
  for (const product of crawledProducts) {
    try {
      const detail = await crawlDetailPage(product.url);
      const category = resolveCategory(product.name, categoryMap);

      enrichmentMap.set(normalize(product.name), {
        fullName: detail.fullName || `Noble ${product.name}`,
        descShort: detail.descShort,
        descLong: detail.descLong,
        category,
        images: detail.images.length > 0 ? detail.images : product.images,
      });

      detailCount++;
    } catch {
      // Fall back to category page data
      const category = resolveCategory(product.name, categoryMap);
      enrichmentMap.set(normalize(product.name), {
        fullName: `Noble ${product.name}`,
        descShort: null,
        descLong: null,
        category,
        images: product.images,
      });
    }

    await delay(300);
  }

  console.log(`    Noble detail pages: ${detailCount} crawled`);
  console.log(`    Noble enrichment map: ${enrichmentMap.size} entries`);
  return enrichmentMap;
}

// ─── Category Page Crawling ──────────────────────────────────────────────────

async function crawlCategoryPages() {
  const allProducts = [];
  const seenUrls = new Set();

  const skipSlugs = new Set([
    'tile-installation', 'plumbing', 'heating-cooling', 'fire-sprinkler',
    'sheet-membranes', 'drains', 'niches-benches', 'pre-slopes-shower-bases',
    'installation-products', 'waterproof-membranes', 'adhesives-sealants',
    'tub-o-towels', 'freeze-protection', 'system-maintenance', 'testing-equipment',
  ]);

  for (const catPath of CATEGORY_PAGES) {
    try {
      const url = SITE_BASE + catPath;
      const resp = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'text/html',
        },
        signal: AbortSignal.timeout(15000),
      });

      if (!resp.ok) continue;
      const html = await resp.text();

      // Extract product links
      const cardRegex = /<a[^>]+href="(\/products\/([^/"]+)\/?)"[^>]*>([\s\S]*?)<\/a>/gi;
      let match;

      while ((match = cardRegex.exec(html)) !== null) {
        const path = match[1];
        const slug = match[2];
        const innerHtml = match[3];

        if (skipSlugs.has(slug)) continue;
        if (seenUrls.has(slug)) continue;
        seenUrls.add(slug);

        const name = deslugify(slug);
        const images = extractThumbnailImages(innerHtml);

        allProducts.push({
          name,
          url: SITE_BASE + path,
          images,
        });
      }

      await delay(300);
    } catch { /* skip */ }
  }

  return allProducts;
}

function extractThumbnailImages(innerHtml) {
  const images = [];

  // Absolute URLs
  const absRegex = /<img[^>]+src="(https?:\/\/[^"]+\.(png|jpg|jpeg|webp)[^"]*)"/gi;
  let m;
  while ((m = absRegex.exec(innerHtml)) !== null) {
    if (isProductImage(m[1])) images.push(m[1]);
  }

  // Relative paths (/storage/...)
  const relRegex = /<img[^>]+src="(\/storage\/[^"]+\.(png|jpg|jpeg|webp)[^"]*)"/gi;
  while ((m = relRegex.exec(innerHtml)) !== null) {
    if (isProductImage(SITE_BASE + m[1])) images.push(SITE_BASE + m[1]);
  }

  return images;
}

// ─── Detail Page Crawling ────────────────────────────────────────────────────

async function crawlDetailPage(pageUrl) {
  const resp = await fetch(pageUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'text/html',
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const html = await resp.text();

  const result = {
    fullName: null,
    descShort: null,
    descLong: null,
    images: [],
  };

  // Extract title
  const h1 = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
  if (h1) {
    let title = h1[1].trim();
    if (!title.toLowerCase().startsWith('noble')) title = `Noble ${title}`;
    result.fullName = title;
  }

  // Extract meta description
  const metaDesc = html.match(/<meta[^>]*name="description"[^>]*content="([^"]+)"/i);
  if (metaDesc) result.descShort = metaDesc[1].trim();

  // Extract og:description
  const ogDesc = html.match(/<meta[^>]*property="og:description"[^>]*content="([^"]+)"/i);
  if (ogDesc && !result.descShort) result.descShort = ogDesc[1].trim();

  // Extract body description
  const descPatterns = [
    /<div[^>]*class="[^"]*product-desc[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    /<div[^>]*class="[^"]*description[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    /<article[^>]*>([\s\S]*?)<\/article>/i,
  ];

  for (const pattern of descPatterns) {
    const match = html.match(pattern);
    if (match) {
      const text = stripHtml(match[1]).trim();
      if (text.length > 20 && text.length < 5000) {
        result.descLong = text;
        break;
      }
    }
  }

  // Extract images
  const seen = new Set();
  const addImage = (url) => {
    if (!url) return;
    if (url.startsWith('/')) url = SITE_BASE + url;
    if (!url.startsWith('http')) return;
    const norm = url.toLowerCase().split('?')[0];
    if (seen.has(norm)) return;
    if (!isProductImage(url)) return;
    seen.add(norm);
    result.images.push(url);
  };

  // og:image
  const ogImg = html.match(/<meta[^>]*property="og:image"[^>]*content="([^"]+)"/i);
  if (ogImg) addImage(ogImg[1]);

  // /storage/ images
  const storageRegex = /(?:src|href)="([^"]*\/storage\/[^"]+\.(png|jpg|jpeg|webp)[^"]*)"/gi;
  let im;
  while ((im = storageRegex.exec(html)) !== null) {
    addImage(im[1]);
  }

  // JSON-LD images
  const jsonLdBlocks = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const block of jsonLdBlocks) {
    const content = block.replace(/<script[^>]*>|<\/script>/gi, '').trim();
    try {
      const data = JSON.parse(content);
      extractJsonLdImages(data, addImage);
    } catch { /* skip */ }
  }

  result.images = result.images.slice(0, 6);
  return result;
}

function extractJsonLdImages(data, addImage) {
  if (!data) return;
  if (Array.isArray(data)) {
    for (const item of data) extractJsonLdImages(item, addImage);
    return;
  }
  if (data.image) {
    const imgs = Array.isArray(data.image) ? data.image : [data.image];
    for (const img of imgs) {
      const url = typeof img === 'string' ? img : img?.url;
      if (url && url.startsWith('http')) addImage(url);
    }
  }
  if (data['@graph']) extractJsonLdImages(data['@graph'], addImage);
}

// ─── Category Resolution ────────────────────────────────────────────────────

async function loadCategoryMap() {
  const pg = await import('pg');
  const pool = new pg.default.Pool({
    host: process.env.DB_HOST || 'db',
    port: Number(process.env.DB_PORT) || 5432,
    database: process.env.DB_NAME || 'flooring_pim',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASS || 'postgres',
  });

  try {
    const result = await pool.query('SELECT id, slug FROM categories');
    const map = {};
    for (const row of result.rows) map[row.slug] = row.id;
    return map;
  } finally {
    await pool.end();
  }
}

function resolveCategory(name, categoryMap) {
  const lower = name.toLowerCase();

  for (const [keyword, slug] of Object.entries(CATEGORY_MAP)) {
    if (lower.includes(keyword)) {
      return categoryMap[slug] || null;
    }
  }

  // Default for Noble: underlayment (most are membrane products)
  return categoryMap['underlayment'] || null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isProductImage(url) {
  const lower = url.toLowerCase();
  const excludes = [
    'logo', 'icon', 'favicon', 'social', 'sprite', 'placeholder', 'spinner',
    'loader', 'avatar', 'arrow', 'chevron', 'close', 'search', 'cart',
    'footer', 'header', 'nav', 'menu', 'badge', 'wp-content/themes', 'wp-includes',
  ];
  return !excludes.some(p => lower.includes(p));
}

function normalize(name) {
  return name.toLowerCase().replace(/[-_]+/g, ' ').replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

function deslugify(slug) {
  return slug.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).trim();
}

function stripHtml(html) {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
