// Orion (169) L-series → sold per piece — 2026-09-02 session.
//
// Idempotent. L01–L08 (+L03M) are painted Mexican (Talavera) decorative tile sold
// PER PIECE (owner), not per sqft. They arrived via the Orion "L-series countertop
// slabs" price-list section as a per-SF figure ($11.99 cost / $19.09 retail), which
// was the miscategorization. Flip them to sell_by='unit' / price_basis='per_unit' so
// the storefront reads "$X /ea" with a per-piece quantity + Add-to-Cart.
//
// NOTE: the $19.09 retail is CARRIED OVER as the per-piece price (it originally came
// in labeled per-sf). If the real per-piece price differs, it's a one-line update.
// The scraper (orion.js classifyProduct) now emits unit/per_unit for these too.
//
//   docker compose exec -T api node scripts/fix-orion-lseries-per-piece-2026-09-02.mjs

import { pool } from '../db.js';
import { MEXICAN_DECO_TILE } from '../scrapers/orion.js';

async function main() {
  const client = await pool.connect();
  const names = [...MEXICAN_DECO_TILE];               // l01..l08, l03m (lowercase)
  const summary = {};
  try {
    await client.query('BEGIN');

    const sellBy = await client.query(`
      UPDATE skus s SET sell_by = 'unit', updated_at = CURRENT_TIMESTAMP
      FROM products p, vendors v
      WHERE s.product_id = p.id AND p.vendor_id = v.id
        AND v.code = '169' AND lower(p.name) = ANY($1) AND s.sell_by IS DISTINCT FROM 'unit'`,
      [names]);
    summary.sell_by_set_unit = sellBy.rowCount;

    const basis = await client.query(`
      UPDATE pricing pr SET price_basis = 'per_unit'
      FROM skus s, products p, vendors v
      WHERE pr.sku_id = s.id AND s.product_id = p.id AND p.vendor_id = v.id
        AND v.code = '169' AND lower(p.name) = ANY($1) AND pr.price_basis IS DISTINCT FROM 'per_unit'`,
      [names]);
    summary.price_basis_set_per_unit = basis.rowCount;

    await client.query('COMMIT');
    console.log('[fix-orion-lseries-per-piece-2026-09-02] applied:', JSON.stringify(summary, null, 2));
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[fix-orion-lseries-per-piece-2026-09-02] rolled back:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
