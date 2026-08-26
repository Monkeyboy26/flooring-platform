#!/usr/bin/env node
/**
 * Build Cosentino catalog.json + images.json from the scraped data.
 *
 * Source: data/cosentino/scraped.json (produced by scrape-cosentino.js).
 * Cosentino = ONE vendor carrying 5 brands (Silestone, Dekton, Sensa, Scalea, Éclos).
 *
 * MODEL:
 *   - Each color = ONE product (brand_id = its brand, collection = marketing series).
 *   - SKUs fan out over finish × thickness (thickness is split into its own SKU/pill
 *     per owner request). Slabs sell_by 'unit', price_basis 'per_unit'.
 *   - NO price list yet → every product/SKU imported as status 'draft', no pricing rows.
 *     Flip to 'active' + add pricing once the price list arrives.
 *   - Images are per-color (deterministic Bynder URLs): primary = full-slab HD render,
 *     swatch = detail thumb, lifestyle = room scenes filtered to this color's slug.
 *
 * Usage: node scripts/build-cosentino-catalog.js
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data', 'cosentino');
const scraped = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'scraped.json'), 'utf8'));

const CDN = 'https://assetstools.cosentino.com/api/v1/bynder';

// Per-brand config: display name, brand code, category slug, material + look defaults.
const BRANDCFG = {
  silestone: { name: 'Silestone', code: 'SILE', category: 'quartz-countertops',   material: 'Quartz',                look: 'Marble' },
  dekton:    { name: 'Dekton',    code: 'DKTN', category: 'sintered-surfaces',     material: 'Ultracompact Surface', look: 'Stone'  },
  sensa:     { name: 'Sensa',     code: 'SNSA', category: 'granite-countertops',   material: 'Granite',              look: 'Granite'},
  scalea:    { name: 'Scalea',    code: 'SCLA', category: 'granite-countertops',   material: 'Natural Stone',        look: 'Stone'  },
  eclos:     { name: 'Éclos',     code: 'ECLS', category: 'sintered-surfaces',     material: 'Mineral Surface',      look: 'Stone'  },
};

const MARBLE_HINTS = /calacatta|statuario|marquina|carrara|arabescato|marble|onyx|travertin/i;

const slugify = (s) => (s || '').toString().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
const titleCase = (s) => (s || '').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

// "2.0 cm" → "2 cm"; "1.2 cm" → "1.2 cm"; "0.8 cm" → "0.8 cm"
function normThickness(t) {
  const m = String(t).match(/([\d.]+)\s*cm/i);
  if (!m) return null;
  let n = parseFloat(m[1]);
  return `${Number.isInteger(n) ? n : n} cm`;
}
const thickSlug = (t) => String(t).replace(/\s*cm/i, '').replace('.', 'p') + 'cm'; // "2 cm"→"2cm", "1.2 cm"→"1p2cm"

// Strip Cosentino boilerplate tails from the description paragraph.
function cleanDesc(d) {
  if (!d) return null;
  let s = d.split(/REQUEST SAMPLES?|SAMPLES TEMPORARILY|PLEASE,? CONTACT|Discover Hybriq|View the full gallery|Order sample|\bTECHNOLOGY\b|\bCERTIFICATES?\b/i)[0];
  return s.replace(/\s+/g, ' ').trim() || null;
}

const products = [];
const images = {};
let skuTotal = 0, noImg = 0;

for (const [brandSlug, arr] of Object.entries(scraped)) {
  const cfg = BRANDCFG[brandSlug];
  if (!cfg) { console.warn('! unknown brand', brandSlug); continue; }

  for (const r of arr) {
    if (!r.name) continue;
    const colorSlug = slugify(r.href.split('/').filter(Boolean).pop());
    const pkey = `COSN-${brandSlug}-${colorSlug}`;
    const collection = r.series ? titleCase(r.series) : cfg.name;
    const look = MARBLE_HINTS.test(r.name) ? 'Marble' : cfg.look;

    // finish × thickness fan-out. Strip the redundant "Sensa " finish-brand prefix
    // (e.g. "SENSA LEATHER" → "Leather") so pills read cleanly.
    const cleanFinish = (f) => titleCase(String(f).replace(/^\s*sensa\s+/i, '').trim());
    const finishes = (r.finishes && r.finishes.length)
      ? [...new Set(r.finishes.map(cleanFinish).filter(Boolean))] : [null];
    const thicks = [...new Set((r.thicknesses || []).map(normThickness).filter(Boolean))];
    const thickList = thicks.length ? thicks : [null];
    const size_nominal = (r.formats && r.formats[0]) ? r.formats[0].replace(/\s+/g, ' ').trim() : null;

    const skus = [];
    for (const finish of finishes) {
      for (const thick of thickList) {
        const suffix = [finish ? slugify(finish) : null, thick ? thickSlug(thick) : null].filter(Boolean).join('-') || 'std';
        const vname = [finish, thick].filter(Boolean).join(' · ') || 'Slab';
        skus.push({
          suffix,
          variant_name: vname,
          finish: finish || null,
          thickness: thick || null,
          size_nominal,
          sell_by: 'unit',
          price_basis: 'per_unit',
        });
      }
    }

    products.push({
      pkey,
      brand: cfg.name,
      brandCode: cfg.code,
      brandSlug,
      name: r.name.trim(),
      color: r.name.trim(),
      collection,
      collectionSlug: slugify(collection),
      category: cfg.category,
      material: cfg.material,
      look,
      status: 'draft',           // unpriced until the price list arrives
      description: cleanDesc(r.description),
      code: r.code || null,
      skus,
    });
    skuTotal += skus.length;

    // ---- images (per-color, deterministic from the Bynder color code) ----
    if (r.code) {
      const primary = `${CDN}/color/${r.code}/tablahd/${r.code}-fullslab.jpg?w=1600&q=80&auto=format`;
      const swatch  = `${CDN}/color/${r.code}/detalle/${r.code}-thumb.jpg?w=900&q=80&auto=format`;
      // Keep only room scenes whose filename references THIS color (drops "similar colors").
      const lifestyle = (r.lifestyle || [])
        .filter((u) => u.toLowerCase().split('/').pop().includes(colorSlug))
        .map((u) => u.split('?')[0] + '?w=1600&q=80&auto=format')
        .slice(0, 4);
      images[pkey] = { primary, swatch, lifestyle };
    } else {
      noImg++;
      images[pkey] = { primary: null, swatch: null, lifestyle: [] };
    }
  }
}

const catalog = {
  vendor: {
    name: 'Cosentino',
    code: 'COSN',
    website: 'https://www.cosentino.com',
    email: null,
    phone: '(786) 686-5060',
    address: '355 Alhambra Circle, Suite 900, Coral Gables, FL 33134',
    notes: 'Cosentino Group — premium surfaces manufacturer/distributor. US brands: Silestone (hybrid quartz), '
      + 'Dekton (ultracompact sintered surface), Sensa (protected natural granite), Scalea (natural stone slabs), '
      + 'Éclos (zero-silica mineral surface). Catalog scraped from cosentino.com (no price list yet — all products '
      + 'imported as DRAFT with no pricing; add costs + activate when the price list arrives). Thickness is split '
      + 'into separate SKUs per owner request. Slabs sell_by unit.',
  },
  brands: Object.values(BRANDCFG).map((c) => ({ name: c.name, code: c.code, website: 'https://www.cosentino.com' })),
  markup: 1.6,
  products,
};

fs.writeFileSync(path.join(DATA_DIR, 'catalog.json'), JSON.stringify(catalog, null, 2));
fs.writeFileSync(path.join(DATA_DIR, 'images.json'), JSON.stringify(images, null, 2));

// ---- summary ----
const byBrand = {};
for (const p of products) byBrand[p.brand] = (byBrand[p.brand] || 0) + 1;
console.log('=== Cosentino catalog built ===');
for (const [b, n] of Object.entries(byBrand)) console.log(`  ${b.padEnd(10)} ${n} products`);
console.log(`  TOTAL      ${products.length} products, ${skuTotal} SKUs`);
console.log(`  images:    ${products.length - noImg}/${products.length} with a primary slab render` + (noImg ? ` (${noImg} missing code → no image)` : ''));
console.log('  → catalog.json + images.json');
