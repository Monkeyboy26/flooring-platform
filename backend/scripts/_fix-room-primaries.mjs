#!/usr/bin/env node
/**
 * Fix specific Elysium SKUs that have room-scene primary images.
 * Fetches their detail pages and re-sorts images using scoreElysiumImages.
 */
import pg from 'pg';
import { elysiumLogin, elysiumFetch, BASE_URL } from '../scrapers/elysium-auth.js';
import { saveSkuImages, saveProductImages, filterImageUrls } from '../scrapers/base.js';

const { Pool } = pg;
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

// Same scoring function as elysium.js
const ELY_ROOM_SCENE = [
  'csa_', 'img_', '_sto_', '_sto.',
  'amb-', 'amb_', 'amb ', '_amb',
  'detalle', '_bano', '-bano',
  'bathroom', '_bath.', '_bath_',
  'restaurant', 'beauty center', 'smart working',
  '_shop.', '_shop_',
  'ambiente', 'bagno', 'cucina', 'ristorante', 'terrazza', 'soggiorno',
  'camera_', 'camera-',
  'room', 'scene', 'lifestyle', 'installed', 'showroom',
  'interior', 'kitchen', 'living', 'outdoor', 'pool',
  'insitu', 'in-situ', 'inspiration', 'styled',
];
const ELY_PRODUCT_SHOT = [
  'swatch', 'chip', 'product', 'closeup', 'close-up',
  'sample', 'solo', 'isolated', 'cutout', 'studio',
  'polished', 'matte', 'honed', 'lappato', 'natural',
  'rect', 'rectified',
];

function scoreElysiumImages(urls, colorHint, productName) {
  if (!urls || urls.length <= 1) return urls || [];
  const colorSlug = colorHint ? colorHint.toLowerCase().replace(/[^a-z0-9]+/g, '') : null;
  const prodLow = (productName || '').toLowerCase();

  function score(url, idx) {
    const fn = url.toLowerCase().split('/').pop().split('?')[0];
    let s = 0;
    for (const kw of ELY_ROOM_SCENE) {
      if (fn.includes(kw) && !prodLow.includes(kw)) { s -= 20; break; }
    }
    for (const kw of ELY_PRODUCT_SHOT) {
      if (fn.includes(kw)) { s += 3; break; }
    }
    if (/\d{2,3}x\d{2,3}/i.test(fn)) s += 5;
    if (colorSlug && colorSlug.length >= 3 && fn.includes(colorSlug)) s += 4;
    if (fn.includes('+')) s -= 10;
    if (/img_\d{3,}/.test(fn)) s -= 8;
    const afterId = fn.replace(/^\d+_\d+-/, '');
    if (afterId.startsWith('csa_') && !afterId.includes('detail')) s -= 10;
    if (fn.endsWith('.png')) s += 2;
    s -= idx * 0.001;
    return s;
  }

  return urls.map((url, i) => ({ url, s: score(url, i) }))
    .sort((a, b) => b.s - a.s)
    .map(x => x.url);
}

function extractGalleryImages(html) {
  const urls = [];
  const seen = new Set();
  // /1000/ URLs
  const re = /https?:\/\/elysiumtile\.com\/static\/images\/product\/1000\/[^"'\s)]+/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (!seen.has(m[0])) { seen.add(m[0]); urls.push(m[0]); }
  }
  return urls;
}

// Target SKUs with room-scene primaries
const TARGETS = [
  // vendor_sku, item search name, color
  { vendorSku: null, searchName: 'Scale Fan White Glossy', color: 'Fan White Gloss', note: 'Scale - kitchen scene' },
  { vendorSku: null, searchName: 'Scale Fan White Matte', color: 'Fan White', note: 'Scale Fan White - bathroom' },
  { vendorSku: null, searchName: 'Grant Grey 24 x 24', color: 'Grant Grey', note: 'Grant - room_2' },
];

async function main() {
  const cookies = await elysiumLogin(pool, null);
  console.log('Logged in');

  // Get SKU IDs for targets
  const targetSkus = await pool.query(`
    SELECT s.id AS sku_id, s.product_id, p.collection, p.name, s.variant_name,
           s.vendor_sku, ma.original_url AS current_primary
    FROM skus s
    JOIN products p ON p.id = s.product_id
    JOIN media_assets ma ON ma.sku_id = s.id AND ma.asset_type = 'primary'
    WHERE p.vendor_id = '550e8400-e29b-41d4-a716-446655440006'
      AND s.variant_type IS NULL
      AND (
        LOWER(ma.original_url) LIKE '%kitchen_slider%'
        OR LOWER(ma.original_url) LIKE '%bano_detalle%'
        OR LOWER(ma.original_url) LIKE '%room_2%'
      )
  `);

  console.log(`Found ${targetSkus.rows.length} SKUs to fix\n`);

  for (const row of targetSkus.rows) {
    console.log(`\n--- ${row.collection} / ${row.name} (${row.variant_name}) ---`);
    console.log(`Current primary: ${row.current_primary.split('/').pop()}`);

    // Try to find the detail page
    const searchName = `${row.collection} ${row.name} ${(row.variant_name || '').split(',')[0]}`.trim();
    const encodedName = searchName.replace(/ /g, '+');
    const detailUrl = `/product?id=${encodedName}`;
    console.log(`Fetching: ${detailUrl}`);

    try {
      const resp = await elysiumFetch(detailUrl, cookies);
      const html = await resp.text();
      const gallery = extractGalleryImages(html);

      if (gallery.length === 0) {
        console.log('  No gallery images found on page');
        continue;
      }

      console.log(`  Gallery: ${gallery.length} images`);
      for (const [i, url] of gallery.entries()) {
        console.log(`    [${i}] ${url.split('/').pop()}`);
      }

      // Score and sort
      const productName = `${row.name} ${row.collection || ''}`;
      const sorted = scoreElysiumImages(gallery, row.name, productName);
      console.log(`  Best: ${sorted[0].split('/').pop()}`);

      // Delete existing images for this SKU
      await pool.query('DELETE FROM media_assets WHERE sku_id = $1', [row.sku_id]);

      // Save new sorted images
      await saveSkuImages(pool, row.product_id, row.sku_id, sorted.slice(0, 8), { productName });

      // Also update product-level images
      await pool.query('DELETE FROM media_assets WHERE product_id = $1 AND sku_id IS NULL', [row.product_id]);
      await saveProductImages(pool, row.product_id, sorted.slice(0, 4));

      const newPrimary = await pool.query(
        `SELECT original_url FROM media_assets WHERE sku_id = $1 AND asset_type = 'primary'`,
        [row.sku_id]
      );
      if (newPrimary.rows[0]) {
        console.log(`  New primary: ${newPrimary.rows[0].original_url.split('/').pop()}`);
      }
    } catch (err) {
      console.log(`  Error: ${err.message}`);
    }
  }

  await pool.end();
  console.log('\nDone');
}

main().catch(e => { console.error(e); process.exit(1); });
