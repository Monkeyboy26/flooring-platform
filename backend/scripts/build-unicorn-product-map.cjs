/**
 * Build Unicorn Tiles product map from unicorntiles.com
 *
 * Scrapes all product pages and extracts per-variant images with labels.
 * Each image is classified as 'product' or 'lifestyle' based on filename.
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
 * Classify image by filename:
 *  - 'product'   = clean product shot (tile face, close-up, swatch)
 *  - 'lifestyle' = room scene, rendering, installed view
 */
function classifyImage(filename) {
  const f = filename.toLowerCase();
  if (/scene|room|interior|kitchen|bath|living|ambiente|render|display|styled|setting|showroom|installed|design-photo/i.test(f)) return 'lifestyle';
  // "Onda-Design-Photos" style names are lifestyle/catalog shots
  if (/design.photo/i.test(f)) return 'lifestyle';
  return 'product';
}

/**
 * Extract all wp-content/uploads images from a product page HTML.
 * Returns array of { url, fullUrl, alt, label, filename, type }.
 */
function extractImages(html, pageUrl) {
  const images = [];
  const seen = new Set();

  // Pattern 1: img tags with alt text (variant product images)
  const imgRegex = /<img[^>]*(?:src|data-src|data-large_image)="([^"]*\/wp-content\/uploads\/[^"]+\.(?:jpg|jpeg|png|webp))"[^>]*alt="([^"]*)"[^>]*/gi;
  let m;
  while ((m = imgRegex.exec(html)) !== null) {
    processImage(m[1], m[2]);
  }

  // Pattern 2: alt before src (some pages use this order)
  const imgRegex2 = /<img[^>]*alt="([^"]*)"[^>]*(?:src|data-src|data-large_image)="([^"]*\/wp-content\/uploads\/[^"]+\.(?:jpg|jpeg|png|webp))"[^>]*/gi;
  while ((m = imgRegex2.exec(html)) !== null) {
    processImage(m[2], m[1]);
  }

  // Pattern 3: a href wrapping images (full-size links)
  const aRegex = /href="([^"]*\/wp-content\/uploads\/[^"]+\.(?:jpg|jpeg|png|webp))"/gi;
  while ((m = aRegex.exec(html)) !== null) {
    processImage(m[1], '');
  }

  function processImage(src, alt) {
    if (!src) return;
    let url = src;
    if (url.startsWith('/')) url = BASE_URL + url;

    // Skip logos, icons, favicons, banners
    if (/logo|icon|favicon|banner/i.test(url)) return;

    // Get full-size URL (strip -300x300 or -WxH thumbnails)
    const fullUrl = url.replace(/-\d+x\d+(\.[a-zA-Z]+)$/, '$1');
    if (seen.has(fullUrl)) return;
    seen.add(fullUrl);

    const filename = fullUrl.split('/').pop() || '';
    const type = classifyImage(filename);

    images.push({
      url: filename,
      fullUrl,
      alt: alt || '',
      type,
    });
  }

  return images;
}

/**
 * Parse the slug from a product URL.
 */
function slugFromUrl(url) {
  return url.replace(/\/+$/, '').split('/').pop() || '';
}

/**
 * Extract color/size info from an image filename.
 * Pattern: {Series}-{details}.jpg
 * Returns { color, size, finish } best-effort.
 */
function parseFilename(filename, series) {
  // Remove extension and thumbnail suffix
  let base = filename.replace(/\.[a-z]+$/i, '').replace(/-\d+x\d+$/, '');

  // Remove series prefix (case-insensitive)
  const seriesNorm = series.replace(/[^a-zA-Z0-9]/g, '-');
  const prefixRegex = new RegExp(`^${seriesNorm}-`, 'i');
  base = base.replace(prefixRegex, '');

  // Remove trailing number (image sequence number like -1, -2, -3)
  base = base.replace(/-\d+$/, '');

  return base; // e.g. "3x12-White-Bianco-Glossy" or "24x24-Black-Polished"
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

    const images = extractImages(html, url);

    // Separate product shots from lifestyle
    const productShots = images.filter(i => i.type === 'product');
    const lifestyleShots = images.filter(i => i.type === 'lifestyle');

    products[slug] = {
      url,
      imageCount: images.length,
      productShots: productShots.length,
      lifestyleShots: lifestyleShots.length,
      images: images.map(img => ({
        url: img.url,
        fullUrl: img.fullUrl,
        alt: img.alt,
        type: img.type,
        parsed: parseFilename(img.url, slug),
      })),
    };

    totalImages += images.length;
    console.log(`    ${productShots.length} product + ${lifestyleShots.length} lifestyle = ${images.length} total`);

    await delay(1500);
  }

  // Step 3: Write output
  const output = {
    generated: new Date().toISOString(),
    domain: 'unicorntiles.com',
    summary: {
      products: Object.keys(products).length,
      failed,
      totalImages,
      productShots: Object.values(products).reduce((s, p) => s + p.productShots, 0),
      lifestyleShots: Object.values(products).reduce((s, p) => s + p.lifestyleShots, 0),
    },
    products,
  };

  fs.writeFileSync(OUTPUT, JSON.stringify(output, null, 2));
  console.log(`\n=== Done ===`);
  console.log(`Products: ${output.summary.products}`);
  console.log(`Failed: ${output.summary.failed}`);
  console.log(`Total images: ${output.summary.totalImages}`);
  console.log(`Product shots: ${output.summary.productShots}`);
  console.log(`Lifestyle shots: ${output.summary.lifestyleShots}`);
  console.log(`Saved to: ${OUTPUT}`);
}

run().catch(err => { console.error(err); process.exit(1); });
