/**
 * Western Pacific Tile (WPT) Scraper
 *
 * Data source: Ecwid e-commerce API (no Puppeteer needed)
 * Store ID: 15639056
 * Public token: public_Ye667ZXjf3nA8vCq1snpZEs81QfUKmqF
 *
 * Hierarchy:
 *   Ecwid top-level category (Floor Tile / Mosaic / Wall Tile) → DB category_id
 *   Ecwid sub-category (Sabik, Alcazar, etc.) → DB products.collection
 *   Ecwid product (Sabik Miel, Sabik Natural) → DB products.name + individual SKU
 *
 * Images come from the Ecwid product media (originalImageUrl + galleryImages).
 * Pricing comes separately from the wholesale PDF price list (see import-wpt-pricing.cjs).
 */

import {
  delay,
  normalizeSize,
  upsertProduct,
  upsertSku,
  upsertSkuAttribute,
  upsertMediaAsset,
  upsertPricing,
  upsertPackaging,
  appendLog,
  addJobError,
  saveProductImages,
  fuzzyMatch,
} from './base.js';

// ── Ecwid API config ────────────────────────────────────────────────
const ECWID_STORE_ID = 15639056;
const ECWID_PUBLIC_TOKEN = 'public_Ye667ZXjf3nA8vCq1snpZEs81QfUKmqF';
const ECWID_API_BASE = `https://app.ecwid.com/api/v3/${ECWID_STORE_ID}`;

// Top-level Ecwid category IDs
const TOP_CATEGORIES = {
  198732037: 'Floor Tile',
  41263850:  'Mosaic',
  41375295:  'Wall Tile',
};

// ── Helpers ─────────────────────────────────────────────────────────

async function ecwidGet(endpoint, params = {}) {
  const url = new URL(`${ECWID_API_BASE}${endpoint}`);
  url.searchParams.set('token', ECWID_PUBLIC_TOKEN);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const resp = await fetch(url.toString(), {
    headers: { 'Accept': 'application/json' },
    signal: AbortSignal.timeout(30000),
  });
  if (!resp.ok) throw new Error(`Ecwid API ${resp.status}: ${endpoint}`);
  return resp.json();
}

/**
 * Fetch all categories from Ecwid.
 * Returns { id, name, parentId, productCount, description }[]
 */
async function fetchCategories() {
  const data = await ecwidGet('/categories', { limit: 200 });
  return data.items || data.categories || [];
}

/**
 * Fetch all products for a category (handles pagination).
 */
async function fetchCategoryProducts(categoryId) {
  const products = [];
  let offset = 0;
  const limit = 100;

  while (true) {
    const data = await ecwidGet('/products', { category: categoryId, limit, offset });
    const items = data.items || [];
    products.push(...items);
    if (items.length < limit) break;
    offset += limit;
    await delay(300); // rate limit courtesy
  }

  return products;
}

/**
 * Fetch single product with full details (gallery images, media, etc.).
 */
async function fetchProduct(productId) {
  return ecwidGet(`/products/${productId}`);
}

/**
 * Parse a WPT product description for structured attributes.
 *
 * Typical formats:
 *   "9\" X 47\" Rectified Porcelain Tile. Wood Look / Matte / Frost Proof / InOut Finish / Moderated Shade Variation: V3"
 *   "12\" x 12\" Mesh Mounted Mosaic"
 *   "24\" X 48\" Glossy Rectified Tile, V4 high variation"
 */
