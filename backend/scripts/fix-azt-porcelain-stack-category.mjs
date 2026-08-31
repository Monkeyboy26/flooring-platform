#!/usr/bin/env node
/**
 * fix-azt-porcelain-stack-category.mjs
 *
 * Arizona Tile PORCELAIN "stack" mesh products were browsing under Stacked
 * Stone. They're mesh-mounted stacked-LOOK mosaic sheets (Straight Stack /
 * Puzzle / Archer / Rhomboid mesh, sold per sheet) from porcelain series pages
 * (AZ tags: porcelain-and-ceramic + porcelain-stack) — not stone ledger.
 * Move them to mosaic-tile so Stacked Stone keeps only real stone (AZT Ledger
 * Panels quartzite, Splitface travertine, Calacatta Umber marble).
 *
 * Collection labels ("Canyon Stacked Stone", …) are intentionally KEPT: they
 * name the look, and product identity keys on (vendor, collection, name) — a
 * rename would fork duplicates on the next scrape.
 *
 * Scraper-side prevention ships with this in scrapers/arizona.js (porcelain
 * pages' 'stacked' format groups → mosaic-tile).
 *
 * Usage:
 *   node scripts/fix-azt-porcelain-stack-category.mjs           # dry run
 *   node scripts/fix-azt-porcelain-stack-category.mjs --apply   # write (with backup)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APPLY = process.argv.includes('--apply');
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/flooring_pim',
});

// Porcelain series whose stack groups landed in stacked-stone. Regex instead of
// exact strings because "Reside USA" carries an invisible U+200E in the DB.
const PORCELAIN_STACK_COLLECTIONS =
  '^(Anthea|Canyon|Digitalart|Intense|Marvel|Pietra Italia|Reside USA.{0,2}|Shibusa)( Stacked Stone)?$';

async function main() {
  console.log(`\n=== AZT porcelain stack → mosaic-tile (${APPLY ? 'APPLY' : 'DRY RUN'}) ===\n`);

  const { rows: cats } = await pool.query(
    `SELECT id, slug FROM categories WHERE slug IN ('stacked-stone','mosaic-tile')`);
  const catId = Object.fromEntries(cats.map(r => [r.slug, r.id]));
  if (!catId['stacked-stone'] || !catId['mosaic-tile']) throw new Error('categories missing');

  const { rows } = await pool.query(`
    SELECT p.id, p.name, p.collection,
      (SELECT COUNT(*) FROM skus s WHERE s.product_id=p.id AND s.status='active') AS active_skus
    FROM products p JOIN vendors v ON v.id=p.vendor_id
    WHERE v.code='AZT' AND p.category_id=$1 AND p.is_active
      AND p.collection ~ $2
    ORDER BY p.collection, p.name`,
    [catId['stacked-stone'], PORCELAIN_STACK_COLLECTIONS]);

  for (const r of rows) {
    console.log(`  ${r.name}  [${r.collection}]${r.active_skus > 0 ? '' : '  (no active SKUs)'}`);
  }
  console.log(`\n${rows.length} products planned → mosaic-tile.`);

  // Safety: what stays behind must be the stone collections only.
  const { rows: staying } = await pool.query(`
    SELECT DISTINCT p.collection FROM products p JOIN vendors v ON v.id=p.vendor_id
    WHERE v.code='AZT' AND p.category_id=$1 AND p.is_active AND p.collection !~ $2
    ORDER BY 1`, [catId['stacked-stone'], PORCELAIN_STACK_COLLECTIONS]);
  console.log(`Staying in stacked-stone: ${staying.map(r => r.collection).join(', ')}`);

  if (!APPLY) { console.log('\nDry run — re-run with --apply.'); await pool.end(); return; }

  const backupName = `azt-porcelain-stack-backup-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
  let backupPath = path.join(__dirname, `../data/${backupName}`);
  const backupJson = JSON.stringify(rows.map(r => ({ ...r, from: 'stacked-stone' })), null, 1);
  try { fs.writeFileSync(backupPath, backupJson); }
  catch { backupPath = path.join('/tmp', backupName); fs.writeFileSync(backupPath, backupJson); }
  console.log(`\nBackup: ${backupPath}`);

  const { rowCount } = await pool.query(
    `UPDATE products SET category_id=$2, updated_at=NOW() WHERE id = ANY($1)`,
    [rows.map(r => r.id), catId['mosaic-tile']]);
  console.log(`Moved ${rowCount} products to mosaic-tile.`);
  await pool.end();
}
main().catch(err => { console.error(err); process.exit(1); });
