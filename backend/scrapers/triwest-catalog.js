import {
  launchBrowser, delay, upsertProduct, upsertSku,
  upsertSkuAttribute, upsertPackaging,
  appendLog, addJobError, normalizeSize, buildVariantName
} from './base.js';
import { triwestLogin, triwestLoginFromCookies, PORTAL_BASE, screenshot } from './triwest-auth.js';

const MAX_ERRORS = 50;

/**
 * Maps DNav product categories to PIM category slugs.
 */
const CATEGORY_MAP = {
  'hardwood':     'engineered-hardwood',
  'engineered':   'engineered-hardwood',
  'solid':        'solid-hardwood',
  'resilient':    'lvp-plank',
  'lvt':          'lvp-plank',
  'lvp':          'lvp-plank',
  'vinyl':        'lvp-plank',
  'waterproof':   'lvp-plank',
  'hybrid':       'lvp-plank',
  'laminate':     'laminate',
  'carpet-tile':  'carpet-tile',
  'carpet':       'carpet-tile',
};

/**
 * Tri-West DNav catalog scraper.
 *
 * Logs into the DNav (Décor 24) dealer portal, browses/searches for products,
 * and extracts item numbers, descriptions, sizes, packaging, and attributes.
 *
 * Supports two modes:
 * - Discovery mode (config.discovery_mode = true): Screenshots the portal, logs
 *   navigation structure, and explores common paths. Run this FIRST to understand
 *   the portal layout before building the full parser.
 * - Full mode: Parses product listings and detail pages, upserts into DB.
 *
 * Template: bed.js (Puppeteer listing → detail → upsert)
 */
