/**
 * Goton Tiles — Enrichment Scraper (reworked)
 *
 * Uses the product map (backend/data/goton-product-map.json) built from
 * gotontiles.com Wix warmup data. No Puppeteer needed — images are fetched
 * directly from Wix static CDN using the structured per-color media mappings.
 *
 * Key improvements over v1:
 *  - Per-SKU images (not product-level) using color→linkedMedia mappings
 *  - Primary images are product shots (tile scans), not lifestyle photos
 *  - Glass mosaic per-code images from collection page data
 *  - No browser needed — uses HTTP fetch + product map JSON
 */
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  delay, appendLog, addJobError, upsertMediaAsset,
} from './base.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PRODUCT_MAP_PATH = join(__dirname, '..', 'data', 'goton-product-map.json');
const WIX_CDN = 'https://static.wixstatic.com/media/';

// ── Glass product name → Wix product map key ──
// DB product names (after code-suffix removal) mapped to product map keys
const GLASS_NAME_TO_MAP_KEY = {
  'Glass Stone Mosaic':    'GLASS & STONE MOSAIC',
  'Glass Basketweave':     'GLASS & STONE MOSAIC  (basketweave and linear line)',
  'Glass Lineal':          'GLASS & STONE MOSAIC  (basketweave and linear line)',
  'Glass Metal Interlock': 'GLASS & METAL LINEAL MOSAIC',
  'Glass Quartzite':       'GLASS & QUARTZITE MOSAIC',
  'Vetro Collection':      'GLASS TILE',
};

/**
 * Build full-res Wix CDN URL from the product map's url field.
 * Strips resize params to get the original full-res image.
 */
function wixFullRes(url) {
  if (!url) return null;
  // url is like "a0c5fc_xxx~mv2.jpg" — prepend CDN base
  if (url.startsWith('http')) return url.split('/v1/')[0]; // strip resize params
  return WIX_CDN + url;
}

/**
 * Fuzzy match a DB color name to a Wix color option.
 * DB has names like "Avorio Cross Cut", Wix has "AVORIO".
 * Returns the best match or null.
 */
/**
 * Strip trailing numeric codes from Wix color names.
 * "HUNGTINGTON438" → "hungtington", "DESERT 166" → "desert", "CARBON244" → "carbon"
 */
function stripCode(name) {
  return name.toLowerCase().replace(/\s*\d{2,}$/, '').trim();
}

/**
 * Simple Levenshtein distance for fuzzy matching typos.
 */
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1, dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
  return dp[m][n];
}

function matchColor(dbColorName, wixColors) {
  const dbLower = dbColorName.toLowerCase().trim();
  if (!dbLower) return null; // empty color can't match
  const dbWords = dbLower.split(/\s+/);
  const dbFirst = dbWords[0];

  // Pass 1: Direct case-insensitive
  for (const wc of Object.keys(wixColors)) {
    if (wc.toLowerCase() === dbLower) return wc;
  }
  // Pass 2: Strip codes and compare
  for (const wc of Object.keys(wixColors)) {
    const wb = stripCode(wc);
    if (wb === dbFirst || wb === dbLower) return wc;
  }
  // Pass 3: DB color contained in Wix base or vice versa
  for (const wc of Object.keys(wixColors)) {
    const wb = stripCode(wc);
    if (wb.length >= 3 && dbLower.includes(wb)) return wc;
  }
  for (const wc of Object.keys(wixColors)) {
    if (dbFirst.length >= 3 && stripCode(wc).includes(dbFirst)) return wc;
  }
  // Pass 4: Fuzzy match — allow up to 2 edit distance for names ≥ 5 chars
  if (dbFirst.length >= 5) {
    let bestMatch = null, bestDist = Infinity;
    for (const wc of Object.keys(wixColors)) {
      const wb = stripCode(wc);
      if (wb.length < 4) continue;
      const dist = levenshtein(dbFirst, wb);
      const maxDist = Math.min(2, Math.floor(Math.min(dbFirst.length, wb.length) * 0.3));
      if (dist <= maxDist && dist < bestDist) {
        bestDist = dist;
        bestMatch = wc;
      }
    }
    if (bestMatch) return bestMatch;
  }
  return null;
}

