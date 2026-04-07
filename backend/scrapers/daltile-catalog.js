import {
  upsertSkuAttribute, upsertMediaAsset,
  appendLog, addJobError
} from './base.js';

/**
 * Daltile / American Olean / Marazzi public website catalog scraper.
 *
 * Uses the Coveo REST API exposed on each brand's website to fetch
 * structured product data (descriptions, images, filterable attributes).
 * No Puppeteer needed — plain fetch() against an unauthenticated JSON API.
 *
 * This scraper ENRICHES existing SKUs (matched by vendor_sku from the 832
 * EDI feed or PDF price list scrapers) with images, categories, and
 * attributes from the public Coveo API. It never creates new products
 * or SKUs — the 832 feed is the source of truth for sellable inventory.
 *
 * The Coveo SKU format is color_code + item_code (e.g., "AC11PLK848MT"),
 * which matches the vendor_sku created by the PDF pricing scraper after
 * color-ref expansion.
 *
 * Works for all three brands via source.base_url detection:
 *   - www.daltile.com
 *   - www.americanolean.com
 *   - www.marazziusa.com
 */

const BRAND_CONFIG = {
  'www.daltile.com':        { code: 'DAL', name: 'Daltile' },
  'www.americanolean.com':  { code: 'AO',  name: 'American Olean' },
  'www.marazziusa.com':     { code: 'MZ',  name: 'Marazzi' },
};

// Coveo caps firstResult at ~5000. For large catalogs, split by product type.
const PRODUCT_TYPE_SPLITS = [
  'Floor Tile',
  'Floor Tile Trim',
  'Wall Tile',
  'Wall Tile Trim',
  'Mosaic Tile',
  'Mosaic Tile Trim',
  'Mosaic Natural Stone Tile',
  'Stone Tile',
  'Stone Tile Trim',
  'LVT Trim',
  'LVT Plank',
  'Luxury Vinyl Tile',
  'Porcelain Slab',
  'Quartz Slab',
  'Natural Stone Slab',
  'Quarry Tile',
  'Quarry Tile Trim',
  'Floor Tile Deco',
  'Wall Tile Deco',
  'Wall Bathroom Accessories',
  'Windowsills-Thresholds',
];

const COVEO_FIELDS = [
  'sku', 'seriesname', 'colornameenglish', 'nominalsize',
  'finish', 'productshape', 'bodytype', 'countryofmanufacture',
  'shadevariation', 'specialfeatures', 'productimageurl',
  'primaryroomsceneurl', 'pdpurl', 'sampleavailable',
  'producttype',
];

const PAGE_SIZE = 1000;
const COVEO_OFFSET_LIMIT = 5000;

