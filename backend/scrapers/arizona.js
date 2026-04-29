import {
  delay, upsertProduct, upsertSku,
  upsertSkuAttribute, upsertPackaging, upsertPricing,
  upsertInventorySnapshot,
  appendLog, addJobError,
  downloadImage, upsertMediaAsset, resolveImageExtension,
  deslugify, buildVariantName, preferProductShot, filterImageUrls,
  filterImagesByVariant, isLifestyleUrl
} from './base.js';
import { BASE_URL } from './arizona-auth.js';
import { loadAllPriceLists } from './arizona-prices.js';

const DEFAULT_CONFIG = {
  delayMs: 1000,
  downloadImages: true,
  perPage: 100,
};

// Max gallery images per SKU (primary + lifestyle + 6 alternate)
const MAX_GALLERY_IMAGES = 8;

/**
 * Filter out wide hero/banner images from Arizona Tile's Widen CDN.
 * These have URL params like w=2000&h=813 or w=1600&h=650 — extreme aspect
 * ratios (>2:1) that are collection banners, not product shots.
 */
function filterWideBanners(urls) {
  return urls.filter(url => {
    // Reject known placeholder filenames
    if (/generic-photo-coming-soon/i.test(url)) return false;
    const wMatch = url.match(/[?&]w=(\d+)/);
    const hMatch = url.match(/[?&]h=(\d+)/);
    if (wMatch && hMatch) {
      const w = parseInt(wMatch[1]);
      const h = parseInt(hMatch[1]);
      if (h > 0 && w / h > 2) return false;
    }
    return true;
  });
}

/**
 * Filter out Widen CDN placeholder images ("Preview Not Available").
 * Placeholders are exactly 8,016 bytes; real images at w=765 are 15KB+.
 * Uses HEAD requests to check Content-Length, rejects ≤ 10,000 bytes.
 */
async function filterWidenPlaceholders(urls) {
  if (!urls || urls.length === 0) return [];
  const checks = await Promise.allSettled(urls.map(async (url) => {
    if (!url.includes('.widen.net')) return { url, ok: true };
    try {
      const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
      const len = parseInt(res.headers.get('content-length') || '0', 10);
      return { url, ok: len > 10000 };
    } catch { return { url, ok: false }; }
  }));
  return checks
    .filter(r => r.status === 'fulfilled' && r.value.ok)
    .map(r => r.value.url);
}

// AZ Tile category slug → PIM category slug
/**
 * Arizona Tile → PIM category mapping.
 *
 * AZ products have MANY category tags (material, format, finish, look, collection).
 * Each entry maps an AZ slug to [pimSlug, priority].
 * When a product belongs to multiple AZ categories, the highest-priority match wins.
 *
 * Priority guide:
 *   90 — specific slab material (granite-slab, quartzite, della-terra-quartz)
 *   80 — specific tile material (porcelain-and-ceramic, marble-tile)
 *   70 — material from Outer Limits / Special Order subcategories
 *   60 — format-specific (mosaic, stacked-stone, pavers, large-format)
 *   50 — generic material parents (natural-stone-tile, natural-stone-slab)
 *   30 — generic cross-references (liners, special-order-series, outer-limits top-level)
 *    0 — skip (looks-like, recycled, made-in-usa, locations)
 */
const CATEGORY_MAP = {
  // ── Tile: specific material (priority 80) ──
  'porcelain-and-ceramic':          ['porcelain-tile', 80],
  'marble-tile':                    ['natural-stone', 80],
  'marble-dolomite-tile':           ['natural-stone', 80],
  'granite-tile':                   ['natural-stone', 80],
  'limestone-tile':                 ['natural-stone', 80],
  'travertine':                     ['natural-stone', 80],
  'basalt-tile':                    ['natural-stone', 80],
  'dolomite':                       ['natural-stone', 80],
  'tumbled-stone':                  ['natural-stone', 80],
  'glass':                          ['porcelain-tile', 80],
  'quarry-tile':                    ['ceramic-tile', 80],
  'agglomerate-marble':             ['natural-stone', 80],
  'metal':                          ['porcelain-tile', 60],

  // ── Slab: specific material (priority 90) ──
  'granite-slab':                   ['granite-countertops', 90],
  'marble-slab':                    ['marble-countertops', 90],
  'della-terra-quartz':             ['quartz-countertops', 90],
  'quartzite':                      ['quartzite-countertops', 90],
  'limestone-slab':                 ['marble-countertops', 90],
  'travertine-slab':                ['marble-countertops', 90],
  'agglomerate-marble-slab':        ['marble-countertops', 90],
  'della-terra-porcelain-slabs':    ['porcelain-slabs', 90],
  'della-terra-porcelain-slabs-outer-limits': ['porcelain-slabs', 90],

  // ── Outer Limits subcategories (priority 70) ──
  'granite':                        ['granite-countertops', 70],   // OL granite slab (2368)
  'limestone':                      ['marble-countertops', 70],    // OL limestone slab (2369)
  'marble':                         ['marble-countertops', 70],    // OL marble slab (2370)
  'travertine-natural-stone-slab':  ['marble-countertops', 70],    // OL travertine slab (2371)
  'quartzite-natural-stone-slab':   ['quartzite-countertops', 70], // OL quartzite slab (2425)
  'limestone-natural-stone-tile':   ['natural-stone', 70],         // OL limestone tile (2458)
  'travertine-natural-stone-tile':  ['natural-stone', 70],         // OL travertine tile (2457)
  'natural-stone-patterns-tile':    ['natural-stone', 70],         // OL patterns tile (2461)

  // ── Special Order subcategories (priority 70) ──
  'stone':                          ['natural-stone', 70],         // Special order natural stone (1437)
  'glass-special-order-series':     ['mosaic-tile', 70],           // Special order glass (1436)

  // ── Format-specific (priority 60) ──
  'decorative-mosaics-mesh-mounts': ['mosaic-tile', 60],
  'porcelain-mosaics-mesh-mounts':  ['mosaic-tile', 60],
  'natural-stone-mosaics-mesh-mounts': ['mosaic-tile', 60],
  'glass-mosaics-mesh-mounts':      ['mosaic-tile', 60],
  'stack':                          ['stacked-stone', 60],
  'porcelain-stack':                ['stacked-stone', 60],
  'natural-stone-stack':            ['stacked-stone', 60],
  'stack-tile':                     ['stacked-stone', 60],
  'pavers':                         ['pavers', 60],
  'special-order-pavers':           ['pavers', 60],
  'natural-stone-special-order-pavers': ['pavers', 60],
  'porcelain-special-order-pavers': ['pavers', 60],
  'large-format-tile':              ['large-format-tile', 55],
  'large-format-porcelain-tile':    ['large-format-tile', 55],
  'large-format-natural-stone-tile': ['natural-stone', 60],
  'patterned-tile':                 ['porcelain-tile', 55],
  'natural-stone-patterns':         ['natural-stone', 55],

  // ── Generic parents (priority 50) ──
  'natural-stone-tile':             ['natural-stone', 50],
  'natural-stone-slab':             ['natural-stone', 50],

  // ── 3D tile subcategories (priority 55) ──
  'porcelain-and-ceramic-3d-tile':  ['porcelain-tile', 55],
  'natural-stone-3d-tile':          ['natural-stone', 55],
  '3d-tile':                        ['porcelain-tile', 45],

  // ── R11 finish — porcelain tiles with slip resistance (priority 40) ──
  'r11-finish':                     ['porcelain-tile', 40],

  // ── Low-priority generic parents (priority 30) ──
  // These only win if no better category matched
  'liners-moldings-trim':           ['transitions-moldings', 30],
  'ceramic-porcelain':              ['transitions-moldings', 30],  // "Porcelain & Ceramic Liners"
  'natural-stone-liners':           ['transitions-moldings', 30],
  'glass-liners':                   ['transitions-moldings', 30],
  'outer-limits':                   ['porcelain-tile', 20],        // generic OL fallback only
  'special-order-series':           ['natural-stone', 20],         // generic SO fallback
  'porcelain':                      ['porcelain-tile', 20],        // generic porcelain (SO sub)
  'tile':                           ['porcelain-tile', 10],        // top-level "Tile" parent
  'slab':                           ['natural-stone', 10],         // top-level "Slab" parent

  // ── Defensive entries ──
  'slate':                          ['natural-stone', 80],
  'onyx':                           ['natural-stone', 80],
  'ceramic':                        ['ceramic-tile', 80],
  'basalt-natural-stone-slab':      ['marble-countertops', 70],
  'basalt':                         ['natural-stone', 70],
  'dolomite-slab':                  ['marble-countertops', 90],
  'soapstone':                      ['natural-stone', 80],
};

