// One-time backfill: mirror active-product images to uploads/mirror.
// Covers primary AND gallery assets (alternate/lifestyle/swatch) so a vendor CDN
// can't break the product gallery — not just the hero. spec_pdf is excluded
// (not an image; mirrorMediaRow's sharp decode would skip it anyway).
// Resumable (only touches mirrored_at IS NULL), fragile-CDNs-first so the
// already-failing hosts (Caesarstone/Mapei/Wix/Cloudinary) get owned first.
//
//   node mirror-images-backfill.mjs [--limit N] [--fragile-only] [--concurrency N]
//                                   [--host <substr>] [--types a,b,c]
//
// Safe to re-run and safe to kill — each image is atomic and idempotent.

import { pool } from './db.js';
import { mirrorMediaRow } from './lib/imageMirror.js';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const LIMIT = parseInt(arg('--limit', '0'), 10);
const CONC = parseInt(arg('--concurrency', '8'), 10);
const FRAGILE_ONLY = process.argv.includes('--fragile-only');
const FRAGILE_RE = 'caesarstone|cdnmedia\\.mapei|wixstatic|cloudinary';
// --host <substr>: mirror only rows whose url matches this host/regex fragment.
// Lets a specific vendor be swept on demand (e.g. --host salsify to clear
// Google's "invalid image encoding" bucket). Sanitized to url-safe chars since
// it's interpolated into the query, same as FRAGILE_RE.
const HOST = (arg('--host', '') || '').replace(/[^a-z0-9.\\|_-]/gi, '');
// Image asset types to mirror. spec_pdf is intentionally excluded. Override with
// --types (e.g. --types primary to restore the old primary-only behaviour).
const DEFAULT_TYPES = ['primary', 'alternate', 'lifestyle', 'swatch'];
const TYPES = (arg('--types', '') || '')
  .split(',').map(s => s.trim().toLowerCase()).filter(t => DEFAULT_TYPES.includes(t));
const ASSET_TYPES = TYPES.length ? TYPES : DEFAULT_TYPES;
const TYPE_LIST = ASSET_TYPES.map(t => `'${t}'`).join(',');

const { rows } = await pool.query(`
  SELECT ma.id, ma.url, ma.original_url
  FROM media_assets ma JOIN products p ON p.id = ma.product_id
  WHERE ma.asset_type IN (${TYPE_LIST}) AND p.status = 'active'
    AND ma.mirrored_at IS NULL AND ma.url ~ '^https?://'
    ${FRAGILE_ONLY ? `AND ma.url ~ '${FRAGILE_RE}'` : ''}
    ${HOST ? `AND ma.url ~ '${HOST}'` : ''}
  ORDER BY (ma.url ~ '${FRAGILE_RE}') DESC, (ma.asset_type = 'primary') DESC, md5(ma.id::text)
  ${LIMIT ? `LIMIT ${LIMIT}` : ''}
`);

console.log(`${rows.length} images to mirror [${ASSET_TYPES.join(',')}] (concurrency ${CONC}${FRAGILE_ONLY ? ', fragile-only' : ''}${HOST ? `, host~${HOST}` : ''})`);
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
