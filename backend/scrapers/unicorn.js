/**
 * Unicorn Tile Corp — Per-SKU Image Assignment from Product Map
 *
 * Reads the pre-built product map (unicorn-product-map.json) and assigns
 * images to individual SKUs based on color/size matching in filenames and
 * alt text. Only uses images from each product's own page — never cross-matches
 * images from other products.
 *
 * Prerequisites: Run build-unicorn-product-map.cjs first to scrape images.
 *
 * Usage: docker compose exec api node scrapers/unicorn.js [--force]
 *   --force  Clear existing images and re-assign from scratch
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';
import { filterImageUrls, saveSkuImages } from './base.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAP_PATH = path.join(__dirname, '..', 'data', 'unicorn-product-map.json');

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: 5432, database: 'flooring_pim', user: 'postgres', password: 'postgres',
});

const FORCE = process.argv.includes('--force');

// ── Manual slug aliases: DB product name → website slug ──
const NAME_TO_SLUG = {
  'creative concrete': 'creacon-creative-concrete',
  'ice white': 'ice-white',
  'star blue': 'star-blue',
  'gl series': null,
  'montana white': 'montana-white',
  'decor white': 'decor-white',
  'eclipse beveled': 'eclipse-beveled',
  'ellum stone': 'ellum-stone',
  'akila lux': 'akila-lux',
};

function toSlug(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function norm(s) {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Color synonyms — only used within same product page
const COLOR_SYNONYMS = {
  crema: ['cream', 'ivory'],
  cream: ['crema', 'ivory'],
  grey: ['gray'],
  gray: ['grey'],
  greymix: ['graymix'],
  graymix: ['greymix'],
  darkgrey: ['darkgray'],
  darkgray: ['darkgrey'],
  graphit: ['graphite'],
  graphite: ['graphit'],
  bianco: ['white', 'blanco'],
  blanco: ['white', 'bianco'],
  nero: ['black'],
  smoke: ['smoky'],
  charcoal: ['darkgray', 'darkgrey', 'black'],
  cotto: ['terracotta'],
  green: ['darkgreen', 'verde'],
  verde: ['green', 'darkgreen'],
  blue: ['darkblue'],
  darkblue: ['blue'],
  darkgreen: ['green', 'verde'],
  sand: ['beige'],
  gris: ['grey', 'gray'],
  grigio: ['grey', 'gray'],
  latte: ['lightbrown', 'brown'],
  // Bode uses "Calacatta Statuario" in filenames for what DB calls "Statuario White"
  statuariowhite: ['calacattastatuario'],
  statuario: ['calacattastatuario'],
};

/**
 * Clean a SKU color name by removing dimension/shape junk.
 */
