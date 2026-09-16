#!/usr/bin/env node
/**
 * Build StoneX per-SKU image map from the scraped stonextile.com catalog.
 *
 * stonextile.com is WooCommerce; every listing is a SINGLE size/finish variant
 * whose `sku` field equals the April-2026 price-list ITEM NUMBER — which is also
 * our skus.vendor_sku. So images match our SKUs EXACTLY by item number (no fuzzy
 * name matching, unlike the old product-slug map). image[0] is the vendor's
 * featured swatch; "-application-" shots are demoted out of the primary slot.
 *
 * Input:  backend/data/stonex/website-products.json  (from the WC store API)
 * Output: backend/data/stonex/sku-images.json
 *           { "<item#>": { primary: url, gallery: [url, ...] }, ... }
 *
 * Usage: node scripts/build-stonex-images.js
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data', 'stonex');
const web = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'website-products.json'), 'utf8'));

const isLifestyle = (url) => /application|lifestyle|-room|install|scene|_app|-app-/i.test(url || '');

// Merge listings that share an item# (rare — one known dup), unioning images.
const byItem = new Map();
for (const w of web) {
  const item = (w.wc_sku || '').trim();
  if (!item) continue;
  const urls = (w.images || []).map(i => i.src).filter(Boolean);
  if (!byItem.has(item)) byItem.set(item, []);
  const seen = new Set(byItem.get(item));
  for (const u of urls) if (!seen.has(u)) { byItem.get(item).push(u); seen.add(u); }
}

const out = {};
let withImg = 0, lifestyleDemoted = 0;
for (const [item, urls] of byItem) {
  if (!urls.length) continue;
  // Primary = first non-lifestyle image; fall back to urls[0] if all are lifestyle.
  let primaryIdx = urls.findIndex(u => !isLifestyle(u));
  if (primaryIdx < 0) primaryIdx = 0;
  if (primaryIdx !== 0) lifestyleDemoted++;
  const primary = urls[primaryIdx];
  const gallery = urls.filter((u, i) => i !== primaryIdx);
  out[item] = { primary, gallery };
  withImg++;
}

fs.writeFileSync(path.join(DATA_DIR, 'sku-images.json'), JSON.stringify(out, null, 1));
console.log(`Items with images: ${withImg}`);
console.log(`Primary demoted off a lifestyle lead image: ${lifestyleDemoted}`);
console.log('Wrote', path.join(DATA_DIR, 'sku-images.json'));
