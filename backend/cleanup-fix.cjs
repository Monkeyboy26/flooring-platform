const { Pool } = require('pg');
const pool = new Pool({ host: 'db', port: 5432, database: 'flooring_pim', user: 'postgres', password: 'postgres' });

(async () => {
  // === Part 1: Test ALL DAM URLs and delete 404s ===
  const damUrls = await pool.query(`
    SELECT ma.id, ma.url, p.name
    FROM media_assets ma
    JOIN products p ON p.id = ma.product_id
    JOIN vendors v ON v.id = p.vendor_id
    WHERE v.code IN ('DAL','AO','MZ') AND ma.url LIKE '%digitalassets.daltile%'
  `);

  console.log("Testing " + damUrls.rows.length + " DAM URLs...");
  const broken = [];
  let ok = 0;
  const batchSize = 10;

  for (let i = 0; i < damUrls.rows.length; i += batchSize) {
    const batch = damUrls.rows.slice(i, i + batchSize);
    const results = await Promise.all(batch.map(async (row) => {
      try {
        const resp = await fetch(row.url, { method: 'HEAD', signal: AbortSignal.timeout(8000) });
        return { id: row.id, status: resp.status, name: row.name };
      } catch (err) {
        return { id: row.id, status: 0, name: row.name };
      }
    }));

    for (const r of results) {
      if (r.status === 200) ok++;
      else broken.push(r);
    }

    if ((i + batchSize) % 50 === 0) {
      process.stdout.write("  " + (i + batchSize) + "/" + damUrls.rows.length + " checked... ");
      console.log("ok:" + ok + " broken:" + broken.length);
    }
  }

  console.log("\nDAM URL results: OK=" + ok + " Broken=" + broken.length + " / " + damUrls.rows.length);

  if (broken.length > 0) {
    console.log("\nBroken URLs:");
    for (const b of broken.slice(0, 10)) {
      console.log("  " + b.status + " | " + b.name);
    }

    // Delete broken URLs
    const brokenIds = broken.map(b => b.id);
    await pool.query('DELETE FROM media_assets WHERE id = ANY($1)', [brokenIds]);
    console.log("\nDeleted " + brokenIds.length + " broken DAM URLs");
  }

  // === Part 2: Update size-only variant names with attribute data ===
  console.log("\n=== Fixing size-only variant names ===");
  const sizeOnlySkus = await pool.query(`
    SELECT s.id, s.variant_name
    FROM skus s
    JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id
    WHERE v.code IN ('DAL','AO','MZ') AND s.variant_name ~ '^[0-9X/.]+$'
  `);
  console.log("Found " + sizeOnlySkus.rows.length + " size-only SKUs");

  let fixed = 0;
  for (const sku of sizeOnlySkus.rows) {
    // Get finish and shape attributes
    const attrs = await pool.query(`
      SELECT a.slug, sa.value
      FROM sku_attributes sa JOIN attributes a ON a.id = sa.attribute_id
      WHERE sa.sku_id = $1 AND a.slug IN ('finish', 'shape')
    `, [sku.id]);

    const attrMap = {};
    for (const a of attrs.rows) attrMap[a.slug] = a.value;

    const parts = [sku.variant_name]; // size
    if (attrMap.shape) parts.push(attrMap.shape);
    if (attrMap.finish) parts.push(attrMap.finish);

    if (parts.length > 1) {
      const newName = parts.join(', ');
      await pool.query('UPDATE skus SET variant_name = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [newName, sku.id]);
      fixed++;
    }
  }
  console.log("Fixed " + fixed + " variant names");

  pool.end();
})();