function cleanColor(raw) {
  if (!raw) return '';
  return raw
    .replace(/\d+"?\s*(hex|square|herringbone|mosaic|sheet|bullnose|disco|chevron)/gi, '')
    .replace(/\d+\s*\d*\s*\d*\s*\d*$/g, '')
    .replace(/mesh\s*mounted/gi, '')
    .replace(/[&]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractSize(variantName) {
  if (!variantName) return '';
  const m = variantName.match(/(\d+x\d+)/i);
  return m ? m[1] : '';
}

function extractFinish(variantName) {
  if (!variantName) return '';
  const m = variantName.match(/\b(matte|polished|glossy|lappato|satin|honed)\b/i);
  return m ? m[1].toLowerCase() : '';
}

function extractShape(text) {
  if (!text) return '';
  const m = text.match(/\b(hex(?:agon)?|herringbone|square|chevron|penny|picket|disco|bullnose)\b/i);
  return m ? m[1].toLowerCase().replace('hexagon', 'hex') : '';
}

/**
 * Extract mosaic piece size from text.
 * Variant names: '3" Hex', '2" Square' → "3", "2"
 * Image filenames: '2x2-Hexagon', '3x3-Square-Mosaic' → "2", "3"
 */
function extractPieceSize(text) {
  if (!text) return '';
  // NxN before Hexagon/Square in filenames: "2x2-Hexagon", "3x3-Square"
  let m = text.match(/(\d+)x\d+[- _]?(?:hex|hexagon|square)/i);
  if (m) return m[1];
  // N" before Hex/Square in variant names: '3" Hex', '2" Square'
  m = text.match(/(\d+)"\s*(?:hex|hexagon|square)\b/i);
  if (m) return m[1];
  return '';
}

/**
 * Score how well a product-page image matches a specific SKU.
 * Only used within the same product — never cross-product.
 */
function scoreImageForSku(image, skuColor, skuSize, skuVariantName) {
  const { alt, parsed, url } = image;
  const cleaned = cleanColor(skuColor);
  const colorNorm = norm(cleaned);
  const variantSize = extractSize(skuVariantName);
  const variantFinish = extractFinish(skuVariantName);

  const altNorm = norm(alt || '');
  const parsedNorm = norm(parsed || '');
  const urlNorm = norm(url || '');

  // Build color forms including synonyms
  const colorWords = cleaned.toLowerCase().split(/\s+/).filter(w => w.length >= 3);
  const synonymList = COLOR_SYNONYMS[colorNorm] || [];
  const extraSynonyms = colorWords.flatMap(w => COLOR_SYNONYMS[w] || []);
  const uniqueColorForms = [...new Set([colorNorm, ...synonymList.map(norm), ...extraSynonyms.map(norm)])].filter(c => c.length >= 3);

  let score = 0;

  // Match color in alt text
  for (const cf of uniqueColorForms) {
    if (altNorm && altNorm.includes(cf)) {
      score = Math.max(score, cf === colorNorm ? 10 : 8);
      break;
    }
  }

  // Match color in parsed filename
  if (!score) {
    for (const cf of uniqueColorForms) {
      if (parsedNorm && parsedNorm.includes(cf)) {
        score = Math.max(score, cf === colorNorm ? 8 : 6);
        break;
      }
    }
  }

  // Match color in full URL
  if (!score) {
    for (const cf of uniqueColorForms) {
      if (urlNorm.includes(cf)) {
        score = Math.max(score, 5);
        break;
      }
    }
  }

  // Multi-word color: all significant words present
  if (!score && colorWords.length >= 2) {
    for (const text of [altNorm, parsedNorm, urlNorm]) {
      if (!text) continue;
      if (colorWords.every(w => text.includes(w))) { score = 7; break; }
    }
  }

  // First distinctive word of multi-word color
  if (!score && colorWords.length >= 2) {
    const generic = ['white', 'black', 'grey', 'gray', 'matte', 'polished', 'glossy'];
    const first = colorWords[0];
    if (first.length >= 4 && !generic.includes(first)) {
      for (const text of [altNorm, parsedNorm, urlNorm]) {
        if (text && text.includes(first)) { score = 6; break; }
      }
    }
  }

  if (score <= 0) return 0;

  const combinedText = [altNorm, parsedNorm, urlNorm].filter(Boolean).join(' ');

  // ── Shape mismatch rejection ──
  // If SKU specifies a mosaic shape (hex, herringbone, square, etc.)
  // and the image specifies a DIFFERENT shape, reject it.
  const skuShape = extractShape(skuVariantName || skuColor || '');
  if (skuShape) {
    const imgShape = extractShape(combinedText.replace(/\d/g, ' ')); // strip digits for cleaner shape detection
    // Re-extract from original texts with proper word boundaries
    const imgShapeAlt = extractShape(alt || '');
    const imgShapeParsed = extractShape(parsed || '');
    const imgShapeUrl = extractShape(url || '');
    const foundShape = imgShapeAlt || imgShapeParsed || imgShapeUrl;
    if (foundShape) {
      const foundNorm = foundShape.replace('hexagon', 'hex');
      if (foundNorm !== skuShape) {
        return 0; // Image depicts a different shape
      }
      score += 6; // Shape match bonus
    }
  }

  // ── Mosaic / field-tile format mismatch rejection ──
  // Prevent field tile SKUs from getting mosaic images and vice versa.
  const MOSAIC_RE = /\b(mosaic|hexagon|hex|chevron|herringbone|penny|disco|picket)\b/i;
  const skuIsMosaic = /\b(sheet|mosaic)\b/i.test(skuVariantName) || MOSAIC_RE.test(skuVariantName);
  const imgText = [alt || '', parsed || '', url || ''].join(' ');
  const imgIsMosaic = MOSAIC_RE.test(imgText) || /\bmosaic\b/i.test(imgText);
  if (skuIsMosaic !== imgIsMosaic) {
    return 0; // Format mismatch: mosaic vs field tile
  }

  // Size bonus
  if (variantSize) {
    const sn = norm(variantSize);
    if (altNorm.includes(sn) || parsedNorm.includes(sn) || urlNorm.includes(sn)) score += 5;
  }

  // ── Finish mismatch rejection ──
  // If the image explicitly labels a finish (matte, polished, glossy, etc.)
  // and the SKU has a DIFFERENT finish, reject it.
  if (variantFinish) {
    const imgFinish = extractFinish(alt || '') || extractFinish(parsed || '') || extractFinish(url || '');
    if (imgFinish && imgFinish !== variantFinish) {
      return 0; // Image depicts a different finish
    }
    if (imgFinish === variantFinish) score += 5; // Finish match bonus
  }

  // Shape bonus for mosaics (legacy — only if no shape rejection above)
  if (!skuShape && skuColor) {
    const shapes = (skuColor.match(/(hex|hexagon|square|herringbone|chevron|penny|disco|picket)/gi) || []).map(norm);
    for (const sw of shapes) {
      if (altNorm.includes(sw) || parsedNorm.includes(sw) || urlNorm.includes(sw)) {
        score += 6;
        break;
      }
    }
  }

  // Product-type bonus
  if (image.type === 'product') score += 3;

  return score;
}

/**
 * Match product map slug to DB product.
 */
function matchSlugToProduct(slug, dbProducts) {
  const slugNorm = norm(slug);
  for (const prod of dbProducts) {
    const shortName = prod.name.replace(/^(Unicorn Tile|Deer Tile)\s+/i, '');
    const nameSlug = toSlug(shortName);
    const nameNorm = norm(shortName);
    const alias = NAME_TO_SLUG[shortName.toLowerCase()];
    if (alias === slug) return prod;
    if (nameSlug === slug) return prod;
    if (nameNorm.length >= 4 && slugNorm.includes(nameNorm)) return prod;
    if (slugNorm.length >= 4 && nameNorm.includes(slugNorm)) return prod;
  }
  return null;
}

async function run() {
  if (!fs.existsSync(MAP_PATH)) {
    console.error(`Product map not found at ${MAP_PATH}\nRun: node scripts/build-unicorn-product-map.cjs`);
    process.exit(1);
  }
  const productMap = JSON.parse(fs.readFileSync(MAP_PATH, 'utf8'));
  console.log(`Loaded product map: ${Object.keys(productMap.products).length} products, ${productMap.summary.totalImages} images\n`);

  const vendorRes = await pool.query("SELECT id FROM vendors WHERE code = 'UNICORN'");
  if (!vendorRes.rows.length) { console.error('UNICORN vendor not found'); return; }
  const vendorId = vendorRes.rows[0].id;

  const dbResult = await pool.query(`
    SELECT p.id as product_id, p.name, p.collection,
           s.id as sku_id, s.vendor_sku, s.variant_name, s.variant_type,
           (SELECT sa.value FROM sku_attributes sa JOIN attributes a ON a.id = sa.attribute_id
            WHERE sa.sku_id = s.id AND a.slug = 'color') as color,
           (SELECT sa.value FROM sku_attributes sa JOIN attributes a ON a.id = sa.attribute_id
            WHERE sa.sku_id = s.id AND a.slug = 'size') as size
    FROM products p
    JOIN skus s ON s.product_id = p.id
    WHERE p.vendor_id = $1
    ORDER BY p.name, s.variant_type NULLS FIRST, s.vendor_sku
  `, [vendorId]);

  const productSkus = new Map();
  for (const row of dbResult.rows) {
    if (!productSkus.has(row.product_id)) {
      productSkus.set(row.product_id, {
        product_id: row.product_id, name: row.name, collection: row.collection, skus: [],
      });
    }
    productSkus.get(row.product_id).skus.push({
      sku_id: row.sku_id, vendor_sku: row.vendor_sku, variant_name: row.variant_name,
      variant_type: row.variant_type, color: row.color, size: row.size,
    });
  }

  const dbProducts = [...productSkus.values()];
  console.log(`DB: ${dbProducts.length} products, ${dbResult.rowCount} SKUs total\n`);

  if (FORCE) {
    const del = await pool.query(`DELETE FROM media_assets WHERE product_id IN (SELECT id FROM products WHERE vendor_id = $1)`, [vendorId]);
    console.log(`[FORCE] Cleared ${del.rowCount} existing images\n`);
  }

  const existingSkuImages = await pool.query(`
    SELECT DISTINCT ma.sku_id FROM media_assets ma
    JOIN products p ON p.id = ma.product_id
    WHERE p.vendor_id = $1 AND ma.sku_id IS NOT NULL
  `, [vendorId]);
  const skuHasImage = FORCE ? new Set() : new Set(existingSkuImages.rows.map(r => r.sku_id));

  // Build product → slug mapping
  const slugs = Object.keys(productMap.products);
  const productSlugMap = new Map();
  for (const slug of slugs) {
    const dbProd = matchSlugToProduct(slug, dbProducts);
    if (dbProd) productSlugMap.set(dbProd.product_id, slug);
  }

  let totalSaved = 0, skusWithImages = 0, skusAlreadyHad = 0;

  for (const dbProd of dbProducts) {
    const slug = productSlugMap.get(dbProd.product_id);
    const mainSkus = dbProd.skus.filter(s => s.variant_type !== 'accessory');
    if (!mainSkus.length) continue;

    // No page on website → skip entirely
    if (!slug) {
      console.log(`  [NO PAGE] ${dbProd.name} — not on website, skipping`);
      continue;
    }

    const skusToProcess = mainSkus.filter(s => !skuHasImage.has(s.sku_id));
    if (!skusToProcess.length) {
      console.log(`  [SKIP] ${dbProd.name} — all SKUs have images`);
      skusAlreadyHad += mainSkus.length;
      continue;
    }

    const pageImages = productMap.products[slug].images || [];
    const productShots = pageImages.filter(i => i.type === 'product');
    const lifestyleShots = pageImages.filter(i => i.type === 'lifestyle');

    if (!pageImages.length) {
      console.log(`  [NO IMAGES] ${dbProd.name}`);
      continue;
    }

    // Check if product page has images for multiple mosaic piece sizes (e.g. 2x2 AND 3x3)
    // Only filter by piece size when both sizes exist on the page
    const pagePieceSizes = new Set();
    for (const img of pageImages) {
      const ps = extractPieceSize(img.url || '') || extractPieceSize(img.alt || '') || extractPieceSize(img.parsed || '');
      if (ps) pagePieceSizes.add(ps);
    }
    const hasMixedPieceSizes = pagePieceSizes.size > 1;

    console.log(`  ${dbProd.name}: ${skusToProcess.length} SKUs, ${productShots.length} product + ${lifestyleShots.length} lifestyle`);

    // Determine if this is a single-color product (all SKUs same base color)
    // Finish-only "colors" (matte, polished, glossy, etc.) don't count as distinct colors
    // so products like Montana White (Glossy + Matte) are treated as single-color.
    // Finish mismatch rejection in scoreImageForSku and fallbacks prevents cross-finish mixing.
    const FINISH_ONLY = new Set(['matte', 'polished', 'glossy', 'lappato', 'satin', 'honed']);
    const realColors = mainSkus
      .map(s => norm(cleanColor(s.color)))
      .filter(c => c && !FINISH_ONLY.has(c));
    const uniqueColors = new Set(realColors);
    const isSingleColor = uniqueColors.size <= 1;

    const usedUrls = new Set();

    for (const sku of skusToProcess) {
      // Score images from THIS product's page only
      const otherSkus = mainSkus.filter(s => s.sku_id !== sku.sku_id);
      let scored = pageImages
        .map(img => {
          const myScore = scoreImageForSku(img, sku.color, sku.size, sku.variant_name);
          if (myScore <= 0) return { img, score: 0 };
          // Cross-check: reject if any sibling variant scores strictly higher,
          // or if it scores equal AND the image text contains the sibling's
          // distinctive color word (meaning it "belongs" to that sibling more).
          const myColorNorm = norm(cleanColor(sku.color));
          for (const sib of otherSkus) {
            const sibScore = scoreImageForSku(img, sib.color, sib.size, sib.variant_name);
            if (sibScore > myScore) return { img, score: 0 };
            // Tied score — break tie using full color phrase comparison.
            // Compare stripped-of-shape-words color phrases (and synonyms)
            // to avoid false matches from shared substrings (e.g. "calacatta"
            // appearing in both Gold and Statuario image filenames).
            if (sibScore === myScore && sibScore > 0) {
              const SHAPE_RE = /\b(hex|hexagon|herringbone|square|chevron|penny|picket|disco|bullnose|mosaic|sheet)\b/gi;
              const myCore = norm(cleanColor(sku.color).replace(SHAPE_RE, '').trim());
              const sibCore = norm(cleanColor(sib.color).replace(SHAPE_RE, '').trim());
              if (sibCore && sibCore !== myCore) {
                const imgText = [norm(img.alt || ''), norm(img.parsed || ''), norm(img.url || '')].join(' ');
                // Check full phrase (or synonyms) for each variant
                const sibPhrases = [sibCore, ...(COLOR_SYNONYMS[sibCore] || []).map(norm)];
                const myPhrases = [myCore, ...(COLOR_SYNONYMS[myCore] || []).map(norm)];
                const sibInImg = sibPhrases.some(s => s.length >= 4 && imgText.includes(s));
                const myInImg = myPhrases.some(s => s.length >= 4 && imgText.includes(s));
                // If sibling's full color is in image but ours isn't → belongs to sibling
                if (sibInImg && !myInImg) return { img, score: 0 };
                // Specificity check: if sibling's color contains ours as substring
                // (e.g. "darkgrey" contains "grey"), sibling is more specific → it wins
                if (sibInImg && sibCore.includes(myCore) && sibCore !== myCore) return { img, score: 0 };
              }
            }
          }
          return { img, score: myScore };
        })
        .filter(s => s.score > 0)
        .sort((a, b) => b.score - a.score);

      // Piece-size filter: when product has multiple piece sizes (e.g. 2x2 AND 3x3 hex),
      // filter to only images matching the SKU's piece size
      if (scored.length > 0 && hasMixedPieceSizes) {
        const skuPS = extractPieceSize(sku.variant_name || '');
        if (skuPS) {
          const psFiltered = scored.filter(({ img }) => {
            const imgPS = extractPieceSize(img.url || '') || extractPieceSize(img.alt || '') || extractPieceSize(img.parsed || '');
            return !imgPS || imgPS === skuPS; // Keep matching or unlabeled images
          });
          if (psFiltered.length > 0) scored = psFiltered;
        }
      }

      // Single-color fallback: if all SKUs are same color+finish and no color-based match,
      // assign product shots differentiated by size
      if (!scored.length && isSingleColor && productShots.length) {
        const MOSAIC_RE2 = /\b(mosaic|hexagon|hex|chevron|herringbone|penny|disco|picket)\b/i;
        const skuIsMosaic2 = /\b(sheet|mosaic)\b/i.test(sku.variant_name) || MOSAIC_RE2.test(sku.variant_name);
        // Build set of known colors to detect opposite-color images
        // Compound colors (e.g., "greymix", "darkgrey") listed first so they match
        // before their simpler substrings ("grey", "gray")
        const KNOWN_COLORS = [
          // Compound colors first (sorted longest-first)
          'calacattastatuario', 'darkgreen', 'darkblue', 'darkgrey', 'darkgray',
          'greymix', 'graymix', 'lightbrown',
          // Simple colors
          'black', 'white', 'grey', 'gray', 'blue', 'green', 'red', 'beige', 'cream', 'crema',
          'silver', 'gold', 'latte', 'cotto', 'charcoal', 'sand', 'smoke', 'nero', 'bianco',
          'blanco', 'branco', 'graphite', 'graphit', 'terra', 'umber', 'corten', 'verde',
          'calacatta', 'statuario', 'ivory', 'brown',
        ];
        const skuColorNorm = norm(cleanColor(sku.color));
        const skuColorSyns = new Set([skuColorNorm, ...(COLOR_SYNONYMS[skuColorNorm] || []).map(norm)]);
        // Only apply opposite-color rejection if SKU has a real color (not just a finish)
        const skuHasRealColor = skuColorNorm && !FINISH_ONLY.has(skuColorNorm);
        scored = productShots.map(img => {
          // Mosaic/field-tile format mismatch check
          const imgTxt = [img.alt || '', img.parsed || '', img.url || ''].join(' ');
          const imgIsMosaic2 = MOSAIC_RE2.test(imgTxt);
          if (skuIsMosaic2 !== imgIsMosaic2) return { img, score: 0 };

          // Shape/pattern mismatch rejection: for products where variants differ by shape
          // (e.g., Nox: Flat, Picket, Undulated, Covebase), reject images from wrong shape
          const KNOWN_SHAPES = ['covebase', 'undulated', 'picket', 'flat', 'bullnose',
            'etoile', 'leaf', 'renze', 'wave', 'jolly', 'coral', 'jazz', 'solene'];
          const imgTextNormForShape = norm(imgTxt);
          const skuNameNorm = norm(sku.variant_name || '');
          for (const shape of KNOWN_SHAPES) {
            const imgHas = imgTextNormForShape.includes(shape);
            const skuHas = skuNameNorm.includes(shape);
            if (imgHas && !skuHas) return { img, score: 0 }; // Image is for a different shape
          }

          // Opposite-color rejection: if image filename explicitly mentions a known color
          // that differs from the SKU's color, reject it (only when SKU has a real color)
          // Process compound colors first to avoid "gray" matching inside "graymix"
          if (skuHasRealColor) {
            const imgTextNorm = norm(imgTxt);
            const matchedCompounds = new Set();
            for (const kc of KNOWN_COLORS) {
              if (!imgTextNorm.includes(kc)) continue;
              // Skip if this simple color is part of a compound we already matched
              let isSubstring = false;
              for (const mc of matchedCompounds) {
                if (mc.includes(kc)) { isSubstring = true; break; }
              }
              if (isSubstring) continue;
              matchedCompounds.add(kc);
              if (!skuColorSyns.has(kc)) {
                // Image mentions a color that isn't ours or a synonym → wrong color
                return { img, score: 0 };
              }
            }
          }

          let sc = 5;
          const vs = extractSize(sku.variant_name);
          const vf = extractFinish(sku.variant_name);
          // Reject if image has a different finish than SKU
          if (vf) {
            const imgFinish = extractFinish(img.url || '') || extractFinish(img.alt || '') || extractFinish(img.parsed || '');
            if (imgFinish && imgFinish !== vf) return { img, score: 0 };
            if (imgFinish === vf) sc += 5;
          }
          if (vs) {
            const sn = norm(vs);
            const urlN = norm(img.url || '');
            const altN = norm(img.alt || '');
            const parsedN = norm(img.parsed || '');
            if (urlN.includes(sn) || altN.includes(sn) || parsedN.includes(sn)) sc += 5;
          }
          return { img, score: sc };
        }).filter(s => s.score > 0).sort((a, b) => b.score - a.score);
      }

      // Unlabeled-image fallback: if a multi-color product page has images
      // without any color label (e.g. "Arte 3x12 Glossy" = white variant),
      // match those to unmatched SKUs by size/finish/shape
      if (!scored.length && !isSingleColor && productShots.length) {
        // Find product shots that have NO recognizable color in their alt/filename
        const ALL_COLORS = new Set([
          'black', 'white', 'grey', 'gray', 'blue', 'green', 'red', 'beige', 'cream', 'crema',
          'silver', 'gold', 'latte', 'cotto', 'charcoal', 'sand', 'smoke', 'nero', 'bianco',
          'blanco', 'branco', 'coral', 'jazz', 'solene', 'etoile', 'leaf', 'renze', 'wave',
          'terra', 'umber', 'corten', 'verde', 'calacatta', 'statuario', 'graphite', 'graphit',
          'picket', 'flat', 'undulated', 'covebase', 'darkblue', 'darkgreen',
        ]);
        const unlabeled = productShots.filter(img => {
          const altN = norm(img.alt || '');
          const parsedN = norm(img.parsed || '');
          const urlN = norm(img.url || '');
          for (const c of ALL_COLORS) {
            if (altN.includes(c) || parsedN.includes(c) || urlN.includes(c)) return false;
          }
          return true;
        });
        if (unlabeled.length) {
          const MOSAIC_RE3 = /\b(mosaic|hexagon|hex|chevron|herringbone|penny|disco|picket)\b/i;
          const skuIsMosaic3 = /\b(sheet|mosaic)\b/i.test(sku.variant_name) || MOSAIC_RE3.test(sku.variant_name);
          scored = unlabeled.map(img => {
            // Mosaic/field-tile format mismatch check
            const imgTxt = [img.alt || '', img.parsed || '', img.url || ''].join(' ');
            const imgIsMosaic3 = MOSAIC_RE3.test(imgTxt);
            if (skuIsMosaic3 !== imgIsMosaic3) return { img, score: 0 };

            let sc = 4;
            const vs = extractSize(sku.variant_name);
            const vf = extractFinish(sku.variant_name);
            // Reject if image has a different finish than SKU
            if (vf) {
              const imgFinish = extractFinish(img.url || '') || extractFinish(img.alt || '') || extractFinish(img.parsed || '');
              if (imgFinish && imgFinish !== vf) return { img, score: 0 };
              if (imgFinish === vf) sc += 5;
            }
            if (vs) {
              const sn = norm(vs);
              const urlN = norm(img.url || '');
              const altN = norm(img.alt || '');
              const parsedN = norm(img.parsed || '');
              if (urlN.includes(sn) || altN.includes(sn) || parsedN.includes(sn)) sc += 5;
            }
            return { img, score: sc };
          }).filter(s => s.score > 0).sort((a, b) => b.score - a.score);
        }
      }

      // Lifestyle-only fallback: if the page has NO product shots (e.g. Markina),
      // assign lifestyle images to all SKUs
      if (!scored.length && !productShots.length && lifestyleShots.length) {
        scored = lifestyleShots.map(img => ({ img, score: 3 }));
      }

      if (!scored.length) {
        console.log(`    ${sku.vendor_sku} (${sku.color}) — no match`);
        continue;
      }

      // Pick best: product shot primary, then alternates
      const skuUrls = [];
      const seen = new Set();

      for (const { img } of scored) {
        if (img.type === 'product' && !seen.has(img.fullUrl)) {
          skuUrls.push(img.fullUrl);
          seen.add(img.fullUrl);
          usedUrls.add(img.fullUrl);
          break;
        }
      }

      for (const { img } of scored) {
        if (seen.has(img.fullUrl)) continue;
        skuUrls.push(img.fullUrl);
        seen.add(img.fullUrl);
        usedUrls.add(img.fullUrl);
        if (skuUrls.length >= 4) break;
      }

      if (!skuUrls.length) {
        for (const { img } of scored) {
          if (!seen.has(img.fullUrl)) {
            skuUrls.push(img.fullUrl);
            seen.add(img.fullUrl);
            usedUrls.add(img.fullUrl);
            if (skuUrls.length >= 3) break;
          }
        }
      }

      if (skuUrls.length) {
        const cleaned = filterImageUrls(skuUrls, { maxImages: 6 });
        if (cleaned.length) {
          const saved = await saveSkuImages(pool, dbProd.product_id, sku.sku_id, cleaned, { maxImages: 6 });
          totalSaved += saved;
          skusWithImages++;
          console.log(`    ${sku.vendor_sku} (${sku.color}) → ${saved} images`);
        }
      }
    }

    // Unused lifestyle at product level
    const unusedLifestyle = lifestyleShots.filter(i => !usedUrls.has(i.fullUrl)).map(i => i.fullUrl);
    if (unusedLifestyle.length) {
      const cleaned = filterImageUrls(unusedLifestyle, { maxImages: 4 });
      for (let i = 0; i < cleaned.length; i++) {
        try {
          await pool.query(`
            INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order, source)
            VALUES ($1, NULL, 'lifestyle', $2, $2, $3, 'scraper')
            ON CONFLICT (product_id, asset_type, sort_order) WHERE sku_id IS NULL
            DO UPDATE SET url = EXCLUDED.url, original_url = EXCLUDED.original_url
          `, [dbProd.product_id, cleaned[i], 100 + i]);
          totalSaved++;
        } catch (e) { /* ignore */ }
      }
      console.log(`    + ${cleaned.length} lifestyle at product level`);
    }
  }

  // Final stats
  const totalMainSkus = dbProducts.reduce((s, p) => s + p.skus.filter(sk => sk.variant_type !== 'accessory').length, 0);
  const finalCheck = await pool.query(`
    SELECT COUNT(DISTINCT ma.sku_id) as with_img
    FROM media_assets ma JOIN skus s ON s.id = ma.sku_id JOIN products p ON p.id = s.product_id
    WHERE p.vendor_id = $1 AND ma.sku_id IS NOT NULL
  `, [vendorId]);

  console.log(`\n=== Summary ===`);
  console.log(`SKUs with images this run: ${skusWithImages}`);
  console.log(`Total images saved: ${totalSaved}`);
  console.log(`Total SKUs with per-SKU images: ${finalCheck.rows[0].with_img} / ${totalMainSkus}`);

  const gapResult = await pool.query(`
    SELECT p.name, s.variant_name, s.vendor_sku
    FROM skus s JOIN products p ON p.id = s.product_id
    WHERE p.vendor_id = $1 AND s.variant_type IS DISTINCT FROM 'accessory'
      AND NOT EXISTS (SELECT 1 FROM media_assets ma WHERE ma.sku_id = s.id)
    ORDER BY p.name, s.variant_name
  `, [vendorId]);
  if (gapResult.rows.length) {
    console.log(`\nSKUs without images (${gapResult.rows.length}) — no matching image on product page:`);
    for (const r of gapResult.rows) console.log(`  ${r.name} | ${r.variant_name}`);
  }

  await pool.end();
}

run().catch(err => { console.error(err); process.exit(1); });
