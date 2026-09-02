// Data-quality cleanup — 2026-09-01 session.
//
// Idempotent. Reproduces on prod the data fixes made locally this session so
// the nightly conformance audit stops flagging them. Safe to re-run: every
// statement is guarded to only touch rows still in the "wrong" state.
//
// deploy.sh ships CODE only; run this against the prod DB manually:
//   ssh ubuntu@32.188.96.3 -i roma-prod.pem
//   docker compose exec -T api node scripts/fix-data-quality-2026-09-01.mjs
//
// Fixes:
//   1. negative-margin      — 2 HR strike plates priced below cost -> $0.19 + lock
//   2. unit-basis-mismatch  — ROCA field tile box+per_unit -> per_sqft (rate was
//                             already a per-sqft number, just mislabeled)
//   3. category-needs-review— 12 EMS setting-materials/trim best-guessed into
//                             Tools & Trowels / Functional Hardware -> correct leaf
//   4. sheet-vinyl migration— 56 Armstrong (Flexstep Value Plus + Traditions) SKUs
//                             miscategorized as lvp-plank / engineered-hardwood are
//                             12'/6' residential SHEET VINYL: -> sheet-vinyl, roll,
//                             per_sqyd (price x9), roll_width_ft from the TW feed.
//   5. deactivate not-carried— unpriced wood/vinyl SKUs from lines confirmed absent
//                             from the Tri-West feed (discontinued colors/products):
//                             TW Studio/Ellicott Point/Louvre/Mediterranean/Timeless
//                             Classics + Orion "Rigid Core". Guarded to unpriced SKUs
//                             only (priced colors of the same lines stay active); a
//                             product left with zero active SKUs is deactivated too.
//                             SHAW unpriced stragglers are intentionally NOT touched
//                             (can't verify not-carried without the Shaw feed).

import { pool } from '../db.js';

// vendor_sku -> roll_width_ft, extracted from triwest-instock.json (the feed is
// not committed, so the map is embedded to keep this script self-contained).
const ROLL_WIDTH = {
  ARMG2482401:12,ARMG2471401:12,ARMG2593401:12,ARMG2880401:12,ARMG2825401:12,ARMG2594401:12,
  ARMG2871401:12,ARMG2470401:12,ARMG2474401:12,ARMG2475401:12,ARMG2478401:12,ARMG2480401:12,
  ARMG2489401:12,ARMG2491401:12,ARMG2492401:12,ARMG2493401:12,ARMG2503401:12,ARMG2513401:12,
  ARMG2516401:12,ARMG2517401:12,ARMG2881401:12,ARMG2481401:12,ARMG2488401:12,ARMG2879401:12,
  ARMG2885401:12,ARMG2886401:12,ARMG2887401:12,ARMG2889401:12,ARMG2897401:12,ARMG5233401:12,
  ARMG5352401:12,ARMG5247401:12,ARMG5290401:12,ARMG5348401:12,ARMG9244401:12,ARMG9245401:12,
  ARMG9246401:12,ARMG9249401:12,ARMG5354401:12,ARMG5247201:6,
};

const EMS_CATEGORY = {
  'adhesives-sealants': [
    '252 Silver Grey 50lb','252 Silver White 50lb','253 Gold Grey 50lb','253 Gold White 50lb',
    '254 Platinum Plus Grey 25lb','254 Platinum White 50lb','255 Platinum Plus 25lb',
    '4xlt White 50lb','Custom Wood Hp4 4 Gal',
  ],
  'stacked-stone': [
    'Grand Canyon Engineered Stone Corner Mixed Sizes','Pacific Rim Engineered Stone Corner Mixed Sizes',
  ],
  'trim-accessories': [
    'Tile Trim Square Precise Straight And 45 Degree Cuts In Tile Trims',
  ],
};

async function catId(client, slug) {
  const { rows } = await client.query(`SELECT id FROM categories WHERE slug = $1`, [slug]);
  if (!rows.length) throw new Error(`category slug not found: ${slug}`);
  return rows[0].id;
}

