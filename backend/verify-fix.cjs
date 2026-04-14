const { Pool } = require('pg');
const pool = new Pool({ host: 'db', port: 5432, database: 'flooring_pim', user: 'postgres', password: 'postgres' });

(async () => {
  // Check Quarry Regular Ember Flash
  console.log("=== Quarry Regular Ember Flash ===");
  let r = await pool.query(`
    SELECT s.vendor_sku, s.variant_name, s.variant_type
    FROM skus s JOIN products p ON p.id = s.product_id
    WHERE LOWER(p.name) LIKE $1
    ORDER BY s.variant_name
  `, ['%quarry%ember%']);
  for (const row of r.rows) {
    console.log("  " + row.vendor_sku + " | " + row.variant_name + " | " + row.variant_type);
  }
  r = await pool.query(`
    SELECT ma.asset_type, ma.url
    FROM media_assets ma JOIN products p ON p.id = ma.product_id
    WHERE LOWER(p.name) LIKE $1
  `, ['%quarry%ember%']);
  console.log("  Images: " + r.rows.length);
  for (const m of r.rows) console.log("  " + m.asset_type + " | " + m.url.substring(0, 100));

  // Check Novelty Quartz
  console.log("\n=== Novelty Quartz ===");
  r = await pool.query(`
    SELECT s.vendor_sku, s.variant_name, s.variant_type
    FROM skus s JOIN products p ON p.id = s.product_id
    WHERE LOWER(p.name) LIKE $1
    ORDER BY s.variant_name
  `, ['%novelty%']);
  for (const row of r.rows) {
    console.log("  " + row.vendor_sku + " | " + row.variant_name + " | " + row.variant_type);
  }
  r = await pool.query(`
    SELECT ma.asset_type, ma.url
    FROM media_assets ma JOIN products p ON p.id = ma.product_id
    WHERE LOWER(p.name) LIKE $1
  `, ['%novelty%']);
  console.log("  Images: " + r.rows.length);
  for (const m of r.rows) console.log("  " + m.asset_type + " | " + m.url.substring(0, 100));

  // Check a sample of the fixed variant names
  console.log("\n=== Sample Fixed Variant Names ===");
  r = await pool.query(`
    SELECT p.name, s.vendor_sku, s.variant_name
    FROM skus s JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id
    WHERE v.code IN ('DAL','AO','MZ') AND s.variant_name LIKE '%,%'
    ORDER BY RANDOM() LIMIT 10
  `);
  for (const row of r.rows) {
    console.log("  " + row.name + " | " + row.vendor_sku + " | " + row.variant_name);
  }

  // Final stats
  console.log("\n=== Overall Stats ===");
  r = await pool.query(`
    SELECT
      COUNT(DISTINCT p.id) as total_products,
      COUNT(DISTINCT CASE WHEN ma.id IS NOT NULL THEN p.id END) as with_images,
      COUNT(DISTINCT s.id) as total_skus,
      COUNT(DISTINCT CASE WHEN s.variant_name ~ '^[0-9X/.]+$' THEN s.id END) as size_only_names
    FROM products p
    JOIN vendors v ON v.id = p.vendor_id
    JOIN skus s ON s.product_id = p.id
    LEFT JOIN media_assets ma ON ma.product_id = p.id
    WHERE v.code IN ('DAL','AO','MZ')
  `);
  const row = r.rows[0];
  console.log("Products: " + row.total_products + " (" + row.with_images + " with images, " + (row.total_products - row.with_images) + " without)");
  console.log("SKUs: " + row.total_skus + " (size-only names remaining: " + row.size_only_names + ")");

  pool.end();
})();
