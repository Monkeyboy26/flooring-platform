import { launchBrowser, delay, upsertInventorySnapshot, appendLog, addJobError } from './base.js';
import { triwestLogin, triwestLoginFromCookies, PORTAL_BASE, screenshot } from './triwest-auth.js';
import {
  MANUFACTURER_NAMES,
  searchByManufacturer, getAllManufacturerCodes, navigateToSearchForm,
} from './triwest-search.js';

const MAX_ERRORS = 30;

/**
 * Tri-West DNav inventory scraper.
 *
 * Lighter scraper that runs every 4-8 hours.
 * Logs into the DNav portal, searches by manufacturer, extracts stock quantities
 * from the Quantity column, and upserts inventory_snapshots.
 *
 * Quantity format in DNav: "1,243 CT" (cartons), "500 SF" (sqft), "120 EA" (each)
 * For CT quantities, we convert to sqft using sqft_per_box from the packaging table.
 */
export async function run(pool, job, source) {
  const config = source.config || {};
  const delayMs = config.delay_ms || 2000;
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
    // Load all Tri-West SKUs from DB upfront, including packaging data for unit conversion
    const skuResult = await pool.query(`
      SELECT s.id, s.vendor_sku, s.internal_sku, s.sell_by,
             p2.sqft_per_box
      FROM skus s
      JOIN products p ON p.id = s.product_id
      LEFT JOIN packaging p2 ON p2.sku_id = s.id
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
      await appendLog(pool, job.id, 'No Tri-West SKUs in DB — run import-triwest-832 first');
      return;
    }

    // Login — returns authenticated browser + page
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

    // Extract warehouse name from portal
    const warehouse = await extractWarehouse(page);
    await appendLog(pool, job.id, `Warehouse location: ${warehouse}`);
    await appendLog(pool, job.id, 'Portal loaded, starting inventory extraction...');

    // Determine which manufacturers to scrape
    const configMfgrs = config.manufacturers;
    let mfgrCodes;

    if (configMfgrs && Array.isArray(configMfgrs) && configMfgrs.length > 0) {
      mfgrCodes = configMfgrs.map(c => ({ value: c.toUpperCase(), text: MANUFACTURER_NAMES[c.toUpperCase()] || c }));
    } else {
      mfgrCodes = await getAllManufacturerCodes(page);
    }

    await appendLog(pool, job.id, `Scanning ${mfgrCodes.length} manufacturers for inventory`);

    for (let m = 0; m < mfgrCodes.length; m++) {
      const mfgr = mfgrCodes[m];
      const mfgrCode = mfgr.value;
      const brandName = MANUFACTURER_NAMES[mfgrCode] || mfgr.text || mfgrCode;

      await appendLog(pool, job.id, `[${m + 1}/${mfgrCodes.length}] Inventory: ${brandName} (${mfgrCode})`);

      const rows = await searchByManufacturer(page, mfgrCode, pool, job.id);

      for (const row of rows) {
        if (!row.itemNumber) continue;

        const skuKey = row.itemNumber.toUpperCase();
        const normalizedKey = row.itemNumber.replace(/[-\s.]/g, '').toUpperCase();
        const dbSku = skuMap.get(skuKey) || skuMap.get(normalizedKey);

        if (!dbSku) {
          totalUnmatched++;
          if (totalUnmatched <= 20) {
            await appendLog(pool, job.id, `  Unmatched SKU: ${row.itemNumber}`);
          }
          continue;
        }

        totalMatched++;

        try {
          // Convert quantity to sqft based on unit type
          let qtySqft = 0;

          if (row.unit === 'SF') {
            // Already in sqft
            qtySqft = row.quantity;
          } else if (row.unit === 'CT' || row.unit === 'BOX') {
            // Cartons — convert using sqft_per_box
            const sqftPerBox = row.sqftPerBox || parseFloat(dbSku.sqft_per_box) || 0;
            if (sqftPerBox > 0) {
              qtySqft = Math.round(row.quantity * sqftPerBox);
            } else {
              // Can't convert without sqft_per_box — store carton count as-is
              qtySqft = row.quantity;
            }
          } else {
            // EA, PC, ST — store raw quantity
            qtySqft = row.quantity;
          }

          await upsertInventorySnapshot(pool, dbSku.id, warehouse, {
            qty_on_hand_sqft: qtySqft,
            qty_in_transit_sqft: 0, // Not available in search results
          });

          totalUpserted++;
        } catch (err) {
          await logError(`Inventory upsert failed for ${row.itemNumber}: ${err.message}`);
        }
      }

      if (totalMatched % 100 === 0 && totalMatched > 0) {
        await appendLog(pool, job.id, `Progress: ${totalMatched} matched, ${totalUpserted} upserted`, {
          products_found: totalMatched,
          products_updated: totalUpserted
        });
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

    await appendLog(pool, job.id,
      `Complete. Matched: ${totalMatched}, Upserted: ${totalUpserted}, Unmatched: ${totalUnmatched}, Errors: ${errorCount}`,
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
    const locMatch = headerText.match(/(?:warehouse|location|ship to)[:\s]+(.+?)(?:\n|$)/i);
    if (locMatch) return locMatch[1].trim();

    // Look for known TW warehouse names
    const bodyText = document.body.innerText;
    const warehouseMatch = bodyText.match(/(?:Santa Fe Springs|Los Angeles|Anaheim)/i);
    if (warehouseMatch) return `TW ${warehouseMatch[0]}`;

    return null;
  });

  return location || 'TW Santa Fe Springs, CA';
}
