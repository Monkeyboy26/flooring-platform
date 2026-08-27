// Strip product-name echoes out of variant names (2026-08-26 follow-up to the
// conformance backfill). "Lisbon — Lisbon Bullnose 3X12" -> "Lisbon — Bullnose
// 3X12"; variant exactly equal to the product name -> NULL (single-name display).
//
// Collision guard: if stripping would make a SKU collide with an UNTOUCHED
// sibling that already carries the bare remainder, the whole product is skipped
// and left for the indistinguishable-variants queue instead.
//
//   node fix-variant-echo-2026-08.mjs --dry-run | --apply

import fs from 'fs';
import { pool } from './db.js';

const APPLY = process.argv.includes('--apply');

const { rows } = await pool.query(`
  SELECT s.id AS sku_id, s.product_id, p.name, s.variant_name, v.code AS vendor_code
  FROM skus s
  JOIN products p ON p.id = s.product_id
  JOIN vendors v ON v.id = p.vendor_id
  WHERE s.status = 'active' AND p.status = 'active' AND s.is_sample IS NOT TRUE
    AND s.variant_name IS NOT NULL
    AND (
      LOWER(TRIM(s.variant_name)) = LOWER(TRIM(p.name))
      OR LOWER(s.variant_name) LIKE LOWER(p.name) || ' %'
      OR LOWER(s.variant_name) LIKE LOWER(p.name) || ',%'
    )
`);

function stripEcho(productName, variantName) {
  const p = productName.trim();
  const v = variantName.trim();
  if (v.toLowerCase() === p.toLowerCase()) return null;
  const rest = v.slice(p.length).replace(/^[\s,]+/, '').trim();
  return rest || null;
}

// Group by product, and fetch ALL active siblings for the collision guard.
const byProduct = new Map();
for (const r of rows) {
  if (!byProduct.has(r.product_id)) byProduct.set(r.product_id, []);
  byProduct.get(r.product_id).push(r);
}
const sibRes = await pool.query(`
  SELECT product_id, id AS sku_id, variant_name FROM skus
  WHERE product_id = ANY($1) AND status = 'active' AND is_sample IS NOT TRUE
`, [[...byProduct.keys()]]);
const sibsByProduct = new Map();
for (const s of sibRes.rows) {
  if (!sibsByProduct.has(s.product_id)) sibsByProduct.set(s.product_id, []);
  sibsByProduct.get(s.product_id).push(s);
}

const updates = [];
let skippedProducts = 0;
for (const [productId, group] of byProduct.entries()) {
  const proposed = new Map(group.map(g => [g.sku_id, stripEcho(g.name, g.variant_name)]));
  const sibs = sibsByProduct.get(productId) || [];
  const keys = sibs.map(s => {
    const next = proposed.has(s.sku_id) ? proposed.get(s.sku_id) : s.variant_name;
    return (next || '').toLowerCase();
  });
  const beforeKeys = sibs.map(s => (s.variant_name || '').toLowerCase());
  // Only guard against NEW collisions — pre-existing duplicates stay the
  // indistinguishable rule's problem either way.
  if (new Set(keys).size < new Set(beforeKeys).size) { skippedProducts++; continue; }
  for (const g of group) {
    updates.push({ sku_id: g.sku_id, vendor: g.vendor_code, product: g.name, from: g.variant_name, to: proposed.get(g.sku_id) });
  }
}

console.log(`${rows.length} echoing SKUs across ${byProduct.size} products; ${updates.length} updates, ${skippedProducts} products skipped (would collide)`);
for (const u of updates.slice(0, 12)) console.log(`  [${u.vendor}] "${u.product}": "${u.from}" -> ${u.to === null ? 'NULL' : '"' + u.to + '"'}`);

if (!APPLY) { console.log('\nDry-run. Re-run with --apply.'); await pool.end(); process.exit(0); }

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
fs.writeFileSync(`./data/variant-echo-backup-${stamp}.json`, JSON.stringify(updates, null, 2));

for (let i = 0; i < updates.length; i += 1000) {
  const chunk = updates.slice(i, i + 1000);
  await pool.query(`
    UPDATE skus s SET variant_name = u.next_name, updated_at = CURRENT_TIMESTAMP
    FROM (SELECT UNNEST($1::uuid[]) AS sku_id, UNNEST($2::text[]) AS next_name) u
    WHERE s.id = u.sku_id
  `, [chunk.map(u => u.sku_id), chunk.map(u => u.to)]);
}
console.log(`Applied ${updates.length} updates. Backup: ./data/variant-echo-backup-${stamp}.json`);
await pool.end();
