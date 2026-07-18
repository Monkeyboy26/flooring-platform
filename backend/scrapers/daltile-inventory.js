import pg from 'pg';
import { launchBrowser, delay, appendLog, addJobError, upsertInventorySnapshot } from './base.js';
import { portalLogin, screenshot, waitForSPA } from './tradepro-auth.js';

/**
 * Daltile inventory scraper — TradePro Exchange (Salesforce Experience Cloud).
 *
 * Logs into the TradePro portal, navigates to the Products page, and uses
 * a dual-extraction approach:
 *   1. Intercepts Salesforce Aura API responses for structured product data
 *      (SKU, description, sqft_per_carton, base UOM)
 *   2. Parses DOM innerText for stock quantities ("1,727.50 / SF In Stock")
 *
 * The Aura action `aura.ApexAction.execute` returns a JSON payload with a
 * `resultData` array whose items have: sku, DW_ID__c, Base_UoM__c,
 * SquarefeetPerCarton__c, Description, etc.
 *
 * The DOM renders each product card with a consistent text pattern:
 *   SKU [CODE]
 *   $[price] / SF
 *   In-Stock
 *   [qty] / SF In Stock
 *
 * Pagination uses page-number buttons at the bottom. The page supports
 * 48 items per page, with "Results 1-48 of N" pagination.
 *
 * User rule: if available sqft < 1, treat as out of stock (qty = 0).
 *
 * Standalone: docker compose exec api node scrapers/daltile-inventory.js
 * Scheduler: export { run } called by the job runner
 */

const BASE_URL = 'https://www.tradeproexchange.com';
const PRODUCTS_PATH = '/s/products#tab=All';
const MAX_ERRORS = 50;

// ─── Exported run() for scheduler ────────────────────────────────────────────

