import { delay, appendLog } from './base.js';
import { screenshot } from './triwest-auth.js';

/**
 * Shared DNav search + parse utilities for Tri-West scrapers.
 *
 * All three scrapers (catalog, pricing, inventory) use the same Advanced Item Search
 * form and results table. This module centralizes search/parse/pagination logic.
 *
 * DNav portal structure (discovered in Phase 0):
 * - Search form: Advanced Item Search with manufacturer dropdown
 * - Results table: 6 columns — Item#, Description, Color, Pattern, Price, Quantity
 * - Pagination: "More" button with d24_max_records dropdown
 * - Description format: Line 1 = "{color}-{product name} {size} / {COLLECTION} *{sqft_per_box}"
 * - Price format: carton price (e.g., $171.46) + per-sqft price (e.g., $4.99 SF)
 * - Quantity format: number + unit code (CT, EA, PC, SF, ST)
 */

/** Manufacturer 3-letter code to brand display name */
export const MANUFACTURER_NAMES = {
  'PRO': 'Provenza',
  'PAF': 'Paradigm',
  'ARM': 'Armstrong',
  'MET': 'Metroflor',
  'MIR': 'Mirage',
  'CAL': 'California Classics',
  'MPG': 'Grand Pacific',
  'BRA': 'Bravada',
  'HFD': 'Hartco',
  'TTF': 'True Touch',
  'CFL': 'Citywide',
  'AHF': 'AHF Contract',
  'FXO': 'Flexco',
  'SIK': 'Sika',
  'USR': 'US Rubber',
  'TEC': 'TEC',
  'KEN': 'Kenmark',
  'BOS': 'Bosphorus',
  'BBL': 'Babool',
  'CON': 'Congoleum',
  'ELT': 'Elysium',
  'FOS': 'Forester',
  'HDS': 'Hardwoods Specialty',
  'JMC': 'JM Cork',
  'KRA': 'Kraus',
  'RCG': 'RC Global',
  'SHA': 'Shaw',
  'STX': 'Stanton',
  'SUM': 'Summit',
  'TDT': 'Traditions',
  'UNL': 'Quick-Step',
  'WFT': 'WF Taylor',
  'BRK': 'Bruce',
  'OPX': 'Opulux',
};

/** Manufacturer code to default PIM category slug */
export const MFGR_CATEGORY = {
  'PRO': 'engineered-hardwood',
  'BRA': 'engineered-hardwood',
  'MIR': 'engineered-hardwood',
  'CAL': 'engineered-hardwood',
  'MPG': 'engineered-hardwood',
  'HFD': 'engineered-hardwood',
  'TTF': 'engineered-hardwood',
  'BRK': 'engineered-hardwood',
  'ARM': 'lvp-plank',
  'MET': 'lvp-plank',
  'CFL': 'lvp-plank',
  'AHF': 'lvp-plank',
  'PAF': 'lvp-plank',
  'CON': 'lvp-plank',
  'UNL': 'laminate',
  'KRA': 'lvp-plank',
  'STX': 'carpet-tile',
  'SHA': 'engineered-hardwood',
  // Specialty brands — no default category
  'FXO': null,
  'SIK': null,
  'USR': null,
  'TEC': null,
  'WFT': null,
  'KEN': null,
  'BOS': null,
  'BBL': null,
  'ELT': null,
  'FOS': null,
  'HDS': null,
  'JMC': null,
  'RCG': null,
  'SUM': null,
  'TDT': null,
  'OPX': 'lvp-plank',
};

/**
 * Parse a single result row from the DNav search results table.
 *
 * Expected cell layout (6 columns):
 *   [0] Item#        — e.g., "PRO2313"
 *   [1] Description  — Line 1: "{COLOR}-{PRODUCT NAME} {SIZE}"
 *                      Line 2: "{COLLECTION} *{sqft_per_box}" (optional)
 *   [2] Color        — e.g., "ACCLAIM"
 *   [3] Pattern      — e.g., "AFFINITY" (= collection)
 *   [4] Price        — e.g., "$171.46 / $4.99 SF"
 *   [5] Quantity     — e.g., "1,243 CT"
 *
 * @param {string[]} cells - Array of 6 cell text values
 * @returns {object|null} Parsed row object, or null if unparseable
 */
