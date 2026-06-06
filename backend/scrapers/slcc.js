/**
 * SLCC Flooring — Image & Attribute Enrichment Scraper
 *
 * Products already imported from PDF price list. This scraper visits
 * slccflooring.com to capture product images and specifications.
 *
 * Strategy:
 *   1. Crawl category pages → discover collection sub-pages
 *   2. Crawl each collection page → discover product URLs
 *   3. Match product URLs to DB by vendor_sku in the URL slug
 *   4. Visit each product page with Puppeteer:
 *      - Extract images from WooCommerce gallery slider (index 0 = primary, rest = alternate)
 *      - Extract specifications table → upsert as sku_attributes
 *
 * Site structure:
 *   /product-category/products/{type}/ → .../{collection}/ → /product/{slug}/
 *   Gallery: .woocommerce-product-gallery__wrapper > .woocommerce-product-gallery__image
 *   Specs: table rows with th (label) + td (value) under "SPECIFICATIONS" heading
 *
 * Usage: docker compose exec api node scrapers/slcc.js
 */
import pg from 'pg';
import { delay, upsertMediaAsset, upsertSkuAttribute, filterImageUrls } from './base.js';

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: 5432, database: 'flooring_pim', user: 'postgres', password: 'postgres',
});

const BASE_URL = 'https://www.slccflooring.com';

// Top-level category pages — each contains links to collection sub-pages
const CATEGORY_PAGES = [
  '/product-category/products/engineered-wood-flooring/',
  '/product-category/products/spc-flooring/',
  '/product-category/products/wpc-flooring/',
  '/product-category/products/laminate-flooring/',
  '/product-category/products/solid-wood-flooring/',
  '/product-category/products/glue-down-lvt-flooring/',
];

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Map SLCC spec table labels → our DB attribute slugs
const SPEC_TO_ATTR = {
  'Plank Width':                'plank_width',
  'Plank Length':               'plank_length',
  'Wood Species':               'species',
  'Wear Layer':                 'wear_layer',
  'Pre-Attached Underlayment':  'underlayer',
  'Surface':                    'surface_texture',
  'Edge Type':                  'edge_type',
  'Wood Color':                 'color',
  'Wood Shade':                 'shade_variation',
  'Sound Rating':               'certification',
  'Installation Type':          'installation',
  'Scratch & Stain Resistant':  'features',
  'Water Performance Level':    'features',
  'Residential Warranty':       'features',
  'Commercial Warranty':        'features',
  'Thickness':                  'thickness',
  'Construction':               'construction',
  'Weight':                     'weight',
  'Grade':                      'material_class',
};

// "features"-type specs get concatenated rather than overwriting each other.
// We collect them separately and join at the end.
const FEATURES_LABELS = new Set([
  'Scratch & Stain Resistant',
  'Water Performance Level',
  'Residential Warranty',
  'Commercial Warranty',
]);

function normalizeCode(code) {
  return code.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Fetch HTML via native fetch and extract links matching a pattern.
// Handles both absolute (https://...) and relative (/path/...) hrefs.
// Retries on 429 with exponential backoff.
async function fetchLinks(url, pattern) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await fetch(url, { headers: { 'User-Agent': UA } });
      if (resp.status === 429) {
        const wait = (attempt + 1) * 10000;
        console.log(`    429 rate-limited, retrying in ${wait / 1000}s...`);
        await delay(wait);
        continue;
      }
      if (!resp.ok) { console.log(`    fetch ${resp.status} for ${url}`); return []; }
      const html = await resp.text();
      const links = new Set();
      const origin = new URL(url).origin;
      const regex = /href="([^"]*?)"/g;
      let m;
      while ((m = regex.exec(html)) !== null) {
        let href = m[1];
        if (href.startsWith('/')) href = origin + href;           // relative → absolute
        if (!href.startsWith('http')) continue;                   // skip #, javascript:, etc.
        if (pattern.test(href)) links.add(href.replace(/\/$/, '') + '/');
      }
      return [...links];
    } catch (err) {
      console.log(`    fetch error for ${url}: ${err.message}`);
      return [];
    }
  }
  return [];
}

