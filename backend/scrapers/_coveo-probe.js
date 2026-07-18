/**
 * One-off: mint a Coveo token via portal login, then dump ALL raw fields for
 * a few known in-stock items — looking for a cross-reference to the EDI code
 * family (e.g. 019036MOD1P4 ↔ 0190S4639MODGL).
 */
import pg from 'pg';
import { launchBrowser, delay } from './base.js';
import { portalLogin, waitForSPA } from './tradepro-auth.js';

const COVEO_URL = 'https://mohawkindustriesproductionwwrtu1cs.org.coveo.com/rest/search/v2?organizationId=mohawkindustriesproductionwwrtu1cs';

async function main() {
  const pool = new pg.Pool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    database: process.env.DB_NAME || 'flooring_pim',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
  });
  const jobResult = await pool.query(`
    INSERT INTO scrape_jobs (vendor_source_id, status, log)
    VALUES ((SELECT id FROM vendor_sources WHERE scraper_key = 'daltile-inventory' LIMIT 1), 'running', '[coveo field probe]')
    RETURNING id`);
  const job = { id: jobResult.rows[0].id };

  let browser = null;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    let token = null;
    page.on('response', async (resp) => {
      if (token || !resp.url().includes('/s/sfsites/aura')) return;
      try {
        const m = (await resp.text()).match(/accessToken[^A-Za-z0-9]+([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/);
        if (m) token = m[1];
      } catch { /* ignore */ }
    });

    await portalLogin(page, pool, job);
    await page.goto('https://www.tradeproexchange.com/s/products#tab=All', { waitUntil: 'networkidle2', timeout: 60000 });
    await waitForSPA(page);
    for (let w = 0; !token && w < 60; w++) await delay(1000);
    if (!token) throw new Error('no token');
    await browser.close();
    browser = null;

    const resp = await fetch(COVEO_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        aq: '@sku==(019036MOD1P4,CT76RCT1224MTJ1)',
        numberOfResults: 2,
        searchHub: 'SSC_ProExchange_CatalogSearch',
        // no fieldsToInclude — return every indexed field
      }),
    });
    const data = await resp.json();
    for (const r of data.results || []) {
      console.log('=== ', r.title, '|', r.uri);
      for (const [k, v] of Object.entries(r.raw).sort()) {
        console.log(`  ${k}: ${String(JSON.stringify(v)).slice(0, 160)}`);
      }
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
    await pool.query(`UPDATE scrape_jobs SET status='completed', completed_at=now() WHERE id=$1`, [job.id]);
    await pool.end();
  }
}
main().catch(e => { console.error(e); process.exit(1); });
