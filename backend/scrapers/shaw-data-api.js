import {
  upsertProduct, upsertSku, upsertSkuAttribute, upsertPackaging,
  upsertMediaAsset, appendLog, addJobError
} from './base.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_API_URL = 'https://DigitalServiceAPI.shawinc.com/ProductAPI/api/v1/Retailer/GetProducts';
const DEFAULT_GATEWAY_KEY = 'b7663dd38d934015973d93e60b3dfa45';
const DEFAULT_DEALER_KEY = 'd1d87aef-bb26-4b15-877f-7bde6b8cbbbe';

const MAX_PAGES = 20;         // Safety limit for pagination
const MAX_ERRORS = 50;        // Stop after this many per-style errors
const ROOM_SCENE_CAP = 3;     // Max room scenes per SKU
const FETCH_TIMEOUT_MS = 120000; // 2-minute timeout per API call

const CATEGORY_MAP = {
  'Carpet':      'carpet',
  'Broadloom':   'carpet',
  'Resilient':   'luxury-vinyl',
  'Hardwood':    'engineered-hardwood',
  'TileStone':   'tile',
  'Carpet Tile': 'carpet-tile',
  'Laminate':    'laminate',
  'Turf':        'artificial-turf',
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function titleCase(str) {
  if (!str) return '';
  // Strip trailing foot/inch marks that 832 names don't have
  let s = str.trim().replace(/['′']+$/, '').trim();
  s = s.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
  // Restore Roman numerals (II, III, IV, VI, VII, VIII, IX, XI, XII)
  s = s.replace(/\b(Ii|Iii|Iv|Vi|Vii|Viii|Ix|Xi|Xii)\b/g, m => m.toUpperCase());
  return s;
}

/** Normalize name for matching: strip foot/inch marks, apostrophes, collapse whitespace */
function normalizeName(name) {
  if (!name) return '';
  return name.toUpperCase().replace(/['′'"]+/g, '').replace(/\s+/g, ' ').trim();
}

/** Extract Widen content ID from URL (the actual image identifier) */
function widenContentId(url) {
  if (!url) return null;
  const m = url.match(/widen\.net\/content\/([^/]+)\//);
  return m ? m[1] : null;
}

/** Optimize Widen CDN URLs: cap width, lower quality to keep images under ~200KB */
function optimizeImageUrl(url) {
  if (!url || !url.includes('widen.net')) return url;
  // Replace any existing sizing params with reasonable defaults
  let u = url.replace(/[?&]quality=\d+/g, '').replace(/[?&]retina=\w+/g, '');
  u = u.replace(/[?&]h=\d+/g, '').replace(/[?&]w=\d+/g, '');
  // Clean up leading ?& or &&
  u = u.replace(/\?&/, '?').replace(/&&+/g, '&').replace(/\?$/, '');
  const sep = u.includes('?') ? '&' : '?';
  return u + sep + 'w=800&quality=80';
}

function safeNum(val) {
  if (val == null) return null;
  const n = typeof val === 'object' ? val.originalValue ?? val.value ?? null : val;
  if (n == null) return null;
  const parsed = parseFloat(n);
  return isNaN(parsed) ? null : parsed;
}

function imperialDisplay(measurement) {
  if (!measurement) return null;
  const imp = measurement.imperial || measurement;
  return imp?.displayValue || imp?.formattedValue || null;
}

function imperialValue(measurement) {
  if (!measurement) return null;
  const imp = measurement.imperial || measurement;
  return safeNum(imp?.originalValue ?? imp?.value ?? null);
}

// ─── API Fetching ───────────────────────────────────────────────────────────

async function fetchAllProducts(config, pool, jobId) {
  const apiUrl = config.api_url || DEFAULT_API_URL;
  const gatewayKey = config.gateway_key || DEFAULT_GATEWAY_KEY;
  const dealerKey = config.dealer_key || DEFAULT_DEALER_KEY;

  const allStyles = [];
  let pagingId = '';
  let page = 0;

  while (page < MAX_PAGES) {
    page++;
    await appendLog(pool, jobId, `Fetching API page ${page} (pagingId: ${pagingId || 'initial'})...`);

    const resp = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'ocp-apim-subscription-key': gatewayKey,
        'api-Key': dealerKey,
        'Accept-Encoding': 'gzip, deflate, br',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ProductType: 'All', PagingId: pagingId || '' }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (resp.status === 429) {
      // Rate limited — retry with exponential backoff
      for (const waitSec of [30, 60, 120]) {
        await appendLog(pool, jobId, `Rate limited (429). Waiting ${waitSec}s...`);
        await new Promise(r => setTimeout(r, waitSec * 1000));
        const retry = await fetch(apiUrl, {
          method: 'POST',
          headers: {
            'ocp-apim-subscription-key': gatewayKey,
            'api-Key': dealerKey,
            'Accept-Encoding': 'gzip, deflate, br',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ ProductType: 'All', PagingId: pagingId || '' }),
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (retry.ok) {
          const data = await retry.json();
          allStyles.push(...(data.retailerStylesDetail || []));
          pagingId = data.pagingId || null;
          break;
        }
        if (retry.status !== 429) throw new Error(`API error: ${retry.status} ${retry.statusText}`);
      }
      continue;
    }

    if (!resp.ok) throw new Error(`API error: ${resp.status} ${resp.statusText}`);

    const data = await resp.json();
    const styles = data.retailerStylesDetail || [];
    allStyles.push(...styles);

    await appendLog(pool, jobId, `Page ${page}: got ${styles.length} styles (total: ${allStyles.length})`);

    pagingId = data.pagingId || null;
    if (!pagingId) break;
  }

  return allStyles;
}

// ─── Data Loading ───────────────────────────────────────────────────────────

async function loadExistingData(pool, vendorId) {
  // Load all Shaw products
  const productsResult = await pool.query(`
    SELECT id, name, collection, description_long FROM products WHERE vendor_id = $1
  `, [vendorId]);
  const products = productsResult.rows;

  // Load all Shaw SKUs with style_code and UPC attributes
  const skusResult = await pool.query(`
    SELECT s.id AS sku_id, s.product_id, s.vendor_sku, s.internal_sku, s.variant_name,
           sc.value AS style_code, upc.value AS upc
    FROM skus s
    JOIN products p ON p.id = s.product_id
    LEFT JOIN sku_attributes sc ON sc.sku_id = s.id
      AND sc.attribute_id = (SELECT id FROM attributes WHERE slug = 'style_number' LIMIT 1)
    LEFT JOIN sku_attributes upc ON upc.sku_id = s.id
      AND upc.attribute_id = (SELECT id FROM attributes WHERE slug = 'upc' LIMIT 1)
    WHERE p.vendor_id = $1 AND s.status = 'active'
  `, [vendorId]);
  const skus = skusResult.rows;

  // Load category slugs
  const catResult = await pool.query('SELECT id, slug FROM categories WHERE is_active = true');
  const categories = new Map(catResult.rows.map(r => [r.slug, r.id]));

  // Load existing packaging sku_ids for "skip if 832 already set" logic
  const pkgResult = await pool.query(`
    SELECT p.sku_id FROM packaging p
    JOIN skus s ON s.id = p.sku_id
    JOIN products pr ON pr.id = s.product_id
    WHERE pr.vendor_id = $1 AND p.sqft_per_box IS NOT NULL
  `, [vendorId]);
  const existingPackaging = new Set(pkgResult.rows.map(r => r.sku_id));

  // Build lookup maps
  const styleCodeToProduct = new Map();
  const nameToProduct = new Map();
  for (const sku of skus) {
    if (sku.style_code) {
      styleCodeToProduct.set(sku.style_code.toUpperCase(), sku.product_id);
    }
  }
  for (const prod of products) {
    nameToProduct.set(normalizeName(prod.name), prod);
  }

  // Build per-product SKU lookups
  const productSkus = new Map();
  for (const sku of skus) {
    if (!productSkus.has(sku.product_id)) productSkus.set(sku.product_id, []);
    productSkus.get(sku.product_id).push(sku);
  }

  // Load existing Widen content IDs mapped to their collection to prevent cross-collection duplication.
  // Shaw's API sometimes returns the same content ID for images from different styles.
  // Width variants in the same collection (e.g. Scoreboard II 12 vs 26) legitimately share images.
  const cidResult = await pool.query(`
    SELECT DISTINCT substring(ma.url from '/content/([^/]+)/') as cid, p.collection
    FROM media_assets ma
    JOIN products p ON p.id = ma.product_id
    WHERE p.vendor_id = $1 AND ma.sku_id IS NOT NULL AND ma.url LIKE '%widen.net%'
  `, [vendorId]);
  const contentIdCollections = new Map();
  for (const row of cidResult.rows) {
    if (row.cid) contentIdCollections.set(row.cid, row.collection || '');
  }

  return { products, skus, categories, existingPackaging, styleCodeToProduct, nameToProduct, productSkus, contentIdCollections };
}

// ─── Style Processing ───────────────────────────────────────────────────────

async function processStyle(pool, style, vendorId, data, counters, jobId) {
  const styleNumber = (style.sellingStyleNumber || '').trim();
  const styleName = titleCase(style.sellingStyleName || '');
  // Shaw's sellingCompanyGroup values are broad marketing divisions (e.g. "COREtec", "Shaw Floors")
  // not actual product collections. Use empty string to avoid overbroad collection_siblings on storefront.
  const collection = '';
  const productType = style.inventoryType || style.productType || '';
  const categorySlug = CATEGORY_MAP[productType] || null;
  const categoryId = categorySlug ? (data.categories.get(categorySlug) || null) : null;
  const description = (style.marketingDescription || '').trim() || null;

  // ─── Match or create product ─────────────────────────────────────────
  let productId = null;
  let isNewProduct = false;

  // 1. Match by style_code attribute
  if (styleNumber) {
    productId = data.styleCodeToProduct.get(styleNumber.toUpperCase()) || null;
  }

  // 2. Match by product name (normalized to handle foot marks, apostrophes)
  if (!productId && styleName) {
    const existing = data.nameToProduct.get(normalizeName(styleName));
    if (existing) productId = existing.id;
  }

  // 3. Fallback: create new product
  if (!productId) {
    if (!styleName) return; // Skip styles with no name
    const result = await upsertProduct(pool, {
      vendor_id: vendorId,
      name: styleName,
      collection: collection || '',
      category_id: categoryId,
      description_long: description,
    });
    productId = result.id;
    isNewProduct = result.is_new;
    if (isNewProduct) {
      counters.productsCreated++;
      // Register in lookup maps for subsequent styles
      data.nameToProduct.set(normalizeName(styleName), { id: productId, name: styleName, collection, description_long: description });
    }
  }

  // Update description if currently empty
  if (description && !isNewProduct) {
    await pool.query(
      'UPDATE products SET description_long = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 AND (description_long IS NULL OR description_long = \'\')',
      [description, productId]
    );
  }

  // Update category if not set
  if (categoryId && !isNewProduct) {
    await pool.query(
      'UPDATE products SET category_id = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 AND category_id IS NULL',
      [categoryId, productId]
    );
  }

  counters.productsUpdated++;

  // ─── Product-level assets ────────────────────────────────────────────

  // Spec PDF (product-level)
  if (style.pdmsLink) {
    await upsertMediaAsset(pool, {
      product_id: productId, sku_id: null,
      asset_type: 'spec_pdf', url: style.pdmsLink,
      original_url: style.pdmsLink, sort_order: 0,
    });
  }

  // Product-level room scene (first one from style, not color)
  const rawStyleRsUrl = style.roomScene?.highResolutionImagePath || style.roomScene?.imagePath;
  const styleRoomSceneUrl = optimizeImageUrl(rawStyleRsUrl);
  if (styleRoomSceneUrl) {
    await upsertMediaAsset(pool, {
      product_id: productId, sku_id: null,
      asset_type: 'lifestyle', url: styleRoomSceneUrl,
      original_url: rawStyleRsUrl, sort_order: 0,
    });
    counters.imagesAdded++;
  }

  // ─── Process colors (SKUs) ──────────────────────────────────────────
  const colors = style.colors || [];
  const existingSkus = data.productSkus.get(productId) || [];

  // Resolve this product's collection for cross-collection dedup
  const productCollection = (data.nameToProduct.get(normalizeName(styleName)) || {}).collection || '';

  // Track Widen content IDs per product to detect within-color duplicates.
  // Also uses the global contentIdCollections map to catch cross-collection duplicates
  // while still allowing width variants in the same collection to share images.
  const usedContentIds = new Set();

  for (const color of colors) {
    await processColor(pool, color, style, productId, vendorId, existingSkus, data, counters, jobId, usedContentIds, productCollection);
  }
}

async function processColor(pool, color, style, productId, vendorId, existingSkus, data, counters, jobId, usedContentIds, productCollection) {
  const styleNumber = (style.sellingStyleNumber || '').trim();
  const colorNumber = (color.colorNumber || '').trim();
  const colorName = titleCase(color.colorName || '');
  const upcCode = (color.upcCode || '').trim();

  // ─── Match or create SKU ─────────────────────────────────────────────
  let skuId = null;
  let isNewSku = false;

  // 1. UPC match
  if (upcCode) {
    const match = existingSkus.find(s => s.upc === upcCode);
    if (match) skuId = match.sku_id;
  }

  // 2. Color name match
  if (!skuId && colorName) {
    const match = existingSkus.find(s =>
      s.variant_name && s.variant_name.toUpperCase() === colorName.toUpperCase()
    );
    if (match) skuId = match.sku_id;
  }

  // 3. Fallback: create new SKU
  if (!skuId) {
    const internalSku = `SHAW-${styleNumber}-${colorNumber}`.replace(/\s+/g, '');
    const result = await upsertSku(pool, {
      product_id: productId,
      vendor_sku: `${styleNumber} ${colorNumber}`.trim(),
      internal_sku: internalSku,
      variant_name: colorName || colorNumber || null,
      sell_by: 'sqft',
    });
    skuId = result.id;
    isNewSku = result.is_new;
    if (isNewSku) {
      counters.skusCreated++;
      // Add to existing SKU list for matching subsequent colors
      existingSkus.push({
        sku_id: skuId, product_id: productId,
        variant_name: colorName, upc: upcCode, style_code: styleNumber,
      });
    }
  }

  // ─── SKU Attributes ──────────────────────────────────────────────────
  const attrs = extractAttributes(style, color);
  for (const [slug, value] of Object.entries(attrs)) {
    if (value != null && value !== '') {
      await upsertSkuAttribute(pool, skuId, slug, String(value));
    }
  }

  // ─── Packaging (only if 832 didn't already set it) ───────────────────
  if (!data.existingPackaging.has(skuId)) {
    const areaPerBox = imperialValue(style.areaPerCarton);
    const piecesPerBox = safeNum(style.piecesPerCarton);
    const weightPerBox = imperialValue(style.weightPerCarton);
    const boxesPerPallet = safeNum(style.boxesPerPallet);

    if (areaPerBox || piecesPerBox || weightPerBox || boxesPerPallet) {
      await upsertPackaging(pool, skuId, {
        sqft_per_box: areaPerBox,
        pieces_per_box: piecesPerBox,
        weight_per_box_lbs: weightPerBox,
        boxes_per_pallet: boxesPerPallet,
      });
    }
  }

  // ─── Images ──────────────────────────────────────────────────────────
  await processImages(pool, color, productId, skuId, counters, usedContentIds, data.contentIdCollections, productCollection);
}

// ─── Image Processing ───────────────────────────────────────────────────────

async function processImages(pool, color, productId, skuId, counters, usedContentIds, contentIdCollections, productCollection) {
  const images = color.imagesInfo || [];
  let primaryUrl = null;
  let primaryRaw = null;
  let altUrl = null;
  let altRaw = null;

  // Collect candidate URLs from imagesInfo
  for (const img of images) {
    const rawUrl = img.highResolutionUrl || img.url;
    if (!rawUrl) continue;
    const imgType = (img.type || '').toLowerCase();
    if (imgType === 'main' && !primaryRaw) {
      primaryRaw = rawUrl;
      primaryUrl = optimizeImageUrl(rawUrl);
    } else if (imgType === 'tileable' && !altRaw) {
      altRaw = rawUrl;
      altUrl = optimizeImageUrl(rawUrl);
    }
  }

  // Fallback primary from color-level imagePath
  if (!primaryUrl) {
    const rawFallback = color.highResolutionImagePath || color.imagePath;
    if (rawFallback) {
      primaryRaw = rawFallback;
      primaryUrl = optimizeImageUrl(rawFallback);
    }
  }

  // Check if a content ID is a duplicate. Two levels:
  // 1. Within-product: usedContentIds tracks IDs seen for this product's colors
  // 2. Cross-collection: contentIdCollections maps IDs to their existing collection.
  //    Same-collection sharing is allowed (width variants share images).
  function isDuplicate(cid) {
    if (!cid) return false;
    // Within-product duplicate (same color used twice)
    if (usedContentIds.has(cid)) return true;
    // Cross-collection duplicate (image belongs to a different collection)
    if (contentIdCollections && contentIdCollections.has(cid)) {
      const existingCollection = contentIdCollections.get(cid);
      if (existingCollection !== (productCollection || '')) return true;
    }
    return false;
  }

  function markUsed(cid) {
    if (!cid) return;
    usedContentIds.add(cid);
    if (contentIdCollections) contentIdCollections.set(cid, productCollection || '');
  }

  const primaryCid = widenContentId(primaryUrl);
  const altCid = widenContentId(altUrl);

  // NOTE: Shaw's API returns two renderings per color — `main` (hero shot) and
  // `tileable` (seamless swatch for room visualizers). Both reference the same
  // CDN filename but are stylistically different photographs. Showing both causes
  // user confusion ("two different colors") on hover-swap card UI. We save only
  // the `main` (primary) image. The `tileable` is kept as a fallback ONLY when
  // the primary is a cross-collection duplicate.
  let savedPrimary = false;
  if (isDuplicate(primaryCid)) {
    // Primary is a duplicate — fall back to tileable as primary
    if (altUrl && altCid && !isDuplicate(altCid)) {
      await upsertMediaAsset(pool, {
        product_id: productId, sku_id: skuId,
        asset_type: 'primary', url: altUrl, original_url: altRaw, sort_order: 0,
      });
      markUsed(altCid);
      savedPrimary = true;
      counters.imagesAdded++;
    }
    // else: both duplicate — skip saving any primary (no image > wrong image)
  } else {
    // Primary is unique — save it
    if (primaryUrl) {
      await upsertMediaAsset(pool, {
        product_id: productId, sku_id: skuId,
        asset_type: 'primary', url: primaryUrl, original_url: primaryRaw, sort_order: 0,
      });
      markUsed(primaryCid);
      savedPrimary = true;
      counters.imagesAdded++;
    }
  }

  // Room scenes (SKU-level, capped)
  const roomScenes = color.roomScenes || [];
  for (let i = 0; i < Math.min(roomScenes.length, ROOM_SCENE_CAP); i++) {
    const rs = roomScenes[i];
    const rawRsUrl = rs.highResolutionImagePath || rs.highResolutionUrl || rs.imagePath || rs.url;
    if (!rawRsUrl) continue;
    const rsUrl = optimizeImageUrl(rawRsUrl);

    await upsertMediaAsset(pool, {
      product_id: productId, sku_id: skuId,
      asset_type: 'lifestyle', url: rsUrl, original_url: rawRsUrl, sort_order: i,
    });
    counters.imagesAdded++;
  }
}

// ─── Attribute Extraction ───────────────────────────────────────────────────

function extractAttributes(style, color) {
  const attrs = {};

  attrs.style_code = (style.sellingStyleNumber || '').trim() || null;
  attrs.brand = style.sellingCompanyGroup || style.brandName || null;
  attrs.construction = style.constructionDescription || style.construction || null;
  attrs.thickness = imperialDisplay(style.totalThickness || style.overallThickness) || null;
  attrs.width = imperialDisplay(style.productSize?.width) || null;
  attrs.finish = style.surfaceFinishDesc || style.finish || null;

  // Material: prefer species-specific fields (may be arrays)
  const fvs = style.faceVeneerSpecies;
  const spi = style.speciesInfo;
  attrs.material = (Array.isArray(fvs) ? fvs.join(', ') : fvs)
    || style.species
    || (Array.isArray(spi) ? spi.map(s => s.description || s).join(', ') : (typeof spi === 'string' ? spi : null))
    || null;

  attrs.edge = style.edgeProfile || style.edgeType || null;

  // Installation methods — may be array or string
  if (style.installationMethods) {
    attrs.installation = Array.isArray(style.installationMethods)
      ? style.installationMethods.join(', ')
      : String(style.installationMethods);
  }

  // Wear layer (Resilient/LVP)
  attrs.wear_layer = imperialDisplay(style.wearLayerThickness) || null;

  // Per-color attributes
  attrs.color = titleCase(color.colorName) || null;
  attrs.color_code = (color.colorNumber || '').trim() || null;
  attrs.upc = (color.upcCode || '').trim() || null;

  // Dominant color hex
  if (color.dominantColorSpace?.hex) {
    attrs.dominant_color = color.dominantColorSpace.hex;
  }

  return attrs;
}

// ─── Main Entry Point ───────────────────────────────────────────────────────

export async function run(pool, job, source) {
  const config = source.config || {};
  const vendorId = source.vendor_id;
  let errorCount = 0;

  const counters = {
    productsCreated: 0,
    productsUpdated: 0,
    skusCreated: 0,
    imagesAdded: 0,
  };

  async function logError(msg) {
    errorCount++;
    if (errorCount <= MAX_ERRORS) {
      try { await addJobError(pool, job.id, msg); } catch { }
    }
    if (errorCount >= MAX_ERRORS) {
      throw new Error(`Stopped: exceeded ${MAX_ERRORS} errors`);
    }
  }

  try {
    // Resolve vendor
    const vendorResult = await pool.query(
      "SELECT id FROM vendors WHERE id = $1 OR code = 'SHAW' LIMIT 1",
      [vendorId]
    );
    if (!vendorResult.rows.length) {
      throw new Error('Shaw vendor not found in database');
    }
    const resolvedVendorId = vendorResult.rows[0].id;

    await appendLog(pool, job.id, 'Shaw Data API scraper starting...');

    // Fetch all products from Shaw API
    const allStyles = await fetchAllProducts(config, pool, job.id);
    await appendLog(pool, job.id, `Fetched ${allStyles.length} styles from Shaw API`);

    if (allStyles.length === 0) {
      await appendLog(pool, job.id, 'No styles returned from API — check credentials');
      return;
    }

    // Apply config filters
    let stylesToProcess = allStyles;
    if (config.style_filter && Array.isArray(config.style_filter)) {
      const filterSet = new Set(config.style_filter.map(s => s.toUpperCase()));
      stylesToProcess = allStyles.filter(s =>
        filterSet.has((s.sellingStyleNumber || '').toUpperCase())
      );
      await appendLog(pool, job.id, `Filtered to ${stylesToProcess.length} styles (style_filter)`);
    }
    if (config.limit && typeof config.limit === 'number') {
      stylesToProcess = stylesToProcess.slice(0, config.limit);
      await appendLog(pool, job.id, `Limited to ${stylesToProcess.length} styles (limit: ${config.limit})`);
    }

    // Load existing DB data for matching
    await appendLog(pool, job.id, 'Loading existing Shaw data from database...');
    const data = await loadExistingData(pool, resolvedVendorId);
    await appendLog(pool, job.id,
      `Loaded: ${data.products.length} products, ${data.skus.length} SKUs, ${data.categories.size} categories`
    );

    // Count total colors for progress reporting
    const totalColors = stylesToProcess.reduce((sum, s) => sum + (s.colors?.length || 0), 0);
    await appendLog(pool, job.id,
      `Processing ${stylesToProcess.length} styles with ${totalColors} color SKUs`,
      { products_found: stylesToProcess.length }
    );

    // Process each style
    for (let i = 0; i < stylesToProcess.length; i++) {
      const style = stylesToProcess[i];
      const styleName = style.sellingStyleName || style.sellingStyleNumber || '?';

      try {
        if (config.images_only) {
          // Images-only mode: just process images for matched products
          await processStyleImagesOnly(pool, style, resolvedVendorId, data, counters);
        } else {
          await processStyle(pool, style, resolvedVendorId, data, counters, job.id);
        }
      } catch (err) {
        await logError(`Style ${styleName}: ${err.message}`);
      }

      // Progress logging every 50 styles
      if ((i + 1) % 50 === 0 || i === stylesToProcess.length - 1) {
        await appendLog(pool, job.id,
          `Progress: ${i + 1}/${stylesToProcess.length} styles | ` +
          `Products: +${counters.productsCreated} new, ${counters.productsUpdated} updated | ` +
          `SKUs: +${counters.skusCreated} | Images: +${counters.imagesAdded} | Errors: ${errorCount}`,
          {
            products_created: counters.productsCreated,
            products_updated: counters.productsUpdated,
            skus_created: counters.skusCreated,
          }
        );
      }
    }

    await appendLog(pool, job.id,
      `Complete! Styles: ${stylesToProcess.length}, Products: +${counters.productsCreated} new / ${counters.productsUpdated} updated, ` +
      `SKUs: +${counters.skusCreated}, Images: +${counters.imagesAdded}, Errors: ${errorCount}`,
      {
        products_found: stylesToProcess.length,
        products_created: counters.productsCreated,
        products_updated: counters.productsUpdated,
        skus_created: counters.skusCreated,
      }
    );

  } catch (err) {
    await appendLog(pool, job.id, `Fatal error: ${err.message}`);
    throw err;
  }
}

// ─── Images-Only Mode ───────────────────────────────────────────────────────

async function processStyleImagesOnly(pool, style, vendorId, data, counters) {
  const styleNumber = (style.sellingStyleNumber || '').trim();
  const styleName = titleCase(style.sellingStyleName || '');

  // Find product
  let productId = null;
  if (styleNumber) {
    productId = data.styleCodeToProduct.get(styleNumber.toUpperCase()) || null;
  }
  if (!productId && styleName) {
    const existing = data.nameToProduct.get(normalizeName(styleName));
    if (existing) productId = existing.id;
  }
  if (!productId) return; // No match — skip in images-only mode

  // Product-level assets
  if (style.pdmsLink) {
    await upsertMediaAsset(pool, {
      product_id: productId, sku_id: null,
      asset_type: 'spec_pdf', url: style.pdmsLink,
      original_url: style.pdmsLink, sort_order: 0,
    });
  }
  const rawRsUrl2 = style.roomScene?.highResolutionImagePath || style.roomScene?.imagePath;
  const rsUrl = optimizeImageUrl(rawRsUrl2);
  if (rsUrl) {
    await upsertMediaAsset(pool, {
      product_id: productId, sku_id: null,
      asset_type: 'lifestyle', url: rsUrl,
      original_url: rawRsUrl2, sort_order: 0,
    });
    counters.imagesAdded++;
  }

  // Process color images for matched SKUs only
  const existingSkus = data.productSkus.get(productId) || [];
  const productCollection = (data.nameToProduct.get(normalizeName(styleName)) || {}).collection || '';
  const usedContentIds = new Set();
  for (const color of (style.colors || [])) {
    const colorName = titleCase(color.colorName || '');
    const upcCode = (color.upcCode || '').trim();

    let skuId = null;
    if (upcCode) {
      const match = existingSkus.find(s => s.upc === upcCode);
      if (match) skuId = match.sku_id;
    }
    if (!skuId && colorName) {
      const match = existingSkus.find(s =>
        s.variant_name && s.variant_name.toUpperCase() === colorName.toUpperCase()
      );
      if (match) skuId = match.sku_id;
    }
    if (!skuId) continue; // No match — skip

    await processImages(pool, color, productId, skuId, counters, usedContentIds, data.contentIdCollections, productCollection);
  }
}
