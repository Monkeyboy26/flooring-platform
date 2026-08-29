/**
 * daltile-fix-dead-images-2026-08.mjs
 *
 * Fixes from a full Daltile image-durability sweep (2026-08-29): of 2,552 distinct
 * hotlinked URLs (2,393 scene7 + 159 digitalassets), 21 were dead (scene7 403s +
 * digitalassets 404s). Coverage was otherwise 99.6% with no placeholder images.
 *
 * Actions (all URLs verified live before inclusion):
 *  1. REPLACE 10 dead PRIMARY urls:
 *     - Quartetto QU01-QU08 8x8: Daltile renamed the assets — current swatches come
 *       from the Coveo product API keyed by our exact vendor_skus
 *       (DAL_QU0x_8x8_<Color>_MT_ScanPanel_01).
 *     - Rekindle RK13 12x24 + 24x48: dead digitalassets renditions → the scene7 twin
 *       Coveo maps BOTH skus to (DAL_RK13_12x24_MediumGrey_Grid).
 *  2. ADD 2 primaries for imageless Elemental Selection slabs CM57/CM58 — Coveo's
 *     digitalassets renditions are dead but the scene7 twins are live
 *     (PAN_CM57_Sunstone_6mm_Slab_01 / PAN_CM58_SmokedGeode_6mm_Slab_01).
 *  3. DELETE the remaining dead-URL rows (36 lifestyle extras: a retired Advantage
 *     roomscene rendition + Mesmerist short-code assets) — every affected SKU keeps
 *     at least one other live image.
 *
 * Left alone: 21 imageless sundries/trim (Bostik/Rubi/Primo/Noble 9999* codes not on
 * daltile.com; Marble Attache Lavish deco = "No-Series-Image-Available" placeholder;
 * Median bullnose = generic trim diagram the catalog scraper deliberately filters).
 *
 *   node backend/scripts/daltile-fix-dead-images-2026-08.mjs            # dry run
 *   node backend/scripts/daltile-fix-dead-images-2026-08.mjs --commit   # apply
 */
import pg from 'pg';
const COMMIT = process.argv.includes('--commit');
const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});
const DAL = '550e8400-e29b-41d4-a716-446655440003';
const S7 = 'https://s7d9.scene7.com/is/image/daltile/';

// vendor_sku -> live replacement primary URL
const REPLACE = {
  QU01SQU88MT: `${S7}DAL_QU01_8x8_Talco_MT_ScanPanel_01`,
  QU02SQU88MT: `${S7}DAL_QU02_8x8_Ambra_MT_ScanPanel_01`,
  QU03SQU88MT: `${S7}DAL_QU03_8x8_Pomice_MT_ScanPanel_01`,
  QU04SQU88MT: `${S7}DAL_QU04_8x8_Terra_MT_ScanPanel_01`,
  QU05SQU88MT: `${S7}DAL_QU05_8x8_Cobalto_MT_ScanPanel_01`,
  QU06SQU88MT: `${S7}DAL_QU06_8x8_Basalto_MT_ScanPanel_01`,
  QU07SQU88MT: `${S7}DAL_QU07_8x8_Ocra_MT_ScanPanel_01`,
  QU08SQU88MT: `${S7}DAL_QU08_8x8_Cadmio_MT_ScanPanel_01`,
  RK13RCT1224XTMT: `${S7}DAL_RK13_12x24_MediumGrey_Grid`,
  RK13RCT2448XTMT: `${S7}DAL_RK13_12x24_MediumGrey_Grid`,
};
// vendor_sku -> new primary for imageless SKUs
const ADD = {
  CM57SL63126MT6: `${S7}PAN_CM57_Sunstone_6mm_Slab_01`,
  CM58SL63126MT6: `${S7}PAN_CM58_SmokedGeode_6mm_Slab_01`,
};
// dead URLs confirmed 403/404 in the sweep (delete any remaining rows carrying them)
const DEAD = [
  `${S7}DAL_QU01_8x8_Talco`, `${S7}DAL_QU02_8x8_Ambra_4up`, `${S7}DAL_QU03_8x8_Pomice_4up`,
  `${S7}DAL_QU04_8x8_Terra`, `${S7}DAL_QU05_8x8_Cobalto_4up`, `${S7}DAL_QU06_8x8_Basalto_4up`,
  `${S7}DAL_QU07_8x8_Ocra_4up`, `${S7}DAL_QU08_8x8_Cadimo`,
  `${S7}DAL_MM30_Arabesque`, `${S7}DAL_MM30_Hex`, `${S7}DAL_MM31_Hex`, `${S7}DAL_MM32_Arabesque`,
  `${S7}DAL_MM32_Hex`, `${S7}DAL_MM33_Arabesque`, `${S7}DAL_MM34_Arabesque`, `${S7}DAL_MM34_Hex`,
  `${S7}DAL_MM35_Arabesque`, `${S7}DAL_MM35_Hex`,
  'https://digitalassets.daltile.com/content/dam/Daltile/DAL_images/c-f-advantage/roomscenes/MZ_Arenella_RES_01_web.jpg/jcr:content/renditions/cq5dam.web.570.570.jpeg',
  'https://digitalassets.daltile.com/content/dam/Daltile/DAL_images/rekindle/web/DAL_RK13_12x24_MediumGrey_Grid.jpg/jcr:content/renditions/cq5dam.web.1280.1280.jpeg',
  'https://digitalassets.daltile.com/content/dam/Daltile/DAL_images/rekindle/web/DAL_RK13_24x48_MediumGrey_Grid.jpg/jcr:content/renditions/cq5dam.web.1280.1280.jpeg',
];

