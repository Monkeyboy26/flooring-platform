#!/usr/bin/env node
/**
 * Merge per-color photos scraped from each collection page's PRODUCT-INFO / label section
 * (data/formamondo/info-raw.json — {pkey:{p, a[]}}, paths relative to /wp-content/uploads/) into
 * the filename-matched images.json, and disperse the gallery/slider room scenes as alternates.
 *
 * The info-section swatch is the color's own photo shown next to its spec label — the reliable
 * per-color hero, ESPECIALLY for the newer lines that have no filename-encoded swatch. But the
 * Elementor sections occasionally attach a sibling color's tile (double Beige block reused Arrow)
 * or a loader/hash graphic, so we only ACCEPT an info primary when it is (a) not junk and (b) not
 * a cross-color leak; otherwise the already-verified filename primary is kept. Clean gallery/slider
 * scenes are always dispersed in as alternates.
 *
 * Usage: node scripts/merge-formamondo-images.js   (writes images.json, backs up images-base.json)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(__dirname, '..', 'data', 'formamondo');
const BASE = 'https://formamondo.com/wp-content/uploads/';
const images = JSON.parse(fs.readFileSync(path.join(DIR, 'images.json'), 'utf8'));
const info = JSON.parse(fs.readFileSync(path.join(DIR, 'info-raw.json'), 'utf8'));
const catalog = JSON.parse(fs.readFileSync(path.join(DIR, 'catalog.json'), 'utf8'));

// note: hash-named uploads (e.g. cd18bf…​.png) are legit per-color renders on the newer lines
// (Noa Light/Pearl), so they are NOT treated as junk — only loaders/spacers/association logos are
const JUNK = /[-_]load\d|[-_]load[-.]|FF-\d|tile-of|Ceramics-of|White-on-transparent/i;
const norm = (s) => String(s).replace(/[^a-z0-9]/gi, '').toUpperCase();
const abs = (p) => (p.startsWith('http') ? p : BASE + p);

// siblings (other colors in the same collection) per pkey, for cross-color leak detection
const siblingsOf = {};
const byCollection = {};
for (const p of catalog.products) (byCollection[p.collectionSlug] ||= []).push(p);
for (const p of catalog.products) {
  siblingsOf[p.pkey] = { self: p.color, siblings: byCollection[p.collectionSlug].map((x) => x.color).filter((c) => c !== p.color) };
}

// back up the filename-only image map once
const backup = path.join(DIR, 'images-base.json');
if (!fs.existsSync(backup)) fs.writeFileSync(backup, JSON.stringify(images, null, 2));

let overridden = 0, keptJunk = 0, keptLeak = 0, altsAdded = 0, noExisting = 0;
for (const [pkey, rec] of Object.entries(info)) {
  const cur = (images[pkey] ||= { product: { primary: null, alternates: [] }, skus: {} });
  const { self, siblings } = siblingsOf[pkey] || { self: '', siblings: [] };
  const file = rec.p.split('/').pop();
  const nf = norm(file);
  const isJunk = JUNK.test(file);
  const isLeak = siblings.some((s) => nf.includes(norm(s))) && !nf.includes(norm(self));

  if (!isJunk && !isLeak) {
    cur.product.primary = abs(rec.p); overridden++;
  } else {
    if (isJunk) keptJunk++; else keptLeak++;
    if (!cur.product.primary) noExisting++;
  }

  // disperse clean gallery/slider scenes as alternates (merged with existing, deduped)
  const cleanAlts = (rec.a || []).filter((u) => !JUNK.test(u)).map(abs);
  const merged = [...new Set([...cleanAlts, ...(cur.product.alternates || [])])]
    .filter((u) => u !== cur.product.primary).slice(0, 5);
  altsAdded += merged.length - (cur.product.alternates || []).length > 0 ? cleanAlts.length : 0;
  cur.product.alternates = merged;
}

fs.writeFileSync(path.join(DIR, 'images.json'), JSON.stringify(images, null, 2));
const withPrimary = Object.values(images).filter((r) => r.product && r.product.primary).length;
console.log(`Merged info-section photos into images.json`);
console.log(`  info primaries accepted (overrode):    ${overridden}`);
console.log(`  rejected as junk (kept filename hero):  ${keptJunk}`);
console.log(`  rejected as cross-color leak:           ${keptLeak}`);
console.log(`  products with a primary now:            ${withPrimary}/${Object.keys(images).length}`);
if (noExisting) console.log(`  ! ${noExisting} rejected AND had no existing primary`);
