import {
  delay, upsertProduct, upsertSku,
  upsertSkuAttribute, upsertPackaging, upsertPricing,
  upsertMediaAsset, upsertInventorySnapshot,
  appendLog, addJobError, preferProductShot, isLifestyleUrl,
  normalizeSize, buildVariantName
} from './base.js';
import { bosphorusLogin, bosphorusLoginFromCookies, bosphorusFetch } from './bosphorus-auth.js';

/**
 * Bosphorus Imports catalog scraper.
 *
 * Server-rendered HTML — uses fetch(), no Puppeteer needed.
 * Paginates /products?page=1..N, extracts product-detail links,
 * then fetches each detail page for JSON-LD schema, variant_groups JS,
 * color/size/finish selects, specs table, images, and description.
 *
 * If BOSPHORUS_COOKIES or BOSPHORUS_USERNAME+BOSPHORUS_PASSWORD env vars
 * are set, fetches with auth cookies to capture dealer pricing from
 * variant_groups (Price, PriceData.net_price, PriceData.price).
 *
 * Product → SKU mapping:
 *   Collection (series) → Product (per size+finish) → SKU (per color)
 */

const BASE_URL = 'https://www.bosphorusimports.com';
const VENDOR_CODE = 'BOS';
const MAX_PAGES = 10; // safety limit
const DEFAULT_DELAY_MS = 800;

// Bosphorus website category labels → PIM category slugs.
// All Bosphorus products are porcelain; "marble", "limestone", etc. are looks, not materials.
const CATEGORY_MAP = {
  'wood look':      'porcelain-tile',
  'marble look':    'porcelain-tile',
  'concrete look':  'porcelain-tile',
  'stone look':     'porcelain-tile',
  'metal look':     'porcelain-tile',
  'encaustic look': 'porcelain-tile',
  'solid look':     'porcelain-tile',
  'subway look':    'backsplash-tile',
  'picket look':    'backsplash-tile',
  'hexagon look':   'porcelain-tile',
  'paver':          'pavers',
  'fluted':         'fluted-tile',
};

// Collections explicitly known to be mosaics (small-format pattern tiles)
const MOSAIC_COLLECTIONS = new Set(['frammenti', 'boutique', 'marvel']);

