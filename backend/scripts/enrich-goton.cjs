/**
 * Goton Tiles — Enrichment: per-SKU images, product grouping, accessory attachment
 *
 * Uses the product map (backend/data/goton-product-map.json) to:
 * 1. Assign per-SKU images from Wix CDN (product shots as primary)
 * 2. Save lifestyle images at product level
 * 3. Update descriptions from site data
 * 4. Verify accessory attachment
 *
 * Usage: node backend/scripts/enrich-goton.cjs
 *   (run inside Docker: docker compose exec api node scripts/enrich-goton.cjs)
 */
const pg = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: 5432, database: 'flooring_pim', user: 'postgres', password: 'postgres',
});

const PRODUCT_MAP_PATH = path.join(__dirname, '..', 'data', 'goton-product-map.json');
const WIX_CDN = 'https://static.wixstatic.com/media/';

// Glass collection code patterns
const GLASS_COLLECTION_PAGES = [
  { slug: 'glass-stone-mosaic', patterns: [/\bGM[12]\d{2}\b/i] },
  { slug: 'glass-stone-mosaic-basketweave-and-linear-line', patterns: [/\bGMH\d+\b/i, /\bGML3\d+\b/i] },
  { slug: 'glass-metal-lineal-mosaic', patterns: [/\bGML4\d+\b/i] },
  { slug: 'glass-quartzite-mosaic', patterns: [/\bGM5\d+\b/i, /\bGML5\d+\b/i] },
  { slug: 'glass-tile', patterns: [/\bVetro\b/i] },
];

function wixFullRes(url) {
  if (!url) return null;
  if (url.startsWith('http')) return url.split('/v1/')[0];
  return WIX_CDN + url;
}

function slugify(name) {
  return name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}

function extractGlassCode(name) {
  const m = name.match(/\b(GM[LH]?\d+)\b/i);
  return m ? m[1].toUpperCase() : null;
}

function getGlassCollectionSlug(name) {
  for (const { slug, patterns } of GLASS_COLLECTION_PAGES) {
    for (const p of patterns) { if (p.test(name)) return slug; }
  }
  return null;
}

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

