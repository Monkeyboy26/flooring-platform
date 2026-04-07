/**
 * Mapei enrichment module for dal-enrich.js
 *
 * Crawls mapeihome.com (WordPress microsites) to get proper product names,
 * descriptions, and images for 464 Mapei products that came through
 * Daltile's 832 EDI with truncated names like "Map Flexcolor Cq 2 Gal".
 *
 * Categories were already assigned in a previous session.
 *
 * Exports: crawl() → Map<normalizedKey, { fullName, descShort, descLong, category, images[] }>
 *
 * Reuses extractBaseName + NAME_ALIASES patterns from mapei.js.
 */

const SITES = [
  'https://mapeihome.com/flooranddecor',
  'https://mapeihome.com/lowes',
];

const CATEGORIES = [
  'grouts',
  'cement-tile-mortars',
  'surface-prep',
  'ready-to-use-adhesives',
  'complementary',
  'wood-flooring-products',
  'resilient-flooring-adhesives',
];

/**
 * Known aliases: normalized DB base name → mapeihome.com product name.
 * Covers cases where names differ between Daltile EDI and Mapei branding.
 */
const NAME_ALIASES = new Map([
  ['eco prim grip', 'eco prim grip'],
  ['4 to 1 bed mix', '4 to 1 mud bed mix'],
  ['cim 500 primer', 'cim 500 primer'],
  ['ds 50', 'ds 50'],
  ['edge protector trim', 'edge protector trim'],
  ['fiberglass mesh', 'fiberglass mesh'],
  ['flexcolor 3d', 'mapei flexcolor 3d'],
  ['flexcolor cq', 'mapei flexcolor cq'],
  ['keracaulk s', 'keracaulk s'],
  ['keracaulk u', 'keracaulk u'],
  ['keracolor s', 'keracolor s sanded grout'],
  ['keracolor u', 'keracolor u unsanded grout'],
  ['kerapoxy cq', 'kerapoxy cq'],
  ['kerapoxy 410', 'kerapoxy 410'],
  ['mapelastic aquadefense', 'mapelastic aquadefense'],
  ['mapelastic ci', 'mapelastic ci'],
  ['mapecem quickpatch', 'mapecem quickpatch'],
  ['mapeguard 2', 'mapeguard 2'],
  ['mapeguard wp 200', 'mapeguard wp 200'],
  ['mapesil t', 'mapesil t plus'],
  ['mapesil 3d', 'mapesil 3d'],
  ['mapesonic 2', 'mapesonic 2'],
  ['planipatch plus', 'planipatch plus'],
  ['planipatch', 'planipatch'],
  ['planiprep sc', 'planiprep sc'],
  ['primer t', 'primer t'],
  ['sm primer', 'mapei sm primer'],
  ['type 1', 'type 1'],
  ['ultracare grout maximizer', 'ultracare grout maximizer'],
  ['ultracare grout refresh', 'ultracare grout refresh'],
  ['ultracare grout release', 'ultracare grout release'],
  ['ultracare epoxy grout haze remover', 'ultracare epoxy grout haze remover'],
  ['ultracare heavy duty stone tile grout cleaner', 'ultracare heavy duty stone tile grout cleaner'],
  ['ultracare penetrating sb stone tile grout sealer', 'ultracare penetrating sb stone tile grout sealer'],
  ['ultracare sulfamic acid crystals', 'ultracare sulfamic acid crystals'],
  ['ultracolor plus fa', 'ultracolor plus fa'],
  ['ultracolor plus max', 'ultracolor plus max'],
  ['ultraflex 1', 'ultraflex 1'],
  ['ultraflex lft', 'ultraflex lft'],
  ['ultraflex lft rapid', 'ultraflex lft rapid'],
  ['ultraflex lht sg', 'ultraflex lht sg'],
  ['ultraplan 1 plus', 'ultraplan 1 plus'],
  ['ultralite mortar', 'mapei ultralite mortar'],
  ['ultrabond eco 995', 'ultrabond eco 995'],
  ['ultrabond eco 980', 'ultrabond eco 980'],
  ['ultrabond eco 222', 'ultrabond eco 222'],
  ['ultrabond eco gpt', 'ultrabond eco gpt'],
  ['ultrabond urethane cleaner', 'ultrabond urethane cleaner'],
  ['novoplan easy plus', 'novoplan easy plus'],
  ['adesilex p10', 'adesilex p10'],
  ['keraflex super', 'keraflex super'],
  ['keraflex sg', 'keraflex sg'],
  ['keraflex plus', 'keraflex plus'],
  ['keraflor', 'keraflor'],
  ['keraply', 'keraply'],
  ['premium mortar', 'premium mortar for tile and stone'],
  ['mapeguard um 35', 'mapeguard um 35'],
]);

