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

  // Build secondary prefix index for fuzzy matching (color-code prefix → SKU rows)
  const prefixIndex = buildPrefixIndex(existingSkus);
  await appendLog(pool, job.id, `Built prefix index with ${prefixIndex.size} unique prefixes`);

  const catMap = await loadCategoryMap(pool);

  // Step 3: Process each Coveo result
  let stats = {
    matched: 0,
    prefixMatched: 0,
    attributesSet: 0,
    imagesSet: 0,
    categoriesSet: 0,
    displayNamesSet: 0,
    skipped: 0,
    errors: 0,
  };

  // Track SKU IDs that already received a primary image (exact match or earlier prefix match).
  // Prefix matching must NOT overwrite these — otherwise a mosaic Coveo entry that
  // doesn't exactly match our DB can clobber a plank SKU's correct image.
  const imagedSkuIds = new Set();

  for (let i = 0; i < allResults.length; i++) {
    const item = allResults[i];
    try {
      await processItem(pool, item, vendorId, brand, existingSkus, stats, catMap, prefixIndex, imagedSkuIds);
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
    `Prefix matches: ${stats.prefixMatched}, ` +
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
    SELECT s.id AS sku_id, s.product_id, s.vendor_sku, s.variant_type, s.variant_name
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
  // Find SKUs without PRIMARY images, along with their product info and color attributes.
  // We assign per-SKU so every variant gets its own image row (no product-level fallbacks).
  const noImg = await pool.query(`
    SELECT p.id, p.name, p.collection, p.display_name,
      s.id AS sku_id, s.vendor_sku, s.variant_type,
      array_agg(DISTINCT sa.value) FILTER (WHERE sa.value IS NOT NULL) as colors
    FROM products p
    JOIN skus s ON s.product_id = p.id AND s.status = 'active'
    LEFT JOIN sku_attributes sa ON sa.sku_id = s.id
      AND sa.attribute_id = (SELECT id FROM attributes WHERE slug = 'color')
    WHERE p.vendor_id = $1 AND p.status = 'active'
      AND s.variant_type IS DISTINCT FROM 'accessory'
      AND NOT EXISTS (
        SELECT 1 FROM media_assets ma
        WHERE ma.sku_id = s.id AND ma.asset_type = 'primary'
      )
    GROUP BY p.id, p.name, p.collection, p.display_name, s.id, s.vendor_sku, s.variant_type
  `, [vendorId]);

  if (noImg.rows.length === 0) return 0;

  // Normalize whitespace for consistent key matching
  const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();

  // Sort results so non-trim products come first. This ensures that color-specific
  // tile images populate byKey before generic trim silhouette images can claim a slot.
  const TRIM_TYPES = new Set([
    'LVT Trim', 'Floor Tile Trim', 'Wall Tile Trim',
    'Mosaic Tile Trim', 'Stone Tile Trim', 'Quarry Tile Trim',
  ]);
  const sortedResults = [...allResults].sort((a, b) => {
    const aType = (a.raw?.producttype || '').toString().trim();
    const bType = (b.raw?.producttype || '').toString().trim();
    const aIsTrim = TRIM_TYPES.has(aType);
    const bIsTrim = TRIM_TYPES.has(bType);
    return (aIsTrim ? 1 : 0) - (bIsTrim ? 1 : 0);
  });

  // Index Coveo results by series+color composite key.
  // Multiple keys per result: full "series color" and normalized variants.
  const byKey = new Map();    // normalized key → {imageUrl, roomUrl}

  for (const result of sortedResults) {
    const raw = result.raw || {};
    const series = (raw.seriesname || '').toString().trim();
    const color = (raw.colornameenglish || '').toString().trim();
    const imageUrl = (raw.productimageurl || '').toString().trim();
    const roomUrl = (raw.primaryroomsceneurl || '').toString().trim();
    // Filter out placeholder and generic trim images
    const validImg = imageUrl && !isPlaceholderUrl(imageUrl) && !isGenericTrimImage(imageUrl)
      ? cleanScene7Url(imageUrl) : '';
    const validRoom = roomUrl && !isPlaceholderUrl(roomUrl)
      ? cleanScene7Url(roomUrl) : '';
    if (!validImg && !validRoom) continue;

    const entry = { imageUrl: validImg, roomUrl: validRoom };

    if (series && color) {
      const key = norm(`${series} ${color}`);
      // Allow overwriting if existing entry has no valid image but new entry does
      if (!byKey.has(key) || (!byKey.get(key).imageUrl && validImg)) {
        byKey.set(key, entry);
      }

      // Also index without finish suffix (e.g., "advantage washed white" without "matte")
      const colorBase = color.replace(/\s+(matte|glossy|polished|textured|honed|tumbled|lappato|structured|satin polished|light polished|superguard\s*x?\s*technology|enhanced urethane)$/i, '').trim();
      if (colorBase && colorBase !== color) {
        const altKey = norm(`${series} ${colorBase}`);
        if (!byKey.has(altKey) || (!byKey.get(altKey).imageUrl && validImg)) {
          byKey.set(altKey, entry);
        }
      }
    }
  }

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

    // Skip mosaic images for non-mosaic SKUs to prevent cross-format assignment
    // (e.g., Eclessia Marble 12x24 field tile shouldn't get an Arches mosaic image)
    if (coveo.imageUrl && (!isMosaicImage(coveo.imageUrl) || isMosaicSku(prod.vendor_sku || ''))) {
      await upsertMediaAsset(pool, {
        product_id: prod.id, sku_id: prod.sku_id,
        asset_type: 'primary', url: coveo.imageUrl,
        original_url: coveo.imageUrl, sort_order: 0,
      });
      matched++;
    }
    if (coveo.roomUrl) {
      await upsertMediaAsset(pool, {
        product_id: prod.id, sku_id: prod.sku_id,
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
async function processItem(pool, item, vendorId, brand, existingSkus, stats, catMap, prefixIndex, imagedSkuIds) {
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
  const rawCoveoSize = getField(item, 'nominalsize');
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

      // Build display_name: "Series Color CategoryType" — e.g., "Acreage Highland Porcelain Tile"
      const displayName = buildDisplayName(seriesName, colorName, shape, finish, productType, normalizedType, bodyType);
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

      // Resolve single size for this specific SKU (Coveo may return all series sizes)
      const resolvedSize = resolveSingleSize(rawCoveoSize, coveoSku, existing?.variant_name || '');

      // Resolve finish: use Coveo value, fall back to vendor_sku suffix parsing
      const resolvedFinish = finish || parseFinishFromSku(coveoSku, productType);

      // Enrich variant_name if it's currently size-only (e.g., "6X6" → "6X6, Matte")
      if (resolvedFinish || shape) {
        await pool.query(`
          UPDATE skus SET
            variant_name = CASE
              WHEN variant_name ~ '^[0-9X/.]+$'
              THEN $2
              ELSE variant_name
            END,
            updated_at = CURRENT_TIMESTAMP
          WHERE id = $1
        `, [skuId, [resolvedSize, shape, resolvedFinish].filter(Boolean).join(', ')]);
      }
    } else {
      // No exact SKU match — try prefix matching for non-trim products (images only)
      const isTrim = productType && /trim/i.test(productType);
      if (!isTrim && productImageUrl && !isPlaceholderUrl(productImageUrl) && !isGenericTrimImage(productImageUrl)) {
        const prefix = extractColorCodePrefix(coveoSku);
        const candidates = prefix ? prefixIndex.get(prefix) : null;
        // Filter to non-accessory SKUs that don't already have a primary image.
        // Without the imagedSkuIds check, a mosaic Coveo entry (e.g., AC11STK124MT)
        // that doesn't exactly match our DB would overwrite a plank SKU's correct
        // image (e.g., AC11PLK848MT) that was assigned via exact match.
        // Also skip non-mosaic SKUs when the image is a mosaic pattern image.
        const imgIsMosaic = isMosaicImage(productImageUrl);
        const targets = candidates?.filter(c =>
          c.variant_type !== 'accessory' &&
          !imagedSkuIds.has(c.sku_id) &&
          (!imgIsMosaic || isMosaicSku(c.vendor_sku))
        );
        if (targets && targets.length > 0) {
          const cleanedUrl = cleanScene7Url(productImageUrl);
          const cleanedRoom = roomSceneUrl && !isPlaceholderUrl(roomSceneUrl)
            ? cleanScene7Url(roomSceneUrl) : null;

          // Assign to non-accessory SKUs sharing this prefix that still need images
          for (const target of targets) {
            await upsertMediaAsset(pool, {
              product_id: target.product_id,
              sku_id: target.sku_id,
              asset_type: 'primary',
              url: cleanedUrl,
              original_url: cleanedUrl,
              sort_order: 0,
            });
            imagedSkuIds.add(target.sku_id);
            stats.imagesSet++;

            if (cleanedRoom) {
              await upsertMediaAsset(pool, {
                product_id: target.product_id,
                sku_id: target.sku_id,
                asset_type: 'lifestyle',
                url: cleanedRoom,
                original_url: cleanedRoom,
                sort_order: 0,
              });
              stats.imagesSet++;
            }
          }
          stats.prefixMatched++;
          continue;
        }
      }
      stats.skipped++;
      continue;
    }

    // Clean color: strip finish names embedded in Coveo's colornameenglish field
    // e.g., "Matte Balance Matte" → "Balance", "Desert Gray Matte" → "Desert Gray"
    const cleanedColor = cleanCoveoColor(colorName, finish);

    // Upsert attributes
    const attrPairs = [
      ['color', cleanedColor],
      ['size', resolvedSize],
      ['finish', resolvedFinish],
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
    // Strip Scene7 preset suffixes (e.g., ?$TRIMTHUMBNAIL$) for full-quality images
    if (productImageUrl && !isPlaceholderUrl(productImageUrl)) {
      const cleanedImg = cleanScene7Url(productImageUrl);
      await upsertMediaAsset(pool, {
        product_id: productId,
        sku_id: skuId,
        asset_type: 'primary',
        url: cleanedImg,
        original_url: cleanedImg,
        sort_order: 0,
      });
      imagedSkuIds.add(skuId);
      stats.imagesSet++;
    }

    if (roomSceneUrl && !isPlaceholderUrl(roomSceneUrl)) {
      const cleanedRoom = cleanScene7Url(roomSceneUrl);
      await upsertMediaAsset(pool, {
        product_id: productId,
        sku_id: skuId,
        asset_type: 'lifestyle',
        url: cleanedRoom,
        original_url: cleanedRoom,
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

// Map normalized product types to display-friendly category suffixes
const DISPLAY_CATEGORY_SUFFIX = {
  'floor_tile':      'Porcelain Tile',
  'floor_trim':      'Molding',
  'floor_deco':      'Porcelain Tile',
  'wall_tile':       'Backsplash Tile',
  'wall_trim':       'Molding',
  'wall_deco':       'Backsplash Tile',
  'bath_accessory':  'Backsplash Tile',
  'stone_tile':      'Natural Stone',
  'stone_trim':      'Molding',
  'mosaic':          'Mosaic Tile',
  'mosaic_trim':     'Molding',
  'mosaic_stone':    'Mosaic Tile',
  'lvt':             'Luxury Vinyl Plank',
  'lvt_trim':        'Molding',
  'lvt_plank':       'Luxury Vinyl Plank',
  'quarry_tile':     'Ceramic Tile',
  'quarry_trim':     'Molding',
  'quartz_slab':     'Quartz Slab',
  'porcelain_slab':  'Porcelain Slab',
  'natural_stone_slab': 'Natural Stone Slab',
  'windowsills_thresholds': 'Natural Stone',
};

/**
 * Build a consumer-friendly display_name from Coveo catalog fields.
 * Format: "Series Color CategoryType" — e.g., "Acreage Highland Porcelain Tile"
 * Trim products: "Series Trim & Accessories Molding"
 */
function buildDisplayName(seriesName, colorName, shape, finish, productType, normalizedType, bodyType) {
  if (!seriesName) return null;

  const parts = [seriesName];

  const isTrim = productType && /trim/i.test(productType);

  if (!isTrim) {
    // Include cleaned color in display_name for non-trim products
    const cleanColor = cleanCoveoColor(colorName, finish);
    if (cleanColor) {
      parts.push(cleanColor);
    }
  }

  // Append category type suffix (e.g., "Porcelain Tile", "Mosaic Tile")
  let suffix = normalizedType ? DISPLAY_CATEGORY_SUFFIX[normalizedType] : null;
  // Override to Ceramic if body type says so
  if (suffix === 'Porcelain Tile' && (bodyType === 'Ceramic' || bodyType === 'Wall Body')) {
    suffix = 'Ceramic Tile';
  }
  if (suffix) {
    parts.push(suffix);
  }

  const name = parts.join(' ').replace(/\s{2,}/g, ' ').trim();
  return name || null;
}

/**
 * Clean a Coveo colornameenglish value by stripping embedded finish names.
 * e.g., "Matte Balance Matte" → "Balance", "Desert Gray Matte" → "Desert Gray",
 *        "Ice White Glossy" → "Ice White"
 */
function cleanCoveoColor(colorName, finish) {
  if (!colorName) return null;
  let v = colorName.trim();

  // Strip trailing SKU codes (e.g., "Matte Black KDIF4GRKMGSD16")
  v = v.replace(/\s+[A-Z0-9]{8,}$/, '').trim();

  // Handle "Matte X Matte" → "X" (finish wrapping color)
  const wrappedMatch = v.match(/^(Matte|Glossy|Polished|Honed|Textured)\s+(.+?)\s+(Matte|Glossy|Polished|Honed|Textured)$/i);
  if (wrappedMatch) {
    return wrappedMatch[2].trim() || null;
  }

  // Strip trailing finish (e.g., "Desert Gray Matte" → "Desert Gray")
  v = v.replace(/\s+(Matte|Glossy|Polished|Honed|Textured|Tumbled|Lappato|Structured|Satin Polished|Light Polished|Superguardx?\s*Technology|Enhanced Urethane)$/i, '').trim();

  // Strip leading finish (e.g., "Matte Arctic White" → "Arctic White")
  v = v.replace(/^(Matte|Glossy|Polished|Honed|Textured)\s+/i, '').trim();

  return v || null;
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

/**
 * Extract the color-code prefix from a SKU.
 * Both 832 EDI format (AD35648CLVT1P) and Coveo format (AD35R64845M12L)
 * share the same leading prefix (AD35 = 1-4 alpha + 1-3 digits).
 */
function extractColorCodePrefix(sku) {
  if (!sku) return null;
  const match = sku.toUpperCase().trim().match(/^([A-Z]{1,4}\d{1,3})/);
  return match ? match[1] : null;
}

/**
 * Strip Scene7 image preset suffix (e.g., ?$TRIMTHUMBNAIL$) to get full-quality URL.
 */
function cleanScene7Url(url) {
  if (!url) return url;
  return url.replace(/\?\$[A-Z_]+\$$/, '');
}

/**
 * Check if an image URL is a mosaic/specialty pattern image.
 * These should only be assigned to mosaic/specialty SKUs, not to plank or field tile SKUs.
 */
function isMosaicImage(url) {
  if (!url) return false;
  const u = url.toUpperCase();
  return u.includes('_MSC_') || u.includes('_MSC.') ||
    u.includes('HERRINGBONE') || u.includes('CHEVRON') ||
    u.includes('BRICKJOINT') || u.includes('BRKJNT') ||
    u.includes('_HEXMSC') || u.includes('_CIRCLEMSC') ||
    u.includes('ARCHES_MSC') || u.includes('FEATHER_MSC') ||
    u.includes('WAVE_MSC') || u.includes('QUILTPATTERN');
}

/**
 * Check if a vendor_sku indicates a mosaic/specialty format.
 * These SKUs can receive mosaic images.
 *
 * Daltile mosaic SKU patterns:
 *   - STK (stacked mosaic), HERR (herringbone)
 *   - MS followed by digit, MSMT, MS1P, MSGL (mosaic gloss/matte)
 *   - BRKJ (brick joint), CHEV (chevron)
 *   - PNYRD (penny round), STJ (stacked joint)
 *   - HEXMS (hex mosaic), WAVE, ARCH
 */
function isMosaicSku(vendorSku) {
  if (!vendorSku) return false;
  const v = vendorSku.toUpperCase();
  return v.includes('STK') || v.includes('HERR') ||
    /MS\d/.test(v) || /MSMT$/.test(v) || /MS1P/.test(v) || /MSGL/.test(v) ||
    v.includes('BRKJ') || v.includes('CHEV') ||
    v.includes('HEXMS') || v.includes('WAVE') ||
    v.includes('ARCH') || v.includes('PNYRD') ||
    v.includes('STJ');
}

/**
 * Detect generic trim product images that are shared across all colors.
 * These are silhouette/profile images of trim pieces, not color-specific product photos.
 */
/**
 * Parse the nominal size from a Daltile vendor_sku.
 *
 * Daltile encodes tile dimensions in the SKU using shape prefixes:
 *   PLK = plank, RCT = rectangle, SQU = square, HEX = hexagon
 * followed by 2-4 digits encoding width × height.
 *   2 digits: W×H  (e.g., RCT28 → 2x8, SQU44 → 4x4)
 *   3 digits: W×HH (e.g., PLK624 → 6x24, RCT412 → 4x12)
 *   4 digits: WW×HH (e.g., RCT1224 → 12x24, SQU2424 → 24x24)
 *
 * Returns null if no parseable size pattern is found.
 */
// Known valid tile sizes for validation of ambiguous suffix patterns
const VALID_TILE_SIZES = new Set([
  '1x1','1x6','2x2','2x8','2x10',
  '3x6','3x12','3x15','3x24',
  '4x4','4x8','4x12','4x16','4x48',
  '6x6','6x12','6x18','6x24','6x36','6x48',
  '8x8','8x24','8x48',
  '10x14','12x10','12x12','12x24',
  '15x30','16x16','16x48',
  '18x18','18x36',
  '20x20','20x39',
  '24x24','24x48',
  '30x60','33x33','36x36',
  '39x59','48x48',
]);

function parseSizeFromVendorSku(vendorSku) {
  if (!vendorSku) return null;
  const upper = vendorSku.toUpperCase();
  // Primary: shape prefix + digits (PLK, RCT, SQU, SQ, HEX, XTP, RT)
  const match = upper.match(/(PLK|RCT|SQU|SQ|HEX|XTP|RT)(\d{2,4})/);
  if (match) return digitsToSize(match[2]);

  // Secondary: digit sequence before known suffixes (MOD, MS, 1P, SP, etc.)
  // Try 4, 3, 2 digit lengths and validate against known tile sizes
  // to avoid grabbing color code digits
  const SUFFIX = /(MOD|MS\d|MS1P|MSMT|MSGL|PANEL|1PK?\b|1P2\b|1L\b|TRD)/;
  for (const len of [4, 3, 2]) {
    const re = new RegExp('(\\d{' + len + '})' + SUFFIX.source);
    const m = upper.match(re);
    if (m) {
      const size = digitsToSize(m[1]);
      if (size && VALID_TILE_SIZES.has(size)) return size;
    }
  }

  return null;
}

function digitsToSize(digits) {
  if (digits.length === 4) {
    return `${parseInt(digits.slice(0, 2))}x${parseInt(digits.slice(2))}`;
  }
  if (digits.length === 3) {
    return `${parseInt(digits[0])}x${parseInt(digits.slice(1))}`;
  }
  if (digits.length === 2) {
    return `${parseInt(digits[0])}x${parseInt(digits[1])}`;
  }
  return null;
}

/**
 * Resolve a single size value for a SKU.
 *
 * Coveo's nominalsize field often returns ALL sizes available in a series
 * (e.g., "12x24, 1x6, 24x48, 3x24, 6x12") rather than the specific SKU's size.
 * This function picks the correct single size using:
 *   1. Size parsed from vendor_sku (most reliable)
 *   2. variant_name if it matches one of the Coveo sizes
 *   3. variant_name if it's purely a size pattern (NxN)
 *   4. Single Coveo size (if not comma-separated)
 */
function resolveSingleSize(coveoSize, vendorSku, variantName) {
  // 1. Parse from vendor_sku — always most reliable
  const skuParsed = parseSizeFromVendorSku(vendorSku);
  if (skuParsed) return skuParsed;

  // 1b. Trim type → size mapping (each trim profile has a standard size)
  if (vendorSku) {
    const v = vendorSku.toUpperCase();
    if (v.includes('SLIMT')) return '2x94';
    if (v.includes('VSLCAP')) return '1 3/8x94';
    if (v.includes('VQRND')) return '3/4x94';
    if (v.includes('EXTSN')) return '1 3/4x94';
    if (v.includes('RNDSTRD')) return '12 1/5x50';
    if (v.includes('VRDSN')) return '1 3/4x94';
  }

  // 2. If Coveo size is a single value (no commas), use it directly
  if (coveoSize && !coveoSize.includes(',')) return coveoSize;

  // 3. If variant_name is purely a size (e.g., "12x24"), use it
  if (variantName) {
    const clean = variantName.trim().replace(/["″'']/g, '').replace(/\s*[xX×]\s*/g, 'x');
    if (/^\d+(\.\d+)?x\d+(\.\d+)?$/.test(clean)) return clean;
  }

  // 3b. Extract size embedded in variant_name (e.g., "Diamond 12x24" → "12x24")
  if (variantName) {
    const embedded = variantName.match(/(\d+(?:\.\d+)?)\s*[xX×]\s*(\d+(?:\.\d+)?)/);
    if (embedded) return `${embedded[1]}x${embedded[2]}`;
  }

  // 4. If Coveo has comma-separated sizes and variant_name matches one, use it
  if (coveoSize && coveoSize.includes(',') && variantName) {
    const sizes = coveoSize.split(',').map(s => s.trim());
    const vClean = variantName.trim().replace(/["″'']/g, '').replace(/\s*[xX×]\s*/g, 'x');
    const match = sizes.find(s => {
      const sClean = s.replace(/["″'']/g, '').replace(/\s*[xX×]\s*/g, 'x');
      return sClean === vClean;
    });
    if (match) return match;
  }

  // 5. Single Coveo size fallback (handles case where no commas but empty checks above)
  return coveoSize || '';
}

/**
 * Parse finish from vendor_sku suffix when Coveo doesn't provide one.
 *
 * Daltile encodes finish in the SKU suffix:
 *   MT = Matte, GL = Glossy, PL = Polished, TX = Textured,
 *   LP = Light Polished, AB = Abrasive, EU = Enhanced Urethane,
 *   SX = SuperGuardX Technology, ST = Satin or SuperGuard Technology (trim)
 */
function parseFinishFromSku(vendorSku, productName) {
  if (!vendorSku) return null;
  const upper = vendorSku.toUpperCase();
  if (/MT([J1-9]\d*)?$/.test(upper)) return 'Matte';
  if (/GL([1-9]\d*)?$/.test(upper)) return 'Glossy';
  if (/PL([1-9]\d*)?$/.test(upper)) return 'Polished';
  if (/TX([1-9]\d*)?$/.test(upper)) return 'Textured';
  if (/LP([1-9]\d*)?$/.test(upper)) return 'Light Polished';
  if (/AB([1-9]\d*)?$/.test(upper)) return 'Abrasive';
  if (/EU$/.test(upper)) return 'Enhanced Urethane';
  if (/VCSL$/.test(upper)) return 'Satin Polished';
  if (/SX$/.test(upper)) return 'SuperGuardX Technology';
  if (/ST([1-9]\d*)?$/.test(upper)) {
    const isTrim = /SLIMT|VSLCAP|VQRND|EXTSN|RNDSTRD|VRDSN|VSCAP|VSTRD/i.test(upper) ||
      (productName && /Trim/i.test(productName));
    return isTrim ? 'SuperGuard Technology' : 'Satin';
  }
  return null;
}

function isGenericTrimImage(url) {
  if (!url) return true;
  const u = url.toUpperCase();
  return u.includes('_PROSERIES') || u.includes('VQRND') || u.includes('VSTRD') ||
    u.includes('VSCAP') || u.includes('RNDSTRD') || u.includes('EXTSN') ||
    u.includes('VSLCAP') || u.includes('RDSN') || u.includes('RDRTR') ||
    u.includes('ENDCAP') || u.includes('TREAD') || u.includes('REDUCER') ||
    u.includes('TMOLD') || u.includes('VNOSE');
}

/**
 * Build a Map from color-code prefix → array of {sku_id, product_id}.
 * Used for fuzzy matching when exact vendor_sku lookup fails.
 */
function buildPrefixIndex(existingSkus) {
  const prefixMap = new Map();
  for (const [, row] of existingSkus) {
    const prefix = extractColorCodePrefix(row.vendor_sku);
    if (!prefix) continue;
    if (!prefixMap.has(prefix)) prefixMap.set(prefix, []);
    prefixMap.get(prefix).push(row);
  }
  return prefixMap;
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
