/**
 * daltile-activate-ready-drafts.mjs
 *
 * Activates Daltile draft SKUs that are fully sellable: priced (>0) AND imaged.
 * The Daltile pipeline drafts imports pending validation; past cleanups left
 * ~8k priced drafts of which 646 also carry images (e.g. Tundra Sand & Stone).
 * Verified 2026-08-29: zero vendor_sku or product-name collisions with active
 * rows, so activation cannot double-list. Parent products go active too.
 *
 *   node backend/scripts/daltile-activate-ready-drafts.mjs            # dry run
 *   node backend/scripts/daltile-activate-ready-drafts.mjs --commit   # apply
 */
import pg from 'pg';
const COMMIT = process.argv.includes('--commit');
const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});
const DAL = '550e8400-e29b-41d4-a716-446655440003';

const { rows } = await pool.query(`
  SELECT s.id sku_id, p.id pid, p.name, p.status pstatus
  FROM products p JOIN skus s ON s.product_id=p.id
  JOIN pricing pr ON pr.sku_id=s.id
  WHERE p.vendor_id=$1 AND s.status='draft' AND pr.retail_price>0
    AND EXISTS(SELECT 1 FROM media_assets m WHERE m.sku_id=s.id)
    -- guard: no active twin by vendor_sku or product name
    AND NOT EXISTS(SELECT 1 FROM skus a JOIN products ap ON ap.id=a.product_id
      WHERE ap.vendor_id=$1 AND a.status='active' AND upper(a.vendor_sku)=upper(s.vendor_sku))
    AND NOT EXISTS(SELECT 1 FROM products ap WHERE ap.vendor_id=$1 AND ap.status='active' AND ap.id<>p.id
      AND lower(regexp_replace(ap.name,'\\s+',' ','g'))=lower(regexp_replace(p.name,'\\s+',' ','g')))`, [DAL]);

const prods = [...new Set(rows.map(r => r.pid))];
console.log(`=== Daltile activate ready drafts — ${COMMIT ? 'COMMIT' : 'DRY RUN'} ===`);
console.log(`SKUs: ${rows.length} across ${prods.length} products`);
if (!COMMIT) { console.log('Dry run — re-run with --commit.'); await pool.end(); process.exit(0); }

const client = await pool.connect();
try {
  await client.query('BEGIN');
  const r1 = await client.query(`UPDATE skus SET status='active', updated_at=now() WHERE id = ANY($1) RETURNING id`, [rows.map(r => r.sku_id)]);
  const r2 = await client.query(`UPDATE products SET status='active', updated_at=now() WHERE id = ANY($1) AND status<>'active' RETURNING id`, [prods]);
  await client.query('COMMIT');
  console.log(`Activated ${r1.rowCount} SKUs, ${r2.rowCount} products`);
} catch (e) { await client.query('ROLLBACK'); console.error('ROLLBACK:', e.message); process.exit(1); }
finally { client.release(); }
for (const pid of prods) await pool.query('SELECT refresh_search_vectors($1)', [pid]).catch(() => {});
console.log(`Refreshed search vectors (${prods.length})`);
await pool.end();
console.log('=== done ===');