/**
 * Main entry point — crawl mapeihome.com and return enrichment data.
 * @returns {Map<string, { fullName, descShort, descLong, category, images }>}
 */
export async function crawl() {
  const enrichmentMap = new Map();

  // Step 1: Crawl category pages for product listings (names + images)
  const productPages = new Map(); // normalized name → { name, imageUrl, detailUrl }

  for (const site of SITES) {
    for (const cat of CATEGORIES) {
      const url = `${site}/product-category/${cat}/`;
      try {
        const resp = await fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
            'Accept': 'text/html',
          },
          signal: AbortSignal.timeout(15000),
        });
        if (!resp.ok) continue;

        const html = await resp.text();
        extractCategoryProducts(html, site, productPages);
        await delay(200);
      } catch { /* skip failed categories */ }
    }
  }

  console.log(`    Mapei category pages: ${productPages.size} products found`);

  // Step 2: Fetch detail pages for descriptions and higher-res images
  let detailCount = 0;
  for (const [normKey, entry] of productPages) {
    if (!entry.detailUrl) continue;

    try {
      const resp = await fetch(entry.detailUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          'Accept': 'text/html',
        },
        signal: AbortSignal.timeout(15000),
      });
      if (!resp.ok) continue;

      const html = await resp.text();
      const detail = extractDetailPage(html, entry);

      enrichmentMap.set(normKey, {
        fullName: detail.fullName || entry.name,
        descShort: detail.descShort,
        descLong: detail.descLong,
        category: null, // Categories already assigned
        images: detail.images.length > 0 ? detail.images : (entry.imageUrl ? [entry.imageUrl] : []),
      });

      detailCount++;
      await delay(150);
    } catch { /* skip */ }
  }

  console.log(`    Mapei detail pages: ${detailCount} crawled`);

  // Step 3: Add entries for products we found on category pages but couldn't get detail pages for
  for (const [normKey, entry] of productPages) {
    if (!enrichmentMap.has(normKey)) {
      enrichmentMap.set(normKey, {
        fullName: entry.name,
        descShort: null,
        descLong: null,
        category: null,
        images: entry.imageUrl ? [entry.imageUrl] : [],
      });
    }
  }

  // Step 4: Add alias entries so the orchestrator can match via NAME_ALIASES
  for (const [dbKey, websiteKey] of NAME_ALIASES) {
    if (!enrichmentMap.has(dbKey) && enrichmentMap.has(websiteKey)) {
      enrichmentMap.set(dbKey, enrichmentMap.get(websiteKey));
    }
    // Also try the website key prefixed with "mapei "
    if (!enrichmentMap.has(dbKey)) {
      const withPrefix = 'mapei ' + dbKey;
      if (enrichmentMap.has(withPrefix)) {
        enrichmentMap.set(dbKey, enrichmentMap.get(withPrefix));
      }
    }
  }

  console.log(`    Mapei enrichment map: ${enrichmentMap.size} entries`);
  return enrichmentMap;
}

// ─── Category Page Extraction ────────────────────────────────────────────────

function extractCategoryProducts(html, site, productPages) {
  // Extract product links + thumbnail images from category listing
  const cardRegex = /<a[^>]+href="([^"]*\/product\/[^"]+)"[^>]*>[\s\S]*?<img[^>]+src="([^"]+)"[^>]*>/gi;
  let m;
  while ((m = cardRegex.exec(html)) !== null) {
    const [, pageUrl, imgSrc] = m;
    const imageUrl = normalizeMapeiImageUrl(imgSrc);

    const slugMatch = pageUrl.match(/\/product\/([^/]+)\/?$/);
    if (!slugMatch) continue;

    const slug = slugMatch[1];
    const name = deslugify(slug);
    const normKey = normalize(name);

    if (!productPages.has(normKey)) {
      productPages.set(normKey, {
        name: `Mapei ${name}`,
        imageUrl,
        detailUrl: pageUrl.startsWith('http') ? pageUrl : `${site}${pageUrl}`,
      });
    }
  }

  // Also extract product detail URLs from links
  const linkRegex = /href="(https:\/\/mapeihome\.com\/[^"]+\/product\/[^"]+)"/gi;
  while ((m = linkRegex.exec(html)) !== null) {
    const url = m[1];
    const slugMatch = url.match(/\/product\/([^/]+)\/?$/);
    if (!slugMatch) continue;

    const slug = slugMatch[1];
    const name = deslugify(slug);
    const normKey = normalize(name);

    if (!productPages.has(normKey)) {
      productPages.set(normKey, {
        name: `Mapei ${name}`,
        imageUrl: null,
        detailUrl: url,
      });
    } else if (!productPages.get(normKey).detailUrl) {
      productPages.get(normKey).detailUrl = url;
    }
  }
}

