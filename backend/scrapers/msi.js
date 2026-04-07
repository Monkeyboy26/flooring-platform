import { launchBrowser, delay, upsertSkuAttribute, upsertPackaging, appendLog, addJobError, downloadImage, upsertMediaAsset, resolveImageExtension } from './base.js';

const DEFAULT_CONFIG = {
  categories: [
    // Tile
    '/porcelain-tile/',
    '/marble-tile/',
    '/travertine-tile/',
    '/granite-tile/',
    '/quartzite-tile/',
    '/slate-tile/',
    '/sandstone-tile/',
    '/limestone-tile/',
    '/onyx-tile/',
    '/wood-look-tile-and-planks/',
    '/large-format-tile/',
    '/commercial-tile/',
    // Luxury Vinyl
    '/luxury-vinyl-flooring/',
    '/waterproof-hybrid-rigid-core/',
    // Hardwood
    '/w-luxury-genuine-hardwood/',
    // Countertops
    '/quartz-countertops/',
    '/granite-countertops/',
    '/marble-countertops/',
    '/quartzite-countertops/',
    '/stile/porcelain-slabs/',
    '/prefabricated-countertops/',
    '/soapstone-countertops/',
    '/vanity-tops-countertops/',
    // Backsplash & Wall — sub-category pages with product grids
    '/backsplash-tile/subway-tile/',
    '/backsplash-tile/glass-tile/',
    '/backsplash-tile/geometric-pattern/',
    '/backsplash-tile/bevollo-glass-tile/',
    '/backsplash-tile/rio-lago-pebbles-mosaics/',
    '/backsplash-tile/waterjet-cut-mosaics/',
    '/backsplash-tile/stik-wall-tile/',
    '/backsplash-tile/wood-look-wall-tile/',
    '/backsplash-tile/brickstaks/',
    '/backsplash-tile/acoustic-wood-slat/',
    '/backsplash-tile/stacked-stone-collection/',
    '/backsplash-tile/encaustic-pattern/',
    '/backsplash-tile/luxor/',
    '/backsplash-tile/revaso-recycled-glass/',
    '/backsplash-tile/specialty-shapes-wall-tile/',
    '/mosaics/collections-mosaics/',
    '/fluted-looks/',
    // Hardscaping
    '/hardscape/rockmount-stacked-stone/',
    '/hardscape/arterra-porcelain-pavers/',
    '/evergrass-turf/',
    // Waterproof Wood
    '/waterproof-wood-flooring/woodhills/',
  ],
  maxProductsPerCategory: 500,
  delayMs: 2500
};

/**
 * MSI Surfaces enrichment scraper.
 * Crawls MSI website category pages and product detail pages to extract
 * descriptions, images, and spec attributes. Matches scraped SKU codes
 * against existing 832-imported SKUs (internal_sku = 'MSI-' + code).
 * Does NOT create products or SKUs — only enriches existing records.
 */
