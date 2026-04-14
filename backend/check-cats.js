const { Pool } = require('pg');
const pool = new Pool({ host: 'db', port: 5432, database: 'flooring_pim', user: 'postgres', password: 'postgres' });

(async () => {
  let r = await pool.query(`
    SELECT pc.name as parent, c.name as category,
      COUNT(p.id) as products, COUNT(DISTINCT v.code) as vendors
    FROM products p
    JOIN categories c ON c.id = p.category_id
    LEFT JOIN categories pc ON pc.id = c.parent_id
    JOIN vendors v ON v.id = p.vendor_id
    GROUP BY pc.name, c.name
    ORDER BY pc.name NULLS FIRST, COUNT(p.id) DESC
  `);
  console.log("=== Full Category Breakdown ===");
  let cur = "";
  for (const row of r.rows) {
    const parent = row.parent || "(top-level)";
    if (parent !== cur) { console.log("\n" + parent + ":"); cur = parent; }
    console.log("  " + row.category + ": " + row.products + " products (" + row.vendors + " vendors)");
  }

  r = await pool.query(`
    SELECT COUNT(p.id) as total,
      COUNT(CASE WHEN p.category_id IS NOT NULL THEN 1 END) as categorized,
      COUNT(CASE WHEN p.category_id IS NULL THEN 1 END) as uncategorized
    FROM products p
  `);
  console.log("\nTotal:", r.rows[0].total, "| Categorized:", r.rows[0].categorized, "| Uncategorized:", r.rows[0].uncategorized);

  r = await pool.query(`
    SELECT v.code, v.name, COUNT(p.id) as products
    FROM vendors v JOIN products p ON p.vendor_id = v.id
    GROUP BY v.code, v.name ORDER BY COUNT(p.id) DESC
  `);
  console.log("\nPer Vendor:");
  for (const row of r.rows) console.log("  " + row.code + " " + row.name + ": " + row.products);

  pool.end();
})();
