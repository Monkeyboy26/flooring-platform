#!/usr/bin/env node

/**
 * Ottimo Ceramics — Stock Check Scraper
 *
 * Source: https://ottimostockcheck.netlify.app
 *   Static page with embedded ALL_DATA JSON array containing live inventory.
 *
 * Tile quantities are shown by full carton → multiplied by sqft_per_box.
 * Mosaic quantities are shown by piece → stored as-is.
 *
 * Usage: docker compose exec api node scrapers/ottimo-stockcheck.js
 */

import pg from 'pg';
import { upsertInventorySnapshot, appendLog, addJobError } from './base.js';

const STOCK_URL = 'https://ottimostockcheck.netlify.app';
const WAREHOUSE = 'Ottimo';
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

/** Categories from the stock check site that represent mosaics (qty = pieces, not cartons). */
const MOSAIC_CATEGORIES = new Set([
  '1. Tile / Glass Mosaic',
  '6. Stone Mosaic Tiles',
  '7. Mosaic Tiles',
  '8. Glass Tile',
]);

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: 5432, database: 'flooring_pim', user: 'postgres', password: 'postgres',
});

// ─── Fetch & parse stock data ────────────────────────────────────────────────

async function fetchStockData() {
  const resp = await fetch(STOCK_URL, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(30000),
  });

  if (!resp.ok) throw new Error(`Stock page returned ${resp.status}`);
  const html = await resp.text();

  // Extract ALL_DATA=[...] from the embedded script
  const match = html.match(/const\s+ALL_DATA\s*=\s*(\[[\s\S]*?\]);/);
  if (!match) throw new Error('Could not find ALL_DATA in page source');

  const data = JSON.parse(match[1]);
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error(`ALL_DATA parsed but empty or not an array`);
  }

  return data;
}

// ─── Fuzzy SKU matching ──────────────────────────────────────────────────────

/**
 * Stock feed SKUs often carry suffixes not present in the Shopify catalog:
 *   -N   size variant        (RH010-10 → RH010)
 *   BN   bullnose trim       (AVG11BN  → AVG11)
 *   SP   special/spanish     (FAS002SP → FAS002)
 *   NI   non-iridescent      (PDM01NI  → PDM01)
 *   R    rectified edge      (HR2601R  → HR2601)
 *
 * Try each transform in order; first DB hit wins.
 */
const FUZZY_TRANSFORMS = [
  { label: 'dash-suffix', fn: s => s.replace(/-\d+$/, '') },
  { label: 'BN-suffix',   fn: s => s.replace(/BN$/, '') },
  { label: 'SP-suffix',   fn: s => s.replace(/SP$/, '') },
  { label: 'NI-suffix',   fn: s => s.replace(/NI$/, '') },
  { label: 'R-suffix',    fn: s => s.replace(/R$/, '') },
  { label: 'N-suffix',    fn: s => s.replace(/N$/, '') },
];

function fuzzyLookup(sku, skuMap) {
  for (const t of FUZZY_TRANSFORMS) {
    const candidate = t.fn(sku);
    if (candidate !== sku && candidate.length > 0 && skuMap.has(candidate)) {
      return { match: skuMap.get(candidate), via: t.label };
    }
  }
  return null;
}

// ─── Core scrape logic ──────────────────────────────────────────────────────

