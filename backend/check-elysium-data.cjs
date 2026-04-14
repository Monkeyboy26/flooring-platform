const { Pool } = require('pg');
const pool = new Pool({ host: 'db', port: 5432, database: 'flooring_pim', user: 'postgres', password: 'postgres' });

(async () => {
  const vendorId = (await pool.query("SELECT id FROM vendors WHERE code = 'ELY'")).rows[0]?.id;
  if (!vendorId) { console.log('Vendor ELY not found'); process.exit(1); }

  const products = await pool.query('SELECT COUNT(*)::int as cnt, status FROM products WHERE vendor_id = $1 GROUP BY status', [vendorId]);
  console.log('Products by status:', products.rows);

  const skus = await pool.query('SELECT COUNT(*)::int as cnt FROM skus WHERE product_id IN (SELECT id FROM products WHERE vendor_id = $1)', [vendorId]);
  console.log('Total SKUs:', skus.rows[0].cnt);

  const images = await pool.query('SELECT COUNT(*)::int as cnt, asset_type FROM media_assets WHERE product_id IN (SELECT id FROM products WHERE vendor_id = $1) GROUP BY asset_type', [vendorId]);
  console.log('Images by type:', images.rows);

  const noImg = await pool.query('SELECT COUNT(*)::int as cnt FROM products WHERE vendor_id = $1 AND id NOT IN (SELECT DISTINCT product_id FROM media_assets WHERE product_id IS NOT NULL)', [vendorId]);
  console.log('Products without images:', noImg.rows[0].cnt);

  const attrs = await pool.query(`SELECT a.name, COUNT(*)::int as cnt FROM sku_attributes sa JOIN attributes a ON a.id = sa.attribute_id WHERE sa.sku_id IN (SELECT id FROM skus WHERE product_id IN (SELECT id FROM products WHERE vendor_id = $1)) GROUP BY a.name`, [vendorId]);
  console.log('Attributes:', attrs.rows);

  const cats = await pool.query('SELECT c.name, COUNT(*)::int as cnt FROM products p JOIN categories c ON c.id = p.category_id WHERE p.vendor_id = $1 GROUP BY c.name ORDER BY cnt DESC', [vendorId]);
  console.log('Categories:', cats.rows);

  // Multi-SKU products
  const multiSku = await pool.query(`SELECT p.name, COUNT(*)::int as sku_count FROM products p JOIN skus s ON s.product_id = p.id WHERE p.vendor_id = $1 GROUP BY p.name HAVING COUNT(*) > 1 ORDER BY sku_count DESC LIMIT 10`, [vendorId]);
  console.log('\nProducts with multiple SKUs (top 10):');
  multiSku.rows.forEach(r => console.log(`  ${r.name}: ${r.sku_count} SKUs`));

  const sample = await pool.query('SELECT p.name, p.collection, s.variant_name, s.internal_sku FROM products p JOIN skus s ON s.product_id = p.id WHERE p.vendor_id = $1 ORDER BY p.name LIMIT 10', [vendorId]);
  console.log('\nSample products:');
  sample.rows.forEach(r => console.log(`  ${r.name} | collection: ${r.collection} | variant: ${r.variant_name} | sku: ${r.internal_sku}`));

  pool.end();
})();