// ─── Detail Page Extraction ──────────────────────────────────────────────────

function extractDetailPage(html, entry) {
  const result = {
    fullName: null,
    descShort: null,
    descLong: null,
    images: [],
  };

  // Extract title
  const h1 = html.match(/<h1[^>]*class="[^"]*product_title[^"]*"[^>]*>([^<]+)<\/h1>/i)
    || html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
  if (h1) {
    let title = h1[1].trim();
    // Ensure "Mapei" prefix
    if (!title.toLowerCase().startsWith('mapei')) title = `Mapei ${title}`;
    result.fullName = title;
  }

  // Extract short description (WooCommerce pattern)
  const shortDescMatch = html.match(/<div[^>]*class="[^"]*woocommerce-product-details__short-description[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
  if (shortDescMatch) {
    result.descShort = stripHtml(shortDescMatch[1]).trim().slice(0, 500);
  }

  // Extract long description
  const longDescMatch = html.match(/<div[^>]*class="[^"]*description[^"]*"[^>]*>([\s\S]*?)<\/div>/i)
    || html.match(/<div[^>]*id="tab-description"[^>]*>([\s\S]*?)<\/div>/i);
  if (longDescMatch) {
    const text = stripHtml(longDescMatch[1]).trim();
    if (text.length > 20) result.descLong = text;
  }

  // Meta description fallback
  if (!result.descShort) {
    const metaDesc = html.match(/<meta[^>]*name="description"[^>]*content="([^"]+)"/i);
    if (metaDesc) result.descShort = metaDesc[1].trim();
  }

  // Extract images — prefer cdnmedia.mapei.com
  const seen = new Set();
  const addImage = (url) => {
    if (!url) return;
    if (url.startsWith('//')) url = 'https:' + url;
    if (url.startsWith('http://')) url = url.replace('http://', 'https://');
    url = url.replace('https://www.mapei.com/images/', 'https://cdnmedia.mapei.com/images/');
    url = url.split('?')[0];
    const lower = url.toLowerCase();
    if (lower.includes('logo') || lower.includes('icon') || lower.includes('bioblock')) return;
    if (seen.has(lower)) return;
    seen.add(lower);
    result.images.push(url);
  };

  // cdnmedia.mapei.com images
  const cdnRegex = /(?:https?:)?\/\/cdnmedia\.mapei\.com\/images\/[^"'\s<>]+/gi;
  let im;
  while ((im = cdnRegex.exec(html)) !== null) {
    addImage(im[0]);
  }

  // www.mapei.com/images/ fallback
  const wwwRegex = /https?:\/\/www\.mapei\.com\/images\/librariesprovider10\/products-images\/[^"'\s<>]+/gi;
  while ((im = wwwRegex.exec(html)) !== null) {
    addImage(im[0]);
  }

  // WooCommerce product images
  const wcImgRegex = /<img[^>]+class="[^"]*wp-post-image[^"]*"[^>]+src="([^"]+)"/gi;
  while ((im = wcImgRegex.exec(html)) !== null) {
    const url = normalizeMapeiImageUrl(im[1]);
    if (url) addImage(url);
  }

  result.images = result.images.slice(0, 6);
  return result;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function normalizeMapeiImageUrl(url) {
  if (!url) return null;
  const lower = url.toLowerCase();
  if (!lower.includes('mapei.com') && !lower.includes('cdnmedia')) return null;
  if (lower.includes('logo') || lower.includes('icon') || lower.includes('bioblock')) return null;

  if (url.startsWith('//')) url = 'https:' + url;
  if (url.startsWith('http://')) url = url.replace('http://', 'https://');
  url = url.replace('https://www.mapei.com/images/', 'https://cdnmedia.mapei.com/images/');
  return url.split('?')[0];
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
