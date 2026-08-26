#!/usr/bin/env node
/**
 * emser-titlecase-variant-colors.cjs
 *
 * Emser's 832 feed sends colors ALL-CAPS, so skus.variant_name reads
 * "PATH 24x47" while the color attribute is already clean ("Path"). Title-case
 * the alpha words in the variant_name (leaving dimension tokens) so every
 * surface — cart, invoices, docs — shows "Path 24x47". The scraper now does this
 * at import (emser-832.js); this backfills existing rows. Dry-run by default.
 *
 * Usage: node backend/scripts/emser-titlecase-variant-colors.cjs [--apply]
 */
const { Pool } = require('pg');
const pool = new Pool({ host:'localhost', port:5432, database:'flooring_pim', user:'postgres', password:'postgres' });
const APPLY = process.argv.includes('--apply');
const titleCase = s => s.replace(/\b\w+/g, w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());

(async () => {
  const TILE = ['porcelain-tile','ceramic-tile','mosaic-tile','natural-stone','tile','stacked-stone','porcelain-slabs','wood-look-tile','large-format-tile'];
  const v = (await pool.query("SELECT id FROM vendors WHERE code='EMS'")).rows[0].id;
  // Tile only — sundry variant codes ("PVC", "SST") must keep their casing.
  const rows = (await pool.query(
    `SELECT s.id, s.variant_name FROM skus s
       JOIN products p ON p.id=s.product_id JOIN categories c ON c.id=p.category_id
      WHERE p.vendor_id=$1 AND c.slug = ANY($2) AND s.variant_name IS NOT NULL
        AND s.variant_name ~ '[A-Z]{2,}'`, [v, TILE])).rows;
  const changes = rows.map(r => ({ id: r.id, from: r.variant_name, to: titleCase(r.variant_name) }))
                      .filter(c => c.from !== c.to);
  console.log(`\n=== Emser variant_name title-case ${APPLY ? '(APPLY)' : '(DRY RUN)'} ===`);
  console.log(`${changes.length} variant_names to fix (of ${rows.length} all-caps candidates)\n`);
  changes.slice(0, 20).forEach(c => console.log(`   "${c.from}"  →  "${c.to}"`));
  if (changes.length > 20) console.log(`   … +${changes.length - 20} more`);
  if (APPLY) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const c of changes) await client.query('UPDATE skus SET variant_name=$1 WHERE id=$2', [c.to, c.id]);
      await client.query('COMMIT');
      console.log(`\nApplied ${changes.length}.\n`);
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  } else console.log(`\n(DRY RUN — re-run with --apply)\n`);
  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
