// Fix name-vs-category contradictions (mosaic in field tile, ledger outside
// stacked-stone, trim in field categories, …). Detection comes from the SAME
// pattern table as the name-category-mismatch quality rule
// (NAME_CATEGORY_RULES in backend/quality/rules.js) so rule and fix can never
// disagree. Moves each product to the pattern's target leaf, with backup.
//
//   node fix-name-category-2026-08.mjs --dry-run | --apply

import fs from 'fs';
import { pool } from './db.js';
import { NAME_CATEGORY_RULES } from './quality/rules.js';

const APPLY = process.argv.includes('--apply');

const cats = (await pool.query('SELECT id, slug FROM categories')).rows;
const catId = Object.fromEntries(cats.map(c => [c.slug, c.id]));

const updates = [];
for (const rule of NAME_CATEGORY_RULES) {
  const { rows } = await pool.query(`
    SELECT p.id AS product_id, v.code AS vendor, p.name, c.slug AS cur
    FROM products p
    JOIN vendors v ON v.id = p.vendor_id
    JOIN categories c ON c.id = p.category_id
    WHERE p.status = 'active' AND p.name ~* $1 AND c.slug = ANY($2)
      ${rule.unless ? `AND p.name !~* '${rule.unless}'` : ''}
  `, [rule.pattern, rule.fireIn]);
  for (const r of rows) {
    if (!catId[rule.target]) continue;
    updates.push({ product_id: r.product_id, vendor: r.vendor, name: r.name, from: r.cur, to: rule.target, rule: rule.key });
  }
}

const byMove = {};
for (const u of updates) byMove[`${u.rule}: ${u.from} -> ${u.to}`] = (byMove[`${u.rule}: ${u.from} -> ${u.to}`] || 0) + 1;
console.log(`${updates.length} products to move:`);
Object.entries(byMove).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  ${k}: ${v}`));
for (const u of updates.slice(0, 12)) console.log(`   [${u.vendor}] ${u.name.slice(0, 50)}  (${u.from} -> ${u.to})`);

if (!APPLY) { console.log('\nDry-run. Re-run with --apply.'); await pool.end(); process.exit(0); }

fs.writeFileSync(`./data/name-category-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`, JSON.stringify(updates, null, 2));
for (const u of updates) {
  await pool.query('UPDATE products SET category_id = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1', [u.product_id, catId[u.to]]);
}
console.log(`Moved ${updates.length} products.`);
await pool.end();