export async function run(pool, job, source) {
  const config = { ...DEFAULT_CONFIG, ...(source.config || {}) };
  const baseUrl = source.base_url.replace(/\/$/, '');

  // Optional: filter to only specific category paths (for partial re-scrapes)
  const onlyCategories = config.onlyCategories || null;
  const activeCategories = onlyCategories
    ? config.categories.filter(c => onlyCategories.some(oc => c.includes(oc)))
    : config.categories;

  // Pre-load ALL MSI SKUs into a Map for O(1) lookups (eliminates N+1 queries)
  const { rows: allMsiSkus } = await pool.query(
    `SELECT s.id AS sku_id, s.product_id, s.internal_sku
     FROM skus s JOIN products p ON s.product_id = p.id
     JOIN vendors v ON p.vendor_id = v.id WHERE v.code = 'MSI'`
  );
  const skuIndex = new Map(allMsiSkus.map(r => [r.internal_sku, r]));

  let browser;
  let totalFound = 0;
  let totalEnriched = 0;
  let totalSkipped = 0;
  let totalImagesAdded = 0;
  let totalAttributesSet = 0;
  let totalPackagingUpdated = 0;

  try {
    await appendLog(pool, job.id, `Launching browser (enrichment mode). Pre-loaded ${skuIndex.size} MSI SKUs for matching.`);
    browser = await launchBrowser();

    // Track visited URLs to prevent infinite drill-down loops
    const visitedUrls = new Set();

    for (const categoryPath of activeCategories) {
      const categoryUrl = baseUrl + (categoryPath.startsWith('/') ? '' : '/') + categoryPath;
      await appendLog(pool, job.id, `Scraping category: ${categoryPath}`);

      let productUrls;
      try {
        productUrls = await collectProductUrls(browser, categoryUrl, config);
        await appendLog(pool, job.id, `Found ${productUrls.length} products in ${categoryPath}`);
      } catch (err) {
        await appendLog(pool, job.id, `ERROR collecting URLs from ${categoryPath}: ${err.message}`);
        await addJobError(pool, job.id, `Category ${categoryPath}: ${err.message}`);
        continue;
      }

      totalFound += productUrls.length;

      for (let i = 0; i < productUrls.length; i++) {
        const url = productUrls[i];

        // Skip already-visited URLs (prevents infinite drill-down loops)
        const normalizedUrl = url.replace(/\/$/, '').toLowerCase();
        if (visitedUrls.has(normalizedUrl)) continue;
        visitedUrls.add(normalizedUrl);

        try {
          const data = await scrapeProductPage(browser, url, config);
          if (!data || !data.name) continue;

          // Skip non-product pages
          const nameLower = (data.name || '').toLowerCase();
          const collLower = (data.collection || '').toLowerCase();

          if ((!data.skus || data.skus.length === 0)) {
            const isGenericName = /^\d+\s*[x×]\s*\d+\b/i.test(data.name)
              || /^(colors?|features|benefits|about|gallery|installation|maintenance|faq|resources)\b/i.test(data.name)
              || collLower.includes('features and benefits')
              || collLower.includes('installation')
              || nameLower.includes('features and benefits');
            if (isGenericName) continue;
          }

          const isNonProduct =
            nameLower.includes('too many requests') ||
            nameLower.includes('care & maintenance') ||
            nameLower.includes('brochure') ||
            nameLower.includes('thresholds & sills') ||
            nameLower.includes('finishing touch') ||
            nameLower.includes('looks like marble') ||
            nameLower.includes('prefabricated') ||
            nameLower.includes('backsplashes') && !nameLower.includes('tile') ||
            nameLower.includes('countertop colors') ||
            nameLower.includes('specialty shapes') ||
            nameLower.includes('trim & accessory') ||
            nameLower.includes('videos') ||
            nameLower.includes('vanity top') ||
            nameLower.includes('countertop') ||
            nameLower.includes('tub and shower') ||
            nameLower.includes('shower panel') ||
            nameLower.includes('evergrass') ||
            nameLower.includes('putting green') ||
            nameLower.includes('emerald turf precut') ||
            /^(mosaic tile|glass tile|encaustic tile|wood look wall tile)$/i.test(data.name) ||
            /^\d+\s*x\s*\d+\s+(porcelain|ceramic)/i.test(data.name);
          if (isNonProduct) continue;

          // Real MSI SKUs contain digits (e.g. NADEGRI1818)
          // URL-derived ones (ANDOVER, CYRUS) won't match 832 imports — skip them
          const hasRealSku = data.skus && data.skus.some(s => /\d/.test(s.code));
          if (!hasRealSku) {
            // Try drill-down for collection pages
            let drilled = false;
            try {
              const subUrls = await collectSubProductUrls(browser, url, config);
              if (subUrls.length > 0) {
                await appendLog(pool, job.id, `Collection page "${data.name}" → drilling into ${subUrls.length} sub-products`);
                productUrls.splice(i + 1, 0, ...subUrls);
                totalFound += subUrls.length;
                drilled = true;
              }
            } catch (drillErr) { /* fall through */ }
            if (drilled) continue;
            // No real SKU codes and not a drillable collection — skip
            continue;
          }

          // Look up each scraped SKU code against pre-loaded SKU index
          const matchedSkus = []; // { skuId, productId, code }
          for (const entry of data.skus) {
            if (!/\d/.test(entry.code)) continue; // skip non-real codes
            const match = lookupSkuFromIndex(skuIndex, entry.code);
            if (match) {
              matchedSkus.push({ skuId: match.sku_id, productId: match.product_id, code: entry.code });
            }
          }

          if (matchedSkus.length === 0) {
            totalSkipped++;
            continue;
          }

          // Use the first matched product for enrichment
          const productId = matchedSkus[0].productId;

          // Enrich product descriptions (only fills NULLs — never overwrites)
          await enrichProduct(pool, productId, {
            description_short: data.description ? data.description.slice(0, 255) : null,
            description_long: data.description || null
          });

          // Download and persist images — skip individual images already downloaded
          const UPLOADS_BASE = process.env.UPLOADS_PATH || '/app/uploads';
          if (data.images && data.images.length > 0) {
            const { rows: existingMedia } = await pool.query(
              "SELECT original_url, asset_type FROM media_assets WHERE product_id = $1",
              [productId]
            );
            const existingUrls = new Set(existingMedia.map(r => r.original_url));
            let altIndex = existingMedia.filter(r => r.asset_type !== 'primary').length;

            for (const img of data.images) {
              if (existingUrls.has(img.url)) continue; // already downloaded
              try {
                const ext = resolveImageExtension(img.url);
                const filename = img.type === 'primary' ? `primary${ext}` : `alt-${++altIndex}${ext}`;
                const destPath = `${UPLOADS_BASE}/products/${productId}/${filename}`;
                const localUrl = `/uploads/products/${productId}/${filename}`;
                const downloaded = await downloadImage(img.url, destPath);
                if (downloaded) {
                  await upsertMediaAsset(pool, {
                    product_id: productId,
                    sku_id: null,
                    asset_type: img.type,
                    url: localUrl,
                    original_url: img.url,
                    sort_order: img.type === 'primary' ? 0 : altIndex
                  });
                  totalImagesAdded++;
                }
              } catch (imgErr) { /* Non-fatal */ }
            }
          }

          // Upsert spec attributes for all matched SKUs
          for (const match of matchedSkus) {
            for (const [attrSlug, value] of Object.entries(data.attributes || {})) {
              await upsertSkuAttribute(pool, match.skuId, attrSlug, value);
              totalAttributesSet++;
            }
            // Per-variant size and finish
            const entry = data.skus.find(s => s.code === match.code);
            if (entry) {
              if (entry.size) {
                await upsertSkuAttribute(pool, match.skuId, 'size', entry.size);
                totalAttributesSet++;
              }
              if (entry.finish) {
                await upsertSkuAttribute(pool, match.skuId, 'finish', entry.finish);
                totalAttributesSet++;
              }
            }
          }

          // Fetch packaging data from MSI's inventory API for matched SKUs
          for (const match of matchedSkus) {
            try {
              const packaging = await fetchPackagingFromApi(browser, match.code);
              if (packaging) {
                await upsertPackaging(pool, match.skuId, packaging);
                totalPackagingUpdated++;
              }
            } catch { /* Non-fatal */ }
            await delay(500); // rate-limit API requests
          }

          totalEnriched++;

          // Log progress every 10 products
          if ((i + 1) % 10 === 0 || i === productUrls.length - 1) {
            await appendLog(pool, job.id, `Progress: ${i + 1}/${productUrls.length} in ${categoryPath}`, {
              products_found: totalFound,
              products_enriched: totalEnriched,
              products_skipped: totalSkipped,
              images_added: totalImagesAdded,
              attributes_set: totalAttributesSet
            });
          }
        } catch (err) {
          await appendLog(pool, job.id, `ERROR scraping ${url}: ${err.message}`);
          await addJobError(pool, job.id, `Product ${url}: ${err.message}`);
        }

        await delay(config.delayMs);
      }
    }

    // Final stats
    await appendLog(pool, job.id,
      `Enrichment complete. Found: ${totalFound}, Enriched: ${totalEnriched}, Skipped (not in DB): ${totalSkipped}, Images: ${totalImagesAdded}, Attributes: ${totalAttributesSet}, Packaging: ${totalPackagingUpdated}`, {
      products_found: totalFound,
      products_enriched: totalEnriched,
      products_skipped: totalSkipped,
      images_added: totalImagesAdded,
      attributes_set: totalAttributesSet
    });
  } finally {
    if (browser) await browser.close();
  }
}

/**
 * Look up an existing SKU from the pre-loaded index (synchronous, O(1)).
 * The 832 scraper creates SKUs with internal_sku = 'MSI-' + vendor_sku.
 * Returns { sku_id, product_id } or null if not found.
 */
function lookupSkuFromIndex(skuIndex, vendorSkuCode) {
  const cleanCode = vendorSkuCode.replace(/\s+/g, '-').toUpperCase();
  return skuIndex.get('MSI-' + cleanCode) || null;
}

/**
 * Fetch packaging data from MSI's inventory tile details API.
 * Parses the HTML response for sqft/box, pieces/box, and weight/box.
 * Returns { sqft_per_box, pieces_per_box, weight_per_box_lbs } or null on failure.
 */
async function fetchPackagingFromApi(browser, skuCode) {
  const page = await browser.newPage();
  try {
    const url = `https://www.msisurfaces.com/inventory/tiledetails/?handler=CatagoryPartial&ItemId=${encodeURIComponent(skuCode)}`;
    const resp = await page.goto(url, { waitUntil: 'networkidle2', timeout: 15000 });
    if (!resp || resp.status() !== 200) return null;

    return await page.evaluate(() => {
      const text = document.body.innerText || '';
      const sqftMatch = text.match(/(\d+\.?\d*)\s*(?:sq\.?\s*ft|SF)\s*(?:per|\/)\s*(?:box|carton)/i);
      const pcsMatch = text.match(/(\d+)\s*(?:pieces?|pcs?)\s*(?:per|\/)\s*(?:box|carton)/i);
      const weightMatch = text.match(/(\d+\.?\d*)\s*(?:lbs?|pounds?)\s*(?:per|\/)\s*(?:box|carton)/i);
      if (!sqftMatch && !pcsMatch && !weightMatch) return null;
      return {
        sqft_per_box: sqftMatch ? parseFloat(sqftMatch[1]) : null,
        pieces_per_box: pcsMatch ? parseInt(pcsMatch[1], 10) : null,
        weight_per_box_lbs: weightMatch ? parseFloat(weightMatch[1]) : null,
      };
    });
  } catch { return null; }
  finally { await page.close(); }
}

/**
 * Update product descriptions if they are NULL or very short (<40 chars).
 * Short descriptions are likely just the product name or placeholder text.
 */
async function enrichProduct(pool, productId, { description_short, description_long }) {
  if (!description_short && !description_long) return;
  await pool.query(
    `UPDATE products SET
      description_short = CASE
        WHEN $2 IS NOT NULL AND (products.description_short IS NULL OR length(products.description_short) < 40)
        THEN $2 ELSE products.description_short END,
      description_long = CASE
        WHEN $3 IS NOT NULL AND (products.description_long IS NULL OR length(products.description_long) < 40)
        THEN $3 ELSE products.description_long END,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = $1`,
    [productId, description_short, description_long]
  );
}

