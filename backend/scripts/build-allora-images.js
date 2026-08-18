#!/usr/bin/env node
/**
 * Scrape allorafloors.com (Webflow) product pages for Allora photos and write
 * backend/data/allora/images.json, keyed by plank internal_sku for import-allora.js.
 *
 * Each color has a page at /floor/<color>. og:image is the overhead plank
 * swatch → primary. The gallery room scenes are the full-res `_IP<n>.jpg` images
 * (Webflow also emits -p-500/800/…/3200 responsive variants — we keep only the
 * base) → lifestyle. The same image object is keyed to every plank SKU of that
 * color (one product per color; the importer uses the first match).
 *
 * Unfinished has no product page → no photo (left out).
 *
 * Usage: node scripts/build-allora-images.js
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data', 'allora');
const catalog = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'catalog.json'), 'utf8'));

const BASE = 'https://www.allorafloors.com/floor/';
const COLOR_SLUG = { Altura: 'altura', Aria: 'aria', Doma: 'doma', Luna: 'luna', Sella: 'sella', Strada: 'strada', Ventasso: 'ventasso', Volto: 'volto' };

function fetchHtml(url) {
  try {
    return execFileSync('curl', ['-s', '-L', '-A', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', '--max-time', '30', url], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  } catch { return ''; }
}
const dec = (u) => u.replace(/%20/g, ' ').replace(/&amp;/g, '&');

// Product photos live in the CMS media bucket; the site-assets bucket
// (640276c1…) holds logos/badges/favicons and is ignored. Product pages don't
// link other colors, so everything in the CMS bucket on a page is this color's.
const CMS_BUCKET = '6425d7e40772ce3d6c3eba88';
const stripResponsive = (u) => u.replace(/-p-\d+(\.\w+)$/i, '$1'); // collapse Webflow -p-500/800/… variants
const EXCLUDE = /overhead|color-variation|indoor-air|comfort|badge|logo|favicon|new-brand|social/i;

function extract(html) {
  const og = html.match(/<meta[^>]*property="og:image"[^>]*content="([^"]+)"/i)
          || html.match(/<meta[^>]*content="([^"]+)"[^>]*property="og:image"/i);
  const primary = og ? dec(og[1]) : null;
  const seen = new Set();
  const lifestyle = [];
  const re = new RegExp(`https://[a-z0-9.-]*website-files\\.com/${CMS_BUCKET}/[^" )]+?\\.(?:jpg|jpeg|png|webp)`, 'gi');
  let m;
  while ((m = re.exec(html))) {
    const u = stripResponsive(dec(m[0]));
    if (u === primary || seen.has(u) || EXCLUDE.test(u)) continue;
    seen.add(u); lifestyle.push(u);
  }
  return { primary, lifestyle };
}

// Herringbone pages carry no og:image; the swatch is the "<Color> Herringbone
// Overhead" image, lifestyle = the page's DSC studio shots. These attach at the
// SKU level (on the GFALPH… herringbone SKU) so that variant shows the real
// herringbone pattern instead of the straight-plank product photo.
function extractHb(html) {
  const ovMatch = html.match(new RegExp(`https://[a-z0-9.-]*website-files\\.com/${CMS_BUCKET}/[^" )]*Herringbone(?:%20| )Overhead[^" )]*\\.(?:jpg|jpeg|png|webp)`, 'i'));
  const primary = ovMatch ? dec(ovMatch[0]) : null;
  const { lifestyle } = extract(html.replace(/property="og:image"/gi, '')); // reuse CMS-bucket scan, no og
  return { primary, lifestyle: lifestyle.filter((u) => u !== primary) };
}

const products = {}; // internal_sku -> color swatch media (product-level)
const skus = {};     // internal_sku -> herringbone media (sku-level)
let ok = 0, miss = 0, hb = 0;

for (const p of catalog.products) {
  const slug = COLOR_SLUG[p.color];
  if (!slug) { miss++; continue; } // Unfinished etc.
  const img = extract(fetchHtml(BASE + slug));
  if (!img.primary) { console.warn(`  ! ${p.color}: no og:image`); miss++; continue; }
  img.lifestyle = img.lifestyle.slice(0, 8); // cap gallery; drops near-dup crops
  for (const s of p.skus) products[s.internal_sku] = img;
  ok++;
  console.log(`  + ${p.color}: primary + ${img.lifestyle.length} lifestyle`);

  // Herringbone SKU (Doma/Luna/Sella) → dedicated /floor/<color>-herringbone page.
  const hbSku = p.skus.find((s) => /GFALPH/.test(s.vendor_sku));
  if (hbSku) {
    const himg = extractHb(fetchHtml(`${BASE}${slug}-herringbone`));
    if (himg.primary) {
      himg.lifestyle = himg.lifestyle.slice(0, 8);
      skus[hbSku.internal_sku] = himg;
      hb++;
      console.log(`    ↳ ${p.color} Herringbone: primary + ${himg.lifestyle.length} lifestyle`);
    } else {
      console.warn(`    ! ${p.color} Herringbone: no overhead image`);
    }
  }
}

fs.writeFileSync(path.join(DATA_DIR, 'images.json'), JSON.stringify({ products, skus }, null, 2));
console.log(`\nWrote images.json: ${ok} colors, ${hb} herringbone SKUs, ${miss} without · ${Object.keys(products).length} product keys / ${Object.keys(skus).length} sku keys`);
