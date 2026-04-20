/**
 * Gaia Flooring — Image & Data Enrichment Scraper
 *
 * Products already imported from PDF price list (import-gaia.js). This scraper
 * visits gaiafloor.com to capture product images, descriptions, and specs.
 *
 * Strategy:
 *   1. Crawl collection listing pages to discover product URLs + SKU codes
 *   2. Match to DB products by color name and vendor_sku
 *   3. Fetch each product page and extract images, description, specs
 *   4. Save images to media_assets, update product descriptions
 *
 * Site structure (Magento 2):
 *   - Collection pages: /flooring/eterra-espc-spc/{white,red,black}-series
 *                       /flooring/nearwood (all Nearwood together)
 *   - Product pages at root: /alpaca, /torino, /athena, /vista, etc.
 *   - Images under: /media/catalog/product/cache/{hash}/{a}/{b}/filename.jpg
 *   - Typical gallery: room scene, product swatch, swatch portrait, texture
 *
 * Usage: docker compose exec api node scrapers/gaia.js [--force]
 */
import pg from 'pg';
import { delay, filterImageUrls, saveProductImages, saveSkuImages, preferProductShot } from './base.js';

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: 5432, database: 'flooring_pim', user: 'postgres', password: 'postgres',
});

const BASE_URL = 'https://gaiafloor.com';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const FORCE = process.argv.includes('--force');

// Collection listing pages to crawl for product URLs
const COLLECTION_PAGES = [
  `${BASE_URL}/flooring/eterra-espc-spc/white-series`,
  `${BASE_URL}/flooring/eterra-espc-spc/red-series`,
  `${BASE_URL}/flooring/eterra-espc-spc/black-series`,
  `${BASE_URL}/flooring/nearwood/white-collection`,
  `${BASE_URL}/flooring/nearwood/red-collection`,
  `${BASE_URL}/flooring/nearwood/black-collection`,
];

function normalizeForMatch(str) {
  return str.toLowerCase().replace(/[^a-z0-9]/g, '');
}

async function fetchHtml(url) {
  try {
    const resp = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow' });
    if (!resp.ok) return null;
    return resp.text();
  } catch { return null; }
}

// ─── Step 1: Discover product URLs from collection listing pages ───

/**
 * Parse a collection listing page for product cards.
 * Each card has: name, vendor SKU code, and product URL.
 *
 * HTML structure (Magento 2):
 *   <li class="product-item">
 *     <a class="product-item-link" href="https://gaiafloor.com/grey-fox">Grey Fox</a>
 *     <div>GA652310</div>
 *   </li>
 */
