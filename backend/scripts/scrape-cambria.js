// Cambria scraper — pulls the ENTIRE quartz design catalog from Cambria's public
// Algolia index in a single request (no Puppeteer, no HTML scraping needed).
//
// The cambriausa.com listing pages are JS-rendered AEM, but the site's own
// front-end reads from a public read-only Algolia index that returns all 155
// designs with full structured data + Scene7 image field values. Images are on
// Adobe Scene7, deterministic per design slug.
//
// Output: data/cambria/algolia.json (raw hits — the scraped source of truth)
// Usage:  node scripts/scrape-cambria.js
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', 'data', 'cambria', 'algolia.json');

// Public, read-only Algolia credentials embedded in cambriausa.com's front-end.
const ALGOLIA = {
  appId: 'IRUPI58XNA',
  apiKey: '745df580b5ecbbba3dbf8c96ba93eb44',
  index: 'cusa-en-design-palette',
};

(async () => {
  const url = `https://${ALGOLIA.appId}-dsn.algolia.net/1/indexes/${ALGOLIA.index}/query`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'X-Algolia-Application-Id': ALGOLIA.appId,
      'X-Algolia-API-Key': ALGOLIA.apiKey,
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    },
    body: JSON.stringify({ query: '', hitsPerPage: 1000, page: 0 }),
  });
  if (!resp.ok) throw new Error(`Algolia ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(data, null, 2));
  console.log(`Cambria: fetched ${data.hits.length}/${data.nbHits} designs → ${OUT}`);
  if (data.hits.length < data.nbHits) console.warn(`! only got ${data.hits.length} of ${data.nbHits} — bump hitsPerPage/paginate`);
})().catch((e) => { console.error('SCRAPE ERROR:', e.message); process.exit(1); });