/**
 * Extract a URL-based SKU fallback from the product URL.
 * Uses the product path segments (minus the category prefix) joined with hyphens.
 * e.g. /porcelain-tile/adella/gris/ → ['ADELLA-GRIS']
 * e.g. /luxury-vinyl-flooring/xl-prescott/ → ['XL-PRESCOTT']
 */
function extractSkuFromUrl(url) {
  try {
    const path = new URL(url).pathname;
    const segments = path.split('/').filter(Boolean);
    // Skip the first segment (category like "porcelain-tile", "luxury-vinyl-flooring")
    const productSegments = segments.length > 1 ? segments.slice(1) : segments;
    const slug = productSegments.join('-');
    if (slug) {
      return [slug.toUpperCase()];
    }
  } catch (e) { /* ignore */ }
  return [];
}

// Phrases that indicate non-description content (footer, newsletter, nav, legal, etc.)
const JUNK_PHRASES = [
  'newsletter', 'subscribe', 'sign up', 'cookie', 'copyright',
  'privacy policy', 'terms of', 'all rights reserved', 'contact us',
  'follow us', 'join our', 'exclusive content', 'customer service',
  'free shipping', 'need help', 'chat with', 'call us', 'email us',
  'my account', 'log in', 'sign in', 'create account',
  'design trends', 'download', 'bill pay'
];

// Phrases that should never be used as collection names
const COLLECTION_JUNK = [
  'check inventory', 'add to cart', 'order sample', 'request sample',
  'find a dealer', 'where to buy', 'load more', 'view all', 'see all',
  'shop now', 'learn more', 'read more', 'view details', 'get started',
  'back to', 'go to', 'see more', 'show more'
];

/**
 * Navigate to an MSI category listing page and collect all product URLs.
 */
async function collectProductUrls(browser, categoryUrl, config) {
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

  // Block fonts and media on listing pages (keep images for product card detection)
  await page.setRequestInterception(true);
  page.on('request', req => {
    const type = req.resourceType();
    if (['font', 'media'].includes(type)) {
      req.abort();
    } else {
      req.continue();
    }
  });

  try {
    await page.goto(categoryUrl, { waitUntil: 'networkidle2', timeout: 60000 });

    // Wait for the product grid to appear
    await page.waitForSelector('.new-filter-collection a, .bordered-image-filter a, a[href*="porcelain"], a[href*="tile"], a[href*="vinyl"]', { timeout: 15000 }).catch(() => {});

    // Click "Load More Products" repeatedly until all loaded or limit reached
    let previousCount = 0;
    for (let attempt = 0; attempt < 50; attempt++) {
      // Find the Load More link by its text content
      const loadMoreBtn = await page.evaluateHandle(() => {
        const links = Array.from(document.querySelectorAll('a'));
        return links.find(a =>
          a.textContent.trim().toLowerCase().includes('load more') &&
          (a.href.includes('javascript:') || a.href === '' || a.getAttribute('href') === '#')
        ) || null;
      });

      const isElement = await loadMoreBtn.evaluate(el => el !== null).catch(() => false);
      if (!isElement) break;

      const isVisible = await loadMoreBtn.evaluate(el => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden' && el.offsetParent !== null;
      }).catch(() => false);
      if (!isVisible) break;

      await loadMoreBtn.click().catch(() => {});
      await delay(2500);

      const currentCount = await page.$$eval(
        '.new-filter-collection a[href]',
        els => els.filter(a => a.href && !a.href.includes('javascript:')).length
      ).catch(() => 0);

      if (currentCount <= previousCount) break;
      if (currentCount >= config.maxProductsPerCategory) break;
      previousCount = currentCount;
    }

    // Collect product links from the grid
    const baseHost = new URL(categoryUrl).origin;
    const urls = await page.evaluate((baseHost) => {
      const seen = new Set();
      const results = [];

      // Filter: must be same-origin MSI page, not a file/external link
      function isValidProductUrl(href) {
        if (!href || href.includes('javascript:') || href === '#') return false;
        // Reject external domains (CDN files, Vimeo, etc.)
        try {
          const url = new URL(href);
          if (url.origin !== baseHost) return false;
        } catch (e) { return false; }
        // Reject file extensions
        if (/\.(pdf|jpg|png|gif|svg|mp4|zip|doc|xlsx?)(\?|$)/i.test(href)) return false;
        // Reject non-product paths
        if (href.includes('/site-search') || href.includes('?') || href.includes('#')) return false;
        if (href.includes('/corporate/') || href.includes('/news/') || href.includes('/blog/')) return false;
        // Reject known non-product info/landing pages
        const path = new URL(href).pathname.toLowerCase();
        if (/\/(colors|features|benefits|faq|resources|installation|maintenance|warranty|care|cleaning|about|videos?|gallery|inspiration|design-trends|how-to)\/?$/.test(path)) return false;
        // Reject sub-category pages that are just dimension names (e.g. /large-format-tile/48-x-48-porcelain-tile/)
        const lastSegment = path.split('/').filter(Boolean).pop() || '';
        if (/^\d+\s*[-x×]\s*\d+/.test(lastSegment)) return false;
        return true;
      }

      // Primary: links inside the product grid
      const gridLinks = document.querySelectorAll('.new-filter-collection a[href]');
      gridLinks.forEach(a => {
        let href = a.href || a.getAttribute('href');
        if (href && href.startsWith('/')) href = baseHost + href;
        if (!isValidProductUrl(href)) return;
        if (seen.has(href)) return;
        seen.add(href);
        results.push(href);
      });

      // Fallback: if grid selector found nothing, try broader approach
      if (results.length === 0) {
        const allLinks = document.querySelectorAll('a[href]');
        allLinks.forEach(a => {
          let href = a.href || a.getAttribute('href');
          if (href && href.startsWith('/')) href = baseHost + href;
          if (!isValidProductUrl(href)) return;
          if (seen.has(href)) return;
          const path = new URL(href).pathname;
          const segments = path.split('/').filter(Boolean);
          if (segments.length >= 2 && !path.includes('category')) {
            if (a.querySelector('img')) {
              seen.add(href);
              results.push(href);
            }
          }
        });
      }

      return results;
    }, baseHost);

    return urls.slice(0, config.maxProductsPerCategory);
  } finally {
    await page.close();
  }
}

/**
 * Collect sub-product URLs from an MSI collection page.
 * When the scraper lands on a collection overview (e.g., /porcelain/antoni/),
 * this function extracts links to individual product pages (e.g., /porcelain/antoni/cafe/).
 */