/**
 * AZ category slugs to skip entirely — these are cross-reference tags, not material types.
 * Products tagged with these also have a real material category.
 */
const CATEGORY_SKIP = new Set([
  'looks-like', 'natural-stone', 'concrete', 'geometric-shapes', 'hand-painted',
  'subway', 'wood',                          // "Looks Like" children (aesthetics)
  'recycled-material-content',               // eco-label, not material
  'made-in-usa', 'made-in-usa-slab',         // origin tag
  'uncategorized', 'test-video', 'slab-outlet', 'quartz',  // misc
]);

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const ACCESSORY_KEYWORDS = /\b(trim|molding|moulding|reducer|stair\s*nose|transition|threshold|t-molding|quarter\s*round|underlayment|adhesive|grout|sealer|caulk|bullnose|cove\s*base|pencil\s*liner)\b/i;

// Categories sold per piece/sheet (not per sqft in boxes)
const UNIT_CATEGORIES = new Set([
  'mosaic-tile',
  'granite-countertops', 'marble-countertops', 'quartz-countertops',
  'quartzite-countertops', 'porcelain-slabs',
]);
// Slab categories eligible for multi-gauge (thickness) SKU splitting
const SLAB_CATEGORIES = new Set([
  'granite-countertops', 'marble-countertops', 'quartz-countertops',
  'quartzite-countertops', 'porcelain-slabs',
]);
// Categories that don't use box packaging (slabs, sheets)
const NO_BOX_CATEGORIES = new Set([
  'mosaic-tile', 'granite-countertops', 'marble-countertops',
  'quartz-countertops', 'quartzite-countertops', 'porcelain-slabs',
]);

function resolveSellBy(pimSlug, accessory, parsedSoldBy) {
  if (accessory) return 'unit';
  if (pimSlug && UNIT_CATEGORIES.has(pimSlug)) return 'unit';
  return parsedSoldBy || 'sqft';
}

function isAccessory(title, description) {
  return ACCESSORY_KEYWORDS.test(title) || (description && ACCESSORY_KEYWORDS.test(description));
}

/**
 * Arizona Tile catalog scraper.
 *
 * Uses WP REST API for listing + HTML scraping for detail specs.
 * No auth needed — catalog is public.
 *
 * Modes (set via source.config.mode):
 *   'full'      — (default) Full catalog scrape: products, SKUs, images, specs, packaging, pricing, inventory
 *   'inventory' — Lightweight pass: updates only inventory + pricing for existing AZT- SKUs
 *
 * Flow:
 *   1. Fetch products via WP REST API
 *   2. Fetch detail pages, parse specs/gallery/variations/packaging/pricing
 *   3. Full mode: upsert products/SKUs/images/specs/packaging/pricing/inventory + activate
 *      Inventory mode: update inventory + pricing for existing SKUs only
 */
