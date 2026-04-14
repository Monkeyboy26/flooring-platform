const { Pool } = require('pg');
const pool = new Pool({ host: 'db', port: 5432, database: 'flooring_pim', user: 'postgres', password: 'postgres' });

(async () => {
  // Get 10 random DAM URLs and test them
  let r = await pool.query(`
    SELECT ma.url, ma.asset_type, p.name
    FROM media_assets ma
    JOIN products p ON p.id = ma.product_id
    JOIN vendors v ON v.id = p.vendor_id
    WHERE v.code IN ('DAL','AO','MZ')
    AND ma.url LIKE '%digitalassets.daltile%'
    ORDER BY RANDOM() LIMIT 10
  `);

  console.log("=== Testing 10 DAM URLs ===");
  let ok = 0, fail = 0;
  for (const row of r.rows) {
    try {
      const resp = await fetch(row.url, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
      const status = resp.status;
      const ct = (resp.headers.get('content-type') || '').substring(0, 30);
      if (status === 200) ok++;
      else fail++;
      console.log("  " + status + " " + ct + " | " + row.name + "\n    " + row.url.substring(0, 150));
    } catch (err) {
      fail++;
      console.log("  ERR | " + row.name + " | " + err.message);
    }
  }
  console.log("\nOK: " + ok + " | Failed: " + fail);

  // Also test 5 Scene7 URLs for comparison
  r = await pool.query(`
    SELECT ma.url, p.name
    FROM media_assets ma
    JOIN products p ON p.id = ma.product_id
    JOIN vendors v ON v.id = p.vendor_id
    WHERE v.code IN ('DAL','AO','MZ')
    AND ma.url LIKE '%scene7%'
    ORDER BY RANDOM() LIMIT 5
  `);

  console.log("\n=== Testing 5 Scene7 URLs ===");
  for (const row of r.rows) {
    try {
      const resp = await fetch(row.url, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
      console.log("  " + resp.status + " | " + row.name);
    } catch (err) {
      console.log("  ERR | " + row.name);
    }
  }

  // Show the full URL for the Quarry product to see if it's truncated
  r = await pool.query(`
    SELECT ma.url, LENGTH(ma.url) as url_len
    FROM media_assets ma
    JOIN products p ON p.id = ma.product_id
    WHERE LOWER(p.name) LIKE $1
  `, ['%quarry%ember%']);
  console.log("\n=== Quarry Ember Flash URLs (full) ===");
  for (const row of r.rows) {
    console.log("  len=" + row.url_len + " | " + row.url);
  }

  pool.end();
})();