/**
 * Extract glass mosaic code from SKU variant_name.
 * e.g. "GM101 5/8x5/8 11-11/16x11-11/16" → "GM101"
 */
function extractGlassCodeFromVariant(variantName) {
  const match = variantName.match(/\b(GM[LH]?\d+)\b/i);
  return match ? match[1].toUpperCase() : null;
}

/**
 * Return only positively classified product images.
 * For per-SKU use: only show actual tile scans, never lifestyle or unclassified.
 */
function productOnly(images) {
  const prod = images.filter(m => m.type === 'product');
  return prod.length > 0 ? prod : images.filter(m => m.type !== 'lifestyle');
}

/**
 * Classify a rendered gallery image by dimensions alone (no title).
 */
function classifyByDimensions(width, height) {
  if (!width || !height) return 'unknown';
  const ratio = width / height;
  if (ratio < 0.6) return 'product';
  if (Math.max(width, height) >= 3000) return 'lifestyle';
  return 'unknown';
}

function prepareGalleryImages(renderedGallery) {
  if (!renderedGallery || renderedGallery.length === 0) return [];
  return renderedGallery.map(img => ({
    url: img.url || img.id,
    title: img.name || '',
    width: img.width || 0,
    height: img.height || 0,
    type: classifyByDimensions(img.width, img.height),
  }));
}

// Goton image title size code → compatible DB sizes (inches)
// Grouped by visual format family. Used only when multiple size codes exist.
const SIZE_CODE_TO_SIZES = {
  '36':   ['12x24', '6x24'],                 // 300x600mm — rectangle family
  '45':   ['18x18', '13x13', '6x6'],         // 450x450mm — square family
  '49':   ['18x36', '9x36', '9x48', '6x36'], // 450x900mm — plank family
  '60':   ['24x24', '12x24'],                 // 600x600mm — square/rect family
  '1560': ['6x24'],                           // 150x600mm
  '1590': ['6x36'],                           // 150x900mm
  '2290': ['9x36'],                           // 225x900mm
  '4120': ['18x48', '9x48'],                  // 450x1200mm — long plank family
};

function getImageSizeCode(title) {
  if (!title) return null;
  const decoded = typeof title === 'string' ? decodeURIComponent(title) : title;
  const m = decoded.match(/^(\d{2,4})[BCD]\d{3}/i);
  return m ? m[1] : null;
}

function getSkuSize(variantName) {
  const m = variantName.match(/(\d+x\d+)/i);
  return m ? m[1].toLowerCase() : null;
}

/**
 * Pick the best image(s) for a SKU based on its variant type and size.
 *
 * Field tiles: size-aware selection, prefer plank scans, up to 4 images
 * Mosaics: only square-ish images (no plank scans), 1 image
 * Accessories: 1 image (primary only)
 */
function isPatternImage(title) {
  if (!title) return false;
  const t = decodeURIComponent(title);
  return /[HJKN]\d{2,3}/.test(t) || /FL[A-Z]?\d{2,3}/.test(t);
}