async function runStockCheck(pool, jobId, log) {
  const stats = { dbSkus: 0, stockItems: 0, updated: 0, fuzzyMatched: 0, noMatch: 0, errors: 0 };

  // Phase 1: Load all Ottimo SKUs from DB with packaging data
  log('Phase 1: Loading Ottimo SKUs from database...');
  const skuResult = await pool.query(`
    SELECT s.id AS sku_id, s.vendor_sku, s.sell_by, pkg.sqft_per_box
    FROM skus s
    JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id
    LEFT JOIN packaging pkg ON pkg.sku_id = s.id
    WHERE v.code = 'OTTIMO' AND s.vendor_sku IS NOT NULL AND s.status = 'active'
  `);

  const skuLookup = new Map();
  for (const row of skuResult.rows) {
    skuLookup.set(row.vendor_sku.toUpperCase(), {
      skuId: row.sku_id,
      sellBy: row.sell_by,
      sqftPerBox: row.sqft_per_box ? parseFloat(row.sqft_per_box) : null,
    });
  }
  stats.dbSkus = skuLookup.size;
  log(`  Loaded ${skuLookup.size} Ottimo SKUs`);

  if (skuLookup.size === 0) {
    log('No Ottimo SKUs found — run the Ottimo catalog scraper first.');
    return stats;
  }

  // Phase 2: Fetch stock data from Netlify
  log('Phase 2: Fetching stock data from ottimostockcheck.netlify.app...');
  const stockData = await fetchStockData();
  stats.stockItems = stockData.length;
  log(`  ${stockData.length} items in stock feed`);

  // Phase 3: Match & upsert inventory
  log('Phase 3: Matching SKUs and updating inventory...');
  const unmatchedSamples = [];
  const fuzzyByType = {};

  for (const item of stockData) {
    const vendorSku = (item.sku || '').trim().toUpperCase();
    if (!vendorSku || /^\d+$/.test(vendorSku)) continue; // skip junk/category rows

    // Exact match first, then fuzzy
    let match = skuLookup.get(vendorSku);
    if (!match) {
      const fuzzy = fuzzyLookup(vendorSku, skuLookup);
      if (fuzzy) {
        match = fuzzy.match;
        stats.fuzzyMatched++;
        fuzzyByType[fuzzy.via] = (fuzzyByType[fuzzy.via] || 0) + 1;
      }
    }

    if (!match) {
      stats.noMatch++;
      if (unmatchedSamples.length < 20) unmatchedSamples.push(item.sku);
      continue;
    }

    const onHand = parseInt(item.on_hand, 10) || 0;
    const isMosaic = MOSAIC_CATEGORIES.has(item.category);

    // Tiles: on_hand is cartons → convert to sqft using packaging
    // Mosaics: on_hand is pieces → store directly
    let qtySqft;
    if (isMosaic) {
      qtySqft = Math.max(onHand, 0);
    } else {
      // Tile cartons — convert to sqft if we have packaging data
      if (match.sqftPerBox && onHand > 0) {
        qtySqft = Math.round(onHand * match.sqftPerBox);
      } else {
        // No packaging data — store carton count directly as a rough proxy
        qtySqft = Math.max(onHand, 0);
      }
    }

    try {
      await upsertInventorySnapshot(pool, match.skuId, WAREHOUSE, {
        qty_on_hand_sqft: qtySqft,
        qty_in_transit_sqft: 0,
      });
      stats.updated++;
    } catch (err) {
      stats.errors++;
      if (stats.errors <= 5) log(`  Error updating ${item.sku}: ${err.message}`);
    }
  }

  if (stats.fuzzyMatched > 0) {
    const breakdown = Object.entries(fuzzyByType).map(([k, v]) => `${k}:${v}`).join(', ');
    log(`  Fuzzy matched: ${stats.fuzzyMatched} (${breakdown})`);
  }
  if (unmatchedSamples.length > 0) {
    log(`  Unmatched samples: ${unmatchedSamples.join(', ')}`);
  }

  return stats;
}

// ─── Standalone entry point ──────────────────────────────────────────────────

async function main() {
  console.log('Ottimo Ceramics — Stock Check Scraper');
  console.log('─'.repeat(40));

  // Create a minimal job record for logging
  const jobResult = await pool.query(`
    INSERT INTO scrape_jobs (vendor_source_id, status, log, errors)
    VALUES (
      (SELECT id FROM vendor_sources WHERE vendor_id = (SELECT id FROM vendors WHERE code = 'OTTIMO') LIMIT 1),
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
    const stats = await runStockCheck(pool, jobId, log);

    log('');
    log('═══════════════════════════════════════════');
    log('  SUMMARY');
    log('═══════════════════════════════════════════');
    log(`  DB SKUs loaded:      ${stats.dbSkus}`);
    log(`  Stock feed items:    ${stats.stockItems}`);
    log(`  Matched & updated:   ${stats.updated} (${stats.fuzzyMatched} fuzzy)`);
    log(`  No DB match:         ${stats.noMatch}`);
    log(`  Errors:              ${stats.errors}`);
    log('═══════════════════════════════════════════');

    if (jobId) {
      await pool.query(
        `UPDATE scrape_jobs SET status = 'completed', products_found = $2, products_updated = $3 WHERE id = $1`,
        [jobId, stats.stockItems, stats.updated],
      );
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

// Also export run() for the job runner in server.js
export async function run(pool, job, source) {
  const log = (msg) => {
    console.log(msg);
    appendLog(pool, job.id, msg).catch(() => {});
  };

  try {
    const stats = await runStockCheck(pool, job.id, log);

    log(`\nStock check complete: ${stats.updated} updated, ${stats.noMatch} unmatched, ${stats.errors} errors`);

    await pool.query(
      `UPDATE scrape_jobs SET products_found = $2, products_updated = $3 WHERE id = $1`,
      [job.id, stats.stockItems, stats.updated],
    );
  } catch (err) {
    await addJobError(pool, job.id, err.message).catch(() => {});
    throw err;
  }
}

main().catch(err => { console.error(err); process.exit(1); });