export async function run(pool, job, source) {
  const config = { delayMs: DEFAULT_DELAY_MS, ...(source.config || {}) };
  const vendor_id = source.vendor_id;

  const stats = {
    found: 0, created: 0, updated: 0,
    skusCreated: 0, imagesSet: 0, attributesSet: 0,
    packagingSet: 0, pricingSet: 0, skipped: 0, errors: 0,
  };

  // ── Attempt authenticated session for pricing ──
  let cookies = null;
  try {
    if (process.env.BOSPHORUS_COOKIES) {
      cookies = await bosphorusLoginFromCookies(pool, job.id);
    } else if (process.env.BOSPHORUS_USERNAME && process.env.BOSPHORUS_PASSWORD) {
      cookies = await bosphorusLogin(pool, job.id);
    }
    if (cookies) {
      await appendLog(pool, job.id, 'Authenticated session active — pricing will be captured');
    }
  } catch (err) {
    await appendLog(pool, job.id, `Auth skipped (${err.message}) — pricing will not be available`);
  }

  // Build slug → category_id lookup
  const categoryLookup = new Map();
  try {
    const catRows = await pool.query('SELECT id, slug FROM categories WHERE is_active = true');
    for (const row of catRows.rows) categoryLookup.set(row.slug, row.id);
  } catch {}

  const touchedProductIds = [];

  // ── Phase 1: Collect product detail URLs from listing pages ──

  // Single-product debug mode: set BOSPHORUS_SINGLE_PRODUCT=slug to scrape one product
  const singleProduct = process.env.BOSPHORUS_SINGLE_PRODUCT;

  await appendLog(pool, job.id, 'Phase 1: Collecting product URLs from listing pages...');

  const productUrls = [];
  const seenSlugs = new Set();

  if (singleProduct) {
    productUrls.push(`${BASE_URL}/product-detail/${singleProduct}`);
    await appendLog(pool, job.id, `Single-product mode: ${singleProduct}`);
  } else {
    for (let page = 1; page <= MAX_PAGES; page++) {
      try {
        const listUrl = `${BASE_URL}/products?page=${page}`;
        const resp = await fetchWithRetry(listUrl, cookies);
        const html = await resp.text();

        const links = extractProductLinks(html);
        if (links.length === 0) break;

        for (const link of links) {
          const slug = link.replace(/.*\/product-detail\//, '');
          if (seenSlugs.has(slug)) continue;
          seenSlugs.add(slug);
          productUrls.push(link.startsWith('http') ? link : `${BASE_URL}${link}`);
        }

        await appendLog(pool, job.id, `Page ${page}: found ${links.length} links (${productUrls.length} total unique)`);

        // Check if there's a next page
        const nextPagePattern = new RegExp(`page=${page + 1}`);
        if (!nextPagePattern.test(html)) break;

        await delay(config.delayMs);
      } catch (err) {
        await appendLog(pool, job.id, `ERROR fetching listing page ${page}: ${err.message}`);
        await addJobError(pool, job.id, `Listing page ${page}: ${err.message}`);
        stats.errors++;
        break;
      }
    }
  }

  stats.found = productUrls.length;
  await appendLog(pool, job.id, `Phase 1 complete: ${productUrls.length} product pages to scrape`, {
    products_found: stats.found,
  });

  // ── Phase 2: Fetch and parse each product detail page ──

  await appendLog(pool, job.id, 'Phase 2: Fetching product detail pages...');

  for (let i = 0; i < productUrls.length; i++) {
    const url = productUrls[i];

    try {
      const resp = await fetchWithRetry(url, cookies);
      const html = await resp.text();

      const productData = parseDetailPage(html, url);
      if (!productData || !productData.name) {
        stats.skipped++;
        continue;
      }

      // Clean collection name: strip trailing slashes, replace underscores, normalize whitespace
      productData.name = productData.name
        .replace(/\s*\/\s*$/, '')
        .replace(/_/g, ' ')
        .trim();

      // Resolve PIM category
      const { id: categoryId, slug: catSlug } = resolveCategory(productData, categoryLookup);

      // Handle no-variant case: populate from seriesColors if available
      if (productData.variants.length === 0) {
        const colors = productData.specs.seriesColors
          ? productData.specs.seriesColors.split(',').map(c => c.trim()).filter(Boolean)
          : [];
        if (colors.length === 0) {
          stats.skipped++;
          continue;
        }
        for (const color of colors) {
          productData.variants.push({
            color, colorId: null, sizeId: null, finishId: null,
            size: null, sizeLabel: '', finish: null,
            vendorSku: productData.defaultSku,
            stockStatus: productData.availability?.includes('InStock') ? 2 : 0,
            totalStock: '0', price: 0, listPrice: 0, netPrice: 0,
            areaNetPrice: 0, areaListPrice: 0, productId: null,
          });
        }
      }

      // Inherit finish for variants that failed to extract one.
      // If the page has a single finish option, or all non-null finishes agree,
      // apply that finish to variants missing it for naming consistency.
      const hasNullFinish = productData.variants.some(v => !v.finish);
      if (hasNullFinish) {
        let defaultFinish = null;
        if (productData.finishes.length === 1) {
          defaultFinish = productData.finishes[0].text;
        } else {
          const finishCounts = new Map();
          for (const v of productData.variants) {
            if (v.finish) finishCounts.set(v.finish, (finishCounts.get(v.finish) || 0) + 1);
          }
          if (finishCounts.size === 1) {
            defaultFinish = finishCounts.keys().next().value;
          }
        }
        if (defaultFinish) {
          for (const v of productData.variants) {
            if (!v.finish) v.finish = defaultFinish;
          }
        }
      }

      // Group by color (sets _rawColor, used for image lookup)
      const colorGroups = groupVariantsByColor(productData);

      // Group by size+finish (for product creation — one product per size+finish)
      const sizeFinishGroups = groupVariantsBySizeFinish(productData);

      if (sizeFinishGroups.size === 0) {
        stats.skipped++;
        continue;
      }

      for (const [groupKey, group] of sizeFinishGroups) {
        const { sizeNorm, finish, isAccessory, accessoryType, colorVariants } = group;

        try {
          // Build product name: "12x24, Matte" or "3x24, Matte (Bullnose)"
          let productName = buildVariantName(sizeNorm, finish);
          if (accessoryType) productName += ` (${accessoryType})`;
          if (!productName) productName = productData.name;

          // Determine sell_by from size (same for all colors in this group)
          const firstVariant = [...colorVariants.values()][0];
          const sellBy = isAccessory ? 'unit'
            : catSlug === 'mosaic-tile' ? 'unit'
            : determineSellBy(firstVariant.size, firstVariant.sizeLabel);

          // UPSERT PRODUCT (one per size+finish combo)
          const product = await upsertProduct(pool, {
            vendor_id,
            name: productName,
            collection: productData.name,
            category_id: categoryId,
            description_short: cleanDescription(productData.description)?.slice(0, 255) || null,
            description_long: cleanDescription(productData.description) || null,
          });

          if (product.is_new) stats.created++;
          else stats.updated++;
          touchedProductIds.push(product.id);

          // ── Product-level images ──
          // Only color-NEUTRAL images go to product level (safe for any SKU gallery).
          // Use getColorSliderImages itself to determine which images are claimed by
          // specific colors — any image claimed by SOME but not ALL colors is color-specific.
          const colors = [...colorVariants.entries()];
          const ownImages = filterOwnCollectionImages(productData.images, productData.name);

          // Collect images claimed by each color via the same logic used for SKU-level assignment
          const colorCount = colorGroups.size;
          const siblingColorNamesForNeutral = [...colorGroups.keys()];
          const claimedBases = new Map(); // base → count of colors that claim it
          for (const [cn, variants] of colorGroups) {
            const rawColor = variants[0]?._rawColor || cn;
            const claimed = getColorSliderImages(
              productData.imagesByVariantId, variants, productData.images, rawColor, siblingColorNamesForNeutral
            );
            const seenInColor = new Set();
            for (const img of claimed) {
              const base = img.split('?')[0];
              if (!seenInColor.has(base)) {
                seenInColor.add(base);
                claimedBases.set(base, (claimedBases.get(base) || 0) + 1);
              }
            }
          }

          // An image is neutral if: NOT claimed by any color, OR claimed by ALL colors.
          // For single-color products, only truly unclaimed images go to product level —
          // "claimed by all colors" is meaningless when there's only 1 color, and would
          // wrongly promote all matched images to product level leaving the SKU with just a swatch.
          const neutralImages = ownImages.filter(url => {
            const base = url.split('?')[0];
            const count = claimedBases.get(base) || 0;
            if (colorCount <= 1) return count === 0;
            return count === 0 || count === colorCount;
          });

          const relevantNeutral = pickSkuImages(neutralImages, sizeNorm, finish);
          const firstSwatchEntry = firstVariant.colorId
            ? productData.swatchImagesByColorId.get(firstVariant.colorId) : null;
          const { productShots: sliderProductShots, lifestyle: sliderLifestyle } =
            classifySliderImages(relevantNeutral, null);

          // Clear stale product-level images before re-inserting current set.
          await pool.query(
            'DELETE FROM media_assets WHERE product_id = $1 AND sku_id IS NULL',
            [product.id]
          );

          let productSortOrder = 0;
          const productPrimaryUrl = sliderProductShots[0];

          if (productPrimaryUrl) {
            await upsertMediaAsset(pool, {
              product_id: product.id, sku_id: null,
              asset_type: 'primary', url: productPrimaryUrl, original_url: productPrimaryUrl,
              sort_order: productSortOrder++,
            });
            stats.imagesSet++;
          }
          for (let si = 1; si < sliderProductShots.length; si++) {
            await upsertMediaAsset(pool, {
              product_id: product.id, sku_id: null,
              asset_type: 'alternate', url: sliderProductShots[si],
              original_url: sliderProductShots[si], sort_order: productSortOrder++,
            });
            stats.imagesSet++;
          }
          for (let li = 0; li < sliderLifestyle.length; li++) {
            await upsertMediaAsset(pool, {
              product_id: product.id, sku_id: null,
              asset_type: 'lifestyle', url: sliderLifestyle[li],
              original_url: sliderLifestyle[li], sort_order: li,
            });
            stats.imagesSet++;
          }
          // No fallback — if all images are color-specific, product level stays empty.
          // Each SKU has its own swatch + variant-matched images; supplementation with
          // a wrong-color swatch is worse than no product-level image.

          // ── For each COLOR in this size+finish group, create a SKU ──
          for (let ci = 0; ci < colors.length; ci++) {
            const [colorName, v] = colors[ci];

            const internalSku = buildInternalSku(productData.name, sizeNorm, finish, colorName);
            const vendorSku = v.vendorSku || internalSku;

            const sku = await upsertSku(pool, {
              product_id: product.id,
              vendor_sku: vendorSku,
              internal_sku: internalSku,
              variant_name: colorName,
              sell_by: sellBy,
              variant_type: isAccessory ? 'accessory' : null,
            });
            if (sku.is_new) stats.skusCreated++;

            // Inventory from stock status
            if (v.stockStatus !== undefined) {
              const qty = v.totalStock ? parseFloat(v.totalStock) : 0;
              await upsertInventorySnapshot(pool, sku.id, 'Bosphorus-Anaheim', {
                qty_on_hand_sqft: qty,
                qty_in_transit_sqft: 0,
              });
            }

            // SKU attributes
            const attrs = [
              ['size', sizeNorm],
              ['color', colorName],
              ['finish', finish],
              ['material', productData.specs.material],
              ['thickness', productData.specs.thickness],
              ['country', productData.specs.origin],
              ['shape', productData.specs.shape],
            ];
            for (const [slug, val] of attrs) {
              if (val) {
                await upsertSkuAttribute(pool, sku.id, slug, val);
                stats.attributesSet++;
              }
            }

            // Packaging — try per-size match first, then fall back to default/single packaging
            const pkg = productData.packagingBySize.get(sizeNorm)
              || productData.packagingBySize.get('_default')
              || (productData.packagingBySize.size === 1
                  ? productData.packagingBySize.values().next().value : null);
            if (pkg && (pkg.sqftPerBox || pkg.piecesPerBox)) {
              await upsertPackaging(pool, sku.id, {
                sqft_per_box: pkg.sqftPerBox || null,
                pieces_per_box: pkg.piecesPerBox || null,
                weight_per_box_lbs: pkg.boxWeight || null,
                boxes_per_pallet: pkg.palletCount || null,
                sqft_per_pallet: pkg.sqftPerPallet || null,
                weight_per_pallet_lbs: pkg.palletWeight || null,
              });
              stats.packagingSet++;
            }

            // Pricing (requires authenticated session — v.price > 0 only when logged in)
            if (v.price > 0) {
              let cost = v.netPrice || v.price;
              let retailPrice = v.listPrice || null;
              const priceBasis = sellBy === 'box' ? 'per_sqft' : 'per_unit';

              if (sellBy === 'box') {
                if (v.areaNetPrice > 0) {
                  cost = v.areaNetPrice;
                  retailPrice = v.areaListPrice || null;
                } else {
                  const sqftPerBox = (pkg && pkg.sqftPerBox) || v.sqft;
                  if (sqftPerBox && sqftPerBox > 0) {
                    cost = +(cost / sqftPerBox).toFixed(4);
                    if (retailPrice) retailPrice = +(retailPrice / sqftPerBox).toFixed(4);
                  }
                }
              }

              await upsertPricing(pool, sku.id, {
                cost,
                retail_price: retailPrice,
                price_basis: priceBasis,
              });
              stats.pricingSet++;
            }

            // ── SKU-level images ──
            // Pass ALL variants of this color (across all sizes/finishes) so that
            // variant-ID matching works even when THIS size's productId isn't in the
            // carousel.  colorGroups has the full list keyed by color name.
            const rawColorForImages = v._rawColor || colorName;
            const allColorVariants = colorGroups.get(colorName) || [v];
            const siblingColorNames = [...colorGroups.keys()];
            const colorSliderImages = getColorSliderImages(
              productData.imagesByVariantId, allColorVariants, productData.images, rawColorForImages, siblingColorNames
            );
            // Filter out cross-collection contamination
            const filteredColorImages = filterOwnCollectionImages(colorSliderImages, productData.name);
            const swatchEntry = v.colorId
              ? productData.swatchImagesByColorId.get(v.colorId) : null;
            const swatchUrl = swatchEntry
              ? (swatchEntry.full || swatchEntry.thumb) : null;

            const { productShots: colorShots, lifestyle: colorLifestyle } =
              classifySliderImages(filteredColorImages, swatchEntry);

            // Clear stale SKU-level images before re-inserting current set.
            // Without this, images from previous scrapes persist at higher sort_orders
            // even when the current scrape no longer matches them to this SKU.
            await pool.query(
              'DELETE FROM media_assets WHERE product_id = $1 AND sku_id = $2',
              [product.id, sku.id]
            );

            let skuSortOrder = 0;

            // Primary: swatch image for this color
            if (swatchUrl) {
              await upsertMediaAsset(pool, {
                product_id: product.id, sku_id: sku.id,
                asset_type: 'primary', url: swatchUrl, original_url: swatchUrl,
                sort_order: skuSortOrder++,
              });
              stats.imagesSet++;
            }
            // Alternates: ONLY matched color-specific slider product shots
            for (const img of colorShots) {
              await upsertMediaAsset(pool, {
                product_id: product.id, sku_id: sku.id,
                asset_type: swatchUrl ? 'alternate' : (skuSortOrder === 0 ? 'primary' : 'alternate'),
                url: img, original_url: img,
                sort_order: skuSortOrder++,
              });
              stats.imagesSet++;
            }
            // Lifestyle: color-specific lifestyle images
            for (const img of colorLifestyle) {
              await upsertMediaAsset(pool, {
                product_id: product.id, sku_id: sku.id,
                asset_type: 'lifestyle', url: img, original_url: img,
                sort_order: skuSortOrder++,
              });
              stats.imagesSet++;
            }
            // NO fallback — if no match, swatch alone is sufficient.
            // Product-level images serve as the gallery via server.js supplementation.
          }
        } catch (err) {
          stats.errors++;
          if (stats.errors <= 30) {
            await addJobError(pool, job.id, `${productData.name} / ${groupKey}: ${err.message}`);
          }
        }
      }
    } catch (err) {
      stats.errors++;
      if (stats.errors <= 30) {
        await addJobError(pool, job.id, `${url}: ${err.message}`);
      }
    }

    if ((i + 1) % 10 === 0 || i === productUrls.length - 1) {
      await appendLog(pool, job.id,
        `Progress: ${i + 1}/${productUrls.length} pages, Products: ${stats.created} new / ${stats.updated} updated, SKUs: ${stats.skusCreated}`,
        {
          products_found: stats.found,
          products_created: stats.created,
          products_updated: stats.updated,
          skus_created: stats.skusCreated,
        }
      );
    }

    await delay(config.delayMs);
  }

  // ── Phase 3: Bulk activate ──

  if (touchedProductIds.length > 0) {
    const uniqueIds = [...new Set(touchedProductIds)];
    const activateResult = await pool.query(
      `UPDATE products SET status = 'active', updated_at = CURRENT_TIMESTAMP
       WHERE id = ANY($1) AND status = 'draft'`,
      [uniqueIds]
    );
    await appendLog(pool, job.id, `Activated ${activateResult.rowCount} products`);

    // Activate SKUs for touched products
    const skuActivate = await pool.query(
      `UPDATE skus SET status = 'active', updated_at = CURRENT_TIMESTAMP
       WHERE product_id = ANY($1) AND status = 'draft'`,
      [uniqueIds]
    );
    if (skuActivate.rowCount > 0) {
      await appendLog(pool, job.id, `Activated ${skuActivate.rowCount} SKUs`);
    }
  }

  // ── Phase 3b: Name cleanup ──

  // Strip trailing slashes from names and collections
  const slashClean = await pool.query(
    `UPDATE products SET
      name = TRIM(REGEXP_REPLACE(name, '\\s*/\\s*$', '')),
      collection = TRIM(REGEXP_REPLACE(collection, '\\s*/\\s*$', '')),
      updated_at = CURRENT_TIMESTAMP
    WHERE vendor_id = $1 AND (name LIKE '%/' OR collection LIKE '%/')`,
    [vendor_id]
  );
  if (slashClean.rowCount > 0) {
    await appendLog(pool, job.id, `Cleaned trailing slashes from ${slashClean.rowCount} product names`);
  }

  // Replace underscores with spaces in collection names (e.g., Re_Style → Re Style)
  const underscoreClean = await pool.query(
    `UPDATE products SET
      collection = REPLACE(collection, '_', ' '),
      updated_at = CURRENT_TIMESTAMP
    WHERE vendor_id = $1 AND collection LIKE '%\\_%'`,
    [vendor_id]
  );
  if (underscoreClean.rowCount > 0) {
    await appendLog(pool, job.id, `Cleaned underscores from ${underscoreClean.rowCount} collection names`);
  }

  // Set display_name: "Collection Size+Finish" (e.g., "Arenite 12x24, Matte")
  const dnResult = await pool.query(
    `UPDATE products SET
      display_name = CASE
        WHEN name = collection THEN collection
        ELSE collection || ' ' || name
      END,
      updated_at = CURRENT_TIMESTAMP
    WHERE vendor_id = $1
    AND collection IS NOT NULL AND collection != ''`,
    [vendor_id]
  );
  if (dnResult.rowCount > 0) {
    await appendLog(pool, job.id, `Set display_name on ${dnResult.rowCount} products`);
  }

  // ── Phase 4: Attach accessories ──
  // Link tile SKUs (sold by box) to accessory SKUs (variant_type = 'accessory')
  // within the same collection, matching by Color and base Finish.
  // In the new model, accessories are separate products (same collection, different size).
  const accResult = await pool.query(`
    INSERT INTO sku_accessories (parent_sku_id, accessory_sku_id, sort_order)
    SELECT DISTINCT tile.id, acc.id,
      CASE
        WHEN acc_size.value LIKE '3x%' THEN 1   -- Bullnose / Surface Bullnose
        WHEN acc_size.value LIKE '2x%' AND acc_size.value NOT IN ('2x2') THEN 2  -- Pencil Liner / Cap
        WHEN acc_size.value LIKE '1x%' AND acc_size.value NOT IN ('1x4') THEN 3  -- Quarter Round
        WHEN acc_size.value LIKE '1/%' OR acc_size.value LIKE '0.%' THEN 4  -- Jolly Liner (1/2x)
        WHEN acc_size.value IN ('2x2', '1x4') THEN 6  -- Mosaic Insert
        ELSE 5
      END
    FROM skus tile
    JOIN products p ON p.id = tile.product_id
    JOIN products p_acc ON p_acc.collection = p.collection AND p_acc.vendor_id = p.vendor_id
    JOIN skus acc ON acc.product_id = p_acc.id
      AND acc.variant_type = 'accessory'
      AND acc.status = 'active'
    -- Match by color attribute
    JOIN sku_attributes tile_color ON tile_color.sku_id = tile.id
    JOIN attributes a_color ON a_color.id = tile_color.attribute_id AND a_color.slug = 'color'
    JOIN sku_attributes acc_color ON acc_color.sku_id = acc.id
      AND acc_color.attribute_id = a_color.id
      AND acc_color.value = tile_color.value
    -- Match by base finish (e.g. "Subway Glossy" matches "Jolly Liner Glossy")
    JOIN sku_attributes tile_finish ON tile_finish.sku_id = tile.id
    JOIN attributes a_finish ON a_finish.id = tile_finish.attribute_id AND a_finish.slug = 'finish'
    JOIN sku_attributes acc_finish ON acc_finish.sku_id = acc.id
      AND acc_finish.attribute_id = a_finish.id
    -- Get accessory size for sort_order
    LEFT JOIN attributes a_size ON a_size.slug = 'size'
    LEFT JOIN sku_attributes acc_size ON acc_size.sku_id = acc.id
      AND acc_size.attribute_id = a_size.id
    WHERE p.vendor_id = $1
      AND tile.variant_type IS NULL
      AND tile.sell_by = 'box'
      AND tile.status = 'active'
      AND (
        tile_finish.value = acc_finish.value
        OR (CASE
          WHEN LOWER(tile_finish.value) LIKE '%glossy' THEN 'glossy'
          WHEN LOWER(tile_finish.value) LIKE '%matte' THEN 'matte'
          WHEN LOWER(tile_finish.value) LIKE '%natural' THEN 'natural'
          WHEN LOWER(tile_finish.value) LIKE '%polished' THEN 'polished'
          WHEN LOWER(tile_finish.value) LIKE '%satin' THEN 'satin'
          WHEN LOWER(tile_finish.value) LIKE '%textured' THEN 'textured'
          WHEN LOWER(tile_finish.value) LIKE '%r11' THEN 'r11'
          WHEN LOWER(tile_finish.value) LIKE '%grip' THEN 'grip'
          WHEN LOWER(tile_finish.value) LIKE '%lappato' THEN 'lappato'
          ELSE LOWER(tile_finish.value)
        END) = (CASE
          WHEN LOWER(acc_finish.value) LIKE '%glossy' THEN 'glossy'
          WHEN LOWER(acc_finish.value) LIKE '%matte' THEN 'matte'
          WHEN LOWER(acc_finish.value) LIKE '%natural' THEN 'natural'
          WHEN LOWER(acc_finish.value) LIKE '%polished' THEN 'polished'
          WHEN LOWER(acc_finish.value) LIKE '%satin' THEN 'satin'
          WHEN LOWER(acc_finish.value) LIKE '%textured' THEN 'textured'
          WHEN LOWER(acc_finish.value) LIKE '%r11' THEN 'r11'
          WHEN LOWER(acc_finish.value) LIKE '%grip' THEN 'grip'
          WHEN LOWER(acc_finish.value) LIKE '%lappato' THEN 'lappato'
          ELSE LOWER(acc_finish.value)
        END)
      )
    ON CONFLICT (parent_sku_id, accessory_sku_id) DO NOTHING
  `, [vendor_id]);
  await appendLog(pool, job.id, `Attached ${accResult.rowCount} accessory links`);

  await appendLog(pool, job.id,
    `Scrape complete. Products: ${stats.created} new / ${stats.updated} updated, ` +
    `SKUs: ${stats.skusCreated}, Images: ${stats.imagesSet}, Attributes: ${stats.attributesSet}, ` +
    `Packaging: ${stats.packagingSet}, Pricing: ${stats.pricingSet}, Skipped: ${stats.skipped}, Errors: ${stats.errors}`,
    {
      products_found: stats.found,
      products_created: stats.created,
      products_updated: stats.updated,
      skus_created: stats.skusCreated,
    }
  );
}

// ─── Fetch with retry ─────────────────────────────────────────────────────────

async function fetchWithRetry(url, cookies = null, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml',
      };
      if (cookies) headers['Cookie'] = cookies;
      const resp = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(30000),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return resp;
    } catch (err) {
      if (attempt === retries) throw err;
      await delay(2000 * (attempt + 1));
    }
  }
}

