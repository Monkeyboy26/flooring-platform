// Cosentino scraper — enumerates every color across all 5 US brands and captures
// structured product data + deterministic Bynder image URLs.
//
// The site sits behind Sucuri CloudProxy (JS challenge) — plain fetch gets a 307,
// so we drive a real Chrome via Puppeteer (base.js launchBrowser). The challenge
// cookie clears on first navigation and persists for the browser session.
//
// Output: data/cosentino/scraped.json  (raw per-color records, one array per brand)
//
// Usage: node scripts/scrape-cosentino.js [brand]   (brand optional: silestone|dekton|sensa|scalea|eclos)
import { launchBrowser, delay } from '../scrapers/base.js';
import fs from 'fs';
import path from 'path';

const BASE = 'https://www.cosentino.com/usa/colors';
const BRANDS = ['silestone', 'dekton', 'sensa', 'scalea', 'eclos'];
const OUT = path.join('data', 'cosentino', 'scraped.json');
const CONCURRENCY = 3;

async function newPage(browser) {
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
  await page.setViewport({ width: 1440, height: 900 });
  // Block heavy assets we don't need — keeps 218 page loads fast. Images are
  // reconstructed from URLs in the DOM, not from the rendered pixels.
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const t = req.resourceType();
    if (t === 'image' || t === 'media' || t === 'font') return req.abort();
    req.continue();
  });
  return page;
}

async function gotoResilient(page, url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
      await delay(800);
      const title = await page.title();
      if (/just a moment|sucuri|access denied|attention required/i.test(title)) {
        await delay(4000);
        await page.reload({ waitUntil: 'networkidle2', timeout: 60000 });
        await delay(1500);
      }
      return true;
    } catch (e) {
      if (i === tries - 1) throw e;
      await delay(2000 + i * 2000);
    }
  }
}

// Enumerate all color detail hrefs for one brand from its listing page.
async function collectColorLinks(page, brand) {
  await gotoResilient(page, `${BASE}/${brand}/`);
  return page.evaluate((brandSlug) => {
    const seen = new Set(); const rows = [];
    const re = new RegExp(`/colors/${brandSlug}/([^/?#]+)/?$`);
    for (const a of document.querySelectorAll('a[href*="/colors/"]')) {
      const href = a.href.split('?')[0].split('#')[0];
      const m = href.match(re);
      if (!m) continue;
      if (seen.has(href)) continue; seen.add(href);
      rows.push({ href, slug: m[1] });
    }
    return rows;
  }, brand);
}