export async function run(pool, job, source) {
  const config = { ...DEFAULT_CONFIG, ...(source.config || {}) };
  const vendor_id = source.vendor_id;
  const isInventoryMode = config.mode === 'inventory';

  const stats = {
    found: 0, created: 0, updated: 0, skusCreated: 0,
    imagesSet: 0, skipped: 0, errors: 0,
    inventoryUpdated: 0, pricingUpdated: 0,
    priceListHits: 0, priceListMisses: 0,
  };

  // Load price list data (all 4 Excel files)
  let priceList = null;
  try {
    priceList = loadAllPriceLists();
    await appendLog(pool, job.id, `Price lists loaded: ${priceList.stats.total} entries (tile: ${priceList.stats.tile}, quartz: ${priceList.stats.quartz}, porcelain-slab: ${priceList.stats.porcelainSlab}, stone: ${priceList.stats.stone})`);
  } catch (err) {
    await appendLog(pool, job.id, `Warning: could not load price lists: ${err.message}. Falling back to web prices.`);
  }

  if (!isInventoryMode) {
    // Ensure all required attributes exist (idempotent)
    const requiredAttrs = [
      { name: 'Edge', slug: 'edge', display_order: 11 },
      { name: 'Look', slug: 'look', display_order: 12 },
      { name: 'Water Absorption', slug: 'water_absorption', display_order: 13 },
      { name: 'DCOF', slug: 'dcof', display_order: 14 },
      { name: 'Breaking Strength', slug: 'breaking_strength', display_order: 15 },
      { name: 'Frost Resistant', slug: 'frost_resistant', display_order: 16 },
      { name: 'Abrasion Resistance', slug: 'abrasion_resistance', display_order: 17 },
      { name: 'MOHS', slug: 'mohs', display_order: 18 },
      { name: 'Shade Variation', slug: 'shade_variation', display_order: 19 },
      { name: 'Staining Resistance', slug: 'staining_resistance', display_order: 20 },
      { name: 'Thermal Shock', slug: 'thermal_shock', display_order: 21 },
    ];
    for (const attr of requiredAttrs) {
      await pool.query(`
        INSERT INTO attributes (name, slug, display_order)
        VALUES ($1, $2, $3) ON CONFLICT (slug) DO NOTHING
      `, [attr.name, attr.slug, attr.display_order]);
    }
  }

  // Build slug → category_id lookup (only needed for full mode)
  const categoryLookup = new Map();
  if (!isInventoryMode) {
    try {
      const catRows = await pool.query('SELECT id, slug FROM categories WHERE is_active = true');
      for (const row of catRows.rows) categoryLookup.set(row.slug, row.id);
    } catch (err) {
      await appendLog(pool, job.id, 'Warning: category lookup failed: ' + err.message);
    }
  }

  const touchedProductIds = [];

  await appendLog(pool, job.id, `Mode: ${isInventoryMode ? 'INVENTORY' : 'FULL'}`);

  // ── Phase 1: Fetch all products via REST API + build category lookup ──

  // Fetch category taxonomy for mapping product_cat IDs → slugs
  await appendLog(pool, job.id, 'Phase 1: Fetching categories from REST API...');
  const azCategoryMap = new Map(); // cat_id → { name, slug, parent }
  try {
    const catResp = await fetch(`${BASE_URL}/api/wp/v2/product_cat?per_page=100`, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(30000)
    });
    if (catResp.ok) {
      const cats = await catResp.json();
      for (const cat of cats) {
        azCategoryMap.set(cat.id, { name: cat.name, slug: cat.slug, parent: cat.parent });
      }
      await appendLog(pool, job.id, `Fetched ${azCategoryMap.size} AZ Tile categories`);
    }
  } catch (err) {
    await appendLog(pool, job.id, `Warning: could not fetch categories: ${err.message}`);
  }

  // Fetch all products via paginated REST API
  await appendLog(pool, job.id, 'Fetching products from REST API...');
  const allProducts = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    try {
      const resp = await fetch(
        `${BASE_URL}/api/wp/v2/product?per_page=${config.perPage}&page=${page}`,
        { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(30000) }
      );

      if (!resp.ok) {
        if (resp.status === 400) {
          hasMore = false;
          break;
        }
        throw new Error(`REST API returned ${resp.status}`);
      }

      const products = await resp.json();
      if (!products.length) {
        hasMore = false;
        break;
      }

      for (const p of products) {
        const classListRaw = p.class_list || {};
        const classList = Array.isArray(classListRaw) ? classListRaw : Object.values(classListRaw);
        const isInStock = classList.some(c => c.includes('instock'));
        const isVariable = classList.some(c => c.includes('variable'));

        allProducts.push({
          wpId: p.id,
          slug: p.slug,
          title: stripTags(p.title?.rendered || ''),
          link: p.link,
          categoryIds: p.product_cat || [],
          isInStock,
          isVariable,
          description: p.yoast_head_json?.description || null,
        });
      }

      const totalPages = parseInt(resp.headers.get('X-WP-TotalPages') || '5', 10);
      hasMore = page < totalPages;
      page++;
      await delay(config.delayMs);
    } catch (err) {
      await appendLog(pool, job.id, `REST API page ${page} error: ${err.message}`);
      await addJobError(pool, job.id, `REST API page ${page}: ${err.message}`);
      hasMore = false;
    }
  }

  stats.found = allProducts.length;
  await appendLog(pool, job.id, `Phase 1 complete: ${stats.found} products from REST API`, {
    products_found: stats.found
  });

  // ── Phase 2: Fetch detail pages ──

  const batchSize = isInventoryMode ? 5 : 3;
  await appendLog(pool, job.id, `Phase 2: Fetching detail pages (batch size ${batchSize})...`);

  // Cache parsed detail data per product
  const detailCache = new Map(); // wpId → parsedDetail | null
  let fetchIdx = 0;

  for (let batchStart = 0; batchStart < allProducts.length; batchStart += batchSize) {
    const batch = allProducts.slice(batchStart, batchStart + batchSize);

    const batchPromises = batch.map(async (apiProduct) => {
      try {
        const detailResp = await fetch(apiProduct.link, {
          headers: { 'User-Agent': USER_AGENT },
          signal: AbortSignal.timeout(30000)
        });
        if (!detailResp.ok) {
          detailCache.set(apiProduct.wpId, null);
          return;
        }
        const html = await detailResp.text();
        detailCache.set(apiProduct.wpId, parseDetailPage(html));
      } catch {
        detailCache.set(apiProduct.wpId, null);
      }
    });

    await Promise.all(batchPromises);
    fetchIdx += batch.length;

    if (fetchIdx % 50 < batchSize || fetchIdx === allProducts.length) {
      await appendLog(pool, job.id, `Fetch progress: ${fetchIdx}/${allProducts.length} pages`);
    }

    await delay(isInventoryMode ? Math.floor(config.delayMs * 0.7) : config.delayMs);
  }

  const fetchedCount = [...detailCache.values()].filter(v => v != null).length;
  await appendLog(pool, job.id, `Fetched ${fetchedCount}/${allProducts.length} detail pages`);

  // ── Phase 3 ──

  if (isInventoryMode) {
    // ── Inventory mode: update existing SKUs only ──
    await appendLog(pool, job.id, 'Phase 3: Updating inventory + pricing for existing SKUs...');

    // Build internal_sku → sku record lookup for all AZT- SKUs
    const existingSkus = await pool.query(`SELECT id, internal_sku, sell_by FROM skus WHERE internal_sku LIKE 'AZT-%'`);
    const skuLookup = new Map(existingSkus.rows.map(r => [r.internal_sku, { id: r.id, sell_by: r.sell_by }]));
    await appendLog(pool, job.id, `Found ${skuLookup.size} existing AZT- SKUs in DB`);

    let processIdx = 0;
    for (const apiProduct of allProducts) {
      const detail = detailCache.get(apiProduct.wpId);
      if (!detail) continue;

      try {
        const collectionName = apiProduct.title;

        if (apiProduct.isVariable && detail.variations.length > 0) {
          for (const v of detail.variations) {
            if (v.attributes?.attribute_pa_size === 'sample') continue;

            const internalSku = `AZT-${v.variation_id}`;
            const skuRec = skuLookup.get(internalSku);
            if (!skuRec) continue;
            const skuId = skuRec.id;

            // Update pricing from price list only (no WC fallback)
            const plEntry = priceList
              ? priceList.lookup(collectionName, v.attributes?.attribute_pa_color, v.attributes?.attribute_pa_size, v.attributes?.attribute_pa_finishes)
              : null;

            if (plEntry) {
              const cost = plEntry.netPrice;
              const sellBy = (plEntry.unit === 'EA' || plEntry.unit === 'SHT') ? 'unit' : 'sqft';
              await upsertPricing(pool, skuId, {
                cost,
                retail_price: Math.round(cost * 2 * 100) / 100,
                price_basis: sellBy === 'unit' ? 'per_unit' : 'per_sqft',
              });
              stats.pricingUpdated++;
            }

            // Update inventory from variation stock status
            const qtyOnHand = v.max_qty ? parseInt(v.max_qty) : (v.is_in_stock ? 1 : 0);
            await upsertInventorySnapshot(pool, skuId, 'default', {
              qty_on_hand_sqft: qtyOnHand,
              qty_in_transit_sqft: 0,
            });
            stats.inventoryUpdated++;
          }
        } else {
          const internalSku = `AZT-${apiProduct.wpId}`;
          const skuRec = skuLookup.get(internalSku);
          if (!skuRec) continue;
          const skuId = skuRec.id;

          // Update pricing: price list first, then page price fallback
          const plEntry = priceList ? priceList.lookup(collectionName, null, null, null) : null;

          if (plEntry) {
            const cost = plEntry.netPrice;
            const sellBy = (plEntry.unit === 'EA' || plEntry.unit === 'SHT') ? 'unit' : 'sqft';
            await upsertPricing(pool, skuId, {
              cost,
              retail_price: Math.round(cost * 2 * 100) / 100,
              price_basis: sellBy === 'unit' ? 'per_unit' : 'per_sqft',
            });
            stats.pricingUpdated++;
          }

          // Update inventory from stock status
          await upsertInventorySnapshot(pool, skuId, 'default', {
            qty_on_hand_sqft: apiProduct.isInStock ? 1 : 0,
            qty_in_transit_sqft: 0,
          });
          stats.inventoryUpdated++;
        }
      } catch (err) {
        stats.errors++;
      }

      processIdx++;
      if (processIdx % 100 === 0) {
        await appendLog(pool, job.id, `Inventory progress: ${processIdx}/${allProducts.length}, updated: ${stats.inventoryUpdated}`);
      }
    }

    await appendLog(pool, job.id,
      `Inventory scrape complete. Entries: ${stats.found}, ` +
      `Inventory updated: ${stats.inventoryUpdated}, Pricing updated: ${stats.pricingUpdated}, ` +
      `Errors: ${stats.errors}`,
      { products_found: stats.found }
    );
  } else {
    // ── Full mode: upsert products + SKUs ──
    await appendLog(pool, job.id, 'Phase 3: Upserting products and SKUs...');

    let idx = 0;
    for (const apiProduct of allProducts) {
      const detail = detailCache.get(apiProduct.wpId);
      if (!detail) {
        stats.skipped++;
        idx++;
        continue;
      }

      try {
        // Resolve PIM category — score all AZ categories and pick highest priority
        let categoryId = null;
        let pimCatSlug = null;
        let bestPriority = -1;

        for (const catId of apiProduct.categoryIds) {
          const azCat = azCategoryMap.get(catId);
          if (!azCat || CATEGORY_SKIP.has(azCat.slug)) continue;

          const mapping = CATEGORY_MAP[azCat.slug];
          if (mapping) {
            const [slug, priority] = mapping;
            if (priority > bestPriority && categoryLookup.has(slug)) {
              bestPriority = priority;
              categoryId = categoryLookup.get(slug);
              pimCatSlug = slug;
            }
          }
          // Also check parent category (lower priority since less specific)
          if (azCat.parent) {
            const parentCat = azCategoryMap.get(azCat.parent);
            if (parentCat && !CATEGORY_SKIP.has(parentCat.slug)) {
              const parentMapping = CATEGORY_MAP[parentCat.slug];
              if (parentMapping) {
                const [slug, priority] = parentMapping;
                // Parent match gets a small penalty
                const adjPriority = priority - 5;
                if (adjPriority > bestPriority && categoryLookup.has(slug)) {
                  bestPriority = adjPriority;
                  categoryId = categoryLookup.get(slug);
                  pimCatSlug = slug;
                }
              }
            }
          }
        }

        // ── Determine collection + name ──
        // Collection = product title from API (e.g., "3D")
        // For variable products, group by color — each color becomes its own product
        // For simple products, keep title as name with collection
        const collectionName = apiProduct.title;

        // ── Gallery images data ──
        const galleryData = detail.gallery; // { flat: [...], shared: [...], byVariationId: { 8683: [...], ... } }
        const galleryFlat = galleryData.flat || [];
        const galleryShared = galleryData.shared || [];

        // Handle SKUs based on product type
        if (apiProduct.isVariable && detail.variations.length > 0) {
          // Group variations by color to create one product per color
          const colorGroups = new Map(); // color → [{ vi, v }]
          for (let vi = 0; vi < detail.variations.length; vi++) {
            const v = detail.variations[vi];
            if (v.attributes?.attribute_pa_size === 'sample') continue;
            const color = v.attributes?.attribute_pa_color || '';
            if (!colorGroups.has(color)) colorGroups.set(color, []);
            colorGroups.get(color).push({ vi, v });
          }

          for (const [colorSlug, variations] of colorGroups) {
            // Product name = deslugified color (e.g., "white-ribbon" → "White Ribbon")
            // If no color, fall back to the API title
            const productName = colorSlug ? deslugify(colorSlug) : apiProduct.title;

            const product = await upsertProduct(pool, {
              vendor_id,
              name: productName,
              collection: collectionName,
              category_id: categoryId,
              description_short: apiProduct.description ? apiProduct.description.slice(0, 255) : null,
              description_long: apiProduct.description
            });

            if (product.is_new) stats.created++;
            else stats.updated++;
            touchedProductIds.push(product.id);

            // ── Product-level primary image ──
            // Priority: 1) swatch image (clean product photo), 2) first variation gallery product shot, 3) preferProductShot from all images
            const swatchUrl = detail.swatchImages?.get(colorSlug) || null;
            let productPrimaryUrl = swatchUrl;

            if (!productPrimaryUrl) {
              // Fall back to the first product shot from any variation gallery in this color group
              for (const { v: cv } of variations) {
                const varGal = galleryData.byVariationId[cv.variation_id] || [];
                const productShot = varGal.find(url => /variation|product|swatch/i.test(url.split('/').pop()));
                if (productShot) { productPrimaryUrl = productShot; break; }
              }
            }

            if (!productPrimaryUrl) {
              // Last resort: collect all color images and pick the best product shot
              const allColorImages = [];
              const seenColorBases = new Set();
              for (const { v: cv } of variations) {
                const cvImg = cv.image?.url || cv.image?.src || null;
                if (cvImg) {
                  const base = cvImg.split('?')[0];
                  if (!seenColorBases.has(base)) { seenColorBases.add(base); allColorImages.push(cvImg); }
                }
                for (const gImg of (galleryData.byVariationId[cv.variation_id] || [])) {
                  const base = gImg.split('?')[0];
                  if (!seenColorBases.has(base)) { seenColorBases.add(base); allColorImages.push(gImg); }
                }
              }
              const colorCandidates = preferProductShot(filterImageUrls(filterWideBanners(allColorImages)), colorSlug);
              productPrimaryUrl = colorCandidates[0] || null;
            }

            if (productPrimaryUrl) {
              await upsertMediaAsset(pool, {
                product_id: product.id,
                sku_id: null,
                asset_type: 'primary',
                url: productPrimaryUrl,
                original_url: productPrimaryUrl,
                sort_order: 0,
              });
              stats.imagesSet++;
            }

            for (const { vi, v } of variations) {
              // Variant name: size + finish (color is now in product name)
              const sizePart = v.attributes?.attribute_pa_size ? deslugify(v.attributes.attribute_pa_size) : '';
              const finishPart = v.attributes?.attribute_pa_finishes ? deslugify(v.attributes.attribute_pa_finishes) : '';
              const variantName = buildVariantName(sizePart, finishPart);

              const accessory = isAccessory(apiProduct.title, apiProduct.description);

              // ── Price list lookup ──
              const plEntry = priceList
                ? priceList.lookup(collectionName, colorSlug, v.attributes?.attribute_pa_size, v.attributes?.attribute_pa_finishes)
                : null;

              // Determine sell_by from price list unit or fallback
              let sellBy;
              if (plEntry) {
                const unit = plEntry.unit;
                if (unit === 'EA' || unit === 'SHT') sellBy = 'unit';
                else sellBy = 'sqft';
              } else {
                sellBy = resolveSellBy(pimCatSlug, accessory, detail.soldBy);
              }

              const sku = await upsertSku(pool, {
                product_id: product.id,
                vendor_sku: String(v.variation_id),
                internal_sku: `AZT-${v.variation_id}`,
                variant_name: variantName,
                sell_by: sellBy,
                ...(accessory && { variant_type: 'accessory' }),
              });
              if (sku.is_new) stats.skusCreated++;

              // ── Pricing: price list only (no WC fallback — "Call for Price" if no match) ──
              if (plEntry) {
                const cost = plEntry.netPrice;
                await upsertPricing(pool, sku.id, {
                  cost,
                  retail_price: Math.round(cost * 2 * 100) / 100,
                  price_basis: sellBy === 'unit' ? 'per_unit' : 'per_sqft',
                });
                stats.priceListHits++;
              } else {
                stats.priceListMisses++;
              }

              // ── Inventory from variation ──
              const qtyOnHand = v.max_qty ? parseInt(v.max_qty) : (v.is_in_stock ? 1 : 0);
              await upsertInventorySnapshot(pool, sku.id, 'default', {
                qty_on_hand_sqft: qtyOnHand,
                qty_in_transit_sqft: 0,
              });

              // ── Packaging: price list first, then HTML-parsed fallback ──
              if (plEntry && plEntry.sfPerBox) {
                await upsertPackaging(pool, sku.id, {
                  sqft_per_box: plEntry.sfPerBox || null,
                  pieces_per_box: plEntry.pcsPerBox || null,
                  weight_per_box_lbs: null,
                  boxes_per_pallet: plEntry.boxesPerPallet || null,
                  sqft_per_pallet: plEntry.sfPerPallet || null,
                  weight_per_pallet_lbs: null,
                });
              } else if (detail.packaging && Object.keys(detail.packaging).length > 0 && !NO_BOX_CATEGORIES.has(pimCatSlug)) {
                await upsertPackaging(pool, sku.id, {
                  sqft_per_box: detail.packaging.sqftPerBox || null,
                  pieces_per_box: detail.packaging.piecesPerBox || null,
                  weight_per_box_lbs: detail.packaging.weightPerBox || null,
                  boxes_per_pallet: detail.packaging.boxesPerPallet || null,
                  sqft_per_pallet: detail.packaging.sqftPerPallet || null,
                  weight_per_pallet_lbs: detail.packaging.weightPerPallet || null,
                });
              }

              // ── Variation-level attributes ──
              if (v.attributes?.attribute_pa_color) {
                await upsertSkuAttribute(pool, sku.id, 'color', cleanAttrValue(v.attributes.attribute_pa_color));
              }
              if (v.attributes?.attribute_pa_size) {
                await upsertSkuAttribute(pool, sku.id, 'size', cleanAttrValue(v.attributes.attribute_pa_size));
              }
              if (v.attributes?.attribute_pa_finishes) {
                let finishVal = cleanAttrValue(v.attributes.attribute_pa_finishes);
                if (finishPart && finishPart.toLowerCase() !== finishVal.toLowerCase()) {
                  finishVal = finishPart;
                }
                await upsertSkuAttribute(pool, sku.id, 'finish', finishVal);
              }

              // ── Product-level specs as SKU attributes ──
              await upsertAllSpecAttributes(pool, sku.id, detail.specs, detail.technicalSpecs);

              // ── Per-variant images ──
              // Priority for primary: 1) swatch image (product photo), 2) variation gallery product shot, 3) variation image field
              const varImage = v.image?.url || v.image?.src || null;
              const sortBase = (vi + 1) * 100;

              const varGallery = galleryData.byVariationId[v.variation_id] || [];

              // Build variant images: start with gallery (first entry is usually the product shot)
              const rawVarImages = [];
              const seenBases = new Set();

              // Insert swatch image first if available (this IS the product photo)
              if (swatchUrl) {
                const base = swatchUrl.split('?')[0];
                seenBases.add(base);
                rawVarImages.push(swatchUrl);
              }

              // Add variation gallery images (first one is typically the product shot for this size)
              for (const imgUrl of varGallery) {
                const base = imgUrl.split('?')[0];
                if (!seenBases.has(base)) {
                  seenBases.add(base);
                  rawVarImages.push(imgUrl);
                }
              }

              // Add the WC variation image if not already included
              if (varImage) {
                const base = varImage.split('?')[0];
                if (!seenBases.has(base)) {
                  seenBases.add(base);
                  rawVarImages.push(varImage);
                }
              }

              // Only pull from shared gallery when variant has no own images
              if (rawVarImages.length === 0 && galleryShared.length > 0) {
                const otherColorNames = [...colorGroups.keys()]
                  .filter(c => c && c !== colorSlug)
                  .map(c => deslugify(c));
                const sharedNew = galleryShared.filter(u => {
                  const b = u.split('?')[0];
                  return !seenBases.has(b) && (seenBases.add(b), true);
                });
                const { matched, shared: neutral } = filterImagesByVariant(
                  sharedNew, deslugify(colorSlug),
                  { otherColors: otherColorNames, productName: collectionName }
                );
                rawVarImages.push(...matched, ...neutral);
              }

              // Filter junk + placeholders, then prefer product shots
              const filteredVarImages = await filterWidenPlaceholders(filterImageUrls(filterWideBanners(rawVarImages)));
              const allVarImages = preferProductShot(filteredVarImages, colorSlug, { size: sizePart, finish: finishPart });

              // Upsert all images for this SKU
              for (let gi = 0; gi < allVarImages.length && gi < MAX_GALLERY_IMAGES; gi++) {
                const imgUrl = allVarImages[gi];
                const isLife = isLifestyleUrl(imgUrl);
                const assetType = gi === 0 ? 'primary'
                  : (isLife || gi > 2) ? 'lifestyle'
                  : 'alternate';
                await upsertMediaAsset(pool, {
                  product_id: product.id,
                  sku_id: sku.id,
                  asset_type: assetType,
                  url: imgUrl,
                  original_url: imgUrl,
                  sort_order: sortBase + gi,
                });
                stats.imagesSet++;
              }

              // If no new images were assigned, promote existing first alternate to primary
              if (allVarImages.length === 0) {
                await promoteToPrimary(pool, product.id, sku.id);
              }
            } // end for variations
          } // end for colorGroups
        } else {
          // Simple product: single SKU — use title as name, no collection grouping
          const product = await upsertProduct(pool, {
            vendor_id,
            name: apiProduct.title,
            collection: collectionName,
            category_id: categoryId,
            description_short: apiProduct.description ? apiProduct.description.slice(0, 255) : null,
            description_long: apiProduct.description
          });

          if (product.is_new) stats.created++;
          else stats.updated++;
          touchedProductIds.push(product.id);

          // Product-level primary image (sorted by preferProductShot, placeholders removed)
          const simpleFiltered = await filterWidenPlaceholders(filterImageUrls(filterWideBanners(galleryFlat)));
          const simpleSorted = preferProductShot(simpleFiltered, apiProduct.title);
          if (simpleSorted.length > 0) {
            await upsertMediaAsset(pool, {
              product_id: product.id,
              sku_id: null,
              asset_type: 'primary',
              url: simpleSorted[0],
              original_url: simpleSorted[0],
              sort_order: 0,
            });
            stats.imagesSet++;
          }

          const accessory = isAccessory(apiProduct.title, apiProduct.description);

          // ── Price list lookup for simple product ──
          // For slab categories, try multi-gauge lookup to create per-thickness SKUs
          const isSlab = pimCatSlug && SLAB_CATEGORIES.has(pimCatSlug);
          const gaugeEntries = (isSlab && priceList)
            ? priceList.lookupSimpleAllGauges(apiProduct.title, apiProduct.slug, detail.specs)
            : [];
          const plEntry = gaugeEntries.length > 0 ? gaugeEntries[0]
            : (priceList ? priceList.lookupSimple(apiProduct.title, apiProduct.slug, detail.specs) : null);

          // Multi-gauge path: create one SKU per thickness
          if (gaugeEntries.length > 1) {
            for (const entry of gaugeEntries) {
              const gauge = entry.normalizedGauge; // e.g. "2CM", "3CM"
              const entrySellBy = (entry.unit === 'EA' || entry.unit === 'SHT') ? 'unit' : 'sqft';

              const sku = await upsertSku(pool, {
                product_id: product.id,
                vendor_sku: `${apiProduct.wpId}-${gauge}`,
                internal_sku: `AZT-${apiProduct.wpId}-${gauge}`,
                variant_name: gauge,
                sell_by: entrySellBy,
                ...(accessory && { variant_type: 'accessory' }),
              });
              if (sku.is_new) stats.skusCreated++;

              // Pricing per gauge
              const cost = entry.netPrice;
              await upsertPricing(pool, sku.id, {
                cost,
                retail_price: Math.round(cost * 2 * 100) / 100,
                price_basis: entrySellBy === 'unit' ? 'per_unit' : 'per_sqft',
              });
              stats.priceListHits++;

              // Inventory per SKU
              await upsertInventorySnapshot(pool, sku.id, 'default', {
                qty_on_hand_sqft: apiProduct.isInStock ? 1 : 0,
                qty_in_transit_sqft: 0,
              });

              // Spec attributes (shared across gauges)
              await upsertAllSpecAttributes(pool, sku.id, detail.specs, detail.technicalSpecs);
              // Override thickness with the specific gauge value
              await upsertSkuAttribute(pool, sku.id, 'thickness', gauge);
            }
            // Images at product level only (sku_id: null) — API falls back to product-level media
            if (simpleSorted.length > 0) {
              for (let gi = 0; gi < simpleSorted.length; gi++) {
                const imgUrl = simpleSorted[gi];
                const isLife = isLifestyleUrl(imgUrl);
                let assetType;
                if (gi === 0) assetType = 'primary';
                else if (isLife || gi > 2) assetType = 'lifestyle';
                else assetType = 'alternate';

                await upsertMediaAsset(pool, {
                  product_id: product.id,
                  sku_id: null,
                  asset_type: assetType,
                  url: imgUrl,
                  original_url: imgUrl,
                  sort_order: gi,
                });
                stats.imagesSet++;
              }
            }
          } else {
            // Single SKU path (non-slab, or slab with only one gauge)
            let sellBy;
            if (plEntry) {
              const unit = plEntry.unit;
              if (unit === 'EA' || unit === 'SHT') sellBy = 'unit';
              else sellBy = 'sqft';
            } else {
              sellBy = resolveSellBy(pimCatSlug, accessory, detail.soldBy);
            }

            const sku = await upsertSku(pool, {
              product_id: product.id,
              vendor_sku: String(apiProduct.wpId),
              internal_sku: `AZT-${apiProduct.wpId}`,
              variant_name: null,
              sell_by: sellBy,
              ...(accessory && { variant_type: 'accessory' }),
            });
            if (sku.is_new) stats.skusCreated++;

            // ── Pricing: price list only (no WC fallback — "Call for Price" if no match) ──
            if (plEntry) {
              const cost = plEntry.netPrice;
              await upsertPricing(pool, sku.id, {
                cost,
                retail_price: Math.round(cost * 2 * 100) / 100,
                price_basis: sellBy === 'unit' ? 'per_unit' : 'per_sqft',
              });
              stats.priceListHits++;
            } else {
              stats.priceListMisses++;
            }

            // ── Inventory ──
            await upsertInventorySnapshot(pool, sku.id, 'default', {
              qty_on_hand_sqft: apiProduct.isInStock ? 1 : 0,
              qty_in_transit_sqft: 0,
            });

            // ── Packaging: price list first, then HTML-parsed ──
            if (plEntry && plEntry.sfPerBox) {
              await upsertPackaging(pool, sku.id, {
                sqft_per_box: plEntry.sfPerBox || null,
                pieces_per_box: plEntry.pcsPerBox || null,
                weight_per_box_lbs: null,
                boxes_per_pallet: plEntry.boxesPerPallet || null,
                sqft_per_pallet: plEntry.sfPerPallet || null,
                weight_per_pallet_lbs: null,
              });
            } else if (detail.packaging && Object.keys(detail.packaging).length > 0 && !NO_BOX_CATEGORIES.has(pimCatSlug)) {
              if (detail.packaging._pdfOnly) {
                await appendLog(pool, job.id, `Info: ${apiProduct.slug} has packaging PDF (${detail.packaging.pdfUrl}) but no inline data`);
              } else {
                await upsertPackaging(pool, sku.id, {
                  sqft_per_box: detail.packaging.sqftPerBox || null,
                  pieces_per_box: detail.packaging.piecesPerBox || null,
                  weight_per_box_lbs: detail.packaging.weightPerBox || null,
                  boxes_per_pallet: detail.packaging.boxesPerPallet || null,
                  sqft_per_pallet: detail.packaging.sqftPerPallet || null,
                  weight_per_pallet_lbs: detail.packaging.weightPerPallet || null,
                });
              }
            }

            // ── All spec attributes ──
            await upsertAllSpecAttributes(pool, sku.id, detail.specs, detail.technicalSpecs);

            // ── Images (sorted by preferProductShot, filtered by filterImageUrls) ──
            if (simpleSorted.length > 0) {
              for (let gi = 0; gi < simpleSorted.length; gi++) {
                const imgUrl = simpleSorted[gi];
                const isLife = isLifestyleUrl(imgUrl);
                let assetType;
                if (gi === 0) assetType = 'primary';
                else if (isLife || gi > 2) assetType = 'lifestyle';
                else assetType = 'alternate';

                await upsertMediaAsset(pool, {
                  product_id: product.id,
                  sku_id: sku.id,
                  asset_type: assetType,
                  url: imgUrl,
                  original_url: imgUrl,
                  sort_order: gi,
                });
                stats.imagesSet++;
              }
            }
          }
        }
      } catch (err) {
        await appendLog(pool, job.id, `ERROR upserting ${apiProduct.slug}: ${err.message}`);
        await addJobError(pool, job.id, `Product ${apiProduct.slug}: ${err.message}`);
        stats.errors++;
      }

      idx++;
      if (idx % 25 < batchSize || idx === allProducts.length) {
        await appendLog(pool, job.id, `Upsert progress: ${idx}/${allProducts.length}`, {
          products_found: stats.found,
          products_created: stats.created,
          products_updated: stats.updated,
          skus_created: stats.skusCreated
        });
      }
    }

    // ── Phase 4: Bulk activate + fix missing primaries ──

    if (touchedProductIds.length > 0) {
      const activateResult = await pool.query(
        `UPDATE products SET status = 'active', updated_at = CURRENT_TIMESTAMP
         WHERE id = ANY($1) AND status = 'draft'`,
        [touchedProductIds]
      );
      await appendLog(pool, job.id, `Activated ${activateResult.rowCount} products (${touchedProductIds.length} total touched)`);
    }

    // Promote first alternate to primary for any AZT SKUs with images but no primary
    const missingPrimary = await pool.query(`
      SELECT DISTINCT s.id as sku_id, s.product_id
      FROM skus s
      JOIN media_assets ma ON ma.sku_id = s.id
      WHERE s.internal_sku LIKE 'AZT-%'
      AND NOT EXISTS (
        SELECT 1 FROM media_assets m2 WHERE m2.sku_id = s.id AND m2.asset_type = 'primary'
      )
    `);
    if (missingPrimary.rows.length > 0) {
      let promoted = 0;
      for (const row of missingPrimary.rows) {
        const ok = await promoteToPrimary(pool, row.product_id, row.sku_id);
        if (ok) promoted++;
      }
      await appendLog(pool, job.id, `Promoted ${promoted}/${missingPrimary.rows.length} SKUs missing primary image`);
    }

    await appendLog(pool, job.id,
      `Scrape complete. Found: ${stats.found}, Created: ${stats.created}, ` +
      `Updated: ${stats.updated}, SKUs: ${stats.skusCreated}, ` +
      `Images: ${stats.imagesSet}, Skipped: ${stats.skipped}, Errors: ${stats.errors}, ` +
      `PriceList hits: ${stats.priceListHits}, misses: ${stats.priceListMisses}`,
      {
        products_found: stats.found,
        products_created: stats.created,
        products_updated: stats.updated,
        skus_created: stats.skusCreated
      }
    );
  }
}