async function collectSubProductUrls(browser, collectionUrl, config) {
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

  await page.setRequestInterception(true);
  page.on('request', req => {
    const type = req.resourceType();
    if (['font', 'media', 'image'].includes(type)) req.abort();
    else req.continue();
  });

  try {
    await page.goto(collectionUrl, { waitUntil: 'networkidle2', timeout: 60000 });
    await delay(1000);

    const baseHost = new URL(collectionUrl).origin;
    const collectionPath = new URL(collectionUrl).pathname.replace(/\/$/, '');

    const urls = await page.evaluate((baseHost, collectionPath) => {
      const seen = new Set();
      const results = [];

      // First try: find links that are direct children of the collection path
      // e.g., if we're on /porcelain/antoni/, find /porcelain/antoni/cafe/
      const allLinks = document.querySelectorAll('a[href]');
      allLinks.forEach(a => {
        let href = a.href || a.getAttribute('href');
        if (!href || href.includes('javascript:') || href === '#') return;
        try {
          const url = new URL(href, baseHost);
          if (url.origin !== baseHost) return;
          const path = url.pathname.replace(/\/$/, '');
          // Must be a child of the collection path
          if (!path.startsWith(collectionPath + '/')) return;
          // Must be exactly one level deeper
          const subPath = path.slice(collectionPath.length + 1);
          if (!subPath || subPath.includes('/')) return;
          // Reject common non-product paths
          if (/\.(pdf|jpg|png|gif|svg|mp4)$/i.test(path)) return;
          if (/\/(colors|features|benefits|faq|resources|installation|gallery|videos?|warranty)\/?$/i.test(path)) return;
          const full = url.origin + path + '/';
          if (seen.has(full)) return;
          seen.add(full);
          results.push(full);
        } catch {}
      });

      // Fallback: if no direct children found, look for product links anywhere on the page
      // MSI backsplash collection pages link to products in different URL structures
      // e.g., /backsplash-tile/glass-tile/ links to /glass-mosaics/product-name/
      if (results.length === 0) {
        allLinks.forEach(a => {
          let href = a.href || a.getAttribute('href');
          if (!href || href.includes('javascript:') || href === '#') return;
          try {
            const url = new URL(href, baseHost);
            if (url.origin !== baseHost) return;
            const path = url.pathname.replace(/\/$/, '');
            // Skip the current collection path itself
            if (path === collectionPath) return;
            // Must have at least 2 path segments (collection/product)
            const segments = path.split('/').filter(Boolean);
            if (segments.length < 2) return;
            // Reject file extensions and non-product pages
            if (/\.(pdf|jpg|png|gif|svg|mp4)$/i.test(path)) return;
            if (/\/(colors|features|benefits|faq|resources|installation|gallery|videos?|warranty|site-search|corporate|news|blog)\/?/i.test(path)) return;
            // Reject hub/category pages (single segment)
            if (segments.length === 1) return;
            // Only include links that have a product image (visual product cards)
            if (!a.querySelector('img')) return;
            const full = url.origin + path + '/';
            if (seen.has(full)) return;
            seen.add(full);
            results.push(full);
          } catch {}
        });
      }

      return results;
    }, baseHost, collectionPath);

    return urls;
  } finally {
    await page.close();
  }
}

/**
 * Scrape a single MSI product detail page.
 *
 * MSI's product pages use accordion sections for specs. The "PRODUCT DETAILS & SPECS"
 * section contains dt/dd pairs with attributes (color, PEI, finish, style, etc.).
 * Size variants with individual ID# codes are listed in the main product area.
 *
 * Packaging data (sqft/box, pieces/box, weight) is fetched from MSI's inventory
 * tile details API at /inventory/tiledetails/?handler=CatagoryPartial&ItemId={SKU}.
 */
