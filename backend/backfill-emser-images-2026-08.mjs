// Phase 3 (coverage) — recover missing Emser TILE images from the emser.com API.
//
// Emser is EDI-sourced (the 832 has no images); images come from the emser.com
// product API, matched by productNumber == our vendor_sku. ~646 real-tile
// products are imageless — either newer or they slipped the catalog scraper's
// match. This indexes the full API by productNumber and attaches the correct
// per-SKU image. The other ~4,400 imageless Emser rows are third-party sundries
// (Laticrete/Noble/tools) and unphotographed metal trim — NO source image
// exists, so they are intentionally out of scope (stay imageless accessories).
//
//   node backfill-emser-images-2026-08.mjs --dry-run | --apply

import { pool } from './db.js';
import { upsertMediaAsset, isLifestyleUrl } from './scrapers/base.js';

const APPLY = process.argv.includes('--apply');
const API = 'https://www.emser.com/api/v2/products';

// ── 1. Index the full API by productNumber -> best product-shot image ──
const norm = (s) => (s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

async function buildIndex() {
  const first = await (await fetch(`${API}?pageSize=100&page=1&expand=images`, { headers: { 'User-Agent': 'Mozilla/5.0' } })).json();
  const pages = first.pagination?.numberOfPages || 1;
  const bySku = new Map();        // productNumber -> image bundle (exact)
  const byCollColor = new Map();  // norm(collection)|norm(color) -> image bundle (fallback)
  const ingest = (products) => {
    for (const p of products || []) {
      const imgs = (p.images || [])
        .map(i => i.largeImagePath || i.mediumImagePath || i.smallImagePath)
        .filter(u => u && !u.includes('placeholder'));
      const primary = imgs.find(u => !isLifestyleUrl(u)) || null; // product shot, not a room scene
      if (!primary) continue;
      const bundle = { primary, alts: imgs.filter(u => u !== primary).slice(0, 3), title: p.productTitle };
      const sku = (p.productNumber || '').toUpperCase().trim();
      if (sku) bySku.set(sku, bundle);
      // Title shape: "INHALE - 1X12, GRIS, GLOSSY" => collection INHALE, color GRIS.
      const t = p.productTitle || '';
      const dash = t.split(/\s-\s/);
      if (dash.length >= 2) {
        const collection = dash[0];
        const rest = dash.slice(1).join(' - ').split(',').map(s => s.trim());
        const color = rest.length >= 2 ? rest[1] : null; // [size, COLOR, finish]
        if (collection && color) {
          const key = norm(collection) + '|' + norm(color);
          if (!byCollColor.has(key)) byCollColor.set(key, bundle); // first wins (a representative)
        }
      }
    }
  };
  ingest(first.products);
  for (let pg = 2; pg <= pages; pg++) {
    try {
      const j = await (await fetch(`${API}?pageSize=100&page=${pg}&expand=images`, { headers: { 'User-Agent': 'Mozilla/5.0' } })).json();
      ingest(j.products);
    } catch (e) { console.log(`  page ${pg} failed: ${e.message}`); }
  }
  return { bySku, byCollColor };
}

console.log('Fetching emser.com API…');
const { bySku, byCollColor } = await buildIndex();
console.log(`API indexed: ${bySku.size} by SKU, ${byCollColor.size} by collection+color`);

// ── 2. Our imageless Emser TILE SKUs (+ collection + color attr) ──
const { rows } = await pool.query(`
  SELECT s.id AS sku_id, s.product_id, s.vendor_sku, p.name, p.collection,
         (SELECT sa.value FROM sku_attributes sa JOIN attributes a ON a.id = sa.attribute_id
           WHERE sa.sku_id = s.id AND a.slug = 'color' LIMIT 1) AS color
  FROM skus s
  JOIN products p ON p.id = s.product_id
  JOIN vendors v ON v.id = p.vendor_id
  JOIN categories c ON c.id = p.category_id
  WHERE v.code = 'EMS' AND s.status = 'active' AND p.status = 'active'
    AND c.slug IN ('porcelain-tile','ceramic-tile','natural-stone','wood-look-tile',
                   'large-format-tile','mosaic-tile','backsplash-wall','pool-tile',
                   'porcelain-slabs','stacked-stone','pavers')
    AND NOT EXISTS (SELECT 1 FROM media_assets ma WHERE ma.sku_id = s.id AND ma.asset_type = 'primary')
`);

const matched = [];
let viaSku = 0, viaColl = 0;
for (const r of rows) {
  let hit = bySku.get((r.vendor_sku || '').toUpperCase().trim());
  if (hit) viaSku++;
  if (!hit && r.collection && r.color) {
    hit = byCollColor.get(norm(r.collection) + '|' + norm(r.color));
    if (hit) viaColl++;
  }
  if (hit) matched.push({ ...r, ...hit });
}
const prods = new Set(matched.map(m => m.product_id));
console.log(`${rows.length} imageless tile SKUs; ${matched.length} matched (${viaSku} by SKU, ${viaColl} by collection+color) — ${prods.size} products recovered`);
for (const m of matched.slice(0, 8)) console.log(`  ${m.collection}/${m.color}  ${m.vendor_sku}  ->  ${m.primary.split('/').pop()}`);

if (!APPLY) { console.log('\nDry-run. Re-run with --apply.'); await pool.end(); process.exit(0); }

let saved = 0;
const productPrimaryDone = new Set();
for (const m of matched) {
  try {
    // Per-SKU primary (correct color for this variant).
    await upsertMediaAsset(pool, { product_id: m.product_id, sku_id: m.sku_id, asset_type: 'primary', url: m.primary, original_url: m.primary, sort_order: 0 });
    let so = 1;
    for (const a of m.alts) { await upsertMediaAsset(pool, { product_id: m.product_id, sku_id: m.sku_id, asset_type: 'alternate', url: a, original_url: a, sort_order: so++ }); }
    // One product-level primary (sku_id NULL) so the browse grid isn't imageless.
    if (!productPrimaryDone.has(m.product_id)) {
      await upsertMediaAsset(pool, { product_id: m.product_id, sku_id: null, asset_type: 'primary', url: m.primary, original_url: m.primary, sort_order: 0 });
      productPrimaryDone.add(m.product_id);
    }
    saved++;
  } catch (e) { /* skip on conflict/error */ }
}
console.log(`Attached: ${saved} SKU primaries + ${productPrimaryDone.size} product-level primaries.`);
await pool.end();
