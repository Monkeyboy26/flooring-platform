#!/usr/bin/env node
/**
 * Stone Pride — Glass Mosaics (custom murals, pool & floor art).
 *
 * The glass-mosaic line is NOT in the D+ price PDF and is not a standard tile
 * product: stone-pride.com presents it as a portfolio of custom, made-to-order
 * mosaic murals, pool designs and floor medallions with no prices or sizes.
 *
 * So these are onboarded as CALL-FOR-PRICING products (active SKU, no pricing row
 * -> storefront shows "Call for Price" + Request a Quote) in the Mosaic Tile
 * category, under the hidden Stone Pride vendor (public code 714). Images are
 * hotlinked from the site (https, URL-encoded for the unicode × in some names).
 *
 * Idempotent. Run: docker compose exec -T api node scripts/import-stone-pride-glass.mjs
 */
import pg from 'pg';

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

const U = 'https://www.stone-pride.com/wp-content/uploads/';
const enc = (u) => encodeURI(u);   // × -> %C3%97 etc.

// name, collection, dims, primary image, extra gallery images
const MURALS_COL = 'Glass Mosaic Murals';
const POOL_COL = 'Glass Mosaic Pool & Floor';
const ITEMS = [
  ['Secret Garden Peacock Glass Mosaic Mural', MURALS_COL, 'approx 2050mm W × 2690mm H', '2018/06/7-Secret-Garden-Peacock-2050W×2690Hmm.jpg'],
  ['City Evening Glass Mosaic Mural', MURALS_COL, 'approx 1960mm W × 2960mm H', '2018/06/6-City-evening-1960Wx2960Hmm.jpg'],
  ['Venice Glass Mosaic Mural', MURALS_COL, 'approx 1820mm W × 1420mm H', '2018/06/8-Venice-1820W×1420Hmm-.jpg'],
  ['Running Horses Glass Mosaic Mural', MURALS_COL, 'approx 4350mm W × 2780mm H', '2018/06/2-RUNNINING-HORSES-4350mmx2780m.jpg'],
  ['Mediterranean Town Glass Mosaic Mural', MURALS_COL, 'approx 3000mm W × 1700mm H', '2018/06/Mediterranean-town-3000Wx1700Hmm-.jpg'],
  ['Sailing Ships Glass Mosaic Mural', MURALS_COL, 'custom sizes', '2018/06/4-Sailing-ships.jpg'],
  ['Trail Glass Mosaic Mural', MURALS_COL, 'approx 1000mm W × 2000mm H', '2018/06/5-Trail-1000W×2000Hmm.jpg'],
  ['Egal Glass Mosaic Mural', MURALS_COL, 'approx 1200mm × 3800mm', '2018/06/3-Egal-1200x3800mm.jpg'],
  ['Birds Glass Mosaic Mural', MURALS_COL, 'approx 1385mm W × 3000mm H', '2018/06/Birds-1385Wx3000Hmm.jpg'],
  ['Flower Glass Mosaic Mural', MURALS_COL, 'approx 1350mm W × 2500mm H', '2018/06/Flower-1350Wx2500Hmm.jpg'],
  ['Glass Mosaic Bathtub Surround', MURALS_COL, 'approx 4900mm W × 3270mm H', '2018/06/Mosaic-Bathtub-4900Wx3270Hmm.jpg'],
  ['Custom Glass Floor Medallion', POOL_COL, 'approx Ø1450mm', '2018/06/floor-medallion-1450mm.jpg'],
  ['Custom Glass Pool Mosaic', POOL_COL, 'custom pool designs', '2018/06/Pool-mosaics-1.jpg',
    ['2018/06/Pool-mosaics-2.jpg', '2018/06/Pool-mosaics-3.jpg', '2018/06/Pool-mosaics-4.jpg',
     '2018/06/Pool-mosaics-6.jpg', '2018/06/Pool-mosaics-7.jpg', '2018/06/Pool-mosaics-8.jpg',
     '2018/06/Pool-mosaics-9.jpg']],
  ['Custom Glass Mosaic Floor', POOL_COL, 'custom floor designs', '2020/08/Glass-mosaic-floor-projects-1-1.jpg',
    ['2020/08/Hotel-lobby-1.jpg', '2020/08/Glass-mosaic-floor-projects-5-1.jpg']],
];

