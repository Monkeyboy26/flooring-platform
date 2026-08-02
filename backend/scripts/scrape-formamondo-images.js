#!/usr/bin/env node
/**
 * Scrape per-color / per-finish tile photos + lifestyle room scenes from formamondo.com
 * (WordPress) and match them to the built catalog.json, emitting data/formamondo/images.json.
 *
 * Each collection page carries manufacturer press shots whose filenames encode the collection,
 * finish and COLOR (conventions differ per manufacturer: Elysian ELS/ELQ, Emilceramica CLAY,
 * Atlas Concorde AU/AX, etc.). We match swatches to catalog colors by a normalized token test
 * (longest color first so "White Everest" wins over a bare "White"), pick the largest resolvable
 * variant, attach finish-specific swatches to their SKU, and gather room scenes as alternates.
 *
 * Output shape (consumed by import-formamondo.js), keyed by product pkey:
 *   { "FMO-<slug>-<color>": { product:{primary,alternates:[]}, skus:{ "<suffix>":{primary} } } }
 *
 * Usage: node scripts/build-formamondo-catalog.js && node scripts/scrape-formamondo-images.js
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(__dirname, '..', 'data', 'formamondo');
const catalog = JSON.parse(fs.readFileSync(path.join(DIR, 'catalog.json'), 'utf8'));
const UA = { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' };
const BASE = 'https://formamondo.com';

const norm = (s) => String(s).replace(/%20/gi, '').replace(/\b20\b/g, '')
  .replace(/[^a-z0-9]/gi, '').toUpperCase();
const ROOM = /(living|kitchen|bagno|bath|bagn|bed|camera|ambiente|\bamb\b|outdoor|studio|restaurant|still|room|scene|interior|office|lobby|shower|hotel|spa|part-amb|detail)/i;
const SIZE_TOK = /(60x120|80x80|120x120|120x278|60x60|160x160|30x60|120x240|278)/i;

// finish -> filename tokens (best-effort; color is the primary key)
const FINISH_TOK = {
  'Natural': ['NOBILE', 'NATURAL', 'NATURALE'], 'Ligne': ['LIGNE'],
  'Neutra R10': ['R10'], 'Neutra R11': ['R11'], 'Sassi': ['SASSI'], 'Ritmo': ['RITMO'],
  'Matte': ['MATT', 'MATTE', 'MATOPACO'], 'Polished': ['POLISHED', 'LUCIDATO', 'LAPP'],
  'Silk Matte': ['SILK'], 'Vein Cut': ['VEINCUT', 'VEIN', 'VENA'], 'Cross Cut': ['CROSSCUT', 'CROSS', 'CONTRO'],
  'Plain': ['PLAIN', 'NATURALE'], 'Linear': ['LINEAR', 'LINEARE', 'RIGATO'], 'Linear 3D Lux': ['3D', 'LUX'],
  'Strip': ['STRIP', 'RIGATO', 'RIGA'], 'Field Tile': [], 'Rubik': ['RUBIK'], 'Mix': ['MIX', 'DEK', 'DECOR'],
};
// finishes that represent the "plain" tile face — preferred for the color's product primary
const BASE_FINISH = new Set(['Natural', 'Matte', 'Plain', 'Field Tile', 'Silk Matte', 'Neutra R10', 'Vein Cut']);
// color name aliases (site misspellings / short forms), normalized
const COLOR_ALIAS = { Mushroom: ['MASHROOM'], Light: ['LIGHT'], Gris: ['GRIS', 'GREY', 'GRIGIO'] };
const colorTokens = (color) => [norm(color), ...(COLOR_ALIAS[color] || [])];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const _headCache = new Map();
async function headOk(url) {
  if (_headCache.has(url)) return _headCache.get(url);
  let ok = false;
  try {
    let res = await fetch(url, { method: 'HEAD', headers: UA });
    if (res.status === 405) res = await fetch(url, { method: 'GET', headers: UA });
    ok = res.ok && /image\//.test(res.headers.get('content-type') || '');
  } catch { ok = false; }
  _headCache.set(url, ok);
  await sleep(120); // be gentle — the host throttles bursts of requests
  return ok;
}

// group HTML image refs by base name; return best resolvable URL per base
function groupAssets(urls) {
  const groups = new Map(); // base -> [{url, w, dimensioned}]
  for (const u of urls) {
    const file = u.split('/').pop();
    // parse dimensions from -WxH.ext OR .WxH_qN_crop.webp OR -WxH-cN...
    let w = 0, dimensioned = false;
    let m = file.match(/[.-](\d{2,4})x(\d{2,4})(?:_q\d+_crop)?\.(webp|jpe?g|png|avif)$/i);
    if (m) { w = +m[1]; dimensioned = true; }
    // base = strip the size/crop suffix and any -WxH
    const base = u
      .replace(/\.(\d{2,4})x(\d{2,4})_q\d+_crop\.webp$/i, '')
      .replace(/-(\d{2,4})x(\d{2,4})\.(webp|jpe?g|png|avif)$/i, (mm, a, b, e) => `.${e}`);
    if (!groups.has(base)) groups.set(base, []);
    groups.get(base).push({ url: u, w: dimensioned ? w : 3000, dimensioned });
  }
  return groups;
}

// Zero HEAD round-trips (the host throttles bursts): every candidate here is already referenced
// in the page HTML, so it is served. WP sized variants -> largest (<=2048); dimensionless .webp
// originals -> as-is; Elysian/Emilceramica press-shot .jpg/.avif bases 404 on their own and are
// only served as the plugin's `<base>.250x250_q75_crop.webp` thumbnail (confirmed for this site).
// manufacturer press swatches (Elysian ELS/ELQ, Emilceramica EN, Atlas AU/AX, ...) whose bare
// base 404s and are ONLY served as the plugin's `<base>.250x250_q75_crop.webp` thumbnail. Regular
// WP originals (formamondo-*, *-scaled.jpeg, Mapierre-N.webp) resolve at their base URL directly.
const PRESS = /(^[A-Z]{2}[A-Z0-9]{2}_)|_(60x120|80x80|120x120|120x278|60x60|160x160)_/;
function bestUrl(base, variants) {
  const dim = variants.filter((v) => v.dimensioned).sort((a, b) => b.w - a.w);
  if (dim.length) return (dim.find((v) => v.w <= 2048) || dim[dim.length - 1]).url;
  const file = base.split('/').pop();
  if (/\.(jpe?g|avif|png)$/i.test(base) && PRESS.test(file)) return `${base}.250x250_q75_crop.webp`;
  return variants[0].url;
}

async function fetchText(url, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: UA });
      if (res.ok) { const t = await res.text(); if (t && t.length > 500) return t; }
    } catch { /* retry */ }
    await sleep(800 * (i + 1));
  }
  throw new Error(`fetch failed: ${url}`);
}

