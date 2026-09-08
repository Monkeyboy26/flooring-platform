// Repair products whose PRIMARY image 404s but that still have a working
// alternate/gallery media_asset — promote the working alternate's URL onto the
// primary row. No re-scrape needed; the product keeps showing a real photo of
// itself. Products with no working sibling are left for a per-vendor image
// re-scrape (reported at the end).
//
// Idempotent. Dry run by default; pass --apply to write.
//   docker compose exec -T api node scripts/fix-broken-primary-images-2026-09-07.mjs [--apply]
import { pool } from '../db.js';

const APPLY = process.argv.includes('--apply');

// Mirror the /api/img proxy + quality checkUrl normalization so a URL that the
// app can actually load is judged "ok".
function normalize(url) {
  if (url && url.includes('&amp;')) url = url.replace(/&amp;/gi, '&');
  if (/[ -￿]/.test(url)) url = encodeURI(url);
  return url;
}
async function resolves(url) {
  const u = normalize(url);
  for (const method of ['HEAD', 'GET']) {
    try {
      const c = new AbortController();
      const t = setTimeout(() => c.abort(), 10000);
      const res = await fetch(u, { method, redirect: 'follow', signal: c.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 RomaImgFix/1.0' } });
      clearTimeout(t);
      if (res.body && method === 'GET') { try { await res.body.cancel(); } catch {} }
      if (res.ok) return true;
      if (method === 'GET') return false;
      if (![405, 403, 400].includes(res.status)) return false;
    } catch { if (method === 'GET') return false; }
  }
  return true;
}

async function main() {
  const { rows } = await pool.query(`
    SELECT qv.product_id, (qv.detail->>'media_id')::uuid AS bad_media,
           p.name, v.code AS vendor
    FROM quality_violations qv
    JOIN products p ON p.id = qv.product_id
    JOIN vendors v ON v.id = p.vendor_id
    WHERE qv.status='open' AND qv.rule_key='broken-image'
    ORDER BY v.code, p.name`);
  console.log(`${rows.length} broken-primary products to inspect\n`);

  let fixed = 0; const stillDead = [];
  for (const r of rows) {
    const alts = (await pool.query(
      `SELECT id, url, asset_type FROM media_assets
       WHERE product_id=$1 AND id<>$2 AND url ~* '^https?://'
       ORDER BY (asset_type='primary') DESC, sort_order`,
      [r.product_id, r.bad_media])).rows;
    let winner = null;
    for (const a of alts) { if (await resolves(a.url)) { winner = a; break; } }
    if (!winner) { stillDead.push(`${r.vendor}  ${r.name}`); continue; }
    fixed++;
    console.log(`  [${r.vendor}] ${r.name} -> ${winner.url.slice(0, 80)}`);
    if (APPLY) {
      await pool.query(`UPDATE media_assets SET url=$2, original_url=COALESCE(original_url,url) WHERE id=$1`,
        [r.bad_media, normalize(winner.url)]);
    }
  }

  console.log(`\n${fixed} primaries repaired from a working sibling; ${stillDead.length} have no working image (need re-scrape):`);
  for (const s of stillDead) console.log('  DEAD  ' + s);
  console.log(APPLY ? '\nApplied.' : '\nDry run — re-run with --apply.');
  await pool.end();
}
main().catch(e => { console.error(e); process.exit(1); });
