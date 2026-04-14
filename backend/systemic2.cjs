const { Pool } = require('pg');
const pool = new Pool({ host: 'db', port: 5432, database: 'flooring_pim', user: 'postgres', password: 'postgres' });

(async () => {
  // Size-only variant SKUs — do they have pricing?
  let r = await pool.query(`
    SELECT
      COUNT(*) as total_size_only,
      COUNT(pr.sku_id) as has_pricing
    FROM skus s
    JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id
    LEFT JOIN pricing pr ON pr.sku_id = s.id
    WHERE v.code IN ('DAL','AO','MZ') AND s.variant_name ~ '^[0-9X/.]+$'
  `);
  console.log("=== Size-only variant SKUs ===");
  console.log("Total:", r.rows[0].total_size_only, "| With pricing:", r.rows[0].has_pricing);

  // How did they get created? Check internal_sku prefix pattern
  r = await pool.query(`
    SELECT
      COUNT(CASE WHEN s.internal_sku LIKE 'DAL-%' THEN 1 END) as dal,
      COUNT(CASE WHEN s.internal_sku LIKE 'AO-%' THEN 1 END) as ao,
      COUNT(CASE WHEN s.internal_sku LIKE 'MZ-%' THEN 1 END) as mz
    FROM skus s
    JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id
    WHERE v.code IN ('DAL','AO','MZ') AND s.variant_name ~ '^[0-9X/.]+$'
  `);
  console.log("By brand:", JSON.stringify(r.rows[0]));

  // Compare: what does a GOOD variant name look like from the pricing scraper?
  r = await pool.query(`
    SELECT s.vendor_sku, s.variant_name, s.variant_type
    FROM skus s
    JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id
    JOIN pricing pr ON pr.sku_id = s.id
    WHERE v.code = 'DAL' AND s.variant_name NOT SIMILAR TO '[0-9X/.]+' AND s.variant_name IS NOT NULL
    ORDER BY RANDOM() LIMIT 10
  `);
  console.log("\n=== Good variant names (from pricing scraper) ===");
  for (const row of r.rows) {
    console.log("  " + row.vendor_sku + " | '" + row.variant_name + "' | " + row.variant_type);
  }

  // === ISSUE 2: Images ===
  r = await pool.query(`
    SELECT
      COUNT(*) as total_images,
      COUNT(CASE WHEN url LIKE '%scene7%' THEN 1 END) as scene7,
      COUNT(CASE WHEN url LIKE '%digitalassets.daltile%' THEN 1 END) as daltile_dam,
      COUNT(CASE WHEN url NOT LIKE '%scene7%' AND url NOT LIKE '%digitalassets.daltile%' THEN 1 END) as other
    FROM media_assets ma
    JOIN products p ON p.id = ma.product_id
    JOIN vendors v ON v.id = p.vendor_id
    WHERE v.code IN ('DAL','AO','MZ')
  `);
  console.log("\n=== Image CDN Breakdown ===");
  console.log(JSON.stringify(r.rows[0]));

  // Sample URLs from each CDN type
  r = await pool.query(`
    SELECT DISTINCT ON (ma.asset_type, CASE WHEN url LIKE '%scene7%' THEN 'scene7' ELSE 'dam' END)
      ma.asset_type,
      CASE WHEN url LIKE '%scene7%' THEN 'scene7' ELSE 'dam' END as cdn,
      ma.url,
      p.name
    FROM media_assets ma
    JOIN products p ON p.id = ma.product_id
    JOIN vendors v ON v.id = p.vendor_id
    WHERE v.code IN ('DAL','AO','MZ')
    ORDER BY ma.asset_type, CASE WHEN url LIKE '%scene7%' THEN 'scene7' ELSE 'dam' END
    LIMIT 8
  `);
  console.log("\nSample URLs:");
  for (const row of r.rows) {
    console.log("  " + row.cdn + " " + row.asset_type + " | " + row.name);
    console.log("    " + row.url);
  }

  // Test: do the DAM URLs actually work? Check URL patterns
  r = await pool.query(`
    SELECT url FROM media_assets ma
    JOIN products p ON p.id = ma.product_id
    JOIN vendors v ON v.id = p.vendor_id
    WHERE v.code IN ('DAL','AO','MZ')
    ORDER BY RANDOM() LIMIT 5
  `);
  console.log("\n=== Random 5 URLs to test ===");
  for (const row of r.rows) console.log("  " + row.url);

  // Products without images
  r = await pool.query(`
    SELECT COUNT(DISTINCT p.id) as no_images
    FROM products p
    JOIN vendors v ON v.id = p.vendor_id
    LEFT JOIN media_assets ma ON ma.product_id = p.id
    WHERE v.code IN ('DAL','AO','MZ') AND ma.id IS NULL
  `);
  const total = await pool.query(`SELECT COUNT(*) as c FROM products p JOIN vendors v ON v.id = p.vendor_id WHERE v.code IN ('DAL','AO','MZ')`);
  console.log("\n=== Image Coverage ===");
  console.log("Products without images:", r.rows[0].no_images, "/", total.rows[0].c);

  pool.end();
})();