async function main() {
  const client = await pool.connect();
  const summary = {};
  try {
    await client.query('BEGIN');

    // 1. negative-margin: HR strike plates $0.09 retail vs $0.10 cost.
    const hr = await client.query(`
      UPDATE pricing pr SET retail_price = 0.19, retail_locked = true
      FROM skus s, products p, vendors v
      WHERE pr.sku_id = s.id AND s.product_id = p.id AND p.vendor_id = v.id
        AND v.code = 'HR' AND s.vendor_sku IN ('506S1','506S2')
        AND pr.retail_price < pr.cost`);
    summary.negative_margin = hr.rowCount;

    // 2. unit-basis-mismatch: ROCA field tile sold by box but priced per_unit,
    //    where the stored number is actually a per-sqft rate.
    const roca = await client.query(`
      UPDATE pricing pr SET price_basis = 'per_sqft'
      FROM skus s, products p, vendors v
      WHERE pr.sku_id = s.id AND s.product_id = p.id AND p.vendor_id = v.id
        AND v.code = 'ROCA' AND s.sell_by = 'box' AND pr.price_basis = 'per_unit'`);
    summary.unit_basis_mismatch = roca.rowCount;

    // 3. category-needs-review: EMS best-guesses -> correct leaf + clear flag.
    summary.ems_recategorized = 0;
    for (const [slug, names] of Object.entries(EMS_CATEGORY)) {
      const id = await catId(client, slug);
      const r = await client.query(`
        UPDATE products p SET category_id = $1, category_needs_review = false
        FROM vendors v
        WHERE p.vendor_id = v.id AND v.code = 'EMS' AND p.status = 'active'
          AND p.name = ANY($2) AND (p.category_id IS DISTINCT FROM $1 OR p.category_needs_review = true)`,
        [id, names]);
      summary.ems_recategorized += r.rowCount;
    }

    // 4. sheet-vinyl migration: Armstrong Flexstep Value Plus + Traditions.
    const svId = await catId(client, 'sheet-vinyl');
    const targets = await client.query(`
      SELECT s.id AS sku_id, s.vendor_sku, p.id AS product_id, pr.cost, pr.retail_price
      FROM skus s
      JOIN products p ON p.id = s.product_id
      JOIN vendors v ON v.id = p.vendor_id
      JOIN categories c ON c.id = p.category_id
      JOIN pricing pr ON pr.sku_id = s.id
      WHERE v.code = 'TW' AND p.name IN ('Flexstep Value Plus','Traditions')
        AND c.slug IN ('lvp-plank','engineered-hardwood')
        AND s.status = 'active' AND s.sell_by = 'box' AND pr.price_basis = 'per_sqft'`);
    const products = new Set();
    let widthSet = 0;
    for (const r of targets.rows) {
      products.add(r.product_id);
      await client.query(`UPDATE skus SET sell_by = 'roll' WHERE id = $1`, [r.sku_id]);
      const cost9 = Math.round(parseFloat(r.cost) * 9 * 100) / 100;
      const ret9  = Math.round(parseFloat(r.retail_price) * 9 * 100) / 100;
      await client.query(
        `UPDATE pricing SET price_basis = 'per_sqyd', cost = $2, retail_price = $3, cut_cost = $2, cut_price = $3 WHERE sku_id = $1`,
        [r.sku_id, cost9, ret9]);
      const w = ROLL_WIDTH[r.vendor_sku] || null;
      if (w) widthSet++;
      await client.query(
        `INSERT INTO packaging (sku_id, roll_width_ft) VALUES ($1, $2)
         ON CONFLICT (sku_id) DO UPDATE SET roll_width_ft = COALESCE(EXCLUDED.roll_width_ft, packaging.roll_width_ft)`,
        [r.sku_id, w]);
    }
    for (const pid of products) {
      await client.query(`UPDATE products SET category_id = $1 WHERE id = $2`, [svId, pid]);
    }
    summary.sheet_vinyl_skus = targets.rows.length;
    summary.sheet_vinyl_products = products.size;
    summary.sheet_vinyl_widths_set = widthSet;

    // 5. Deactivate unpriced, not-carried wood/vinyl SKUs (discontinued lines/
    //    colors confirmed absent from the Tri-West feed). Guarded to unpriced
    //    (no pricing row) so priced colors of the same product stay active.
    const NOT_CARRIED = [
      { code: 'TW',  names: ['Studio','Ellicott Point','Louvre','Mediterranean','Timeless Classics'] },
      { code: '169', names: ['Rigid Core'] },
    ];
    const WV_SLUGS = ['engineered-hardwood','solid-hardwood','waterproof-wood','laminate','lvp-plank','lvt-tile'];
    let deactSkus = 0;
    for (const { code, names } of NOT_CARRIED) {
      const r = await client.query(`
        UPDATE skus s SET status = 'inactive'
        FROM products p, vendors v, categories c
        WHERE s.product_id = p.id AND p.vendor_id = v.id AND p.category_id = c.id
          AND v.code = $1 AND p.name = ANY($2) AND c.slug = ANY($3)
          AND s.status = 'active' AND s.variant_type IS DISTINCT FROM 'accessory'
          AND NOT EXISTS (SELECT 1 FROM pricing pr WHERE pr.sku_id = s.id)`,
        [code, names, WV_SLUGS]);
      deactSkus += r.rowCount;
    }
    // Deactivate products in those lines that now have zero active SKUs.
    const dp = await client.query(`
      UPDATE products p SET status = 'inactive'
      FROM vendors v
      WHERE p.vendor_id = v.id AND p.status = 'active'
        AND ((v.code = 'TW'  AND p.name = ANY($1))
          OR (v.code = '169' AND p.name = ANY($2)))
        AND NOT EXISTS (SELECT 1 FROM skus s WHERE s.product_id = p.id AND s.status = 'active')`,
      [['Studio','Ellicott Point','Louvre','Mediterranean','Timeless Classics'], ['Rigid Core']]);
    summary.deactivated_skus = deactSkus;
    summary.deactivated_products = dp.rowCount;

    await client.query('COMMIT');
    console.log('[fix-data-quality-2026-09-01] applied:', JSON.stringify(summary, null, 2));
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[fix-data-quality-2026-09-01] rolled back:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
