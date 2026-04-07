import { upsertMediaAsset, appendLog, addJobError } from './base.js';

/**
 * Mapei image enrichment scraper.
 *
 * Mapei products (grouts, adhesives, caulks, membranes, etc.) are distributed
 * through Daltile but have no images from the EDI 832 feed. Images are sourced
 * from mapeihome.com (WordPress microsites for Floor & Decor / Lowe's) which
 * serve cdnmedia.mapei.com image URLs without Cloudflare protection.
 *
 * CDN: cdnmedia.mapei.com — images are public once the URL is known.
 *
 * Strategy:
 *   1. Crawl mapeihome.com category pages → collect product slugs + image URLs
 *   2. Group DB products by base product name
 *   3. Match crawled products to DB products by normalized name
 *   4. Save as product-level images (sku_id = null)
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
  'floor-heating-systems',
  'care-maintenance',
];

export async function run(pool, job, source) {
  await appendLog(pool, job.id, 'Starting Mapei image enrichment scraper (mapeihome.com)');

  // Step 1: Load DB products without images
  const products = await loadMapeiProducts(pool);
  await appendLog(pool, job.id, `Found ${products.length} Mapei products without images`);

  if (products.length === 0) {
    await appendLog(pool, job.id, 'No Mapei products need images — done');
    return;
  }

  // Step 2: Group DB products by base name
  const lineGroups = groupByProductLine(products);
  await appendLog(pool, job.id, `Grouped into ${lineGroups.size} distinct product lines`);

  // Step 3: Crawl mapeihome.com for product images
  const imageMap = await crawlMapeiHome(pool, job);
  await appendLog(pool, job.id, `Crawled ${imageMap.size} products with images from mapeihome.com`);

  // Step 4: Match and save
  let stats = { linesMatched: 0, productsMatched: 0, imagesSet: 0, notFound: 0 };
  const unmatchedLines = [];

  for (const [slug, group] of lineGroups) {
    const imageUrl = findBestMatch(slug, group, imageMap);

    if (imageUrl) {
      stats.linesMatched++;
      for (const prodId of group.productIds) {
        await upsertMediaAsset(pool, {
          product_id: prodId,
          sku_id: null,
          asset_type: 'primary',
          url: imageUrl,
          original_url: imageUrl,
          sort_order: 0,
        });
        stats.productsMatched++;
        stats.imagesSet++;
      }
    } else {
      stats.notFound++;
      unmatchedLines.push(`${slug} (${group.productIds.length} products)`);
    }
  }

  // Log unmatched lines for diagnostics
  if (unmatchedLines.length > 0 && unmatchedLines.length <= 50) {
    await appendLog(pool, job.id, `Unmatched lines: ${unmatchedLines.join(', ')}`);
  } else if (unmatchedLines.length > 50) {
    await appendLog(pool, job.id, `${unmatchedLines.length} unmatched lines (showing first 30): ${unmatchedLines.slice(0, 30).join(', ')}`);
  }

  await appendLog(pool, job.id,
    `Complete. Lines matched: ${stats.linesMatched}/${lineGroups.size}, ` +
    `Products matched: ${stats.productsMatched}, Images saved: ${stats.imagesSet}, ` +
    `Not found: ${stats.notFound}`,
    { products_found: products.length, products_updated: stats.productsMatched }
  );
}

// ─── DB Loading ──────────────────────────────────────────────────────────────

async function loadMapeiProducts(pool) {
  const result = await pool.query(`
    SELECT p.id AS product_id, p.name
    FROM products p
    JOIN vendors v ON v.id = p.vendor_id
    LEFT JOIN media_assets ma ON ma.product_id = p.id
    WHERE v.code = 'DAL'
      AND p.collection = 'Mapei Corporation'
      AND ma.id IS NULL
    ORDER BY p.name
  `);
  return result.rows;
}

// ─── Crawl mapeihome.com ─────────────────────────────────────────────────────

/**
 * Crawl mapeihome.com category pages to build a map of
 * normalized product name → image URL.
 */