// ══════════════════════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════════════════════

/**
 * Promote the first alternate/lifestyle image to 'primary' for a SKU
 * that has images but no primary. Updates the record in-place.
 * Returns true if a promotion occurred.
 */
async function promoteToPrimary(pool, productId, skuId) {
  const result = await pool.query(`
    UPDATE media_assets SET asset_type = 'primary'
    WHERE id = (
      SELECT id FROM media_assets
      WHERE product_id = $1 AND sku_id = $2 AND asset_type IN ('alternate', 'lifestyle')
      ORDER BY sort_order LIMIT 1
    )
    RETURNING id
  `, [productId, skuId]);
  return result.rowCount > 0;
}

// ══════════════════════════════════════════════════════════════
// Parsers
// ══════════════════════════════════════════════════════════════

/**
 * Parse all data from a product detail page.
 * Returns a unified object matching the Elysium v3 pattern.
 */
function parseDetailPage(html) {
  // Merge table-based tech specs with regex-based; regex results take priority
  const tableTechSpecs = parseTechnicalSpecsTable(html);
  const regexTechSpecs = parseTechnicalSpecs(html);
  const technicalSpecs = { ...tableTechSpecs, ...regexTechSpecs };

  // Detect packaging PDF link (for future manual review)
  const pkgPdfMatch = html.match(/<a[^>]+href="([^"]+)"[^>]*>[\s\S]*?Thickness\s*(?:&amp;|&)\s*Packaging[\s\S]*?<\/a>/i);
  const packagingPdfUrl = pkgPdfMatch ? htmlDecode(pkgPdfMatch[1]) : null;

  const packaging = parsePackaging(html);
  if (packagingPdfUrl) {
    packaging.pdfUrl = packagingPdfUrl;
    if (Object.keys(packaging).length === 1) {
      // Only pdfUrl, no inline packaging data — log-worthy
      packaging._pdfOnly = true;
    }
  }

  return {
    specs: parseSpecs(html),
    technicalSpecs,
    packaging,
    pricing: parsePricing(html),
    gallery: parseGallery(html),
    variations: parseVariations(html),
    soldBy: parseSoldBy(html),
    stockStatus: parseStockStatus(html),
    swatchImages: parseSwatchImages(html),
  };
}

