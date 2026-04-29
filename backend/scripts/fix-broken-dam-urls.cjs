const { Pool } = require('pg');
const pool = new Pool({ host: 'localhost', database: 'flooring_pim', user: 'postgres', password: 'postgres' });

async function main() {
  // Find remaining broken DAM URLs (still pointing to non-existent renditions)
  const res = await pool.query(`
    SELECT m.id, m.url, m.product_id, m.sku_id, m.asset_type, m.source
    FROM media_assets m
    WHERE m.url LIKE '%digitalassets.daltile.com%.tif/jcr:content/renditions/cq5dam.web.1280.1280.jpeg'
  `);
  
  console.log(`Checking ${res.rows.length} remaining .tif 1280 URLs...`);
  let ok = 0, broken = 0;
  const brokenRows = [];
  
  for (let i = 0; i < res.rows.length; i += 15) {
    const batch = res.rows.slice(i, i + 15);
    const results = await Promise.all(batch.map(async (row) => {
      try {
        const r = await fetch(row.url, { method: 'HEAD', signal: AbortSignal.timeout(8000) });
        return { ...row, works: r.ok };
      } catch { return { ...row, works: false }; }
    }));
    
    for (const r of results) {
      if (r.works) ok++;
      else { broken++; brokenRows.push(r); }
    }
  }
  
  console.log(`Working: ${ok}, Broken: ${broken}`);
  
  // For broken ones, try to find a Scene7 URL from siblings
  console.log(`\nLooking for sibling images for ${brokenRows.length} broken URLs...`);
  let siblingFixed = 0, deleted = 0;
  
  for (const row of brokenRows) {
    if (!row.sku_id) {
      // Product-level image — delete it (SKUs may have their own)
      await pool.query('DELETE FROM media_assets WHERE id = $1', [row.id]);
      deleted++;
      continue;
    }
    
    // Check if there's a working sibling image in the same product
    const sibRes = await pool.query(`
      SELECT DISTINCT m.url 
      FROM media_assets m 
      JOIN skus s ON s.id = m.sku_id
      WHERE s.product_id = $1 AND m.sku_id != $2 
        AND m.asset_type = $3 AND m.url NOT LIKE '%/renditions/cq5dam.web.1280.1280.jpeg'
        AND m.url NOT LIKE '%/renditions/original'
      LIMIT 1
    `, [row.product_id, row.sku_id, row.asset_type]);
    
    if (sibRes.rows.length > 0) {
      // Use sibling image
      await pool.query('UPDATE media_assets SET url = $1, source = $2 WHERE id = $3', 
        [sibRes.rows[0].url, 'sibling-fallback', row.id]);
      siblingFixed++;
    } else {
      // No sibling — delete so browse falls back through COALESCE chain
      await pool.query('DELETE FROM media_assets WHERE id = $1', [row.id]);
      deleted++;
    }
  }
  
  console.log(`Sibling-fixed: ${siblingFixed}, Deleted (no fallback): ${deleted}`);
  
  // Also handle any remaining .jpg/renditions/original that got reverted
  // These are valid JPEG but very large (10MB+) — let's just leave them for now since they work
  const jpgOriginals = await pool.query(`
    SELECT COUNT(*) as cnt FROM media_assets 
    WHERE url LIKE '%digitalassets.daltile.com%.jpg/jcr:content/renditions/original'
  `);
  console.log(`\nRemaining .jpg originals (large but functional): ${jpgOriginals.rows[0].cnt}`);
  
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