function pickImagesForSku(allImages, variantName, variantType) {
  if (!allImages || allImages.length === 0) return [];

  const isMosaic = /mosaic|hexag|chevron|herring/i.test(variantName);
  const isAccessory = variantType === 'accessory';

  if (isMosaic) {
    // Determine mosaic shape from variant name
    const isHexagon = /hexag/i.test(variantName);
    const isChevron = /chevron|herring/i.test(variantName);
    const isOpus = /opus|floor.?layout/i.test(variantName);

    // Try shape-specific pattern image first
    // H=hexagon, J=chevron, K/N=regular mosaic sheet, FL=floor layout/opus
    const patternShots = allImages.filter(m => {
      if (m.type === 'lifestyle') return false;
      const t = m.title ? decodeURIComponent(m.title) : '';
      if (isHexagon) return /[H]\d{2,3}/.test(t);
      if (isChevron) return /[J]\d{2,3}/.test(t);
      if (isOpus) return /FL[A-Z]?\d{2,3}/.test(t);
      return /[KN]\d{2,3}/.test(t);
    });
    if (patternShots.length > 0) return [patternShots[0]];

    // No shape-specific image — fall back to field tile scan (exclude pattern images)
    const fieldShots = allImages.filter(m =>
      (m.type === 'product' || m.type === 'unknown') && !isPatternImage(m.title)
    );
    if (fieldShots.length > 0) return [fieldShots[0]];
    if (allImages.length > 0) return [allImages[0]];
    return [];
  }

  if (isAccessory) {
    return [allImages[0]];
  }

  // ── Field tile: size-aware selection (exclude mosaic pattern images) ──
  const productImgs = allImages.filter(m =>
    (m.type === 'product' || m.type === 'unknown') && !isPatternImage(m.title)
  );
  const lifestyleImgs = allImages.filter(m => m.type === 'lifestyle');

  const skuSize = getSkuSize(variantName);
  let selectedProduct = productImgs;

  if (skuSize && productImgs.length > 0) {
    const sizeCodes = new Set();
    for (const img of productImgs) {
      const code = getImageSizeCode(img.title);
      if (code) sizeCodes.add(code);
    }

    if (sizeCodes.size > 1) {
      let matchingCode = null;
      for (const code of sizeCodes) {
        const expectedSizes = SIZE_CODE_TO_SIZES[code] || [];
        if (expectedSizes.some(s => skuSize.includes(s) || s.includes(skuSize))) {
          matchingCode = code;
          break;
        }
      }

      if (matchingCode) {
        const sizeMatched = productImgs.filter(img => {
          const code = getImageSizeCode(img.title);
          return !code || code === matchingCode;
        });
        if (sizeMatched.length > 0) selectedProduct = sizeMatched;
      }
    }
  }

  // Sort: plank scans first, then other product images, then per-color lifestyle
  const planks = selectedProduct.filter(m => m.height && m.width && m.height > m.width * 1.3);
  const otherProduct = selectedProduct.filter(m => !planks.includes(m));
  return [...planks, ...otherProduct, ...lifestyleImgs].slice(0, 4);
}

/**
 * Get per-color images from a map entry.
 * Strategy 1: Colors have linked images → use those (filter lifestyle)
 * Strategy 2: Colors exist but 0 linked → split allMedia non-lifestyle by color index
 * Returns Map<wixColorKey, image[]>
 */
