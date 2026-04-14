import {
  launchBrowser, delay, upsertProduct, upsertSku,
  upsertSkuAttribute, upsertPackaging, upsertPricing,
  upsertInventorySnapshot,
  appendLog, addJobError, upsertMediaAsset,
  normalizeSize, buildVariantName
} from './base.js';

const DEFAULT_CONFIG = {
  categories: [
    // Tile
    '/en/product/list/porcelain/',
    '/en/product/list/ceramic-tiles/',
    '/en/product/list/marble-tiles/',
    '/en/product/list/travertine-tiles/',
    '/en/product/list/slate-tiles/',
    '/en/product/list/granite-tiles/',
    '/en/product/list/limestone-tiles/',
    '/en/product/list/glass-tiles/',
    // Specialty
    '/en/product/list/mosaic/',
    '/en/product/list/subway-tiles/',
    '/en/product/list/decorative-tiles/',
    '/en/product/list/large-format/',
    '/en/product/list/zellige-tiles/',
    // Wood & Vinyl
    '/en/product/list/vinyl-flooring/',
    '/en/product/list/wood-look-tile/',
    // Outdoor
    '/en/product/list/outdoor/',
    '/en/product/list/pavers/',
    // Slabs
    '/en/product/list/slabs/',
    // Trim & Installation
    '/en/product/list/trim-tiles/',
    // Engineered Wood
    '/en/product/list/engineered-wood/',
    '/en/product/list/engineered-hdf-wood/',
  ],
  perPage: 180,
  delayMs: 1500,
  scrapeDetails: true,
};

// Max gallery images per SKU (primary + lifestyle + 6 alternate)
const MAX_GALLERY_IMAGES = 8;

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Cloudinary base URL for constructing image URLs from ImageName
const CLOUDINARY_BASE = 'https://res.cloudinary.com/bedrosians/image/upload';
const PRODUCT_IMAGE_PATH = 'cdn-bedrosian/assets/products/hiresimages';

/**
 * Maps Bedrosians MaterialType values to PIM category slugs.
 */
const CATEGORY_MAP = {
  'porcelain': 'porcelain-tile',
  'ceramic': 'ceramic-tile',
  'marble': 'natural-stone',
  'travertine': 'natural-stone',
  'slate': 'natural-stone',
  'granite': 'natural-stone',
  'limestone': 'natural-stone',
  'glass': 'mosaic-tile',
  'vinyl': 'lvp-plank',
  'lvt': 'lvp-plank',
  'lvp': 'lvp-plank',
  'hardwood': 'engineered-hardwood',
  'engineered hdf wood': 'engineered-hardwood',
  'quartzite': 'natural-stone',
  'soapstone': 'natural-stone',
  'onyx': 'natural-stone',
  'sandstone': 'natural-stone',
  'basalt': 'natural-stone',
};

/**
 * Bedrosians scraper.
 *
 * Bedrosians is an AngularJS app that embeds structured product data in
 * <script> tags as JS objects. We extract this JSON from page source
 * instead of parsing the rendered DOM — much faster and more reliable.
 *
 * Listing pages embed: window.bdApp.value('$model', { products: [...] })
 *   → pricing (PriceToDisplay), inventory (OnHand/Availability), images (ImageName/AlternativeImageUrl)
 *
 * Detail pages embed: window.bdApp.value('productDetailModel', {...})
 *   → packaging (Packaging[]), technical specs (Properties[]), description, tearsheets (Resources[])
 *
 * Flow:
 *   1. Collect products from listing pages (embedded JSON)
 *   2. Upsert products, SKUs, pricing, inventory, images from listing data
 *   3. Scrape detail pages for packaging, properties, description, gallery
 *   4. Bulk activate products
 */
