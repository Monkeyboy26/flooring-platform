/**
 * One-off discovery: capture the network calls and UI structure behind the
 * TradePro Exchange products page, to design a per-category inventory scraper
 * (the All-products tab caps pagination at 5,000 records).
 *
 * Run: docker compose exec -T api node scrapers/_discover-tradepro.js
 * Output: /app/data/tradepro-discovery/{requests.json,dom.json} + stdout summary
 */
import fs from 'fs';
import pg from 'pg';
import { launchBrowser, delay } from './base.js';
import { portalLogin, waitForSPA } from './tradepro-auth.js';

const OUT_DIR = '/app/data/tradepro-discovery';
const KEYWORDS = ['resultData', 'In Stock', 'inStock', 'inventory', 'stock', 'Quantity', 'ATP'];

async function main() {
  const pool = new pg.Pool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    database: process.env.DB_NAME || 'flooring_pim',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
  });

  // portalLogin logs via appendLog(job.id), so give it a real job row
  const jobResult = await pool.query(`
    INSERT INTO scrape_jobs (vendor_source_id, status, log, errors)
    VALUES (
      (SELECT id FROM vendor_sources WHERE scraper_key = 'daltile-inventory' LIMIT 1),
      'running', '[discovery run]\n', '[]'::jsonb
    )
    RETURNING id
  `);
  const job = { id: jobResult.rows[0].id };

  await fs.promises.mkdir(OUT_DIR, { recursive: true });
  const captures = [];
  let browser = null;

  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    // Capture XHR/fetch traffic, with special attention to Aura/Apex calls
    page.on('response', async (resp) => {
      try {
        const req = resp.request();
        const type = req.resourceType();
        if (type !== 'xhr' && type !== 'fetch') return;
        const url = resp.url();
        let body = '';
        try { body = await resp.text(); } catch { /* stream gone */ }
        const hits = KEYWORDS.filter(k => body.includes(k));
        captures.push({
          url,
          method: req.method(),
          status: resp.status(),
          postData: (req.postData() || '').slice(0, 4000),
          responseBytes: body.length,
          keywordHits: hits,
          responseSnippet: body.slice(0, hits.length ? 20000 : 1500),
        });
      } catch { /* never break the page on capture errors */ }
    });

    await portalLogin(page, pool, job);

    console.log('Navigating to products page...');
    await page.goto('https://www.tradeproexchange.com/s/products#tab=All', {
      waitUntil: 'networkidle2', timeout: 60000,
    });
    await waitForSPA(page);
    await delay(5000);

    // UI structure: tabs, facets/filters, first product card
    const dom = await page.evaluate(() => {
      const tabs = Array.from(document.querySelectorAll('[role="tab"], lightning-tab, .slds-tabs_default__item'))
        .map(el => el.textContent.trim()).filter(Boolean);
      const links = Array.from(document.querySelectorAll('a[href*="tab="], a[href*="category"], a[href*="filter"]'))
        .map(a => ({ text: a.textContent.trim().slice(0, 80), href: a.getAttribute('href') }))
        .filter(l => l.text).slice(0, 100);
      const checkboxLabels = Array.from(document.querySelectorAll('input[type="checkbox"]'))
        .map(cb => (cb.closest('label') || cb.parentElement)?.textContent.trim().slice(0, 80))
        .filter(Boolean).slice(0, 200);
      const buttons = Array.from(document.querySelectorAll('button'))
        .map(b => b.textContent.trim()).filter(t => t && t.length < 40).slice(0, 120);
      const bodyStart = document.body.innerText.slice(0, 3000);
      return { url: location.href, tabs, links, checkboxLabels, buttons, bodyStart };
    });

    // Trigger one pagination click so the page-change request gets captured
    console.log('Clicking to page 2 to capture the pagination request...');
    const markerBefore = captures.length;
    await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('button, a, span'));
      const two = els.find(el => el.textContent.trim() === '2');
      if (two) two.click();
    });
    await delay(6000);
    await waitForSPA(page);
    const paginationCaptures = captures.slice(markerBefore).map(c => c.url);

    await fs.promises.writeFile(`${OUT_DIR}/requests.json`, JSON.stringify(captures, null, 2));
    await fs.promises.writeFile(`${OUT_DIR}/dom.json`, JSON.stringify({ ...dom, paginationCaptures }, null, 2));

    console.log(`\nCaptured ${captures.length} XHR/fetch calls.`);
    const withHits = captures.filter(c => c.keywordHits.length);
    console.log(`Calls containing stock/result keywords: ${withHits.length}`);
    for (const c of withHits.slice(0, 15)) {
      console.log(`  [${c.keywordHits.join(',')}] ${c.method} ${c.url.slice(0, 140)} (${c.responseBytes}B)`);
    }
    console.log(`\nTabs found: ${JSON.stringify(dom.tabs)}`);
    console.log(`Filter checkboxes (first 30): ${JSON.stringify(dom.checkboxLabels.slice(0, 30))}`);
    console.log(`\nWrote ${OUT_DIR}/requests.json and dom.json`);
  } finally {
    if (browser) await browser.close().catch(() => {});
    await pool.query(`UPDATE scrape_jobs SET status='completed', completed_at=now(), log = log || '[discovery finished]' WHERE id=$1`, [job.id]);
    await pool.end();
  }
}

main().catch(err => { console.error('Discovery failed:', err); process.exit(1); });
