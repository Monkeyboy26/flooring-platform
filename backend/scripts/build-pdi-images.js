#!/usr/bin/env node
/**
 * Assemble backend/data/pdi/images.json (keyed by internal_sku) from the three
 * scrape files (scrape-laminate.json / scrape-spc.json / scrape-hardwood.json)
 * produced from pacificdirectflooring.com (Webflow). Maps each scraped
 * {collection, colorName} back to its internal_sku via catalog.json.
 *
 * Many price-sheet designs are NOT published on the website (Poseidon Jupiter/
 * Pegasus/Hydra/Kraken/Aegen/Odyssey/Thalassa, XL Selene/Pluto/Leto, Desert
 * Walnut, all of Florence/Napa Valley, most of Riche/Manhattan) → no image;
 * they import photo-less. Reported at the end.
 *
 * Usage: node scripts/build-pdi-images.js
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(__dirname, '..', 'data', 'pdi');
const rd = (f) => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));

const catalog = rd('catalog.json');
const lam = rd('scrape-laminate.json');
const spc = rd('scrape-spc.json');
const hw = rd('scrape-hardwood.json');

// scrape-section key → catalog collection name
const SECTION_TO_COLLECTION = {
  poseidon: 'Poseidon', poseidon_xl: 'Poseidon XL', herringbone: 'Poseidon Herringbone',
  viva_las_vegas: 'Viva Las Vegas', monaco_royale: 'Monaco Royale', exotic_delights: 'Exotic Delights',
  manhattan: 'Manhattan', riche: 'Riche',
};

// lookup: "Collection|Name" → internal_sku
const skuByKey = {};
for (const p of catalog.products) skuByKey[`${p.collection}|${p.name}`] = p.internal_sku;

const images = {};
const unmatched = [];
for (const scrape of [lam, spc, hw]) {
  for (const [section, items] of Object.entries(scrape)) {
    const collection = SECTION_TO_COLLECTION[section];
    if (!collection) { console.warn('! unknown section', section); continue; }
    for (const [name, urls] of Object.entries(items)) {
      if (!urls || !urls.primary) continue;
      const internal = skuByKey[`${collection}|${name}`];
      if (!internal) { unmatched.push(`${collection} / ${name}`); continue; }
      images[internal] = { primary: urls.primary, lifestyle: urls.lifestyle || null };
    }
  }
}

fs.writeFileSync(path.join(DIR, 'images.json'), JSON.stringify(images, null, 2));

const total = catalog.products.length;
const withImg = Object.keys(images).length;
console.log(`Wrote images.json: ${withImg}/${total} flooring products have a primary photo`);
const withLife = Object.values(images).filter(i => i.lifestyle).length;
console.log(`  (${withLife} also have a lifestyle scene)`);
if (unmatched.length) console.log('! UNMATCHED (name mismatch vs catalog):', unmatched);
const photoless = catalog.products.filter(p => !images[p.internal_sku]).map(p => `${p.collection}/${p.name}`);
console.log(`! No photo (${photoless.length}):`, photoless.join(', '));
