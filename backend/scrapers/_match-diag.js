/**
 * Offline matching diagnostics: replay the daltile-inventory crosswalk against
 * /app/data/daltile-instock.json and explain every unmatched/ambiguous item.
 */
import fs from 'fs';
import pg from 'pg';
import { buildActiveIndex, crosswalkItem, canonSize, norm, first } from './daltile-crosswalk.js';

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
           MAX(CASE WHEN a.name = 'Shape' THEN sa.value END) AS shape,
           MAX(CASE WHEN a.name = 'Color' THEN sa.value END) AS color
    FROM skus s
    JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id
    LEFT JOIN pricing pr ON pr.sku_id = s.id
    LEFT JOIN sku_attributes sa ON sa.sku_id = s.id
    LEFT JOIN attributes a ON a.id = sa.attribute_id AND a.name IN ('Size', 'Finish', 'Shape', 'Color')
    WHERE v.code IN ('DAL', 'AO', 'MZ') AND s.vendor_sku IS NOT NULL
    GROUP BY s.id, s.vendor_sku, s.status, p.status, p.collection, pr.cost, s.variant_type, p.name
  `);
  const active = all.rows.filter(r => r.product_status === 'active' && r.sku_status === 'active');
  const exactMap = new Map();
  for (const r of all.rows) exactMap.set(r.vendor_sku.toUpperCase(), r);

  const index = buildActiveIndex(active);
  const stats = { exact: 0, exactActive: 0, crosswalked: 0, split: 0, ambiguous: 0, unmatched: 0 };
  const unmatched = [];
  const ambiguous = [];

  for (const item of items) {
    const rawSku = (item.sku || '').toUpperCase();
    const exact = exactMap.get(rawSku);
    if (exact) { stats.exact++; if (exact.product_status === 'active' && exact.sku_status === 'active') stats.exactActive++; }

    const res = crosswalkItem(item, index, stats);
    if (res.state === 'matched') {
      if (res.matches.length > 1) stats.split++;
      if (!exact || res.matches.some(m => m.row.id !== exact.id)) stats.crosswalked++;
    } else if (res.state === 'ambiguous') {
      stats.ambiguous++;
      ambiguous.push({
        sku: item.sku, size: first(item.nominalsize), finish: first(item.finish),
        shape: first(item.shapeandmosaic), series: item.seriesname,
        classprices: item.classprices, cands: res.candidates.map(c => `${c.vendor_sku}[$${c.cost}]`),
      });
    } else if (!exact) {
      stats.unmatched++;
      const colorCode = String(item.color || '').toUpperCase();
      const byPrefix = active.filter(c => colorCode && c.vendor_sku.toUpperCase().startsWith(colorCode));
      unmatched.push({
        sku: item.sku, qty: item.inventoryitems, uom: item.uom,
        color: item.color, size: first(item.nominalsize), finish: first(item.finish),
        series: item.seriesname, type: first(item.planproducttype),
        byPrefix: byPrefix.length,
        activeSizesForColor: [...new Set(byPrefix.map(c => `${c.size}→${canonSize(c.size)}`))].slice(0, 8),
      });
    }
  }

  console.log('RESULT:', JSON.stringify(stats));
  console.log('\n=== UNMATCHED with active same-color candidates (normalization gaps) ===');
  for (const u of unmatched.filter(u => u.byPrefix > 0).slice(0, 30)) {
    console.log(` ${u.sku} | size=${u.size}→${canonSize(u.size)} finish=${u.finish} | prefix-cands=${u.byPrefix} | active sizes for ${u.color}: ${u.activeSizesForColor.join(', ')}`);
  }
  console.log('\n=== UNMATCHED with NO active same-color SKU (not in catalog) ===');
  const noCat = unmatched.filter(u => u.byPrefix === 0);
  console.log(`count: ${noCat.length}`);
  const byType = {};
  for (const u of noCat) byType[u.type || '?'] = (byType[u.type || '?'] || 0) + 1;
  console.log('by product type:', JSON.stringify(byType));
  console.log('\n=== AMBIGUOUS (first 20) ===');
  for (const a of ambiguous.slice(0, 20)) {
    console.log(` ${a.sku} [$${a.classprices}] shape=${a.shape} → ${a.cands.join(' | ')}`);
  }
  await pool.end();
}
main().catch(e => { console.error(e); process.exit(1); });
