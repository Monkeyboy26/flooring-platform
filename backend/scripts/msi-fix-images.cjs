#!/usr/bin/env node
/**
 * MSI Shared Image Fix — Phase 2 (Page-Fetching)
 *
 * For MSI products that STILL share primary images after running
 * msi-fix-shared-images.cjs (CDN URL guessing), this script:
 *
 *   Phase 1: Recover usable original_url from media_assets (no network for DB)
 *   Phase 2: Fetch MSI product pages via sitemap + URL construction, extract images
 *   Phase 3: Crawl category listing pages as last resort
 *
 * Usage:
 *   node backend/scripts/msi-fix-images.cjs --dry-run          # Preview only
 *   node backend/scripts/msi-fix-images.cjs --phase 1          # Only Phase 1
 *   node backend/scripts/msi-fix-images.cjs --limit 50         # Cap page fetches
 *   node backend/scripts/msi-fix-images.cjs --verbose          # Extra logging
 */
const { Pool } = require('pg');
const https = require('https');
const http = require('http');

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const DRY_RUN = process.argv.includes('--dry-run');
const VERBOSE = process.argv.includes('--verbose');
const phaseIdx = process.argv.indexOf('--phase');
const PHASE_FILTER = phaseIdx !== -1 ? parseInt(process.argv[phaseIdx + 1]) : null;
const limitIdx = process.argv.indexOf('--limit');
const FETCH_LIMIT = limitIdx !== -1 ? parseInt(process.argv[limitIdx + 1]) : Infinity;

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const BASE = 'https://www.msisurfaces.com';
const CDN = 'https://cdn.msisurfaces.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const DELAY_MS = 1500;
const CONCURRENCY = 5;

const CATEGORY_URL_MAP = {
  'LVP (Plank)': ['luxury-vinyl-flooring'],
  'Waterproof Wood': ['luxury-vinyl-flooring', 'waterproof-hybrid-rigid-core'],
  'Porcelain Tile': ['porcelain-tile'],
  'Large Format Tile': ['large-format-tile', 'porcelain-tile'],
  'Natural Stone': ['marble-tile', 'travertine-tile', 'granite-tile', 'quartzite-tile', 'slate-tile', 'sandstone-tile', 'limestone-tile', 'onyx-tile'],
  'Marble Countertops': ['marble-countertops'],
  'Granite Countertops': ['granite-countertops'],
  'Quartzite Countertops': ['quartzite-countertops'],
  'Mosaic Tile': ['mosaics'],
  'Backsplash Tile': ['backsplash-tile'],
  'Backsplash & Wall Tile': ['backsplash-tile'],
  'Hardscaping': ['hardscape'],
  'Pavers': ['hardscape/arterra-porcelain-pavers', 'hardscape/pavers'],
  'Stacked Stone': ['stacked-stone', 'hardscape/rockmount-stacked-stone'],
  'Engineered Hardwood': ['w-luxury-genuine-hardwood'],
  'Transitions & Moldings': ['luxury-vinyl-flooring'],
};

const CATEGORY_PAGES = [
  '/porcelain-tile/', '/marble-tile/', '/travertine-tile/',
  '/granite-tile/', '/quartzite-tile/', '/slate-tile/',
  '/sandstone-tile/', '/limestone-tile/', '/onyx-tile/',
  '/wood-look-tile-and-planks/', '/large-format-tile/',
  '/luxury-vinyl-flooring/', '/waterproof-hybrid-rigid-core/',
  '/w-luxury-genuine-hardwood/',
  '/hardscape/rockmount-stacked-stone/', '/hardscape/arterra-porcelain-pavers/',
  '/hardscape/cobbles/', '/hardscape/stepping-stones/',
  '/hardscape/pavers/', '/hardscape/outdoor-tile/',
  '/mosaics/collections-mosaics/',
  '/backsplash-tile/subway-tile/', '/backsplash-tile/glass-tile/',
  '/backsplash-tile/geometric-pattern/', '/backsplash-tile/stacked-stone-collection/',
  '/backsplash-tile/encaustic-pattern/', '/backsplash-tile/specialty-shapes-wall-tile/',
  '/backsplash-tile/rio-lago-pebbles-mosaics/', '/backsplash-tile/waterjet-cut-mosaics/',
  '/stacked-stone/',
  '/quartz-countertops/', '/granite-countertops/',
  '/marble-countertops/', '/quartzite-countertops/',
];