function extractProductsFromListing(html) {
  const products = [];
  const seen = new Set();

  // Match product item blocks: find all links pointing to root-level product pages
  // Product URLs are at root: gaiafloor.com/alpaca, gaiafloor.com/grey-fox
  const linkPattern = /href="(https:\/\/gaiafloor\.com\/([a-z0-9][a-z0-9-]+[a-z0-9]))"/gi;
  let m;
  while ((m = linkPattern.exec(html)) !== null) {
    const url = m[1];
    const slug = m[2];

    // Skip non-product pages
    if (slug.includes('/') || slug === 'flooring' || slug === 'checkout' ||
        slug === 'customer' || slug === 'gaiaview' || slug === 'every-step-matters' ||
        slug === 'dealer-resources' || slug.startsWith('san-') ||
        slug.startsWith('los-') || slug.startsWith('dallas') ||
        slug === 'seattle' || slug === 'resources' ||
        slug === 'every-step-matters' || slug === 'define-your-style') continue;

    if (seen.has(url)) continue;
    seen.add(url);
    products.push({ url, slug });
  }

  // Now extract name + SKU code from the surrounding text for each product
  // Pattern: product name followed by SKU code like "Grey Fox\nGA652310"
  const skuPattern = />([\w\s'-]+?)(?:\s+Herringbone)?\s*<[\s\S]*?(GA\w{5,10}(?:AB)?)/gi;
  const skuMap = new Map(); // slug → { name, vendorSku }
  let sm;
  while ((sm = skuPattern.exec(html)) !== null) {
    const rawName = sm[1].trim();
    const vendorSku = sm[2];
    // Find which product this belongs to by checking nearby links
    const context = html.substring(Math.max(0, sm.index - 500), sm.index + 500);
    for (const p of products) {
      if (context.includes(p.url)) {
        skuMap.set(p.slug, { name: rawName, vendorSku });
        break;
      }
    }
  }

  // Enrich products with name/SKU data
  for (const p of products) {
    const info = skuMap.get(p.slug);
    if (info) {
      p.name = info.name;
      p.vendorSku = info.vendorSku;
    } else {
      // Derive name from slug: "grey-fox" → "Grey Fox"
      p.name = p.slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    }
  }

  return products;
}

// ─── Step 2: Extract data from product detail pages ───

/**
 * Extract gallery images from a product page HTML.
 *
 * Gaia's Magento 2 pages define their gallery in:
 *   <script type="text/x-magento-init">
 *     { "[data-gallery-role=gallery-placeholder]": {
 *         "mage/gallery/gallery": { "data": [ { "full": "...", "img": "...", ... } ] }
 *     }}
 *   </script>
 *
 * We parse that JSON to get the actual product gallery images (full resolution).
 * Falls back to og:image + color-name-filtered regex if JSON extraction fails.
 */
function extractImagesFromHtml(html, colorSlug) {
  // ─── Strategy 1: Parse Magento gallery JSON (most reliable) ───
  const galleryImages = extractMagentoGallery(html);
  if (galleryImages.length) return galleryImages;

  // ─── Strategy 2: og:image + color-filtered regex fallback ───
  const imgs = [];
  const seen = new Set();

  const ogMatch = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i) ||
                  html.match(/<meta\s+content="([^"]+)"\s+property="og:image"/i);
  if (ogMatch && !ogMatch[1].includes('logo') && !ogMatch[1].includes('favicon')) {
    const src = ogMatch[1];
    if (!seen.has(src)) { seen.add(src); imgs.push(src); }
  }

  // Only grab images whose filename contains the color slug (e.g. "grey-fox")
  // This filters out sibling color swatches and accessory images
  if (colorSlug) {
    const slugVariants = [
      colorSlug,                             // grey-fox
      colorSlug.replace(/-/g, '_'),          // grey_fox
      colorSlug.replace(/-/g, ''),           // greyfox
    ];
    const imgPattern = /(?:src|data-src|href)="(https?:\/\/gaiafloor\.com\/media\/catalog\/product\/[^"]+\.(?:jpg|jpeg|png|webp))"/gi;
    let m;
    while ((m = imgPattern.exec(html)) !== null) {
      const src = m[1];
      const filename = src.split('/').pop().toLowerCase();
      if (!slugVariants.some(v => filename.includes(v))) continue;
      if (src.includes('logo') || src.includes('placeholder')) continue;
      const canonical = src.replace(/\/cache\/[a-f0-9]+\//i, '/cache/x/');
      if (seen.has(canonical)) continue;
      seen.add(canonical);
      const fullSize = src.replace(/\/cache\/[a-f0-9]+\//, '/cache/e127b9e9aadabab3f3667fbb97e7ba38/');
      imgs.push(fullSize);
    }
  }

  return imgs;
}

/**
 * Parse Magento 2 gallery JSON from <script type="text/x-magento-init"> blocks.
 * Returns array of full-resolution image URLs, ordered by position.
 */
