// Push products out of non-leaf PARENT categories into browsable leaves.
// 572 active products sit in parent buckets (not navigable to a specific type):
//   - luxury-vinyl (144): LVP/LVT flooring -> lvp-plank / lvt-tile by size
//   - EMS installation-sundries + hardware-specialty (402): -> leaves via
//     classifyEmserSundry (reused from emser-832; ~110 classifiable, rest stay
//     for review and are surfaced by the non-leaf-category quality rule)
//   - hardscaping: coping -> pool-coping (walling/caps left for a category call)
//   - laminate-flooring -> laminate
//
//   node fix-categorization-2026-08.mjs --dry-run | --apply

import fs from 'fs';
import { pool } from './db.js';
import { classifyEmserSundry } from './scrapers/emser-832.js';

const APPLY = process.argv.includes('--apply');

const cats = (await pool.query('SELECT id, slug FROM categories')).rows;
const catId = Object.fromEntries(cats.map(c => [c.slug, c.id]));

// LVP vs LVT by size string: a ~48in-long strip is a plank; a squarish format is a tile.
function lvLeaf(size) {
  const s = (size || '').toLowerCase();
  if (/48|x\s*36|x\s*47/.test(s)) return 'lvp-plank';
  if (/12\s*[x"]?\s*24|18\s*[x"]?\s*18|16\s*[x"]?\s*16|12\s*[x"]?\s*12|24\s*[x"]?\s*24/.test(s)) return 'lvt-tile';
  return 'lvp-plank'; // ADURA/EF/Shaw LV lines are predominantly plank
}

const { rows } = await pool.query(`
  SELECT p.id AS product_id, p.name, v.code AS vendor, c.slug AS cur,
    (SELECT sa.value FROM sku_attributes sa JOIN attributes a ON a.id = sa.attribute_id
       JOIN skus s ON s.id = sa.sku_id
     WHERE s.product_id = p.id AND a.slug = 'size' LIMIT 1) AS size
  FROM products p JOIN vendors v ON v.id = p.vendor_id JOIN categories c ON c.id = p.category_id
  WHERE p.status = 'active'
    AND EXISTS (SELECT 1 FROM categories ch WHERE ch.parent_id = p.category_id)
`);

const updates = [];
const unresolved = {};
for (const r of rows) {
  let leaf = null;
  if (r.cur === 'luxury-vinyl') leaf = lvLeaf(r.size);
  else if (r.cur === 'laminate-flooring') leaf = 'laminate';
  else if (r.cur === 'installation-sundries' || r.cur === 'hardware-specialty') leaf = classifyEmserSundry(r.name);
  else if (r.cur === 'hardscaping') leaf = /coping/i.test(r.name) ? 'pool-coping' : null;
  if (leaf && catId[leaf]) updates.push({ product_id: r.product_id, name: r.name, from: r.cur, to: leaf });
  else unresolved[r.cur] = (unresolved[r.cur] || 0) + 1;
}

const byLeaf = {};
for (const u of updates) byLeaf[`${u.from} -> ${u.to}`] = (byLeaf[`${u.from} -> ${u.to}`] || 0) + 1;
console.log(`${rows.length} products in parent categories; ${updates.length} classifiable to leaves`);
Object.entries(byLeaf).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  ${k}: ${v}`));
console.log('unresolved (stay in parent, flagged by rule):', JSON.stringify(unresolved));

if (!APPLY) { console.log('\nDry-run. Re-run with --apply.'); await pool.end(); process.exit(0); }

fs.writeFileSync(`./data/categorization-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`, JSON.stringify(updates, null, 2));
for (let i = 0; i < updates.length; i += 500) {
  const chunk = updates.slice(i, i + 500);
  await pool.query(`
    UPDATE products p SET category_id = u.cat_id, updated_at = CURRENT_TIMESTAMP
    FROM (SELECT UNNEST($1::uuid[]) AS pid, UNNEST($2::uuid[]) AS cat_id) u
    WHERE p.id = u.pid
  `, [chunk.map(u => u.product_id), chunk.map(u => catId[u.to])]);
}
console.log(`Recategorized ${updates.length} products to leaves.`);
await pool.end();