const GENERIC_WORDS = new Set([
  'porcelain', 'ceramic', 'marble', 'granite', 'travertine',
  'quartzite', 'slate', 'sandstone', 'limestone', 'onyx', 'tile', 'tiles',
  'plank', 'planks', 'flooring', 'wood', 'vinyl', 'luxury', 'collection',
  'series', 'waterproof', 'hybrid', 'rigid', 'core', 'look', 'matte',
  'polished', 'honed', 'mosaic', 'backsplash', 'wall', 'floor', 'natural',
  'stone', 'slab', 'countertop', 'countertops', 'paver', 'pavers',
  'stacked', 'ledger', 'panel', 'prefab', 'vanity', 'top', 'tops',
  'engineered', 'hardwood',
]);

// Rejected image paths (generic/non-product)
const REJECT_PATHS = ['/colornames/', '/blogs/', '/thumbnails/', '/miscellaneous/',
  '/flyers/', '/brochures/'];

// ---------------------------------------------------------------------------
// Helpers (adapted from msi-fix-shared-images.cjs + msi-images.js)
// ---------------------------------------------------------------------------

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function cleanName(name) {
  return name
    .replace(/[-\s]*\d+\/\d+-\d+mm\s*$/i, '')
    .replace(/[-\s]*[\d.]+x[\d.]+-\d+\/\d+-\d+mm$/i, '')
    .replace(/[-\s]*[\d.]+x[\d.]+\s*$/i, '')
    .replace(/\s*-\s*$/, '')
    .trim();
}

