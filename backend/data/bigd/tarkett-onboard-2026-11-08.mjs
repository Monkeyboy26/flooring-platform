// Onboard Tarkett products (via Big D Supply, vendor BIGD) from the Class 3
// price book effective 10/12/2026 — insert-only, never UPDATEs existing rows.
// Catalog built by parse-tarkett-class3.py -> tarkett-catalog.json:
// VCT (4 series), iD Latitude LVT, Surestart underlayment, Acczent +
// Performa sheet rolls (per_sqyd, Mannington roll convention), adhesives.
//
// Pricing routes through base.js upsertPricing (cost, retail=2x -> 1.70x
// keystone + charm + category floor), basis passed explicitly per sku.
// Brand 'Tarkett' is created if missing. No images (DAM scrape = follow-up).
//
//   docker exec -e DB_HOST=db flooring-api node data/bigd/tarkett-onboard-2026-11-08.mjs [--apply]
// Dry run (default) prints the plan; --apply inserts.

import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { upsertPricing } from '../../scrapers/base.js';

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

const APPLY = process.argv.includes('--apply');
const VENDOR_ID = '71708161-0077-4b80-b128-a52d689de455'; // Big D Supply
const catalog = JSON.parse(fs.readFileSync(path.join(__dirname, 'tarkett-catalog.json'), 'utf8'));

const catCache = {};
async function catId(slug) {
  if (slug in catCache) return catCache[slug];
  const r = await pool.query('SELECT id FROM categories WHERE slug=$1', [slug]);
  return (catCache[slug] = r.rows.length ? r.rows[0].id : null);
}
const attrCache = new Map();
async function attrId(slug) {
  if (attrCache.has(slug)) return attrCache.get(slug);
  const r = await pool.query('SELECT id FROM attributes WHERE slug=$1', [slug]);
  const id = r.rows.length ? r.rows[0].id : null; attrCache.set(slug, id); return id;
}

async function main() {
  let { rows: brandRows } = await pool.query("SELECT id FROM brands WHERE lower(name)='tarkett'");
  let brandId = brandRows[0]?.id || null;
  if (!brandId && APPLY) {
    const ins = await pool.query(
      `INSERT INTO brands (name, code, website) VALUES ('Tarkett','TARKETT','https://www.tarkett.com') RETURNING id`);
    brandId = ins.rows[0].id;
    console.log('Created brand Tarkett', brandId);
  }

  const { rows: ex } = await pool.query(
    `SELECT s.vendor_sku FROM skus s JOIN products p ON p.id=s.product_id WHERE p.vendor_id=$1`, [VENDOR_ID]);
  const existing = new Set(ex.map(r => r.vendor_sku));

  const work = [];
  for (const p of catalog) {
    const newSkus = p.skus.filter(s => !existing.has(s.vendor_sku));
    if (newSkus.length) work.push({ p, newSkus });
  }
  const totalNew = work.reduce((n, w) => n + w.newSkus.length, 0);
  console.log(`New SKUs to insert: ${totalNew} across ${work.length} products`);

  if (!APPLY) {
    const byColl = {};
    for (const { p, newSkus } of work) byColl[p.collection] = (byColl[p.collection] || 0) + newSkus.length;
    for (const [c, n] of Object.entries(byColl)) console.log(`  ${c}: ${n} skus`);
    for (const { p, newSkus } of work.slice(0, 12))
      console.log(`  [${p.category_slug}] ${p.collection} / ${p.name} (+${newSkus.length})`);
    console.log('\nDRY RUN — re-run with --apply to insert.');
    await pool.end(); return;
  }

  let prodNew = 0, prodReuse = 0, skuNew = 0; const noCat = new Set();
  for (const { p, newSkus } of work) {
    const categoryId = await catId(p.category_slug);
    if (!categoryId) { noCat.add(p.category_slug); continue; }

    let prodId;
    const found = await pool.query(
      `SELECT id FROM products WHERE vendor_id=$1 AND collection IS NOT DISTINCT FROM $2 AND name=$3`,
      [VENDOR_ID, p.collection, p.name]);
    if (found.rows.length) { prodId = found.rows[0].id; prodReuse++; }
    else {
      const ins = await pool.query(
        `INSERT INTO products (vendor_id, brand_id, name, collection, category_id, status, description_short, description_long)
         VALUES ($1,$2,$3,$4,$5,'active',$6,$7) RETURNING id`,
        [VENDOR_ID, brandId, p.name, p.collection, categoryId, (p.description || '').slice(0, 250), p.description || null]);
      prodId = ins.rows[0].id; prodNew++;
    }

    for (const s of newSkus) {
      const ins = await pool.query(
        `INSERT INTO skus (product_id, vendor_sku, internal_sku, variant_name, sell_by, variant_type)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (internal_sku) DO NOTHING RETURNING id`,
        [prodId, s.vendor_sku, s.internal_sku, s.variant_name, s.sell_by || 'unit', s.variant_type || null]);
      if (!ins.rows.length) continue;
      const skuId = ins.rows[0].id; skuNew++;
      await upsertPricing(pool, skuId, { cost: s.cost, retail_price: s.cost * 2, price_basis: s.price_basis });
      if (s.packaging) {
        await pool.query(
          `INSERT INTO packaging (sku_id, sqft_per_box, pieces_per_box, roll_width_ft)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (sku_id) DO UPDATE SET sqft_per_box=EXCLUDED.sqft_per_box,
             pieces_per_box=EXCLUDED.pieces_per_box, roll_width_ft=EXCLUDED.roll_width_ft`,
          [skuId, s.packaging.sqft_per_box || null, s.packaging.pieces_per_box || null,
           s.packaging.roll_width_ft || null]);
      }
      for (const [slug, val] of Object.entries(s.attrs || {})) {
        if (val == null || val === '') continue;
        const aid = await attrId(slug); if (!aid) continue;
        await pool.query(
          `INSERT INTO sku_attributes (sku_id, attribute_id, value) VALUES ($1,$2,$3)
           ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value=EXCLUDED.value`,
          [skuId, aid, String(val).trim()]);
      }
    }
  }
  console.log(`\nProducts: ${prodNew} created, ${prodReuse} reused (unchanged)`);
  console.log(`SKUs inserted: ${skuNew} (all imageless — Tarkett DAM scrape is a follow-up)`);
  if (noCat.size) console.log(`! missing categories (skipped): ${[...noCat].join(', ')}`);
  await pool.end();
}
main().catch(e => { console.error(e); process.exit(1); });
