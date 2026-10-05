/**
 * Moma OAKTHREE onboarding (vendor 896) — wood-look porcelain, in stock ("STOCKED IN
 * FULLERTON"). 3 colors (Young/Mid/Old) x 3 field sizes (8x48/12x48/24x48), Natural.
 * Pricing via base.js house model (NOT import-moma.js 1.6x). Images self-hosted under
 * /uploads/moma/oakthree (sourced from momaceramichegroup.com/losangeles).
 * Idempotent. Dry-run by default; APPLY=1 to write.
 *   docker exec -e APPLY=1 flooring-api node /app/data/moma/onboard-oakthree.mjs
 */
import pg from 'pg';
import { upsertPricing } from '../../scrapers/base.js';

const APPLY = process.env.APPLY === '1';
const pool = new pg.Pool({ host: process.env.DB_HOST || 'db', port: 5432,
  database: 'flooring_pim', user: 'postgres', password: process.env.DB_PASSWORD || 'postgres' });

const VENDOR = '896';
const BRAND_ID = '346db123-0390-4cd9-afa8-d9925ec8b6b8';
const COLLECTION = 'Oakthree';
const CAT_SLUG = 'wood-look-tile';
const SHORT = 'Wood-look porcelain replicating the aged beauty of oak.';
const LONG = 'Oakthree is a collection where perfection is defined by the number three — a symbol of absolute completeness. Inspired by the essence of oak, each color is paired with a unique, meticulously crafted oak-grain pattern for balance, authenticity and craftsmanship. Rectified wood-look porcelain, suitable for residential and commercial floors and walls.';

const COLORS = [ { code: 'OT01', name: 'Young', img: 'young' },
                 { code: 'OT02', name: 'Mid',   img: 'mid' },
                 { code: 'OT03', name: 'Old',   img: 'old' } ];
// size -> {cost, pkg:[pcs,sqft,boxes_pal,sqft_pal,lbs]}
const SIZES = [ { size: '8x48',  cost: 4.35, pkg: [4,15.5,18,279,57.5] },
                { size: '12x48', cost: 4.57, pkg: [6,15.5,36,558,57.5] },
                { size: '24x48', cost: 4.79, pkg: [2,15.5,36,558,57.5] } ];
const ATTRS = { material: 'Porcelain', look: 'Wood', shade_variation: 'V2', pei_rating: '4',
  mohs: '6', dcof: '>0.42', frost_resistant: 'Yes', rectified: 'Yes', application: 'Floor · Wall' };
