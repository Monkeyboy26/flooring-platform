import { launchBrowser, delay, upsertProduct, upsertSku, upsertSkuAttribute, upsertPackaging, appendLog, addJobError, downloadImage, upsertMediaAsset, resolveImageExtension } from './base.js';

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
    // Backsplash & Wall
    '/backsplash-tile/',
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
  delayMs: 1500
};

/**
 * MSI Surfaces scraper.
 * Navigates category pages, collects product URLs, then scrapes each product page.
 * MSI is a JS-rendered SPA — requires networkidle2 + explicit selector waits.
 */
export async function run(pool, job, source) {
  const config = { ...DEFAULT_CONFIG, ...(source.config || {}) };
  const baseUrl = source.base_url.replace(/\/$/, '');
  const vendor_id = source.vendor_id;

  // Map MSI category URL paths to DB category slugs
  const CATEGORY_MAP = {
    // Tile
    '/porcelain-tile/':               'porcelain-tile',
    '/marble-tile/':                  'natural-stone',
    '/travertine-tile/':              'natural-stone',
    '/granite-tile/':                 'natural-stone',
    '/quartzite-tile/':               'natural-stone',
    '/slate-tile/':                   'natural-stone',
    '/sandstone-tile/':               'natural-stone',
    '/limestone-tile/':               'natural-stone',
    '/onyx-tile/':                    'natural-stone',
    '/wood-look-tile-and-planks/':    'wood-look-tile',
    '/large-format-tile/':            'large-format-tile',
    '/commercial-tile/':              'commercial-tile',
    // Luxury Vinyl
    '/luxury-vinyl-flooring/':        'lvp-plank',
    '/waterproof-hybrid-rigid-core/': 'lvp-plank',
    // Hardwood
    '/w-luxury-genuine-hardwood/':    'engineered-hardwood',
    // Countertops
    '/quartz-countertops/':           'quartz-countertops',
    '/granite-countertops/':          'granite-countertops',
    '/marble-countertops/':           'marble-countertops',
    '/quartzite-countertops/':        'quartzite-countertops',
    '/stile/porcelain-slabs/':        'porcelain-slabs',
    '/prefabricated-countertops/':    'prefab-countertops',
    '/soapstone-countertops/':        'soapstone-countertops',
    '/vanity-tops-countertops/':      'vanity-tops',
    // Backsplash & Wall
    '/backsplash-tile/':              'backsplash-tile',
    '/mosaics/collections-mosaics/':  'mosaic-tile',
    '/fluted-looks/':                 'fluted-tile',
    // Hardscaping
    '/hardscape/rockmount-stacked-stone/': 'stacked-stone',
    '/hardscape/arterra-porcelain-pavers/': 'pavers',
    '/evergrass-turf/':               'artificial-turf',
    // Waterproof Wood
    '/waterproof-wood-flooring/woodhills/': 'waterproof-wood',
  };

  // sell_by override per category slug (default is 'sqft')
  const SELL_BY_MAP = {
    'quartz-countertops': 'unit',
    'granite-countertops': 'unit',
    'marble-countertops': 'unit',
    'quartzite-countertops': 'unit',
    'porcelain-slabs': 'unit',
    'prefab-countertops': 'unit',
    'soapstone-countertops': 'unit',
    'vanity-tops': 'unit',
    'lvp-plank': 'box',
    'waterproof-wood': 'box',
  };

  // Vinyl trim/accessories are sold per piece, not per box
  const TRIM_SELL_BY = 'unit';

  // Build slug→id lookup from DB
  const categoryIdMap = {};
  const catResult = await pool.query('SELECT id, slug FROM categories');
  for (const row of catResult.rows) categoryIdMap[row.slug] = row.id;

  let browser;
  let totalFound = 0;
  let totalCreated = 0;
  let totalUpdated = 0;
  let totalSkusCreated = 0;

  try {
    await appendLog(pool, job.id, 'Launching browser...');
    browser = await launchBrowser();

    for (const categoryPath of config.categories) {
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

      // Resolve category_id for this URL path
      const categorySlug = CATEGORY_MAP[categoryPath] || null;
      const currentCategoryId = categorySlug ? (categoryIdMap[categorySlug] || null) : null;

      for (let i = 0; i < productUrls.length; i++) {
        const url = productUrls[i];
        try {
          const data = await scrapeProductPage(browser, url, config);
          if (!data || !data.name) {
            await appendLog(pool, job.id, `Skipped ${url} — no product name found`);
            continue;
          }

          // Skip non-product pages
          const nameLower = (data.name || '').toLowerCase();
          const collLower = (data.collection || '').toLowerCase();

          // 1. No SKUs + generic/info page name
          if ((!data.skus || data.skus.length === 0)) {
            const isGenericName = /^\d+\s*[x×]\s*\d+\b/i.test(data.name)
              || /^(colors?|features|benefits|about|gallery|installation|maintenance|faq|resources)\b/i.test(data.name)
              || collLower.includes('features and benefits')
              || collLower.includes('installation')
              || nameLower.includes('features and benefits');
            if (isGenericName) {
              await appendLog(pool, job.id, `Skipped ${url} — non-product page: "${data.name}"`);
              continue;
            }
          }

          // 2. Known non-product page patterns (even if they have URL-derived SKUs)
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
          if (isNonProduct) {
            await appendLog(pool, job.id, `Skipped ${url} — non-product page: "${data.name}"`);
            continue;
          }

          // 3. Skip if all SKUs are URL-derived (no real ID# codes found)
          // Real MSI SKUs contain digits (e.g. NADEGRI1818, VTGSELBOU9X48-2MM-12MIL)
          // URL-derived ones are just uppercase slugs (e.g. ANDOVER, CYRUS, BRAXTON)
          const hasRealSku = data.skus && data.skus.some(s => /\d/.test(s.code));
          if (!hasRealSku) {
            await appendLog(pool, job.id, `Skipped ${url} — no real SKU codes (URL-derived only): "${data.name}"`);
            continue;
          }

          // Upsert product
          const product = await upsertProduct(pool, {
            vendor_id,
            name: data.name,
            collection: data.collection,
            category_id: currentCategoryId,
            description_short: data.description ? data.description.slice(0, 255) : null,
            description_long: data.description
          });

          if (product.is_new) totalCreated++;
          else totalUpdated++;

          // Upsert SKU(s) — use extracted ID# variants; fall back to URL-based
          const skuEntries = data.skus && data.skus.length > 0
            ? data.skus
            : extractSkuFromUrl(url).map(code => ({ code, size: '', finish: '', variantName: null }));

          for (const entry of skuEntries) {
            const vendorSku = entry.code;
            const cleanSku = vendorSku.replace(/\s+/g, '-').toUpperCase();
            const internalSku = 'MSI-' + cleanSku;
            const baseSellBy = SELL_BY_MAP[categorySlug] || 'sqft';
            // Vinyl trim/accessories are sold per piece, not per box
            const sellBy = (entry.variant_type === 'trim' || entry.variant_type === 'accessory') ? TRIM_SELL_BY : baseSellBy;
            const sku = await upsertSku(pool, {
              product_id: product.id,
              vendor_sku: vendorSku,
              internal_sku: internalSku,
              variant_name: entry.variantName || (skuEntries.length > 1 ? vendorSku : null),
              sell_by: sellBy,
              variant_type: entry.variant_type
            });
            if (sku.is_new) totalSkusCreated++;

            // Upsert product-level attributes (shared across all variants)
            for (const [attrSlug, value] of Object.entries(data.attributes || {})) {
              await upsertSkuAttribute(pool, sku.id, attrSlug, value);
            }

            // Upsert per-variant size and finish (overrides product-level if present)
            if (entry.size) {
              await upsertSkuAttribute(pool, sku.id, 'size', entry.size);
            }
            if (entry.finish) {
              await upsertSkuAttribute(pool, sku.id, 'finish', entry.finish);
            }

            // Fetch packaging data from MSI inventory API
            const pkg = await fetchPackagingData(baseUrl, vendorSku);
            if (pkg) {
              await upsertPackaging(pool, sku.id, {
                sqft_per_box: pkg.sqft_per_box,
                pieces_per_box: pkg.pieces_per_box,
                weight_per_box_lbs: pkg.weight_per_box_lbs,
                boxes_per_pallet: pkg.boxes_per_pallet,
                sqft_per_pallet: pkg.sqft_per_pallet,
                weight_per_pallet_lbs: pkg.weight_per_pallet_lbs
              });
              if (pkg.thickness) {
                await upsertSkuAttribute(pool, sku.id, 'thickness', pkg.thickness);
              }
            }
          }

          // Download and persist images
          const UPLOADS_BASE = process.env.UPLOADS_PATH || '/app/uploads';
          if (data.images && data.images.length > 0) {
            let altIndex = 0;
            for (const img of data.images) {
              try {
                const ext = resolveImageExtension(img.url);
                const filename = img.type === 'primary' ? `primary${ext}` : `alt-${++altIndex}${ext}`;
                const destPath = `${UPLOADS_BASE}/products/${product.id}/${filename}`;
                const localUrl = `/uploads/products/${product.id}/${filename}`;
                const downloaded = await downloadImage(img.url, destPath);
                if (downloaded) {
                  await upsertMediaAsset(pool, {
                    product_id: product.id,
                    sku_id: null,
                    asset_type: img.type,
                    url: localUrl,
                    original_url: img.url,
                    sort_order: img.type === 'primary' ? 0 : altIndex
                  });
                }
              } catch (imgErr) {
                // Non-fatal: log and continue
              }
            }
          }

          // Log progress every 10 products
          if ((i + 1) % 10 === 0 || i === productUrls.length - 1) {
            await appendLog(pool, job.id, `Progress: ${i + 1}/${productUrls.length} in ${categoryPath}`, {
              products_found: totalFound,
              products_created: totalCreated,
              products_updated: totalUpdated,
              skus_created: totalSkusCreated
            });
          }
        } catch (err) {
          await appendLog(pool, job.id, `ERROR scraping ${url}: ${err.message}`);
          await addJobError(pool, job.id, `Product ${url}: ${err.message}`);
        }

        await delay(config.delayMs);
      }
    }

    // Final counter update
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

/**
 * Fetch packaging data from MSI's inventory tile details API.
 * Endpoint: /inventory/tiledetails/?handler=CatagoryPartial&ItemId={SKU_CODE}
 * Returns parsed packaging object or null if not found.
 */
async function fetchPackagingData(baseUrl, skuCode) {
  try {
    const url = `${baseUrl}/inventory/tiledetails/?handler=CatagoryPartial&ItemId=${encodeURIComponent(skuCode)}`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' }
    });
    if (!resp.ok) return null;

    const html = await resp.text();
    if (html.includes('No Records')) return null;

    // Parse tblQty table rows: <td>Label</td><td>Value</td>
    const fields = {};
    const rows = [...html.matchAll(/<tr>[\s\S]*?<td[^>]*>([\s\S]*?)<\/td>[\s\S]*?<td[^>]*>\s*([\s\S]*?)\s*<\/td>[\s\S]*?<\/tr>/g)];
    for (const m of rows) {
      const label = m[1].replace(/<[^>]+>/g, '').trim();
      const value = m[2].replace(/<[^>]+>/g, '').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&').trim();
      if (label && value) fields[label] = value;
    }

    const sqftPerBox = parseFloat(fields['Sqft Per Box']) || 0;
    const piecesPerBox = parseInt(fields['Pcs In Box']) || 0;
    const pcsPerCrate = parseInt(fields['Pcs Per Crate']) || 0;
    const weightPerPc = parseFloat(fields['Approx Weight Per Pc']) || 0;
    const thickness = fields['Approximate Thickness'] || null;

    // Skip items with no real packaging data (e.g. slabs return all zeros)
    if (!sqftPerBox && !piecesPerBox) return null;

    const boxesPerPallet = (pcsPerCrate && piecesPerBox) ? Math.round(pcsPerCrate / piecesPerBox) : null;
    const weightPerBox = (weightPerPc && piecesPerBox) ? Math.round(weightPerPc * piecesPerBox * 100) / 100 : null;
    const sqftPerPallet = (sqftPerBox && boxesPerPallet) ? Math.round(sqftPerBox * boxesPerPallet * 100) / 100 : null;
    const weightPerPallet = (weightPerPc && pcsPerCrate) ? Math.round(weightPerPc * pcsPerCrate * 100) / 100 : null;

    return {
      sqft_per_box: sqftPerBox || null,
      pieces_per_box: piecesPerBox || null,
      weight_per_box_lbs: weightPerBox,
      boxes_per_pallet: boxesPerPallet,
      sqft_per_pallet: sqftPerPallet,
      weight_per_pallet_lbs: weightPerPallet,
      thickness
    };
  } catch (e) {
    return null;
  }
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
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
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
            if (dimMatch || thickMatch) {
              const parts = [];
              if (dimMatch) parts.push(dimMatch[1] + 'x' + dimMatch[2]);
              if (thickMatch) parts.push(thickMatch[1] + 'mm');
              if (milMatch) parts.push(milMatch[1] + 'mil');
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
        'core type': 'material',
        'installation method': 'style'
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
      // Parse these when dt/dd extraction found nothing.
      if (Object.keys(result.attributes).length === 0) {
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
          'material': 'material'
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

    return data;
  } finally {
    await page.close();
  }
}
