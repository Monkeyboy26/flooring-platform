/**
 * Build Unicorn Tiles product map from unicorntiles.com
 *
 * Scrapes all product pages and extracts images based on DOM position:
 *  - Left column: Nectar slider with background-image CSS → lifestyle/room scenes
 *  - Right column: wpb_gallery with <img> tags + alt text → per-color product shots
 *
 * Usage: node backend/scripts/build-unicorn-product-map.cjs
 * Output: backend/data/unicorn-product-map.json
 */
const fs = require('fs');
const path = require('path');

const BASE_URL = 'https://unicorntiles.com';
const OUTPUT = path.join(__dirname, '..', 'data', 'unicorn-product-map.json');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchHtml(url) {
  const resp = await fetch(url, {
    headers: { 'User-Agent': UA },
    redirect: 'follow',
  });
  if (!resp.ok) { console.error(`  FETCH FAILED ${resp.status}: ${url}`); return null; }
  return resp.text();
}

/**
 * Discover all product page URLs from the /products/ listing.
 */
async function discoverProducts() {
  const urls = new Set();
  const html = await fetchHtml(`${BASE_URL}/products/`);
  if (!html) return [];

  const regex = /href="(https?:\/\/unicorntiles\.com\/products\/[^"]+)"/gi;
  let m;
  while ((m = regex.exec(html)) !== null) {
    const u = m[1].replace(/\/$/, '') + '/';
    if (u !== `${BASE_URL}/products/`) urls.add(u);
  }
  return [...urls].sort();
}

/**
 * Normalize a URL to full-size (strip -300x300 or -WxH thumbnail suffix).
 */
function toFullSize(url) {
  return url.replace(/-\d+x\d+(\.[a-zA-Z]+)$/, '$1');
}

/**
 * Resolve a URL to absolute.
 */
function resolveUrl(src) {
  if (!src) return '';
  if (src.startsWith('//')) return 'https:' + src;
  if (src.startsWith('/')) return BASE_URL + src;
  if (!src.startsWith('http')) return BASE_URL + '/' + src;
  return src;
}

/**
 * Extract images from a product page HTML using DOM-aware parsing.
 *
 * Two distinct sources:
 *  1. Slider (left column): background-image: url(...) inside the nectar slider section
 *  2. Grid (right column): <img> tags with alt/title text (per-color product swatches)
 */
function extractImages(html) {
  const seen = new Set();
  const sliderImages = [];
  const gridImages = [];

  // ── 1. Slider images: background-image URLs from nectar slider ──
  // These are inline styles on swiper-slide divs: style="background-image: url('...')"
  const bgRegex = /background-image:\s*url\(['"]?([^'")]+\/wp-content\/uploads\/[^'")]+)['"]?\)/gi;
  let m;
  while ((m = bgRegex.exec(html)) !== null) {
    const raw = resolveUrl(m[1]);
    const fullUrl = toFullSize(raw);
    if (seen.has(fullUrl)) continue;
    if (/logo|icon|favicon|banner/i.test(fullUrl)) continue;
    seen.add(fullUrl);
    const filename = fullUrl.split('/').pop() || '';
    sliderImages.push({
      url: filename,
      fullUrl,
      alt: '',
      type: 'lifestyle',
      source: 'slider',
    });
  }

  // ── 2. Grid images: <img> tags with src pointing to wp-content/uploads ──
  // These are the per-color product swatches in the right column gallery.
  // Match both orderings: src before alt, and alt before src.
  const imgPatterns = [
    /<img[^>]*(?:src|data-src|data-large_image)="([^"]*\/wp-content\/uploads\/[^"]+\.(?:jpg|jpeg|png|webp))"[^>]*alt="([^"]*)"[^>]*/gi,
    /<img[^>]*alt="([^"]*)"[^>]*(?:src|data-src|data-large_image)="([^"]*\/wp-content\/uploads\/[^"]+\.(?:jpg|jpeg|png|webp))"[^>]*/gi,
  ];

  for (let pi = 0; pi < imgPatterns.length; pi++) {
    const regex = imgPatterns[pi];
    while ((m = regex.exec(html)) !== null) {
      const src = pi === 0 ? m[1] : m[2];
      const alt = pi === 0 ? m[2] : m[1];
      const raw = resolveUrl(src);
      const fullUrl = toFullSize(raw);
      if (seen.has(fullUrl)) continue;
      if (/logo|icon|favicon|banner/i.test(fullUrl)) continue;
      seen.add(fullUrl);
      const filename = fullUrl.split('/').pop() || '';
      gridImages.push({
        url: filename,
        fullUrl,
        alt: alt || '',
        type: 'product',
        source: 'grid',
        colorLabel: alt || '',
      });
    }
  }

  // ── 3. Fallback: <a> href links to full-size images not yet captured ──
  // Some pages wrap product images in <a> tags with href to full-size.
  const aRegex = /href="([^"]*\/wp-content\/uploads\/[^"]+\.(?:jpg|jpeg|png|webp))"/gi;
  while ((m = aRegex.exec(html)) !== null) {
    const raw = resolveUrl(m[1]);
    const fullUrl = toFullSize(raw);
    if (seen.has(fullUrl)) continue;
    if (/logo|icon|favicon|banner/i.test(fullUrl)) continue;
    seen.add(fullUrl);
    const filename = fullUrl.split('/').pop() || '';
    // Classify by filename as fallback
    const isLifestyle = /scene|room|interior|kitchen|bath|living|ambiente|render|display|styled|setting|showroom|installed|design.photo/i.test(filename);
    if (isLifestyle) {
      sliderImages.push({
        url: filename,
        fullUrl,
        alt: '',
        type: 'lifestyle',
        source: 'slider',
      });
    } else {
      gridImages.push({
        url: filename,
        fullUrl,
        alt: '',
        type: 'product',
        source: 'grid',
        colorLabel: '',
      });
    }
  }

  return { sliderImages, gridImages };
}