// ─── Listing page parser ──────────────────────────────────────────────────────

function extractProductLinks(html) {
  const links = [];
  const seen = new Set();
  const regex = /href="([^"]*\/product-detail\/[^"]+)"/g;
  let match;
  while ((match = regex.exec(html)) !== null) {
    const href = match[1];
    if (!seen.has(href)) {
      seen.add(href);
      links.push(href);
    }
  }
  return links;
}

// ─── Detail page parser ──────────────────────────────────────────────────────

function parseDetailPage(html, url) {
  const result = {
    name: null,
    productGroupId: null,
    description: null,
    defaultSku: null,
    availability: null,
    variants: [],      // { colorId, sizeId, finishId, color, size, sizeLabel, finish, vendorSku, stockStatus, totalStock, soldAs, productId }
    colors: [],        // { id, text }
    sizes: [],         // { id, text }
    finishes: [],      // { id, text }
    images: [],        // full URLs (collection-level)
    imagesByVariantId: new Map(), // variant productId → [full-size image URLs]
    swatchImagesByColorId: new Map(), // color attrVal → { full: URL|null, thumb: URL }
    specs: {},
    packagingBySize: new Map(), // normalizedSize → { sqftPerBox, piecesPerBox, boxWeight, palletCount, sqftPerPallet, palletWeight }
  };

  // ── JSON-LD ProductGroup ──
  // Build URL→vendorSku map from hasVariant array for later correlation
  const skuByUrl = new Map();
  const jsonLdMatch = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi);
  if (jsonLdMatch) {
    for (const tag of jsonLdMatch) {
      try {
        const content = tag.replace(/<script[^>]*>/, '').replace(/<\/script>/, '').replace(/[\x00-\x1f]/g, ' ');
        const data = JSON.parse(content);
        if (data['@type'] === 'ProductGroup' || data['@type'] === 'Product') {
          result.name = data.name || null;
          result.productGroupId = data.productGroupID || null;
          result.defaultSku = data.sku || null;
          result.description = data.description || null;
          if (data.offers) {
            result.availability = data.offers.availability || null;
          }
          // Extract images from JSON-LD
          if (data.image) {
            const contentUrls = data.image.contentUrl || data.image;
            if (Array.isArray(contentUrls)) {
              for (const u of contentUrls) result.images.push(normalizeImgUrl(u));
            } else if (typeof contentUrls === 'string') {
              result.images.push(normalizeImgUrl(contentUrls));
            }
          }
          // Extract variant SKUs keyed by their offer URL
          if (data.hasVariant) {
            for (const v of data.hasVariant) {
              if (v.sku && v.offers?.url) {
                skuByUrl.set(v.offers.url, v.sku);
              }
            }
          }
        }
      } catch {}
    }
  }

  // ── Fallback name from <h1> ──
  if (!result.name) {
    const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
    if (h1Match) result.name = stripTags(h1Match[1]).trim();
  }

  // ── Description fallback ──
  if (!result.description) {
    const descMatch = html.match(/class="productView-description"[^>]*>([\s\S]*?)<\/div>/);
    if (descMatch) {
      result.description = stripTags(descMatch[1]).replace(/\s+/g, ' ').trim();
    }
  }

  // ── Parse variant_groups JS object ──
  const variantMatch = html.match(/variant_groups\s*=\s*(\{[\s\S]*?\});/);
  if (variantMatch) {
    try {
      const variantObj = JSON.parse(variantMatch[1]);
      for (const [key, val] of Object.entries(variantObj)) {
        const ids = key.split('-');
        // Price: net dealer price (top-level). PriceData has list/net breakdown.
        const dealerPrice = parseFloat(val.Price) || 0;
        const listPrice = val.PriceData ? (parseFloat(val.PriceData.price) || 0) : 0;
        const netPrice = val.PriceData ? (parseFloat(val.PriceData.net_price) || dealerPrice) : dealerPrice;

        // Per-sqft prices from price_text (pre-computed by the website)
        const priceTxt = val.PriceData?.price_text;
        const parseMoney = (s) => s ? parseFloat(String(s).replace(/[^0-9.]/g, '')) || 0 : 0;
        const areaNetPrice = parseMoney(priceTxt?.area_net_price);
        const areaListPrice = parseMoney(priceTxt?.area_price);

        result.variants.push({
          colorId: ids[0] || null,
          sizeId: ids[1] || null,
          finishId: ids[2] || null,
          variantName: val.record_variants_name || '',
          vendorSku: skuByUrl.get(val.Url) || null,
          stockStatus: parseInt(val.StockStatus, 10),
          totalStock: val.TotalStock || '0',
          soldAs: val.SoldAs || 'box',
          productId: val.Id != null ? String(val.Id) : null,
          price: dealerPrice,
          listPrice,
          netPrice,
          areaNetPrice,
          areaListPrice,
          sqft: val.SQFT ? parseFloat(val.SQFT) : null,
        });
      }
    } catch {}
  }

  // ── Parse color/size/finish select options ──
  result.colors = parseSelectOptions(html, 'Color');
  result.sizes = parseSelectOptions(html, 'Size');
  result.finishes = parseSelectOptions(html, 'Finish');

  // Enrich variants with readable names
  const colorById = new Map(result.colors.map(c => [c.id, c.text]));
  const sizeById = new Map(result.sizes.map(s => [s.id, s.text]));
  const finishById = new Map(result.finishes.map(f => [f.id, f.text]));

  for (const v of result.variants) {
    v.color = colorById.get(v.colorId) || extractFromVariantName(v.variantName, 'color');
    v.size = sizeById.get(v.sizeId) || extractFromVariantName(v.variantName, 'size');
    v.sizeLabel = sizeById.get(v.sizeId) || '';
    v.finish = finishById.get(v.finishId) || extractFromVariantName(v.variantName, 'finish');
  }

  // ── Parse specs table ──
  const specsRegex = /<tr[^>]*>\s*<td[^>]*>\s*([\s\S]*?)\s*<\/td>\s*<td[^>]*>\s*([\s\S]*?)\s*<\/td>\s*<\/tr>/gi;
  let specMatch;
  while ((specMatch = specsRegex.exec(html)) !== null) {
    const label = stripTags(specMatch[1]).trim().toLowerCase();
    const value = stripTags(specMatch[2]).trim();
    if (!value) continue;

    if (label === 'material') result.specs.material = value;
    else if (label === 'series name') result.specs.seriesName = value;
    else if (label.includes('series color')) result.specs.seriesColors = value;
    else if (label === 'size') result.specs.sizes = value;
    else if (label === 'shape') result.specs.shape = value;
    else if (label === 'thickness') {
      // Sanitize: take first comma-separated value, normalize spacing (e.g., "9mm" → "9 mm")
      let thick = value.split(',')[0].trim();
      if (thick === '-' || !thick) thick = null;
      else thick = thick.replace(/(\d)(mm)/i, '$1 $2');
      result.specs.thickness = thick;
    }
    else if (label.includes('country')) result.specs.origin = value;
    else if (label.includes('box weight') || label.includes('sq ft per box') || label.includes('sqft per box')
      || label.includes('box count') || label.includes('pieces per box') || label.includes('pallet weight')
      || label.includes('sq ft per pallet') || label.includes('sqft per pallet') || label.includes('pallet count')
      || label.includes('boxes per pallet') || label.includes('minimum')) {
      // Packaging fields — handled in per-size pass below
    }
  }

  // ── Parse per-size packaging blocks ──
  // Packaging section has repeating groups: Size header → packaging rows → next Size header → ...
  // We re-scan the table rows, tracking the current "packaging size" context.
  let currentPkgSize = null;
  let currentPkg = null;
  const specsRegex2 = /<tr[^>]*>\s*<td[^>]*>\s*([\s\S]*?)\s*<\/td>\s*<td[^>]*>\s*([\s\S]*?)\s*<\/td>\s*<\/tr>/gi;
  let specMatch2;
  let seenPackagingField = false;
  while ((specMatch2 = specsRegex2.exec(html)) !== null) {
    const label2 = stripTags(specMatch2[1]).trim().toLowerCase();
    const value2 = stripTags(specMatch2[2]).trim();
    if (!value2) continue;

    const isPackagingField = label2.includes('box weight') || label2.includes('sq ft per box') || label2.includes('sqft per box')
      || label2.includes('box count') || label2.includes('pieces per box') || label2.includes('pallet weight')
      || label2.includes('sq ft per pallet') || label2.includes('sqft per pallet') || label2.includes('pallet count')
      || label2.includes('boxes per pallet') || label2.includes('minimum');

    // "size" row in PACKAGING section starts a new packaging block.
    // The label may be just "size" or may contain preceding HTML debris (e.g., "...packaging...size")
    // when table cells bleed across accordion sections.
    // Distinguish from SPECIFICATIONS "Size" row (comma-separated list of all sizes)
    // by requiring either: already seen a packaging field, OR value is a single size (no commas/and).
    const isLabelSize = label2 === 'size' || /\bsize\s*$/.test(label2);
    if (isLabelSize) {
      const isSingleSize = !value2.includes(',') && !value2.toLowerCase().includes(' and ');
      if (seenPackagingField || isSingleSize) {
        // Flush previous block
        if (currentPkgSize && currentPkg) {
          result.packagingBySize.set(currentPkgSize, currentPkg);
        }
        currentPkgSize = normalizeSize(value2);
        currentPkg = {};
        continue;
      }
    }

    if (isPackagingField) {
      seenPackagingField = true;
      if (!currentPkg) {
        // Packaging without a preceding size header — use a placeholder
        currentPkgSize = '_default';
        currentPkg = {};
      }
      if (label2.includes('box weight')) currentPkg.boxWeight = parseFloat(value2.replace(/[^0-9.]/g, '')) || null;
      else if (label2.includes('sq ft per box') || label2.includes('sqft per box')) currentPkg.sqftPerBox = parseFloat(value2.replace(/[^0-9.]/g, '')) || null;
      else if (label2.includes('box count') || label2.includes('pieces per box')) currentPkg.piecesPerBox = parseInt(value2) || null;
      else if (label2.includes('pallet weight')) currentPkg.palletWeight = parseFloat(value2.replace(/[^0-9.,]/g, '').replace(',', '')) || null;
      else if (label2.includes('sq ft per pallet') || label2.includes('sqft per pallet')) currentPkg.sqftPerPallet = parseFloat(value2.replace(/[^0-9.]/g, '')) || null;
      else if (label2.includes('pallet count') || label2.includes('boxes per pallet')) currentPkg.palletCount = parseInt(value2) || null;
    }
  }
  // Flush last block
  if (currentPkgSize && currentPkg) {
    result.packagingBySize.set(currentPkgSize, currentPkg);
  }
  // Backward compat: populate scalar specs from first packaging block (for products with single-size packaging)
  if (result.packagingBySize.size > 0) {
    const first = result.packagingBySize.values().next().value;
    result.specs.sqftPerBox = first.sqftPerBox || null;
    result.specs.piecesPerBox = first.piecesPerBox || null;
    result.specs.boxWeight = first.boxWeight || null;
    result.specs.palletCount = first.palletCount || null;
    result.specs.sqftPerPallet = first.sqftPerPallet || null;
    result.specs.palletWeight = first.palletWeight || null;
  }

  // ── Parse product images and map to variant IDs ──
  // Bosphorus CDN URLs contain variant IDs in the path:
  //   Main carousel: /products//8469/calypso-0.jpg (full-size, variant ID in path)
  //   Thumb carousel: /products/8469/th-calypso-0.jpg (data-product-id on <img> tag)
  // After normalizeImgUrl both become /products/8469/...

  // Extract product images (main carousel + gallery): map to variant via URL path
  // (data-product-id thumbnail attribute was removed in Sep 2025 redesign)
  const productImgRegex = /src="(https?:\/\/www\.bosphorusimports\.com\/cdn\/uploads\/capsule\/products\/\/?[^"]+)"/g;
  const seenImgs = new Set(result.images.map(u => u.split('?')[0]));
  let imgMatch;
  while ((imgMatch = productImgRegex.exec(html)) !== null) {
    const imgUrl = normalizeImgUrl(imgMatch[1]);
    if (/\/th-/.test(imgUrl)) continue; // skip thumbnails
    const base = imgUrl.split('?')[0];

    // Map to variant via URL path: /products/8469/calypso-0.jpg
    const vidMatch = base.match(/\/products\/(\d+)\//);
    if (vidMatch) {
      const variantPid = vidMatch[1];
      if (!result.imagesByVariantId.has(variantPid)) {
        result.imagesByVariantId.set(variantPid, []);
      }
      const existing = result.imagesByVariantId.get(variantPid);
      if (!existing.some(u => u.split('?')[0] === base)) {
        existing.push(imgUrl);
      }
    }

    // Also add to collection-level images as fallback
    if (!seenImgs.has(base)) {
      seenImgs.add(base);
      result.images.push(imgUrl);
    }
  }

  // Sort images: product shots first
  result.images = preferProductShot(result.images);

  // ── Parse color swatch background-image URLs ──
  // Swatches are inline styles on <span> inside <label data-product-attribute-value="NNN">
  // We extract each <label> block individually and find the background-image within it,
  // using the label's data-product-attribute-value as the colorId (matches variant_groups keys).
  const labelRegex = /<label[^>]*data-product-attribute-value="(\d+)"[^>]*>([\s\S]*?)<\/label>/g;
  let swMatch;
  while ((swMatch = labelRegex.exec(html)) !== null) {
    const colorId = swMatch[1];
    if (result.swatchImagesByColorId.has(colorId)) continue; // first occurrence wins
    const inner = swMatch[2];
    const bgMatch = inner.match(/style="background-image:\s*url\('?(https?:\/\/[^'")\s]+)'?\);?"/);
    if (!bgMatch) continue;
    const rawUrl = normalizeImgUrl(bgMatch[1]);
    const filename = rawUrl.split('/').pop().split('?')[0];
    if (filename.startsWith('th-')) {
      const fullUrl = rawUrl.replace(/\/th-([^/?]+)/, '/$1');
      result.swatchImagesByColorId.set(colorId, { full: fullUrl, thumb: rawUrl });
    } else {
      result.swatchImagesByColorId.set(colorId, { full: rawUrl, thumb: null });
    }
  }

  return result;
}

