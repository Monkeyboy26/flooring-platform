const { Pool } = require('pg');
const pool = new Pool({ host: 'db', port: 5432, database: 'flooring_pim', user: 'postgres', password: 'postgres' });

(async () => {
  // Find the product
  const p = await pool.query(`
    SELECT p.id, p.name, p.collection, v.code
    FROM products p JOIN vendors v ON v.id = p.vendor_id
    WHERE LOWER(p.name) LIKE $1
  `, ['%quarry%ember%']);
  console.log("=== Product ===");
  for (const row of p.rows) console.log(row.code, row.id, row.name, "| coll:", row.collection);

  if (p.rows.length === 0) { console.log("Not found!"); pool.end(); return; }
  const pid = p.rows[0].id;

  // Get all SKUs
  const skus = await pool.query(`
    SELECT s.id, s.vendor_sku, s.internal_sku, s.variant_name, s.variant_type, s.sell_by
    FROM skus s WHERE s.product_id = $1
    ORDER BY s.variant_name
  `, [pid]);
  console.log("\n=== SKUs (" + skus.rows.length + ") ===");
  for (const s of skus.rows) {
    console.log("  " + s.vendor_sku + " | variant: " + s.variant_name + " | type: " + s.variant_type);
  }

  // Get media assets
  const media = await pool.query(`
    SELECT ma.id, ma.asset_type, ma.url, ma.original_url, ma.sku_id, ma.sort_order
    FROM media_assets ma WHERE ma.product_id = $1
    ORDER BY ma.sort_order
  `, [pid]);
  console.log("\n=== Media Assets (" + media.rows.length + ") ===");
  for (const m of media.rows) {
    const urlShort = (m.url || "(null)").substring(0, 100);
    console.log("  " + m.asset_type + " | " + urlShort + " | sku_id:" + m.sku_id);
  }

  // Get attributes
  const attrs = await pool.query(`
    SELECT s.vendor_sku, a.slug, sa.value
    FROM sku_attributes sa
    JOIN attributes a ON a.id = sa.attribute_id
    JOIN skus s ON s.id = sa.sku_id
    WHERE s.product_id = $1
    ORDER BY s.vendor_sku, a.slug
  `, [pid]);
  console.log("\n=== Attributes ===");
  for (const a of attrs.rows) {
    console.log("  " + a.vendor_sku + " | " + a.slug + ": " + a.value);
  }

  // Get pricing for SKUs
  const pricing = await pool.query(`
    SELECT s.vendor_sku, pr.cost, pr.retail_price, pr.price_basis
    FROM pricing pr
    JOIN skus s ON s.id = pr.sku_id
    WHERE s.product_id = $1
    ORDER BY s.vendor_sku
  `, [pid]);
  console.log("\n=== Pricing ===");
  for (const pr of pricing.rows) {
    console.log("  " + pr.vendor_sku + " | cost: $" + pr.cost + " | basis: " + pr.price_basis);
  }

  pool.end();
})();