async function crawlMapeiHome(pool, job) {
  const imageMap = new Map(); // normalized name → image URL

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
        const items = extractProductsFromCategory(html);

        for (const item of items) {
          if (item.imageUrl && !imageMap.has(item.normalizedName)) {
            imageMap.set(item.normalizedName, item.imageUrl);
          }
        }

        // Polite delay
        await delay(200);
      } catch {
        // Skip failed category pages
      }
    }
  }

  // Also crawl individual product detail pages for higher-res images
  // if we found product page URLs
  const detailUrls = new Set();
  for (const site of SITES) {
    for (const cat of CATEGORIES) {
      const url = `${site}/product-category/${cat}/`;
      try {
        const resp = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html' },
          signal: AbortSignal.timeout(15000),
        });
        if (!resp.ok) continue;
        const html = await resp.text();

        // Extract product detail page URLs
        const linkRegex = /href="(https:\/\/mapeihome\.com\/[^"]+\/product\/[^"]+)"/gi;
        let m;
        while ((m = linkRegex.exec(html)) !== null) {
          detailUrls.add(m[1]);
        }
      } catch { /* skip */ }
    }
  }

  await appendLog(pool, job.id, `Found ${detailUrls.size} product detail pages to check`);

  let detailCount = 0;
  for (const detailUrl of detailUrls) {
    try {
      const resp = await fetch(detailUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html' },
        signal: AbortSignal.timeout(15000),
      });
      if (!resp.ok) continue;
      const html = await resp.text();

      const images = extractImagesFromDetailPage(html);
      if (images.length > 0) {
        // Extract product name from URL slug
        const slugMatch = detailUrl.match(/\/product\/([^/]+)\/?$/);
        if (slugMatch) {
          const name = normalizeForMatch(slugMatch[1].replace(/-/g, ' '));
          if (!imageMap.has(name) || images[0].includes('cdnmedia.mapei.com')) {
            imageMap.set(name, images[0]);
          }
        }
      }
      detailCount++;
      await delay(150);
    } catch { /* skip */ }
  }

  await appendLog(pool, job.id, `Processed ${detailCount} detail pages`);
  return imageMap;
}

/**
 * Extract product names and image URLs from a category listing page.
 */
function extractProductsFromCategory(html) {
  const products = [];

  // Match product cards: <a href="...product/slug/">...<img src="cdnmedia...">
  // Pattern: look for product links with nearby images
  const cardRegex = /<a[^>]+href="([^"]*\/product\/[^"]+)"[^>]*>[\s\S]*?<img[^>]+src="([^"]+)"[^>]*>/gi;
  let m;
  while ((m = cardRegex.exec(html)) !== null) {
    const [, pageUrl, imgSrc] = m;
    const imageUrl = normalizeImageUrl(imgSrc);
    if (!imageUrl) continue;

    // Extract product slug from URL
    const slugMatch = pageUrl.match(/\/product\/([^/]+)\/?$/);
    if (!slugMatch) continue;

    const name = normalizeForMatch(slugMatch[1].replace(/-/g, ' '));
    products.push({ normalizedName: name, imageUrl, pageUrl });
  }

  // Also try: img tags with cdnmedia URLs that have product names in filename
  const imgRegex = /<img[^>]+src="([^"]*(?:cdnmedia\.mapei\.com|www\.mapei\.com)[^"]*products-images[^"]*)"/gi;
  while ((m = imgRegex.exec(html)) !== null) {
    const url = normalizeImageUrl(m[1]);
    if (!url) continue;

    // Extract product name from filename
    const fnMatch = url.match(/products-images\/[^/]*?-([a-z][\w-]+)-\d/i);
    if (fnMatch) {
      const name = normalizeForMatch(fnMatch[1].replace(/-/g, ' '));
      if (!products.find(p => p.normalizedName === name)) {
        products.push({ normalizedName: name, imageUrl: url });
      }
    }
  }

  return products;
}

/**
 * Extract cdnmedia.mapei.com image URLs from a product detail page.
 */
