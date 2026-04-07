/**
 * Schluter Systems enrichment module for dal-enrich.js
 *
 * Crawls schluter.com to get proper product names, descriptions,
 * categories, and images for 2,772 Schluter products that came
 * through Daltile's 832 EDI with truncated names.
 *
 * Exports: crawl() → Map<normalizedKey, { fullName, descShort, descLong, category, images[] }>
 *
 * Reuses sitemap parsing and JSON-LD extraction patterns from schluter.js.
 */

const SITEMAP_INDEX = 'https://www.schluter.com/sitemap.xml';
const SITE_BASE = 'https://www.schluter.com';
const IMAGE_CDNS = ['sccpublic.s3-external-1.amazonaws.com', 'assets.schluter.com'];

// Schluter product line → DB category slug mapping
const CATEGORY_MAP = {
  // Edge profiles
  'jolly':        'transitions-moldings',
  'rondec':       'transitions-moldings',
  'rondec-step':  'transitions-moldings',
  'schiene':      'transitions-moldings',
  'quadec':       'transitions-moldings',
  'dilex':        'transitions-moldings',
  'dilex-ahk':    'transitions-moldings',
  'dilex-ek':     'transitions-moldings',
  'dilex-edp':    'transitions-moldings',
  'dilex-ekf':    'transitions-moldings',
  'dilex-hk':     'transitions-moldings',
  'dilex-hks':    'transitions-moldings',
  'dilex-ksn':    'transitions-moldings',
  'dilex-mp':     'transitions-moldings',
  'dilex-mop':    'transitions-moldings',
  'dilex-bw':     'transitions-moldings',
  'dilex-bwb':    'transitions-moldings',
  'reno-t':       'transitions-moldings',
  'reno-tk':      'transitions-moldings',
  'reno-u':       'transitions-moldings',
  'eck-e':        'transitions-moldings',
  'eck-k':        'transitions-moldings',
  'eck-kh':       'transitions-moldings',
  'eck-ki':       'transitions-moldings',
  'bara':         'transitions-moldings',
  'bara-rak':     'transitions-moldings',
  'bara-rkl':     'transitions-moldings',
  'bara-rw':      'transitions-moldings',
  'bara-rwe':     'transitions-moldings',
  'bara-rwl':     'transitions-moldings',
  'bara-esot':    'transitions-moldings',
  'bara-rap':     'transitions-moldings',
  'vinpro-t':     'transitions-moldings',
  'vinpro-s':     'transitions-moldings',
  'vinpro-rw':    'transitions-moldings',
  'vinpro-step':  'transitions-moldings',
  'vinpro-u':     'transitions-moldings',
  'designline':   'transitions-moldings',
  'shelves':      'transitions-moldings',

  // Membranes / waterproofing / underlayment
  'kerdi':          'underlayment',
  'kerdi-band':     'underlayment',
  'kerdi-ds':       'underlayment',
  'kerdi-board':    'underlayment',
  'kerdi-kereck':   'underlayment',
  'kerdi-kers':     'underlayment',
  'kerdi-seal':     'underlayment',
  'kerdi-fix':      'underlayment',
  'ditra':          'underlayment',
  'ditra-xl':       'underlayment',
  'ditra-drain':    'underlayment',
  'ditra-heat':     'underlayment',

  // Drains
  'kerdi-drain':    'installation-sundries',
  'kerdi-line':     'installation-sundries',

  // Setting materials / adhesives
  'all-set':        'adhesives-sealants',
  'fast-set':       'adhesives-sealants',
  'ditra-set':      'adhesives-sealants',

  // Shower systems
  'kerdi-shower':   'underlayment',

  // Tools
  'tools':          'tools-trowels',
};

/**
 * Main entry point — crawl schluter.com and return enrichment data.
 * @returns {Map<string, { fullName, descShort, descLong, category, images }>}
 */
