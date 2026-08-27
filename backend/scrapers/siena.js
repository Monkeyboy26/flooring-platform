/**
 * Siena Decor — Unified Scraper (Price List + Website Images)
 *
 * Primary source: backend/data/siena/catalog-q4-2025.json (via lib/sienaCatalog.mjs)
 *   - Transcribed from the Siena Q-4-2025 wholesale price list (Rev 8/28/2025)
 *   - 86 collections; loaded through loadSienaCatalog() so this never falls back to
 *     stale data. Run reconciles: upserts current SKUs + deactivates the rest.
 *
 * Secondary source: sienadecor.com portfolio pages (WordPress)
 *   - Collection images with per-SKU color labels
 *   - Room scene / lifestyle images
 *
 * Strategy: products/SKUs/pricing/packaging from the catalog JSON,
 *           images from the website, matched to SKUs by color label.
 *
 * Usage: docker compose exec api node scrapers/siena.js
 */
import pg from 'pg';
import {
  launchBrowser, delay,
  upsertProduct, upsertSku, upsertPricing, upsertPackaging,
  upsertMediaAsset, upsertSkuAttribute,
  isLifestyleUrl, saveProductImages, saveSkuImages,
} from './base.js';
import { loadSienaCatalog, keepInternalSkus } from '../lib/sienaCatalog.mjs';

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

const BASE_URL = 'https://sienadecor.com';

// ──────────────────────────────────────────────
// PRICE LIST — embedded from 2024 FEB Z1 PDF
// ──────────────────────────────────────────────
// Structure: collection → { desc, origin, material, usage, items[] }
// Items: field tiles have `colors`, accessories have `type`
// unit: 'sf' = per sqft (sell_by box), 'pc' = per piece (sell_by unit), 'sh' = per sheet (sell_by unit)

// PRICE_LIST is loaded from backend/data/siena/catalog-q4-2025.json inside run()
// via loadSienaCatalog(pool, vendorId) — single source of truth (was inline 2024 data).

// ──────────────────────────────────────────────
// Website slug mapping — collection name → portfolio-items slug
// ──────────────────────────────────────────────

// (COLLECTION_SLUG_MAP removed — slugs now live in catalog-q4-2025.json per collection)

// ──────────────────────────────────────────────
// Website caption → PRICE_LIST color mapping
// For collections where the website uses different color names
// ──────────────────────────────────────────────

// Explicit caption→color mappings for collections where website labels differ
// from PRICE_LIST color names. Only confident mappings — better no image than wrong.
// IMPORTANT: Do NOT map decorative captions (Deco/Fibre/Inlay/Bend/Grid) to
// plain-tile colors. Only map deco→deco or plain→plain.
const CAPTION_TO_COLOR = {};
// (Q4-2025 catalog colors match the current website labels, so image captions are
// matched directly via matchLabelToColor. The old caption→2024-color aliases were
// removed — they pointed at discontinued colors and would mis-route images.)

// ──────────────────────────────────────────────
// Category keyword mapping
// ──────────────────────────────────────────────

const CATEGORY_KEYWORDS = {
  'porcelain-tile': ['porcelain'],
  'ceramic-tile':   ['ceramic'],
  'mosaic-tile':    ['mosaic'],
};

// Cost markup to generate retail price (2x)
const MARKUP = 2.0;

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

function slugify(text) {
  return (text || '').toUpperCase().replace(/[^A-Z0-9]+/g, '').slice(0, 30);
}

/** Build internal SKU: SIENA-{COLLECTION}-{COLOR/TYPE}-{SIZE}[-{FINISH}] */
function buildInternalSku(collection, colorOrType, size, finish) {
  const col = slugify(collection);
  const ct = slugify(colorOrType);
  const sz = (size || '').replace(/[^0-9xX.]/g, '').toUpperCase();
  const fin = finish ? slugify(finish) : '';
  const parts = ['SIENA', col, ct, sz];
  if (fin) parts.push(fin);
  return parts.join('-');
}

/** Determine category_id for a collection based on material */
async function resolveCategory(pool, material) {
  let slug = 'porcelain-tile'; // default
  if (material === 'ceramic') slug = 'ceramic-tile';
  const res = await pool.query('SELECT id FROM categories WHERE slug = $1', [slug]);
  return res.rows.length ? res.rows[0].id : null;
}

