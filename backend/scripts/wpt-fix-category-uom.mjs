/**
 * wpt-fix-category-uom.mjs
 *
 * Two WPT data fixes:
 *
 * 1. CATEGORY — 12 collections of floor tiles (wood-look planks + 24x48/12x40 large
 *    format) were categorized as "Backsplash & Wall Tile". Move them to Porcelain Tile
 *    (WPT's floor bucket, where existing wood-looks like Cypress already live).
 *
 * 2. UOM — 34 field-tile SKUs are sell_by='unit'/per_unit (show "/ea") but carry a
 *    sqft_per_box, so they're really sold by the box. Their retail/cost are per-BOX
 *    (retail = cost x1.6 keystone holds per-box), so convert to box/per_sqft by dividing
 *    both by sqft_per_box — the box economics are preserved, the display becomes /sqft.
 *
 *   node backend/scripts/wpt-fix-category-uom.mjs            # dry run
 *   node backend/scripts/wpt-fix-category-uom.mjs --commit   # apply
 */
import pg from 'pg';
const COMMIT = process.argv.includes('--commit');
const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

const FLOOR_COLLECTIONS = ['Alcazar','Atelier','Atrium','Avalanche','Bosco','Ceppo Di Gré',
  'Dayton','Leviglass','Lumen & Bloom','Native','Norway','Private Collection'];

const { rows: v } = await pool.query("SELECT id FROM vendors WHERE name ILIKE '%western pacific%'");
const vendorId = v[0].id;
const { rows: cat } = await pool.query("SELECT id FROM categories WHERE slug='porcelain-tile'");
const porcelainId = cat[0].id;

console.log(`=== WPT category + UOM fix — ${COMMIT ? 'COMMIT' : 'DRY RUN'} ===`);

// counts
const { rows: [c1] } = await pool.query(`
  SELECT COUNT(*) n FROM products p JOIN categories c ON c.id=p.category_id
  WHERE p.vendor_id=$1 AND p.status='active' AND c.slug='backsplash-wall' AND p.collection = ANY($2)`,
  [vendorId, FLOOR_COLLECTIONS]);
console.log(`1. CATEGORY: ${c1.n} products (${FLOOR_COLLECTIONS.length} collections) Wall → Porcelain Tile`);

const { rows: [c2] } = await pool.query(`
  SELECT COUNT(*) n FROM skus s JOIN products p ON p.id=s.product_id
  JOIN packaging pk ON pk.sku_id=s.id
  WHERE p.vendor_id=$1 AND s.status='active' AND s.sell_by='unit' AND pk.sqft_per_box>0`, [vendorId]);
console.log(`2. UOM: ${c2.n} field-tile SKUs unit/per_unit → box/per_sqft (price ÷ sqft_per_box)`);

if (!COMMIT) {
  const { rows } = await pool.query(`
    SELECT p.name, s.variant_name, pr.retail_price, pk.sqft_per_box,
      round(pr.retail_price/pk.sqft_per_box,2) new_sqft
    FROM skus s JOIN products p ON p.id=s.product_id JOIN pricing pr ON pr.sku_id=s.id JOIN packaging pk ON pk.sku_id=s.id
    WHERE p.vendor_id=$1 AND s.status='active' AND s.sell_by='unit' AND pk.sqft_per_box>0
    ORDER BY p.name LIMIT 10`, [vendorId]);
  console.log('   sample UOM conversions (per-box $ → per-sqft $):');
  rows.forEach(r => console.log(`     ${r.name} ${r.variant_name}: $${r.retail_price}/box ÷ ${r.sqft_per_box} = $${r.new_sqft}/sqft`));
  console.log('\nDry run — re-run with --commit to apply.');
  await pool.end(); process.exit(0);
}

// 1. category
const r1 = await pool.query(`
  UPDATE products SET category_id=$2
  WHERE vendor_id=$1 AND status='active' AND collection = ANY($3)
    AND category_id=(SELECT id FROM categories WHERE slug='backsplash-wall')
  RETURNING id`, [vendorId, porcelainId, FLOOR_COLLECTIONS]);
console.log(`Recategorized ${r1.rowCount} products → Porcelain Tile`);

// 2. uom: convert per-box → per-sqft
const r2 = await pool.query(`
  UPDATE pricing pr SET
    cost = round(pr.cost / pk.sqft_per_box, 2),
    retail_price = round(pr.retail_price / pk.sqft_per_box, 2),
    price_basis = 'per_sqft'
  FROM skus s, packaging pk
  WHERE pr.sku_id=s.id AND pk.sku_id=s.id
    AND s.product_id IN (SELECT id FROM products WHERE vendor_id=$1 AND status='active')
    AND s.sell_by='unit' AND pk.sqft_per_box>0
  RETURNING pr.sku_id`, [vendorId]);
const r3 = await pool.query(`
  UPDATE skus s SET sell_by='box'
  WHERE s.product_id IN (SELECT id FROM products WHERE vendor_id=$1 AND status='active')
    AND s.sell_by='unit' AND EXISTS(SELECT 1 FROM packaging pk WHERE pk.sku_id=s.id AND pk.sqft_per_box>0)
  RETURNING s.id`, [vendorId]);
console.log(`UOM: repriced ${r2.rowCount} pricing rows to per_sqft, set ${r3.rowCount} SKUs to sell_by=box`);

// refresh search vectors
const { rows: prods } = await pool.query('SELECT DISTINCT p.id FROM products p WHERE p.vendor_id=$1', [vendorId]);
for (const r of prods) await pool.query('SELECT refresh_search_vectors($1)', [r.id]).catch(()=>{});
console.log('Done.');
await pool.end();
