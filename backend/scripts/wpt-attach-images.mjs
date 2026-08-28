/**
 * wpt-attach-images.mjs
 *
 * Western Pacific Tile moved their Ecwid store behind dealer auth, so the old public
 * API token (in scrapers/wpt.js) 403s and image coverage collapsed to ~8%. The current
 * storefront still renders publicly via Ecwid's storefront API v1
 * (us-*-storefront-api.ecwid.com/storefront/api/v1/15639056/catalog), which returns
 * per-product CloudFront image URLs. Those were harvested (188 products) into
 * data/wpt/wpt-images.json. This attaches them to WPT SKUs by product name (the DB
 * vendor_sku is a WPT code, not the Ecwid id — so match on name).
 *
 * Hotlinks the vendor CDN URL (consistent with the platform's pure-hotlink images).
 *
 *   node backend/scripts/wpt-attach-images.mjs            # dry run
 *   node backend/scripts/wpt-attach-images.mjs --commit   # apply
 */
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COMMIT = process.argv.includes('--commit');
const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

const norm = s => (s||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const items = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/wpt/wpt-images.json'), 'utf8'));
const imgByName = new Map(items.map(x => [norm(x.name), x.img]));

const { rows: v } = await pool.query("SELECT id FROM vendors WHERE code='807' AND name ILIKE '%western pacific%'");
if (!v.length) { console.error('WPT vendor not found'); process.exit(1); }
const vendorId = v[0].id;

// active WPT SKUs with their product name + whether they already have an image
const { rows: skus } = await pool.query(`
  SELECT s.id sku_id, s.product_id, p.name,
    EXISTS(SELECT 1 FROM media_assets ma WHERE ma.sku_id=s.id) has_img
  FROM products p JOIN skus s ON s.product_id=p.id
  WHERE p.vendor_id=$1 AND s.status='active'`, [vendorId]);

let matched = 0, toAttach = [], noMatch = new Set();
for (const s of skus) {
  const img = imgByName.get(norm(s.name));
  if (!img) { if (!s.has_img) noMatch.add(s.name); continue; }
  matched++;
  if (!s.has_img) toAttach.push({ sku_id: s.sku_id, product_id: s.product_id, img });
}
console.log(`=== WPT attach images — ${COMMIT ? 'COMMIT' : 'DRY RUN'} ===`);
console.log(`Harvested products: ${items.length} | active SKUs: ${skus.length}`);
console.log(`SKUs whose product name matches a harvested image: ${matched}`);
console.log(`Imageless SKUs that will get an image: ${toAttach.length}`);
console.log(`Imageless SKUs with NO harvested match: ${noMatch.size}${noMatch.size ? ' — e.g. ' + [...noMatch].slice(0,8).join(', ') : ''}`);

if (!COMMIT) { console.log('\nDry run — re-run with --commit to apply.'); await pool.end(); process.exit(0); }

let n = 0;
for (const a of toAttach) {
  await pool.query(`
    INSERT INTO media_assets (id, product_id, sku_id, asset_type, url, original_url, sort_order, created_at, source)
    VALUES (gen_random_uuid(), $1, $2, 'primary', $3, $3, 0, now(), 'ecwid-storefront-v1')`,
    [a.product_id, a.sku_id, a.img]);
  n++;
}
console.log(`Attached ${n} primary images`);
const { rows: prods } = await pool.query('SELECT DISTINCT product_id FROM skus s JOIN products p ON p.id=s.product_id WHERE p.vendor_id=$1', [vendorId]);
for (const r of prods) await pool.query('SELECT refresh_search_vectors($1)', [r.product_id]).catch(()=>{});
console.log('Done.');
await pool.end();
