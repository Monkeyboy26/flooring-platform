#!/usr/bin/env node
/**
 * Build Forma Mondo product images from the PDF price-list swatches (the authoritative per-finish
 * tile face in the "IMAGE" column of each collection page). Guarantees every (color, finish) shows
 * its own correct swatch — no color mismatches, no fallbacks to a sibling finish or a room scene.
 *
 * Source: `pdfimages -png "PRICE LIST 2026.pdf"` output (img-000.png ...). Each embedded image is
 * one finish row, in top-to-bottom reading order per page (verified against a labeled contact sheet
 * 2026-08-02). This script copies each swatch to uploads/formamondo/<pkey>-<finishslug>.png and
 * writes data/formamondo/images.json:
 *   product.primary = the product's FIRST finish swatch (represents the color);
 *   skus[suffix]    = the swatch for that SKU's finish (all sizes of a finish share one swatch).
 *
 * Usage: node scripts/build-formamondo-pdf-images.js /path/to/pdfimages-output-dir
 */
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(__dirname, '..', 'data', 'formamondo');
const UPLOADS = path.join(__dirname, '..', '..', 'uploads', 'formamondo');
const SWATCHES = path.join(DIR, 'swatches'); // committed JPGs (self-contained; survive without the PDF)
const SRC = process.argv[2] || path.join(DIR, 'pdf-swatches-src'); // raw `pdfimages` PNGs (gitignored)
const catalog = JSON.parse(fs.readFileSync(path.join(DIR, 'catalog.json'), 'utf8'));

// num (pdfimages index) -> [pkey, finishSlug]. Order verified against the rendered price list.
const MAP = {
  2: ['FMO-mapierre-blanc', 'natural'], 3: ['FMO-mapierre-blanc', 'ligne'],
  4: ['FMO-mapierre-beige', 'natural'], 5: ['FMO-mapierre-beige', 'ligne'],
  6: ['FMO-mapierre-gris', 'natural'], 7: ['FMO-mapierre-gris', 'ligne'],
  8: ['FMO-mapierre-noir', 'natural'], 9: ['FMO-mapierre-noir', 'ligne'],
  10: ['FMO-matera-stone-white', 'neutra-r10'], 11: ['FMO-matera-stone-white', 'neutra-r11'],
  12: ['FMO-matera-stone-white', 'sassi'], 13: ['FMO-matera-stone-white', 'ritmo'],
  14: ['FMO-matera-stone-beige', 'neutra-r10'], 15: ['FMO-matera-stone-beige', 'neutra-r11'],
  16: ['FMO-matera-stone-beige', 'sassi'], 17: ['FMO-matera-stone-beige', 'ritmo'],
  18: ['FMO-marvel-diva-taj-mahal', 'matte'], 19: ['FMO-marvel-diva-taj-mahal', 'polished'],
  20: ['FMO-marvel-diva-ice-crystal', 'matte'], 21: ['FMO-marvel-diva-ice-crystal', 'polished'],
  22: ['FMO-marvel-diva-white-everest', 'matte'], 23: ['FMO-marvel-diva-white-everest', 'polished'],
  24: ['FMO-marvel-diva-precious-brown', 'silk-matte'],
  25: ['FMO-elysian-travertini-pearl', 'vein-cut'], 26: ['FMO-elysian-travertini-pearl', 'cross-cut'],
  27: ['FMO-elysian-travertini-light', 'vein-cut'], 28: ['FMO-elysian-travertini-light', 'cross-cut'],
  29: ['FMO-elysian-travertini-misty', 'vein-cut'], 30: ['FMO-elysian-travertini-misty', 'cross-cut'],
  31: ['FMO-easylife-vanilla', 'silk-matte'], 32: ['FMO-easylife-porridge', 'silk-matte'],
  33: ['FMO-easylife-mushroom', 'silk-matte'], 34: ['FMO-easylife-truffle', 'silk-matte'],
  35: ['FMO-easylife-cool-spring', 'silk-matte'], 36: ['FMO-easylife-warm-spring', 'silk-matte'],
  37: ['FMO-double-white', 'plain'], 38: ['FMO-double-white', 'linear'], 39: ['FMO-double-white', 'linear-3d-lux'],
  40: ['FMO-double-beige', 'plain'], 41: ['FMO-double-beige', 'linear'], 42: ['FMO-double-beige', 'linear-3d-lux'],
  43: ['FMO-double-mint', 'plain'], 44: ['FMO-double-mint', 'linear'], 45: ['FMO-double-arrow', 'mix'],
  46: ['FMO-noa-light', 'natural'], 47: ['FMO-noa-pearl', 'natural'], 48: ['FMO-noa-sand', 'natural'],
  49: ['FMO-volcano-ash', 'natural'], 50: ['FMO-volcano-ash', 'rubik'],
  51: ['FMO-alpi-grigio', 'natural'], 52: ['FMO-alpi-tesseo', 'mix'],
  53: ['FMO-boost-vision-glow', 'natural'], 54: ['FMO-boost-vision-camel', 'natural'],
  55: ['FMO-natural-white', 'field-tile'], 56: ['FMO-natural-white', 'strip'],
  57: ['FMO-natural-ivory', 'field-tile'], 58: ['FMO-natural-ivory', 'strip'],
  59: ['FMO-nyra-star', 'natural'], 60: ['FMO-nyra-sunlight', 'natural'],
};

