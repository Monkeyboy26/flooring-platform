/**
 * Unicorn Tile Corp — Per-SKU Image Assignment from Product Map
 *
 * Reads the pre-built product map (unicorn-product-map.json) and assigns
 * images to individual SKUs using DOM-aware classification:
 *
 *  - Grid images (right column, per-color swatches) → PRIMARY product image
 *    Matched by colorLabel from alt text on the product page.
 *
 *  - Slider images (left column, room scenes) → SECONDARY lifestyle images
 *    Dispersed round-robin across all color SKUs of the same product.
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
  'le que': 'le-que',
  'rue de paris': 'rue-de-paris',
  'dantilia': 'dantilia',
};

function toSlug(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function norm(s) {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Color synonyms for matching grid colorLabel → SKU color
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

function extractPieceSize(text) {
  if (!text) return '';
  let m = text.match(/(\d+)x\d+[- _]?(?:hex|hexagon|square)/i);
  if (m) return m[1];
  m = text.match(/(\d+)"\s*(?:hex|hexagon|square)\b/i);
  if (m) return m[1];
  return '';
}

/**
 * Score how well a grid image's colorLabel matches a SKU's color.
 * Returns 0 for no match, higher for better match.
 */
function scoreGridImage(image, skuColor, skuSize, skuVariantName) {
  const { colorLabel, parsed, url } = image;
  const cleaned = cleanColor(skuColor);
  const colorNorm = norm(cleaned);
  if (!colorNorm) return 0;

  const labelNorm = norm(colorLabel || '');
  const parsedNorm = norm(parsed || '');
  const urlNorm = norm(url || '');

  // Build color forms including synonyms
  const colorWords = cleaned.toLowerCase().split(/\s+/).filter(w => w.length >= 3);
  const synonymList = COLOR_SYNONYMS[colorNorm] || [];
  const extraSynonyms = colorWords.flatMap(w => COLOR_SYNONYMS[w] || []);
  const uniqueColorForms = [...new Set([colorNorm, ...synonymList.map(norm), ...extraSynonyms.map(norm)])].filter(c => c.length >= 3);

  let score = 0;

  // Best: exact color match in the alt-text label
  for (const cf of uniqueColorForms) {
    if (labelNorm && labelNorm.includes(cf)) {
      score = Math.max(score, cf === colorNorm ? 10 : 8);
      break;
    }
  }

  // Fallback: match in parsed filename
  if (!score) {
    for (const cf of uniqueColorForms) {
      if (parsedNorm && parsedNorm.includes(cf)) {
        score = Math.max(score, cf === colorNorm ? 8 : 6);
        break;
      }
    }
  }

  // Fallback: match in URL
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
    for (const text of [labelNorm, parsedNorm, urlNorm]) {
      if (!text) continue;
      if (colorWords.every(w => text.includes(w))) { score = 7; break; }
    }
  }

  // First distinctive word of multi-word color
  if (!score && colorWords.length >= 2) {
    const generic = ['white', 'black', 'grey', 'gray', 'matte', 'polished', 'glossy'];
    const first = colorWords[0];
    if (first.length >= 4 && !generic.includes(first)) {
      for (const text of [labelNorm, parsedNorm, urlNorm]) {
        if (text && text.includes(first)) { score = 6; break; }
      }
    }
  }

  if (score <= 0) return 0;

  const combinedText = [labelNorm, parsedNorm, urlNorm].filter(Boolean).join(' ');

  // ── Shape mismatch rejection ──
  const skuShape = extractShape(skuVariantName || skuColor || '');
  if (skuShape) {
    const imgShapeAlt = extractShape(colorLabel || '');
    const imgShapeParsed = extractShape(parsed || '');
    const imgShapeUrl = extractShape(url || '');
    const foundShape = imgShapeAlt || imgShapeParsed || imgShapeUrl;
    if (foundShape) {
      const foundNorm = foundShape.replace('hexagon', 'hex');
      if (foundNorm !== skuShape) return 0;
      score += 6;
    }
  }

  // ── Mosaic / field-tile format mismatch rejection ──
  const MOSAIC_RE = /\b(mosaic|hexagon|hex|chevron|herringbone|penny|disco|picket)\b/i;
  const skuIsMosaic = /\b(sheet|mosaic)\b/i.test(skuVariantName) || MOSAIC_RE.test(skuVariantName);
  const imgText = [colorLabel || '', parsed || '', url || ''].join(' ');
  const imgIsMosaic = MOSAIC_RE.test(imgText);
  if (skuIsMosaic !== imgIsMosaic) return 0;

  // Size bonus / mismatch rejection
  const variantSize = extractSize(skuVariantName);
  if (variantSize) {
    const sn = norm(variantSize);
    if (parsedNorm.includes(sn) || urlNorm.includes(sn) || labelNorm.includes(sn)) {
      score += 5;
    } else {
      const imgSize = extractSize(url || '') || extractSize(colorLabel || '') || extractSize(parsed || '');
      if (imgSize && norm(imgSize) !== sn) return 0;
    }
  }

  // Finish mismatch rejection
  const variantFinish = extractFinish(skuVariantName);
  if (variantFinish) {
    const imgFinish = extractFinish(colorLabel || '') || extractFinish(parsed || '') || extractFinish(url || '');
    if (imgFinish && imgFinish !== variantFinish) return 0;
    if (imgFinish === variantFinish) score += 5;
  }

  // Piece-size filter
  const skuPS = extractPieceSize(skuVariantName || '');
  if (skuPS) {
    const imgPS = extractPieceSize(url || '') || extractPieceSize(colorLabel || '') || extractPieceSize(parsed || '');
    if (imgPS && imgPS !== skuPS) return 0;
    if (imgPS === skuPS) score += 3;
  }

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
    const gridImages = pageImages.filter(i => i.source === 'grid');
    const sliderImages = pageImages.filter(i => i.source === 'slider');

    // Backwards compat: if product map lacks source field (old format), fall back
    const hasSourceField = pageImages.some(i => i.source);
    const productShots = hasSourceField ? gridImages : pageImages.filter(i => i.type === 'product');
    const lifestyleShots = hasSourceField ? sliderImages : pageImages.filter(i => i.type === 'lifestyle');

    if (!pageImages.length) {
      console.log(`  [NO IMAGES] ${dbProd.name}`);
      continue;
    }

    console.log(`  ${dbProd.name}: ${skusToProcess.length} SKUs, ${productShots.length} grid + ${lifestyleShots.length} slider`);

    // ── Phase 1: Assign PRIMARY images from grid (right-side per-color swatches) ──
    const skuPrimaryMap = new Map(); // sku_id → [urls]

    for (const sku of skusToProcess) {
      // Score grid images against this SKU's color
      const otherSkus = mainSkus.filter(s => s.sku_id !== sku.sku_id);
      let scored = productShots
        .map(img => {
          const myScore = scoreGridImage(img, sku.color, sku.size, sku.variant_name);
          if (myScore <= 0) return { img, score: 0 };
          // Cross-check: reject if a sibling variant scores strictly higher
          for (const sib of otherSkus) {
            const sibScore = scoreGridImage(img, sib.color, sib.size, sib.variant_name);
            if (sibScore > myScore) return { img, score: 0 };
            // Tied score — break tie using color phrase comparison
            if (sibScore === myScore && sibScore > 0) {
              const SHAPE_RE = /\b(hex|hexagon|herringbone|square|chevron|penny|picket|disco|bullnose|mosaic|sheet)\b/gi;
              const myCore = norm(cleanColor(sku.color).replace(SHAPE_RE, '').trim());
              const sibCore = norm(cleanColor(sib.color).replace(SHAPE_RE, '').trim());
              if (sibCore && sibCore !== myCore) {
                const imgText = [norm(img.colorLabel || img.alt || ''), norm(img.parsed || ''), norm(img.url || '')].join(' ');
                const sibPhrases = [sibCore, ...(COLOR_SYNONYMS[sibCore] || []).map(norm)];
                const myPhrases = [myCore, ...(COLOR_SYNONYMS[myCore] || []).map(norm)];
                const sibInImg = sibPhrases.some(s => s.length >= 4 && imgText.includes(s));
                const myInImg = myPhrases.some(s => s.length >= 4 && imgText.includes(s));
                if (sibInImg && !myInImg) return { img, score: 0 };
                if (sibInImg && sibCore.includes(myCore) && sibCore !== myCore) return { img, score: 0 };
              }
            }
          }
          return { img, score: myScore };
        })
        .filter(s => s.score > 0)
        .sort((a, b) => b.score - a.score);

      // Single-color fallback: if all SKUs are same base color and no match found
      const FINISH_ONLY = new Set(['matte', 'polished', 'glossy', 'lappato', 'satin', 'honed']);
      const realColors = mainSkus
        .map(s => norm(cleanColor(s.color)))
        .filter(c => c && !FINISH_ONLY.has(c));
      const isSingleColor = new Set(realColors).size <= 1;

      if (!scored.length && isSingleColor && productShots.length) {
        const MOSAIC_RE = /\b(mosaic|hexagon|hex|chevron|herringbone|penny|disco|picket)\b/i;
        const skuIsMosaic = /\b(sheet|mosaic)\b/i.test(sku.variant_name) || MOSAIC_RE.test(sku.variant_name);
        const KNOWN_SHAPES = ['covebase', 'undulated', 'picket', 'flat', 'bullnose',
          'etoile', 'leaf', 'renze', 'wave', 'jolly', 'coral', 'jazz', 'solene'];
        const skuNameNorm = norm(sku.variant_name || '');

        scored = productShots.map(img => {
          const imgTxt = [img.colorLabel || img.alt || '', img.parsed || '', img.url || ''].join(' ');
          const imgIsMosaic = MOSAIC_RE.test(imgTxt);
          if (skuIsMosaic !== imgIsMosaic) return { img, score: 0 };

          // Shape mismatch rejection
          const imgTextNorm = norm(imgTxt);
          for (const shape of KNOWN_SHAPES) {
            if (imgTextNorm.includes(shape) && !skuNameNorm.includes(shape)) return { img, score: 0 };
          }

          let sc = 5;
          const vs = extractSize(sku.variant_name);
          const vf = extractFinish(sku.variant_name);
          if (vf) {
            const imgFinish = extractFinish(img.url || '') || extractFinish(img.colorLabel || img.alt || '') || extractFinish(img.parsed || '');
            if (imgFinish && imgFinish !== vf) return { img, score: 0 };
            if (imgFinish === vf) sc += 5;
          }
          if (vs) {
            const sn = norm(vs);
            const urlN = norm(img.url || '');
            const parsedN = norm(img.parsed || '');
            if (urlN.includes(sn) || parsedN.includes(sn)) sc += 5;
            else {
              const imgSize = extractSize(img.url || '') || extractSize(img.parsed || '');
              if (imgSize && norm(imgSize) !== sn) return { img, score: 0 };
            }
          }
          return { img, score: sc };
        }).filter(s => s.score > 0).sort((a, b) => b.score - a.score);
      }

      // Unlabeled-image fallback for multi-color products
      if (!scored.length && !isSingleColor && productShots.length) {
        const ALL_COLORS = new Set([
          'black', 'white', 'grey', 'gray', 'blue', 'green', 'red', 'beige', 'cream', 'crema',
          'silver', 'gold', 'latte', 'cotto', 'charcoal', 'sand', 'smoke', 'nero', 'bianco',
          'blanco', 'branco', 'coral', 'jazz', 'solene', 'etoile', 'leaf', 'renze', 'wave',
          'terra', 'umber', 'corten', 'verde', 'calacatta', 'statuario', 'graphite', 'graphit',
          'picket', 'flat', 'undulated', 'covebase', 'darkblue', 'darkgreen',
        ]);
        const unlabeled = productShots.filter(img => {
          const labelN = norm(img.colorLabel || img.alt || '');
          const parsedN = norm(img.parsed || '');
          const urlN = norm(img.url || '');
          for (const c of ALL_COLORS) {
            if (labelN.includes(c) || parsedN.includes(c) || urlN.includes(c)) return false;
          }
          return true;
        });
        if (unlabeled.length) {
          const MOSAIC_RE = /\b(mosaic|hexagon|hex|chevron|herringbone|penny|disco|picket)\b/i;
          const skuIsMosaic = /\b(sheet|mosaic)\b/i.test(sku.variant_name) || MOSAIC_RE.test(sku.variant_name);
          scored = unlabeled.map(img => {
            const imgTxt = [img.colorLabel || img.alt || '', img.parsed || '', img.url || ''].join(' ');
            const imgIsMosaic = MOSAIC_RE.test(imgTxt);
            if (skuIsMosaic !== imgIsMosaic) return { img, score: 0 };
            let sc = 4;
            const vs = extractSize(sku.variant_name);
            const vf = extractFinish(sku.variant_name);
            if (vf) {
              const imgFinish = extractFinish(img.url || '') || extractFinish(img.parsed || '');
              if (imgFinish && imgFinish !== vf) return { img, score: 0 };
              if (imgFinish === vf) sc += 5;
            }
            if (vs) {
              const sn = norm(vs);
              const urlN = norm(img.url || '');
              const parsedN = norm(img.parsed || '');
              if (urlN.includes(sn) || parsedN.includes(sn)) sc += 5;
              else {
                const imgSize = extractSize(img.url || '') || extractSize(img.parsed || '');
                if (imgSize && norm(imgSize) !== sn) return { img, score: 0 };
              }
            }
            return { img, score: sc };
          }).filter(s => s.score > 0).sort((a, b) => b.score - a.score);
        }
      }

      // Collect primary URLs for this SKU
      const primaryUrls = [];
      const seen = new Set();
      for (const { img } of scored) {
        if (!seen.has(img.fullUrl)) {
          primaryUrls.push(img.fullUrl);
          seen.add(img.fullUrl);
          if (primaryUrls.length >= 2) break; // up to 2 grid images per SKU
        }
      }

      if (primaryUrls.length) {
        skuPrimaryMap.set(sku.sku_id, primaryUrls);
      } else {
        console.log(`    ${sku.vendor_sku} (${sku.color}) — no grid match`);
      }
    }

    // ── Phase 2: Assign slider/lifestyle images to SKUs by color ──
    // Many slider images have color/finish/shape in their filenames
    // (e.g. "Melanie-3x12-Scene-Black.jpg", "Silom-Scene-Leaf-Glossy.jpg").
    // Score each slider image against each SKU; matched images go to the
    // best-matching SKU. Unmatched (generic) images get distributed round-robin.
    const skuSliderMap = new Map(); // sku_id → [urls]

    if (lifestyleShots.length && skusToProcess.length) {
      const genericSlider = []; // images that don't match any SKU

      for (const img of lifestyleShots) {
        // Score this slider image against all SKUs
        let bestSkuId = null;
        let bestScore = 0;

        for (const sku of skusToProcess) {
          // Reuse scoreGridImage — it works on url/parsed/colorLabel fields
          // Slider images have no colorLabel but do have parsed filenames
          const score = scoreGridImage(
            { ...img, colorLabel: img.colorLabel || '' },
            sku.color, sku.size, sku.variant_name,
          );
          if (score > bestScore) {
            bestScore = score;
            bestSkuId = sku.sku_id;
          }
        }

        if (bestSkuId && bestScore > 0) {
          if (!skuSliderMap.has(bestSkuId)) skuSliderMap.set(bestSkuId, []);
          skuSliderMap.get(bestSkuId).push(img.fullUrl);
        } else {
          genericSlider.push(img.fullUrl);
        }
      }

      // Round-robin distribute generic (unmatched) slider images
      if (genericSlider.length) {
        for (let i = 0; i < genericSlider.length; i++) {
          const skuIdx = i % skusToProcess.length;
          const skuId = skusToProcess[skuIdx].sku_id;
          if (!skuSliderMap.has(skuId)) skuSliderMap.set(skuId, []);
          skuSliderMap.get(skuId).push(genericSlider[i]);
        }
      }
    }

    // ── Phase 3: Save combined images per SKU ──
    for (const sku of skusToProcess) {
      const primary = skuPrimaryMap.get(sku.sku_id) || [];
      const secondary = skuSliderMap.get(sku.sku_id) || [];

      // If no grid match but we have slider images, use first slider as primary
      // (better than no image at all)
      const combined = [...primary, ...secondary];

      if (!combined.length) {
        // Last resort: if page has NO grid AND NO slider, try lifestyle-only fallback
        if (!productShots.length && lifestyleShots.length) {
          const fallback = lifestyleShots.map(i => i.fullUrl);
          const cleaned = filterImageUrls(fallback, { maxImages: 3 });
          if (cleaned.length) {
            const saved = await saveSkuImages(pool, dbProd.product_id, sku.sku_id, cleaned, { maxImages: 3 });
            totalSaved += saved;
            skusWithImages++;
            console.log(`    ${sku.vendor_sku} (${sku.color}) → ${saved} images (lifestyle fallback)`);
          }
        }
        continue;
      }

      const cleaned = filterImageUrls(combined, { maxImages: 6 });
      if (cleaned.length) {
        const saved = await saveSkuImages(pool, dbProd.product_id, sku.sku_id, cleaned, { maxImages: 6 });
        totalSaved += saved;
        skusWithImages++;
        console.log(`    ${sku.vendor_sku} (${sku.color}) → ${saved} images (${primary.length} grid + ${secondary.length} slider)`);
      }
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
