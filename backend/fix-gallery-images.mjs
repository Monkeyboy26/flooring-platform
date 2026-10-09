// Remove the gallery images the vision check (verify-gallery-images.mjs) flagged
// as a DIFFERENT product/format than the SKU's primary. Principle from the
// scrapers: no image > wrong image. Deletes the media_assets rows (with a JSON
// backup) so the wrong hex/slab/pattern shot leaves the gallery; the primary
// (and any correct alternates) stay.
//
//   node fix-gallery-images.mjs [--vendor MSI] [--min-confidence 0.7] [--dry-run | --apply]

import fs from 'fs';
import { pool } from './db.js';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const APPLY = process.argv.includes('--apply');
const VENDOR = arg('--vendor', 'MSI');
const MINCONF = parseFloat(arg('--min-confidence', '0.7'));

const { rows } = await pool.query(`
  SELECT g.media_id, g.observed, g.confidence, g.note, m.asset_type, m.url, m.original_url,
         p.name, v.code AS vendor_code
  FROM gallery_image_checks g
  JOIN media_assets m ON m.id = g.media_id
  JOIN products p ON p.id = m.product_id
  JOIN vendors v ON v.id = p.vendor_id
  WHERE g.matches = false AND g.confidence >= $1
    AND ($2::text IS NULL OR v.code = $2)
  ORDER BY p.name`, [MINCONF, VENDOR]);

console.log(`${rows.length} confirmed-different gallery images (confidence >= ${MINCONF}${VENDOR ? `, ${VENDOR}` : ''})`);
for (const r of rows.slice(0, 20)) console.log(`  ${r.name.slice(0,34).padEnd(34)} [${r.asset_type}] obs="${(r.observed||'').slice(0,40)}" ...${(r.original_url||r.url).slice(-40)}`);

if (!APPLY) { console.log('\nDry-run. Re-run with --apply.'); await pool.end(); process.exit(0); }

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
await pool.query(`CREATE TABLE IF NOT EXISTS gallery_badimg_backup_${stamp.replace(/[^0-9]/g,'').slice(0,14)} AS SELECT m.*, now() AS backed_up_at FROM media_assets m WHERE 1=0`);
const tbl = `gallery_badimg_backup_${stamp.replace(/[^0-9]/g,'').slice(0,14)}`;
const ids = rows.map(r => r.media_id);
if (ids.length) {
  await pool.query(`INSERT INTO ${tbl} SELECT m.*, now() FROM media_assets m WHERE m.id = ANY($1)`, [ids]);
  await pool.query(`DELETE FROM media_assets WHERE id = ANY($1)`, [ids]);
}
console.log(`Deleted ${ids.length} wrong gallery images. Backup table: ${tbl}`);
await pool.end();