export async function run(pool, job, source) {
  const config = { ...DEFAULT_CONFIG, ...(source.config || {}) };
  const baseUrl = source.base_url.replace(/\/$/, '');
  const vendor_id = source.vendor_id;

  let browser;
  const stats = {
    found: 0, created: 0, updated: 0, skusCreated: 0,
    imagesSet: 0, pricingSet: 0, inventorySet: 0,
    packagingSet: 0, errors: 0,
  };

  // Build slug → category_id lookup from DB
  const categoryLookup = new Map();
  try {
    const catRows = await pool.query('SELECT id, slug FROM categories WHERE is_active = true');
    for (const row of catRows.rows) {
      categoryLookup.set(row.slug, row.id);
    }
  } catch (err) {
    // Non-fatal — products will just have null category_id
  }

  // Track product IDs touched in this run for bulk activation
  const touchedProductIds = [];

  try {
    await appendLog(pool, job.id, 'Launching browser...');
    browser = await launchBrowser();

    // ── Phase 1: Collect all products from listing pages ──
    const allProducts = new Map(); // keyed by ProductCode for dedup

    for (const categoryPath of config.categories) {
      await appendLog(pool, job.id, `Scraping category: ${categoryPath}`);

      try {
        const products = await scrapeListingPages(browser, baseUrl, categoryPath, config);
        let newInCategory = 0;
        for (const p of products) {
          if (p.ProductCode && !allProducts.has(p.ProductCode)) {
            allProducts.set(p.ProductCode, p);
            newInCategory++;
          }
        }
        await appendLog(pool, job.id, `Found ${products.length} products in ${categoryPath} (${newInCategory} new, ${products.length - newInCategory} duplicates)`);
      } catch (err) {
        await appendLog(pool, job.id, `ERROR scraping ${categoryPath}: ${err.message}`);
        await addJobError(pool, job.id, `Category ${categoryPath}: ${err.message}`);
      }
    }

    stats.found = allProducts.size;
    await appendLog(pool, job.id, `Total unique products across all categories: ${stats.found}`, {
      products_found: stats.found
    });

    // Close browser during Phase 2 (DB-only) to free memory for later detail scraping
    if (browser) { await browser.close(); browser = null; }

    // ── Phase 2: Upsert products, SKUs, pricing, inventory, images ──
    const skuMap = new Map(); // ProductCode -> { skuId, productId }
    let idx = 0;

    for (const [productCode, raw] of allProducts) {
      idx++;
      try {
        const mapped = mapListingProduct(raw);
        if (!mapped.name) {
          await appendLog(pool, job.id, `Skipped ${productCode} — no product name`);
          continue;
        }

        // Resolve category_id from MaterialType
        const categoryId = resolveCategoryId(mapped.materialType, categoryLookup);

        // Upsert product
        const product = await upsertProduct(pool, {
          vendor_id,
          name: mapped.name,
          collection: mapped.collection,
          category_id: categoryId,
          description_short: mapped.description ? mapped.description.slice(0, 255) : null,
          description_long: mapped.description
        });

        if (product.is_new) stats.created++;
        else stats.updated++;
        touchedProductIds.push(product.id);

        // Upsert SKU
        const sku = await upsertSku(pool, {
          product_id: product.id,
          vendor_sku: productCode,
          internal_sku: `BED-${productCode}`,
          variant_name: mapped.variantName || mapped.size || null,
          sell_by: mapped.sellBy,
          variant_type: mapped.variantType || null
        });
        if (sku.is_new) stats.skusCreated++;

        skuMap.set(productCode, { skuId: sku.id, productId: product.id, listingImageUrls: mapped.imageUrls || [] });

        // ── Attributes ──
        for (const [slug, value] of Object.entries(mapped.attributes)) {
          await upsertSkuAttribute(pool, sku.id, slug, value);
        }

        // ── Pricing ──
        if (mapped.pricing.retailPrice) {
          await upsertPricing(pool, sku.id, {
            cost: 0,
            retail_price: mapped.pricing.retailPrice,
            price_basis: mapped.pricing.priceBasis || 'per_sqft',
          });
          stats.pricingSet++;
        }

        // ── Inventory ──
        const qtyOnHand = mapped.inventory.onHand || (mapped.inventory.isInStock ? 1 : 0);
        await upsertInventorySnapshot(pool, sku.id, 'default', {
          qty_on_hand_sqft: qtyOnHand,
          qty_in_transit_sqft: 0,
        });
        stats.inventorySet++;

        // ── Images (direct Cloudinary CDN URLs — no downloading) ──
        const imageUrls = mapped.imageUrls; // already deduplicated, max MAX_GALLERY_IMAGES

        // Product-level primary: use first image from non-accessory SKUs only
        // (accessories shouldn't override the main product image)
        if (imageUrls.length > 0 && !mapped.variantType) {
          await upsertMediaAsset(pool, {
            product_id: product.id,
            sku_id: null,
            asset_type: 'primary',
            url: imageUrls[0],
            original_url: imageUrls[0],
            sort_order: 0,
          });
        }

        // SKU-level images
        for (let gi = 0; gi < imageUrls.length && gi < MAX_GALLERY_IMAGES; gi++) {
          const imgUrl = imageUrls[gi];
          const assetType = gi === 0 ? 'primary' : 'alternate';
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

        // Log progress every 25 products
        if (idx % 25 === 0 || idx === allProducts.size) {
          await appendLog(pool, job.id, `Upsert progress: ${idx}/${allProducts.size}`, {
            products_found: stats.found,
            products_created: stats.created,
            products_updated: stats.updated,
            skus_created: stats.skusCreated
          });
        }
      } catch (err) {
        await appendLog(pool, job.id, `ERROR upserting ${productCode}: ${err.message}`);
        await addJobError(pool, job.id, `Product ${productCode}: ${err.message}`);
        stats.errors++;
      }
    }

    // ── Phase 3: Scrape detail pages for packaging, properties, gallery ──
    if (config.scrapeDetails) {
      await appendLog(pool, job.id, `Scraping detail pages for packaging + properties...`);
      browser = await launchBrowser();
      let detailIdx = 0;

      for (const [productCode, raw] of allProducts) {
        detailIdx++;
        const entry = skuMap.get(productCode);
        if (!entry) continue;

        // Build detail URL
        let detailPath = raw.ProductUrl || raw.Url || raw.ProductDetailUrl;
        if (!detailPath && raw.ProductCode) {
          detailPath = `/en/product/detail/?itemNo=${encodeURIComponent(raw.ProductCode)}`;
        }
        if (!detailPath) continue;

        try {
          const detailData = await scrapeDetailPage(browser, baseUrl, detailPath);
          if (!detailData) continue;

          // ── Packaging ──
          if (detailData.packaging) {
            await upsertPackaging(pool, entry.skuId, detailData.packaging);
            stats.packagingSet++;
          }

          // ── Technical properties as sku_attributes ──
          for (const [slug, value] of Object.entries(detailData.properties)) {
            await upsertSkuAttribute(pool, entry.skuId, slug, value);
          }

          // ── Description (update product if we got a better one) ──
          if (detailData.description) {
            await pool.query(
              `UPDATE products SET description_long = COALESCE($2, description_long), updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND (description_long IS NULL OR description_long = '')`,
              [entry.productId, detailData.description]
            );
          }

          // ── Gallery images from detail page (deduplicated against listing images) ──
          if (detailData.galleryImages.length > 0) {
            // Build a set of base filenames from Phase 2 listing images to avoid duplicates
            const listingBases = new Set(
              (entry.listingImageUrls || []).map(u => cloudinaryBaseFile(u))
            );
            const uniqueGallery = detailData.galleryImages.filter(
              url => !listingBases.has(cloudinaryBaseFile(url))
            );
            // Start sort_order after listing images to avoid conflicts
            const sortBase = MAX_GALLERY_IMAGES;
            for (let gi = 0; gi < uniqueGallery.length && gi < MAX_GALLERY_IMAGES; gi++) {
              const imgUrl = uniqueGallery[gi];
              await upsertMediaAsset(pool, {
                product_id: entry.productId,
                sku_id: entry.skuId,
                asset_type: 'alternate',
                url: imgUrl,
                original_url: imgUrl,
                sort_order: sortBase + gi,
              });
              stats.imagesSet++;
            }
          }

          // ── Tearsheet PDF ──
          if (detailData.tearsheetUrl) {
            await upsertMediaAsset(pool, {
              product_id: entry.productId,
              sku_id: entry.skuId,
              asset_type: 'spec_pdf',
              url: detailData.tearsheetUrl,
              original_url: detailData.tearsheetUrl,
              sort_order: 0,
            });
          }
        } catch (err) {
          await appendLog(pool, job.id, `ERROR detail page ${productCode}: ${err.message}`);
          await addJobError(pool, job.id, `Detail ${productCode}: ${err.message}`);
          stats.errors++;
        }

        // Log progress every 25
        if (detailIdx % 25 === 0 || detailIdx === allProducts.size) {
          await appendLog(pool, job.id, `Detail progress: ${detailIdx}/${allProducts.size} (packaging: ${stats.packagingSet})`);
        }

        // Restart browser every 100 pages to prevent OOM from accumulated Chromium memory
        if (detailIdx % 100 === 0 && detailIdx < allProducts.size) {
          await browser.close();
          browser = null;
          await delay(3000); // Give OS time to reclaim memory
          browser = await launchBrowser();
          await appendLog(pool, job.id, `Browser restarted at ${detailIdx}/${allProducts.size} to free memory`);
        }

        await delay(config.delayMs);
      }

      await appendLog(pool, job.id, `Detail phase complete: ${stats.packagingSet} packaging updated`);
    }

    // ── Phase 4: Bulk activate all products touched in this run ──
    if (touchedProductIds.length > 0) {
      const activateResult = await pool.query(
        `UPDATE products SET status = 'active', updated_at = CURRENT_TIMESTAMP
         WHERE id = ANY($1) AND status = 'draft'`,
        [touchedProductIds]
      );
      const activatedCount = activateResult.rowCount;
      await appendLog(pool, job.id, `Activated ${activatedCount} products (${touchedProductIds.length} total touched)`);
    }

    // Final summary
    await appendLog(pool, job.id,
      `Scrape complete. Found: ${stats.found}, Created: ${stats.created}, ` +
      `Updated: ${stats.updated}, SKUs: ${stats.skusCreated}, ` +
      `Images: ${stats.imagesSet}, Pricing: ${stats.pricingSet}, ` +
      `Inventory: ${stats.inventorySet}, Packaging: ${stats.packagingSet}, ` +
      `Errors: ${stats.errors}`,
      {
        products_found: stats.found,
        products_created: stats.created,
        products_updated: stats.updated,
        skus_created: stats.skusCreated
      }
    );
  } finally {
    if (browser) await browser.close();
  }
}

// ══════════════════════════════════════════════════════════════
// Phase 1: Listing page scraping
// ══════════════════════════════════════════════════════════════

/**
 * Scrape all listing pages for a category.
 * Returns an array of raw product objects from the embedded JSON.
 */
async function scrapeListingPages(browser, baseUrl, categoryPath, config) {
  const page = await browser.newPage();
  await page.setUserAgent(USER_AGENT);

  // Block images, fonts, CSS — we only need the script content
  await page.setRequestInterception(true);
  page.on('request', req => {
    const type = req.resourceType();
    if (['image', 'font', 'stylesheet', 'media'].includes(type)) {
      req.abort();
    } else {
      req.continue();
    }
  });

  const allProducts = [];

  try {
    // Load first page to determine total page count
    const firstUrl = `${baseUrl}${categoryPath}?page=1&perPage=${config.perPage}`;
    await page.goto(firstUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await delay(2000);

    const firstPageData = await extractListingData(page, config);
    if (firstPageData.products.length > 0) {
      allProducts.push(...firstPageData.products);
    }

    const totalPages = firstPageData.totalPages || 1;

    // Scrape remaining pages
    for (let pageNum = 2; pageNum <= totalPages; pageNum++) {
      const pageUrl = `${baseUrl}${categoryPath}?page=${pageNum}&perPage=${config.perPage}`;
      await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await delay(config.delayMs);

      const pageData = await extractListingData(page, config);
      if (pageData.products.length > 0) {
        allProducts.push(...pageData.products);
      } else {
        break; // No more products, stop paginating
      }
    }
  } finally {
    await page.close();
  }

  return allProducts;
}

/**
 * Extract the embedded product data from a Bedrosians listing page.
 * Looks for window.bdApp.value('$model', {...}) in the page source.
 */
async function extractListingData(page, config) {
  const html = await page.content();
  const result = { products: [], totalPages: 1 };

  // Strategy 1: Extract from window.bdApp.value('$model', {...})
  const modelMatch = html.match(/window\.bdApp\.value\s*\(\s*'\$model'\s*,\s*(\{[\s\S]*?\})\s*\)\s*;/);
  if (modelMatch) {
    try {
      const modelStr = modelMatch[1];
      const model = safeParseJsObject(modelStr);
      const products = model && (model.Products || model.products);
      if (products) {
        result.products = Array.isArray(products) ? products : [];
      }
      if (model) {
        const pager = model.pager || model.Pager || model.Pagination || {};
        const totalPages = model.TotalPages || model.totalPages
          || pager.TotalPages || pager.totalPages
          || pager.CountOfPages || pager.countOfPages
          || pager.pageCount;
        const foundCount = model.foundCount || model.FoundCount || 0;
        const pageSize = pager.PageSize || pager.pageSize || config.perPage;
        if (totalPages) {
          result.totalPages = parseInt(totalPages, 10) || 1;
        } else if (foundCount && pageSize) {
          result.totalPages = Math.ceil(parseInt(foundCount, 10) / parseInt(pageSize, 10)) || 1;
        }
      }
    } catch (e) {
      // Fall through to alternative strategies
    }
  }

  // Strategy 2: Try page.evaluate to access the model directly from JS context
  if (result.products.length === 0) {
    try {
      const evalResult = await page.evaluate(() => {
        /* eslint-disable no-undef */
        if (typeof window !== 'undefined') {
          try {
            const injector = window.angular && window.angular.element(document.body).injector();
            if (injector) {
              const model = injector.get('$model');
              const prods = model && (model.Products || model.products);
              if (prods) {
                const pager = model.pager || model.Pager || model.Pagination || {};
                return {
                  products: prods,
                  totalPages: model.TotalPages || model.totalPages || pager.TotalPages || pager.totalPages || pager.pageCount || 1,
                  foundCount: model.foundCount || model.FoundCount || 0
                };
              }
            }
          } catch (e) { /* not available */ }

          const wm = window.$model;
          const wprods = wm && (wm.Products || wm.products);
          if (wprods) {
            const wpager = wm.pager || wm.Pager || {};
            return {
              products: wprods,
              totalPages: wm.TotalPages || wm.totalPages || wpager.totalPages || wpager.TotalPages || 1,
              foundCount: wm.foundCount || wm.FoundCount || 0
            };
          }
        }
        return null;
        /* eslint-enable no-undef */
      });

      if (evalResult && evalResult.products) {
        result.products = evalResult.products;
        const tp = parseInt(evalResult.totalPages, 10) || 0;
        const fc = parseInt(evalResult.foundCount, 10) || 0;
        if (tp > 1) {
          result.totalPages = tp;
        } else if (fc && config && config.perPage) {
          result.totalPages = Math.ceil(fc / config.perPage) || 1;
        }
      }
    } catch (e) {
      // Fall through
    }
  }

  // Strategy 3: Look for JSON-like product arrays in script tags
  if (result.products.length === 0) {
    const jsonMatch = html.match(/"[Pp]roducts"\s*:\s*(\[[\s\S]*?\])\s*[,}]/);
    if (jsonMatch) {
      try {
        result.products = JSON.parse(jsonMatch[1]);
      } catch (e) {
        // Could not parse
      }
    }
  }

  // Extract total pages from HTML pagination if not found in model
  if (result.totalPages <= 1 && result.products.length > 0) {
    const pageMatch = html.match(/page=(\d+)&perPage/g);
    if (pageMatch) {
      let maxPage = 1;
      for (const m of pageMatch) {
        const num = parseInt(m.match(/page=(\d+)/)[1], 10);
        if (num > maxPage) maxPage = num;
      }
      result.totalPages = maxPage;
    }
  }

  return result;
}

// ══════════════════════════════════════════════════════════════
// Phase 3: Detail page scraping
// ══════════════════════════════════════════════════════════════

/**
 * Scrape a single product detail page.
 * Extracts packaging, technical properties, description, gallery images, tearsheet.
 *
 * Returns { packaging, properties, description, galleryImages, tearsheetUrl } or null.
 */
async function scrapeDetailPage(browser, baseUrl, detailPath) {
  const page = await browser.newPage();
  await page.setUserAgent(USER_AGENT);

  // Block fonts, CSS, images, and media to reduce memory — we extract image URLs from HTML, not rendered images
  await page.setRequestInterception(true);
  page.on('request', req => {
    const type = req.resourceType();
    if (['font', 'stylesheet', 'media', 'image'].includes(type)) {
      req.abort();
    } else {
      req.continue();
    }
  });

  try {
    const url = detailPath.startsWith('http') ? detailPath : `${baseUrl}${detailPath}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await delay(2000);

    const html = await page.content();

    const result = {
      packaging: null,
      properties: {},
      description: null,
      galleryImages: [],
      tearsheetUrl: null,
    };

    // ── Strategy 1: Extract productDetailModel from embedded script ──
    const detailMatch = html.match(/window\.bdApp\.value\s*\(\s*'productDetailModel'\s*,\s*(\{[\s\S]*?\})\s*\)\s*;/);
    if (detailMatch) {
      try {
        const model = safeParseJsObject(detailMatch[1]);
        if (model) {
          // Packaging — array of {Key, Value} pairs
          if (Array.isArray(model.Packaging) && model.Packaging.length > 0) {
            result.packaging = extractPackagingFromKeyValues(model.Packaging);
          }

          // Properties — array of {Key, Value} for technical specs
          if (Array.isArray(model.Properties)) {
            result.properties = extractPropertiesFromKeyValues(model.Properties);
          }

          // Description from Product object
          const product = model.Product;
          if (product && product.Description) {
            result.description = product.Description;
          }

          // Tearsheet from Resources
          if (Array.isArray(model.Resources)) {
            const tearsheet = model.Resources.find(r => r.Key === 'Tearsheet' && r.Value);
            if (tearsheet) result.tearsheetUrl = tearsheet.Value;
          }
        }
      } catch (e) { /* fall through to alternative strategies */ }
    }

    // ── Strategy 2: Fall back to DOM parsing for packaging ──
    if (!result.packaging) {
      result.packaging = await extractPackagingFromDOM(page);
    }

    // ── Extract gallery images from rendered page ──
    try {
      const galleryImages = await page.evaluate(() => {
        const images = [];
        // Look for product gallery/slider images
        const selectors = [
          '.pdp-image img',
          '.product-gallery img',
          '.gallery-slider img',
          '[class*="gallery"] img',
          '[class*="slider"] img',
          '.pdp-page-gallery img',
        ];
        for (const sel of selectors) {
          document.querySelectorAll(sel).forEach(img => {
            const src = img.getAttribute('src') || img.getAttribute('data-src') || img.getAttribute('ng-src') || '';
            if (src && src.includes('cloudinary') && !src.includes('{{')) {
              images.push(src);
            }
          });
          if (images.length > 0) break;
        }
        return images;
      });
      if (galleryImages.length > 0) {
        // Normalize, deduplicate, and filter out non-product images (icons, logos, etc.)
        const seen = new Set();
        for (const img of galleryImages) {
          const normalized = normalizeCloudinaryUrl(img);
          const base = normalized.split('?')[0];
          // Skip UI icons, logos, badges, tiny images, filler defaults, and non-product assets
          if (/icon|logo|badge|placeholder|PDP%20Updates/i.test(base)) continue;
          if (/bd_default/i.test(normalized)) continue; // Cloudinary fallback/filler image
          if (/\/w_(50|100)\b|t_product_150/i.test(normalized)) continue; // tiny thumbnails
          if (!seen.has(base)) {
            seen.add(base);
            result.galleryImages.push(normalized);
          }
        }
      }
    } catch (e) { /* gallery extraction failed, non-fatal */ }

    return result;
  } finally {
    await page.close();
  }
}

/**
 * Extract packaging from productDetailModel.Packaging array.
 * Format: [{Key: "Box Pieces", Value: "8.00"}, {Key: "Box SF", Value: "15.50"}, ...]
 */
function extractPackagingFromKeyValues(packagingArray) {
  const keyMap = {
    'box pieces': 'pieces_per_box',
    'box pcs': 'pieces_per_box',
    'pieces per box': 'pieces_per_box',
    'box sf': 'sqft_per_box',
    'box sq ft': 'sqft_per_box',
    'sqft per box': 'sqft_per_box',
    'sf per box': 'sqft_per_box',
    'box weight': 'weight_per_box_lbs',
    'weight per box': 'weight_per_box_lbs',
    'pallet boxes': 'boxes_per_pallet',
    'boxes per pallet': 'boxes_per_pallet',
    'pallet sf': 'sqft_per_pallet',
    'pallet sq ft': 'sqft_per_pallet',
    'pallet weight': 'weight_per_pallet_lbs',
    'weight per pallet': 'weight_per_pallet_lbs',
  };

  const result = {
    sqft_per_box: null,
    pieces_per_box: null,
    weight_per_box_lbs: null,
    boxes_per_pallet: null,
    sqft_per_pallet: null,
    weight_per_pallet_lbs: null,
  };

  for (const item of packagingArray) {
    if (!item.Key || !item.Value) continue;
    const key = item.Key.toLowerCase().trim();
    const field = keyMap[key];
    if (field) {
      if (field === 'pieces_per_box' || field === 'boxes_per_pallet') {
        result[field] = parseInt(item.Value, 10) || null;
      } else {
        result[field] = parseNum(item.Value);
      }
    }
  }

  // Only return if we got at least one field
  if (result.sqft_per_box || result.pieces_per_box || result.weight_per_box_lbs) {
    return result;
  }
  return null;
}

/**
 * Extract technical properties from productDetailModel.Properties array.
 * Format: [{Key: "PeiAbrasion", Value: "4"}, {Key: "Dcof", Value: "0.42"}, ...]
 * Returns { slug: value } map for upsertSkuAttribute.
 */
function extractPropertiesFromKeyValues(propertiesArray) {
  const keyMap = {
    'peiabrasion': 'pei_rating',
    'peirating': 'pei_rating',
    'shadevariation': 'shade_variation',
    'waterabsorption': 'water_absorption',
    'dcof': 'dcof',
    'scratchresistance': 'scratch_resistance',
    'chemicalresistance': 'chemical_resistance',
    'frostresistance': 'frost_resistance',
    'breakingstrength': 'breaking_strength',
    'shape': 'shape',
    'materialcategory': null, // skip — already mapped
    'materialtype': null, // skip — already mapped
    'materialfinish': null, // skip — already mapped
    'residential': null, // skip — usage info, not an attribute
    'commercial': null, // skip — usage info
  };

  const result = {};
  for (const item of propertiesArray) {
    if (!item.Key || !item.Value) continue;
    const normalizedKey = item.Key.toLowerCase().replace(/[^a-z]/g, '');
    const slug = keyMap[normalizedKey];
    if (slug === null) continue; // explicitly skipped
    if (slug) {
      result[slug] = item.Value;
    }
  }
  return result;
}

/**
 * Fallback: Extract packaging from rendered DOM.
 */
async function extractPackagingFromDOM(page) {
  const packaging = await page.evaluate(() => {
    const result = {};
    const specMap = {
      'box sf': 'sqft_per_box',
      'box sq ft': 'sqft_per_box',
      'box sqft': 'sqft_per_box',
      'sf per box': 'sqft_per_box',
      'sq ft per box': 'sqft_per_box',
      'sqft per box': 'sqft_per_box',
      'box pieces': 'pieces_per_box',
      'pieces per box': 'pieces_per_box',
      'pcs per box': 'pieces_per_box',
      'box weight': 'weight_per_box_lbs',
      'box weight (lbs)': 'weight_per_box_lbs',
      'weight per box': 'weight_per_box_lbs',
      'pallet boxes': 'boxes_per_pallet',
      'boxes per pallet': 'boxes_per_pallet',
      'pallet sf': 'pallet_sqft',
      'pallet sq ft': 'pallet_sqft',
      'pallet weight': 'pallet_weight'
    };

    document.querySelectorAll('dt').forEach(dt => {
      const key = dt.textContent.trim().toLowerCase();
      const dd = dt.nextElementSibling;
      if (dd && dd.tagName === 'DD') {
        const val = dd.textContent.trim();
        const mapped = specMap[key];
        if (mapped && val) result[mapped] = val;
      }
    });

    if (Object.keys(result).length === 0) {
      document.querySelectorAll('table tr, .spec-row, .product-spec').forEach(row => {
        const cells = row.querySelectorAll('td, th, span, .spec-label, .spec-value');
        if (cells.length >= 2) {
          const key = cells[0].textContent.trim().toLowerCase();
          const val = cells[1].textContent.trim();
          const mapped = specMap[key];
          if (mapped && val) result[mapped] = val;
        }
      });
    }

    return Object.keys(result).length > 0 ? result : null;
  });

  if (packaging) {
    return {
      sqft_per_box: parseNum(packaging.sqft_per_box),
      pieces_per_box: parseInt(packaging.pieces_per_box, 10) || null,
      weight_per_box_lbs: parseNum(packaging.weight_per_box_lbs),
      boxes_per_pallet: parseInt(packaging.boxes_per_pallet, 10) || null,
      sqft_per_pallet: parseNum(packaging.pallet_sqft),
      weight_per_pallet_lbs: parseNum(packaging.pallet_weight)
    };
  }
  return null;
}

// ══════════════════════════════════════════════════════════════
// Product mapping
// ══════════════════════════════════════════════════════════════

/**
 * Parse a verbose Bedrosians product name into structured components.
 *
 * Input:  "+One 12\" x 24\" Matte Porcelain Field Tile in Ash"
 * Output: { color: "Ash", size: "12x24", finish: "Matte", shape: "Field Tile" }
 */
function parseBedrosianName(rawName) {
  const result = { color: null, size: null, finish: null, shape: null };
  if (!rawName) return result;

  const colorMatch = rawName.match(/\bin\s+([A-Z][^"]*?)$/i);
  if (colorMatch) {
    result.color = colorMatch[1].trim();
  }

  const sizeMatch = rawName.match(/(\d+\.?\d*)\s*"?\s*[xX×]\s*(\d+\.?\d*)\s*"?/);
  if (sizeMatch) {
    result.size = normalizeSize(sizeMatch[0]);
  }

  const finishMatch = rawName.match(/\b(Matte|Polished|Honed|Glossy|Satin|Textured|Natural|Lappato|Brushed|Tumbled|Chiseled|Latte)\b/i);
  if (finishMatch) {
    result.finish = finishMatch[1].charAt(0).toUpperCase() + finishMatch[1].slice(1).toLowerCase();
  }

  const shapeMatch = rawName.match(/\b(Field Tile|Mosaic|Bullnose|Quarter Round|Pencil Liner|Wall Tile|Floor Tile|Subway Tile|Hexagon|Herringbone|Chevron|Deco(?:rative)?|Listello|Chair Rail|Trim|Cove Base)\b/i);
  if (shapeMatch) {
    result.shape = shapeMatch[1];
  }

  return result;
}

/**
 * Map a Bedrosians listing product to our PIM schema.
 * Extracts all available data: product info, attributes, pricing, inventory, images.
 */
function mapListingProduct(raw) {
  const attributes = {};

  if (raw.MaterialType) attributes.material = raw.MaterialType;
  if (raw.MaterialFinish) attributes.finish = raw.MaterialFinish;
  if (raw.Size) attributes.size = raw.Size;
  if (raw.Thickness) attributes.thickness = raw.Thickness;
  if (raw.Shape) attributes.shape = raw.Shape;
  if (raw.CountryOfOrigin) attributes.country = raw.CountryOfOrigin;
  if (raw.ShadeVariation) attributes.shade_variation = raw.ShadeVariation;
  if (raw.Applications) attributes.application = Array.isArray(raw.Applications) ? raw.Applications.join(', ') : String(raw.Applications);
  if (raw.Usages) attributes.usage = Array.isArray(raw.Usages) ? raw.Usages.join(', ') : String(raw.Usages);
  if (raw.PEIRating) attributes.pei_rating = String(raw.PEIRating);
  if (raw.MosaicSize) attributes.mosaic_size = raw.MosaicSize;
  if (raw.ActualSize) attributes.actual_size = raw.ActualSize;

  // ── Product naming ──
  // Use SeriesColor for product name (actual color name, e.g., "Walnut")
  // Fall back to parsing from verbose name
  const verboseName = raw.Name || raw.ProductName || '';
  const parsed = parseBedrosianName(verboseName);
  // ── Detect vinyl accessories (T-Mold, Reducer, Stair Nose, etc.) ──
  // These should be SKUs on the main color product, not separate product cards.
  const ACCESSORY_PATTERNS = [
    { pattern: /\bFlush\s+Stair\s+Nose\b/i, label: 'Flush Stair Nose' },
    { pattern: /\bOverlapping\s+Stair\s+Nose\b/i, label: 'Overlapping Stair Nose' },
    { pattern: /\bStair\s+Nose\b/i, label: 'Stair Nose' },
    { pattern: /\bT[-\s]?Mold(?:ing)?\b/i, label: 'T-Mold' },
    { pattern: /\bReducer\b/i, label: 'Reducer' },
    { pattern: /\bQuarter\s+Round\b/i, label: 'Quarter Round' },
    { pattern: /\bEnd\s+Cap\b/i, label: 'End Cap' },
    { pattern: /\bThreshold\b/i, label: 'Threshold' },
    { pattern: /\bUnderlayment\b/i, label: 'Underlayment' },
  ];

  let accessoryType = null;
  for (const { pattern, label } of ACCESSORY_PATTERNS) {
    if (pattern.test(verboseName)) {
      accessoryType = label;
      break;
    }
  }

  let productName = raw.SeriesColor || parsed.color || verboseName;
  let variantType = null;

  // If it's an accessory, extract color from end of verbose name and use accessory label as variant
  if (accessoryType) {
    variantType = 'accessory';
    // Color is typically the last word(s): "...Canvas", "...khaki", "...Driftwood"
    const colorFromEnd = verboseName.replace(/.*(?:T-Mold|Reducer|Stair Nose|Quarter Round|End Cap|Threshold|Underlayment)\b[^A-Za-z]*/i, '').trim();
    if (colorFromEnd) productName = colorFromEnd;
  }

  // Collection: GroupVariantsBy groups all variants; ProductSeries is the series name
  const collection = raw.GroupVariantsBy || raw.ProductSeries || raw.Series || null;

  // Variant name: for accessories use the type label + size, otherwise size + finish + shape
  let variantName;
  if (accessoryType) {
    const sizeStr = parsed.size || raw.Size || '';
    variantName = sizeStr ? `${accessoryType} ${sizeStr}` : accessoryType;
  } else {
    variantName = buildVariantName(
      parsed.size || raw.Size,
      parsed.finish || raw.MaterialFinish,
      parsed.shape
    );
  }

  // ── Sell by ──
  const sellBy = mapUomToSellBy(raw.SellingUom);

  // ── Pricing from PriceToDisplay ──
  const pricing = { retailPrice: null, priceBasis: 'per_sqft' };
  const ptd = raw.PriceToDisplay;
  if (ptd) {
    pricing.retailPrice = ptd.CurrentPrice || ptd.ActualPrice || ptd.ListPrice || null;
    if (pricing.retailPrice && typeof pricing.retailPrice === 'number' && pricing.retailPrice > 0) {
      // Determine price basis from sell_by
      pricing.priceBasis = sellBy === 'unit' ? 'per_unit' : 'per_sqft';
    } else {
      pricing.retailPrice = null;
    }
  }

  // ── Inventory from OnHand / Availability ──
  const rawOnHand = parseNum(raw.OnHand) || parseNum(raw.Availability) || 0;
  const inventory = {
    onHand: Math.floor(rawOnHand), // DB column is integer
    isInStock: raw.IsInStock === true || rawOnHand > 0,
  };

  // ── Image URLs (direct Cloudinary CDN — no downloading) ──
  const imageUrls = buildImageUrls(raw);

  return {
    name: productName,
    collection,
    description: raw.Description || raw.ShortDescription || null,
    size: raw.Size || null,
    variantName,
    variantType,
    sellBy,
    attributes,
    materialType: raw.MaterialType || null,
    pricing,
    inventory,
    imageUrls,
  };
}

/**
 * Build deduplicated image URLs from listing data.
 * Uses Cloudinary CDN URLs — no disk downloads needed.
 */
function buildImageUrls(raw) {
  const urls = [];
  const seen = new Set();

  function addUrl(url) {
    if (!url) return;
    const normalized = normalizeCloudinaryUrl(url);
    const base = normalized.split('?')[0];
    // Skip filler/default images and tiny thumbnails
    if (/bd_default/i.test(normalized)) return;
    if (/icon|logo|badge|placeholder|PDP%20Updates/i.test(base)) return;
    if (/\/w_(50|100)\b|t_product_150/i.test(normalized)) return;
    if (!seen.has(base) && urls.length < MAX_GALLERY_IMAGES) {
      seen.add(base);
      urls.push(normalized);
    }
  }

  // Primary image from ImageName
  const imgName = raw.ImageName || (raw.colorList && raw.colorList.length > 0 && raw.colorList[0].ImageName) || null;
  if (imgName) {
    // High-res product image
    addUrl(`${CLOUDINARY_BASE}/f_auto,q_70,w_800/v1/${PRODUCT_IMAGE_PATH}/${imgName}.jpg`);
  }

  // Alternative image (installation/lifestyle shot)
  if (raw.AlternativeImageUrl) {
    addUrl(raw.AlternativeImageUrl);
  }

  // If ImageSource is a direct URL, add it too
  if (raw.ImageSource && raw.ImageSource.includes('cloudinary')) {
    addUrl(raw.ImageSource);
  }

  return urls;
}

/**
 * Extract the base filename from a Cloudinary URL, stripping transforms and extension.
 * e.g. "https://res.cloudinary.com/.../f_auto,q_70,w_800/v1/.../100010079.jpg" → "100010079"
 *      "https://res.cloudinary.com/.../t_product_detail,f_auto/.../100010079"   → "100010079"
 */
function cloudinaryBaseFile(url) {
  if (!url) return '';
  // Get the last path segment, strip query params, strip extension
  const path = url.split('?')[0];
  const segments = path.split('/');
  const last = segments[segments.length - 1] || '';
  return last.replace(/\.\w{2,5}$/, '').toLowerCase();
}

/**
 * Normalize a Cloudinary URL: ensure https, clean up transforms.
 */
function normalizeCloudinaryUrl(url) {
  if (!url) return url;
  // Fix protocol-relative URLs
  if (url.startsWith('//')) {
    url = 'https:' + url;
  }
  // Fix http → https
  if (url.startsWith('http://')) {
    url = url.replace('http://', 'https://');
  }
  // Normalize res-N.cloudinary.com → res.cloudinary.com
  url = url.replace(/res-\d+\.cloudinary\.com/, 'res.cloudinary.com');
  return url;
}

/**
 * Resolve a Bedrosians MaterialType to a PIM category_id.
 */
function resolveCategoryId(materialType, categoryLookup) {
  if (!materialType) return null;
  const slug = CATEGORY_MAP[materialType.toLowerCase()];
  if (!slug) return null;
  return categoryLookup.get(slug) || null;
}

/**
 * Map Bedrosians SellingUom to our sell_by field.
 * Handles both object {Id: "SF", Name: "Sq. Ft."} and string formats.
 */
function mapUomToSellBy(uom) {
  if (!uom) return 'sqft';

  // Handle object format: {Id: "SF", Name: "Sq. Ft.", IsFractional: true}
  if (typeof uom === 'object') {
    const id = (uom.Id || uom.id || '').toUpperCase();
    if (id === 'SF' || id === 'SQFT') return 'sqft';
    if (id === 'PCS' || id === 'PC' || id === 'EA' || id === 'EACH') return 'unit';
    if (id === 'CTN' || id === 'BOX') return 'sqft';
    // Fall back to Name
    const name = (uom.Name || uom.name || '').toLowerCase();
    if (name.includes('sq') || name.includes('foot') || name.includes('feet')) return 'sqft';
    if (name.includes('piece') || name.includes('each')) return 'unit';
    if (name.includes('carton') || name.includes('box')) return 'sqft';
    return 'sqft';
  }

  // Handle string format
  const lower = String(uom).toLowerCase();
  if (lower.includes('sqft') || lower.includes('sq ft') || lower.includes('square')) return 'sqft';
  if (lower.includes('piece') || lower.includes('each') || lower.includes('unit')) return 'unit';
  if (lower.includes('box') || lower.includes('carton')) return 'sqft';
  return 'sqft';
}

// ══════════════════════════════════════════════════════════════
// Utilities
// ══════════════════════════════════════════════════════════════

/**
 * Safely parse a number from a string or number value.
 */
function parseNum(val) {
  if (val == null) return null;
  if (typeof val === 'number') return val;
  const cleaned = String(val).replace(/[$,\s]/g, '');
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

/**
 * Attempt to parse a JS object literal string that may not be strict JSON.
 */
function safeParseJsObject(str) {
  try {
    return JSON.parse(str);
  } catch (e) {
    // Not strict JSON, try to coerce
  }

  try {
    let jsonStr = str
      .replace(/\/\/[^\n]*/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, '"$1"')
      .replace(/(\{|,)\s*([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:/g, '$1"$2":')
      .replace(/,\s*([\]}])/g, '$1');
    return JSON.parse(jsonStr);
  } catch (e) {
    return null;
  }
}
