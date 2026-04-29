/**
 * MSI Collection-Level Image Inheritance
 *
 * For products that still have no images, inherit from same-collection products
 * that DO have images. This gives every product at least a representative image
 * from its collection/family.
 *
 * Usage: node backend/scripts/msi-collection-inherit.cjs [--dry-run]
 */

const { Pool } = require('pg');

const VENDOR_ID = '550e8400-e29b-41d4-a716-446655440001';
const DRY_RUN = process.argv.includes('--dry-run');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

async function main() {
  const log = (msg) => console.log(msg);
  log('MSI Collection-Level Image Inheritance');
  log('='.repeat(60));
  if (DRY_RUN) log('DRY RUN');

  // Get all products missing images, with their collection
  const { rows: missing } = await pool.query(`
    SELECT DISTINCT p.id as product_id, p.name, p.collection, c.slug as category
    FROM products p
    JOIN skus s ON s.product_id = p.id
    JOIN categories c ON c.id = p.category_id
    LEFT JOIN media_assets ma ON ma.sku_id = s.id
    WHERE p.vendor_id = $1 AND ma.id IS NULL AND s.status = 'active'
    ORDER BY c.slug, p.collection, p.name
  `, [VENDOR_ID]);

  log(`${missing.length} products missing images`);

  let matched = 0, imagesSaved = 0;

  for (const prod of missing) {
    let donorImages = null;

    // Strategy 1: Same collection, same category
    if (prod.collection) {
      const { rows } = await pool.query(`
        SELECT DISTINCT ma.url, ma.asset_type, ma.sort_order
        FROM products p
        JOIN skus s ON s.product_id = p.id
        JOIN media_assets ma ON ma.sku_id = s.id
        JOIN categories c ON c.id = p.category_id
        WHERE p.vendor_id = $1
          AND p.id != $2
          AND p.collection = $3
          AND c.slug = $4
        ORDER BY ma.sort_order
        LIMIT 3
      `, [VENDOR_ID, prod.product_id, prod.collection, prod.category]);

      if (rows.length > 0) donorImages = rows;
    }

    // Strategy 2: Name prefix match (at least 2 words) across all categories
    if (!donorImages) {
      const words = prod.name.split(/\s+/).filter(w => w.length >= 2);
      for (let len = Math.min(words.length, 3); len >= 2; len--) {
        const prefix = words.slice(0, len).join(' ');
        const { rows } = await pool.query(`
          SELECT DISTINCT ma.url, ma.asset_type, ma.sort_order
          FROM products p
          JOIN skus s ON s.product_id = p.id
          JOIN media_assets ma ON ma.sku_id = s.id
          WHERE p.vendor_id = $1
            AND p.id != $2
            AND LOWER(p.name) LIKE $3
          ORDER BY ma.sort_order
          LIMIT 3
        `, [VENDOR_ID, prod.product_id, prefix.toLowerCase() + '%']);

        if (rows.length > 0) {
          donorImages = rows;
          break;
        }
      }
    }

    // Strategy 3: Same category, first word match (very broad)
    if (!donorImages) {
      const firstWord = prod.name.split(/\s+/)[0];
      if (firstWord && firstWord.length >= 3) {
        const { rows } = await pool.query(`
          SELECT DISTINCT ma.url, ma.asset_type, ma.sort_order
          FROM products p
          JOIN skus s ON s.product_id = p.id
          JOIN media_assets ma ON ma.sku_id = s.id
          JOIN categories c ON c.id = p.category_id
          WHERE p.vendor_id = $1
            AND p.id != $2
            AND LOWER(p.name) LIKE $3
            AND c.slug = $4
          ORDER BY ma.sort_order
          LIMIT 3
        `, [VENDOR_ID, prod.product_id, firstWord.toLowerCase() + '%', prod.category]);

        if (rows.length > 0) donorImages = rows;
      }
    }

    if (donorImages) {
      matched++;
      // Get all SKUs for this product
      const { rows: skus } = await pool.query(
        'SELECT id FROM skus WHERE product_id = $1 AND status = $2',
        [prod.product_id, 'active']
      );

      for (const sku of skus) {
        let sortOrder = 0;
        for (const img of donorImages) {
          if (!DRY_RUN) {
            await pool.query(`
              INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order, created_at)
              VALUES ($1, $2, $3, $4, $4, $5, NOW())
              ON CONFLICT DO NOTHING
            `, [prod.product_id, sku.id, sortOrder === 0 ? 'primary' : 'alternate', img.url, sortOrder]);
          }
          imagesSaved++;
          sortOrder++;
        }
      }

      log(`  [${prod.category}] ${prod.name} (${prod.collection}) -> inherited ${donorImages.length} images`);
    } else {
      log(`  [${prod.category}] ${prod.name} (${prod.collection}) -> NO DONOR FOUND`);
    }
  }

  // Final coverage
  const { rows: coverage } = await pool.query(`
    SELECT c.slug,
      COUNT(DISTINCT s.id) as total,
      COUNT(DISTINCT CASE WHEN ma.id IS NOT NULL THEN s.id END) as with_img
    FROM skus s
    JOIN products p ON s.product_id = p.id
    LEFT JOIN categories c ON c.id = p.category_id
    LEFT JOIN media_assets ma ON ma.sku_id = s.id
    WHERE p.vendor_id = $1 AND s.status = 'active'
    GROUP BY c.slug ORDER BY total DESC
  `, [VENDOR_ID]);

  let totalSkus = 0, totalWithImages = 0;
  log('');
  log('Coverage:');
  for (const row of coverage) {
    const pct = (100 * row.with_img / row.total).toFixed(1);
    log(`  ${row.slug}: ${row.with_img}/${row.total} (${pct}%)`);
    totalSkus += parseInt(row.total);
    totalWithImages += parseInt(row.with_img);
  }

  log('');
  log('='.repeat(60));
  log(`  Matched: ${matched} / ${missing.length} products`);
  log(`  Images saved: ${imagesSaved}`);
  log(`  Total: ${totalWithImages}/${totalSkus} (${(100*totalWithImages/totalSkus).toFixed(1)}%)`);
  log('='.repeat(60));

  await pool.end();
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