export async function run(pool, job, source) {
  const baseUrl = (source.base_url || source.config?.base_url || '').replace(/\/+$/, '');
  const domain = extractDomain(baseUrl);
  const brand = BRAND_CONFIG[domain];

  if (!brand) {
    throw new Error(
      `Unknown domain "${domain}". Expected one of: ${Object.keys(BRAND_CONFIG).join(', ')}`
    );
  }

  await appendLog(pool, job.id, `Starting ${brand.name} catalog scraper (Coveo API) for ${domain}`);

  // Step 1: Fetch all results from Coveo
  const allResults = await fetchAllCoveoResults(domain, job, pool);
  await appendLog(pool, job.id, `Fetched ${allResults.length} total Coveo results`);

  if (allResults.length === 0) {
    await appendLog(pool, job.id, 'No results from Coveo API. Check domain or API availability.');
    return;
  }

  // Step 2: Load existing vendor SKUs and category map
  const vendorId = source.vendor_id;
  const existingSkus = await loadExistingSkus(pool, vendorId);
  await appendLog(pool, job.id, `Loaded ${existingSkus.size} existing SKUs from DB for matching`);

  const catMap = await loadCategoryMap(pool);

  // Step 3: Process each Coveo result
  let stats = {
    matched: 0,
    attributesSet: 0,
    imagesSet: 0,
    categoriesSet: 0,
    displayNamesSet: 0,
    skipped: 0,
    errors: 0,
  };

  for (let i = 0; i < allResults.length; i++) {
    const item = allResults[i];
    try {
      await processItem(pool, item, vendorId, brand, existingSkus, stats, catMap);
    } catch (err) {
      stats.errors++;
      if (stats.errors <= 30) {
        const sku = getField(item, 'sku') || '(no sku)';
        await addJobError(pool, job.id, `Item ${sku}: ${err.message}`);
      }
    }

    // Progress log every 500 items
    if ((i + 1) % 500 === 0) {
      await appendLog(pool, job.id,
        `Progress: ${i + 1}/${allResults.length} — matched: ${stats.matched}, skipped: ${stats.skipped}`,
        { products_found: i + 1, products_updated: stats.matched }
      );
    }
  }

  // Step 4: Fallback image matching for products without images
  // Some products only exist in the PDF price book and don't match any Coveo SKU.
  // Try to find images by matching series+color name or series name from Coveo data.
  const nameMatched = await matchImagesByName(pool, vendorId, allResults, job);
  stats.imagesSet += nameMatched;

  // Final summary
  await appendLog(pool, job.id,
    `Complete. Coveo results: ${allResults.length}, SKU matches: ${stats.matched}, ` +
    `Categories set: ${stats.categoriesSet}, Display names set: ${stats.displayNamesSet || 0}, ` +
    `Attributes set: ${stats.attributesSet}, Images set: ${stats.imagesSet}, ` +
    `Name-matched images: ${nameMatched}, ` +
    `Skipped (no match): ${stats.skipped}, Errors: ${stats.errors}`,
    {
      products_found: allResults.length,
      products_updated: stats.matched,
    }
  );
}

// ─── Coveo API ──────────────────────────────────────────────────────────────

/**
 * Fetch all product results from the Coveo API, handling pagination
 * and automatic query splitting for large catalogs (>5000 results).
 */
async function fetchAllCoveoResults(domain, job, pool) {
  // First, check total count with a single query
  const probe = await queryCoveo(domain, '', 0, 0);
  const totalCount = probe.totalCount || 0;

  await appendLog(pool, job.id, `Coveo reports ${totalCount} total products for ${domain}`);

  if (totalCount === 0) return [];

  if (totalCount <= COVEO_OFFSET_LIMIT) {
    // Simple pagination — all results fit within offset limit
    return await paginateQuery(domain, '', totalCount);
  }

  // Need to split by product type to stay under offset limit
  await appendLog(pool, job.id,
    `Total (${totalCount}) exceeds Coveo offset limit (${COVEO_OFFSET_LIMIT}). Splitting by product type.`
  );

  const allResults = [];
  const seenSkus = new Set();

  for (const productType of PRODUCT_TYPE_SPLITS) {
    const typeFilter = ` @producttype=="${productType}"`;
    const typeProbe = await queryCoveo(domain, typeFilter, 0, 0);
    const typeCount = typeProbe.totalCount || 0;

    if (typeCount === 0) continue;

    await appendLog(pool, job.id, `  ${productType}: ${typeCount} results`);
    const results = await paginateQuery(domain, typeFilter, typeCount);

    for (const r of results) {
      const rawSku = getField(r, 'sku');
      if (!rawSku) continue;
      // Handle multi-SKU entries (semicolon-delimited)
      const skuParts = rawSku.split(/[;,]/).map(s => s.trim()).filter(Boolean);
      const key = skuParts.map(s => s.toUpperCase()).sort().join('|');
      if (!seenSkus.has(key)) {
        seenSkus.add(key);
        allResults.push(r);
      }
    }
  }

  // Catch-all for any product types not in our split list
  const catchAllFilter = PRODUCT_TYPE_SPLITS
    .map(t => `@producttype<>"${t}"`)
    .join(' ');
  const catchProbe = await queryCoveo(domain, ` ${catchAllFilter}`, 0, 0);
  const catchCount = catchProbe.totalCount || 0;

  if (catchCount > 0) {
    await appendLog(pool, job.id, `  (other types): ${catchCount} results`);
    const results = await paginateQuery(domain, ` ${catchAllFilter}`, Math.min(catchCount, COVEO_OFFSET_LIMIT));
    for (const r of results) {
      const rawSku = getField(r, 'sku');
      if (!rawSku) continue;
      const skuParts = rawSku.split(/[;,]/).map(s => s.trim()).filter(Boolean);
      const key = skuParts.map(s => s.toUpperCase()).sort().join('|');
      if (!seenSkus.has(key)) {
        seenSkus.add(key);
        allResults.push(r);
      }
    }
  }

  return allResults;
}

