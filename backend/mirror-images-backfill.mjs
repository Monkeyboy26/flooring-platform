// One-time backfill: mirror active-product PRIMARY images to uploads/mirror.
// Resumable (only touches mirrored_at IS NULL), fragile-CDNs-first so the
// already-failing hosts (Caesarstone/Mapei/Wix/Cloudinary) get owned first.
//
//   node mirror-images-backfill.mjs [--limit N] [--fragile-only] [--concurrency N]
//
// Safe to re-run and safe to kill — each image is atomic and idempotent.

import { pool } from './db.js';
import { mirrorMediaRow } from './lib/imageMirror.js';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const LIMIT = parseInt(arg('--limit', '0'), 10);
const CONC = parseInt(arg('--concurrency', '8'), 10);
const FRAGILE_ONLY = process.argv.includes('--fragile-only');
const FRAGILE_RE = 'caesarstone|cdnmedia\\.mapei|wixstatic|cloudinary';

const { rows } = await pool.query(`
  SELECT ma.id, ma.url, ma.original_url
  FROM media_assets ma JOIN products p ON p.id = ma.product_id
  WHERE ma.asset_type = 'primary' AND p.status = 'active'
    AND ma.mirrored_at IS NULL AND ma.url ~ '^https?://'
    ${FRAGILE_ONLY ? `AND ma.url ~ '${FRAGILE_RE}'` : ''}
  ORDER BY (ma.url ~ '${FRAGILE_RE}') DESC, md5(ma.id::text)
  ${LIMIT ? `LIMIT ${LIMIT}` : ''}
`);

console.log(`${rows.length} primaries to mirror (concurrency ${CONC}${FRAGILE_ONLY ? ', fragile-only' : ''})`);
let done = 0, ok = 0, skip = 0, bytes = 0;
const t0 = Date.now();
let cursor = 0;
async function worker() {
  while (cursor < rows.length) {
    const row = rows[cursor++];
    try {
      const b = await mirrorMediaRow(pool, row);
      if (b) { ok++; bytes += b; } else skip++;
    } catch (e) { skip++; }
    if (++done % 250 === 0) {
      const rate = done / ((Date.now() - t0) / 1000);
      console.log(`  ${done}/${rows.length}  ok=${ok} skip=${skip}  ${(bytes / 1048576).toFixed(0)}MB  ${rate.toFixed(1)}/s  eta ${Math.round((rows.length - done) / rate / 60)}m`);
    }
  }
}
await Promise.all(Array.from({ length: CONC }, worker));
console.log(`\nDone: ${ok} mirrored, ${skip} skipped (kept vendor url), ${(bytes / 1048576).toFixed(0)}MB total, ${Math.round((Date.now() - t0) / 1000)}s`);
await pool.end();
