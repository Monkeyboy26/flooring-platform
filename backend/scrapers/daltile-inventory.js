import pg from 'pg';
import { launchBrowser, delay, appendLog, addJobError, upsertInventorySnapshot } from './base.js';
import { portalLogin, waitForSPA } from './tradepro-auth.js';
import { buildActiveIndex, crosswalkItem } from './daltile-crosswalk.js';

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
          fieldsToInclude: ['sku', 'inventoryitems', 'uom', 'brandid', 'color', 'colornameenglish', 'nominalsize', 'finish', 'seriesname', 'classprices', 'skudescription', 'shapeandmosaic', 'planproducttype'],
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

    // ── Step 5: Match portal items to DB SKUs ──
    // Daltile runs two code families for the same physical item: the portal /
    // Coveo "sales SKU" (e.g. 019036MOD1P4, on our draft rows from the old
    // portal catalog scraper) and the EDI 832 item code (e.g. 0190S4639MODGL,
    // on the ACTIVE storefront rows). Exact code match alone therefore parks
    // nearly all stock on unpublished twins. The attribute crosswalk lives in
    // daltile-crosswalk.js (shared with the offline _match-diag.js replay).
    const activeResult = await pool.query(`
      SELECT s.id, s.vendor_sku, s.variant_type, p.collection, p.name AS product_name,
             pkg.sqft_per_box, pr.cost,
             MAX(CASE WHEN a.name = 'Size' THEN sa.value END) AS size,
             MAX(CASE WHEN a.name = 'Finish' THEN sa.value END) AS finish,
             MAX(CASE WHEN a.name = 'Shape' THEN sa.value END) AS shape
      FROM skus s
      JOIN products p ON p.id = s.product_id
      JOIN vendors v ON v.id = p.vendor_id
      LEFT JOIN packaging pkg ON pkg.sku_id = s.id
      LEFT JOIN pricing pr ON pr.sku_id = s.id
      LEFT JOIN sku_attributes sa ON sa.sku_id = s.id
      LEFT JOIN attributes a ON a.id = sa.attribute_id AND a.name IN ('Size', 'Finish', 'Shape')
      WHERE v.code IN ('DAL', 'AO', 'MZ') AND p.status = 'active' AND s.status = 'active'
        AND s.vendor_sku IS NOT NULL
      GROUP BY s.id, s.vendor_sku, s.variant_type, p.collection, p.name, pkg.sqft_per_box, pr.cost
    `);
    const activeIds = new Set(activeResult.rows.map(r => r.id));
    const aliasRows = skuResult.rows.filter(r => !activeIds.has(r.id));
    const activeIndex = buildActiveIndex(activeResult.rows, aliasRows);
    await appendLog(pool, job.id, `Attribute index: ${activeResult.rows.length} active SKUs across ${activeIndex.bySize.size} sizes, ${aliasRows.length} alias rows`);

    const toSqft = (item, sqftPerBox) => {
      let qty = parseFloat(item.inventoryitems) || 0;
      // Non-SF items report units; convert via packaging like the DOM scraper did
      if (item.uom && item.uom !== 'SF' && item.uom !== 'SQFT') {
        const spb = parseFloat(sqftPerBox);
        if (spb > 0) qty = qty * spb;
      }
      return qty < 1 ? 0 : qty;
    };

    const qtyBySkuId = new Map();
    const addQty = (skuId, sqft) => qtyBySkuId.set(skuId, (qtyBySkuId.get(skuId) || 0) + sqft);

    let exactMatched = 0;
    let crosswalked = 0;
    let ambiguous = 0;
    let totalUnmatched = 0;
    const cwStats = {};

    for (const item of stockItems) {
      const rawSku = (item.sku || '').toUpperCase();
      if (!rawSku) continue;

      const exact = skuMap.get(rawSku) || skuMap.get(rawSku.replace(/[-\s]/g, ''));
      if (exact) {
        exactMatched++;
        addQty(exact.id, toSqft(item, exact.sqft_per_box));
      }

      // Attribute crosswalk to an active twin (skip if exact already hit it)
      const res = crosswalkItem(item, activeIndex, cwStats);
      if (res.state === 'matched') {
        let counted = false;
        for (const { row, share } of res.matches) {
          if (exact && row.id === exact.id) continue;
          addQty(row.id, toSqft(item, row.sqft_per_box) * share);
          counted = true;
        }
        if (counted) crosswalked++;
      } else if (res.state === 'ambiguous') {
        ambiguous++;
        if (ambiguous <= 10) {
          await appendLog(pool, job.id, `  Ambiguous crosswalk: ${item.sku} → ${res.candidates.map(c => c.vendor_sku).join(', ')}`);
        }
      } else if (!exact) {
        totalUnmatched++;
        if (totalUnmatched <= 20) {
          await appendLog(pool, job.id, `  Unmatched: ${item.sku} (qty: ${item.inventoryitems} ${item.uom || '?'})`);
        }
      }
    }
    await appendLog(pool, job.id, `Crosswalk signals: ${JSON.stringify(cwStats)}`);

    // ── Step 6: Write aggregated quantities ──
    let totalUpserted = 0;
    for (const [skuId, sqft] of qtyBySkuId) {
      try {
        await upsertInventorySnapshot(pool, skuId, WAREHOUSE, {
          qty_on_hand_sqft: Math.round(sqft),
          qty_in_transit_sqft: 0,
        });
        totalUpserted++;
      } catch (err) {
        await addJobError(pool, job.id, `Inventory upsert failed for sku ${skuId}: ${err.message}`);
      }
    }

    await appendLog(pool, job.id,
      `Complete. In-stock items: ${stockItems.length}, Exact: ${exactMatched}, ` +
      `Crosswalked to active: ${crosswalked}, Ambiguous: ${ambiguous}, Unmatched: ${totalUnmatched}, ` +
      `SKUs written: ${totalUpserted}, Zero-filled: ${zeroFill.rowCount}`,
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
