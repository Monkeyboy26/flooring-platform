#!/usr/bin/env node
/**
 * Build backend/data/pink/images.json for the Pink Floors import.
 *
 * pinkfloors.com runs WooCommerce with an OPEN Store API
 * (/wp-json/wc/store/v1/products) — same as Icon Tile. Every product carries a
 * clean color name that matches our catalog.json `name` EXACTLY (case/accent
 * insensitive), so this is a plain 1:1 name join — no fuzzy SKU matching. Each
 * site product has one image → stored as {primary}.
 *
 * Site has 17 of our 20 products; the 3 Chevron colors are not published there.
 * We do NOT substitute a herringbone/plank photo for chevron (cross-form matches
 * put the wrong texture on a swatch — see [[icon-tile-onboarding]] lesson), so
 * those stay image-less.
 *
 * Output keyed by internal_sku (PDI convention): { "PINK-...": { primary } }.
 *
 * Usage: node scripts/build-pink-images.js   (writes data/pink/images.json)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data', 'pink');
const catalog = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'catalog.json'), 'utf8'));

const API = 'https://pinkfloors.com/wp-json/wc/store/v1/products?per_page=100';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)';

// normalize a product name for matching: lowercase, strip accents & punctuation
const norm = (s) => (s || '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const internalSku = (code) => `PINK-${code.trim().replace(/\s+/g, '-')}`;

async function main() {
  const res = await fetch(API, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`Store API ${res.status}`);
  const site = await res.json();
  console.log(`Fetched ${site.length} products from pinkfloors.com Store API\n`);

  // index site products by normalized name -> first image src
  const byName = new Map();
  for (const p of site) {
    const img = (p.images || [])[0]?.src;
    if (img) byName.set(norm(p.name), img);
  }

  const images = {};
  const matched = [], missing = [];
  for (const p of catalog.products) {
    const src = byName.get(norm(p.name));
    if (src) {
      images[internalSku(p.vendor_sku)] = { primary: src };
      matched.push(p.name);
    } else {
      missing.push(`${p.name} [${p.collection}]`);
    }
  }

  fs.writeFileSync(path.join(DATA_DIR, 'images.json'), JSON.stringify(images, null, 2));
  console.log(`Matched ${matched.length}/${catalog.products.length} products with a photo.`);
  if (missing.length) console.log(`No site photo (${missing.length}): ${missing.join(', ')}`);
  console.log(`\nWrote data/pink/images.json`);
}

main().catch(e => { console.error(e); process.exit(1); });