export async function crawl() {
  // Step 1: Fetch product sitemap → get all product page URLs
  const sitemapUrls = await fetchProductSitemap();
  console.log(`    Schluter sitemap: ${sitemapUrls.length} product URLs`);

  // Step 2: Group URLs by product line (shortest URL per line)
  const lineUrlMap = buildLineUrlMap(sitemapUrls);
  console.log(`    Product lines found: ${lineUrlMap.size}`);

  // Step 3: Load category map from DB
  const categoryMap = await loadCategoryMap();

  // Step 4: Crawl each product line page
  const enrichmentMap = new Map();
  let processed = 0;

  for (const [lineName, url] of lineUrlMap) {
    try {
      const data = await crawlProductPage(url, lineName, categoryMap);
      if (data) {
        enrichmentMap.set(normalize(lineName), data);
      }
    } catch (err) {
      // Skip errors silently — some pages may fail
    }

    processed++;
    if (processed % 20 === 0) {
      console.log(`    Crawled ${processed}/${lineUrlMap.size} product lines`);
    }

    await delay(200);
  }

  // Step 5: Expand combined product lines into individual aliases
  // URLs like "TREP-E--EK" (double-dash separator) represent multiple product lines
  // sharing one page. Split them so each sub-line can be matched individually.
  const aliases = [];
  for (const [key, data] of enrichmentMap) {
    // Double-space comes from double-dash in URL after replace(/-/g, ' ')
    // After normalize: "trep e ek" (double-space collapsed to single)
    // We also handle the raw line name format before normalization
    const words = key.split(' ');
    if (words.length >= 3 && words[0].length >= 3) {
      // e.g., "trep e ek" → create "trep e" and "trep ek"
      // e.g., "trep se s b" → create "trep se", "trep s", "trep b"
      const prefix = words[0]; // e.g., "trep"
      for (let i = 1; i < words.length; i++) {
        const subKey = `${prefix} ${words[i]}`;
        if (!enrichmentMap.has(subKey)) {
          aliases.push([subKey, data]);
        }
      }
    }
  }
  for (const [k, d] of aliases) enrichmentMap.set(k, d);

  console.log(`    Schluter enrichment map: ${enrichmentMap.size} product lines (${aliases.length} aliases added)`);
  return enrichmentMap;
}

// ─── Sitemap Parsing ─────────────────────────────────────────────────────────

async function fetchProductSitemap() {
  // Get sitemap index
  const indexResp = await fetch(SITEMAP_INDEX, { signal: AbortSignal.timeout(15000) });
  const indexXml = await indexResp.text();

  // Find PRODUCT sitemap
  const sitemapMatch = indexXml.match(/<loc>([^<]*PRODUCT-en_US[^<]*)<\/loc>/);
  if (!sitemapMatch) throw new Error('Product sitemap not found in sitemap index');

  // Fetch product sitemap
  const sitemapResp = await fetch(sitemapMatch[1], { signal: AbortSignal.timeout(30000) });
  const sitemapXml = await sitemapResp.text();

  const urls = [];
  for (const m of sitemapXml.matchAll(/<loc>([^<]+)<\/loc>/g)) {
    urls.push(m[1]);
  }
  return urls;
}

function buildLineUrlMap(sitemapUrls) {
  const map = new Map();

  for (const url of sitemapUrls) {
    // Extract product line: /Schluter®-{LINE}/p/
    const lineMatch = url.match(/Schluter%C2%AE-([^/]+)\/p\//);
    if (!lineMatch) continue;

    const rawLine = decodeURIComponent(lineMatch[1]).replace(/-/g, ' ').trim();
    const key = rawLine.toUpperCase();

    // Keep shortest URL (base product page)
    if (!map.has(key) || url.length < map.get(key).url.length) {
      map.set(key, { url, lineName: rawLine });
    }
  }

  // Return as Map<lineName, url>
  const result = new Map();
  for (const [, val] of map) {
    result.set(val.lineName, val.url);
  }
  return result;
}

// ─── Page Crawling ───────────────────────────────────────────────────────────

async function crawlProductPage(url, lineName, categoryMap) {
  const resp = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'text/html',
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!resp.ok) return null;
  const html = await resp.text();

  // Extract data from page
  const fullName = extractFullName(html, lineName);
  const description = extractDescription(html);
  const category = resolveCategory(lineName, categoryMap);
  const images = extractImages(html);

  return {
    fullName,
    descShort: description.short,
    descLong: description.long,
    category,
    images,
  };
}

/**
 * Extract the full product name from the page.
 * Looks for h1 tag, JSON-LD name, or og:title.
 */
function extractFullName(html, fallbackLine) {
  // Try h1
  const h1 = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
  if (h1) {
    let name = h1[1].trim();
    // Clean up Schluter® prefix → "Schluter"
    name = name.replace(/Schluter®?\s*/gi, 'Schluter ').trim();
    if (name.length > 5 && name.length < 200) return name;
  }

  // Try JSON-LD
  const jsonLdBlocks = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const block of jsonLdBlocks) {
    const content = block.replace(/<script[^>]*>|<\/script>/gi, '').trim();
    try {
      const data = JSON.parse(content);
      const name = extractJsonLdName(data);
      if (name) return name.replace(/Schluter®?\s*/gi, 'Schluter ').trim();
    } catch { /* skip */ }
  }

  // Try og:title
  const ogTitle = html.match(/<meta[^>]*property="og:title"[^>]*content="([^"]+)"/i);
  if (ogTitle) {
    return ogTitle[1].replace(/Schluter®?\s*/gi, 'Schluter ').trim();
  }

  // Fallback: construct from line name
  return `Schluter ${fallbackLine}`;
}