export async function run(pool, job, source) {
  const config = source.config || {};
  const discoveryMode = config.discovery_mode === true;
  const maxProducts = config.max_products || 5000;
  const delayMs = config.delay_ms || 1500;
  const vendor_id = source.vendor_id;

  let browser = null;
  let errorCount = 0;
  let productsFound = 0;
  let productsCreated = 0;
  let productsUpdated = 0;
  let skusCreated = 0;

  async function logError(msg) {
    errorCount++;
    if (errorCount <= MAX_ERRORS) {
      try { await addJobError(pool, job.id, msg); } catch { }
    }
  }

  try {
    // Step 1: Login
    let cookies;
    try {
      cookies = await triwestLogin(pool, job.id);
    } catch (err) {
      await appendLog(pool, job.id, `Puppeteer login failed: ${err.message} — trying cookie fallback...`);
      cookies = await triwestLoginFromCookies(pool, job.id);
    }

    // Step 2: Launch browser for portal navigation
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1440, height: 900 });

    // Set cookies in browser
    const cookiePairs = cookies.split('; ').map(pair => {
      const [name, ...rest] = pair.split('=');
      return { name, value: rest.join('='), domain: 'tri400.triwestltd.com' };
    });
    await page.setCookie(...cookiePairs);

    // Navigate to portal dashboard
    await appendLog(pool, job.id, `Navigating to DNav portal...`);
    await page.goto(PORTAL_BASE, { waitUntil: 'networkidle2', timeout: 30000 });
    await delay(2000);

    // Check if we're still logged in
    const currentUrl = page.url();
    if (currentUrl.includes('login') || currentUrl.includes('Login')) {
      throw new Error('Session cookies not accepted — redirected to login');
    }

    await appendLog(pool, job.id, `Portal loaded: ${currentUrl}`);

    // ─── DISCOVERY MODE ───
    if (discoveryMode) {
      await runDiscovery(page, pool, job);
      await appendLog(pool, job.id, '=== DISCOVERY MODE COMPLETE ===');
      await appendLog(pool, job.id, 'Review screenshots and logs above. Then set discovery_mode: false to run full scrape.');
      return;
    }

    // ─── FULL MODE ───
    // Look up category IDs
    const categoryLookup = await buildCategoryLookup(pool);

    // Find product listings
    const productListings = await scrapeProductListings(page, pool, job, maxProducts, delayMs);
    productsFound = productListings.length;
    await appendLog(pool, job.id, `Found ${productsFound} products in portal`);

    // Upsert each product
    for (let i = 0; i < productListings.length; i++) {
      const item = productListings[i];

      try {
        // Determine category
        const categorySlug = mapCategory(item.category);
        const category_id = categorySlug ? (categoryLookup[categorySlug] || null) : null;

        // Collection = "Brand - Collection Name"
        const collection = item.brand && item.collection
          ? `${item.brand} - ${item.collection}`
          : item.brand || item.collection || '';

        // Upsert product
        const product = await upsertProduct(pool, {
          vendor_id,
          name: item.name || item.itemNumber,
          collection,
          category_id,
          description_short: item.description || null,
        });

        if (product.is_new) productsCreated++;
        else productsUpdated++;

        // Build internal SKU: TW-<vendor_sku>
        const vendorSku = item.itemNumber;
        const internalSku = `TW-${vendorSku}`;

        // Determine sell_by
        const sellBy = item.unit === 'PCS' || item.unit === 'EA' ? 'unit' : 'sqft';

        // Build variant name from size
        const variantName = buildVariantName(item.size, item.finish);

        // Upsert SKU
        const sku = await upsertSku(pool, {
          product_id: product.id,
          vendor_sku: vendorSku,
          internal_sku: internalSku,
          variant_name: variantName,
          sell_by: sellBy,
        });

        if (sku.is_new) skusCreated++;

        // Upsert packaging if available
        if (item.sqftPerBox || item.piecesPerBox) {
          await upsertPackaging(pool, sku.id, {
            sqft_per_box: item.sqftPerBox || null,
            pieces_per_box: item.piecesPerBox || null,
            weight_per_box_lbs: item.weightPerBox || null,
            boxes_per_pallet: item.boxesPerPallet || null,
          });
        }

        // Upsert attributes
        if (item.size) await upsertSkuAttribute(pool, sku.id, 'size', normalizeSize(item.size));
        if (item.finish) await upsertSkuAttribute(pool, sku.id, 'finish', item.finish);
        if (item.color) await upsertSkuAttribute(pool, sku.id, 'color', item.color);
        if (item.material) await upsertSkuAttribute(pool, sku.id, 'material', item.material);
        if (item.thickness) await upsertSkuAttribute(pool, sku.id, 'thickness', item.thickness);

      } catch (err) {
        await logError(`Product ${item.itemNumber}: ${err.message}`);
      }

      // Progress logging every 25 products
      if ((i + 1) % 25 === 0) {
        await appendLog(pool, job.id,
          `Progress: ${i + 1}/${productsFound} — created: ${productsCreated}, updated: ${productsUpdated}, SKUs: ${skusCreated}`,
          { products_found: productsFound, products_created: productsCreated, products_updated: productsUpdated, skus_created: skusCreated }
        );
      }
    }

    // Bulk activate products
    if (productsCreated + productsUpdated > 0) {
      await pool.query(`
        UPDATE products SET status = 'active'
        WHERE vendor_id = $1 AND status = 'draft'
      `, [vendor_id]);
      await appendLog(pool, job.id, 'Activated all draft Tri-West products');
    }

    await appendLog(pool, job.id,
      `Complete. Found: ${productsFound}, Created: ${productsCreated}, Updated: ${productsUpdated}, SKUs: ${skusCreated}, Errors: ${errorCount}`,
      { products_found: productsFound, products_created: productsCreated, products_updated: productsUpdated, skus_created: skusCreated }
    );

  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

/**
 * Discovery mode: screenshot the portal, log navigation, explore structure.
 * This runs BEFORE building the full parser.
 */
