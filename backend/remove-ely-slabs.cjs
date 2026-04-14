const { Pool } = require('pg');
const pool = new Pool({ host: 'db', port: 5432, database: 'flooring_pim', user: 'postgres', password: 'postgres' });

(async () => {
  const vendorId = (await pool.query("SELECT id FROM vendors WHERE code = 'ELY'")).rows[0]?.id;
  const catSlugs = ['quartz-countertops', 'granite-countertops', 'quartzite-countertops'];

  const catIds = (await pool.query(
    'SELECT id, name FROM categories WHERE slug = ANY($1)', [catSlugs]
  )).rows;
  console.log('Categories to remove:', catIds.map(c => `${c.name} (${c.id})`).join(', '));

  const products = (await pool.query(
    'SELECT id, name FROM products WHERE vendor_id = $1 AND category_id = ANY($2)',
    [vendorId, catIds.map(c => c.id)]
  )).rows;
  console.log(`Found ${products.length} Elysium products to delete`);

  if (products.length === 0) { pool.end(); return; }

  const productIds = products.map(p => p.id);
  const skuIds = (await pool.query('SELECT id FROM skus WHERE product_id = ANY($1)', [productIds])).rows.map(r => r.id);

  if (skuIds.length > 0) {
    await pool.query('DELETE FROM sku_attributes WHERE sku_id = ANY($1)', [skuIds]);
    await pool.query('DELETE FROM pricing WHERE sku_id = ANY($1)', [skuIds]);
    await pool.query('DELETE FROM packaging WHERE sku_id = ANY($1)', [skuIds]);
  }
  await pool.query('DELETE FROM skus WHERE product_id = ANY($1)', [productIds]);
  await pool.query('DELETE FROM media_assets WHERE product_id = ANY($1)', [productIds]);
  await pool.query('DELETE FROM products WHERE id = ANY($1)', [productIds]);

  console.log(`Deleted ${products.length} products, ${skuIds.length} SKUs`);
  pool.end();
})();
