/**
 * De-duplicate Bosphorus media rows caused by the ?v= cache-buster.
 *
 * Bosphorus image URLs carried a `?v=<timestamp>` that changed every scrape, so
 * media_assets never deduped and the SAME image accumulated dozens of copies
 * (one product had 228 of one image; vendor-wide 12,382 rows for only ~861 real
 * images). The scraper is now fixed (normalizeImgUrl strips ?v=); this collapses
 * the existing duplicates.
 *
 * Per (product, sku-level-or-product-level, base image = URL without ?v=), keep
 * ONE row — best asset_type (primary > alternate > lifestyle), then lowest
 * sort_order — and delete the rest. Backup written; dry-run default.
 *   node backend/scripts/dedup-bosphorus-media.mjs [--apply]
 */
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const APPLY = process.argv.includes('--apply');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost', port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim', user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

// base image key: original CDN url (or url) with ?query and any -v-<ts> local
// suffix stripped, so all cache-buster variants of one image collapse together.
const BASE_SQL = `regexp_replace(regexp_replace(COALESCE(original_url, url), '\\?.*$', ''), '-v-[0-9]+', '')`;

async function main() {
  const vendor = (await pool.query(`SELECT id FROM vendors WHERE code='BOS' LIMIT 1`)).rows[0];
  if (!vendor) throw new Error('Bosphorus vendor not found');

  const dupSql = `
    WITH ranked AS (
      SELECT m.id,
        ROW_NUMBER() OVER (
          PARTITION BY m.product_id, COALESCE(m.sku_id::text, 'PRODUCT'), ${BASE_SQL}
          ORDER BY CASE m.asset_type WHEN 'primary' THEN 0 WHEN 'alternate' THEN 1 WHEN 'swatch' THEN 2 ELSE 3 END,
                   m.sort_order, m.id
        ) AS rn
      FROM media_assets m JOIN products p ON p.id = m.product_id
      WHERE p.vendor_id = $1
    )
    SELECT id FROM ranked WHERE rn > 1`;

  const before = (await pool.query(
    `SELECT count(*) c FROM media_assets m JOIN products p ON p.id=m.product_id WHERE p.vendor_id=$1`, [vendor.id])).rows[0].c;
  const dupIds = (await pool.query(dupSql, [vendor.id])).rows.map(r => r.id);
  console.log(`Bosphorus media: ${before} rows → ${dupIds.length} duplicate copies to remove (keeping ${before - dupIds.length}).`);

  if (!dupIds.length) { console.log('Nothing to dedup.'); await pool.end(); return; }
  if (!APPLY) { console.log('\nDry run — pass --apply to commit.'); await pool.end(); return; }

  const backup = (await pool.query(
    `SELECT * FROM media_assets WHERE id = ANY($1)`, [dupIds])).rows;
  const bp = path.join(__dirname, '..', 'data', `bosphorus-media-dedup-backup-${Date.now()}.json`);
  fs.writeFileSync(bp, JSON.stringify(backup, null, 2));
  console.log(`Backup: ${bp}`);

  // delete in chunks
  let deleted = 0;
  for (let i = 0; i < dupIds.length; i += 1000) {
    const chunk = dupIds.slice(i, i + 1000);
    const r = await pool.query(`DELETE FROM media_assets WHERE id = ANY($1)`, [chunk]);
    deleted += r.rowCount;
  }
  console.log(`\n✓ Deleted ${deleted} duplicate Bosphorus media rows.`);
  await pool.end();
}
main().catch(e => { console.error(e); process.exit(1); });
