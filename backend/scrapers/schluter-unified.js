import fs from 'fs';
import path from 'path';
import { upsertMediaAsset, appendLog, addJobError } from './base.js';
import { extractCodes } from './bigd-reprice.js';
import { crawl as crawlSchluterCom } from './dal-enrich-schluter.js';

/**
 * Schluter implementation pipeline — turns the Big D CSP sheet's 165 Schluter
 * profile SKUs into real, published storefront products.
 *
 * For every Daltile-imported SKU whose part code is on the sheet:
 *   - product gets a real name built from the sheet description, WITH the part
 *     code kept in the name ("Schluter Jolly 3/8" Satin Anodized Aluminum
 *     J100AE") — contractors search by code and re-runs re-match through it
 *   - SKUs grouped into EDI catch-all products ("Trim & Accessories") are
 *     split out onto their own product
 *   - collection = profile family (Jolly, Schiene, Quadec, ...), category =
 *     transitions-moldings, brand = Schluter, variant = finish only
 *   - product images/descriptions come from schluter.com family pages (reuses
 *     dal-enrich-schluter's crawl)
 *   - product + SKU set active, sell_by = unit
 *
 * Pricing is schluter-reprice.js's job (retail = sheet, cost untouched).
 * Vendor stays DAL (Daltile still supplies the rest of the Schluter catalog);
 * curated internal_skus are appended to data/dal-curated-skus.json, which
 * daltile-832.js skips so a re-import can't yank them back onto junk products.
 *
 * CLI: docker compose exec api node scrapers/schluter-unified.js [--dry] [--no-crawl]
 */

const SHEET_PATH = 'data/bigd-schluter-pricesheet.json';
const CURATED_PATH = 'data/dal-curated-skus.json';

function titleCaseWord(w) {
  if (/\d/.test(w) || w.length <= 2) return w; // codes, sizes, "PVC"
  if (w.includes('-')) {
    // Family tokens like DILEX-AHK / RENO-U: short suffixes stay upper
    return w.split('-').map(seg => seg.length <= 4 && seg === seg.toUpperCase() && !/[aeiou]/i.test(seg.slice(1))
      ? seg.toUpperCase()
      : seg.charAt(0) + seg.slice(1).toLowerCase()).join('-');
  }
  return w.charAt(0) + w.slice(1).toLowerCase();
}

/** '5/16" BRUSHED CHROME ANODIZED ALUMINUM' pieces → readable name */
function buildName(item) {
  const code = item.code.toUpperCase();
  let rest = item.desc.replace(new RegExp('^' + code + '\\s*', 'i'), '').replace(/SCHLUTER\s+/i, '');
  rest = rest.split(/\s+/).map(titleCaseWord).join(' ');
  return `Schluter ${rest} ${code}`.replace(/\s+/g, ' ').trim();
}

function familyOf(item) {
  const m = /SCHLUTER\s+([A-Z]+(?:-[A-Z]+)*)/i.exec(item.desc);
  if (!m) return 'Schluter';
  // Title-case each dash segment: 'DILEX-AHK' → 'Dilex-AHK' reads oddly; keep
  // the family token as Schluter writes them: first letter cap, rest lower,
  // short all-cap suffixes preserved (AHK, TK, U...)
  return m[1].split('-').map(seg => seg.length <= 3 ? seg.toUpperCase() : seg.charAt(0) + seg.slice(1).toLowerCase()).join('-');
}

function cleanVariantFinish(variant) {
  if (!variant) return variant;
  let s = variant.replace(/\s+[A-Z]*\d[\w/-]*$/i, '').trim(); // strip trailing code token
  if (!s) return variant.trim();
  if (s === s.toUpperCase()) s = s.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
  return s;
}

