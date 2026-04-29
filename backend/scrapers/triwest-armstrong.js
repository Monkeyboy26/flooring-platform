import {
  delay, upsertMediaAsset,
  appendLog, addJobError, saveProductImages, saveSkuImages
} from './base.js';

import { createHash } from 'crypto';

const BASE_URL = 'https://www.armstrongflooring.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_ERRORS = 100;

// Known error/meme image hashes (MD5) — reject any image matching these
const ERROR_IMAGE_HASHES = new Set([
  'd0a7127af62d07881dbc4e8a1d29bf26', // IT team meme (577KB)
  'd488a4a8c70e99179bfd4550fccd3297', // placeholder.jpeg (61KB)
  'aab2252aad617be32d88e1aa936cacdf', // tiny blank swatch (~2.9KB)
]);
const MIN_IMAGE_SIZE = 4000; // Reject images smaller than 4KB (blank swatches)

/**
 * Armstrong enrichment scraper for Tri-West — HTTP-only (no Puppeteer).
 *
 * Armstrong product pages are server-rendered HTML with image URLs embedded in
 * og:image meta tags and data-imagegalleryimages attributes, so we can extract
 * everything with plain HTTP fetches + regex/string parsing.
 *
 * Strategy:
 *   Phase A — Auto-discover collections from Armstrong website category pages
 *     1. Crawl commercial + residential category listing pages
 *     2. For each category, extract all collection links
 *     3. For each collection, extract all item codes from item links
 *     4. Build lookup: Map<itemCode, collectionPath>
 *
 *   Phase B — Enrich SKUs with per-SKU images
 *     1. Load all Armstrong SKUs from DB
 *     2. Derive item code from vendor_sku (first 5 chars after "ARM")
 *     3. Look up item code in discovery map → construct item page URL
 *     4. Fetch item page HTML, extract og:image, gallery, PDFs
 *     5. Store images at SKU level, PDFs at product level
 */
