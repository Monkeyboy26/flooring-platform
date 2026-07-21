#!/usr/bin/env node
/**
 * State the mosaic pattern in Daltile variant names.
 *
 * Coveo's `designPattern` is blank for most mosaics, so sheets that differ only
 * by layout (Brick Joint vs Penny Round vs Trapezoid …) all showed the same
 * bare "size, finish" label. This backfills the pattern — decoded from the
 * authoritative image filename / vendor_sku by scrapers/daltile-mosaic-pattern.cjs
 * — into `variant_name` and the `pattern` sku_attribute.
 *
 * Trims are skipped, patterns already present in the name are left alone, and
 * the old variant_name/pattern value is dumped to a backup JSON first so the run
 * is fully revertible.
 *
 * Usage:
 *   node backend/scripts/daltile-enrich-mosaic-patterns.cjs --dry-run
 *   node backend/scripts/daltile-enrich-mosaic-patterns.cjs
 *   node backend/scripts/daltile-enrich-mosaic-patterns.cjs --revert <backup.json>
 */
const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');
const { resolveMosaicPattern } = require('../scrapers/daltile-mosaic-pattern.cjs');

const pool = new Pool({
  host: process.env.DB_HOST || process.env.PGHOST || 'localhost',
  port: parseInt(process.env.DB_PORT || process.env.PGPORT || '5432'),
  database: process.env.DB_NAME || process.env.PGDATABASE || 'flooring_pim',
  user: process.env.DB_USER || process.env.PGUSER || 'postgres',
  password: process.env.DB_PASSWORD || process.env.PGPASSWORD || 'postgres',
});

const DRY_RUN = process.argv.includes('--dry-run');
const revertIdx = process.argv.indexOf('--revert');
const REVERT_FILE = revertIdx !== -1 ? process.argv[revertIdx + 1] : null;
const DATA_DIR = path.join(__dirname, '..', 'data');
const PATTERN_ATTR_SLUG = 'pattern';

async function revert(file) {
  const changes = JSON.parse(fs.readFileSync(file, 'utf8'));
  const attrId = (await pool.query(`SELECT id FROM attributes WHERE slug = $1`, [PATTERN_ATTR_SLUG])).rows[0]?.id;
  console.log(`Reverting ${changes.length} variant-name changes from ${path.basename(file)}...`);
  for (const c of changes) {
    await pool.query(`UPDATE skus SET variant_name = $1 WHERE id = $2`, [c.old_variant_name, c.sku_id]);
    if (attrId) {
      if (c.old_pattern === null) {
        await pool.query(`DELETE FROM sku_attributes WHERE sku_id = $1 AND attribute_id = $2`, [c.sku_id, attrId]);
      } else {
        await pool.query(
          `INSERT INTO sku_attributes (sku_id, attribute_id, value) VALUES ($1, $2, $3)
           ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value = EXCLUDED.value`,
          [c.sku_id, attrId, c.old_pattern]
        );
      }
    }
  }
  console.log(`Reverted ${changes.length} rows.`);
  await pool.end();
}

async function main() {
  if (REVERT_FILE) return revert(REVERT_FILE);

  console.log(`\nDaltile Mosaic Pattern Enrichment${DRY_RUN ? ' (DRY RUN)' : ''}\n`);

  const attrId = (await pool.query(`SELECT id FROM attributes WHERE slug = $1`, [PATTERN_ATTR_SLUG])).rows[0]?.id;
  if (!attrId) throw new Error(`No '${PATTERN_ATTR_SLUG}' attribute defined`);

  // Every active Daltile mosaic SKU: primary image marked _Msc_, or a product
  // named "…mosaic…". Carry the current pattern attribute value for backup.
  const { rows } = await pool.query(`
    SELECT s.id AS sku_id, s.vendor_sku, s.variant_name,
           p.name AS product_name,
           (SELECT ma.url FROM media_assets ma
              WHERE ma.sku_id = s.id AND ma.asset_type = 'primary' LIMIT 1) AS image_url,
           (SELECT sa.value FROM sku_attributes sa
              WHERE sa.sku_id = s.id AND sa.attribute_id = $1 LIMIT 1) AS old_pattern
    FROM skus s
    JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id
    WHERE v.code = 'DAL' AND s.status = 'active'
      AND (
        p.name ILIKE '%mosaic%'
        OR EXISTS (SELECT 1 FROM media_assets ma
                   WHERE ma.sku_id = s.id AND ma.asset_type = 'primary' AND ma.url ILIKE '%\\_Msc\\_%')
      )
  `, [attrId]);
  console.log(`Active Daltile mosaic SKUs examined: ${rows.length}`);

  const changes = [];
  const byPattern = {};
  for (const row of rows) {
    const pattern = resolveMosaicPattern({
      vendorSku: row.vendor_sku,
      imageUrl: row.image_url,
      currentName: row.variant_name,
      productName: row.product_name,
    });
    if (!pattern) continue;
    const base = (row.variant_name || '').trim();
    const newName = base ? `${base}, ${pattern}` : pattern;
    byPattern[pattern] = (byPattern[pattern] || 0) + 1;
    changes.push({
      sku_id: row.sku_id,
      vendor_sku: row.vendor_sku,
      old_variant_name: row.variant_name,
      new_variant_name: newName,
      old_pattern: row.old_pattern === undefined ? null : row.old_pattern,
      pattern,
    });
  }

  console.log(`\n=== Patterns to add (${changes.length} SKUs) ===`);
  for (const [p, n] of Object.entries(byPattern).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(3)}  ${p}`);
  }

  console.log('\n=== Examples (vendor_sku | old → new) ===');
  for (const c of changes.slice(0, 12)) {
    console.log(`  ${c.vendor_sku}:  "${c.old_variant_name || ''}"  →  "${c.new_variant_name}"`);
  }

  if (changes.length === 0) { console.log('\nNothing to enrich.'); await pool.end(); return; }

  if (DRY_RUN) {
    console.log('\nDRY RUN — no changes written. Re-run without --dry-run to apply.');
    await pool.end();
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(DATA_DIR, `daltile-mosaic-pattern-backup-${stamp}.json`);
  fs.writeFileSync(backupPath, JSON.stringify(changes, null, 2));
  console.log(`\nBackup written: ${path.relative(process.cwd(), backupPath)}`);

  const client = await pool.connect();
  let applied = 0;
  try {
    await client.query('BEGIN');
    for (const c of changes) {
      await client.query(`UPDATE skus SET variant_name = $1 WHERE id = $2`, [c.new_variant_name, c.sku_id]);
      await client.query(
        `INSERT INTO sku_attributes (sku_id, attribute_id, value) VALUES ($1, $2, $3)
         ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value = EXCLUDED.value`,
        [c.sku_id, attrId, c.pattern]
      );
      applied++;
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  console.log(`Applied ${applied} mosaic pattern names.`);
  console.log(`Revert with: node backend/scripts/daltile-enrich-mosaic-patterns.cjs --revert ${path.relative(process.cwd(), backupPath)}`);
  await pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
