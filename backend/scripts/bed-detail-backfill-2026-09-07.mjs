// Targeted Bedrosians detail-page pass for SKUs flagged missing-box-packaging.
//
// The full detail crawl gets throttled by the site after ~450 pages (60s nav
// timeouts) and has twice died to container restarts before reaching these
// products, so this hits ONLY the flagged SKUs' detail pages (via the stable
// /en/product/detail/?itemNo=<code> path) and writes packaging + properties.
// Reuses bed.js scrapeDetailPage — same extraction as the full scrape.
//
// Idempotent (upserts). Run: docker compose exec -T api node scripts/bed-detail-backfill-2026-09-07.mjs

import { pool } from '../db.js';
import { launchBrowser, upsertPackaging } from '../scrapers/base.js';
import { scrapeDetailPage } from '../scrapers/bed.js';

const BASE = 'https://www.bedrosians.com';

async function main() {
  const { rows } = await pool.query(`
    SELECT DISTINCT s.id AS sku_id, s.vendor_sku, p.name, s.variant_name
    FROM quality_violations qv
    JOIN skus s ON s.id = qv.sku_id
    JOIN products p ON p.id = s.product_id
    WHERE qv.status = 'open' AND qv.rule_key = 'missing-box-packaging'
      AND qv.vendor_id = (SELECT id FROM vendors WHERE code = 'BED')
      AND s.vendor_sku IS NOT NULL
    ORDER BY s.vendor_sku`);
  console.log(`${rows.length} flagged BED SKU(s) to backfill`);

  let browser = await launchBrowser();
  let done = 0, packed = 0, failed = 0;
  for (const r of rows) {
    done++;
    const detailPath = `/en/product/detail/?itemNo=${encodeURIComponent(r.vendor_sku)}`;
    try {
      const detail = await scrapeDetailPage(browser, BASE, detailPath);
      if (detail && detail.packaging) {
        await upsertPackaging(pool, r.sku_id, detail.packaging);
        packed++;
        console.log(`  [${done}/${rows.length}] ${r.vendor_sku} ${r.name} — packaging OK`);
      } else {
        console.log(`  [${done}/${rows.length}] ${r.vendor_sku} ${r.name} — no packaging on page`);
      }
    } catch (err) {
      failed++;
      console.log(`  [${done}/${rows.length}] ${r.vendor_sku} — ERROR ${err.message}`);
      if (/Target closed|Session closed|disconnected/i.test(err.message)) {
        try { await browser.close(); } catch {}
        browser = await launchBrowser();
      }
    }
    await new Promise(res => setTimeout(res, 4000));
  }
  await browser.close();
  console.log(`Done: ${packed} packaging rows written, ${failed} errors, ${rows.length - packed - failed} pages without packaging.`);
  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
