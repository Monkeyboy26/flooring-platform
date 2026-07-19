/**
 * Live probe for DNav pagination + navigation diagnosis.
 * Logs in once, searches a big-catalog manufacturer, inspects the More form,
 * clicks it while polling the table, then tests the back-to-search strategies.
 *
 *   docker exec -w /app flooring-api node scrapers/_triwest-probe.js PRO
 */
import pg from 'pg';
import { triwestLogin, PORTAL_BASE, screenshot } from './triwest-auth.js';
import { delay } from './base.js';
import { parseResultsTable, navigateToSearchForm } from './triwest-search.js';

const MFGR = (process.argv[2] || 'PRO').toUpperCase();

async function pageState(page, tag) {
  const st = await page.evaluate(() => {
    const forms = Array.from(document.querySelectorAll('form')).map(f => ({
      action: (f.action || '').slice(-70),
      id: f.id || '',
      submits: Array.from(f.querySelectorAll('input[type="submit"]')).map(b => b.value),
      hasMaxRecords: !!f.querySelector('select[name="d24_max_records"]'),
      hidden: Array.from(f.querySelectorAll('input[type="hidden"]')).map(h => `${h.name}=${String(h.value).slice(0, 30)}`),
    }));
    const btns = Array.from(document.querySelectorAll('input[type="submit"], button'))
      .map(b => (b.value || b.textContent || '').trim()).filter(Boolean);
    return {
      url: location.href,
      title: document.title,
      loginForm: !!document.querySelector('#d24user_login'),
      mfgrDropdown: !!document.querySelector('select[name="d24_filter_mfgr"]'),
      forms, btns,
      bodyStart: (document.body.innerText || '').slice(0, 200).replace(/\n+/g, ' | '),
    };
  }).catch(e => ({ error: e.message }));
  console.log(`\n===== ${tag} =====`);
  console.log(JSON.stringify(st, null, 1));
}

async function main() {
  const pool = new pg.Pool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    database: process.env.DB_NAME || 'flooring_pim',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
  });
  const fakeJobId = (await pool.query(`SELECT id FROM scrape_jobs ORDER BY created_at DESC LIMIT 1`)).rows[0].id;

  const { browser, page } = await triwestLogin(pool, fakeJobId);
  try {
    await pageState(page, 'after login');

    // Select manufacturer + max records, submit advanced search (mirrors searchByManufacturer)
    await page.evaluate((code) => {
      const sel = document.querySelector('select[name="d24_filter_mfgr"]');
      sel.value = code;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }, MFGR);
    await delay(500);
    await page.evaluate(() => {
      for (const sel of document.querySelectorAll('select[name="d24_max_records"]')) {
        let maxVal = sel.value, maxNum = parseInt(sel.value) || 0;
        for (const opt of sel.options) {
          const num = parseInt(opt.value) || 0;
          if (num > maxNum) { maxNum = num; maxVal = opt.value; }
        }
        sel.value = maxVal;
      }
      for (const form of document.querySelectorAll('form')) {
        if (form.action && form.action.includes('item_search_advanced')) {
          form.querySelector('input[type="submit"]')?.click();
          return;
        }
      }
    });
    await delay(6000);

    let rows = await parseResultsTable(page);
    console.log(`\n${MFGR} initial rows: ${rows.length}, first: ${rows[0]?.itemNumber}, last: ${rows[rows.length - 1]?.itemNumber}`);
    await pageState(page, 'after search (results view)');
    await screenshot(page, `probe-${MFGR}-results`);

    // Click More the same way clickMoreResults does, then poll instead of fixed 5s
    const clicked = await page.evaluate(() => {
      const forms = document.querySelectorAll('form');
      let moreForm = null;
      for (const f of forms) {
        if ((f.action && f.action.includes('more')) || (f.id && f.id.includes('more'))) { moreForm = f; break; }
        const btn = f.querySelector('input[type="submit"]');
        if (btn && (btn.value || '').toLowerCase().includes('more')) { moreForm = f; break; }
      }
      if (!moreForm) {
        for (const btn of document.querySelectorAll('input[type="submit"], button')) {
          const text = (btn.value || btn.textContent || '').trim().toLowerCase();
          if (text === 'more' || text === 'more results' || text === 'load more') { btn.click(); return 'standalone'; }
        }
        return false;
      }
      const maxRecords = moreForm.querySelector('select[name="d24_max_records"]');
      if (maxRecords) {
        let maxVal = maxRecords.options[0]?.value, maxNum = parseInt(maxVal) || 0;
        for (const opt of maxRecords.options) {
          const num = parseInt(opt.value) || 0;
          if (num > maxNum) { maxNum = num; maxVal = opt.value; }
        }
        maxRecords.value = maxVal;
      }
      const submitBtn = moreForm.querySelector('input[type="submit"]');
      if (submitBtn) { submitBtn.click(); return 'form'; }
      return false;
    });
    console.log(`\nMore click result: ${clicked}`);

    for (let t = 2; t <= 30; t += 2) {
      await delay(2000);
      const cur = await parseResultsTable(page).catch(e => ({ err: e.message }));
      if (cur.err) { console.log(`  t=${t}s parse error: ${cur.err}`); continue; }
      console.log(`  t=${t}s rows=${cur.length} first=${cur[0]?.itemNumber} last=${cur[cur.length - 1]?.itemNumber}`);
      if (cur.length > rows.length) { rows = cur; console.log('  GREW — stopping poll'); break; }
    }
    await screenshot(page, `probe-${MFGR}-after-more`);
    await pageState(page, 'after More poll');

    // Header links (what could strategy 1 actually click?)
    const links = await page.evaluate(() =>
      Array.from(document.querySelectorAll('a')).slice(0, 40)
        .map(a => `${(a.textContent || '').trim().slice(0, 30)} -> ${(a.getAttribute('href') || '').slice(0, 60)}`)
        .filter(s => s.length > 4));
    console.log('\nlinks:', JSON.stringify(links, null, 1));

    // KEY TEST: from the results view, select the NEXT manufacturer and submit
    // the (hidden) advanced search form directly — no navigation at all.
    await page.select('select[name="d24_filter_mfgr"]', 'MIR');
    await delay(500);
    await page.evaluate(() => {
      for (const form of document.querySelectorAll('form')) {
        if (form.action && form.action.includes('item_search_advanced')) {
          form.querySelector('input[type="submit"]')?.click();
          return;
        }
      }
    });
    await delay(6000);
    const mirRows = await parseResultsTable(page);
    console.log(`\nIN-PLACE re-search MIR: rows=${mirRows.length} first=${mirRows[0]?.itemNumber} last=${mirRows[mirRows.length - 1]?.itemNumber}`);
    await screenshot(page, `probe-inplace-MIR`);
  } finally {
    await browser.close().catch(() => {});
    await pool.end();
  }
}
main().catch(e => { console.error(e); process.exit(1); });
