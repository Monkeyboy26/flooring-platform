// Fetch each create-item page and extract product image candidates from cdn.msisurfaces.com.
const fs = require('fs');
const create = require('./msi-create.json');

const JUNK = /flyers|inspiration|miscellaneous|warning|prop65|cpsc|logo|icon|banner|header|footer|social|visualizer|room-scene-thumb/i;

const urls = [...new Set(create.map(r => String(r['Web Link'] || '').trim()).filter(u => u.startsWith('http')))];
console.log(`Fetching ${urls.length} pages...`);

const out = {};
let done = 0;

async function grab(url) {
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36' },
      signal: AbortSignal.timeout(25000),
    });
    if (!res.ok) { out[url] = { error: 'http ' + res.status }; return; }
    const html = await res.text();
    const all = [...new Set((html.match(/https?:\/\/cdn\.msisurfaces\.com\/[^"'\s)]+\.(?:jpg|jpeg|png|webp)/gi) || []))]
      .filter(u => !JUNK.test(u));
    const primary = all.find(u => !/\/angle\/|\/fulldetail\/|\/thumbnails?\/|-angle\.|-fulldetail\./i.test(u)) || all[0] || null;
    const alts = all.filter(u => u !== primary && !/\/thumbnails?\//i.test(u)).slice(0, 2);
    out[url] = { primary, alts, candidates: all.length };
  } catch (e) {
    out[url] = { error: e.message };
  } finally {
    done++;
    if (done % 20 === 0) console.log(`  ${done}/${urls.length}`);
  }
}

(async () => {
  const CONC = 5;
  let i = 0;
  async function worker() {
    while (i < urls.length) { const u = urls[i++]; await grab(u); await new Promise(r => setTimeout(r, 200)); }
  }
  await Promise.all(Array.from({ length: CONC }, worker));
  const withImg = Object.values(out).filter(r => r.primary).length;
  console.log(`\nPages with a primary image: ${withImg}/${urls.length}`);
  Object.entries(out).filter(([,r]) => !r.primary).slice(0, 15).forEach(([u, r]) => console.log(`  NO-IMG ${u} ${r.error || ''}`));
  fs.writeFileSync(__dirname + '/create-images.json', JSON.stringify(out, null, 1));
})();