/** Classify accessory type label for variant_name */
function accessoryLabel(type) {
  const labels = {
    'bullnose': 'Bullnose',
    'mosaic': 'Mosaic',
    'london-base': 'London Base',
    'london-top': 'London Top',
    'torello': 'Torello',
    'quarter-round': 'Quarter Round',
    'corner': 'Corner',
    'corner-qr': 'Corner QR',
    'jolly': 'Jolly',
    'liner': 'Liner',
  };
  return labels[type] || type.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// ──────────────────────────────────────────────
// Image scraping helpers
// ──────────────────────────────────────────────

async function createPage(browser) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });
  return page;
}

async function scrollToLoadAll(page) {
  await page.evaluate(async () => {
    for (let i = 0; i < 15; i++) {
      window.scrollBy(0, 400);
      await new Promise(r => setTimeout(r, 200));
    }
    window.scrollTo(0, 0);
  });
  await delay(1000);
}

/**
 * Extract images + labels from a Siena Decor collection page.
 *
 * DOM structure (WordPress gallery):
 *   div.gallery > dl.gallery-item > dt > a > img   (swatch/product photo)
 *                                 > dd.gallery-caption  (color label)
 *
 * Non-gallery images (outside .gallery) are lifestyle / room-scene photos.
 *
 * Returns { swatches: [{src, label}], lifestyleImages: [url], description }
 */
async function extractCollectionImages(page, url) {
  try {
    const resp = await page.goto(url, { waitUntil: 'networkidle2', timeout: 90000 });
    if (!resp || resp.status() >= 400) {
      console.log(`    HTTP ${resp?.status()} for ${url}`);
      return { swatches: [], lifestyleImages: [], description: null };
    }
    await delay(2000);
    await scrollToLoadAll(page);

    const result = await page.evaluate(() => {
      const seen = new Set();
      function fullSize(src) {
        // Only strip WordPress thumbnail dimensions (both values >= 100px).
        // Keep tile-size identifiers like -12x24, -18x18, -3x12, -5x7, -13x26.
        return (src || '').replace(/-(\d+)x(\d+)(\.\w+)(\?|$)/, (m, w, h, ext, end) =>
          (parseInt(w) >= 100 && parseInt(h) >= 100) ? ext + end : m
        );
      }
      function normalize(src) {
        return src.split('?')[0].replace(/-\d+x\d+(\.\w+)$/, '$1');
      }

      // ── 1a. Gallery items: labeled swatch images ──
      const swatches = [];
      document.querySelectorAll('.gallery .gallery-item').forEach(item => {
        const img = item.querySelector('img');
        const caption = item.querySelector('.gallery-caption');
        if (!img) return;
        // Prefer <a> href (full-size original) over <img> src (WP thumbnail)
        const link = img.closest('a');
        const src = (link?.href && link.href.startsWith('http') ? link.href : '') ||
                    img.currentSrc || img.src || img.dataset?.src || '';
        if (!src || !src.startsWith('http')) return;
        const norm = normalize(src);
        if (seen.has(norm)) return;
        seen.add(norm);
        swatches.push({
          src: fullSize(src),
          label: caption?.textContent?.trim() || '',
        });
      });

      // ── 1b. WP-caption containers: labeled images in .wp-caption divs ──
      document.querySelectorAll('.wp-caption').forEach(container => {
        if (container.closest('.gallery')) return; // already handled above
        const img = container.querySelector('img');
        const caption = container.querySelector('.wp-caption-text');
        if (!img) return;
        // Prefer <a> href (full-size original) over <img> src (WP thumbnail)
        const link = img.closest('a');
        const src = (link?.href && link.href.startsWith('http') ? link.href : '') ||
                    img.currentSrc || img.src || img.dataset?.src || '';
        if (!src || !src.startsWith('http')) return;
        const norm = normalize(src);
        if (seen.has(norm)) return;
        seen.add(norm);
        const label = caption?.textContent?.trim() || '';
        if (label) {
          swatches.push({ src: fullSize(src), label });
        }
      });

      // ── 2. Non-gallery images: lifestyle / room-scene ──
      const lifestyleImages = [];
      const contentArea = document.querySelector('.post-content') ||
                          document.querySelector('.entry-content') ||
                          document.querySelector('.fusion-fullwidth') ||
                          document.body;
      contentArea.querySelectorAll('img').forEach(img => {
        if (img.closest('.gallery') || img.closest('.wp-caption')) return;
        const src = img.currentSrc || img.src || img.dataset?.src || '';
        if (!src || !src.startsWith('http')) return;
        if (src.includes('logo') || src.includes('icon') || src.includes('placeholder')) return;
        const norm = normalize(src);
        if (seen.has(norm)) return;
        seen.add(norm);
        lifestyleImages.push(fullSize(src));
      });

      // ── 3. Description ──
      let description = null;
      const descEl = document.querySelector('.fusion-tab-content p') ||
                     document.querySelector('.post-content > p') ||
                     document.querySelector('.entry-content > p');
      if (descEl) {
        const text = descEl.textContent?.trim();
        if (text && text.length > 20 && text.length < 500) description = text;
      }

      return { swatches, lifestyleImages, description };
    });

    return result;
  } catch (err) {
    console.log(`    Error loading ${url}: ${err.message}`);
    return { swatches: [], lifestyleImages: [], description: null };
  }
}

