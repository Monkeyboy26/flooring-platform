/**
 * Color Fast Industries enrichment module for dal-enrich.js
 *
 * Crawls colorfastind.com to get product names, descriptions, categories,
 * and images for 41 Color Fast products that came through Daltile's 832 EDI
 * with truncated names and 0% image coverage.
 *
 * Color Fast makes caulk, sealants, and grout colorants primarily.
 *
 * Exports: crawl() → Map<normalizedKey, { fullName, descShort, descLong, category, images[] }>
 */

const SITE_BASE = 'https://colorfastind.com';

// Known entry points for Color Fast product pages
const ENTRY_PAGES = [
  '/',
  '/products/',
  '/product-category/caulk/',
  '/product-category/grout/',
  '/product-category/sealant/',
  '/product-category/colorant/',
  '/shop/',
];

/**
 * Main entry point — crawl colorfastind.com and return enrichment data.
 * @returns {Map<string, { fullName, descShort, descLong, category, images }>}
 */
export async function crawl() {
  const enrichmentMap = new Map();

  // Step 1: Load category map
  const categoryMap = await loadCategoryMap();

  // Step 2: Discover product URLs from entry pages
  const productUrls = await discoverProductUrls();
  console.log(`    Color Fast: ${productUrls.size} product URLs discovered`);

  // Step 3: Try sitemap first (WordPress sites often have one)
  const sitemapUrls = await fetchSitemap();
  for (const url of sitemapUrls) {
    productUrls.add(url);
  }
  console.log(`    Color Fast: ${productUrls.size} total product URLs (after sitemap)`);

  // Step 4: Crawl each product page
  let crawled = 0;

  for (const url of productUrls) {
    try {
      const data = await crawlProductPage(url, categoryMap);
      if (data && data.fullName) {
        const key = normalize(data.fullName.replace(/^Color\s*Fast\s*/i, '').trim());
        if (key.length >= 3) {
          enrichmentMap.set(key, data);
        }
      }
    } catch { /* skip */ }

    crawled++;
    await delay(300);
  }

  console.log(`    Color Fast enrichment map: ${enrichmentMap.size} entries`);
  return enrichmentMap;
}

// ─── URL Discovery ───────────────────────────────────────────────────────────

async function discoverProductUrls() {
  const urls = new Set();

  for (const path of ENTRY_PAGES) {
    try {
      const resp = await fetch(SITE_BASE + path, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'text/html',
        },
        signal: AbortSignal.timeout(15000),
      });

      if (!resp.ok) continue;
      const html = await resp.text();

      // Extract product page URLs (WooCommerce pattern: /product/{slug}/)
      const linkRegex = /href="(https?:\/\/(?:www\.)?colorfastind\.com\/product\/[^"]+)"/gi;
      let m;
      while ((m = linkRegex.exec(html)) !== null) {
        urls.add(m[1].replace(/\/$/, '') + '/');
      }

      // Also try relative URLs
      const relRegex = /href="(\/product\/[^"]+)"/gi;
      while ((m = relRegex.exec(html)) !== null) {
        urls.add(SITE_BASE + m[1].replace(/\/$/, '') + '/');
      }

      await delay(200);
    } catch { /* skip */ }
  }

  return urls;
}