// Step 1: Get collection sub-page URLs from a category page.
// Also crawls /page/2/, /page/3/ etc. in case collections span multiple pages.
async function getCollectionUrls(categoryPath) {
  const allLinks = new Set();
  let pageNum = 1;

  while (pageNum <= 5) {
    const url = pageNum === 1
      ? `${BASE_URL}${categoryPath}`
      : `${BASE_URL}${categoryPath.replace(/\/$/, '')}/page/${pageNum}/`;

    const links = await fetchLinks(url, /\/product-category\/products\/[^/]+\/[^/]+\//);
    let added = 0;
    for (const l of links) {
      const path = new URL(l).pathname;
      if (/\/page\/\d+\//.test(path) || /\/feed\//.test(path)) continue;
      if (path === categoryPath) continue;
      if (!path.startsWith(categoryPath.replace(/\/$/, ''))) continue;
      if (!allLinks.has(l)) { allLinks.add(l); added++; }
    }

    // If we're on page 1, check if /page/2/ exists; otherwise stop
    if (pageNum === 1) {
      const page2Url = `${BASE_URL}${categoryPath.replace(/\/$/, '')}/page/2/`;
      try {
        const r = await fetch(page2Url, { method: 'HEAD', headers: { 'User-Agent': UA }, redirect: 'follow' });
        if (!r.ok) break;
      } catch { break; }
    } else if (added === 0) {
      break; // no new collections on this page
    }

    pageNum++;
    await delay(1000);
  }

  return [...allLinks];
}

// Step 2: Get product URLs from a collection page (may have pagination)
async function getProductUrls(collectionUrl) {
  const products = new Set();
  let url = collectionUrl;
  let pageNum = 1;

  while (url && pageNum <= 10) {
    const links = await fetchLinks(url, /\/product\/[^/]+\//);
    for (const l of links) {
      if (l.includes('/product/') && !l.includes('/product-category/')) {
        products.add(l);
      }
    }

    const nextPage = pageNum + 1;
    const nextUrl = collectionUrl.replace(/\/$/, '') + `/page/${nextPage}/`;
    try {
      const resp = await fetch(nextUrl, { method: 'HEAD', headers: { 'User-Agent': UA }, redirect: 'follow' });
      if (resp.ok) { url = nextUrl; pageNum++; }
      else break;
    } catch { break; }
  }
  return [...products];
}

// Strip WordPress thumbnail dimension suffixes to get full-size URL
function getFullSizeUrl(url) {
  return url.replace(/-\d+x\d+(\.[a-zA-Z]+)(\?.*)?$/, '$1');
}

/**
 * Extract gallery images and specifications from a product detail page using fetch.
 * No headless browser needed — WooCommerce gallery data is in the static HTML.
 * Returns { images: string[], specs: Record<string, string> }
 */
async function extractProductPage(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await fetch(url, { headers: { 'User-Agent': UA } });
      if (resp.status === 429) {
        const wait = (attempt + 1) * 10000;
        console.log(`    429 rate-limited, retrying in ${wait / 1000}s...`);
        await delay(wait);
        continue;
      }
      if (!resp.ok) {
        console.log(`    fetch ${resp.status} for ${url}`);
        return { images: [], specs: {} };
      }
      const html = await resp.text();

      // ── Images: WooCommerce gallery data-large_image attributes (ordered) ──
      const images = [];
      const seen = new Set();
      // Match gallery image divs with data-large_image on the img tag
      const imgRegex = /data-large_image="([^"]+)"/g;
      let m;
      while ((m = imgRegex.exec(html)) !== null) {
        let src = m[1].split('?')[0];
        if (seen.has(src)) continue;
        if (src.includes('placeholder') || src.includes('woocommerce-placeholder')) continue;
        seen.add(src);
        images.push(src);
      }

      // ── Specifications table: <th>Label</th><td>Value</td> ──
      const specs = {};
      const trRegex = /<tr[^>]*>\s*<th[^>]*>([\s\S]*?)<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<\/tr>/gi;
      while ((m = trRegex.exec(html)) !== null) {
        const k = m[1].replace(/<[^>]+>/g, '').trim();
        const v = m[2].replace(/<[^>]+>/g, '').trim();
        if (k && v) specs[k] = v;
      }

      return { images, specs };
    } catch (err) {
      console.log(`    Error fetching page: ${err.message}`);
      return { images: [], specs: {} };
    }
  }
  return { images: [], specs: {} };
}

/**
 * Save gallery images for a product.
 * Preserves SLCC's gallery slider order exactly:
 * Index 0 → primary, 1–2 → alternate, 3+ → lifestyle.
 */