export function parseResultRow(cells) {
  if (!cells || cells.length < 5) return null;

  const itemNumber = (cells[0] || '').trim();
  if (!itemNumber || itemNumber.length < 3) return null;

  const rawDescription = (cells[1] || '').trim();
  const colorCell = (cells[2] || '').trim();  // truncated by portal (~9 chars)
  const patternCell = (cells[3] || '').trim(); // truncated by portal (~9 chars)
  const rawPrice = (cells[4] || '').trim();
  const rawQty = cells.length > 5 ? (cells[5] || '').trim() : '';

  // Parse description lines
  // Multi-line format:
  //   Line 1: "ACCLAIM-EUROPEAN OAK 7.5"" or "BORN READY 7.15"X60""
  //   Line 2: "AFFINITY COLLECTION     *34.36" or "UPTOWN CHIC WPF COLL    *35.96"
  // Some brands have dimensions on line 2 instead of collection:
  //   Line 1: "TIMBERCUTS HICKORY 1/2" ENG."
  //   Line 2: "1/2"X(3.5",5.5",7.5")XRL*37.98"
  // Single-line format:
  //   "ACCLAIM-EUROPEAN OAK 7.5" / AFFINITY COLLECTION *34.36"
  const descLines = rawDescription.split(/\n/).map(l => l.trim()).filter(Boolean);
  let line1 = descLines[0] || '';
  let collectionLine = descLines[1] || '';

  // Handle single-line format with " / " separator
  if (!collectionLine && line1.includes(' / ')) {
    const slashParts = line1.split(' / ');
    line1 = slashParts[0].trim();
    collectionLine = slashParts[1] || '';
  }

  // Detect if line 2 is dimensions/packaging rather than a collection name.
  // Dimension patterns: starts with digits, fractions, or contains XRL, SF/, EA/, etc.
  const isDimensionLine = collectionLine && /^[\d(]/.test(collectionLine.replace(/\*[\d.]+/, '').trim())
    || (collectionLine && /\d+\/?CT\b|XRL|SF\/|EA\/|\bXXX\b|\bGAL\b|\bOZ\b/i.test(collectionLine.replace(/\*[\d.]+/, '')));

  // Extract full color name and product name from line 1
  // Formats: "COLOR-PRODUCT NAME SIZE" or "COLOR NAME SIZE" (no dash)
  let fullColor = '';
  let productName = '';
  let size = '';

  // Size pattern: decimal or fractional dimensions, with optional quotes and x-dimensions
  // Matches: 7.5", 1/2", 9"X72", 7.15"X60", 2 1/4"
  const sizeRegex = /\s+((?:\d+\s+)?\d+(?:[\/\.]\d+)?["']?(?:\s*[xX×]\s*(?:\d+\s+)?\d+(?:[\/\.]\d+)?["']?)*)$/;

  const dashIdx = line1.indexOf('-');
  if (dashIdx > 0) {
    // Format: "ACCLAIM-EUROPEAN OAK 7.5""
    fullColor = line1.slice(0, dashIdx).trim();
    const afterDash = line1.slice(dashIdx + 1).trim();
    const sizeMatch = afterDash.match(sizeRegex);
    if (sizeMatch) {
      size = sizeMatch[1].trim();
      productName = afterDash.slice(0, afterDash.length - sizeMatch[0].length).trim();
    } else {
      productName = afterDash;
    }
  } else {
    // Format: "BORN READY 7.15"X60"" — no dash, color is everything before size
    const sizeMatch = line1.match(sizeRegex);
    if (sizeMatch) {
      size = sizeMatch[1].trim();
      fullColor = line1.slice(0, line1.length - sizeMatch[0].length).trim();
    } else {
      fullColor = line1;
    }
    productName = fullColor; // same as color when no dash separator
  }

  // If line 2 is dimensions (not a collection), extract size from it and use
  // the product line name from line 1 as the collection instead.
  if (isDimensionLine) {
    // Extract size from line 2 if we didn't get one from line 1
    if (!size) {
      let dimStr = collectionLine.replace(/\*[\d.]+/, '').trim();
      dimStr = dimStr.replace(/\s+\d+\/?CT$/i, '').replace(/\s+XXX$/i, '').trim();
      if (dimStr) size = dimStr;
    }
    // Use line 1 product name as collection (e.g., "TIMBERCUTS" from "TIMBERCUTS HICKORY 1/2" ENG.")
    // Extract the product line: first word(s) before species/material keywords
    const speciesWords = /\b(OAK|HICKORY|MAPLE|WALNUT|CHERRY|BIRCH|ASH|ELM|PINE|ACACIA|WHITE|RED|EUROPEAN|FRENCH|ENG|SOLID|PLK|PLANK|STRIP)\b/i;
    const speciesIdx = line1.search(speciesWords);
    let productLine = '';
    if (speciesIdx > 0) {
      productLine = line1.slice(0, speciesIdx).trim();
      // Remove trailing size fragments from product line
      productLine = productLine.replace(/\s+\d+[\/.]?\d*["']?\s*$/, '').trim();
    }
    // Fall back to color cell if product line extraction failed
    if (productLine.length >= 3 && productLine !== 'ZZ') {
      collectionLine = productLine; // will be used as pattern below
    } else {
      collectionLine = ''; // will fall through to patternCell or brand-only
    }
  }

  // Extract full collection/pattern from line 2 (before *sqft and "COLL"/"COLLECTION" suffix)
  // e.g., "AFFINITY COLLECTION     *34.36" → "AFFINITY"
  // e.g., "UPTOWN CHIC WPF COLL    *35.96" → "UPTOWN CHIC WPF"
  // e.g., "UNTAMED BEAUTY-WHITE OAK  5/CT" → "UNTAMED BEAUTY-WHITE OAK"
  let fullPattern = patternCell; // default to truncated cell value
  if (collectionLine) {
    let cleaned = collectionLine.replace(/\*[\d.]+/, '').trim(); // remove *sqft
    cleaned = cleaned.replace(/\s+COLLECTION$/i, '').replace(/\s+COLL$/i, '').trim();
    // Remove trailing quantity indicators: "5/CT", "10/CT", "5CT", "XXX", etc.
    cleaned = cleaned.replace(/\s+\d+\/?CT$/i, '').trim();
    cleaned = cleaned.replace(/\s+XXX$/i, '').trim();
    if (cleaned.length > 0) {
      fullPattern = cleaned;
    }
  }

  // Use full color from description (not truncated cell); fall back to cell
  const color = fullColor || colorCell;
  const pattern = fullPattern || patternCell;

  // Extract sqft_per_box from *value in description (e.g., "*34.36")
  let sqftPerBox = null;
  const sqftMatch = (collectionLine || rawDescription).match(/\*(\d+(?:\.\d+)?)/);
  if (sqftMatch) {
    sqftPerBox = parseFloat(sqftMatch[1]);
  }

  // Parse prices: "$171.46 / $4.99 SF" or "$4.99 SF"
  let cartonPrice = null;
  let sqftPrice = null;
  const priceMatches = rawPrice.match(/\$\s*([\d,]+\.?\d*)/g);
  if (priceMatches) {
    if (priceMatches.length >= 2) {
      cartonPrice = parseFloat(priceMatches[0].replace(/[$,\s]/g, ''));
      sqftPrice = parseFloat(priceMatches[1].replace(/[$,\s]/g, ''));
    } else if (priceMatches.length === 1) {
      const val = parseFloat(priceMatches[0].replace(/[$,\s]/g, ''));
      // If "SF" follows, it's sqft price; otherwise carton
      if (rawPrice.includes('SF')) {
        sqftPrice = val;
      } else {
        cartonPrice = val;
      }
    }
  }

  // Parse quantity: "1,243 CT" or "500 SF" or "120 EA"
  let quantity = 0;
  let unit = 'CT';
  const qtyMatch = rawQty.match(/([\d,]+(?:\.\d+)?)\s*(CT|EA|PC|SF|ST|PCS|BOX|PLT)?/i);
  if (qtyMatch) {
    quantity = parseFloat(qtyMatch[1].replace(/,/g, ''));
    unit = (qtyMatch[2] || 'CT').toUpperCase();
    if (unit === 'PCS') unit = 'PC';
    if (unit === 'BOX') unit = 'CT';
  }

  return {
    itemNumber,
    rawDescription,
    productName: productName || color || itemNumber,
    color,
    pattern,       // = collection name
    size,
    sqftPerBox,
    cartonPrice,
    sqftPrice,
    quantity,
    unit,
  };
}

/**
 * Parse all data rows from the current DNav results table.
 *
 * @param {import('puppeteer').Page} page
 * @returns {Promise<object[]>} Array of parsed row objects
 */
export async function parseResultsTable(page) {
  const rawRows = await page.evaluate(() => {
    const tables = document.querySelectorAll('table');

    // Priority 1: DNav standard table (class includes 'd24-standard' or 'd24-sortable')
    for (const table of tables) {
      const cls = table.className || '';
      if (cls.includes('d24-standard') || cls.includes('d24-sortable')) {
        const rows = Array.from(table.querySelectorAll('tr'));
        const data = [];
        for (let i = 1; i < rows.length; i++) { // skip header row
          const cells = Array.from(rows[i].querySelectorAll('td'));
          // Skip blank separator rows (0-1 cells or all empty)
          if (cells.length < 5) continue;
          const texts = cells.map(c => c.textContent.trim());
          if (texts.every(t => !t)) continue; // all-empty row
          data.push(texts);
        }
        if (data.length > 0) return data;
      }
    }

    // Priority 2: table with Item#/Price/Quantity headers
    for (const table of tables) {
      const headers = Array.from(table.querySelectorAll('th')).map(th => th.textContent.trim().toLowerCase());
      if (headers.some(h => h.includes('item')) && headers.some(h => h.includes('price') || h.includes('quantity'))) {
        const rows = Array.from(table.querySelectorAll('tr'));
        const data = [];
        for (let i = 1; i < rows.length; i++) {
          const cells = Array.from(rows[i].querySelectorAll('td'));
          if (cells.length >= 5) {
            const texts = cells.map(c => c.textContent.trim());
            if (texts.every(t => !t)) continue;
            data.push(texts);
          }
        }
        if (data.length > 0) return data;
      }
    }

    // Priority 3: any table with 5+ column data rows
    for (const table of tables) {
      const rows = Array.from(table.querySelectorAll('tr'));
      if (rows.length < 2) continue;
      const data = [];
      for (let i = 1; i < rows.length; i++) {
        const cells = Array.from(rows[i].querySelectorAll('td'));
        if (cells.length >= 5) {
          const texts = cells.map(c => c.textContent.trim());
          if (texts.every(t => !t)) continue;
          data.push(texts);
        }
      }
      if (data.length > 0) return data;
    }

    return [];
  });

  const parsed = [];
  for (const cells of rawRows) {
    const row = parseResultRow(cells);
    if (row) parsed.push(row);
  }
  return parsed;
}

/**
 * Click the "More" button to load additional results from the DNav search.
 * First sets d24_max_records to the highest available value.
 *
 * @param {import('puppeteer').Page} page
 * @returns {Promise<boolean>} true if more results were loaded
 */
export async function clickMoreResults(page) {
  const moreClicked = await page.evaluate(() => {
    // Find the "More" form
    const forms = document.querySelectorAll('form');
    let moreForm = null;
    for (const f of forms) {
      if (f.action && f.action.includes('more') || f.id && f.id.includes('more')) {
        moreForm = f;
        break;
      }
      // Also check submit button text
      const btn = f.querySelector('input[type="submit"]');
      if (btn && (btn.value || '').toLowerCase().includes('more')) {
        moreForm = f;
        break;
      }
    }

    if (!moreForm) {
      // Try finding a standalone "More" button
      const btns = document.querySelectorAll('input[type="submit"], button');
      for (const btn of btns) {
        const text = (btn.value || btn.textContent || '').trim().toLowerCase();
        if (text === 'more' || text === 'more results' || text === 'load more') {
          btn.click();
          return true;
        }
      }
      return false;
    }

    // Set max_records to highest value if dropdown exists
    const maxRecords = moreForm.querySelector('select[name="d24_max_records"]');
    if (maxRecords) {
      const options = Array.from(maxRecords.options);
      if (options.length > 0) {
        // Pick the highest numeric value
        let maxVal = options[0].value;
        let maxNum = parseInt(options[0].value) || 0;
        for (const opt of options) {
          const num = parseInt(opt.value) || 0;
          if (num > maxNum) { maxNum = num; maxVal = opt.value; }
        }
        maxRecords.value = maxVal;
      }
    }

    // Click the submit button
    const submitBtn = moreForm.querySelector('input[type="submit"]');
    if (submitBtn) {
      submitBtn.click();
      return true;
    }

    return false;
  });

  if (moreClicked) {
    await delay(5000); // Wait for results to load
    return true;
  }
  return false;
}

/**
 * Read all manufacturer codes from the Advanced Item Search dropdown.
 *
 * @param {import('puppeteer').Page} page
 * @returns {Promise<{value: string, text: string}[]>} Dropdown options (excluding empty)
 */
export async function getAllManufacturerCodes(page) {
  const raw = await page.evaluate(() => {
    const select = document.querySelector('select[name="d24_filter_mfgr"]');
    if (!select) return [];
    return Array.from(select.options)
      .filter(o => o.value && o.value.trim() !== '')
      .map(o => ({ value: o.value.trim(), text: o.text.trim() }));
  });

  // Sort: important flooring brands first, large mega-catalogs later, specialty last.
  // Priority tiers prevent mega-brands (AHF ~8000 items) from consuming the whole session.
  const PRIORITY = {
    'PRO': 1, 'MIR': 1, 'CAL': 1, 'BRA': 1, 'MPG': 1, // premium hardwood
    'HFD': 2, 'TTF': 2, 'BRK': 2,                       // hardwood
    'PAF': 3, 'MET': 3, 'CFL': 3, 'CON': 3, 'KRA': 3,  // vinyl/resilient
    'UNL': 3, 'STX': 3,                                   // laminate/carpet
    'AHF': 4, 'SHA': 4, 'ARM': 4,                         // mega-catalogs (1000+ items)
  };
  return raw.sort((a, b) => {
    const aP = PRIORITY[a.value] || 9;
    const bP = PRIORITY[b.value] || 9;
    return aP - bP;
  });
}

/**
 * Navigate back to the Advanced Search form from any state.
 * Tries clicking #home first, then reloads the page as fallback.
 *
 * @param {import('puppeteer').Page} page
 * @param {string} portalBase - e.g., PORTAL_BASE
 * @returns {Promise<boolean>} true if search form is ready
 */
export async function navigateToSearchForm(page, portalBase) {
  // DNav is an SPA — after a search with results, the DOM stays in results view.
  // After heavy pagination, the session may also expire and redirect to login.

  // Strategy 1: Click home link to reset to dashboard
  await page.evaluate(() => {
    const homeLink = document.querySelector('a[href*="#home"]');
    if (homeLink) { homeLink.click(); return; }
    const advLink = document.querySelector('a[href*="ADVANCED"]');
    if (advLink) advLink.click();
  });
  await delay(3000);

  if (await _isFormReady(page)) return true;

  // Strategy 2: Full page reload
  try {
    await page.goto(`${portalBase}/main/`, { waitUntil: 'networkidle2', timeout: 30000 });
    await delay(3000);
  } catch {
    await page.goto(`${portalBase}/main/`, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await delay(5000);
  }

  if (await _isFormReady(page)) return true;

  // Strategy 3: Session expired — we're on the login page. Re-login.
  const onLoginPage = await page.evaluate(() => {
    const text = document.body.innerText || '';
    return text.includes('Sign-In') || text.includes('User ID') || !!document.querySelector('#d24user_login');
  });

  if (onLoginPage) {
    // Signal that a re-login is needed. Return 'relogin' so the caller can handle it.
    return 'relogin';
  }

  return false;
}

/** Check if the manufacturer dropdown is visible and interactable. */
async function _isFormReady(page) {
  const ready = await page.evaluate(() => {
    const select = document.querySelector('select[name="d24_filter_mfgr"]');
    if (!select) return false;
    const rect = select.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    // Reset dropdown for next search
    select.value = '';
    return true;
  });
  return ready;
}

/**
 * Search DNav for a single manufacturer and return all result rows.
 * Handles pagination (clicks "More" until no new results appear).
 *
 * @param {import('puppeteer').Page} page - Authenticated Puppeteer page on search form
 * @param {string} mfgrCode - Manufacturer value to select (e.g., "PRO")
 * @param {object} pool - DB pool for logging
 * @param {number} jobId - Scrape job ID
 * @param {object} [opts]
 * @param {number} [opts.maxRows=3000] - Max rows to collect per manufacturer
 * @returns {Promise<object[]>} All parsed rows for this manufacturer
 */
export async function searchByManufacturer(page, mfgrCode, pool, jobId, opts = {}) {
  const maxRows = opts.maxRows || 3000;

  // Select manufacturer in dropdown
  try {
    await page.select('select[name="d24_filter_mfgr"]', mfgrCode);
  } catch (err) {
    await appendLog(pool, jobId, `  Failed to select manufacturer ${mfgrCode}: ${err.message}`);
    return [];
  }
  await delay(500);

  // Before searching, set d24_max_records to highest value if the dropdown exists on the page
  // (this controls how many rows per page — default is 30, but higher values reduce pagination)
  await page.evaluate(() => {
    const selects = document.querySelectorAll('select[name="d24_max_records"]');
    for (const sel of selects) {
      const opts = Array.from(sel.options);
      let maxVal = sel.value, maxNum = parseInt(sel.value) || 0;
      for (const opt of opts) {
        const num = parseInt(opt.value) || 0;
        if (num > maxNum) { maxNum = num; maxVal = opt.value; }
      }
      sel.value = maxVal;
    }
  });

  // Click Search button on the Advanced Item Search form
  // IMPORTANT: Must target `item_search_advanced` specifically, NOT `item_search`
  // (the keyword search form `#item_search` would also match and fails without text input)
  const searchClicked = await page.evaluate(() => {
    const forms = document.querySelectorAll('form');
    // Priority 1: form with action containing 'item_search_advanced'
    for (const form of forms) {
      if (form.action && form.action.includes('item_search_advanced')) {
        const btn = form.querySelector('input[type="submit"]');
        if (btn) { btn.click(); return true; }
      }
    }
    // Priority 2: form that contains the manufacturer dropdown (it's the advanced search form)
    for (const form of forms) {
      if (form.querySelector('select[name="d24_filter_mfgr"]')) {
        const btn = form.querySelector('input[type="submit"]');
        if (btn) { btn.click(); return true; }
      }
    }
    return false;
  });

  if (!searchClicked) {
    await appendLog(pool, jobId, `  Could not find Search button for ${mfgrCode}`);
    return [];
  }

  // Wait for results to load
  await delay(6000);

  // Parse initial results
  let allRows = await parseResultsTable(page);

  if (allRows.length === 0) {
    // Check if "no results" or empty
    const pageText = await page.evaluate(() => document.body.innerText.slice(0, 500)).catch(() => '');
    if (pageText.toLowerCase().includes('no items') || pageText.toLowerCase().includes('no results') || pageText.toLowerCase().includes('0 items')) {
      await appendLog(pool, jobId, `  ${mfgrCode}: 0 results`);
      return [];
    }
    // Take a screenshot for debugging
    await screenshot(page, `triwest-no-results-${mfgrCode}`);
    await appendLog(pool, jobId, `  ${mfgrCode}: table parse returned 0 rows (possible structure change)`);
    return [];
  }

  await appendLog(pool, jobId, `  ${mfgrCode}: initial page has ${allRows.length} rows`);

  // Paginate: keep clicking "More" until no new rows or we hit the cap
  let prevCount = 0;
  let paginationAttempts = 0;
  const MAX_PAGINATION = 50; // safety limit

  while (allRows.length < maxRows && paginationAttempts < MAX_PAGINATION) {
    prevCount = allRows.length;
    const moreAvailable = await clickMoreResults(page);
    if (!moreAvailable) break;

    paginationAttempts++;
    const newRows = await parseResultsTable(page);

    if (newRows.length <= prevCount) {
      // No new rows appeared
      break;
    }

    allRows = newRows; // DNav typically replaces/extends the table
    await appendLog(pool, jobId, `  ${mfgrCode}: after "More" #${paginationAttempts}, now ${allRows.length} rows`);
  }

  return allRows.slice(0, maxRows);
}
