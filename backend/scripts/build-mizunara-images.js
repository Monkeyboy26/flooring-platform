#!/usr/bin/env node
/**
 * Build backend/data/mizunara/images.json for the Mizunara import.
 *
 * jcflooringdirect.com (and southwestflooringdirect.com) run WooCommerce with an
 * OPEN Store API (/wp-json/wc/store/v1/products). Both carry the full "Mizunara
 * Wood" 7.5" collection as ONE product whose 21 gallery images embed the EXACT
 * vendor SKU in each filename, e.g. `Nikka-EK7MW362W.png` and its room scene
 * `Nikka-EK7MW362W-1.png`. That code = our vendor_sku minus the `AHF` prefix, so
 * we match per-SKU (not fuzzy color): EK7MW362W → AHFEK7MW362W → TW-AHFEK7MW362W.
 *   base filename → primary (625x625 plank swatch)
 *   `-N` suffix   → lifestyle (room scene)
 *
 * Only the Woods 7.5" line (10 colors) is published anywhere — Coastal Rift is a
 * brand-new AHF/NWFA-2026 line not yet on any retailer site, so it stays photoless.
 *
 * Output keyed by internal_sku: { "TW-AHFEK7MW362W": { primary, lifestyle } }.
 * Consumed by import-mizunara.js (per-SKU media attach).
 *
 * Usage: node scripts/build-mizunara-images.js
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, '..', 'data', 'mizunara');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)';

// Ordered by preference — first source that yields a clean match for a SKU wins.
const SOURCES = [
  'https://jcflooringdirect.com/wp-json/wc/store/v1/products?search=mizunara&per_page=20',
  'https://southwestflooringdirect.com/wp-json/wc/store/v1/products?search=mizunara&per_page=20',
];

// The 10 Woods SKUs we expect to fill (for a coverage report).
const EXPECTED = ['302', '307', '312', '317', '322', '332', '337', '347', '357', '362']
  .map(n => `TW-AHFEK7MW${n}W`);

async function fetchImages(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`Store API ${res.status} for ${url}`);
  const products = await res.json();
  const out = [];
  for (const p of products) for (const im of (p.images || [])) if (im.src) out.push(im.src);
  return out;
}

async function main() {
  const images = {};
  const seenSrc = new Set();

  for (const url of SOURCES) {
    let srcs;
    try { srcs = await fetchImages(url); }
    catch (e) { console.warn(`! ${url}: ${e.message}`); continue; }
    const host = new URL(url).host;
    console.log(`Fetched ${srcs.length} images from ${host}`);

    for (const src of srcs) {
      const fn = src.split('/').pop();
      // capture SKU code (EK<digit>MW<digits>W) + optional numeric variant suffix
      const m = fn.match(/(EK\dMW\d+W)(?:-(?:Copy-?)?(\d+))?\.(?:png|jpe?g|webp)/i);
      if (!m) continue;
      const code = m[1].toUpperCase();
      const isLifestyle = !!m[2];              // has a trailing -N → room scene
      const internal = `TW-AHF${code}`;
      if (!EXPECTED.includes(internal)) continue;
      if (seenSrc.has(src)) continue;
      seenSrc.add(src);

      images[internal] ||= {};
      const slot = isLifestyle ? 'lifestyle' : 'primary';
      // First source wins per slot (don't overwrite a cleaner earlier match).
      if (!images[internal][slot]) images[internal][slot] = src;
    }
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'images.json'), JSON.stringify(images, null, 2));

  const filled = EXPECTED.filter(k => images[k]?.primary);
  const missing = EXPECTED.filter(k => !images[k]?.primary);
  console.log(`\nMatched primary for ${filled.length}/${EXPECTED.length} Woods SKUs`);
  console.log(`With lifestyle: ${EXPECTED.filter(k => images[k]?.lifestyle).length}`);
  if (missing.length) console.log(`Missing: ${missing.join(', ')}`);
  console.log(`\nWrote ${path.join(OUT_DIR, 'images.json')}`);
}

main().catch(e => { console.error(e); process.exit(1); });
