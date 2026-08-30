// One-time backfill: reclassify every product sitting on a NULL or parent
// (non-leaf) category through the central classifier (lib/categoryClassifier.js)
// — the SAME module the choke-point net and quality rules use, so this backfill
// can never disagree with them.
//
// Confident keyword matches move to a leaf. Products whose family is known but
// have no keyword signal move to the family's best-guess leaf and are flagged
// category_needs_review=true. NULL products with no signal at all stay put and
// are flagged. Nothing is left silently on a parent/NULL that we can resolve.
//
//   node scripts/backfill-categories-central.mjs            # dry-run (default)
//   node scripts/backfill-categories-central.mjs --apply    # write + JSON backup
//   node scripts/backfill-categories-central.mjs --active   # limit to status='active'

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool } from '../db.js';
import { netCategory, loadCategoryCache } from '../lib/categoryClassifier.js';

const APPLY = process.argv.includes('--apply');
const ACTIVE_ONLY = process.argv.includes('--active');
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const { parentIds, idToSlug } = await loadCategoryCache(pool);
const parentIdArr = [...parentIds];

const statusFilter = ACTIVE_ONLY ? `AND p.status = 'active'` : `AND p.status IN ('active','draft','inactive')`;
const { rows } = await pool.query(`
  SELECT p.id AS product_id, p.name, p.collection, p.category_id, p.status,
         v.code AS vendor
  FROM products p
  JOIN vendors v ON v.id = p.vendor_id
  WHERE (p.category_id IS NULL OR p.category_id = ANY($1::uuid[]))
    ${statusFilter}
  ORDER BY v.code, p.name
`, [parentIdArr]);

console.log(`Scanning ${rows.length} products on NULL/parent categories${ACTIVE_ONLY ? " (status='active' only)" : ''}\n`);

const changes = [];       // { product_id, name, vendor, status, from, to, needsReview }
const unresolved = [];    // couldn't assign any leaf (anonymous NULL)
for (const p of rows) {
  const net = await netCategory(pool, { name: p.name, collection: p.collection, categoryId: p.category_id });
  const from = p.category_id ? (idToSlug.get(p.category_id) || '??') : 'NULL';
  if (!net.changed) continue; // already a leaf (shouldn't happen given the WHERE, but safe)
  if (net.categoryId && net.categoryId !== p.category_id) {
    changes.push({ product_id: p.product_id, name: p.name, vendor: p.vendor, status: p.status,
                   from, to: net.slug, needsReview: net.needsReview });
  } else {
    // category unchanged (still NULL/parent) but flagged for review
    unresolved.push({ product_id: p.product_id, name: p.name, vendor: p.vendor, status: p.status, from });
  }
}

// ── Report ──────────────────────────────────────────────────────────────────
const byTarget = {};
for (const c of changes) {
  const k = `${c.to}${c.needsReview ? '  (best-guess, flagged)' : ''}`;
  (byTarget[k] ||= []).push(c);
}
console.log('=== Reclassifications (from → to) ===');
for (const k of Object.keys(byTarget).sort()) {
  const list = byTarget[k];
  console.log(`\n${k}: ${list.length}`);
  for (const c of list.slice(0, 6)) console.log(`    [${c.vendor}/${c.status}] ${c.from} → ${c.to}   "${c.name.slice(0, 52)}"`);
  if (list.length > 6) console.log(`    … +${list.length - 6} more`);
}

const confident = changes.filter(c => !c.needsReview).length;
const flagged = changes.filter(c => c.needsReview).length;
console.log(`\n=== Summary ===`);
console.log(`  Confident leaf moves : ${confident}`);
console.log(`  Best-guess (flagged) : ${flagged}`);
console.log(`  Unresolved NULL (flagged, unchanged): ${unresolved.length}`);
if (unresolved.length) {
  const byV = {};
  for (const u of unresolved) (byV[u.vendor] ||= 0), byV[u.vendor]++;
  console.log(`    by vendor: ${Object.entries(byV).map(([v, n]) => `${v}:${n}`).join(', ')}`);
  console.log('    e.g. ' + unresolved.slice(0, 5).map(u => `"${u.name.slice(0, 40)}"`).join(', '));
}

if (!APPLY) {
  console.log('\nDRY-RUN — no changes written. Re-run with --apply to persist.');
  await pool.end();
  process.exit(0);
}

// ── Apply ─────────────────────────────────────────────────────────────────
const ts = new Date().toISOString().replace(/[:.]/g, '-');
const backupIds = [...changes.map(c => c.product_id), ...unresolved.map(u => u.product_id)];
const backup = (await pool.query(
  `SELECT id AS product_id, category_id, category_needs_review FROM products WHERE id = ANY($1::uuid[])`,
  [backupIds]
)).rows;
const backupFile = path.join(__dirname, '..', 'data', `categorization-central-backup-${ts}.json`);
fs.writeFileSync(backupFile, JSON.stringify(backup, null, 2));
console.log(`\nBackup written: ${backupFile} (${backup.length} rows)`);

const client = await pool.connect();
try {
  await client.query('BEGIN');
  for (const c of changes) {
    await client.query(
      `UPDATE products SET category_id = (SELECT id FROM categories WHERE slug = $2),
                           category_needs_review = $3, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [c.product_id, c.to, c.needsReview]
    );
  }
  for (const u of unresolved) {
    await client.query(
      `UPDATE products SET category_needs_review = true, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [u.product_id]
    );
  }
  await client.query('COMMIT');
  console.log(`Applied: ${changes.length} recategorized, ${unresolved.length} flagged-only.`);
} catch (e) {
  await client.query('ROLLBACK');
  console.error('ROLLBACK —', e.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