/**
 * Paginate through a single Coveo query, collecting all results.
 */
async function paginateQuery(domain, extraFilter, totalCount) {
  const results = [];
  let offset = 0;

  while (offset < totalCount && offset < COVEO_OFFSET_LIMIT) {
    const pageSize = Math.min(PAGE_SIZE, totalCount - offset);
    const resp = await queryCoveo(domain, extraFilter, offset, pageSize);
    const batch = resp.results || [];

    if (batch.length === 0) break;
    results.push(...batch);
    offset += batch.length;

    if (offset < totalCount) {
      await delay(200);
    }
  }

  return results;
}

/**
 * Execute a single Coveo search API call.
 */
async function queryCoveo(domain, extraFilter, firstResult, numberOfResults) {
  const aq = `@sitetargethostname=="${domain}" @sourcedisplayname==product${extraFilter}`;

  const resp = await fetch(`https://${domain}/coveo/rest/search`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({
      q: '',
      aq,
      firstResult,
      numberOfResults,
      fieldsToInclude: COVEO_FIELDS,
    }),
    signal: AbortSignal.timeout(30000),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Coveo API error ${resp.status}: ${text.slice(0, 200)}`);
  }

  return await resp.json();
}

// ─── DB Processing ──────────────────────────────────────────────────────────

/**
 * Load all existing SKUs for a vendor into a Map keyed by UPPER(vendor_sku).
 * Returns Map<string, { sku_id, product_id, vendor_sku }>.
 */
async function loadExistingSkus(pool, vendorId) {
  const result = await pool.query(`
    SELECT s.id AS sku_id, s.product_id, s.vendor_sku
    FROM skus s
    JOIN products p ON p.id = s.product_id
    WHERE p.vendor_id = $1
  `, [vendorId]);

  const map = new Map();
  for (const row of result.rows) {
    if (row.vendor_sku) {
      map.set(row.vendor_sku.toUpperCase(), row);
    }
  }
  return map;
}

/**
 * Fallback: match images by collection+color for products that have no images.
 *
 * Strategy:
 *   1. Build a Coveo index keyed by "series color" (e.g., "advantage washed white matte")
 *   2. Load unimaged products WITH their color attributes from sku_attributes
 *   3. Match each product by "collection + color" against the Coveo index
 *   4. Also try "collection + name" and bare "name" as additional fallback keys
 *
 * This dramatically improves coverage because color attributes are populated by the
 * 832 EDI feed even when the vendor_sku format doesn't match Coveo's exact SKU format.
 */
async function matchImagesByName(pool, vendorId, allResults, job) {
  // Find products without images, along with their color attributes
  const noImg = await pool.query(`
    SELECT p.id, p.name, p.collection, p.display_name,
      array_agg(DISTINCT sa.value) FILTER (WHERE sa.value IS NOT NULL) as colors
    FROM products p
    LEFT JOIN media_assets ma ON ma.product_id = p.id
    LEFT JOIN skus s ON s.product_id = p.id AND s.status = 'active'
    LEFT JOIN sku_attributes sa ON sa.sku_id = s.id
      AND sa.attribute_id = (SELECT id FROM attributes WHERE slug = 'color')
    WHERE p.vendor_id = $1 AND p.status = 'active' AND ma.id IS NULL
    GROUP BY p.id, p.name, p.collection, p.display_name
  `, [vendorId]);

  if (noImg.rows.length === 0) return 0;

  // Normalize whitespace for consistent key matching
  const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();

  // Index Coveo results by series+color composite key.
  // Multiple keys per result: full "series color" and normalized variants.
  const byKey = new Map();    // normalized key → {imageUrl, roomUrl}

  for (const result of allResults) {
    const raw = result.raw || {};
    const series = (raw.seriesname || '').toString().trim();
    const color = (raw.colornameenglish || '').toString().trim();
    const imageUrl = (raw.productimageurl || '').toString().trim();
    const roomUrl = (raw.primaryroomsceneurl || '').toString().trim();
    const validImg = imageUrl && !isPlaceholderUrl(imageUrl) ? imageUrl : '';
    const validRoom = roomUrl && !isPlaceholderUrl(roomUrl) ? roomUrl : '';
    if (!validImg && !validRoom) continue;

    const entry = { imageUrl: validImg, roomUrl: validRoom };

    if (series && color) {
      const key = norm(`${series} ${color}`);
      if (!byKey.has(key)) byKey.set(key, entry);

      // Also index without finish suffix (e.g., "advantage washed white" without "matte")
      const colorBase = color.replace(/\s+(matte|glossy|polished|textured|honed|tumbled|lappato|structured|satin polished|light polished|superguard\s*x?\s*technology|enhanced urethane)$/i, '').trim();
      if (colorBase && colorBase !== color) {
        const altKey = norm(`${series} ${colorBase}`);
        if (!byKey.has(altKey)) byKey.set(altKey, entry);
      }
    }
  }

  // Track assigned image URLs to prevent the same image going to multiple products
  const assignedUrls = new Set();

  let matched = 0;
  for (const prod of noImg.rows) {
    let coveo = null;

    // Strategy 1: collection + color attribute (best match)
    if (!coveo && prod.collection && prod.colors && prod.colors.length > 0) {
      for (const color of prod.colors) {
        coveo = byKey.get(norm(`${prod.collection} ${color}`));
        if (coveo) break;

        // Try without finish suffix on the color
        const colorBase = color.replace(/\s+(matte|glossy|polished|textured|honed|tumbled|lappato|structured|satin|semi-textured)$/i, '').trim();
        if (colorBase !== color) {
          coveo = byKey.get(norm(`${prod.collection} ${colorBase}`));
          if (coveo) break;
        }
      }
    }

    // Strategy 2: display_name (e.g., "Advantage Matte" → match "advantage matte")
    if (!coveo && prod.display_name) {
      coveo = byKey.get(norm(prod.display_name));
    }

    // Strategy 3: collection + EDI name (original approach)
    if (!coveo && prod.collection) {
      coveo = byKey.get(norm(`${prod.collection} ${prod.name}`));
    }

    // Strategy 4: bare name
    if (!coveo) {
      coveo = byKey.get(norm(prod.name));
    }

    if (!coveo) continue;

    // Skip if this exact image URL was already assigned to another product
    if (coveo.imageUrl && assignedUrls.has(coveo.imageUrl)) continue;

    if (coveo.imageUrl) {
      await upsertMediaAsset(pool, {
        product_id: prod.id, sku_id: null,
        asset_type: 'primary', url: coveo.imageUrl,
        original_url: coveo.imageUrl, sort_order: 0,
      });
      assignedUrls.add(coveo.imageUrl);
      matched++;
    }
    if (coveo.roomUrl) {
      await upsertMediaAsset(pool, {
        product_id: prod.id, sku_id: null,
        asset_type: 'lifestyle', url: coveo.roomUrl,
        original_url: coveo.roomUrl, sort_order: 0,
      });
      matched++;
    }
  }

  if (matched > 0) {
    await appendLog(pool, job.id,
      `Name-based image matching: ${noImg.rows.length} products without images, ` +
      `${matched} images added (collection+color, display_name, and name fallbacks)`
    );
  }

  return matched;
}

/**
 * Process a single Coveo result: enrich an existing product/SKU if matched.
 *
 * Coveo SKUs are in format "colorCode + itemCode" (e.g., "AC11PLK848MT"),
 * which matches the vendor_sku format from the 832 EDI / PDF pricing scraper.
 * Some entries have multiple SKUs separated by semicolons.
 * Unmatched SKUs are skipped (enrichment-only — no new products created).
 */
async function processItem(pool, item, vendorId, brand, existingSkus, stats, catMap) {
  const rawSku = getField(item, 'sku');
  if (!rawSku) {
    stats.skipped++;
    return;
  }

  // Split multi-SKU entries (e.g., "FH10P43F9MT; FH10P43H9MT")
  const skuList = rawSku.split(/[;,]/).map(s => s.trim()).filter(Boolean);
  if (skuList.length === 0) {
    stats.skipped++;
    return;
  }

  const seriesName = getField(item, 'seriesname');
  const colorName = getField(item, 'colornameenglish');
  const size = getField(item, 'nominalsize');
  const finish = getField(item, 'finish');
  const shape = getField(item, 'productshape');
  const bodyType = getField(item, 'bodytype');
  const country = getField(item, 'countryofmanufacture');
  const shadeVariation = getField(item, 'shadevariation');
  const productImageUrl = getField(item, 'productimageurl');
  const roomSceneUrl = getField(item, 'primaryroomsceneurl');
  const productType = getField(item, 'producttype');

  // Process each individual SKU in this entry
  for (const coveoSku of skuList) {
    const lookupKey = coveoSku.toUpperCase();
    const existing = existingSkus.get(lookupKey);

    let productId, skuId;

    if (existing) {
      // Existing SKU from PDF pricing — enrich with catalog data
      stats.matched++;
      productId = existing.product_id;
      skuId = existing.sku_id;

      // Enrich product: update collection, category, display_name if we have better data
      const normalizedType = productType ? normalizeProductType(productType) : null;
      const categoryId = resolveCategory(normalizedType, seriesName, bodyType, catMap);

      const updates = [];
      const params = [productId];
      let paramIdx = 2;

      if (seriesName) {
        // Only fill in collection if the product doesn't already have one.
        // The 832 EDI sets more granular collections (e.g., "Color Wheel Classic")
        // while Coveo merges them into broader series (e.g., "Color Wave").
        updates.push(`collection = COALESCE(NULLIF(collection, ''), $${paramIdx})`);
        params.push(seriesName);
        paramIdx++;
      }
      if (categoryId) {
        updates.push(`category_id = COALESCE(category_id, $${paramIdx})`);
        params.push(categoryId);
        paramIdx++;
        stats.categoriesSet = (stats.categoriesSet || 0) + 1;
      }

      // Build display_name from Coveo fields: "Series Shape Finish"
      const displayName = buildDisplayName(seriesName, shape, finish, productType);
      if (displayName) {
        updates.push(`display_name = COALESCE(NULLIF(display_name, ''), $${paramIdx})`);
        params.push(displayName);
        paramIdx++;
        stats.displayNamesSet = (stats.displayNamesSet || 0) + 1;
      }

      if (updates.length > 0) {
        updates.push('updated_at = CURRENT_TIMESTAMP');
        await pool.query(
          `UPDATE products SET ${updates.join(', ')} WHERE id = $1`,
          params
        );
      }

      // Enrich variant_name if it's currently size-only (e.g., "6X6" → "6X6, Matte")
      if (finish || shape) {
        await pool.query(`
          UPDATE skus SET
            variant_name = CASE
              WHEN variant_name ~ '^[0-9X/.]+$'
              THEN $2
              ELSE variant_name
            END,
            updated_at = CURRENT_TIMESTAMP
          WHERE id = $1
        `, [skuId, [size, shape, finish].filter(Boolean).join(', ')]);
      }
    } else {
      // No matching SKU from 832/pricing — skip (enrichment-only mode)
      stats.skipped++;
      continue;
    }

    // Upsert attributes
    const attrPairs = [
      ['color', colorName],
      ['size', size],
      ['finish', finish],
      ['material', bodyType],
      ['shape', shape],
      ['country', country],
      ['shade_variation', shadeVariation],
    ];

    for (const [slug, value] of attrPairs) {
      if (value) {
        await upsertSkuAttribute(pool, skuId, slug, value);
        stats.attributesSet++;
      }
    }

    // Upsert media assets (store Scene7 CDN URLs directly — no download)
    // Skip placeholder images (e.g., "No-Series-Image-Available", "PLACEHOLDER")
    if (productImageUrl && !isPlaceholderUrl(productImageUrl)) {
      await upsertMediaAsset(pool, {
        product_id: productId,
        sku_id: skuId,
        asset_type: 'primary',
        url: productImageUrl,
        original_url: productImageUrl,
        sort_order: 0,
      });
      stats.imagesSet++;
    }

    if (roomSceneUrl && !isPlaceholderUrl(roomSceneUrl)) {
      await upsertMediaAsset(pool, {
        product_id: productId,
        sku_id: skuId,
        asset_type: 'lifestyle',
        url: roomSceneUrl,
        original_url: roomSceneUrl,
        sort_order: 0,
      });
      stats.imagesSet++;
    }
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

// Coveo finish values → display-friendly names (matching existing display_name conventions)
const FINISH_DISPLAY_MAP = {
  'Glossy':                'Gloss',
  'SuperGuard Technology': 'Matte',
  'SuperGuardX Technology':'Matte',
  'Light Polished':        'Lappato',
  'Satin Polished':        'Satin',
  'Enhanced Urethane':     'Matte',
};

/**
 * Build a consumer-friendly display_name from Coveo catalog fields.
 * Format: "Series Shape Finish" — e.g., "Acreage Plank Matte"
 * Trim products get their product type instead of shape.
 */
function buildDisplayName(seriesName, shape, finish, productType) {
  if (!seriesName) return null;

  const parts = [seriesName];

  // For trim products, include the trim type descriptor
  const isTrim = productType && /trim/i.test(productType);
  if (shape && !isTrim) {
    parts.push(shape);
  }

  // Finish is NOT included in display_name — it belongs as a separate attribute.
  // Including it causes redundancy with variant_name/color which also contain finish.

  const name = parts.join(' ').replace(/\s{2,}/g, ' ').trim();
  return name || null;
}

/**
 * Check if an image URL is a placeholder (e.g., "No-Series-Image-Available", "PLACEHOLDER").
 */
function isPlaceholderUrl(url) {
  if (!url) return true;
  const lower = url.toLowerCase();
  return lower.includes('placeholder') || lower.includes('no-series-image') || lower.includes('no.series') || lower.includes('coming-soon');
}

/**
 * Extract a Coveo field value from a result object.
 * Coveo stores custom fields in result.raw with a lowercase key.
 * Array values have leading spaces per element that need trimming.
 */
function getField(result, fieldName) {
  const raw = result.raw || {};
  const val = raw[fieldName] ?? raw[fieldName.toLowerCase()] ?? null;
  if (val == null) return '';
  if (Array.isArray(val)) return val.map(v => String(v).trim()).filter(Boolean).join(', ');
  return String(val).trim();
}

/**
 * Normalize product type strings to consistent snake_case slugs.
 * Coveo returns "Floor Tile", "Wall Tile Trim", etc. — match the pricing scraper format.
 */
function normalizeProductType(type) {
  if (!type) return null;
  const map = {
    'Floor Tile': 'floor_tile',
    'Floor Tile Trim': 'floor_trim',
    'Floor Tile Deco': 'floor_deco',
    'Wall Tile': 'wall_tile',
    'Wall Tile Trim': 'wall_trim',
    'Wall Tile Deco': 'wall_deco',
    'Wall Bathroom Accessories': 'bath_accessory',
    'Bathroom Accessories': 'bath_accessory',
    'Mosaic Tile': 'mosaic',
    'Mosaic Tile Trim': 'mosaic_trim',
    'Mosaic Natural Stone Tile': 'mosaic_stone',
    'Stone Tile': 'stone_tile',
    'Stone Tile Trim': 'stone_trim',
    'Quarry Tile': 'quarry_tile',
    'Quarry Tile Trim': 'quarry_trim',
    'Porcelain Slab': 'porcelain_slab',
    'Quartz Slab': 'quartz_slab',
    'Natural Stone Slab': 'natural_stone_slab',
    'Luxury Vinyl Tile': 'lvt',
    'LVT Trim': 'lvt_trim',
    'LVT Plank': 'lvt_plank',
    'Windowsills-Thresholds': 'windowsills_thresholds',
  };
  return map[type] || type.toLowerCase().replace(/[\s-]+/g, '_');
}

function extractDomain(url) {
  try {
    return new URL(url).hostname;
  } catch {
    try {
      return new URL('https://' + url).hostname;
    } catch {
      return url;
    }
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Category Resolution ──────────────────────────────────────────────────────

async function loadCategoryMap(pool) {
  const result = await pool.query('SELECT id, slug FROM categories');
  const map = {};
  for (const row of result.rows) map[row.slug] = row.id;
  return map;
}

const VARIANT_TYPE_TO_CATEGORY = {
  'floor_tile':      'porcelain-tile',
  'floor_trim':      'porcelain-tile',
  'floor_deco':      'porcelain-tile',
  'wall_tile':       'backsplash-tile',
  'wall_trim':       'backsplash-tile',
  'wall_deco':       'backsplash-tile',
  'bath_accessory':  'backsplash-tile',
  'stone_tile':      'natural-stone',
  'stone_trim':      'natural-stone',
  'mosaic':          'mosaic-tile',
  'mosaic_trim':     'mosaic-tile',
  'mosaic_stone':    'mosaic-tile',
  'lvt':             'lvp-plank',
  'lvt_trim':        'lvp-plank',
  'lvt_plank':       'lvp-plank',
  'quarry_tile':     'ceramic-tile',
  'quarry_trim':     'ceramic-tile',
  'quartz_slab':     'quartz-countertops',
  'porcelain_slab':  'porcelain-slabs',
  'windowsills_thresholds': 'natural-stone',
};

function resolveCategory(variantType, collection, bodyType, catMap) {
  // Special handling for natural_stone_slab
  if (variantType === 'natural_stone_slab') {
    const cLower = (collection || '').toLowerCase();
    if (cLower.includes('granite'))    return catMap['granite-countertops'] || null;
    if (cLower.includes('quartzite'))  return catMap['quartzite-countertops'] || null;
    if (cLower.includes('soapstone'))  return catMap['soapstone-countertops'] || null;
    if (cLower.includes('marble'))     return catMap['marble-countertops'] || null;
    return catMap['natural-stone'] || null;
  }

  // Override to ceramic if body type says so
  if (variantType && (variantType.startsWith('floor_') || variantType.startsWith('wall_'))) {
    if (bodyType === 'Ceramic' || bodyType === 'Wall Body') {
      return catMap['ceramic-tile'] || null;
    }
  }

  const slug = VARIANT_TYPE_TO_CATEGORY[variantType];
  if (slug && catMap[slug]) return catMap[slug];

  // Fallback: try collection name
  if (collection) {
    const cLower = collection.toLowerCase();
    if (cLower.includes('quartz'))  return catMap['quartz-countertops'] || null;
    if (cLower.includes('granite')) return catMap['granite-countertops'] || null;
    if (cLower.includes('marble'))  return catMap['marble-countertops'] || null;
    if (cLower.includes('stone'))   return catMap['natural-stone'] || null;
    if (cLower.includes('mosaic'))  return catMap['mosaic-tile'] || null;
    if (cLower.includes('vinyl') || cLower.includes('lvt')) return catMap['lvp-plank'] || null;
  }

  return catMap['porcelain-tile'] || null;
}
