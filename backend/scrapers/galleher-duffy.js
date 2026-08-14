/**
 * Galleher Duffy — daily price + inventory scraper.
 *
 * Refreshes dealer COST and warehouse INVENTORY for the five Galleher house brands
 * we carry (MONARCH, REWARD, GEM, PAL, AUD under vendor GALL) from the login-gated
 * Magento portal galleherduffy.com. Auth is a persistent logged-in Chrome profile
 * (see galleher-duffy-auth.js — reCAPTCHA blocks headless login). Dealer price +
 * Company Stock are injected client-side, so we drive the profile to render each
 * brand-filtered search page and parse the DOM (Product#, price, Company Stock).
 *
 * For each item matched to our SKU by vendor_sku (the Galleher item code):
 *   - cost → pricing.cost, retail recomputed at keystone x1.6 (retail_locked honored
 *     by upsertPricing; $0.00 tiles skipped so we never wipe a real cost)
 *   - Company Stock → inventory_snapshots (warehouse 'galleher', fresh_until +24h)
 *
 * Registered as a vendor_sources row with scraper_key 'galleher-duffy' + a daily cron;
 * the server's runScraper() creates the job and invokes run().
 */
import { appendLog, addJobError, upsertPricing, upsertInventorySnapshot } from './base.js';
import { openGalleher } from './galleher-duffy-auth.js';

const VENDOR_CODE = 'GALL';
const BRAND_CODES = ['MONARCH', 'REWARD', 'GEM', 'PAL', 'AUD'];
const WAREHOUSE = 'galleher'; // Galleher "Company Stock" = nationwide availability
const MAX_PAGES = 20;
const BASE = 'https://www.galleherduffy.com';

const BRAND_SEARCH = {
  MONARCH: '/catalogsearch/result/?q=Monarch+Plank&product_list_limit=36',
  REWARD: '/catalogsearch/result/index/?cat=2149&product_list_limit=36&q=Reward',
  GEM: '/catalogsearch/result/?q=Gemcore&product_list_limit=36',
  PAL: '/catalogsearch/result/index/?cat=608&product_list_limit=36&q=Palacio',
  AUD: '/catalogsearch/result/?q=Audacity&product_list_limit=36',
};

const normSku = (s) => (s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const keystone = (cost) => parseFloat((Math.round(cost * 1.6 / 0.05) * 0.05).toFixed(2));

// Parse the rendered search DOM → [{code, cost, unit, stock}]. Runs in the page.
function parseInPage() {
  return [...document.querySelectorAll('li.product-item')].map((el) => {
    const t = (el.innerText || '').replace(/\s+/g, ' ');
    const code = (t.match(/Product#\s*:?\s*([A-Z0-9]{5,})/) || [])[1] || null;
    const pm = t.match(/\$([0-9][0-9,]*\.[0-9]{2})\s*\/\s*(Square Foot|Piece|Bundle|Carton)/);
    const sm = t.match(/Company Stock\s*:?\s*([0-9,]+)\s*(Carton|Piece|Bundle|Box|Pallet|SF)/);
    const back = /Company Stock\s*:?\s*Backorder/.test(t);
    return {
      code,
      cost: pm ? parseFloat(pm[1].replace(/,/g, '')) : null,
      unit: pm ? pm[2] : null,
      stock: sm ? parseInt(sm[1].replace(/,/g, ''), 10) : back ? 0 : null,
    };
  }).filter((x) => x.code);
}

async function loadPage(page, url) {
  await page.goto(`${BASE}${url}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  // wait for tiles + at least one price to render (dealer price is JS-injected)
  await page.waitForFunction(
    () => document.querySelectorAll('li.product-item').length > 0 && /\$[0-9.]+\s*\/\s*(Square Foot|Piece)|Backorder/.test(document.body.innerText),
    { timeout: 30000 },
  ).catch(() => {});
  await new Promise((r) => setTimeout(r, 2500));
  return page.evaluate(parseInPage);
}

export async function run(pool, job, source) {
  await appendLog(pool, job.id, '=== Galleher Duffy daily price + inventory ===');
  const { browser, page } = await openGalleher(pool, job.id);

  try {
    const skuRes = await pool.query(
      `SELECT s.id, s.vendor_sku, pr.price_basis
       FROM skus s
       JOIN products p ON p.id = s.product_id
       JOIN vendors v ON v.id = p.vendor_id
       JOIN brands b ON b.id = p.brand_id
       LEFT JOIN pricing pr ON pr.sku_id = s.id
       WHERE v.code = $1 AND b.code = ANY($2) AND s.vendor_sku IS NOT NULL`,
      [VENDOR_CODE, BRAND_CODES],
    );
    const byCode = new Map();
    for (const r of skuRes.rows) byCode.set(normSku(r.vendor_sku), r);
    await appendLog(pool, job.id, `Loaded ${byCode.size} Galleher SKUs to refresh`);

    let found = 0, priceUpd = 0, invUpd = 0, matched = 0;
    const seen = new Set();

    for (const brand of BRAND_CODES) {
      let brandTiles = 0;
      for (let p = 1; p <= MAX_PAGES; p++) {
        let tiles;
        try { tiles = await loadPage(page, `${BRAND_SEARCH[brand]}&p=${p}`); }
        catch (e) { await addJobError(pool, job.id, `${brand} p${p}: ${e.message}`); break; }
        if (!tiles.length) break;
        let pageNew = 0;
        for (const t of tiles) {
          const key = normSku(t.code);
          if (seen.has(key)) continue; // Magento repeats items across pages
          seen.add(key); pageNew++; found++;
          const sku = byCode.get(key);
          if (!sku) continue;
          matched++;
          if (t.cost != null && t.cost > 0) {
            await upsertPricing(pool, sku.id, {
              cost: t.cost, retail_price: keystone(t.cost),
              price_basis: sku.price_basis || (t.unit === 'Piece' ? 'per_unit' : 'per_sqft'),
            }, { jobId: job.id });
            priceUpd++;
          }
          if (t.stock != null) {
            await upsertInventorySnapshot(pool, sku.id, WAREHOUSE, { qty_on_hand: t.stock, qty_in_transit: 0 });
            invUpd++;
          }
        }
        brandTiles += pageNew;
        if (pageNew === 0) break; // reached end of this brand's unique results
      }
      await appendLog(pool, job.id, `${brand}: ${brandTiles} tiles scanned`, { products_found: found, skus_affected: matched });
    }

    await appendLog(pool, job.id,
      `Done — ${found} tiles, ${matched} matched, ${priceUpd} prices updated, ${invUpd} inventory snapshots`,
      { products_found: found, products_updated: priceUpd, skus_affected: matched });
  } finally {
    await browser.close().catch(() => {});
  }
}
