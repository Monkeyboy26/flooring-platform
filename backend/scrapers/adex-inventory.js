#!/usr/bin/env node

/**
 * ADEX USA Dealer Portal — Inventory Scraper.
 *
 * Logs into portal.adexusawest.com (WordPress + WooCommerce B2B),
 * reads stock data, and updates inventory_snapshots so the storefront
 * can display stock status for ADEX products.
 *
 * Strategy (in order):
 *   A. Authenticated WooCommerce Store API with WP nonce — fast, structured JSON
 *   B. Product page HTML scraping — fallback if API doesn't expose quantities
 *   C. Boolean stock (in_stock = 999, out_of_stock = 0) — last resort
 *
 * Usage:
 *   docker compose exec api node scrapers/adex-inventory.js [--cookies]
 *
 *   --cookies  Use ADEX_COOKIES env var instead of Puppeteer login
 */

import pg from 'pg';
import { delay, upsertInventorySnapshot, appendLog, addJobError } from './base.js';
import { adexLogin, adexLoginFromCookies, adexFetch, BASE_URL } from './adex-auth.js';

const WAREHOUSE = 'ADEX USA West';
const DELAY_MS = 300;
const STORE_API_PER_PAGE = 100;

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: 5432,
  database: 'flooring_pim',
  user: 'postgres',
  password: 'postgres',
});

// ─── Standalone entry point ──────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const useCookies = args.includes('--cookies');

  console.log('ADEX USA Inventory Scraper');
  console.log('─'.repeat(40));

  // Create a minimal job record for logging
  const jobResult = await pool.query(`
    INSERT INTO scrape_jobs (vendor_source_id, status, log, errors)
    VALUES (
      (SELECT id FROM vendor_sources WHERE vendor_id = (SELECT id FROM vendors WHERE code = 'ADEX') LIMIT 1),
      'running',
      '',
      '[]'::jsonb
    )
    RETURNING id
  `).catch(() => null);

  const jobId = jobResult?.rows?.[0]?.id || null;
  const log = (msg) => {
    console.log(msg);
    if (jobId) appendLog(pool, jobId, msg).catch(() => {});
  };

  try {
    const stats = await runInventoryScrape(pool, jobId, log, useCookies);

    log(`\n=== ADEX Inventory Scrape Complete ===`);
    log(`DB SKUs loaded:    ${stats.dbSkus}`);
    log(`API products:      ${stats.apiProducts}`);
    log(`Matched & updated: ${stats.updated}`);
    log(`No DB match:       ${stats.noMatch}`);
    log(`Errors:            ${stats.errors}`);

    if (jobId) {
      await pool.query(`UPDATE scrape_jobs SET status = 'completed', products_found = $2, products_updated = $3 WHERE id = $1`,
        [jobId, stats.apiProducts, stats.updated]);
    }
  } catch (err) {
    console.error('Fatal error:', err);
    if (jobId) {
      await addJobError(pool, jobId, err.message).catch(() => {});
      await pool.query(`UPDATE scrape_jobs SET status = 'failed' WHERE id = $1`, [jobId]).catch(() => {});
    }
    process.exit(1);
  } finally {
    await pool.end();
  }
}

// ─── Core scrape logic (can also be called from job runner) ──────────────────

