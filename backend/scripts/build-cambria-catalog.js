#!/usr/bin/env node
/**
 * Build Cambria catalog.json + images.json from the Algolia scrape.
 *
 * Source: data/cambria/algolia.json (produced by scrape-cambria.js).
 * Cambria = ONE vendor + ONE house brand (Cambria), all natural quartz surfaces.
 *
 * MODEL:
 *   - Each design = ONE product (collection = Cambria design series: Signature/Luxury/
 *     Classic/Coordinates/Grandeur).
 *   - SKUs fan out over finish × thickness (thickness SPLIT into its own SKU/pill).
 *     Slabs sell_by 'unit', price_basis 'per_unit'.
 *   - NO price list (Cambria doesn't publish per-slab retail) → status 'draft', no pricing.
 *   - Images per-design from Adobe Scene7 (deterministic by slug): primary = flat slab
 *     swatch render, jumbo = full-slab render (alternate), lifestyle = hover kitchen shot.
 *
 * Usage: node scripts/build-cambria-catalog.js
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data', 'cambria');
const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'algolia.json'), 'utf8'));

const MARBLE_HINTS = /marble|calacatta|statuario|carrara|brittanicca|torquay|marmo/i;

const slugify = (s) => (s || '').toString().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
const clean = (s) => (s || '').replace(/[®™©]/g, '').replace(/\s+/g, ' ').trim();
const stripHtml = (s) => (s || '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
  .replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim() || null;

// "2cm" / "1cm (Minimal lead time)" → "2 cm" / "1 cm"
function normThickness(t) {
  const m = String(t).match(/(\d+)\s*cm/i);
  return m ? `${m[1]} cm` : null;
}
const thickSlug = (t) => String(t).replace(/\s*cm/i, '') + 'cm'; // "2 cm" → "2cm"

// Scene7: swap the ?$SearchImages$ thumbnail preset for a full-res render.
const s7 = (url, params) => url ? url.split('?')[0] + '?' + params : null;

const products = [];
const images = {};
let skuTotal = 0;

for (const h of raw.hits) {
  const name = clean(h.name);
  if (!name) continue;
  const slug = h.slug || slugify(name);
  const pkey = `CAMB-${slug}`;
  const collection = (h.designSeries && h.designSeries.name) ? h.designSeries.name : 'Cambria';
  const look = MARBLE_HINTS.test(name) ? 'Marble' : 'Stone';
  const size_nominal = (h.slabSize && h.slabSize.name)
    ? h.slabSize.name.replace(/\s*\(Nominal\)/i, '').replace(/\s*in\b/g, '"').replace(/\s+/g, ' ').trim()
    : null;

  const finishes = [...new Set((h.finishes || []).map((f) => clean(f.name)).filter(Boolean))];
  const finishList = finishes.length ? finishes : [null];
  const thicks = [...new Set((h.thickness || []).map((t) => normThickness(t.name)).filter(Boolean))]
    .sort((a, b) => parseFloat(a) - parseFloat(b));
  const thickList = thicks.length ? thicks : [null];

  const skus = [];
  for (const finish of finishList) {
    for (const thick of thickList) {
      const suffix = [finish ? slugify(finish) : null, thick ? thickSlug(thick) : null].filter(Boolean).join('-') || 'std';
      const vname = [finish, thick].filter(Boolean).join(' · ') || 'Slab';
      skus.push({ suffix, variant_name: vname, finish: finish || null, thickness: thick || null, size_nominal, sell_by: 'unit', price_basis: 'per_unit' });
    }
  }

  products.push({
    pkey,
    name,
    color: name,
    collection,
    collectionSlug: slugify(collection),
    category: 'quartz-countertops',
    material: 'Quartz',
    look,
    colorFamily: (h.primaryColor && h.primaryColor.name) || null,
    designcode: h.designcode || null,
    status: 'draft',
    description: stripHtml(h.description),
    skus,
  });
  skuTotal += skus.length;

  // ---- images (Scene7, per-design) + the per-design Specifications tear sheet ----
  images[pkey] = {
    primary: s7(h.slabdetailimage, 'wid=2000&qlt=90&fmt=jpeg'),   // flat slab swatch render
    jumbo: s7(h.fullslabimage, 'wid=2400&qlt=90&fmt=jpeg'),        // full jumbo slab render
    lifestyle: h.hoverimage ? [s7(h.hoverimage, 'wid=1600&qlt=85&fmt=jpeg')] : [], // hover kitchen scene
    // "Specifications (PDF)" on each design page — deterministic tear sheet by slug (all 155 verified 200)
    specPdf: `https://www.cambriausa.com/content/dam/cusa/sales-marketing-collateral/tear-sheets/tear-sheet-${slug}.pdf`,
  };
}

const catalog = {
  // Distributor is Marble Express; Cambria is a brand under it (customers see
  // the brand, POs go to Marble Express). Cambria + Caesarstone share this vendor.
  vendor: {
    name: 'Marble Express',
    code: 'MRBX',
    website: null,
    email: null,
    phone: null,
    address: null,
    notes: 'Slab distributor; carries Cambria + Caesarstone quartz brands. '
      + 'Cambria: 155 designs across 5 series (Signature/Luxury/Classic/Coordinates/Grandeur), '
      + 'catalog + Scene7 images from the public Algolia index (cusa-en-design-palette). Cambria does '
      + 'not publish per-slab retail pricing, so all Cambria products import as DRAFT with no pricing — add '
      + 'costs + activate when the distributor price sheet arrives. Thickness split into separate SKUs. Slabs sell_by unit.',
  },
  brand: { name: 'Cambria', code: 'CAMB', website: 'https://www.cambriausa.com' },
  markup: 1.6,
  products,
};

fs.writeFileSync(path.join(DATA_DIR, 'catalog.json'), JSON.stringify(catalog, null, 2));
fs.writeFileSync(path.join(DATA_DIR, 'images.json'), JSON.stringify(images, null, 2));

const bySeries = {};
for (const p of products) bySeries[p.collection] = (bySeries[p.collection] || 0) + 1;
console.log('=== Cambria catalog built ===');
for (const [s, n] of Object.entries(bySeries)) console.log(`  ${s.padEnd(12)} ${n} designs`);
console.log(`  TOTAL        ${products.length} designs, ${skuTotal} SKUs`);
console.log(`  images:      ${products.filter((p) => images[p.pkey].primary).length}/${products.length} with a primary slab render`);
console.log('  → catalog.json + images.json');