const slug = (s) => 'SP-GLASS-' + s.replace(/Glass Mosaic|Mural|Custom/g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toUpperCase();

async function main() {
  console.log('=== Stone Pride Glass Mosaics (call-for-pricing) ===\n');
  const v = await pool.query(`SELECT id FROM vendors WHERE code='STPR'`);
  if (!v.rows.length) throw new Error('Stone Pride vendor (STPR) not found — run import-stone-pride.js first');
  const vendorId = v.rows[0].id;
  const b = await pool.query(`SELECT id FROM brands WHERE code='STPR'`);
  const brandId = b.rows.length ? b.rows[0].id : null;
  const c = await pool.query(`SELECT id FROM categories WHERE slug='mosaic-tile'`);
  const categoryId = c.rows[0].id;

  let pN = 0, sN = 0, mN = 0;
  for (const [name, collection, dims, primary, gallery = []] of ITEMS) {
    const desc = `Custom hand-crafted glass mosaic, made to order (${dims}). Bespoke sizes, colors and designs available — request a design consultation.`;
    const prod = await pool.query(`
      INSERT INTO products (vendor_id, brand_id, name, collection, category_id, status, description_short, description_long)
      VALUES ($1,$2,$3,$4,$5,'active',$6,$6)
      ON CONFLICT ON CONSTRAINT products_vendor_collection_name_unique DO UPDATE SET
        category_id=EXCLUDED.category_id, status='active',
        description_short=EXCLUDED.description_short, description_long=EXCLUDED.description_long,
        updated_at=CURRENT_TIMESTAMP
      RETURNING id, (xmax=0) AS is_new
    `, [vendorId, brandId, name, collection, categoryId, desc]);
    const productId = prod.rows[0].id;
    if (prod.rows[0].is_new) pN++;

    const internal = slug(name);
    const sku = await pool.query(`
      INSERT INTO skus (product_id, vendor_sku, internal_sku, variant_name, sell_by, status)
      VALUES ($1,$2,$3,$4,'unit','active')
      ON CONFLICT (internal_sku) DO UPDATE SET
        product_id=EXCLUDED.product_id, variant_name=EXCLUDED.variant_name, status='active', updated_at=CURRENT_TIMESTAMP
      RETURNING id, (xmax=0) AS is_new
    `, [productId, internal, internal, 'Custom / made to order']);
    const skuId = sku.rows[0].id;
    if (sku.rows[0].is_new) sN++;
    // NO pricing row on purpose -> storefront renders "Call for Price" + Request a Quote

    // media: product-level primary + gallery
    await pool.query(`
      INSERT INTO media_assets (product_id, asset_type, url, original_url, sort_order)
      VALUES ($1,'primary',$2,$2,0) ON CONFLICT DO NOTHING
    `, [productId, enc(U + primary)]);
    mN++;
    let so = 1;
    for (const g of gallery) {
      await pool.query(`
        INSERT INTO media_assets (product_id, asset_type, url, original_url, sort_order)
        VALUES ($1,'alternate',$2,$2,$3) ON CONFLICT DO NOTHING
      `, [productId, enc(U + g), so++]);
    }
  }
  console.log(`Products: ${pN} new  (${ITEMS.length} total)`);
  console.log(`SKUs:     ${sN} new  (all call-for-pricing, no pricing row)`);
  console.log(`Media:    ${mN} primaries + gallery attached`);
  await pool.end();
  console.log('\nDone.');
}
main().catch(e => { console.error(e); process.exit(1); });
