/**
 * Regroup published Schluter products into profile+size parents with finish
 * variants (2026-07-27).
 *
 * Before: 147 single-SKU products ("Schluter Jolly 3/8" Satin Anodized
 * Aluminum J100AE"). After: one product per profile+size ("Schluter Jolly
 * 3/8\"") whose SKUs are the finishes — the storefront renders them as
 * variant pills via same_product_siblings, and each SKU carries its own
 * finish-specific store photo (sku-level primary from the HD/Lowe's harvest).
 *
 * The Schluter part code moves into skus.vendor_sku (replacing the orphaned
 * Daltile 9999 number — the 832 import skips these curated SKUs) so
 * schluter-reprice keeps matching. Old emptied products are deleted.
 *
 * Run: docker exec flooring-api node scripts/schluter-group-variants.mjs [--dry]
 */
import pg from 'pg';
import fs from 'fs';

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'db',
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});
const dry = process.argv.includes('--dry');

const sheet = JSON.parse(fs.readFileSync('data/bigd-schluter-pricesheet.json', 'utf8')).items;
const hd = JSON.parse(fs.readFileSync('data/hd-schluter-images.json', 'utf8')).items;
let lowes = [];
try { lowes = JSON.parse(fs.readFileSync('data/lowes-schluter-images.json', 'utf8')).items; } catch {}
const imgByCode = new Map();
for (const x of lowes) if (x.img) imgByCode.set(x.model.toUpperCase(), x.img);
for (const x of hd) if (x.img) imgByCode.set(x.model.toUpperCase(), x.img);

function familyOf(desc) {
  const m = /SCHLUTER\s+([A-Z]+(?:-[A-Z]+)*)/i.exec(desc);
  if (!m) return 'Schluter';
  const KEEP_UPPER = new Set(['AHK', 'AHKA', 'TK', 'U', 'T', 'P', 'EK', 'KS']);
  return m[1].split('-').map(seg =>
    KEEP_UPPER.has(seg.toUpperCase()) ? seg.toUpperCase()
      : seg.charAt(0) + seg.slice(1).toLowerCase()).join('-');
}

