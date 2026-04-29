const { Pool } = require('pg');
const pool = new Pool({ host: 'localhost', database: 'flooring_pim', user: 'postgres', password: 'postgres' });

async function main() {
  // Find SKUs that have no image but have siblings with images
  const res = await pool.query(`
    SELECT s.id as sku_id, s.product_id, s.vendor_sku, p.name,
      (SELECT m2.url FROM media_assets m2 
       JOIN skus sib ON sib.id = m2.sku_id 
       WHERE sib.product_id = s.product_id AND sib.id != s.id 
         AND m2.asset_type = 'primary'
       LIMIT 1) as sibling_url
    FROM skus s
    JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id
    WHERE v.code = 'DAL' AND s.status = 'active' AND p.status = 'active'
      AND s.variant_type IS DISTINCT FROM 'accessory'
      AND NOT EXISTS(SELECT 1 FROM media_assets m WHERE m.sku_id = s.id AND m.asset_type = 'primary')
    ORDER BY p.name
  `);
  
  let siblingCopied = 0, productLevel = 0, noImage = 0;
  const noImageProducts = new Set();
  
  for (const row of res.rows) {
    if (row.sibling_url) {
      await pool.query(`
        INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order, source)
        VALUES ($1, $2, 'primary', $3, $3, 0, 'sibling-fallback')
        ON CONFLICT (product_id, sku_id, asset_type, sort_order) WHERE sku_id IS NOT NULL
        DO UPDATE SET url = EXCLUDED.url, source = EXCLUDED.source
      `, [row.product_id, row.sku_id, row.sibling_url]);
      siblingCopied++;
    } else {
      // Check for product-level image
      const pRes = await pool.query(`
        SELECT url FROM media_assets WHERE product_id = $1 AND sku_id IS NULL AND asset_type = 'primary' LIMIT 1
      `, [row.product_id]);
      
      if (pRes.rows.length > 0) {
        productLevel++;
      } else {
        noImage++;
        noImageProducts.add(row.name);
      }
    }
  }
  
  console.log(`Sibling-copied: ${siblingCopied}`);
  console.log(`Has product-level fallback: ${productLevel}`);
  console.log(`No image at all: ${noImage} (${noImageProducts.size} products)`);
  
  if (noImageProducts.size > 0) {
    console.log('\nImageless products:');
    for (const name of noImageProducts) console.log(`  ${name}`);
  }
  
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
