import { launchBrowser, delay, upsertPricing, appendLog, addJobError } from './base.js';
import { triwestLogin, triwestLoginFromCookies, PORTAL_BASE, screenshot } from './triwest-auth.js';

const MAX_ERRORS = 30;

/**
 * Tri-West DNav pricing scraper.
 *
 * Logs into the DNav dealer portal and extracts dealer cost prices per item.
 * Matches to existing SKUs by vendor_sku (item number).
 *
 * This scraper does NOT create products — it only upserts pricing for
 * products already imported by triwest-catalog.js.
 *
 * Template: bed-pricing.js (load data → match SKUs → upsert pricing)
 */
export async function run(pool, job, source) {
  const config = source.config || {};
  const delayMs = config.delay_ms || 1500;
  const vendor_id = source.vendor_id;

  let browser = null;
  let errorCount = 0;
  let totalFound = 0;
  let totalMatched = 0;
  let totalUnmatched = 0;
  let skusUpdated = 0;

  async function logError(msg) {
    errorCount++;
    if (errorCount <= MAX_ERRORS) {
      try { await addJobError(pool, job.id, msg); } catch { }
    }
  }

  try {
    // Load all Tri-West SKUs from DB upfront
    const skuResult = await pool.query(`
      SELECT s.id, s.vendor_sku, s.internal_sku
      FROM skus s
      JOIN products p ON p.id = s.product_id
      WHERE p.vendor_id = $1 AND s.vendor_sku IS NOT NULL
    `, [vendor_id]);

    // Build lookup map: vendor_sku → sku row
    const skuMap = new Map();
    for (const row of skuResult.rows) {
      skuMap.set(row.vendor_sku.toUpperCase(), row);
      const normalized = row.vendor_sku.replace(/[-\s.]/g, '').toUpperCase();
      if (!skuMap.has(normalized)) skuMap.set(normalized, row);
    }

    await appendLog(pool, job.id, `Loaded ${skuResult.rows.length} Tri-West SKUs from DB (${skuMap.size} lookup keys)`);

    if (skuMap.size === 0) {
      await appendLog(pool, job.id, 'No Tri-West SKUs in DB — run triwest-catalog first');
      return;
    }

    // Login
    let cookies;
    try {
      cookies = await triwestLogin(pool, job.id);
    } catch (err) {
      await appendLog(pool, job.id, `Puppeteer login failed: ${err.message} — trying cookie fallback...`);
      cookies = await triwestLoginFromCookies(pool, job.id);
    }

    // Launch browser
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1440, height: 900 });

    // Set cookies
    const cookiePairs = cookies.split('; ').map(pair => {
      const [name, ...rest] = pair.split('=');
      return { name, value: rest.join('='), domain: 'tri400.triwestltd.com' };
    });
    await page.setCookie(...cookiePairs);

    // Navigate to portal
    await page.goto(PORTAL_BASE, { waitUntil: 'networkidle2', timeout: 30000 });
    await delay(2000);

    if (page.url().includes('login') || page.url().includes('Login')) {
      throw new Error('Session cookies not accepted — redirected to login');
    }

    await appendLog(pool, job.id, 'Portal loaded, navigating to price list...');

    // Navigate to price list / price inquiry section
    // (Exact navigation will be refined after discovery mode reveals the portal structure)
    const priceEntries = await scrapePriceData(page, pool, job, delayMs);
    totalFound = priceEntries.length;

    await appendLog(pool, job.id, `Extracted ${totalFound} price entries from portal`);

    // Match and upsert pricing
    const unmatchedEntries = [];
    for (const entry of priceEntries) {
      if (!entry.itemNumber) continue;

      const skuKey = entry.itemNumber.toUpperCase();
      const normalizedKey = entry.itemNumber.replace(/[-\s.]/g, '').toUpperCase();
      const dbSku = skuMap.get(skuKey) || skuMap.get(normalizedKey);

      if (!dbSku) {
        totalUnmatched++;
        if (unmatchedEntries.length < 30) {
          unmatchedEntries.push(entry.itemNumber);
        }
        continue;
      }

      totalMatched++;

      try {
        const priceBasis = entry.unit === 'PCS' || entry.unit === 'EA' ? 'per_unit' : 'per_sqft';

        await upsertPricing(pool, dbSku.id, {
          cost: entry.dealerCost,
          retail_price: entry.listPrice || 0,
          price_basis: priceBasis,
        });

        skusUpdated++;
      } catch (err) {
        await logError(`Pricing upsert failed for ${entry.itemNumber}: ${err.message}`);
      }

      if (totalMatched % 100 === 0) {
        await appendLog(pool, job.id, `Progress: ${totalMatched} matched, ${skusUpdated} updated`, {
          products_found: totalFound,
          products_updated: skusUpdated
        });
      }
    }

    // Log unmatched entries
    if (unmatchedEntries.length > 0) {
      await appendLog(pool, job.id, `Unmatched price entries (first ${unmatchedEntries.length}):`);
      for (const u of unmatchedEntries) {
        await appendLog(pool, job.id, `  ${u}`);
      }
    }

    await appendLog(pool, job.id,
      `Complete. Entries: ${totalFound}, Matched: ${totalMatched}, Updated: ${skusUpdated}, Unmatched: ${totalUnmatched}, Errors: ${errorCount}`,
      { products_found: totalFound, products_updated: skusUpdated }
    );

  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

/**
 * Scrape price data from the DNav portal.
 * Returns array of { itemNumber, dealerCost, listPrice, unit }.
 *
 * This is a placeholder that will be refined after discovery mode.
 */
async function scrapePriceData(page, pool, job, delayMs) {
  const allEntries = [];

  // Try to find and navigate to price list section
  // DNav portals typically have a "Price Inquiry" or "Price List" link
  const priceLinks = await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a[href]'));
    return links
      .filter(a => {
        const text = a.textContent.toLowerCase();
        return text.includes('price') || text.includes('cost') || text.includes('pricelist');
      })
      .map(a => ({ text: a.textContent.trim(), href: a.href }));
  });

  if (priceLinks.length > 0) {
    await appendLog(pool, job.id, `Found price-related links: ${JSON.stringify(priceLinks.slice(0, 5))}`);
    // Navigate to first price link
    try {
      await page.goto(priceLinks[0].href, { waitUntil: 'networkidle2', timeout: 30000 });
      await delay(2000);
      await screenshot(page, 'triwest-pricelist');
    } catch (err) {
      await appendLog(pool, job.id, `Failed to navigate to price list: ${err.message}`);
    }
  }

  // Extract price data from tables
  const entries = await page.evaluate(() => {
    const results = [];
    const tables = document.querySelectorAll('table');

    for (const table of tables) {
      const rows = Array.from(table.querySelectorAll('tr'));
      for (let i = 1; i < rows.length; i++) {
        const cells = Array.from(rows[i].querySelectorAll('td'));
        if (cells.length < 2) continue;

        const text = rows[i].textContent;
        const itemMatch = text.match(/\b([A-Z]{2,5}[-.]?[A-Z0-9]{3,}[-.]?[A-Z0-9]*)\b/);
        const priceMatch = text.match(/\$?\s*([\d,]+\.?\d{0,2})/);

        if (itemMatch && priceMatch) {
          results.push({
            itemNumber: itemMatch[1],
            dealerCost: parseFloat(priceMatch[1].replace(/,/g, '')),
            listPrice: 0,
            unit: text.includes('/SF') || text.includes('S/F') ? 'SF' : 'PCS',
          });
        }
      }
    }

    return results;
  });

  allEntries.push(...entries);
  return allEntries;
}
