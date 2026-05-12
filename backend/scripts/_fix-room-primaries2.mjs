#!/usr/bin/env node
/**
 * Fix specific room-scene primaries using exact CSV item names.
 */
import pg from 'pg';
import { elysiumLogin, elysiumFetch, BASE_URL } from '../scrapers/elysium-auth.js';
import { saveSkuImages, saveProductImages } from '../scrapers/base.js';

const { Pool } = pg;
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

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
  const re = /https?:\/\/elysiumtile\.com\/static\/images\/product\/1000\/[^"'\s)]+/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const clean = m[0].replace(/&amp;/g, '&');
    if (!seen.has(clean)) { seen.add(clean); urls.push(clean); }
  }
  return urls;
}

// Items to fix: vendor_sku → exact CSV item name
const FIXES = [
  { vendorSku: 'C200', itemName: 'Scale Fan White Gloss 4 x 5', color: 'Fan White Gloss', collection: 'Scale' },
  { vendorSku: 'C201', itemName: 'Scale Fan White Matte 4 x 5', color: 'Fan White', collection: 'Scale' },
  { vendorSku: 'P868', itemName: 'Malaysia Grant Grey 24 x 24', color: 'Malaysia Grant Grey', collection: 'Grant' },
];

async function main() {
  const cookies = await elysiumLogin(pool, null);
  console.log('Logged in');

  for (const fix of FIXES) {
    console.log(`\n--- ${fix.itemName} (${fix.vendorSku}) ---`);

    // Find SKU in DB
    const skuRes = await pool.query(`
      SELECT s.id AS sku_id, s.product_id
      FROM skus s WHERE s.vendor_sku = $1 AND s.internal_sku LIKE 'ELY-%'
    `, [fix.vendorSku]);

    if (skuRes.rows.length === 0) {
      console.log('  SKU not found in DB');
      continue;
    }

    const { sku_id, product_id } = skuRes.rows[0];

    // Fetch detail page using exact CSV item name
    const encodedName = fix.itemName.replace(/ /g, '+');
    const detailUrl = `/product?id=${encodedName}`;
    console.log(`  Fetching: ${detailUrl}`);

    try {
      const resp = await elysiumFetch(detailUrl, cookies);
      const html = await resp.text();
      const gallery = extractGalleryImages(html);

      if (gallery.length === 0) {
        console.log('  No gallery images found');
        continue;
      }

      console.log(`  Gallery: ${gallery.length} images`);
      for (const [i, url] of gallery.entries()) {
        const fn = url.split('/').pop();
        console.log(`    [${i}] ${fn}`);
      }

      const productName = `${fix.color} ${fix.collection}`;
      const sorted = scoreElysiumImages(gallery, fix.color, productName);

      console.log(`  Sorted order:`);
      for (const [i, url] of sorted.entries()) {
        const fn = url.split('/').pop();
        console.log(`    [${i}] ${fn}`);
      }

      // Delete existing images for this SKU
      await pool.query('DELETE FROM media_assets WHERE sku_id = $1', [sku_id]);
      // Save new sorted images
      await saveSkuImages(pool, product_id, sku_id, sorted.slice(0, 8), { productName });

      const newPrimary = await pool.query(
        `SELECT original_url FROM media_assets WHERE sku_id = $1 AND asset_type = 'primary'`,
        [sku_id]
      );
      if (newPrimary.rows[0]) {
        console.log(`  ✓ New primary: ${newPrimary.rows[0].original_url.split('/').pop()}`);
      }
    } catch (err) {
      console.log(`  Error: ${err.message}`);
    }
  }

  await pool.end();
  console.log('\nDone');
}

main().catch(e => { console.error(e); process.exit(1); });
