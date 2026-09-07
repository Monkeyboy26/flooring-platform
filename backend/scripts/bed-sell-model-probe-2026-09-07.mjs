// Probe Bedrosians PDPs for the flagged "missing packaging" SKUs: these turned
// out to be pattern bundles / paver sets (continuous sqft) and pool coping
// (per piece), not carton goods. Reads each page's title + displayed price +
// selling unit as ground truth and reports; --apply then fixes sell models:
//   Pattern Bundle / Paver Set / Versailles -> sell_by='sqft' (continuous)
//   Pool Coping / priced "each"             -> sell_by='unit' + per_unit
// Run: docker compose exec -T api node scripts/bed-sell-model-probe-2026-09-07.mjs [--apply]

import { pool } from '../db.js';
import { launchBrowser } from '../scrapers/base.js';

const APPLY = process.argv.includes('--apply');

async function main() {
  const { rows } = await pool.query(`
    SELECT DISTINCT s.id AS sku_id, s.vendor_sku, p.name, s.variant_name, s.sell_by,
           pr.price_basis, pr.cost, pr.retail_price
    FROM quality_violations qv
    JOIN skus s ON s.id = qv.sku_id
    JOIN products p ON p.id = s.product_id
    LEFT JOIN pricing pr ON pr.sku_id = s.id
    WHERE qv.status = 'open' AND qv.rule_key = 'missing-box-packaging'
      AND qv.vendor_id = (SELECT id FROM vendors WHERE code = 'BED')
    ORDER BY s.vendor_sku`);
  console.log(`${rows.length} SKU(s) to probe`);

  const browser = await launchBrowser();
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36');

  const plan = { sqft: [], piece: [], skip: [] };
  for (const r of rows) {
    try {
      await page.goto(`https://www.bedrosians.com/en/product/detail/?itemNo=${encodeURIComponent(r.vendor_sku)}`,
        { waitUntil: 'domcontentloaded', timeout: 60000 });
      await new Promise(res => setTimeout(res, 2500));
      const info = await page.evaluate(() => {
        const title = document.title;
        const txt = document.body ? document.body.innerText : '';
        const price = (txt.match(/\$\s?([\d,]+\.?\d*)\s*\/\s*(piece|each|sq\.?\s*ft|sheet|box|set|bundle)/i) || [])
          .slice(1, 3);
        return { title, priceNum: price[0] || null, priceUnit: (price[1] || '').toLowerCase() };
      });
      const t = info.title;
      let action = 'skip';
      if (/discontinued/i.test(t)) action = 'skip-discontinued';
      else if (/pattern bundle|paver set|versailles/i.test(t) || /sq\.?\s*ft/.test(info.priceUnit)) action = 'sqft';
      else if (/pool coping/i.test(t) || /piece|each/.test(info.priceUnit)) action = 'piece';
      (plan[action === 'sqft' ? 'sqft' : action === 'piece' ? 'piece' : 'skip']).push({ ...r, title: t, ...info, action });
      console.log(`  ${r.vendor_sku} [${action}] ${t.slice(0, 80)} | $${info.priceNum || '?'} /${info.priceUnit || '?'} | stored ${r.sell_by}/${r.price_basis} $${r.cost}`);
    } catch (err) {
      plan.skip.push({ ...r, action: 'skip-error' });
      console.log(`  ${r.vendor_sku} [skip-error] ${err.message.slice(0, 60)}`);
    }
    await new Promise(res => setTimeout(res, 3000));
  }
  await browser.close();

  console.log(`\nPlan: ${plan.sqft.length} -> sell_by sqft, ${plan.piece.length} -> per-piece, ${plan.skip.length} skipped`);
  if (!APPLY) { console.log('Dry-run. Re-run with --apply.'); await pool.end(); return; }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const r of plan.sqft) {
      await client.query(`UPDATE skus SET sell_by = 'sqft', updated_at = NOW() WHERE id = $1`, [r.sku_id]);
    }
    for (const r of plan.piece) {
      await client.query(`UPDATE skus SET sell_by = 'unit', updated_at = NOW() WHERE id = $1`, [r.sku_id]);
      await client.query(`UPDATE pricing SET price_basis = 'per_unit' WHERE sku_id = $1`, [r.sku_id]);
    }
    await client.query('COMMIT');
    console.log('Applied.');
  } catch (err) { await client.query('ROLLBACK'); throw err; }
  finally { client.release(); await pool.end(); }
}

main().catch(err => { console.error(err); process.exit(1); });
