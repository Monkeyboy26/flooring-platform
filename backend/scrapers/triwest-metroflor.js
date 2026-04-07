import {
  launchBrowser, delay, upsertMediaAsset, upsertSkuAttribute,
  appendLog, addJobError, preferProductShot,
  fuzzyMatch, extractSpecPDFs, normalizeTriwestName
} from './base.js';

const BASE_URL = 'https://www.metroflor.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_ERRORS = 30;

/**
 * Metroflor enrichment scraper for Tri-West.
 *
 * Fetches product data from metroflor.com Shopify JSON API (no browser needed).
 * Enriches EXISTING Tri-West SKUs — never creates new products.
 * Tech: Shopify (FloorTitan theme) — uses /products.json endpoint.
 *
 * Runs AFTER import-triwest-832.cjs populates SKUs in the DB.
 */
export async function run(pool, job, source) {
  const config = source.config || {};
  const delayMs = config.delay_ms || 500; // Much faster since no browser rendering
  const vendor_id = source.vendor_id;
  const brandPrefix = 'Metroflor';

  let browser = null; // Only launched for fallback
  let errorCount = 0;
  let skusEnriched = 0;
  let skusSkipped = 0;
  let imagesAdded = 0;
  let specPdfsAdded = 0;
  let jsonMatches = 0;
  let fallbackMatches = 0;

  async function logError(msg) {
    errorCount++;
    if (errorCount <= MAX_ERRORS) {
      try { await addJobError(pool, job.id, msg); } catch { }
    }
  }

  try {
    // Load existing TW products for this brand (includes SKU-less products from DNav)
    const prodResult = await pool.query(`
      SELECT p.id AS product_id, p.name, p.collection, p.description_long
      FROM products p
      WHERE p.vendor_id = $1 AND p.collection LIKE $2
    `, [vendor_id, `${brandPrefix}%`]);

    // Also load SKU data for products that have it
    const skuResult = await pool.query(`
      SELECT s.id AS sku_id, s.vendor_sku, s.internal_sku, s.variant_name, s.product_id
      FROM skus s
      JOIN products p ON p.id = s.product_id
      WHERE p.vendor_id = $1 AND p.collection LIKE $2
    `, [vendor_id, `${brandPrefix}%`]);

    await appendLog(pool, job.id, `Found ${prodResult.rows.length} ${brandPrefix} products (${skuResult.rows.length} SKUs) to enrich`);

    if (prodResult.rows.length === 0) {
      await appendLog(pool, job.id, `No ${brandPrefix} products found — run import-triwest-832 first`);
      return;
    }

    // Build SKU lookup by product_id
    const skusByProduct = new Map();
    for (const row of skuResult.rows) {
      if (!skusByProduct.has(row.product_id)) skusByProduct.set(row.product_id, []);
      skusByProduct.get(row.product_id).push(row);
    }

    // Group products by collection + name
    const productGroups = new Map();
    for (const row of prodResult.rows) {
      const key = `${row.collection}||${row.name}`;
      if (!productGroups.has(key)) {
        productGroups.set(key, {
          product_id: row.product_id, name: row.name, collection: row.collection,
          skus: skusByProduct.get(row.product_id) || [],
        });
      }
    }

    await appendLog(pool, job.id, `Grouped into ${productGroups.size} products (${skuResult.rows.length} with SKUs)`);

    // ── Phase 1: Fetch ALL Shopify products via JSON API (no browser) ──
    await appendLog(pool, job.id, `Fetching Shopify product catalog from ${BASE_URL}/products.json...`);
    const shopifyProducts = await fetchAllShopifyProducts();
    await appendLog(pool, job.id, `Fetched ${shopifyProducts.length} Shopify products`);

    // ── Phase 2: Build lookup indexes for fast matching ──
    const { byVariantSku, byHandle, allProducts } = buildLookupMap(shopifyProducts);
    await appendLog(pool, job.id, `Built lookup map: ${byVariantSku.size} variant SKUs, ${byHandle.size} handles`);

    // ── Phase 3: Match DB products to Shopify products and extract data ──
    let processed = 0;
    const unmatchedGroups = []; // For browser fallback

    for (const [key, group] of productGroups) {
      processed++;

      try {
        // Try JSON-based matching first
        const shopifyProduct = matchShopifyProduct(group, byVariantSku, byHandle, allProducts);

        if (shopifyProduct) {
          jsonMatches++;
          const productData = extractProductData(shopifyProduct);

          // Update description if we found one and DB is empty
          if (productData.description && !group.skus[0]?.description_long) {
            await pool.query(
              'UPDATE products SET description_long = $1 WHERE id = $2 AND description_long IS NULL',
              [productData.description, group.product_id]
            );
          }

          // Upsert images (product-level)
          if (productData.images && productData.images.length > 0) {
            const sorted = preferProductShot(productData.images, group.name);
            for (let i = 0; i < Math.min(sorted.length, 8); i++) {
              const assetType = i === 0 ? 'primary' : (sorted[i].includes('room') || sorted[i].includes('scene') ? 'lifestyle' : 'alternate');
              await upsertMediaAsset(pool, {
                product_id: group.product_id,
                sku_id: null,
                asset_type: assetType,
                url: sorted[i],
                original_url: sorted[i],
                sort_order: i,
              });
              imagesAdded++;
            }
          }

          // Upsert spec PDFs from body_html
          if (productData.specPdfs && productData.specPdfs.length > 0) {
            for (let i = 0; i < productData.specPdfs.length; i++) {
              await upsertMediaAsset(pool, {
                product_id: group.product_id,
                sku_id: null,
                asset_type: 'spec_pdf',
                url: productData.specPdfs[i].url,
                original_url: productData.specPdfs[i].url,
                sort_order: i,
              });
              specPdfsAdded++;
            }
          }

          // Upsert specs as SKU attributes
          if (productData.specs && group.skus.length > 0) {
            for (const sku of group.skus) {
              for (const [attrSlug, value] of Object.entries(productData.specs)) {
                if (value) await upsertSkuAttribute(pool, sku.sku_id, attrSlug, value);
              }
              skusEnriched++;
            }
          } else {
            skusEnriched += group.skus.length;
          }
        } else {
          // No JSON match — queue for browser fallback
          unmatchedGroups.push(group);
        }
      } catch (err) {
        await logError(`${group.collection} / ${group.name}: ${err.message}`);
        skusSkipped++;
      }

      if (processed % 10 === 0) {
        await appendLog(pool, job.id, `Progress: ${processed}/${productGroups.size} products, ${jsonMatches} JSON matches, ${imagesAdded} images`);
      }
    }

    await appendLog(pool, job.id, `JSON API phase complete: ${jsonMatches} matched, ${unmatchedGroups.length} unmatched`);

    // ── Phase 4: Browser fallback for unmatched products ──
    if (unmatchedGroups.length > 0) {
      await appendLog(pool, job.id, `Launching browser fallback for ${unmatchedGroups.length} unmatched products...`);

      try {
        browser = await launchBrowser();
        const page = await browser.newPage();
        await page.setUserAgent(USER_AGENT);
        await page.setViewport({ width: 1440, height: 900 });

        for (const group of unmatchedGroups) {
          try {
            const productData = await findProductViaBrowser(page, group, delayMs);

            if (!productData) {
              skusSkipped++;
              continue;
            }

            fallbackMatches++;

            // Update description if we found one and DB is empty
            if (productData.description && !group.skus[0]?.description_long) {
              await pool.query(
                'UPDATE products SET description_long = $1 WHERE id = $2 AND description_long IS NULL',
                [productData.description, group.product_id]
              );
            }

            // Upsert images (product-level)
            if (productData.images && productData.images.length > 0) {
              const sorted = preferProductShot(productData.images, group.name);
              for (let i = 0; i < Math.min(sorted.length, 8); i++) {
                const assetType = i === 0 ? 'primary' : (sorted[i].includes('room') || sorted[i].includes('scene') ? 'lifestyle' : 'alternate');
                await upsertMediaAsset(pool, {
                  product_id: group.product_id,
                  sku_id: null,
                  asset_type: assetType,
                  url: sorted[i],
                  original_url: sorted[i],
                  sort_order: i,
                });
                imagesAdded++;
              }
            }

            // Extract spec PDFs via browser if page is available
            try {
              const specPdfs = await extractSpecPDFs(page);
              for (let i = 0; i < specPdfs.length; i++) {
                await upsertMediaAsset(pool, {
                  product_id: group.product_id,
                  sku_id: null,
                  asset_type: 'spec_pdf',
                  url: specPdfs[i].url,
                  original_url: specPdfs[i].url,
                  sort_order: i,
                });
                specPdfsAdded++;
              }
            } catch { /* spec PDF extraction is best-effort */ }

            // Upsert specs as SKU attributes
            if (productData.specs && group.skus.length > 0) {
              for (const sku of group.skus) {
                for (const [attrSlug, value] of Object.entries(productData.specs)) {
                  if (value) await upsertSkuAttribute(pool, sku.sku_id, attrSlug, value);
                }
                skusEnriched++;
              }
            } else {
              skusEnriched += group.skus.length;
            }
          } catch (err) {
            await logError(`Fallback: ${group.collection} / ${group.name}: ${err.message}`);
            skusSkipped++;
          }
        }
      } catch (err) {
        await appendLog(pool, job.id, `Browser fallback failed to launch: ${err.message}`);
        // Count all remaining unmatched as skipped
        for (const group of unmatchedGroups) {
          skusSkipped++;
        }
      }
    }

    await appendLog(pool, job.id,
      `Complete. Products: ${productGroups.size}, JSON matches: ${jsonMatches}, Fallback matches: ${fallbackMatches}, ` +
      `SKUs enriched: ${skusEnriched}, Skipped: ${skusSkipped}, Images: ${imagesAdded}, Spec PDFs: ${specPdfsAdded}, Errors: ${errorCount}`,
      { products_found: productGroups.size, products_updated: skusEnriched }
    );

  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}


// ─── Shopify JSON API Functions ─────────────────────────────────────────────

/**
 * Fetch all products from Shopify /products.json with pagination.
 * Returns flat array of all Shopify product objects.
 */
async function fetchAllShopifyProducts() {
  const products = [];
  let page = 1;

  while (true) {
    const url = `${BASE_URL}/products.json?limit=250&page=${page}`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(30000),
    });

    if (!resp.ok) {
      if (page === 1) throw new Error(`Shopify JSON API returned ${resp.status}`);
      break; // Later pages returning errors means we've likely exhausted products
    }

    const data = await resp.json();
    const batch = data.products || [];

    if (batch.length === 0) break;

    products.push(...batch);

    // If we got fewer than 250, we've reached the last page
    if (batch.length < 250) break;

    page++;
    // Small delay between pagination requests to be polite
    await delay(300);
  }

  return products;
}

