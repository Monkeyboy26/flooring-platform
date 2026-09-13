import {
  delay, upsertProduct, upsertSku,
  upsertSkuAttribute, upsertPackaging, upsertPricing,
  appendLog, addJobError,
  downloadImage, upsertMediaAsset, resolveImageExtension,
  deslugify, buildVariantName, filterImageUrls,
  isLifestyleUrl
} from './base.js';
import { BASE_URL } from './arizona-auth.js';
import { loadAllPriceLists } from './arizona-prices.js';
import {
  htmlDecode, stripTags, cleanAttrValue,
} from './arizona/html.js';
import {
  MAX_GALLERY_IMAGES, WIDEN_PLACEHOLDER_BYTES,
  FIELD_TILE_IMAGE_RE, DETAIL_SHOT_RE, MOSAIC_IMAGE_INDICATOR_RE,
  reParamWidenUrl, normalizeWidenUrls, filterWidenPlaceholders, isFieldTileUrl,
  parseGallery, parseSwatchImages,
} from './arizona/images.js';
import {
  parseDetailPage, parseSpecs, parseTechnicalSpecs, parseTechnicalSpecsTable,
  parsePackaging, parsePricing, parseSoldBy, parseStockStatus, parseVariations,
} from './arizona/detail-parse.js';
import {
  CATEGORY_MAP, CATEGORY_SKIP, ACCESSORY_KEYWORDS,
  MOSAIC_NAME_PATTERN, STACKED_NAME_PATTERN, FORMAT_PAGE_TITLES,
  MOSAIC_SHAPE_RE, FIELD_SIZE, MOSAIC_KW,
  UNIT_CATEGORIES, SLAB_CATEGORIES, FORMAT_CATS, SLAB_TO_TILE_FALLBACK, NO_BOX_CATEGORIES,
  extractMosaicShape, parseSizeDims, isFieldTileSize, isAccessory,
  normalizeSeriesTitle, joinDedupe, resolveBestCategory, classifyVariation,
} from './arizona/categorize.js';
import {
  resolveSellBy, BOX_ONLY_SERIES, planFromPriceList,
} from './arizona/pricing.js';
import { upsertAllSpecAttributes } from './arizona/specs.js';

const DEFAULT_CONFIG = {
  delayMs: 1000,
  downloadImages: true,
  perPage: 100,
};

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * Arizona Tile catalog scraper.
 *
 * Uses WP REST API for listing + HTML scraping for detail specs.
 * No auth needed — catalog is public.
 *
 * Modes (set via source.config.mode):
 *   'full'      — (default) Full catalog scrape: products, SKUs, images, specs, packaging, pricing
 *   'inventory' — Lightweight pass: updates only pricing for existing AZT- SKUs
 *
 * No inventory data is written — Arizona Tile's site stock flags are not
 * meaningful for our warehouse, so inventory_snapshots is left untouched.
 *
 * Flow:
 *   1. Fetch products via WP REST API
 *   2. Fetch detail pages, parse specs/gallery/variations/packaging/pricing
 *   3. Full mode: upsert products/SKUs/images/specs/packaging/pricing + activate
 *      Inventory mode: update pricing for existing SKUs only
 */
// When the vendor is hidden (vendors.hide_public_name), the site descriptions we scrape carry the
// distributor name + marketing/logistics boilerplate. Strip them before storing so a re-scrape can't
// reintroduce the name. Best-effort code scrub; seoRenderer.cleanDescription is the render-time backstop.
let HIDE_VENDOR_NAME = null;
function scrubHiddenVendor(text) {
  if (!HIDE_VENDOR_NAME || !text) return text;
  const n = HIDE_VENDOR_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let t = text;
  // vendor-only marketing / logistics boilerplate tails
  t = t.replace(new RegExp('\\s*(at\\s+)?' + n + ' we have tile and slabs whether you are building your dream.*$', 'is'), '');
  t = t.replace(new RegExp('\\s*-?\\s*whether you are building your dream with ' + n + '\\.?\\s*$', 'i'), '');
  t = t.replace(new RegExp('\\s*just imagine how ' + n + ' products can enhance your project.*$', 'is'), '');
  t = t.replace(new RegExp("\\s*[^.]*\\b" + n + " (?:does not|will not|carries|features|Slab Warehouse|locations)[^.]*\\.", 'gi'), '');
  // attribution phrasings
  t = t.replace(new RegExp(n + "['’]s\\s+", 'g'), 'the ');
  t = t.replace(new RegExp('\\s*(?:,?\\s*crafted by|,?\\s*by|\\s*from)\\s+' + n + '\\b', 'gi'), '');
  t = t.replace(new RegExp('\\s*' + n + '\\b', 'gi'), '');   // any remaining
  t = t.replace(/\s{2,}/g, ' ').replace(/\s+([.,])/g, '$1').replace(/\s*-\s*$/, '').trim();
  return t || null;
}