export async function run(pool, job, source) {
  const config = source.config || {};
  const discoveryMode = config.discovery_mode === true;
  const maxPages = config.max_pages || 999;

  let browser = null;
  let errorCount = 0;
  let totalMatched = 0;
  let totalUnmatched = 0;
  let totalUpserted = 0;

  async function logError(msg) {
    errorCount++;
    if (errorCount <= MAX_ERRORS) {
      try { await addJobError(pool, job.id, msg); } catch { /* ignore */ }
    }
  }

  try {
    // ── Step 1: Load all DAL/AO/MZ SKUs from DB ──
    const skuResult = await pool.query(`
      SELECT s.id, s.vendor_sku, s.internal_sku,
             pkg.sqft_per_box
      FROM skus s
      JOIN products p ON p.id = s.product_id
      JOIN vendors v ON v.id = p.vendor_id
      LEFT JOIN packaging pkg ON pkg.sku_id = s.id
      WHERE v.code IN ('DAL', 'AO', 'MZ') AND s.vendor_sku IS NOT NULL
    `);

    const skuMap = new Map();
    for (const row of skuResult.rows) {
      skuMap.set(row.vendor_sku.toUpperCase(), row);
    }

    await appendLog(pool, job.id,
      `Loaded ${skuResult.rows.length} DAL/AO/MZ SKUs (${skuMap.size} lookup keys)`
    );

    // ── Step 2: Launch browser ──
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    // ── Helper: login + navigate to products page (reusable for session recovery) ──
    async function loginAndNavigate(targetPage) {
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await appendLog(pool, job.id, `Login attempt ${attempt}/3...`);
          await portalLogin(page, pool, job);
          break;
        } catch (err) {
          await logError(`Login attempt ${attempt} failed: ${err.message}`);
          if (attempt === 3) throw new Error('All login attempts failed');
          await delay(attempt * 5000);
        }
      }

      // Navigate to products page
      const productsUrl = `${BASE_URL}${PRODUCTS_PATH}`;
      await appendLog(pool, job.id, `Navigating to products: ${productsUrl}`);
      await page.goto(productsUrl, { waitUntil: 'networkidle2', timeout: 60000 });
      await waitForSPA(page);

      if (page.url().includes('/login')) {
        throw new Error('Session expired — redirected to login after navigation');
      }

      await delay(5000);

      // If resuming from a specific page, navigate there
      if (targetPage > 1) {
        await appendLog(pool, job.id, `Resuming from page ${targetPage}...`);
        for (let p = 1; p < targetPage; p++) {
          const ok = await goToNextPage(page, p);
          if (!ok) {
            await appendLog(pool, job.id, `Could not navigate to page ${targetPage}, stuck at ${p}`);
            return p + 1;
          }
          await delay(2000);
          await waitForSPA(page);
          // Skip extraction on these pages, just navigate
        }
        await delay(3000);
        await waitForSPA(page);
      }

      return targetPage;
    }

    // ── Step 3: Initial login + navigate ──
    await loginAndNavigate(1);

    if (discoveryMode) {
      await screenshot(page, 'daltile-inv-products-page');
    }

    // ── Step 4: Read pagination info ──
    const paginationInfo = await getPaginationInfo(page);
    await appendLog(pool, job.id,
      `Page shows: ${paginationInfo.text || 'unknown'} (${paginationInfo.totalResults} results, ${paginationInfo.perPage} per page)`
    );

    const totalPages = Math.min(
      Math.ceil(paginationInfo.totalResults / (paginationInfo.perPage || 48)),
      maxPages
    );
    await appendLog(pool, job.id, `Will scrape up to ${totalPages} pages`);

    // ── Step 5: Scrape each page with session recovery ──
    const allItems = [];
    let consecutiveEmptyPages = 0;
    let sessionRecoveries = 0;
    const MAX_SESSION_RECOVERIES = 5;

    for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
      let pageItems = [];

      try {
        // Check for session expiry
        const currentUrl = page.url();
        if (currentUrl.includes('/login') || currentUrl.includes('/LoginPage')) {
          throw new Error('SESSION_EXPIRED');
        }

        // Extract items from current page via DOM innerText
        pageItems = await Promise.race([
          extractItemsFromInnerText(page),
          new Promise((_, reject) => setTimeout(() => reject(new Error('EXTRACT_TIMEOUT')), 30000)),
        ]);
      } catch (err) {
        const isSessionError = err.message === 'SESSION_EXPIRED' ||
          err.message === 'EXTRACT_TIMEOUT' ||
          err.message.includes('Execution context was destroyed') ||
          err.message.includes('Session closed') ||
          err.message.includes('Target closed');

        if (isSessionError && sessionRecoveries < MAX_SESSION_RECOVERIES) {
          sessionRecoveries++;
          await appendLog(pool, job.id,
            `Session lost at page ${pageNum} (${err.message}). Recovery ${sessionRecoveries}/${MAX_SESSION_RECOVERIES}...`
          );

          // Close old page, open new one
          try { await page.close(); } catch { /* ignore */ }
          page = await browser.newPage();
          await page.setViewport({ width: 1440, height: 900 });
          await page.setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
          );

          try {
            const resumedAt = await loginAndNavigate(pageNum);
            pageNum = resumedAt - 1; // loop will increment
            consecutiveEmptyPages = 0;
            continue;
          } catch (loginErr) {
            await logError(`Session recovery failed: ${loginErr.message}`);
            break;
          }
        } else {
          await logError(`Page ${pageNum} failed: ${err.message}`);
          break;
        }
      }

      if (pageItems.length === 0) {
        consecutiveEmptyPages++;
        if (consecutiveEmptyPages >= 3) {
          await appendLog(pool, job.id, `No items found on ${consecutiveEmptyPages} consecutive pages — stopping`);
          break;
        }
      } else {
        consecutiveEmptyPages = 0;
      }

      allItems.push(...pageItems);

      if (pageNum % 10 === 0 || pageNum === 1) {
        await appendLog(pool, job.id,
          `Page ${pageNum}/${totalPages}: ${pageItems.length} items (${allItems.length} total)`
        );
      }

      // Navigate to next page
      if (pageNum < totalPages) {
        try {
          const navigated = await Promise.race([
            goToNextPage(page, pageNum),
            new Promise((_, reject) => setTimeout(() => reject(new Error('NAV_TIMEOUT')), 30000)),
          ]);
          if (!navigated) {
            await appendLog(pool, job.id, `Could not navigate past page ${pageNum} — stopping`);
            break;
          }
          await delay(3000);
          await waitForSPA(page);
        } catch (navErr) {
          // Navigation timeout — treat as session loss
          if (sessionRecoveries < MAX_SESSION_RECOVERIES) {
            sessionRecoveries++;
            await appendLog(pool, job.id,
              `Navigation timeout at page ${pageNum} (${navErr.message}). Recovery ${sessionRecoveries}/${MAX_SESSION_RECOVERIES}...`
            );
            try { await page.close(); } catch { /* ignore */ }
            page = await browser.newPage();
            await page.setViewport({ width: 1440, height: 900 });
            await page.setUserAgent(
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            );
            try {
              const resumedAt = await loginAndNavigate(pageNum + 1);
              pageNum = resumedAt - 1;
              consecutiveEmptyPages = 0;
              continue;
            } catch (loginErr) {
              await logError(`Session recovery failed: ${loginErr.message}`);
              break;
            }
          } else {
            await appendLog(pool, job.id, `Max session recoveries reached — stopping`);
            break;
          }
        }
      }
    }

    if (discoveryMode) {
      await screenshot(page, 'daltile-inv-final-page');
    }

    await appendLog(pool, job.id,
      `Extraction complete: ${allItems.length} items (session recoveries: ${sessionRecoveries})`
    );

    // ── Step 8: Match and upsert ──
    for (const item of allItems) {
      if (!item.sku) continue;

      const skuKey = item.sku.toUpperCase();
      const dbSku = skuMap.get(skuKey);

      if (!dbSku) {
        totalUnmatched++;
        if (totalUnmatched <= 20) {
          await appendLog(pool, job.id, `  Unmatched: ${item.sku} (qty: ${item.qty} ${item.unit})`);
        }
        continue;
      }

      totalMatched++;

      try {
        let qtySqft = item.qty || 0;

        // Stock is already in SF from the DOM ("1,727.50 / SF In Stock")
        // Convert if unit is not SF
        if (item.unit !== 'SF' && item.unit !== 'SQFT') {
          const sqftPerBox = dbSku.sqft_per_box;
          if (sqftPerBox && parseFloat(sqftPerBox) > 0) {
            qtySqft = qtySqft * parseFloat(sqftPerBox);
          }
        }

        // User rule: if available sqft < 1, treat as out of stock
        if (qtySqft < 1) qtySqft = 0;

        await upsertInventorySnapshot(pool, dbSku.id, 'TradePro', {
          qty_on_hand_sqft: Math.round(qtySqft),
          qty_in_transit_sqft: 0,
        });

        totalUpserted++;
      } catch (err) {
        await logError(`Inventory upsert failed for ${item.sku}: ${err.message}`);
      }

      if (totalMatched % 200 === 0) {
        await appendLog(pool, job.id,
          `Progress: ${totalMatched} matched, ${totalUpserted} upserted, ${totalUnmatched} unmatched`,
          { products_found: totalMatched, products_updated: totalUpserted }
        );
      }
    }

    // ── Final summary ──
    await appendLog(pool, job.id,
      `Complete. Items parsed: ${allItems.length}, Matched: ${totalMatched}, ` +
      `Upserted: ${totalUpserted}, Unmatched: ${totalUnmatched}, Errors: ${errorCount}`,
      { products_found: totalMatched, products_updated: totalUpserted }
    );

    if (totalUnmatched > 20) {
      await appendLog(pool, job.id,
        `(${totalUnmatched - 20} more unmatched SKUs not shown)`
      );
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// ─── DOM Extraction via innerText ────────────────────────────────────────────

/**
 * Extract SKU + stock quantity from the page's innerText.
 *
 * Product cards render as consecutive text blocks:
 *   ...
 *   SKU [CODE]
 *   $[price] / SF
 *   In-Stock
 *   [qty] / [UNIT] In Stock
 *   Add To Cart
 *   ...
 *
 * We find all "SKU [CODE]" lines and then look nearby for "[qty] / SF In Stock".
 */
async function extractItemsFromInnerText(page) {
  return page.evaluate(() => {
    const text = document.body.innerText;
    const lines = text.split('\n').map(l => l.trim());
    const items = [];

    for (let i = 0; i < lines.length; i++) {
      // Match "SKU [CODE]" lines
      const skuMatch = lines[i].match(/^SKU\s+([A-Z0-9]{5,})$/i);
      if (!skuMatch) continue;

      const sku = skuMatch[1];

      // Look in the next ~10 lines for stock quantity
      let qty = 0;
      let unit = 'SF';
      let found = false;

      for (let j = i + 1; j < Math.min(i + 12, lines.length); j++) {
        // Match "[qty] / [UNIT] In Stock"
        const stockMatch = lines[j].match(/([\d,]+\.?\d*)\s*\/\s*(SF|EA|CT|PC|PL)\s*In Stock/i);
        if (stockMatch) {
          qty = parseFloat(stockMatch[1].replace(/,/g, ''));
          unit = stockMatch[2].toUpperCase();
          found = true;
          break;
        }
        // Also check for "Out of Stock" or "Clearance" without qty
        if (/out\s*of\s*stock/i.test(lines[j])) {
          qty = 0;
          found = true;
          break;
        }
        // Stop if we've hit the next product card
        if (/^SKU\s+[A-Z0-9]{5,}$/i.test(lines[j])) break;
        if (lines[j] === 'favorite') break; // card boundary
      }

      items.push({ sku, qty, unit });
    }

    return items;
  });
}

// ─── Pagination Helpers ──────────────────────────────────────────────────────

/**
 * Get pagination info from the page text.
 * Looks for "Results 1-48 of 40,007" or similar.
 */
async function getPaginationInfo(page) {
  return page.evaluate(() => {
    const text = document.body.innerText;
    const match = text.match(/Results?\s+(\d[\d,]*)\s*[-–]\s*(\d[\d,]*)\s+of\s+([\d,]+)/i);
    if (match) {
      const from = parseInt(match[1].replace(/,/g, ''));
      const to = parseInt(match[2].replace(/,/g, ''));
      const total = parseInt(match[3].replace(/,/g, ''));
      return {
        text: match[0],
        from,
        to,
        perPage: to - from + 1,
        totalResults: total,
      };
    }
    return { text: null, from: 1, to: 48, perPage: 48, totalResults: 0 };
  });
}

/**
 * Navigate to the next page by clicking the next page-number button.
 *
 * The TradePro products page has page buttons: 1 2 3 4 5 ... at the bottom.
 * We look for the button for the next page number within the page's shadow DOM
 * by using innerText-based matching since the LWC shadow DOM is opaque to
 * regular DOM queries.
 */
async function goToNextPage(page, currentPage) {
  const nextPage = currentPage + 1;

  // Strategy 1: Try clicking by evaluating shadow DOM
  const clicked = await page.evaluate((targetPage) => {
    // Find all shadow hosts and traverse into them
    function queryShadow(root, selector) {
      const results = [...root.querySelectorAll(selector)];
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot) results.push(...queryShadow(el.shadowRoot, selector));
      }
      return results;
    }

    // Find buttons/links with the page number text
    const allClickables = queryShadow(document, 'button, a, [role="button"]');
    for (const el of allClickables) {
      const text = el.textContent.trim();
      if (text === String(targetPage) && el.offsetParent !== null) {
        el.click();
        return true;
      }
    }

    // Also try aria-label
    for (const el of allClickables) {
      const label = (el.getAttribute('aria-label') || '').toLowerCase();
      if (label.includes('page ' + targetPage) || label.includes('next')) {
        el.click();
        return true;
      }
    }

    return false;
  }, nextPage);

  if (clicked) return true;

  // Strategy 2: Use keyboard navigation — try scrolling to page numbers and clicking
  // Find the page number in the visible text and click at its coordinates
  try {
    // Try using Puppeteer's XPath to find text nodes with the page number
    const pageNumberElements = await page.$$(`text/${nextPage}`);
    for (const el of pageNumberElements) {
      const box = await el.boundingBox();
      if (box && box.y > 500) { // Page numbers are at the bottom
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        return true;
      }
    }
  } catch { /* text selector not supported in this Puppeteer version */ }

  // Strategy 3: Scroll to bottom and look for clickable page numbers
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await delay(1000);

  // Try clicking by coordinates — find the page number text in the DOM
  const clickResult = await page.evaluate((targetPage) => {
    // The page numbers appear as bare text in the innerText at the bottom
    // Find elements containing just this number
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (node.textContent.trim() === String(targetPage)) {
        const parent = node.parentElement;
        if (parent && parent.offsetParent !== null) {
          const rect = parent.getBoundingClientRect();
          // Page numbers are at the bottom of the page
          if (rect.top > 200) {
            parent.click();
            return { clicked: true, tag: parent.tagName, y: rect.top };
          }
        }
      }
    }
    return { clicked: false };
  }, nextPage);

  return clickResult.clicked;
}