/**
 * Parse general specs from Product Details tab.
 * Format: <strong>Label:</strong><br />value
 */
function parseSpecs(html) {
  const specs = {};
  const specPatterns = [
    { regex: /<strong>Product Type:?<\/strong>(?:<br\s*\/?>)?\s*([^<]+)/i, key: 'type' },
    { regex: /<strong>Origin:?<\/strong>(?:<br\s*\/?>)?\s*([^<]+)/i, key: 'countryOfOrigin' },
    { regex: /<strong>Stocked Finish(?:es)?(?:\(es\))?:?<\/strong>(?:<br\s*\/?>)?\s*([^<]+)/i, key: 'finish' },
    { regex: /<strong>Stocked Sizes?:?<\/strong>(?:<br\s*\/?>)?\s*([^<]+)/i, key: 'size' },
    { regex: /<strong>Stocked Thickness:?<\/strong>(?:<br\s*\/?>)?\s*([^<]+)/i, key: 'thickness' },
    { regex: /<strong>Recommended Uses?:?<\/strong>(?:<br\s*\/?>)?\s*([^<]+)/i, key: 'application' },
    { regex: /<strong>Stocked Color(?:s|\/Finishes)?:?<\/strong>(?:<br\s*\/?>)?\s*([^<]+)/i, key: 'colors' },
    { regex: /<strong>Edge:?<\/strong>(?:<br\s*\/?>)?\s*([^<]+)/i, key: 'edge' },
    { regex: /<strong>Look:?<\/strong>(?:<br\s*\/?>)?\s*([^<]+)/i, key: 'look' },
    { regex: /<strong>Collection:?<\/strong>(?:<br\s*\/?>)?\s*([^<]+)/i, key: 'collection' },
  ];

  for (const { regex, key } of specPatterns) {
    const match = html.match(regex);
    if (match) specs[key] = htmlDecode(match[1].trim());
  }

  // Multi-line value extraction: some specs span multiple <br>-separated lines
  const multiLineKeys = [
    { regex: /<strong>Stocked Color(?:s|\/Finishes)?:?<\/strong>\s*([\s\S]*?)(?=<strong>|<\/div>|<\/p>)/i, key: 'colors' },
    { regex: /<strong>Stocked Finish(?:es)?(?:\(es\))?:?<\/strong>\s*([\s\S]*?)(?=<strong>|<\/div>|<\/p>)/i, key: 'finish' },
    { regex: /<strong>Stocked Sizes?:?<\/strong>\s*([\s\S]*?)(?=<strong>|<\/div>|<\/p>)/i, key: 'size' },
    { regex: /<strong>Stocked Thickness:?<\/strong>\s*([\s\S]*?)(?=<strong>|<\/div>|<\/p>)/i, key: 'thickness' },
    { regex: /<strong>Recommended Uses?:?<\/strong>\s*([\s\S]*?)(?=<strong>|<\/div>|<\/p>)/i, key: 'application' },
  ];
  for (const { regex, key } of multiLineKeys) {
    const match = html.match(regex);
    if (match) {
      const lines = match[1]
        .split(/<br\s*\/?>/)
        .map(l => htmlDecode(l.replace(/<[^>]+>/g, '').trim()))
        .filter(Boolean);
      if (lines.length > 1) {
        specs[key] = lines.join(', ');
      }
    }
  }

  return specs;
}

