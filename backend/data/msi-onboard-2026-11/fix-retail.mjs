/**
 * Set retail on the 124 newly created MSI SKUs (onboard.mjs passed cost only;
 * upsertPricing never invents retail). retail_in = cost × 1.70, then
 * upsertPricing's charm/floor rules adjust. Also reports any active MSI SKU
 * with no pricing row at all.
 */
import pg from 'pg';
import fs from 'fs';
import { upsertPricing } from '/app/scrapers/base.js';

const DIR = '/app/data/msi-onboard-2026-11';
const create = JSON.parse(fs.readFileSync(`${DIR}/msi-create.json`, 'utf8'));

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'db', port: 5432,
  database: 'flooring_pim', user: 'postgres',
  password: process.env.DB_PASSWORD || process.env.POSTGRES_PASSWORD || 'postgres',
});

function rowCost(r) {
  return parseFloat(r['PRICE/EACH']) || parseFloat(r['PRICE/UOM']) || 0;
}

async function main() {
  let fixed = 0, missing = 0;
  for (const r of create) {
    const sres = await pool.query('SELECT id FROM skus WHERE internal_sku = $1', [`MSI-${r.__item}`]);
    if (!sres.rows.length) { missing++; continue; }
    const cost = rowCost(r);
    if (!(cost > 0)) continue;
    const retail = Math.round(cost * 1.70 * 100) / 100;
    await upsertPricing(pool, sres.rows[0].id, { cost, retail_price: retail, price_basis: 'per_unit' });
    fixed++;
  }
  console.log(`retail set on ${fixed} new skus (missing=${missing})`);

  const check = await pool.query(`
    SELECT COUNT(*) FILTER (WHERE pr.sku_id IS NULL) AS no_pricing,
           COUNT(*) FILTER (WHERE pr.retail_price <= 0) AS zero_retail
    FROM skus s JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id
    LEFT JOIN pricing pr ON pr.sku_id = s.id
    WHERE v.code = 'MSI' AND s.status = 'active' AND p.is_active`);
  console.log(`active MSI skus with NO pricing row: ${check.rows[0].no_pricing}, zero retail: ${check.rows[0].zero_retail}`);
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
