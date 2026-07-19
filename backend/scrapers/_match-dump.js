/**
 * Dump per-item crosswalk results as JSON for regression diffing when tuning
 * daltile-crosswalk.js: run once before the change and once after, then diff.
 *
 *   docker exec -w /app flooring-api node scrapers/_match-dump.js /app/data/_match-before.json
 *   (edit the crosswalk)
 *   docker exec -w /app flooring-api node scrapers/_match-dump.js /app/data/_match-after.json
 */
import fs from 'fs';
import pg from 'pg';
import { buildActiveIndex, crosswalkItem } from './daltile-crosswalk.js';

async function main() {
  const pool = new pg.Pool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    database: process.env.DB_NAME || 'flooring_pim',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
  });
  const items = JSON.parse(fs.readFileSync('/app/data/daltile-instock.json'));
  const all = await pool.query(`
    SELECT s.id, s.vendor_sku, s.status AS sku_status, p.status AS product_status, p.collection, pr.cost, s.variant_type, p.name AS product_name,
           MAX(CASE WHEN a.name = 'Size' THEN sa.value END) AS size,
           MAX(CASE WHEN a.name = 'Finish' THEN sa.value END) AS finish,
           MAX(CASE WHEN a.name = 'Shape' THEN sa.value END) AS shape
    FROM skus s
    JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id
    LEFT JOIN pricing pr ON pr.sku_id = s.id
    LEFT JOIN sku_attributes sa ON sa.sku_id = s.id
    LEFT JOIN attributes a ON a.id = sa.attribute_id AND a.name IN ('Size', 'Finish', 'Shape')
    WHERE v.code IN ('DAL', 'AO', 'MZ') AND s.vendor_sku IS NOT NULL
    GROUP BY s.id, s.vendor_sku, s.status, p.status, p.collection, pr.cost, s.variant_type, p.name
  `);
  const active = all.rows.filter(r => r.product_status === 'active' && r.sku_status === 'active');
  const aliasRows = all.rows.filter(r => !(r.product_status === 'active' && r.sku_status === 'active'));
  const index = buildActiveIndex(active, aliasRows);
  const out = {};
  for (const item of items) {
    const res = crosswalkItem(item, index, {});
    out[item.sku] = res.state === 'matched'
      ? res.matches.map(m => `${m.row.vendor_sku}@${m.share}`).sort().join('|')
      : res.state === 'ambiguous' ? 'AMBIGUOUS:' + res.candidates.map(c => c.vendor_sku).sort().join('|')
      : 'NONE';
  }
  fs.writeFileSync(process.argv[2], JSON.stringify(out, null, 1));
  console.log('items:', items.length);
  await pool.end();
}
main().catch(e => { console.error(e); process.exit(1); });