/**
 * Parse technical specs (PEI, DCOF, Water Absorption, etc.)
 * from the detail page. Arizona Tile uses the same <strong>Label:</strong> pattern.
 */
function parseTechnicalSpecs(html) {
  const tech = {};
  const techPatterns = [
    { regex: /<strong>PEI(?: Rating)?:?<\/strong>(?:<br\s*\/?>)?\s*([^<]+)/i, key: 'peiRating' },
    { regex: /<strong>Shade Variation:?<\/strong>(?:<br\s*\/?>)?\s*([^<]+)/i, key: 'shadeVariation' },
    { regex: /<strong>Water Absorption:?<\/strong>(?:<br\s*\/?>)?\s*([^<]+)/i, key: 'waterAbsorption' },
    { regex: /<strong>DCOF(?: Acutest)?:?<\/strong>(?:<br\s*\/?>)?\s*([^<]+)/i, key: 'dcof' },
    { regex: /<strong>MOHS:?<\/strong>(?:<br\s*\/?>)?\s*([^<]+)/i, key: 'mohs' },
    { regex: /<strong>Breaking Strength:?<\/strong>(?:<br\s*\/?>)?\s*([^<]+)/i, key: 'breakingStrength' },
    { regex: /<strong>Frost Resistant:?<\/strong>(?:<br\s*\/?>)?\s*([^<]+)/i, key: 'frostResistant' },
    { regex: /<strong>Abrasion Resistance:?<\/strong>(?:<br\s*\/?>)?\s*([^<]+)/i, key: 'abrasionResistance' },
    { regex: /<strong>Coefficient of Friction:?<\/strong>(?:<br\s*\/?>)?\s*([^<]+)/i, key: 'dcof' },
  ];

  for (const { regex, key } of techPatterns) {
    if (tech[key]) continue; // Don't overwrite (dcof has two patterns)
    const match = html.match(regex);
    if (match) tech[key] = htmlDecode(match[1].trim());
  }

  return tech;
}

