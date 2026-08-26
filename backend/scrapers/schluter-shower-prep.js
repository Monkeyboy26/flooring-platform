import fs from 'fs';
import path from 'path';
import { appendLog, addJobError, upsertMediaAsset } from './base.js';

/**
 * Schluter shower-stack prep — stages the KERDI system (drains, linear drains,
 * membrane, boards, trays, kits, shelves, DITRA-HEAT) for publishing.
 *
 * Consumes data/hd-schluter-shower.json (Home Depot browser harvest; re-run the
 * harvest to extend coverage — this script picks up whatever is in the file).
 * For every draft Daltile Schluter SKU whose part code is in the harvest:
 *   - real name from HD's label ("Schluter Kerdi-Line Brushed Stainless Steel
 *     23-5/8 in. Perforated Grate Assembly KL1B19EB60") — code kept in name
 *   - split out of EDI catch-all products where needed
 *   - collection = family (Kerdi-Line, Kerdi-Drain, Kerdi-Board, ...),
 *     category = shower-systems (DITRA-HEAT → floor-heating), brand = Schluter
 *   - HD product photo as product primary, HD label as description_short
 *   - part code → vendor_sku; internal_sku added to the dal-curated protection list
 *
 * Products/SKUs REMAIN DRAFT — pricing comes when the Big D CSP for these lines
 * arrives (ask Ryan Newby); flipping live is then reprice + activate.
 * HD street prices are kept in the harvest file for later reference.
 *
 * CLI: docker compose exec api node scrapers/schluter-shower-prep.js [--dry]
 */

const HARVEST_PATH = 'data/hd-schluter-shower.json';
const CURATED_PATH = 'data/dal-curated-skus.json';

function familyOf(label) {
  const first = (label || '').split(' ')[0];
  if (/^ditra-heat/i.test(first)) return 'Ditra-Heat';
  if (/^kerdi-line/i.test(first)) return 'Kerdi-Line';
  if (/^kerdi-drain/i.test(first)) return 'Kerdi-Drain';
  if (/^kerdi-board/i.test(first)) return 'Kerdi-Board';
  if (/^kerdi-shower/i.test(first)) return 'Kerdi-Shower';
  if (/^kerdi-fix/i.test(first)) return 'Kerdi-Fix';
  if (/^kerdi/i.test(first)) return 'Kerdi';
  if (/^shelf/i.test(first)) return 'Shelves';
  return 'Schluter';
}

