// Onboard Mannington SHEET VINYL from the 11/06/2026 Rolls-Detail price list
// (mannington/mannington-pricelist-2026-11-06.json, rolls[] — 304 rows, 9 series
// blocks). Sheet was never in the PIM: the April-2026 onboard transcribed only
// the Cartons-Detail PDF.
//
// Shape (mirrors EF broadloom carpet, the existing roll machinery):
//   products: one per (collection, pattern); collection = series (IPGB split out
//     as "Insight Plus Glass Back" — Mannington's own line naming — which also
//     de-dupes IP/IPGB same-color-same-size rows). category = sheet-vinyl,
//     slug = mannington-<collection>-<pattern>.
//   skus: vendor_sku = catalog # (unique per color+width), sell_by='roll',
//     variant_name "{color}, {width} Sheet". attrs: color / size / material.
//     packaging.roll_width_ft = 6 or 12.
//   pricing: per SQYD (list prices x9) — the entire roll pipeline (storefront
//     sheet/carpet calculators, cart math, rep/admin) treats sell_by='roll' as
//     per-sqyd (EF/SHAW/PC/TW convention); storing the list's native per-sqft
//     numbers made the calculator/cart divide by 9 (9x undercharge, fixed by
//     mannington-sheet-pricing-to-sqyd-2026-11-08.mjs). cost = cut (falls back
//     to roll) x9; base retail via upsertPricing house rules with explicit
//     per_sqyd basis; cut_/roll_price written directly at 1.70x nickel with the
//     carpet $1/sqft-margin floor (cost+9/sqyd). Roll-only lines get cut = roll
//     (isRollPriced() keys on cut_price).
//
// Insert-only + idempotent (ON CONFLICT by natural keys); created rows recorded in
//   products_mann_sheet_onboard_20261106 / skus_mann_sheet_onboard_20261106.
//
//   docker exec -e DB_HOST=db flooring-api node data/mannington-onboard-sheet-2026-11-06.mjs [--apply]

import pg from 'pg';
import fs from 'fs';
import { upsertPricing } from '../scrapers/base.js';

const { Pool } = pg;
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

const APPLY = process.argv.includes('--apply');
const VENDOR_ID = 'dabbf50b-c1ed-4e81-8bf1-c1ac88a5a4bd'; // Mannington
const CATEGORY_ID = '0b25bb37-0286-4054-8c99-28e999772f55'; // sheet-vinyl
const ATTR = {
  color: 'd50e8400-e29b-41d4-a716-446655440001',
  material: 'd50e8400-e29b-41d4-a716-446655440002',
  size: 'd50e8400-e29b-41d4-a716-446655440004',
};
const SRC = new URL('./mannington/mannington-pricelist-2026-11-06.json', import.meta.url).pathname;
const PROD_LOG = 'products_mann_sheet_onboard_20261106';
const SKU_LOG = 'skus_mann_sheet_onboard_20261106';

// series header (+ style code where it splits a line) -> collection display name
function collectionFor(row) {
  if (row.style_code === 'IPGB') return 'Insight Plus Glass Back';
  switch (row.series) {
    case 'LUXURY VINYL SHEET': return 'Luxury Vinyl Sheet';
    case 'PRIME': return 'Prime';
    case 'Mannington on Main - Towne Centre': return 'Towne Centre';
    default: return row.series; // Benchmark, Insight Plus, Jump Start
  }
}
const slugify = s => s.toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const nickel170 = c => Math.round(Math.round(c * 1.70 / 0.05) * 0.05 * 100) / 100;
const CARPET_MIN_MARGIN_SQYD = 9; // $1/sqft x 9 — house rule, see base.js carpetFloor
const rollRetail = costSqyd => {
  const p = nickel170(costSqyd);
  const min = costSqyd + CARPET_MIN_MARGIN_SQYD;
  return p < min ? Math.round(Math.ceil(min / 0.05) * 0.05 * 100) / 100 : p;
};

