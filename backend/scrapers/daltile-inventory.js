import pg from 'pg';
import { launchBrowser, delay, appendLog, addJobError, upsertInventorySnapshot } from './base.js';
import { portalLogin, waitForSPA } from './tradepro-auth.js';

/**
 * Daltile inventory scraper — TradePro Exchange (Salesforce Experience Cloud).
 *
 * The portal's product list is backed by Coveo search (Mohawk's org). The DOM
 * cannot be crawled past ~5,000 of 40k+ results (server-side pagination cap:
 * pages beyond that repeat the final 8 records), so this scraper skips the DOM
 * entirely:
 *
 *   1. Puppeteer login, load the products page once, and intercept the Coveo
 *      access token the page mints via aura ApexAction (JWT, ~24h TTL).
 *      Then the browser closes — total browser time is ~1 minute.
 *   2. Query Coveo REST directly for `@inventoryitems>0` — only ~1,400 items
 *      carry stock at the local SSC, so a few 500-row pages cover everything.
 *      `inventoryitems` is the on-hand quantity in the item's `uom` (SF/EA).
 *   3. Zero-fill snapshots for every tracked DAL/AO/MZ SKU in one bulk
 *      statement, then write real quantities for the in-stock set.
 *
 * The Coveo offset cap (~5,000, error `RequestedResultsMax`) still applies,
 * so if the in-stock set ever grows past ~4,500 the fetch partitions by brand.
 *
 * User rule: if available sqft < 1, treat as out of stock (qty = 0).
 *
 * Standalone: docker compose exec api node scrapers/daltile-inventory.js
 * Scheduler: export { run } called by the job runner
 */

const BASE_URL = 'https://www.tradeproexchange.com';
const PRODUCTS_PATH = '/s/products#tab=All';
const COVEO_URL = 'https://mohawkindustriesproductionwwrtu1cs.org.coveo.com/rest/search/v2?organizationId=mohawkindustriesproductionwwrtu1cs';
const SEARCH_HUB = 'SSC_ProExchange_CatalogSearch';
const BRAND_FILTER = '@brandid==(AO,DB,MZ)';
const PAGE_SIZE = 500;
const OFFSET_SAFE_LIMIT = 4500;
const WAREHOUSE = 'TradePro';

// ─── Exported run() for scheduler ────────────────────────────────────────────

