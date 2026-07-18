#!/usr/bin/env node
// Quick diagnostic: what CDN URLs does the scraper generate for specific SKUs?
import https from 'https';

const CDN = 'https://cdn.msisurfaces.com/images';

function slugify(str) {
  if (!str) return '';
  return str.toLowerCase()
    .replace(/[®™©]/g, '').replace(/\bTM\b/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function headUrl(url) {
  return new Promise(resolve => {
    let resolved = false;
    const done = (val) => { if (!resolved) { resolved = true; resolve(val); } };
    const req = https.request(url, { method: 'HEAD', timeout: 10000 }, res => {
      res.resume();
      done(res.statusCode === 200 ? url : null);
    });
    req.on('error', () => done(null));
    req.on('timeout', () => { req.destroy(); done(null); });
    req.end();
  });
}

// Simplified versions of the URL builders to diagnose
function buildMosaicUrls(productName, collection, variantName) {
  const urls = [];
  const nameSlug = slugify(productName);
  const collSlug = slugify(collection);
  const colorSlug = slugify(variantName);
  const finishes = ['polished', 'honed', 'tumbled', 'matte', 'glossy'];
  if (nameSlug) {
    urls.push(`${CDN}/mosaics/${nameSlug}.jpg`);
    for (const f of finishes) urls.push(`${CDN}/mosaics/${nameSlug}-${f}.jpg`);
    urls.push(`${CDN}/mosaics/detail-two/${nameSlug}-detail-two.jpg`);
  }
  if (collSlug && colorSlug) {
    urls.push(`${CDN}/mosaics/${collSlug}-${colorSlug}.jpg`);
    urls.push(`${CDN}/mosaics/${colorSlug}-${collSlug}.jpg`);
  }
  if (nameSlug) urls.push(`${CDN}/colornames/${nameSlug}.jpg`);
  if (collSlug && colorSlug) urls.push(`${CDN}/colornames/${collSlug}-${colorSlug}.jpg`);
  return [...new Set(urls)];
}

function buildPorcelainUrls(collection, variantName, productName, vendorSku, size) {
  const urls = [];
  const nameSlug = slugify(productName);
  const collSlug = slugify(collection);
  const colorSlug = slugify(variantName);

  if (size && collSlug && colorSlug) {
    const sizeSlug = size.toLowerCase().replace(/[^0-9x]/g, '');
    if (sizeSlug) {
      urls.push(`${CDN}/porcelainceramic/${colorSlug}-${collSlug}-porcelain-${sizeSlug}-polished.jpg`);
      urls.push(`${CDN}/porcelainceramic/${colorSlug}-${collSlug}-${sizeSlug}-polished.jpg`);
    }
  }
  if (collSlug && colorSlug) {
    urls.push(`${CDN}/porcelainceramic/${colorSlug}-${collSlug}-porcelain.jpg`);
    urls.push(`${CDN}/porcelainceramic/${collSlug}-${colorSlug}-porcelain.jpg`);
  }
  if (nameSlug) {
    urls.push(`${CDN}/porcelainceramic/${nameSlug}.jpg`);
  }
  return [...new Set(urls)];
}

// Test SKUs
const testSkus = [
  { vendor_sku: 'NADEVISGRI1224', product_name: 'Adella Viso Gris', collection: 'Adella', color: 'Gris', category: 'mosaic-tile', size: '12x24' },
  { vendor_sku: 'NEDECAL2448', product_name: 'Eden Calcatta', collection: 'Eden', color: 'White-Cool', category: 'porcelain-tile', size: '24x48' },
  { vendor_sku: 'NEDECAL2X2HEX', product_name: 'Eden Calcatta 2x2 Hexagon', collection: 'Eden', color: 'White-Cool', category: 'mosaic-tile', size: null },
  { vendor_sku: 'NEDESTA3X3HEX', product_name: 'Eden Statuary 3x3 Hexagon', collection: 'Eden', color: 'White-Cool', category: 'mosaic-tile', size: null },
];

async function test() {
  for (const sku of testSkus) {
    console.log(`\n=== ${sku.vendor_sku} — ${sku.product_name} (${sku.category}) ===`);

    let candidates;
    if (/mosaic|glass.tile/i.test(sku.category)) {
      candidates = buildMosaicUrls(sku.product_name, sku.collection, sku.color);
    } else {
      candidates = buildPorcelainUrls(sku.collection, sku.color, sku.product_name, sku.vendor_sku, sku.size);
    }

    console.log(`  Generated ${candidates.length} candidates:`);

    // Probe all in parallel
    const results = await Promise.all(candidates.map(async url => {
      const hit = await headUrl(url);
      return { url, hit: !!hit };
    }));

    for (const r of results) {
      const icon = r.hit ? '✓' : '✗';
      const shortUrl = r.url.replace(CDN, '');
      console.log(`  ${icon} ${shortUrl}`);
    }

    const hits = results.filter(r => r.hit);
    console.log(`  → ${hits.length} hits`);
  }
}

test().catch(console.error);