export async function run(pool, job, source, opts = {}) {
  const dry = !!opts.dry;
  const log = async (m, c) => job?.id ? appendLog(pool, job.id, m, c) : console.log(m);

  const harvest = JSON.parse(fs.readFileSync(path.resolve(HARVEST_PATH), 'utf8')).items;
  const byCode = new Map(harvest.filter(x => x.model && x.label).map(x => [x.model.toUpperCase(), x]));
  await log(`Shower prep${dry ? ' (DRY RUN)' : ''}: ${byCode.size} HD items loaded`);

  const cats = {};
  for (const slug of ['shower-systems', 'floor-heating']) {
    cats[slug] = (await pool.query('SELECT id FROM categories WHERE slug=$1', [slug])).rows[0].id;
  }
  const brandId = (await pool.query(`SELECT id FROM brands WHERE code='SCHLUTER'`)).rows[0].id;
  const vendorId = (await pool.query(`SELECT id FROM vendors WHERE code='DAL'`)).rows[0].id;

  const rows = await pool.query(`
    SELECT s.id AS sku_id, s.internal_sku, s.variant_name, s.vendor_sku,
           p.id AS product_id, p.name AS product_name,
           COUNT(*) OVER (PARTITION BY p.id) AS product_sku_count
    FROM skus s
    JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id
    WHERE v.code = 'DAL' AND p.collection = 'Schluter Systems LP'
    ORDER BY p.name, s.variant_name
  `);

  const backup = { products: [], skus: [] };
  const stats = { staged: 0, split: 0, renamed: 0, imaged: 0, errors: 0 };
  const productByName = new Map();
  const curated = [];

  for (const row of rows.rows) {
    const tok = (row.variant_name || '').trim().split(/\s+/).pop()?.toUpperCase() || '';
    const item = byCode.get(tok);
    if (!item) continue;
    try {
      const family = familyOf(item.label);
      const category = family === 'Ditra-Heat' ? cats['floor-heating'] : cats['shower-systems'];
      let newName = /^schluter/i.test(item.label) ? item.label : `Schluter ${item.label}`;
      newName = `${newName} ${item.model.toUpperCase()}`.replace(/\s+/g, ' ').trim();
      const variant = (row.variant_name || '').replace(/\s+\S+$/, '').trim() || 'Standard';

      backup.products.push({ id: row.product_id, name: row.product_name });
      backup.skus.push({ id: row.sku_id, product_id: row.product_id, variant_name: row.variant_name, vendor_sku: row.vendor_sku });
      curated.push(row.internal_sku);
      stats.staged++;

      if (dry) continue;

      let productId = row.product_id;
      if (Number(row.product_sku_count) === 1) {
        stats.renamed++;
        await pool.query(`
          UPDATE products SET name=$1, collection=$2, category_id=$3, brand_id=$4, description_short=$5, updated_at=NOW()
          WHERE id=$6`, [newName, family, category, brandId, item.label, row.product_id]);
      } else {
        stats.split++;
        if (productByName.has(newName)) productId = productByName.get(newName);
        else {
          const ex = await pool.query('SELECT id FROM products WHERE vendor_id=$1 AND collection=$2 AND name=$3',
            [vendorId, family, newName]);
          if (ex.rows.length) productId = ex.rows[0].id;
          else {
            const ins = await pool.query(`
              INSERT INTO products (vendor_id, name, collection, category_id, brand_id, description_short, status)
              VALUES ($1,$2,$3,$4,$5,$6,'draft') RETURNING id`,
              [vendorId, newName, family, category, brandId, item.label]);
            productId = ins.rows[0].id;
          }
          productByName.set(newName, productId);
        }
        await pool.query('UPDATE skus SET product_id=$1 WHERE id=$2', [productId, row.sku_id]);
      }

      await pool.query(`
        UPDATE skus SET variant_name=$1, sell_by='unit',
          vendor_sku = CASE WHEN vendor_sku ~ '^9999' THEN $2 ELSE vendor_sku END
        WHERE id=$3`, [variant, item.model.toUpperCase(), row.sku_id]);

      if (item.img) {
        const has = await pool.query(
          `SELECT 1 FROM media_assets WHERE product_id=$1 AND asset_type='primary' LIMIT 1`, [productId]);
        if (!has.rows.length) {
          stats.imaged++;
          await upsertMediaAsset(pool, {
            product_id: productId, sku_id: null, asset_type: 'primary',
            url: item.img, original_url: item.img, sort_order: 0,
          });
        }
      }
    } catch (err) {
      stats.errors++;
      if (job?.id) await addJobError(pool, job.id, `${row.internal_sku}: ${err.message}`);
      else console.error('ERROR', row.internal_sku, err.message);
    }
  }

  if (!dry && curated.length) {
    let cur = { internal_skus: [] };
    try { cur = JSON.parse(fs.readFileSync(path.resolve(CURATED_PATH), 'utf8')); } catch { /* fresh */ }
    const set = new Set(cur.internal_skus || []);
    curated.forEach(s => set.add(s));
    fs.writeFileSync(path.resolve(CURATED_PATH), JSON.stringify({ updated_at: new Date().toISOString(), internal_skus: [...set] }, null, 1));
    await log(`Curated protection list now ${set.size} SKUs`);
  }
  if (!dry && backup.skus.length) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    fs.writeFileSync(path.resolve(`data/schluter-shower-prep-backup-${stamp}.json`), JSON.stringify(backup));
  }
  await log(`Done${dry ? ' (dry)' : ''}. Staged ${stats.staged} SKUs (renamed ${stats.renamed}, split ${stats.split}), ` +
    `products imaged ${stats.imaged}, errors ${stats.errors}. All remain DRAFT until Big D pricing arrives.`,
    { products_found: stats.staged, products_updated: stats.renamed + stats.split });
  return stats;
}

if (process.argv[1] && process.argv[1].endsWith('schluter-shower-prep.js')) {
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