export async function run(pool, job, source) {
  const config = source.config || {};
  const delayMs = config.delay_ms || 500;
  const vendor_id = source.vendor_id;

  let errorCount = 0;
  let skusEnriched = 0;
  let skusSkipped = 0;
  let skuImagesAdded = 0;
  let productImagesAdded = 0;
  let pdfsAdded = 0;

  async function logError(msg) {
    errorCount++;
    if (errorCount <= MAX_ERRORS) {
      try { await addJobError(pool, job.id, msg); } catch { }
    }
  }

  try {
    // ──────────────────────────────────────────────
    // Phase A: Auto-discover collections from website
    // ──────────────────────────────────────────────
    await appendLog(pool, job.id, 'Phase A: Discovering collections from Armstrong website...');

    const itemCodeMap = await discoverCollections(delayMs);
    await appendLog(pool, job.id, `Discovery complete: ${itemCodeMap.size} item codes mapped across collections`);

    // ──────────────────────────────────────────────
    // Phase A.5: Fetch browse APIs for validated image URLs
    // ──────────────────────────────────────────────
    await appendLog(pool, job.id, 'Phase A.5: Fetching browse APIs for validated image URLs...');
    const apiImageMap = await fetchBrowseApiImages();
    await appendLog(pool, job.id, `Browse APIs: ${apiImageMap.size} validated item→image mappings`);

    // ──────────────────────────────────────────────
    // Phase B: Enrich SKUs
    // ──────────────────────────────────────────────
    await appendLog(pool, job.id, 'Phase B: Enriching SKUs with images...');

    // Load existing Armstrong products
    const prodResult = await pool.query(`
      SELECT p.id AS product_id, p.name AS product_name, p.collection, p.description_long
      FROM products p
      WHERE p.vendor_id = $1 AND (p.collection LIKE 'Armstrong%' OR p.collection ILIKE 'Armstrong Flooring%')
    `, [vendor_id]);

    // Load SKU data
    const skuResult = await pool.query(`
      SELECT s.id AS sku_id, s.vendor_sku, s.internal_sku, s.variant_name, s.product_id
      FROM skus s
      JOIN products p ON p.id = s.product_id
      WHERE p.vendor_id = $1 AND s.vendor_sku LIKE 'ARM%'
      ORDER BY s.variant_name
    `, [vendor_id]);

    await appendLog(pool, job.id, `Found ${prodResult.rows.length} Armstrong products (${skuResult.rows.length} SKUs)`);
    if (prodResult.rows.length === 0) return;

    // Build SKU lookup by product_id
    const skusByProduct = new Map();
    for (const row of skuResult.rows) {
      if (!skusByProduct.has(row.product_id)) skusByProduct.set(row.product_id, []);
      skusByProduct.get(row.product_id).push(row);
    }

    // Group by product_id
    const productGroups = new Map();
    for (const row of prodResult.rows) {
      if (!productGroups.has(row.product_id)) {
        productGroups.set(row.product_id, {
          product_id: row.product_id,
          product_name: row.product_name,
          collection: row.collection,
          description_long: row.description_long,
          skus: skusByProduct.get(row.product_id) || [],
        });
      }
    }

    // Check existing images
    const armSkuIds = skuResult.rows.map(r => r.sku_id);
    const armProductIds = [...new Set(prodResult.rows.map(r => r.product_id))];

    const existingSkuImages = armSkuIds.length > 0 ? await pool.query(`
      SELECT DISTINCT ma.sku_id FROM media_assets ma
      WHERE ma.sku_id = ANY($1::uuid[]) AND ma.asset_type = 'primary' AND ma.sku_id IS NOT NULL
    `, [armSkuIds]) : { rows: [] };
    const skusWithImages = new Set(existingSkuImages.rows.map(r => r.sku_id));

    const existingProductImages = armProductIds.length > 0 ? await pool.query(`
      SELECT DISTINCT ma.product_id FROM media_assets ma
      WHERE ma.product_id = ANY($1::uuid[]) AND ma.asset_type = 'primary' AND ma.sku_id IS NULL
    `, [armProductIds]) : { rows: [] };
    const productsWithImages = new Set(existingProductImages.rows.map(r => r.product_id));

    // Try to map each SKU to a discovered collection path
    let mappedSkus = 0;
    let unmappedSkus = 0;
    const skuToCollectionPath = new Map(); // sku_id → collectionPath

    for (const group of productGroups.values()) {
      for (const sku of group.skus) {
        const itemCode = deriveItemCode(sku.vendor_sku);
        if (itemCode && itemCodeMap.has(itemCode)) {
          skuToCollectionPath.set(sku.sku_id, itemCodeMap.get(itemCode));
          mappedSkus++;
        } else {
          // Fallback: try static mapping by product name
          const staticPath = mapProductToPath(group.product_name);
          if (staticPath) {
            skuToCollectionPath.set(sku.sku_id, staticPath);
            mappedSkus++;
          } else {
            unmappedSkus++;
          }
        }
      }
    }

    await appendLog(pool, job.id,
      `${productGroups.size} products | ${mappedSkus} SKUs mapped to URLs, ${unmappedSkus} unmapped | ` +
      `${skusWithImages.size} already have images, ${productsWithImages.size} products have images`
    );

    // ──────────────────────────────────────────────
    // Process each product group
    // ──────────────────────────────────────────────
    let productIdx = 0;
    for (const [productId, group] of productGroups) {
      productIdx++;

      // ── Product-level enrichment ──
      // Use the first mapped SKU's collection path for the product page
      const firstMappedSku = group.skus.find(s => skuToCollectionPath.has(s.sku_id));
      if (!productsWithImages.has(productId) && firstMappedSku) {
        try {
          const collectionPath = skuToCollectionPath.get(firstMappedSku.sku_id);
          // Extract the collection page URL (path without /item/...)
          const collectionUrl = `${BASE_URL}${collectionPath}.html`;
          const collectionHtml = await httpGet(collectionUrl);

          if (collectionHtml) {
            const productData = extractCollectionPageData(collectionHtml);

            if (productData.description && !group.description_long) {
              await pool.query(
                'UPDATE products SET description_long = $1 WHERE id = $2 AND description_long IS NULL',
                [productData.description, productId]
              );
            }

            if (productData.images.length > 0) {
              const saved = await saveProductImages(pool, productId, productData.images, { maxImages: 6 });
              productImagesAdded += saved;
            }

            for (let i = 0; i < productData.pdfs.length; i++) {
              await upsertMediaAsset(pool, {
                product_id: productId,
                sku_id: null,
                asset_type: 'spec_pdf',
                url: productData.pdfs[i],
                original_url: productData.pdfs[i],
                sort_order: i,
              });
              pdfsAdded++;
            }
          }
          await delay(delayMs);
        } catch (err) {
          await logError(`Product ${group.product_name}: ${err.message}`);
        }
      }

      // ── SKU-level enrichment ──
      for (const sku of group.skus) {
        if (skusWithImages.has(sku.sku_id)) {
          skusSkipped++;
          continue;
        }

        const itemCode = deriveItemCode(sku.vendor_sku);
        if (!itemCode) {
          skusSkipped++;
          continue;
        }

        // Strategy: prefer API-validated image, fall back to scraping item page
        let images = [];

        // 1. Check browse API for this item code (trusted source, try multiple lengths)
        const apiCode = deriveItemCodeForApi(sku.vendor_sku, apiImageMap);
        const apiImage = apiCode ? apiImageMap.get(apiCode) : null;
        if (apiImage) {
          images.push(apiImage);
        }

        // 2. Fall back to scraping item page if no API image
        const collectionPath = skuToCollectionPath.get(sku.sku_id);
        if (images.length === 0 && collectionPath) {
          try {
            const itemUrl = `${BASE_URL}${collectionPath}/item/${itemCode}.html`;
            const html = await httpGet(itemUrl);
            if (html) {
              images = extractItemImages(html);
            }
            await delay(delayMs);
          } catch (err) {
            await logError(`SKU ${sku.vendor_sku} page fetch: ${err.message}`);
          }
        }

        // 3. Validate scraped images — reject known error/meme images
        //    (API images are trusted and skip validation)
        if (images.length > 0 && !apiImage) {
          const validImages = [];
          for (const imgUrl of images) {
            const isValid = await validateImageUrl(imgUrl);
            if (isValid) validImages.push(imgUrl);
          }
          images = validImages;
        }

        try {
          if (images.length > 0) {
              const saved = await saveSkuImages(pool, productId, sku.sku_id, images, { maxImages: 4 });
              skuImagesAdded += saved;
              skusEnriched++;

          } else {
            skusSkipped++;
          }
        } catch (err) {
          await logError(`SKU ${sku.vendor_sku}: ${err.message}`);
          skusSkipped++;
        }
      }

      if (productIdx % 10 === 0 || productIdx === productGroups.size) {
        await appendLog(pool, job.id,
          `Progress: ${productIdx}/${productGroups.size} products | ` +
          `SKU images: ${skuImagesAdded}, enriched: ${skusEnriched}, skipped: ${skusSkipped} | ` +
          `Product images: ${productImagesAdded}, PDFs: ${pdfsAdded}, errors: ${errorCount}`
        );
      }
    }

    await appendLog(pool, job.id,
      `Complete. ${skusEnriched} SKUs enriched, ${skusSkipped} skipped, ` +
      `${skuImagesAdded} SKU images, ${productImagesAdded} product images, ${pdfsAdded} PDFs, ${errorCount} errors`,
      { products_found: productGroups.size, products_updated: skusEnriched }
    );

  } catch (err) {
    await logError(`Fatal: ${err.message}`);
    throw err;
  }
}

