// PentalQuartz scraper — plain HTTP fetch + HTML parse (no Puppeteer; site has no
// anti-bot beyond a UA check). PentalQuartz is now distributed by Architectural
// Surfaces Group (arcsurfaces.com; pentalquartz.com 301s there).
//
// Enumerates the 32 current quartz colors from pq-sitemap.xml, then parses each
// color page for the embedded per-product JSON blob (sku/finish/color-family/features),
// og:image (primary swatch), collection, slab size, description, and the DigitalOcean
// "materialmatrix" jumbo inventory-slab photos.
//
// Output: data/pental/scraped.json
// Usage:  node scripts/scrape-pental.js
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', 'data', 'pental', 'scraped.json');
const SITEMAP = 'https://arcsurfaces.com/pq-sitemap.xml';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const CONCURRENCY = 4;

async function get(url) {
  const resp = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30000) });
  if (!resp.ok) throw new Error(`${resp.status} ${url}`);
  return resp.text();
}

const m1 = (h, re) => { const m = h.match(re); return m ? m[1].trim() : null; };
const decode = (s) => (s || '').replace(/&amp;/g, '&').replace(/&#8217;|&#039;|&rsquo;/g, "'")
  .replace(/&#8211;|&#8212;/g, '-').replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&[a-z]+;/gi, ' ').trim();

function parseColor(url, h) {
  // Per-product JSON blob (single-quoted data attribute) — pick the one for THIS page.
  const slug = url.replace(/\/$/, '').split('/').pop();
  const blobs = [...h.matchAll(/='(\{[^']*"sku":"PQ\d+[^']*\})'/g)]
    .map((m) => { try { return JSON.parse(m[1]); } catch { return null; } }).filter(Boolean);
  const blob = blobs.find((b) => (b.url || '').includes(`/${slug}/`)) || blobs[0] || {};
  const tags = {};
  for (const t of (blob.filter_tags || [])) tags[t.key] = t.terms || [];

  const name = decode(m1(h, /<h1[^>]*>([^<]+)<\/h1>/i)) || blob.name || null;
  const og = m1(h, /<meta property="og:image" content="([^"]+)"/i);
  // Strip WordPress "-1440x700" sized-variant suffix → full-resolution original.
  const fullres = (u) => u ? u.replace(/-\d+x\d+(\.[a-z]+)(\?|$)/i, '$1$2') : null;
  // Prefer the per-product swatch render (blob.slab) — og:image occasionally points
  // at a "-2" lifestyle variant. Fall back to blob.image, then og.
  const primary = fullres(blob.slab) || fullres(blob.image) || fullres(og);
  const ogFull = fullres(og);
  const description = decode(m1(h, /<meta property="og:description" content="([^"]*)"/i));
  const collectionSlug = m1(h, /\/quartz\/pentalquartz\/collection\/([^"'\/]+)\/?["']/i);
  const collection = collectionSlug
    ? collectionSlug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
    : null;
  const plain = h.replace(/<[^>]+>/g, ' ');
  const size = m1(plain, /Size\s*:?\s*(\d{2,3}\s*[xX]\s*\d{2,3})/);
  const jumbo = [...new Set((h.match(/https:\/\/materialmatrix\.nyc3\.digitaloceanspaces\.com\/images\/bundle\/\d+\/slab\.jpg/gi) || []))];

  return {
    slug, url, name,
    sku: blob.sku || null,
    collection,
    finish: (tags.finish || []).map((f) => f.replace(/\b\w/g, (c) => c.toUpperCase())),
    colorFamily: tags.color || [],
    features: tags.features || [],
    size: size ? size.replace(/\s+/g, '') : null,
    description,
    primary,
    // og hero, kept as a lifestyle extra only when it differs from the swatch primary
    lifestyle: (ogFull && ogFull !== primary) ? [ogFull] : [],
    jumbo,
  };
}

async function runPool(items, worker, concurrency) {
  const results = new Array(items.length);
  let idx = 0;
  async function next() {
    while (idx < items.length) {
      const cur = idx++;
      try { results[cur] = await worker(items[cur]); }
      catch (e) { results[cur] = { error: e.message, url: items[cur] }; }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, next));
  return results;
}

(async () => {
  const sm = await get(SITEMAP);
  const urls = [...new Set((sm.match(/https:\/\/arcsurfaces\.com\/quartz\/pentalquartz\/[^<\s]+/g) || [])
    .map((u) => u.replace(/<.*$/, '')))]
    .filter((u) => !/\/collection\//.test(u) && !/\/pentalquartz\/?$/.test(u));
  console.log(`Pental: ${urls.length} color URLs from sitemap`);

  const recs = await runPool(urls, async (u) => parseColor(u, await get(u)), CONCURRENCY);
  const good = recs.filter((r) => r && r.name && !r.error);
  const bad = recs.filter((r) => !r || r.error || !r.name);

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(good, null, 2));
  console.log(`Scraped ${good.length}/${urls.length}` + (bad.length ? `  (${bad.length} failed: ${bad.map((b) => b.url || '?').join(', ')})` : ''));
  const noImg = good.filter((r) => !r.primary).length, noSku = good.filter((r) => !r.sku).length;
  console.log(`  missing primary: ${noImg} | missing sku: ${noSku} → ${OUT}`);
})().catch((e) => { console.error('SCRAPE ERROR:', e); process.exit(1); });
