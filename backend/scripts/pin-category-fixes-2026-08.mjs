#!/usr/bin/env node
/**
 * pin-category-fixes-2026-08.mjs — one-time backfill for the category_source
 * pinning system: marks the product sets past hand-fixes deliberately placed
 * as category_source='manual', so no scraper or validator can ever move them
 * back (the whole reason arizona.js had to be patched defensively).
 *
 * Pinned sets:
 *   • AZT mosaic miscategorization fix (Gem→fluted, S-Series/Thin Brick→
 *     backsplash-wall, Atlantic Grey→natural-stone) — IDs from
 *     data/azt-mosaic-miscat-backup-2026-08-31-05-34-21.json
 *   • AZT porcelain "stack" mesh → mosaic-tile (66 products) — IDs from
 *     data/azt-porcelain-stack-backup-2026-08-31-15-49-44.json
 *   • BED stone lines fix (Durango/Iceberg White/Glorious White/Silver Cream
 *     → natural-stone, Ashen Grey → stacked-stone) — by name, same match as
 *     fix-bed-stone-lines.mjs
 *
 * Idempotent. Dry run by default; --apply to write.
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

const dataDir = path.join(__dirname, '..', 'data');
const ids = new Set();

const miscat = JSON.parse(fs.readFileSync(path.join(dataDir, 'azt-mosaic-miscat-backup-2026-08-31-05-34-21.json')));
for (const p of miscat.products || []) ids.add(p.id);

const stack = JSON.parse(fs.readFileSync(path.join(dataDir, 'azt-porcelain-stack-backup-2026-08-31-15-49-44.json')));
for (const p of stack) ids.add(p.id);

try {
  const bed = (await pool.query(`SELECT id FROM vendors WHERE code = 'BED'`)).rows[0]?.id;
  if (bed) {
    const { rows } = await pool.query(
      `SELECT p.id FROM products p
       WHERE p.vendor_id = $1 AND p.name = p.collection
         AND p.name IN ('Durango','Iceberg White','Glorious White','Silver Cream','Ashen Grey')`,
      [bed]);
    for (const r of rows) ids.add(r.id);
  }

  const idList = [...ids];
  const { rows: current } = await pool.query(
    `SELECT id, category_source FROM products WHERE id = ANY($1)`, [idList]);
  const toPin = current.filter(r => r.category_source !== 'manual').map(r => r.id);
  console.log(`${idList.length} products in pin sets, ${current.length} exist, ${toPin.length} to pin`);

  if (APPLY && toPin.length) {
    const res = await pool.query(
      `UPDATE products SET category_source = 'manual' WHERE id = ANY($1)`, [toPin]);
    console.log(`pinned ${res.rowCount} products as category_source='manual'`);
  } else if (!APPLY) {
    console.log('[dry run] pass --apply to write');
  }
} finally {
  await pool.end();
}