export async function run(pool, job, source) {
  const config = { ...DEFAULT_CONFIG, ...(source.config || {}) };
  const vendor_id = source.vendor_id;
  {
    const vr = await pool.query('SELECT name, hide_public_name FROM vendors WHERE id=$1', [vendor_id]);
    HIDE_VENDOR_NAME = vr.rows[0]?.hide_public_name === true ? vr.rows[0].name : null;
    if (HIDE_VENDOR_NAME) console.log(`  [hidden vendor — scrubbing "${HIDE_VENDOR_NAME}" from scraped descriptions]`);
  }
  const isInventoryMode = config.mode === 'inventory';

  const stats = {
    found: 0, created: 0, updated: 0, skusCreated: 0,
    imagesSet: 0, skipped: 0, errors: 0,
    pricingUpdated: 0,
    priceListHits: 0, priceListMisses: 0,
    deactivated: 0,
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
      signal: AbortSignal.timeout(60000)
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
        { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(60000) }
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
      // Retry once after a longer delay
      await delay(5000);
      try {
        const retryResp = await fetch(
          `${BASE_URL}/api/wp/v2/product?per_page=${config.perPage}&page=${page}`,
          { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(90000) }
        );
        if (retryResp.ok) {
          const products = await retryResp.json();
          if (products.length) {
            for (const p of products) {
              const classListRaw = p.class_list || {};
              const classList = Array.isArray(classListRaw) ? classListRaw : Object.values(classListRaw);
              allProducts.push({
                wpId: p.id, slug: p.slug,
                title: stripTags(p.title?.rendered || ''),
                link: p.link, categoryIds: p.product_cat || [],
                isInStock: classList.some(c => c.includes('instock')),
                isVariable: classList.some(c => c.includes('variable')),
                description: p.yoast_head_json?.description || null,
              });
            }
            const totalPages = parseInt(retryResp.headers.get('X-WP-TotalPages') || '5', 10);
            hasMore = page < totalPages;
            page++;
            await appendLog(pool, job.id, `REST API page ${page - 1} retry succeeded`);
            await delay(config.delayMs);
            continue;
          }
        }
      } catch { /* retry also failed */ }
      await addJobError(pool, job.id, `REST API page ${page}: ${err.message} (retry also failed)`);
      hasMore = false;
    }
  }

  // Optional cap for smoke-testing the pipeline on a handful of products
  // without a full catalog run. NOTE: a capped run must NOT deactivate orphans
  // (Phase 4 coverage gate handles this — a tiny sample trivially fails ≥50%).
  if (config.maxProducts && allProducts.length > config.maxProducts) {
    allProducts.length = config.maxProducts;
    await appendLog(pool, job.id, `maxProducts=${config.maxProducts} — capping discovery (smoke/test mode)`);
  }

  stats.found = allProducts.length;
  await appendLog(pool, job.id, `Phase 1 complete: ${stats.found} products from REST API`, {
    products_found: stats.found
  });

  // ── Phase 2: Fetch detail pages ──

  const detailDelayMs = Math.max(config.delayMs, 2000); // min 2s between requests (per worker) to avoid throttling
  // Fetch detail pages with a bounded worker pool instead of strictly
  // sequentially. The old one-at-a-time loop took ~40min for ~440 products and
  // routinely got reaped/marked failed. With N workers the wall-clock drops to
  // ~minutes while each worker still self-throttles (delay + per-page backoff).
  const DETAIL_CONCURRENCY = Math.max(1, config.detailConcurrency || 5);
  await appendLog(pool, job.id, `Phase 2: Fetching detail pages (${DETAIL_CONCURRENCY} workers, ${detailDelayMs}ms/worker delay)...`);

  // Cache parsed detail data per product
  const detailCache = new Map(); // wpId → parsedDetail | null

  const MAX_PAGE_RETRIES = 4;        // per-page retries on throttle before giving up
  const MAX_BACKOFF_MS = 90000;      // cap a single backoff sleep at 90s
  const ABORT_AFTER = 25;            // consecutive hard failures (post-retry) before bailing

  // Single fetch attempt. Distinguishes throttling (429/503, retryable) from a
  // genuine miss (404 etc, not retryable) so backoff only kicks in when the
  // server is actually rate-limiting us.
  async function fetchDetailOnce(apiProduct) {
    const resp = await fetch(apiProduct.link, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(45000)
    });
    if (resp.status === 429 || resp.status === 503 || resp.status === 403) {
      const raHeader = parseInt(resp.headers.get('retry-after') || '0', 10);
      return { ok: false, retryable: true, retryAfterMs: raHeader > 0 ? raHeader * 1000 : 0 };
    }
    if (!resp.ok) return { ok: false, retryable: false };
    const html = await resp.text();
    return { ok: true, data: parseDetailPage(html) };
  }

  // Fetch a detail page, backing off exponentially on throttle. Honors any
  // Retry-After the server sends. Returns parsed detail or null.
  async function fetchDetailPage(apiProduct) {
    let backoff = detailDelayMs * 2;
    for (let attempt = 0; attempt <= MAX_PAGE_RETRIES; attempt++) {
      let r;
      try {
        r = await fetchDetailOnce(apiProduct);
      } catch {
        r = { ok: false, retryable: true, retryAfterMs: 0 }; // timeout/network → treat as retryable
      }
      if (r.ok) return r.data;
      if (!r.retryable) return null; // genuine 404/etc — don't waste retries
      if (attempt < MAX_PAGE_RETRIES) {
        const wait = Math.min(r.retryAfterMs || backoff, MAX_BACKOFF_MS);
        await appendLog(pool, job.id,
          `  Throttled on ${apiProduct.wpId} — backing off ${Math.round(wait / 1000)}s (retry ${attempt + 1}/${MAX_PAGE_RETRIES})`);
        await delay(wait);
        backoff = Math.min(Math.round(backoff * 2.5), MAX_BACKOFF_MS);
      }
    }
    return null;
  }

  // Shared state across workers. `consecutiveFailures` resets on any success and
  // approximates a "sustained block" — when it mounts we cool off once, then set
  // `aborted` so every worker drains out. cursor++ is atomic here (single-
  // threaded, no await between read and increment), so no two workers take the
  // same index.
  let consecutiveFailures = 0;
  let completed = 0;
  let cursor = 0;
  let cooledOff = false;
  let aborted = false;

  async function detailWorker() {
    while (true) {
      if (aborted || job.abortController?.signal?.aborted) return;
      const i = cursor++;
      if (i >= allProducts.length) return;
      const apiProduct = allProducts[i];

      let result = null;
      try {
        result = await fetchDetailPage(apiProduct);
      } catch {
        result = null;
      }
      detailCache.set(apiProduct.wpId, result);

      if (result) {
        consecutiveFailures = 0;
      } else {
        consecutiveFailures++;
        // Each page already retried with backoff, so a run of hard failures
        // means a sustained block — cool off once, then bail if it persists.
        if (!cooledOff && consecutiveFailures === Math.floor(ABORT_AFTER / 2)) {
          cooledOff = true;
          await appendLog(pool, job.id, `${consecutiveFailures} consecutive failures — cooling off 60s before continuing...`);
          await delay(60000);
        }
        if (consecutiveFailures >= ABORT_AFTER) {
          if (!aborted) {
            aborted = true;
            await appendLog(pool, job.id, `Aborting Phase 2: ${consecutiveFailures} consecutive failures after backoff — server is blocking us`);
          }
          return;
        }
      }

      completed++;
      if (completed % 10 === 0 || completed === allProducts.length) {
        const ok = [...detailCache.values()].filter(v => v != null).length;
        await appendLog(pool, job.id, `Fetch progress: ${completed}/${allProducts.length} (${ok} OK)`);
      }

      await delay(detailDelayMs);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(DETAIL_CONCURRENCY, allProducts.length) }, () => detailWorker())
  );

  // Retry failed pages once more (fetchDetailPage already backs off internally).
  const failedProducts = allProducts.filter(p => detailCache.get(p.wpId) == null);
  if (!aborted && failedProducts.length > 0 && failedProducts.length < allProducts.length) {
    await appendLog(pool, job.id, `Retrying ${failedProducts.length} failed detail pages...`);
    let retryCursor = 0;
    async function retryWorker() {
      while (true) {
        const i = retryCursor++;
        if (i >= failedProducts.length) return;
        const apiProduct = failedProducts[i];
        try {
          const result = await fetchDetailPage(apiProduct);
          if (result) detailCache.set(apiProduct.wpId, result);
        } catch { /* still failed */ }
        await delay(detailDelayMs);
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(DETAIL_CONCURRENCY, failedProducts.length) }, () => retryWorker())
    );
  }

  const fetchedCount = [...detailCache.values()].filter(v => v != null).length;
  await appendLog(pool, job.id, `Fetched ${fetchedCount}/${allProducts.length} detail pages`);

  // ── Phase 3 ──

  if (isInventoryMode) {
    // ── Inventory mode: update pricing for existing SKUs only ──
    await appendLog(pool, job.id, 'Phase 3: Updating pricing for existing SKUs...');

    // Build internal_sku → sku record lookup for all AZT- SKUs
    const existingSkus = await pool.query(`
      SELECT s.id, s.internal_sku, s.sell_by, c.slug AS cat_slug
      FROM skus s
      LEFT JOIN products p ON p.id = s.product_id
      LEFT JOIN categories c ON c.id = p.category_id
      WHERE s.internal_sku LIKE 'AZT-%'`);
    const skuLookup = new Map(existingSkus.rows.map(r => [r.internal_sku, { id: r.id, sell_by: r.sell_by, cat_slug: r.cat_slug }]));
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
              const plan = planFromPriceList(plEntry, skuRec.cat_slug);
              // Keep sell_by in sync with price list unit so price suffix matches
              if (skuRec.sell_by !== plan.sellBy) {
                await pool.query('UPDATE skus SET sell_by = $1, updated_at = NOW() WHERE id = $2', [plan.sellBy, skuId]);
              }
              await upsertPricing(pool, skuId, {
                cost: plan.cost,
                retail_price: Math.round(plan.cost * 2 * 100) / 100,
                price_basis: plan.priceBasis,
              });
              stats.pricingUpdated++;
            }
          }
        } else {
          const internalSku = `AZT-${apiProduct.wpId}`;
          const skuRec = skuLookup.get(internalSku);
          if (!skuRec) continue;
          const skuId = skuRec.id;

          // Update pricing: price list first, then page price fallback
          const plEntry = priceList ? priceList.lookup(collectionName, null, null, null) : null;

          if (plEntry) {
            const plan = planFromPriceList(plEntry, skuRec.cat_slug);
            if (skuRec.sell_by !== plan.sellBy) {
              await pool.query('UPDATE skus SET sell_by = $1, updated_at = NOW() WHERE id = $2', [plan.sellBy, skuId]);
            }
            await upsertPricing(pool, skuId, {
              cost: plan.cost,
              retail_price: Math.round(plan.cost * 2 * 100) / 100,
              price_basis: plan.priceBasis,
            });
            stats.pricingUpdated++;
          }
        }
      } catch (err) {
        stats.errors++;
      }

      processIdx++;
      if (processIdx % 100 === 0) {
        await appendLog(pool, job.id, `Pricing progress: ${processIdx}/${allProducts.length}, updated: ${stats.pricingUpdated}`);
      }
    }

    await appendLog(pool, job.id,
      `Pricing scrape complete. Entries: ${stats.found}, ` +
      `Pricing updated: ${stats.pricingUpdated}, ` +
      `Errors: ${stats.errors}`,
      { products_found: stats.found }
    );
  } else {
    // ── Full mode: upsert products + SKUs ──
    await appendLog(pool, job.id, 'Phase 3: Upserting products and SKUs...');

    // AZ lists some stones as separate WC pages for tile and slab with IDENTICAL
    // titles (e.g. "Bianco Carrara" tile page + slab page). Both resolve to the
    // same (vendor, collection, name) product row, merging tile SKUs into the
    // slab product with the slab category clobbering the tile category. Track
    // which titles also have a non-slab page so colliding slab pages get a
    // distinct " Slab" collection (and thus their own product row).
    const titleHasNonSlab = new Set();
    for (const p of allProducts) {
      const raw = resolveBestCategory(p, azCategoryMap, categoryLookup);
      if (raw.pimCatSlug && !SLAB_CATEGORIES.has(raw.pimCatSlug)) {
        titleHasNonSlab.add(p.title.toLowerCase());
      }
    }

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
        let { categoryId, pimCatSlug } = resolveBestCategory(apiProduct, azCategoryMap, categoryLookup);

        // ── 3D wall-tile body split (ceramic vs porcelain) ──
        // AZ's 3D dimensional wall-tile subcategory (porcelain-and-ceramic-3d-tile)
        // mixes ceramic and porcelain series, but AZ's generic 'porcelain-and-ceramic'
        // tag lumps them all to porcelain-tile. Split on the parsed body/material spec:
        // "...Porcelain" stays porcelain; white/red-body is ceramic. (3D & Contour =
        // "Rectified White Body" → ceramic; Curve = "...Color Body Porcelain" → porcelain.)
        if (pimCatSlug === 'porcelain-tile'
            && categoryLookup.has('ceramic-tile')
            && apiProduct.categoryIds.some(id => azCategoryMap.get(id)?.slug === 'porcelain-and-ceramic-3d-tile')) {
          const body = (detail.specs?.type || '').toLowerCase();
          if (body && !body.includes('porcelain')) {
            categoryId = categoryLookup.get('ceramic-tile');
            pimCatSlug = 'ceramic-tile';
          }
        }

        // Save pre-guard category state for variant-level format splitting
        const originalFormatSlug = FORMAT_CATS.has(pimCatSlug) ? pimCatSlug : null;
        const originalSlabSlug = SLAB_CATEGORIES.has(pimCatSlug) ? pimCatSlug : null;

        // ── Mixed-product guard: mosaic should not win for field-tile collections ──
        // Products like Marvel have both 12x24 field tiles AND 2x2 Mosaic variants.
        // If a format category won via priority but the product has field-tile sizes,
        // fall back to the best material category.
        if (FORMAT_CATS.has(pimCatSlug) && detail.variations.length > 0) {
          const varSizes = detail.variations
            .map(v => (v.attributes?.attribute_pa_size || ''))
            .filter(Boolean);
          const hasFieldTileSize = varSizes.some(s => isFieldTileSize(s));

          if (hasFieldTileSize) {
            // Re-resolve: find best non-mosaic category
            let altPriority = -1, altCatId = null, altSlug = null;
            for (const catId of apiProduct.categoryIds) {
              const azCat = azCategoryMap.get(catId);
              if (!azCat || CATEGORY_SKIP.has(azCat.slug)) continue;
              const mapping = CATEGORY_MAP[azCat.slug];
              if (!mapping) continue;
              const [slug, priority] = mapping;
              // Skip all format categories — the product has field-tile sizes
              if (slug === 'mosaic-tile' || slug === 'stacked-stone' || slug === 'pavers') continue;
              if (priority > altPriority && categoryLookup.has(slug)) {
                altPriority = priority;
                altCatId = categoryLookup.get(slug);
                altSlug = slug;
              }
            }
            // Only demote to a SPECIFIC material category (priority ≥80, e.g.
            // porcelain-and-ceramic, marble-tile). Generic special-order/OL tags
            // ('stone' 70, 'special-order-series' 20) must not steal glass-SO
            // mosaic sheets whose sizes look field-like (Geo-Solid Square 12x12,
            // Geo-Highland 15x15).
            if (altCatId && altPriority >= 80) {
              categoryId = altCatId;
              pimCatSlug = altSlug;
            }
          }
        }

        // Resolve non-slab material category for tile-format variants in slab products
        let tileCatId = null, tileCatSlug = null;
        if (originalSlabSlug && SLAB_CATEGORIES.has(pimCatSlug)) {
          let altP = -1;
          for (const catId of apiProduct.categoryIds) {
            const azCat = azCategoryMap.get(catId);
            if (!azCat || CATEGORY_SKIP.has(azCat.slug)) continue;
            const mapping = CATEGORY_MAP[azCat.slug];
            if (!mapping) continue;
            const [slug, priority] = mapping;
            if (SLAB_CATEGORIES.has(slug) || FORMAT_CATS.has(slug)) continue;
            if (priority > altP && categoryLookup.has(slug)) {
              altP = priority;
              tileCatId = categoryLookup.get(slug);
              tileCatSlug = slug;
            }
          }
        }

        // ── Wall/backsplash tile detection ──
        // Small-format porcelain tiles (3x6, 4x16, 2-1/4x9-3/4, etc.) are wall tiles
        // IF the product has NO field-tile-sized variants (12x24, 24x48, etc.).
        // This is size-based, not finish-based — many wall tiles aren't labeled glossy.
        if (pimCatSlug === 'porcelain-tile' && categoryLookup.has('backsplash-wall')
            && detail.variations.length > 0) {
          const varSizes = detail.variations
            .map(v => (v.attributes?.attribute_pa_size || ''))
            .filter(s => s && s !== 'sample');
          // Check if ANY variant has a field-tile size (≥12 in both dims)
          const hasFieldSize = varSizes.some(s => isFieldTileSize(s));
          // Check if at least one variant has a recognized wall-tile size
          // Handles raw (4x16), WC-slugified (4-x-16), and fractional (2-1-4-x-9-3-4)
          const WALL_PATTERN = /\b(3-?x-?6|4-?x-?12|4-?x-?16|2-?x-?6|2-?x-?8|2-?x-?12|2-?x-?16|3-?x-?12|3-?x-?9|2\.?5-?x-?8|6-?x-?6|8-?x-?24)\b|\d-\d+-?\d*-x-\d/;
          const hasWallSize = varSizes.some(s => WALL_PATTERN.test(s));
          if (hasWallSize && !hasFieldSize) {
            categoryId = categoryLookup.get('backsplash-wall');
            pimCatSlug = 'backsplash-wall';
          }
        }

        // ── Name-based format override ──
        // Products tagged only with generic material categories (natural-stone-tile,
        // porcelain-and-ceramic) but whose collection name clearly indicates a specific
        // format (mosaic, stacked stone) get reclassified here.
        if (!FORMAT_CATS.has(pimCatSlug) && !SLAB_CATEGORIES.has(pimCatSlug)) {
          // Ledger products aren't always named "Ledger" — Haisa Blue's only
          // size is "Split Honed Ledger 6x24". Treat as stacked stone when
          // every variant size is a ledger/splitface size.
          const nonSampleSizes = detail.variations
            .map(v => (v.attributes?.attribute_pa_size || ''))
            .filter(s => s && s !== 'sample');
          const allLedgerSizes = nonSampleSizes.length > 0
            && nonSampleSizes.every(s => STACKED_NAME_PATTERN.test(s));
          if (MOSAIC_NAME_PATTERN.test(apiProduct.title)) {
            const mosaicId = categoryLookup.get('mosaic-tile');
            if (mosaicId) { categoryId = mosaicId; pimCatSlug = 'mosaic-tile'; }
          } else if (STACKED_NAME_PATTERN.test(apiProduct.title) || allLedgerSizes) {
            const stackedId = categoryLookup.get('stacked-stone');
            if (stackedId) { categoryId = stackedId; pimCatSlug = 'stacked-stone'; }
          }
        }

        // ── Determine collection + name ──
        // Collection = product title from API (e.g., "3D")
        // For variable products, group by color — each color becomes its own product
        // For simple products, keep title as name with collection
        const collectionName = apiProduct.title;
        // Customer-facing collection/name base with series codes expanded/stripped.
        // (collectionName itself stays pristine: price-list lookups key off it.)
        const displayCollection = normalizeSeriesTitle(apiProduct.title);
        // Slab page whose title collides with a tile/mosaic page — needs its own
        // collection so it doesn't share a product row with the tile product.
        const slabCollision = SLAB_CATEGORIES.has(pimCatSlug) && titleHasNonSlab.has(apiProduct.title.toLowerCase());

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
            const rawColor = colorSlug ? deslugify(colorSlug) : apiProduct.title;
            // Skip the collection prefix when the page title already CONTAINS the
            // color name ("CS-Terra Nova" + color "Terra Nova" would double into
            // "CS-Terra Nova Terra Nova ...") — the color is the identity there.
            const productName = (displayCollection
                && !rawColor.toLowerCase().startsWith(displayCollection.toLowerCase())
                && !displayCollection.toLowerCase().includes(rawColor.toLowerCase()))
              ? joinDedupe(displayCollection, rawColor)
              : rawColor;

            // Build best product-shot lookup from all sibling variations in this color group.
            // When a variant only has a lifestyle image, we can substitute a product shot from a sibling.
            let colorBestProductShot = null;
            for (const { v: sv } of variations) {
              const svImg = sv.image?.url || sv.image?.src || null;
              if (!svImg || /coming-soon/i.test(svImg)) continue;
              const svUrl = reParamWidenUrl(svImg);
              if (!isLifestyleUrl(svUrl, productName)) {
                // Found a product shot — prefer swatches over generic product images
                if (!colorBestProductShot || /swatch/i.test(svUrl)) {
                  colorBestProductShot = svUrl;
                  if (/swatch/i.test(svUrl)) break; // swatch is ideal, stop looking
                }
              }
            }

            // Sub-group variations by format for variant-level category splitting
            const formatGroups = new Map();
            for (const entry of variations) {
              const fmt = classifyVariation(
                entry.v.attributes?.attribute_pa_size,
                originalFormatSlug,
                originalSlabSlug
              );
              if (!formatGroups.has(fmt)) formatGroups.set(fmt, []);
              formatGroups.get(fmt).push(entry);
            }

            const needsSuffix = formatGroups.size > 1;

            for (const [fmt, fmtVariations] of formatGroups) {
              let effectiveCollection = displayCollection;
              let effectiveCatId = categoryId;
              let effectiveCatSlug = pimCatSlug;

              if (fmt === 'mosaic') {
                const mosaicId = categoryLookup.get('mosaic-tile');
                if (mosaicId) { effectiveCatId = mosaicId; effectiveCatSlug = 'mosaic-tile'; }
                if (needsSuffix) effectiveCollection += ' Mosaics';
              } else if (fmt === 'stacked') {
                // Porcelain series' "stack" groups (Canyon, Marvel, Shibusa, …)
                // are mesh-mounted stacked-LOOK mosaic sheets, not stone ledger
                // — browse them under mosaic-tile. Real stone pages keep
                // stacked-stone. The " Stacked Stone" collection suffix stays
                // either way: it names the look, and product identity keys on
                // (vendor, collection, name).
                const porcelainStack = apiProduct.categoryIds.some(id => {
                  const az = azCategoryMap.get(id);
                  return az && (az.slug === 'porcelain-and-ceramic' || az.slug === 'porcelain-stack');
                });
                const stackSlug = porcelainStack ? 'mosaic-tile' : 'stacked-stone';
                const stackedId = categoryLookup.get(stackSlug);
                if (stackedId) { effectiveCatId = stackedId; effectiveCatSlug = stackSlug; }
                if (needsSuffix) effectiveCollection += ' Stacked Stone';
              } else if (fmt === 'paver') {
                const paverId = categoryLookup.get('pavers');
                if (paverId) { effectiveCatId = paverId; effectiveCatSlug = 'pavers'; }
                if (needsSuffix) effectiveCollection += ' Pavers';
              } else if (fmt === 'tile') {
                if (tileCatId) {
                  effectiveCatId = tileCatId;
                  effectiveCatSlug = tileCatSlug;
                } else {
                  // No tile category from AZ WC tags — use slab-to-tile fallback
                  const fb = SLAB_TO_TILE_FALLBACK[originalSlabSlug];
                  if (fb && categoryLookup.has(fb)) {
                    effectiveCatId = categoryLookup.get(fb);
                    effectiveCatSlug = fb;
                  }
                }
                if (needsSuffix) effectiveCollection += ' Tile';
              } else if (fmt === 'default' && effectiveCatSlug === 'mosaic-tile') {
                // Piece-format leftovers of a mosaic-tagged series (Gem fluted
                // 2x16 strips, S-Series 2x12, Thin Brick 2x8, Atlantic Grey
                // 4x16 Split): the series page's mesh-mount tags describe the
                // sibling mosaic groups, not these loose pieces. Demote to the
                // material category when EVERY size in the group is a clean
                // integer piece size ≤4" on one side (mesh sheets have
                // fractional dims — Geometro et al. stay mosaics).
                const pieceSizes = fmtVariations
                  .map(e => e.v.attributes?.attribute_pa_size || '')
                  .filter(s => s && s !== 'sample');
                const allWallPieces = pieceSizes.length > 0 && pieceSizes.every(s => {
                  if (MOSAIC_KW.test(s)) return false;
                  const d = parseSizeDims(s);
                  return d && Number.isInteger(d[0]) && Number.isInteger(d[1])
                    && Math.min(d[0], d[1]) <= 4 && Math.max(d[0], d[1]) <= 24;
                });
                if (allWallPieces) {
                  // Strongest non-format material tag. The ≥50 floor skips the
                  // generic special-order/outer-limits fallbacks so tag-less
                  // glass mosaic series (Geo-Solid etc.) keep mosaic-tile.
                  let altSlug = null, altP = 49;
                  for (const catId of apiProduct.categoryIds) {
                    const azCat = azCategoryMap.get(catId);
                    if (!azCat || CATEGORY_SKIP.has(azCat.slug)) continue;
                    const mapping = CATEGORY_MAP[azCat.slug];
                    if (!mapping) continue;
                    const [slug, priority] = mapping;
                    if (FORMAT_CATS.has(slug) || SLAB_CATEGORIES.has(slug)) continue;
                    if (priority > altP && categoryLookup.has(slug)) { altP = priority; altSlug = slug; }
                  }
                  const fluted = /flut/i.test(`${apiProduct.title} ${apiProduct.description || ''}`);
                  const target = fluted && categoryLookup.has('fluted-tile') ? 'fluted-tile'
                    : (!altSlug || altSlug === 'porcelain-tile' || altSlug === 'ceramic-tile')
                      ? 'backsplash-wall' : altSlug;
                  if (categoryLookup.has(target)) {
                    effectiveCatId = categoryLookup.get(target);
                    effectiveCatSlug = target;
                  }
                }
              } else if (slabCollision && SLAB_CATEGORIES.has(effectiveCatSlug)) {
                effectiveCollection += ' Slab';
              }

            // ── Mosaic shape sub-grouping ──
            // For mosaics, group variants by shape/pattern so each shape gets its
            // own product with the shape in the name (e.g., "Bardiglio Herringbone").
            // Skip for 'stacked' groups routed to mosaic-tile: their sizes hit
            // shape words ("Straight Stack", "Long Rhomboid") and renaming would
            // fork existing products.
            const shapeSubGroups = [];
            if (effectiveCatSlug === 'mosaic-tile' && fmt !== 'stacked') {
              const shapeMap = new Map();
              for (const entry of fmtVariations) {
                const shape = extractMosaicShape(entry.v.attributes?.attribute_pa_size);
                if (!shapeMap.has(shape)) shapeMap.set(shape, []);
                shapeMap.get(shape).push(entry);
              }
              for (const [shape, vars] of shapeMap) {
                // Don't append a shape word the name already carries
                // ("Large Chevron Terra Nova" + shape "Chevron")
                const hasShape = shape && new RegExp('\\b' + shape.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + 's?\\b', 'i').test(productName);
                shapeSubGroups.push([shape && !hasShape ? `${productName} ${shape}` : productName, vars, shape]);
              }
            } else {
              shapeSubGroups.push([productName, fmtVariations, '']);
            }

            for (const [effectiveName, subVariations, mosaicShape] of shapeSubGroups) {

            // ── Skip format-page duplicates ──
            // Format pages (Modella, Split) list colors that usually have their own
            // WC product page. If this color already exists under a different collection,
            // skip to avoid creating a duplicate product.
            if (FORMAT_PAGE_TITLES.has(collectionName)) {
              const existsElsewhere = await pool.query(
                `SELECT 1 FROM products WHERE vendor_id = $1 AND name = $2
                 AND collection NOT LIKE $3 AND is_active = true LIMIT 1`,
                [vendor_id, effectiveName, collectionName + '%']
              );
              if (existsElsewhere.rows.length > 0) {
                continue;
              }
            }

            const product = await upsertProduct(pool, {
              vendor_id,
              name: effectiveName,
              collection: effectiveCollection,
              category_id: effectiveCatId,
              description_short: apiProduct.description ? scrubHiddenVendor(apiProduct.description.slice(0, 255)) : null,
              description_long: scrubHiddenVendor(apiProduct.description)
            });

            if (product.is_new) stats.created++;
            else stats.updated++;
            touchedProductIds.push(product.id);

            // ── Product-level primary image ──
            // Collect ALL candidate images from all subVariation galleries + variation.image,
            // then run preferProductShot to select the best product shot.
            const isMosaicCtx = effectiveCatSlug === 'mosaic-tile';
            // Never propagate a FIELD-TILE sibling shot into a mosaic product —
            // that's how a 12x24 hero lands on a 2x2 mosaic when its own gallery
            // image is (transiently) unavailable. A lifestyle image or no image
            // beats a wrong-format product shot.
            const siblingShot = (isMosaicCtx && colorBestProductShot && isFieldTileUrl(colorBestProductShot))
              ? null : colorBestProductShot;
            let productPrimaryCandidates = [];
            for (const { v: cv } of subVariations) {
              const varGal = galleryData.byVariationId[cv.variation_id] || [];
              for (const url of varGal) {
                productPrimaryCandidates.push(reParamWidenUrl(url));
              }
              const cvImg = cv.image?.url || cv.image?.src || null;
              if (cvImg) productPrimaryCandidates.push(reParamWidenUrl(cvImg));
            }
            // Deduplicate and filter placeholders
            productPrimaryCandidates = await filterWidenPlaceholders(
              filterImageUrls([...new Set(productPrimaryCandidates)]
                .filter(u => !/coming-soon/i.test(u)))
            );
            // For mosaics, prefer non-field-tile images; keep field-tile as last resort
            if (isMosaicCtx) {
              const mosaicOnly = productPrimaryCandidates.filter(u => !isFieldTileUrl(u));
              if (mosaicOnly.length > 0) productPrimaryCandidates = mosaicOnly;
            }
            // Sibling propagation: if first candidate is lifestyle, use color group's product shot
            if (siblingShot && productPrimaryCandidates.length > 0 && isLifestyleUrl(productPrimaryCandidates[0], effectiveName)) {
              productPrimaryCandidates.unshift(siblingShot);
            } else if (siblingShot && productPrimaryCandidates.length === 0) {
              productPrimaryCandidates.push(siblingShot);
            }
            const productPrimaryUrl = productPrimaryCandidates.length > 0 ? productPrimaryCandidates[0] : null;

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

            for (const { vi, v } of subVariations) {
              // Variant name: size + finish (color is now in product name)
              let sizePart = v.attributes?.attribute_pa_size ? deslugify(v.attributes.attribute_pa_size) : '';
              const finishPart = v.attributes?.attribute_pa_finishes ? deslugify(v.attributes.attribute_pa_finishes) : '';

              // Strip mosaic shape from sizePart — it's already in the product name
              if (mosaicShape && sizePart) {
                sizePart = sizePart.replace(new RegExp(`\\b${mosaicShape}\\b`, 'i'), '').replace(/\s{2,}/g, ' ').trim();
              }
              // Strip finish from sizePart when it appears as a leading/trailing word group
              // e.g. "Multi Finish Modella" + finish "Multi Finish" → "Modella"
              if (finishPart && sizePart) {
                const esc = finishPart.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                sizePart = sizePart
                  .replace(new RegExp(`^${esc}\\b\\s*`, 'i'), '')
                  .replace(new RegExp(`\\s*\\b${esc}$`, 'i'), '')
                  .trim();
              }

              const variantName = buildVariantName(sizePart, finishPart);

              const accessory = isAccessory(apiProduct.title, apiProduct.description);

              // ── Price list lookup ──
              const plEntry = priceList
                ? priceList.lookup(collectionName, colorSlug, v.attributes?.attribute_pa_size, v.attributes?.attribute_pa_finishes)
                : null;

              // Determine sell_by from price list unit or fallback
              const plPlan = plEntry ? planFromPriceList(plEntry, effectiveCatSlug) : null;
              const sellBy = plPlan ? plPlan.sellBy : resolveSellBy(effectiveCatSlug, accessory, detail.soldBy);

              const sku = await upsertSku(pool, {
                product_id: product.id,
                vendor_sku: String(v.variation_id),
                internal_sku: `AZT-${v.variation_id}`,
                variant_name: variantName,
                sell_by: sellBy,
                ...(accessory && { variant_type: 'accessory' }),
              }, { sellByAuthoritative: !!plPlan });
              if (sku.is_new) stats.skusCreated++;

              // ── Pricing: price list only (no WC fallback — "Call for Price" if no match) ──
              if (plPlan) {
                await upsertPricing(pool, sku.id, {
                  cost: plPlan.cost,
                  retail_price: Math.round(plPlan.cost * 2 * 100) / 100,
                  price_basis: plPlan.priceBasis,
                });
                stats.priceListHits++;
              } else {
                stats.priceListMisses++;
              }

              // ── Packaging: price list first, then HTML-parsed fallback ──
              // Some price-list rows only give sf/pc + pcs/box — derive box sqft
              // from those, but only when the result is a plausible BOX (≤60 sqft):
              // large-format rows put CRATE counts in pcs/box (24x24 = 98 pcs =
              // 392 sqft), which must not be stored as a box.
              const plSfPerBox = plEntry
                ? (plEntry.sfPerBox
                    || ((plEntry.sfPerPc && plEntry.pcsPerBox && plEntry.sfPerPc * plEntry.pcsPerBox <= 60)
                        ? Math.round(plEntry.sfPerPc * plEntry.pcsPerBox * 10000) / 10000 : null))
                : null;
              if (plSfPerBox) {
                await upsertPackaging(pool, sku.id, {
                  sqft_per_box: plSfPerBox,
                  pieces_per_box: plEntry.pcsPerBox || null,
                  weight_per_box_lbs: null,
                  boxes_per_pallet: plEntry.boxesPerPallet || null,
                  sqft_per_pallet: plEntry.sfPerPallet || null,
                  weight_per_pallet_lbs: null,
                });
              } else if (detail.packaging && Object.keys(detail.packaging).length > 0 && !NO_BOX_CATEGORIES.has(effectiveCatSlug)
                         && detail.variations.length === 1) {
                // Page-level packaging block describes ONE variant — only safe to
                // apply when the page has a single variation (it used to smear the
                // default variant's box info across every size on the page).
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
              await upsertAllSpecAttributes(pool, sku.id, detail.specs, detail.technicalSpecs, { skipFinish: !!v.attributes?.attribute_pa_finishes });

              // ── Per-variant images ──
              // Gallery first (first = primary), variation.image as fallback only
              const varImage = v.image?.url || v.image?.src || null;
              const sortBase = (vi + 1) * 100;

              const varGallery = galleryData.byVariationId[v.variation_id] || [];
              let allVarImages = await filterWidenPlaceholders(filterImageUrls(normalizeWidenUrls(varGallery)));

              // For mosaic SKUs, prefer non-field-tile images; keep field-tile as last resort
              if (isMosaicCtx) {
                const mosaicOnly = allVarImages.filter(u => !isFieldTileUrl(u));
                if (mosaicOnly.length > 0) allVarImages = mosaicOnly;
              }

              // If gallery is empty, fall back to variation.image (skip placeholders)
              if (allVarImages.length === 0 && varImage && !/coming-soon/i.test(varImage)) {
                const fallback = await filterWidenPlaceholders([reParamWidenUrl(varImage)]);
                if (fallback.length > 0) allVarImages.push(fallback[0]);
              }

              // Sibling propagation: if primary is a lifestyle image but a sibling variant
              // in the same color group has a product shot, use that instead
              if (siblingShot && allVarImages.length > 0 && isLifestyleUrl(allVarImages[0], effectiveName)) {
                allVarImages.unshift(siblingShot);
              } else if (siblingShot && allVarImages.length === 0) {
                allVarImages.push(siblingShot);
              }

              for (let gi = 0; gi < allVarImages.length && gi < MAX_GALLERY_IMAGES; gi++) {
                const imgUrl = allVarImages[gi];
                const isLife = isLifestyleUrl(imgUrl);
                const assetType = gi === 0 && !isLife ? 'primary'
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
            } // end for variations
            } // end for shapeSubGroups
            } // end for formatGroups
          } // end for colorGroups
        } else {
          // Simple product: single SKU — use title as name, no collection grouping
          const product = await upsertProduct(pool, {
            vendor_id,
            name: displayCollection,
            collection: slabCollision ? `${displayCollection} Slab` : displayCollection,
            category_id: categoryId,
            description_short: apiProduct.description ? scrubHiddenVendor(apiProduct.description.slice(0, 255)) : null,
            description_long: scrubHiddenVendor(apiProduct.description)
          });

          if (product.is_new) stats.created++;
          else stats.updated++;
          touchedProductIds.push(product.id);

          // Product-level primary image (filtered, vendor gallery order preserved)
          const simpleFiltered = await filterWidenPlaceholders(filterImageUrls(normalizeWidenUrls(galleryFlat)));
          if (simpleFiltered.length > 0) {
            await upsertMediaAsset(pool, {
              product_id: product.id,
              sku_id: null,
              asset_type: 'primary',
              url: simpleFiltered[0],
              original_url: simpleFiltered[0],
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
            : (priceList ? priceList.lookupSimple(apiProduct.title, apiProduct.slug, detail.specs, isSlab) : null);

          // Multi-gauge path: create one SKU per thickness
          if (gaugeEntries.length > 1) {
            for (const entry of gaugeEntries) {
              const gauge = entry.normalizedGauge; // e.g. "2CM", "3CM"
              const entryPlan = planFromPriceList(entry, pimCatSlug);

              const sku = await upsertSku(pool, {
                product_id: product.id,
                vendor_sku: `${apiProduct.wpId}-${gauge}`,
                internal_sku: `AZT-${apiProduct.wpId}-${gauge}`,
                variant_name: gauge,
                sell_by: entryPlan.sellBy,
                ...(accessory && { variant_type: 'accessory' }),
              });
              if (sku.is_new) stats.skusCreated++;

              // Pricing per gauge
              await upsertPricing(pool, sku.id, {
                cost: entryPlan.cost,
                retail_price: Math.round(entryPlan.cost * 2 * 100) / 100,
                price_basis: entryPlan.priceBasis,
              });
              stats.priceListHits++;

              // Spec attributes (shared across gauges)
              await upsertAllSpecAttributes(pool, sku.id, detail.specs, detail.technicalSpecs);
              // Override thickness with the specific gauge value
              await upsertSkuAttribute(pool, sku.id, 'thickness', gauge);
            }
            // Images at product level only (sku_id: null) — API falls back to product-level media
            if (simpleFiltered.length > 0) {
              for (let gi = 0; gi < simpleFiltered.length; gi++) {
                const imgUrl = simpleFiltered[gi];
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
            const plPlan = plEntry ? planFromPriceList(plEntry, pimCatSlug) : null;
            const sellBy = plPlan ? plPlan.sellBy : resolveSellBy(pimCatSlug, accessory, detail.soldBy);

            const sku = await upsertSku(pool, {
              product_id: product.id,
              vendor_sku: String(apiProduct.wpId),
              internal_sku: `AZT-${apiProduct.wpId}`,
              variant_name: null,
              sell_by: sellBy,
              ...(accessory && { variant_type: 'accessory' }),
            }, { sellByAuthoritative: !!plPlan });
            if (sku.is_new) stats.skusCreated++;

            // ── Pricing: price list only (no WC fallback — "Call for Price" if no match) ──
            if (plPlan) {
              await upsertPricing(pool, sku.id, {
                cost: plPlan.cost,
                retail_price: Math.round(plPlan.cost * 2 * 100) / 100,
                price_basis: plPlan.priceBasis,
              });
              stats.priceListHits++;
            } else {
              stats.priceListMisses++;
            }

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

            // ── Images (vendor gallery order preserved, filtered by filterImageUrls) ──
            if (simpleFiltered.length > 0) {
              for (let gi = 0; gi < simpleFiltered.length; gi++) {
                const imgUrl = simpleFiltered[gi];
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
      if (idx % 25 === 0 || idx === allProducts.length) {
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
        `UPDATE products SET status = 'active', is_active = true, updated_at = CURRENT_TIMESTAMP
         WHERE id = ANY($1) AND status = 'draft'`,
        [touchedProductIds]
      );
      await appendLog(pool, job.id, `Activated ${activateResult.rowCount} products (${touchedProductIds.length} total touched)`);

      // ── Phase 4b: Deactivate products no longer in catalog ──
      // Safety guards (ALL must pass):
      //   1. ≥50% of existing active products were touched (prevents partial-catalog issues)
      //   2. ≥80% of detail pages were successfully fetched (prevents fetch-failure cascades)
      const fetchRatio = allProducts.length > 0 ? fetchedCount / allProducts.length : 0;
      const activeResult = await pool.query(
        `SELECT id FROM products WHERE vendor_id = $1 AND status = 'active'`,
        [vendor_id]
      );
      const touchedSet = new Set(touchedProductIds);
      const orphanIds = activeResult.rows.filter(r => !touchedSet.has(r.id)).map(r => r.id);
      const ratio = activeResult.rows.length > 0 ? touchedProductIds.length / activeResult.rows.length : 0;

      if (orphanIds.length > 0 && ratio >= 0.5 && fetchRatio >= 0.8) {
        const deactivateResult = await pool.query(
          `UPDATE products SET status = 'inactive', is_active = false, updated_at = CURRENT_TIMESTAMP
           WHERE id = ANY($1)
           RETURNING id`,
          [orphanIds]
        );
        stats.deactivated = deactivateResult.rowCount;
        await appendLog(pool, job.id,
          `Deactivated ${deactivateResult.rowCount} products not found in latest catalog ` +
          `(coverage: ${(ratio * 100).toFixed(0)}%, fetch: ${(fetchRatio * 100).toFixed(0)}%, ` +
          `${orphanIds.length} orphans out of ${activeResult.rows.length} active)`
        );
      } else if (orphanIds.length > 0) {
        const reasons = [];
        if (ratio < 0.5) reasons.push(`coverage ${(ratio * 100).toFixed(0)}% < 50%`);
        if (fetchRatio < 0.8) reasons.push(`detail fetch ${(fetchRatio * 100).toFixed(0)}% < 80% (${fetchedCount}/${allProducts.length})`);
        await appendLog(pool, job.id,
          `Skipping deactivation of ${orphanIds.length} orphans: ${reasons.join(', ')}`
        );
      }
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

    // ── Phase 5: Audit & fix primary images — demote lifestyle primaries ──
    await appendLog(pool, job.id, 'Phase 5: Auditing primary images...');
    const primaryRows = await pool.query(`
      SELECT ma.id as media_id, ma.url, ma.product_id, ma.sku_id,
             s.internal_sku, p.name as product_name, p.collection
      FROM media_assets ma
      JOIN skus s ON s.id = ma.sku_id
      JOIN products p ON p.id = ma.product_id
      WHERE s.internal_sku LIKE 'AZT-%'
        AND ma.asset_type = 'primary'
    `);

    const suspects = [];
    for (const row of primaryRows.rows) {
      if (isLifestyleUrl(row.url, row.product_name)) {
        suspects.push(row);
      }
    }

    if (suspects.length > 0) {
      await appendLog(pool, job.id,
        `Primary image audit: ${suspects.length}/${primaryRows.rows.length} have lifestyle primary — fixing...`
      );
      let fixed = 0, keptAsOnly = 0;
      for (const s of suspects) {
        // Check if there's a non-lifestyle alternate we can promote
        const alt = await pool.query(`
          SELECT id, url FROM media_assets
          WHERE sku_id = $1 AND asset_type IN ('alternate', 'lifestyle')
            AND id != $2
          ORDER BY sort_order
        `, [s.sku_id, s.media_id]);

        const goodAlt = alt.rows.find(r => !isLifestyleUrl(r.url, s.product_name));
        if (goodAlt) {
          // Swap asset_type AND sort_order. A single-statement swap still trips
          // the unique (product_id, sku_id, asset_type, sort_order) index —
          // Postgres checks it per-row mid-statement — so park the old primary
          // at an unused negative sort first, then move each row. One bad image
          // must not fail the whole job.
          try {
            const pair = await pool.query(
              'SELECT id, asset_type, sort_order FROM media_assets WHERE id IN ($1, $2)',
              [s.media_id, goodAlt.id]);
            const oldP = pair.rows.find(r => r.id === s.media_id);
            const newP = pair.rows.find(r => r.id === goodAlt.id);
            await pool.query('UPDATE media_assets SET sort_order = $2 WHERE id = $1',
              [s.media_id, -1000 - fixed]);
            await pool.query('UPDATE media_assets SET asset_type = $2, sort_order = $3 WHERE id = $1',
              [goodAlt.id, oldP.asset_type, oldP.sort_order]);
            await pool.query('UPDATE media_assets SET asset_type = $2, sort_order = $3 WHERE id = $1',
              [s.media_id, newP.asset_type, newP.sort_order]);
            fixed++;
          } catch (err) {
            await appendLog(pool, job.id, `Primary image swap failed for ${s.internal_sku}: ${err.message}`);
          }
        } else {
          // No product shot available — keep lifestyle as primary (better than nothing)
          keptAsOnly++;
        }
      }
      await appendLog(pool, job.id,
        `Primary image audit: fixed ${fixed}, kept ${keptAsOnly} (no product shot available)`
      );
    } else {
      await appendLog(pool, job.id, `Primary image audit: all ${primaryRows.rows.length} primaries are product shots`);
    }

    await appendLog(pool, job.id,
      `Scrape complete. Found: ${stats.found}, Created: ${stats.created}, ` +
      `Updated: ${stats.updated}, SKUs: ${stats.skusCreated}, ` +
      `Images: ${stats.imagesSet}, Deactivated: ${stats.deactivated}, ` +
      `Skipped: ${stats.skipped}, Errors: ${stats.errors}, ` +
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