// ──────────────────────────────────────────────
// Phase A: Auto-discovery
// ──────────────────────────────────────────────

/**
 * Category listing pages on the Armstrong website.
 * Each contains links to collection pages.
 */
const CATEGORY_URLS = [
  '/commercial/en-us/products/lvt-luxury-flooring',
  '/commercial/en-us/products/vinyl-composition-tile',
  '/commercial/en-us/products/hom',
  '/commercial/en-us/products/het',
  '/commercial/en-us/products/srf',
  '/commercial/en-us/products/esd',
  '/residential/en-us/engineered-tile/',
];

/**
 * Crawl Armstrong category pages to build a Map<itemCode, collectionPath>.
 */
async function discoverCollections(delayMs) {
  const itemCodeMap = new Map(); // itemCode → collectionPath
  const collectionPaths = new Set();

  // Step 1: Fetch each category page and extract collection links
  for (const catPath of CATEGORY_URLS) {
    const catUrl = `${BASE_URL}${catPath}`;
    const html = await httpGet(catUrl);
    if (!html) continue;

    // Extract collection links from the category page
    // Links look like:
    //   href="/commercial/en-us/products/lvt-luxury-flooring/duo.html"
    //   href="https://www.armstrongflooring.com/commercial/en-us/products/lvt-luxury-flooring/duo.html"
    // We extract the path and strip .html suffix
    const basePath = catPath.replace(/\/$/, '');

    // Match both relative and absolute URLs under this category path
    const linkPattern = new RegExp(
      `href="(?:${escapeRegex(BASE_URL)})?(${escapeRegex(basePath)}/[a-z0-9][a-z0-9_-]*)(?:\\.html)?(?:[?#][^"]*)?\"`,
      'gi'
    );
    let match;
    while ((match = linkPattern.exec(html)) !== null) {
      const path = match[1];
      if (path.includes('/item/')) continue;
      if (path.includes('/browse')) continue;
      // Don't add the category page itself
      if (path === basePath) continue;
      collectionPaths.add(path);
    }

    // Also look for collection links in other category sections on the same page
    // (e.g., the LVT page also shows hardwood collections)
    const genericPattern = new RegExp(
      `href="(?:${escapeRegex(BASE_URL)})?(/(?:commercial|residential)/en-us/products?/[a-z0-9-]+/[a-z0-9][a-z0-9_-]*)(?:\\.html)?(?:[?#][^"]*)?\"`,
      'gi'
    );
    while ((match = genericPattern.exec(html)) !== null) {
      const path = match[1];
      if (path.includes('/item/')) continue;
      if (path.includes('/browse')) continue;
      collectionPaths.add(path);
    }

    await delay(delayMs);
  }

  console.log(`  Discovered ${collectionPaths.size} collection paths`);

  // Step 2: Fetch each collection page and extract item codes
  for (const collPath of collectionPaths) {
    // Append .html?size=999 to get all items on one page
    const collUrl = `${BASE_URL}${collPath}.html?size=999`;
    const html = await httpGet(collUrl);
    if (!html) continue;

    // Extract item codes from links like: /item/ST559.html or /item/51802.html
    const itemPattern = /\/item\/([A-Za-z0-9]+)\.html/g;
    let match;
    let itemCount = 0;
    while ((match = itemPattern.exec(html)) !== null) {
      const code = match[1].toUpperCase();
      if (code.length >= 4 && code.length <= 7) {
        // Map the first 5 chars (our standard item code length) to this collection
        const key = code.slice(0, 5);
        if (!itemCodeMap.has(key)) {
          itemCodeMap.set(key, collPath);
          itemCount++;
        }
        // Also map the full code if different
        if (code !== key && !itemCodeMap.has(code)) {
          itemCodeMap.set(code, collPath);
        }
      }
    }

    if (itemCount > 0) {
      console.log(`  ${collPath}: ${itemCount} item codes`);
    }

    await delay(delayMs);
  }

  return itemCodeMap;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ──────────────────────────────────────────────
// Static mapping fallback: product name → Armstrong website URL path
// ──────────────────────────────────────────────

/**
 * Fallback mapping when auto-discovery doesn't find an item code.
 * Maps product names to Armstrong website collection URL paths.
 * Returns the path (without .html) or null if unmapped.
 */
function mapProductToPath(name) {
  const n = name.toLowerCase();

  // Residential
  if (n.startsWith('alterna') && !n.includes('grout') && !n.includes('classic') && !n.includes('reserve'))
    return '/residential/en-us/engineered-tile/alterna-engineered-tile';

  // Commercial — VCT
  if (n.startsWith('imperial texture'))
    return '/commercial/en-us/products/vinyl-composition-tile/std-excelon-imp-texture';
  if (n.startsWith('crown texture'))
    return '/commercial/en-us/products/vinyl-composition-tile/premium-excelon-crown-texture';
  if (n.startsWith('stonetex'))
    return '/commercial/en-us/products/vinyl-composition-tile/excelon-stonetex';
  if (n.startsWith('feature tile') || n.startsWith('feature strip'))
    return '/commercial/en-us/products/vinyl-composition-tile/excelon-feature-tile-strip';
  if (n === 'static dissipative')
    return '/commercial/en-us/products/esd/static-dissp-excelon-sdt';
  if (n.startsWith('multicolor dry back'))
    return '/commercial/en-us/products/vinyl-composition-tile/excelon-feature-tile-strip';

  // Commercial — Homogeneous sheet
  if (n.startsWith('natralis') && !n.includes('weld'))
    return '/commercial/en-us/products/hom/natralis';
  if (n.startsWith('medintone') || n.startsWith('meditone'))
    return '/commercial/en-us/products/hom/medintone';
  if (n.startsWith('medinpure'))
    return '/commercial/en-us/products/hom/medinpure';

  // Commercial — LVT
  if (n.startsWith('biome'))
    return '/commercial/en-us/products/lvt-luxury-flooring/biome';
  if (n.startsWith('exchange'))
    return '/commercial/en-us/products/lvt-luxury-flooring/exchange';
  if (n.startsWith('theorem'))
    return '/commercial/en-us/products/lvt-luxury-flooring/theorem';
  if (n.startsWith('duo'))
    return '/commercial/en-us/products/lvt-luxury-flooring/duo';
  if (n.startsWith('terra'))
    return '/commercial/en-us/products/lvt-luxury-flooring/terra';
  if (n.startsWith('coalesce'))
    return '/commercial/en-us/products/lvt-luxury-flooring/coalesce';
  if (n.startsWith('unify'))
    return '/commercial/en-us/products/lvt-luxury-flooring/unify';
  if (n.startsWith('natural creations'))
    return '/commercial/en-us/products/lvt-luxury-flooring/natural-creations-with-diamond-10';
  if (n.includes('parallel') && n.includes('12'))
    return '/commercial/en-us/products/lvt-luxury-flooring/parallel-usa-12';
  if (n.includes('parallel') && n.includes('20'))
    return '/commercial/en-us/products/lvt-luxury-flooring/parallel-usa-20';
  if (n.startsWith('kaleido'))
    return '/commercial/en-us/products/lvt-luxury-flooring/kaleido';
  if (n.startsWith('mixtera'))
    return '/commercial/en-us/products/lvt-luxury-flooring/duo';

  // Commercial — Heterogeneous sheet
  if (n.startsWith('nidra'))
    return '/commercial/en-us/products/het/nidra';
  if (n.startsWith('zenscape'))
    return '/commercial/en-us/products/het/zenscape';

  // Commercial — Sheet resilient
  if (n.startsWith('safety zone'))
    return '/commercial/en-us/products/srf/safety-zone';

  return null;
}

// ──────────────────────────────────────────────
// Item code derivation
// ──────────────────────────────────────────────

/**
 * Derive Armstrong item code from Tri-West vendor_sku.
 *
 * Armstrong item codes are always 5 characters. The vendor_sku format is:
 *   "ARM" + {5-char item code} + {packaging suffix of varying length}
 *
 * Examples:
 *   ARMD7106461 → D7106  (Alterna tile)
 *   ARM51802161 → 51802  (Imperial Texture VCT)
 *   ARMH2001    → H2001  (Medintone sheet)
 *   ARM80860    → 80860  (Nidra sheet)
 *   ARMST131641 → ST131  (Biome LVT)
 */
function deriveItemCode(vendorSku) {
  if (!vendorSku || !vendorSku.startsWith('ARM')) return null;
  const inner = vendorSku.slice(3);
  if (inner.length < 5) return null;
  return inner.slice(0, 5).toUpperCase();
}

/**
 * Try multiple item code lengths to match browse API entries.
 * Residential codes can be longer than 5 chars (e.g., 1UP77004, G2905).
 */
function deriveItemCodeForApi(vendorSku, apiMap) {
  if (!vendorSku || !vendorSku.startsWith('ARM')) return null;
  for (const len of [5, 6, 7, 8, 9, 10]) {
    if (3 + len > vendorSku.length) break;
    const code = vendorSku.slice(3, 3 + len).toUpperCase();
    if (apiMap.has(code)) return code;
  }
  return null;
}

// ──────────────────────────────────────────────
// Browse API image source (validated URLs)
// ──────────────────────────────────────────────

/**
 * Fetch Armstrong's browse APIs (residential + commercial) to get
 * validated item code → image URL mappings.
 * These are Armstrong's own curated product images — no memes.
 */
async function fetchBrowseApiImages() {
  const imageMap = new Map();

  try {
    // Residential API
    const resResp = await fetch(
      `${BASE_URL}/residential/api/en-us/browse/products?q=matchall&filters=type:ResidentialProduct&filters=type:Trim&filters=type:IMA&size=999&start=0&region=`,
      { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(20000) }
    );
    if (resResp.ok) {
      const resData = await resResp.json();
      for (const p of (resData.products || [])) {
        const match = p.line1 && p.line1.match(/\|\s*([A-Za-z0-9]+)$/);
        if (match && p.image) {
          imageMap.set(match[1].toUpperCase(), BASE_URL + p.image + '?size=detail');
        }
      }
    }

    // Commercial API
    const comResp = await fetch(
      `${BASE_URL}/commercial/api/en-us/browse/products?q=matchall&size=999&start=0`,
      { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(20000) }
    );
    if (comResp.ok) {
      const comData = await comResp.json();
      for (const p of (comData.products || [])) {
        const code = (p.line2 || '').trim().toUpperCase();
        if (code && p.image && !imageMap.has(code)) {
          imageMap.set(code, BASE_URL + p.image + '?size=detail');
        }
      }
    }
  } catch { /* API unavailable — fall back to scraping */ }

  return imageMap;
}

// ──────────────────────────────────────────────
// Image validation
// ──────────────────────────────────────────────

/**
 * Validate an image URL by downloading it and checking against known
 * error image hashes. Returns false if the image is a known error/meme.
 */
async function validateImageUrl(url) {
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      redirect: 'follow',
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) return false;

    const buffer = Buffer.from(await resp.arrayBuffer());

    // Reject tiny images (blank swatches)
    if (buffer.length < MIN_IMAGE_SIZE) return false;

    // Reject known error images by hash
    const hash = createHash('md5').update(buffer).digest('hex');
    if (ERROR_IMAGE_HASHES.has(hash)) return false;

    return true;
  } catch {
    return false;
  }
}