async function saveImages(productId, imageUrls) {
  // Filter junk, deduplicate, get full-size versions
  const fullSized = imageUrls.map(u => getFullSizeUrl(u));
  const cleaned = filterImageUrls(fullSized, { maxImages: 8 });
  if (!cleaned.length) return 0;

  let saved = 0;
  for (let i = 0; i < cleaned.length; i++) {
    const assetType = i === 0 ? 'primary' : (i <= 2 ? 'alternate' : 'lifestyle');
    await upsertMediaAsset(pool, {
      product_id: productId,
      sku_id: null,
      asset_type: assetType,
      url: cleaned[i],
      original_url: cleaned[i],
      sort_order: i,
    });
    saved++;
  }
  return saved;
}

/**
 * Save scraped specifications as sku_attributes for a product's main SKU(s).
 * Merges "features"-type specs into a single semicolon-separated value.
 */
async function saveSpecs(mainSkuIds, specs) {
  if (!mainSkuIds?.length || !Object.keys(specs).length) return 0;

  let saved = 0;
  const featureParts = [];

  for (const [label, value] of Object.entries(specs)) {
    // Skip collection/SKU — already stored on product/sku rows
    if (label === 'Collection' || label === 'SKU' || label === 'Sqft Per BOX') continue;

    const attrSlug = SPEC_TO_ATTR[label];
    if (!attrSlug) continue;

    if (FEATURES_LABELS.has(label)) {
      // Accumulate features for later
      if (value && value.toLowerCase() !== 'n/a') {
        featureParts.push(`${label}: ${value}`);
      }
      continue;
    }

    // Write to each main (non-accessory) SKU
    for (const skuId of mainSkuIds) {
      if (!skuId) continue;
      await upsertSkuAttribute(pool, skuId, attrSlug, value);
      saved++;
    }
  }

  // Write concatenated features
  if (featureParts.length > 0) {
    const featuresValue = featureParts.join('; ');
    for (const skuId of mainSkuIds) {
      if (!skuId) continue;
      await upsertSkuAttribute(pool, skuId, 'features', featuresValue);
      saved++;
    }
  }

  return saved;
}

const BATCH_SIZE = 20;