/**
 * Parse technical specs from HTML <table> elements with "TECHNICAL CHARACTERISTICS" header.
 * New Arizona Tile format uses tables instead of <strong> label blocks for some products.
 * Extracts label (col 1) → value (last col, typically "TYPICAL VALUE") pairs.
 */
function parseTechnicalSpecsTable(html) {
  const tech = {};

  // Find table sections containing technical characteristics
  const tableMatch = html.match(/<table[^>]*>[\s\S]*?TECHNICAL\s+CHARACTERISTICS[\s\S]*?<\/table>/i);
  if (!tableMatch) return tech;

  const tableHtml = tableMatch[0];

  // Map of label patterns → tech spec keys
  const labelMap = [
    { pattern: /water\s+absorption/i, key: 'waterAbsorption' },
    { pattern: /dcof|dynamic\s+coefficient/i, key: 'dcof' },
    { pattern: /breaking\s+strength/i, key: 'breakingStrength' },
    { pattern: /frost\s+resist/i, key: 'frostResistant' },
    { pattern: /abrasion\s+resist/i, key: 'abrasionResistance' },
    { pattern: /\bpei\b/i, key: 'peiRating' },
    { pattern: /\bmohs\b/i, key: 'mohs' },
    { pattern: /shade\s+variation/i, key: 'shadeVariation' },
    { pattern: /staining\s+resist/i, key: 'stainingResistance' },
    { pattern: /thermal\s+shock/i, key: 'thermalShock' },
  ];

  // Extract rows: <tr>...<td>Label</td>...<td>Value</td>...</tr>
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;
  while ((rowMatch = rowRegex.exec(tableHtml)) !== null) {
    const cells = [];
    const cellRegex = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let cellMatch;
    while ((cellMatch = cellRegex.exec(rowMatch[1])) !== null) {
      cells.push(cellMatch[1].replace(/<[^>]+>/g, '').trim());
    }
    if (cells.length < 2) continue;

    const label = cells[0];
    const value = cells[cells.length - 1]; // Last column = typical value
    if (!label || !value) continue;

    for (const { pattern, key } of labelMap) {
      if (pattern.test(label) && !tech[key]) {
        tech[key] = htmlDecode(value);
        break;
      }
    }
  }

  return tech;
}

/**
 * Parse packaging info from the detail page.
 * Looks for patterns like "X pcs/box", "XX sf/box", "XX lbs/box", etc.
 */
function parsePackaging(html) {
  const pkg = {};

  const pcsMatch = html.match(/<strong>Pieces?\s*(?:Per|\/)\s*Box:?<\/strong>(?:<br\s*\/?>)?\s*([^<]+)/i)
    || html.match(/(\d+)\s*(?:pcs?|pieces?)\s*(?:per|\/)\s*box/i);
  if (pcsMatch) pkg.piecesPerBox = parseInt(pcsMatch[1]) || null;

  const sqftMatch = html.match(/<strong>(?:Sq\.?\s*Ft\.?|SF|Square Feet)\s*(?:Per|\/)\s*Box:?<\/strong>(?:<br\s*\/?>)?\s*([^<]+)/i)
    || html.match(/([\d.]+)\s*(?:sf|sq\.?\s*ft\.?)\s*(?:per|\/)\s*box/i);
  if (sqftMatch) pkg.sqftPerBox = parseFloat(sqftMatch[1]) || null;

  const weightMatch = html.match(/<strong>Weight\s*(?:Per|\/)\s*Box:?<\/strong>(?:<br\s*\/?>)?\s*([^<]+)/i)
    || html.match(/([\d.]+)\s*(?:lbs?\.?)\s*(?:per|\/)\s*box/i);
  if (weightMatch) pkg.weightPerBox = parseFloat(weightMatch[1].replace(/[^0-9.]/g, '')) || null;

  const bppMatch = html.match(/<strong>Boxes?\s*(?:Per|\/)\s*Pallet:?<\/strong>(?:<br\s*\/?>)?\s*([^<]+)/i)
    || html.match(/(\d+)\s*(?:boxes?)\s*(?:per|\/)\s*pallet/i);
  if (bppMatch) pkg.boxesPerPallet = parseInt(bppMatch[1]) || null;

  const sqftPalletMatch = html.match(/<strong>(?:Sq\.?\s*Ft\.?|SF)\s*(?:Per|\/)\s*Pallet:?<\/strong>(?:<br\s*\/?>)?\s*([^<]+)/i)
    || html.match(/([\d.,]+)\s*(?:sf|sq\.?\s*ft\.?)\s*(?:per|\/)\s*pallet/i);
  if (sqftPalletMatch) pkg.sqftPerPallet = parseFloat(sqftPalletMatch[1].replace(/,/g, '')) || null;

  const weightPalletMatch = html.match(/<strong>Weight\s*(?:Per|\/)\s*Pallet:?<\/strong>(?:<br\s*\/?>)?\s*([^<]+)/i)
    || html.match(/([\d.,]+)\s*(?:lbs?\.?)\s*(?:per|\/)\s*pallet/i);
  if (weightPalletMatch) pkg.weightPerPallet = parseFloat(weightPalletMatch[1].replace(/[^0-9.]/g, '')) || null;

  return pkg;
}

/**
 * Parse pricing from the detail page HTML.
 * WooCommerce puts price in <span class="woocommerce-Price-amount">.
 */
function parsePricing(html) {
  const result = { retailPrice: null, priceBasis: 'per_sqft' };

  // Cascading price extraction:
  // 1. WooCommerce price element (legacy pages)
  const priceMatch = html.match(/class="woocommerce-Price-amount[^"]*"[^>]*>[^$]*\$([\d,.]+)/);
  if (priceMatch) {
    result.retailPrice = parseFloat(priceMatch[1].replace(/,/g, '')) || null;
  }

  // 2. Extract display_price from data-product_variations JSON
  //    Some "simple" products are rendered as single-variation
  if (!result.retailPrice) {
    const varMatch = html.match(/data-product_variations="([^"]+)"/);
    if (varMatch) {
      try {
        let json = varMatch[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#039;/g, "'");
        const vars = JSON.parse(json);
        if (Array.isArray(vars) && vars.length > 0 && vars[0].display_price) {
          result.retailPrice = parseFloat(vars[0].display_price) || null;
        }
      } catch { /* ignore parse errors */ }
    }
  }

  // 3. JSON-LD structured data (application/ld+json)
  if (!result.retailPrice) {
    const ldMatch = html.match(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/i);
    if (ldMatch) {
      try {
        const ld = JSON.parse(ldMatch[1]);
        const offers = ld.offers || (Array.isArray(ld['@graph']) && ld['@graph'].find(g => g.offers))?.offers;
        if (offers) {
          const price = offers.price || offers.lowPrice || (Array.isArray(offers) && offers[0]?.price);
          if (price) result.retailPrice = parseFloat(price) || null;
        }
      } catch { /* ignore parse errors */ }
    }
  }

  // 4. data-price attribute on cart form elements
  if (!result.retailPrice) {
    const dataPriceMatch = html.match(/data-price="([\d.]+)"/);
    if (dataPriceMatch) {
      result.retailPrice = parseFloat(dataPriceMatch[1]) || null;
    }
  }

  if (!result.retailPrice) {
    // Log-worthy: simple product with no pricing found
    result._noPricing = true;
  }

  // Check for "per sqft" / "per piece" / "per box" indicator
  const basisMatch = html.match(/per\s+(sq\.?\s*ft\.?|piece|box|unit|square\s*foot)/i);
  if (basisMatch) {
    const raw = basisMatch[1].toLowerCase();
    if (raw.includes('box')) result.priceBasis = 'per_unit';
    else if (raw.includes('piece') || raw.includes('unit')) result.priceBasis = 'per_unit';
    else result.priceBasis = 'per_sqft';
  }

  return result;
}

