/**
 * Build Goton Tiles product map from gotontiles.com
 *
 * Extracts per-product, per-color image mappings from Wix warmup data.
 * The warmup JSON is server-rendered in the HTML — no browser needed.
 *
 * Usage: node backend/scripts/build-goton-product-map.cjs
 * Output: backend/data/goton-product-map.json
 */
const fs = require('fs');
const path = require('path');

const BASE_URL = 'https://www.gotontiles.com';
const WIX_STORES_APP_ID = '1380b703-ce81-ff05-f115-39571d94dfcd';
const OUTPUT = path.join(__dirname, '..', 'data', 'goton-product-map.json');

// Known glass collection page slugs
const GLASS_PAGE_SLUGS = [
  'glass-stone-mosaic',
  'glass-stone-mosaic-basketweave-and-linear-line',
  'glass-metal-lineal-mosaic',
  'glass-quartzite-mosaic',
  'glass-tile',
];

// Extra slugs from import script that may not appear in the listing
const EXTRA_SLUGS = [
  'cimaron', 'cimarron', 'danube-waves',
  'maysak', 'meranti', 'nabi', 'petrafina',
  'saddlewood', 'simpatico-concrete', 'simpatico-wood',
  'southpoint', 'stream', 'theology', 'travertine',
  'urban', 'vienna-style', 'vintage', 'willow', 'woodcrete',
  'supergres-fog', 'whiteause',
];

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Classify image as product shot vs lifestyle based on title.
 * Chinese 效果图 = rendering/lifestyle.
 */
