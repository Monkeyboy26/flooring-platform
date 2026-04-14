const { Pool } = require('pg');
const pool = new Pool({ host: 'db', port: 5432, database: 'flooring_pim', user: 'postgres', password: 'postgres' });

(async () => {
  const vendorId = (await pool.query("SELECT id FROM vendors WHERE code = 'ELY'")).rows[0]?.id;
  if (!vendorId) { console.log('Vendor ELY not found'); process.exit(1); }

  const productIds = (await pool.query('SELECT id FROM products WHERE vendor_id = $1', [vendorId])).rows.map(r => r.id);
  console.log(`Wiping ${productIds.length} Elysium products...`);

  if (productIds.length > 0) {
    const skuIds = (await pool.query('SELECT id FROM skus WHERE product_id = ANY($1)', [productIds])).rows.map(r => r.id);
    if (skuIds.length > 0) {
      await pool.query('DELETE FROM sku_attributes WHERE sku_id = ANY($1)', [skuIds]);
      await pool.query('DELETE FROM pricing WHERE sku_id = ANY($1)', [skuIds]);
      await pool.query('DELETE FROM packaging WHERE sku_id = ANY($1)', [skuIds]);
    }
    await pool.query('DELETE FROM skus WHERE product_id = ANY($1)', [productIds]);
    await pool.query('DELETE FROM media_assets WHERE product_id = ANY($1)', [productIds]);
    await pool.query('DELETE FROM products WHERE id = ANY($1)', [productIds]);
  }

  console.log('Done. Wiped all Elysium data.');
  pool.end();
})();