function parseItem(item) {
  const code = item.code.toUpperCase();
  const family = familyOf(item.desc);
  const long300 = /\/300$/.test(code);
  const sizeM = /(\d+\s*\/\s*\d+"|\d+(?:\.\d+)?")/.exec(item.desc);
  const size = sizeM ? sizeM[1].replace(/\s+/g, '') : null;
  // finish = desc minus code, SCHLUTER, family token, size
  let finish = item.desc
    .replace(new RegExp('^' + code.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&') + '\\s*', 'i'), '')
    .replace(/SCHLUTER\s+/i, '')
    .replace(/^[A-Z-]+\s+/i, '')      // family token
    .replace(sizeM ? sizeM[1] : '', '')
    .replace(/\s+/g, ' ').trim();
  finish = finish.split(' ').map(w => /\d/.test(w) || w.length <= 2 ? w : w.charAt(0) + w.slice(1).toLowerCase()).join(' ');
  if (!finish) finish = code;
  // group: family + size (fall back to the numeric height in the code)
  const num = (code.match(/(\d{2,3})/) || [])[1] || '';
  const groupKey = `${family}|${size || num}${long300 ? '|300' : ''}`;
  const parentName = `Schluter ${family}${size ? ' ' + size : num ? ' #' + num : ''}${long300 ? " 9'10\" Length" : ''}`;
  return { code, family, size, finish: long300 ? finish.replace(/\s*\(?9.*$/, '') + " 9'10\"" : finish, groupKey, parentName };
}

const byCode = new Map(sheet.map(it => [it.code.toUpperCase(), parseItem(it)]));

const prods = await pool.query(`
  SELECT p.id AS product_id, p.name, p.category_id, p.brand_id, p.vendor_id, p.collection,
         s.id AS sku_id, s.vendor_sku, s.internal_sku
  FROM products p
  JOIN skus s ON s.product_id = p.id
  WHERE p.brand_id = (SELECT id FROM brands WHERE code = 'SCHLUTER') AND p.status = 'active'
  ORDER BY p.name
`);

const backup = { products: [], skus: prods.rows.map(r => ({ sku_id: r.sku_id, product_id: r.product_id, vendor_sku: r.vendor_sku })) };
const parents = new Map(); // groupKey → { id, name, variants:Set }
let moved = 0, imaged = 0, deleted = 0, unparsed = 0;

for (const row of prods.rows) {
  const code = row.name.trim().split(/\s+/).pop().toUpperCase();
  const info = byCode.get(code);
  if (!info) { unparsed++; console.log('  no sheet parse for', row.name); continue; }

  let parent = parents.get(info.groupKey);
  if (!parent) {
    if (!dry) {
      const existing = await pool.query(
        'SELECT id FROM products WHERE vendor_id = $1 AND collection = $2 AND name = $3',
        [row.vendor_id, info.family, info.parentName]);
      let pid;
      if (existing.rows.length) pid = existing.rows[0].id;
      else {
        const ins = await pool.query(`
          INSERT INTO products (vendor_id, name, collection, category_id, brand_id, status)
          VALUES ($1, $2, $3, $4, $5, 'active') RETURNING id`,
          [row.vendor_id, info.parentName, info.family, row.category_id, row.brand_id]);
        pid = ins.rows[0].id;
      }
      parent = { id: pid, name: info.parentName, variants: new Set(), hasPrimary: false };
    } else {
      parent = { id: null, name: info.parentName, variants: new Set(), hasPrimary: false };
    }
    parents.set(info.groupKey, parent);
  }

  let variant = info.finish;
  if (parent.variants.has(variant.toLowerCase())) variant = `${info.finish} ${code}`;
  parent.variants.add(variant.toLowerCase());

  moved++;
  const img = imgByCode.get(code) || null;
  if (img) imaged++;
  if (dry) continue;

  await pool.query(`
    UPDATE skus SET product_id = $1, variant_name = $2,
                    vendor_sku = CASE WHEN vendor_sku ~ '^9999' THEN $3 ELSE vendor_sku END
    WHERE id = $4`, [parent.id, variant, code, row.sku_id]);

  if (img) {
    await pool.query('DELETE FROM media_assets WHERE sku_id = $1', [row.sku_id]);
    await pool.query(`
      INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
      VALUES ($1, $2, 'primary', $3, $3, 0)`, [parent.id, row.sku_id, img]);
    if (!parent.hasPrimary) {
      const has = await pool.query(
        `SELECT 1 FROM media_assets WHERE product_id = $1 AND sku_id IS NULL AND asset_type = 'primary' LIMIT 1`,
        [parent.id]);
      if (!has.rows.length) {
        await pool.query(`
          INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
          VALUES ($1, NULL, 'primary', $2, $2, 0)`, [parent.id, img]);
      }
      parent.hasPrimary = true;
    }
  }

  // Old single-SKU product is now empty — remove it (media first)
  backup.products.push({ id: row.product_id, name: row.name });
  const left = await pool.query('SELECT 1 FROM skus WHERE product_id = $1 LIMIT 1', [row.product_id]);
  if (!left.rows.length) {
    await pool.query('DELETE FROM media_assets WHERE product_id = $1', [row.product_id]);
    await pool.query('DELETE FROM product_tags WHERE product_id = $1', [row.product_id]).catch(() => {});
    await pool.query('DELETE FROM products WHERE id = $1', [row.product_id]);
    deleted++;
  }
}

if (!dry) {
  fs.writeFileSync('data/schluter-group-variants-backup-' + Date.now() + '.json', JSON.stringify(backup));
}
console.log(`${dry ? '(DRY) ' : ''}moved ${moved} SKUs into ${parents.size} parent products; ` +
  `sku images set ${imaged}; old products deleted ${deleted}; unparsed ${unparsed}`);
for (const [k, p] of [...parents].slice(0, 12)) console.log('  ', p.name, '—', p.variants.size, 'finishes');
await pool.end();