async function collectionPage(slug) {
  const html = await fetchText(`${BASE}/collection/${slug}/`);
  const urls = [...new Set(
    [...html.matchAll(/https:\/\/formamondo\.com\/wp-content\/uploads\/20\d\d\/\d\d\/[^"'()\s\\]+?\.(?:webp|jpe?g|png|avif)/gi)]
      .map((m) => m[0])
  )].filter((u) => !/logo|favicon|White-on-transparent|Ceramics-of-italy|Ceramics-of|tile-of-spain|tile-of-italy|placeholder|[-_]load\d|[-_]load[-.]|[-_]loader|spinner|-icon|FF-\d|\/[0-9a-f]{32}[-.]/i.test(u));
  return groupAssets(urls);
}

async function run() {
  const bySlug = {};
  for (const p of catalog.products) (bySlug[p.collectionSlug] ||= []).push(p);
  const images = {};
  let nPrimary = 0, nFinish = 0, nAlt = 0, missing = [], sharedHero = [];

  for (const [slug, prods] of Object.entries(bySlug)) {
    const groups = await collectionPage(slug);
    // resolve best url per base, classify swatch vs lifestyle
    const swatches = [];  // {base,url,nrm}
    const scenes = [];    // {base,url,nrm}
    for (const [base, variants] of groups) {
      const file = base.split('/').pop();
      const url = await bestUrl(base, variants);
      if (!url) continue;
      const entry = { base, url, nrm: norm(file), file };
      if (ROOM.test(file)) scenes.push(entry);
      else if (SIZE_TOK.test(file)) swatches.push(entry);
      else scenes.push(entry); // hero / uncategorized -> alternate pool
    }

    const colors = prods.map((p) => p.color).sort((a, b) => norm(b).length - norm(a).length);
    const hasTok = (nrm, color) => colorTokens(color).some((t) => nrm.includes(t));
    const claimed = new Set();
    for (const p of prods) {
      // swatches matching this color, not already claimed, and not better-matched by a longer color
      const mine = swatches.filter((s) => hasTok(s.nrm, p.color) && !claimed.has(s.url) &&
        !colors.some((oc) => norm(oc).length > norm(p.color).length && hasTok(s.nrm, oc)));
      mine.forEach((s) => claimed.add(s.url));

      const rec = { product: { primary: null, alternates: [] }, skus: {} };
      // finish-specific swatch per SKU
      for (const sku of p.skus) {
        const toks = FINISH_TOK[sku.finish] || [];
        const hit = mine.find((s) => toks.some((t) => s.nrm.includes(t)));
        if (hit) { rec.skus[sku.suffix] = { primary: hit.url }; nFinish++; }
      }
      // product primary: prefer a base-finish swatch, else a plain (no decor) one, else first
      let primary = null;
      for (const sku of p.skus) {
        if (BASE_FINISH.has(sku.finish) && rec.skus[sku.suffix]?.primary) { primary = rec.skus[sku.suffix].primary; break; }
      }
      if (!primary && mine.length) {
        // pick the shortest filename (usually the plain face, fewest decor tokens)
        primary = [...mine].sort((a, b) => a.file.length - b.file.length)[0].url;
      }
      // color-named lifestyle scenes for this color, then generic collection scenes
      const colScenes = scenes.filter((s) => hasTok(s.nrm, p.color)).map((s) => s.url);
      if (!primary && colScenes.length) primary = colScenes[0];
      // last resort: a generic collection lifestyle scene (shared) so every color has a hero
      if (!primary && scenes.length) { primary = scenes[0].url; p._sharedHero = true; }
      if (primary) { rec.product.primary = primary; nPrimary++; if (p._sharedHero) sharedHero.push(p.pkey); }
      else missing.push(p.pkey);

      const alts = [...new Set([...colScenes, ...scenes.slice(0, 3).map((s) => s.url)])]
        .filter((u) => u !== primary).slice(0, 4);
      rec.product.alternates = alts; nAlt += alts.length;
      images[p.pkey] = rec;
    }
    console.log(`  ${slug.padEnd(20)} swatches:${String(swatches.length).padStart(2)} scenes:${String(scenes.length).padStart(2)} colors:${prods.length}`);
    await sleep(500);
  }

  fs.writeFileSync(path.join(DIR, 'images.json'), JSON.stringify(images, null, 2));
  console.log(`\nimages.json: ${nPrimary}/${catalog.products.length} products with a primary, ` +
    `${nFinish} finish-specific SKU photos, ${nAlt} lifestyle alternates`);
  if (sharedHero.length) console.log(`Shared collection hero (no per-color web swatch): ${sharedHero.length} — ${sharedHero.join(', ')}`);
  if (missing.length) console.log('No image at all:', missing.join(', '));
}
run().catch((e) => { console.error(e); process.exit(1); });
