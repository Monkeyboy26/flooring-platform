const { Pool } = require('pg');
const pool = new Pool({ host: 'db', port: 5432, database: 'flooring_pim', user: 'postgres', password: 'postgres' });

(async () => {
  // Find broken-looking URLs (no extension, no query params, ending in slash or short path)
  let r = await pool.query(`
    SELECT ma.url, ma.asset_type, p.name
    FROM media_assets ma
    JOIN products p ON p.id = ma.product_id
    JOIN vendors v ON v.id = p.vendor_id
    WHERE v.code IN ('DAL','AO','MZ')
    AND ma.url NOT LIKE '%.jpeg'
    AND ma.url NOT LIKE '%.jpg'
    AND ma.url NOT LIKE '%.png'
    AND ma.url NOT LIKE '%.tif%'
    AND ma.url NOT LIKE '%$%'
    ORDER BY RANDOM() LIMIT 20
  `);
  console.log("=== URLs without extensions or transforms (" + r.rows.length + " sample) ===");
  for (const row of r.rows) {
    console.log("  " + row.asset_type + " | " + row.name + "\n    " + row.url);
  }

  // Count broken patterns
  r = await pool.query(`
    SELECT
      COUNT(*) as total,
      COUNT(CASE WHEN url LIKE '%$TRIMTHUMBNAIL$' THEN 1 END) as scene7_thumb,
      COUNT(CASE WHEN url LIKE '%cq5dam.web%' THEN 1 END) as dam_rendition,
      COUNT(CASE WHEN url LIKE '%/' THEN 1 END) as ends_with_slash,
      COUNT(CASE WHEN url NOT LIKE '%$%' AND url NOT LIKE '%.jpeg' AND url NOT LIKE '%.jpg' AND url NOT LIKE '%.png' AND url NOT LIKE '%.tif%' THEN 1 END) as no_ext_or_transform
    FROM media_assets ma
    JOIN products p ON p.id = ma.product_id
    JOIN vendors v ON v.id = p.vendor_id
    WHERE v.code IN ('DAL','AO','MZ')
  `);
  console.log("\n=== URL Pattern Breakdown ===");
  console.log(JSON.stringify(r.rows[0], null, 2));

  // Test a few URLs
  const testUrls = [
    'https://s7d9.scene7.com/is/image/daltile/DAL_GW05_6x24_Hickory?$TRIMTHUMBNAIL$',
    'https://digitalassets.daltile.com/content/dam/AmericanOlean/AO_ImageFiles/QuarryTile/web/AO_0Q02_6X6',
    'https://digitalassets.daltile.com/content/dam/AmericanOlean/AO_ImageFiles/QuarryTile/web/roomscenes/',
  ];

  console.log("\n=== Testing URLs ===");
  for (const url of testUrls) {
    try {
      const resp = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
      const contentType = resp.headers.get('content-type') || '';
      console.log("  " + resp.status + " " + contentType.substring(0, 30) + " | " + url.substring(0, 80));
    } catch (err) {
      console.log("  ERROR " + err.message + " | " + url.substring(0, 80));
    }
  }

  pool.end();
})();
