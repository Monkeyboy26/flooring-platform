// Diagnostic (read-only): probe active-product PRIMARY images that are still raw
// vendor URLs (mirrored_at IS NULL) and report which are dead (404/410) — i.e.
// broken product cards/heroes. Does NOT delete: a dead primary is a product
// decision (deactivate / re-scrape / swap an alternate up), not a media delete.
//
//   node probe-dead-primaries.mjs [--concurrency N] [--host substr]
import { pool } from './db.js';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const CONC = parseInt(arg('--concurrency', '24'), 10);
const HOST = (arg('--host', '') || '').replace(/[^a-z0-9.\\|_-]/gi, '');

const { rows } = await pool.query(`
  SELECT ma.id, ma.url, p.name AS product, p.slug, v.code AS vendor, v.name AS vendor_name
  FROM media_assets ma
  JOIN products p ON p.id = ma.product_id
  JOIN vendors v ON v.id = p.vendor_id
  WHERE ma.asset_type = 'primary' AND p.status = 'active'
    AND ma.mirrored_at IS NULL AND ma.url ~ '^https?://'
    ${HOST ? `AND ma.url ~ '${HOST}'` : ''}
`);
console.log(`${rows.length} unmirrored active primaries to probe (concurrency ${CONC}${HOST ? `, host~${HOST}` : ''})`);

async function probe(url) {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 12000);
    const res = await fetch(url, { method: 'GET', redirect: 'follow', signal: c.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) RomaImageSweep/1.0' } });
    clearTimeout(t);
    try { await res.body?.cancel(); } catch {}
    return res.status;
  } catch { return 0; }
}

const dead = [], other = {};
let cursor = 0, done = 0;
async function worker() {
  while (cursor < rows.length) {
    const r = rows[cursor++];
    const s = await probe(r.url);
    if (s === 404 || s === 410) dead.push(r);
    else if (s !== 200) other[s] = (other[s] || 0) + 1;
    if (++done % 1000 === 0) console.log(`  probed ${done}/${rows.length}  dead=${dead.length}`);
  }
}
await Promise.all(Array.from({ length: CONC }, worker));

const byVendor = {};
for (const d of dead) byVendor[d.vendor] = (byVendor[d.vendor] || 0) + 1;
console.log(`\n=== DEAD PRIMARIES: ${dead.length} / ${rows.length} (${(100 * dead.length / (rows.length || 1)).toFixed(1)}%) ===`);
console.log('non-200-non-dead kept by status:', JSON.stringify(other));
console.log('\nDead by vendor:');
for (const [v, n] of Object.entries(byVendor).sort((a, b) => b[1] - a[1])) console.log(`  ${v}: ${n}`);
console.log('\nSample (up to 25):');
for (const d of dead.slice(0, 25)) console.log(`  [${d.vendor}] ${d.product}  /shop/${d.slug}\n      ${d.url}`);
await pool.end();
