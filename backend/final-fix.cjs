const { Pool } = require('pg');
const pool = new Pool({ host: 'db', port: 5432, database: 'flooring_pim', user: 'postgres', password: 'postgres' });

(async () => {
  // === Clean any remaining broken URLs (ending in / or too short) ===
  let r = await pool.query(`
    SELECT id, url FROM media_assets
    WHERE url LIKE '%/' OR LENGTH(url) < 50
  `);
  console.log("Broken URLs (ending in / or too short):", r.rows.length);
  for (const row of r.rows) console.log("  " + row.url);
  if (r.rows.length > 0) {
    await pool.query('DELETE FROM media_assets WHERE id = ANY($1)', [r.rows.map(r => r.id)]);
    console.log("Deleted " + r.rows.length);
  }

  // === Test all remaining non-Scene7 URLs ===
  r = await pool.query(`
    SELECT ma.id, ma.url, p.name
    FROM media_assets ma
    JOIN products p ON p.id = ma.product_id
    WHERE ma.url NOT LIKE '%scene7%'
  `);
  console.log("\n=== Testing " + r.rows.length + " non-Scene7 URLs ===");
  let broken = [];
  for (let i = 0; i < r.rows.length; i += 10) {
    const batch = r.rows.slice(i, i + 10);
    const results = await Promise.all(batch.map(async (row) => {
      try {
        const resp = await fetch(row.url, { method: 'HEAD', signal: AbortSignal.timeout(8000) });
        return { id: row.id, status: resp.status, name: row.name, url: row.url };
      } catch (err) {
        return { id: row.id, status: 0, name: row.name, url: row.url };
      }
    }));
    for (const res of results) {
      if (res.status !== 200) broken.push(res);
    }
  }
  console.log("Broken: " + broken.length + " / " + r.rows.length);
  if (broken.length > 0) {
    for (const b of broken.slice(0, 5)) console.log("  " + b.status + " | " + b.name + " | " + b.url.substring(0, 100));
    await pool.query('DELETE FROM media_assets WHERE id = ANY($1)', [broken.map(b => b.id)]);
    console.log("Deleted " + broken.length + " broken URLs");
  }

  // === Try to find Novelty on the AO website ===
  console.log("\n=== Searching Coveo for 'Novelty' ===");
  const resp = await fetch('https://www.americanolean.com/coveo/rest/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({
      q: 'Novelty',
      aq: '@sitetargethostname=="www.americanolean.com" @sourcedisplayname==product',
      firstResult: 0,
      numberOfResults: 10,
      fieldsToInclude: ['sku', 'seriesname', 'colornameenglish', 'productimageurl', 'primaryroomsceneurl'],
    }),
    signal: AbortSignal.timeout(10000),
  });
  const data = await resp.json();
  console.log("Coveo results for 'Novelty':", data.totalCount);
  for (const result of (data.results || [])) {
    const raw = result.raw || {};
    console.log("  " + (raw.seriesname || '') + " | " + (raw.colornameenglish || '') + " | SKU:" + (raw.sku || ''));
    console.log("    img: " + (raw.productimageurl || '(none)').substring(0, 80));
  }

  // === Final coverage ===
  r = await pool.query(`
    SELECT v.code,
      COUNT(DISTINCT p.id) as total,
      COUNT(DISTINCT CASE WHEN ma.id IS NOT NULL THEN p.id END) as with_images
    FROM products p
    JOIN vendors v ON v.id = p.vendor_id
    LEFT JOIN media_assets ma ON ma.product_id = p.id
    WHERE v.code IN ('DAL','AO','MZ')
    GROUP BY v.code ORDER BY v.code
  `);
  console.log("\n=== Final Image Coverage ===");
  for (const row of r.rows) {
    const pct = Math.round(100 * row.with_images / row.total);
    console.log(row.code + ": " + row.with_images + "/" + row.total + " (" + pct + "%)");
  }

  pool.end();
})();