export async function run(pool, job, source, opts = {}) {
  const dry = !!opts.dry;
  const noCrawl = !!opts.noCrawl;
  const log = async (msg, counters) => {
    if (job?.id) await appendLog(pool, job.id, msg, counters);
    else console.log(msg);
  };

  const sheet = JSON.parse(fs.readFileSync(path.resolve(SHEET_PATH), 'utf8'));
  const byCode = new Map(sheet.items.map(it => [it.code.toUpperCase(), it]));
  await log(`Schluter unified${dry ? ' (DRY RUN)' : ''}: ${byCode.size} sheet codes — ${sheet.source}`);

  const catRow = await pool.query(`SELECT id FROM categories WHERE slug = 'transitions-moldings'`);
  const brandRow = await pool.query(`SELECT id FROM brands WHERE code = 'SCHLUTER'`);
  const categoryId = catRow.rows[0]?.id || null;
  const brandId = brandRow.rows[0]?.id || null;

  const rows = await pool.query(`
    SELECT s.id AS sku_id, s.internal_sku, s.variant_name, s.status AS sku_status, s.sell_by,
           p.id AS product_id, p.name AS product_name, p.status AS product_status,
           COUNT(*) OVER (PARTITION BY p.id) AS product_sku_count
    FROM skus s
    JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id
    WHERE v.code = 'DAL' AND p.collection = 'Schluter Systems LP'
    ORDER BY p.name, s.variant_name
  `);

  // Match SKUs to sheet items
  const matched = []; // { row, item }
  for (const row of rows.rows) {
    let item = null;
    for (const c of extractCodes(row.variant_name, row.product_name)) {
      if (byCode.has(c)) { item = byCode.get(c); break; }
    }
    if (item) matched.push({ row, item });
  }
  await log(`Matched ${matched.length}/${rows.rows.length} SKUs against the sheet`);

  // Crawl schluter.com once for family images + descriptions
  let enrichment = new Map();
  if (!noCrawl) {
    try {
      enrichment = await crawlSchluterCom();
      await log(`schluter.com crawl: ${enrichment.size} product lines with images/descriptions`);
    } catch (err) {
      await log(`schluter.com crawl failed (${err.message}) — continuing without images`);
    }
  }
  const familyData = (family) => enrichment.get(family.toLowerCase().replace(/-/g, ' '))
    || enrichment.get(family.toLowerCase().split('-')[0]) || null;

  const backup = { created_at: new Date().toISOString(), products: [], skus: [] };
  const stats = { renamed: 0, split: 0, activated: 0, variantsCleaned: 0, imagesSet: 0, described: 0, errors: 0 };
  const vendorId = (await pool.query(`SELECT id FROM vendors WHERE code = 'DAL'`)).rows[0].id;
  const productByName = new Map(); // new-name → product_id (dedupe within run)
  const imagedProducts = new Set();

  async function ensureImages(productId, family, itemDescShort) {
    if (imagedProducts.has(productId)) return;
    imagedProducts.add(productId);
    const has = await pool.query(`SELECT 1 FROM media_assets WHERE product_id = $1 AND asset_type = 'primary' LIMIT 1`, [productId]);
    if (has.rows.length) return;
    const data = familyData(family);
    if (!data?.images?.length) return;
    stats.imagesSet++;
    if (dry) return;
    for (let i = 0; i < Math.min(data.images.length, 4); i++) {
      await upsertMediaAsset(pool, {
        product_id: productId, sku_id: null,
        asset_type: i === 0 ? 'primary' : 'alternate',
        url: data.images[i], original_url: data.images[i], sort_order: i,
      });
    }
    if (data.descShort) {
      stats.described++;
      if (!dry) {
        await pool.query(`
          UPDATE products SET description_short = COALESCE(NULLIF(description_short, ''), $1),
                              description_long = COALESCE(description_long, $2)
          WHERE id = $3
        `, [data.descShort, data.descLong || null, productId]);
      }
    }
  }

  for (const { row, item } of matched) {
    try {
      const newName = buildName(item);
      const family = familyOf(item);
      const singleSku = Number(row.product_sku_count) === 1;
      let productId = row.product_id;

      backup.products.push({ id: row.product_id, name: row.product_name, status: row.product_status });
      backup.skus.push({ id: row.sku_id, product_id: row.product_id, variant_name: row.variant_name, status: row.sku_status, sell_by: row.sell_by });

      if (singleSku) {
        stats.renamed++;
        if (!dry) {
          await pool.query(`
            UPDATE products SET name = $1, collection = $2, category_id = $3, brand_id = $4,
                                status = 'active', updated_at = NOW()
            WHERE id = $5
          `, [newName, family, categoryId, brandId, row.product_id]);
        }
      } else {
        // Split out of a catch-all product onto its own (find-or-create by name)
        stats.split++;
        if (!dry) {
          if (productByName.has(newName)) {
            productId = productByName.get(newName);
          } else {
            const existing = await pool.query(
              `SELECT id FROM products WHERE vendor_id = $1 AND collection = $2 AND name = $3`,
              [vendorId, family, newName]);
            if (existing.rows.length) {
              productId = existing.rows[0].id;
            } else {
              const ins = await pool.query(`
                INSERT INTO products (vendor_id, name, collection, category_id, brand_id, status)
                VALUES ($1, $2, $3, $4, $5, 'active') RETURNING id
              `, [vendorId, newName, family, categoryId, brandId]);
              productId = ins.rows[0].id;
            }
            productByName.set(newName, productId);
          }
          await pool.query('UPDATE skus SET product_id = $1 WHERE id = $2', [productId, row.sku_id]);
        }
      }

      const cleanedVariant = cleanVariantFinish(row.variant_name);
      if (cleanedVariant && cleanedVariant !== row.variant_name) stats.variantsCleaned++;
      stats.activated++;
      if (!dry) {
        await pool.query(`UPDATE skus SET status = 'active', sell_by = 'unit', variant_name = $1 WHERE id = $2`,
          [cleanedVariant || row.variant_name, row.sku_id]);
        await ensureImages(productId, family, item.desc);
      } else {
        await ensureImages(productId, family, item.desc); // counts only (dry short-circuits writes)
      }
    } catch (err) {
      stats.errors++;
      if (job?.id) await addJobError(pool, job.id, `${row.internal_sku}: ${err.message}`);
      else console.error(`ERROR ${row.internal_sku}:`, err.message);
    }
  }

  // Protect curated SKUs from Daltile re-imports
  if (!dry && matched.length) {
    let cur = { internal_skus: [] };
    try { cur = JSON.parse(fs.readFileSync(path.resolve(CURATED_PATH), 'utf8')); } catch { /* fresh file */ }
    const set = new Set(cur.internal_skus || []);
    matched.forEach(({ row }) => set.add(row.internal_sku));
    fs.writeFileSync(path.resolve(CURATED_PATH), JSON.stringify({ updated_at: new Date().toISOString(), internal_skus: [...set] }, null, 1));
    await log(`Curated-SKU protection list updated: ${set.size} SKUs (daltile-832 skips these)`);
  }

  if (!dry && backup.skus.length) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    fs.writeFileSync(path.resolve(`data/schluter-unified-backup-${stamp}.json`), JSON.stringify(backup));
  }

  await log(
    `Done${dry ? ' (dry)' : ''}. Renamed ${stats.renamed}, split from catch-alls ${stats.split}, ` +
    `activated ${stats.activated} SKUs, variants cleaned ${stats.variantsCleaned}, ` +
    `products imaged ${stats.imagesSet}, descriptions ${stats.described}, errors ${stats.errors}.`,
    { products_found: matched.length, products_updated: stats.renamed + stats.split }
  );
  return stats;
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

if (process.argv[1] && process.argv[1].endsWith('schluter-unified.js')) {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({
    host: process.env.DB_HOST || 'db',
    port: Number(process.env.DB_PORT) || 5432,
    database: process.env.DB_NAME || 'flooring_pim',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || process.env.DB_PASS || 'postgres',
  });
  try {
    await run(pool, { id: null }, null, {
      dry: process.argv.includes('--dry'),
      noCrawl: process.argv.includes('--no-crawl'),
    });
  } finally {
    await pool.end();
  }
}