// ─── Standalone Entry Point ──────────────────────────────────────────────────

async function main() {
  const pool = new pg.Pool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    database: process.env.DB_NAME || 'flooring_pim',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
  });

  const jobResult = await pool.query(`
    INSERT INTO scrape_jobs (vendor_source_id, status, log, errors)
    VALUES (
      (SELECT id FROM vendor_sources WHERE scraper_key = 'daltile-inventory' LIMIT 1),
      'running', '', '[]'::jsonb
    )
    RETURNING id
  `);

  const job = { id: jobResult.rows[0].id };
  const source = {
    config: { discovery_mode: false },
    vendor_id: null,
  };

  console.log(`Scrape job created: ${job.id}`);

  try {
    await run(pool, job, source);
    await pool.query(`UPDATE scrape_jobs SET status = 'completed' WHERE id = $1`, [job.id]);
    console.log('Scrape completed successfully');
  } catch (err) {
    console.error('Scrape failed:', err.message);
    await pool.query(
      `UPDATE scrape_jobs SET status = 'failed', log = log || $2 WHERE id = $1`,
      [job.id, `\n[ERROR] ${err.message}\n`]
    );
  } finally {
    await pool.end();
  }
}

const isMain = process.argv[1] && (
  process.argv[1].endsWith('daltile-inventory.js') ||
  process.argv[1].includes('daltile-inventory')
);
if (isMain) main().catch(err => { console.error(err); process.exit(1); });