function headUrl(url) {
  return new Promise(resolve => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.request(url, { method: 'HEAD', timeout: 6000, headers: { 'User-Agent': UA } }, res => {
      resolve(res.statusCode === 200 ? url : null);
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

async function headBatch(urls, concurrency = 10) {
  const results = new Array(urls.length).fill(null);
  let idx = 0;
  async function worker() {
    while (idx < urls.length) {
      const i = idx++;
      results[i] = await headUrl(urls[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, () => worker()));
  return results;
}

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function fetchText(url, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const resp = await fetch(url, {
        headers: { 'User-Agent': UA },
        redirect: 'follow',
        signal: AbortSignal.timeout(30000),
      });
      if (resp.status === 429) {
        const wait = Math.pow(2, attempt) * 10000;
        console.log(`  429 rate-limited on ${url}, waiting ${wait / 1000}s...`);
        await delay(wait);
        continue;
      }
      if (!resp.ok) return null;
      return await resp.text();
    } catch (err) {
      if (attempt < retries) {
        await delay(3000);
        continue;
      }
      return null;
    }
  }
  return null;
}

function imageScore(url) {
  const lower = url.toLowerCase();
  if (lower.includes('/detail/')) return 100;
  if (lower.includes('/front/')) return 80;
  if (lower.includes('/iso/')) return 60;
  if (lower.includes('/edge/')) return 50;
  if (lower.includes('/vignette/')) return 40;
  if (lower.includes('/variations/')) return 35;
  if (lower.includes('/roomscenes/')) return 20;
  if (lower.includes('/trims/')) return 5;
  if (lower.includes('/thumbnails/')) return 1;
  return 30;
}

function isRejectedPath(url) {
  const lower = url.toLowerCase();
  return REJECT_PATHS.some(p => lower.includes(p));
}

function getNameKeywords(name) {
  return (name || '').toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length >= 3 && !GENERIC_WORDS.has(w));
}

// Extract images from MSI product page HTML (no DOM/Puppeteer needed)
function extractImagesFromHtml(html, productName) {
  const images = [];
  const seen = new Set();
  const keywords = getNameKeywords(productName);

  function addImg(url, score, trusted) {
    if (!url || seen.has(url)) return;
    if (!url.includes('cdn.msisurfaces.com')) return;
    if (isRejectedPath(url)) return;
    if (/\.(svg|gif|ico)(\?|$)/i.test(url)) return;
    if (/icon|logo|badge|placeholder|roomvo|wetcutting/i.test(url)) return;
    // Keyword check for untrusted sources
    if (!trusted && keywords.length > 0) {
      const urlLower = decodeURIComponent(url).toLowerCase();
      if (!keywords.some(kw => urlLower.includes(kw))) return;
    }
    seen.add(url);
    images.push({ url, score });
  }

  // 1. og:image meta tag (most reliable)
  const ogMatch = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
  if (ogMatch) addImg(ogMatch[1].replace(/&amp;/g, '&'), 200, true);

  // 2. JSON-LD structured data
  const jsonLdRegex = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let jm;
  while ((jm = jsonLdRegex.exec(html)) !== null) {
    try {
      const data = JSON.parse(jm[1]);
      const extractLdImages = (obj) => {
        if (!obj) return;
        if (obj.image) {
          const imgs = Array.isArray(obj.image) ? obj.image : [obj.image];
          imgs.forEach(u => { if (typeof u === 'string') addImg(u, 190, true); });
        }
        if (obj['@graph']) {
          for (const item of obj['@graph']) extractLdImages(item);
        }
      };
      extractLdImages(data);
    } catch {}
  }

  // 3. All CDN URLs in HTML body
  const cdnRegex = /https?:\/\/cdn\.msisurfaces\.com\/images\/[^"'\s)<>]+\.(?:jpg|jpeg|png|webp)/gi;
  let cm;
  while ((cm = cdnRegex.exec(html)) !== null) {
    const imgUrl = cm[0].replace(/&amp;/g, '&');
    addImg(imgUrl, imageScore(imgUrl), false);
  }

  // Sort by score descending
  images.sort((a, b) => b.score - a.score);
  return images;
}

// ---------------------------------------------------------------------------
// Sitemap + URL matching
// ---------------------------------------------------------------------------

async function fetchSitemapUrls() {
  console.log('  Fetching sitemap.xml...');
  const xml = await fetchText(`${BASE}/sitemap.xml`);
  if (!xml) { console.log('  Failed to fetch sitemap.xml'); return []; }

  const urls = [];
  const locRegex = /<loc>\s*(https?:\/\/[^<]+)\s*<\/loc>/g;
  let m;
  while ((m = locRegex.exec(xml)) !== null) {
    urls.push(m[1].trim());
  }

  // Filter to product-level URLs
  const productUrls = urls.filter(u => {
    const path = new URL(u).pathname;
    const segments = path.split('/').filter(Boolean);
    if (segments.length < 2) return false;
    if (/\.(aspx|html)$/i.test(path)) return false;
    if (/\/(corporate|news|blog|locations|site-search|dealer|customer|vendor|room-visualizer|inspiration|merchandising|faq|privacy|brochures|flyers|silica|radon|sds|helpful|right-to|msivideo|slabphoto|linktomsi|msi-retailer|new-products|shopping)/i.test(path)) return false;
    return true;
  });

  console.log(`  Sitemap: ${urls.length} total, ${productUrls.length} product URLs`);
  return productUrls;
}

function matchProductToSitemapUrl(product, sitemapUrls) {
  const cleaned = cleanName(product.name);
  const nameSlug = slugify(cleaned);
  const collSlug = product.collection ? slugify(product.collection) : '';

  // Score each sitemap URL by match quality
  let best = null;
  let bestScore = 0;

  for (const url of sitemapUrls) {
    const path = new URL(url).pathname.toLowerCase();
    const segments = path.split('/').filter(Boolean);
    const lastSeg = segments[segments.length - 1] || '';

    // Exact name slug in last segment
    if (lastSeg === nameSlug) {
      return url; // perfect match
    }

    // Name slug contained in last segment
    if (lastSeg.includes(nameSlug) && nameSlug.length >= 4) {
      const score = nameSlug.length / lastSeg.length;
      if (score > bestScore) { bestScore = score; best = url; }
    }

    // Collection + name in path
    if (collSlug && path.includes(collSlug) && path.includes(nameSlug)) {
      return url;
    }
  }

  return bestScore > 0.4 ? best : null;
}

function constructPageUrls(product) {
  const cleaned = cleanName(product.name);
  const nameSlug = slugify(cleaned);
  const collSlug = product.collection ? slugify(product.collection) : '';
  const dispSlug = product.display_name ? slugify(cleanName(product.display_name)) : nameSlug;

  const urls = [];
  const catPrefixes = CATEGORY_URL_MAP[product.category] || [];

  for (const prefix of catPrefixes) {
    // category/collection/name/
    if (collSlug) {
      urls.push(`${BASE}/${prefix}/${collSlug}/${nameSlug}/`);
      urls.push(`${BASE}/${prefix}/${collSlug}-${nameSlug}/`);
    }
    // category/name/
    urls.push(`${BASE}/${prefix}/${nameSlug}/`);
    if (dispSlug !== nameSlug) {
      urls.push(`${BASE}/${prefix}/${dispSlug}/`);
    }
  }

  return [...new Set(urls)];
}

// Fetch category listing page and extract product links
async function fetchCategoryProductUrls(categoryPath) {
  const html = await fetchText(`${BASE}${categoryPath}`);
  if (!html) return [];

  const urls = new Set();
  const linkRegex = /href="(\/[^"]+\/[^"]+\/)"/g;
  let m;
  while ((m = linkRegex.exec(html)) !== null) {
    const path = m[1];
    const segments = path.split('/').filter(Boolean);
    if (segments.length < 2) continue;
    if (/\/(colors|features|benefits|faq|resources|installation|gallery|videos?|warranty|care|cleaning|about|how-to|design-trends|site-search|corporate|news|blog)\/?$/i.test(path)) continue;
    if (/\.(aspx|html|pdf|jpg|png)$/i.test(path)) continue;
    const last = segments[segments.length - 1];
    if (/^\d+\s*[-x]\s*\d+/.test(last)) continue;
    urls.add(`${BASE}${path}`);
  }
  return [...urls];
}

// ---------------------------------------------------------------------------
// Worker pool for concurrent fetching with rate limiting
// ---------------------------------------------------------------------------

async function runWorkerPool(tasks, concurrency, processFn) {
  let idx = 0;
  const results = [];

  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      try {
        const result = await processFn(tasks[i], i);
        if (result) results.push(result);
      } catch (err) {
        if (VERBOSE) console.log(`  Worker error: ${err.message}`);
      }
      await delay(DELAY_MS);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker()));
  return results;
}

// ---------------------------------------------------------------------------
// Phase 1: Recover original_url
// ---------------------------------------------------------------------------

async function phase1(client, sharedProducts, urlUsageMap) {
  console.log('\n' + '='.repeat(60));
  console.log('PHASE 1: Recover usable original_url from media_assets');
  console.log('='.repeat(60) + '\n');

  // Get original_urls for these products
  const productIds = sharedProducts.map(p => p.product_id);
  const { rows: origRows } = await client.query(`
    SELECT m.id as media_id, m.product_id, m.url, m.original_url
    FROM media_assets m
    WHERE m.product_id = ANY($1) AND m.asset_type = 'primary' AND m.sku_id IS NULL
      AND m.original_url IS NOT NULL
      AND m.original_url != m.url
      AND m.original_url LIKE '%cdn.msisurfaces.com%'
  `, [productIds]);

  console.log(`  Products with recoverable original_url: ${origRows.length}`);

  let fixed = 0;
  let checked = 0;
  const remaining = new Set(productIds);

  // Filter out rejected paths and already-shared URLs
  const candidates = origRows.filter(r => {
    if (isRejectedPath(r.original_url)) return false;
    const usage = urlUsageMap.get(r.original_url) || 0;
    if (usage >= 3) return false;
    return true;
  });

  console.log(`  After filtering rejected/shared: ${candidates.length} to check\n`);

  // HEAD-check in batches
  const urls = candidates.map(c => c.original_url);
  const headResults = await headBatch(urls, 10);

  for (let i = 0; i < candidates.length; i++) {
    checked++;
    const c = candidates[i];
    if (!headResults[i]) continue;

    const product = sharedProducts.find(p => p.product_id === c.product_id);
    const shortUrl = c.original_url.replace('https://cdn.msisurfaces.com/images/', '');
    console.log(`  ✓ ${product ? product.name : c.product_id} → ${shortUrl}`);

    if (!DRY_RUN) {
      await client.query(
        'UPDATE media_assets SET url = $1 WHERE id = $2',
        [c.original_url, c.media_id]
      );
    }

    fixed++;
    remaining.delete(c.product_id);
    // Track new URL usage
    urlUsageMap.set(c.original_url, (urlUsageMap.get(c.original_url) || 0) + 1);
  }

  console.log(`\n  Phase 1 result: ${fixed} fixed, ${checked} checked, ${remaining.size} remaining`);
  return [...remaining];
}

// ---------------------------------------------------------------------------
// Phase 2: Fetch product pages from sitemap + constructed URLs
// ---------------------------------------------------------------------------

async function phase2(client, sharedProducts, remainingIds, urlUsageMap) {
  console.log('\n' + '='.repeat(60));
  console.log('PHASE 2: Fetch MSI product pages for image extraction');
  console.log('='.repeat(60) + '\n');

  const products = sharedProducts.filter(p => remainingIds.includes(p.product_id));
  if (products.length === 0) {
    console.log('  No products remaining for Phase 2.');
    return remainingIds;
  }

  console.log(`  Products to process: ${products.length}`);

  // Step 1: Fetch sitemap
  const sitemapUrls = await fetchSitemapUrls();

  // Step 2: Match products to page URLs
  const productPageMap = []; // { product, pageUrls }
  for (const product of products) {
    const pageUrls = [];

    // Try sitemap match first
    const sitemapMatch = matchProductToSitemapUrl(product, sitemapUrls);
    if (sitemapMatch) pageUrls.push(sitemapMatch);

    // Construct candidate URLs
    const constructed = constructPageUrls(product);
    for (const url of constructed) {
      if (!pageUrls.includes(url)) pageUrls.push(url);
    }

    if (pageUrls.length > 0) {
      productPageMap.push({ product, pageUrls });
    } else if (VERBOSE) {
      console.log(`  No page URL candidates for: ${product.name}`);
    }
  }

  console.log(`  Products with page URL candidates: ${productPageMap.length}`);
  const toFetch = Math.min(productPageMap.length, FETCH_LIMIT);
  console.log(`  Will fetch pages for: ${toFetch} products\n`);

  let fixed = 0;
  let fetched = 0;
  const remaining = new Set(remainingIds);

  // Process with worker pool
  const tasks = productPageMap.slice(0, toFetch);
  await runWorkerPool(tasks, CONCURRENCY, async ({ product, pageUrls }, idx) => {
    // Try each candidate URL until we find one with images
    for (const pageUrl of pageUrls) {
      fetched++;
      const html = await fetchText(pageUrl);
      if (!html) continue;
      if (html.length < 2000) continue; // too short = error page

      // Check for rate limiting
      if (/too many requests|429|rate limit/i.test(html.slice(0, 1000))) {
        console.log(`  Rate limited, waiting 10s...`);
        await delay(10000);
        continue;
      }

      const images = extractImagesFromHtml(html, product.name);
      if (images.length === 0) continue;

      // Select best image that isn't already heavily shared
      let bestImg = null;
      for (const img of images) {
        const usage = urlUsageMap.get(img.url) || 0;
        if (usage >= 3) continue;
        if (img.url === product.current_url) continue; // same as current
        bestImg = img;
        break;
      }

      if (bestImg) {
        const shortUrl = bestImg.url.replace('https://cdn.msisurfaces.com/images/', '');
        console.log(`  ✓ ${product.name} [${product.collection || ''}] → ${shortUrl} (score: ${bestImg.score})`);

        if (!DRY_RUN) {
          await client.query(
            'UPDATE media_assets SET url = $1, original_url = $2 WHERE id = $3',
            [bestImg.url, bestImg.url, product.media_id]
          );
        }

        fixed++;
        remaining.delete(product.product_id);
        urlUsageMap.set(bestImg.url, (urlUsageMap.get(bestImg.url) || 0) + 1);
        return { product_id: product.product_id }; // done with this product
      }
    }

    if (VERBOSE) {
      console.log(`  ✗ ${product.name} — no suitable image found on page`);
    }
    return null;
  });

  console.log(`\n  Phase 2 result: ${fixed} fixed, ${fetched} pages fetched, ${remaining.size} remaining`);
  return [...remaining];
}

// ---------------------------------------------------------------------------
// Phase 3: Crawl category listing pages (last resort)
// ---------------------------------------------------------------------------

async function phase3(client, sharedProducts, remainingIds, urlUsageMap) {
  console.log('\n' + '='.repeat(60));
  console.log('PHASE 3: Crawl category listing pages for remaining products');
  console.log('='.repeat(60) + '\n');

  const products = sharedProducts.filter(p => remainingIds.includes(p.product_id));
  if (products.length === 0) {
    console.log('  No products remaining for Phase 3.');
    return remainingIds;
  }

  console.log(`  Products remaining: ${products.length}`);

  // Build name → product lookup
  const nameLookup = new Map();
  for (const p of products) {
    const key = slugify(cleanName(p.name));
    if (key.length >= 3) nameLookup.set(key, p);
    // Also index by display name
    if (p.display_name) {
      const dk = slugify(cleanName(p.display_name));
      if (dk.length >= 3 && !nameLookup.has(dk)) nameLookup.set(dk, p);
    }
  }

  // Crawl category pages, find product links, match by name
  let fixed = 0;
  let pagesChecked = 0;
  const remaining = new Set(remainingIds);
  const discoveredUrls = new Map(); // product_id → page URL

  for (const catPath of CATEGORY_PAGES) {
    if (remaining.size === 0) break;

    console.log(`  Crawling ${catPath}...`);
    try {
      const productUrls = await fetchCategoryProductUrls(catPath);
      pagesChecked++;

      for (const pageUrl of productUrls) {
        const path = new URL(pageUrl).pathname;
        const segments = path.split('/').filter(Boolean);
        const lastSeg = segments[segments.length - 1] || '';

        // Try matching last segment against remaining product names
        for (const [nameKey, product] of nameLookup) {
          if (!remaining.has(product.product_id)) continue;
          if (lastSeg.includes(nameKey) || nameKey.includes(lastSeg)) {
            if (!discoveredUrls.has(product.product_id)) {
              discoveredUrls.set(product.product_id, pageUrl);
            }
          }
        }
      }

      await delay(800);
    } catch (err) {
      if (VERBOSE) console.log(`    Error: ${err.message}`);
    }
  }

  console.log(`  Discovered ${discoveredUrls.size} product page URLs from category crawl\n`);

  // Fetch each discovered page
  const fetchTasks = [];
  for (const [productId, pageUrl] of discoveredUrls) {
    const product = products.find(p => p.product_id === productId);
    if (product) fetchTasks.push({ product, pageUrls: [pageUrl] });
  }

  const limitedTasks = fetchTasks.slice(0, Math.min(fetchTasks.length, FETCH_LIMIT));

  await runWorkerPool(limitedTasks, CONCURRENCY, async ({ product, pageUrls }) => {
    const pageUrl = pageUrls[0];
    const html = await fetchText(pageUrl);
    if (!html || html.length < 2000) return null;

    const images = extractImagesFromHtml(html, product.name);
    if (images.length === 0) return null;

    let bestImg = null;
    for (const img of images) {
      const usage = urlUsageMap.get(img.url) || 0;
      if (usage >= 3) continue;
      if (img.url === product.current_url) continue;
      bestImg = img;
      break;
    }

    if (bestImg) {
      const shortUrl = bestImg.url.replace('https://cdn.msisurfaces.com/images/', '');
      console.log(`  ✓ ${product.name} → ${shortUrl} (score: ${bestImg.score})`);

      if (!DRY_RUN) {
        await client.query(
          'UPDATE media_assets SET url = $1, original_url = $2 WHERE id = $3',
          [bestImg.url, bestImg.url, product.media_id]
        );
      }

      fixed++;
      remaining.delete(product.product_id);
      urlUsageMap.set(bestImg.url, (urlUsageMap.get(bestImg.url) || 0) + 1);
      return { product_id: product.product_id };
    }

    return null;
  });

  console.log(`\n  Phase 3 result: ${fixed} fixed, ${pagesChecked} category pages crawled, ${remaining.size} remaining`);
  return [...remaining];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`\nMSI Shared Image Fix — Page Fetching${DRY_RUN ? ' (DRY RUN)' : ''}`);
  if (PHASE_FILTER) console.log(`Phase filter: ${PHASE_FILTER} only`);
  if (FETCH_LIMIT < Infinity) console.log(`Fetch limit: ${FETCH_LIMIT}`);
  console.log('='.repeat(60) + '\n');

  const client = await pool.connect();

  try {
    if (!DRY_RUN) await client.query('BEGIN');

    // Get MSI vendor
    const { rows: [vendor] } = await client.query("SELECT id FROM vendors WHERE code = 'MSI'");
    if (!vendor) { console.log('ERROR: MSI vendor not found'); return; }

    // Find all MSI products with shared primary images
    const { rows: allMsi } = await client.query(`
      SELECT p.id as product_id, p.name, p.display_name, p.collection,
             c.name as category, m.url as current_url, m.id as media_id
      FROM media_assets m
      JOIN products p ON p.id = m.product_id
      JOIN vendors v ON v.id = p.vendor_id
      LEFT JOIN categories c ON c.id = p.category_id
      WHERE v.code = 'MSI' AND m.asset_type = 'primary' AND m.sku_id IS NULL
        AND p.status = 'active'
      ORDER BY c.name, p.collection, p.name
    `);

    // Count URL usage to identify shared images
    const urlShareCount = new Map();
    for (const r of allMsi) {
      urlShareCount.set(r.current_url, (urlShareCount.get(r.current_url) || 0) + 1);
    }

    const sharedProducts = allMsi
      .filter(r => urlShareCount.get(r.current_url) > 1)
      .map(r => ({ ...r, share_count: urlShareCount.get(r.current_url) }));

    console.log(`Products with shared primary images: ${sharedProducts.length}\n`);

    if (sharedProducts.length === 0) {
      console.log('Nothing to fix — no shared images found.');
      return;
    }

    // Category breakdown
    const catCounts = {};
    for (const p of sharedProducts) {
      catCounts[p.category || 'Uncategorized'] = (catCounts[p.category || 'Uncategorized'] || 0) + 1;
    }
    console.log('By category:');
    for (const [cat, cnt] of Object.entries(catCounts).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${cat}: ${cnt}`);
    }

    // Top shared images
    const topShared = [...urlShareCount.entries()]
      .filter(([, cnt]) => cnt > 5)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);
    if (topShared.length > 0) {
      console.log('\nTop shared images:');
      for (const [url, cnt] of topShared) {
        const short = url.length > 80 ? '...' + url.slice(-77) : url;
        console.log(`  ${cnt} products → ${short}`);
      }
    }

    // Build URL usage map (across ALL media_assets, not just shared)
    const { rows: urlCounts } = await client.query(`
      SELECT url, COUNT(DISTINCT product_id) as cnt
      FROM media_assets WHERE asset_type = 'primary' AND sku_id IS NULL
      GROUP BY url HAVING COUNT(DISTINCT product_id) > 1
    `);
    const urlUsageMap = new Map(urlCounts.map(r => [r.url, parseInt(r.cnt)]));

    // Run phases
    let remainingIds = sharedProducts.map(p => p.product_id);
    const initialCount = remainingIds.length;

    if (!PHASE_FILTER || PHASE_FILTER === 1) {
      remainingIds = await phase1(client, sharedProducts, urlUsageMap);
    }

    if (!PHASE_FILTER || PHASE_FILTER === 2) {
      remainingIds = await phase2(client, sharedProducts, remainingIds, urlUsageMap);
    }

    if (!PHASE_FILTER || PHASE_FILTER === 3) {
      remainingIds = await phase3(client, sharedProducts, remainingIds, urlUsageMap);
    }

    // Final summary
    const totalFixed = initialCount - remainingIds.length;
    console.log(`\n${'='.repeat(60)}`);
    console.log(`FINAL SUMMARY${DRY_RUN ? ' (DRY RUN)' : ''}:`);
    console.log(`  Started with shared-image products: ${initialCount}`);
    console.log(`  Total fixed:                        ${totalFixed}`);
    console.log(`  Still unfixed:                      ${remainingIds.length}`);

    // List unfixed
    if (remainingIds.length > 0) {
      const unfixed = sharedProducts.filter(p => remainingIds.includes(p.product_id));
      const show = unfixed.slice(0, 40);
      console.log(`\nUnfixed products${unfixed.length > 40 ? ` (showing 40 of ${unfixed.length})` : ''}:`);
      for (const p of show) {
        console.log(`  ${p.name} [${p.collection || ''}] (${p.category}, shared with ${p.share_count})`);
      }
    }

    if (!DRY_RUN) {
      await client.query('COMMIT');
      console.log('\nAll changes committed.');
    } else {
      console.log('\nDry run complete — no changes made.');
    }

  } catch (err) {
    if (!DRY_RUN) {
      try { await client.query('ROLLBACK'); } catch {}
    }
    console.error('\nError:', err.message);
    if (VERBOSE) console.error(err.stack);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
