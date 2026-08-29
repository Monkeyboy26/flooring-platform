/**
 * daltile-price-halverton-9xfree.mjs
 *
 * Prices the 6 Halverton 9xFree planks (HL50-HL55 R9XFree10M) that the
 * crosswalk-grow matcher skipped: its LVP key needs an M##L mil token which
 * these codes lack, so they stayed unpriced. Verified against the live 832
 * feed 2026-08-29: each maps 1:1 by color digit to HL5xR9FR20ML10M —
 * "Halverton Plank 9xfree Rigid Click 10.0mm Sx", $5.82/SF, 4.44 sqft/box.
 *
 * Mirrors daltile-crosswalk-grow.mjs conventions: daltile_edi_map row so the
 * nightly overlay tracks future EDI price changes; cost = EDI cost; retail =
 * nine-ending round-down of cost x1.6; box/per_sqft + coverage.
 *
 *   node backend/scripts/daltile-price-halverton-9xfree.mjs            # dry run
 *   node backend/scripts/daltile-price-halverton-9xfree.mjs --commit   # apply
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
const COST = 5.82, SQFT_PER_BOX = 4.44;
const nineEnding = (raw) => Math.round((Math.floor((raw - 0.09) / 0.10) * 0.10 + 0.09) * 100) / 100;
const RETAIL = nineEnding(COST * 1.6); // 9.29

const MAP = {};
for (let n = 50; n <= 55; n++) MAP[`HL${n}R9XFree10M`] = `HL${n}R9FR20ML10M`;

const { rows } = await pool.query(`
  SELECT s.id sku_id, s.vendor_sku, p.name, pr.retail_price
  FROM skus s JOIN products p ON p.id=s.product_id LEFT JOIN pricing pr ON pr.sku_id=s.id
  WHERE p.vendor_id=$1 AND s.status='active' AND s.vendor_sku = ANY($2)
  ORDER BY s.vendor_sku`, [DAL, Object.keys(MAP)]);

console.log(`=== Halverton 9xFree pricing — ${COMMIT ? 'COMMIT' : 'DRY RUN'} ===`);
rows.forEach(r => console.log(`  ${r.vendor_sku} → ${MAP[r.vendor_sku]} | ${r.name} | ` +
  `${r.retail_price == null ? 'UNPRICED' : 'already $' + r.retail_price} → cost $${COST}, retail $${RETAIL}/sqft, spb ${SQFT_PER_BOX}`));

if (!COMMIT) { console.log('\nDry run — re-run with --commit to apply.'); await pool.end(); process.exit(0); }

const client = await pool.connect();
try {
  await client.query('BEGIN');
  for (const r of rows) {
    await client.query(
      `INSERT INTO daltile_edi_map (live_vendor_sku, edi_vendor_sku, confidence, method)
       VALUES ($1,$2,'high','grow:plank-9xfree')
       ON CONFLICT (live_vendor_sku) DO UPDATE SET edi_vendor_sku=EXCLUDED.edi_vendor_sku, method=EXCLUDED.method, updated_at=now()`,
      [r.vendor_sku, MAP[r.vendor_sku]]);
    await client.query(
      `INSERT INTO pricing (sku_id, cost, retail_price, price_basis) VALUES ($1,$2,$3,'per_sqft')
       ON CONFLICT (sku_id) DO UPDATE SET cost=EXCLUDED.cost, price_basis=EXCLUDED.price_basis,
         retail_price=CASE WHEN pricing.retail_locked THEN pricing.retail_price ELSE EXCLUDED.retail_price END`,
      [r.sku_id, COST, RETAIL]);
    await client.query(
      `INSERT INTO packaging (sku_id, sqft_per_box) VALUES ($1,$2)
       ON CONFLICT (sku_id) DO UPDATE SET sqft_per_box=COALESCE(packaging.sqft_per_box, EXCLUDED.sqft_per_box)`,
      [r.sku_id, SQFT_PER_BOX]);
    await client.query(`UPDATE skus SET sell_by='box', updated_at=now() WHERE id=$1`, [r.sku_id]);
  }
  await client.query('COMMIT');
  console.log(`Applied ${rows.length} SKUs`);
} catch (e) { await client.query('ROLLBACK'); console.error('ROLLBACK:', e.message); process.exit(1); }
finally { client.release(); }
const { rows: prods } = await pool.query('SELECT DISTINCT product_id FROM skus WHERE id = ANY($1)', [rows.map(r => r.sku_id)]);
for (const r of prods) await pool.query('SELECT refresh_search_vectors($1)', [r.product_id]).catch(() => {});
console.log(`Refreshed search vectors (${prods.length} products)`);
await pool.end();
console.log('=== done ===');
