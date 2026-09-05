// Orion slab-named TILE twins mis-shelved as countertops/slabs — 2026-09-05.
//
// The dealer price list has slabs named Calacatta Gold, Nero Marquinia, etc.,
// but the website pages we scraped for those names are porcelain/floor TILES
// (verified live: product_cat-porcelain / floor-tile, 24x48, ~$6.99/sf). The
// 2026-09-02 slab reclassify then routed them to marble/granite-countertops off
// description marketing copy ("NERO MARQUINIA is a prestigious black marble…").
// scrapers/orion.js now carries the corrected CATEGORY_OVERRIDES + slab-URL
// routing; this script applies the same correction to the current DB.
//
// Also zeroes the stale tile-level retails ($5.49/$6.99, cost $0) on Alpine and
// Perla Santana — genuine slabs whose old tile-page prices survived the URL
// churn; retail 0.00 = the Orion call-for-pricing slab convention (retail_price
// is NOT NULL in schema; 0 also hides them from storefront browse like
// Cristallo Illuminates / the rest of the unpriced slab program).
//
// Idempotent.
//   docker compose exec -T api node scripts/fix-orion-slab-named-tiles-2026-09-05.mjs
//   (prod) ssh -i ~/.ssh/roma-prod.pem ubuntu@32.188.96.3
//          docker compose exec -T api node scripts/fix-orion-slab-named-tiles-2026-09-05.mjs

import { pool } from '../db.js';

const ORION = '94dd7078-a068-4ea0-b78b-b0565731e758';

// name (lower) → target leaf + SKU classification + attribute values.
const MOVES = [
  { name: 'calacatta gold',      slug: 'porcelain-tile', sellBy: 'box',  variantType: 'floor_tile', material: 'Porcelain', application: 'Floor & Wall' },
  { name: 'nero marquinia',      slug: 'porcelain-tile', sellBy: 'box',  variantType: 'floor_tile', material: 'Porcelain', application: 'Floor & Wall' },
  { name: 'marmorea carrara',    slug: 'porcelain-tile', sellBy: 'box',  variantType: 'floor_tile', material: 'Porcelain', application: 'Floor & Wall' },
  { name: 'marmorea verde alpi', slug: 'porcelain-tile', sellBy: 'box',  variantType: 'floor_tile', material: 'Porcelain', application: 'Floor & Wall' },
  { name: 'calacatta',           slug: 'porcelain-tile', sellBy: 'box',  variantType: 'floor_tile', material: 'Porcelain', application: 'Floor & Wall' },
  { name: 'carrara',             slug: 'porcelain-tile', sellBy: 'box',  variantType: 'floor_tile', material: 'Porcelain', application: 'Floor & Wall' },
  { name: 'reverse',             slug: 'porcelain-tile', sellBy: 'box',  variantType: 'floor_tile', material: 'Porcelain', application: 'Floor & Wall' },
  { name: 'natural granite',     slug: 'natural-stone',  sellBy: 'sqft', variantType: 'stone_tile', material: 'Granite',   application: 'Floor & Wall' },
];

// Genuine slabs carrying stale tile-level retails (cost $0, 0 < retail < $8) —
// reset to call-for-pricing (retail 0.00) like the rest of the unpriced slabs.
const STALE_SLAB_RETAILS = ['alpine', 'perla santana'];

async function main() {
  const client = await pool.connect();
  const summary = { moved: 0, sku_updated: 0, attr_set: 0, retail_nulled: 0, missing: [] };
  try {
    await client.query('BEGIN');

    const cats = (await client.query('SELECT id, slug FROM categories')).rows;
    const catId = new Map(cats.map(c => [c.slug, c.id]));

    const attrs = (await client.query(
      `SELECT id, slug FROM attributes WHERE slug IN ('material','application')`)).rows;
    const attrId = new Map(attrs.map(a => [a.slug, a.id]));

    for (const m of MOVES) {
      const prod = (await client.query(
        `SELECT p.id FROM products p WHERE p.vendor_id = $1 AND lower(p.name) = $2`,
        [ORION, m.name])).rows;
      if (!prod.length) { summary.missing.push(m.name); continue; }

      for (const p of prod) {
        const r = await client.query(
          `UPDATE products SET category_id = $1, updated_at = CURRENT_TIMESTAMP
           WHERE id = $2 AND category_id IS DISTINCT FROM $1`,
          [catId.get(m.slug), p.id]);
        summary.moved += r.rowCount;

        const skuIds = (await client.query(
          'SELECT id FROM skus WHERE product_id = $1', [p.id])).rows.map(x => x.id);
        for (const skuId of skuIds) {
          const rs = await client.query(
            `UPDATE skus SET sell_by = $1, variant_type = $2, updated_at = CURRENT_TIMESTAMP
             WHERE id = $3 AND (sell_by IS DISTINCT FROM $1 OR variant_type IS DISTINCT FROM $2)`,
            [m.sellBy, m.variantType, skuId]);
          summary.sku_updated += rs.rowCount;

          for (const [slug, value] of [['material', m.material], ['application', m.application]]) {
            if (!attrId.get(slug)) continue;
            const ra = await client.query(
              `INSERT INTO sku_attributes (sku_id, attribute_id, value) VALUES ($1,$2,$3)
               ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value = EXCLUDED.value
               WHERE sku_attributes.value IS DISTINCT FROM EXCLUDED.value`,
              [skuId, attrId.get(slug), value]);
            summary.attr_set += ra.rowCount;
          }
        }
      }
    }

    const rn = await client.query(
      `UPDATE pricing pr SET retail_price = 0
       FROM skus s JOIN products p ON p.id = s.product_id
       WHERE pr.sku_id = s.id AND p.vendor_id = $1
         AND lower(p.name) = ANY($2)
         AND pr.retail_price > 0 AND pr.retail_price < 8
         AND COALESCE(pr.cost, 0) = 0`,
      [ORION, STALE_SLAB_RETAILS]);
    summary.retail_nulled = rn.rowCount;

    await client.query('COMMIT');
    console.log('[fix-orion-slab-named-tiles-2026-09-05] applied:', JSON.stringify(summary, null, 2));
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[fix-orion-slab-named-tiles-2026-09-05] rolled back:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