function matchColor(dbColor, wixColors) {
  const dbLower = dbColor.toLowerCase().trim();
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
 * Classify a rendered gallery image by dimensions alone (no title available).
 * Used for images captured via Puppeteer from the Wix product page gallery,
 * which don't have meaningful filenames.
 */
function classifyByDimensions(width, height) {
  if (!width || !height) return 'unknown';
  const ratio = width / height;
  // Very tall/narrow → plank scan (product shot)
  if (ratio < 0.6) return 'product';
  // Large images (>=3000px) are likely room/exterior scenes
  if (Math.max(width, height) >= 3000) return 'lifestyle';
  // Everything else: square to moderately rectangular
  return 'unknown';
}

/**
 * Prepare rendered gallery images for use with pickImagesForSku.
 * Converts from the product map's renderedGallery format to the image format
 * used by the enrichment (with url, title, width, height, type).
 */
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

/**
 * Return only positively classified product images.
 * For per-SKU use: only show actual tile scans, never lifestyle or unclassified.
 */
function productOnly(images) {
  const prod = images.filter(m => m.type === 'product');
  // Fallback: if zero product images, allow unknown but never lifestyle
  return prod.length > 0 ? prod : images.filter(m => m.type !== 'lifestyle');
}

// Goton image title size code → compatible DB sizes (inches)
// Grouped by visual format family: square, rectangle, plank, long plank.
// Used ONLY when a color has MULTIPLE size codes — picks the best match.
// When only ONE code exists, size filtering is skipped (show the only image).
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

/**
 * Extract size code from an image title.
 * e.g. "60B191.jpg" → "60", "4120B431 (450x1200)" → "4120"
 */
function getImageSizeCode(title) {
  if (!title) return null;
  const decoded = typeof title === 'string' ? decodeURIComponent(title) : title;
  const m = decoded.match(/^(\d{2,4})[BCD]\d{3}/i);
  return m ? m[1] : null;
}

/**
 * Extract size from a SKU variant name.
 * e.g. "Vanilla 221 12x24" → "12x24", "Carbon 244 18x48" → "18x48"
 */
function getSkuSize(variantName) {
  const m = variantName.match(/(\d+x\d+)/i);
  return m ? m[1].toLowerCase() : null;
}

/**
 * Pick the best image(s) for a SKU based on its variant type and size.
 *
 * Field tiles (12x24, 18x48, 9x36, etc.):
 *   - If images have different size codes, pick those matching the SKU's size
 *   - Prefer plank scans (tall portrait, ratio < 0.7) first, then any remaining
 *   - Up to 4 images total
 *
 * Mosaics (Porcelain Mosaic 2x2 12x12, Hexagon, etc.):
 *   - ONLY use mosaic-specific shots (K/N pattern code in image title)
 *   - Returns empty if no mosaic-specific image exists (no fallback to field tile)
 *
 * Accessories (Bullnose, V-Cap, Cove Base, etc.):
 *   - Returns empty — no accessory-specific photos available from Goton
 *
 * Pattern variants (Herringbone, Chevron, Basketweave):
 *   - Returns empty — these look visually distinct from standard field tiles
 */
function pickImagesForSku(allImages, variantName, variantType) {
  if (!allImages || allImages.length === 0) return [];

  const isMosaic = variantType === 'mosaic' || /mosaic|hexag/i.test(variantName);
  const isAccessory = variantType === 'accessory';

  // Pattern variants (herringbone, chevron, basketweave) look visually distinct
  // from standard field tiles — don't reuse the field tile's image.
  // But exclude mosaics since they have their own handling above.
  const isPattern = !isMosaic && /herringbone|chevron|basketweave/i.test(variantName);

  if (isMosaic) {
    // Mosaics come in many patterns (2x2, Hexagon, Opus, Basketweave, Chevron)
    // that all look completely different. Since Goton doesn't provide
    // separate images per mosaic pattern, don't assign any image —
    // a 2x2 grid image would be wrong on a Hexagon or Opus SKU.
    return [];
  }

  if (isAccessory) {
    // Accessories (bullnose, cove base, v-cap) have unique profiles.
    // Only use an image specifically shot for accessories, never the field tile image.
    // Since Goton doesn't provide separate accessory photos, return empty.
    return [];
  }

  if (isPattern) {
    // Pattern variants need their own image — a herringbone layout looks
    // nothing like a standard field tile. Don't assign the tile's image.
    return [];
  }

  // ── Field tile: size-aware selection ──
  // Separate product images from lifestyle (lifestyle = per-color room scenes)
  const productImgs = allImages.filter(m => m.type === 'product' || m.type === 'unknown');
  const lifestyleImgs = allImages.filter(m => m.type === 'lifestyle');

  // Check if images have different size codes (e.g. Iconic has 4120 + 60)
  const skuSize = getSkuSize(variantName);
  let selectedProduct = productImgs;

  if (skuSize && productImgs.length > 0) {
    const sizeCodes = new Set();
    for (const img of productImgs) {
      const code = getImageSizeCode(img.title);
      if (code) sizeCodes.add(code);
    }

    // Only do size filtering if there are multiple distinct size codes
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

  // Sort: plank scans first, then square/other product images, then per-color lifestyle
  const planks = selectedProduct.filter(m => m.height && m.width && m.height > m.width * 1.3);
  const otherProduct = selectedProduct.filter(m => !planks.includes(m));
  return [...planks, ...otherProduct, ...lifestyleImgs].slice(0, 4);
}

/**
 * Get per-color images from a map entry.
 * Three strategies:
 *  1. Color has linkedMediaItems → use those (filter lifestyle)
 *  2. Colors exist but 0 linked → split allMedia non-lifestyle by color index
 *  3. No colors → return all non-lifestyle from allMedia
 *
 * Returns Map<wixColorKey, image[]>
 */
function getPerColorImages(mapEntry) {
  const result = new Map();
  const realColors = Object.entries(mapEntry.colors || {}).filter(([k]) => k !== 'ALL' && k !== 'All');

  if (realColors.length === 0) return result;

  // Check if ANY color has linked images
  const totalLinked = realColors.reduce((sum, [, data]) => sum + data.images.length, 0);

  if (totalLinked > 0) {
    // Strategy 1: use linked images
    // Include product images first, then per-color lifestyle as additional alternates
    for (const [colorKey, colorData] of realColors) {
      const productImgs = colorData.images.filter(m => m.type === 'product');
      const colorLifestyle = colorData.images.filter(m => m.type === 'lifestyle');
      // Product images first, per-color lifestyle after (will become alternates)
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

  // Strategy 2: no linked images — match allMedia to colors by title codes/names
  // Filter out lifestyle, then also detect leading hero images by dimensions
  let candidates = mapEntry.allMedia.filter(m => m.type !== 'lifestyle');
  if (candidates.length === 0) return result;

  // Detect leading hero: if first image is landscape and >2x area of median
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
  // e.g., "VANILLA202" → code "202", name "vanilla"
  // e.g., "Beige 086" → code "086", name "beige"
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

    // Strategy A: Match by color code in title (e.g., "49B309" → code "309")
    let foundColors = null;
    const titleCodes = [...decoded.matchAll(/(\d{3})/g)].map(m => m[1]);
    for (const tc of titleCodes) {
      if (colorCodeMap.has(tc)) { foundColors = colorCodeMap.get(tc); break; }
    }

    // Strategy B: Match by color name in title (e.g., "MOON_SAND" → "sand")
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

  // If title matching found images for at least one color, use the matched results
  if (matched.size > 0) {
    for (const [colorKey, imgs] of matched) {
      result.set(colorKey, imgs);
    }
    // For colors that didn't get matched images: DON'T assign unmatched images
    // (they'd be from a different color). Leave those colors imageless.
    return result;
  }

  // No titles matched any color — return empty rather than guessing.
  // Better to show no image than the wrong color's image.
  return result;
}

function findInProductMap(products, dbName) {
  for (const [name, data] of Object.entries(products)) {
    if (name.toLowerCase() === dbName.toLowerCase()) return data;
  }
  const dbSlug = slugify(dbName);
  for (const [name, data] of Object.entries(products)) {
    if (data.slug === dbSlug) return data;
  }
  const dbLower = dbName.toLowerCase();
  for (const [name, data] of Object.entries(products)) {
    const ml = name.toLowerCase();
    if (ml.includes(dbLower) || dbLower.includes(ml)) return data;
  }
  return null;
}

async function upsertMedia(client, { product_id, sku_id, asset_type, url, sort_order }) {
  if (!url) return;
  if (sku_id) {
    await client.query(`
      INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
      VALUES ($1, $2, $3, $4, $4, $5)
      ON CONFLICT (product_id, sku_id, asset_type, sort_order) WHERE sku_id IS NOT NULL
      DO UPDATE SET url = EXCLUDED.url, original_url = EXCLUDED.original_url
    `, [product_id, sku_id, asset_type, url, sort_order]);
  } else {
    await client.query(`
      INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
      VALUES ($1, NULL, $2, $3, $3, $4)
      ON CONFLICT (product_id, asset_type, sort_order) WHERE sku_id IS NULL
      DO UPDATE SET url = EXCLUDED.url, original_url = EXCLUDED.original_url
    `, [product_id, asset_type, url, sort_order]);
  }
}

async function run() {
  console.log('Goton enrichment: per-SKU images + grouping + accessories\n');

  // Load product map
  const mapRaw = fs.readFileSync(PRODUCT_MAP_PATH, 'utf-8');
  const productMap = JSON.parse(mapRaw);
  console.log(`Product map: ${Object.keys(productMap.products).length} products (generated ${productMap.generated})\n`);

  const client = await pool.connect();

  try {
    // Get vendor ID
    const vendorRes = await client.query(`SELECT id FROM vendors WHERE code = 'GOTON'`);
    if (vendorRes.rowCount === 0) { console.error('Vendor GOTON not found'); return; }
    const vendorId = vendorRes.rows[0].id;

    // Get attribute ID for color
    const colorAttrRes = await client.query(`SELECT id FROM attributes WHERE slug = 'color' LIMIT 1`);
    const colorAttrId = colorAttrRes.rows[0]?.id;

    // Get all products
    const products = await client.query(`
      SELECT p.id, p.name, p.collection, p.description_short
      FROM products p WHERE p.vendor_id = $1
      ORDER BY p.collection, p.name
    `, [vendorId]);

    // Get all SKUs with color
    const skus = await client.query(`
      SELECT s.id, s.product_id, s.variant_name, s.variant_type, s.sell_by,
             sa.value AS color
      FROM skus s
      JOIN products p ON p.id = s.product_id
      LEFT JOIN sku_attributes sa ON sa.sku_id = s.id AND sa.attribute_id = $1
      WHERE p.vendor_id = $2 AND s.status = 'active'
      ORDER BY s.product_id, s.variant_name
    `, [colorAttrId, vendorId]);

    // Group SKUs by product
    const skusByProduct = new Map();
    for (const s of skus.rows) {
      if (!skusByProduct.has(s.product_id)) skusByProduct.set(s.product_id, []);
      skusByProduct.get(s.product_id).push(s);
    }

    console.log(`DB: ${products.rowCount} products, ${skus.rowCount} SKUs\n`);

    let imagesSaved = 0, skusMatched = 0, productsMatched = 0, productsFailed = 0;
    let descriptionsUpdated = 0;

    await client.query('BEGIN');

    // Clean slate: delete ALL existing Goton media_assets so stale images don't persist
    const delResult = await client.query(`
      DELETE FROM media_assets WHERE product_id IN (
        SELECT id FROM products WHERE vendor_id = $1
      )
    `, [vendorId]);
    console.log(`Cleared ${delResult.rowCount} old media_assets\n`);

    // ── Fix glass mosaic garbled color attributes ──
    // Glass mosaics (single-SKU products) shouldn't have color attributes — delete any that exist
    const glassColorDel = await client.query(`
      DELETE FROM sku_attributes
      WHERE attribute_id = $1
        AND sku_id IN (
          SELECT s.id FROM skus s
          JOIN products p ON s.product_id = p.id
          WHERE p.vendor_id = $2
            AND (p.name LIKE 'Glass %' OR p.name LIKE 'Glass_%')
        )
    `, [colorAttrId, vendorId]);
    if (glassColorDel.rowCount > 0) console.log(`Removed ${glassColorDel.rowCount} garbled glass mosaic color attributes`);

    // ── Fix Vetro Collection finish attributes ──
    // Ensure both Smooth and Textured variants have a finish attribute
    const finishAttrRes = await client.query(`SELECT id FROM attributes WHERE slug = 'finish' LIMIT 1`);
    const finishAttrId = finishAttrRes.rows[0]?.id;
    if (finishAttrId) {
      const vetroSkus = await client.query(`
        SELECT s.id, s.variant_name FROM skus s
        JOIN products p ON s.product_id = p.id
        WHERE p.vendor_id = $1 AND p.name = 'Vetro Collection'
          AND s.variant_type IS DISTINCT FROM 'accessory'
      `, [vendorId]);
      let finishFixed = 0;
      for (const row of vetroSkus.rows) {
        const finishVal = /Smooth/i.test(row.variant_name) ? 'Smooth'
          : /Textured/i.test(row.variant_name) ? 'Textured' : null;
        if (finishVal) {
          const r = await client.query(`
            INSERT INTO sku_attributes (sku_id, attribute_id, value)
            VALUES ($1, $2, $3)
            ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value = EXCLUDED.value
          `, [row.id, finishAttrId, finishVal]);
          if (r.rowCount > 0) finishFixed++;
        }
      }
      if (finishFixed > 0) console.log(`Set ${finishFixed} Vetro finish attributes`);
    }

    // ── Fix missing color attributes (e.g., Krovanh has numeric-only colors) ──
    const missingColorSkus = await client.query(`
      SELECT s.id, s.variant_name FROM skus s
      JOIN products p ON s.product_id = p.id
      LEFT JOIN sku_attributes sa ON sa.sku_id = s.id AND sa.attribute_id = $1
      WHERE p.vendor_id = $2 AND s.status = 'active'
        AND sa.value IS NULL
        AND p.name NOT LIKE 'Glass %'
    `, [colorAttrId, vendorId]);
    let colorFixed = 0;
    for (const row of missingColorSkus.rows) {
      // Extract color: everything before the first size/type keyword
      const cm = row.variant_name.match(
        /^(.+?)\s+(?:Porcelain|Mosaic|Hexag|Floor\s+Bullnose|Cove\s+Base|V-Cap|Out-Corner|1\/4\s+Round|Round\s+Beak|\d+x\d+)/i
      );
      const colorVal = cm ? cm[1].trim() : null;
      if (colorVal) {
        await client.query(`
          INSERT INTO sku_attributes (sku_id, attribute_id, value)
          VALUES ($1, $2, $3)
          ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value = EXCLUDED.value
        `, [row.id, colorAttrId, colorVal]);
        colorFixed++;
      }
    }
    if (colorFixed > 0) console.log(`Fixed ${colorFixed} missing color attributes`);

    // ── Fix mosaic size attributes: use pattern name instead of sheet size ──
    // e.g., "12x12" → "Mosaic 2x2", "9.5x11-3/4" → "Mosaic 2x6 Chevron"
    const sizeAttrRes = await client.query(`SELECT id FROM attributes WHERE slug = 'size' LIMIT 1`);
    const sizeAttrId = sizeAttrRes.rows[0]?.id;
    if (sizeAttrId) {
      const mosaicSkus = await client.query(`
        SELECT s.id, s.variant_name, sa.value AS current_size
        FROM skus s
        JOIN products p ON p.id = s.product_id
        JOIN sku_attributes sa ON sa.sku_id = s.id AND sa.attribute_id = $1
        WHERE p.vendor_id = $2 AND s.status = 'active'
          AND s.variant_name ~* 'mosaic|hexag|herringbone'
          AND s.variant_type IS DISTINCT FROM 'accessory'
      `, [sizeAttrId, vendorId]);

      let mosaicSizeFixed = 0;
      for (const row of mosaicSkus.rows) {
        // Extract pattern: "Color Code Porcelain Mosaic <PATTERN> <SHEET_SIZE>"
        let pattern = null;
        const m = row.variant_name.match(/(?:Porcelain\s+)?Mosaic\s+(.+)/i);
        if (m) {
          // Strip trailing sheet size (e.g., "12x12", "9.5x11-3/4")
          pattern = m[1].replace(/\s+[\d][\dx.\-\/]+$/i, '').trim();
        }
        if (!pattern) {
          // Herringbone case: "Herringbone 1x3 9x12"
          const h = row.variant_name.match(/(Herringbone\s+\S+)/i);
          if (h) pattern = h[1].trim();
        }
        if (pattern) {
          const newSize = 'Mosaic ' + pattern;
          if (newSize !== row.current_size) {
            await client.query(
              `UPDATE sku_attributes SET value = $1 WHERE sku_id = $2 AND attribute_id = $3`,
              [newSize, row.id, sizeAttrId]
            );
            mosaicSizeFixed++;
          }
        }
      }
      if (mosaicSizeFixed > 0) console.log(`Fixed ${mosaicSizeFixed} mosaic size attributes\n`);
    }

    for (const product of products.rows) {
      const productSkus = skusByProduct.get(product.id) || [];
      if (productSkus.length === 0) continue;

      // Find in product map
      const glassSlug = getGlassCollectionSlug(product.name);
      const glassCode = extractGlassCode(product.name);
      let mapEntry;

      if (glassSlug) {
        // Glass: look up collection page
        for (const [name, data] of Object.entries(productMap.products)) {
          if (data.slug === glassSlug) { mapEntry = data; break; }
        }
      } else {
        mapEntry = findInProductMap(productMap.products, product.name);
      }

      if (!mapEntry) {
        console.log(`  SKIP ${product.name} — not in product map`);
        productsFailed++;
        continue;
      }

      // Update description
      if (mapEntry.description) {
        const clean = mapEntry.description.replace(/<[^>]+>/g, '').trim().substring(0, 500);
        if (clean.length >= 20) {
          const r = await client.query(`
            UPDATE products SET description_short = $1, updated_at = CURRENT_TIMESTAMP
            WHERE id = $2 AND (description_short IS NULL OR description_short = '' OR description_short ~* 'a durable porcelain tile')
          `, [clean, product.id]);
          if (r.rowCount > 0) descriptionsUpdated++;
        }
      }

      // Group ALL SKUs (tiles + accessories) by color
      // When color attribute is null, try to extract from variant name
      // (e.g. Krovanh: "210 6x24" → color "210")
      const colorGroups = new Map();
      for (const sku of productSkus) {
        let c = sku.color || '';
        if (!c) {
          // Extract color: everything before the first type/description keyword
          // e.g. "Papel 235 Floor Bullnose" → "Papel 235"
          //      "210 Porcelain Mosaic 2x2 Hexagon 12x12" → "210"
          //      "Gris 100 1/4 Round" → "Gris 100"
          //      "Vanilla 221 12x24" → "Vanilla 221"
          const cm = sku.variant_name.match(
            /^(.+?)\s+(?:Porcelain|Mosaic|Hexag|Floor\s+Bullnose|Cove\s+Base|V-Cap|Out-Corner|1\/4\s+Round|Round\s+Beak|\d+x\d+)/i
          );
          if (cm) c = cm[1].trim();
        }
        if (!colorGroups.has(c)) colorGroups.set(c, []);
        colorGroups.get(c).push(sku);
      }

      let productImageCount = 0;
      // Fallback: prefer non-lifestyle, but use lifestyle if nothing else
      let allProductImages = productOnly(mapEntry.allMedia);
      if (allProductImages.length === 0) allProductImages = mapEntry.allMedia;

      // Prepare rendered gallery images for mosaic SKUs
      const galleryImages = prepareGalleryImages(mapEntry.renderedGallery);

      if (glassCode && mapEntry.colors) {
        // ── Glass mosaic: match by code in color options ──
        const matchedColor = Object.keys(mapEntry.colors).find(c =>
          c.toUpperCase().includes(glassCode)
        );
        const images = matchedColor
          ? productOnly(mapEntry.colors[matchedColor].images)
          : allProductImages;

        for (const sku of productSkus) {
          const picked = pickImagesForSku(images, sku.variant_name, sku.variant_type);
          for (let i = 0; i < picked.length; i++) {
            const url = wixFullRes(picked[i].url);
            await upsertMedia(client, {
              product_id: product.id, sku_id: sku.id,
              asset_type: i === 0 ? 'primary' : 'alternate',
              url, sort_order: i,
            });
            imagesSaved++;
          }
          skusMatched++;
        }
        productImageCount = images.length;

      } else if (mapEntry.colors && Object.keys(mapEntry.colors).length > 0) {
        // ── Regular product with color options ──
        // Build per-color image map (handles both linked & split strategies)
        const perColorImages = getPerColorImages(mapEntry);
        let colorMatchLog = [];

        for (const [dbColor, dbSkus] of colorGroups) {
          // Try to match DB color to Wix color
          const wixKey = matchColor(dbColor, mapEntry.colors);
          let images = (wixKey && perColorImages.has(wixKey))
            ? perColorImages.get(wixKey)
            : null;

          if (!images || images.length === 0) {
            // No match — skip this color to avoid showing wrong color's images
            colorMatchLog.push(`${dbColor}→SKIP(no match)`);
            continue;
          }

          colorMatchLog.push(`${dbColor}→${wixKey}(${images.length})`);

          for (const sku of dbSkus) {
            // pickImagesForSku handles type-appropriate selection:
            // tiles get tile scans, mosaics/accessories/patterns only get type-specific images
            const picked = pickImagesForSku(images, sku.variant_name, sku.variant_type);
            for (let i = 0; i < picked.length; i++) {
              const url = wixFullRes(picked[i].url);
              await upsertMedia(client, {
                product_id: product.id, sku_id: sku.id,
                asset_type: i === 0 ? 'primary' : 'alternate',
                url, sort_order: i,
              });
              imagesSaved++;
            }
            skusMatched++;
          }
          productImageCount += images.length;
        }
      } else {
        // ── No color options in product map ──
        // Only assign images if this product has a single color group,
        // so we're confident the images match. With multiple colors,
        // we can't tell which image belongs to which color.
        if (allProductImages.length > 0 && colorGroups.size <= 1) {
          for (const sku of productSkus) {
            const picked = pickImagesForSku(allProductImages, sku.variant_name, sku.variant_type);
            for (let i = 0; i < picked.length; i++) {
              const url = wixFullRes(picked[i].url);
              await upsertMedia(client, {
                product_id: product.id, sku_id: sku.id,
                asset_type: i === 0 ? 'primary' : 'alternate',
                url, sort_order: i,
              });
              imagesSaved++;
            }
            skusMatched++;
          }
          productImageCount = allProductImages.length;
        } else if (allProductImages.length > 0) {
          console.log(`  ${product.name}: SKIP images — ${colorGroups.size} colors but no color map to match`);
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
            // Color name doesn't have code — extract from variant name
            for (const sku of dbSkus) {
              const m = sku.variant_name.match(/\b(\d{3})\b/);
              if (m) { code = m[1]; break; }
            }
          }
          if (code) {
            if (!codeToSkuIds.has(code)) codeToSkuIds.set(code, []);
            for (const sku of dbSkus) {
              if (sku.variant_type !== 'accessory') codeToSkuIds.get(code).push(sku.id);
            }
          }
        }

        // Also build color-name → SKU IDs map for name-based matching fallback
        // Strip digit codes AND common qualifiers (Cross Cut, Vein Cut, etc.)
        const nameToSkuIds = new Map();
        for (const [dbColor, dbSkus] of colorGroups) {
          let name = dbColor.replace(/\s*\d{3,}\s*/, '').trim();
          // Strip tile cut/finish qualifiers that won't appear in lifestyle filenames
          name = name.replace(/\s+(Cross\s+Cut|Vein\s+Cut|Textured|Polished|Matte|Honed)\b/gi, '').trim().toLowerCase();
          const nonAccSkus = dbSkus.filter(s => s.variant_type !== 'accessory');
          if (nonAccSkus.length === 0) continue;
          if (name && name.length >= 3) {
            if (!nameToSkuIds.has(name)) nameToSkuIds.set(name, []);
            for (const sku of nonAccSkus) nameToSkuIds.get(name).push(sku.id);
          }
          // Also add just the first word as a fallback key (e.g., "avorio" from "avorio cross cut")
          const firstWord = name.split(/\s+/)[0];
          if (firstWord && firstWord.length >= 3 && firstWord !== name) {
            if (!nameToSkuIds.has(firstWord)) nameToSkuIds.set(firstWord, []);
            for (const sku of nonAccSkus) nameToSkuIds.get(firstWord).push(sku.id);
          }
        }

        const lifestyleSortOrders = new Map(); // skuId → next sort_order
        let anyMatchedLifestyle = false;
        const unmatchedLifestyle = [];

        for (const lf of allMediaLifestyle) {
          const decoded = decodeURIComponent(lf.title || '');
          // Strategy 1: Extract 3-digit color codes from title
          const titleCodes = [...decoded.matchAll(/(\d{3})/g)].map(m => m[1]);
          const matchedSkuIds = new Set();

          for (const tc of titleCodes) {
            if (codeToSkuIds.has(tc)) {
              for (const sid of codeToSkuIds.get(tc)) matchedSkuIds.add(sid);
            }
          }

          // Strategy 2: Match by color name in title (e.g., "ONIX90X90_BEIGE_AMB" → "Beige")
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
            for (const skuId of matchedSkuIds) {
              const so = lifestyleSortOrders.get(skuId) || 0;
              if (so >= 3) continue; // max 3 lifestyle per SKU
              await upsertMedia(client, {
                product_id: product.id, sku_id: skuId,
                asset_type: 'lifestyle', url, sort_order: so,
              });
              lifestyleSortOrders.set(skuId, so + 1);
              imagesSaved++;
            }
            anyMatchedLifestyle = true;
          } else {
            unmatchedLifestyle.push(lf);
          }
        }

        // Only save unmatched lifestyle at product level if no per-color lifestyle exists
        // (from linked data alternates OR from allMedia code matching above)
        const hasPerColorLifestyle = anyMatchedLifestyle ||
          (mapEntry.colors && Object.values(mapEntry.colors).some(cd =>
            cd.images && cd.images.some(m => m.type === 'lifestyle')));

        if (!hasPerColorLifestyle && unmatchedLifestyle.length > 0) {
          for (let i = 0; i < Math.min(unmatchedLifestyle.length, 3); i++) {
            const url = wixFullRes(unmatchedLifestyle[i].url);
            await upsertMedia(client, {
              product_id: product.id, sku_id: null,
              asset_type: 'lifestyle', url, sort_order: i,
            });
          }
        }
      }

      if (productImageCount > 0) {
        productsMatched++;
        const accCount = productSkus.filter(s => s.variant_type === 'accessory').length;
        const tileCount = productSkus.length - accCount;
        console.log(`  ${product.name}: ${tileCount} tiles + ${accCount} acc → ${colorGroups.size} colors matched`);
      } else {
        productsFailed++;
        console.log(`  ${product.name}: NO IMAGES`);
      }
    }

    // ── Verify accessory attachment ──
    console.log('\n── Accessory Verification ──');
    const accCheck = await client.query(`
      SELECT p.name, COUNT(CASE WHEN s.variant_type = 'accessory' THEN 1 END) as acc,
             COUNT(CASE WHEN s.variant_type IS NULL THEN 1 END) as tiles
      FROM products p
      JOIN skus s ON s.product_id = p.id AND s.status = 'active'
      WHERE p.vendor_id = $1
      GROUP BY p.name
      HAVING COUNT(CASE WHEN s.variant_type = 'accessory' THEN 1 END) > 0
      ORDER BY p.name
    `, [vendorId]);
    console.log(`Products with accessories: ${accCheck.rowCount}`);
    for (const row of accCheck.rows) {
      console.log(`  ${row.name}: ${row.tiles} tiles + ${row.acc} accessories`);
    }

    await client.query('COMMIT');

    console.log('\n=== Enrichment Complete ===');
    console.log(`Products matched: ${productsMatched} / ${products.rowCount}`);
    console.log(`Products failed: ${productsFailed}`);
    console.log(`SKUs with images: ${skusMatched}`);
    console.log(`Images saved: ${imagesSaved}`);
    console.log(`Descriptions updated: ${descriptionsUpdated}`);

  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch(err => { console.error(err); process.exit(1); });
