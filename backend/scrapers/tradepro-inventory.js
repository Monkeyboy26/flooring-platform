import { launchBrowser, delay, appendLog, addJobError } from './base.js';
import { portalLogin, screenshot, waitForSPA, findSelector } from './tradepro-auth.js';

const MAX_ERRORS = 30;
const BASE_URL = 'https://www.tradeproexchange.com';

const BRANDS = [
  { name: 'Daltile',        vendorCodes: ['DALTILE', 'DAL'], keywords: ['daltile', 'dal'] },
  { name: 'American Olean', vendorCodes: ['AO', 'AMERICAN_OLEAN'], keywords: ['american olean', 'ao '] },
  { name: 'Marazzi',        vendorCodes: ['MARAZZI'], keywords: ['marazzi'] },
];

/**
 * TradePro Exchange inventory scraper.
 *
 * Logs into the Salesforce Experience Cloud portal, navigates to product
 * listings, extracts real-time stock quantities per SKU, and upserts
 * into inventory_snapshots.
 */
export async function run(pool, job, source) {
  const config = source.config || {};
  const discoveryMode = config.discovery_mode === true;
  const maxProducts = config.max_products || 5000;
  const brands = config.brands || BRANDS.map(b => b.name);
  const productsUrl = config.products_url || '/s/global-search/%20';

  let browser = null;
  let errorCount = 0;
  let totalMatched = 0;
  let totalUnmatched = 0;
  let totalUpserted = 0;

  async function logError(msg) {
    errorCount++;
    if (errorCount <= MAX_ERRORS) {
      try { await addJobError(pool, job.id, msg); } catch { /* DB error during error logging — ignore */ }
    }
  }

  try {
    // Load all Daltile/AO/Marazzi SKUs from DB upfront
    const activeBrands = BRANDS.filter(b => brands.includes(b.name));
    const vendorCodes = activeBrands.flatMap(b => b.vendorCodes);
    const placeholders = vendorCodes.map((_, i) => `$${i + 1}`).join(', ');

    const skuResult = await pool.query(`
      SELECT s.id, s.vendor_sku, s.internal_sku, v.code AS vendor_code
      FROM skus s
      JOIN products p ON p.id = s.product_id
      JOIN vendors v ON v.id = p.vendor_id
      WHERE v.code IN (${placeholders}) AND s.vendor_sku IS NOT NULL
    `, vendorCodes);

    // Build lookup map: vendor_sku → sku row
    const skuMap = new Map();
    for (const row of skuResult.rows) {
      skuMap.set(row.vendor_sku.toUpperCase(), row);
      // Also store without hyphens/spaces for fuzzy matching
      const normalized = row.vendor_sku.replace(/[-\s]/g, '').toUpperCase();
      if (!skuMap.has(normalized)) skuMap.set(normalized, row);
    }

    await appendLog(pool, job.id, `Loaded ${skuResult.rows.length} Daltile/AO/Marazzi SKUs from DB (${skuMap.size} lookup keys)`);

    // Launch browser
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    // Login with retry (up to 3 attempts)
    let loginSuccess = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await appendLog(pool, job.id, `Login attempt ${attempt}/3...`);
        await portalLogin(page, pool, job);
        loginSuccess = true;
        break;
      } catch (err) {
        await logError(`Login attempt ${attempt} failed: ${err.message}`);
        if (attempt < 3) {
          const backoff = attempt * 5000;
          await appendLog(pool, job.id, `Retrying login in ${backoff / 1000}s...`);
          await delay(backoff);
        }
      }
    }

    if (!loginSuccess) {
      throw new Error('All login attempts failed');
    }

    // Extract warehouse/location from portal header
    const warehouse = await extractWarehouse(page);
    await appendLog(pool, job.id, `Warehouse location: ${warehouse}`);

    // Discovery mode: screenshot dashboard and log structure
    if (discoveryMode) {
      await appendLog(pool, job.id, '=== DISCOVERY MODE ===');
      await screenshot(page, 'inventory-dashboard');
      await discoverPageStructure(page, pool, job);
    }

    // Navigate to products page
    const fullProductsUrl = productsUrl.startsWith('http')
      ? productsUrl
      : `${BASE_URL}${productsUrl}`;

    await appendLog(pool, job.id, `Navigating to products: ${fullProductsUrl}`);
    await page.goto(fullProductsUrl, { waitUntil: 'networkidle2', timeout: 60000 });
    await waitForSPA(page);

    // Check for session expiry
    if (page.url().includes('/login')) {
      throw new Error('Session expired — redirected to login after navigating to products');
    }

    if (discoveryMode) await screenshot(page, 'products-page');

    // Scrape product cards with pagination
    const allCards = await scrapeAllProductCards(page, pool, job, maxProducts, discoveryMode);
    await appendLog(pool, job.id, `Extracted ${allCards.length} product cards total`);

    // Match and upsert inventory
    for (const card of allCards) {
      if (!card.sku) continue;

      const skuKey = card.sku.toUpperCase();
      const normalizedKey = card.sku.replace(/[-\s]/g, '').toUpperCase();
      const dbSku = skuMap.get(skuKey) || skuMap.get(normalizedKey);

      if (!dbSku) {
        totalUnmatched++;
        if (totalUnmatched <= 20) {
          await appendLog(pool, job.id, `  Unmatched SKU: ${card.sku} (${card.name || 'no name'})`);
        }
        continue;
      }

      totalMatched++;

      try {
        // Determine which columns to fill based on unit
        const isSquareFoot = (card.stockUnit || '').toUpperCase() === 'SF';
        const qtyOnHand = isSquareFoot ? 0 : Math.round(card.stockQty || 0);
        const qtyOnHandSqft = isSquareFoot ? Math.round(card.stockQty || 0) : 0;

        await pool.query(`
          INSERT INTO inventory_snapshots (
            sku_id, warehouse, qty_on_hand, qty_on_hand_sqft, fresh_until
          ) VALUES ($1, $2, $3, $4, NOW() + INTERVAL '24 hours')
          ON CONFLICT (sku_id, warehouse) DO UPDATE SET
            qty_on_hand = EXCLUDED.qty_on_hand,
            qty_on_hand_sqft = EXCLUDED.qty_on_hand_sqft,
            fresh_until = EXCLUDED.fresh_until,
            snapshot_time = CURRENT_TIMESTAMP
        `, [dbSku.id, warehouse, qtyOnHand, qtyOnHandSqft]);

        totalUpserted++;
      } catch (err) {
        await logError(`Inventory upsert failed for ${card.sku}: ${err.message}`);
      }

      // Progress logging every 100 SKUs
      if (totalMatched % 100 === 0) {
        await appendLog(pool, job.id, `Progress: ${totalMatched} matched, ${totalUpserted} upserted, ${totalUnmatched} unmatched`, {
          products_found: totalMatched,
          products_updated: totalUpserted
        });
      }
    }

    // Final summary
    await appendLog(pool, job.id,
      `Complete. Cards: ${allCards.length}, Matched: ${totalMatched}, Upserted: ${totalUpserted}, Unmatched: ${totalUnmatched}, Errors: ${errorCount}`,
      { products_found: totalMatched, products_updated: totalUpserted }
    );

    if (totalUnmatched > 20) {
      await appendLog(pool, job.id, `(${totalUnmatched - 20} more unmatched SKUs not shown — may indicate new products to import)`);
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

/**
 * Extract the warehouse/location from the portal header.
 * The portal shows something like "ROMA FLOORING DESIGN INC / ANAHEIM / DalTile"
 * Falls back to a generic label if not found.
 */
async function extractWarehouse(page) {
  const location = await page.evaluate(() => {
    // Look for header text with location info
    const candidates = [
      ...document.querySelectorAll('header *'),
      ...document.querySelectorAll('[class*="account"], [class*="header"], [class*="location"]')
    ];

    for (const el of candidates) {
      const text = el.textContent.trim();
      // Match patterns like "SSC Anaheim, CA" or "ANAHEIM"
      const locationMatch = text.match(/(?:SSC\s+)?([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*),?\s*([A-Z]{2})?/);
      if (locationMatch && text.includes('/')) {
        // Extract location portion from "COMPANY / CITY / BRAND" pattern
        const parts = text.split('/').map(s => s.trim());
        if (parts.length >= 2) {
          return parts[1].trim(); // City is typically the second segment
        }
      }
    }

    // Fallback: try to find "In Stock at <location>" text anywhere
    const bodyText = document.body.innerText;
    const stockMatch = bodyText.match(/In Stock at\s+(.+?)(?:\n|$)/i);
    if (stockMatch) return stockMatch[1].trim();

    return null;
  });

  if (location) {
    // Normalize: "ANAHEIM" → "SSC Anaheim, CA" if it looks like just a city
    if (/^[A-Z]+$/.test(location)) {
      return `SSC ${location.charAt(0) + location.slice(1).toLowerCase()}, CA`;
    }
    return location;
  }

  return 'TradePro SSC Anaheim, CA';
}

/**
 * Scrape all product cards from the current page with pagination (scroll/load more).
 * Returns array of parsed product card objects.
 */
async function scrapeAllProductCards(page, pool, job, maxProducts, discoveryMode) {
  const allCards = [];
  let previousCount = 0;
  let stableRounds = 0;

  for (let pageNum = 0; pageNum < 200; pageNum++) {
    // Extract currently visible product cards
    const cards = await extractProductCards(page);

    if (discoveryMode && pageNum === 0) {
      await appendLog(pool, job.id, `Discovery: found ${cards.length} product cards on initial load`);
      // Log first 20 cards in detail
      for (let i = 0; i < Math.min(cards.length, 20); i++) {
        const c = cards[i];
        await appendLog(pool, job.id, `  [${i}] SKU: ${c.sku || '?'} | Price: $${c.price || '?'}/${c.priceUnit || '?'} | Stock: ${c.stockQty || '?'} ${c.stockUnit || '?'} | ${c.name || ''}`);
      }
      await screenshot(page, 'inventory-cards-page0');
    }

    // If we have new cards beyond what we already collected
    if (cards.length > allCards.length) {
      // Add only new cards (those beyond our previous count)
      const newCards = cards.slice(allCards.length);
      allCards.push(...newCards);

      if (allCards.length >= maxProducts) {
        await appendLog(pool, job.id, `Reached max_products limit (${maxProducts}), stopping pagination`);
        break;
      }

      stableRounds = 0;
    } else {
      stableRounds++;
    }

    // Stop if count has been stable for 3 rounds
    if (stableRounds >= 3) {
      await appendLog(pool, job.id, `No new products after ${stableRounds} pagination attempts, done.`);
      break;
    }

    previousCount = cards.length;

    // Try to load more products
    const loadedMore = await loadMoreProducts(page);
    if (!loadedMore) {
      await appendLog(pool, job.id, 'No more products to load (no load-more button or end of scroll)');
      break;
    }

    await waitForSPA(page, 15000);

    // Check for session expiry
    if (page.url().includes('/login')) {
      await appendLog(pool, job.id, 'Session expired during pagination');
      break;
    }

    if (pageNum % 10 === 9) {
      await appendLog(pool, job.id, `Pagination round ${pageNum + 1}: ${allCards.length} cards so far`);
    }
  }

  return allCards;
}

/**
 * Extract product card data from the current page state.
 * Tries multiple selector strategies since this is a Salesforce LWC app.
 */
async function extractProductCards(page) {
  return page.evaluate(() => {
    const results = [];

    // Strategy 1: Look for product card containers with structured data
    const cardSelectors = [
      '[data-product]',
      '.product-card',
      '.product-tile',
      '[class*="productCard"]',
      '[class*="product-card"]',
      '[class*="ProductCard"]',
      '[class*="product_card"]',
      '.slds-card',
      '[class*="searchResult"]',
      '[class*="search-result"]',
      '[class*="tile"]'
    ];

    let cards = [];
    for (const sel of cardSelectors) {
      cards = Array.from(document.querySelectorAll(sel));
      if (cards.length > 0) break;
    }

    // Strategy 2: Find repeated siblings that look like product cards
    if (cards.length === 0) {
      // Look for grid/list containers
      const containers = document.querySelectorAll(
        '[class*="grid"], [class*="list"], [class*="results"], [class*="products"]'
      );
      for (const container of containers) {
        const children = Array.from(container.children);
        if (children.length >= 3) {
          // Check if children have SKU-like text
          const hasSku = children.some(c => /[A-Z]{2,}\d{2,}/.test(c.textContent));
          if (hasSku) {
            cards = children;
            break;
          }
        }
      }
    }

    // Extract data from each card
    for (const card of cards) {
      const text = card.textContent || '';

      // Extract SKU — pattern like CT76RCT1224MTJ1 or DA-CT76RCT1224MTJ1
      const skuMatch = text.match(/\b([A-Z]{1,4}[\d-][A-Z0-9]{5,})\b/);

      // Extract price — "$1.84 /SF" or "$32.44 /EA" or "$1.84/SF"
      const priceMatch = text.match(/\$\s*([\d,]+\.?\d*)\s*\/?\s*(SF|EA|SQ\s*FT|SQFT|PC|PIECE)/i);

      // Extract stock qty — "5,332.79 / SF In Stock" or "60.80 / EA In Stock"
      const stockMatch = text.match(/([\d,]+\.?\d*)\s*\/?\s*(SF|EA|SQ\s*FT|SQFT|PC|PIECE)\s*(?:In\s*Stock|Available)/i);

      // Extract name — try headings or bold elements first
      const nameEl = card.querySelector('h1, h2, h3, h4, h5, [class*="name"], [class*="title"]');
      const name = nameEl ? nameEl.textContent.trim() : null;

      // Extract description
      const descEl = card.querySelector('[class*="desc"], [class*="detail"], p');
      const description = descEl ? descEl.textContent.trim() : null;

      // Check for in-stock indicator
      const inStock = text.toLowerCase().includes('in stock') ||
                      card.querySelector('[class*="check"], .slds-icon-utility-check, svg[data-key="check"]') !== null;

      if (skuMatch || priceMatch || stockMatch) {
        results.push({
          sku: skuMatch ? skuMatch[1] : null,
          name: name || null,
          description: description || null,
          price: priceMatch ? parseFloat(priceMatch[1].replace(/,/g, '')) : null,
          priceUnit: priceMatch ? priceMatch[2].toUpperCase().replace(/\s+/g, '') : null,
          stockQty: stockMatch ? parseFloat(stockMatch[1].replace(/,/g, '')) : null,
          stockUnit: stockMatch ? stockMatch[2].toUpperCase().replace(/\s+/g, '') : null,
          inStock
        });
      }
    }

    return results;
  });
}

/**
 * Try to load more products via "Load More" button, pagination link, or scrolling.
 * Returns true if an action was taken, false if no more loading is possible.
 */
async function loadMoreProducts(page) {
  // Strategy 1: Click "Load More" / "Show More" / "View More" button
  const clickedLoadMore = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button, a, [role="button"]'));
    const loadMore = buttons.find(el => {
      const text = el.textContent.trim().toLowerCase();
      return (
        text.includes('load more') ||
        text.includes('show more') ||
        text.includes('view more') ||
        text.includes('see more') ||
        text === 'more'
      ) && el.offsetParent !== null; // visible
    });
    if (loadMore) {
      loadMore.click();
      return true;
    }
    return false;
  });

  if (clickedLoadMore) return true;

  // Strategy 2: Click "Next" / pagination arrow
  const clickedNext = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button, a, [role="button"]'));
    const next = buttons.find(el => {
      const text = el.textContent.trim().toLowerCase();
      const label = (el.getAttribute('aria-label') || '').toLowerCase();
      return (
        text === 'next' || text === '›' || text === '>' || text === '>>' ||
        label.includes('next')
      ) && el.offsetParent !== null && !el.disabled;
    });
    if (next) {
      next.click();
      return true;
    }
    return false;
  });

  if (clickedNext) return true;

  // Strategy 3: Scroll to bottom (for infinite scroll)
  const prevHeight = await page.evaluate(() => window.__prevScrollHeight || document.body.scrollHeight);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));

  // Wait a bit for new content to load after scroll
  await delay(3000);

  const newHeight = await page.evaluate(() => document.body.scrollHeight);
  // Cache current height for next comparison
  await page.evaluate((h) => { window.__prevScrollHeight = h; }, newHeight);

  return newHeight > prevHeight;
}