export async function run(pool, job) {
  let browser = null;

  try {
    // ── Step 1: Load all DAL/AO/MZ SKUs from DB ──
    const skuResult = await pool.query(`
      SELECT s.id, s.vendor_sku, pkg.sqft_per_box
      FROM skus s
      JOIN products p ON p.id = s.product_id
      JOIN vendors v ON v.id = p.vendor_id
      LEFT JOIN packaging pkg ON pkg.sku_id = s.id
      WHERE v.code IN ('DAL', 'AO', 'MZ') AND s.vendor_sku IS NOT NULL
    `);

    const skuMap = new Map();
    for (const row of skuResult.rows) {
      skuMap.set(row.vendor_sku.toUpperCase(), row);
      const normalized = row.vendor_sku.replace(/[-\s]/g, '').toUpperCase();
      if (!skuMap.has(normalized)) skuMap.set(normalized, row);
    }

    await appendLog(pool, job.id,
      `Loaded ${skuResult.rows.length} DAL/AO/MZ SKUs (${skuMap.size} lookup keys)`
    );

    // ── Step 2: Capture a Coveo access token via portal login ──
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    let coveoToken = null;
    page.on('response', async (resp) => {
      if (coveoToken || !resp.url().includes('/s/sfsites/aura')) return;
      try {
        const body = await resp.text();
        const m = body.match(/accessToken[^A-Za-z0-9]+([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/);
        if (m) coveoToken = m[1];
      } catch { /* response stream gone — another response will carry it */ }
    });

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await appendLog(pool, job.id, `Login attempt ${attempt}/3...`);
        await portalLogin(page, pool, job);
        break;
      } catch (err) {
        await addJobError(pool, job.id, `Login attempt ${attempt} failed: ${err.message}`);
        if (attempt === 3) throw new Error('All login attempts failed');
        await delay(attempt * 5000);
      }
    }

    await appendLog(pool, job.id, 'Loading products page to mint Coveo token...');
    await page.goto(`${BASE_URL}${PRODUCTS_PATH}`, { waitUntil: 'networkidle2', timeout: 60000 });
    await waitForSPA(page);

    for (let waited = 0; !coveoToken && waited < 60000; waited += 1000) await delay(1000);
    if (!coveoToken) throw new Error('Coveo access token not seen in aura traffic within 60s');

    await browser.close().catch(() => {});
    browser = null;
    await appendLog(pool, job.id, 'Coveo token captured; browser closed.');

    // ── Step 3: Fetch all in-stock items from Coveo ──
    const coveoQuery = async (aq, firstResult) => {
      const resp = await fetch(COVEO_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${coveoToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          aq,
          firstResult,
          numberOfResults: PAGE_SIZE,
          fieldsToInclude: ['sku', 'inventoryitems', 'uom', 'brandid'],
          searchHub: SEARCH_HUB,
        }),
      });
      if (!resp.ok) throw new Error(`Coveo query failed: HTTP ${resp.status} ${(await resp.text()).slice(0, 200)}`);
      const data = await resp.json();
      if (data.exception) throw new Error(`Coveo exception: ${JSON.stringify(data.exception)}`);
      return data;
    };

    const fetchAllPages = async (aq) => {
      const items = [];
      let total = Infinity;
      for (let offset = 0; offset < total; offset += PAGE_SIZE) {
        let data;
        try {
          data = await coveoQuery(aq, offset);
        } catch (err) {
          await appendLog(pool, job.id, `Retrying Coveo page at offset ${offset} (${err.message})`);
          await delay(3000);
          data = await coveoQuery(aq, offset);
        }
        total = data.totalCount;
        items.push(...data.results.map(r => r.raw));
        await delay(300);
      }
      return { items, total };
    };

    const inStockAq = `@inventoryitems>0 ${BRAND_FILTER}`;
    const probe = await coveoQuery(inStockAq, 0);
    await appendLog(pool, job.id, `Coveo reports ${probe.totalCount} in-stock items at local SSC`);

    let stockItems;
    if (probe.totalCount <= OFFSET_SAFE_LIMIT) {
      stockItems = (await fetchAllPages(inStockAq)).items;
    } else {
      // Offset cap territory — partition by brand to keep each set small
      stockItems = [];
      for (const brand of ['DB', 'AO', 'MZ']) {
        const { items, total } = await fetchAllPages(`@inventoryitems>0 @brandid==${brand}`);
        await appendLog(pool, job.id, `  ${brand}: ${items.length}/${total} in-stock items`);
        stockItems.push(...items);
      }
    }
    await appendLog(pool, job.id, `Fetched ${stockItems.length} in-stock items from Coveo`);

    // ── Step 4: Zero-fill all tracked SKUs, then write real quantities ──
    // Anything the SSC doesn't stock (or doesn't list) shows as 0 = special order.
    const zeroFill = await pool.query(`
      INSERT INTO inventory_snapshots
        (sku_id, warehouse, qty_on_hand, qty_in_transit, qty_on_hand_sqft, qty_in_transit_sqft, snapshot_time, fresh_until)
      SELECT s.id, $1, 0, 0, 0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + INTERVAL '24 hours'
      FROM skus s
      JOIN products p ON p.id = s.product_id
      JOIN vendors v ON v.id = p.vendor_id
      WHERE v.code IN ('DAL', 'AO', 'MZ') AND s.vendor_sku IS NOT NULL
      ON CONFLICT (sku_id, warehouse) DO UPDATE SET
        qty_on_hand = 0, qty_in_transit = 0, qty_on_hand_sqft = 0, qty_in_transit_sqft = 0,
        snapshot_time = CURRENT_TIMESTAMP, fresh_until = CURRENT_TIMESTAMP + INTERVAL '24 hours'
    `, [WAREHOUSE]);
    await appendLog(pool, job.id, `Zero-filled ${zeroFill.rowCount} snapshots`);

    let totalMatched = 0;
    let totalUnmatched = 0;
    let totalUpserted = 0;

    for (const item of stockItems) {
      const rawSku = (item.sku || '').toUpperCase();
      if (!rawSku) continue;
      const dbSku = skuMap.get(rawSku) || skuMap.get(rawSku.replace(/[-\s]/g, ''));

      if (!dbSku) {
        totalUnmatched++;
        if (totalUnmatched <= 20) {
          await appendLog(pool, job.id, `  Unmatched: ${item.sku} (qty: ${item.inventoryitems} ${item.uom || '?'})`);
        }
        continue;
      }
      totalMatched++;

      let qtySqft = parseFloat(item.inventoryitems) || 0;
      // Non-SF items report units; convert via packaging like the DOM scraper did
      if (item.uom && item.uom !== 'SF' && item.uom !== 'SQFT') {
        const sqftPerBox = parseFloat(dbSku.sqft_per_box);
        if (sqftPerBox > 0) qtySqft = qtySqft * sqftPerBox;
      }
      if (qtySqft < 1) qtySqft = 0;

      try {
        await upsertInventorySnapshot(pool, dbSku.id, WAREHOUSE, {
          qty_on_hand_sqft: Math.round(qtySqft),
          qty_in_transit_sqft: 0,
        });
        totalUpserted++;
      } catch (err) {
        await addJobError(pool, job.id, `Inventory upsert failed for ${item.sku}: ${err.message}`);
      }
    }

    await appendLog(pool, job.id,
      `Complete. In-stock items: ${stockItems.length}, Matched: ${totalMatched}, ` +
      `Upserted: ${totalUpserted}, Unmatched: ${totalUnmatched}, Zero-filled: ${zeroFill.rowCount}`,
      { products_found: stockItems.length, products_updated: totalUpserted, skus_affected: zeroFill.rowCount }
    );
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
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

  console.log(`Scrape job created: ${job.id}`);

  try {
    await run(pool, job);
    await pool.query(`UPDATE scrape_jobs SET status = 'completed', completed_at = now() WHERE id = $1`, [job.id]);
    console.log('Scrape completed successfully');
  } catch (err) {
    console.error('Scrape failed:', err.message);
    await pool.query(
      `UPDATE scrape_jobs SET status = 'failed', completed_at = now(), log = log || $2 WHERE id = $1`,
      [job.id, `\n[ERROR] ${err.message}\n`]
    );
  } finally {
    await pool.end();
  }
}

const isStandalone = process.argv[1] && (
  process.argv[1].endsWith('daltile-inventory.js') ||
  process.argv[1].includes('daltile-inventory')
);
if (isStandalone) main();