console.log(`=== Daltile dead-image fix — ${COMMIT ? 'COMMIT' : 'DRY RUN'} ===`);

// counts
const { rows: [c1] } = await pool.query(`
  SELECT COUNT(*) n FROM media_assets ma JOIN skus s ON s.id=ma.sku_id JOIN products p ON p.id=s.product_id
  WHERE p.vendor_id=$1 AND s.vendor_sku = ANY($2) AND ma.asset_type='primary' AND ma.url = ANY($3)`,
  [DAL, Object.keys(REPLACE), DEAD]);
const { rows: addTargets } = await pool.query(`
  SELECT s.id sku_id, s.product_id, s.vendor_sku FROM skus s JOIN products p ON p.id=s.product_id
  WHERE p.vendor_id=$1 AND s.vendor_sku = ANY($2) AND s.status='active'
    AND NOT EXISTS (SELECT 1 FROM media_assets m WHERE m.sku_id=s.id)`, [DAL, Object.keys(ADD)]);
const { rows: [c3] } = await pool.query(`
  SELECT COUNT(*) n, COUNT(DISTINCT ma.sku_id) skus FROM media_assets ma WHERE ma.url = ANY($1)`, [DEAD]);
console.log(`1. replace dead primaries: ${c1.n} rows (${Object.keys(REPLACE).length} skus targeted)`);
console.log(`2. add primaries to imageless slabs: ${addTargets.length} skus`);
console.log(`3. delete remaining dead-url rows: up to ${c3.n} rows across ${c3.skus} skus (post-replace)`);

if (!COMMIT) { console.log('\nDry run — re-run with --commit to apply.'); await pool.end(); process.exit(0); }

const client = await pool.connect();
try {
  await client.query('BEGIN');
  // 1. replace
  let rep = 0;
  for (const [vsku, url] of Object.entries(REPLACE)) {
    const r = await client.query(`
      UPDATE media_assets ma SET url=$3, original_url=$3
      FROM skus s, products p
      WHERE ma.sku_id=s.id AND s.product_id=p.id AND p.vendor_id=$1
        AND s.vendor_sku=$2 AND ma.asset_type='primary' AND ma.url = ANY($4)
      RETURNING ma.id`, [DAL, vsku, url, DEAD]);
    rep += r.rowCount;
  }
  console.log(`Replaced ${rep} primary urls`);
  // 2. add
  for (const t of addTargets) {
    await client.query(`
      INSERT INTO media_assets (id, product_id, sku_id, asset_type, url, original_url, sort_order, created_at, source)
      VALUES (gen_random_uuid(), $1, $2, 'primary', $3, $3, 0, now(), 'coveo-scene7-fix')`,
      [t.product_id, t.sku_id, ADD[t.vendor_sku]]);
  }
  console.log(`Added ${addTargets.length} slab primaries`);
  // 3. delete remaining dead rows
  const del = await client.query(`DELETE FROM media_assets WHERE url = ANY($1) RETURNING id`, [DEAD]);
  console.log(`Deleted ${del.rowCount} dead-url rows`);
  await client.query('COMMIT');
} catch (e) {
  await client.query('ROLLBACK'); console.error('ROLLBACK:', e.message); process.exit(1);
} finally { client.release(); }

// refresh affected products' search vectors
const { rows: prods } = await pool.query(`
  SELECT DISTINCT p.id FROM products p JOIN skus s ON s.product_id=p.id
  WHERE p.vendor_id=$1 AND (s.vendor_sku = ANY($2))`,
  [DAL, [...Object.keys(REPLACE), ...Object.keys(ADD)]]);
for (const r of prods) await pool.query('SELECT refresh_search_vectors($1)', [r.id]).catch(() => {});
console.log(`Refreshed search vectors (${prods.length} products)`);
await pool.end();
console.log('=== done ===');
