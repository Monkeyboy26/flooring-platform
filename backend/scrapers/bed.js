import {
  launchBrowser, delay, upsertProduct, upsertSku,
  upsertSkuAttribute, upsertPackaging, upsertPricing,
  appendLog, addJobError
} from './base.js';

const DEFAULT_CONFIG = {
  categories: [
    '/en/product/list/porcelain/',
    '/en/product/list/ceramic-tiles/',
    '/en/product/list/vinyl-flooring/',
    '/en/product/list/marble-tiles/',
    '/en/product/list/flooring/'
  ],
  perPage: 180,
  delayMs: 1500,
  scrapePackaging: true
};

/**
 * Bedrosians scraper.
 *
 * Bedrosians is an AngularJS app that embeds structured product data in
 * <script> tags as JS objects. We extract this JSON from page source
 * instead of parsing the rendered DOM — much faster and more reliable.
 *
 * Listing pages embed: window.bdApp.value('$model', { Products: [...] })
 * Detail pages embed:  productDetailModel with packaging info.
 */
export async function run(pool, job, source) {
  const config = { ...DEFAULT_CONFIG, ...(source.config || {}) };
  const baseUrl = source.base_url.replace(/\/$/, '');
  const vendor_id = source.vendor_id;

  let browser;
  let totalFound = 0;
  let totalCreated = 0;
  let totalUpdated = 0;
  let totalSkusCreated = 0;

  try {
    await appendLog(pool, job.id, 'Launching browser...');
    browser = await launchBrowser();

    // Phase 1: Collect all products from listing pages
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

    totalFound = allProducts.size;
    await appendLog(pool, job.id, `Total unique products across all categories: ${totalFound}`, {
      products_found: totalFound
    });

    // Phase 2: Upsert products and SKUs from listing data
    const skuMap = new Map(); // ProductCode -> sku DB id (for packaging phase)
    let idx = 0;

    for (const [productCode, raw] of allProducts) {
      idx++;
      try {
        const mapped = mapListingProduct(raw);
        if (!mapped.name) {
          await appendLog(pool, job.id, `Skipped ${productCode} — no product name`);
          continue;
        }

        // Upsert product
        const product = await upsertProduct(pool, {
          vendor_id,
          name: mapped.name,
          collection: mapped.collection,
          category_id: null,
          description_short: mapped.description ? mapped.description.slice(0, 255) : null,
          description_long: mapped.description
        });

        if (product.is_new) totalCreated++;
        else totalUpdated++;

        // Upsert SKU
        const sku = await upsertSku(pool, {
          product_id: product.id,
          vendor_sku: productCode,
          internal_sku: `BED-${productCode}`,
          variant_name: mapped.size || null,
          sell_by: mapped.sellBy
        });
        if (sku.is_new) totalSkusCreated++;

        skuMap.set(productCode, sku.id);

        // Upsert attributes
        for (const [slug, value] of Object.entries(mapped.attributes)) {
          await upsertSkuAttribute(pool, sku.id, slug, value);
        }

        // Upsert pricing from listing data if available
        if (mapped.retailPrice) {
          await upsertPricing(pool, sku.id, {
            cost: 0,
            retail_price: mapped.retailPrice,
            price_basis: mapped.priceBasis
          });
        }

        // Log progress every 25 products
        if (idx % 25 === 0 || idx === allProducts.size) {
          await appendLog(pool, job.id, `Upsert progress: ${idx}/${allProducts.size}`, {
            products_found: totalFound,
            products_created: totalCreated,
            products_updated: totalUpdated,
            skus_created: totalSkusCreated
          });
        }
      } catch (err) {
        await appendLog(pool, job.id, `ERROR upserting ${productCode}: ${err.message}`);
        await addJobError(pool, job.id, `Product ${productCode}: ${err.message}`);
      }
    }

    // Phase 3: Optionally scrape detail pages for packaging data
    if (config.scrapePackaging) {
      await appendLog(pool, job.id, `Scraping detail pages for packaging data...`);
      let packagingCount = 0;
      let packIdx = 0;

      for (const [productCode, raw] of allProducts) {
        packIdx++;
        const skuId = skuMap.get(productCode);
        if (!skuId) continue;

        // Build detail URL from the product's URL field
        const detailPath = raw.ProductUrl || raw.Url || raw.ProductDetailUrl;
        if (!detailPath) continue;

        try {
          const packaging = await scrapeDetailPage(browser, baseUrl, detailPath, config);
          if (packaging) {
            await upsertPackaging(pool, skuId, packaging);
            // Update pricing with detail page data if richer
            if (packaging.retailPrice) {
              await upsertPricing(pool, skuId, {
                cost: 0,
                retail_price: packaging.retailPrice,
                price_basis: packaging.priceBasis || 'per_sqft'
              });
            }
            packagingCount++;
          }
        } catch (err) {
          await appendLog(pool, job.id, `ERROR detail page ${productCode}: ${err.message}`);
          await addJobError(pool, job.id, `Detail ${productCode}: ${err.message}`);
        }

        // Log packaging progress every 25
        if (packIdx % 25 === 0 || packIdx === allProducts.size) {
          await appendLog(pool, job.id, `Packaging progress: ${packIdx}/${allProducts.size} (${packagingCount} updated)`);
        }

        await delay(config.delayMs);
      }

      await appendLog(pool, job.id, `Packaging phase complete: ${packagingCount} SKUs updated`);
    }

    // Final summary
    await appendLog(pool, job.id, `Scrape complete. Found: ${totalFound}, Created: ${totalCreated}, Updated: ${totalUpdated}, SKUs: ${totalSkusCreated}`, {
      products_found: totalFound,
      products_created: totalCreated,
      products_updated: totalUpdated,
      skus_created: totalSkusCreated
    });
  } finally {
    if (browser) await browser.close();
  }
}

