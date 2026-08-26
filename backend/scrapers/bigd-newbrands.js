import fs from 'fs';
import path from 'path';
import { upsertProduct, upsertSku, upsertPricing, appendLog, addJobError } from './base.js';

/**
 * Big D tier-1 gap fill (2026-07-27) — creates the new-brand catalog from the
 * CSP sheet: W.F. Taylor adhesives, UZIN floor prep, backer boards
 * (HardieBacker / PermaBase / Fiberock / DensShield + screws/mesh), QUIKRETE
 * mud, and sound-control underlayments (Centaur / Pliteq / Roberts / Sponge
 * Cushion).
 *
 * Data: data/bigd-newbrands.json (curated from the parsed sheet).
 * Rules: vendor = Big D Supply, cost = sheet price, retail = 1.6x nickel,
 * brand rows auto-created, products land ACTIVE (owner publishes sheet-priced
 * stock immediately). Images are a follow-up pass (Lowe's carries the backer
 * boards + Roberts; manufacturer sites for the rest).
 *
 * CLI: docker compose exec api node scrapers/bigd-newbrands.js [--dry]
 */

const DATA_PATH = 'data/bigd-newbrands.json';
const STANDARD_MARKUP = 1.6;
const nickel = (n) => Math.round(n * STANDARD_MARKUP / 0.05) * 0.05;
const money = (n) => Math.round(n * 100) / 100;

export async function run(pool, job, source, opts = {}) {
  const dry = !!opts.dry;
  const log = async (m, c) => job?.id ? appendLog(pool, job.id, m, c) : console.log(m);

  const data = JSON.parse(fs.readFileSync(path.resolve(DATA_PATH), 'utf8'));
  const vendorId = (await pool.query(`SELECT id FROM vendors WHERE code = 'BIGD'`)).rows[0].id;

  const catCache = new Map();
  async function catId(slug) {
    if (!catCache.has(slug)) {
      const r = await pool.query('SELECT id FROM categories WHERE slug = $1', [slug]);
      catCache.set(slug, r.rows[0]?.id || null);
    }
    return catCache.get(slug);
  }
  const brandCache = new Map();
  async function brandId(code, name) {
    if (!brandCache.has(code)) {
      const r = await pool.query(`
        INSERT INTO brands (code, name) VALUES ($1, $2)
        ON CONFLICT DO NOTHING RETURNING id`, [code, name]);
      if (r.rows.length) brandCache.set(code, r.rows[0].id);
      else brandCache.set(code, (await pool.query('SELECT id FROM brands WHERE code = $1', [code])).rows[0].id);
    }
    return brandCache.get(code);
  }

  const stats = { products: 0, skus: 0, errors: 0 };
  for (const line of data.lines) {
    try {
      if (dry) { stats.products++; stats.skus += line.skus.length; continue; }
      const bId = await brandId(line.brandCode, line.brand);
      const cId = await catId(line.category);
      const product = await upsertProduct(pool, {
        vendor_id: vendorId, name: line.product, collection: line.collection,
        category_id: cId, brand_id: bId,
      });
      await pool.query(`UPDATE products SET brand_id = $1, category_id = $2, status = 'active', updated_at = NOW() WHERE id = $3`,
        [bId, cId, product.id]);
      stats.products++;
      for (const s of line.skus) {
        const internal = 'BIGD-' + s.code.replace(/[^\w.-]/g, '-');
        const sku = await upsertSku(pool, {
          product_id: product.id, vendor_sku: s.code, internal_sku: internal,
          variant_name: s.variant, sell_by: 'unit',
        });
        await pool.query(`UPDATE skus SET status = 'active', variant_type = NULL WHERE id = $1`, [sku.id]);
        await upsertPricing(pool, sku.id, {
          cost: money(s.price), retail_price: money(nickel(s.price)), price_basis: 'per_unit',
        }, { jobId: job?.id });
        stats.skus++;
      }
    } catch (err) {
      stats.errors++;
      if (job?.id) await addJobError(pool, job.id, `${line.product}: ${err.message}`);
      else console.error('ERROR', line.product, err.message);
    }
  }
  await log(`Done${dry ? ' (dry)' : ''}. Products ${stats.products}, SKUs ${stats.skus}, errors ${stats.errors}.`,
    { products_found: stats.products, skus_created: stats.skus });
  return stats;
}

if (process.argv[1] && process.argv[1].endsWith('bigd-newbrands.js')) {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({
    host: process.env.DB_HOST || 'db',
    port: Number(process.env.DB_PORT) || 5432,
    database: process.env.DB_NAME || 'flooring_pim',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || process.env.DB_PASS || 'postgres',
  });
  try {
    await run(pool, { id: null }, null, { dry: process.argv.includes('--dry') });
  } finally {
    await pool.end();
  }
}
