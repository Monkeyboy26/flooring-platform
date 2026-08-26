#!/usr/bin/env node
/**
 * Scrape garrisoncollection.com for Garrison product photos and write
 * backend/data/garrison/images.json, keyed by internal_sku:
 *   { "GARRISON-<vendorSku>": { primary, lifestyle: [ ...roomPhotos ] } }
 *
 * Each product detail page renders:
 *   - og:image  → the main plank/product photo   → PRIMARY (per user: main photo)
 *   - a collection lifestyle banner + gallery      → room/lifestyle photos below
 *   - generic moulding icons + "related product" thumbnails → ignored
 *
 * Pages are matched to the catalog by the canonical vendor SKU printed on the
 * page (e.g. GHNPO206), so we don't rely on the site's irregular URL slugs.
 *
 * Usage: node scripts/build-garrison-images.js
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data', 'garrison');
const catalog = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'catalog.json'), 'utf8'));

// Map every plank vendor_sku → internal_sku (the images we need).
const skuToInternal = new Map();
for (const p of catalog.products) for (const s of p.skus) skuToInternal.set(s.vendor_sku, s.internal_sku);
const wantedSkus = [...skuToInternal.keys()].sort((a, b) => b.length - a.length); // longest first (avoid prefix matches)

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (res.ok) return await res.text();
      if (res.status === 404) return null;
    } catch (e) { /* retry */ }
    await sleep(600 * (i + 1));
  }
  return null;
}