/**
 * Scrape all listing pages for a category.
 * Returns an array of raw product objects from the embedded JSON.
 */
async function scrapeListingPages(browser, baseUrl, categoryPath, config) {
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

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

    const firstPageData = await extractListingData(page);
    if (firstPageData.products.length > 0) {
      allProducts.push(...firstPageData.products);
    }

    const totalPages = firstPageData.totalPages || 1;

    // Scrape remaining pages
    for (let pageNum = 2; pageNum <= totalPages; pageNum++) {
      const pageUrl = `${baseUrl}${categoryPath}?page=${pageNum}&perPage=${config.perPage}`;
      await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await delay(config.delayMs);

      const pageData = await extractListingData(page);
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
async function extractListingData(page) {
  const html = await page.content();
  const result = { products: [], totalPages: 1 };

  // Strategy 1: Extract from window.bdApp.value('$model', {...})
  // The data is embedded as a JS object literal in a script tag
  const modelMatch = html.match(/window\.bdApp\.value\s*\(\s*'\$model'\s*,\s*(\{[\s\S]*?\})\s*\)\s*;/);
  if (modelMatch) {
    try {
      const modelStr = modelMatch[1];
      const model = safeParseJsObject(modelStr);
      if (model && model.Products) {
        result.products = Array.isArray(model.Products) ? model.Products : [];
      }
      // Extract pagination info
      if (model && model.TotalPages) {
        result.totalPages = parseInt(model.TotalPages, 10) || 1;
      } else if (model && model.Pagination && model.Pagination.TotalPages) {
        result.totalPages = parseInt(model.Pagination.TotalPages, 10) || 1;
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
        // AngularJS apps often expose the model on the scope or as a global
        if (typeof window !== 'undefined') {
          // Try accessing via angular injector
          try {
            const injector = window.angular && window.angular.element(document.body).injector();
            if (injector) {
              const model = injector.get('$model');
              if (model && model.Products) {
                return {
                  products: model.Products,
                  totalPages: model.TotalPages || model.Pagination?.TotalPages || 1
                };
              }
            }
          } catch (e) { /* not available */ }

          // Try window-level variables
          if (window.$model && window.$model.Products) {
            return {
              products: window.$model.Products,
              totalPages: window.$model.TotalPages || 1
            };
          }
        }
        return null;
        /* eslint-enable no-undef */
      });

      if (evalResult && evalResult.products) {
        result.products = evalResult.products;
        result.totalPages = parseInt(evalResult.totalPages, 10) || 1;
      }
    } catch (e) {
      // Fall through
    }
  }

  // Strategy 3: Look for JSON-like product arrays in script tags
  if (result.products.length === 0) {
    const jsonMatch = html.match(/"Products"\s*:\s*(\[[\s\S]*?\])\s*[,}]/);
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

/**
 * Scrape a single product detail page for packaging data.
 */
async function scrapeDetailPage(browser, baseUrl, detailPath, config) {
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

  // Block images, fonts, CSS
  await page.setRequestInterception(true);
  page.on('request', req => {
    const type = req.resourceType();
    if (['image', 'font', 'stylesheet', 'media'].includes(type)) {
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

    // Strategy 1: Extract productDetailModel from embedded script
    const detailMatch = html.match(/productDetailModel\s*[=:]\s*(\{[\s\S]*?\})\s*[;\n]/);
    if (detailMatch) {
      try {
        const detail = safeParseJsObject(detailMatch[1]);
        return extractPackagingFromDetail(detail);
      } catch (e) { /* fall through */ }
    }

    // Strategy 2: Try to extract from bdApp model on detail page
    const modelMatch = html.match(/window\.bdApp\.value\s*\(\s*'\$model'\s*,\s*(\{[\s\S]*?\})\s*\)\s*;/);
    if (modelMatch) {
      try {
        const model = safeParseJsObject(modelMatch[1]);
        return extractPackagingFromDetail(model);
      } catch (e) { /* fall through */ }
    }

    // Strategy 3: Parse packaging specs from rendered HTML table/spec list
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

      // Check dt/dd pairs
      document.querySelectorAll('dt').forEach(dt => {
        const key = dt.textContent.trim().toLowerCase();
        const dd = dt.nextElementSibling;
        if (dd && dd.tagName === 'DD') {
          const val = dd.textContent.trim();
          const mapped = specMap[key];
          if (mapped && val) result[mapped] = val;
        }
      });

      // Check table rows
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

      // Check any element pairs with spec-like text
      if (Object.keys(result).length === 0) {
        const bodyText = document.body.innerText;
        for (const [label, field] of Object.entries(specMap)) {
          const re = new RegExp(label.replace(/[()]/g, '\\$&') + '\\s*[:\\-]?\\s*([\\d.]+)', 'i');
          const m = bodyText.match(re);
          if (m) result[field] = m[1];
        }
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
  } finally {
    await page.close();
  }
}

/**
 * Extract packaging fields from a detail model object.
 */
function extractPackagingFromDetail(model) {
  if (!model) return null;

  // Bedrosians detail models may nest packaging under various keys
  const src = model.Packaging || model.BoxInfo || model;

  const result = {
    sqft_per_box: parseNum(src.BoxSF || src.BoxSqFt || src.SqFtPerBox || src.BoxSquareFeet),
    pieces_per_box: parseInt(src.BoxPieces || src.PiecesPerBox || src.BoxPcs, 10) || null,
    weight_per_box_lbs: parseNum(src.BoxWeight || src.WeightPerBox || src.BoxWeightLbs),
    boxes_per_pallet: parseInt(src.PalletBoxes || src.BoxesPerPallet || src.PalletCartons, 10) || null,
    sqft_per_pallet: parseNum(src.PalletSF || src.PalletSqFt || src.SqFtPerPallet),
    weight_per_pallet_lbs: parseNum(src.PalletWeight || src.WeightPerPallet || src.PalletWeightLbs)
  };

  // Also check for pricing on the detail page
  if (src.Price || src.PriceToDisplay || model.PriceToDisplay) {
    const priceObj = src.PriceToDisplay || model.PriceToDisplay || {};
    const currentPrice = parseNum(priceObj.CurrentPrice || priceObj.Price || src.Price);
    if (currentPrice) {
      result.retailPrice = currentPrice;
      result.priceBasis = mapUomToPriceBasis(src.SellingUom || model.SellingUom);
    }
  }

  // Only return if we got at least one packaging field
  if (result.sqft_per_box || result.pieces_per_box || result.weight_per_box_lbs) {
    return result;
  }
  return null;
}

/**
 * Map a Bedrosians listing product to our PIM schema.
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

  // Price extraction
  let retailPrice = null;
  if (raw.PriceToDisplay) {
    retailPrice = parseNum(raw.PriceToDisplay.CurrentPrice || raw.PriceToDisplay.Price || raw.PriceToDisplay);
  }

  return {
    name: raw.Name || raw.ProductName || '',
    collection: raw.ProductSeries || raw.Series || null,
    description: raw.Description || raw.ShortDescription || null,
    size: raw.Size || null,
    sellBy: mapUomToSellBy(raw.SellingUom),
    attributes,
    retailPrice,
    priceBasis: mapUomToPriceBasis(raw.SellingUom)
  };
}

/**
 * Map Bedrosians SellingUom to our sell_by field.
 */
function mapUomToSellBy(uom) {
  if (!uom) return 'sqft';
  const lower = String(uom).toLowerCase();
  if (lower.includes('sqft') || lower.includes('sq ft') || lower.includes('square')) return 'sqft';
  if (lower.includes('piece') || lower.includes('each') || lower.includes('unit')) return 'unit';
  if (lower.includes('box') || lower.includes('carton')) return 'box';
  return 'sqft';
}

/**
 * Map SellingUom to our price_basis field.
 */
function mapUomToPriceBasis(uom) {
  if (!uom) return 'per_sqft';
  const lower = String(uom).toLowerCase();
  if (lower.includes('sqft') || lower.includes('sq ft') || lower.includes('square')) return 'per_sqft';
  if (lower.includes('piece') || lower.includes('each') || lower.includes('unit')) return 'per_unit';
  return 'per_sqft';
}

/**
 * Safely parse a number from a string or number value.
 * Strips currency symbols and commas.
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
 * Handles unquoted keys, single-quoted strings, trailing commas, etc.
 */
function safeParseJsObject(str) {
  // First try standard JSON.parse
  try {
    return JSON.parse(str);
  } catch (e) {
    // Not strict JSON, try to coerce
  }

  // Convert JS object literal to JSON:
  // 1. Replace single quotes around values with double quotes
  // 2. Add quotes around unquoted keys
  // 3. Remove trailing commas
  try {
    let jsonStr = str
      // Remove JS comments
      .replace(/\/\/[^\n]*/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      // Replace single-quoted strings with double-quoted
      .replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, '"$1"')
      // Quote unquoted keys: word characters before a colon
      .replace(/(\{|,)\s*([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:/g, '$1"$2":')
      // Remove trailing commas before } or ]
      .replace(/,\s*([\]}])/g, '$1');
    return JSON.parse(jsonStr);
  } catch (e) {
    return null;
  }
}
