// Soft-demote the Daltile lifestyle links the vision check
// (verify-daltile-lifestyle.mjs) flagged as a COLOR MISMATCH — a collection
// room scene showing a different color than that variant. Re-labels asset_type
// 'lifestyle' -> 'lifestyle_hidden'. EVERY customer-facing media query (storefront
// PDP media endpoint + browse/lifestyle CTEs in server.js) uses an explicit
// asset_type allow-list that does NOT include 'lifestyle_hidden', so the wrong-
// color room scene disappears from the PDP/gallery immediately while the row is
// preserved for audit and trivially reversible from the backup. (NOTE: 'swatch'
// is NOT a safe hide target — the storefront gallery renders swatch images;
// hence a dedicated hidden type.) Principle from the scrapers: no image > wrong
// image. sort_order is left unchanged — the new asset_type can't collide with
// the unique (product,sku,asset_type,sort_order) index, so reversal is a clean
// type flip.
//
//   node fix-daltile-lifestyle-demote.mjs [--vendor DAL] [--min-confidence 0.7] [--dry-run | --apply]
//
// Reverse:  UPDATE media_assets SET asset_type='lifestyle' WHERE id IN (SELECT id FROM <backup table>);

import fs from 'fs';
import { pool } from './db.js';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const APPLY = process.argv.includes('--apply');
const VENDOR = arg('--vendor', 'DAL');
const MINCONF = parseFloat(arg('--min-confidence', '0.7'));

// Same candidate set as the verifier, joined to the cached per-pair verdict.
// publicUrl() preference (original_url first) is reproduced in SQL via COALESCE
// of the http-matching column so the join key matches what the verifier stored.
const SQL = `
  WITH dal_life AS (
    SELECT m.id AS media_id, m.sku_id, m.product_id, m.asset_type, m.sort_order,
           m.url AS life_url_raw, m.original_url AS life_original,
           CASE WHEN m.original_url ~ '^https?://' THEN m.original_url
                WHEN m.url ~ '^https?://' THEN m.url END AS life_pub,
           CASE WHEN ref.original_url ~ '^https?://' THEN ref.original_url
                WHEN ref.url ~ '^https?://' THEN ref.url END AS ref_pub,
           p.name
    FROM media_assets m
    JOIN products p ON p.id = m.product_id
    JOIN vendors v ON v.id = p.vendor_id
    LEFT JOIN LATERAL (
      SELECT url, original_url FROM media_assets rm
      WHERE rm.sku_id = m.sku_id AND rm.asset_type IN ('primary','swatch')
      ORDER BY (rm.asset_type = 'primary') DESC, rm.sort_order LIMIT 1
    ) ref ON true
    WHERE v.code = $1 AND p.status = 'active' AND m.asset_type = 'lifestyle'
      AND ref.url IS NOT NULL
  ),
  shared AS (
    SELECT life_url_raw FROM dal_life GROUP BY life_url_raw HAVING COUNT(DISTINCT product_id) > 1
  )
  SELECT dl.media_id, dl.sku_id, dl.product_id, dl.name, dl.sort_order,
         dl.life_url_raw, dl.life_original, dl.life_pub, dl.ref_pub,
         c.matches, c.confidence, c.observed
  FROM dal_life dl
  JOIN shared s ON s.life_url_raw = dl.life_url_raw
  JOIN lifestyle_color_checks c ON c.life_url = dl.life_pub AND c.ref_url = dl.ref_pub
  WHERE dl.life_pub IS NOT NULL AND dl.ref_pub IS NOT NULL AND dl.life_pub <> dl.ref_pub
    AND c.matches = false AND c.confidence >= $2
  ORDER BY dl.name
`;

const { rows } = await pool.query(SQL, [VENDOR, MINCONF]);
console.log(`${rows.length} lifestyle links to demote (color mismatch, confidence >= ${MINCONF}, ${VENDOR})`);
for (const r of rows.slice(0, 15))
  console.log(`  ${r.name.slice(0,42).padEnd(42)} conf=${r.confidence} room="${(r.observed||'').slice(0,26)}"`);

// Coverage sanity: how many distinct products / lifestyle images are affected.
const prods = new Set(rows.map(r => r.product_id));
const lifes = new Set(rows.map(r => r.life_url_raw));
console.log(`\nAffects ${prods.size} products across ${lifes.size} distinct lifestyle images.`);

if (!APPLY) { console.log('\nDry-run. Re-run with --apply.'); await pool.end(); process.exit(0); }

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const tbl = `dal_lifestyle_demote_backup_${stamp.replace(/[^0-9]/g,'').slice(0,14)}`;
await pool.query(`CREATE TABLE ${tbl} AS SELECT m.*, now() AS backed_up_at FROM media_assets m WHERE 1=0`);
const ids = rows.map(r => r.media_id);
if (ids.length) {
  await pool.query(`INSERT INTO ${tbl} SELECT m.*, now() FROM media_assets m WHERE m.id = ANY($1)`, [ids]);
  fs.writeFileSync(`./data/dal-lifestyle-demote-backup-${stamp}.json`,
    JSON.stringify(rows.map(r => ({ id: r.media_id, sku_id: r.sku_id, product_id: r.product_id,
      name: r.name, sort_order: r.sort_order, life: r.life_pub, ref: r.ref_pub,
      confidence: r.confidence, observed: r.observed })), null, 2));
  await pool.query(
    `UPDATE media_assets SET asset_type='lifestyle_hidden' WHERE id = ANY($1)`,
    [ids]);
}
console.log(`\nDemoted ${ids.length} wrong-color lifestyle links -> lifestyle_hidden. Backup table: ${tbl} + ./data/dal-lifestyle-demote-backup-${stamp}.json`);
await pool.end();
