/**
 * Backfill the Stanza (hidden vendor, public code 563) rename onto existing rows.
 *
 * The original import used the PDF's bare color names as product names ("Tan",
 * "Tiger") and prefixed every collection with "Stanza" — leaking a publicly
 * hidden vendor and leaving meaningless card titles. build-stanza-catalog.js
 * now emits the hidden-vendor convention ("Tan Flat Indonesian Stone Mosaic",
 * collection "Flat Indonesian Stone Mosaic"); this script maps the regenerated
 * catalog.json onto the live rows by internal_sku (stable across the rename —
 * the import's product upsert conflicts on vendor+collection+name, so a plain
 * re-import would duplicate instead of rename).
 *
 * Per product/SKU:
 *   - products: name, collection, description_short, description_long
 *   - skus: variant_name (now the color, not the old product name)
 *   - sku_attributes: color + collection values refreshed; `brand` DELETED
 *     (PDP spec table renders every sku_attribute — "Stanza" must not show)
 *
 * Idempotent. Usage: node backend/scripts/fix-stanza-names.mjs [--dry-run]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASS || 'postgres',
});

const DRY_RUN = process.argv.includes('--dry-run');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const catalog = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'stanza', 'catalog.json'), 'utf8'));

async function main() {
  let renamed = 0, skipped = 0, missing = 0, brandAttrsDeleted = 0;
  for (const p of catalog) {
    const sku = p.skus[0];
    const r = await pool.query(
      `SELECT s.id AS sku_id, s.product_id, s.variant_name, pr.name, pr.collection
         FROM skus s JOIN products pr ON pr.id = s.product_id
        WHERE s.internal_sku = $1`, [sku.internal_sku]);
    if (!r.rows.length) { console.warn('  ! no sku row for', sku.internal_sku); missing++; continue; }
    const row = r.rows[0];

    const changes = row.name !== p.name || row.collection !== p.collection || row.variant_name !== sku.variant_name;
    if (changes) {
      console.log(`  ${sku.internal_sku}: "${row.name}" → "${p.name}"`);
      renamed++;
    } else {
      skipped++;
    }
    if (DRY_RUN) continue;

    await pool.query(
      `UPDATE products SET name=$1, collection=$2, description_short=$3, description_long=$4, updated_at=CURRENT_TIMESTAMP
        WHERE id=$5`,
      [p.name, p.collection, (p.description || '').slice(0, 250), p.description, row.product_id]);
    await pool.query(`UPDATE skus SET variant_name=$1, updated_at=CURRENT_TIMESTAMP WHERE id=$2`,
      [sku.variant_name, row.sku_id]);
    for (const [slug, value] of [['color', p.attrs.color], ['collection', p.attrs.collection]]) {
      await pool.query(
        `UPDATE sku_attributes sa SET value=$1
           FROM attributes a WHERE a.id=sa.attribute_id AND a.slug=$2 AND sa.sku_id=$3`,
        [String(value), slug, row.sku_id]);
    }
    const del = await pool.query(
      `DELETE FROM sku_attributes sa USING attributes a
        WHERE a.id=sa.attribute_id AND a.slug='brand' AND sa.sku_id=$1`, [row.sku_id]);
    brandAttrsDeleted += del.rowCount;
  }
  console.log(`\n${DRY_RUN ? '[dry-run] ' : ''}renamed: ${renamed}, already-correct: ${skipped}, missing: ${missing}, brand attrs deleted: ${brandAttrsDeleted}`);
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
