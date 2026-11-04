#!/usr/bin/env node
// One-off, idempotent: enrich BARE Mannington (MANN) flooring variant_names with
// their size, so every SKU reads consistently ("Acorn, 5mm x 7.1" x 48"") instead
// of a lone color ("Acorn"). Mirrors the format the rest of the catalog already uses.
//
// "Bare" = variant_name carries no dimension (no 'x'/'X'); these are mostly the
// ADURA PRO (SPC / Loose Lay) and hardwood lines whose importer left the name as
// color-only. Appends ", {size attr}".
//
// Duplication guards:
//   * Skip if the size string already appears in the name (idempotent re-runs).
//   * Collision safety net: if a proposed name would collide with any OTHER active
//     SKU in the same product (current or proposed), append the distinguishing
//     sub_line; if that still collides, fall back to "({vendor_sku})" (always unique).
//     (Verified 0 collisions on both envs at write time — this is defensive.)
//
// Usage:  node mannington-enrich-bare-variant-names-2026-11-04.mjs [--apply]
// Dry-run by default. Creates a one-time backup table on --apply.

import pg from 'pg';

const APPLY = process.argv.includes('--apply');
const MANN = 'dabbf50b-c1ed-4e81-8bf1-c1ac88a5a4bd';
const BACKUP = 'variant_name_mann_bare_enrich_backup_20261104';
const MAX_LEN = 120;

const pool = new pg.Pool({
  host: process.env.PGHOST || process.env.DB_HOST || 'localhost',
  port: +(process.env.PGPORT || process.env.DB_PORT || 5432),
  user: process.env.PGUSER || process.env.DB_USER || 'postgres',
  password: process.env.PGPASSWORD || process.env.DB_PASSWORD || 'postgres',
  database: process.env.PGDATABASE || process.env.DB_NAME || 'flooring_pim',
});

const clip = (s) => s.length > MAX_LEN ? s.slice(0, MAX_LEN) : s;
const has = (base, seg) => base.toLowerCase().includes(String(seg).trim().toLowerCase());
const append = (base, seg) => has(base, seg) ? base : clip(`${base}, ${String(seg).trim()}`);

async function main() {
  // All active flooring SKUs for MANN, with size/sub_line, grouped per product so we
  // can enforce uniqueness against the full sibling set (enriched + newly-proposed).
  const { rows } = await pool.query(`
    SELECT s.id, s.product_id, s.variant_name, s.vendor_sku,
      (SELECT sa.value FROM sku_attributes sa JOIN attributes a ON a.id=sa.attribute_id
         WHERE sa.sku_id=s.id AND a.slug='size' LIMIT 1) AS size,
      (SELECT sa.value FROM sku_attributes sa JOIN attributes a ON a.id=sa.attribute_id
         WHERE sa.sku_id=s.id AND a.slug='sub_line' LIMIT 1) AS sub_line
    FROM skus s JOIN products p ON p.id=s.product_id
    WHERE p.vendor_id=$1 AND s.status='active' AND COALESCE(s.variant_type,'')!='accessory'`,
    [MANN]);

  const byProduct = new Map();
  for (const r of rows) {
    if (!byProduct.has(r.product_id)) byProduct.set(r.product_id, []);
    byProduct.get(r.product_id).push(r);
  }

  const isBare = (r) => r.variant_name && !/[xX]/.test(r.variant_name) && r.size;
  const changes = []; // { id, before, after, via }

  for (const group of byProduct.values()) {
    // Seed the taken-name set with every SKU's CURRENT name (lowercased).
    const taken = new Map(); // lower(name) -> count
    const bump = (n) => taken.set(n.toLowerCase(), (taken.get(n.toLowerCase()) || 0) + 1);
    const free = (n) => taken.set(n.toLowerCase(), (taken.get(n.toLowerCase()) || 1) - 1);
    for (const r of group) bump(r.variant_name || '');

    for (const r of group) {
      if (!isBare(r)) continue;
      free(r.variant_name);                         // this SKU is being renamed
      let next = append(r.variant_name, r.size);    // "Color, {size}"
      let via = 'size';
      if ((taken.get(next.toLowerCase()) || 0) > 0) {
        if (r.sub_line && !has(next, r.sub_line)) { next = append(next, r.sub_line); via = 'size+sub_line'; }
      }
      if ((taken.get(next.toLowerCase()) || 0) > 0 && r.vendor_sku) {
        next = append(next, `(${r.vendor_sku})`); via += '+vendor_sku';
      }
      bump(next);
      if (next !== r.variant_name) changes.push({ id: r.id, before: r.variant_name, after: next, via });
    }
  }

  console.log(`Bare MANN flooring variant_names to enrich: ${changes.length}`);
  for (const c of changes.slice(0, 10)) console.log(`  "${c.before}"  ->  "${c.after}"  [${c.via}]`);
  if (changes.length > 10) console.log(`  ... and ${changes.length - 10} more`);
  const viaCounts = changes.reduce((m, c) => (m[c.via] = (m[c.via] || 0) + 1, m), {});
  console.log('by method:', JSON.stringify(viaCounts));

  if (!APPLY) { console.log('\nDry run. Re-run with --apply to write.'); await pool.end(); return; }
  if (!changes.length) { console.log('\nNothing to do.'); await pool.end(); return; }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [{ exists }] } = await client.query(`SELECT to_regclass($1) IS NOT NULL AS exists`, [BACKUP]);
    if (!exists) {
      await client.query(
        `CREATE TABLE ${BACKUP} AS
         SELECT id AS sku_id, variant_name AS old_variant_name, now() AS backed_up_at
         FROM skus WHERE id = ANY($1)`, [changes.map(c => c.id)]);
      console.log(`Backup table ${BACKUP} created (${changes.length} rows).`);
    } else {
      console.log(`Backup table ${BACKUP} already exists — leaving as-is.`);
    }
    for (const c of changes) {
      await client.query(`UPDATE skus SET variant_name=$2, updated_at=NOW() WHERE id=$1`, [c.id, c.after]);
    }
    await client.query('COMMIT');
    console.log(`Applied: ${changes.length} variant_names enriched.`);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
