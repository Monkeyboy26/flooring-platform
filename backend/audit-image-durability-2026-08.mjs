// Image durability audit (2026-08-26). Answers: how fragile is our hotlinking?
// Samples primary images per CDN host, fetches each, and reports breakage rate,
// hotlink-hostility (401/403), and average byte size (to size a mirror to S3).
// Read-only — no DB writes. Sample-based so it's quick and polite to vendors.
//
//   node audit-image-durability-2026-08.mjs [samplePerHost=25]

import { pool } from './db.js';

const SAMPLE = parseInt(process.argv[2] || '25', 10);

function hostOf(url) {
  if (/^\/(uploads|assets|api)\//.test(url)) return '(self/proxy)';
  const m = url.match(/^https?:\/\/([^/]+)/i);
  return m ? m[1] : '(other)';
}

// One random sample of primary URLs per host (SQL-side sampling via row_number).
const { rows } = await pool.query(`
  WITH prim AS (
    SELECT ma.url,
      CASE WHEN ma.url ~ '^/(uploads|assets|api)/' THEN '(self/proxy)'
           ELSE split_part(regexp_replace(ma.url,'^https?://',''),'/',1) END AS host,
      row_number() OVER (PARTITION BY
        CASE WHEN ma.url ~ '^/(uploads|assets|api)/' THEN '(self/proxy)'
             ELSE split_part(regexp_replace(ma.url,'^https?://',''),'/',1) END
        ORDER BY md5(ma.id::text)) AS rn,
      count(*) OVER (PARTITION BY
        CASE WHEN ma.url ~ '^/(uploads|assets|api)/' THEN '(self/proxy)'
             ELSE split_part(regexp_replace(ma.url,'^https?://',''),'/',1) END) AS host_total
    FROM media_assets ma JOIN products p ON p.id=ma.product_id
    WHERE ma.asset_type='primary' AND p.status='active' AND ma.url ~ '^https?://'
  )
  SELECT url, host, host_total FROM prim WHERE rn <= $1
`, [SAMPLE]);

const byHost = new Map();
for (const r of rows) {
  if (!byHost.has(r.host)) byHost.set(r.host, { total: r.host_total, urls: [] });
  byHost.get(r.host).urls.push(r.url);
}

async function probe(url) {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 12000);
    const res = await fetch(url, { redirect: 'follow', signal: c.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 RomaImageAudit/1.0' } });
    clearTimeout(t);
    const len = parseInt(res.headers.get('content-length') || '0', 10);
    let bytes = len;
    if (!bytes && res.ok) { const b = await res.arrayBuffer(); bytes = b.byteLength; }
    else if (res.body) { try { await res.body.cancel(); } catch {} }
    return { ok: res.ok, status: res.status, bytes };
  } catch (e) { return { ok: false, status: e.name === 'AbortError' ? 'timeout' : 'unreachable', bytes: 0 }; }
}

const results = [];
for (const [host, info] of [...byHost.entries()].sort((a, b) => b[1].total - a[1].total)) {
  let ok = 0, broken = 0, blocked = 0, bytesSum = 0, bytesN = 0;
  const CONC = 8;
  let i = 0;
  async function worker() {
    while (i < info.urls.length) {
      const url = info.urls[i++];
      const r = await probe(url);
      if (r.ok) { ok++; if (r.bytes) { bytesSum += r.bytes; bytesN++; } }
      else { broken++; if (r.status === 403 || r.status === 401) blocked++; }
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));
  const n = info.urls.length;
  const avgKb = bytesN ? Math.round(bytesSum / bytesN / 1024) : 0;
  results.push({ host, catalog_total: parseInt(info.total, 10), sampled: n,
    broken_pct: Math.round(broken / n * 100), blocked, avg_kb: avgKb,
    est_mirror_mb: avgKb ? Math.round(info.total * avgKb / 1024) : null });
}

console.log(`Durability audit — ${SAMPLE}/host sample of active primary images\n`);
console.log('HOST'.padEnd(34), 'CATALOG'.padStart(8), 'BROKEN%'.padStart(8), 'BLOCKED'.padStart(8), 'AVG_KB'.padStart(7), 'MIRROR_MB'.padStart(10));
let totalMirrorMb = 0, totalCatalog = 0, weightedBroken = 0;
for (const r of results) {
  console.log(r.host.slice(0, 33).padEnd(34), String(r.catalog_total).padStart(8),
    (r.broken_pct + '%').padStart(8), String(r.blocked).padStart(8),
    String(r.avg_kb).padStart(7), String(r.est_mirror_mb ?? '?').padStart(10));
  if (r.est_mirror_mb) totalMirrorMb += r.est_mirror_mb;
  totalCatalog += r.catalog_total;
  weightedBroken += r.broken_pct / 100 * r.catalog_total;
}
console.log('\nTotals: ~' + totalCatalog + ' primary images, est ~' + (totalMirrorMb / 1024).toFixed(1) +
  ' GB to mirror primaries, weighted breakage ~' + Math.round(weightedBroken / totalCatalog * 100) + '%');
await pool.end();
