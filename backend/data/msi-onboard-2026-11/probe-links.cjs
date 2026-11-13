// Probe MSI Web Links for liveness + og:image. Dedupes URLs, concurrency 6.
const fs = require('fs');
const reactivate = require('./msi-reactivate.json');
const create = require('./msi-create.json');

const urls = new Set();
for (const r of [...reactivate, ...create]) {
  const link = String(r['Web Link'] || '').trim();
  if (link.startsWith('http')) urls.add(link);
}
const list = [...urls];
console.log(`Unique URLs to probe: ${list.length}`);

const results = {};
let done = 0;

async function probe(url) {
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36' },
      signal: AbortSignal.timeout(20000),
    });
    const finalUrl = res.url;
    let ogImage = null, title = null;
    if (res.ok) {
      const html = await res.text();
      ogImage = (html.match(/property="og:image"\s+content="([^"]+)"/) || html.match(/content="([^"]+)"\s+property="og:image"/) || [])[1] || null;
      title = (html.match(/<title>([^<]*)<\/title>/) || [])[1] || null;
      // MSI soft-404: redirected to homepage or a category root
      const soft404 = finalUrl.replace(/\/$/, '') === 'https://www.msisurfaces.com'
        || /page-not-found|404/i.test(finalUrl) || /page not found/i.test(title || '');
      results[url] = { ok: !soft404, status: res.status, finalUrl, ogImage, title };
    } else {
      results[url] = { ok: false, status: res.status, finalUrl };
    }
  } catch (e) {
    results[url] = { ok: false, error: e.message };
  }
  done++;
  if (done % 40 === 0) console.log(`  ${done}/${list.length}`);
}

(async () => {
  const CONC = 6;
  let i = 0;
  async function worker() {
    while (i < list.length) {
      const url = list[i++];
      await probe(url);
      await new Promise(r => setTimeout(r, 150));
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));
  const live = Object.values(results).filter(r => r.ok).length;
  const dead = list.length - live;
  console.log(`\nLive: ${live}, Dead/failed: ${dead}`);
  Object.entries(results).filter(([,r]) => !r.ok).slice(0, 25).forEach(([u, r]) =>
    console.log(`  DEAD ${r.status || r.error} ${u} -> ${r.finalUrl || ''}`));
  fs.writeFileSync(__dirname + '/link-probe-results.json', JSON.stringify(results, null, 1));
})();