function extractJsonLdName(data) {
  if (!data) return null;
  if (Array.isArray(data)) {
    for (const item of data) {
      const n = extractJsonLdName(item);
      if (n) return n;
    }
    return null;
  }
  if (data['@type'] === 'Product' && data.name) return data.name;
  if (data['@graph']) return extractJsonLdName(data['@graph']);
  return null;
}

/**
 * Extract product descriptions from the page.
 */
function extractDescription(html) {
  let short = null;
  let long = null;

  // Try meta description
  const metaDesc = html.match(/<meta[^>]*name="description"[^>]*content="([^"]+)"/i);
  if (metaDesc) {
    short = metaDesc[1].trim();
  }

  // Try og:description
  const ogDesc = html.match(/<meta[^>]*property="og:description"[^>]*content="([^"]+)"/i);
  if (ogDesc && !short) {
    short = ogDesc[1].trim();
  }

  // Try to find product description in body content
  // Look for common patterns: .product-description, .pdp-description, description div
  const descPatterns = [
    /<div[^>]*class="[^"]*product-desc[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    /<div[^>]*class="[^"]*description[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    /<div[^>]*id="[^"]*description[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
  ];

  for (const pattern of descPatterns) {
    const match = html.match(pattern);
    if (match) {
      const text = stripHtml(match[1]).trim();
      if (text.length > 20 && text.length < 5000) {
        long = text;
        break;
      }
    }
  }

  // JSON-LD description
  const jsonLdBlocks = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const block of jsonLdBlocks) {
    const content = block.replace(/<script[^>]*>|<\/script>/gi, '').trim();
    try {
      const data = JSON.parse(content);
      const desc = extractJsonLdDescription(data);
      if (desc && desc.length > 20) {
        if (!long) long = desc;
        if (!short) short = desc.slice(0, 200);
      }
    } catch { /* skip */ }
  }

  return { short, long };
}

function extractJsonLdDescription(data) {
  if (!data) return null;
  if (Array.isArray(data)) {
    for (const item of data) {
      const d = extractJsonLdDescription(item);
      if (d) return d;
    }
    return null;
  }
  if (data['@type'] === 'Product' && data.description) return data.description;
  if (data['@graph']) return extractJsonLdDescription(data['@graph']);
  return null;
}

/**
 * Extract images from the page (same logic as schluter.js).
 */
function extractImages(html) {
  const images = [];
  const seen = new Set();

  const addImage = (url) => {
    if (!url || !url.startsWith('http')) return;
    if (!IMAGE_CDNS.some(cdn => url.toLowerCase().includes(cdn))) return;
    const lower = url.toLowerCase();
    if (lower.includes('logo') || lower.includes('icon') || lower.includes('favicon')) return;
    if (lower.includes('placeholder') || lower.includes('spinner')) return;
    const norm = lower.replace(/-S\d+-FJPG/gi, '').split('?')[0];
    if (seen.has(norm)) return;
    seen.add(norm);
    images.push(url);
  };

  // JSON-LD images
  const jsonLdBlocks = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const block of jsonLdBlocks) {
    const content = block.replace(/<script[^>]*>|<\/script>/gi, '').trim();
    try {
      const data = JSON.parse(content);
      extractJsonLdImages(data, addImage);
    } catch { /* skip */ }
  }

  // og:image
  const ogMatch = html.match(/<meta[^>]*property="og:image"[^>]*content="([^"]+)"/i);
  if (ogMatch) addImage(ogMatch[1]);

  // img tags with CDN URLs
  const imgRegex = /<img[^>]+src="(https:\/\/(?:sccpublic\.s3[^"]+|assets\.schluter\.com[^"]+))"/gi;
  let m;
  while ((m = imgRegex.exec(html)) !== null) {
    addImage(m[1]);
  }

  return images.slice(0, 6);
}

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
      if (url) addImage(url);
    }
  }
  if (data['@graph']) extractJsonLdImages(data['@graph'], addImage);
}

// ─── Category Resolution ────────────────────────────────────────────────────

async function loadCategoryMap() {
  // Import pg and connect to get category slugs → IDs
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

function resolveCategory(lineName, categoryMap) {
  const key = lineName.toLowerCase().replace(/\s+/g, '-');

  // Check exact match first
  if (CATEGORY_MAP[key] && categoryMap[CATEGORY_MAP[key]]) {
    return categoryMap[CATEGORY_MAP[key]];
  }

  // Check prefix matches (e.g., "Dilex-AHK Corner" matches "dilex-ahk")
  for (const [prefix, slug] of Object.entries(CATEGORY_MAP)) {
    if (key.startsWith(prefix)) {
      return categoryMap[slug] || null;
    }
  }

  // Default: installation & sundries for unrecognized Schluter products
  return categoryMap['installation-sundries'] || null;
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