const BASE = '/uploads/moma/oakthree';
const compact = (s) => s.replace('x', '');
const nominal = (s) => { const [a, b] = s.split('x'); return `${a}"x${b}"`; };
// mirrors server.js generateSlugBackend (current standard — plain slugify of the name)
const slugify = (t) => (t || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

async function main() {
  console.log(`=== Oakthree onboard (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===`);
  const cat = await pool.query('SELECT id FROM categories WHERE slug=$1', [CAT_SLUG]);
  const categoryId = cat.rows[0].id;
  const ven = await pool.query('SELECT id FROM vendors WHERE code=$1', [VENDOR]);
  const vendorId = ven.rows[0].id;

  let nP = 0, nS = 0, nM = 0;
  for (const sz of SIZES) {
    const name = `${COLLECTION} ${sz.size}`;
    console.log(`\n${name}  $${sz.cost}`);
    let productId = null;
    if (APPLY) {
      const p = await pool.query(`
        INSERT INTO products (vendor_id, brand_id, name, collection, category_id, status, description_short, description_long, slug)
        VALUES ($1,$2,$3,$4,$5,'active',$6,$7,$8)
        ON CONFLICT ON CONSTRAINT products_vendor_collection_name_unique DO UPDATE SET
          brand_id=EXCLUDED.brand_id, category_id=EXCLUDED.category_id, status='active',
          description_short=EXCLUDED.description_short, description_long=EXCLUDED.description_long,
          slug=COALESCE(products.slug, EXCLUDED.slug), updated_at=CURRENT_TIMESTAMP
        RETURNING id`, [vendorId, BRAND_ID, name, COLLECTION, categoryId, SHORT, LONG, slugify(name)]);
      productId = p.rows[0].id;
    }
    nP++;
    const is24 = sz.size === '24x48';
    for (const c of COLORS) {
      const internal = `MOMA-${c.code}-${compact(sz.size)}`;
      console.log(`  ${c.name} (${c.code}) -> ${internal}`);
      nS++;
      if (!APPLY) continue;
      const s = await pool.query(`
        INSERT INTO skus (product_id, vendor_sku, internal_sku, variant_name, sell_by, status)
        VALUES ($1,$2,$3,$4,'box','active')
        ON CONFLICT (internal_sku) DO UPDATE SET product_id=EXCLUDED.product_id, vendor_sku=EXCLUDED.vendor_sku,
          variant_name=EXCLUDED.variant_name, status='active', updated_at=CURRENT_TIMESTAMP
        RETURNING id`, [productId, `${c.code}-${compact(sz.size)}`, internal, c.name]);
      const skuId = s.rows[0].id;

      await upsertPricing(pool, skuId, { cost: sz.cost, retail_price: +(sz.cost * 2).toFixed(2), price_basis: 'per_sqft' });

      await pool.query(`
        INSERT INTO packaging (sku_id, sqft_per_box, pieces_per_box, weight_per_box_lbs, boxes_per_pallet, sqft_per_pallet)
        VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (sku_id) DO UPDATE SET sqft_per_box=EXCLUDED.sqft_per_box, pieces_per_box=EXCLUDED.pieces_per_box,
          weight_per_box_lbs=EXCLUDED.weight_per_box_lbs, boxes_per_pallet=EXCLUDED.boxes_per_pallet, sqft_per_pallet=EXCLUDED.sqft_per_pallet`,
        [skuId, sz.pkg[1], sz.pkg[0], sz.pkg[4], sz.pkg[2], sz.pkg[3]]);

      const attrs = { ...ATTRS, collection: COLLECTION, color: c.name, color_code: c.code, finish: 'Natural', size: nominal(sz.size) };
      for (const [slug, val] of Object.entries(attrs)) {
        await pool.query(`
          INSERT INTO sku_attributes (sku_id, attribute_id, value)
          SELECT $1, a.id, $3 FROM attributes a WHERE a.slug=$2
          ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value=EXCLUDED.value`, [skuId, slug, val]);
      }

      // media: 24x48 uses the big-format face as primary; plank sizes use the plank face.
      const primary = is24 ? `${BASE}/${c.img}@1.jpg` : `${BASE}/${c.img}@2.jpg`;
      const alt     = is24 ? `${BASE}/${c.img}@2.jpg` : `${BASE}/${c.img}@1.jpg`;
      const media = [ [primary, 'primary', 0], [alt, 'alternate', 0],
        [`${BASE}/OT_lifestyle1.jpg`, 'lifestyle', 0], [`${BASE}/OT_lifestyle2.jpg`, 'lifestyle', 1], [`${BASE}/OT_lifestyle3.jpg`, 'lifestyle', 2] ];
      for (const [url, type, sort] of media) {
        await pool.query(`
          INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order, source)
          VALUES ($1,$2,$3,$4,$4,$5,'momaceramichegroup.com')
          ON CONFLICT (product_id, sku_id, asset_type, sort_order) WHERE sku_id IS NOT NULL
          DO UPDATE SET url=EXCLUDED.url, original_url=EXCLUDED.original_url, source=EXCLUDED.source`,
          [productId, skuId, type, url, sort]);
        nM++;
      }
    }
  }
  console.log(`\n${APPLY ? 'Onboarded' : 'Would onboard'}: ${nP} products, ${nS} SKUs${APPLY ? `, ${nM} media rows` : ''}.`);
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
