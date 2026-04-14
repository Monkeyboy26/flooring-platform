const { Pool } = require('pg');
const pool = new Pool({ host: 'db', port: 5432, database: 'flooring_pim', user: 'postgres', password: 'postgres' });

(async () => {
  // === Check Novelty Quartz ===
  let r = await pool.query(`
    SELECT p.id, p.name, p.collection, v.code
    FROM products p JOIN vendors v ON v.id = p.vendor_id
    WHERE LOWER(p.name) LIKE '%novelty%quartz%' OR LOWER(p.name) LIKE '%quartz%novelty%'
  `);
  console.log("=== Novelty Quartz Products ===");
  if (r.rows.length === 0) {
    // Try broader search
    r = await pool.query(`
      SELECT p.id, p.name, p.collection, v.code
      FROM products p JOIN vendors v ON v.id = p.vendor_id
      WHERE LOWER(p.name) LIKE '%novelty%'
    `);
  }
  for (const row of r.rows) {
    console.log(row.code + " | " + row.name + " | coll: " + row.collection);
    const media = await pool.query(`SELECT asset_type, url FROM media_assets WHERE product_id = $1`, [row.id]);
    if (media.rows.length === 0) console.log("  NO IMAGES");
    for (const m of media.rows) console.log("  " + m.asset_type + " | " + m.url.substring(0, 120));
  }

  // === How many products are missing images entirely? ===
  r = await pool.query(`
    SELECT v.code,
      COUNT(DISTINCT p.id) as total,
      COUNT(DISTINCT CASE WHEN ma.id IS NOT NULL THEN p.id END) as with_images,
      COUNT(DISTINCT CASE WHEN ma.id IS NULL THEN p.id END) as no_images
    FROM products p
    JOIN vendors v ON v.id = p.vendor_id
    LEFT JOIN media_assets ma ON ma.product_id = p.id
    WHERE v.code IN ('DAL','AO','MZ')
    GROUP BY v.code ORDER BY v.code
  `);
  console.log("\n=== Image Coverage Per Brand ===");
  for (const row of r.rows) {
    console.log(row.code + ": " + row.with_images + "/" + row.total + " have images (" + row.no_images + " missing)");
  }

  // === Check which products are missing images — are they pricing-only? ===
  r = await pool.query(`
    SELECT v.code, p.name, p.collection,
      COUNT(s.id) as skus,
      COUNT(pr.sku_id) as with_pricing
    FROM products p
    JOIN vendors v ON v.id = p.vendor_id
    LEFT JOIN media_assets ma ON ma.product_id = p.id
    LEFT JOIN skus s ON s.product_id = p.id
    LEFT JOIN pricing pr ON pr.sku_id = s.id
    WHERE v.code IN ('DAL','AO','MZ') AND ma.id IS NULL
    GROUP BY v.code, p.name, p.collection
    ORDER BY COUNT(pr.sku_id) DESC
    LIMIT 20
  `);
  console.log("\n=== Top 20 Products Without Images (by pricing count) ===");
  for (const row of r.rows) {
    console.log(row.code + " | " + row.name + " | coll: " + row.collection + " | skus: " + row.skus + " | priced: " + row.with_pricing);
  }

  // === Batch test 20 random DAM URLs ===
  r = await pool.query(`
    SELECT ma.url, p.name
    FROM media_assets ma
    JOIN products p ON p.id = ma.product_id
    JOIN vendors v ON v.id = p.vendor_id
    WHERE v.code IN ('DAL','AO','MZ') AND ma.url LIKE '%digitalassets.daltile%'
    ORDER BY RANDOM() LIMIT 20
  `);
  console.log("\n=== Testing 20 Random DAM URLs ===");
  let ok = 0, fail = 0;
  for (const row of r.rows) {
    try {
      const resp = await fetch(row.url, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
      if (resp.status === 200) ok++;
      else {
        fail++;
        console.log("  " + resp.status + " | " + row.name + " | " + row.url.substring(0, 100));
      }
    } catch (err) {
      fail++;
      console.log("  ERR | " + row.name);
    }
  }
  console.log("  OK: " + ok + " | Failed: " + fail + " / 20");

  pool.end();
})();