async function runInventoryScrape(pool, jobId, log, useCookies) {
  const stats = { dbSkus: 0, apiProducts: 0, updated: 0, noMatch: 0, errors: 0 };

  // Phase 1: Load all ADEX SKUs from DB
  log('Phase 1: Loading ADEX SKUs from database...');
  const skuResult = await pool.query(`
    SELECT s.id AS sku_id, s.vendor_sku, pkg.sqft_per_box
    FROM skus s
    JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id
    LEFT JOIN packaging pkg ON pkg.sku_id = s.id
    WHERE v.code = 'ADEX' AND s.vendor_sku IS NOT NULL AND s.status = 'active'
  `);

  const skuLookup = new Map();
  for (const row of skuResult.rows) {
    skuLookup.set(row.vendor_sku.toUpperCase(), {
      skuId: row.sku_id,
      sqftPerBox: row.sqft_per_box ? parseFloat(row.sqft_per_box) : null,
    });
  }
  stats.dbSkus = skuLookup.size;
  log(`Loaded ${skuLookup.size} ADEX SKUs`);

  if (skuLookup.size === 0) {
    log('No ADEX SKUs found — run the ADEX import script first.');
    return stats;
  }

  // Phase 2: Authenticate
  log('Phase 2: Authenticating...');
  let cookies;
  if (useCookies || process.env.ADEX_COOKIES) {
    cookies = await adexLoginFromCookies(pool, jobId);
  } else {
    cookies = await adexLogin(pool, jobId);
  }

  // Phase 3: Try authenticated Store API first (Approach A)
  log('Phase 3: Fetching inventory data...');
  let apiSuccess = false;

  try {
    apiSuccess = await tryStoreApi(pool, jobId, log, cookies, skuLookup, stats);
  } catch (err) {
    log(`Store API approach failed: ${err.message} — falling back to HTML scraping`);
  }

  // If API didn't yield quantity data, fall back to HTML scraping (Approach B)
  if (!apiSuccess) {
    try {
      await tryHtmlScraping(pool, jobId, log, cookies, skuLookup, stats);
    } catch (err) {
      log(`HTML scraping failed: ${err.message}`);
      stats.errors++;
    }
  }

  return stats;
}

// ─── Approach A: Authenticated WooCommerce Store API ─────────────────────────