async function runDiscovery(page, pool, job) {
  await appendLog(pool, job.id, '=== DISCOVERY MODE START ===');

  // Screenshot the dashboard/home page
  await screenshot(page, 'triwest-dashboard');
  await appendLog(pool, job.id, `Dashboard URL: ${page.url()}`);

  // Log page title and basic structure
  const pageInfo = await page.evaluate(() => {
    return {
      title: document.title,
      url: window.location.href,
      bodyTextSnippet: document.body.innerText.slice(0, 1000),
    };
  });
  await appendLog(pool, job.id, `Page title: ${pageInfo.title}`);
  await appendLog(pool, job.id, `Body text: ${pageInfo.bodyTextSnippet}`);

  // Log all navigation links
  const navLinks = await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a[href]'));
    return links.map(a => ({
      text: a.textContent.trim().slice(0, 80),
      href: a.href,
    })).filter(l => l.text && !l.href.startsWith('javascript'));
  });

  await appendLog(pool, job.id, `Found ${navLinks.length} links on dashboard:`);
  for (const link of navLinks.slice(0, 50)) {
    await appendLog(pool, job.id, `  [${link.text}] → ${link.href}`);
  }

  // Log all forms and input fields
  const formInfo = await page.evaluate(() => {
    const forms = Array.from(document.querySelectorAll('form'));
    return forms.map(f => ({
      action: f.action,
      method: f.method,
      inputs: Array.from(f.querySelectorAll('input, select, textarea')).map(i => ({
        tag: i.tagName, type: i.type, name: i.name, id: i.id,
        placeholder: i.placeholder, value: i.value?.slice(0, 50),
      }))
    }));
  });
  await appendLog(pool, job.id, `Forms: ${JSON.stringify(formInfo, null, 2)}`);

  // Look for iframes (DNav sometimes uses frames)
  const iframes = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('iframe, frame')).map(f => ({
      src: f.src, name: f.name, id: f.id,
    }));
  });
  if (iframes.length > 0) {
    await appendLog(pool, job.id, `Frames found: ${JSON.stringify(iframes)}`);
  }

  // Explore common DNav paths
  const pathsToTry = [
    '/search', '/catalog', '/products', '/inventory',
    '/itemsearch', '/item', '/pricelist', '/price',
    '/order', '/orders', '/account',
  ];

  for (const pathSuffix of pathsToTry) {
    try {
      const testUrl = `${PORTAL_BASE}${pathSuffix}`;
      await appendLog(pool, job.id, `Trying path: ${testUrl}`);
      const response = await page.goto(testUrl, { waitUntil: 'networkidle2', timeout: 15000 });

      if (response && response.status() < 400) {
        await screenshot(page, `triwest-path-${pathSuffix.replace(/\//g, '-')}`);
        const text = await page.evaluate(() => document.body.innerText.slice(0, 500));
        await appendLog(pool, job.id, `  Status: ${response.status()} — Content: ${text.slice(0, 200)}`);
      } else {
        await appendLog(pool, job.id, `  Status: ${response ? response.status() : 'no response'}`);
      }
    } catch (err) {
      await appendLog(pool, job.id, `  Error: ${err.message}`);
    }

    await delay(1000);
  }

  // Go back to dashboard and try searching
  await page.goto(PORTAL_BASE, { waitUntil: 'networkidle2', timeout: 30000 });
  await delay(1000);

  // Try to find a search box and search for a known brand
  const searchSelector = await page.evaluate(() => {
    const candidates = Array.from(document.querySelectorAll('input[type="text"], input[type="search"], input[name*="search"], input[name*="item"], input[placeholder*="Search"], input[placeholder*="search"]'));
    if (candidates.length > 0) {
      return {
        found: true,
        selector: candidates[0].name ? `input[name="${candidates[0].name}"]` : (candidates[0].id ? `#${candidates[0].id}` : 'input[type="search"]'),
        info: { type: candidates[0].type, name: candidates[0].name, placeholder: candidates[0].placeholder }
      };
    }
    return { found: false };
  });

  if (searchSelector.found) {
    await appendLog(pool, job.id, `Search field found: ${JSON.stringify(searchSelector.info)}`);

    // Try searching for "Provenza" as a test
    try {
      await page.click(searchSelector.selector, { clickCount: 3 });
      await page.type(searchSelector.selector, 'Provenza', { delay: 50 });
      await page.keyboard.press('Enter');
      await delay(3000);
      await screenshot(page, 'triwest-search-provenza');

      const searchResults = await page.evaluate(() => document.body.innerText.slice(0, 2000));
      await appendLog(pool, job.id, `Search results: ${searchResults.slice(0, 500)}`);
    } catch (err) {
      await appendLog(pool, job.id, `Search attempt failed: ${err.message}`);
    }
  } else {
    await appendLog(pool, job.id, 'No search field found on dashboard');
  }

  // Log network requests made by the page (for API discovery)
  await appendLog(pool, job.id, 'Discovery complete — review screenshots in uploads folder');
}

/**
 * Scrape product listings from the DNav portal.
 * This is a placeholder that will be refined after discovery mode reveals the portal structure.
 */