async function fetchSitemap() {
  const urls = [];
  const sitemapPaths = [
    '/sitemap.xml',
    '/product-sitemap.xml',
    '/sitemap_index.xml',
    '/wp-sitemap-posts-product-1.xml',
  ];

  for (const path of sitemapPaths) {
    try {
      const resp = await fetch(SITE_BASE + path, {
        headers: {
          'User-Agent': 'Mozilla/5.0',
          'Accept': 'application/xml, text/xml',
        },
        signal: AbortSignal.timeout(10000),
      });

      if (!resp.ok) continue;
      const xml = await resp.text();

      // Extract product URLs from sitemap
      for (const m of xml.matchAll(/<loc>([^<]*\/product\/[^<]+)<\/loc>/g)) {
        urls.push(m[1].trim());
      }

      // If this is a sitemap index, follow child sitemaps
      for (const m of xml.matchAll(/<loc>([^<]*sitemap[^<]*\.xml[^<]*)<\/loc>/g)) {
        try {
          const childResp = await fetch(m[1].trim(), {
            headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/xml' },
            signal: AbortSignal.timeout(10000),
          });
          if (!childResp.ok) continue;
          const childXml = await childResp.text();
          for (const cm of childXml.matchAll(/<loc>([^<]*\/product\/[^<]+)<\/loc>/g)) {
            urls.push(cm[1].trim());
          }
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }

  return urls;
}

// ─── Page Crawling ───────────────────────────────────────────────────────────

async function crawlProductPage(url, categoryMap) {
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
  const h1 = html.match(/<h1[^>]*class="[^"]*product_title[^"]*"[^>]*>([^<]+)<\/h1>/i)
    || html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
  if (h1) {
    let title = h1[1].trim();
    if (!title.toLowerCase().startsWith('color') && !title.toLowerCase().startsWith('cf ')) {
      title = `Color Fast ${title}`;
    }
    result.fullName = title;
  }

  // og:title fallback
  if (!result.fullName) {
    const ogTitle = html.match(/<meta[^>]*property="og:title"[^>]*content="([^"]+)"/i);
    if (ogTitle) result.fullName = ogTitle[1].trim();
  }

  // Extract slug from URL as last resort
  if (!result.fullName) {
    const slugMatch = url.match(/\/product\/([^/]+)\/?$/);
    if (slugMatch) {
      result.fullName = `Color Fast ${deslugify(slugMatch[1])}`;
    }
  }

  // Extract descriptions
  const shortDesc = html.match(/<div[^>]*class="[^"]*woocommerce-product-details__short-description[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
  if (shortDesc) {
    result.descShort = stripHtml(shortDesc[1]).trim().slice(0, 500);
  }

  const longDesc = html.match(/<div[^>]*class="[^"]*description[^"]*"[^>]*>([\s\S]*?)<\/div>/i)
    || html.match(/<div[^>]*id="tab-description"[^>]*>([\s\S]*?)<\/div>/i);
  if (longDesc) {
    const text = stripHtml(longDesc[1]).trim();
    if (text.length > 20) result.descLong = text;
  }

  // Meta description fallback
  if (!result.descShort) {
    const metaDesc = html.match(/<meta[^>]*name="description"[^>]*content="([^"]+)"/i);
    if (metaDesc) result.descShort = metaDesc[1].trim();
  }

  // Resolve category — Color Fast primarily makes caulk/sealants
  result.category = resolveCategory(result.fullName, url, categoryMap);

  // Extract images
  const seen = new Set();
  const addImage = (rawUrl) => {
    if (!rawUrl) return;
    let imgUrl = rawUrl;
    if (imgUrl.startsWith('//')) imgUrl = 'https:' + imgUrl;
    if (imgUrl.startsWith('/')) imgUrl = SITE_BASE + imgUrl;
    if (!imgUrl.startsWith('http')) return;

    const lower = imgUrl.toLowerCase();
    if (lower.includes('logo') || lower.includes('icon') || lower.includes('favicon')) return;
    if (lower.includes('placeholder') || lower.includes('woocommerce-placeholder')) return;

    // Normalize for dedup: strip WP thumbnail suffixes
    const norm = lower.replace(/-\d+x\d+(\.[a-z]+)$/, '$1').split('?')[0];
    if (seen.has(norm)) return;
    seen.add(norm);

    // Keep full-size version
    result.images.push(imgUrl.replace(/-\d+x\d+(\.[a-zA-Z]+)(\?|$)/, '$1$2'));
  };

  // og:image
  const ogImg = html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i);
  if (ogImg) addImage(ogImg[1]);

  // WooCommerce product image
  const wcImg = html.match(/<img[^>]+class="[^"]*wp-post-image[^"]*"[^>]+src="([^"]+)"/i);
  if (wcImg) addImage(wcImg[1]);

  // Product gallery images
  const galleryRegex = /<div[^>]*class="[^"]*woocommerce-product-gallery[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/i;
  const gallery = html.match(galleryRegex);
  if (gallery) {
    const imgRegex = /(?:src|data-src|data-large_image)=["']([^"']+\.(jpg|jpeg|png|webp)[^"']*)["']/gi;
    let im;
    while ((im = imgRegex.exec(gallery[1])) !== null) {
      addImage(im[1]);
    }
  }

  // General img tags with uploads
  const imgRegex = /<img[^>]+(?:src|data-src)=["']([^"']*\/wp-content\/uploads\/[^"']+)["']/gi;
  let im;
  while ((im = imgRegex.exec(html)) !== null) {
    addImage(im[1]);
  }

  // JSON-LD images
  const jsonLdBlocks = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const block of jsonLdBlocks) {
    const content = block.replace(/<script[^>]*>|<\/script>/gi, '').trim();
    try {
      const data = JSON.parse(content);
      extractJsonLdImages(data, addImage);
    } catch { /* skip */ }
  }

  result.images = result.images.slice(0, 6);

  if (!result.fullName) return null;
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

function resolveCategory(name, url, categoryMap) {
  const lower = (name || '').toLowerCase() + ' ' + (url || '').toLowerCase();

  if (lower.includes('caulk') || lower.includes('sealant') || lower.includes('silicone')) {
    return categoryMap['adhesives-sealants'] || null;
  }
  if (lower.includes('grout') || lower.includes('colorant')) {
    return categoryMap['adhesives-sealants'] || null;
  }
  if (lower.includes('sealer') || lower.includes('cleaner')) {
    return categoryMap['adhesives-sealants'] || null;
  }

  // Default for Color Fast: adhesives & sealants
  return categoryMap['adhesives-sealants'] || null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

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