async function tryStoreApi(pool, jobId, log, cookies, skuLookup, stats) {
  // First, extract the WP REST nonce from a page load
  log('  Attempting Store API with WP nonce...');
  const pageResp = await adexFetch('/shop/', cookies);
  const pageHtml = await pageResp.text();

  // WooCommerce stores the nonce in various places
  const nonceMatch = pageHtml.match(/["']nonce["']\s*:\s*["']([a-f0-9]+)["']/) ||
                     pageHtml.match(/wp_rest['"]\s*:\s*['"]([\w]+)['"]/) ||
                     pageHtml.match(/wcStoreApiNonce["']\s*:\s*["']([^"']+)["']/);

  const nonce = nonceMatch ? nonceMatch[1] : null;
  if (nonce) {
    log(`  Found WP nonce: ${nonce.slice(0, 8)}...`);
  } else {
    log('  No WP nonce found — trying API without nonce...');
  }

  // Paginate through Store API
  let page = 1;
  let hasQuantityData = false;
  let totalProcessed = 0;

  while (true) {
    const apiUrl = `/wp-json/wc/store/v1/products?per_page=${STORE_API_PER_PAGE}&page=${page}`;
    const headers = { 'Accept': 'application/json' };
    if (nonce) headers['X-WP-Nonce'] = nonce;

    const resp = await adexFetch(apiUrl, cookies, { headers });

    if (!resp.ok) {
      if (page === 1) {
        log(`  Store API returned ${resp.status} — not available`);
        return false;
      }
      break;
    }

    let products;
    try {
      products = await resp.json();
    } catch {
      log('  Store API returned non-JSON — not available');
      return false;
    }

    if (!Array.isArray(products) || products.length === 0) break;

    for (const product of products) {
      stats.apiProducts++;

      // Extract SKU — could be on the product or its variations
      const skusToCheck = [];
      if (product.sku) skusToCheck.push(product.sku);

      // Some WooCommerce setups nest variations
      if (product.variations && Array.isArray(product.variations)) {
        for (const v of product.variations) {
          if (v.sku) skusToCheck.push(v.sku);
        }
      }

      for (const vendorSku of skusToCheck) {
        const match = skuLookup.get(vendorSku.toUpperCase());
        if (!match) {
          stats.noMatch++;
          continue;
        }

        // Check if API exposes actual quantities
        const stockQty = product.stock_quantity ?? product.low_stock_remaining ?? null;
        const isInStock = product.is_in_stock ?? true;

        let qty;
        if (stockQty !== null && stockQty !== undefined) {
          // Real quantity data available
          hasQuantityData = true;
          qty = parseFloat(stockQty) || 0;
          // Convert cartons to sqft if packaging data available
          if (match.sqftPerBox && qty > 0 && qty < 10000) {
            qty = qty * match.sqftPerBox;
          }
        } else {
          // Boolean only
          qty = isInStock ? 999 : 0;
        }

        await upsertInventorySnapshot(pool, match.skuId, WAREHOUSE, {
          qty_on_hand_sqft: qty,
          qty_in_transit_sqft: 0,
        });
        stats.updated++;
        totalProcessed++;
      }
    }

    // Check for next page via total pages header
    const totalPages = parseInt(resp.headers.get('x-wp-totalpages'), 10) || 999;
    if (page >= totalPages) break;

    page++;
    await delay(DELAY_MS);
  }

  if (totalProcessed > 0) {
    log(`  Store API: processed ${totalProcessed} SKUs across ${page} pages` +
        (hasQuantityData ? ' (with quantities)' : ' (boolean stock only)'));
    return true;
  }

  log('  Store API: no matching SKUs found — falling back');
  return false;
}

// ─── Approach B: HTML scraping of shop/product pages ─────────────────────────

async function tryHtmlScraping(pool, jobId, log, cookies, skuLookup, stats) {
  log('  Falling back to HTML scraping...');

  // Paginate through /shop/ pages
  let page = 1;
  let hasMore = true;
  let totalProcessed = 0;

  while (hasMore) {
    const shopUrl = page === 1 ? '/shop/' : `/shop/page/${page}/`;
    const resp = await adexFetch(shopUrl, cookies);

    if (!resp.ok) {
      if (page === 1) log(`  Shop page returned ${resp.status}`);
      break;
    }

    const html = await resp.text();

    // Extract product links from shop listing
    const productLinks = extractProductLinks(html);
    if (productLinks.length === 0) {
      hasMore = false;
      break;
    }

    log(`  Shop page ${page}: ${productLinks.length} products`);

    // Visit each product page to extract SKU + stock info
    for (const link of productLinks) {
      try {
        const prodResp = await adexFetch(link, cookies);
        if (!prodResp.ok) continue;

        const prodHtml = await prodResp.text();
        const stockEntries = extractStockFromProductPage(prodHtml);

        for (const entry of stockEntries) {
          const match = skuLookup.get(entry.sku.toUpperCase());
          if (!match) {
            stats.noMatch++;
            continue;
          }

          let qty = entry.qty;
          // Convert cartons to sqft if needed
          if (match.sqftPerBox && qty > 0 && qty < 10000 && entry.isCartons) {
            qty = qty * match.sqftPerBox;
          }

          await upsertInventorySnapshot(pool, match.skuId, WAREHOUSE, {
            qty_on_hand_sqft: qty,
            qty_in_transit_sqft: 0,
          });
          stats.updated++;
          totalProcessed++;
        }
      } catch (err) {
        stats.errors++;
        if (stats.errors <= 20 && jobId) {
          await addJobError(pool, jobId, `Product ${link}: ${err.message}`).catch(() => {});
        }
      }

      await delay(DELAY_MS);
    }

    // Check if there's a next page
    hasMore = html.includes(`/shop/page/${page + 1}/`) || html.includes(`paged=${page + 1}`);
    page++;
    await delay(DELAY_MS);
  }

  log(`  HTML scraping: processed ${totalProcessed} SKUs across ${page - 1} pages`);
}

// ─── HTML Parsers ────────────────────────────────────────────────────────────

/**
 * Extract product page URLs from a WooCommerce shop listing page.
 */
function extractProductLinks(html) {
  const links = new Set();
  // WooCommerce product links in listing
  const re = /href=["'](https?:\/\/portal\.adexusawest\.com\/product\/[^"'\s]+)["']/gi;
  let m;
  while ((m = re.exec(html))) {
    links.add(m[1]);
  }
  // Also try relative URLs
  const reRel = /href=["'](\/product\/[^"'\s]+)["']/gi;
  while ((m = reRel.exec(html))) {
    links.add(`${BASE_URL}${m[1]}`);
  }
  return [...links];
}

/**
 * Extract SKU + stock info from a WooCommerce product detail page.
 * Returns array of { sku, qty, isCartons } entries.
 *
 * WooCommerce B2B themes typically show stock in formats like:
 *   - "X in stock"
 *   - "Available: X"
 *   - "Stock: X"
 *   - data-stock_quantity="X" in variation JSON
 */
function extractStockFromProductPage(html) {
  const entries = [];
  const seen = new Set();

  // Strategy 1: Parse WooCommerce variation JSON (most reliable)
  // WooCommerce outputs: var product_variations = [...] with sku + stock_quantity
  const varJsonMatch = html.match(/var\s+product_variations\s*=\s*(\[[\s\S]*?\]);/);
  if (varJsonMatch) {
    try {
      const variations = JSON.parse(varJsonMatch[1]);
      for (const v of variations) {
        if (v.sku && !seen.has(v.sku)) {
          seen.add(v.sku);
          const qty = v.stock_quantity != null
            ? (parseFloat(v.stock_quantity) || 0)
            : (v.is_in_stock ? 999 : 0);
          entries.push({ sku: v.sku, qty, isCartons: false });
        }
      }
    } catch { /* ignore parse errors */ }
  }

  // Strategy 2: Parse WooCommerce structured data (JSON-LD)
  const jsonLdMatches = html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const jm of jsonLdMatches) {
    try {
      const data = JSON.parse(jm[1]);
      const offers = data.offers || (data['@graph'] || []).flatMap(g => g.offers || []);
      const offerList = Array.isArray(offers) ? offers : [offers];
      for (const offer of offerList) {
        if (offer.sku && !seen.has(offer.sku)) {
          seen.add(offer.sku);
          const inStock = offer.availability && offer.availability.includes('InStock');
          entries.push({ sku: offer.sku, qty: inStock ? 999 : 0, isCartons: false });
        }
      }
    } catch { /* ignore */ }
  }

  // Strategy 3: Single product SKU + stock text
  if (entries.length === 0) {
    // WooCommerce single product SKU
    const skuMatch = html.match(/class=["']sku["'][^>]*>([^<]+)</) ||
                     html.match(/"sku"\s*:\s*"([^"]+)"/);
    if (skuMatch) {
      const sku = skuMatch[1].trim();
      if (sku && !seen.has(sku)) {
        seen.add(sku);

        // Look for stock quantity
        let qty = 0;
        const stockQtyMatch = html.match(/(\d+)\s+in\s+stock/i) ||
                               html.match(/stock[:\s]+(\d+)/i) ||
                               html.match(/available[:\s]+(\d+)/i) ||
                               html.match(/data-stock_quantity=["'](\d+)["']/);
        if (stockQtyMatch) {
          qty = parseInt(stockQtyMatch[1], 10);
        } else if (/class=["'][^"']*in-stock/i.test(html) || /in\s*stock/i.test(html)) {
          qty = 999; // In stock, unknown quantity
        }

        entries.push({ sku, qty, isCartons: false });
      }
    }
  }

  return entries;
}

// ─── Job runner export (for integration with scrape_sources) ─────────────────

export async function run(pool, job, source) {
  const config = source.config || {};
  const useCookies = !!process.env.ADEX_COOKIES;

  const log = (msg) => appendLog(pool, job.id, msg);

  const stats = await runInventoryScrape(pool, job.id, log, useCookies);

  await appendLog(pool, job.id,
    `Inventory complete. SKUs: ${stats.dbSkus}, API products: ${stats.apiProducts}, ` +
    `Updated: ${stats.updated}, No match: ${stats.noMatch}, Errors: ${stats.errors}`,
    { products_found: stats.apiProducts, products_updated: stats.updated }
  );
}

// ─── Run standalone ──────────────────────────────────────────────────────────

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
