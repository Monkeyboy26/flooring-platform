/**
 * WPT "Craft" collection — pin the correct primary (plain field-tile swatch).
 *
 * The Craft fabric-look tiles ship a messy Ecwid gallery per product: the plain
 * field-tile swatch, a coordinating MOSAIC (basketweave) sheet, room scenes, a
 * bullnose TRIM piece, and brand/spec filler slides. Aspect-ratio ranking can't
 * separate the square field swatch from the square mosaic, and for Rope/Yarn a
 * room scene / trim piece has an aspect closer to the 12x24 tile than the square
 * swatch — so the automated pass picks the wrong primary ("random mosaics").
 *
 * These 5 products are curated by hand (verified against the images): primary =
 * the plain field swatch, then the other field swatch, then the mosaic, then
 * scenes/trim as lifestyle. Filler slides are already dropped by
 * fix-wpt-image-primaries.mjs; run that FIRST, then this to pin the primaries.
 *
 * Idempotent, dry-run default, --apply writes a JSON backup.
 *   node backend/scripts/fix-wpt-craft-primaries.mjs [--apply]
 */
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const APPLY = process.argv.includes('--apply');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

// Per product: ordered image ids (CloudFront filename stem, no extension).
// [0] = plain field swatch (primary); mosaics/scenes/trim follow as gallery.
// kind per index: 'field'|'mosaic'|'scene'|'trim' → asset_type mapping below.
const CRAFT = {
  'Craft Cotton': { folder: '377371128', order: [
    ['2418856408', 'field'], ['2418856418', 'mosaic'], ['2418865348', 'scene'], ['2418865346', 'scene'] ] },
  'Craft Quilt': { folder: '377445947', order: [
    ['2419257072', 'field'], ['2419257074', 'field'], ['2419262006', 'mosaic'] ] },
  'Craft Rope': { folder: '377375194', order: [
    ['2418940853', 'field'], ['2418958282', 'mosaic'], ['2419250295', 'scene'], ['2419250297', 'scene'] ] },
  'Craft Wool': { folder: '377461287', order: [
    ['2419266263', 'field'], ['2419266265', 'field'], ['2419263275', 'mosaic'] ] },
  'Craft Yarn': { folder: '377455568', order: [
    ['2419250417', 'field'], ['2419250419', 'field'], ['2419234499', 'mosaic'], ['2419262052', 'trim'] ] },
};

const CF = (folder, id) => `https://d2j6dbq0eux0bg.cloudfront.net/images/15639056/products/${folder}/${id}.jpg`;
const assetType = (kind, i) => i === 0 ? 'primary' : kind === 'scene' || kind === 'trim' ? 'lifestyle' : 'alternate';

async function main() {
  const vendor = (await pool.query(
    `SELECT id FROM vendors WHERE LOWER(name) LIKE '%western pacific%' OR code='807' LIMIT 1`)).rows[0];
  if (!vendor) throw new Error('WPT vendor not found');

  const plan = [];
  for (const [name, spec] of Object.entries(CRAFT)) {
    const prod = (await pool.query(
      `SELECT id FROM products WHERE vendor_id=$1 AND name=$2 LIMIT 1`, [vendor.id, name])).rows[0];
    if (!prod) { console.log(`  ! ${name} not found — skipping`); continue; }
    const skuId = (await pool.query(
      `SELECT sku_id FROM media_assets WHERE product_id=$1 AND sku_id IS NOT NULL LIMIT 1`, [prod.id])).rows[0]?.sku_id
      || (await pool.query(`SELECT id FROM skus WHERE product_id=$1 LIMIT 1`, [prod.id])).rows[0]?.id || null;

    // Preserve any existing local mirror url for a source.
    const existing = (await pool.query(
      `SELECT url, original_url FROM media_assets WHERE product_id=$1`, [prod.id])).rows;
    const mirrorFor = new Map();
    for (const e of existing) if (String(e.url).startsWith('/uploads/mirror/')) mirrorFor.set(e.original_url, e.url);

    const rows = spec.order.map(([id, kind], i) => {
      const src = CF(spec.folder, id);
      return { url: mirrorFor.get(src) || src, original_url: src, asset_type: assetType(kind, i), sort_order: i, kind };
    });
    plan.push({ product_id: prod.id, sku_id: skuId, name, rows });
  }

  for (const c of plan) {
    console.log(`  ${c.name}: primary(${c.rows[0].kind}) ${c.rows[0].original_url.split('/').pop()}  [${c.rows.map(r => r.kind).join(', ')}]`);
  }
  if (!APPLY) { console.log('\nDry run — pass --apply to commit.'); await pool.end(); return; }

  fs.writeFileSync(path.join(__dirname, '..', 'data', `wpt-craft-primaries-backup-${Date.now()}.json`),
    JSON.stringify({ generated_at: new Date().toISOString(), plan }, null, 2));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const c of plan) {
      await client.query('DELETE FROM media_assets WHERE product_id=$1', [c.product_id]);
      for (const r of c.rows) {
        await client.query(
          `INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [c.product_id, c.sku_id, r.asset_type, r.url, r.original_url, r.sort_order]);
      }
    }
    await client.query('COMMIT');
    console.log(`\n✓ Pinned ${plan.length} Craft product primaries.`);
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); await pool.end(); }
}
main().catch(e => { console.error(e); process.exit(1); });
