/**
 * Custom Building Products (CBP) enrichment module for dal-enrich.js
 *
 * Crawls custombuildingproducts.com sitemap + product pages to get proper
 * product names, descriptions, categories, and images for 193 CBP products
 * that came through Daltile's 832 EDI with truncated names like "Cbp Versabond 50 Lb".
 *
 * Exports: crawl() → Map<normalizedKey, { fullName, descShort, descLong, category, images[] }>
 *
 * Reuses sitemap parsing and word-overlap matching patterns from cbp.js.
 */

const SITEMAP_URL = 'https://www.custombuildingproducts.com/products-sitemap.xml';
const SITE_BASE = 'https://www.custombuildingproducts.com';

// CBP product line → DB category slug mapping
const CATEGORY_MAP = {
  // Mortars / thinset
  'versabond': 'adhesives-sealants',
  'megalite': 'adhesives-sealants',
  'acrylpro': 'adhesives-sealants',
  'flexbond': 'adhesives-sealants',
  'customblend': 'adhesives-sealants',
  'marble set': 'adhesives-sealants',
  'easyset': 'adhesives-sealants',

  // Grout
  'polyblend': 'adhesives-sealants',
  'prism': 'adhesives-sealants',
  'ceg-lite': 'adhesives-sealants',
  'fusion pro': 'adhesives-sealants',

  // Sealants / caulk
  'commercial caulk': 'adhesives-sealants',
  'sanded caulk': 'adhesives-sealants',

  // Waterproofing
  'redgard': 'underlayment',
  'wonderboard': 'underlayment',
  'simplemat': 'underlayment',

  // Surface prep / levelers
  'levelquik': 'surface-prep-levelers',
  'customfinish': 'surface-prep-levelers',
  'customtech': 'surface-prep-levelers',
  'profinish': 'surface-prep-levelers',

  // Cleaners / sealers
  'aqua mix': 'adhesives-sealants',
  'tilelab': 'adhesives-sealants',
  'stonetech': 'adhesives-sealants',

  // Tools
  'supergrid': 'tools-trowels',
};

/**
 * Main entry point — crawl custombuildingproducts.com and return enrichment data.
 * @returns {Map<string, { fullName, descShort, descLong, category, images }>}
 */
export async function crawl() {
  const enrichmentMap = new Map();

  // Step 1: Load category map
  const categoryMap = await loadCategoryMap();

  // Step 2: Fetch product sitemap → extract product page URLs
  const sitemapUrls = await fetchProductSitemap();
  console.log(`    CBP sitemap: ${sitemapUrls.length} product URLs`);

  // Step 3: Build slug → URL mapping
  const sitemapMap = buildSitemapMap(sitemapUrls);
  console.log(`    CBP product slugs: ${sitemapMap.size}`);

  // Step 4: Crawl each product page
  let crawled = 0;

  for (const [slug, entry] of sitemapMap) {
    try {
      const data = await crawlProductPage(entry.url, slug, categoryMap);
      if (data) {
        enrichmentMap.set(normalize(slug), data);
      }
    } catch { /* skip */ }

    crawled++;
    if (crawled % 20 === 0) {
      console.log(`    Crawled ${crawled}/${sitemapMap.size} CBP products`);
    }

    await delay(300);
  }

  console.log(`    CBP enrichment map: ${enrichmentMap.size} entries`);
  return enrichmentMap;
}

// ─── Sitemap Parsing ─────────────────────────────────────────────────────────

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

  const urls = [];
  for (const m of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) {
    const url = m[1].trim();
    if (url.includes('/products/') && url !== `${SITE_BASE}/products/`) {
      urls.push(url);
    }
  }
  return urls;
}

