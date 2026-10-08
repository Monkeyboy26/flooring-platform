// Post-backfill dead-gallery sweep: delete gallery rows (alternate/lifestyle/
// swatch) whose vendor source is genuinely gone, so the PDP gallery stops
// rendering broken thumbnails. Run AFTER mirror-images-backfill.mjs has drained
// the live rows — then the only still-raw gallery rows left are dead sources.
//
//   node sweep-dead-gallery.mjs            # dry-run: probe + report, no deletes
//   node sweep-dead-gallery.mjs --apply    # back up to a table, then delete
//   [--host <substr>] [--concurrency N]
//
// Only HARD-gone sources (404/410) are deleted. 403/429/5xx/timeouts are kept
// (could be bot-blocking or transient — a real user / the mirror with a browser
// UA may still get them). Deletes guard on mirrored_at IS NULL so a row the
// backfill just self-hosted is never removed. primary is deliberately NOT swept:
// a dead primary needs a product-level decision (deactivate), not a silent
// delete that leaves the card imageless — those are reported, not touched.

import { pool } from './db.js';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const APPLY = process.argv.includes('--apply');
const CONC = parseInt(arg('--concurrency', '24'), 10);
const HOST = (arg('--host', '') || '').replace(/[^a-z0-9.\\|_-]/gi, '');

const { rows } = await pool.query(`
  SELECT ma.id, ma.url, ma.asset_type
  FROM media_assets ma JOIN products p ON p.id = ma.product_id
  WHERE ma.asset_type IN ('alternate','lifestyle','swatch') AND p.status = 'active'
    AND ma.mirrored_at IS NULL AND ma.url ~ '^https?://'
    ${HOST ? `AND ma.url ~ '${HOST}'` : ''}
`);
console.log(`${rows.length} still-raw gallery rows to probe (concurrency ${CONC}${HOST ? `, host~${HOST}` : ''})`);

// Report (but never delete) dead primaries so a human can deactivate the product.
const { rows: deadPrimaryCandidates } = await pool.query(`
  SELECT ma.id, ma.url FROM media_assets ma JOIN products p ON p.id = ma.product_id
  WHERE ma.asset_type = 'primary' AND p.status = 'active'
    AND ma.mirrored_at IS NULL AND ma.url ~ '^https?://'
    ${HOST ? `AND ma.url ~ '${HOST}'` : ''}
`);

async function probe(url) {
  const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) RomaImageSweep/1.0';
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 12000);
    // GET (not HEAD) — some CDNs 405/return wrong status on HEAD. We only read
    // the status line; the body is aborted right after headers arrive.
    const res = await fetch(url, { method: 'GET', redirect: 'follow', signal: c.signal, headers: { 'User-Agent': UA } });
    clearTimeout(t);
    try { await res.body?.cancel(); } catch {}
    return res.status;
  } catch { return 0; } // network error / timeout → treat as transient, keep
}

const dead = [], otherBad = [];
let cursor = 0, done = 0;
async function worker() {
  while (cursor < rows.length) {
    const row = rows[cursor++];
    const status = await probe(row.url);
    if (status === 404 || status === 410) dead.push(row.id);
    else if (status !== 200) otherBad.push({ status, url: row.url });
    if (++done % 500 === 0) console.log(`  probed ${done}/${rows.length}  dead=${dead.length} other=${otherBad.length}`);
  }
}
await Promise.all(Array.from({ length: CONC }, worker));

console.log(`\nProbe complete: ${dead.length} dead (404/410), ${otherBad.length} other-non-200 (kept), ${rows.length - dead.length - otherBad.length} still-live-unmirrored`);
if (otherBad.length) {
  const byStatus = {};
  for (const o of otherBad) byStatus[o.status] = (byStatus[o.status] || 0) + 1;
  console.log('  non-200 kept by status:', JSON.stringify(byStatus));
}
console.log(`\n${deadPrimaryCandidates.length} unmirrored primaries exist (NOT swept — probe/deactivate separately if dead)`);

if (!dead.length) { console.log('\nNothing to delete.'); await pool.end(); process.exit(0); }
if (!APPLY) { console.log('\nDRY-RUN: re-run with --apply to back up + delete the dead rows.'); await pool.end(); process.exit(0); }

const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const backup = `media_assets_dead_gallery_backup_${stamp}`;
const idList = dead.map(id => `'${id}'`).join(',');
const client = await pool.connect();
try {
  await client.query('BEGIN');
  await client.query(`CREATE TABLE IF NOT EXISTS ${backup} AS SELECT * FROM media_assets WHERE false`);
  await client.query(`INSERT INTO ${backup} SELECT * FROM media_assets WHERE id IN (${idList}) AND mirrored_at IS NULL`);
  const del = await client.query(
    `DELETE FROM media_assets WHERE id IN (${idList}) AND mirrored_at IS NULL
       AND asset_type IN ('alternate','lifestyle','swatch')`);
  await client.query('COMMIT');
  console.log(`\nDeleted ${del.rowCount} dead gallery rows (backup: ${backup}).`);
} catch (e) {
  await client.query('ROLLBACK');
  console.error('Sweep failed, rolled back:', e.message);
} finally {
  client.release();
  await pool.end();
}