function extractMagentoGallery(html) {
  const imgs = [];
  const scriptPattern = /<script\s+type="text\/x-magento-init"\s*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = scriptPattern.exec(html)) !== null) {
    const jsonStr = m[1].trim();
    let parsed;
    try { parsed = JSON.parse(jsonStr); } catch { continue; }

    // Look for gallery-placeholder key
    const galleryKey = Object.keys(parsed).find(k => k.includes('gallery-placeholder'));
    if (!galleryKey) continue;

    const galleryConfig = parsed[galleryKey];
    const gallery = galleryConfig['mage/gallery/gallery'];
    if (!gallery || !Array.isArray(gallery.data)) continue;

    // Sort by position and extract full-resolution URLs
    const sorted = [...gallery.data].sort((a, b) => (Number(a.position) || 0) - (Number(b.position) || 0));
    for (const item of sorted) {
      const url = item.full || item.img || item.thumb;
      if (url && !imgs.includes(url)) imgs.push(url);
    }
  }
  return imgs;
}

/**
 * Extract product description from page HTML.
 */
function extractDescription(html) {
  // Look for description in product info area
  const descMatch = html.match(/Our\s+([\w\s]+?)\s+(?:Luxury Vinyl|Laminate|Engineered)[\s\S]*?(?=<\/(?:p|div)>)/i);
  if (descMatch) {
    // Clean HTML tags and collapse whitespace
    return descMatch[0].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().substring(0, 500);
  }
  return null;
}

/**
 * Extract specifications table from page HTML.
 * Returns object with keys like: wearLayer, underlayment, core, clickSystem, sqftBox, warranty
 */
function extractSpecs(html) {
  const specs = {};
  const seen = new Set();

  // Find table rows with spec data
  const rowPattern = /<t[hd][^>]*>\s*([\w\s/]+?)\s*<\/t[hd]>\s*<td[^>]*>\s*([\s\S]*?)\s*<\/td>/gi;
  let m;
  while ((m = rowPattern.exec(html)) !== null) {
    const label = m[1].trim();
    const value = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (seen.has(label)) continue;
    seen.add(label);

    switch (label.toLowerCase()) {
      case 'wear layer': specs.wearLayer = value; break;
      case 'underlayment': specs.underlayment = value; break;
      case 'core': specs.core = value; break;
      case 'click system': specs.clickSystem = value; break;
      case 'sqft/box': specs.sqftBox = parseFloat(value) || null; break;
      case 'residential warranty': specs.residentialWarranty = value.replace(/\s*Year\s+\w+\s+Warranty$/i, '').trim(); break;
      case 'commercial warranty': specs.commercialWarranty = value.replace(/\s*Year\s+\w+\s+Warranty$/i, '').trim(); break;
    }
  }

  return Object.keys(specs).length ? specs : null;
}

/**
 * Extract the COLOR CODE line: "COLOR CODE: Grey Fox GA652310"
 */
