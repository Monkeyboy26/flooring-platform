#!/usr/bin/env node
/**
 * One-off: rewrite backend/data/ark/images.json so a BOARD/SWATCH photo leads
 * each product and room-scene renders come after (ARK's styled renders were
 * scraped as the lead image). Input is the visual-QA sweep output
 * (data/ark/image-order.json), keyed by product_id with { name, order:[urls] }.
 *
 * For each catalog product we recompute which images.json key feeds its media
 * (same first-sku candidate logic as import-ark.js findImage), match the sweep
 * result by product name, and set that key's primary = order[0], alternate =
 * order[1..], lifestyle = []. Re-running import-ark.js then rebuilds DB media in
 * board-first order (all asset_type 'primary' per the earlier request).
 *
 * Usage: node scripts/apply-ark-image-order.js   (then re-run import-ark.js)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, '..', 'data', 'ark');
const catalog = JSON.parse(fs.readFileSync(path.join(DATA, 'catalog.json'), 'utf8'));
const images = JSON.parse(fs.readFileSync(path.join(DATA, 'images.json'), 'utf8'));
const sweep = JSON.parse(fs.readFileSync(path.join(DATA, 'image-order.json'), 'utf8'));

// Same candidate logic as import-ark.js
function imageCandidates(internalSku) {
  const base = internalSku.replace(/^ARK-/i, '').toUpperCase();
  const cands = [base];
  if (base.endsWith('-N-3M')) cands.push(base.replace(/-N-3M$/, '-N'), base.replace(/-N-3M$/, ''));
  if (base.endsWith('-3M')) cands.push(base.replace(/-3M$/, ''));
  if (base.endsWith('-N')) cands.push(base.replace(/-N$/, ''));
  if (base.endsWith('-L')) cands.push(base.replace(/-L$/, ''));
  return cands;
}
function feedingKey(skus) {
  for (const s of skus) {
    for (const key of imageCandidates(s.internal_sku)) {
      if (images[key] && (images[key].primary || (images[key].alternate || []).length)) return key;
    }
  }
  return null;
}

const byName = new Map();
for (const pid of Object.keys(sweep)) byName.set(sweep[pid].name, sweep[pid]);

let updated = 0, missing = 0, leadScene = 0;
for (const p of catalog.products) {
  if (p.category === 'transitions-moldings') continue;
  const sw = byName.get(p.name);
  if (!sw || !sw.order || !sw.order.length) { missing++; console.warn('  ! no sweep result for', p.name); continue; }
  const key = feedingKey(p.skus);
  if (!key) { missing++; console.warn('  ! no images key for', p.name); continue; }
  images[key] = {
    primary: sw.order[0],
    alternate: sw.order.slice(1),
    lifestyle: [],
    description: images[key].description || (sw.notes || ''),
  };
  if (sw.lead_type && sw.lead_type !== 'board') { leadScene++; console.warn('  ~ still scene-lead:', p.name); }
  updated++;
}

fs.writeFileSync(path.join(DATA, 'images.json'), JSON.stringify(images, null, 2));
console.log(`Rewrote images.json: ${updated} products reordered, ${missing} unmatched, ${leadScene} still scene-lead.`);