function parseDescription(desc) {
  if (!desc) return {};
  // Strip HTML tags
  const text = desc.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

  const attrs = {};

  // Extract size: "9" X 47"" or "9 X 47" or similar
  const sizeMatch = text.match(/(\d+(?:[\/\.]\d+)?)\s*["″]?\s*[xX×]\s*(\d+(?:[\/\.]\d+)?)\s*["″]?/);
  if (sizeMatch) {
    attrs.size = `${sizeMatch[1]}x${sizeMatch[2]}`;
  }

  const lower = text.toLowerCase();

  // Material type
  if (lower.includes('porcelain')) attrs.material = 'Porcelain';
  else if (lower.includes('ceramic')) attrs.material = 'Ceramic';
  else if (lower.includes('glass')) attrs.material = 'Glass';
  else if (lower.includes('stone')) attrs.material = 'Natural Stone';
  else if (lower.includes('mosaic')) attrs.material = 'Mosaic';

  // Finish
  if (lower.includes('polished')) attrs.finish = 'Polished';
  else if (lower.includes('glossy') || lower.includes('gloss')) attrs.finish = 'Glossy';
  else if (lower.includes('matte') || lower.includes('matt')) attrs.finish = 'Matte';
  else if (lower.includes('honed')) attrs.finish = 'Honed';
  else if (lower.includes('semi-polish')) attrs.finish = 'Semi-Polished';
  else if (lower.includes('satin')) attrs.finish = 'Satin';

  // Edge
  if (lower.includes('rectified')) attrs.edge = 'Rectified';
  else if (lower.includes('pressed')) attrs.edge = 'Pressed';

  // Color variation
  const variationMatch = text.match(/(?:shade\s*)?variation[:\s]*v(\d+)/i);
  if (variationMatch) attrs.color_variation = `V${variationMatch[1]}`;

  // Look
  if (lower.includes('wood look')) attrs.look = 'Wood';
  else if (lower.includes('marble look') || lower.includes('marble')) attrs.look = 'Marble';
  else if (lower.includes('concrete') || lower.includes('cement')) attrs.look = 'Concrete';
  else if (lower.includes('stone look')) attrs.look = 'Stone';

  // Installation
  if (lower.includes('floor or wall') || lower.includes('wall / floor') || lower.includes('floor/wall')) {
    attrs.installation = 'Floor & Wall';
  } else if (lower.includes('wall')) {
    attrs.installation = 'Wall';
  } else if (lower.includes('floor')) {
    attrs.installation = 'Floor';
  }

  // Mesh mounted (mosaics)
  if (lower.includes('mesh mounted') || lower.includes('mesh-mounted')) {
    attrs.mounting = 'Mesh Mounted';
  }

  return attrs;
}

/**
 * Derive the color name from a product name and its collection.
 * "Sabik Miel" with collection "Sabik" → "Miel"
 * "Dorne Beige 24 x 47" with collection "Dorne" → "Beige"
 */