/**
 * Parse the slug from a product URL.
 */
function slugFromUrl(url) {
  return url.replace(/\/+$/, '').split('/').pop() || '';
}

/**
 * Extract color/size info from an image filename.
 */
function parseFilename(filename, series) {
  let base = filename.replace(/\.[a-z]+$/i, '').replace(/-\d+x\d+$/, '');
  const seriesNorm = series.replace(/[^a-zA-Z0-9]/g, '-');
  const prefixRegex = new RegExp(`^${seriesNorm}-`, 'i');
  base = base.replace(prefixRegex, '');
  base = base.replace(/-\d+$/, '');
  return base;
}

async function run() {
  console.log('=== Building Unicorn Tiles Product Map ===\n');

  // Step 1: Discover all product URLs
  console.log('Step 1: Discovering product URLs...');
  const productUrls = await discoverProducts();
  console.log(`  Found ${productUrls.length} products\n`);

  // Step 2: Scrape each product page
  console.log('Step 2: Scraping product pages...');
  const products = {};
  let totalImages = 0;
  let failed = 0;

  for (const url of productUrls) {
    const slug = slugFromUrl(url);
    console.log(`  ${slug}...`);

    const html = await fetchHtml(url);
    if (!html) {
      failed++;
      await delay(1000);
      continue;
    }

    const { sliderImages, gridImages } = extractImages(html);
    const allImages = [...gridImages, ...sliderImages];

    products[slug] = {
      url,
      imageCount: allImages.length,
      gridCount: gridImages.length,
      sliderCount: sliderImages.length,
      images: allImages.map(img => ({
        url: img.url,
        fullUrl: img.fullUrl,
        alt: img.alt,
        type: img.type,
        source: img.source,
        ...(img.colorLabel ? { colorLabel: img.colorLabel } : {}),
        parsed: parseFilename(img.url, slug),
      })),
    };

    totalImages += allImages.length;
    console.log(`    ${gridImages.length} grid (product) + ${sliderImages.length} slider (lifestyle) = ${allImages.length} total`);

    await delay(1500);
  }

  // Step 3: Write output
  const totalGrid = Object.values(products).reduce((s, p) => s + p.gridCount, 0);
  const totalSlider = Object.values(products).reduce((s, p) => s + p.sliderCount, 0);

  const output = {
    generated: new Date().toISOString(),
    domain: 'unicorntiles.com',
    summary: {
      products: Object.keys(products).length,
      failed,
      totalImages,
      gridImages: totalGrid,
      sliderImages: totalSlider,
    },
    products,
  };

  fs.writeFileSync(OUTPUT, JSON.stringify(output, null, 2));
  console.log(`\n=== Done ===`);
  console.log(`Products: ${output.summary.products}`);
  console.log(`Failed: ${output.summary.failed}`);
  console.log(`Total images: ${output.summary.totalImages}`);
  console.log(`Grid (product) images: ${totalGrid}`);
  console.log(`Slider (lifestyle) images: ${totalSlider}`);
  console.log(`Saved to: ${OUTPUT}`);
}

run().catch(err => { console.error(err); process.exit(1); });