async function run() {
  const vendorRes = await pool.query("SELECT id FROM vendors WHERE code = 'SLCC'");
  if (!vendorRes.rows.length) { console.error('SLCC vendor not found'); return; }
  const vendorId = vendorRes.rows[0].id;

  // Get all products and their main SKU vendor codes
  const dbProducts = await pool.query(`
    SELECT p.id as product_id, p.name, p.collection,
           array_agg(DISTINCT s.vendor_sku) FILTER (WHERE s.variant_type IS NULL) as vendor_skus,
           array_agg(DISTINCT s.id) FILTER (WHERE s.variant_type IS NULL) as main_sku_ids
    FROM products p
    JOIN skus s ON s.product_id = p.id
    WHERE p.vendor_id = $1
    GROUP BY p.id, p.name, p.collection
    ORDER BY p.collection, p.name
  `, [vendorId]);

  // Check which already have a primary image (product-level)
  const existingImages = await pool.query(`
    SELECT DISTINCT ma.product_id
    FROM media_assets ma
    JOIN products p ON p.id = ma.product_id
    WHERE p.vendor_id = $1 AND ma.sku_id IS NULL AND ma.asset_type = 'primary'
  `, [vendorId]);
  const alreadyHasImage = new Set(existingImages.rows.map(r => r.product_id));

  // We scrape everything (for attributes) but only save images for those missing them
  console.log(`Total products: ${dbProducts.rowCount}`);
  console.log(`Already have images: ${alreadyHasImage.size}`);
  console.log(`Need images: ${dbProducts.rowCount - alreadyHasImage.size}\n`);

  // Build lookup by normalized vendor_sku
  const productByCode = new Map();
  for (const row of dbProducts.rows) {
    if (row.vendor_skus) {
      for (const code of row.vendor_skus) {
        if (code) productByCode.set(normalizeCode(code), row);
      }
    }
  }

  // ── Step 1: Discover collection sub-pages ──
  console.log('=== Step 1: Discovering collection pages ===');
  const allCollectionUrls = [];
  for (const cat of CATEGORY_PAGES) {
    console.log(`\nCategory: ${cat}`);
    const collections = await getCollectionUrls(cat);
    console.log(`  Found ${collections.length} collection pages`);
    for (const c of collections) console.log(`    ${c}`);
    allCollectionUrls.push(...collections);
    await delay(3000);
  }
  const uniqueCollections = [...new Set(allCollectionUrls)];
  console.log(`\nTotal unique collection pages: ${uniqueCollections.length}\n`);

  // ── Step 2: Discover product URLs ──
  console.log('=== Step 2: Discovering product URLs ===');
  const allProductUrls = new Set();
  for (const collUrl of uniqueCollections) {
    const products = await getProductUrls(collUrl);
    for (const p of products) allProductUrls.add(p);
    const name = collUrl.split('/').filter(Boolean).pop();
    if (products.length > 0) console.log(`  ${name}: ${products.length} products`);
    await delay(2000);
  }
  const uniqueUrls = [...allProductUrls];
  console.log(`\nTotal unique product URLs: ${uniqueUrls.length}\n`);

  // ── Step 3: Match URLs to DB products by vendor_sku in slug ──
  console.log('=== Step 3: Matching URLs to DB products ===');
  const matches = [];
  const unmatched = [];

  // Sort by longest code first to avoid partial matches
  const sortedCodes = [...productByCode.entries()].sort((a, b) => b[0].length - a[0].length);

  for (const url of uniqueUrls) {
    const slug = url.replace(/\/+$/, '').split('/').pop() || '';
    const normSlug = normalizeCode(slug);
    let dbProd = null;

    // Try to find the vendor_sku in the URL slug
    for (const [normCode, prod] of sortedCodes) {
      if (normCode.length >= 4 && normSlug.includes(normCode)) {
        dbProd = prod;
        break;
      }
    }

    // Also try matching by product name at end of slug
    if (!dbProd) {
      for (const prod of dbProducts.rows) {
        const nameSlug = normalizeCode(prod.name);
        if (nameSlug.length >= 4 && normSlug.endsWith(nameSlug)) {
          dbProd = prod;
          break;
        }
      }
    }

    if (dbProd) {
      matches.push({ url, dbProd });
    } else {
      unmatched.push(slug);
    }
  }

  console.log(`Matched: ${matches.length}`);
  console.log(`Unmatched: ${unmatched.length}`);
  if (unmatched.length > 0 && unmatched.length <= 30) {
    console.log('Unmatched slugs:');
    for (const s of unmatched) console.log(`  ${s}`);
  }
  console.log();

  // ── Step 4: Scrape images + attributes via fetch ──
  console.log('=== Step 4: Scraping images & attributes ===');
  let totalImagesSaved = 0;
  let totalAttrsSaved = 0;
  let productsScraped = 0;
  const scrapedProductIds = new Set();

  try {
    for (const { url, dbProd } of matches) {
      if (scrapedProductIds.has(dbProd.product_id)) continue;

      console.log(`  ${dbProd.name} (${dbProd.collection}) → ${url}`);
      const { images, specs } = await extractProductPage(url);

      // Save images — always upsert to fix any wrong primary/secondary ordering
      let imgCount = 0;
      if (images.length > 0) {
        imgCount = await saveImages(dbProd.product_id, images);
        totalImagesSaved += imgCount;
      }

      // Save attributes (always update to latest from site)
      const attrCount = await saveSpecs(dbProd.main_sku_ids, specs);
      totalAttrsSaved += attrCount;

      const parts = [];
      if (imgCount > 0) parts.push(`${imgCount} img`);
      if (attrCount > 0) parts.push(`${attrCount} attr`);
      if (parts.length) {
        console.log(`    Saved ${parts.join(', ')}`);
      } else if (images.length === 0) {
        console.log(`    [NO IMAGES on page]`);
      } else {
        console.log(`    [already has images, ${Object.keys(specs).length} specs checked]`);
      }

      productsScraped++;
      scrapedProductIds.add(dbProd.product_id);
      await delay(1500);
    }

    console.log(`\n=== Scrape Complete ===`);
    console.log(`Products scraped: ${productsScraped}`);
    console.log(`Total images saved: ${totalImagesSaved}`);
    console.log(`Total attributes saved: ${totalAttrsSaved}`);
    console.log(`Products still missing images: ${dbProducts.rowCount - alreadyHasImage.size - (totalImagesSaved > 0 ? productsScraped : 0)}`);

  } finally {
    await pool.end();
  }
}

run().catch(err => { console.error(err); process.exit(1); });
