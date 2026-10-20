// Targeted coverage backfill for BED SKUs that sell box/per_sqft but have no
// sqft_per_box (quality rule: missing-box-packaging). Re-fetches ONLY the
// affected detail pages — the data is on bedrosians.com, the full scrape's
// detail phase just never finished for these (dies on owner redeploys).
//
// Resumable: each run re-queries only the still-missing SKUs, so re-running
// picks up where a killed run left off. Browser is recycled every N pages to
// avoid long-run memory growth.
//
//   docker exec -e DB_HOST=db flooring-api node data/bed-coverage-backfill.mjs [--limit N] [--dry]
import pg from 'pg';
import { launchBrowser, upsertPackaging, delay } from '../scrapers/base.js';
import { scrapeDetailPage } from '../scrapers/bed.js';

const { Pool } = pg;
const BASE_URL = 'https://www.bedrosians.com';
const RECYCLE_EVERY = 40;
const argv = process.argv.slice(2);
const DRY = argv.includes('--dry');
const limArg = argv.indexOf('--limit');
const LIMIT = limArg >= 0 ? parseInt(argv[limArg + 1], 10) : null;

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  database: process.env.DB_NAME || 'flooring_pim',
});

const { rows: targets } = await pool.query(`
  SELECT s.id AS sku_id, s.vendor_sku, p.name, s.variant_name
  FROM skus s
  JOIN products p ON p.id = s.product_id
  JOIN vendors v ON v.id = p.vendor_id AND v.code = 'BED'
  JOIN pricing pr ON pr.sku_id = s.id
  LEFT JOIN packaging pk ON pk.sku_id = s.id
  WHERE s.sell_by = 'box' AND pr.price_basis = 'per_sqft'
    AND COALESCE(pk.sqft_per_box, 0) <= 0
    AND s.status = 'active'
  ORDER BY p.name, s.variant_name
  ${LIMIT ? `LIMIT ${LIMIT}` : ''}
`);

console.log(`BED coverage backfill: ${targets.length} SKUs missing sqft_per_box${DRY ? ' (DRY RUN)' : ''}`);
if (!targets.length) { await pool.end(); process.exit(0); }

let browser = await launchBrowser();
let set = 0, noData = 0, errors = 0, i = 0;

for (const t of targets) {
  i++;
  if (i % RECYCLE_EVERY === 0) {
    try { await browser.close(); } catch {}
    browser = await launchBrowser();
  }
  const detailPath = `/en/product/detail/?itemNo=${encodeURIComponent(t.vendor_sku)}`;
  try {
    const d = await scrapeDetailPage(browser, BASE_URL, detailPath);
    const sf = d && d.packaging && Number(d.packaging.sqft_per_box);
    if (sf && sf > 0) {
      if (!DRY) await upsertPackaging(pool, t.sku_id, d.packaging);
      set++;
      console.log(`  ✓ ${t.vendor_sku} ${t.name} — ${t.variant_name || ''} → ${sf} sqft/box (pcs ${d.packaging.pieces_per_box ?? '?'})`);
    } else {
      noData++;
      console.log(`  · ${t.vendor_sku} ${t.name} — no box SF on detail page`);
    }
  } catch (e) {
    errors++;
    console.log(`  ✗ ${t.vendor_sku} ${t.name} — ${e.message}`);
  }
  await delay(400);
  if (i % 25 === 0) console.log(`[progress ${i}/${targets.length}] set=${set} noData=${noData} err=${errors}`);
}

try { await browser.close(); } catch {}
console.log(`\nDONE: set=${set} noData=${noData} errors=${errors} of ${targets.length}`);
await pool.end();