// ──────────────────────────────────────────────
// HTTP fetching
// ──────────────────────────────────────────────

async function httpGet(url) {
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) return null;
    return await resp.text();
  } catch {
    return null;
  }
}

// ──────────────────────────────────────────────
// HTML parsing (regex-based, no DOM needed)
// ──────────────────────────────────────────────

/**
 * Extract the primary swatch image URL from an Armstrong item page.
 * The og:image meta tag contains the CDN swatch URL.
 */
function extractOgImage(html) {
  const m = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/);
  if (!m) return null;
  const url = m[1];
  // Filter out generic/error images
  if (url.includes('placeholder') || url.includes('error') || url.includes('logo')) return null;
  return url;
}

/**
 * Extract gallery images from the data-imagegalleryimages JSON attribute.
 * Returns array of image URLs (swatch + roomscene).
 */
function extractGalleryImages(html) {
  const images = [];
  const seen = new Set();

  // data-imagegalleryimages contains HTML-entity-encoded JSON
  const m = html.match(/data-imagegalleryimages='([^']+)'/s) ||
            html.match(/data-imagegalleryimages="([^"]+)"/s);
  if (!m) return images;

  try {
    const decoded = m[1]
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#34;/g, '"')
      .replace(/\\u003e/g, '>')
      .replace(/\\u003c/g, '<')
      .replace(/\\u0026/g, '&');
    const gallery = JSON.parse(decoded);

    for (const item of gallery) {
      // Each item has small/medium/large variants with {src, w, h}
      const src = item.large?.src || item.medium?.src || item.small?.src;
      if (src && !seen.has(src.split('?')[0])) {
        seen.add(src.split('?')[0]);
        const fullUrl = src.startsWith('http') ? src : BASE_URL + src;
        // Use ?size=detail for consistent quality
        const normalized = fullUrl.replace(/\?size=\w+/, '?size=detail');
        images.push(normalized.includes('?') ? normalized : normalized + '?size=detail');
      }
    }
  } catch { /* JSON parse failed — that's OK */ }

  return images;
}

