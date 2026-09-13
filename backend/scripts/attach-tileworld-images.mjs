#!/usr/bin/env node
/**
 * Attach Tile World photos to EXISTING products — no purge, no reimport.
 *
 * import-tileworld.js is a full purge-and-rebuild (drops cart_items, changes product
 * ids), so it must not be re-run just to pick up newly matched images. This script
 * reads catalog.json + images.json (rebuilt by build-tileworld-catalog.js, which now
 * carries the SITE_ALIAS map for the sheet↔site spelling drift) and only upserts
 * media_assets rows (+ the color attr the site match provides) onto the products
 * already in the DB, located by their skus' internal_sku. Idempotent — same ON
 * CONFLICT upserts as the importer.
 *
 * Usage: DB_PASSWORD=postgres node scripts/attach-tileworld-images.mjs
 */
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.TWD_DATA_DIR || path.join(__dirname, '..', 'data', 'tileworld');
const catalog = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'catalog.json'), 'utf8'));
const images = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'images.json'), 'utf8'));
const SOURCE = 'tileworldusa.com';

async function productMedia(productId, url, assetType, sortOrder) {
  if (!url) return;
  await pool.query(`
    INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order, source)
    VALUES ($1,NULL,$2,$3,$3,$4,$5)
    ON CONFLICT (product_id, asset_type, sort_order) WHERE sku_id IS NULL
    DO UPDATE SET url=EXCLUDED.url, original_url=EXCLUDED.original_url, source=EXCLUDED.source`,
    [productId, assetType, url, sortOrder, SOURCE]);
}
async function skuMedia(productId, skuId, url, assetType, sortOrder) {
  if (!url) return;
  await pool.query(`
    INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order, source)
    VALUES ($1,$2,$3,$4,$4,$5,$6)
    ON CONFLICT (product_id, sku_id, asset_type, sort_order) WHERE sku_id IS NOT NULL
    DO UPDATE SET url=EXCLUDED.url, original_url=EXCLUDED.original_url, source=EXCLUDED.source`,
    [productId, skuId, assetType, url, sortOrder, SOURCE]);
}
async function setColor(skuId, value) {
  if (!value) return;
  await pool.query(`
    INSERT INTO sku_attributes (sku_id, attribute_id, value)
    SELECT $1, id, $2 FROM attributes WHERE slug='color'
    ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value=EXCLUDED.value`,
    [skuId, String(value).trim()]);
}

async function main() {
  let attached = 0, skippedHasImage = 0, notFound = 0, skuImgs = 0;
  for (const p of catalog.products) {
    const im = images[p.pkey];
    if (!im) continue;

    // locate the DB product + sku ids via internal_sku (importer format: `${pkey}-${suffix}`)
    const internals = p.skus.map((s) => `${p.pkey}-${s.suffix}`.replace(/-+/g, '-').replace(/-$/, ''));
    const r = await pool.query(
      `SELECT s.id, s.internal_sku, s.product_id FROM skus s WHERE s.internal_sku = ANY($1)`, [internals]);
    if (!r.rows.length) { notFound++; console.warn(`  ! no DB skus for ${p.pkey}`); continue; }
    const productId = r.rows[0].product_id;
    const skuByInternal = new Map(r.rows.map((row) => [row.internal_sku, row.id]));

    const has = await pool.query(
      `SELECT 1 FROM media_assets WHERE product_id=$1 AND asset_type='primary' LIMIT 1`, [productId]);
    if (has.rows.length) { skippedHasImage++; continue; }   // already imaged — leave untouched

    if (im.product && im.product.primary) await productMedia(productId, im.product.primary, 'primary', 0);
    for (const s of p.skus) {
      const internal = `${p.pkey}-${s.suffix}`.replace(/-+/g, '-').replace(/-$/, '');
      const skuId = skuByInternal.get(internal);
      if (!skuId) continue;
      const sim = im.skus && im.skus[s.suffix];
      if (sim && sim.primary) { await skuMedia(productId, skuId, sim.primary, 'primary', 0); skuImgs++; }
      await setColor(skuId, p.color);
    }
    attached++;
    console.log(`  + ${p.pkey}`);
  }
  console.log(`\nAttached ${attached} products (${skuImgs} sku photos); ${skippedHasImage} already imaged; ${notFound} not in DB.`);
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