async function scrapeProductPage(browser, url, config) {
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

  // Block images, fonts, and media for speed — we only need text content
  await page.setRequestInterception(true);
  page.on('request', req => {
    const type = req.resourceType();
    if (['font', 'media'].includes(type)) {
      req.abort();
    } else {
      req.continue();
    }
  });

  try {
    // Load page with rate-limit retry
    let retries = 0;
    while (retries < 3) {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
      const pageTitle = await page.title().catch(() => '');
      const bodySnippet = await page.evaluate(() => document.body?.innerText?.slice(0, 200) || '').catch(() => '');
      if (/too many requests|429|rate limit/i.test(pageTitle + bodySnippet)) {
        retries++;
        const backoff = 5000 * retries; // 5s, 10s, 15s
        await delay(backoff);
        continue;
      }
      break;
    }
    await page.waitForSelector('h1', { timeout: 10000 }).catch(() => {});

    // Expand all accordion/collapse sections so spec dt/dd and variant data become visible
    await page.evaluate(() => {
      // Click all accordion toggle buttons/links
      const toggles = document.querySelectorAll(
        '.accordion-header, .accordion-toggle-icon, [data-toggle="collapse"], ' +
        '.collapse-toggle, button[aria-expanded="false"], a[data-toggle="collapse"]'
      );
      toggles.forEach(t => { try { t.click(); } catch (e) {} });

      // Click the Tiles and Accessories tabs in the sizes section
      document.querySelectorAll('#item-sizes a, #productSizesAccordion a[data-toggle="tab"]').forEach(t => {
        try { t.click(); } catch (e) {}
      });

      // Force-show any .collapse elements that are hidden
      document.querySelectorAll('.collapse').forEach(el => {
        el.classList.add('in', 'show');
        el.style.display = '';
        el.style.height = 'auto';
      });

      // Force-show tab panes
      document.querySelectorAll('.tab-pane').forEach(el => {
        el.classList.add('active', 'in', 'show');
        el.style.display = '';
      });
    });

    // Wait for accordion content to render
    await delay(800);

    // Extract all data from the DOM
    const data = await page.evaluate((junkPhrases, collectionJunk) => {
      const result = {
        name: '',
        skus: [],       // Array of { code, size, finish, variantName }
        collection: '',
        description: '',
        attributes: {},  // Product-level specs from dt/dd
        images: []       // Array of { url, type: 'primary'|'alternate' }
      };

      // --- Product name from h1 ---
      const h1 = document.querySelector('h1');
      if (h1) {
        let rawName = h1.textContent.trim();
        // Title-case ALL CAPS product names or names with ALL CAPS prefix
        // e.g. "AMBER FORRESTER Luxury Vinyl Plank" → "Amber Forrester Luxury Vinyl Plank"
        // e.g. "BARNSTORM" → "Barnstorm"
        // Preserves abbreviations like "LVP", "SPC", "XL"
        const ABBREVS = ['LVP','SPC','XL','XXL','LG','HD','HDP','USA'];
        const CATEGORY_SUFFIXES = /(Porcelain|Ceramic|Marble|Granite|Travertine|Vinyl|Tile|Plank|Flooring|Wood|Luxury|Series|Waterproof|Hybrid|Rigid|Core|Collection)\b/i;
        const words = rawName.split(/\s+/);
        let hasAllCapsPrefix = false;
        for (const w of words) {
          if (CATEGORY_SUFFIXES.test(w)) break;
          if (w.length > 2 && w === w.toUpperCase() && !ABBREVS.includes(w)) {
            hasAllCapsPrefix = true;
            break;
          }
        }
        if (hasAllCapsPrefix) {
          rawName = words.map(w => {
            if (ABBREVS.includes(w.toUpperCase())) return w.toUpperCase();
            if (CATEGORY_SUFFIXES.test(w)) return w; // preserve existing casing of category words
            if (w === w.toUpperCase() && w.length > 2) {
              return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
            }
            return w;
          }).join(' ');
        }
        // Strip material/category suffix from product name
        // "Calacatta Gold Marble" → "Calacatta Gold"
        // "Adella Gris Porcelain Tile" → "Adella Gris"
        // "Amber Forrester Luxury Vinyl Planks" → "Amber Forrester"
        // "Antoni Cafe Porcelain Wood Tile" → "Antoni Cafe"
        rawName = rawName
          .replace(/\s+(Porcelain|Ceramic|Marble|Granite|Travertine|Quartzite|Limestone|Slate|Sandstone|Onyx|Basalt)(\s+\w+)?\s+(Tiles?|Planks?|Flooring|Slabs?|Stones?)\s*$/i, '')
          .replace(/\s+(Porcelain|Ceramic|Marble|Granite|Travertine|Quartzite|Limestone|Slate|Sandstone|Onyx|Basalt)\s*$/i, '')
          .replace(/\s+Wood\s+(?:Look\s+)?(?:Tiles?|Wall)\s*$/i, '')
          .replace(/\s+Brick\s+Tiles?\s*$/i, '')
          .replace(/\s+Bricks?\s*$/i, '')
          .replace(/\s+(?:Tiles?|Planks?|Flooring)\s*$/i, '')
          .replace(/\s+(Luxury Vinyl Planks?|Luxury Vinyl Tiles?|Luxury Vinyl|Vinyl Planks?|Vinyl Tiles?|Vinyl Flooring|LVP|LVT|SPC)\s*$/i, '')
          .replace(/\s+(Engineered Hardwood|Solid Hardwood|Hardwood Flooring|Hardwood)\s*$/i, '')
          .replace(/\s+(Stacked Stone|Ledger Panel|Porcelain Pavers?)\s*$/i, '')
          .replace(/\s+Hybrid\s+Rigid\s+Core\s*$/i, '')
          .replace(/\s+(?:Oak\s+)?Wood\s*$/i, '')
          .replace(/\s+(Collection|Series)\s*$/i, '')
          .trim();

        // Strip ® ™ © TM from the raw name in-page
        rawName = rawName.replace(/[®™©]/g, '').replace(/\bTM\b/g, '').trim();

        result.name = rawName;
      }

      // --- SKU variants ---
      // MSI product pages list variants in a freeform layout within the sizes section.
      // The innerText shows a clear pattern per variant:
      //   ADELLA GRIS 18X18 MATTE     ← item description (line before ID#)
      //   ID#: NADEGRI1818             ← SKU code
      //   Finish: Matte               ← finish (line after ID#)
      // We parse the description by stripping the product name prefix to get the variant name.
      const seen = new Set();
      const FINISHES = ['MATTE','POLISHED','HONED','BRUSHED','TUMBLED','LAPPATO','SATIN','GLOSSY','TEXTURED','NATURAL','CHISELED','RECTIFIED','SOFT','GRIP'];

      // Helper: parse "ADELLA GRIS 18X18 MATTE" into variant, size, finish
      function parseItemDescription(desc, productName) {
        if (!desc) return { variantName: null, size: '', finish: '' };
        const descUpper = desc.toUpperCase().trim();

        // Clean the product name (remove category suffixes)
        const cleanName = (productName || '')
          .replace(/\s*(Porcelain|Ceramic|Marble|Granite|Travertine|Vinyl|Tile|Plank|Flooring|Collection|Wood|Luxury|Series|Waterproof|Hybrid|Rigid|Core)\s*/gi, ' ')
          .trim().toUpperCase();

        // Normalize: strip accents for comparison (CAFÉ → CAFE)
        function stripAccents(s) {
          return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        }

        // Strip product name prefix word-by-word
        let variant = descUpper;
        if (cleanName) {
          const nameWords = stripAccents(cleanName).split(/\s+/).filter(Boolean);
          const descNorm = stripAccents(descUpper);
          const descWords = descUpper.split(/\s+/).filter(Boolean);
          const descNormWords = descNorm.split(/\s+/).filter(Boolean);
          let matched = 0;
          for (let i = 0; i < nameWords.length && i < descNormWords.length; i++) {
            if (nameWords[i] === descNormWords[i]) matched++;
            else break;
          }
          if (matched > 0) {
            variant = descWords.slice(matched).join(' ');
          }
        }

        // If stripping didn't shorten it, find where size/format starts
        if (!variant || variant === descUpper) {
          const sizeIdx = descUpper.search(
            /\b(\d+\s*[xX×]\s*\d+|MOSAIC|HEXAGON|HEX|BULLNOSE|BULL\s*NOSE|PLANK|PENCIL|QUARTER|TRIM|PAVER)/i
          );
          if (sizeIdx > 0) variant = descUpper.slice(sizeIdx);
        }

        let size = '';
        const sizeMatch = variant.match(/(\d+)\s*[xX×]\s*(\d+)/);
        if (sizeMatch) size = sizeMatch[1] + 'x' + sizeMatch[2];

        let finish = '';
        for (const f of FINISHES) {
          if (variant.toUpperCase().includes(f)) { finish = f; break; }
        }

        const variantName = variant
          .toLowerCase()
          .replace(/\b\w/g, c => c.toUpperCase())
          .replace(/\b([xX×])\b/g, 'x');

        return { variantName: variantName || null, size, finish };
      }

      // Section header → variant_type mapping
      const SECTION_TYPE_MAP = {
        'tiles': 'tile', 'tile': 'tile',
        'mosaics': 'mosaic', 'mosaic': 'mosaic',
        'decorative mosaics': 'mosaic', 'decorative': 'mosaic',
        'slabs': 'slab', 'slab': 'slab',
        'accessories': 'accessory', 'accessory': 'accessory',
        'trim': 'trim', 'bullnose': 'trim', 'pencil': 'trim',
        'pavers': 'paver', 'paver': 'paver',
      };

      // Primary: parse innerText line-by-line
      // The line immediately before "ID#: CODE" is the item description.
      // The line immediately after may be "Finish: VALUE".
      const lines = (document.body.innerText || '').split('\n').map(l => l.trim()).filter(Boolean);
      let currentVariantType = null;
      for (let i = 0; i < lines.length; i++) {
        // Check if this line is a section header (e.g. "TILES", "ACCESSORIES")
        const lineLower = lines[i].toLowerCase();
        if (SECTION_TYPE_MAP[lineLower]) {
          currentVariantType = SECTION_TYPE_MAP[lineLower];
          continue;
        }

        const idMatch = lines[i].match(/^ID#:\s*([A-Z0-9][\w-]{4,})/i);
        if (!idMatch) continue;
        const code = idMatch[1].trim();
        if (code.length < 5 || seen.has(code)) continue;
        seen.add(code);

        // Description is the line before ID#
        let itemDescription = '';
        if (i > 0 && !lines[i - 1].match(/^(ID#:|Finish:|ADD TO|TILES|ACCESSORIES|DECORATIVE|\d+[xX]\d+$)/i)) {
          itemDescription = lines[i - 1];
        }
        // "Collection Name: Andover" → extract collection, not variant name
        const collMatch = itemDescription.match(/^Collection Name:\s*(.+)/i);
        if (collMatch) {
          if (!result.collection) result.collection = collMatch[1].trim();
          itemDescription = '';  // don't use as variant description
        }

        // Finish from the next line(s)
        let finish = '';
        for (let j = i + 1; j < Math.min(i + 3, lines.length); j++) {
          const fm = lines[j].match(/^Finish:\s*(.+)/i);
          if (fm) { finish = fm[1].trim(); break; }
        }

        const parsed = parseItemDescription(itemDescription, result.name);
        // Use explicit finish from "Finish:" line if parseItemDescription didn't find one
        if (!parsed.finish && finish) parsed.finish = finish;
        // Append finish to variant name if it came from "Finish:" line (not in description)
        if (parsed.variantName && finish && !parsed.variantName.toLowerCase().includes(finish.toLowerCase())) {
          const tcFinish = finish.charAt(0).toUpperCase() + finish.slice(1).toLowerCase();
          parsed.variantName = parsed.variantName + ' ' + tcFinish;
        }

        result.skus.push({
          code,
          size: parsed.size,
          finish: parsed.finish,
          variantName: parsed.variantName,
          itemDescription,
          variant_type: currentVariantType
        });
      }

      // --- Post-process SKU variant names and types ---
      // MSI SKU prefix → variant_type mapping
      const SKU_TYPE_MAP = {
        'VTR': 'tile',    // main vinyl plank
        'VTT': 'trim',    // vinyl trim/molding
        'VTU': 'accessory', // underlayment
        'XL':  'accessory', // adhesives/primers
        'NSL': 'slab',     // natural stone slab
        'TTR': 'trim',     // tile trim
        'TT':  'trim',     // generic trim (e.g. TTVINTAJ-T-SR)
      };

      // SKU suffix → human-readable trim name
      const TRIM_SUFFIX_MAP = {
        '-EC':     'End Cap',
        '-FSN':    'Flush Stair Nose',
        '-FSN-EE': 'Flush Stair Nose Eased Edge',
        '-OSN':    'Overlapping Stair Nose',
        '-QR':     'Quarter Round',
        '-SR':     'Reducer',
        '-TL':     'T-Molding',
        '-ST-EE':  'Stair Tread Eased Edge',
        '-T-SR':   'T-Molding / Reducer',
      };

      for (const sku of result.skus) {
        const code = sku.code.toUpperCase();

        // 1. Infer variant_type from SKU prefix if not already set by section header
        if (!sku.variant_type) {
          for (const [prefix, type] of Object.entries(SKU_TYPE_MAP)) {
            if (code.startsWith(prefix)) {
              sku.variant_type = type;
              break;
            }
          }
        }

        // 2. Clean leading dashes/spaces from variant names
        if (sku.variantName) {
          sku.variantName = sku.variantName.replace(/^[-–—\s]+/, '').trim();
        }

        // 2b. Strip thickness (e.g. "5mm", "8mm") and wear layer (e.g. "12mil", "20mil")
        //     from variant names for tile and mosaic — these are specs, not variants
        if (sku.variantName && (sku.variant_type === 'tile' || sku.variant_type === 'mosaic')) {
          sku.variantName = sku.variantName
            .replace(/\b\d+(?:\.\d+)?\s*mm\b/gi, '')
            .replace(/\b\d+\s*mil\b/gi, '')
            .replace(/\s{2,}/g, ' ')
            .trim();
        }

        // 3. Fix "Tl Molding" → "T-Molding"
        if (sku.variantName) {
          sku.variantName = sku.variantName.replace(/\bTl\s+Molding\b/i, 'T-Molding');
        }

        // 4. If variant name is still the raw SKU code (no spaces, all alphanumeric+dashes),
        //    generate a readable name from the code
        const nameIsCode = sku.variantName && /^[A-Z0-9][\w-]*$/i.test(sku.variantName)
          && !sku.variantName.includes(' ');
        if (!sku.variantName || nameIsCode) {
          // Try trim suffix first (longest match first)
          const suffixes = Object.keys(TRIM_SUFFIX_MAP).sort((a, b) => b.length - a.length);
          let matched = false;
          for (const suffix of suffixes) {
            if (code.endsWith(suffix)) {
              sku.variantName = TRIM_SUFFIX_MAP[suffix];
              matched = true;
              break;
            }
          }
          // For main planks, parse dimensions from the code (e.g. VTRAMBFOR7X48-5MM-20MIL)
          if (!matched) {
            const dimMatch = code.match(/(\d+)\s*X\s*(\d+)/i);
            const thickMatch = code.match(/(\d+(?:\.\d+)?)\s*MM/i);
            const milMatch = code.match(/(\d+)\s*MIL/i);
            const isTileOrMosaic = sku.variant_type === 'tile' || sku.variant_type === 'mosaic';
            if (dimMatch || thickMatch) {
              const parts = [];
              if (dimMatch) parts.push(dimMatch[1] + 'x' + dimMatch[2]);
              // Only include thickness/mil in variant name for non-tile/mosaic (e.g. vinyl planks)
              if (thickMatch && !isTileOrMosaic) parts.push(thickMatch[1] + 'mm');
              if (milMatch && !isTileOrMosaic) parts.push(milMatch[1] + 'mil');
              if (sku.finish) parts.push(sku.finish.charAt(0).toUpperCase() + sku.finish.slice(1).toLowerCase());
              sku.variantName = parts.join(' ');
              if (dimMatch) sku.size = dimMatch[1] + 'x' + dimMatch[2];
            }
          }
        }
      }

      // --- Specs from dt/dd pairs ---
      const SPEC_MAP = {
        'primary color': 'color',
        'primary color(s)': 'color',
        'pei rating': 'pei_rating',
        'style': 'style',
        'tile type': 'material',
        'shade variations': 'shade_variation',
        'shade variation': 'shade_variation',
        'rectified/non-rectified': 'rectified',
        'environmental': 'certification',
        'finish': 'finish',
        'material': 'material',
        'thickness': 'thickness',
        'total thickness': 'thickness',
        'overall thickness': 'thickness',
        'size': 'size',
        'plank size': 'size',
        'plank dimensions': 'size',
        'dimensions': 'size',
        'wear layer': 'wear_layer',
        'wear layer thickness': 'wear_layer',
        'country of origin': 'country',
        'edge type': 'edge_type',
        'edge detail': 'edge_type',
        'water absorption': 'water_absorption',
        'core type': 'core_type',
        'installation method': 'installation_method',
        'dcof': 'dcof',
        'dcof acutest': 'dcof',
        'coefficient of friction': 'dcof',
        'radiant heat': 'radiant_heat',
        'radiant heat compatible': 'radiant_heat',
        'application': 'application',
        'shape': 'shape',
        'species': 'species'
      };

      const dtElements = document.querySelectorAll('dt');
      for (const dt of dtElements) {
        const label = dt.textContent.trim().toLowerCase();
        const dd = dt.nextElementSibling;
        if (!dd || dd.tagName !== 'DD') continue;
        const value = dd.textContent.trim();
        if (!value) continue;

        const slug = SPEC_MAP[label];
        if (slug && !result.attributes[slug]) {
          result.attributes[slug] = value;
        }
      }

      // --- Table-based spec extraction (fallback when dt/dd finds < 3) ---
      if (Object.keys(result.attributes).length < 3) {
        const rows = document.querySelectorAll('table tr');
        for (const row of rows) {
          const cells = row.querySelectorAll('td, th');
          if (cells.length >= 2) {
            const label = cells[0].textContent.trim().toLowerCase();
            const value = cells[1].textContent.trim();
            if (!value || value.length > 200) continue;
            const slug = SPEC_MAP[label];
            if (slug && !result.attributes[slug]) {
              result.attributes[slug] = value;
            }
          }
        }
      }

      // --- Div-based spec extraction (fallback for styled spec blocks) ---
      if (Object.keys(result.attributes).length < 3) {
        const labelEls = document.querySelectorAll('.spec-label, .specs strong, .specs b, .product-specs strong, .product-specs b');
        for (const el of labelEls) {
          const label = el.textContent.trim().replace(/:$/, '').toLowerCase();
          const valueEl = el.nextElementSibling || el.parentElement;
          if (!valueEl) continue;
          const value = (valueEl === el.parentElement)
            ? valueEl.textContent.replace(el.textContent, '').trim()
            : valueEl.textContent.trim();
          if (!value || value.length > 200) continue;
          const slug = SPEC_MAP[label];
          if (slug && !result.attributes[slug]) {
            result.attributes[slug] = value;
          }
        }
      }

      // --- Description ---
      function isJunk(text) {
        const lower = text.toLowerCase();
        return junkPhrases.some(phrase => lower.includes(phrase));
      }

      const descHeaders = document.querySelectorAll('h2, h3, h4, strong, b');
      for (const hdr of descHeaders) {
        const hdrText = hdr.textContent.trim().toLowerCase();
        if (hdrText === 'description' || hdrText === 'product description' || hdrText === 'overview') {
          let el = hdr.nextElementSibling;
          while (el && (el.tagName === 'BR' || el.textContent.trim() === '')) el = el.nextElementSibling;
          if (el) {
            const text = el.textContent.trim();
            if (text.length > 15 && !isJunk(text)) { result.description = text; break; }
          }
        }
      }
      if (!result.description) {
        const metaDesc = document.querySelector('meta[name="description"]');
        if (metaDesc) {
          const content = metaDesc.getAttribute('content');
          if (content && content.length > 20 && !isJunk(content)) result.description = content.trim();
        }
      }
      if (!result.description) {
        for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
          try {
            const d = JSON.parse(script.textContent);
            if (d.description) { result.description = d.description; break; }
            if (d['@graph']) for (const item of d['@graph']) { if (item.description) { result.description = item.description; break; } }
          } catch (e) {}
        }
      }
      if (!result.description) {
        const root = document.querySelector('main, [role="main"], article') || document.body;
        for (const p of root.querySelectorAll('p')) {
          if (p.closest('footer, header, nav, .modal, .newsletter, form')) continue;
          const text = p.textContent.trim();
          if (text.length > 50 && text.length < 2000 && !isJunk(text) && !text.includes('ID#:')) { result.description = text; break; }
        }
      }

      // --- Collection (with junk filtering) ---
      function isCollectionJunk(text) {
        const lower = text.toLowerCase();
        return collectionJunk.some(phrase => lower.includes(phrase));
      }

      for (const bc of document.querySelectorAll('.breadcrumb a, nav[aria-label*="bread"] a, .breadcrumbs a')) {
        const text = bc.textContent.trim();
        if (text && text.length < 40 && text.length > 2 &&
            !text.toLowerCase().includes('home') && !text.toLowerCase().includes('tile') &&
            !text.toLowerCase().includes('flooring') && !isCollectionJunk(text)) {
          result.collection = text; break;
        }
      }
      if (!result.collection) {
        for (const a of document.querySelectorAll('a[href*="/porcelain"], a[href*="/marble"], a[href*="/granite"], a[href*="/travertine"], a[href*="/vinyl"]')) {
          const text = a.textContent.trim();
          if (text && text.length < 40 && text.length > 2 &&
              !text.toLowerCase().includes('tile') && !text.toLowerCase().includes('flooring') &&
              !isCollectionJunk(text)) {
            result.collection = text; break;
          }
        }
      }
      // H1 heuristic — extract collection name from product name
      if (!result.collection && result.name) {
        const cleaned = result.name.replace(/\s+(Porcelain|Ceramic|Marble|Granite|Travertine|Vinyl|Tile|Plank|Flooring|Collection|Wood|Luxury|Series|Waterproof|Hybrid|Rigid|Core).*$/i, '').trim();
        const words = cleaned.split(/\s+/);
        const sizePrefixes = ['xl', 'xxl', 'lg', 'sm', 'md'];
        const cw = (words.length >= 2 && sizePrefixes.includes(words[0].toLowerCase())) ? words.slice(1) : words;
        if (cw.length >= 1 && cw[0].length > 2) result.collection = cw[0];
      }

      // --- Vinyl/non-dt/dd spec extraction ---
      // Some MSI pages (especially vinyl) display specs as alternating label/value lines:
      //   THICKNESS\n5MM\nWEAR LAYER\n20MIL\n...
      // Parse these when dt/dd extraction found fewer than 3 attributes.
      if (Object.keys(result.attributes).length < 3) {
        const bodyLines = (document.body.innerText || '').split('\n').map(l => l.trim()).filter(Boolean);
        const LINE_SPEC_MAP = {
          'thickness': 'thickness',
          'total thickness': 'thickness',
          'overall thickness': 'thickness',
          'wear layer': 'wear_layer',
          'primary color(s)': 'color',
          'primary color': 'color',
          'style': 'style',
          'shade variation': 'shade_variation',
          'shade variations': 'shade_variation',
          'edge detail': 'edge_type',
          'edge type': 'edge_type',
          'environmental': 'certification',
          'series name(s)': 'collection_name',
          'plank size': 'size',
          'material': 'material',
          'core type': 'core_type',
          'installation method': 'installation_method',
          'dcof': 'dcof',
          'dcof acutest': 'dcof',
          'pei rating': 'pei_rating',
          'water absorption': 'water_absorption',
          'finish': 'finish',
          'rectified/non-rectified': 'rectified',
          'country of origin': 'country',
          'radiant heat': 'radiant_heat',
          'radiant heat compatible': 'radiant_heat'
        };
        for (let li = 0; li < bodyLines.length - 1; li++) {
          const label = bodyLines[li].toLowerCase();
          const slug = LINE_SPEC_MAP[label];
          if (slug && !result.attributes[slug]) {
            const value = bodyLines[li + 1];
            // Skip if value looks like another label or junk
            if (value && value.length < 100 && !LINE_SPEC_MAP[value.toLowerCase()]) {
              if (slug === 'collection_name') {
                if (!result.collection) result.collection = value;
              } else {
                result.attributes[slug] = value;
              }
            }
          }
        }
      }

      // --- Image extraction ---
      const MAX_IMAGES = 8; // 1 primary + up to 7 alternates
      const seenUrls = new Set();

      // Build name keywords to filter out images of other products/colors.
      // "Antoni Gris Porcelain Wood Tile" → ['antoni', 'gris']
      // We strip generic material/type words and keep the distinctive name words.
      const GENERIC_WORDS = new Set(['porcelain','ceramic','marble','granite','travertine',
        'quartzite','slate','sandstone','limestone','onyx','tile','tiles','plank','planks',
        'flooring','wood','vinyl','luxury','collection','series','waterproof','hybrid',
        'rigid','core','look','matte','polished','honed','mosaic','backsplash','wall',
        'floor','natural','stone','slab','countertop','countertops','paver','pavers',
        'stacked','ledger','panel','prefab','vanity','top','tops','engineered','hardwood']);
      const nameKeywords = (result.name || '').toLowerCase()
        .replace(/[^a-z0-9\s]/g, '')
        .split(/\s+/)
        .filter(w => w.length >= 3 && !GENERIC_WORDS.has(w));

      function addImage(src, trusted) {
        if (!src) return;
        if (result.images.length >= MAX_IMAGES) return;
        try {
          const u = new URL(src, window.location.origin);
          const href = u.href;
          if (seenUrls.has(href)) return;
          if (!href.includes('cdn.msisurfaces.com') && !href.includes('/files/')) return;
          if (/\.(svg|gif|ico)(\?|$)/i.test(href)) return;
          // Skip non-product images
          if (/icon|logo|badge|placeholder/i.test(href)) return;
          if (/\/miscellaneous\//i.test(href)) return;
          if (/\/thumbnails\//i.test(href)) return;
          if (/\/flyers\//i.test(href)) return;
          if (/\/brochures\//i.test(href)) return;
          if (/roomvo|wetcutting/i.test(href)) return;
          // Unless from a trusted source (og:image, JSON-LD), verify the URL
          // contains at least one keyword from the product name to avoid
          // images of other colors/products shown on the same page.
          if (!trusted && nameKeywords.length > 0) {
            const urlLower = decodeURIComponent(href).toLowerCase();
            const matches = nameKeywords.some(kw => urlLower.includes(kw));
            if (!matches) return;
          }
          seenUrls.add(href);
          const type = result.images.length === 0 ? 'primary' : 'alternate';
          result.images.push({ url: href, type });
        } catch {}
      }

      // 1. og:image meta tag (most reliable hero image) — trusted
      const ogImage = document.querySelector('meta[property="og:image"]');
      if (ogImage) addImage(ogImage.getAttribute('content'), true);

      // 2. JSON-LD structured data — trusted
      for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
        try {
          const d = JSON.parse(script.textContent);
          const imgs = d.image ? (Array.isArray(d.image) ? d.image : [d.image]) : [];
          imgs.forEach(u => addImage(u, true));
          if (d['@graph']) {
            for (const item of d['@graph']) {
              if (item.image) {
                const ii = Array.isArray(item.image) ? item.image : [item.image];
                ii.forEach(u => addImage(u, true));
              }
            }
          }
        } catch {}
      }

      // 3. Gallery img tags — filtered by name keywords
      const selectors = [
        '.product-gallery img',
        '.slick-slide img',
        '.hero-image img',
        'img[src*="cdn.msisurfaces.com"]',
        '.product-image img',
        '.product-detail img'
      ];
      for (const sel of selectors) {
        document.querySelectorAll(sel).forEach(img => {
          addImage(img.src, false);
          addImage(img.getAttribute('data-src'), false);
          addImage(img.getAttribute('data-lazy'), false);
        });
      }

      return result;
    }, JUNK_PHRASES, COLLECTION_JUNK);

    // ── Post-process: clean collection name and strip prefix from product name ──

    if (data.collection) {
      // Remove ®, ™, ©, TM superscripts, and "Collection"/"Series" suffix
      data.collection = data.collection
        .replace(/[®™©]/g, '')
        .replace(/TM(?:\b|$)/g, '')
        .replace(/\s+(Collection|Series)\s*$/i, '')
        .trim();

      // Title-case ALL CAPS collection names: "ARABESCATO CARRARA" → "Arabescato Carrara"
      if (data.collection.length > 3 && data.collection === data.collection.toUpperCase()) {
        data.collection = data.collection
          .toLowerCase()
          .replace(/\b\w/g, c => c.toUpperCase());
      }

      // Reject junk/generic collection names extracted from page chrome
      const JUNK_COLLECTIONS = [
        'hover to zoom', 'detail', 'details', 'countertops', 'countertop',
        'flooring', 'backsplash', 'wall tile', 'floor tile', 'mosaics',
        'porcelain tile', 'marble tile', 'natural stone', 'click to zoom',
        'product details', 'specifications', 'stacked stone', 'hardscape',
        'click to expand', 'view more', 'see more', 'show all',
        'quartz countertop colors', 'hardscaping', 'natural stone collection',
        'waterproof hybrid rigid core', 'w luxury genuine hardwood',
        'waterproof wood', 'golden', 'collections', 'check slab inventory',
        'solid hardwood collection', 'tub & shower surrounds',
      ];
      if (JUNK_COLLECTIONS.includes(data.collection.toLowerCase())) {
        data.collection = '';
      }
    }

    // Strip ®, ™, © from product name
    if (data.name) {
      data.name = data.name.replace(/[®™©]/g, '').replace(/TM(?:\b|$)/g, '').trim();
    }

    // Strip material suffixes that may have been missed by in-page regex
    // (handles "Porcelain Wood Tile", "Wood Tile", "Brick Tile", "Marble" etc.)
    if (data.name) {
      data.name = data.name
        .replace(/\s+(Porcelain|Ceramic|Marble|Granite|Travertine|Quartzite|Limestone|Slate|Sandstone|Onyx|Basalt)(\s+\w+)?\s+(Tiles?|Planks?|Flooring|Slabs?|Stones?)\s*$/i, '')
        .replace(/\s+Wood\s+(?:Look\s+)?(?:Tiles?|Wall)\s*$/i, '')
        .replace(/\s+Brick\s+Tiles?\s*$/i, '')
        .replace(/\s+Bricks?\s*$/i, '')
        .replace(/\s+(?:Tiles?|Planks?|Flooring)\s*$/i, '')
        .replace(/\s+(Porcelain|Ceramic|Marble|Granite|Travertine|Quartzite|Limestone|Slate|Sandstone|Onyx|Basalt)\s*$/i, '')
        .replace(/\s+(Luxury Vinyl Planks?|Luxury Vinyl Tiles?|Luxury Vinyl|Vinyl Planks?|Vinyl Tiles?|LVP|LVT|SPC)\s*$/i, '')
        .replace(/\s+(Engineered Hardwood|Solid Hardwood|Hardwood)\s*$/i, '')
        .replace(/\s+Hybrid\s+Rigid\s+Core\s*$/i, '')
        .replace(/\s+(?:Oak\s+)?Wood\s*$/i, '')
        .replace(/\s+(Collection|Series)\s*$/i, '')
        .trim();
    }

    // Strip collection prefix from product name (like Elysium/AZ Tile pattern)
    // "Andover Vintaj" with collection "Andover" → "Vintaj"
    if (data.collection && data.name) {
      const collLower = data.collection.toLowerCase();
      const nameLower = data.name.toLowerCase();
      if (nameLower.startsWith(collLower + ' ')) {
        data.name = data.name.slice(data.collection.length).trim();
      }
    }

    // Handle marble/stone naming: if product name ended up as just a material word
    // (e.g., collection="Arabescato Carrara", name="Marble"), swap them.
    const MATERIAL_WORDS = ['marble', 'granite', 'quartzite', 'travertine', 'limestone',
      'slate', 'sandstone', 'onyx', 'basalt', 'soapstone', 'porcelain', 'ceramic'];
    if (data.name && MATERIAL_WORDS.includes(data.name.toLowerCase()) && data.collection) {
      // The "collection" is actually the product name (stone variety)
      data.name = data.collection;
      data.collection = '';
    }
    // If name equals collection (single-variety product like "Bianco Dolomite"),
    // keep collection empty — name IS the product identifier
    if (data.name && data.collection && data.name.toLowerCase() === data.collection.toLowerCase()) {
      data.collection = '';
    }
    // Also handle empty name after all stripping
    if (!data.name && data.collection) {
      data.name = data.collection;
      data.collection = '';
    }

    // Extract size from product name for brick/specialty products
    // "Charcoal 2x10" → name="Charcoal", moves size to variant data
    if (data.name) {
      const sizeInName = data.name.match(/^(.+?)\s+(\d+\.?\d*\s*[xX×]\s*\d+\.?\d*)\s*$/);
      if (sizeInName) {
        data._extractedSize = sizeInName[2].replace(/\s*[xX×]\s*/g, 'x');
        data.name = sizeInName[1].trim();
      }
    }

    // Strip collection+name prefix from variant names
    // "Acclima Ayla End Cap" → "End Cap", "Brockton -Tmold 94\"" → "Tmold 94\""
    if (data.skus && data.name) {
      const fullPrefix = data.collection
        ? (data.collection + ' ' + data.name).toLowerCase()
        : data.name.toLowerCase();
      const nameOnly = data.name.toLowerCase();
      for (const sku of data.skus) {
        if (!sku.variantName) continue;
        const vLower = sku.variantName.toLowerCase();
        let stripped = sku.variantName;
        if (data.collection && vLower.startsWith(fullPrefix + ' ')) {
          stripped = sku.variantName.slice(fullPrefix.length + 1);
        } else if (vLower.startsWith(nameOnly + ' ')) {
          stripped = sku.variantName.slice(nameOnly.length + 1);
        }
        // Clean leading dashes and whitespace
        sku.variantName = stripped.replace(/^[\s\-]+/, '').trim() || sku.variantName;
      }
    }

    return data;
  } finally {
    await page.close();
  }
}
