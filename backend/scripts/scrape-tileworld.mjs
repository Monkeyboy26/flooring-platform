#!/usr/bin/env node
/**
 * Scrape tileworldusa.com for product photos + color/surface facets.
 *
 * The site lists products by size at /size/<slug>, but the cards are AJAX-loaded
 * from POST https://tileworldusa.com/load_ajax_size.php (params: start, limit,
 * sizeid, sizeslug, sizename, surface, color, space, total_pages, col_view). We
 * paginate each size until a page returns no cards, collect every card
 * (size_slug, slug, name, thumbnail img, detail url), then fetch each product's
 * detail page to read its spec meta ("Color: <span>…", "Surface look: <span>…",
 * "Format", "Space", "Type").
 *
 * Only 7 sizes have site pages (12x24, 12x36, 24x24, 24x48, 6x36, 8x24, 8x55) —
 * the sheet's 8x48 / 32x32 / 36x36 / 48x48 have none, but those designs usually
 * also appear in a scraped size and match by base name in the catalog builder.
 *
 * OUTPUT: backend/data/tileworld/site-products.json (listing) and
 *   site-details.json (listing + meta). build-tileworld-catalog.js reads the latter.
 *
 * Usage: node scripts/scrape-tileworld.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(__dirname, '..', 'data', 'tileworld');
const BASE = 'https://tileworldusa.com';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

const SIZES = {
  '12-x-24-in': { id: 1, name: '12 x 24 in' },
  '24-x-24-in': { id: 2, name: '24 x 24 in' },
  '8-x-24-in':  { id: 3, name: '8 x 24 in' },
  '6-x-36-in':  { id: 4, name: '6 x 36 in' },
  '12-x-36-in': { id: 5, name: '12 x 36 in' },
  '24-x-48-in': { id: 7, name: '24 x 48 in' },
  '8-x-55-in':  { id: 8, name: '8 x 55 in' },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(sizeslug, sizeid, sizename, start) {
  const body = new URLSearchParams({
    start: String(start), limit: '12', sizeid: String(sizeid), sizename,
    surface: '', sizeslug, color: '', total_pages: '9999', col_view: '3', space: '',
  });
  const res = await fetch(`${BASE}/load_ajax_size.php`, {
    method: 'POST', headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' }, body,
  });
  if (!res.ok) throw new Error(`ajax ${res.status}`);
  return res.text();
}

// card: image link → <img src alt>
const CARD_RE = /product-details\/([^/"]+)\/([^"]+)"\s+class="p-block-link">\s*<img\s+src="([^"]+)"[^>]*alt="([^"]*)"/g;

function parseCards(html, sizeslug) {
  const out = [];
  let m; CARD_RE.lastIndex = 0;
  while ((m = CARD_RE.exec(html)) !== null) {
    out.push({ size_slug: m[1] || sizeslug, slug: m[2], img: m[3], name: m[4].trim() });
  }
  return out;
}

function parseMeta(html) {
  const meta = {};
  for (const label of ['Color', 'Surface look', 'Format', 'Space', 'Product Type', 'Type']) {
    const re = new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*:\\s*<span[^>]*>\\s*([^<]+)', 'i');
    const m = re.exec(html);
    if (m) meta[label === 'Product Type' ? 'Type' : label] = m[1].trim();
  }
  return meta;
}

async function main() {
  console.log('=== Scrape Tile World (tileworldusa.com) ===\n');
  const products = [];   // {size_slug, slug, name, img}
  const seen = new Set();

  for (const [slug, { id, name }] of Object.entries(SIZES)) {
    let start = 0, got = 0;
    for (;;) {
      const html = await post(slug, id, name, start);
      const cards = parseCards(html, slug);
      if (!cards.length) break;
      for (const c of cards) {
        const key = `${c.size_slug}||${c.slug}`;
        if (seen.has(key)) continue;
        seen.add(key); products.push(c); got++;
      }
      start++;
      await sleep(150);
      if (start > 100) break;   // safety
    }
    console.log(`  ${slug}: ${got} products`);
  }
  console.log(`\nListing total: ${products.length} products`);
  fs.writeFileSync(path.join(DIR, 'site-products.json'), JSON.stringify(products, null, 1));

  // detail pages → meta
  console.log('\nFetching detail pages for color/surface meta...');
  const details = {};
  let n = 0, withColor = 0;
  for (const p of products) {
    try {
      const res = await fetch(`${BASE}/product-details/${p.size_slug}/${p.slug}`, { headers: { 'User-Agent': UA } });
      const meta = res.ok ? parseMeta(await res.text()) : {};
      if (meta.Color) withColor++;
      details[`${p.size_slug}||${p.slug}`] = { ...p, meta };
    } catch {
      details[`${p.size_slug}||${p.slug}`] = { ...p, meta: {} };
    }
    if (++n % 25 === 0) { console.log(`  ...${n}/${products.length}`); }
    await sleep(120);
  }
  fs.writeFileSync(path.join(DIR, 'site-details.json'), JSON.stringify(details, null, 1));
  console.log(`\nWrote site-products.json (${products.length}) + site-details.json (${withColor} with color).`);
}
main().catch((e) => { console.error(e); process.exit(1); });