function deriveColor(productName, collectionName) {
  if (!productName || !collectionName) return productName || '';
  let color = productName;

  // Strip collection prefix (case-insensitive)
  const re = new RegExp(`^${collectionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*`, 'i');
  color = color.replace(re, '').trim();

  // Strip trailing dimensions (e.g., "24 x 47", "9x48", "12x24")
  color = color.replace(/\s*\d+(?:["″])?\s*[xX×]\s*\d+(?:["″])?\s*$/, '').trim();

  // Strip trailing size descriptors
  color = color.replace(/\s+\d+["″]?\s*$/, '').trim();

  return color || productName;
}

/**
 * Determine sell_by based on Ecwid product context.
 * Mosaics sold by sheet → 'unit'
 * Tiles sold by sqft → 'sqft'
 * Accessories (bullnose, quarter round) → 'unit'
 */
function determineSellBy(productName, categoryName) {
  const lower = (productName + ' ' + categoryName).toLowerCase();
  if (lower.includes('mosaic')) return 'unit';
  if (lower.includes('bullnose') || lower.includes('quarter round') || lower.includes('trim')) return 'unit';
  return 'sqft';
}

/**
 * Determine variant_type from the top-level category.
 */
function determineVariantType(topCategoryName) {
  switch (topCategoryName) {
    case 'Floor Tile': return 'floor_tile';
    case 'Wall Tile': return 'wall_tile';
    case 'Mosaic': return 'mosaic';
    default: return null;
  }
}

/**
 * Build a stable internal_sku for WPT products.
 * Uses the Ecwid product ID for uniqueness.
 */
function buildInternalSku(ecwidSku, productName, collectionName) {
  // Prefer vendor's SKU if meaningful (not just a sequential number)
  // WPT's Ecwid SKUs are just numbers like "00234", not useful identifiers
  // Build from collection + color instead
  const slug = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  const collection = slug(collectionName);
  const color = slug(deriveColor(productName, collectionName));
  return `WPT-${collection}-${color}`.replace(/-+/g, '-').replace(/-$/, '');
}

// ── Main scraper ────────────────────────────────────────────────────

export async function run(pool, opts = {}) {
  const { jobId } = opts;
  const log = (msg) => jobId ? appendLog(pool, jobId, msg).catch(() => {}) : console.log(msg);

  const stats = {
    categoriesFound: 0,
    productsFound: 0,
    productsCreated: 0,
    productsUpdated: 0,
    skusCreated: 0,
    skusUpdated: 0,
    imagesSaved: 0,
    errors: 0,
  };

  try {
    // ── 1. Ensure WPT vendor exists ────────────────────────────────
    let vendorResult = await pool.query(
      `SELECT id FROM vendors WHERE LOWER(name) LIKE '%western pacific%' OR LOWER(name) LIKE '%wpt%' LIMIT 1`
    );
    let vendorId;
    if (vendorResult.rows.length) {
      vendorId = vendorResult.rows[0].id;
      await log(`Found existing vendor: id=${vendorId}`);
    } else {
      const ins = await pool.query(
        `INSERT INTO vendors (name, code, website, is_active) VALUES ($1, $2, $3, true) RETURNING id`,
        ['Western Pacific Tile', 'wpt', 'https://westernpacifictile.com']
      );
      vendorId = ins.rows[0].id;
      await log(`Created vendor "Western Pacific Tile": id=${vendorId}`);
    }

    // ── 2. Resolve DB category IDs ─────────────────────────────────
    // Map WPT Ecwid top-level categories to our DB categories
    const DB_CATEGORY_MAP = {
      'Floor Tile': 'Porcelain Tile',
      'Mosaic':     'Mosaic Tile',
      'Wall Tile':  'Backsplash & Wall Tile',
    };
    const categoryMap = {}; // topCategoryId → DB category_id
    for (const [ecwidCatId, catName] of Object.entries(TOP_CATEGORIES)) {
      const dbCatName = DB_CATEGORY_MAP[catName] || catName;
      const catResult = await pool.query(
        `SELECT id FROM categories WHERE LOWER(name) = LOWER($1) LIMIT 1`,
        [dbCatName]
      );
      if (catResult.rows.length) {
        categoryMap[ecwidCatId] = catResult.rows[0].id;
        await log(`Mapped "${catName}" → "${dbCatName}" (category_id=${catResult.rows[0].id})`);
      } else {
        await log(`Warning: No DB category found for "${dbCatName}", products will have NULL category_id`);
        categoryMap[ecwidCatId] = null;
      }
    }

    // ── 3. Fetch Ecwid category tree ───────────────────────────────
    await log('Fetching Ecwid categories...');
    const ecwidCategories = await fetchCategories();
    stats.categoriesFound = ecwidCategories.length;
    await log(`Found ${ecwidCategories.length} Ecwid categories`);

    // Build parent→children map and id→category lookup
    const catById = {};
    for (const cat of ecwidCategories) catById[cat.id] = cat;

    // Find sub-categories under our 3 top-level categories
    // Deduplicate by normalized name (e.g., "Ceppo Di Gre" vs "Ceppo Di Gré")
    const seenCollections = new Set();
    const subCategories = ecwidCategories.filter(c => {
      if (!c.parentId || !TOP_CATEGORIES[c.parentId]) return false;
      const normName = (c.name || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
      if (seenCollections.has(normName)) return false;
      seenCollections.add(normName);
      return true;
    });
    await log(`Found ${subCategories.length} sub-categories to process`);

    // ── 4. Process each sub-category (collection) ──────────────────
    for (const subCat of subCategories) {
      const topCatName = TOP_CATEGORIES[subCat.parentId];
      const collectionName = subCat.name;
      const dbCategoryId = categoryMap[subCat.parentId] || null;
      const variantType = determineVariantType(topCatName);

      await log(`\n── ${topCatName} > ${collectionName} (ecwid cat ${subCat.id}) ──`);

      // Fetch all products in this sub-category
      let products;
      try {
        products = await fetchCategoryProducts(subCat.id);
      } catch (err) {
        await log(`ERROR fetching products for ${collectionName}: ${err.message}`);
        stats.errors++;
        continue;
      }

      if (!products.length) {
        await log(`  No products found, skipping`);
        continue;
      }

      await log(`  ${products.length} products found`);
      stats.productsFound += products.length;

      // Parse collection-level description for shared attributes
      const collectionAttrs = parseDescription(subCat.description || '');

      for (const ecwidProduct of products) {
        try {
          // Fetch full product details (with gallery images)
          const fullProduct = await fetchProduct(ecwidProduct.id);
          await delay(200); // rate limit

          const productName = (fullProduct.name || '').trim();
          if (!productName) continue;

          const color = deriveColor(productName, collectionName);
          const sellBy = determineSellBy(productName, topCatName);

          // Parse product-specific description
          const productAttrs = {
            ...collectionAttrs,
            ...parseDescription(fullProduct.description || ''),
          };

          // Build description from parsed text
          const descText = (fullProduct.description || '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/&quot;/g, '"')
            .replace(/&amp;/g, '&')
            .replace(/\s+/g, ' ')
            .trim();

          // ── Upsert product ──
          const productResult = await upsertProduct(pool, {
            vendor_id: vendorId,
            name: productName,
            collection: collectionName,
            category_id: dbCategoryId,
            description_short: descText.slice(0, 500) || null,
            description_long: descText || null,
          }, { jobId });

          const productId = productResult.id;
          if (productResult.is_new) stats.productsCreated++;
          else stats.productsUpdated++;

          // ── Upsert SKU ──
          const internalSku = buildInternalSku(fullProduct.sku, productName, collectionName);
          const variantName = productAttrs.size
            ? `${normalizeSize(productAttrs.size)}${productAttrs.finish ? ', ' + productAttrs.finish : ''}`
            : null;

          const skuResult = await upsertSku(pool, {
            product_id: productId,
            vendor_sku: fullProduct.sku || '',
            internal_sku: internalSku,
            variant_name: variantName,
            sell_by: sellBy,
            variant_type: variantType,
          }, { jobId });

          const skuId = skuResult.id;
          if (skuResult.is_new) stats.skusCreated++;
          else stats.skusUpdated++;

          // ── Set attributes ──
          if (productAttrs.size) await upsertSkuAttribute(pool, skuId, 'size', productAttrs.size);
          if (color) await upsertSkuAttribute(pool, skuId, 'color', color);
          if (productAttrs.finish) await upsertSkuAttribute(pool, skuId, 'finish', productAttrs.finish);
          if (productAttrs.material) await upsertSkuAttribute(pool, skuId, 'material', productAttrs.material);
          if (productAttrs.edge) await upsertSkuAttribute(pool, skuId, 'edge', productAttrs.edge);
          if (productAttrs.look) await upsertSkuAttribute(pool, skuId, 'style', productAttrs.look);

          // ── Save images ──
          const imageUrls = [];

          // Primary image (original high-res)
          if (fullProduct.originalImageUrl) {
            imageUrls.push(fullProduct.originalImageUrl);
          } else if (fullProduct.imageUrl) {
            imageUrls.push(fullProduct.imageUrl);
          }

          // Gallery images
          if (fullProduct.galleryImages) {
            for (const gi of fullProduct.galleryImages) {
              const url = gi.originalImageUrl || gi.imageUrl || gi.url;
              if (url && !imageUrls.includes(url)) imageUrls.push(url);
            }
          }

          // Alternative: use media array if available
          if (!imageUrls.length && fullProduct.media?.images) {
            for (const mi of fullProduct.media.images) {
              const url = mi.imageOriginalUrl || mi.image1500pxUrl || mi.image800pxUrl;
              if (url && !imageUrls.includes(url)) imageUrls.push(url);
            }
          }

          if (imageUrls.length) {
            const saved = await saveProductImages(pool, productId, imageUrls, { maxImages: 6 });
            stats.imagesSaved += saved;
          }

          await log(`  ✓ ${productName} → SKU ${internalSku} (${imageUrls.length} images)`);

        } catch (err) {
          await log(`  ERROR processing "${ecwidProduct.name}": ${err.message}`);
          if (jobId) addJobError(pool, jobId, `Product "${ecwidProduct.name}": ${err.message}`).catch(() => {});
          stats.errors++;
        }
      }
    }

    // ── 5. Also process products directly under top-level categories ──
    // Some products may be directly in Floor Tile / Mosaic / Wall Tile without a sub-category
    for (const [ecwidCatId, topCatName] of Object.entries(TOP_CATEGORIES)) {
      const dbCategoryId = categoryMap[ecwidCatId] || null;
      const variantType = determineVariantType(topCatName);

      // Get products that are directly in this top-level category
      // (not in any sub-category)
      let products;
      try {
        products = await fetchCategoryProducts(parseInt(ecwidCatId));
      } catch (err) {
        continue;
      }

      // Filter out products we already processed (those in sub-categories)
      const processedEcwidIds = new Set();
      for (const subCat of subCategories) {
        if (subCat.parentId === parseInt(ecwidCatId)) {
          try {
            const subProds = await fetchCategoryProducts(subCat.id);
            for (const p of subProds) processedEcwidIds.add(p.id);
          } catch (err) { /* skip */ }
        }
      }

      const directProducts = products.filter(p => !processedEcwidIds.has(p.id));
      if (!directProducts.length) continue;

      await log(`\n── ${topCatName} (direct products: ${directProducts.length}) ──`);

      for (const ecwidProduct of directProducts) {
        try {
          const fullProduct = await fetchProduct(ecwidProduct.id);
          await delay(200);

          const productName = (fullProduct.name || '').trim();
          if (!productName) continue;

          const productAttrs = parseDescription(fullProduct.description || '');
          const sellBy = determineSellBy(productName, topCatName);
          const descText = (fullProduct.description || '')
            .replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
            .replace(/\s+/g, ' ').trim();

          const productResult = await upsertProduct(pool, {
            vendor_id: vendorId,
            name: productName,
            collection: topCatName,
            category_id: dbCategoryId,
            description_short: descText.slice(0, 500) || null,
          }, { jobId });

          const internalSku = buildInternalSku(fullProduct.sku, productName, topCatName);

          const skuResult = await upsertSku(pool, {
            product_id: productResult.id,
            vendor_sku: fullProduct.sku || '',
            internal_sku: internalSku,
            sell_by: sellBy,
            variant_type: variantType,
          }, { jobId });

          if (productResult.is_new) stats.productsCreated++;
          else stats.productsUpdated++;
          if (skuResult.is_new) stats.skusCreated++;
          else stats.skusUpdated++;

          // Attributes
          if (productAttrs.size) await upsertSkuAttribute(pool, skuResult.id, 'size', productAttrs.size);
          if (productAttrs.finish) await upsertSkuAttribute(pool, skuResult.id, 'finish', productAttrs.finish);
          if (productAttrs.material) await upsertSkuAttribute(pool, skuResult.id, 'material', productAttrs.material);

          // Images
          const imageUrls = [];
          if (fullProduct.originalImageUrl) imageUrls.push(fullProduct.originalImageUrl);
          if (fullProduct.galleryImages) {
            for (const gi of fullProduct.galleryImages) {
              const url = gi.originalImageUrl || gi.imageUrl;
              if (url && !imageUrls.includes(url)) imageUrls.push(url);
            }
          }
          if (imageUrls.length) {
            stats.imagesSaved += await saveProductImages(pool, productResult.id, imageUrls, { maxImages: 6 });
          }

          await log(`  ✓ ${productName} → ${internalSku}`);
          stats.productsFound++;
        } catch (err) {
          stats.errors++;
        }
      }
    }

    // ── Summary ────────────────────────────────────────────────────
    await log(`\n═══ WPT Scrape Complete ═══`);
    await log(`Categories: ${stats.categoriesFound}`);
    await log(`Products found: ${stats.productsFound}`);
    await log(`Products created: ${stats.productsCreated}, updated: ${stats.productsUpdated}`);
    await log(`SKUs created: ${stats.skusCreated}, updated: ${stats.skusUpdated}`);
    await log(`Images saved: ${stats.imagesSaved}`);
    await log(`Errors: ${stats.errors}`);

    if (jobId) {
      await appendLog(pool, jobId, 'Scrape completed', {
        products_found: stats.productsFound,
        products_created: stats.productsCreated,
        products_updated: stats.productsUpdated,
        skus_created: stats.skusCreated,
      });
    }

    return stats;

  } catch (err) {
    await log(`FATAL ERROR: ${err.message}`);
    if (jobId) await addJobError(pool, jobId, err.message);
    throw err;
  }
}
