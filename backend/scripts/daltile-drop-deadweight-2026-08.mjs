/**
 * daltile-drop-deadweight-2026-08.mjs
 *
 * Deactivates active Daltile SKUs that fail EVERY sell-ability test:
 *   1. missing from the public daltile.com catalog (audit 2026-08-29,
 *      data/daltile/tradepro-website-missing-2026-08-29.json)
 *   2. no retail price (never priced by catalog scrape or EDI overlay)
 *   3. NOT a slab/countertop category (those are quote items — unpriced
 *      call-for-pricing is intentional, they stay active)
 * The EDI check is implied: every unpriced SKU was already classified vs the
 * live 832 feed (edi-593-check) — priceable ones were priced by the crosswalk
 * grow, so remaining unpriced = not in EDI either.
 *
 * Deliberately NOT dropped: slabs (quote items), Halverton/Grantshire (still
 * priced in the 832 feed = orderable; website restructure only), code-rotation
 * lines (ONE Quartz/Brickwork etc. — need re-onboard, not removal).
 *
 * Products left with zero active SKUs go inactive too.
 *
 *   node backend/scripts/daltile-drop-deadweight-2026-08.mjs            # dry run
 *   node backend/scripts/daltile-drop-deadweight-2026-08.mjs --commit   # apply
 */
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COMMIT = process.argv.includes('--commit');
const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});
const DAL = '550e8400-e29b-41d4-a716-446655440003';
const SLAB_CATS = ['Quartz Countertops','Granite Countertops','Quartzite Countertops',
  'Marble Countertops','Porcelain Slabs'];
// lines still priced in the current 832 feed = orderable (website restructure only);
// their unpriced stragglers are crosswalk gaps (e.g. Halverton 9xFree planks match
// HL5xR9FR20ML10M in-feed), not discontuations
const EDI_ALIVE = ['Halverton','Grantshire'];

const missing = JSON.parse(fs.readFileSync(
  path.join(__dirname, '../data/daltile/tradepro-website-missing-2026-08-29.json'), 'utf8'));
const missSkus = missing.map(m => m.vendor_sku);

const { rows: targets } = await pool.query(`
  SELECT s.id sku_id, s.vendor_sku, p.id product_id, p.name, p.collection, c.name category
  FROM skus s JOIN products p ON p.id=s.product_id
  LEFT JOIN pricing pr ON pr.sku_id=s.id LEFT JOIN categories c ON c.id=p.category_id
  WHERE p.vendor_id=$1 AND s.status='active'
    AND s.vendor_sku = ANY($2)
    AND pr.retail_price IS NULL
    AND COALESCE(c.name,'') <> ALL($3)
    AND COALESCE(p.collection,'') <> ALL($4)
  ORDER BY c.name, p.collection, s.vendor_sku`, [DAL, missSkus, SLAB_CATS, EDI_ALIVE]);

console.log(`=== Daltile dead-weight drop — ${COMMIT ? 'COMMIT' : 'DRY RUN'} ===`);
console.log(`Targets (website-missing + unpriced + non-slab): ${targets.length} SKUs`);
const grp = targets.reduce((m, t) => ((m[`${t.category} / ${t.collection}`] = (m[`${t.category} / ${t.collection}`]||0)+1), m), {});
Object.entries(grp).sort((a,b)=>b[1]-a[1]).forEach(([k,v]) => console.log(`  ${v}\t${k}`));

if (!COMMIT) { console.log('\nDry run — re-run with --commit to apply.'); await pool.end(); process.exit(0); }

const client = await pool.connect();
try {
  await client.query('BEGIN');
  const r1 = await client.query(
    `UPDATE skus SET status='inactive', updated_at=now() WHERE id = ANY($1) RETURNING id`,
    [targets.map(t => t.sku_id)]);
  const r2 = await client.query(`
    UPDATE products p SET status='inactive', updated_at=now()
    WHERE p.vendor_id=$1 AND p.status='active'
      AND p.id = ANY($2)
      AND NOT EXISTS (SELECT 1 FROM skus s WHERE s.product_id=p.id AND s.status='active')
    RETURNING p.id`, [DAL, [...new Set(targets.map(t => t.product_id))]]);
  await client.query('COMMIT');
  console.log(`\nDeactivated ${r1.rowCount} SKUs; ${r2.rowCount} products left with no active SKUs → inactive`);
} catch (e) {
  await client.query('ROLLBACK'); console.error('ROLLBACK:', e.message); process.exit(1);
} finally { client.release(); }

const { rows: prods } = await pool.query(
  'SELECT DISTINCT product_id FROM skus WHERE id = ANY($1)', [targets.map(t => t.sku_id)]);
for (const r of prods) await pool.query('SELECT refresh_search_vectors($1)', [r.product_id]).catch(()=>{});
console.log(`Refreshed search vectors (${prods.length} products)`);
await pool.end();
console.log('=== done ===');
