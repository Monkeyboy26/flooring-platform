/**
 * goton-cleanup.mjs
 *
 * 1. Discontinue dead lines NOT on the current gotontiles.com site (Cimaron,
 *    Danube Waves, Supergres Fog) — old ceramic lines, 0 order history.
 * 2. Trim/gap image inheritance: any imageless active Goton SKU inherits a PRIMARY
 *    image from a same-product, same-color sibling that has one (e.g. a Floor Bullnose
 *    borrows its color's field-tile shot). Colors with no imaged sibling stay imageless.
 *
 *   node backend/scripts/goton-cleanup.mjs            # dry run
 *   node backend/scripts/goton-cleanup.mjs --commit   # apply
 */
import pg from 'pg';
const COMMIT = process.argv.includes('--commit');
const DEAD = ['Cimaron', 'Danube Waves', 'Supergres Fog'];
const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

const { rows: v } = await pool.query("SELECT id FROM vendors WHERE code='GOT'");
if (!v.length) { console.error('Goton (GOT) not found'); process.exit(1); }
const vendorId = v[0].id;

console.log(`=== Goton cleanup — ${COMMIT ? 'COMMIT' : 'DRY RUN'} ===`);

// counts for dry run
const { rows: [dead] } = await pool.query(
  `SELECT COUNT(DISTINCT p.id) prods, COUNT(s.id) skus
   FROM products p JOIN skus s ON s.product_id=p.id
   WHERE p.vendor_id=$1 AND p.status='active' AND p.name = ANY($2)`, [vendorId, DEAD]);
console.log(`1. Discontinue dead lines (${DEAD.join(', ')}): ${dead.prods} products / ${dead.skus} SKUs`);

const inheritCTE = `
  WITH color_attr AS (SELECT id FROM attributes WHERE slug='color' LIMIT 1),
  imageless AS (
    SELECT s.id sku_id, s.product_id, ca.value AS color
    FROM skus s JOIN products p ON p.id=s.product_id
    JOIN sku_attributes ca ON ca.sku_id=s.id AND ca.attribute_id=(SELECT id FROM color_attr)
    WHERE p.vendor_id=$1 AND s.status='active'
      AND NOT EXISTS (SELECT 1 FROM media_assets ma WHERE ma.sku_id=s.id)
  ),
  seeded AS (
    SELECT i.sku_id, i.product_id, src.url, src.original_url
    FROM imageless i
    JOIN LATERAL (
      SELECT ma.url, ma.original_url
      FROM skus s2
      JOIN sku_attributes ca2 ON ca2.sku_id=s2.id AND ca2.attribute_id=(SELECT id FROM color_attr)
      JOIN media_assets ma ON ma.sku_id=s2.id AND ma.asset_type='primary'
      WHERE s2.product_id=i.product_id AND ca2.value=i.color AND s2.id<>i.sku_id
      ORDER BY ma.sort_order LIMIT 1
    ) src ON true
  )`;
const { rows: [inh] } = await pool.query(`${inheritCTE} SELECT COUNT(*) n FROM seeded`, [vendorId]);
console.log(`2. Trim/gap image inheritance: ${inh.n} imageless SKUs can inherit a same-color sibling's image`);

if (!COMMIT) { console.log('\nDry run — re-run with --commit to apply.'); await pool.end(); process.exit(0); }

// 1. discontinue
await pool.query(
  `UPDATE skus SET status='inactive' WHERE product_id IN
    (SELECT id FROM products WHERE vendor_id=$1 AND status='active' AND name = ANY($2))`, [vendorId, DEAD]);
const dp = await pool.query(
  `UPDATE products SET status='inactive' WHERE vendor_id=$1 AND status='active' AND name = ANY($2) RETURNING id`,
  [vendorId, DEAD]);
console.log(`Discontinued ${dp.rowCount} products`);

// 2. inherit
const ins = await pool.query(`${inheritCTE}
  INSERT INTO media_assets (id, product_id, sku_id, asset_type, url, original_url, sort_order, created_at, source)
  SELECT gen_random_uuid(), product_id, sku_id, 'primary', url, original_url, 0, now(), 'inherited-color-sibling'
  FROM seeded RETURNING id`, [vendorId]);
console.log(`Inherited images for ${ins.rowCount} SKUs`);

await pool.end();
console.log('=== done ===');
