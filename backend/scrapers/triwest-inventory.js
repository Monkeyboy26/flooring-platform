import fs from 'fs';
import { launchBrowser, delay, upsertInventorySnapshot, appendLog, addJobError } from './base.js';
import { triwestLogin, triwestLoginFromCookies, PORTAL_BASE, screenshot } from './triwest-auth.js';
import {
  MANUFACTURER_NAMES,
  searchByManufacturer, getAllManufacturerCodes, navigateToSearchForm,
} from './triwest-search.js';

const MAX_ERRORS = 30;
const PER_MANUFACTURER_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes per manufacturer
const MAX_CONSECUTIVE_EMPTY = 5; // abort if 5+ manufacturers in a row return 0 results
const MAX_ATTEMPTS_PER_MANUFACTURER = 2; // retry once if the session expires mid-search

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

    let consecutiveEmpty = 0;
    const dumpRows = []; // raw portal rows for offline match analysis

    for (let m = 0; m < mfgrCodes.length; m++) {
      const mfgr = mfgrCodes[m];
      const mfgrCode = mfgr.value;
      const brandName = MANUFACTURER_NAMES[mfgrCode] || mfgr.text || mfgrCode;

      await appendLog(pool, job.id, `[${m + 1}/${mfgrCodes.length}] Inventory: ${brandName} (${mfgrCode})`);

      // Per-manufacturer timeout to prevent hanging on unresponsive pages.
      // If the DNav session expires mid-pagination the results are silently
      // truncated, so re-login and retry the manufacturer, keeping the larger set.
      let rows = [];
      let reloginFailed = false;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_MANUFACTURER; attempt++) {
        const status = {};
        let attemptRows;
        try {
          attemptRows = await Promise.race([
            searchByManufacturer(page, mfgrCode, pool, job.id, { status }),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error(`Timed out after ${PER_MANUFACTURER_TIMEOUT_MS / 1000}s`)), PER_MANUFACTURER_TIMEOUT_MS)
            ),
          ]);
        } catch (searchErr) {
          await logError(`${brandName} (${mfgrCode}): ${searchErr.message}`);
          attemptRows = [];
        }
        if (attemptRows.length > rows.length) rows = attemptRows;
        if (!status.sessionExpired) break;

        if (attempt >= MAX_ATTEMPTS_PER_MANUFACTURER) {
          await appendLog(pool, job.id, `  ${mfgrCode}: keeping partial results (${rows.length} rows) — session expired again on retry`);
          break;
        }

        await appendLog(pool, job.id, `Session expired mid-search for ${brandName}, re-logging in to retry...`);
        await browser.close().catch(() => {});
        try {
          const session = await triwestLogin(pool, job.id);
          browser = session.browser;
          page = session.page;
        } catch (err) {
          await appendLog(pool, job.id, `Re-login failed: ${err.message}`);
          reloginFailed = true;
          break;
        }
      }
      if (reloginFailed) break;

      if (rows.length === 0) {
        consecutiveEmpty++;
        if (consecutiveEmpty >= MAX_CONSECUTIVE_EMPTY) {
          await appendLog(pool, job.id,
            `${MAX_CONSECUTIVE_EMPTY} consecutive manufacturers returned 0 results — portal may be down, aborting`);
          break;
        }
      } else {
        consecutiveEmpty = 0;
      }

      for (const row of rows) dumpRows.push({ mfgr: mfgrCode, ...row });

      for (const row of rows) {
        if (!row.itemNumber) continue;

        const skuKey = row.itemNumber.toUpperCase();
        const normalizedKey = row.itemNumber.replace(/[-\s.]/g, '').toUpperCase();
        // Some brands' catalog SKUs came from pricelists without the portal's
        // 3-letter manufacturer prefix (Quick-Step: portal UNLUS4217 ↔ DB
        // US4217; Cal Classics ride under STX: STXLCMI812 ↔ LCMI812, with an
        // optional CF packaging suffix: STXMCLV395CF ↔ MCLV395; Citywide under
        // TDT) — try the stripped keys last so prefixed SKUs always win
        const strippedKey = skuKey.startsWith(mfgrCode) && skuKey.length >= mfgrCode.length + 4
          ? skuKey.slice(mfgrCode.length) : null;
        const dbSku = skuMap.get(skuKey) || skuMap.get(normalizedKey) ||
          (strippedKey ? skuMap.get(strippedKey) : undefined) ||
          (strippedKey && strippedKey.endsWith('CF') ? skuMap.get(strippedKey.slice(0, -2)) : undefined);

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

    // Persist raw rows so match gaps can be analyzed offline without re-scraping
    try {
      fs.writeFileSync('/app/data/triwest-instock.json', JSON.stringify(dumpRows, null, 1));
      await appendLog(pool, job.id, `Dumped ${dumpRows.length} raw rows to data/triwest-instock.json`);
    } catch (err) {
      await appendLog(pool, job.id, `Row dump failed: ${err.message}`);
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
