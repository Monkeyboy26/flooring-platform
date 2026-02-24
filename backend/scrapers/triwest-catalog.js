import {
  launchBrowser, delay, upsertProduct, upsertSku,
  upsertSkuAttribute, upsertPackaging,
  appendLog, addJobError, normalizeSize, buildVariantName
} from './base.js';
import { triwestLogin, triwestLoginFromCookies, PORTAL_BASE, screenshot } from './triwest-auth.js';
import {
  MANUFACTURER_NAMES, MFGR_CATEGORY,
  searchByManufacturer, getAllManufacturerCodes, navigateToSearchForm,
} from './triwest-search.js';

const MAX_ERRORS = 50;

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
    // Step 1: Login — returns authenticated browser + page (same session)
    let cookies;
    let page;
    try {
      const session = await triwestLogin(pool, job.id);
      browser = session.browser;
      page = session.page;
      cookies = session.cookies;
    } catch (err) {
      await appendLog(pool, job.id, `Puppeteer login failed: ${err.message} — trying cookie fallback...`);
      cookies = await triwestLoginFromCookies(pool, job.id);
      // Cookie fallback: need to open a new browser
      browser = await launchBrowser();
      page = await browser.newPage();
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
      await page.setViewport({ width: 1440, height: 900 });
      const cookiePairs = cookies.split('; ').map(pair => {
        const [name, ...rest] = pair.split('=');
        return { name, value: rest.join('='), domain: 'tri400.triwestltd.com' };
      });
      await page.setCookie(...cookiePairs);
      await page.goto(`${PORTAL_BASE}/main/`, { waitUntil: 'networkidle2', timeout: 30000 });
      await delay(3000);
    }

    // We should already be on the dashboard from triwestLogin
    const currentUrl = page.url();
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

    // Determine which manufacturers to scrape
    const configMfgrs = config.manufacturers; // optional filter: ["PRO", "PAF", ...]
    let mfgrCodes;

    if (configMfgrs && Array.isArray(configMfgrs) && configMfgrs.length > 0) {
      mfgrCodes = configMfgrs.map(c => ({ value: c.toUpperCase(), text: MANUFACTURER_NAMES[c.toUpperCase()] || c }));
      await appendLog(pool, job.id, `Scraping ${mfgrCodes.length} specified manufacturers: ${configMfgrs.join(', ')}`);
    } else {
      mfgrCodes = await getAllManufacturerCodes(page);
      await appendLog(pool, job.id, `Found ${mfgrCodes.length} manufacturers in dropdown`);
    }

    // Iterate through manufacturers and search each one
    let totalItemsCollected = 0;

    for (let m = 0; m < mfgrCodes.length && totalItemsCollected < maxProducts; m++) {
      const mfgr = mfgrCodes[m];
      const mfgrCode = mfgr.value;
      const brandName = MANUFACTURER_NAMES[mfgrCode] || mfgr.text || mfgrCode;
      const categorySlug = MFGR_CATEGORY[mfgrCode] || null;
      const category_id = categorySlug ? (categoryLookup[categorySlug] || null) : null;

      await appendLog(pool, job.id, `[${m + 1}/${mfgrCodes.length}] Searching manufacturer: ${brandName} (${mfgrCode})`);

      // Search this manufacturer (cap per-manufacturer to prevent session timeout)
      const perMfgrCap = config.max_per_manufacturer || 3000;
      const rows = await searchByManufacturer(page, mfgrCode, pool, job.id, {
        maxRows: Math.min(perMfgrCap, maxProducts - totalItemsCollected),
      });

      if (rows.length === 0) {
        await appendLog(pool, job.id, `  ${brandName}: no results, skipping`);
      }

      // ── Two-pass upsert: flooring first, then accessories ──
      // Accessory SKUs (stair noses, T-moldings, quarter rounds, reducers, end caps)
      // share the parent's base SKU with a suffix (e.g., PRO2313 → PRO2313STN).
      // We need flooring products in the DB first so we can link accessories to them.

      const ACCESSORY_SUFFIXES = /^(.+\d)(STN|STNSQ|SQSTN|TM|QTR|QR|RDC|RD|SQN|FSN|OSN|EC|END|LW|LZ|PADFSN|PADRD|PADEC|PADOSN|PADQR|PADTM|PAD|OSCV|SQSTNI?|STNI)$/i;
      const ACCESSORY_NAME_RE = /\b(STAIR\s*NOSE|T[- ]?MOULD|QUARTER\s*ROUND|REDUCER|END\s*CAP|SQUARE\s*NOSE|OVERLAP|BULLNOSE|FLUSH|TRANSITION|RISER|THRESHOLD)\b/i;

      // Separate flooring rows from accessory rows
      const flooringRows = [];
      const accessoryRows = [];
      for (const row of rows) {
        const suffixMatch = row.itemNumber.match(ACCESSORY_SUFFIXES);
        const isAccessoryName = ACCESSORY_NAME_RE.test(row.productName || row.color || '');
        if (suffixMatch || isAccessoryName) {
          accessoryRows.push({ ...row, baseSku: suffixMatch ? suffixMatch[1] : null });
        } else {
          flooringRows.push(row);
        }
      }

      // Pass 1: Upsert flooring products and build a baseSku → product_id lookup
      const skuToProduct = new Map(); // vendorSku → { product_id, collection }

      for (let i = 0; i < flooringRows.length; i++) {
        const row = flooringRows[i];

        try {
          const collection = row.pattern
            ? `${brandName} - ${row.pattern}`
            : brandName;

          const productName = row.color || row.productName || row.itemNumber;

          const product = await upsertProduct(pool, {
            vendor_id,
            name: productName,
            collection,
            category_id,
            description_short: row.rawDescription || null,
          });

          if (product.is_new) productsCreated++;
          else productsUpdated++;

          const vendorSku = row.itemNumber;
          const internalSku = `TW-${vendorSku}`;
          const sellBy = row.unit === 'EA' || row.unit === 'PC' ? 'unit' : 'sqft';
          const variantName = buildVariantName(row.size);

          const sku = await upsertSku(pool, {
            product_id: product.id,
            vendor_sku: vendorSku,
            internal_sku: internalSku,
            variant_name: variantName,
            sell_by: sellBy,
          });

          if (sku.is_new) skusCreated++;

          if (row.sqftPerBox) {
            await upsertPackaging(pool, sku.id, { sqft_per_box: row.sqftPerBox });
          }

          if (row.size) await upsertSkuAttribute(pool, sku.id, 'size', normalizeSize(row.size));
          if (row.color) await upsertSkuAttribute(pool, sku.id, 'color', row.color);

          // Track for accessory linking
          skuToProduct.set(vendorSku, { product_id: product.id, collection });

        } catch (err) {
          await logError(`Product ${row.itemNumber}: ${err.message}`);
        }

        totalItemsCollected++;

        if (totalItemsCollected % 50 === 0) {
          await appendLog(pool, job.id,
            `Progress: ${totalItemsCollected} items — created: ${productsCreated}, updated: ${productsUpdated}, SKUs: ${skusCreated}`,
            { products_found: totalItemsCollected, products_created: productsCreated, products_updated: productsUpdated, skus_created: skusCreated }
          );
        }
      }

      // Pass 2: Upsert accessory SKUs linked to their parent product
      let accessoriesLinked = 0;

      for (const row of accessoryRows) {
        try {
          const vendorSku = row.itemNumber;
          const internalSku = `TW-${vendorSku}`;

          // Find parent product by base SKU
          let parentInfo = row.baseSku ? skuToProduct.get(row.baseSku) : null;

          // If parent not in this batch, try DB lookup
          if (!parentInfo && row.baseSku) {
            const dbResult = await pool.query(`
              SELECT s.product_id FROM skus s
              WHERE s.vendor_sku = $1 AND s.internal_sku = $2
            `, [row.baseSku, `TW-${row.baseSku}`]);
            if (dbResult.rows.length > 0) {
              parentInfo = { product_id: dbResult.rows[0].product_id };
            }
          }

          if (parentInfo) {
            // Link as accessory SKU under parent product
            const accessoryName = (row.productName || row.color || vendorSku).replace(/\s+/g, ' ').trim();
            const sku = await upsertSku(pool, {
              product_id: parentInfo.product_id,
              vendor_sku: vendorSku,
              internal_sku: internalSku,
              variant_name: accessoryName,
              sell_by: 'unit',
              variant_type: 'accessory',
            });
            if (sku.is_new) skusCreated++;
            accessoriesLinked++;
          } else {
            // No parent found — create as standalone product (fallback)
            const collection = row.pattern
              ? `${brandName} - ${row.pattern}`
              : brandName;
            const productName = row.color || row.productName || vendorSku;

            const product = await upsertProduct(pool, {
              vendor_id,
              name: productName,
              collection,
              category_id,
              description_short: row.rawDescription || null,
            });

            if (product.is_new) productsCreated++;
            else productsUpdated++;

            const sellBy = row.unit === 'EA' || row.unit === 'PC' ? 'unit' : 'sqft';
            const sku = await upsertSku(pool, {
              product_id: product.id,
              vendor_sku: vendorSku,
              internal_sku: internalSku,
              variant_name: row.productName || row.color || null,
              sell_by: sellBy,
              variant_type: 'accessory',
            });
            if (sku.is_new) skusCreated++;
          }
        } catch (err) {
          await logError(`Accessory ${row.itemNumber}: ${err.message}`);
        }

        totalItemsCollected++;

        if (totalItemsCollected % 50 === 0) {
          await appendLog(pool, job.id,
            `Progress: ${totalItemsCollected} items — created: ${productsCreated}, updated: ${productsUpdated}, SKUs: ${skusCreated}, Accessories linked: ${accessoriesLinked}`,
            { products_found: totalItemsCollected, products_created: productsCreated, products_updated: productsUpdated, skus_created: skusCreated }
          );
        }
      }

      if (accessoryRows.length > 0) {
        await appendLog(pool, job.id,
          `  ${brandName}: ${accessoriesLinked}/${accessoryRows.length} accessories linked to parent products`);
      }

      // Navigate back to search form for next manufacturer
      if (m < mfgrCodes.length - 1) {
        const navResult = await navigateToSearchForm(page, PORTAL_BASE);
        if (navResult === 'relogin' || !navResult) {
          // Session expired or nav failed — re-login either way
          await appendLog(pool, job.id, `Session expired after ${brandName}, re-logging in...`);
          await browser.close().catch(() => {});
          try {
            const session = await triwestLogin(pool, job.id);
            browser = session.browser;
            page = session.page;
          } catch (err) {
            await appendLog(pool, job.id, `Re-login failed: ${err.message}`);
            break;
          }
        }
        await delay(delayMs);
      }
    }

    productsFound = totalItemsCollected;

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

  // Screenshot the dashboard (we're already on it after login)
  await screenshot(page, 'triwest-dashboard');
  await appendLog(pool, job.id, `Dashboard URL: ${page.url()}`);

  // ─── TEST SEARCH: Do this FIRST while dashboard is in clean state ───
  await appendLog(pool, job.id, '=== TEST SEARCH (Provenza) ===');

  // Get manufacturer dropdown options
  const mfgrOptions = await page.evaluate(() => {
    const select = document.querySelector('select[name="d24_filter_mfgr"]');
    if (!select) return null;
    return Array.from(select.options).map(o => ({ value: o.value, text: o.text.trim() }));
  });

  if (!mfgrOptions) {
    await appendLog(pool, job.id, 'ERROR: Manufacturer dropdown not found on dashboard');
    await appendLog(pool, job.id, `Page text: ${await page.evaluate(() => document.body.innerText.slice(0, 500))}`);
    return;
  }

  await appendLog(pool, job.id, `Manufacturer dropdown has ${mfgrOptions.length} options:`);
  for (const opt of mfgrOptions) {
    await appendLog(pool, job.id, `  "${opt.text}" (value: "${opt.value}")`);
  }

  // Select "PROVENZA FLOORS INC."
  const provenza = mfgrOptions.find(o => o.text.includes('PROVENZA'));
  const testMfgr = provenza || mfgrOptions.find(o => o.value && o.value !== '');

  if (!testMfgr) {
    await appendLog(pool, job.id, 'No valid manufacturer to test');
    return;
  }

  await appendLog(pool, job.id, `Selecting manufacturer: "${testMfgr.text}" (value: "${testMfgr.value}")`);
  await page.select('select[name="d24_filter_mfgr"]', testMfgr.value);
  await delay(500);

  // Intercept network responses BEFORE clicking search
  const apiCalls = [];
  page.on('response', async (response) => {
    const url = response.url();
    if (url.includes('danciko') && !url.includes('.css') && !url.includes('.js') && !url.includes('.png') && !url.includes('.jpg') && !url.includes('.gif')) {
      try {
        const contentType = response.headers()['content-type'] || '';
        apiCalls.push({ url, status: response.status(), type: contentType });
      } catch { }
    }
  });

  // Submit the Advanced Item Search form
  const searchBtnClicked = await page.evaluate(() => {
    const forms = document.querySelectorAll('form');
    for (const form of forms) {
      if (form.action && form.action.includes('item_search_advanced')) {
        const btn = form.querySelector('input[type="submit"]');
        if (btn) { btn.click(); return true; }
      }
    }
    const btn = document.querySelector('input[type="submit"][value="Search"]');
    if (btn) { btn.click(); return true; }
    return false;
  });

  if (!searchBtnClicked) {
    await appendLog(pool, job.id, 'Could not find Search button');
    return;
  }

  await appendLog(pool, job.id, 'Search submitted, waiting for results...');
  await delay(8000);
  await screenshot(page, 'triwest-search-results');

  // Log intercepted API calls
  if (apiCalls.length > 0) {
    await appendLog(pool, job.id, `Intercepted ${apiCalls.length} API calls during search:`);
    for (const call of apiCalls) {
      await appendLog(pool, job.id, `  ${call.status} ${call.url} (${call.type})`);
    }
  }

  // Capture full page text
  const resultsText = await page.evaluate(() => document.body.innerText.slice(0, 5000));
  await appendLog(pool, job.id, `Search results text:\n${resultsText}`);

  // Analyze ALL tables on the page
  const tableInfo = await page.evaluate(() => {
    const tables = document.querySelectorAll('table');
    const results = [];
    for (let t = 0; t < tables.length; t++) {
      const table = tables[t];
      const headers = Array.from(table.querySelectorAll('th')).map(th => th.textContent.trim());
      const rows = Array.from(table.querySelectorAll('tr'));
      const sampleRows = [];
      for (let i = 0; i < Math.min(rows.length, 10); i++) {
        const cells = Array.from(rows[i].querySelectorAll('td, th'));
        sampleRows.push(cells.map(c => c.textContent.trim().slice(0, 100)));
      }
      if (headers.length > 0 || sampleRows.some(r => r.length > 2)) {
        results.push({
          index: t,
          id: table.id || '',
          class: (table.className || '').slice(0, 100),
          headers,
          rowCount: rows.length,
          sampleRows
        });
      }
    }
    return results;
  });

  if (tableInfo.length > 0) {
    await appendLog(pool, job.id, `Found ${tableInfo.length} data tables:`);
    for (const ti of tableInfo) {
      await appendLog(pool, job.id, `  Table #${ti.index} (id="${ti.id}" class="${ti.class}"): ${ti.rowCount} rows`);
      await appendLog(pool, job.id, `    Headers: [${ti.headers.join(' | ')}]`);
      for (const row of ti.sampleRows) {
        await appendLog(pool, job.id, `    [${row.join(' | ')}]`);
      }
    }
  } else {
    await appendLog(pool, job.id, 'No data tables found in search results');
  }

  // Look for result items in any format (divs, cards, lists)
  const resultContainers = await page.evaluate(() => {
    const items = [];
    const selectors = [
      '[class*="result"]', '[class*="item-"]', '[class*="product"]',
      '[class*="search"]', '[class*="d24"]', '[class*="listing"]',
    ];
    for (const sel of selectors) {
      for (const el of document.querySelectorAll(sel)) {
        const text = el.innerText?.trim().slice(0, 300) || '';
        if (text.length > 20 && text.length < 300) {
          items.push({
            tag: el.tagName,
            class: (el.className?.toString() || '').slice(0, 150),
            id: el.id || '',
            text,
          });
        }
      }
    }
    return items.slice(0, 15);
  });

  if (resultContainers.length > 0) {
    await appendLog(pool, job.id, `Found ${resultContainers.length} result containers:`);
    for (const item of resultContainers) {
      await appendLog(pool, job.id, `  <${item.tag}#${item.id} class="${item.class}">\n    "${item.text}"`);
    }
  }

  // Look for clickable items (links, rows with onclick)
  const clickableItems = await page.evaluate(() => {
    const items = [];
    // Links in the main content area
    const allLinks = document.querySelectorAll('a');
    for (const a of allLinks) {
      const href = a.href || '';
      const text = a.textContent.trim().slice(0, 80);
      if (href.includes('#item') || href.includes('#detail') || href.includes('#product') || text.match(/^[A-Z0-9]{3,}/)) {
        items.push({ tag: 'A', href, text, onclick: '' });
      }
    }
    // Clickable table rows
    const rows = document.querySelectorAll('tr[onclick], tr[style*="cursor"], td[onclick]');
    for (const r of rows) {
      items.push({
        tag: r.tagName,
        href: '',
        text: r.textContent.trim().slice(0, 100),
        onclick: (r.getAttribute('onclick') || '').slice(0, 150),
      });
    }
    return items.slice(0, 10);
  });

  if (clickableItems.length > 0) {
    await appendLog(pool, job.id, `Clickable items in results:`);
    for (const ci of clickableItems) {
      await appendLog(pool, job.id, `  <${ci.tag}> text="${ci.text}" href="${ci.href}" onclick="${ci.onclick}"`);
    }

    // Click the first item to see detail page
    const first = clickableItems[0];
    try {
      if (first.tag === 'A' && first.href) {
        await page.evaluate((href) => {
          const link = Array.from(document.querySelectorAll('a')).find(a => a.href === href);
          if (link) link.click();
        }, first.href);
      } else if (first.onclick) {
        await page.evaluate((onclick) => {
          const el = document.querySelector(`[onclick="${onclick}"]`);
          if (el) el.click();
        }, first.onclick);
      }

      await delay(5000);
      await screenshot(page, 'triwest-item-detail');

      const detailText = await page.evaluate(() => document.body.innerText.slice(0, 4000));
      await appendLog(pool, job.id, `Item detail page:\n${detailText.slice(0, 3000)}`);

      // Log forms on detail page
      const detailForms = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('form')).map(f => ({
          action: f.action, id: f.id,
          inputs: Array.from(f.querySelectorAll('input, select')).map(i => ({
            type: i.type, name: i.name, id: i.id, placeholder: i.placeholder, value: (i.value || '').slice(0, 50)
          }))
        }));
      });
      await appendLog(pool, job.id, `Detail forms: ${JSON.stringify(detailForms, null, 2)}`);
    } catch (err) {
      await appendLog(pool, job.id, `Item detail click failed: ${err.message}`);
    }
  } else {
    await appendLog(pool, job.id, 'No clickable items found in search results');
  }

  // Also try the keyword search bar as a secondary test
  await appendLog(pool, job.id, '=== KEYWORD SEARCH TEST ===');
  try {
    // Go back to dashboard via #home
    await page.evaluate(() => {
      const link = document.querySelector('a[href*="#home"]');
      if (link) link.click();
    });
    await delay(3000);

    const searchInput = await page.$('#d24_keywordsearch');
    if (searchInput) {
      await searchInput.click({ clickCount: 3 });
      await searchInput.type('Provenza Moda', { delay: 50 });
      await page.keyboard.press('Enter');
      await delay(5000);
      await screenshot(page, 'triwest-keyword-search');

      const kwText = await page.evaluate(() => document.body.innerText.slice(0, 3000));
      await appendLog(pool, job.id, `Keyword search results:\n${kwText.slice(0, 2000)}`);
    }
  } catch (err) {
    await appendLog(pool, job.id, `Keyword search failed: ${err.message}`);
  }

  await appendLog(pool, job.id, 'Discovery complete — review screenshots in uploads folder');
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
