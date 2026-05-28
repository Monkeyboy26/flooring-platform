/**
 * Ottimo Ceramics — Unified Scraper (Shopify + Price List)
 *
 * Primary source: Shopify collection JSON APIs
 *   - /collections/all-tiles/products.json   (~191 tile products)
 *   - /collections/all-mosaics/products.json (~56 mosaic products)
 *
 * Secondary source: ottimo-pricelist.txt (pdftotext output)
 *   - Vendor SKU → cost price, pcs/carton, sqft/carton
 *
 * Replaces the old two-step process (import-ottimo.js + ottimo.js enrichment).
 *
 * Usage: docker compose exec api node scrapers/ottimo.js
 */
import pg from 'pg';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  upsertProduct, upsertSku, upsertPricing, upsertPackaging,
  upsertSkuAttribute, upsertMediaAsset, normalizeSize,
} from './base.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: 5432, database: 'flooring_pim', user: 'postgres', password: 'postgres',
});

const BASE_URL = 'https://ottimoceramics.com';
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MARKUP = 2.0;

const delay = ms => new Promise(r => setTimeout(r, ms));

// ─── Category IDs ───
const CAT = {
  porcelain: '650e8400-e29b-41d4-a716-446655440012',
  ceramic:   '650e8400-e29b-41d4-a716-446655440013',
  mosaic:    '650e8400-e29b-41d4-a716-446655440014',
  pavers:    '650e8400-e29b-41d4-a716-446655440062',
};

// ──────────────────────────────────────────────
// Step 1: Parse Price List into Lookup Map
// ──────────────────────────────────────────────

function isPageHeader(line) {
  const t = line.trim();
  if (!t) return true;
  if (/^\s*Ottimo\s*$/i.test(t)) return true;
  if (/Ceramics,?\s*Inc/i.test(t)) return true;
  if (/Ottimo Item Number/i.test(t)) return true;
  if (/Program Price List/i.test(t)) return true;
  if (/Ceramic\s*\/\s*Wall/i.test(t)) return true;
  if (/Porcelain\s+& Floor/i.test(t)) return true;
  if (/Surcharge/i.test(t)) return true;
  if (/May \d+, \d{4}/i.test(t)) return true;
  if (/Temporary\s+.*Pcs\s+Sft/i.test(t)) return true;
  if (/^\s*7%\s+/.test(t)) return true;
  return false;
}

/**
 * Parse the price list into a Map<vendorSku, { cost, pcsCarton, sqftCarton, sellBy, priceBasis, material, application }>.
 */