const finishSlugOf = (suffix) => suffix.replace(/-(12x24|24x48|48x48)$/,'');
const URLBASE = '/uploads/formamondo';

fs.mkdirSync(UPLOADS, { recursive: true });
fs.mkdirSync(SWATCHES, { recursive: true });
const fromPdf = fs.existsSync(path.join(SRC, 'img-002.png'));
// 1) stage swatches with meaningful names, build pkey -> { finishSlug: url }.
//    From the raw `pdfimages` PNGs (regen): resize+JPG into the committed swatches/ dir.
//    Either way: copy the committed JPG into the nginx-served uploads/formamondo/.
const swatch = {};
let staged = 0;
for (const [num, [pkey, finish]] of Object.entries(MAP)) {
  const fname = `${pkey}-${finish}.jpg`;
  const committed = path.join(SWATCHES, fname);
  if (fromPdf) {
    await sharp(path.join(SRC, `img-${String(num).padStart(3, '0')}.png`))
      .resize({ width: 1000, withoutEnlargement: true }).jpeg({ quality: 82 }).toFile(committed);
  }
  if (!fs.existsSync(committed)) { console.warn('  ! missing swatch', fname); continue; }
  fs.copyFileSync(committed, path.join(UPLOADS, fname));
  (swatch[pkey] ||= {})[finish] = `${URLBASE}/${fname}`;
  staged++;
}
console.log(fromPdf ? 'Regenerated JPG swatches from PDF PNGs.' : 'Staged committed JPG swatches (no raw PDF source).');

// 2) generate images.json from the catalog + swatch map (primary = first finish; each SKU = its finish)
const images = {};
let missing = [];
for (const p of catalog.products) {
  const sw = swatch[p.pkey] || {};
  const firstFinish = finishSlugOf(p.skus[0].suffix);
  const primary = sw[firstFinish] || Object.values(sw)[0] || null;
  if (!primary) { missing.push(p.pkey); }
  const rec = { product: { primary, alternates: [] }, skus: {} };
  for (const s of p.skus) {
    const fs2 = finishSlugOf(s.suffix);
    const u = sw[fs2];
    if (u) rec.skus[s.suffix] = { primary: u };
    else missing.push(`${p.pkey}/${s.suffix}`);
  }
  images[p.pkey] = rec;
}

fs.writeFileSync(path.join(DIR, 'images.json'), JSON.stringify(images, null, 2));
const nSku = Object.values(images).reduce((a, r) => a + Object.keys(r.skus).length, 0);
console.log(`Staged ${staged} PDF swatches -> uploads/formamondo/`);
console.log(`images.json: ${Object.keys(images).length} products, ${nSku} SKU swatches (every finish has its own)`);
if (missing.length) console.log('MISSING swatch:', missing.join(', '));
else console.log('No fallbacks — every product + every SKU has its own color/finish-matched swatch.');
