#!/usr/bin/env node
// One-off, idempotent cleanup: strip the redundant trailing ", {thickness}"
// from Mannington (MANN) flooring variant_names.
//
// Symptom: PDP H1 doubled the plank thickness, e.g.
//   "ADURA Napa Barrel, 2.5mm x 6" x 48", 2.5mm Luxury Vinyl Plank"
// The size segment already encodes the thickness ("2.5mm x 6\" x 48\""), so the
// trailing ", 2.5mm" is a duplicate. These names are STALE — produced by an
// older variantDedupe pass before appendSegment() guarded against echoing a
// value already present in the base name. Current code no longer regenerates
// them (the SKUs are already unique, so the collision query never returns them),
// so a one-time data strip is the durable fix.
//
// Safe: only touches rows whose variant_name ends with ", <thickness>" AND where
// that thickness also appears earlier in the name (the doubling signature).
// Verified to introduce no new within-product name collisions.
//
// Usage:  node mannington-strip-doubled-thickness-2026-11-03.mjs [--apply]
// Dry-run by default; pass --apply to write. Creates a one-time backup table.

import pg from 'pg';

const APPLY = process.argv.includes('--apply');
const MANN = 'dabbf50b-c1ed-4e81-8bf1-c1ac88a5a4bd';
const BACKUP = 'variant_name_mann_doubled_thickness_backup_20261103';

const pool = new pg.Pool({
  host: process.env.PGHOST || process.env.DB_HOST || 'localhost',
  port: +(process.env.PGPORT || process.env.DB_PORT || 5432),
  user: process.env.PGUSER || process.env.DB_USER || 'postgres',
  password: process.env.PGPASSWORD || process.env.DB_PASSWORD || 'postgres',
  database: process.env.PGDATABASE || process.env.DB_NAME || 'flooring_pim',
});

// Rows to fix + their cleaned name. regexp_replace strips the trailing
// ", <thickness>" (thickness dots escaped so "2.5" doesn't match greedily).
const SELECT_SQL = `
  WITH m AS (
    SELECT s.id, s.variant_name,
      (SELECT sa.value FROM sku_attributes sa JOIN attributes a ON a.id=sa.attribute_id
         WHERE sa.sku_id=s.id AND a.slug='thickness' LIMIT 1) AS thickness
    FROM skus s JOIN products p ON p.id=s.product_id
    WHERE p.vendor_id=$1 AND COALESCE(s.variant_type,'')!='accessory'
  )
  SELECT id, variant_name AS before,
         regexp_replace(variant_name, ',\\s*' || replace(thickness,'.','\\.') || '\\s*$', '') AS after
  FROM m
  WHERE thickness IS NOT NULL
    AND variant_name LIKE '%, '||thickness
    AND variant_name LIKE '%'||thickness||'%'||thickness`;

async function main() {
  const { rows } = await pool.query(SELECT_SQL, [MANN]);
  const changed = rows.filter(r => r.after !== r.before);
  console.log(`Mannington flooring SKUs with doubled trailing thickness: ${changed.length}`);
  for (const r of changed.slice(0, 8)) console.log(`  "${r.before}"  ->  "${r.after}"`);
  if (changed.length > 8) console.log(`  ... and ${changed.length - 8} more`);

  if (!APPLY) { console.log('\nDry run. Re-run with --apply to write.'); await pool.end(); return; }
  if (!changed.length) { console.log('\nNothing to do.'); await pool.end(); return; }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // One-time backup of the rows we are about to change (idempotent: skip if table exists).
    const { rows: [{ exists }] } = await client.query(
      `SELECT to_regclass($1) IS NOT NULL AS exists`, [BACKUP]);
    if (!exists) {
      await client.query(
        `CREATE TABLE ${BACKUP} AS
         SELECT id AS sku_id, variant_name AS old_variant_name, now() AS backed_up_at
         FROM skus WHERE id = ANY($1)`, [changed.map(r => r.id)]);
      console.log(`Backup table ${BACKUP} created (${changed.length} rows).`);
    } else {
      console.log(`Backup table ${BACKUP} already exists — leaving as-is.`);
    }
    for (const r of changed) {
      await client.query(
        `UPDATE skus SET variant_name=$2, updated_at=NOW() WHERE id=$1`, [r.id, r.after]);
    }
    await client.query('COMMIT');
    console.log(`Applied: ${changed.length} variant_names cleaned.`);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
