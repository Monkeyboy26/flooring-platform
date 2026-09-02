/**
 * tradepro-dc-probe.mjs (one-off diagnostic, READ-ONLY)
 *
 * Question: does TradePro Exchange expose OTHER-DC stock (beyond our home
 * Anaheim SSC) anywhere — product detail page, aura ApexActions, or Coveo?
 *
 * Logs in with the scraper account, opens an in-stock product detail page,
 * records every aura/Coveo response containing inventory-ish keywords, and
 * dumps the detail page's visible text. Writes findings to
 * /tmp/tradepro-dc-probe.json. No DB writes.
 */
import fs from 'fs';
import { launchBrowser, delay } from '../scrapers/base.js';
import { portalLogin, waitForSPA } from '../scrapers/tradepro-auth.js';
import { pool } from '../db.js';

const TEST_SKU = process.env.PROBE_SKU || '0190A1061P1'; // Color Wheel Classic Arctic White, 3,948 on hand locally
const KEYWORDS = /inventor|warehouse|location|branch|\bdc\b|distribution|availab|stock|onhand|on_hand|ssc/i;

const job = { id: null };
// appendLog/addJobError tolerate null job? They insert into scrape_jobs — guard by stubbing pool.query for job logs.
const logPool = { query: async () => ({ rows: [] }) };

const findings = { aura: [], coveo: [], pageText: '', detailUrl: '' };
let browser;
try {
  browser = await launchBrowser();
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });

  page.on('response', async (resp) => {
    try {
      const url = resp.url();
      if (!/aura|coveo|apex|api/i.test(url)) return;
      const ct = resp.headers()['content-type'] || '';
      if (!/json|text/i.test(ct)) return;
      const body = await resp.text();
      if (body.length > 500000) return;
      if (KEYWORDS.test(body)) {
        const bucket = /coveo/i.test(url) ? findings.coveo : findings.aura;
        // keep a trimmed snippet around each keyword hit
        const snippets = [];
        let m; const re = new RegExp(KEYWORDS.source, 'gi');
        while ((m = re.exec(body)) && snippets.length < 12) {
          snippets.push(body.slice(Math.max(0, m.index - 120), m.index + 200).replace(/\s+/g, ' '));
        }
        bucket.push({ url: url.slice(0, 160), size: body.length, snippets });
      }
    } catch { /* ignore */ }
  });

  console.log('logging in…');
  await portalLogin(page, logPool, job);
  await waitForSPA(page);
  console.log('logged in. searching for', TEST_SKU);

  // search for the SKU from the products page
  await page.goto(`https://www.tradeproexchange.com/s/products#q=${TEST_SKU}`, { waitUntil: 'networkidle2', timeout: 60000 });
  await waitForSPA(page);
  await delay(3000);

  // click the first product tile/link
  const link = await page.evaluate(() => {
    const a = [...document.querySelectorAll('a[href*="/s/product"], a[href*="product-detail"], .coveo-result-list a, [data-testid*="product"] a')]
      .find(x => x.offsetParent !== null);
    if (a) { a.click(); return a.href; }
    return null;
  });
  console.log('clicked detail link:', link);
  await delay(2000);
  await waitForSPA(page);
  await delay(5000);
  findings.detailUrl = page.url();
  console.log('detail url:', findings.detailUrl);

  // look for any "check other locations / availability" affordance and click it
  const clicked = await page.evaluate(() => {
    const els = [...document.querySelectorAll('button, a, span[role=button], lightning-button')];
    const hit = els.find(e => /other location|availability|check stock|nearby|more stores|warehouse/i.test(e.textContent || ''));
    if (hit) { hit.click(); return (hit.textContent || '').trim().slice(0, 80); }
    return null;
  });
  console.log('availability affordance clicked:', clicked);
  if (clicked) { await delay(4000); await waitForSPA(page); }

  findings.pageText = await page.evaluate(() => document.body.innerText.slice(0, 20000));
} catch (e) {
  console.error('PROBE ERROR:', e.message);
} finally {
  try { if (browser) await browser.close(); } catch {}
}

fs.writeFileSync('/tmp/tradepro-dc-probe.json', JSON.stringify(findings, null, 1));
console.log(`\nwrote /tmp/tradepro-dc-probe.json — aura hits: ${findings.aura.length}, coveo hits: ${findings.coveo.length}`);
// quick console surface of the most interesting bits
const interesting = findings.pageText.split('\n').filter(l => KEYWORDS.test(l)).slice(0, 30);
console.log('\npage lines w/ inventory keywords:');
interesting.forEach(l => console.log('  ', l.trim().slice(0, 140)));
await pool.end();
