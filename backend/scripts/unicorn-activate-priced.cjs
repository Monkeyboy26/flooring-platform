/**
 * unicorn-activate-priced.cjs
 *
 * Unicorn Tile Corp visibility was gated on per-SKU images: SKUs/products without a
 * matched photo from unicorntiles.com were left in draft or batch-deactivated
 * (2026-05-09), hiding priced variants like "Nano Black Polished 24x48" from the
 * storefront. Per owner direction, we no longer gate visibility on images — flooring
 * size/finish variants share the product/color look.
 *
 * This activates every Unicorn SKU that has a real price (retail_price > 0) but is
 * currently draft/inactive, then activates any product that now has an active SKU.
 * Discontinued/zero-priced SKUs are left untouched.
 *
 *   node backend/scripts/unicorn-activate-priced.cjs            # dry run
 *   node backend/scripts/unicorn-activate-priced.cjs --commit   # apply
 */
const { Pool } = require('pg');
const COMMIT = process.argv.includes('--commit');
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: 5432, database: 'flooring_pim', user: 'postgres', password: 'postgres',
});

async function run() {
  const { rows: v } = await pool.query("SELECT id FROM vendors WHERE code='UN'");
  if (!v.length) throw new Error('Unicorn vendor (UN) not found');
  const vendorId = v[0].id;

  const { rows: [before] } = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE s.status='active') active,
      COUNT(*) FILTER (WHERE s.status IN ('draft','inactive') AND pr.retail_price>0) hidden_priced
    FROM products p JOIN skus s ON s.product_id=p.id
    LEFT JOIN pricing pr ON pr.sku_id=s.id
    WHERE p.vendor_id=$1`, [vendorId]);
  console.log(`=== Unicorn activate-priced — ${COMMIT ? 'COMMIT' : 'DRY RUN'} ===`);
  console.log(`Active SKUs: ${before.active} | hidden-but-priced SKUs to activate: ${before.hidden_priced}`);

  if (!COMMIT) {
    const { rows } = await pool.query(`
      SELECT p.name, s.variant_name, s.status, pr.retail_price
      FROM products p JOIN skus s ON s.product_id=p.id
      LEFT JOIN pricing pr ON pr.sku_id=s.id
      WHERE p.vendor_id=$1 AND s.status IN ('draft','inactive') AND pr.retail_price>0
      ORDER BY p.name, s.variant_name LIMIT 20`, [vendorId]);
    console.log('Sample to activate:');
    rows.forEach(r => console.log(`  + ${r.name} — ${r.variant_name} (${r.status}) $${r.retail_price}`));
    console.log('\nDry run — re-run with --commit to apply.');
    await pool.end();
    return;
  }

  const sku = await pool.query(`
    UPDATE skus SET status='active'
    WHERE product_id IN (SELECT id FROM products WHERE vendor_id=$1)
      AND status IN ('draft','inactive')
      AND EXISTS (SELECT 1 FROM pricing pr WHERE pr.sku_id=skus.id AND pr.retail_price>0)
    RETURNING id`, [vendorId]);
  console.log(`Activated ${sku.rowCount} SKUs`);

  const prod = await pool.query(`
    UPDATE products SET status='active'
    WHERE vendor_id=$1 AND status IN ('draft','inactive')
      AND EXISTS (SELECT 1 FROM skus s WHERE s.product_id=products.id AND s.status='active')
    RETURNING id`, [vendorId]);
  console.log(`Activated ${prod.rowCount} products`);

  for (const r of prod.rows) await pool.query('SELECT refresh_search_vectors($1)', [r.id]);
  // also refresh products whose SKUs changed but product was already active
  const { rows: allProds } = await pool.query('SELECT id FROM products WHERE vendor_id=$1', [vendorId]);
  for (const r of allProds) await pool.query('SELECT refresh_search_vectors($1)', [r.id]);
  console.log('Search vectors refreshed. Done.');
  await pool.end();
}
run().catch(e => { console.error(e); process.exit(1); });