/**
 * Parse sold-by from page content.
 */
function parseSoldBy(html) {
  const soldByMatch = html.match(/sold\s+(?:by\s+)?(?:the\s+)?(box|sq\.?\s*ft\.?|piece|square\s*foot|unit)/i);
  if (soldByMatch) {
    const raw = soldByMatch[1].toLowerCase();
    if (raw.includes('box')) return 'sqft';
    if (raw.includes('piece') || raw.includes('unit')) return 'unit';
    return 'sqft';
  }
  return null;
}

/**
 * Parse stock status from page HTML.
 */
function parseStockStatus(html) {
  if (/class=['"][^'"]*in-stock/i.test(html)) return 'In Stock';
  if (/class=['"][^'"]*out-of-stock/i.test(html)) return 'Out of Stock';
  if (/class=['"][^'"]*on-backorder/i.test(html)) return 'Backorder';
  return null;
}

/**
 * Parse gallery images from aztiles_product_gallery JS variable.
 * Format can be:
 *   - Array of arrays: [[{thumb, medium, zoom}, ...]]  (simple products)
 *   - Object with numeric keys: {"0": [{...},...], "8683": [{...},...]}  (variable products)
 *     Key "0" = shared/product-level images
 *     Other keys = WooCommerce variation_id → per-variant gallery images
 * Items have thumb/medium/zoom keys — prefer zoom (highest res), fallback to medium.
 * URLs contain &amp; HTML entities that need decoding.
 *
 * Returns { flat: [url, ...], shared: [url, ...], byVariationId: { 8683: [url, ...], ... } }
 * - flat: all images combined (used for simple products)
 * - shared: key "0" images (product-level, used when no per-variant images exist)
 * - byVariationId: keyed by WooCommerce variation_id (NOT sequential index)
 */
function parseGallery(html) {
  const match = html.match(/aztiles_product_gallery\s*=\s*(\{[\s\S]*?\}|\[[\s\S]*?\]);/);
  if (!match) return { flat: [], shared: [], byVariationId: {} };

  function extractUrls(items) {
    const urls = items
      .map(item => {
        if (typeof item === 'string') return item;
        if (typeof item === 'object' && item) {
          return item.full || item.zoom || item.medium || item.thumb || item.url || item.src || null;
        }
        return null;
      })
      .filter(Boolean)
      .map(u => u.replace(/&amp;/g, '&'));

    // Deduplicate by base filename
    const seen = new Set();
    const unique = [];
    for (const url of urls) {
      const base = url.split('?')[0];
      if (seen.has(base)) continue;
      seen.add(base);
      unique.push(url);
    }
    return unique.slice(0, MAX_GALLERY_IMAGES);
  }

  try {
    const raw = match[1].replace(/&amp;/g, '&');
    const gallery = JSON.parse(raw);

    const byVariationId = {};
    let shared = [];
    let allItems = [];

    if (Array.isArray(gallery)) {
      // [[{thumb,medium,zoom},...]] or [{thumb,medium,zoom},...]
      for (const entry of gallery) {
        if (Array.isArray(entry)) allItems.push(...entry);
        else allItems.push(entry);
      }
    } else if (typeof gallery === 'object') {
      // {"0": [{...},...], "8683": [{...},...]} — key 0 is shared, others are variation_ids
      for (const key of Object.keys(gallery)) {
        const arr = gallery[key];
        if (!Array.isArray(arr)) continue;
        allItems.push(...arr);
        if (key === '0') {
          shared = extractUrls(arr);
        } else {
          byVariationId[Number(key)] = extractUrls(arr);
        }
      }
    }

    return { flat: extractUrls(allItems), shared, byVariationId };
  } catch {
    return { flat: [], shared: [], byVariationId: {} };
  }
}

/**
 * Parse variations from data-product_variations attribute.
 * The JSON is double HTML-encoded on the page.
 */
function parseVariations(html) {
  const match = html.match(/data-product_variations="([^"]+)"/);
  if (!match) return [];

  try {
    let json = match[1];
    json = htmlDecode(json);
    json = htmlDecode(json);
    return JSON.parse(json);
  } catch {
    return [];
  }
}

/**
 * Upsert all spec + technical spec attributes for a SKU.
 */
async function upsertAllSpecAttributes(pool, skuId, specs, technicalSpecs) {
  // General specs → attribute slugs
  const specMap = {
    type: 'material',
    countryOfOrigin: 'country',
    finish: 'finish',
    thickness: 'thickness',
    application: 'application',
    colors: 'color',
    edge: 'edge',
    look: 'look',
  };
  for (const [specKey, attrSlug] of Object.entries(specMap)) {
    if (specs[specKey]) await upsertSkuAttribute(pool, skuId, attrSlug, specs[specKey]);
  }

  // Technical specs → attribute slugs
  const techMap = {
    peiRating: 'pei_rating',
    shadeVariation: 'shade_variation',
    waterAbsorption: 'water_absorption',
    dcof: 'dcof',
    breakingStrength: 'breaking_strength',
    frostResistant: 'frost_resistant',
    abrasionResistance: 'abrasion_resistance',
    mohs: 'mohs',
    stainingResistance: 'staining_resistance',
    thermalShock: 'thermal_shock',
  };
  for (const [techKey, attrSlug] of Object.entries(techMap)) {
    if (technicalSpecs[techKey]) await upsertSkuAttribute(pool, skuId, attrSlug, technicalSpecs[techKey]);
  }
}

/**
 * Parse color swatch images from the detail page.
 * These are per-color product photos (e.g., "Aequa-Castor-12x48-variation.webp")
 * displayed as clickable color option buttons.
 *
 * Structure: <span class="...color-variation..." data-parent-id="pa_color" data-value="castor" ...>
 *              <i><img src="..." alt="Castor"></i>
 *            </span>
 *
 * Returns Map<colorSlug, imageUrl>
 */
function parseSwatchImages(html) {
  const swatches = new Map();
  // Match color-variation spans with data-parent-id="pa_color" and data-value, then find inner img src
  const regex = /data-parent-id="pa_color"[^>]*data-value="([^"]+)"[^>]*>[\s\S]*?<img[^>]+src="([^"]+)"/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    const colorSlug = match[1].trim();
    const url = htmlDecode(match[2]);
    if (url && colorSlug && !url.includes('placeholder') && !url.includes('Line-Art')) {
      swatches.set(colorSlug, url);
    }
  }
  // Also try reverse attribute order: data-value before data-parent-id
  const regex2 = /data-value="([^"]+)"[^>]*data-parent-id="pa_color"[^>]*>[\s\S]*?<img[^>]+src="([^"]+)"/gi;
  while ((match = regex2.exec(html)) !== null) {
    const colorSlug = match[1].trim();
    const url = htmlDecode(match[2]);
    if (url && colorSlug && !swatches.has(colorSlug) && !url.includes('placeholder') && !url.includes('Line-Art')) {
      swatches.set(colorSlug, url);
    }
  }
  return swatches;
}

/**
 * Decode HTML entities (named and numeric).
 */
function htmlDecode(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

/**
 * Clean attribute value slug (e.g., "matte-finish" → "Matte Finish").
 * Uses deslugify for proper fraction handling.
 */
function cleanAttrValue(slug) {
  return deslugify(slug);
}

/**
 * Strip HTML tags from a string.
 */
function stripTags(str) {
  return htmlDecode(str.replace(/<[^>]+>/g, ''));
}