function classifyImage(title, width, height) {
  const decoded = title ? decodeURIComponent(title) : null;
  const maxDim = Math.max(width || 0, height || 0);
  if (!decoded) {
    // No title: classify by dimensions alone
    // Tall portrait → likely plank scan
    if (height > width * 1.3) return 'product';
    // Large images (>=3000px either dimension) are likely room/exterior scenes,
    // NOT tile face scans (which are typically ≤2000px)
    if (maxDim >= 3000) return 'lifestyle';
    // Medium square (900-3000px, within 5% of square) → tile face scan
    if (width >= 900 && height >= 900 && Math.abs(width - height) / Math.max(width, height) < 0.05) return 'product';
    return 'unknown';
  }
  // ── Lifestyle indicators (checked first, before product rules) ──
  // Chinese 效果图 = rendering, 场景 = scene
  if (decoded.includes('\u6548\u679C\u56FE') || decoded.includes('\u573A\u666F')) return 'lifestyle';
  if (/render|scene/i.test(decoded)) return 'lifestyle';
  // AMBIENTE (Italian) = room scene — always lifestyle regardless of tile codes in filename
  // Matches: "Amb" (whole word), "AMBIENTE", "_AMB-", "_AMB_", "AMB_", "AMB " at start
  if (/\bAmb(?:iente)?\b|[_\s]AMB[-_.\d\s]|^AMB[-_\s]/i.test(decoded)) return 'lifestyle';
  if (/room|interior|kitchen|bath|living|moodboard/i.test(decoded)) return 'lifestyle';
  // Chinese 合层 = merged layers (Photoshop composite) — always a scene render
  if (/\u5408\u5C42/.test(decoded)) return 'lifestyle';
  // Multi-tile-code titles (codes joined with +) = composite layout/room shot
  // e.g. "36C131+60C131+N048-C131T+H028-C131"
  if (/\d{2}[A-Z]\d{3}.*\+.*\d{2}[A-Z]\d{3}/i.test(decoded)) return 'lifestyle';
  // Chinese 图 prefix at large size = room/scene render (small = product diagram)
  if (decoded.startsWith('\u56FE') && maxDim >= 3000) return 'lifestyle';
  // Chinese catalog pages: 画册 = catalog, 系列+number = series promo
  if (/\u753B\u518C/.test(decoded)) return 'lifestyle';
  if (/\u7CFB\u5217\d/.test(decoded)) return 'lifestyle';
  // Chinese product-name + pattern code (海岸木-J137-B321 = installed scene)
  // EXCEPT K/N prefix codes which are mosaic sheet close-ups (石化-K050-B336)
  if (/^[\u4e00-\u9fff]+-[A-Z]\d{3}-/.test(decoded) && !/^[\u4e00-\u9fff]+-[KN]\d{2,3}/i.test(decoded)) return 'lifestyle';
  // Chinese 副本 (copy) — lifestyle UNLESS it contains a tile/mosaic code
  if (/\u526F\u672C/.test(decoded) && !/\d{2}[A-Z]\d{3}/.test(decoded) && !/^GM[LH]?\d{3}/i.test(decoded) && !/^[NHK]\d{2,3}[A-Z]?[-_]/i.test(decoded)) return 'lifestyle';
  // Scaled photos are typically room/promo shots
  if (/-scaled\.(jpg|png)$/i.test(decoded)) return 'lifestyle';
  // ── Product indicators ──
  // Tall portrait = plank/panel scan
  if (height > width * 1.3) return 'product';
  if (/\d{3,}[A-Z]?Y?\s*[\(（]/.test(decoded)) return 'product';
  if (/swatch|silo|scan|panel|plank/i.test(decoded)) return 'product';
  if (/CROSS|VEIN|DECORO|MATT|POLISH|F\d+#?[._]/i.test(decoded)) return 'product';
  // Goton internal tile codes: "60B191.jpg", "45D161.jpg", "36B404.jpg", "49C214 副本.jpg"
  if (/^\d{2,4}[A-Z]\d{3}/i.test(decoded)) return 'product';
  // Glass mosaic codes: "gm103.jpg", "GML402 副本.jpg", "GMH614_edited.jpg"
  if (/^GM[LH]?\d{3}/i.test(decoded)) return 'product';
  // Full-width GM codes: "ＧＭ５０１+GM503"
  if (/\uFF27\uFF2D/i.test(decoded)) return 'product';
  // Chinese 图 prefix at small size = product diagram
  if (decoded.startsWith('\u56FE')) return 'product';
  // Product codes with L prefix: "LB748511-.jpg", "LC960531.jpg", "LG316-01==-.jpg"
  if (/^L[BCGK]\d{4,}/i.test(decoded)) return 'product';
  // Mosaic pattern thumbnails: "K050-B411.jpg", "K078-C402B.jpg", "N048-C400T.jpg"
  if (/^[KN]\d{3}-[BC]\d{3}/i.test(decoded)) return 'product';
  // Floor layout thumbs: "FLB326YG.jpg", "FLC402G.jpg"
  if (/^FL[BC]\d{3}/i.test(decoded)) return 'product';
  // Square large images are typically product face scans
  if (width >= 900 && height >= 900 && Math.abs(width - height) / Math.max(width, height) < 0.05) return 'product';
  // Small numbered images (01.png, 02.png) in Vetro glass = product swatches
  if (/^\d{2}\.(png|jpg)$/i.test(decoded)) return 'product';
  // European dimension format: "Bella Stone Cream 59,5x119,2 1.jpg", "BIANCO 600x1200mm-1.jpg"
  if (/\d+[,.]?\d*\s*x\s*\d+/i.test(decoded)) return 'product';
  if (/^M\d{6}/i.test(decoded)) return 'product';
  // Numbered product images: "224-.jpg", "224--.jpg"
  if (/^\d{3}-+\.(jpg|png)$/i.test(decoded)) return 'product';
  return 'unknown';
}

/**
 * Fetch a page and extract #wix-warmup-data JSON.
 */
async function fetchWarmupData(url) {
  const resp = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Accept': 'text/html,application/xhtml+xml',
    },
  });
  if (!resp.ok) return null;
  const html = await resp.text();

  // Extract the warmup data JSON from the HTML (attribute order varies)
  const match = html.match(/<script[^>]*id="wix-warmup-data"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) return null;

  try {
    return JSON.parse(match[1]);
  } catch (e) {
    return null;
  }
}

/**
 * Extract product data from a product page's warmup JSON.
 */
function parseProductData(warmup) {
  const storeData = warmup?.appsWarmupData?.[WIX_STORES_APP_ID];
  if (!storeData) return null;

  const key = Object.keys(storeData).find(k => k.startsWith('productPage_'));
  if (!key) return null;

  const product = storeData[key]?.catalog?.product;
  if (!product) return null;

  return {
    name: product.name,
    productType: product.productType,
    description: product.description || '',
    options: (product.options || []).map(o => ({
      title: o.title,
      type: o.optionType,
      selections: (o.selections || []).map(s => ({
        id: s.id,
        description: s.description,
        value: s.value,
        key: s.key,
        linkedMedia: (s.linkedMediaItems || []).map(m => ({
          url: m.url,
          fullUrl: m.fullUrl,
          title: m.title,
          width: m.width,
          height: m.height,
          mediaType: m.mediaType,
        })),
      })),
    })),
    media: (product.media || []).map(m => ({
      url: m.url,
      fullUrl: m.fullUrl,
      title: m.title,
      width: m.width,
      height: m.height,
      mediaType: m.mediaType,
    })),
  };
}