/**
 * Parse <select> options for a given attribute name (Color, Size, Finish).
 * Looks for the label text followed by option tags with data-product-attribute-value.
 */
function parseSelectOptions(html, attributeName) {
  const options = [];

  // New site layout (Sep 2025+): swatch labels instead of <select> dropdowns
  // Pattern: <strong>Color:</strong> ... <label class="form-option-swatch" data-product-attribute-value="7599">
  //            <span class="form-option-expanded">Cream</span>
  //            <p class="variant-name-value">Cream</p>
  //          </label>
  const swatchSectionRegex = new RegExp(
    `(?:<strong>|<label[^>]*>)[^<]*${attributeName}[^<]*(?:</strong>|</label>)([\\s\\S]*?)(?=<strong>|<label[^>]*>[^<]*(?:Color|Size|Finish)[^<]*</label>|$)`,
    'i'
  );
  const sectionMatch = html.match(swatchSectionRegex);

  if (sectionMatch) {
    const sectionHtml = sectionMatch[1];
    // Extract from <label data-product-attribute-value="ID"> ... text content
    const labelRegex = /<label[^>]*data-product-attribute-value="(\d+)"[^>]*>([\s\S]*?)<\/label>/g;
    let lMatch;
    while ((lMatch = labelRegex.exec(sectionHtml)) !== null) {
      const id = lMatch[1];
      const inner = lMatch[2];
      // Prefer <p class="variant-name-value"> text, fall back to <span class="form-option-expanded">
      const nameMatch = inner.match(/<p[^>]*class="variant-name-value"[^>]*>([^<]+)<\/p>/)
        || inner.match(/<span[^>]*class="form-option-expanded"[^>]*>([^<]+)<\/span>/)
        || inner.match(/<span[^>]*>([^<]+)<\/span>/);
      const text = nameMatch ? nameMatch[1].trim() : stripTags(inner).trim();
      if (text && !options.find(o => o.id === id)) {
        options.push({ id, text });
      }
    }
  }

  // Legacy fallback: <select> dropdowns (pre-Sep 2025)
  if (options.length === 0) {
    const selectRegex = new RegExp(
      `<label[^>]*>[^<]*${attributeName}[^<]*<\\/label>[\\s\\S]*?<select[^>]*>([\\s\\S]*?)<\\/select>`,
      'i'
    );
    const selectMatch = html.match(selectRegex);
    if (selectMatch) {
      const selectHtml = selectMatch[1];
      const optionRegex = /data-product-attribute-value="(\d+)"[^>]*>([^<]+)</g;
      let optMatch;
      while ((optMatch = optionRegex.exec(selectHtml)) !== null) {
        options.push({ id: optMatch[1], text: optMatch[2].trim() });
      }
    }
  }

  // Last resort: broad search for any data-product-attribute-value near the attribute name
  if (options.length === 0) {
    const broadRegex = new RegExp(
      `${attributeName}[\\s\\S]{0,500}?data-product-attribute-value="(\\d+)"[^>]*>[\\s\\S]*?(?:<p[^>]*class="variant-name-value"[^>]*>([^<]+)|<span[^>]*>([^<]+))`,
      'gi'
    );
    let bMatch;
    while ((bMatch = broadRegex.exec(html)) !== null) {
      const text = (bMatch[2] || bMatch[3] || '').trim();
      if (text && !options.find(o => o.id === bMatch[1])) {
        options.push({ id: bMatch[1], text });
      }
    }
  }

  return options;
}