function buildSitemapMap(sitemapUrls) {
  const map = new Map();

  for (const url of sitemapUrls) {
    const pathMatch = url.match(/\/products\/([^/?#]+)/);
    if (!pathMatch) continue;

    const slug = pathMatch[1].replace(/\/$/, '');
    const words = slug.toLowerCase().split('-').filter(w => w.length > 0);
    const key = words.join(' ');

    map.set(key, { url, slug, words });
  }

  return map;
}

// ─── Page Crawling ───────────────────────────────────────────────────────────

async function crawlProductPage(url, slug, categoryMap) {
  const resp = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'text/html',
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!resp.ok) return null;
  const html = await resp.text();

  const result = {
    fullName: null,
    descShort: null,
    descLong: null,
    category: null,
    images: [],
  };

  // Extract title
  const h1 = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
  if (h1) {
    let title = h1[1].trim();
    // Ensure "Custom" prefix for brand consistency
    if (!title.toLowerCase().startsWith('custom') && !title.toLowerCase().includes('aqua mix')
        && !title.toLowerCase().includes('tilelab') && !title.toLowerCase().includes('stonetech')) {
      title = `Custom ${title}`;
    }
    result.fullName = title;
  }

  // Extract og:title fallback
  if (!result.fullName) {
    const ogTitle = html.match(/<meta[^>]*property="og:title"[^>]*content="([^"]+)"/i);
    if (ogTitle) result.fullName = ogTitle[1].trim();
  }

  // Extract meta description
  const metaDesc = html.match(/<meta[^>]*name="description"[^>]*content="([^"]+)"/i);
  if (metaDesc) result.descShort = metaDesc[1].trim();

  // Extract long description from page body
  const descPatterns = [
    /<div[^>]*class="[^"]*product-desc[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    /<div[^>]*class="[^"]*entry-content[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    /<div[^>]*class="[^"]*description[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    /<div[^>]*id="tab-description"[^>]*>([\s\S]*?)<\/div>/i,
  ];

  for (const pattern of descPatterns) {
    const match = html.match(pattern);
    if (match) {
      const text = stripHtml(match[1]).trim();
      if (text.length > 20 && text.length < 5000) {
        result.descLong = text;
        if (!result.descShort) result.descShort = text.slice(0, 300);
        break;
      }
    }
  }

  // Resolve category
  result.category = resolveCategory(slug, categoryMap);

  // Extract images
  const seen = new Set();
  const addImage = (rawUrl) => {
    if (!rawUrl || typeof rawUrl !== 'string') return;
    let url = rawUrl;
    if (url.startsWith('//')) url = 'https:' + url;
    if (url.startsWith('/')) url = SITE_BASE + url;
    if (!url.startsWith('http')) return;
    if (!url.includes('/wp-content/uploads/')) return;

    // Strip WP thumbnail suffixes for dedup
    const norm = url.toLowerCase().replace(/-\d+x\d+(\.[a-z]+)$/, '$1').split('?')[0];
    if (seen.has(norm)) return;
    seen.add(norm);

    // Keep full-size version
    result.images.push(url.replace(/-\d+x\d+(\.[a-zA-Z]+)(\?|$)/, '$1$2'));
  };

  // og:image
  const ogImg = html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:image["']/i);
  if (ogImg) addImage(ogImg[1]);

  // JSON-LD images
  const jsonLdBlocks = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const block of jsonLdBlocks) {
    const content = block.replace(/<script[^>]*>|<\/script>/gi, '').trim();
    try {
      const data = JSON.parse(content);
      extractJsonLdImages(data, addImage);
    } catch { /* skip */ }
  }

  // img tags with wp-content/uploads
  const imgRegex = /<img[^>]+(?:src|data-src|data-lazy-src)=["']([^"']*\/wp-content\/uploads\/[^"']+)["']/gi;
  let im;
  while ((im = imgRegex.exec(html)) !== null) {
    addImage(im[1]);
  }

  // srcset
  const srcsetRegex = /srcset=["']([^"']+)["']/gi;
  while ((im = srcsetRegex.exec(html)) !== null) {
    const urls = im[1].split(',').map(s => s.trim().split(/\s+/)[0]);
    for (const u of urls) {
      if (u.includes('/wp-content/uploads/')) addImage(u);
    }
  }

  result.images = result.images.slice(0, 6);

  // Only return if we got meaningful data
  if (!result.fullName && result.images.length === 0) return null;
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
      if (url) addImage(url);
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

function resolveCategory(slug, categoryMap) {
  const lower = slug.toLowerCase();

  for (const [keyword, catSlug] of Object.entries(CATEGORY_MAP)) {
    if (lower.includes(keyword.replace(/\s+/g, '-')) || lower.includes(keyword.replace(/\s+/g, ' '))) {
      return categoryMap[catSlug] || null;
    }
  }

  // Default for CBP: adhesives & sealants (most products are grout/mortar/adhesive)
  return categoryMap['adhesives-sealants'] || null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function normalize(name) {
  return name.toLowerCase().replace(/[-_]+/g, ' ').replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
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
