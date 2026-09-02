// Orion (169) slab sell_by fix — 2026-09-02 session.
//
// Idempotent. The slab program is priced PER SQUARE FOOT (Orion quotes slabs "per
// SF"; we have no per-product slab dimensions, so no per-slab conversion — owner
// call). The rows were left as sell_by='box' (implies a carton that doesn't exist),
// which mis-displays the price. Flip them to sell_by='sqft' so the storefront shows
// and sells them as $X/sqft. price_basis stays per_sqft (backfilled where null).
// The scraper already emits sqft/per_sqft for slabs (classifyProduct), so this only
// aligns existing rows; future scrapes stay correct.
//
//   docker compose exec -T api node scripts/fix-orion-slab-sellby-2026-09-02.mjs
//   (prod) ssh ubuntu@32.188.96.3 -i roma-prod.pem
//          docker compose exec -T api node scripts/fix-orion-slab-sellby-2026-09-02.mjs

import { pool } from '../db.js';

const SLAB_LEAVES = ['porcelain-slabs', 'marble-countertops', 'quartzite-countertops',
  'granite-countertops', 'quartz-countertops', 'soapstone-countertops'];

async function main() {
  const client = await pool.connect();
  const summary = {};
  try {
    await client.query('BEGIN');

    const sellBy = await client.query(`
      UPDATE skus s SET sell_by = 'sqft', updated_at = CURRENT_TIMESTAMP
      FROM products p, vendors v, categories c
      WHERE s.product_id = p.id AND p.vendor_id = v.id AND p.category_id = c.id
        AND v.code = '169' AND c.slug = ANY($1) AND s.sell_by = 'box'`,
      [SLAB_LEAVES]);
    summary.sell_by_box_to_sqft = sellBy.rowCount;

    const basis = await client.query(`
      UPDATE pricing pr SET price_basis = 'per_sqft'
      FROM skus s, products p, vendors v, categories c
      WHERE pr.sku_id = s.id AND s.product_id = p.id AND p.vendor_id = v.id AND p.category_id = c.id
        AND v.code = '169' AND c.slug = ANY($1) AND pr.price_basis IS DISTINCT FROM 'per_sqft'`,
      [SLAB_LEAVES]);
    summary.price_basis_set = basis.rowCount;

    await client.query('COMMIT');
    console.log('[fix-orion-slab-sellby-2026-09-02] applied:', JSON.stringify(summary, null, 2));
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[fix-orion-slab-sellby-2026-09-02] rolled back:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
