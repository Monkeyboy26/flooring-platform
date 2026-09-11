/**
 * WPT hand-curated image sets for "problem" collections.
 *
 * A few WPT collections are fabric/subway/deco field tiles whose Ecwid gallery
 * mixes the plain FIELD swatch with a coordinating MOSAIC (basketweave) sheet, a
 * bullnose TRIM liner, a harlequin wall deco, room scenes, and near-duplicate
 * re-uploads. Aspect-ratio ranking can't tell a square field swatch from a square
 * mosaic, or a 3x12 field panel from a same-width trim — so the automated pass
 * picks mosaics / trim as primary. Pixel stats can't separate trim from marble
 * either. These are curated by hand (verified against the images).
 *
 * KEEP-ONLY semantics: the listed images are the ENTIRE gallery, in order
 * (index 0 = primary). Everything else on the product — mosaic, trim, deco, and
 * duplicate swatches — is deleted. kind: 'field' → primary/alternate,
 * 'scene' → lifestyle.
 *
 * Run AFTER fix-wpt-image-primaries.mjs. Idempotent, dry-run default, --apply
 * writes a JSON backup.
 *   node backend/scripts/fix-wpt-curated-primaries.mjs [--apply]
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

// name → { folder, keep: [[imageId, kind]] }  (image ids are CloudFront stems)
const CURATED = {
  // Craft — fabric-look 12x24 field tiles (drop basketweave mosaic + trim + dup swatch)
  'Craft Cotton': { folder: '377371128', keep: [['2418856408', 'field'], ['2418865346', 'scene']] },
  'Craft Quilt':  { folder: '377445947', keep: [['2419257072', 'field']] },
  'Craft Rope':   { folder: '377375194', keep: [['2418940853', 'field'], ['2419250295', 'scene']] },
  'Craft Wool':   { folder: '377461287', keep: [['2419266263', 'field']] },
  'Craft Yarn':   { folder: '377455568', keep: [['2419250417', 'field']] },
  // Teramoda — subway/brick 3x12 field tiles (drop trim liner + harlequin deco + dup swatch)
  'Teramoda Bamboo': { folder: null, keep: [['2722133365', 'field']] },
  'Teramoda Powder': { folder: '416136868', keep: [['2722141187', 'field'], ['2722141227', 'scene']] },
  'Teramoda Sky':    { folder: null, keep: [['2722139548', 'field']] },
  'Teramoda Stone':  { folder: null, keep: [['2722153759', 'field']] },
};

const CF = (folder, id) => folder
  ? `https://d2j6dbq0eux0bg.cloudfront.net/images/15639056/products/${folder}/${id}.jpg`
  : `https://d2j6dbq0eux0bg.cloudfront.net/images/15639056/${id}.jpg`;
const assetType = (kind, i) => i === 0 ? 'primary' : kind === 'scene' ? 'lifestyle' : 'alternate';

async function main() {
  const vendor = (await pool.query(
    `SELECT id FROM vendors WHERE LOWER(name) LIKE '%western pacific%' OR code='807' LIMIT 1`)).rows[0];
  if (!vendor) throw new Error('WPT vendor not found');

  const plan = [];
  for (const [name, spec] of Object.entries(CURATED)) {
    const prod = (await pool.query(
      `SELECT id FROM products WHERE vendor_id=$1 AND name=$2 LIMIT 1`, [vendor.id, name])).rows[0];
    if (!prod) { console.log(`  ! ${name} not found — skipping`); continue; }
    const skuId = (await pool.query(
      `SELECT sku_id FROM media_assets WHERE product_id=$1 AND sku_id IS NOT NULL LIMIT 1`, [prod.id])).rows[0]?.sku_id
      || (await pool.query(`SELECT id FROM skus WHERE product_id=$1 LIMIT 1`, [prod.id])).rows[0]?.id || null;
    const existing = (await pool.query(`SELECT url, original_url FROM media_assets WHERE product_id=$1`, [prod.id])).rows;
    const mirrorFor = new Map();
    for (const e of existing) if (String(e.url).startsWith('/uploads/mirror/')) mirrorFor.set(e.original_url, e.url);

    const rows = spec.keep.map(([id, kind], i) => {
      const src = CF(spec.folder, id);
      return { url: mirrorFor.get(src) || src, original_url: src, asset_type: assetType(kind, i), sort_order: i, kind };
    });
    plan.push({ product_id: prod.id, sku_id: skuId, name, rows, oldCount: existing.length });
  }

  for (const c of plan) {
    console.log(`  ${c.name}: ${c.oldCount}→${c.rows.length} imgs · primary(${c.rows[0].kind}) ${c.rows[0].original_url.split('/').pop()}`);
  }
  if (!APPLY) { console.log('\nDry run — pass --apply to commit.'); await pool.end(); return; }

  fs.writeFileSync(path.join(__dirname, '..', 'data', `wpt-curated-primaries-backup-${Date.now()}.json`),
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
    console.log(`\n✓ Curated ${plan.length} products.`);
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); await pool.end(); }
}
main().catch(e => { console.error(e); process.exit(1); });
