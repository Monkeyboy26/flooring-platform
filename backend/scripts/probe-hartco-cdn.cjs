#!/usr/bin/env node
/**
 * Probe hartco.com CDN for images matching our DB vendor_skus.
 * Outputs JSON array of { sku_id, product_id, vendor_sku, cdn_url } for hits.
 */
const https = require('https');
const { Pool } = require('pg');

const pool = new Pool({
  host: 'localhost', port: 5432,
  database: 'flooring_pim', user: 'postgres', password: 'postgres',
});

function normalize(vendorSku) {
  let s = vendorSku.toUpperCase().replace(/-/g, '');
  if (s.startsWith('AHF')) s = s.slice(3);
  return s;
}

function checkUrl(url) {
  return new Promise(resolve => {
    // Use GET with Range header — CDN blocks HEAD requests
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Range': 'bytes=0-0' } }, res => {
      // Drain response body
      res.resume();
      if (res.statusCode === 302 || res.statusCode === 301) {
        const loc = res.headers.location || '';
        if (loc.includes('placeholder')) {
          resolve({ ok: false, status: res.statusCode, redirect: loc });
        } else {
          const fullUrl = loc.startsWith('http') ? loc : `https://www.hartco.com${loc}`;
          https.get(fullUrl, { headers: { 'User-Agent': 'Mozilla/5.0', 'Range': 'bytes=0-0' } }, res2 => {
            res2.resume();
            resolve({ ok: res2.statusCode === 200 || res2.statusCode === 206, status: res2.statusCode });
          }).on('error', () => resolve({ ok: false, status: 0 }));
        }
      } else {
        resolve({ ok: res.statusCode === 200 || res.statusCode === 206, status: res.statusCode });
      }
    });
    req.on('error', () => resolve({ ok: false, status: 0 }));
  });
}

async function main() {
  const result = await pool.query(`
    SELECT s.id as sku_id, s.vendor_sku, s.product_id, s.variant_name
    FROM skus s
    JOIN products p ON s.product_id = p.id
    LEFT JOIN media_assets ma ON ma.sku_id = s.id AND ma.asset_type = 'primary'
    WHERE (p.collection LIKE 'Hartco%' OR p.collection LIKE 'AHF%')
      AND ma.id IS NULL
      AND s.variant_type IS DISTINCT FROM 'accessory'
      AND s.vendor_sku IS NOT NULL
      AND s.vendor_sku NOT LIKE 'AHFHARTCOCUSTOM%'
      AND s.vendor_sku NOT LIKE 'AHFHARTCOCUSTO%'
    ORDER BY s.vendor_sku
  `);

  console.error(`Testing ${result.rows.length} SKUs against hartco.com CDN...\n`);

  const hits = [];
  const misses = [];
  const CONCURRENCY = 10;

  for (let i = 0; i < result.rows.length; i += CONCURRENCY) {
    const batch = result.rows.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(async row => {
      const norm = normalize(row.vendor_sku);
      const url = `https://www.hartco.com/cdn/swatch/${norm}.jpg`;
      const check = await checkUrl(url);
      return { row, norm, url, check };
    }));

    for (const { row, norm, url, check } of results) {
      if (check.ok) {
        hits.push({ sku_id: row.sku_id, product_id: row.product_id, vendor_sku: row.vendor_sku, variant_name: row.variant_name, cdn_url: url });
        console.error(`  + ${norm} (${row.variant_name}) → 200`);
      } else {
        misses.push({ vendor_sku: row.vendor_sku, norm, status: check.status, redirect: check.redirect });
      }
    }
  }

  console.error(`\n--- Results ---`);
  console.error(`Hits:   ${hits.length}`);
  console.error(`Misses: ${misses.length}`);

  if (misses.length > 0) {
    console.error(`\nSample misses (first 10):`);
    misses.slice(0, 10).forEach(m => console.error(`  ${m.vendor_sku} → ${m.norm} (${m.status}${m.redirect ? ' → ' + m.redirect : ''})`));
  }

  // Output hits as JSON to stdout
  console.log(JSON.stringify(hits, null, 2));

  await pool.end();
}

main().catch(err => { console.error('Fatal:', err); pool.end(); process.exit(1); });
