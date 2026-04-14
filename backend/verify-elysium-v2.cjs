const { Pool } = require('pg');
const pool = new Pool({ host: 'db', port: 5432, database: 'flooring_pim', user: 'postgres', password: 'postgres' });

(async () => {
  const vendorId = (await pool.query("SELECT id FROM vendors WHERE code = 'ELY'")).rows[0]?.id;

  // Category distribution
  const cats = await pool.query(`
    SELECT c.name, COUNT(*)::int as cnt
    FROM products p LEFT JOIN categories c ON c.id = p.category_id
    WHERE p.vendor_id = $1 GROUP BY c.name ORDER BY cnt DESC
  `, [vendorId]);
  console.log('Categories:');
  cats.rows.forEach(r => console.log(`  ${r.name || 'NULL'}: ${r.cnt}`));

  // Image stats
  const imgs = await pool.query(`
    SELECT asset_type, COUNT(*)::int as cnt
    FROM media_assets WHERE product_id IN (SELECT id FROM products WHERE vendor_id = $1)
    GROUP BY asset_type ORDER BY cnt DESC
  `, [vendorId]);
  console.log('\nImages by type:');
  imgs.rows.forEach(r => console.log(`  ${r.asset_type}: ${r.cnt}`));

  // Products without images
  const noImg = await pool.query(`
    SELECT COUNT(*)::int as cnt FROM products
    WHERE vendor_id = $1 AND id NOT IN (SELECT DISTINCT product_id FROM media_assets WHERE product_id IS NOT NULL)
  `, [vendorId]);
  console.log(`\nProducts without images: ${noImg.rows[0].cnt}`);

  // Check image resolution (should be /1000/ now)
  const imgSample = await pool.query(`
    SELECT url FROM media_assets
    WHERE product_id IN (SELECT id FROM products WHERE vendor_id = $1)
    AND asset_type = 'primary' LIMIT 5
  `, [vendorId]);
  console.log('\nSample primary image URLs:');
  imgSample.rows.forEach(r => console.log(`  ${r.url.substring(0, 100)}`));

  // Average images per product
  const avgImgs = await pool.query(`
    SELECT AVG(cnt)::numeric(5,1) as avg_imgs, MAX(cnt)::int as max_imgs, MIN(cnt)::int as min_imgs
    FROM (
      SELECT p.id, COUNT(ma.id)::int as cnt
      FROM products p
      LEFT JOIN media_assets ma ON ma.product_id = p.id
      WHERE p.vendor_id = $1
      GROUP BY p.id
    ) sub
  `, [vendorId]);
  console.log(`\nImages per product: avg=${avgImgs.rows[0].avg_imgs}, max=${avgImgs.rows[0].max_imgs}, min=${avgImgs.rows[0].min_imgs}`);

  // Catalog PDFs
  const pdfs = await pool.query(`
    SELECT COUNT(*)::int as cnt FROM media_assets
    WHERE product_id IN (SELECT id FROM products WHERE vendor_id = $1)
    AND asset_type = 'spec_pdf'
  `, [vendorId]);
  console.log(`Catalog PDFs: ${pdfs.rows[0].cnt}`);

  // Collections
  const colls = await pool.query(`
    SELECT collection, COUNT(*)::int as cnt
    FROM products WHERE vendor_id = $1 AND collection IS NOT NULL
    GROUP BY collection ORDER BY cnt DESC LIMIT 15
  `, [vendorId]);
  console.log('\nTop collections:');
  colls.rows.forEach(r => console.log(`  ${r.collection}: ${r.cnt}`));

  // Multi-SKU products
  const multiSku = await pool.query(`
    SELECT p.name, c.name as category, COUNT(*)::int as sku_count
    FROM products p JOIN skus s ON s.product_id = p.id
    LEFT JOIN categories c ON c.id = p.category_id
    WHERE p.vendor_id = $1 GROUP BY p.name, c.name HAVING COUNT(*) > 1
    ORDER BY sku_count DESC LIMIT 10
  `, [vendorId]);
  console.log('\nProducts with multiple SKUs:');
  multiSku.rows.forEach(r => console.log(`  ${r.name} (${r.category}): ${r.sku_count} SKUs`));

  // Attributes
  const attrs = await pool.query(`
    SELECT a.name, COUNT(*)::int as cnt
    FROM sku_attributes sa JOIN attributes a ON a.id = sa.attribute_id
    WHERE sa.sku_id IN (SELECT id FROM skus WHERE product_id IN (SELECT id FROM products WHERE vendor_id = $1))
    GROUP BY a.name
  `, [vendorId]);
  console.log('\nAttributes:', attrs.rows);

  pool.end();
})();