/**
 * Match a scraped image label to a color name (conservative, case-insensitive).
 * Returns the matched color name or null.
 *
 * Strategy: prefer explicit CAPTION_TO_COLOR (handled by caller), then:
 * 1. Exact match (full label)
 * 1b. Exact match after stripping size/finish suffixes (e.g., "AGAVE 12X24 (Pol)" → "AGAVE")
 * 2. Decorative labels (deco/fibre/inlay/etc.) → only match deco colors, else skip
 * 3. Color name starts with label (e.g., "Grey" → "Grey Polished")
 * 4. Label starts with color (e.g., "Black Matte/ Glossy" → "Black")
 */
function matchLabelToColor(label, colors, collectionName = '') {
  if (!label || !colors.length) return null;
  // Normalize the ×/X multiply sign to 'x' so size tokens (e.g. "24×40") are recognized,
  // then drop remaining punctuation.
  let clean = label.toLowerCase().replace(/[×✕✖]/g, 'x')
    .replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
  if (clean.length < 2) return null;

  // Strip a leading collection-name prefix ("CARPET SAND 24x40" → "sand 24x40")
  const collClean = (collectionName || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
  if (collClean && clean.startsWith(collClean + ' ')) clean = clean.slice(collClean.length).trim();

  // Normalize color names consistently (collapse whitespace)
  const norm = c => c.toLowerCase().replace(/\s+/g, ' ').trim();

  // 1. Exact match
  for (const c of colors) {
    if (clean === norm(c)) return c;
  }

  // 1b. Strip size info (e.g., "12X24", "24x48") and finish qualifiers, then retry exact match
  //     Handles labels like "AGAVE 12X24 (Pol)" → "agave", "CREMA MARFIL 24X24 (Mat/Pol)" → "crema marfil"
  const stripped = clean
    .replace(/\s+\d+\s*x\s*\d+.*$/, '')               // strip "12x24 (Pol)" etc.
    .replace(/\s+(?:pol|mat|matte|glossy|polished|natural)\b.*$/i, '')  // strip trailing finish
    .trim();
  if (stripped && stripped !== clean && stripped.length >= 3) {
    for (const c of colors) {
      if (stripped === norm(c)) return c;
    }
  }

  // Detect decorative labels — these should NOT match plain tile colors
  const decoRe = /\b(deco|decor|decoro|fibre|fiber|inlay|3d|bend|grid|honey|bijou|relieve|sigma|ondas|rodia|mix)\b/;
  if (decoRe.test(clean)) {
    // Only match deco colors (those also containing a deco keyword)
    for (const c of colors) {
      const cl = norm(c);
      if (decoRe.test(cl) && (clean.includes(cl) || cl.includes(clean))) return c;
    }
    return null;
  }

  // 2. Color name starts with the label text (or stripped label)
  //    e.g., label "Grey" matches "Grey Polished", "Grey Natural"
  //    Pick the longest label match (most specific)
  let best = null, bestLen = 0;
  for (const label2 of [clean, stripped].filter(Boolean)) {
    for (const c of colors) {
      const cl = norm(c);
      if (cl.startsWith(label2) && label2.length > bestLen) {
        best = c; bestLen = label2.length;
      }
    }
  }
  if (best) return best;

  // 3. Label starts with a color name (min 4 chars to avoid false positives)
  //    e.g., label "Black Matte/ Glossy" matches "Black"
  best = null; bestLen = 0;
  for (const label2 of [clean, stripped].filter(Boolean)) {
    for (const c of colors) {
      const cl = norm(c);
      if (cl.length >= 4 && label2.startsWith(cl) && cl.length > bestLen) {
        best = c; bestLen = cl.length;
      }
    }
  }
  if (best) return best;

  // 4. Unique whole-word match: exactly one color appears as a standalone word in the
  //    label (handles size/collection-suffixed captions like "SAND 24x40" → Sand).
  //    Only fires when a SINGLE color matches — ambiguous captions stay unmatched.
  const wordHits = [];
  for (const c of colors) {
    const cl = norm(c);
    if (cl.length < 4) continue;
    const re = new RegExp(`\\b${cl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
    if (re.test(clean)) wordHits.push(c);
  }
  if (wordHits.length === 1) return wordHits[0];

  return null;
}

// ──────────────────────────────────────────────
// Main scraper
// ──────────────────────────────────────────────

async function run() {
  console.log('=== Siena Decor Scraper ===\n');

  // ── Step 1: Create/lookup vendor ──
  let vendorRes = await pool.query("SELECT id FROM vendors WHERE code = 'SIEN'");
  if (!vendorRes.rows.length) {
    vendorRes = await pool.query(
      "INSERT INTO vendors (name, code, website) VALUES ('Siena Decor', 'SIEN', 'https://sienadecor.com') RETURNING id"
    );
    console.log('Created vendor: Siena Decor');
  }
  const vendorId = vendorRes.rows[0].id;

  // Load current catalog (Q4-2025) keyed by Title-Case collection names.
  const PRICE_LIST = await loadSienaCatalog(pool, vendorId);

  // ── Step 2: Resolve category IDs ──
  const categoryCache = new Map();
  for (const [slug] of Object.entries(CATEGORY_KEYWORDS)) {
    const res = await pool.query('SELECT id FROM categories WHERE slug = $1', [slug]);
    if (res.rows.length) categoryCache.set(slug, res.rows[0].id);
  }

  // ── Step 3: Phase 1 — Data Import from PRICE_LIST ──
  console.log('Phase 1: Importing products from price list...\n');

  let productsCreated = 0;
  let skusCreated = 0;
  const productIndex = new Map(); // collection:color → { productId, skuIds: Map<internalSku, skuId> }

  for (const [collectionName, collData] of Object.entries(PRICE_LIST)) {
    const categoryId = await resolveCategory(pool, collData.material);

    // Gather all unique colors across field tile items
    const allColors = new Set();
    for (const item of collData.items) {
      if (item.colors) {
        for (const c of item.colors) allColors.add(c);
      }
    }

    // ── Create field tile products (one per color) ──
    for (const item of collData.items) {
      if (item.type) continue; // skip accessories for now

      for (const color of item.colors) {
        const productName = allColors.size === 1 && !color.includes('Mix') && !color.includes('Deco')
          ? collectionName
          : `${collectionName} ${color}`;

        const { id: productId, is_new: prodNew } = await upsertProduct(pool, {
          vendor_id: vendorId,
          name: productName,
          collection: collectionName,
          category_id: categoryId,
          description_short: `${collData.desc}. Origin: ${collData.origin}.`,
        });

        if (prodNew) productsCreated++;

        // Build SKU
        const finish = item.finish || null;
        const internalSku = buildInternalSku(collectionName, color, item.size, finish);
        const variantName = finish ? `${item.size}, ${finish}` : item.size;
        const sellBy = item.unit === 'sf' ? 'box' : 'unit';
        const priceBasis = item.unit === 'sf' ? 'per_sqft' : 'per_unit';

        const { id: skuId, is_new: skuNew } = await upsertSku(pool, {
          product_id: productId,
          vendor_sku: '',
          internal_sku: internalSku,
          variant_name: variantName,
          sell_by: sellBy,
          variant_type: collData.usage?.includes('wall') ? 'wall_tile' : 'floor_tile',
        });

        if (skuNew) skusCreated++;

        // Pricing
        const cost = item.price;
        const retail = parseFloat((cost * MARKUP).toFixed(2));
        await upsertPricing(pool, skuId, { cost, retail_price: retail, price_basis: priceBasis });

        // Packaging (only for box-sold items)
        if (item.sf) {
          await upsertPackaging(pool, skuId, {
            sqft_per_box: item.sf,
            pieces_per_box: item.pcs,
            weight_per_box_lbs: item.lbs,
            boxes_per_pallet: item.bxPl || null,
          });
        }

        // SKU attributes
        await upsertSkuAttribute(pool, skuId, 'size', item.size);
        await upsertSkuAttribute(pool, skuId, 'color', color);
        if (finish) await upsertSkuAttribute(pool, skuId, 'finish', finish);
        if (collData.material) await upsertSkuAttribute(pool, skuId, 'material', collData.material);
        if (collData.origin) await upsertSkuAttribute(pool, skuId, 'origin', collData.origin);

        // Index for image matching
        const key = `${collectionName}:${color}`;
        if (!productIndex.has(key)) {
          productIndex.set(key, { productId, skuIds: new Map() });
        }
        productIndex.get(key).skuIds.set(internalSku, skuId);
      }
    }

    // ── Create accessory products ──
    for (const item of collData.items) {
      if (!item.type) continue;

      const accLabel = accessoryLabel(item.type);
      const productName = `${collectionName} ${item.label || accLabel}`;

      const { id: productId, is_new: prodNew } = await upsertProduct(pool, {
        vendor_id: vendorId,
        name: productName,
        collection: collectionName,
        category_id: item.type === 'mosaic' ? (categoryCache.get('mosaic-tile') || categoryId) : categoryId,
        description_short: `${accLabel} trim for the ${collectionName} collection.`,
      });

      if (prodNew) productsCreated++;

      const internalSku = buildInternalSku(collectionName, item.label || item.type, item.size, null);
      const sellBy = item.unit === 'sf' ? 'box' : 'unit';
      const priceBasis = item.unit === 'sf' ? 'per_sqft' : 'per_unit';
      const variantType = item.type === 'mosaic' ? 'mosaic' : 'accessory';

      const { id: skuId, is_new: skuNew } = await upsertSku(pool, {
        product_id: productId,
        vendor_sku: '',
        internal_sku: internalSku,
        variant_name: item.size,
        sell_by: sellBy,
        variant_type: variantType,
      });

      if (skuNew) skusCreated++;

      const cost = item.price;
      const retail = parseFloat((cost * MARKUP).toFixed(2));
      await upsertPricing(pool, skuId, { cost, retail_price: retail, price_basis: priceBasis });

      if (item.sf) {
        await upsertPackaging(pool, skuId, {
          sqft_per_box: item.sf,
          pieces_per_box: item.pcs,
          weight_per_box_lbs: item.lbs,
        });
      } else if (item.pcs) {
        await upsertPackaging(pool, skuId, { pieces_per_box: item.pcs });
      }

      await upsertSkuAttribute(pool, skuId, 'size', item.size);
      if (collData.material) await upsertSkuAttribute(pool, skuId, 'material', collData.material);
    }

    console.log(`  ${collectionName}: imported`);
  }

  console.log(`\nPhase 1 complete: ${productsCreated} products, ${skusCreated} SKUs created\n`);

  // ── Step 4: Phase 2 — Scrape website for images ──
  console.log('Phase 2: Scraping website for images...\n');

  let browser = await launchBrowser();
  let page = await createPage(browser);
  let imagesSaved = 0;

  try {
    for (const [collectionName, collData] of Object.entries(PRICE_LIST)) {
      const slug = collData.slug;
      if (!slug) continue;
      const url = `${BASE_URL}/portfolio-items/${slug}/`;
      console.log(`  Visiting: ${url}`);

      let result;
      try {
        result = await extractCollectionImages(page, url);
      } catch (err) {
        console.log(`    Error: ${err.message}`);
        // Try to recover browser
        try { await page.goto('about:blank', { timeout: 5000 }).catch(() => {}); } catch {
          try { await browser.close(); } catch {}
          browser = await launchBrowser();
          page = await createPage(browser);
        }
        await delay(1000);
        continue;
      }

      const totalImages = result.swatches.length + result.lifestyleImages.length;
      if (!totalImages) {
        console.log(`    No images found`);
        await delay(500);
        continue;
      }

      console.log(`    Found ${result.swatches.length} swatch + ${result.lifestyleImages.length} lifestyle images`);

      // Gather all colors for this collection (collData from the loop above)
      const allColors = [];
      for (const item of collData.items) {
        if (item.colors) allColors.push(...item.colors);
      }
      const uniqueColors = [...new Set(allColors)];

      // ── Match swatch images to colors and save per-SKU ──
      const savedProducts = new Set();
      const captionMap = CAPTION_TO_COLOR[collectionName] || {};

      // ── Pass 1: Collect all image URLs per color ──
      // This prevents many-to-one mappings (e.g., 10 deco captions → Mix Deco)
      // from overwriting each other. Instead we batch them and save once per color.
      const colorImages = new Map(); // color → [imgUrl, ...]
      const finishRe = /\s+(Polished|Natural|Matte|Brillo)\s*$/i;
      // Colors with explicit caption mappings should NOT receive sibling images —
      // they have their own dedicated gallery image (e.g., Carrara Blanco vs Blanco Brillo)
      const explicitlyMappedColors = new Set(Object.values(captionMap));

      for (const swatch of result.swatches) {
        if (!swatch.label || !swatch.label.trim()) continue; // skip empty captions

        // 1. Explicit caption→color mapping (highest priority)
        // 2. Conservative fuzzy match by label only (no filename guessing)
        const matchedColor = captionMap[swatch.label] ||
                             matchLabelToColor(swatch.label, uniqueColors, collectionName);
        if (!matchedColor) {
          console.log(`    [UNMATCHED] caption="${swatch.label}" | available: ${uniqueColors.join(', ')}`);
          continue;
        }

        // Skip filterImageUrls() — it strips ALL -NxN suffixes, destroying tile-size
        // identifiers like -12x24. The page.evaluate fullSize() already handled
        // WP thumbnail stripping correctly (only strips when both dims >= 100).
        const imgUrl = swatch.src;
        if (!imgUrl || !imgUrl.startsWith('http')) continue;

        // Build list of colors to save: primary match + finish siblings
        // e.g., "Grey Polished" → also save to "Grey Matte", "Grey Natural"
        // Skip siblings that have their own explicit caption mapping — they'll
        // get their own image and shouldn't be cross-contaminated.
        const baseColor = matchedColor.replace(finishRe, '').trim().toLowerCase();
        const colorsToSave = [matchedColor];
        for (const c of uniqueColors) {
          if (c === matchedColor) continue;
          const cBase = c.replace(finishRe, '').trim().toLowerCase();
          if (cBase === baseColor && !explicitlyMappedColors.has(c)) colorsToSave.push(c);
        }

        for (const color of colorsToSave) {
          if (!colorImages.has(color)) colorImages.set(color, []);
          const imgs = colorImages.get(color);
          if (!imgs.includes(imgUrl)) imgs.push(imgUrl);
        }
      }

      // ── Pass 2: Save batched images per color ──
      for (const [color, imgUrls] of colorImages) {
        const key = `${collectionName}:${color}`;
        const entry = productIndex.get(key);
        if (!entry) continue;

        for (const [, skuId] of entry.skuIds) {
          const saved = await saveSkuImages(pool, entry.productId, skuId, imgUrls, { maxImages: 4, productName: `${collectionName} ${color}` });
          imagesSaved += saved;
        }
        savedProducts.add(entry.productId);

        const siblingNote = colorImages.has(color) && colorImages.get(color) === imgUrls ? '' : '';
        console.log(`    [SKU] ${color}: ${imgUrls.length} image(s) → 1 product`);
      }

      // Lifestyle images are not labeled per color on the Siena website,
      // so we skip them — better no image than a wrong-color room scene.
      if (result.lifestyleImages.length > 0) {
        console.log(`    [SKIPPED] ${result.lifestyleImages.length} lifestyle images (not color-specific)`);
      }

      // Update description if scraped
      if (result.description) {
        await pool.query(`
          UPDATE products SET description_short = COALESCE(description_short, $1)
          WHERE vendor_id = $2 AND collection = $3 AND description_short IS NULL
        `, [result.description, vendorId, collectionName]);
      }

      await delay(800);
    }
  } finally {
    await browser.close();
  }

  console.log(`\nPhase 2 complete: ${imagesSaved} images saved`);

  // Report image coverage
  const coverageRes = await pool.query(`
    SELECT COUNT(*) as total,
           COUNT(CASE WHEN EXISTS (SELECT 1 FROM media_assets ma WHERE ma.sku_id = s.id) THEN 1 END) as with_img
    FROM skus s JOIN products p ON p.id = s.product_id
    WHERE p.vendor_id = $1 AND s.variant_type NOT IN ('accessory') AND s.status = 'active'
  `, [vendorId]);
  const { total, with_img } = coverageRes.rows[0];
  console.log(`  Image coverage: ${with_img}/${total} field tile SKUs (${(100*with_img/total).toFixed(1)}%)\n`);

  // ── Step 5: Phase 3 — Activate products ──
  console.log('Phase 3: Activating products...\n');

  // Activate SKUs with pricing
  const skuActivated = await pool.query(`
    UPDATE skus SET status = 'active'
    WHERE product_id IN (SELECT id FROM products WHERE vendor_id = $1)
      AND status = 'draft'
      AND EXISTS (SELECT 1 FROM pricing pr WHERE pr.sku_id = skus.id AND pr.retail_price > 0)
    RETURNING id
  `, [vendorId]);
  console.log(`  Activated ${skuActivated.rowCount} SKUs with pricing`);

  // Activate products with active SKUs
  const prodActivated = await pool.query(`
    UPDATE products SET status = 'active'
    WHERE vendor_id = $1
      AND status = 'draft'
      AND EXISTS (SELECT 1 FROM skus s WHERE s.product_id = products.id AND s.status = 'active')
    RETURNING id
  `, [vendorId]);
  console.log(`  Activated ${prodActivated.rowCount} products`);

  // ── Step 5b: Deactivate SKUs/products no longer in the current catalog ──
  // (status='inactive', NOT deleted — order history stays intact)
  const keep = [...keepInternalSkus(PRICE_LIST)];
  const deactSku = await pool.query(`
    UPDATE skus SET status='inactive'
    WHERE product_id IN (SELECT id FROM products WHERE vendor_id=$1)
      AND status='active' AND internal_sku <> ALL($2::text[])
    RETURNING id`, [vendorId, keep]);
  console.log(`  Deactivated ${deactSku.rowCount} discontinued SKUs`);
  const deactProd = await pool.query(`
    UPDATE products SET status='inactive'
    WHERE vendor_id=$1 AND status='active'
      AND NOT EXISTS (SELECT 1 FROM skus s WHERE s.product_id=products.id AND s.status='active')
    RETURNING id`, [vendorId]);
  console.log(`  Deactivated ${deactProd.rowCount} products with no active SKUs`);

  // ── Step 6: Phase 4 — Refresh search vectors ──
  console.log('\nPhase 4: Refreshing search vectors...\n');

  // Use the DB's proper refresh_search_vectors function for each product
  const sienaProducts = await pool.query(
    'SELECT id FROM products WHERE vendor_id = $1', [vendorId]
  );
  for (const row of sienaProducts.rows) {
    await pool.query('SELECT refresh_search_vectors($1)', [row.id]);
  }
  console.log(`  Search vectors refreshed for ${sienaProducts.rowCount} products`);

  console.log('\n=== Scrape Complete ===');
  console.log(`Products created: ${productsCreated}`);
  console.log(`SKUs created: ${skusCreated}`);
  console.log(`Images saved: ${imagesSaved}`);

  await pool.end();
}

run().catch(err => { console.error(err); process.exit(1); });
