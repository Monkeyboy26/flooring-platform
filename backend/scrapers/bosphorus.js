import {
  delay, upsertProduct, upsertSku,
  upsertSkuAttribute, upsertPackaging, upsertPricing,
  upsertMediaAsset, upsertInventorySnapshot,
  appendLog, addJobError, preferProductShot,
  normalizeSize, buildVariantName
} from './base.js';

/**
 * Bosphorus Imports catalog scraper.
 *
 * Server-rendered HTML — uses fetch(), no Puppeteer needed.
 * Paginates /products?page=1..N, extracts product-detail links,
 * then fetches each detail page for JSON-LD schema, variant_groups JS,
 * color/size/finish selects, specs table, images, and description.
 *
 * Product → SKU mapping:
 *   Collection (series) → Product (per color) → SKU (per color+size+finish)
 */

const BASE_URL = 'https://www.bosphorusimports.com';
const VENDOR_CODE = 'BOS';
const MAX_PAGES = 10; // safety limit
const DEFAULT_DELAY_MS = 800;

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
  'mosaic':         'mosaic-tile',
  'paver':          'pavers',
  'natural stone':  'natural-stone',
  'marble':         'natural-stone',
  'travertine':     'natural-stone',
  'limestone':      'natural-stone',
};

export async function run(pool, job, source) {
  const config = { delayMs: DEFAULT_DELAY_MS, ...(source.config || {}) };
  const vendor_id = source.vendor_id;

  const stats = {
    found: 0, created: 0, updated: 0,
    skusCreated: 0, imagesSet: 0, attributesSet: 0,
    packagingSet: 0, skipped: 0, errors: 0,
  };

  // Build slug → category_id lookup
  const categoryLookup = new Map();
  try {
    const catRows = await pool.query('SELECT id, slug FROM categories WHERE is_active = true');
    for (const row of catRows.rows) categoryLookup.set(row.slug, row.id);
  } catch {}

  const touchedProductIds = [];

  // ── Phase 1: Collect product detail URLs from listing pages ──

  await appendLog(pool, job.id, 'Phase 1: Collecting product URLs from listing pages...');

  const productUrls = [];
  const seenSlugs = new Set();

  for (let page = 1; page <= MAX_PAGES; page++) {
    try {
      const listUrl = `${BASE_URL}/products?page=${page}`;
      const resp = await fetchWithRetry(listUrl);
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

  stats.found = productUrls.length;
  await appendLog(pool, job.id, `Phase 1 complete: ${productUrls.length} product pages to scrape`, {
    products_found: stats.found,
  });

  // ── Phase 2: Fetch and parse each product detail page ──

  await appendLog(pool, job.id, 'Phase 2: Fetching product detail pages...');

  for (let i = 0; i < productUrls.length; i++) {
    const url = productUrls[i];

    try {
      const resp = await fetchWithRetry(url);
      const html = await resp.text();

      const productData = parseDetailPage(html, url);
      if (!productData || !productData.name) {
        stats.skipped++;
        continue;
      }

      // Resolve PIM category
      const { id: categoryId, slug: catSlug } = resolveCategory(productData, categoryLookup);

      // Group variants by color → one product per color
      const colorGroups = groupVariantsByColor(productData);

      for (const [colorName, variants] of colorGroups) {
        try {
          const product = await upsertProduct(pool, {
            vendor_id,
            name: colorName,
            collection: productData.name,
            category_id: categoryId,
            description_short: cleanDescription(productData.description)?.slice(0, 255) || null,
            description_long: cleanDescription(productData.description) || null,
          });

          if (product.is_new) stats.created++;
          else stats.updated++;
          touchedProductIds.push(product.id);

          // Collect color-specific images from variant carousel mapping
          const colorImages = getColorImagesFromVariants(
            productData.imagesByVariantId, variants, productData.images, colorName
          );

          // Product-level images (from color-specific carousel images, already sorted by preferProductShot)
          for (let gi = 0; gi < colorImages.length && gi < 6; gi++) {
            const assetType = gi === 0 ? 'primary' : 'alternate';
            await upsertMediaAsset(pool, {
              product_id: product.id,
              sku_id: null,
              asset_type: assetType,
              url: colorImages[gi],
              original_url: colorImages[gi],
              sort_order: gi,
            });
            stats.imagesSet++;
          }

          // Upsert each variant as a SKU
          for (let vi = 0; vi < variants.length; vi++) {
            const v = variants[vi];

            // Strip trailing finish/type text from size (e.g., "12"x24" Matte" → "12"x24"")
            const sizeClean = (v.size || '').replace(/\s+(Matte|Polished|Honed|Satin|Glossy|Natural|Textured|Grip|Rough|Lappato).*$/i, '');
            const sizeNorm = normalizeSize(sizeClean);
            const variantName = buildVariantName(sizeNorm, v.finish);
            // Mosaic category always sells per sheet; otherwise use size heuristic
            const sellBy = catSlug === 'mosaic-tile' ? 'unit' : determineSellBy(v.size, v.sizeLabel);

            const internalSku = buildInternalSku(productData.name, colorName, sizeNorm, v.finish);

            // Use vendorSku from variant data, or fall back to internal_sku
            const vendorSku = v.vendorSku || internalSku;

            const sku = await upsertSku(pool, {
              product_id: product.id,
              vendor_sku: vendorSku,
              internal_sku: internalSku,
              variant_name: variantName,
              sell_by: sellBy,
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
              ['finish', v.finish],
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

            // Packaging from specs (skip for mosaics — sold per sheet, not per box)
            if ((productData.specs.sqftPerBox || productData.specs.piecesPerBox) && catSlug !== 'mosaic-tile') {
              await upsertPackaging(pool, sku.id, {
                sqft_per_box: productData.specs.sqftPerBox || null,
                pieces_per_box: productData.specs.piecesPerBox || null,
                weight_per_box_lbs: productData.specs.boxWeight || null,
                boxes_per_pallet: productData.specs.palletCount || null,
                sqft_per_pallet: productData.specs.sqftPerPallet || null,
                weight_per_pallet_lbs: productData.specs.palletWeight || null,
              });
              stats.packagingSet++;
            }

            // SKU-level images skipped — product-level images already cover all
            // color-specific images, and SKUs (different sizes of same color) share them.
          }
        } catch (err) {
          stats.errors++;
          if (stats.errors <= 30) {
            await addJobError(pool, job.id, `${productData.name} / ${colorName}: ${err.message}`);
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
  }

  await appendLog(pool, job.id,
    `Scrape complete. Products: ${stats.created} new / ${stats.updated} updated, ` +
    `SKUs: ${stats.skusCreated}, Images: ${stats.imagesSet}, Attributes: ${stats.attributesSet}, ` +
    `Packaging: ${stats.packagingSet}, Skipped: ${stats.skipped}, Errors: ${stats.errors}`,
    {
      products_found: stats.found,
      products_created: stats.created,
      products_updated: stats.updated,
      skus_created: stats.skusCreated,
    }
  );
}

// ─── Fetch with retry ─────────────────────────────────────────────────────────

async function fetchWithRetry(url, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const resp = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'text/html,application/xhtml+xml',
        },
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
    specs: {},
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
          price: parseFloat(val.Price) || 0,
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
    else if (label.includes('box weight')) result.specs.boxWeight = parseFloat(value.replace(/[^0-9.]/g, '')) || null;
    else if (label.includes('sq ft per box') || label.includes('sqft per box')) result.specs.sqftPerBox = parseFloat(value.replace(/[^0-9.]/g, '')) || null;
    else if (label.includes('box count') || label.includes('pieces per box')) result.specs.piecesPerBox = parseInt(value) || null;
    else if (label.includes('pallet weight')) result.specs.palletWeight = parseFloat(value.replace(/[^0-9.,]/g, '').replace(',', '')) || null;
    else if (label.includes('sq ft per pallet') || label.includes('sqft per pallet')) result.specs.sqftPerPallet = parseFloat(value.replace(/[^0-9.]/g, '')) || null;
    else if (label.includes('pallet count') || label.includes('boxes per pallet')) result.specs.palletCount = parseInt(value) || null;
    else if (label.includes('minimum')) result.specs.minimumPurchase = value;
  }

  // ── Parse carousel thumbnails → variant-specific images ──
  // <swiper-slide data-product-id="8469"><img src=".../th-calypso-0.jpg"/></swiper-slide>
  const thumbSlideRegex = /data-product-id="(\d+)"[^>]*>\s*<img[^>]*src="([^"]+)"/g;
  let thumbMatch;
  while ((thumbMatch = thumbSlideRegex.exec(html)) !== null) {
    const variantPid = thumbMatch[1];
    const thumbUrl = thumbMatch[2];
    // Convert thumbnail URL to full-size by removing th- prefix, normalize path
    const fullUrl = normalizeImgUrl(thumbUrl.replace(/\/th-/, '/'));
    if (!result.imagesByVariantId.has(variantPid)) {
      result.imagesByVariantId.set(variantPid, []);
    }
    const existing = result.imagesByVariantId.get(variantPid);
    const base = fullUrl.split('?')[0];
    if (!existing.some(u => u.split('?')[0] === base)) {
      existing.push(fullUrl);
    }
  }

  // ── Parse gallery images from HTML (collection-level fallback) ──
  const imgRegex = /src="(https?:\/\/www\.bosphorusimports\.com\/cdn\/uploads\/capsule\/products\/[^"]+)"/g;
  const seenImgs = new Set(result.images.map(u => u.split('?')[0]));
  let imgMatch;
  while ((imgMatch = imgRegex.exec(html)) !== null) {
    const imgUrl = normalizeImgUrl(imgMatch[1]);
    // Skip thumbnails (th- prefix)
    if (/\/th-/.test(imgUrl)) continue;
    const base = imgUrl.split('?')[0];
    if (!seenImgs.has(base)) {
      seenImgs.add(base);
      result.images.push(imgUrl);
    }
  }

  // Sort images: product shots first
  result.images = preferProductShot(result.images);

  return result;
}

/**
 * Parse <select> options for a given attribute name (Color, Size, Finish).
 * Looks for the label text followed by option tags with data-product-attribute-value.
 */
function parseSelectOptions(html, attributeName) {
  const options = [];

  // Find the form-field containing this attribute label
  const labelRegex = new RegExp(
    `<label[^>]*>[^<]*${attributeName}[^<]*<\\/label>[\\s\\S]*?<select[^>]*>([\\s\\S]*?)<\\/select>`,
    'i'
  );
  const selectMatch = html.match(labelRegex);

  if (selectMatch) {
    const selectHtml = selectMatch[1];
    const optionRegex = /data-product-attribute-value="(\d+)"[^>]*>([^<]+)</g;
    let optMatch;
    while ((optMatch = optionRegex.exec(selectHtml)) !== null) {
      options.push({ id: optMatch[1], text: optMatch[2].trim() });
    }
  }

  // Fallback: look for radio/swatch options
  if (options.length === 0) {
    const swatchRegex = new RegExp(
      `${attributeName}[\\s\\S]{0,500}?data-product-attribute-value="(\\d+)"[^>]*>[\\s\\S]*?<span[^>]*>([^<]+)`,
      'gi'
    );
    let swMatch;
    while ((swMatch = swatchRegex.exec(html)) !== null) {
      if (!options.find(o => o.id === swMatch[1])) {
        options.push({ id: swMatch[1], text: swMatch[2].trim() });
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
  const sizePattern = /(?:\d+"?\s+)?\d+(?:\/\d+|\.\d*)?"?\s*x\s*(?:\d+"?\s+)?\d+(?:\/\d+|\.\d*)?"?/i;

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
    // No variants parsed — create a single group from the collection name
    // Use colors from specs if available
    const colors = productData.specs.seriesColors
      ? productData.specs.seriesColors.split(',').map(c => c.trim()).filter(Boolean)
      : [productData.name];

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
    const color = v.color || 'Default';
    if (!groups.has(color)) groups.set(color, []);
    groups.get(color).push(v);
  }

  return groups;
}

// ─── Image helpers ────────────────────────────────────────────────────────────

/**
 * Get images for a specific color by collecting images from the carousel
 * thumbnail → variant mapping. Each carousel image is associated with a
 * specific variant product ID via data-product-id. We collect images from
 * all variants of the same color.
 *
 * Falls back to URL-based matching, then all images if no mapping exists.
 */
function getColorImagesFromVariants(imagesByVariantId, colorVariants, allImages, colorName) {
  // Use carousel matching only if multiple product-ids exist.
  // A single product-id means a "flat" carousel with no per-variant mapping.
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
    if (colorImgs.length > 0) return preferProductShot(colorImgs, colorName);
  }

  // URL-based matching with cascading specificity (most strict → least strict)
  if (allImages && allImages.length > 0) {
    const colorLower = colorName.toLowerCase();
    const colorSlug = colorLower.replace(/[^a-z0-9]+/g, '');
    const colorWords = colorLower.split(/[^a-z0-9]+/).filter(w => w.length >= 3);
    const numMatch = colorName.match(/^(\d+)\s/);
    const colorNum = numMatch ? numMatch[1] : null;
    const isColorMix = colorLower.includes('mix');
    let matched;

    // Helper: check if a word appears as a whole segment in a filename
    // (split on _ and -) to prevent "abi" matching inside "sabi"
    const fnHasWord = (fn, word) => {
      const segments = fn.split(/[_\-]+/);
      return segments.some(seg => seg === word || seg.startsWith(word + 's'));
    };

    // Helper: exclude mix images when matching non-mix colors, and vice versa.
    // Prevents "mio_mix_crayonsand_fog__46231.jpg" from matching plain "Fog".
    const isMixImage = (fn) => fnHasWord(fn, 'mix');
    const mixFilter = (url) => {
      const fn = url.split('/').pop().split('?')[0].toLowerCase();
      if (isColorMix) return true;           // Mix color: allow all images
      return !isMixImage(fn);                // Non-mix color: exclude mix images
    };

    // 1. Full slug match (e.g., "amibasalt" in filename)
    matched = allImages.filter(url => {
      const fn = url.split('/').pop().split('?')[0].toLowerCase();
      return (fn.includes(colorSlug) || fn.includes(colorLower.replace(/\s+/g, '-'))) && mixFilter(url);
    });
    if (matched.length > 0) return preferProductShot(matched, colorName);

    // 2. ALL words match (AND logic, word-boundary) — most precise for multi-word names
    if (colorWords.length >= 2) {
      matched = allImages.filter(url => {
        const fn = url.split('/').pop().split('?')[0].toLowerCase();
        return colorWords.every(w => fnHasWord(fn, w)) && mixFilter(url);
      });
      if (matched.length > 0) return preferProductShot(matched, colorName);
    }

    // 3. Number prefix match (e.g., "style_1__" for "1 Ravello")
    if (colorNum) {
      matched = allImages.filter(url => {
        const fn = url.split('/').pop().split('?')[0].toLowerCase();
        const numPattern = new RegExp(`[_\\-]${colorNum}[_\\-]|^${colorNum}[_\\-]|[_\\-]${colorNum}\\b`);
        return numPattern.test(fn) && mixFilter(url);
      });
      if (matched.length > 0) return preferProductShot(matched, colorName);
    }

    // 4. ANY word match (OR logic, word-boundary) — least strict, last URL-based attempt
    if (colorWords.length > 0) {
      matched = allImages.filter(url => {
        const fn = url.split('/').pop().split('?')[0].toLowerCase();
        return colorWords.some(w => fnHasWord(fn, w)) && mixFilter(url);
      });
      if (matched.length > 0) return preferProductShot(matched, colorName);
    }
  }

  // Last resort: shared images (capped at 3)
  return (allImages || []).slice(0, 3);
}

// ─── SKU and category helpers ─────────────────────────────────────────────────

function buildInternalSku(collection, color, size, finish) {
  const parts = [VENDOR_CODE, slugify(collection), slugify(color)];
  if (size) parts.push(slugify(size));
  if (finish) parts.push(slugify(finish));
  return parts.join('-');
}

/**
 * Determine sell_by from the size label.
 * Tiles (12x24, 24x48, 48x48) → 'sqft'
 * Mosaics (2x2, 1x4) → 'unit'
 * Bullnose/trim (3x24, 3x48) → 'unit'
 */
function determineSellBy(size, sizeLabel) {
  const label = (sizeLabel || '').toLowerCase();
  if (label.includes('mosaic') || label.includes('bullnose') || label.includes('surface')) {
    return 'unit';
  }

  const normalized = normalizeSize(size);
  if (!normalized) return 'sqft';

  const match = normalized.match(/^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/);
  if (!match) return 'sqft';

  const dim1 = parseFloat(match[1]);
  const dim2 = parseFloat(match[2]);
  const maxDim = Math.max(dim1, dim2);
  const minDim = Math.min(dim1, dim2);

  // Small tiles (mosaics): both dimensions ≤ 4
  if (maxDim <= 4) return 'unit';
  // Bullnose/trim: one dimension ≤ 3 and other > 12
  if (minDim <= 3 && maxDim >= 12) return 'unit';

  return 'sqft';
}

function resolveCategory(productData, categoryLookup) {
  // Check material and description keywords
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

  // Default to porcelain-tile (most Bosphorus products are porcelain)
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
