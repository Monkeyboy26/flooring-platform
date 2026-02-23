import { launchBrowser, delay, upsertInventorySnapshot, appendLog, addJobError } from './base.js';
import { triwestLogin, triwestLoginFromCookies, PORTAL_BASE, screenshot } from './triwest-auth.js';

const MAX_ERRORS = 30;

/**
 * Tri-West DNav inventory scraper.
 *
 * Lighter scraper that runs every 4-8 hours.
 * Loads existing Tri-West SKUs from DB, checks stock levels in DNav,
 * and upserts inventory_snapshots.
 *
 * Template: tradepro-inventory.js
 */
export async function run(pool, job, source) {
  const config = source.config || {};
  const discoveryMode = config.discovery_mode === true;
  const delayMs = config.delay_ms || 1500;
  const freshnessHours = config.freshness_hours || 8;
  const vendor_id = source.vendor_id;

  let browser = null;
  let errorCount = 0;
  let totalMatched = 0;
  let totalUnmatched = 0;
  let totalUpserted = 0;

  async function logError(msg) {
    errorCount++;
    if (errorCount <= MAX_ERRORS) {
      try { await addJobError(pool, job.id, msg); } catch { }
    }
  }

  try {
    // Load all Tri-West SKUs from DB upfront
    const skuResult = await pool.query(`
      SELECT s.id, s.vendor_sku, s.internal_sku, s.sell_by
      FROM skus s
      JOIN products p ON p.id = s.product_id
      WHERE p.vendor_id = $1 AND s.vendor_sku IS NOT NULL
    `, [vendor_id]);

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

    // Discovery mode
    if (discoveryMode) {
      await appendLog(pool, job.id, '=== INVENTORY DISCOVERY MODE ===');
      await screenshot(page, 'triwest-inventory-dashboard');
      await discoverInventoryPages(page, pool, job);
      await appendLog(pool, job.id, '=== DISCOVERY COMPLETE ===');
      return;
    }

    // Extract warehouse name from portal
    const warehouse = await extractWarehouse(page);
    await appendLog(pool, job.id, `Warehouse location: ${warehouse}`);

    // Scrape inventory data
    const inventoryItems = await scrapeInventoryData(page, pool, job, delayMs);
    await appendLog(pool, job.id, `Extracted ${inventoryItems.length} inventory entries`);

    // Match and upsert
    for (const item of inventoryItems) {
      if (!item.itemNumber) continue;

      const skuKey = item.itemNumber.toUpperCase();
      const normalizedKey = item.itemNumber.replace(/[-\s.]/g, '').toUpperCase();
      const dbSku = skuMap.get(skuKey) || skuMap.get(normalizedKey);

      if (!dbSku) {
        totalUnmatched++;
        if (totalUnmatched <= 20) {
          await appendLog(pool, job.id, `  Unmatched SKU: ${item.itemNumber}`);
        }
        continue;
      }

      totalMatched++;

      try {
        await upsertInventorySnapshot(pool, dbSku.id, warehouse, {
          qty_on_hand_sqft: item.qtySqft || 0,
          qty_in_transit_sqft: item.qtyTransitSqft || 0,
        });

        totalUpserted++;
      } catch (err) {
        await logError(`Inventory upsert failed for ${item.itemNumber}: ${err.message}`);
      }

      if (totalMatched % 100 === 0) {
        await appendLog(pool, job.id, `Progress: ${totalMatched} matched, ${totalUpserted} upserted`, {
          products_found: totalMatched,
          products_updated: totalUpserted
        });
      }
    }

    await appendLog(pool, job.id,
      `Complete. Items: ${inventoryItems.length}, Matched: ${totalMatched}, Upserted: ${totalUpserted}, Unmatched: ${totalUnmatched}, Errors: ${errorCount}`,
      { products_found: totalMatched, products_updated: totalUpserted }
    );

    if (totalUnmatched > 20) {
      await appendLog(pool, job.id, `(${totalUnmatched - 20} more unmatched SKUs not shown)`);
    }

  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

/**
 * Extract the warehouse/location from the DNav portal.
 */
async function extractWarehouse(page) {
  const location = await page.evaluate(() => {
    // Look for account/location info in header
    const headerText = (document.querySelector('header, [class*="header"]')?.textContent || '').trim();
    // DNav portals often show company/location in the header
    const locMatch = headerText.match(/(?:warehouse|location|ship to)[:\s]+(.+?)(?:\n|$)/i);
    if (locMatch) return locMatch[1].trim();

    // Look for "Santa Fe Springs" or other TW warehouse names
    const bodyText = document.body.innerText;
    const warehouseMatch = bodyText.match(/(?:Santa Fe Springs|Los Angeles|Anaheim)/i);
    if (warehouseMatch) return `TW ${warehouseMatch[0]}`;

    return null;
  });

  return location || 'TW Santa Fe Springs, CA';
}

/**
 * Discovery mode for inventory pages.
 */
async function discoverInventoryPages(page, pool, job) {
  const inventoryLinks = await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a[href]'));
    return links
      .filter(a => {
        const text = a.textContent.toLowerCase();
        return text.includes('inventory') || text.includes('stock') ||
               text.includes('available') || text.includes('warehouse');
      })
      .map(a => ({ text: a.textContent.trim(), href: a.href }));
  });

  await appendLog(pool, job.id, `Inventory-related links: ${JSON.stringify(inventoryLinks)}`);

  for (const link of inventoryLinks.slice(0, 5)) {
    try {
      await page.goto(link.href, { waitUntil: 'networkidle2', timeout: 15000 });
      await screenshot(page, `triwest-inventory-${link.text.replace(/\s+/g, '-').slice(0, 20)}`);
      const text = await page.evaluate(() => document.body.innerText.slice(0, 500));
      await appendLog(pool, job.id, `  [${link.text}] — ${text.slice(0, 200)}`);
    } catch (err) {
      await appendLog(pool, job.id, `  [${link.text}] — Error: ${err.message}`);
    }
    await delay(1000);
  }
}

/**
 * Scrape inventory data from the DNav portal.
 * Returns array of { itemNumber, qtySqft, qtyTransitSqft }.
 *
 * Placeholder — will be refined after discovery mode.
 */
async function scrapeInventoryData(page, pool, job, delayMs) {
  const allItems = [];

  // Try to find inventory / stock levels section
  const inventoryLinks = await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a[href]'));
    return links
      .filter(a => {
        const text = a.textContent.toLowerCase();
        return text.includes('inventory') || text.includes('stock');
      })
      .map(a => ({ text: a.textContent.trim(), href: a.href }));
  });

  if (inventoryLinks.length > 0) {
    try {
      await page.goto(inventoryLinks[0].href, { waitUntil: 'networkidle2', timeout: 30000 });
      await delay(2000);
    } catch (err) {
      await appendLog(pool, job.id, `Failed to navigate to inventory: ${err.message}`);
    }
  }

  // Extract inventory from tables
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
        const qtyMatch = text.match(/([\d,]+\.?\d*)\s*(?:SF|sqft|sq\s*ft|pcs|units)/i);

        if (itemMatch) {
          results.push({
            itemNumber: itemMatch[1],
            qtySqft: qtyMatch ? parseFloat(qtyMatch[1].replace(/,/g, '')) : 0,
            qtyTransitSqft: 0,
          });
        }
      }
    }

    return results;
  });

  allItems.push(...entries);
  return allItems;
}