/**
 * Build lookup indexes from Shopify products for fast matching.
 *
 * Returns:
 *   byVariantSku - Map<normalizedSku, shopifyProduct>
 *   byHandle     - Map<handle, shopifyProduct>
 *   allProducts  - Array of { product, titleNorm, titleWords } for fuzzy matching
 */
function buildLookupMap(shopifyProducts) {
  const byVariantSku = new Map();
  const byHandle = new Map();
  const allProducts = [];

  for (const product of shopifyProducts) {
    // Index by handle
    if (product.handle) {
      byHandle.set(product.handle.toLowerCase(), product);
    }

    // Index by variant SKUs (Shopify variants can have SKU fields)
    for (const variant of (product.variants || [])) {
      if (variant.sku) {
        const normSku = variant.sku.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (normSku) byVariantSku.set(normSku, product);
      }
    }

    // Prepare title for fuzzy matching
    const titleNorm = (product.title || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
    allProducts.push({
      product,
      titleNorm,
      titleWords: new Set(titleNorm.split(' ').filter(Boolean)),
    });
  }

  return { byVariantSku, byHandle, allProducts };
}

/**
 * Match a DB product group to a Shopify product using multiple strategies.
 *
 * Tri-West naming for Metroflor:
 *   name = "ATTRAXION DEJA BELGIUM WEAVE" (product line + collection name)
 *   collection = "Metroflor - FADED DENIM (CC) TILE" (color + format info)
 *
 * Shopify naming:
 *   title = "Metroflor LVT - Déjà New - Belgium Weave, Faded Denim"
 *
 * Strategy: extract collection name from DB `name` field, extract color from
 * DB `collection` field, and match against Shopify titles.
 */
function matchShopifyProduct(group, byVariantSku, byHandle, allProducts) {
  const productName = group.name;          // e.g. "ATTRAXION DEJA BELGIUM WEAVE"
  const rawCollection = group.collection;  // e.g. "Metroflor - FADED DENIM (CC) TILE"

  // Extract color from collection field: strip "Metroflor - ", "(CC)", size info, "TILE"/"PLK" suffix
  const colorFromCollection = rawCollection
    .replace(/^Metroflor\s*[-–—]\s*/i, '')
    .replace(/\(CC\)/gi, '')
    .replace(/\b(TILE|PLK|SPC|LVT)\b/gi, '')
    .replace(/\d+["″']?\s*[xX×]\s*\d+["″']?/g, '')
    .replace(/-?(DB|SPC|12MIL|20MIL|6MIL|8MIL)\b/gi, '')
    .trim();

  // Extract collection words from product name by stripping known prefixes
  // "ATTRAXION DEJA BELGIUM WEAVE" → "BELGIUM WEAVE"
  // "DEJA NEW LVT ENGLISH WALNUT" → "ENGLISH WALNUT"
  // "COSMOPOLITAN PLANK" → "COSMOPOLITAN"
  const collectionFromName = productName
    .replace(/^(ATTRAXION\s+)?DEJA\s*(NEW\s*)?(LVT\s*)?/i, '')
    .replace(/\b(PLANK|TILE|PLK|SPC|LVT)\b/gi, '')
    .trim();

  const normalizedColor = normalizeTriwestName(colorFromCollection).toLowerCase();
  const normalizedCollection = normalizeTriwestName(collectionFromName).toLowerCase();
  const normalizedProductName = normalizeTriwestName(productName).toLowerCase();

  // Strategy 1: Match by vendor_sku (strip MET prefix and try)
  for (const sku of group.skus) {
    if (sku.vendor_sku) {
      const normSku = sku.vendor_sku.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (normSku && byVariantSku.has(normSku)) {
        return byVariantSku.get(normSku);
      }
      // Also try without the MET prefix (Tri-West adds it)
      const withoutMet = normSku.replace(/^met/, '');
      if (withoutMet && byVariantSku.has(withoutMet)) {
        return byVariantSku.get(withoutMet);
      }
    }
  }

  // Strategy 2: Two-part containment — find Shopify titles containing BOTH collection AND color
  if (normalizedCollection.length >= 3 && normalizedColor.length >= 3) {
    for (const entry of allProducts) {
      if (entry.titleNorm.includes(normalizedCollection) && entry.titleNorm.includes(normalizedColor)) {
        return entry.product;
      }
    }
  }

  // Strategy 3: Collection-only match (less specific, for single-color products)
  if (normalizedCollection.length >= 5) {
    const collectionMatches = allProducts.filter(e => e.titleNorm.includes(normalizedCollection));
    if (collectionMatches.length === 1) {
      return collectionMatches[0].product;
    }
    // If multiple matches, try to narrow by color
    if (collectionMatches.length > 1 && normalizedColor.length >= 3) {
      const colorMatch = collectionMatches.find(e => e.titleNorm.includes(normalizedColor));
      if (colorMatch) return colorMatch.product;
    }
  }

  // Strategy 4: Handle-based matching
  const collSlug = normalizedCollection.replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  const colorSlug = normalizedColor.replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  const handleCandidates = [
    `metroflor-lvt-deja-new-${collSlug}-${colorSlug}`,
    `metroflor-lvt-${collSlug}-${colorSlug}`,
    `${collSlug}-${colorSlug}`,
  ];
  for (const handle of handleCandidates) {
    if (byHandle.has(handle)) return byHandle.get(handle);
  }

  // Strategy 5: Fuzzy match
  let bestMatch = null;
  let bestScore = 0;
  const FUZZY_THRESHOLD = 0.55;

  const composite = `${normalizedCollection} ${normalizedColor}`.trim();

  for (const entry of allProducts) {
    const title = entry.product.title || '';
    const score = fuzzyMatch(title, composite);
    if (score > bestScore) {
      bestScore = score;
      bestMatch = entry.product;
    }
  }

  if (bestScore >= FUZZY_THRESHOLD) {
    return bestMatch;
  }

  return null;
}


// ─── Data Extraction from Shopify Product Objects ───────────────────────────

/**
 * Extract images, description, specs, and spec PDFs from a Shopify product object.
 * No browser needed — works entirely from the JSON data.
 */
function extractProductData(shopifyProduct) {
  // Extract images from Shopify product.images array
  const images = (shopifyProduct.images || [])
    .map(img => img.src)
    .filter(Boolean);

  // Extract description from body_html (strip HTML tags)
  const bodyHtml = shopifyProduct.body_html || '';
  const description = bodyHtml
    ? bodyHtml.replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/&#\d+;/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 2000)
    : null;

  // Parse specs from body_html
  const specs = parseMetroflorSpecs(bodyHtml);

  // Extract spec PDFs from body_html href links
  const specPdfs = extractPdfsFromHtml(bodyHtml);

  const hasData = images.length > 0 || description || (specs && Object.keys(specs).length > 0);

  return {
    images,
    description: description || null,
    specs: specs && Object.keys(specs).length > 0 ? specs : null,
    specPdfs,
  };
}

/**
 * Parse specs from Shopify product body_html.
 * Extracts: thickness, width/size, length, wear layer, finish, edge, material, construction, sqft/carton, warranty.
 */
function parseMetroflorSpecs(html) {
  if (!html) return {};
  const text = html.replace(/<[^>]+>/g, '\n').replace(/&[a-z]+;/g, ' ').replace(/&#\d+;/g, ' ');
  const specs = {};
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  for (const line of lines) {
    const match = line.match(/^(thickness|width|length|wear\s*layer|finish|edge|material|species|size|dimensions?|construction|sqft|sq\s*ft|warranty|core|plank|format|surface)[:\s-]+(.+)/i);
    if (match) {
      const label = match[1].toLowerCase().trim();
      const value = match[2].trim();
      if (label.includes('thickness')) specs.thickness = value;
      if (label.includes('width') || label.includes('size') || label.includes('dimension') || label.includes('plank') || label.includes('format')) specs.size = value;
      if (label.includes('length')) specs.length = value;
      if (label.includes('wear')) specs.wear_layer = value;
      if (label.includes('finish') || label.includes('surface')) specs.finish = value;
      if (label.includes('edge')) specs.edge = value;
      if (label.includes('material') || label.includes('species')) specs.material = value;
      if (label.includes('construction') || label.includes('core')) specs.construction = value;
      if (label.includes('sqft') || label.includes('sq ft')) specs.sqft_per_carton = value;
      if (label.includes('warranty')) specs.warranty = value;
    }
  }

  // Also try "Label: Value" pattern in table-like structures (td/th pairs stripped to text)
  const kvPattern = /(?:^|\n)\s*([A-Za-z\s]+?)\s*:\s*(.+)/g;
  let kvMatch;
  while ((kvMatch = kvPattern.exec(text)) !== null) {
    const label = kvMatch[1].toLowerCase().trim();
    const value = kvMatch[2].trim();
    if (!value || value.length > 200) continue;
    if (label.includes('thickness') && !specs.thickness) specs.thickness = value;
    if ((label.includes('width') || label.includes('plank size') || label.includes('format')) && !specs.size) specs.size = value;
    if (label.includes('length') && !specs.length) specs.length = value;
    if (label.includes('wear layer') && !specs.wear_layer) specs.wear_layer = value;
    if ((label.includes('finish') || label.includes('surface')) && !specs.finish) specs.finish = value;
    if (label.includes('edge') && !specs.edge) specs.edge = value;
    if ((label.includes('core') || label.includes('construction')) && !specs.construction) specs.construction = value;
    if (label.includes('warranty') && !specs.warranty) specs.warranty = value;
    if ((label.includes('material') || label.includes('species')) && !specs.material) specs.material = value;
  }

  return specs;
}

/**
 * Extract PDF links from body_html.
 * Looks for href attributes ending in .pdf within the HTML string.
 * Returns array of { url, label } objects.
 */
function extractPdfsFromHtml(html) {
  if (!html) return [];

  const SPEC_KEYWORDS = [
    'spec', 'technical', 'install', 'maintenance', 'warranty',
    'care', 'data sheet', 'datasheet', 'guide', 'brochure',
  ];

  const pdfs = [];
  const seen = new Set();

  // Match href="...pdf" patterns in HTML
  const hrefPattern = /href=["']([^"']*\.pdf(?:\?[^"']*)?)["'][^>]*>([^<]*)</gi;
  let match;

  while ((match = hrefPattern.exec(html)) !== null) {
    let url = match[1].trim();
    const linkText = match[2].trim();

    // Make relative URLs absolute
    if (url && !url.startsWith('http')) {
      url = url.startsWith('/') ? `${BASE_URL}${url}` : `${BASE_URL}/${url}`;
    }

    const urlLower = url.toLowerCase();
    if (seen.has(urlLower)) continue;

    const label = linkText || url.split('/').pop().replace(/\.pdf.*$/i, '');
    const combined = (label + ' ' + urlLower).toLowerCase();

    // Only include if it looks like a spec/technical document
    if (SPEC_KEYWORDS.some(kw => combined.includes(kw))) {
      seen.add(urlLower);
      pdfs.push({ url, label });
    }
  }

  // Also match bare PDF URLs (not in href) — sometimes embedded as text
  const barePattern = /(?:https?:\/\/[^\s"'<>]+\.pdf(?:\?[^\s"'<>]*)?)/gi;
  while ((match = barePattern.exec(html)) !== null) {
    const url = match[0].trim();
    const urlLower = url.toLowerCase();
    if (seen.has(urlLower)) continue;

    const label = url.split('/').pop().replace(/\.pdf.*$/i, '');
    const combined = (label + ' ' + urlLower).toLowerCase();

    if (SPEC_KEYWORDS.some(kw => combined.includes(kw))) {
      seen.add(urlLower);
      pdfs.push({ url, label });
    }
  }

  return pdfs;
}


// ─── Browser Fallback (only used when JSON API matching fails) ──────────────

/**
 * Fallback: find product via Shopify search in the browser.
 * Only used for products that couldn't be matched via JSON API.
 */
async function findProductViaBrowser(page, productGroup, delayMs) {
  const colorName = productGroup.name;
  const collection = productGroup.collection;
  const collectionName = collection.replace(/^Metroflor\s*/i, '').trim();

  try {
    // Search Shopify store
    const searchTerm = `${collectionName} ${colorName}`;
    await page.goto(`${BASE_URL}/search?q=${encodeURIComponent(searchTerm)}&type=product`, {
      waitUntil: 'networkidle2',
      timeout: 15000,
    });
    await delay(delayMs);

    const productUrl = await page.evaluate((name) => {
      const nameLower = name.toLowerCase();
      const links = document.querySelectorAll('a[href*="/products/"]');
      for (const a of links) {
        const text = (a.textContent || '').toLowerCase();
        const href = (a.getAttribute('href') || '').toLowerCase();
        if (text.includes(nameLower) || href.includes(nameLower.replace(/\s+/g, '-'))) {
          return a.href;
        }
      }
      // Return first product link from search results as best guess
      const first = document.querySelector('a[href*="/products/"]');
      return first ? first.href : null;
    }, colorName);

    if (!productUrl) return null;

    // Extract handle from URL and try fetching product JSON directly
    const handleMatch = productUrl.match(/\/products\/([^?#/]+)/);
    if (handleMatch) {
      const handle = handleMatch[1];
      try {
        const resp = await fetch(`${BASE_URL}/products/${handle}.json`, {
          headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' },
          signal: AbortSignal.timeout(10000),
        });
        if (resp.ok) {
          const data = await resp.json();
          if (data?.product) {
            return extractProductData(data.product);
          }
        }
      } catch { /* fall through to DOM scraping */ }
    }

    // Last resort: scrape the product page DOM
    await page.goto(productUrl, { waitUntil: 'networkidle2', timeout: 15000 });
    await delay(delayMs);

    return page.evaluate(() => {
      const images = [];
      document.querySelectorAll('.product__media img, .product-single__photo img, img[src*="cdn.shopify"]').forEach(img => {
        const src = img.src || img.dataset.src;
        if (src && src.includes('cdn.shopify') && !src.includes('logo')) {
          images.push(src);
        }
      });

      const descEl = document.querySelector('.product-single__description, .product__description, [class*="product-description"]');
      const description = descEl ? descEl.textContent.trim().slice(0, 2000) : null;

      return {
        images: [...new Set(images)],
        description,
        specs: null,
        specPdfs: [],
      };
    });
  } catch {
    return null;
  }
}