/**
 * Extract all images from an Armstrong item page.
 * Priority: og:image first (primary swatch), then gallery images.
 */
function extractItemImages(html) {
  const images = [];
  const seen = new Set();

  // 1. og:image is the primary swatch
  const ogImage = extractOgImage(html);
  if (ogImage) {
    const normalized = ogImage.replace(/\?size=\w+/, '?size=detail');
    const url = normalized.includes('?') ? normalized : normalized + '?size=detail';
    images.push(url);
    seen.add(url.split('?')[0]);
  }

  // 2. Gallery images (may include roomscenes)
  for (const url of extractGalleryImages(html)) {
    if (!seen.has(url.split('?')[0])) {
      seen.add(url.split('?')[0]);
      images.push(url);
    }
  }

  // 3. Fallback: CDN swatch/roomscene URLs from anywhere in the HTML
  const cdnPattern = /(?:https?:)?\/\/(?:www\.)?armstrongflooring\.com\/cdn\/(swatch|roomscene)\/[^"'<>\s]+/g;
  let match;
  while ((match = cdnPattern.exec(html)) !== null) {
    let url = match[0];
    if (url.startsWith('//')) url = 'https:' + url;
    // Filter out generic nav/menu/mega-menu images
    if (url.includes('mega-menu') || url.includes('color-swatches/') || url.includes('header')) continue;
    const normalized = url.replace(/\?size=\w+/, '?size=detail');
    const finalUrl = normalized.includes('?') ? normalized : normalized + '?size=detail';
    if (!seen.has(finalUrl.split('?')[0])) {
      seen.add(finalUrl.split('?')[0]);
      images.push(finalUrl);
    }
  }

  return images;
}

/**
 * Extract PDF links from an Armstrong page.
 */
function extractPdfs(html) {
  const pdfs = [];
  const seen = new Set();
  const pdfPattern = /(?:https?:)?\/\/(?:www\.)?armstrongflooring\.com\/cdn\/(maintenance|warranty|installation|spec)\/[^"'<>\s]+\.pdf/g;
  let match;
  while ((match = pdfPattern.exec(html)) !== null) {
    let url = match[0];
    if (url.startsWith('//')) url = 'https:' + url;
    if (!seen.has(url)) {
      seen.add(url);
      pdfs.push(url);
    }
  }

  // Also look for relative PDF links
  const relPattern = /\/cdn\/(maintenance|warranty|installation|spec)\/[^"'<>\s]+\.pdf/g;
  while ((match = relPattern.exec(html)) !== null) {
    const url = BASE_URL + match[0];
    if (!seen.has(url)) {
      seen.add(url);
      pdfs.push(url);
    }
  }

  return pdfs;
}

/**
 * Extract product-level data from a collection page.
 */
function extractCollectionPageData(html) {
  const result = { images: [], pdfs: [], description: null };

  // Description from og:description
  const descMatch = html.match(/<meta\s+property="og:description"\s+content="([^"]+)"/);
  if (descMatch) {
    const desc = descMatch[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
    if (desc.length > 20 && !desc.toLowerCase().includes('error')) {
      result.description = desc.slice(0, 2000);
    }
  }

  // Gallery images (lifestyle/promo)
  const galleryImages = extractGalleryImages(html);
  for (const url of galleryImages) {
    if (!url.includes('color-swatches/') && !url.includes('mega-menu')) {
      result.images.push(url);
    }
  }

  // PDFs
  result.pdfs = extractPdfs(html);

  return result;
}
