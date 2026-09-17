/**
 * Tri-West — product name + collection cleanup
 *
 * Tri-West is import-driven (832 EDI + DNav catalog + hardcoded inserts), and
 * several import paths left raw catalog strings in products.name / .collection:
 *   A. raw catalog codes  "Paradigm Performer SPC W/pad 12mil 7 X60 - Micro Bevel"
 *   B. trim/molding names  "T-molding 94", "Flush Stair Nose 94"
 *   C. @work redundancy    "@work Confidence Carpet Tile 24x24"
 *   D. trailing width       (left alone unless it's a molding length)
 * plus a little collection noise ("Hartwood Natureworx W/pad", "Grand Pacific
 * 7.25\" - Grand Pacific").
 *
 * This rewrites those to retail-readable titles using the SHARED cleaners in
 * lib/triwestName.js — the exact same functions the importers now call, so a
 * re-import can't reintroduce the noise. Owner decision 2026-09-16: KEEP plank
 * widths in the collection (useful buyer info; several series differ only by
 * width) — only junk/echoes are removed.
 *
 * Safety:
 *   - scoped strictly to the Tri-West vendor
 *   - only writes rows whose name/collection actually changes (idempotent)
 *   - collision guard: skips any change that would make two DIFFERENT products
 *     share the same (collection, name) — never silently merges siblings
 *   - does NOT touch slug (stable SEO identifier) or pricing/attributes
 *   - dry-run by default; pass --apply to commit (writes a JSON backup first)
 *
 * Usage:
 *   node backend/scripts/fix-triwest-names.mjs           # dry run
 *   node backend/scripts/fix-triwest-names.mjs --apply   # commit
 */
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { cleanTriwestName, cleanTriwestCollection, cleanTriwestVariant } from '../lib/triwestName.cjs';

const APPLY = process.argv.includes('--apply');
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

const VENDOR_ID = '550e8400-e29b-41d4-a716-446655440008'; // Tri-West

const key = (col, name) => `${(col || '').trim().toLowerCase()}|||${(name || '').trim().toLowerCase()}`;

async function main() {
  // Scope to active products (the only status the storefront renders). Inactive
  // drafts/discontinued stubs are cleaned by the importer root-fix if ever
  // re-imported, and cleaning them here only surfaces edge artifacts.
  const { rows } = await pool.query(
    `SELECT id, name, collection, status FROM products WHERE vendor_id = $1 AND status = 'active' ORDER BY collection, name`,
    [VENDOR_ID]
  );
  console.log(`Loaded ${rows.length} active Tri-West products\n`);

  // Current (collection, name) → owning product ids, to detect collisions.
  const currentKeys = new Map();
  for (const r of rows) {
    const k = key(r.collection, r.name);
    if (!currentKeys.has(k)) currentKeys.set(k, new Set());
    currentKeys.get(k).add(r.id);
  }

  // Tally every product's FINAL (collection, name) so we can catch two distinct
  // products cleaning onto the same identity (mutual collision), not just a
  // clash with an unchanged product.
  const finalKeyCount = new Map();
  const proposals = rows.map(r => {
    const newName = cleanTriwestName(r.name) ?? r.name;
    const newCol = cleanTriwestCollection(r.collection) ?? r.collection;
    const k = key(newCol, newName);
    finalKeyCount.set(k, (finalKeyCount.get(k) || 0) + 1);
    return { r, newName, newCol, k };
  });

  const changes = [];
  const skipped = [];
  for (const p of proposals) {
    const { r, newName, newCol, k } = p;
    if (newName === r.name && newCol === r.collection) continue;

    // Collision guard — skip if the cleaned identity is shared by any OTHER
    // product, whether that product is unchanged (currentKeys) or also cleaning
    // onto this key (finalKeyCount). Never merge distinct products.
    const owners = currentKeys.get(k);
    const clashesUnchanged = owners && (owners.size > 1 || !owners.has(r.id));
    const clashesProposed = finalKeyCount.get(k) > 1;
    if (clashesUnchanged || clashesProposed) {
      skipped.push({ r, newName, newCol });
      continue;
    }
    changes.push({ id: r.id, status: r.status, oldName: r.name, newName, oldCol: r.collection, newCol });
  }

  // Report
  const nameChanges = changes.filter(c => c.oldName !== c.newName);
  const colChanges = changes.filter(c => c.oldCol !== c.newCol);
  console.log(`── Name changes (${nameChanges.length}) ──`);
  for (const c of nameChanges) {
    console.log(`  [${c.status}] ${JSON.stringify(c.oldName)}  ->  ${JSON.stringify(c.newName)}`);
  }
  console.log(`\n── Collection changes (${colChanges.length}) ──`);
  for (const c of colChanges) {
    console.log(`  [${c.status}] ${JSON.stringify(c.oldCol)}  ->  ${JSON.stringify(c.newCol)}`);
  }
  if (skipped.length) {
    console.log(`\n── SKIPPED (collision guard: ${skipped.length}) ──`);
    for (const s of skipped) {
      console.log(`  [${s.r.status}] ${JSON.stringify(s.r.name)} / ${JSON.stringify(s.r.collection)}  ` +
        `-> would collide as ${JSON.stringify(s.newCol)} / ${JSON.stringify(s.newName)}`);
    }
  }
  console.log(`\nTotal products to update: ${changes.length}`);

  // ── Phase 2: strip catalog-code fragments from SKU variant_names ──
  const { rows: skuRows } = await pool.query(
    `SELECT s.id, s.variant_name FROM skus s JOIN products p ON p.id = s.product_id
     WHERE p.vendor_id = $1 AND s.status = 'active' AND s.variant_name IS NOT NULL`,
    [VENDOR_ID]
  );
  const skuChanges = [];
  for (const s of skuRows) {
    const cleaned = cleanTriwestVariant(s.variant_name);
    if (cleaned !== s.variant_name) skuChanges.push({ id: s.id, oldVariant: s.variant_name, newVariant: cleaned });
  }
  console.log(`\n── SKU variant_name changes (${skuChanges.length}) ── (sample)`);
  for (const c of skuChanges.slice(0, 15)) {
    console.log(`  ${JSON.stringify(c.oldVariant)}  ->  ${JSON.stringify(c.newVariant)}`);
  }
  if (skuChanges.length > 15) console.log(`  … and ${skuChanges.length - 15} more`);

  if (!APPLY) {
    console.log('\nDRY RUN — no changes written. Re-run with --apply to commit.');
    await pool.end();
    return;
  }
  if (!changes.length && !skuChanges.length) {
    console.log('\nNothing to apply.');
    await pool.end();
    return;
  }

  // Backup
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(__dirname, '..', 'data', `triwest-names-backup-${stamp}.json`);
  fs.writeFileSync(backupPath, JSON.stringify({
    products: changes.map(c => ({ id: c.id, name: c.oldName, collection: c.oldCol })),
    skus: skuChanges.map(c => ({ id: c.id, variant_name: c.oldVariant })),
  }, null, 2));
  console.log(`\nBackup written: ${backupPath}`);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const c of changes) {
      await client.query(
        `UPDATE products SET name = $1, collection = $2, updated_at = NOW() WHERE id = $3`,
        [c.newName, c.newCol, c.id]
      );
    }
    for (const c of skuChanges) {
      await client.query(
        `UPDATE skus SET variant_name = $1, updated_at = NOW() WHERE id = $2`,
        [c.newVariant, c.id]
      );
    }
    await client.query('COMMIT');
    console.log(`\nAPPLIED ${changes.length} product + ${skuChanges.length} variant updates.`);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('ROLLED BACK:', e.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