async function scrapeProductListings(page, pool, job, maxProducts, delayMs) {
  const allProducts = [];
  let pageNum = 0;

  // Try to navigate to a product listing or search page
  // (Exact navigation will be refined after discovery mode)

  // Attempt: search for all products
  const searchInputs = await page.$$('input[type="text"], input[type="search"]');
  if (searchInputs.length > 0) {
    await searchInputs[0].click({ clickCount: 3 });
    await searchInputs[0].type('*', { delay: 50 });
    await page.keyboard.press('Enter');
    await delay(3000);
  }

  // Paginate through results
  while (allProducts.length < maxProducts) {
    pageNum++;
    const items = await extractProductsFromPage(page);

    if (items.length === 0) {
      await appendLog(pool, job.id, `No products found on page ${pageNum}, stopping`);
      break;
    }

    allProducts.push(...items);
    await appendLog(pool, job.id, `Page ${pageNum}: extracted ${items.length} items (total: ${allProducts.length})`);

    // Try to navigate to next page
    const hasNext = await clickNextPage(page);
    if (!hasNext) break;

    await delay(delayMs);
  }

  return allProducts;
}

/**
 * Extract product data from the current page.
 * Flexible extraction that handles tables, cards, and list layouts.
 */
async function extractProductsFromPage(page) {
  return page.evaluate(() => {
    const results = [];

    // Strategy 1: Look for table rows (DNav often uses data tables)
    const tables = document.querySelectorAll('table');
    for (const table of tables) {
      const rows = Array.from(table.querySelectorAll('tr'));
      // Skip header row
      for (let i = 1; i < rows.length; i++) {
        const cells = Array.from(rows[i].querySelectorAll('td'));
        if (cells.length < 3) continue;

        const text = rows[i].textContent;
        // Look for item number pattern
        const itemMatch = text.match(/\b([A-Z]{2,5}[-.]?[A-Z0-9]{3,}[-.]?[A-Z0-9]*)\b/);
        if (!itemMatch) continue;

        results.push({
          itemNumber: itemMatch[1],
          name: cells[1]?.textContent?.trim() || null,
          description: cells[2]?.textContent?.trim() || null,
          brand: null,
          collection: null,
          category: null,
          size: null,
          finish: null,
          color: null,
          material: null,
          thickness: null,
          unit: null,
          sqftPerBox: null,
          piecesPerBox: null,
          weightPerBox: null,
          boxesPerPallet: null,
        });
      }
    }

    // Strategy 2: Look for product cards/divs
    if (results.length === 0) {
      const cards = document.querySelectorAll('[class*="product"], [class*="item"], [class*="card"]');
      for (const card of cards) {
        const text = card.textContent;
        const itemMatch = text.match(/\b([A-Z]{2,5}[-.]?[A-Z0-9]{3,}[-.]?[A-Z0-9]*)\b/);
        if (!itemMatch) continue;

        const nameEl = card.querySelector('h1, h2, h3, h4, h5, [class*="name"], [class*="title"]');

        results.push({
          itemNumber: itemMatch[1],
          name: nameEl?.textContent?.trim() || null,
          description: null,
          brand: null,
          collection: null,
          category: null,
          size: null,
          finish: null,
          color: null,
          material: null,
          thickness: null,
          unit: null,
          sqftPerBox: null,
          piecesPerBox: null,
          weightPerBox: null,
          boxesPerPallet: null,
        });
      }
    }

    return results;
  });
}

/**
 * Try to click "Next" or advance pagination.
 */
async function clickNextPage(page) {
  const clicked = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('a, button, input[type="button"]'));
    const next = buttons.find(el => {
      const text = (el.textContent || el.value || '').trim().toLowerCase();
      const label = (el.getAttribute('aria-label') || '').toLowerCase();
      return (text === 'next' || text === '>' || text === '>>' || text === '›' || label.includes('next'))
        && el.offsetParent !== null;
    });
    if (next) { next.click(); return true; }
    return false;
  });

  if (clicked) {
    await delay(2000);
    return true;
  }
  return false;
}

/**
 * Map a DNav category string to a PIM category slug.
 */
function mapCategory(rawCategory) {
  if (!rawCategory) return null;
  const lower = rawCategory.toLowerCase().trim();
  for (const [key, slug] of Object.entries(CATEGORY_MAP)) {
    if (lower.includes(key)) return slug;
  }
  return null;
}

/**
 * Build a lookup map of category slug → category ID.
 */
async function buildCategoryLookup(pool) {
  const result = await pool.query('SELECT id, slug FROM categories');
  const lookup = {};
  for (const row of result.rows) {
    lookup[row.slug] = row.id;
  }
  return lookup;
}
