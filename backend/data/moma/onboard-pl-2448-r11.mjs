/**
 * Moma Pietra Ligure — add the NEW March-2026 size: FIELD 24x48 R11 @ $4.39 (4 colors).
 * Added to the existing "Pietra Ligure 24x48" product (code 896) so R11 shows as a
 * finish variant alongside Natural. Each R11 color SKU clones its Natural sibling's
 * attributes (finish overridden to R11) + media; pricing via base.js house model.
 * Dry-run by default; APPLY=1 to write.
 *   docker exec -e APPLY=1 flooring-api node /app/data/moma/onboard-pl-2448-r11.mjs
 */
import pg from 'pg';
import { upsertPricing } from '../../scrapers/base.js';

const APPLY = process.env.APPLY === '1';
const pool = new pg.Pool({ host: process.env.DB_HOST || 'db', port: 5432,
  database: 'flooring_pim', user: 'postgres', password: process.env.DB_PASSWORD || 'postgres' });

const COLORS = [['PL00','Avorio'],['PL01','Sabbia'],['PL02','Grigio'],['PL03','Anthracite']];
const COST = 4.39;
const PKG = { pcs: 2, sf: 15.5, boxes_pal: 36, sf_pal: 558, lbs: 66.14 };

async function main() {
  console.log(`=== Pietra Ligure 24x48 R11 onboard (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===`);
  const pr = await pool.query(`
    SELECT p.id FROM products p JOIN vendors v ON v.id=p.vendor_id
    WHERE v.code='896' AND p.collection='Pietra Ligure' AND p.name='Pietra Ligure 24x48'`);
  if (!pr.rows.length) throw new Error('parent product "Pietra Ligure 24x48" not found');
  const productId = pr.rows[0].id;
  console.log('parent product:', productId);

  let created = 0;
  for (const [code, color] of COLORS) {
    const sibRes = await pool.query(`SELECT id, variant_name FROM skus WHERE internal_sku=$1`, [`MOMA-${code}-2448`]);
    if (!sibRes.rows.length) { console.log(`  !! no Natural sibling MOMA-${code}-2448 — skip`); continue; }
    const sib = sibRes.rows[0];
    const internal = `MOMA-${code}-2448-R11`;
    console.log(`  ${color} (${code}) -> ${internal}  cost ${COST}`);
    if (!APPLY) { created++; continue; }

    // SKU
    const sk = await pool.query(`
      INSERT INTO skus (product_id, vendor_sku, internal_sku, variant_name, sell_by, status)
      VALUES ($1,$2,$3,$4,'box','active')
      ON CONFLICT (internal_sku) DO UPDATE SET product_id=EXCLUDED.product_id, vendor_sku=EXCLUDED.vendor_sku,
        variant_name=EXCLUDED.variant_name, status='active', updated_at=CURRENT_TIMESTAMP
      RETURNING id`, [productId, `${code}-2448-R11`, internal, sib.variant_name]);
    const skuId = sk.rows[0].id;

    // attributes: clone sibling's, override finish=R11
    await pool.query(`
      INSERT INTO sku_attributes (sku_id, attribute_id, value)
      SELECT $1, sa.attribute_id, sa.value FROM sku_attributes sa WHERE sa.sku_id=$2
      ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value=EXCLUDED.value`, [skuId, sib.id]);
    await pool.query(`
      UPDATE sku_attributes SET value='R11'
      WHERE sku_id=$1 AND attribute_id=(SELECT id FROM attributes WHERE slug='finish')`, [skuId]);

    // pricing via house model (cost -> 1.70x keystone + tile floor + charm)
    await upsertPricing(pool, skuId, { cost: COST, retail_price: +(COST * 2).toFixed(2), price_basis: 'per_sqft' });

    // packaging (from PDF row)
    await pool.query(`
      INSERT INTO packaging (sku_id, sqft_per_box, pieces_per_box, weight_per_box_lbs, boxes_per_pallet, sqft_per_pallet)
      VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (sku_id) DO UPDATE SET sqft_per_box=EXCLUDED.sqft_per_box, pieces_per_box=EXCLUDED.pieces_per_box,
        weight_per_box_lbs=EXCLUDED.weight_per_box_lbs, boxes_per_pallet=EXCLUDED.boxes_per_pallet, sqft_per_pallet=EXCLUDED.sqft_per_pallet`,
      [skuId, PKG.sf, PKG.pcs, PKG.lbs, PKG.boxes_pal, PKG.sf_pal]);

    // media: clone sibling's (R11 shares the color's look)
    await pool.query(`
      INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order, source)
      SELECT product_id, $1, asset_type, url, original_url, sort_order, source
      FROM media_assets WHERE sku_id=$2
      ON CONFLICT (product_id, sku_id, asset_type, sort_order) WHERE sku_id IS NOT NULL
      DO UPDATE SET url=EXCLUDED.url, original_url=EXCLUDED.original_url, source=EXCLUDED.source`, [skuId, sib.id]);
    created++;
  }
  console.log(`\n${APPLY ? 'Created/updated' : 'Would create'} ${created} R11 SKUs.`);
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