function getPerColorImages(mapEntry) {
  const result = new Map();
  const realColors = Object.entries(mapEntry.colors || {}).filter(([k]) => k !== 'ALL' && k !== 'All');
  if (realColors.length === 0) return result;

  const totalLinked = realColors.reduce((sum, [, data]) => sum + data.images.length, 0);
  if (totalLinked > 0) {
    // Include product images first, then per-color lifestyle as alternates
    for (const [colorKey, colorData] of realColors) {
      const productImgs = colorData.images.filter(m => m.type === 'product');
      const colorLifestyle = colorData.images.filter(m => m.type === 'lifestyle');
      const combined = [...productImgs, ...colorLifestyle];
      if (combined.length > 0) {
        result.set(colorKey, combined);
      } else {
        // Color has 0 linked images — try matching by color code in allMedia titles
        const codeMatch = colorKey.match(/\d{3,}/);
        if (codeMatch) {
          const code = codeMatch[0];
          const matched = productOnly(mapEntry.allMedia).filter(m =>
            m.title && m.title.includes(code)
          );
          if (matched.length > 0) result.set(colorKey, matched);
        }
      }
    }
    return result;
  }

  // No linked images — match allMedia to colors by title codes/names
  // Filter out lifestyle, then also detect leading hero images by dimensions
  let candidates = mapEntry.allMedia.filter(m => m.type !== 'lifestyle');
  if (candidates.length === 0) return result;

  // Detect leading hero: if first image is landscape and >1.5x area of median
  if (candidates.length > realColors.length + 1) {
    const first = candidates[0];
    const areas = candidates.slice(1).map(m => (m.width || 1) * (m.height || 1));
    const medianArea = areas.sort((a, b) => a - b)[Math.floor(areas.length / 2)];
    const firstArea = (first.width || 1) * (first.height || 1);
    const isLandscape = (first.width || 0) > (first.height || 0) * 1.1;
    if (isLandscape && firstArea > medianArea * 1.5) {
      candidates = candidates.slice(1); // skip hero
    }
  }
  if (candidates.length === 0) return result;

  // Build color code and name maps from Wix color keys
  // Multiple colors can share a code (e.g., "AVORIO MATT 601M" + "AVORIO POLISHED 601P")
  const colorCodeMap = new Map(); // code → colorKey[]
  const colorNameMap = new Map(); // lowercased name → colorKey[]
  for (const [colorKey] of realColors) {
    const codeMatch = colorKey.match(/(\d{3,})/);
    if (codeMatch) {
      if (!colorCodeMap.has(codeMatch[1])) colorCodeMap.set(codeMatch[1], []);
      colorCodeMap.get(codeMatch[1]).push(colorKey);
    }
    const namePart = colorKey.replace(/\s*\d{2,}.*$/, '').trim().toLowerCase();
    if (namePart && namePart.length >= 3) {
      if (!colorNameMap.has(namePart)) colorNameMap.set(namePart, []);
      colorNameMap.get(namePart).push(colorKey);
    }
  }

  // Try matching each candidate image to color(s) by its title
  const matched = new Map(); // colorKey → image[]
  const unmatched = [];

  for (const img of candidates) {
    const decoded = decodeURIComponent(img.title || '');
    if (!decoded || decoded === 'no-title') {
      unmatched.push(img);
      continue;
    }
    const titleLower = decoded.toLowerCase();

    let foundColors = null;
    const titleCodes = [...decoded.matchAll(/(\d{3})/g)].map(m => m[1]);
    for (const tc of titleCodes) {
      if (colorCodeMap.has(tc)) { foundColors = colorCodeMap.get(tc); break; }
    }

    if (!foundColors) {
      for (const [name, colorKeys] of colorNameMap) {
        if (titleLower.includes(name)) { foundColors = colorKeys; break; }
      }
    }

    if (foundColors) {
      for (const ck of foundColors) {
        if (!matched.has(ck)) matched.set(ck, []);
        matched.get(ck).push(img);
      }
    } else {
      unmatched.push(img);
    }
  }

  if (matched.size > 0) {
    for (const [colorKey, imgs] of matched) {
      result.set(colorKey, imgs);
    }
    return result;
  }

  // Fallback: no titles matched — even-split as last resort
  const perColor = Math.max(1, Math.floor(candidates.length / realColors.length));
  for (let i = 0; i < realColors.length; i++) {
    const [colorKey] = realColors[i];
    const start = i * perColor;
    const end = (i === realColors.length - 1) ? candidates.length : start + perColor;
    const slice = candidates.slice(start, end);
    if (slice.length > 0) result.set(colorKey, slice);
  }
  return result;
}

/**
 * Load product map and refresh if stale.
 */
