/**
 * Shared Siena catalog loader + naming — single source of truth.
 *
 * Data lives in backend/data/siena/catalog-q4-2025.json (transcribed from the
 * Siena Q-4-2025 wholesale price list). Both the re-onboard importer
 * (import-siena-q4-2025.mjs) and the scraper (scrapers/siena.js) load through here so
 * they can never diverge or fall back to stale 2024 data.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CATALOG_PATH = path.join(__dirname, '../data/siena/catalog-q4-2025.json');

// ── naming (must stay identical everywhere that keys Siena SKUs) ──
export function slugify(text) {
  return (text || '').toUpperCase().replace(/[^A-Z0-9]+/g, '').slice(0, 30);
}
export function buildInternalSku(collection, colorOrType, size, finish) {
  const col = slugify(collection);
  const ct = slugify(colorOrType);
  const sz = (size || '').replace(/[^0-9xX.]/g, '').toUpperCase();
  const fin = finish ? slugify(finish) : '';
  const parts = ['SIENA', col, ct, sz];
  if (fin) parts.push(fin);
  return parts.join('-');
}
export function accessoryLabel(type) {
  const labels = {
    bullnose: 'Bullnose', mosaic: 'Mosaic', 'london-base': 'London Base',
    'london-top': 'London Top', torello: 'Torello', 'quarter-round': 'Quarter Round',
    corner: 'Corner', 'corner-qr': 'Corner QR', jolly: 'Jolly', liner: 'Liner',
  };
  const key = String(type || '').toLowerCase();
  return labels[key] || String(type).replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}
export const isMosaic = t => String(t || '').toLowerCase() === 'mosaic';

// Title-case an ALL-CAPS collection key (fallback for collections with no existing DB name)
export function titleCase(k) {
  return k.toLowerCase().replace(/\b([a-z0-9])([a-z0-9]*)/g, (_, a, b) => a.toUpperCase() + b)
    .replace(/\bD'([a-z])/i, (_, c) => "D'" + c.toUpperCase());
}
const normKey = s => (s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/**
 * Load the catalog keyed by human Title-Case collection names, in the shape the
 * scraper/importer expect (collData.material/origin/usage/desc + items[]).
 * Uses the DB's existing Title-Case collection names where present so products update
 * in place rather than spawning ALL-CAPS duplicates.
 */
export async function loadSienaCatalog(pool, vendorId) {
  const raw = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8').replace(/&amp;/g, '&'));

  const displayByNorm = {};
  if (pool && vendorId) {
    const existing = await pool.query(
      "SELECT DISTINCT collection FROM products WHERE vendor_id=$1 AND collection IS NOT NULL", [vendorId]);
    for (const r of existing.rows) {
      if (!/[a-z]/.test(r.collection)) continue; // skip ALL-CAPS artifacts
      displayByNorm[normKey(r.collection)] = r.collection;
    }
  }
  const displayName = k => displayByNorm[normKey(k)] || titleCase(k);

  const out = {};
  for (const [key, coll] of Object.entries(raw)) {
    const material = /ceramic/i.test(coll.material) ? 'ceramic' : 'porcelain';
    const usage = coll.usage || 'floor';
    out[displayName(key)] = {
      material, origin: coll.origin || '', usage, slug: coll.slug || null,
      desc: `${coll.note ? coll.note + ' ' : ''}${material} ${usage} tile`.trim(),
      items: coll.items,
    };
  }
  return out;
}

/** Set of every internal_sku the catalog produces — drives deactivation of the rest. */
export function keepInternalSkus(priceList) {
  const keep = new Set();
  for (const [collectionName, coll] of Object.entries(priceList)) {
    for (const item of coll.items) {
      if (item.type) {
        keep.add(buildInternalSku(collectionName, accessoryLabel(item.type), item.size, null));
      } else if (item.colors) {
        for (const color of item.colors) {
          keep.add(buildInternalSku(collectionName, color, item.size, item.finish || null));
        }
      }
    }
  }
  return keep;
}