const ICON_RE = /(t-moulding|reducer|nosing|baby-threshold|tread|stair-riser|stair-nose|stairnose|g-icon|logo|placeholder|sample-|swatch-icon)/i;
// Promo / placeholder images some template pages use instead of a real plank photo.
const BAD_IMG = /(70-years|old-master-products|-logo|award|badge|coming-soon|placeholder|default-|banner-default)/i;
const IMG_RE = /https:\/\/www\.garrisoncollection\.com\/wordpress\/wp-content\/uploads\/[^"'\\ )]+?\.(?:jpe?g|png|webp)/gi;
const PDF_RE = /https?:\/\/(?:www\.)?garrisoncollection\.com\/[^"'\\ )]+?\.pdf/gi;
// Product documents worth keeping, in display priority order.
const DOC_KINDS = [
  { re: /spec.?sheet/i },     // Spec Sheet
  { re: /warranty/i },        // Warranty
  { re: /care|maintenance/i },// Care & Maintenance
  { re: /install/i },         // Installation guide
];
// Generic site-wide brochures / other-product-line catalogs to ignore.
const DOC_SKIP = /(temporary-catalog|catalog-digital|main-brochure|-brochure|allora|resilient|vinyl|laminate)/i;

// Normalize a wp-content image URL to its canonical original:
// strip pagespeed suffix, leading "x" (pagespeed inliner), and -WxH size suffix.
function canonical(url) {
  let u = url.replace(/\.pagespeed\.[^/]*$/i, '');
  u = u.replace(/\/x([^/]+)$/, '/$1');           // drop pagespeed "x" filename prefix
  u = u.replace(/-\d+x\d+(?=\.\w+$)/i, '');       // drop -768x513 size suffix
  return u;
}

const ORIGIN = 'https://www.garrisoncollection.com';

async function collectProductUrls() {
  const urls = new Set();

  // 1) Sitemap (covers many, but NOT every product page).
  const seenMaps = new Set();
  async function crawlMap(mapUrl) {
    if (seenMaps.has(mapUrl)) return;
    seenMaps.add(mapUrl);
    const xml = await get(mapUrl);
    if (!xml) return;
    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/gi)].map((m) => m[1].trim().replace(/&amp;/g, '&'));
    for (const l of locs) if (/\/product\//.test(l)) urls.add(l);
    for (const l of locs) if (/\.xml($|\?)/i.test(l)) await crawlMap(l);
  }
  await crawlMap(`${ORIGIN}/sitemap.xml`);

  // 2) Crawl every collection listing page for /product/ links (the sitemap
  //    misses ~half the color pages). Discover collection pages from the
  //    hardwood category index + a guessed slug per pricelist collection.
  const collectionUrls = new Set();
  const guessSlugs = ['beverly-hills', 'carolina-classic', 'competition-buster', 'contractors-choice',
    'contractor-s-choice', 'crystal-valley', 'crystal-valley-america', 'exotics', 'garrison-ii-distressed',
    'garrison-ii-smooth', 'gold-label', 'legends', 'newport', 'private-selection'];
  for (const s of guessSlugs) collectionUrls.add(`${ORIGIN}/collection/${s}`);
  for (const idx of ['/collections/hardwood', '/collections', '/products']) {
    const h = await get(ORIGIN + idx);
    if (!h) continue;
    for (const m of h.matchAll(/\/collection\/[a-z0-9-]+/gi)) collectionUrls.add(ORIGIN + m[0]);
    for (const m of h.matchAll(/\/product\/[a-z0-9-]+/gi)) urls.add(ORIGIN + m[0]);
  }
  for (const cu of collectionUrls) {
    const h = await get(cu);
    if (!h) continue;
    for (const m of h.matchAll(/\/product\/[a-z0-9-]+/gi)) urls.add(ORIGIN + m[0]);
    await sleep(120);
  }
  return [...urls];
}

const slug = (s) => s.toLowerCase().replace(/[''.]/g, '').replace(/\([^)]*\)/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// Candidate /product/ slugs for a product whose page was NOT found by SKU. The
// site's slugs are irregular (/product/<color>, /product/european-oak-<color>,
// Exotics uses the species) and some Legends colors live on Clearance pages that
// don't carry the GFLE SKU — so we match those by color/species name instead.
function guessUrls(p) {
  const csl = slug(p.color), spl = p.species ? slug(p.species) : '', colsl = slug(p.collection);
  const bases = new Set();
  for (const b of [`european-oak-${csl}`, csl, `${spl}-${csl}`, `${colsl}-${csl}`, spl, `european-oak-${spl}`]) if (b && !b.startsWith('-')) bases.add(b);
  return [...bases].map((b) => `${ORIGIN}/product/${b}`);
}

// Does a page's title/h1 identify it as this product (by color or species name)?
function pageMatchesProduct(html, p) {
  const t = ((html.match(/<title>([^<]*)<\/title>/i) || [])[1] || '') + ' ' + ((html.match(/page-title">([^<]*)</i) || [])[1] || '');
  const hay = t.toLowerCase();
  const colorToks = slug(p.color).split('-').filter(Boolean);
  const specToks = p.species ? slug(p.species).split('-').filter(Boolean) : [];
  const allIn = (toks) => toks.length && toks.every((w) => hay.includes(w));
  return allIn(colorToks) || allIn(specToks);
}

// Parse the current product's "See It in Action" gallery from the page JSON.
// interior_images is a field on each product object (current product first), so
// the FIRST occurrence is this product's. Returns full-res top-level image URLs.
function extractInteriors(html) {
  const i = html.indexOf('"interior_images"');
  if (i < 0) return [];
  const start = html.indexOf('[', i);
  if (start < 0) return [];
  let depth = 0, k = start;
  for (; k < html.length; k++) { const c = html[k]; if (c === '[') depth++; else if (c === ']') { depth--; if (depth === 0) { k++; break; } } }
  const arr = html.slice(start, k);
  const out = [];
  for (const obj of arr.split(/\},\s*\{/)) {
    const m = obj.match(/"url":"(https:[^"]+?\.(?:jpe?g|png|webp))"/i);
    if (!m) continue;
    let u = m[1].replace(/\\\//g, '/');
    if (/-\d+x\d+\.\w+$/i.test(u)) continue;           // skip size-variant urls
    u = canonical(u);
    if (ICON_RE.test(u) || BAD_IMG.test(u) || /screen-shot/i.test(u)) continue;
    if (!out.includes(u)) out.push(u);
  }
  return out;
}

// Extract { primary, lifestyle[], documents[] } from a product page.
function extractImages(html) {
  // PRIMARY = the main plank/product photo. Templates vary in where it lives and
  // some put a "70-Years" promo in og:image while the real plank is in the gallery
  // "original" key — so pick the first NON-promo candidate among both.
  const cands = [];
  const og = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
  if (og) cands.push(canonical(og[1]));
  const orig = html.match(/"original"\s*:\s*"([^"]+)"/);
  if (orig) cands.push(canonical(orig[1].replace(/\\\//g, '/')));
  const primary = cands.find((c) => c && !BAD_IMG.test(c) && !ICON_RE.test(c)) || null;
  if (!primary) return null;   // fully promo/placeholder page → skip

  // ROOM/LIFESTYLE = the product's "See It in Action" gallery, stored in the page
  // JSON as the first "interior_images" array (a field on the current product, so
  // the FIRST occurrence is always this product's — empty for products with none,
  // never a related product's). These are the real installed/room photos.
  const lifestyle = extractInteriors(html).filter((u) => u !== primary);

  // DOCUMENTS: spec sheet / warranty / care / installation PDFs (skip generic
  // brochures & other product-line catalogs). Deduped, in DOC_KINDS priority order.
  const pdfs = [...new Set([...html.matchAll(PDF_RE)].map((x) => x[0]))].filter((u) => !DOC_SKIP.test(u));
  const documents = [];
  for (const kind of DOC_KINDS) {
    const hit = pdfs.find((u) => kind.re.test(u) && !documents.includes(u));
    if (hit) documents.push(hit);
  }
  return { primary, lifestyle, documents };
}

// Match a page to a catalog SKU (related-product carousels list OTHER colors'
// SKUs, so restrict to the main-product region before the related section).
function detectSku(html) {
  const relIdx = html.search(/id="related-products"|wrap-related-product|class="related-product/i);
  const mainRegion = relIdx > 0 ? html.slice(0, relIdx) : html;
  for (const s of wantedSkus) if (mainRegion.includes(s)) return s;
  return null;
}

// Authoritative slug overrides for products whose real page can't be found by
// SKU (Legends colors live on size-suffixed Clearance pages that don't carry the
// GFLE SKU) and whose short/species guesses would mis-hit another product.
// Slugs verified from the /collection/legends listing.
const OVERRIDES = {
  'GARRISON-GFLEO7503': 'european-oak-caffe-7-1-2',       // Caffe
  'GARRISON-GFLEO7505': 'european-oak-lugana-7-1-2',      // Lugana
  'GARRISON-GFLEO7507': 'european-oak-provence-7-1-2',    // Provence
  'GARRISON-GFLEO1002': 'european-oak-lodi-10-1-4',       // Lodi
  'GARRISON-GFLEW7501': 'natural-walnut-7-1-2',           // Walnut Natural (not the Contractor's Choice walnut)
};

async function main() {
  console.log('=== Garrison image scrape ===');
  console.log(`Need images for ${skuToInternal.size} plank SKUs across ${catalog.products.length} products.`);
  const images = {};
  const record = (internal, imgs) => { images[internal] = { primary: imgs.primary, lifestyle: imgs.lifestyle.slice(0, 6), documents: imgs.documents || [] }; };

  // ---- Pass A: SKU-matched discovered pages ----
  const productUrls = await collectProductUrls();
  console.log(`Discovered ${productUrls.length} /product/ URLs. Pass A (SKU match)...`);
  let i = 0;
  for (const url of productUrls) {
    i++;
    const html = await get(url);
    if (!html) continue;
    const sku = detectSku(html);
    if (!sku) continue;
    const imgs = extractImages(html);
    if (!imgs || !imgs.primary) continue;               // promo/placeholder page → skip
    record(skuToInternal.get(sku), imgs);
    if (i % 40 === 0) console.log(`  ...${i}/${productUrls.length} (matched ${Object.keys(images).length})`);
    await sleep(120);
  }
  console.log(`Pass A matched ${Object.keys(images).length} SKUs.`);

  // ---- Pass B: name-matched guesses for products still without a photo ----
  const productsMissing = catalog.products.filter((p) => !p.skus.some((s) => images[s.internal_sku]));
  console.log(`Pass B: ${productsMissing.length} products still need a photo...`);
  for (const p of productsMissing) {
    for (const url of guessUrls(p)) {
      const html = await get(url);
      if (!html) continue;
      if (!pageMatchesProduct(html, p)) continue;
      const imgs = extractImages(html);
      if (!imgs || !imgs.primary) continue;
      for (const s of p.skus) if (!images[s.internal_sku]) record(s.internal_sku, imgs);
      console.log(`  + [${p.collection}] ${p.name} ← ${url.split('/product/')[1]}`);
      break;
    }
    await sleep(120);
  }

  // ---- Authoritative overrides (force-set / correct specific SKUs) ----
  for (const [internal, s] of Object.entries(OVERRIDES)) {
    const html = await get(`${ORIGIN}/product/${s}`);
    if (!html) { console.log(`  ! override page missing: ${s}`); continue; }
    const imgs = extractImages(html);
    if (!imgs || !imgs.primary) { console.log(`  ! override no primary: ${s}`); continue; }
    record(internal, imgs);
    console.log(`  = override ${internal} ← ${s}`);
    await sleep(120);
  }

  fs.writeFileSync(path.join(DATA_DIR, 'images.json'), JSON.stringify(images, null, 2));
  const withLife = Object.values(images).filter((v) => v.lifestyle.length).length;
  const missing = [...skuToInternal.values()].filter((v) => !images[v]);
  const prodMissing = catalog.products.filter((p) => !p.skus.some((s) => images[s.internal_sku]));
  console.log(`\nTotal: ${Object.keys(images).length} SKUs with a photo (${withLife} with room photos).`);
  console.log(`Plank SKUs with NO photo: ${missing.length}; PRODUCTS with no photo at all: ${prodMissing.length}`);
  if (prodMissing.length) console.log('  ' + prodMissing.map((p) => `${p.collection}/${p.name}`).join(', '));
  console.log(`Wrote ${path.join(DATA_DIR, 'images.json')}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