function parsePriceList(filePath) {
  const raw = readFileSync(filePath, 'utf-8');
  const lines = raw.split('\n');
  const map = new Map();

  let section = 'mosaic';

  // Tile: SKU  SIZE  Porcelain|Ceramic  Wall & Floor|WALL ONLY|PAVER  DESC  $COST  PCS  SQFT
  const tileRe = /^(\S+?\*?)\s+([\d."'/]+\s*x\s*[\d."'/]+)\s+(Porcelain|Ceramic)\s+(Wall & Floor|WALL ONLY|PAVER)\s+(.+?)\s+\$([\d,.]+)\s+(\d+)\s+([\d.]+)\s*$/i;
  // Tile sold by piece
  const tilePcRe = /^(\S+?\*?)\s+([\d."'/]+\s*x\s*[\d."'/]+)\s+(Porcelain|Ceramic)\s+(Wall & Floor|WALL ONLY|PAVER)\s+(.+?)\s+\$([\d,.]+)\s+Sold by pc\s*$/i;
  // Mosaic: SKU  DESC  $COST  Sold by pc|PCS
  const mosaicRe = /^(\S+(?:\s\d+)?)\s{2,}(.+?)\s+\$([\d,.]+)\s+(Sold by pc|\d+)\s*$/;

  for (const line of lines) {
    if (/Tile\s*-\s*Sold per Carton/i.test(line)) { section = 'tile'; continue; }
    if (/^BULLNOSE\b/i.test(line.trim())) break;
    if (isPageHeader(line)) continue;
    if (/\$0\.00/.test(line)) continue;
    if (/Denotes Bullnose/i.test(line)) continue;

    if (section === 'mosaic') {
      const m = line.match(mosaicRe);
      if (!m) continue;
      const vendorSku = m[1].trim();
      const cost = parseFloat(m[3].replace(',', ''));
      if (cost <= 0) continue;
      map.set(vendorSku, {
        cost,
        pcsCarton: m[4] !== 'Sold by pc' ? parseInt(m[4], 10) : null,
        sqftCarton: null,
        sellBy: 'unit',
        priceBasis: 'per_unit',
        material: null,
        application: null,
      });
    } else {
      let m = line.match(tileRe);
      if (m) {
        const vendorSku = m[1].replace(/\*+$/, '').trim();
        const cost = parseFloat(m[6].replace(',', ''));
        if (cost <= 0) continue;
        map.set(vendorSku, {
          cost,
          pcsCarton: parseInt(m[7], 10),
          sqftCarton: parseFloat(m[8]),
          sellBy: 'box',
          priceBasis: 'per_sqft',
          material: m[3].trim(),
          application: m[4].trim(),
        });
        continue;
      }

      m = line.match(tilePcRe);
      if (m) {
        const vendorSku = m[1].replace(/\*+$/, '').trim();
        const cost = parseFloat(m[6].replace(',', ''));
        if (cost <= 0) continue;
        map.set(vendorSku, {
          cost,
          pcsCarton: null,
          sqftCarton: null,
          sellBy: 'unit',
          priceBasis: 'per_unit',
          material: m[3].trim(),
          application: m[4].trim(),
        });
      }
    }
  }

  return map;
}

/**
 * Build a fuzzy lookup map from price list SKUs.
 * For each price list SKU, generate alternative keys that a Shopify variant might use:
 *   - Strip trailing `-N` suffix (e.g., FAS001-N → FAS001)
 *   - Strip trailing `SP` suffix (e.g., FAS004SP → FAS004)
 *   - Remove `N` inserted before `-digit` suffix (e.g., FLD010N-1 → FLD010-1, FLD010N-2 → FLD010)
 * Only the first match wins (exact map takes priority; within fuzzy, first registered key wins).
 * Each entry stores { ...priceData, _plSku } so we can track which PL SKU was consumed.
 */
function buildFuzzyMap(priceMap) {
  const fuzzy = new Map();

  for (const [plSku, data] of priceMap) {
    const entry = { ...data, _plSku: plSku };

    // Strip trailing -N
    if (plSku.endsWith('-N')) {
      const alt = plSku.slice(0, -2);
      if (!priceMap.has(alt) && !fuzzy.has(alt)) fuzzy.set(alt, entry);
    }

    // Strip trailing SP
    if (plSku.endsWith('SP')) {
      const alt = plSku.slice(0, -2);
      if (!priceMap.has(alt) && !fuzzy.has(alt)) fuzzy.set(alt, entry);
    }

    // Remove N before -digit suffix (e.g., FLD010N-1 → FLD010-1 and FLD010)
    const nDashMatch = plSku.match(/^(.+?)N(-\d+)$/);
    if (nDashMatch) {
      const withDash = nDashMatch[1] + nDashMatch[2]; // FLD010N-1 → FLD010-1
      const base = nDashMatch[1];                       // FLD010N-1 → FLD010
      if (!priceMap.has(withDash) && !fuzzy.has(withDash)) fuzzy.set(withDash, entry);
      if (!priceMap.has(base) && !fuzzy.has(base)) fuzzy.set(base, entry);
    }
  }

  return fuzzy;
}

// ──────────────────────────────────────────────
// Step 2: Fetch All Shopify Products
// ──────────────────────────────────────────────

async function fetchCollection(collectionSlug) {
  const products = [];
  let page = 1;

  while (true) {
    const url = `${BASE_URL}/collections/${collectionSlug}/products.json?limit=250&page=${page}`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(30000),
    });

    if (!resp.ok) {
      if (page === 1) throw new Error(`Shopify ${collectionSlug} API returned ${resp.status}`);
      break;
    }

    const data = await resp.json();
    const batch = data.products || [];
    if (batch.length === 0) break;

    products.push(...batch);
    if (batch.length < 250) break;
    page++;
    await delay(500);
  }

  return products;
}

async function fetchAllShopifyProducts() {
  console.log('Fetching tiles collection...');
  const tiles = await fetchCollection('all-tiles');
  console.log(`  ${tiles.length} tile products`);

  await delay(500);

  console.log('Fetching mosaics collection...');
  const mosaics = await fetchCollection('all-mosaics');
  console.log(`  ${mosaics.length} mosaic products`);

  // Deduplicate by handle (a product could appear in both collections)
  const byHandle = new Map();
  for (const p of [...tiles, ...mosaics]) {
    if (!byHandle.has(p.handle)) byHandle.set(p.handle, p);
  }

  console.log(`  ${byHandle.size} unique products after dedup\n`);
  return [...byHandle.values()];
}

// ──────────────────────────────────────────────
// Step 3: Process Each Product
// ──────────────────────────────────────────────

/**
 * Clean product title: strip clearance/stock markers.
 */
function cleanTitle(title) {
  return (title || '')
    .replace(/\*+Clearance\s*Item\*+/gi, '')
    .replace(/\(Limited\s+Stock\)/gi, '')
    .replace(/\*+/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Derive category_id from product_type and tags.
 */
function deriveCategory(productType, tags) {
  const pt = (productType || '').toLowerCase();
  const tagSet = new Set((tags || []).map(t => t.toLowerCase()));

  if (pt === 'mosaics' || pt === 'mosaic') return CAT.mosaic;
  if (tagSet.has('paver') || tagSet.has('pavers')) return CAT.pavers;
  if (tagSet.has('ceramic')) return CAT.ceramic;
  if (tagSet.has('porcelain')) return CAT.porcelain;

  // Fallback based on product_type
  if (pt === 'wall tile' || pt === 'tile') {
    // Check tags for material hint
    if (tagSet.has('ceramic')) return CAT.ceramic;
    return CAT.porcelain;
  }

  return CAT.porcelain; // default
}

/**
 * Derive variant_type from product_type, tags, and application info.
 */
function deriveVariantType(productType, tags, application) {
  const pt = (productType || '').toLowerCase();
  const tagSet = new Set((tags || []).map(t => t.toLowerCase()));
  const app = (application || '').toLowerCase();

  if (pt === 'mosaics' || pt === 'mosaic' || tagSet.has('mosaic')) return 'mosaic';
  if (app === 'wall only' || pt === 'wall tile') return 'wall_tile';
  if (app === 'paver' || tagSet.has('paver') || tagSet.has('pavers')) return 'floor_tile';
  if (tagSet.has('floor') || app.includes('floor')) return 'floor_tile';
  if (tagSet.has('wall') && !tagSet.has('floor')) return 'wall_tile';

  return 'floor_tile'; // default for tiles
}

/**
 * Parse body_html table rows into a Map<itemNumber, { color, size, finish, application, look, type, glaze, edge }>.
 */
function parseBodyHtmlTable(bodyHtml) {
  const rows = new Map();
  if (!bodyHtml) return rows;

  // Match table rows: <tr>...<td>...</td>...</tr>
  const trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let trMatch;
  let headerCols = null;

  while ((trMatch = trRegex.exec(bodyHtml)) !== null) {
    const rowHtml = trMatch[1];
    // Extract cell contents
    const cells = [];
    const tdRegex = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let tdMatch;
    while ((tdMatch = tdRegex.exec(rowHtml)) !== null) {
      // Strip HTML tags and decode entities
      let text = tdMatch[1]
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      cells.push(text);
    }

    if (cells.length < 3) continue;

    // Detect header row
    if (!headerCols && cells.some(c => /item\s*number/i.test(c))) {
      headerCols = cells.map(c => c.toLowerCase().replace(/\s+/g, '_'));
      continue;
    }

    if (!headerCols) continue;

    // Build a record from the row
    const record = {};
    for (let i = 0; i < Math.min(cells.length, headerCols.length); i++) {
      record[headerCols[i]] = cells[i];
    }

    const itemNum = record['item_number'] || record['item_#'] || record['item#'] || '';
    if (itemNum && itemNum !== '-') {
      rows.set(itemNum.trim(), {
        color: record['color'] || '',
        size: record['size_(nominal)'] || record['size'] || '',
        finish: record['finish'] || '',
        application: record['application'] || '',
        look: record['look'] || '',
        type: record['type'] || '',
        glaze: record['glaze'] || '',
        edge: record['edge'] || '',
      });
    }
  }

  return rows;
}

/**
 * Get option value by option name from Shopify product options and variant.
 */
function getOptionValue(product, variant, optionName) {
  const lower = optionName.toLowerCase();
  for (const opt of (product.options || [])) {
    if (opt.name.toLowerCase().includes(lower)) {
      const key = `option${opt.position}`;
      return variant[key] || null;
    }
  }
  return null;
}

/**
 * Build variant name from option values.
 */
function buildVariantName(product, variant) {
  const parts = [];
  const size = getOptionValue(product, variant, 'size');
  const color = getOptionValue(product, variant, 'color');
  const finish = getOptionValue(product, variant, 'finish') || getOptionValue(product, variant, 'format');

  if (size && size !== 'Default Title' && size !== 'Mixed') parts.push(normalizeSize(size));
  if (color && color !== 'Default Title') parts.push(color);
  if (finish && finish !== 'Default Title') parts.push(finish);

  return parts.length > 0 ? parts.join(', ') : null;
}

// ──────────────────────────────────────────────
// Image processing
// ──────────────────────────────────────────────

/**
 * Collect images for a specific variant from the product's image list.
 * Returns { primary: url|null, alternates: url[] }
 */
function collectVariantImages(product, variant) {
  const variantId = variant.id;
  const allImages = product.images || [];

  // The variant's featured_image is the primary product shot
  const featuredSrc = variant.featured_image?.src || null;

  // Other images linked to this variant via variant_ids
  const linkedImages = allImages
    .filter(img => img.variant_ids && img.variant_ids.includes(variantId) && img.src !== featuredSrc)
    .sort((a, b) => a.position - b.position)
    .map(img => img.src);

  return {
    primary: featuredSrc,
    alternates: linkedImages,
  };
}

/**
 * Distribute shared/lifestyle images (empty variant_ids) to matching variants by color.
 * Images whose filename contains a color name get assigned to that color's SKUs.
 * Images that don't match any color stay at the product level.
 *
 * Returns { colorMap: Map<colorLower, url[]>, unmatched: url[] }
 */
function distributeLifestyleImages(product) {
  const allImages = product.images || [];
  const variants = product.variants || [];

  // Collect shared images (no variant_ids)
  const sharedImages = allImages
    .filter(img => !img.variant_ids || img.variant_ids.length === 0)
    .sort((a, b) => a.position - b.position)
    .map(img => img.src);

  if (sharedImages.length === 0) return { colorMap: new Map(), unmatched: [] };

  // Build list of unique color names from variants
  const colorNames = new Set();
  for (const v of variants) {
    const color = getOptionValue(product, v, 'color');
    if (color && color !== 'Default Title') colorNames.add(color);
  }

  if (colorNames.size === 0) return { colorMap: new Map(), unmatched: sharedImages };

  // Build color slugs for filename matching (e.g., "White Onyx" → "whiteonyx", "white")
  const colorSlugs = []; // { color, slugs: string[] }
  for (const color of colorNames) {
    const full = color.toLowerCase().replace(/[^a-z0-9]/g, '');
    const words = color.toLowerCase().split(/\s+/).filter(w => w.length >= 3);
    colorSlugs.push({ color: color.toLowerCase(), slugs: [full, ...words] });
  }

  const colorMap = new Map(); // colorLower → url[]
  const unmatched = [];

  for (const url of sharedImages) {
    const filename = url.toLowerCase().split('/').pop().split('?')[0].replace(/[^a-z0-9]/g, '');

    // Try to match to a specific color
    let matchedColor = null;
    let bestLen = 0;

    for (const { color, slugs } of colorSlugs) {
      for (const slug of slugs) {
        if (slug.length > bestLen && filename.includes(slug)) {
          matchedColor = color;
          bestLen = slug.length;
        }
      }
    }

    if (matchedColor) {
      if (!colorMap.has(matchedColor)) colorMap.set(matchedColor, []);
      colorMap.get(matchedColor).push(url);
    } else {
      unmatched.push(url);
    }
  }

  return { colorMap, unmatched };
}

// ──────────────────────────────────────────────
// Main processing
// ──────────────────────────────────────────────

async function processShopifyProduct(product, vendorId, priceMap, fuzzyMap) {
  const title = cleanTitle(product.title);
  if (!title) return null;

  const categoryId = deriveCategory(product.product_type, product.tags);
  const tags = product.tags || [];

  // Parse body_html table for structured per-SKU attributes
  const bodyData = parseBodyHtmlTable(product.body_html);

  // Upsert product (collection = product title for Ottimo's flat structure)
  const productRow = await upsertProduct(pool, {
    vendor_id: vendorId,
    name: title,
    collection: title,
    category_id: categoryId,
    description_short: null,
    description_long: null,
  });
  const productId = productRow.id;

  // Activate the product
  await pool.query(`UPDATE products SET status = 'active' WHERE id = $1`, [productId]);

  const variants = product.variants || [];
  const stats = { skus: 0, images: 0, pricing: 0, packaging: 0, attrs: 0 };

  // Distribute lifestyle images to matching color variants
  const { colorMap: lifestyleByColor, unmatched: unmatchedLifestyle } =
    distributeLifestyleImages(product);

  // Clean up old product-level lifestyle images (may be stale from prior runs)
  await pool.query(`
    DELETE FROM media_assets
    WHERE product_id = $1 AND sku_id IS NULL AND asset_type = 'lifestyle'
  `, [productId]);

  // Save unmatched lifestyle images at product level
  for (let i = 0; i < unmatchedLifestyle.length; i++) {
    await upsertMediaAsset(pool, {
      product_id: productId,
      sku_id: null,
      asset_type: 'lifestyle',
      url: unmatchedLifestyle[i],
      original_url: unmatchedLifestyle[i],
      sort_order: i,
    });
    stats.images++;
  }

  // Track which color's lifestyle images we've already saved (multiple SKUs can share a color)
  const lifestyleColorSaved = new Set();

  for (const variant of variants) {
    const vendorSku = (variant.sku || '').trim();
    if (!vendorSku) continue;

    const internalSku = 'OTTIMO-' + vendorSku;
    const variantName = buildVariantName(product, variant);

    // Look up price list data (exact match, then fuzzy fallback)
    const plData = priceMap.get(vendorSku) || fuzzyMap.get(vendorSku) || null;

    // Determine sell_by and variant_type
    const isMosaic = (product.product_type || '').toLowerCase() === 'mosaics' ||
                     tags.some(t => t.toLowerCase() === 'mosaic');

    // Check body_html data for this SKU's application
    const bodyRow = bodyData.get(vendorSku) || {};
    const application = bodyRow.application || plData?.application || '';

    let sellBy = plData?.sellBy || (isMosaic ? 'unit' : 'box');
    let priceBasis = plData?.priceBasis || (isMosaic ? 'per_unit' : 'per_sqft');
    const variantType = deriveVariantType(product.product_type, tags, application);

    // Upsert SKU
    const skuRow = await upsertSku(pool, {
      product_id: productId,
      vendor_sku: vendorSku,
      internal_sku: internalSku,
      variant_name: variantName,
      sell_by: sellBy,
      variant_type: variantType,
    });
    const skuId = skuRow.id;
    stats.skus++;

    // Activate the SKU
    await pool.query(`UPDATE skus SET status = 'active' WHERE id = $1`, [skuId]);

    // ── Pricing ──
    if (plData && plData.cost > 0) {
      await upsertPricing(pool, skuId, {
        cost: plData.cost,
        retail_price: plData.cost * MARKUP,
        price_basis: priceBasis,
      });
      stats.pricing++;
    }

    // ── Packaging ──
    if (plData && (plData.sqftCarton || plData.pcsCarton)) {
      await upsertPackaging(pool, skuId, {
        sqft_per_box: plData.sqftCarton || null,
        pieces_per_box: plData.pcsCarton || null,
      });
      stats.packaging++;
    }

    // ── Attributes ──
    // Color: from variant option or body_html
    const color = getOptionValue(product, variant, 'color') || bodyRow.color || null;
    if (color && color !== 'Default Title') {
      await upsertSkuAttribute(pool, skuId, 'color', color);
      stats.attrs++;
    }

    // Size: from variant option, normalized
    const sizeRaw = getOptionValue(product, variant, 'size') || bodyRow.size || null;
    if (sizeRaw && sizeRaw !== 'Default Title' && sizeRaw !== 'Mixed') {
      await upsertSkuAttribute(pool, skuId, 'size', normalizeSize(sizeRaw));
      stats.attrs++;
    }

    // Finish: from variant option3 or body_html
    const finish = getOptionValue(product, variant, 'finish') ||
                   getOptionValue(product, variant, 'format') ||
                   bodyRow.finish || null;
    if (finish && finish !== 'Default Title') {
      await upsertSkuAttribute(pool, skuId, 'finish', finish);
      stats.attrs++;
    }

    // Material: from body_html Type column or tags
    let material = bodyRow.type || null;
    if (!material) {
      // Derive from tags
      if (tags.some(t => t.toLowerCase() === 'porcelain')) material = 'Porcelain';
      else if (tags.some(t => t.toLowerCase() === 'ceramic')) material = 'Ceramic';
      else if (tags.some(t => t.toLowerCase() === 'glass')) material = 'Glass';
      else if (tags.some(t => t.toLowerCase() === 'marble')) material = 'Marble';
      else if (tags.some(t => t.toLowerCase() === 'aluminum')) material = 'Aluminum';
    }
    if (material) {
      await upsertSkuAttribute(pool, skuId, 'material', material);
      stats.attrs++;
    }

    // ── Images ──
    const imgData = collectVariantImages(product, variant);

    let sortOrder = 0;

    // Primary image (variant's featured product shot)
    if (imgData.primary) {
      await upsertMediaAsset(pool, {
        product_id: productId,
        sku_id: skuId,
        asset_type: 'primary',
        url: imgData.primary,
        original_url: imgData.primary,
        sort_order: sortOrder++,
      });
      stats.images++;
    }

    // Alternate images (other images linked to this variant)
    for (const altUrl of imgData.alternates) {
      await upsertMediaAsset(pool, {
        product_id: productId,
        sku_id: skuId,
        asset_type: 'alternate',
        url: altUrl,
        original_url: altUrl,
        sort_order: sortOrder++,
      });
      stats.images++;
    }

    // Lifestyle images — assigned per color variant based on filename matching
    const variantColor = (color || '').toLowerCase();
    if (variantColor && lifestyleByColor.has(variantColor) && !lifestyleColorSaved.has(variantColor)) {
      const colorLifestyle = lifestyleByColor.get(variantColor);
      for (let i = 0; i < colorLifestyle.length; i++) {
        await upsertMediaAsset(pool, {
          product_id: productId,
          sku_id: skuId,
          asset_type: 'lifestyle',
          url: colorLifestyle[i],
          original_url: colorLifestyle[i],
          sort_order: sortOrder++,
        });
        stats.images++;
      }
      lifestyleColorSaved.add(variantColor);
    }
  }

  return stats;
}



// ──────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────

async function run() {
  console.log('═══════════════════════════════════════════');
  console.log('  Ottimo Ceramics — Unified Scraper');
  console.log('═══════════════════════════════════════════\n');

  // Step 1: Parse price list
  const priceListPath = join(__dirname, '..', 'data', 'ottimo-pricelist.txt');
  console.log('Step 1: Parsing price list...');
  const priceMap = parsePriceList(priceListPath);
  const fuzzyMap = buildFuzzyMap(priceMap);
  console.log(`  ${priceMap.size} SKUs in price list (${fuzzyMap.size} fuzzy aliases)\n`);

  // Step 2: Fetch Shopify products
  console.log('Step 2: Fetching Shopify catalog...');
  const shopifyProducts = await fetchAllShopifyProducts();

  // Ensure vendor exists
  const vendorRes = await pool.query(`
    INSERT INTO vendors (id, name, code, website)
    VALUES (gen_random_uuid(), 'Ottimo Ceramics', 'OTTIMO', 'https://ottimoceramics.com')
    ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, website = EXCLUDED.website
    RETURNING id
  `);
  const vendorId = vendorRes.rows[0].id;
  console.log(`Vendor: Ottimo Ceramics (${vendorId})\n`);

  // Step 3: Process each Shopify product
  console.log('Step 3: Processing Shopify products...');
  const matchedSkus = new Set();
  let fuzzyMatchCount = 0;
  let totals = { products: 0, skus: 0, images: 0, pricing: 0, packaging: 0, attrs: 0 };

  for (const product of shopifyProducts) {
    const stats = await processShopifyProduct(product, vendorId, priceMap, fuzzyMap);
    if (!stats) continue;

    totals.products++;
    totals.skus += stats.skus;
    totals.images += stats.images;
    totals.pricing += stats.pricing;
    totals.packaging += stats.packaging;
    totals.attrs += stats.attrs;

    // Track matched SKUs from price list (exact or fuzzy)
    for (const v of (product.variants || [])) {
      const sku = (v.sku || '').trim();
      if (!sku) continue;
      if (priceMap.has(sku)) {
        matchedSkus.add(sku);
      } else if (fuzzyMap.has(sku)) {
        matchedSkus.add(fuzzyMap.get(sku)._plSku); // mark the original PL SKU as consumed
        fuzzyMatchCount++;
      }
    }

    if (totals.products % 25 === 0) {
      console.log(`  ... ${totals.products} products processed`);
    }
  }
  console.log(`  ${totals.products} Shopify products processed\n`);

  // Step 4: Deactivate orphaned products (from old imports) that have no active SKUs
  console.log('Step 4: Cleaning up orphaned products...');
  const cleanupResult = await pool.query(`
    UPDATE products SET status = 'inactive'
    WHERE vendor_id = $1 AND status = 'active'
      AND NOT EXISTS (SELECT 1 FROM skus s WHERE s.product_id = products.id AND s.status = 'active')
    RETURNING id
  `, [vendorId]);
  console.log(`  ${cleanupResult.rowCount} orphaned products deactivated\n`);

  // Summary
  console.log('═══════════════════════════════════════════');
  console.log('  SUMMARY');
  console.log('═══════════════════════════════════════════');
  console.log(`  Products:             ${totals.products}`);
  console.log(`  SKUs:                 ${totals.skus}`);
  console.log(`  Images saved:         ${totals.images}`);
  console.log(`  Pricing records:      ${totals.pricing}`);
  console.log(`  Packaging records:    ${totals.packaging}`);
  console.log(`  Attribute records:    ${totals.attrs}`);
  console.log(`  Price list matches:   ${matchedSkus.size}/${priceMap.size} (${fuzzyMatchCount} fuzzy)`);
  console.log('═══════════════════════════════════════════\n');

  await pool.end();
}

run().catch(err => { console.error(err); process.exit(1); });
