#!/usr/bin/env node
/**
 * Build PentalQuartz catalog.json + images.json from the scrape.
 *
 * Source: data/pental/scraped.json (produced by scrape-pental.js).
 * Pental Surfaces = ONE vendor + ONE brand (PentalQuartz), engineered quartz slabs
 * (now distributed by Architectural Surfaces Group).
 *
 * MODEL:
 *   - Each color = ONE product (collection = the marketing collection, e.g. Core Classics).
 *   - SKUs fan out over finish × thickness. Finish is per-color (Polished/Honed);
 *     thickness is NOT published per-color, so we apply the brand's standard countertop
 *     gauges 2cm + 3cm to every color (SPLIT into its own SKU/pill, same rule as the other
 *     surfaces vendors). Slabs sell_by 'unit', price_basis 'per_unit'.
 *   - NO price list → status 'draft', no pricing rows.
 *   - Images: primary = per-color swatch/slab render (full-res); jumbo = DigitalOcean
 *     inventory-slab photos; one brand-level architectural spec PDF + terms.
 *
 * Usage: node scripts/build-pental-catalog.js
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data', 'pental');
const scraped = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'scraped.json'), 'utf8'));

const THICKNESSES = ['2 cm', '3 cm']; // brand-level standard countertop gauges (not published per color)
const MARBLE_HINTS = /marble|calacatta|carrara|statuario|arabescato|onyx/i;

const clean = (s) => (s || '').replace(/[®™©]/g, '').replace(/\s+/g, ' ').trim();
const slugify = (s) => (s || '').toString().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
const thickSlug = (t) => String(t).replace(/\s*cm/i, '') + 'cm';
const titleCase = (s) => (s || '').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

// "138x79" → '138" x 79"'
function fmtSize(s) {
  const m = String(s || '').match(/(\d{2,3})\s*[xX]\s*(\d{2,3})/);
  return m ? `${m[1]}" x ${m[2]}"` : null;
}

function lookFor(r) {
  const feats = (r.features || []).join(' ');
  if (/marble/i.test(feats) || MARBLE_HINTS.test(r.name)) return 'Marble';
  if (/quartzite/i.test(feats)) return 'Quartzite';
  if (/concrete/i.test(feats)) return 'Concrete';
  return 'Stone';
}

const products = [];
const images = {};
let skuTotal = 0;

for (const r of scraped) {
  const name = clean(r.name);
  if (!name) continue;
  const slug = r.slug || slugify(name);
  const pkey = `PENT-${slug}`;
  const collection = r.collection || 'PentalQuartz';
  const size_nominal = fmtSize(r.size);
  const finishes = (r.finish && r.finish.length) ? [...new Set(r.finish.map(titleCase))] : ['Polished'];

  const skus = [];
  for (const finish of finishes) {
    for (const thick of THICKNESSES) {
      const suffix = `${slugify(finish)}-${thickSlug(thick)}`;
      skus.push({
        suffix,
        variant_name: `${finish} · ${thick}`,
        finish, thickness: thick, size_nominal,
        vendor_sku: `${r.sku || slug.toUpperCase()}-${thickSlug(thick)}`,
        sell_by: 'unit', price_basis: 'per_unit',
      });
    }
  }

  products.push({
    pkey, name, color: name, collection, collectionSlug: slugify(collection),
    category: 'quartz-countertops', material: 'Quartz', look: lookFor(r),
    sku: r.sku || null,
    colorFamily: (r.colorFamily || []).map((c) => titleCase(c.replace(/-/g, ' '))).join(', ') || null,
    status: 'draft',
    description: r.description || null,
    skus,
  });
  skuTotal += skus.length;

  images[pkey] = {
    primary: r.primary || null,
    jumbo: r.jumbo || [],
    lifestyle: r.lifestyle || [],
  };
}

const catalog = {
  vendor: {
    name: 'Pental Surfaces',
    code: 'PENT',
    website: 'https://arcsurfaces.com/quartz/pentalquartz/',
    email: null,
    phone: '(206) 768-3200',
    address: '713 S Fidalgo St, Seattle, WA 98108',
    notes: 'PentalQuartz — engineered quartz surfaces (originally Pental Surfaces, now distributed by '
      + 'Architectural Surfaces Group; pentalquartz.com redirects to arcsurfaces.com). 32 current colors across '
      + '~8 collections, scraped from arcsurfaces.com. No published per-slab retail → all products imported as '
      + 'DRAFT with no pricing (add costs + activate on price sheet). Finish per color (Polished/Honed); thickness '
      + 'is brand-level (standard 2cm + 3cm gauges applied to every color) and SPLIT into separate SKUs. Slabs sell_by unit.',
  },
  brand: { name: 'PentalQuartz', code: 'PQ', website: 'https://arcsurfaces.com/quartz/pentalquartz/' },
  markup: 1.6,
  // brand-level documents attached as spec_pdf to every color
  brandPdfs: [
    'https://arcsurfaces.com/wp-content/uploads/2022/08/PQ-ARCHITECTURAL-SPECIFICATION.pdf',
    'https://arcsurfaces.com/wp-content/uploads/Terms-Conditions-Updated-4.24.25.pdf',
  ],
  products,
};

fs.writeFileSync(path.join(DATA_DIR, 'catalog.json'), JSON.stringify(catalog, null, 2));
fs.writeFileSync(path.join(DATA_DIR, 'images.json'), JSON.stringify(images, null, 2));

const byColl = {};
for (const p of products) byColl[p.collection] = (byColl[p.collection] || 0) + 1;
console.log('=== PentalQuartz catalog built ===');
for (const [c, n] of Object.entries(byColl)) console.log(`  ${c.padEnd(22)} ${n}`);
console.log(`  TOTAL ${products.length} colors, ${skuTotal} SKUs`);
console.log(`  images: ${products.filter((p) => images[p.pkey].primary).length}/${products.length} primary | ` +
  `${products.filter((p) => images[p.pkey].jumbo.length).length} with jumbo slab photos`);
console.log('  → catalog.json + images.json');
