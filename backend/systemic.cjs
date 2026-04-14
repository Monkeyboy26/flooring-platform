const { Pool } = require('pg');
const pool = new Pool({ host: 'db', port: 5432, database: 'flooring_pim', user: 'postgres', password: 'postgres' });

(async () => {
  // === ISSUE 1: Variant names that are ONLY a size (no description) ===
  let r = await pool.query(`
    SELECT COUNT(*) as total,
      COUNT(CASE WHEN s.variant_name ~ '^[0-9X/.]+$' THEN 1 END) as size_only,
      COUNT(CASE WHEN s.variant_name IS NULL THEN 1 END) as null_name,
      COUNT(CASE WHEN s.variant_name IS NOT NULL AND s.variant_name !~ '^[0-9X/.]+$' THEN 1 END) as has_description
    FROM skus s
    JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id
    WHERE v.code IN ('DAL','AO','MZ')
  `);
  console.log("=== ISSUE 1: Variant Name Quality ===");
  console.log("Total SKUs:", r.rows[0].total);
  console.log("Size-only variant_name (e.g., '6X6'):", r.rows[0].size_only);
  console.log("Null variant_name:", r.rows[0].null_name);
  console.log("Has actual description:", r.rows[0].has_description);

  // Sample size-only variants
  r = await pool.query(`
    SELECT p.name, s.vendor_sku, s.variant_name, s.variant_type
    FROM skus s
    JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id
    WHERE v.code IN ('DAL','AO','MZ') AND s.variant_name ~ '^[0-9X/.]+$'
    ORDER BY RANDOM() LIMIT 15
  `);
  console.log("\nSample size-only SKUs:");
  for (const row of r.rows) {
    console.log("  " + row.name + " | " + row.vendor_sku + " | variant: '" + row.variant_name + "' | type: " + row.variant_type);
  }

  // Check: are these all catalog-only (no pricing)?
  r = await pool.query(`
    SELECT
      COUNT(*) as total_size_only,
      COUNT(pr.id) as has_pricing
    FROM skus s
    JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id
    LEFT JOIN pricing pr ON pr.sku_id = s.id
    WHERE v.code IN ('DAL','AO','MZ') AND s.variant_name ~ '^[0-9X/.]+$'
  `);
  console.log("\nSize-only SKUs with pricing:", r.rows[0].has_pricing, "/ total:", r.rows[0].total_size_only);

  // === ISSUE 2: Image URLs ===
  r = await pool.query(`
    SELECT
      COUNT(*) as total_images,
      COUNT(CASE WHEN url LIKE '%.jpg' OR url LIKE '%.png' OR url LIKE '%.jpeg' OR url LIKE '%.webp' THEN 1 END) as has_extension,
      COUNT(CASE WHEN url NOT LIKE '%.jpg' AND url NOT LIKE '%.png' AND url NOT LIKE '%.jpeg' AND url NOT LIKE '%.webp' AND url NOT LIKE '%?' THEN 1 END) as no_extension
    FROM media_assets ma
    JOIN products p ON p.id = ma.product_id
    JOIN vendors v ON v.id = p.vendor_id
    WHERE v.code IN ('DAL','AO','MZ')
  `);
  console.log("\n=== ISSUE 2: Image URL Quality ===");
  console.log("Total images:", r.rows[0].total_images);
  console.log("Has file extension:", r.rows[0].has_extension);
  console.log("Missing extension:", r.rows[0].no_extension);

  // Sample image URLs
  r = await pool.query(`
    SELECT ma.asset_type, ma.url, p.name
    FROM media_assets ma
    JOIN products p ON p.id = ma.product_id
    JOIN vendors v ON v.id = p.vendor_id
    WHERE v.code IN ('DAL','AO','MZ')
    ORDER BY RANDOM() LIMIT 10
  `);
  console.log("\nSample image URLs:");
  for (const row of r.rows) {
    console.log("  " + row.asset_type + " | " + row.name + " | " + row.url.substring(0, 120));
  }

  // Check how many products have images vs don't
  r = await pool.query(`
    SELECT
      COUNT(DISTINCT p.id) as total_products,
      COUNT(DISTINCT CASE WHEN ma.id IS NOT NULL THEN p.id END) as with_images,
      COUNT(DISTINCT CASE WHEN ma.id IS NULL THEN p.id END) as without_images
    FROM products p
    JOIN vendors v ON v.id = p.vendor_id
    LEFT JOIN media_assets ma ON ma.product_id = p.id
    WHERE v.code IN ('DAL','AO','MZ')
  `);
  console.log("\n=== Product Image Coverage ===");
  console.log("With images:", r.rows[0].with_images, "/ total:", r.rows[0].total_products);
  console.log("Without images:", r.rows[0].without_images);

  // Check: do Scene7 URLs work (they typically don't need extensions)?
  r = await pool.query(`
    SELECT
      COUNT(CASE WHEN url LIKE '%scene7%' THEN 1 END) as scene7,
      COUNT(CASE WHEN url LIKE '%digitalassets.daltile%' THEN 1 END) as daltile_dam,
      COUNT(CASE WHEN url NOT LIKE '%scene7%' AND url NOT LIKE '%digitalassets.daltile%' THEN 1 END) as other
    FROM media_assets ma
    JOIN products p ON p.id = ma.product_id
    JOIN vendors v ON v.id = p.vendor_id
    WHERE v.code IN ('DAL','AO','MZ')
  `);
  console.log("\nImage CDN breakdown:");
  console.log("  Scene7:", r.rows[0].scene7);
  console.log("  Daltile DAM:", r.rows[0].daltile_dam);
  console.log("  Other:", r.rows[0].other);

  pool.end();
})();
