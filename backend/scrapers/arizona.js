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
const CATEGORY_MAP = {
  'porcelain-and-ceramic': 'porcelain-tile',
  'marble': 'natural-stone',
  'decorative-mosaics-mesh-mounts': 'mosaic-tile',
  'granite-slab': 'granite-countertops',
  'della-terra-quartz': 'quartz-countertops',
  'quartzite': 'quartzite-countertops',
  'marble-slab': 'natural-stone',
  'porcelain-slabs': 'porcelain-slabs',
  'pavers': 'pavers',
  'ceramic-porcelain': 'ceramic-tile',
};

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const ACCESSORY_KEYWORDS = /\b(trim|molding|moulding|reducer|stair\s*nose|transition|threshold|t-molding|quarter\s*round|underlayment|adhesive|grout|sealer|caulk|bullnose|cove\s*base|pencil\s*liner)\b/i;

// Categories sold per piece/sheet (not per sqft in boxes)
const UNIT_CATEGORIES = new Set(['mosaic-tile']);
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
  };

  if (!isInventoryMode) {
    // Ensure all required attributes exist (idempotent)
    const requiredAttrs = [
      { name: 'Edge', slug: 'edge', display_order: 11 },
      { name: 'Look', slug: 'look', display_order: 12 },
      { name: 'Water Absorption', slug: 'water_absorption', display_order: 13 },
      { name: 'DCOF', slug: 'dcof', display_order: 14 },
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
        if (apiProduct.isVariable && detail.variations.length > 0) {
          for (const v of detail.variations) {
            if (v.attributes?.attribute_pa_size === 'sample') continue;

            const internalSku = `AZT-${v.variation_id}`;
            const skuRec = skuLookup.get(internalSku);
            if (!skuRec) continue;
            const skuId = skuRec.id;

            // Update pricing from variation (AZT display_price = dealer cost; 2x markup)
            if (v.display_price) {
              const aztCost = parseFloat(v.display_price);
              await upsertPricing(pool, skuId, {
                cost: aztCost,
                retail_price: Math.round(aztCost * 2 * 100) / 100,
                price_basis: skuRec.sell_by === 'unit' ? 'per_unit' : 'per_sqft',
              });
              stats.pricingUpdated++;
            }

            // Update inventory from variation stock status
            // WooCommerce max_qty can indicate available quantity
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

          // Update pricing from page (AZT page price = dealer cost; 2x markup)
          if (detail.pricing.retailPrice) {
            const aztCost = detail.pricing.retailPrice;
            await upsertPricing(pool, skuId, {
              cost: aztCost,
              retail_price: Math.round(aztCost * 2 * 100) / 100,
              price_basis: skuRec.sell_by === 'unit' ? 'per_unit' : (detail.pricing.priceBasis || 'per_sqft'),
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
        // Resolve PIM category from product_cat IDs
        let categoryId = null;
        let pimCatSlug = null;
        for (const catId of apiProduct.categoryIds) {
          const azCat = azCategoryMap.get(catId);
          if (azCat) {
            const pimSlug = CATEGORY_MAP[azCat.slug];
            if (pimSlug && categoryLookup.has(pimSlug)) {
              categoryId = categoryLookup.get(pimSlug);
              pimCatSlug = pimSlug;
              break;
            }
            if (azCat.parent) {
              const parentCat = azCategoryMap.get(azCat.parent);
              if (parentCat) {
                const parentPimSlug = CATEGORY_MAP[parentCat.slug];
                if (parentPimSlug && categoryLookup.has(parentPimSlug)) {
                  categoryId = categoryLookup.get(parentPimSlug);
                  pimCatSlug = parentPimSlug;
                  break;
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

            // Product-level primary image: collect images from ALL variants in this color group
            // so we pick the best product shot across all sizes (not just first variant)
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
            // Also include shared gallery as last resort — filtered by color
            if (galleryShared.length > 0) {
              const otherColorNames = [...colorGroups.keys()]
                .filter(c => c && c !== colorSlug)
                .map(c => deslugify(c));
              const sharedNew = galleryShared.filter(u => {
                const b = u.split('?')[0];
                return !seenColorBases.has(b) && (seenColorBases.add(b), true);
              });
              const { matched, shared: neutral } = filterImagesByVariant(
                sharedNew, deslugify(colorSlug),
                { otherColors: otherColorNames, productName: collectionName }
              );
              allColorImages.push(...matched, ...neutral);
            }
            const colorCandidates = preferProductShot(filterImageUrls(filterWideBanners(allColorImages)), colorSlug);
            const productPrimaryUrl = colorCandidates[0] || null;
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
              const sku = await upsertSku(pool, {
                product_id: product.id,
                vendor_sku: String(v.variation_id),
                internal_sku: `AZT-${v.variation_id}`,
                variant_name: variantName,
                sell_by: resolveSellBy(pimCatSlug, accessory, detail.soldBy),
                ...(accessory && { variant_type: 'accessory' }),
              });
              if (sku.is_new) stats.skusCreated++;

              // ── Pricing from variation (AZT display_price = dealer cost; 2x markup) ──
              if (v.display_price) {
                const aztCost = parseFloat(v.display_price);
                await upsertPricing(pool, sku.id, {
                  cost: aztCost,
                  retail_price: Math.round(aztCost * 2 * 100) / 100,
                  price_basis: UNIT_CATEGORIES.has(pimCatSlug) ? 'per_unit' : 'per_sqft',
                });
              }

              // ── Inventory from variation ──
              const qtyOnHand = v.max_qty ? parseInt(v.max_qty) : (v.is_in_stock ? 1 : 0);
              await upsertInventorySnapshot(pool, sku.id, 'default', {
                qty_on_hand_sqft: qtyOnHand,
                qty_in_transit_sqft: 0,
              });

              // ── Packaging (skip for mosaics/countertops/slabs — no box packaging) ──
              if (detail.packaging && Object.keys(detail.packaging).length > 0 && !NO_BOX_CATEGORIES.has(pimCatSlug)) {
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
                // Use the finish from variant name when it differs from the WooCommerce attribute
                // (Arizona Tile's API sometimes returns the wrong finish slug for a variation)
                let finishVal = cleanAttrValue(v.attributes.attribute_pa_finishes);
                if (finishPart && finishPart.toLowerCase() !== finishVal.toLowerCase()) {
                  finishVal = finishPart;
                }
                await upsertSkuAttribute(pool, sku.id, 'finish', finishVal);
              }

              // ── Product-level specs as SKU attributes ──
              await upsertAllSpecAttributes(pool, sku.id, detail.specs, detail.technicalSpecs);

              // ── Per-variant images ──
              const varImage = v.image?.url || v.image?.src || null;
              const sortBase = (vi + 1) * 100; // +1 to avoid collision with product-level sort_order=0

              // Look up gallery images by variation_id first, then shared gallery as fallback
              const varGallery = galleryData.byVariationId[v.variation_id] || [];

              // Build variant-only images first (no shared gallery)
              const rawVarImages = [];
              if (varImage) rawVarImages.push(varImage);
              const seenBases = new Set(varImage ? [varImage.split('?')[0]] : []);
              for (const imgUrl of varGallery) {
                const base = imgUrl.split('?')[0];
                if (!seenBases.has(base)) {
                  seenBases.add(base);
                  rawVarImages.push(imgUrl);
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
              // Filter junk + placeholders, then prefer product shots matching this variant's size + finish
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
          const sku = await upsertSku(pool, {
            product_id: product.id,
            vendor_sku: String(apiProduct.wpId),
            internal_sku: `AZT-${apiProduct.wpId}`,
            variant_name: null,
            sell_by: resolveSellBy(pimCatSlug, accessory, detail.soldBy),
            ...(accessory && { variant_type: 'accessory' }),
          });
          if (sku.is_new) stats.skusCreated++;

          // ── Pricing (AZT page price = dealer cost; 2x markup) ──
          if (detail.pricing.retailPrice) {
            const aztCost = detail.pricing.retailPrice;
            await upsertPricing(pool, sku.id, {
              cost: aztCost,
              retail_price: Math.round(aztCost * 2 * 100) / 100,
              price_basis: UNIT_CATEGORIES.has(pimCatSlug) ? 'per_unit' : (detail.pricing.priceBasis || 'per_sqft'),
            });
          }

          // ── Inventory ──
          await upsertInventorySnapshot(pool, sku.id, 'default', {
            qty_on_hand_sqft: apiProduct.isInStock ? 1 : 0,
            qty_in_transit_sqft: 0,
          });

          // ── Packaging (skip for mosaics/countertops/slabs — no box packaging) ──
          if (detail.packaging && Object.keys(detail.packaging).length > 0 && !NO_BOX_CATEGORIES.has(pimCatSlug)) {
            await upsertPackaging(pool, sku.id, {
              sqft_per_box: detail.packaging.sqftPerBox || null,
              pieces_per_box: detail.packaging.piecesPerBox || null,
              weight_per_box_lbs: detail.packaging.weightPerBox || null,
              boxes_per_pallet: detail.packaging.boxesPerPallet || null,
              sqft_per_pallet: detail.packaging.sqftPerPallet || null,
              weight_per_pallet_lbs: detail.packaging.weightPerPallet || null,
            });
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

    // ── Phase 4: Bulk activate ──

    if (touchedProductIds.length > 0) {
      const activateResult = await pool.query(
        `UPDATE products SET status = 'active', updated_at = CURRENT_TIMESTAMP
         WHERE id = ANY($1) AND status = 'draft'`,
        [touchedProductIds]
      );
      await appendLog(pool, job.id, `Activated ${activateResult.rowCount} products (${touchedProductIds.length} total touched)`);
    }

    await appendLog(pool, job.id,
      `Scrape complete. Found: ${stats.found}, Created: ${stats.created}, ` +
      `Updated: ${stats.updated}, SKUs: ${stats.skusCreated}, ` +
      `Images: ${stats.imagesSet}, Skipped: ${stats.skipped}, Errors: ${stats.errors}`,
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
// Parsers
// ══════════════════════════════════════════════════════════════

/**
 * Parse all data from a product detail page.
 * Returns a unified object matching the Elysium v3 pattern.
 */
function parseDetailPage(html) {
  return {
    specs: parseSpecs(html),
    technicalSpecs: parseTechnicalSpecs(html),
    packaging: parsePackaging(html),
    pricing: parsePricing(html),
    gallery: parseGallery(html),
    variations: parseVariations(html),
    soldBy: parseSoldBy(html),
    stockStatus: parseStockStatus(html),
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
    { regex: /<strong>Stocked Finish(?:es)?:?<\/strong>(?:<br\s*\/?>)?\s*([^<]+)/i, key: 'finish' },
    { regex: /<strong>Stocked Sizes?:?<\/strong>(?:<br\s*\/?>)?\s*([^<]+)/i, key: 'size' },
    { regex: /<strong>Stocked Thickness:?<\/strong>(?:<br\s*\/?>)?\s*([^<]+)/i, key: 'thickness' },
    { regex: /<strong>Recommended Uses?:?<\/strong>(?:<br\s*\/?>)?\s*([^<]+)/i, key: 'application' },
    { regex: /<strong>Stocked Colors?:?<\/strong>(?:<br\s*\/?>)?\s*([^<]+)/i, key: 'colors' },
    { regex: /<strong>Edge:?<\/strong>(?:<br\s*\/?>)?\s*([^<]+)/i, key: 'edge' },
    { regex: /<strong>Look:?<\/strong>(?:<br\s*\/?>)?\s*([^<]+)/i, key: 'look' },
    { regex: /<strong>Collection:?<\/strong>(?:<br\s*\/?>)?\s*([^<]+)/i, key: 'collection' },
  ];

  for (const { regex, key } of specPatterns) {
    const match = html.match(regex);
    if (match) specs[key] = htmlDecode(match[1].trim());
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

  // Try WooCommerce price element
  const priceMatch = html.match(/class="woocommerce-Price-amount[^"]*"[^>]*>[^$]*\$([\d,.]+)/);
  if (priceMatch) {
    result.retailPrice = parseFloat(priceMatch[1].replace(/,/g, '')) || null;
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
          return item.zoom || item.medium || item.thumb || item.url || item.src || null;
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
  };
  for (const [techKey, attrSlug] of Object.entries(techMap)) {
    if (technicalSpecs[techKey]) await upsertSkuAttribute(pool, skuId, attrSlug, technicalSpecs[techKey]);
  }
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
