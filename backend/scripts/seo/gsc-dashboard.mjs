// SEO Phase 5 — Google Search Console indexation & performance dashboard.
//
// Pulls Search Analytics (per-page clicks/impressions/CTR/position) + sitemap
// submitted/indexed counts from the Search Console API and buckets pages into the
// clusters this catalog cares about (facet landing pages, product PDPs, category
// pages, collections, other). Shows how the aggressive programmatic-SEO surface is
// actually performing in Google — the measurement half of Phase 5.
//
//   node scripts/seo/gsc-dashboard.mjs [--days 28] [--limit 5000] [--json]
//
// Run inside the api container (env carries the credentials):
//   docker compose exec -T api node scripts/seo/gsc-dashboard.mjs
//
// CREDENTIALS (read-only). A Google service account with access to the property:
//   GSC_SA_JSON     — the service-account key JSON, inline (preferred for env/.env)
//                     OR
//   GSC_SA_KEYFILE  — path to the key JSON file
//   GSC_SITE_URL    — property id; default 'sc-domain:romaflooringdesigns.com'
//                     (use 'https://romaflooringdesigns.com/' for a URL-prefix property)
// Grant: Search Console → Settings → Users and permissions → add the service
// account email as a Full or Restricted user on the property.

import { readFileSync } from 'node:fs';
import { JWT } from 'google-auth-library';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const DAYS = parseInt(arg('--days', '28'), 10);
const LIMIT = parseInt(arg('--limit', '5000'), 10);
const JSON_OUT = process.argv.includes('--json');
const SITE = process.env.GSC_SITE_URL || 'sc-domain:romaflooringdesigns.com';

// ── Credentials ──────────────────────────────────────────────────────────────
function loadServiceAccount() {
  if (process.env.GSC_SA_JSON) {
    try { return JSON.parse(process.env.GSC_SA_JSON); }
    catch { throw new Error('GSC_SA_JSON is set but is not valid JSON'); }
  }
  if (process.env.GSC_SA_KEYFILE) {
    return JSON.parse(readFileSync(process.env.GSC_SA_KEYFILE, 'utf8'));
  }
  return null;
}

const sa = loadServiceAccount();
if (!sa) {
  console.error(`✗ No Search Console credentials found.

Set ONE of these in the api environment (.env), then re-run:
  GSC_SA_JSON='{...service-account key json...}'
  GSC_SA_KEYFILE=/path/to/key.json
Optionally GSC_SITE_URL (default ${SITE}).

Setup: create a Google Cloud service account, enable the "Google Search Console
API", download its JSON key, and add the service-account email as a user on the
Search Console property.`);
  process.exit(2);
}

const auth = new JWT({
  email: sa.client_email,
  key: sa.private_key,
  scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
});

