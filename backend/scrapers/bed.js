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
  detailOffset: 0,
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
  // 'tile' omitted — ambiguous catch-all; logged as unmapped so new products can be triaged
  'hardwood': 'engineered-hardwood',
  'engineered hdf wood': 'engineered-hardwood',
  'hickory': 'engineered-hardwood',
  'quartzite': 'natural-stone',
  'soapstone': 'natural-stone',
  'onyx': 'natural-stone',
  'sandstone': 'natural-stone',
  'basalt': 'natural-stone',
  'pebble rock': 'natural-stone',
  'ledger': 'stacked-stone',
  'corner': 'stacked-stone',
  'brick': 'ceramic-tile',
  'mineral surface': 'quartz-countertops',
  'quartz': 'quartz-countertops',
  'quarry': 'ceramic-tile',
  'cement': 'porcelain-tile',
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

  // Bedrosians is a manufacturer-brand — stamp every product with the "Bedrosians" brand so the
  // storefront brand filter (COALESCE(brand, vendor)) shows one entry, not a "Bedrosians Tile"
  // (vendor-name) fallback for any product left brand-less.
  let brandId = null;
  try {
    const brandRow = await pool.query("SELECT id FROM brands WHERE name = 'Bedrosians' LIMIT 1");
    brandId = brandRow.rows[0] ? brandRow.rows[0].id : null;
  } catch (err) {
    // Non-fatal — products just keep their existing brand
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

        // Resolve category_id from MaterialType + shape/slab context
        const categoryId = resolveCategoryId(mapped.materialType, categoryLookup, mapped.collection, {
          shape: mapped.shape,
          isSlab: mapped.isSlab,
          name: mapped.name,
          size: mapped.size,
          application: mapped.attributes && mapped.attributes.application,
        });
        if (mapped.materialType && !categoryId) {
          await appendLog(pool, job.id, `Unmapped MaterialType "${mapped.materialType}" for ${productCode} — product will have no category`);
        }

        // Shape-based product splitting: when the shape implies a different category
        // than the base MaterialType, create a separate product with a shape suffix.
        // This prevents mosaic/penny-round/wall-tile SKUs from being lumped with
        // field tiles under a single product.
        const baseCategoryId = resolveCategoryId(mapped.materialType, categoryLookup, mapped.collection, {
          shape: null,
          isSlab: mapped.isSlab,
          name: mapped.name,
          size: mapped.size,
          application: mapped.attributes && mapped.attributes.application,
        });
        let productName = mapped.name;
        let productCollection = mapped.collection;
        if (categoryId && baseCategoryId && categoryId !== baseCategoryId && mapped.shape) {
          const shapeSuffix = classifyShapeSuffix(mapped.shape);
          if (shapeSuffix) {
            productName = `${mapped.name} ${shapeSuffix}`;
            productCollection = `${mapped.collection} ${shapeSuffix}`;
          }
        }

        // Upsert product
        const product = await upsertProduct(pool, {
          vendor_id,
          name: productName,
          collection: productCollection,
          category_id: categoryId,
          brand_id: brandId,
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

        // Slab area derived from its dimensions — backs the per-piece price above and
        // lets the reconcile pass tell converted slabs from area-less ones.
        if (mapped.slabSqft) {
          await upsertPackaging(pool, sku.id, { sqft_per_box: mapped.slabSqft, pieces_per_box: 1 });
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
      // Build lightweight detail queue and release raw product data to free memory
      const detailQueue = [];
      for (const [productCode, raw] of allProducts) {
        let detailPath = raw.ProductUrl || raw.Url || raw.ProductDetailUrl;
        if (!detailPath && raw.ProductCode) {
          detailPath = `/en/product/detail/?itemNo=${encodeURIComponent(raw.ProductCode)}`;
        }
        if (detailPath) {
          detailQueue.push({ productCode, detailPath });
        }
      }
      allProducts.clear();
      if (global.gc) global.gc();

      await appendLog(pool, job.id, `Scraping detail pages for packaging + properties...`);
      browser = await launchBrowser();
      let detailIdx = 0;

      for (const { productCode, detailPath } of detailQueue) {
        detailIdx++;
        if (detailIdx <= config.detailOffset) continue;
        const entry = skuMap.get(productCode);
        if (!entry) continue;

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
          // If browser crashed, relaunch it before continuing
          if (/Protocol error|Connection closed|Target closed|Session closed/i.test(err.message)) {
            try { if (browser) await browser.close(); } catch (_) {}
            browser = null;
            await delay(3000);
            browser = await launchBrowser();
            await appendLog(pool, job.id, `Browser relaunched after crash at detail ${detailIdx}`);
          }
        }

        // Log progress every 25
        if (detailIdx % 25 === 0 || detailIdx === detailQueue.length) {
          await appendLog(pool, job.id, `Detail progress: ${detailIdx}/${detailQueue.length} (packaging: ${stats.packagingSet})`);
        }

        // Restart browser every 100 pages to prevent OOM from accumulated Chromium memory
        if (detailIdx % 100 === 0 && detailIdx < detailQueue.length) {
          await browser.close();
          browser = null;
          await delay(3000); // Give OS time to reclaim memory
          browser = await launchBrowser();
          await appendLog(pool, job.id, `Browser restarted at ${detailIdx}/${detailQueue.length} to free memory`);
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

    // ── Phase 5: Reconcile — the authoritative post-scrape pass over fully-scraped products ──
    // Fixes category (holistically, from all SKUs + application), color, display_name, sell_by /
    // price basis, marks bundled liner SKUs as accessories, prunes orphans, and attaches
    // cross-product accessories. Guarded on stats.found > 0 so a failed/empty run never mutates
    // the catalog. Idempotent — safe to re-run.
    if (stats.found > 0) {
      try {
        const rec = await reconcileBedProducts(pool, vendor_id);
        await appendLog(pool, job.id,
          `Reconcile: ${rec.categoryFixed} categories, ${rec.colorFixed} colors, ` +
          `${rec.displayNameFixed} display names, ${rec.sellByFixed} sell_by/price, ` +
          `${rec.slabPriceConverted} slab prices converted to per-piece, ` +
          `${rec.accessorySkus} accessory SKUs, ${rec.pruned} orphans pruned, ` +
          `${rec.accessoryLinks} accessory links${rec.nullPrice ? `, ${rec.nullPrice} with NO price` : ''}`);
      } catch (err) {
        await appendLog(pool, job.id, `Reconcile skipped: ${err.message}`);
      }
    }

    // Final summary
    await appendLog(pool, job.id,
      `Scrape complete. Found: ${stats.found}, Created: ${stats.created}, ` +
      `Updated: ${stats.updated}, SKUs: ${stats.skusCreated}, ` +
      `Images: ${stats.imagesSet}, Broken images skipped: ${stats.brokenImages || 0}, ` +
      `Pricing: ${stats.pricingSet}, ` +
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
          if (/t_product_300/i.test(normalized)) continue; // recommendation carousel thumbnails (cross-sell, not this product's gallery)
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

  // Match dimensions including fractions: 3/4" x 3/4", 1-1/2" x 12", 12" x 24"
  const dimPat = /(\d+(?:[- ]\d+\/\d+|\.\d+|\/\d+)?)\s*"?\s*[xX×]\s*(\d+(?:[- ]\d+\/\d+|\.\d+|\/\d+)?)\s*"?/;
  const sizeMatch = rawName.match(dimPat);
  if (sizeMatch) {
    result.size = normalizeSize(sizeMatch[0]);
  }

  const finishMatch = rawName.match(/\b(Matte|Polished|Honed|Glossy|Satin|Textured|Natural|Lappato|Brushed|Tumbled|Chiseled|Latte|Flamed|Bush Hammered|Leathered|Sandblasted|Split Face|Antiqued)\b/i);
  if (finishMatch) {
    result.finish = finishMatch[1].charAt(0).toUpperCase() + finishMatch[1].slice(1).toLowerCase();
  }

  const shapeMatch = rawName.match(/\b(Field Tile|Mosaic|Bullnose|Quarter Round|Pencil Liner|Wall Tile|Floor Tile|Subway Tile|Hexagon|Herringbone|Chevron|Deco(?:rative)?|Listello|Chair Rail|Trim|Cove Base|Basketweave|Arabesque|Picket|Diamond|Lantern|Fan|Penny Round)\b/i);
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

  const seriesColor = raw.SeriesColor && raw.SeriesColor.length >= 2 && !/^[A-Z0-9]{1,4}$/.test(raw.SeriesColor) ? raw.SeriesColor : null;
  let productName = seriesColor || parsed.color || verboseName;
  let variantType = null;

  // If it's an accessory, extract color from end of verbose name and use accessory label as variant
  if (accessoryType) {
    variantType = 'accessory';
    // Color is typically the last word(s): "...Canvas", "...khaki", "...Driftwood"
    const colorFromEnd = verboseName.replace(/.*(?:T-Mold|Reducer|Flush\s+Stair\s+Nose|Overlapping\s+Stair\s+Nose|Stair\s+Nose|Quarter\s+Round|End\s+Cap|Threshold|Underlayment)\b[^A-Za-z]*/i, '').trim();
    if (colorFromEnd) productName = colorFromEnd;
  }

  // Collection: GroupVariantsBy groups all variants; ProductSeries is the series name
  const collection = raw.GroupVariantsBy || raw.ProductSeries || raw.Series || null;
  if (collection && !accessoryType && !productName.toLowerCase().startsWith(collection.toLowerCase())) {
    productName = `${collection} ${productName}`;
  }

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
  // Slabs are sold per piece regardless of UOM
  const materialLower = (raw.MaterialType || '').toLowerCase();
  // Slab size = BOTH dimensions large. A lone >50" side is not enough: wood-look planks run
  // 10x60–12x72 and are field tile sold by the box (Timberline, Planx, Yorkwood), while true
  // slab/panel formats (30.63x86 Fusion, 60x126 Magnifica) are wide as well as long.
  const slabDims = parseDims(parsed.size || raw.Size);
  const isSlabSize = !!slabDims && slabDims.min > 24 && slabDims.max > 50;
  // Bedrosians' slab catalog codes its collections SLABGRA/SLABQTE/SLAB3MRE/etc. (stone slabs), and
  // names porcelain slabs "... Porcelain Slab" / "Bookmatched Slab". ProductCode is a numeric id for
  // these, so the collection prefix and product name are the reliable signals.
  const isSlabCollection = /^SLAB/i.test(collection || '');
  const isSlabName = /\b(slab|bookmatch)/i.test(productName || '');
  const isSlab = materialLower === 'mineral surface' || materialLower === 'quartz'
    || (raw.ProductCode && String(raw.ProductCode).toUpperCase().includes('SLAB'))
    || isSlabCollection || isSlabName || isSlabSize;
  // Mosaics are sold per piece/sheet, not per sqft
  const isMosaic = classifyShapeSuffix(parsed.shape || raw.Shape) === 'Mosaic';
  const sellBy = (isSlab || isMosaic) ? 'unit' : mapUomToSellBy(raw.SellingUom);

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

  // Bedrosians quotes some slab lines per sqft (SellingUom "SF" — e.g. Magnifica Fusion
  // $13.95/sqft) while we sell every slab per piece. Convert using the slab's own
  // dimensions. When the size won't parse, keep the honest per_sqft basis instead of
  // mislabeling a per-sqft figure per_unit — a unit-sold SKU with per_sqft basis and no
  // box area renders "/sqft" and the rep enters the slab size at line level.
  let slabSqft = null;
  if (isSlab && pricing.retailPrice && isSqftUom(raw.SellingUom)) {
    const d = parseDims(parsed.size || raw.Size);
    if (d && d.min > 0) {
      slabSqft = Math.round((d.min * d.max / 144) * 10000) / 10000;
      pricing.retailPrice = Math.round(pricing.retailPrice * slabSqft * 100) / 100;
    } else {
      pricing.priceBasis = 'per_sqft';
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
    shape: parsed.shape || raw.Shape || null,
    isSlab,
    slabSqft,
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
 * Classify a shape string into a product-name suffix for shape-based splitting.
 * Returns null if the shape doesn't warrant splitting (e.g., "Field Tile").
 */
function classifyShapeSuffix(shape) {
  if (!shape) return null;
  const s = shape.toLowerCase();
  const MOSAIC_SHAPES = [
    'mosaic', 'penny round', 'hexagon', 'herringbone', 'basketweave',
    'arabesque', 'picket', 'diamond', 'lantern', 'fan', 'chevron',
  ];
  if (MOSAIC_SHAPES.some(kw => s.includes(kw))) return 'Mosaic';
  if (s.includes('wall tile') || s.includes('subway')) return 'Wall Tile';
  return null;
}

/**
 * Categorize a Bedrosians product to a PIM category SLUG (pure — no DB).
 *
 * This is the SINGLE source of categorization truth, used both by the scrape
 * insert (per-SKU, provisional — gives products a sane category immediately and
 * drives shape-splitting) and by reconcileBedProducts (per-product AGGREGATE,
 * authoritative — `application` merged across SKUs, `name` the product name).
 *
 * Priority: slab → ledger → tile-trim (name-based) → mosaic-shape → wall-only
 * (application) → floor moldings → material default (CATEGORY_MAP).
 */
function categorizeBedSlug(materialType, collection, { shape, isSlab, name, application } = {}) {
  if (!materialType) return null;
  const mt = materialType.toLowerCase();
  let slug = CATEGORY_MAP[mt];
  // Narrow override: Bedrosians labels Shorewood vinyl planks as MaterialType "Tile"
  if (!slug && mt === 'tile' && collection && /^shorewood$/i.test(collection)) {
    slug = 'lvp-plank';
  }
  if (!slug) return null;

  const nameLower = (name || '').toLowerCase();
  // An explicit field/wall "Tile" type-word marks a single tile, not a mosaic sheet — so it must
  // not be pulled into mosaic-tile by a pattern-shaped name (e.g. "Hexagon Porcelain Tile",
  // "Fan Deco Porcelain Tile"). Bare collection+color mosaics (e.g. "360 Beige") have no such word.
  const hasFieldTileWord = !nameLower.includes('mosaic')
    && /(field tile|floor ?& ?wall tile|floor and wall tile|porcelain tile\b|ceramic tile\b|wall tile)/.test(nameLower);

  // ── Shape override: mosaic shapes → mosaic-tile ──
  if (shape) {
    const shapeLower = shape.toLowerCase();
    const MOSAIC_SHAPES = [
      'mosaic', 'penny round', 'hexagon', 'herringbone', 'basketweave',
      'arabesque', 'picket', 'diamond', 'lantern', 'fan', 'chevron',
    ];
    if (!hasFieldTileWord && MOSAIC_SHAPES.some(s => shapeLower.includes(s))) {
      slug = 'mosaic-tile';
    }
    // Wall tile override: a "Wall Tile" / "Subway" SHAPE → backsplash-wall, but ONLY when the tile
    // is not floor-rated. Bedrosians tags some floor planks (e.g. Othello 8"×48") with a "Wall Tile"
    // format variant; those stay in their field-tile category since Applications include "Floors".
    const floorRated = /floor/i.test(application || '');
    if ((shapeLower.includes('wall tile') || shapeLower.includes('subway')) && !floorRated) {
      slug = 'backsplash-wall';
    }
  }

  // ── Wall-tile override: wall-only field tiles → backsplash-wall. Detected from the name
  // ("Wall Tile" and not "Floor & Wall") OR the Applications attribute being wall-only
  // ("Walls, Shower Walls" with no "Floors"), which catches lines named plainly "Ceramic Tile"
  // (e.g. Cloe, Donna, Grace). ──
  const appLower = (application || '').toLowerCase();
  const wallOnlyApp = /wall/.test(appLower) && !/floor/.test(appLower);
  if (['porcelain-tile', 'ceramic-tile'].includes(slug)
      && ((/wall tile/.test(nameLower) && !/floor/.test(nameLower)) || (application && wallOnlyApp))) {
    slug = 'backsplash-wall';
  }

  // ── Tile/stone trim override: bullnose / jolly / v-cap / liner / edge trim → trim-accessories.
  // NAME-based only: a thin-strip SIZE must NOT reclassify a product, because a wall/field tile
  // line commonly bundles a liner SKU (e.g. Cloe = 0.5"×8" jolly + 2.5"×8" + 5"×5" tiles) and the
  // product must stay a tile. Exclude pool coping ("Bullnose Edge" = the coping's profile). ──
  if (['porcelain-tile', 'ceramic-tile', 'mosaic-tile', 'backsplash-wall', 'backsplash-tile', 'natural-stone'].includes(slug)
      && /(bullnose|jolly|v-?cap|\bliner\b|\btrim\b|pencil|listello|cove base|chair rail|cane trim)/.test(nameLower)
      && !/coping|\bpool/.test(nameLower)) {
    slug = 'trim-accessories';
  }

  // ── Ledger override: ledger / stacked-stone panels → stacked-stone ──
  if (/\bledger\b/.test(nameLower) || /\bledger\b/i.test(collection || '')) {
    slug = 'stacked-stone';
  }

  // ── Floor molding override: transition pieces on wood/vinyl → transitions-moldings ──
  if (['engineered-hardwood', 'lvp-plank'].includes(slug)
      && /(t-mold|reducer|stair nose|threshold|quarter round|end cap|\bmolding\b|\btrim\b)/.test(nameLower)) {
    slug = 'transitions-moldings';
  }

  // ── Slab override: route to slab/countertop categories ──
  if (isSlab) {
    if (mt === 'porcelain' || mt === 'cement') {
      slug = 'porcelain-slabs';
    } else if (mt === 'quartzite') {
      slug = 'quartzite-countertops';
    } else if (mt === 'granite') {
      slug = 'granite-countertops';
    } else if (mt === 'soapstone') {
      slug = 'soapstone-countertops';
    } else if (['marble', 'travertine', 'limestone', 'onyx'].includes(mt)) {
      slug = 'marble-countertops';
    }
    // quartz / mineral surface already map to quartz-countertops via CATEGORY_MAP
  }

  return slug;
}

/**
 * Resolve a Bedrosians product to a PIM category_id (slug → id via categoryLookup).
 * Thin wrapper over categorizeBedSlug used by the scrape insert.
 */
function resolveCategoryId(materialType, categoryLookup, collection, opts = {}) {
  const slug = categorizeBedSlug(materialType, collection, opts);
  return slug ? (categoryLookup.get(slug) || null) : null;
}

// ══════════════════════════════════════════════════════════════
// Reconcile — authoritative post-scrape pass (see Phase 5 in run())
// ══════════════════════════════════════════════════════════════

const ACCESSORY_CATEGORY_SLUGS = ['trim-accessories', 'transitions-moldings'];
// Categories whose items are sold per piece/sheet (sell_by='unit', price_basis='per_unit').
const UNIT_CATEGORY_SLUGS = new Set([
  'porcelain-slabs', 'quartz-countertops', 'granite-countertops', 'quartzite-countertops',
  'marble-countertops', 'soapstone-countertops', 'mosaic-tile', 'stacked-stone',
  'trim-accessories', 'transitions-moldings',
]);
// Trailing type labels the display_name may have baked in (storefront/docs derive type from the
// live category, so the suffix must never be stored). Longest first so "Natural Stone Tile" wins.
const TYPE_SUFFIXES = [
  'Natural Stone Tile', 'Wood Look Tile', 'Large Format Tile', 'Commercial Tile', 'Decorative Tile',
  'Backsplash Tile', 'Fluted Tile', 'Porcelain Tile', 'Ceramic Tile', 'Mosaic Tile', 'Pool Tile',
  'Wall Tile', 'Carpet Tile', 'Engineered Hardwood', 'Solid Hardwood', 'Waterproof Wood', 'Hardwood',
  'Porcelain Slab', 'Quartz Countertop', 'Granite Countertop', 'Quartzite Countertop',
  'Marble Countertop', 'Soapstone Countertop', 'Countertop', 'Luxury Vinyl Plank',
  'Luxury Vinyl Tile', 'Luxury Vinyl', 'SPC Vinyl', 'WPC Vinyl', 'Sheet Vinyl', 'Laminate', 'Carpet',
  'Stacked Stone', 'Wall Base', 'Molding', 'Stair Tread', 'Paver',
].sort((a, b) => b.length - a.length);
const FINISH_WORDS = /\b(gloss(?:y)?|matte|honed|polished|satin|glazed|natural|brushed|tumbled|chiseled|lappato|textured|flamed|leathered|sandblasted)\b/ig;
// Words that are never a color: format, finish, shape, material, part types.
const NONCOLOR_WORDS = /\b(wall|floor|subway|shower|countertop|tile|mosaic|field|deco(?:rative)?|pattern|slab|sheet|plank|ceramic|porcelain|marble|glass|stone|granite|quartzite|travertine|limestone|bullnose|jolly|liner|pencil|molding|trim|chair ?rail|v-?cap|cove ?base|listello|cane|edge|round|corner|honed|matte|glossy|polished|satin|glazed|brushed|tumbled|chiseled)\b/ig;
const esc = (s) => (s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Parse "0.5x8" / '10.25" x 11.75"' → {min,max} inches, or null. */
function parseDims(sizeStr) {
  const m = (sizeStr || '').match(/(\d+(?:\.\d+)?)\s*["”]?\s*[xX×]\s*(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const a = parseFloat(m[1]), b = parseFloat(m[2]);
  return { min: Math.min(a, b), max: Math.max(a, b) };
}

/** A long, ≤1"-wide piece is a pencil/liner/edge-trim strip, not a tile. */
function isThinStrip(dims) { return dims && dims.min <= 1 && dims.max >= 4; }

/**
 * Short accessory label from a trim/liner SKU. Reads the variant_name FIRST (it carries the real
 * type, e.g. "Reducer 1.75x76.75", "Stair Nose", "Quarter Round"), then the name, then falls back
 * to size (a ≤0.75"-wide strip is a pencil liner). Specific molding types before generic.
 */
function accessoryLabelFor(name, variantName, vendorSku, dims) {
  const s = `${name || ''} ${variantName || ''} ${vendorSku || ''}`;
  if (/flush\s*stair\s*nos/i.test(s)) return 'Flush Stairnose';
  if (/stair\s*nos|nosing/i.test(s)) return 'Stairnose';
  if (/t[-\s]?mold/i.test(s)) return 'T-Mold';
  if (/reducer/i.test(s)) return 'Reducer';
  if (/threshold/i.test(s)) return 'Threshold';
  if (/quarter\s*round/i.test(s)) return 'Quarter Round';
  if (/end\s*cap/i.test(s)) return 'End Cap';
  if (/chair\s*rail/i.test(s)) return 'Chair Rail';
  if (/v-?cap/i.test(s)) return 'V-Cap';
  if (/cove\s*base/i.test(s)) return 'Cove Base';
  if (/jolly/i.test(s)) return 'Jolly Trim';
  if (/bull?nos/i.test(s)) return 'Bullnose';
  if (/listello/i.test(s)) return 'Listello';
  if (/pencil/i.test(s)) return 'Pencil Liner';
  if (dims && dims.min <= 0.75 && dims.max >= 4) return 'Pencil Liner';  // 0.5"/0.75"-wide strip
  if (dims && dims.min <= 2 && dims.max >= 6) return 'Liner';
  return 'Trim';
}

/** Product color from name minus collection, stripped of size/finish/format/type words. */
function deriveProductColor(name, collection) {
  let s = (name || '').replace(new RegExp('^' + esc(collection), 'i'), '');
  const inMatch = s.match(/\bin\s+([A-Za-z][A-Za-z0-9 &/'-]+?)\s*$/);
  if (inMatch) s = inMatch[1];
  s = s.replace(/\d[\d.]*\s*["”]?\s*[xX×]\s*[\d.]+\s*["”]?/g, '')  // sizes
       .replace(FINISH_WORDS, '').replace(NONCOLOR_WORDS, '')
       .replace(/(^|\s)[xX](?=\s|$)/g, ' ')                       // leftover standalone dimension "x"
       .replace(/\s+/g, ' ').trim();
  // Fallback for mangled accessory names ("x 2.73\" Sand", "x 1.77\" x .28\" Canvas"): if the
  // result still has digits/quotes or is empty, take the trailing color word(s) — moldings always
  // end with their color, which matches the parent plank.
  if (!s || /[0-9"”]/.test(s)) {
    const m = (name || '').match(/([A-Za-z][A-Za-z '&/-]*?)\s*$/);
    if (m) s = m[1].trim();
  }
  return s && s.replace(/[^a-z]/ig, '').length >= 2 ? s : null;
}

/** Strip a trailing baked type-suffix so the type stays category-driven. */
function stripTypeSuffix(text) {
  let s = text || '';
  for (let pass = 0; pass < 2; pass++) {
    let changed = false;
    for (const suf of TYPE_SUFFIXES) {
      const re = new RegExp('\\s+' + esc(suf) + '\\s*$', 'i');
      if (re.test(s)) { s = s.replace(re, '').trim(); changed = true; break; }
    }
    if (!changed) break;
  }
  return s;
}

/**
 * Reconcile every Bedrosians product against its fully-scraped SKUs.
 * Returns a stats object. Idempotent.
 */
export async function reconcileBedProducts(pool, vendor_id) {
  const stats = { categoryFixed: 0, colorFixed: 0, displayNameFixed: 0, sellByFixed: 0,
    slabPriceConverted: 0, accessorySkus: 0, pruned: 0, accessoryLinks: 0, nullPrice: 0 };

  const slugToId = new Map();
  for (const r of (await pool.query('SELECT id, slug FROM categories WHERE is_active = true')).rows) {
    slugToId.set(r.slug, r.id);
  }

  // Products
  const prods = (await pool.query(
    `SELECT p.id, p.name, p.collection, p.display_name, c.slug AS cat
     FROM products p LEFT JOIN categories c ON c.id = p.category_id
     WHERE p.vendor_id = $1`, [vendor_id])).rows;
  const byId = new Map(prods.map(p => [p.id, { ...p, skus: [] }]));

  // SKUs + pivoted attributes + latest price
  const skus = (await pool.query(
    `SELECT s.id, s.product_id, s.vendor_sku, s.variant_name, s.sell_by, s.variant_type, s.accessory_label,
       max(CASE WHEN a.slug='size' THEN sa.value END) AS size,
       max(CASE WHEN a.slug='material' THEN sa.value END) AS material,
       max(CASE WHEN a.slug='application' THEN sa.value END) AS application,
       max(CASE WHEN a.slug='shape' THEN sa.value END) AS shape,
       max(CASE WHEN a.slug='color' THEN sa.value END) AS color,
       pr.price_basis, pr.retail_price, pk.sqft_per_box
     FROM skus s
     JOIN products p ON p.id = s.product_id
     LEFT JOIN sku_attributes sa ON sa.sku_id = s.id
     LEFT JOIN attributes a ON a.id = sa.attribute_id
       AND a.slug IN ('size','material','application','shape','color')
     LEFT JOIN pricing pr ON pr.sku_id = s.id
     LEFT JOIN packaging pk ON pk.sku_id = s.id
     WHERE p.vendor_id = $1
     GROUP BY s.id, s.product_id, s.vendor_sku, s.variant_name, s.sell_by, s.variant_type, s.accessory_label,
       pr.price_basis, pr.retail_price, pk.sqft_per_box`, [vendor_id])).rows;
  for (const s of skus) { const p = byId.get(s.product_id); if (p) p.skus.push(s); }

  const colorAttrId = (await pool.query("SELECT id FROM attributes WHERE slug='color'")).rows[0]?.id;

  for (const p of byId.values()) {
    if (!p.skus.length) continue;

    // ── Aggregate context ──
    const mergedApp = [...new Set(p.skus.map(s => s.application).filter(Boolean))].join(', ');
    const materials = p.skus.map(s => s.material).filter(Boolean);
    const material = materials.sort((a, b) =>
      materials.filter(x => x === b).length - materials.filter(x => x === a).length)[0] || null;
    // A SKU is a slab if its vendor_sku is SLAB-coded or its size is slab-sized — large in
    // BOTH dimensions (a lone >50" side would sweep in 10x60–12x72 wood-look planks).
    const isSlabSku = (s) => {
      if (/SLAB/i.test(s.vendor_sku || '')) return true;
      const d = parseDims(s.size);
      return !!d && d.min > 24 && d.max > 50;
    };
    // The PRODUCT is a slab only from product-level signals (SLAB collection/name, quartz/mineral
    // material) OR when EVERY non-accessory SKU is a slab (e.g. Magnifica Encore, all 63"×126").
    // Requiring "every" — not "some" — stops a grab-bag marble line like "Calacatta" (12x24/3x12
    // tiles + a couple SLAB SKUs) from being mis-filed as a countertop slab.
    const tileSkus = p.skus.filter(s => s.variant_type !== 'accessory');
    const isSlab = /^SLAB/i.test(p.collection || '') || /\b(slab|bookmatch)/i.test(p.name || '')
      || ['mineral surface', 'quartz'].includes((material || '').toLowerCase())
      || (tileSkus.length > 0 && tileSkus.every(isSlabSku));
    // A "real tile" SKU: non-accessory, not a slab, with a normal tile size (2"–50"). Its presence
    // means a product sitting in a slab/countertop category is really a grab-bag tile line.
    const hasRealTile = p.skus.some(s => {
      if (s.variant_type === 'accessory' || isSlabSku(s)) return false;
      const d = parseDims(s.size);
      return d && d.min >= 2 && d.max <= 50;
    });

    // ── a. Category (CORRECTIVE, not from-scratch) ──
    // The scrape-time category used rich raw data (esp. shape, which is sparse once stored — 60%+
    // of mosaics have no shape attribute), so re-deriving from stored attributes would collapse
    // mosaics into field tile. Instead, keep the existing category and only fix high-confidence
    // issues detectable from the aggregate: slabs, wall-only field tiles, floor tiles stuck in
    // wall, and ledgers.
    const mt = (material || '').toLowerCase();
    const floorCapable = /floor/i.test(mergedApp);
    const wallOnly = /wall/i.test(mergedApp) && !floorCapable;
    const namedWallTile = /wall tile/i.test(p.name) && !/floor/i.test(p.name);
    const slabSlug = mt === 'porcelain' || mt === 'cement' ? 'porcelain-slabs'
      : mt === 'quartzite' ? 'quartzite-countertops'
      : mt === 'granite' ? 'granite-countertops'
      : mt === 'soapstone' ? 'soapstone-countertops'
      : ['marble', 'travertine', 'limestone', 'onyx'].includes(mt) ? 'marble-countertops'
      : ['quartz', 'mineral surface'].includes(mt) ? 'quartz-countertops' : null;
    const SLAB_CATS = new Set(['porcelain-slabs', 'quartz-countertops', 'granite-countertops',
      'quartzite-countertops', 'marble-countertops', 'soapstone-countertops']);
    const explicitSlab = /^SLAB/i.test(p.collection || '') || /\b(slab|bookmatch)/i.test(p.name || '');
    let target = p.cat;
    if (isSlab && slabSlug) {
      target = slabSlug;                                           // Magnifica Encore, SLAB*, >50"
    } else if (SLAB_CATS.has(p.cat) && hasRealTile && !explicitSlab) {
      // Wrongly in a slab/countertop category but has real tile SKUs → grab-bag tile line (Calacatta,
      // White Carrara). Route to its material's tile category. Real slabs (no tile SKU) are untouched.
      target = mt === 'porcelain' || mt === 'cement' ? 'porcelain-tile'
        : mt === 'ceramic' ? 'ceramic-tile'
        : /marble|travertine|limestone|granite|quartzite|slate|onyx/.test(mt) ? 'natural-stone' : p.cat;
    } else if (['porcelain-tile', 'ceramic-tile'].includes(p.cat) && (wallOnly || namedWallTile)) {
      target = 'backsplash-wall';                                  // Cloe, Traditions, Donna
    } else if (p.cat === 'backsplash-wall' && floorCapable && !namedWallTile && !wallOnly) {
      target = mt === 'ceramic' ? 'ceramic-tile'                   // Othello (floor plank, "Wall Tile" format)
        : /marble|travertine|limestone|granite|quartzite|slate|onyx/.test(mt) ? 'natural-stone'
        : 'porcelain-tile';
    } else if ((/\bledger\b/i.test(p.name) || /\bledger\b/i.test(p.collection || '')) && p.cat === 'natural-stone') {
      target = 'stacked-stone';
    } else if (['engineered-hardwood', 'lvp-plank'].includes(p.cat) && p.skus.length
        && p.skus.every(s => /t-mold|reducer|stair\s*nos|nosing|threshold|quarter\s*round|end\s*cap|\bmolding\b|\btrim\b/i.test(`${p.name} ${s.variant_name || ''}`))) {
      // A wood/vinyl product whose EVERY SKU is a molding is an accessory, not a plank. The scraper
      // mangles some names ("x 2.73\" Sand") so the type is only in the variant_name — detect from
      // there so it lands in transitions-moldings and gets attached to its parent planks.
      target = 'transitions-moldings';
    }
    if (target && target !== p.cat && slugToId.has(target)) {
      await pool.query('UPDATE products SET category_id=$2, updated_at=CURRENT_TIMESTAMP WHERE id=$1',
        [p.id, slugToId.get(target)]);
      p.cat = target;
      stats.categoryFixed++;
    }
    const unitSold = UNIT_CATEGORY_SLUGS.has(p.cat);

    // ── b. Color — fix missing / format-word / type-word colors from the name ──
    if (colorAttrId) {
      const derived = deriveProductColor(p.name, p.collection)
        || (p.collection && p.name && p.name.toLowerCase() === p.collection.toLowerCase() ? p.collection : null);
      for (const s of p.skus) {
        const cur = (s.color || '').trim();
        // Replace a clearly-bad color: missing, a bare format/finish word ("Wall"/"Gloss"), or
        // garbage from a mangled accessory name (contains digits/quotes, or a leading "x " like
        // "x Sand"). Never churn a real multi-word color that merely contains such a word.
        const bad = !cur || /^(walls?|floors?|subway|shower ?walls?|tile|n\/?a|gloss(?:y)?|matte|honed|polished|satin|glazed|natural|brushed|tumbled)$/i.test(cur)
          || /["”]/.test(cur) || /^x\s/i.test(cur);  // quote or leading-"x" = mangled; NOT a bare digit (legit "Design 4")
        if (bad && derived) {
          await pool.query(
            `INSERT INTO sku_attributes (sku_id, attribute_id, value) VALUES ($1,$2,$3)
             ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value=EXCLUDED.value`,
            [s.id, colorAttrId, derived]);
          s.color = derived;
          stats.colorFixed++;
        }
      }
    }

    // ── c. Accessory-variant marking (authoritative) ──
    // A SKU is an accessory iff it's a thin strip (0.5"×8" liner) OR its name/variant explicitly
    // names a trim piece. Decision does NOT use the vendor_sku (codes like "SN"/"ATC" are too
    // ambiguous and would mis-mark field tiles). Clear a stale accessory flag on a real tile SKU.
    const TILE_CATS = new Set(['porcelain-tile', 'ceramic-tile', 'mosaic-tile', 'backsplash-wall', 'natural-stone', 'backsplash-tile']);
    for (const s of p.skus) {
      const dims = parseDims(s.size);
      const nameTrim = /bull?nos|jolly|\bliner\b|pencil|t[-\s]?mold|reducer|stair\s*nos|nosing|threshold|end\s*cap|quarter\s*round|chair\s*rail|v-?cap|cove\s*base|listello/i.test(`${p.name} ${s.variant_name || ''}`);
      const shouldBeAcc = isThinStrip(dims) || nameTrim;
      if (shouldBeAcc) {
        // Derive the specific type label authoritatively (fixes generic "Trim"/"Molding").
        const label = accessoryLabelFor(p.name, s.variant_name, s.vendor_sku, dims);
        if (s.variant_type !== 'accessory' || s.accessory_label !== label) {
          await pool.query(
            'UPDATE skus SET variant_type=$2, accessory_label=$3, updated_at=CURRENT_TIMESTAMP WHERE id=$1',
            [s.id, 'accessory', label]);
          if (s.variant_type !== 'accessory') stats.accessorySkus++;
          s.variant_type = 'accessory';
          s.accessory_label = label;
        }
      } else if (s.variant_type === 'accessory' && TILE_CATS.has(p.cat)) {
        await pool.query('UPDATE skus SET variant_type=NULL, accessory_label=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=$1', [s.id]);
        s.variant_type = null;
      }
    }

    // ── d. display_name — strip baked type-suffix (fallback to name minus collection). For
    // accessory products the name is often mangled ("Trim in Chambord"), so use the derived color
    // (the type is shown separately via accessory_label + category suffix). ──
    const nameMinusColl = (p.name || '').replace(new RegExp('^' + esc(p.collection) + '\\s*', 'i'), '').trim();
    const dnBase = (ACCESSORY_CATEGORY_SLUGS.includes(p.cat) && deriveProductColor(p.name, p.collection))
      || (p.display_name && p.display_name.trim())
      || nameMinusColl || p.name;
    const dn = stripTypeSuffix(dnBase);
    if (dn && dn !== p.display_name) {
      await pool.query('UPDATE products SET display_name=$2, updated_at=CURRENT_TIMESTAMP WHERE id=$1', [p.id, dn]);
      stats.displayNameFixed++;
    }

    // ── e. sell_by + price_basis (accessory + slab SKUs are always per-piece) ──
    for (const s of p.skus) {
      const slabSku = isSlabSku(s);
      const wantUnit = unitSold || s.variant_type === 'accessory' || slabSku;
      const wantSellBy = wantUnit ? 'unit' : 'box';
      if (s.sell_by !== wantSellBy) {
        await pool.query('UPDATE skus SET sell_by=$2, updated_at=CURRENT_TIMESTAMP WHERE id=$1', [s.id, wantSellBy]);
        stats.sellByFixed++;
      }
      // A slab still carrying a per-sqft price can only go per-piece by converting the
      // price with its area (the listing pass does this when the slab size parses; Box SF
      // from the detail page covers the rest here). With no area at all the per-sqft
      // basis stands — unit+per_sqft+no-box renders "/sqft" and the rep enters the slab
      // size at line level. Relabeling a per-sqft figure as per_unit without converting
      // is how Magnifica Fusion ended up at "$13.95/ea".
      const slabArea = parseFloat(s.sqft_per_box);
      if (slabSku && s.price_basis === 'per_sqft' && s.retail_price != null && slabArea > 0) {
        await pool.query(
          `UPDATE pricing SET retail_price = ROUND(retail_price * $2, 2),
             cost = ROUND(cost * $2, 2), price_basis = 'per_unit' WHERE sku_id = $1`,
          [s.id, slabArea]);
        s.price_basis = 'per_unit';
        stats.slabPriceConverted++;
      }
      const wantBasis = !wantUnit ? 'per_sqft'
        : (slabSku && s.price_basis === 'per_sqft') ? 'per_sqft' : 'per_unit';
      if (s.retail_price != null && s.price_basis && s.price_basis !== wantBasis) {
        await pool.query('UPDATE pricing SET price_basis=$2 WHERE sku_id=$1', [s.id, wantBasis]);
      }
      if (s.retail_price == null) stats.nullPrice++;
    }
  }

  // ── f. Prune orphan products (no SKU, no media) ──
  const pruneRes = await pool.query(
    `DELETE FROM products p WHERE p.vendor_id=$1
       AND NOT EXISTS (SELECT 1 FROM skus s WHERE s.product_id=p.id)
       AND NOT EXISTS (SELECT 1 FROM media_assets m WHERE m.product_id=p.id)`, [vendor_id]);
  stats.pruned = pruneRes.rowCount;

  // ── g. Cross-product accessory attachment (collection + color) ──
  stats.accessoryLinks = await attachBedAccessories(pool, vendor_id);

  return stats;
}

/** Normalize a collection so accessory + main lines align ("Marin Mosaics" ↔ "Marin"). */
function normColl(c) { return (c || '').toLowerCase().replace(/\s*(mosaics?|slabs?)\s*$/i, '').trim(); }

/**
 * Link Bedrosians trim/molding products to parent tiles by normalized collection + color.
 * Color-specific accessories link only to same-color parents; color-less (T-Moldings) link
 * collection-wide. Idempotent (ON CONFLICT DO NOTHING). Returns links written.
 */
async function attachBedAccessories(pool, vendor_id) {
  const acc = (await pool.query(
    `SELECT s.id, p.name, p.collection,
       (SELECT sa.value FROM sku_attributes sa JOIN attributes a ON a.id=sa.attribute_id
         WHERE sa.sku_id=s.id AND a.slug='color' LIMIT 1) AS color
     FROM skus s JOIN products p ON p.id=s.product_id JOIN categories c ON c.id=p.category_id
     WHERE p.vendor_id=$1 AND c.slug = ANY($2) AND s.status IN ('active','draft') AND s.is_sample=false
       AND p.collection <> ''`, [vendor_id, ACCESSORY_CATEGORY_SLUGS])).rows;
  const mains = (await pool.query(
    `SELECT s.id, p.name, p.collection
     FROM skus s JOIN products p ON p.id=s.product_id JOIN categories c ON c.id=p.category_id
     WHERE p.vendor_id=$1 AND NOT (c.slug = ANY($2)) AND s.status IN ('active','draft') AND s.is_sample=false
       AND p.collection <> ''`, [vendor_id, ACCESSORY_CATEGORY_SLUGS])).rows;

  const mainsByColl = new Map();
  for (const m of mains) {
    const k = normColl(m.collection);
    if (!mainsByColl.has(k)) mainsByColl.set(k, []);
    mainsByColl.get(k).push(m);
  }

  const links = [];
  for (const a of acc) {
    const pool2 = mainsByColl.get(normColl(a.collection));
    if (!pool2 || !pool2.length) continue;
    const color = deriveProductColor(a.name, a.collection);
    let matched;
    if (color && color.replace(/[^a-z]/ig, '').length >= 3) {
      const re = new RegExp('(^|[^a-z])' + esc(color) + '([^a-z]|$)', 'i');
      matched = pool2.filter(m => re.test(m.name));
      if (!matched.length) continue; // don't pollute other colors
    } else {
      matched = pool2; // collection-wide (color-less T-Molding etc.)
    }
    let sort = 0;
    for (const m of matched) if (m.id !== a.id) links.push([m.id, a.id, sort++]);
  }

  let written = 0;
  const BATCH = 500;
  for (let i = 0; i < links.length; i += BATCH) {
    const batch = links.slice(i, i + BATCH);
    const values = [], params = [];
    batch.forEach((b, j) => { const o = j * 3; values.push(`($${o+1},$${o+2},$${o+3})`); params.push(b[0], b[1], b[2]); });
    const res = await pool.query(
      `INSERT INTO sku_accessories (parent_sku_id, accessory_sku_id, sort_order)
       VALUES ${values.join(',')} ON CONFLICT (parent_sku_id, accessory_sku_id) DO NOTHING`, params);
    written += res.rowCount;
  }
  return written;
}

/**
 * True when Bedrosians' SellingUom is a square-foot unit, i.e. PriceToDisplay is a
 * per-sqft figure. Handles both object {Id: "SF", ...} and string formats.
 */
function isSqftUom(uom) {
  if (!uom) return false;
  if (typeof uom === 'object') {
    const id = (uom.Id || uom.id || '').toUpperCase();
    if (id === 'SF' || id === 'SQFT') return true;
    const name = (uom.Name || uom.name || '').toLowerCase();
    return name.includes('sq') || name.includes('foot') || name.includes('feet');
  }
  const lower = String(uom).toLowerCase().trim();
  return lower === 'sf' || lower.includes('sqft') || lower.includes('sq ft')
    || lower.includes('square') || lower.includes('foot') || lower.includes('feet');
}

/**
 * Map Bedrosians SellingUom to our sell_by field.
 * Handles both object {Id: "SF", Name: "Sq. Ft."} and string formats.
 */
function mapUomToSellBy(uom) {
  if (!uom) return 'box';

  // Handle object format: {Id: "SF", Name: "Sq. Ft.", IsFractional: true}
  if (typeof uom === 'object') {
    const id = (uom.Id || uom.id || '').toUpperCase();
    if (id === 'SF' || id === 'SQFT') return 'box';
    if (id === 'PCS' || id === 'PC' || id === 'EA' || id === 'EACH') return 'unit';
    if (id === 'CTN' || id === 'BOX') return 'box';
    // Fall back to Name
    const name = (uom.Name || uom.name || '').toLowerCase();
    if (name.includes('sq') || name.includes('foot') || name.includes('feet')) return 'box';
    if (name.includes('piece') || name.includes('each')) return 'unit';
    if (name.includes('carton') || name.includes('box')) return 'box';
    return 'box';
  }

  // Handle string format
  const lower = String(uom).toLowerCase();
  if (lower.includes('sqft') || lower.includes('sq ft') || lower.includes('square')) return 'box';
  if (lower.includes('piece') || lower.includes('each') || lower.includes('unit')) return 'unit';
  if (lower.includes('box') || lower.includes('carton')) return 'box';
  return 'box';
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