/**
 * Discovery mode: log page structure details for debugging.
 */
async function discoverPageStructure(page, pool, job) {
  const structure = await page.evaluate(() => {
    const info = {};

    // Count elements by type
    info.links = document.querySelectorAll('a[href]').length;
    info.buttons = document.querySelectorAll('button').length;
    info.inputs = document.querySelectorAll('input').length;
    info.forms = document.querySelectorAll('form').length;

    // Find navigation elements
    info.navLinks = Array.from(document.querySelectorAll('nav a, header a, [class*="nav"] a')).map(a => ({
      text: a.textContent.trim().slice(0, 60),
      href: a.href
    })).filter(l => l.text);

    // Find elements with inventory/stock/product keywords
    const bodyText = document.body.innerText.toLowerCase();
    info.hasProductKeyword = bodyText.includes('product');
    info.hasInventoryKeyword = bodyText.includes('inventory') || bodyText.includes('stock');
    info.hasSearchKeyword = bodyText.includes('search');

    // Header/account text
    const headerEl = document.querySelector('header, [class*="header"]');
    info.headerText = headerEl ? headerEl.textContent.trim().slice(0, 200) : '(no header found)';

    return info;
  });

  await appendLog(pool, job.id, `Page structure: ${JSON.stringify(structure, null, 2)}`);
}