/**
 * Extract listing slugs from the product listing page.
 */
function parseListingSlugs(warmup) {
  const storeData = warmup?.appsWarmupData?.[WIX_STORES_APP_ID];
  if (!storeData) return [];

  const key = Object.keys(storeData).find(k => k.startsWith('initialData_'));
  if (!key) return [];

  const list = storeData[key]?.catalog?.category?.productsWithMetaData?.list;
  if (!list) return [];

  return list.map(p => ({
    name: p.name,
    slug: p.urlPart,
    ribbon: p.ribbon || '',
  }));
}

async function run() {
  console.log('Building Goton product map...\n');

  // Step 1: Get product slugs from listing page
  console.log('Fetching product listing...');
  const listingWarmup = await fetchWarmupData(`${BASE_URL}/product`);
  const listingSlugs = listingWarmup ? parseListingSlugs(listingWarmup) : [];
  console.log(`  Found ${listingSlugs.length} products in listing\n`);

  // Merge with extra slugs and glass pages
  const allSlugs = new Map();
  for (const item of listingSlugs) {
    allSlugs.set(item.slug, { name: item.name, ribbon: item.ribbon, source: 'listing' });
  }
  for (const slug of GLASS_PAGE_SLUGS) {
    if (!allSlugs.has(slug))
      allSlugs.set(slug, { name: slug, ribbon: '', source: 'glass' });
  }
  for (const slug of EXTRA_SLUGS) {
    if (!allSlugs.has(slug))
      allSlugs.set(slug, { name: slug, ribbon: '', source: 'extra' });
  }
  console.log(`Total slugs to check: ${allSlugs.size}\n`);

  // Step 2: Visit each product page and extract data
  const productMap = {};
  let scraped = 0, failed = 0;

  for (const [slug, meta] of allSlugs) {
    scraped++;
    process.stdout.write(`  [${scraped}/${allSlugs.size}] ${slug}...`);

    const warmup = await fetchWarmupData(`${BASE_URL}/product-page/${slug}`);
    const data = warmup ? parseProductData(warmup) : null;

    if (!data) {
      console.log(' SKIP (no data)');
      failed++;
      await delay(300);
      continue;
    }

    // Build per-color image map
    const colorOption = data.options.find(o => o.title === 'Color' || o.type === 'COLOR');
    const colors = {};
    if (colorOption) {
      for (const sel of colorOption.selections) {
        if (sel.description === 'ALL') continue;
        colors[sel.description] = {
          colorValue: sel.value,
          images: sel.linkedMedia.map(m => ({
            url: m.url,
            fullUrl: m.fullUrl,
            title: m.title,
            width: m.width,
            height: m.height,
            type: classifyImage(m.title, m.width, m.height),
          })),
        };
      }
    }

    // Classify all media
    const allMedia = data.media.map(m => ({
      url: m.url,
      fullUrl: m.fullUrl,
      title: m.title,
      width: m.width,
      height: m.height,
      type: classifyImage(m.title, m.width, m.height),
    }));

    productMap[data.name] = {
      slug,
      ribbon: meta.ribbon,
      source: meta.source,
      description: data.description,
      options: data.options.map(o => o.title),
      colorCount: Object.keys(colors).length,
      colors,
      mediaCount: allMedia.length,
      productShots: allMedia.filter(m => m.type === 'product').length,
      lifestyleShots: allMedia.filter(m => m.type === 'lifestyle').length,
      allMedia,
    };

    console.log(` OK (${Object.keys(colors).length} colors, ${allMedia.length} media)`);
    await delay(500 + Math.random() * 300);
  }

  // Build summary
  const productNames = Object.keys(productMap);
  const totalColors = productNames.reduce((sum, n) => sum + productMap[n].colorCount, 0);
  const totalMedia = productNames.reduce((sum, n) => sum + productMap[n].mediaCount, 0);

  const output = {
    generated: new Date().toISOString(),
    domain: 'www.gotontiles.com',
    summary: {
      products: productNames.length,
      failed,
      totalColors,
      totalMedia,
    },
    products: productMap,
  };

  fs.writeFileSync(OUTPUT, JSON.stringify(output, null, 2));
  console.log(`\nProduct map saved to ${OUTPUT}`);
  console.log(`Products: ${productNames.length} | Colors: ${totalColors} | Media: ${totalMedia} | Failed: ${failed}`);
}

run().catch(err => { console.error(err); process.exit(1); });