function loadProductMap() {
  try {
    const raw = readFileSync(PRODUCT_MAP_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    return null;
  }
}

/**
 * Slugify a product name for matching to product map keys.
 */
function slugify(name) {
  return name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}

/**
 * Find a product in the product map by name (fuzzy).
 * Tries exact match, slug match, and partial match.
 */
function findInProductMap(productMap, dbProductName) {
  const products = productMap.products;

  // Exact match (case-insensitive)
  for (const [name, data] of Object.entries(products)) {
    if (name.toLowerCase() === dbProductName.toLowerCase()) return data;
  }

  // Match by slug
  const dbSlug = slugify(dbProductName);
  for (const [name, data] of Object.entries(products)) {
    if (data.slug === dbSlug) return data;
  }

  // Partial match: DB name contained in product map name or vice versa
  const dbLower = dbProductName.toLowerCase();
  for (const [name, data] of Object.entries(products)) {
    const mapLower = name.toLowerCase();
    if (mapLower.includes(dbLower) || dbLower.includes(mapLower)) return data;
  }

  return null;
}


// ══════════════════════════════════════════════════════════════════════════════
// Main run function
// ══════════════════════════════════════════════════════════════════════════════

export async function run(pool, job, source) {
  const vendorId = source.vendor_id;

  const log = async (msg, counters) => {
    console.log(`[goton] ${msg}`);
    await appendLog(pool, job.id, msg, counters).catch(() => {});
  };
  const logError = async (msg) => {
    console.error(`[goton] ERROR: ${msg}`);
    await addJobError(pool, job.id, msg).catch(() => {});
  };

  // ── Load product map ──
  const productMap = loadProductMap();
  if (!productMap) {
    await logError('Product map not found. Run: node backend/scripts/build-goton-product-map.cjs');
    return;
  }
  await log(`Loaded product map: ${Object.keys(productMap.products).length} products, generated ${productMap.generated}`);

  // ── Get all Goton products from DB with their SKUs ──
  const productRows = await pool.query(`
    SELECT p.id, p.name, p.collection, p.description_short
    FROM products p
    WHERE p.vendor_id = $1
    ORDER BY p.collection, p.name
  `, [vendorId]);

  // Get all SKUs for this vendor with their color attribute
  const skuRows = await pool.query(`
    SELECT s.id AS sku_id, s.product_id, s.variant_name, s.variant_type, s.sell_by,
           sa.value AS color
    FROM skus s
    JOIN products p ON p.id = s.product_id
    LEFT JOIN sku_attributes sa ON sa.sku_id = s.id
      AND sa.attribute_id = (SELECT id FROM attributes WHERE slug = 'color' LIMIT 1)
    WHERE p.vendor_id = $1 AND s.status = 'active'
    ORDER BY s.product_id, s.variant_name
  `, [vendorId]);

  // Group SKUs by product_id, then by color
  const skusByProduct = new Map();
  for (const sku of skuRows.rows) {
    if (!skusByProduct.has(sku.product_id)) skusByProduct.set(sku.product_id, []);
    skusByProduct.get(sku.product_id).push(sku);
  }

  await log(`Found ${productRows.rowCount} products, ${skuRows.rowCount} SKUs`);

  let imagesSaved = 0;
  let skusMatched = 0;
  let productsMatched = 0;
  let productsFailed = 0;
  let descriptionsUpdated = 0;

  // ══════════════════════════════════════════════════════════════════════
  // Process each product
  // ══════════════════════════════════════════════════════════════════════
  for (const product of productRows.rows) {
    const skus = skusByProduct.get(product.id) || [];
    if (skus.length === 0) continue;

    // Check if this is a glass mosaic product
    const glassMapKey = GLASS_NAME_TO_MAP_KEY[product.name];

    let mapEntry;
    if (glassMapKey) {
      // Glass products: look up by product map key directly
      mapEntry = productMap.products[glassMapKey] || null;
    } else {
      // Regular products: look up by name
      mapEntry = findInProductMap(productMap, product.name);
    }

    if (!mapEntry) {
      await logError(`No product map entry for "${product.name}"`);
      productsFailed++;
      continue;
    }

    // ── Update description ──
    if (mapEntry.description && mapEntry.description.length >= 20) {
      const cleanDesc = mapEntry.description.replace(/<[^>]+>/g, '').trim().substring(0, 500);
      if (cleanDesc.length >= 20) {
        const descResult = await pool.query(`
          UPDATE products SET description_short = $1, updated_at = CURRENT_TIMESTAMP
          WHERE id = $2
            AND (description_short IS NULL OR description_short = '' OR description_short ~* 'a durable porcelain tile')
        `, [cleanDesc, product.id]);
        if (descResult.rowCount > 0) descriptionsUpdated++;
      }
    }

    // ── Determine images per SKU ──
    // Group ALL SKUs (tiles + accessories) by color
    // When color attribute is null, extract from variant name
    const colorGroups = new Map(); // color → sku[]
    for (const sku of skus) {
      let color = sku.color || '';
      if (!color) {
        // Extract color: everything before the first type/description keyword
        const cm = sku.variant_name.match(
          /^(.+?)\s+(?:Porcelain|Mosaic|Hexag|Floor\s+Bullnose|Cove\s+Base|V-Cap|Out-Corner|1\/4\s+Round|Round\s+Beak|\d+x\d+)/i
        );
        if (cm) color = cm[1].trim();
      }
      if (!colorGroups.has(color)) colorGroups.set(color, []);
      colorGroups.get(color).push(sku);
    }

    let productImageCount = 0;
    let allProductImages = productOnly(mapEntry.allMedia);
    if (allProductImages.length === 0) allProductImages = mapEntry.allMedia;

    // Prepare rendered gallery images for mosaic SKUs
    const galleryImages = prepareGalleryImages(mapEntry.renderedGallery);

    if (glassMapKey && glassMapKey !== 'GLASS TILE' && mapEntry.colors) {
      // ── Glass mosaic: match each SKU's code to a color key ──
      for (const sku of skus) {
        const code = extractGlassCodeFromVariant(sku.variant_name);
        const matchedColor = code
          ? Object.keys(mapEntry.colors).find(c => c.toUpperCase().includes(code))
          : null;
        const images = matchedColor
          ? productOnly(mapEntry.colors[matchedColor].images)
          : allProductImages;

        const picked = pickImagesForSku(images, sku.variant_name, sku.variant_type);
        let saved = 0;
        for (let i = 0; i < picked.length; i++) {
          const url = wixFullRes(picked[i].url);
          if (!url) continue;
          await upsertMediaAsset(pool, {
            product_id: product.id, sku_id: sku.sku_id,
            asset_type: i === 0 ? 'primary' : 'alternate', url, original_url: url, sort_order: i,
          });
          saved++;
        }
        imagesSaved += saved;
        if (saved > 0) { skusMatched++; productImageCount++; }
      }

    } else if (mapEntry.colors && Object.keys(mapEntry.colors).length > 0) {
      // ── Regular product with color options ──
      const perColorImages = getPerColorImages(mapEntry);

      for (const [dbColor, dbSkus] of colorGroups) {
        const wixColorKey = matchColor(dbColor, mapEntry.colors);
        let images = (wixColorKey && perColorImages.has(wixColorKey))
          ? perColorImages.get(wixColorKey)
          : null;
        // No match — skip this color to avoid showing wrong color's images
        if (!images || images.length === 0) continue;

        for (const sku of dbSkus) {
          const picked = pickImagesForSku(images, sku.variant_name, sku.variant_type);
          let saved = 0;
          for (let i = 0; i < picked.length; i++) {
            const url = wixFullRes(picked[i].url);
            if (!url) continue;
            await upsertMediaAsset(pool, {
              product_id: product.id, sku_id: sku.sku_id,
              asset_type: i === 0 ? 'primary' : 'alternate', url, original_url: url, sort_order: i,
            });
            saved++;
          }
          imagesSaved += saved;
          if (saved > 0) skusMatched++;
        }
        productImageCount += images.length;
      }
    } else {
      // ── No color options: use all non-lifestyle media ──
      if (allProductImages.length > 0) {
        for (const sku of skus) {
          const picked = pickImagesForSku(allProductImages, sku.variant_name, sku.variant_type);
          let saved = 0;
          for (let i = 0; i < picked.length; i++) {
            const url = wixFullRes(picked[i].url);
            if (!url) continue;
            await upsertMediaAsset(pool, {
              product_id: product.id, sku_id: sku.sku_id,
              asset_type: i === 0 ? 'primary' : 'alternate', url, original_url: url, sort_order: i,
            });
            saved++;
          }
          imagesSaved += saved;
          if (saved > 0) skusMatched++;
        }
        productImageCount = allProductImages.length;
      }
    }

    // ── Lifestyle images: match to specific colors via title codes ──
    const allMediaLifestyle = mapEntry.allMedia.filter(m => m.type === 'lifestyle');
    if (allMediaLifestyle.length > 0) {
      // Build color-code → tile SKU IDs map from DB color groups
      // Color codes are 3-digit numbers found in variant names (e.g., "Ice 327 12x24" → "327")
      const codeToSkuIds = new Map();
      for (const [dbColor, dbSkus] of colorGroups) {
        let code = null;
        const cm = dbColor.match(/\d{3,}/);
        if (cm) {
          code = cm[0];
        } else {
          for (const sku of dbSkus) {
            const m = sku.variant_name.match(/\b(\d{3})\b/);
            if (m) { code = m[1]; break; }
          }
        }
        if (code) {
          if (!codeToSkuIds.has(code)) codeToSkuIds.set(code, []);
          for (const sku of dbSkus) {
            if (sku.variant_type !== 'accessory') codeToSkuIds.get(code).push(sku.sku_id);
          }
        }
      }

      // Also build color-name → SKU IDs map for name-based matching fallback
      const nameToSkuIds = new Map();
      for (const [dbColor, dbSkus] of colorGroups) {
        const name = dbColor.replace(/\s*\d{3,}\s*/, '').trim().toLowerCase();
        if (name && name.length >= 3) {
          if (!nameToSkuIds.has(name)) nameToSkuIds.set(name, []);
          for (const sku of dbSkus) {
            if (sku.variant_type !== 'accessory') nameToSkuIds.get(name).push(sku.sku_id);
          }
        }
      }

      const lifestyleSortOrders = new Map();
      let anyMatchedLifestyle = false;
      const unmatchedLifestyle = [];

      for (const lf of allMediaLifestyle) {
        const decoded = decodeURIComponent(lf.title || '');
        const titleCodes = [...decoded.matchAll(/(\d{3})/g)].map(m => m[1]);
        const matchedSkuIds = new Set();

        for (const tc of titleCodes) {
          if (codeToSkuIds.has(tc)) {
            for (const sid of codeToSkuIds.get(tc)) matchedSkuIds.add(sid);
          }
        }

        // Strategy 2: Match by color name in title
        if (matchedSkuIds.size === 0 && decoded) {
          const titleLower = decoded.toLowerCase();
          for (const [name, skuIds] of nameToSkuIds) {
            if (titleLower.includes(name)) {
              for (const sid of skuIds) matchedSkuIds.add(sid);
            }
          }
        }

        if (matchedSkuIds.size > 0) {
          const url = wixFullRes(lf.url);
          if (!url) continue;
          for (const skuId of matchedSkuIds) {
            const so = lifestyleSortOrders.get(skuId) || 0;
            if (so >= 3) continue;
            await upsertMediaAsset(pool, {
              product_id: product.id, sku_id: skuId,
              asset_type: 'lifestyle', url, original_url: url, sort_order: so,
            });
            lifestyleSortOrders.set(skuId, so + 1);
            imagesSaved++;
          }
          anyMatchedLifestyle = true;
        } else {
          unmatchedLifestyle.push(lf);
        }
      }

      const hasPerColorLifestyle = anyMatchedLifestyle ||
        (mapEntry.colors && Object.values(mapEntry.colors).some(cd =>
          cd.images && cd.images.some(m => m.type === 'lifestyle')));

      if (!hasPerColorLifestyle && unmatchedLifestyle.length > 0) {
        for (let i = 0; i < Math.min(unmatchedLifestyle.length, 3); i++) {
          const url = wixFullRes(unmatchedLifestyle[i].url);
          if (!url) continue;
          await upsertMediaAsset(pool, {
            product_id: product.id, sku_id: null,
            asset_type: 'lifestyle', url, original_url: url, sort_order: i,
          });
        }
      }
    }

    if (productImageCount > 0) {
      productsMatched++;
      await log(`  ${product.name}: ${productImageCount} images across ${colorGroups.size} colors, ${skus.length} SKUs`);
    } else {
      productsFailed++;
      await logError(`  No images for ${product.name}`);
    }
  }

  // ── Summary ──
  await log('=== Scrape Complete ===');
  await log(`Products matched: ${productsMatched} / ${productRows.rowCount}`);
  await log(`Products without images: ${productsFailed}`);
  await log(`SKUs with images: ${skusMatched}`);
  await log(`Total images saved: ${imagesSaved}`);
  await log(`Descriptions updated: ${descriptionsUpdated}`);

  await appendLog(pool, job.id, 'Done', {
    products_found: productRows.rowCount,
    products_updated: productsMatched + descriptionsUpdated,
    skus_matched: skusMatched,
    images_saved: imagesSaved,
  }).catch(() => {});
}