function extractColorCode(html) {
  const m = html.match(/COLOR CODE:\s*([\w\s'-]+?)\s+(GA\w+)/i);
  return m ? { name: m[1].trim(), vendorSku: m[2] } : null;
}

// ─── Step 3: Match website products to DB products ───

function matchProducts(webProducts, dbProducts) {
  const matches = [];
  const matchedDbIds = new Set();

  // Build lookup maps for DB products
  const byNormName = new Map();   // normalized name → dbProd
  const byVendorSku = new Map();  // vendor_sku → dbProd

  for (const db of dbProducts) {
    byNormName.set(normalizeForMatch(db.name), db);
    if (db.vendor_skus) {
      for (const sku of db.vendor_skus) {
        if (sku) byVendorSku.set(sku.toUpperCase(), db);
      }
    }
  }

  for (const web of webProducts) {
    let dbProd = null;

    // Strategy 1: Exact vendor_sku match
    if (web.vendorSku) {
      dbProd = byVendorSku.get(web.vendorSku.toUpperCase());
    }

    // Strategy 2: Normalized name match
    if (!dbProd) {
      const normName = normalizeForMatch(web.name);
      dbProd = byNormName.get(normName);
    }

    // Strategy 3: Slug-based name match (handles "Herringbone" suffix)
    if (!dbProd) {
      const normSlug = normalizeForMatch(web.slug);
      dbProd = byNormName.get(normSlug);
      // Also try without "herringbone" suffix
      if (!dbProd && normSlug.endsWith('herringbone')) {
        const base = normSlug.replace(/herringbone$/, '');
        dbProd = byNormName.get(base);
      }
    }

    // Strategy 4: Fuzzy containment match
    if (!dbProd) {
      const normSlug = normalizeForMatch(web.slug);
      for (const [normName, p] of byNormName.entries()) {
        if (matchedDbIds.has(p.product_id)) continue;
        if (normName.length >= 4 && (normSlug.includes(normName) || normName.includes(normSlug))) {
          dbProd = p;
          break;
        }
      }
    }

    if (dbProd && !matchedDbIds.has(dbProd.product_id)) {
      matches.push({ web, dbProd });
      matchedDbIds.add(dbProd.product_id);
    }
  }

  return { matches, matchedDbIds };
}

// ─── Main ───

async function run() {
  const vendorRes = await pool.query("SELECT id FROM vendors WHERE code = 'GAIA'");
  if (!vendorRes.rows.length) { console.error('GAIA vendor not found. Run import-gaia.js first.'); return; }
  const vendorId = vendorRes.rows[0].id;

  // Load all DB products with their SKU info
  const dbProducts = await pool.query(`
    SELECT p.id as product_id, p.name, p.collection, p.description_short,
           array_agg(DISTINCT s.id) as sku_ids,
           array_agg(DISTINCT s.id) FILTER (WHERE s.variant_type IS NULL) as main_sku_ids,
           array_agg(DISTINCT s.vendor_sku) FILTER (WHERE s.variant_type IS NULL) as vendor_skus
    FROM products p
    JOIN skus s ON s.product_id = p.id
    WHERE p.vendor_id = $1
    GROUP BY p.id, p.name, p.collection, p.description_short
    ORDER BY p.collection, p.name
  `, [vendorId]);

  // Check which products already have images
  const existingImages = await pool.query(`
    SELECT DISTINCT s.product_id
    FROM media_assets ma
    JOIN skus s ON s.id = ma.sku_id
    JOIN products p ON p.id = s.product_id
    WHERE p.vendor_id = $1 AND ma.asset_type = 'primary'
    UNION
    SELECT DISTINCT ma.product_id
    FROM media_assets ma
    JOIN products p ON p.id = ma.product_id
    WHERE p.vendor_id = $1 AND ma.asset_type = 'primary' AND ma.sku_id IS NULL
  `, [vendorId]);
  const alreadyHasImage = new Set(existingImages.rows.map(r => r.product_id));

  const allProducts = dbProducts.rows;
  const needsImages = FORCE ? allProducts : allProducts.filter(r => !alreadyHasImage.has(r.product_id));

  console.log(`Total DB products: ${allProducts.length}`);
  console.log(`Already have images: ${alreadyHasImage.size}`);
  console.log(`Need images: ${needsImages.length}${FORCE ? ' (--force: re-scraping all)' : ''}\n`);

  if (!needsImages.length) { await pool.end(); return; }

  // ═══ Step 1: Crawl collection pages for product URLs ═══
  console.log('=== Step 1: Discovering product URLs from collection pages ===');
  const webProducts = [];
  const seenUrls = new Set();

  for (const collectionUrl of COLLECTION_PAGES) {
    const html = await fetchHtml(collectionUrl);
    if (!html) {
      console.log(`  [FAILED] ${collectionUrl}`);
      continue;
    }
    const found = extractProductsFromListing(html);
    let added = 0;
    for (const p of found) {
      if (!seenUrls.has(p.url)) {
        seenUrls.add(p.url);
        webProducts.push(p);
        added++;
      }
    }
    const pageName = collectionUrl.split('/').pop();
    console.log(`  ${pageName}: ${added} products`);
    await delay(500);
  }
  console.log(`  Total unique product URLs: ${webProducts.length}\n`);

  // ═══ Step 2: Match web products to DB products ═══
  console.log('=== Step 2: Matching to DB products ===');
  const { matches, matchedDbIds } = matchProducts(webProducts, needsImages);

  console.log(`  Matched: ${matches.length} / ${needsImages.length}`);
  const unmatched = needsImages.filter(p => !matchedDbIds.has(p.product_id));
  if (unmatched.length) {
    console.log(`  Unmatched DB products:`);
    for (const p of unmatched) console.log(`    ${p.collection} / ${p.name}`);
  }
  const unmatchedWeb = webProducts.filter(w => !matches.some(m => m.web.url === w.url));
  if (unmatchedWeb.length) {
    console.log(`  Unmatched website products (may be new):`);
    for (const w of unmatchedWeb) console.log(`    ${w.name || w.slug} (${w.vendorSku || 'no SKU'})`);
  }

  // ═══ Step 3: Scrape each product page ═══
  console.log('\n=== Step 3: Scraping product pages ===');
  let imagesSaved = 0;
  let productsWithImages = 0;
  let descriptionsUpdated = 0;

  for (const { web, dbProd } of matches) {
    const html = await fetchHtml(web.url);
    if (!html) {
      console.log(`  ${dbProd.name} → [FETCH FAILED]`);
      await delay(500);
      continue;
    }

    // Extract images — pass color slug so fallback regex can filter by product name
    const rawImages = extractImagesFromHtml(html, web.slug);
    if (!rawImages.length) {
      console.log(`  ${dbProd.name} → [NO IMAGES]`);
      await delay(300);
      continue;
    }

    // Sort: prefer product shots over lifestyle, then filter
    const sorted = preferProductShot(rawImages, dbProd.name);
    const cleaned = filterImageUrls(sorted, { maxImages: 6 });

    // Save images at SKU level if single main SKU, else product level
    const mainSkuIds = (dbProd.main_sku_ids || []).filter(Boolean);
    let saved;
    if (mainSkuIds.length === 1) {
      saved = await saveSkuImages(pool, dbProd.product_id, mainSkuIds[0], cleaned, { maxImages: 6 });
    } else {
      saved = await saveProductImages(pool, dbProd.product_id, cleaned, { maxImages: 6 });
    }
    imagesSaved += saved;
    if (saved > 0) productsWithImages++;

    // Extract and update description if product doesn't have one
    if (!dbProd.description_short) {
      const desc = extractDescription(html);
      if (desc) {
        await pool.query(
          'UPDATE products SET description_short = $1 WHERE id = $2 AND description_short IS NULL',
          [desc, dbProd.product_id]
        );
        descriptionsUpdated++;
      }
    }

    // Extract and update vendor_sku if we got one from the product page
    const colorCode = extractColorCode(html);
    if (colorCode && colorCode.vendorSku && mainSkuIds.length === 1) {
      await pool.query(
        'UPDATE skus SET vendor_sku = $1 WHERE id = $2',
        [colorCode.vendorSku, mainSkuIds[0]]
      );
    }

    const level = mainSkuIds.length === 1 ? 'SKU' : 'product';
    console.log(`  ${dbProd.name} (${dbProd.collection}) → ${saved} image(s) at ${level} level`);
    await delay(1000);
  }

  console.log(`\n=== Scrape Complete ===`);
  console.log(`Products already had images: ${alreadyHasImage.size}`);
  console.log(`Products matched to URLs: ${matches.length}`);
  console.log(`Products scraped with images: ${productsWithImages}`);
  console.log(`Products still missing images: ${needsImages.length - productsWithImages}`);
  console.log(`Total images saved: ${imagesSaved}`);
  console.log(`Descriptions updated: ${descriptionsUpdated}`);

  await pool.end();
}

run().catch(err => { console.error(err); process.exit(1); });