function extractImagesFromDetailPage(html) {
  const images = [];
  const seen = new Set();

  // cdnmedia.mapei.com images
  const regex = /(?:https?:)?\/\/cdnmedia\.mapei\.com\/images\/[^"'\s<>]+/gi;
  let m;
  while ((m = regex.exec(html)) !== null) {
    let url = m[0];
    if (url.startsWith('//')) url = 'https:' + url;
    url = url.split('?')[0]; // strip query params
    const lower = url.toLowerCase();
    if (lower.includes('logo') || lower.includes('icon') || lower.includes('bioblock')) continue;
    if (!seen.has(lower)) {
      seen.add(lower);
      images.push(url);
    }
  }

  // Also check www.mapei.com/images/ (some pages use this instead of CDN)
  const regex2 = /https?:\/\/www\.mapei\.com\/images\/librariesprovider10\/products-images\/[^"'\s<>]+/gi;
  while ((m = regex2.exec(html)) !== null) {
    let url = m[0].split('?')[0];
    const lower = url.toLowerCase();
    if (lower.includes('logo') || lower.includes('icon')) continue;
    // Convert to cdnmedia URL
    url = url.replace('http://www.mapei.com/images/', 'https://cdnmedia.mapei.com/images/');
    url = url.replace('https://www.mapei.com/images/', 'https://cdnmedia.mapei.com/images/');
    if (!seen.has(url.toLowerCase())) {
      seen.add(url.toLowerCase());
      images.push(url);
    }
  }

  return images;
}

// ─── Grouping ────────────────────────────────────────────────────────────────

/**
 * Extract the Mapei product base name from our DB name.
 * "Map Flexcolor Cq 2 Gal" → "Flexcolor Cq"
 * "Map Adesilex P10 43 Lb" → "Adesilex P10"
 */
function extractBaseName(name) {
  let n = name.replace(/^Map\s+/i, '').trim();
  // Strip trailing: dimensions (12" x 150'), then qty+unit, voltage, ranges
  n = n.replace(/\s+\d+"?\s*x\s*\d+"?.*$/i, '');          // 108" x 108" 120v
  n = n.replace(/\s+\d+\s*-\s*\d+sf.*$/i, '');             // 11 - 20sf 120v
  n = n.replace(/\s+\d+(\.\d+)?sf\s+.*$/i, '');            // 100sf 240v
  n = n.replace(/\s+\d+(\.\d+)?\s*(Lb|Gal|Oz|Pc|Roll|Sqft|Qt|Gm|Ft|Lf|Sf|Each|Kit|Barrel|Cart).*$/i, '');
  n = n.replace(/\s+\d+\/\d+".*$/i, '');                   // 3/16"
  return n.trim();
}

function normalizeForMatch(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function groupByProductLine(products) {
  const groups = new Map();

  for (const prod of products) {
    const base = extractBaseName(prod.name);
    const key = normalizeForMatch(base);

    if (!groups.has(key)) {
      groups.set(key, {
        baseName: base,
        productIds: [],
      });
    }
    groups.get(key).productIds.push(prod.product_id);
  }

  return groups;
}

// ─── Matching ────────────────────────────────────────────────────────────────

/**
 * Known aliases: our DB name → mapeihome.com product name.
 * Covers cases where names differ between Daltile EDI and Mapei branding.
 */
const NAME_ALIASES = new Map([
  ['eco prim grip', 'eco prim grip'],
  ['4 to 1 bed mix', '4 to 1 mud bed mix'],
  ['4 to 1 mud bed mix', '4 to 1 mud bed mix'],
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
  // Mapeheat — all variants share the same product images
  ['mapeheat cable', 'mapeheat cable'],
  ['mapeheat mat', 'mapeheat mat'],
  ['mapeheat membrane', 'mapeheat membrane'],
  ['mapeheat thermo basic', 'mapeheat thermo basic'],
  ['mapeheat thermo connect', 'mapeheat thermo connect'],
  ['mapeheat thermo touch', 'mapeheat thermo touch'],
  ['mapeheat thermo extender', 'mapeheat thermo extender'],
  ['mapeheat cable repair kit', 'mapeheat cable repair kit'],
  ['mapeheat lead wire repair kit', 'mapeheat lead wire repair kit'],
  ['mapeheat mat repair kit', 'mapeheat mat repair kit'],
  ['mapeheat fault sensor', 'mapeheat fault sensor'],
  ['mapeheat temperature sensing probe', 'mapeheat temperature sensing probe'],
  ['mapeheat cable guides', 'mapeheat cable guides'],
  // Professional products — DB names map to website names
  ['flexset', 'flexset'],
  ['granirapid', 'granirapid'],
  ['kerabond', 'kerabond'],
  ['kerabond t', 'kerabond t'],
  ['keralastic', 'keralastic'],
  ['keraset', 'keraset'],
  ['mapeband', 'mapeband'],
  ['mapebond 710', 'mapebond 710'],
  ['mapebond 720', 'mapebond 720'],
  ['mapebond vm', 'mapebond vm'],
  ['mapebond vm lite', 'mapebond vm lite'],
  ['mapebond vm rapid', 'mapebond vm rapid'],
  ['mapebond vm super', 'mapebond vm super'],
  ['mapecoat 4 lvt', 'mapecoat 4 lvt'],
  ['mapedrain', 'mapedrain'],
  ['mapedrain 30', 'mapedrain 30'],
  ['mapedrain 35', 'mapedrain 35'],
  ['mapeflex p1', 'mapeflex p1'],
  ['mapelevel spacer', 'mapelevel spacer'],
  ['mapesand coarse', 'mapesand coarse'],
  ['mapesand fine', 'mapesand fine'],
  ['mapethane', 'mapethane'],
  ['modified mortar bed', 'modified mortar bed'],
  ['planibond eba', 'planibond eba'],
  ['planicrete', 'planicrete'],
  ['planicrete ac', 'planicrete ac'],
  ['planicrete w', 'planicrete w'],
  ['planigrout', 'planigrout'],
  ['planiseal cr1', 'planiseal cr1'],
  ['planiseal msp', 'planiseal msp'],
  ['planiseal pmb', 'planiseal pmb'],
  ['planiseal vs', 'planiseal vs'],
  ['planiseal vs fast', 'planiseal vs fast'],
  ['planislop rs', 'planislop rs'],
  ['planitex slf', 'planitex slf'],
  ['planitop 330 fast', 'planitop 330 fast'],
  ['pro series', 'pro series'],
  ['proangle', 'proangle'],
  ['pronivel', 'pronivel'],
  ['reinforcing fabric', 'reinforcing fabric'],
  ['saltillo grout mix', 'saltillo grout mix'],
  ['topcem premix', 'topcem premix'],
  ['ultratop pc', 'ultratop pc'],
  ['leveling spacers', 'leveling spacers'],
  ['kerdi board zw', 'kerdi board zw'],
]);

/**
 * Find the best image URL match for a DB product line.
 */
function findBestMatch(slug, group, imageMap) {
  // Direct match
  if (imageMap.has(slug)) return imageMap.get(slug);

  // Try alias
  const alias = NAME_ALIASES.get(slug);
  if (alias && imageMap.has(alias)) return imageMap.get(alias);

  // Try with "mapei " prefix
  if (imageMap.has('mapei ' + slug)) return imageMap.get('mapei ' + slug);

  // Try without "mapei " prefix
  const noMapei = slug.replace(/^mapei\s+/, '');
  if (noMapei !== slug && imageMap.has(noMapei)) return imageMap.get(noMapei);

  // Fuzzy: find imageMap key that contains our slug or vice versa
  for (const [key, url] of imageMap) {
    if (key.includes(slug) || slug.includes(key)) return url;
  }

  // Try first word match (e.g., "planipatch" matches "planipatch plus")
  const firstWord = slug.split(' ')[0];
  if (firstWord.length >= 5) {
    for (const [key, url] of imageMap) {
      if (key.startsWith(firstWord)) return url;
    }
  }

  return null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Normalize image URL: ensure https, strip query params, convert www.mapei.com to CDN.
 */
function normalizeImageUrl(url) {
  if (!url) return null;

  // Must be a Mapei product image
  const lower = url.toLowerCase();
  if (!lower.includes('mapei.com') && !lower.includes('cdnmedia.mapei.com')) return null;
  if (lower.includes('logo') || lower.includes('icon') || lower.includes('bioblock')) return null;
  if (!lower.includes('products-images') && !lower.includes('product')) return null;

  // Normalize protocol
  if (url.startsWith('//')) url = 'https:' + url;
  if (url.startsWith('http://')) url = url.replace('http://', 'https://');

  // Convert www.mapei.com → cdnmedia.mapei.com
  url = url.replace('https://www.mapei.com/images/', 'https://cdnmedia.mapei.com/images/');

  // Strip query params
  url = url.split('?')[0];

  return url;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