/**
 * Extract a value from the variant name string.
 * Format: "Cream 12\"x24\" Matte" or "Beige 2\"x2\" Mosaic Matte"
 */
function extractFromVariantName(name, field) {
  if (!name) return null;
  // Unescape quotes and normalize smart quotes
  const clean = name.replace(/\\"/g, '"').replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '"');

  // Size regex that handles fractions: 3/4x5, 1/2x8, 10" 1/2x71, 12"x24", 10.25x63
  // Allows optional inch mark between integer and fraction: 10" 1/2
  // Negative lookahead (?![a-z]) prevents matching trailing digits before letters (e.g., "3D")
  const sizePattern = /(?:\d+"?\s+)?\d+(?:\/\d+|\.\d*)?"?\s*x\s*(?:\d+"?\s+)?\d+(?:\/\d+|\.\d*)?"?(?![a-z])/i;

  if (field === 'size') {
    const sizeMatch = clean.match(sizePattern);
    return sizeMatch ? sizeMatch[0].trim() : null;
  }
  if (field === 'color') {
    // Color is everything before the first size pattern
    const parts = clean.split(sizePattern);
    const color = parts[0] ? parts[0].replace(/[\s\/\"]+$/, '').trim() : null;
    return color || null;
  }
  if (field === 'finish') {
    // Finish is the last word(s) after the size
    const sizeIdx = clean.search(sizePattern);
    if (sizeIdx < 0) return null;
    const afterSize = clean.slice(sizeIdx).replace(sizePattern, '').trim();
    // Strip mosaic/bullnose labels, keep finish
    const finishPart = afterSize
      .replace(/\b(Porcelain|Surface|Bullnose|Mosaic|Mosaics)\b/gi, '')
      .trim();
    return finishPart || null;
  }
  return null;
}

// ─── Variant grouping ─────────────────────────────────────────────────────────

/**
 * Group variants by color name → one product per color.
 * Returns Map<colorName, variant[]>
 */
function groupVariantsByColor(productData) {
  const groups = new Map();

  if (productData.variants.length === 0) {
    // No variants parsed — skip unless seriesColors provides real color names.
    // Without real variant data (size, finish, price), creating products just
    // produces orphan collection-parent rows with 0 usable SKUs.
    const colors = productData.specs.seriesColors
      ? productData.specs.seriesColors.split(',').map(c => c.trim()).filter(Boolean)
      : [];

    if (colors.length === 0) return groups; // nothing to create

    for (const color of colors) {
      groups.set(color, [{
        color,
        size: null,
        sizeLabel: '',
        finish: null,
        vendorSku: productData.defaultSku,
        stockStatus: productData.availability?.includes('InStock') ? 2 : 0,
        totalStock: '0',
      }]);
    }
    return groups;
  }

  for (const v of productData.variants) {
    const rawColor = v.color || 'Default';
    // Strip leading sort-order numbers: "1 Ravello" → "Ravello", "10 Sorrento" → "Sorrento"
    const color = rawColor.replace(/^\d+\s+/, '');
    // Preserve original for image filename matching (e.g., "8 Scala" → style_8__)
    v._rawColor = rawColor;
    if (!groups.has(color)) groups.set(color, []);
    groups.get(color).push(v);
  }

  // Replace "Default" with the collection name when it's the only color
  if (groups.size === 1 && groups.has('Default')) {
    const variants = groups.get('Default');
    groups.delete('Default');
    groups.set(productData.name, variants);
  }

  return groups;
}

/**
 * Group variants by size+finish → one product per size+finish combo.
 * Each color within a group becomes a separate SKU.
 * Returns Map<key, { sizeNorm, finish, isAccessory, accessoryType, colorVariants: Map<color, variant> }>
 */
function groupVariantsBySizeFinish(productData) {
  const groups = new Map();

  for (const v of productData.variants) {
    const rawColor = v.color || 'Default';
    const color = rawColor.replace(/^\d+\s+/, '');
    v._rawColor = rawColor;

    const sizeClean = (v.size || '').replace(/\s+(?:3D\s+)?(Matte|Polished|Honed|Satin|Glossy|Natural|Textured|Grip|Rough|Lappato).*$/i, '');
    const sizeNorm = normalizeSize(sizeClean) || 'Standard';
    const finish = v.finish || null;

    // Detect accessory (same logic as before)
    const finishLower = (finish || '').toLowerCase();
    const sizeLabelLower = (v.sizeLabel || '').toLowerCase();
    const accessoryKeywords = /\b(jolly|bullnose|pencil|liner|trim|molding|ogee|rope\s*liner|crown\s*molding|quarter\s*round|chair\s*rail)\b/i;
    const hasKeywordInFinish = accessoryKeywords.test(finishLower);
    const hasKeywordInSize = accessoryKeywords.test(sizeLabelLower);

    let sizeIsSmallTrim = false;
    if (sizeNorm) {
      const sizeParts = sizeNorm.split(/x/i);
      if (sizeParts.length === 2) {
        const sd1 = parseDimension(sizeParts[0]);
        const sd2 = parseDimension(sizeParts[1]);
        if (!isNaN(sd1) && !isNaN(sd2)) {
          sizeIsSmallTrim = Math.min(sd1, sd2) <= 3;
        }
      }
      if (!sizeIsSmallTrim && sizeParts.length !== 2) {
        sizeIsSmallTrim = !/^\d/.test(sizeNorm);
      }
    }
    let isAccessory = hasKeywordInFinish || (hasKeywordInSize && sizeIsSmallTrim);

    let accessoryType = null;
    if (!isAccessory) {
      accessoryType = inferAccessoryType(sizeNorm, finish);
      if (accessoryType) isAccessory = true;
    }

    const key = `${sizeNorm}|${finish || ''}|${isAccessory ? (accessoryType || 'accessory') : ''}`;

    if (!groups.has(key)) {
      groups.set(key, {
        sizeNorm, finish, isAccessory, accessoryType,
        colorVariants: new Map(),
      });
    }
    const group = groups.get(key);
    if (!group.colorVariants.has(color)) {
      group.colorVariants.set(color, v);
    }
  }

  // If the only color across all groups is 'Default', replace with collection name
  const allColorKeys = new Set();
  for (const g of groups.values()) {
    for (const k of g.colorVariants.keys()) allColorKeys.add(k);
  }
  if (allColorKeys.size === 1 && allColorKeys.has('Default')) {
    for (const g of groups.values()) {
      const v = g.colorVariants.get('Default');
      g.colorVariants.delete('Default');
      g.colorVariants.set(productData.name, v);
    }
  }

  return groups;
}

/**
 * Classify slider images into product shots vs lifestyle, excluding duplicates of the swatch.
 * If no swatch and no product shots, promotes the first lifestyle image.
 */
function classifySliderImages(sliderImages, swatchEntry) {
  const swatchUrl = swatchEntry ? (swatchEntry.full || swatchEntry.thumb) : null;
  const swatchBase = swatchUrl ? swatchUrl.split('?')[0] : null;
  const productShots = [];
  const lifestyle = [];
  for (const img of sliderImages) {
    const imgBase = img.split('?')[0];
    if (swatchBase && imgBase === swatchBase) continue;
    if (isLifestyleUrl(img)) {
      lifestyle.push(img);
    } else {
      productShots.push(img);
    }
  }
  if (!swatchUrl && productShots.length === 0 && lifestyle.length > 0) {
    productShots.push(lifestyle.shift());
  }
  return { productShots, lifestyle };
}

// ─── Image helpers ────────────────────────────────────────────────────────────

/**
 * Filter image list to remove images that clearly belong to a different collection.
 * Checks if image filename contains a different known collection's name/slug.
 * Used to catch cross-collection contamination (e.g., Marvel images on Duality page).
 */
function filterOwnCollectionImages(images, collectionName) {
  if (!images.length || !collectionName) return images;
  const ownSlug = collectionName.toLowerCase().replace(/[^a-z0-9]+/g, '');

  const KNOWN_PREFIXES = [
    'marvel', 'arenite', 'calypso', 'amalfi', 'duality', 'beyond', 'glocal',
    'silverlake', 'castello', 'crayon', 'boost', 'gravel', 'holbox', 'limestone',
    'soapstone', 'argile', 'iconica', 'vesta', 'forma', 'cusp', 'solid',
    'geo', 'arrow', 'memory', 'pietra', 'eiche', 'fango', 'fuoritono',
    'intreccio', 'mingle', 'nova', 'planches', 'pyper', 'silvan', 'splendours',
    'frammenti', 'boutique', 'duplostone', 'reflet', 'tanger', 'match',
    'cotto', 'fluted', 'element', 'norgestein', 'norge', 'golden', 'mealapis',
    'boosticor', 'booststone', 'opart', 'restyle', 'porcellana', 'blackandwhite',
  ];

  return images.filter(url => {
    const fn = url.split('/').pop().split('?')[0].toLowerCase();
    if (fn.includes(ownSlug)) return true;
    const otherPrefix = KNOWN_PREFIXES.find(p => p !== ownSlug && fn.includes(p));
    return !otherPrefix;
  });
}

/**
 * Get slider images for a specific color by collecting images from the carousel
 * variant mapping. Each carousel image is associated with a specific variant
 * product ID via its URL path. We collect images from all variants of the same color.
 *
 * Returns raw slider images (no reordering) — caller handles classification.
 * Falls back to filename-based color matching, then all images.
 */

/** Check if a filename segment matches a color word, with fuzzy prefix matching
 *  to handle typos like "terrazo" vs "terrazzo" (shared prefix ≥ 5 chars). */
function segFuzzyMatch(seg, w) {
  if (seg === w || seg.startsWith(w) || w.startsWith(seg)) return true;
  const minLen = Math.min(seg.length, w.length);
  if (minLen >= 5) {
    let shared = 0;
    while (shared < minLen && seg[shared] === w[shared]) shared++;
    if (shared >= 5) return true;
  }
  return false;
}

function getColorSliderImages(imagesByVariantId, colorVariants, allImages, colorName, siblingColorNames) {
  // 1. Variant ID mapping (carousel images keyed by variant product ID from URL path)
  //    When imagesByVariantId has multiple keys, each key partitions images by variant —
  //    this is the most reliable matching method.
  //    When it has only 1 key, ALL images are under a single page ID. A variant's JSON
  //    val.Id matching that single page ID is coincidental, not meaningful, so we skip
  //    to filename matching instead to avoid false matches (e.g., Glocal Sugar getting
  //    ALL Glocal images because its val.Id happens to equal the page path ID).
  if (imagesByVariantId && imagesByVariantId.size > 1) {
    const colorImgs = [];
    const seenBases = new Set();
    for (const v of colorVariants) {
      if (v.productId) {
        const imgs = imagesByVariantId.get(v.productId) || [];
        for (const img of imgs) {
          const base = img.split('?')[0];
          if (!seenBases.has(base)) {
            seenBases.add(base);
            colorImgs.push(img);
          }
        }
      }
    }
    if (colorImgs.length > 0) {
      // Apply cross-color filename filter: remove images whose filenames mention
      // a sibling color's distinctive words but NOT this color's words.
      // This catches variant-ID grouping that lumps multiple colors together.
      if (siblingColorNames && siblingColorNames.length > 1 && colorName) {
        const colorLower = colorName.toLowerCase();
        const myWords = colorLower.split(/[^a-z0-9]+/).filter(w => w.length >= 3);
        const mySlug = colorLower.replace(/[^a-z0-9]+/g, '');

        // Build list of sibling-only words: words that appear in a sibling but not in our color
        const siblingOnlyWords = [];
        for (const sib of siblingColorNames) {
          if (sib.toLowerCase() === colorLower) continue;
          const sibWords = sib.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 3);
          const uniqueWords = sibWords.filter(w => !myWords.includes(w));
          if (uniqueWords.length > 0) {
            siblingOnlyWords.push({ sib, uniqueWords, allWords: sibWords });
          }
        }

        if (siblingOnlyWords.length > 0) {
          const filtered = colorImgs.filter(url => {
            const fn = url.split('/').pop().split('?')[0].toLowerCase();
            const segments = fn.split(/[_\-.]+/);
            // Keep image unless a sibling's unique words ALL appear in the filename
            // AND this color's distinctive words do NOT appear (or are shared)
            return !siblingOnlyWords.some(({ uniqueWords, allWords }) => {
              const sibUniquesPresent = uniqueWords.every(w =>
                segments.some(seg => segFuzzyMatch(seg, w))
              );
              if (!sibUniquesPresent) return false;
              // Check if ALL sibling words are present (full sibling match)
              return allWords.every(w =>
                segments.some(seg => segFuzzyMatch(seg, w))
              );
            });
          });
          if (filtered.length > 0) return filtered;
        }
      }
      return colorImgs;
    }
  }

  // 2. Filename-based color matching (fallback for pages without per-variant image mapping)
  if (allImages && allImages.length > 0 && colorName) {
    const colorLower = colorName.toLowerCase();
    const colorSlug = colorLower.replace(/[^a-z0-9]+/g, '');
    const colorWords = colorLower.split(/[^a-z0-9]+/).filter(w => w.length >= 3);
    const numMatch = colorName.match(/^(\d+)\s/);
    const colorNum = numMatch ? numMatch[1] : null;
    const isColorMix = colorLower.includes('mix');

    // Words that describe product type/finish, NOT color. These must never be used
    // alone for image matching because they appear in filenames of many different colors
    // (e.g., "deco" in "castello_miele_deco_room", "castello_paglierino_deco_room").
    const NOISE_WORDS = new Set([
      'deco', 'ceramic', 'mix', 'mosaic', 'matte', 'glossy', 'polished',
      'satin', 'grip', 'room', 'style', 'masonry', 'wheat', 'insert',
    ]);
    // Color-meaningful words: exclude noise and short words
    const meaningfulWords = colorWords.filter(w => !NOISE_WORDS.has(w));

    const fnHasWord = (fn, word) => {
      const segments = fn.split(/[_\-]+/);
      return segments.some(seg => seg === word || seg.startsWith(word + 's'));
    };
    const isMixImage = (fn) => fnHasWord(fn, 'mix');
    const mixFilter = (url) => {
      const fn = url.split('/').pop().split('?')[0].toLowerCase();
      return isColorMix || !isMixImage(fn);
    };

    // Specificity guard: filter out images that a longer/more-specific sibling
    // color would claim. e.g., "Green" should not claim "laurel_green" images
    // when "Laurel Green" exists as a sibling color.
    // Build sibling info: each sibling that is a superset of this color's words.
    const siblingSpecs = (siblingColorNames || [])
      .filter(sib => sib.toLowerCase() !== colorName.toLowerCase())
      .map(sib => {
        const sibLower = sib.toLowerCase();
        const sibSlug = sibLower.replace(/[^a-z0-9]+/g, '');
        const sibWords = sibLower.split(/[^a-z0-9]+/).filter(w => w.length >= 3);
        return { sibSlug, sibWords };
      })
      .filter(({ sibSlug, sibWords }) =>
        // Sibling must be longer and contain our slug as a substring
        (sibSlug.length > colorSlug.length && sibSlug.includes(colorSlug)) ||
        // OR sibling's words must be a superset of our meaningful words
        (sibWords.length > meaningfulWords.length && meaningfulWords.every(w => sibWords.includes(w)))
      );

    const applySpecificityGuard = (imgs) => {
      if (imgs.length === 0 || siblingSpecs.length === 0) return imgs;
      const filtered = imgs.filter(url => {
        const fn = url.split('/').pop().split('?')[0].toLowerCase();
        const segments = fn.split(/[_\-.]+/);
        // Keep image if no longer sibling matches this filename
        return !siblingSpecs.some(({ sibSlug, sibWords }) => {
          // Check concatenated slug match (e.g., "articterrazzo" in filename)
          const concatPattern = new RegExp(`(?:^|[_\\-.])${sibSlug}(?:[_\\-.]|$)`);
          if (concatPattern.test(fn)) return true;
          // Check word-segment match: all sibling words present as filename segments
          // (e.g., "laurel" + "green" both in "hopp_5x40_laurel_green__07530")
          // Also handles filename typos like "terrazo" vs "terrazzo" via segFuzzyMatch.
          if (sibWords.length >= 2 && sibWords.every(w => segments.some(seg => segFuzzyMatch(seg, w)))) return true;
          return false;
        });
      });
      return filtered.length > 0 ? filtered : imgs;
    };

    let matched;

    // Full slug match (e.g., "doratodeco" or "amibasalt" in filename)
    // Use word-boundary regex: slug must be at start/end or bounded by _ - .
    // This prevents "artic" matching inside "articterrazzo", "nero" inside "fuorinero", etc.
    const slugPattern = new RegExp(`(?:^|[_\\-.])${colorSlug}(?:[_\\-.]|$)`);
    const hyphenSlug = colorLower.replace(/\s+/g, '-');
    const hyphenPattern = new RegExp(`(?:^|[_\\-.])${hyphenSlug.replace(/[^a-z0-9-]/g, '')}(?:[_\\-.]|$)`);
    matched = allImages.filter(url => {
      const fn = url.split('/').pop().split('?')[0].toLowerCase();
      return (slugPattern.test(fn) || hyphenPattern.test(fn)) && mixFilter(url);
    });
    matched = applySpecificityGuard(matched);
    if (matched.length > 0) return matched;

    // ALL words match (AND logic, word-boundary) — uses all words including noise
    if (colorWords.length >= 2) {
      matched = allImages.filter(url => {
        const fn = url.split('/').pop().split('?')[0].toLowerCase();
        return colorWords.every(w => fnHasWord(fn, w)) && mixFilter(url);
      });
      if (matched.length > 0) return matched;
    }

    // Number prefix match (e.g., "style_1__" for "1 Ravello")
    if (colorNum) {
      matched = allImages.filter(url => {
        const fn = url.split('/').pop().split('?')[0].toLowerCase();
        const numPattern = new RegExp(`[_\\-]${colorNum}[_\\-]|^${colorNum}[_\\-]|[_\\-]${colorNum}\\b`);
        return numPattern.test(fn) && mixFilter(url);
      });
      if (matched.length > 0) return matched;
    }

    // ANY word match (OR logic) — only use meaningful color words to avoid
    // matching generic terms like "deco" that appear in many colors' filenames.
    // e.g., "Dorato Deco" should match on "dorato" only, not "deco".
    if (meaningfulWords.length > 0) {
      matched = allImages.filter(url => {
        const fn = url.split('/').pop().split('?')[0].toLowerCase();
        return meaningfulWords.some(w => fnHasWord(fn, w)) && mixFilter(url);
      });
      matched = applySpecificityGuard(matched);
      if (matched.length > 0) return matched;
    }
  }

  // 3. No fallback — return empty instead of shared images.
  // Product-level images serve as the gallery via server.js supplementation.
  return [];
}

/**
 * Pick the best images for a specific SKU from the pool of color images.
 * Strategy:
 *   1. Extract finish keywords (stave, 3d, hexagon, chevron, grip, etc.) from finish name
 *   2. Score each image by: finish match, size match, product-shot preference
 *   3. Pick best-scoring images as primary + alternates
 *   4. Cap at 4 images per SKU to avoid bloat
 */
function pickSkuImages(colorImages, sizeNorm, finish) {
  if (!colorImages.length) return [];
  if (!sizeNorm && !finish) return colorImages.slice(0, 1);

  // ── Build size patterns ──
  let sizePatterns = [];
  const anySizePattern = /(?<!\d)(\d+(?:\.\d+)?)[_\-]?[x×][_\-]?(\d+(?:\.\d+)?)(?!\d)/i;
  if (sizeNorm) {
    const sizeParts = sizeNorm.match(/^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/);
    if (sizeParts) {
      const d1 = sizeParts[1];
      const d2 = sizeParts[2];
      const B = '(?<!\\d)';
      const BE = '(?!\\d)';
      sizePatterns = [
        new RegExp(`${B}${escapeRegex(d1)}\\s*[x×]\\s*${escapeRegex(d2)}${BE}`, 'i'),
        new RegExp(`${B}${escapeRegex(d1)}[_\\-]x[_\\-]${escapeRegex(d2)}${BE}`, 'i'),
        new RegExp(`${B}${escapeRegex(d1)}[_\\-]${escapeRegex(d2)}${BE}`, 'i'),
      ];
      if (d1.includes('.') || d2.includes('.')) {
        sizePatterns.push(
          new RegExp(`${B}${escapeRegex(d1.replace('.', ''))}\\s*[x×_\\-]\\s*${escapeRegex(d2.replace('.', ''))}${BE}`, 'i')
        );
      }
    }
  }

  // ── Extract finish keywords ──
  // Only SHAPE keywords matter for image matching — they're the real visual differentiators.
  // Surface finishes (matte, glossy, polished) don't reliably appear in filenames and
  // aren't strong signals for image selection.
  const SHAPE_KEYWORDS = [
    'stave3d', 'stave', '3d', 'hexagon', 'hex', 'chevron', 'rhomboid',
    'subway', 'picket', 'mosaic', 'deco', 'fluted',
    'herringbone', 'basketweave', 'arabesque', 'lantern', 'fan',
    'splitface', 'bullnose', 'jolly', 'pencil', 'ogee',
  ];
  const finishLower = (finish || '').toLowerCase();
  const finishSlug = finishLower.replace(/[^a-z0-9]+/g, '');

  // Build positive match keywords and anti-keywords for precise matching.
  // "Stave 3D" → match "stave3d"; anti-keywords: none
  // "Stave" (no 3D) → match "stave"; anti-keywords: "stave3d", "3d"
  // "Matte" → no shape keywords; anti-keywords: none (just rely on other-shape penalty)
  const finishKeys = [];
  const antiKeys = []; // keywords that mean WRONG variant for this finish

  if (finishSlug.includes('stave') && finishSlug.includes('3d')) {
    finishKeys.push('stave3d');
  } else if (finishSlug.includes('stave')) {
    finishKeys.push('stave');
    antiKeys.push('stave3d', '3d');
  } else if (finishSlug.includes('3d')) {
    finishKeys.push('3d');
  }
  // Add other shape keywords
  for (const kw of SHAPE_KEYWORDS) {
    if (kw === 'stave3d' || kw === 'stave' || kw === '3d') continue; // handled above
    if (finishLower.includes(kw) && !finishKeys.includes(kw)) finishKeys.push(kw);
  }

  // Segment-based match: split filename on delimiters and check full segments
  // so "stave" doesn't match inside "stave3d"
  const fnSegments = (fn) => fn.split(/[_\-\s.]+/);
  const segmentMatch = (fn, kw) => {
    // For compound keywords like "stave3d", check both substring and segment
    if (kw.length > 4) return fn.includes(kw);
    // For short keywords, require segment boundary match
    const segs = fnSegments(fn);
    return segs.some(seg => seg === kw || seg.startsWith(kw + 's'));
  };

  // ── Score each image ──
  const scored = colorImages.map(url => {
    const fn = url.split('/').pop().split('?')[0].toLowerCase();
    let score = 0;

    // Size match: +20 for matching this SKU's size
    const matchesSize = sizePatterns.length > 0 && sizePatterns.some(p => p.test(fn));
    const hasAnySize = anySizePattern.test(fn);
    if (matchesSize) score += 20;
    else if (hasAnySize) score -= 10; // wrong size → penalize

    // Anti-keyword check: strong penalty if image has a keyword we explicitly DON'T want
    const hasAntiKey = antiKeys.length > 0 && antiKeys.some(kw => fn.includes(kw));
    if (hasAntiKey) {
      score -= 25; // strong penalty — this is the WRONG variant
    } else {
      // Finish match: +30 for matching this SKU's shape keywords
      const matchesFinish = finishKeys.length > 0 && finishKeys.some(kw => segmentMatch(fn, kw));
      // Check if image has a DIFFERENT shape keyword (wrong variant)
      const hasOtherShape = !matchesFinish && SHAPE_KEYWORDS.some(kw => fn.includes(kw));
      if (matchesFinish) score += 30;
      else if (hasOtherShape) score -= 15; // wrong shape → penalize
    }

    // Product shot preference: +5 for product shots, -20 for lifestyle
    if (isLifestyleUrl(url)) score -= 20;
    else score += 5;

    return { url, score };
  });

  // Sort by score descending, stable (preserves vendor gallery order on ties)
  scored.sort((a, b) => b.score - a.score);

  // Pick top results, cap at 4
  const result = [];
  for (const item of scored) {
    if (result.length >= 4) break;
    // Skip heavily penalized images (wrong size + wrong finish + room scene)
    if (item.score < -20 && result.length > 0) break;
    result.push(item.url);
  }

  return result.length > 0 ? result : colorImages.slice(0, 1);
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─── SKU and category helpers ─────────────────────────────────────────────────

function buildInternalSku(collection, size, finish, color) {
  const parts = [VENDOR_CODE, slugify(collection)];
  if (size) parts.push(slugify(size));
  if (finish) parts.push(slugify(finish));
  parts.push(slugify(color));
  return parts.join('-');
}

/**
 * Parse a dimension string that may contain fractions (e.g., "1/2", "2 1/2", "3/4")
 * into a decimal number. Returns NaN if unparseable.
 */
function parseDimension(s) {
  if (!s) return NaN;
  s = s.trim();
  // "2 1/2" → 2 + 1/2 = 2.5 (mixed fraction)
  const mixedMatch = s.match(/^(\d+)\s+(\d+)\/(\d+)$/);
  if (mixedMatch) return parseInt(mixedMatch[1]) + parseInt(mixedMatch[2]) / parseInt(mixedMatch[3]);
  // "1/2" → 0.5 (simple fraction)
  const fracMatch = s.match(/^(\d+)\/(\d+)$/);
  if (fracMatch) return parseInt(fracMatch[1]) / parseInt(fracMatch[2]);
  // "2.5" or "12" (decimal or integer)
  return parseFloat(s);
}

/**
 * Infer accessory type from size dimensions.
 * Returns null for regular field tiles/mosaics, or a type string for trim/accessories.
 *
 * Quarter Round:   min dim < 1" & max ≤ 6" (e.g., 3/4x5, 3/4x6)
 * Pencil Liner:    min dim ≤ 1" & max > 6"  (e.g., 1/2x8, 1/2x12, 1/2x15)
 * Trim Liner:      1" < min dim < 2.5" & max ≥ 8" (e.g., 2x15, 2x16, 2x18)
 * Chair Rail:      1" < min dim ≤ 3" & max ≤ 8" with "chair rail" in finish
 * Bullnose:        2.5" ≤ min dim ≤ 3" & max ≥ 8"  (e.g., 3x12, 3x24, 3x36, 3x48)
 */
function inferAccessoryType(sizeNorm, finish) {
  if (!sizeNorm) return null;

  // Split on 'x' and parse each dimension, handling fractions like "1/2", "2 1/2"
  const parts = sizeNorm.split(/x/i);
  if (parts.length !== 2) return null;

  const d1 = parseDimension(parts[0]);
  const d2 = parseDimension(parts[1]);
  if (isNaN(d1) || isNaN(d2)) return null;

  const minDim = Math.min(d1, d2);
  const maxDim = Math.max(d1, d2);

  const finishLower = (finish || '').toLowerCase();

  // Quarter Round: very narrow (< 1") and short
  if (minDim < 1 && maxDim <= 6) return 'Quarter Round';

  // Pencil Liner / Flat Liner: very narrow (≤ 1") and longer
  if (minDim <= 1 && maxDim > 6) {
    if (finishLower.includes('flat')) return 'Flat Liner';
    return 'Pencil Liner';
  }

  // Mosaic Insert: small square or narrow rectangle (≤ 2.5" x ≤ 5")
  // Covers 2x2, 1x4, 1x3, 2.5x2.5, 2.5x5 — sold per piece as accent/insert
  if (minDim <= 2.5 && maxDim <= 5) return 'Mosaic Insert';

  // Chair Rail: finish explicitly says "chair rail", narrow profile
  if (finishLower.includes('chair rail') && minDim <= 3 && maxDim <= 8) {
    return 'Chair Rail';
  }

  // Trim Liner: narrow (> 1" but < 2.5") with long edge (≥ 8")
  // Covers 2x15, 2x16, 2x18 — deco strips, roman trim, etc.
  if (minDim > 1 && minDim < 2.5 && maxDim >= 8) {
    if (finishLower.includes('deco')) return 'Deco Liner';
    if (finishLower.includes('roman')) return 'Trim Liner';
    return 'Trim Liner';
  }

  // Bullnose: 3" wide edge with longer side (≥ 8")
  // Standard surface bullnose — 3x12, 3x24, 3x36, 3x48
  if (minDim >= 2.5 && minDim <= 3 && maxDim >= 8) {
    return 'Bullnose';
  }

  return null;
}

/**
 * Determine sell_by from the size label.
 * Tiles (12x24, 24x48, 48x48) → 'box'
 * Mosaics (2x2, 1x4) → 'unit'
 * Bullnose/trim (3x24, 3x48) → 'unit'
 * Quarter Round (3/4x5) → 'unit'
 */
function determineSellBy(size, sizeLabel) {
  const label = (sizeLabel || '').toLowerCase();
  if (label.includes('mosaic') || label.includes('bullnose') || label.includes('surface')) {
    return 'unit';
  }

  const normalized = normalizeSize(size);
  if (!normalized) return 'box';

  const match = normalized.match(/^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/);
  if (!match) return 'box';

  const dim1 = parseFloat(match[1]);
  const dim2 = parseFloat(match[2]);
  const maxDim = Math.max(dim1, dim2);
  const minDim = Math.min(dim1, dim2);

  // Very narrow trim (quarter round, pencil liner): min dim < 1"
  if (minDim < 1) return 'unit';
  // Small tiles (mosaics): both dimensions ≤ 4
  if (maxDim <= 4) return 'unit';
  // Bullnose/trim: one dimension ≤ 3
  if (minDim <= 3) return 'unit';

  return 'box';
}

function resolveCategory(productData, categoryLookup) {
  const collectionLower = (productData.name || '').toLowerCase();

  // Explicit mosaic collections
  if (MOSAIC_COLLECTIONS.has(collectionLower)) {
    const catId = categoryLookup.get('mosaic-tile');
    if (catId) return { id: catId, slug: 'mosaic-tile' };
  }

  // Check website category labels and description keywords
  const text = [
    productData.specs.material || '',
    productData.description || '',
    productData.name || '',
  ].join(' ').toLowerCase();

  for (const [keyword, slug] of Object.entries(CATEGORY_MAP)) {
    if (text.includes(keyword)) {
      const catId = categoryLookup.get(slug);
      if (catId) return { id: catId, slug };
    }
  }

  // Default to porcelain-tile (all Bosphorus products are porcelain)
  return { id: categoryLookup.get('porcelain-tile') || null, slug: 'porcelain-tile' };
}

function slugify(str) {
  return (str || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Normalize image URL: collapse double slashes in path (but not in https://) */
function normalizeImgUrl(url) {
  if (!url) return url;
  return url.replace(/([^:])\/\//g, '$1/');
}

function stripTags(str) {
  return (str || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

/**
 * Clean a description that may contain double-encoded HTML entities.
 * Decodes entities first, strips HTML tags, then cleans up whitespace.
 */
function cleanDescription(str) {
  if (!str) return null;
  // Decode &amp; first to handle double-encoding like &amp;rdquo; → &rdquo;
  let s = str.replace(/&amp;/g, '&');
  // Named entity map
  const entities = {
    '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ',
    '&rdquo;': '"', '&ldquo;': '"', '&rsquo;': "'", '&lsquo;': "'",
    '&Prime;': '"', '&prime;': "'",
    '&mdash;': '—', '&ndash;': '–', '&hellip;': '...',
    '&bull;': '•', '&middot;': '·',
    '&times;': 'x', '&divide;': '÷',
    '&frac14;': '¼', '&frac12;': '½', '&frac34;': '¾',
    '&eacute;': 'é', '&egrave;': 'è', '&ecirc;': 'ê', '&euml;': 'ë',
    '&aacute;': 'á', '&agrave;': 'à', '&acirc;': 'â', '&atilde;': 'ã',
    '&iacute;': 'í', '&oacute;': 'ó', '&uacute;': 'ú', '&uuml;': 'ü',
    '&ntilde;': 'ñ', '&ccedil;': 'ç',
    '&deg;': '°', '&reg;': '®', '&trade;': '™', '&copy;': '©',
    '&amp;': '&',
  };
  for (const [ent, ch] of Object.entries(entities)) {
    s = s.split(ent).join(ch);
  }
  // Numeric character references: &#NNN; and &#xHHH;
  s = s.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  s = s.replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)));
  // Strip HTML tags
  s = s.replace(/<[^>]+>/g, ' ');
  // Clean whitespace
  s = s.replace(/\s+/g, ' ').trim();
  return s || null;
}
