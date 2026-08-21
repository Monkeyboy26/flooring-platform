#!/usr/bin/env node
/**
 * Build backend/data/pacifico/images.json for the Pacifico Grande import.
 *
 * jcflooringdirect.com / southwestflooringdirect.com (open WooCommerce Store API)
 * carry the full Pacifico Grande collection as ONE product whose ~30 gallery
 * images embed the EXACT vendor SKU code, e.g. `Andes-Summit-VCG10AS.avif` and
 * its room scene `Andes-Summit-VCG10AS-.avif`. That `VCG10AS` = our vendor_sku
 * minus the `HFD` prefix (HFDVCG10AS), so we match per-SKU:
 *   VCG10AS → HFDVCG10AS → TW-HFDVCG10AS.
 *   base filename → primary (plank swatch);  trailing `-`/`-N` → lifestyle.
 *
 * All 10 colors are published. Output keyed by internal_sku:
 *   { "TW-HFDVCG10AS": { primary, lifestyle } }.  Consumed by import-pacifico.js.
 *
 * Usage: node scripts/build-pacifico-images.js
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, '..', 'data', 'pacifico');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)';

const SOURCES = [
  'https://jcflooringdirect.com/wp-json/wc/store/v1/products?search=pacifico&per_page=20',
  'https://southwestflooringdirect.com/wp-json/wc/store/v1/products?search=pacifico&per_page=20',
];

const EXPECTED = ['AS', 'BE', 'CS', 'GV', 'HV', 'KV', 'ML', 'SN', 'SS', 'WW']
  .map(c => `TW-HFDVCG10${c}`);

async function fetchImages(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`Store API ${res.status} for ${url}`);
  const products = await res.json();
  const out = [];
  for (const p of products) {
    if (!/pacifico/i.test(p.name || '')) continue;
    for (const im of (p.images || [])) if (im.src) out.push(im.src);
  }
  return out;
}

async function main() {
  const images = {};
  for (const url of SOURCES) {
    let srcs;
    try { srcs = await fetchImages(url); }
    catch (e) { console.warn(`! ${url}: ${e.message}`); continue; }
    console.log(`Fetched ${srcs.length} images from ${new URL(url).host}`);

    for (const src of srcs) {
      const fn = src.split('/').pop();
      const m = fn.match(/VCG10(\w{2})(-\S*)?\.(?:avif|png|jpe?g|webp)/i);
      if (!m) continue;
      const code = m[1].toUpperCase();
      const internal = `TW-HFDVCG10${code}`;
      if (!EXPECTED.includes(internal)) continue;
      // base filename (code immediately before extension) = primary swatch.
      const isPrimary = !m[2];
      images[internal] ||= {};
      const slot = isPrimary ? 'primary' : 'lifestyle';
      if (!images[internal][slot]) images[internal][slot] = src;
    }
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'images.json'), JSON.stringify(images, null, 2));

  const filled = EXPECTED.filter(k => images[k]?.primary);
  console.log(`\nMatched primary for ${filled.length}/${EXPECTED.length} colors`);
  console.log(`With lifestyle: ${EXPECTED.filter(k => images[k]?.lifestyle).length}`);
  const missing = EXPECTED.filter(k => !images[k]?.primary);
  if (missing.length) console.log(`Missing: ${missing.join(', ')}`);
  console.log(`\nWrote ${path.join(OUT_DIR, 'images.json')}`);
}

main().catch(e => { console.error(e); process.exit(1); });
