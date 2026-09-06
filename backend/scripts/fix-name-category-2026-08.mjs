// Name-vs-category fixer — companion to the name-category-mismatch quality
// rule. Imports the SAME contradiction table (NAME_CATEGORY_RULES in
// quality/rules.js) so detection and fix can never drift: every active
// product whose name matches a pattern while sitting in one of that
// pattern's confusable categories moves to the pattern's target leaf.
//
// Products are pinned (category_source='manual') so scraper re-imports
// don't bounce them back — base.js upsertProduct honors the pin.
//
// First real batch: 55 SIEN "<collection> Bullnose" products the Siena
// re-onboard filed under porcelain/ceramic-tile (their SKUs were already
// unit/per_unit accessories — only the product category was wrong).
//
// Idempotent. Dry-run unless --apply.
// Prod: docker compose exec -T api node scripts/fix-name-category-2026-08.mjs --apply

import { pool } from '../db.js';
import { NAME_CATEGORY_RULES } from '../quality/rules.js';

const APPLY = process.argv.includes('--apply');

async function main() {
  let total = 0;
  for (const rule of NAME_CATEGORY_RULES) {
    const { rows } = await pool.query(`
      SELECT p.id, p.name, v.code AS vendor, c.slug AS current
      FROM products p
      JOIN vendors v ON v.id = p.vendor_id
      JOIN categories c ON c.id = p.category_id
      WHERE p.status = 'active' AND p.name ~* $1 AND c.slug = ANY($2)
      ORDER BY v.code, p.name`, [rule.pattern, rule.fireIn]);
    if (!rows.length) continue;
    console.log(`\n[${rule.key}] -> ${rule.target}: ${rows.length} product(s)`);
    for (const r of rows.slice(0, 8)) console.log(`  ${r.vendor} "${r.name}" (${r.current})`);
    if (rows.length > 8) console.log(`  ... and ${rows.length - 8} more`);
    total += rows.length;

    if (APPLY) {
      const res = await pool.query(`
        UPDATE products p SET
          category_id = (SELECT id FROM categories WHERE slug = $2),
          category_source = 'manual',
          updated_at = NOW()
        WHERE p.id = ANY($1)`, [rows.map(r => r.id), rule.target]);
      console.log(`  moved ${res.rowCount} (pinned)`);
    }
  }
  console.log(`\n${total} product(s) ${APPLY ? 'moved' : 'would move'}.`);
  if (!APPLY) console.log('Dry-run. Re-run with --apply to write.');
  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