async function gsc(path, { method = 'GET', body } = {}) {
  const { token } = await auth.getAccessToken();
  const res = await fetch(`https://searchconsole.googleapis.com/webmasters/v3/${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`GSC ${method} ${path} → ${res.status} ${res.statusText} ${txt.slice(0, 300)}`);
  }
  return res.json();
}

// ── Date range (GSC data lags ~2–3 days; end 3 days back) ────────────────────
// Date math without Date.now(): derive from a fixed anchor passed by the caller is
// overkill here — GSC needs real calendar dates, so use the system clock directly.
const iso = d => d.toISOString().slice(0, 10);
const end = new Date(Date.now() - 3 * 864e5);
const start = new Date(end.getTime() - DAYS * 864e5);

// ── Page classifier — the clusters this catalog cares about ──────────────────
function classify(url) {
  let path;
  try { path = new URL(url).pathname + (new URL(url).search || ''); } catch { return 'other'; }
  if (path === '/' ) return 'home';
  if (path.startsWith('/shop?category=') || path.startsWith('/shop/?category=')) return 'category';
  if (/^\/shop\/[a-z0-9-]+\/[a-z0-9-]+\/?$/.test(path)) return 'product';   // two-segment PDP
  if (/^\/shop\/[a-z0-9-]+\/?$/.test(path)) return 'facet';                 // single-segment landing
  if (path === '/shop' || path.startsWith('/shop?') || path.startsWith('/shop/?')) return 'browse';
  if (path.startsWith('/collections')) return 'collections';
  if (path.startsWith('/trade')) return 'trade';
  return 'other';
}

// ── Pull data ────────────────────────────────────────────────────────────────
let rows = [];
try {
  const data = await gsc(`sites/${encodeURIComponent(SITE)}/searchAnalytics/query`, {
    method: 'POST',
    body: { startDate: iso(start), endDate: iso(end), dimensions: ['page'], rowLimit: LIMIT },
  });
  rows = data.rows || [];
} catch (e) {
  console.error(`✗ Search Analytics query failed: ${e.message}`);
  console.error(`  Check that the service account is a user on property "${SITE}" and the API is enabled.`);
  process.exit(1);
}

let sitemaps = [];
try {
  const sm = await gsc(`sites/${encodeURIComponent(SITE)}/sitemaps`);
  sitemaps = sm.sitemap || [];
} catch { /* sitemaps are a nice-to-have; ignore if unavailable */ }

// ── Aggregate by cluster ─────────────────────────────────────────────────────
const clusters = {};
for (const r of rows) {
  const c = classify(r.keys[0]);
  const b = (clusters[c] ||= { pages: 0, clicks: 0, impressions: 0, posSum: 0 });
  b.pages++; b.clicks += r.clicks || 0; b.impressions += r.impressions || 0;
  b.posSum += (r.position || 0) * (r.impressions || 0); // impression-weighted position
}
const order = ['facet', 'product', 'category', 'collections', 'browse', 'trade', 'home', 'other'];
const totals = rows.reduce((t, r) => (t.clicks += r.clicks || 0, t.impr += r.impressions || 0, t.pages++, t), { clicks: 0, impr: 0, pages: 0 });

if (JSON_OUT) {
  console.log(JSON.stringify({ site: SITE, range: { start: iso(start), end: iso(end) }, totals, clusters, sitemaps }, null, 2));
} else {
  console.log(`\nGoogle Search Console — ${SITE}   (${iso(start)} → ${iso(end)}, ${DAYS}d)\n`);
  console.log(`  ${'cluster'.padEnd(12)} ${'pages'.padStart(7)} ${'impr'.padStart(9)} ${'clicks'.padStart(7)} ${'CTR'.padStart(6)} ${'avgPos'.padStart(7)}`);
  console.log(`  ${'─'.repeat(52)}`);
  for (const c of order) {
    const b = clusters[c]; if (!b) continue;
    const ctr = b.impressions ? (b.clicks / b.impressions * 100).toFixed(1) + '%' : '—';
    const pos = b.impressions ? (b.posSum / b.impressions).toFixed(1) : '—';
    console.log(`  ${c.padEnd(12)} ${String(b.pages).padStart(7)} ${String(b.impressions).padStart(9)} ${String(b.clicks).padStart(7)} ${ctr.padStart(6)} ${pos.padStart(7)}`);
  }
  console.log(`  ${'─'.repeat(52)}`);
  console.log(`  ${'TOTAL'.padEnd(12)} ${String(totals.pages).padStart(7)} ${String(totals.impr).padStart(9)} ${String(totals.clicks).padStart(7)}`);
  console.log(`\n  Note: "pages" = distinct URLs with ≥1 impression in range (a proxy for indexed+surfaced).`);
  if (sitemaps.length) {
    console.log(`\n  Sitemaps:`);
    for (const s of sitemaps) {
      const sub = (s.contents || []).reduce((a, c) => a + Number(c.submitted || 0), 0);
      console.log(`    ${s.path}  submitted=${sub}  lastDownloaded=${s.lastDownloaded || '—'}  errors=${s.errors || 0}  warnings=${s.warnings || 0}`);
    }
  }
}