// Extract structured data from a single color detail page.
async function scrapeColor(page, brand, href) {
  await gotoResilient(page, href);
  const rec = await page.evaluate((brandSlug) => {
    const attr = (sel, a) => { const el = document.querySelector(sel); return el ? el.getAttribute(a) : null; };
    const q = (sel) => { const el = document.querySelector(sel); return el ? el.textContent.trim() : null; };

    const name = q('h1');

    // "SILESTONE - SUMA" line lives near the top; find the first BRAND - SERIES line.
    const bodyText = document.body.innerText || '';
    const lines = bodyText.split('\n').map(s => s.trim()).filter(Boolean);
    let series = null;
    const brandUpper = brandSlug.toUpperCase();
    for (const ln of lines) {
      const m = ln.match(/^([A-Z][A-Za-zÀ-ÿ'®]+)\s*[-–]\s*(.+)$/);
      if (m && m[1].toUpperCase().replace('®', '') === brandUpper) { series = m[2].trim(); break; }
    }

    // Section slicer: grab text between a heading and the next known heading.
    const HEADS = ['DESCRIPTION:', 'DESCRIPTION', 'TECHNOLOGY', 'CERTIFICATES',
      'FINISHES AVAILABLE', 'THICKNESSES', 'FORMAT', 'PROFESSIONAL RESOURCES',
      'DETAILED VIEW', 'PROJECTS USING', 'SIMILAR COLORS', 'WHERE TO BUY'];
    function section(startHead) {
      const iStart = lines.findIndex(l => l.toUpperCase().startsWith(startHead));
      if (iStart < 0) return [];
      const out = [];
      for (let i = iStart + 1; i < lines.length; i++) {
        const up = lines[i].toUpperCase();
        if (HEADS.some(h => up === h || up.startsWith(h))) break;
        out.push(lines[i]);
      }
      return out;
    }

    const descLines = section('DESCRIPTION');
    const description = descLines.join(' ').trim() || null;

    // Finishes: ALL-CAPS lines in the FINISHES block are the finish names;
    // sentence-case lines are marketing blurbs.
    const finishes = section('FINISHES AVAILABLE')
      .filter(l => l === l.toUpperCase() && /^[A-Z][A-Z\s+&/-]{2,24}$/.test(l))
      .map(l => l.replace(/\s+/g, ' ').trim());

    // Thicknesses: lines like "2,0 cm" / "1.2 cm" / "0.8 cm"
    const thicknesses = section('THICKNESSES')
      .filter(l => /^\d+([.,]\d+)?\s*cm$/i.test(l))
      .map(l => l.replace(',', '.').replace(/\s+/g, ' ').trim());

    // Format: "128.74 x 62.60 in" (may be multiple)
    const formats = section('FORMAT')
      .filter(l => /\d+(\.\d+)?\s*[xX×]\s*\d+(\.\d+)?\s*(in|cm)/i.test(l))
      .map(l => l.replace(/\s+/g, ' ').trim());

    // Color code + images from the principal slab render.
    const principal = attr('img.img-principal', 'src') || attr('img.img-principal', 'data-src') || '';
    const og = attr('meta[property="og:image"]', 'content') || '';
    const codeMatch = (principal + ' ' + og).match(/\/color\/([A-Z0-9]{2,6})\//);
    const code = codeMatch ? codeMatch[1] : null;

    // Lifestyle: GUID-based image URLs on the page (room scenes). Keep raw; we
    // filter to this color's slug in the build step to drop "similar colors".
    const lifestyle = [...new Set([...document.querySelectorAll('img, source')]
      .map(e => e.currentSrc || e.getAttribute('src') || e.getAttribute('data-src') || '')
      .filter(u => /assetstools\.cosentino\.com\/api\/v1\/bynder\/image\//.test(u))
      .map(u => u.split('?')[0]))];

    return { name, series, description, finishes, thicknesses, formats, code, principal, og, lifestyle };
  }, brand);
  return { brand, href, ...rec };
}

async function runPool(items, worker, concurrency) {
  const results = new Array(items.length);
  let idx = 0;
  async function next(runner) {
    while (idx < items.length) {
      const cur = idx++;
      try { results[cur] = await worker(items[cur], runner); }
      catch (e) { results[cur] = { error: e.message, item: items[cur] }; }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, (_, i) => next(i)));
  return results;
}

(async () => {
  const only = process.argv[2] ? [process.argv[2].toLowerCase()] : BRANDS;
  const browser = await launchBrowser();
  const data = {};
  try {
    // Warm the Sucuri cookie once with a dedicated page.
    const warm = await newPage(browser);
    await gotoResilient(warm, `${BASE}/`);
    await warm.close();

    // Pre-open a small pool of pages for detail scraping.
    const pages = [];
    for (let i = 0; i < CONCURRENCY; i++) pages.push(await newPage(browser));

    for (const brand of only) {
      const listPage = pages[0];
      const links = await collectColorLinks(listPage, brand);
      console.log(`[${brand}] ${links.length} colors`);
      const recs = await runPool(links, (link, runner) => scrapeColor(pages[runner], brand, link.href), CONCURRENCY);
      const good = recs.filter(r => r && r.name && !r.error);
      const bad = recs.filter(r => !r || r.error || !r.name);
      data[brand] = good;
      console.log(`[${brand}] scraped ${good.length}/${links.length}` + (bad.length ? `  (${bad.length} failed)` : ''));
      if (bad.length) console.log(`[${brand}] failures:`, bad.map(b => (b && (b.href || (b.item && b.item.href))) || '?').slice(0, 10));
      // Write incrementally so a mid-run crash still yields partial data.
      fs.writeFileSync(OUT, JSON.stringify(data, null, 2));
    }

    const total = Object.values(data).reduce((n, a) => n + a.length, 0);
    console.log(`\nDONE — ${total} colors across ${only.length} brand(s) → ${OUT}`);
  } catch (e) {
    console.error('SCRAPE ERROR:', e);
    fs.writeFileSync(OUT, JSON.stringify(data, null, 2));
  } finally {
    await browser.close();
  }
})();