async function main() {
  const { rolls } = JSON.parse(fs.readFileSync(SRC, 'utf8'));
  if (!rolls.length || rolls[0].pattern === undefined) throw new Error('rolls[].pattern missing — re-run parser v3');

  // group products
  const products = new Map(); // key coll|pattern -> {collection, pattern, rows[]}
  for (const r of rolls) {
    const collection = collectionFor(r);
    const key = `${collection}|${r.pattern}`;
    (products.get(key) ?? products.set(key, { collection, pattern: r.pattern, rows: [] }).get(key)).rows.push(r);
  }
  const { rows: existingSkus } = await pool.query(
    `SELECT s.vendor_sku FROM skus s JOIN products p ON p.id=s.product_id WHERE p.vendor_id=$1`, [VENDOR_ID]);
  const existing = new Set(existingSkus.map(s => s.vendor_sku));
  const newRows = rolls.filter(r => !existing.has(r.catalog));
  console.log(`Rolls: ${rolls.length} rows -> ${products.size} products; new SKUs: ${newRows.length} (${rolls.length - newRows.length} already present)`);
  const byColl = {};
  for (const p of products.values()) (byColl[p.collection] ??= { products: 0, skus: 0 }), byColl[p.collection].products++, byColl[p.collection].skus += p.rows.length;
  for (const [c, n] of Object.entries(byColl)) console.log(`  ${c}: ${n.products} products / ${n.skus} skus`);

  if (!APPLY) {
    console.log('\nDRY RUN — sample:');
    for (const p of [...products.values()].slice(0, 5)) {
      const r = p.rows[0];
      console.log(`  ${p.collection} / ${p.pattern} (${p.rows.length} skus) e.g. ${r.color}, ${r.size} cat ${r.catalog} roll $${r.roll_sf}${r.cut_sf ? ` cut $${r.cut_sf}` : ''}`);
    }
    console.log('\nRe-run with --apply to write.');
    await pool.end();
    return;
  }

  const createdProducts = [], createdSkus = [];
  for (const p of products.values()) {
    // find-or-create product
    let { rows: [prod] } = await pool.query(
      `SELECT id FROM products WHERE vendor_id=$1 AND collection=$2 AND name=$3`,
      [VENDOR_ID, p.collection, p.pattern]);
    if (!prod) {
      let slug = `mannington-${slugify(p.collection)}-${slugify(p.pattern)}`;
      const { rows: clash } = await pool.query(`SELECT 1 FROM products WHERE slug=$1`, [slug]);
      if (clash.length) slug = `${slug}-sheet`;
      ({ rows: [prod] } = await pool.query(
        `INSERT INTO products (vendor_id, name, collection, category_id, status, is_active, slug, category_source)
         VALUES ($1, $2, $3, $4, 'active', true, $5, 'vendor') RETURNING id`,
        [VENDOR_ID, p.pattern, p.collection, CATEGORY_ID, slug]));
      createdProducts.push(prod.id);
    }
    for (const r of p.rows) {
      if (existing.has(r.catalog)) continue;
      const variantName = `${r.color}, ${r.size} Sheet`;
      const { rows: [sku] } = await pool.query(
        `INSERT INTO skus (product_id, vendor_sku, internal_sku, variant_name, sell_by, status)
         VALUES ($1, $2, $3, $4, 'roll', 'active')
         ON CONFLICT (internal_sku) DO UPDATE SET status='active'
         RETURNING id`,
        [prod.id, r.catalog, `MANN-${r.catalog}`, variantName]);
      createdSkus.push(sku.id);
      // per-sqyd: list is per-sqft, roll pipeline expects sqyd — x9 everything.
      // base cost = cut (what a partial order costs us); roll-only lines cut=roll
      const cutSqyd = +(((r.cut_sf ?? r.roll_sf)) * 9).toFixed(2);
      const rollSqyd = +(r.roll_sf * 9).toFixed(2);
      await upsertPricing(pool, sku.id, { cost: cutSqyd, retail_price: cutSqyd * 2, price_basis: 'per_sqyd' });
      await pool.query(
        `UPDATE pricing SET cut_cost=$2, cut_price=$3, roll_cost=$4, roll_price=$5 WHERE sku_id=$1`,
        [sku.id, cutSqyd, rollRetail(cutSqyd), rollSqyd, rollRetail(rollSqyd)]);
      const widthFt = parseInt(r.size, 10);
      await pool.query(
        `INSERT INTO packaging (sku_id, roll_width_ft) VALUES ($1, $2) ON CONFLICT (sku_id) DO UPDATE SET roll_width_ft=$2`,
        [sku.id, widthFt]);
      const attrs = [[ATTR.color, r.color], [ATTR.size, `${r.size} x RL`], [ATTR.material, 'Sheet Vinyl']];
      for (const [attrId, value] of attrs) {
        await pool.query(
          `INSERT INTO sku_attributes (sku_id, attribute_id, value) VALUES ($1, $2, $3)
           ON CONFLICT (sku_id, attribute_id) DO NOTHING`, [sku.id, attrId, value]);
      }
    }
  }

  await pool.query(`DROP TABLE IF EXISTS ${PROD_LOG}`);
  await pool.query(`CREATE TABLE ${PROD_LOG} AS SELECT * FROM products WHERE id = ANY($1::uuid[])`, [createdProducts]);
  await pool.query(`DROP TABLE IF EXISTS ${SKU_LOG}`);
  await pool.query(`CREATE TABLE ${SKU_LOG} AS SELECT * FROM skus WHERE id = ANY($1::uuid[])`, [createdSkus]);
  console.log(`Created ${createdProducts.length} products, ${createdSkus.length} SKUs (logs: ${PROD_LOG}, ${SKU_LOG}).`);

  const { rows: sample } = await pool.query(
    `SELECT p.collection, p.name, s.vendor_sku, s.variant_name, pr.cost, pr.retail_price, pr.cut_cost, pr.cut_price, pr.roll_cost, pr.roll_price, pk.roll_width_ft
       FROM skus s JOIN products p ON p.id=s.product_id
       JOIN pricing pr ON pr.sku_id=s.id LEFT JOIN packaging pk ON pk.sku_id=s.id
      WHERE s.id = ANY($1::uuid[]) ORDER BY random() LIMIT 8`, [createdSkus]);
  console.log('\nSample:');
  for (const s of sample) console.log(`  ${s.collection}/${s.name} ${s.vendor_sku} "${s.variant_name}" cost ${s.cost} retail ${s.retail_price} cut ${s.cut_cost}->${s.cut_price} roll ${s.roll_cost}->${s.roll_price} width ${s.roll_width_ft}'`);

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
