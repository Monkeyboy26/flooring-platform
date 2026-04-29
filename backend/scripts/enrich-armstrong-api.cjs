#!/usr/bin/env node
/**
 * Enrich Armstrong SKUs with images from the residential + commercial browse APIs.
 * These APIs return item codes + swatch image URLs for products on armstrongflooring.com.
 */
const https = require('https');
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.PGHOST || 'db',
  database: process.env.PGDATABASE || 'flooring_pim',
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'postgres',
});

const BASE = 'https://www.armstrongflooring.com';

function fetchJson(url) {
  return new Promise((resolve) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 20000 }, (r) => {
      let d = '';
      r.on('data', (c) => (d += c));
      r.on('end', () => {
        try { resolve(JSON.parse(d)); } catch { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  if (dryRun) console.log('=== DRY RUN ===');

  // 1. Fetch both browse APIs (commercial caps at 999 per page, need pagination)
  console.log('Fetching residential + commercial browse APIs...');
  const resData = await fetchJson(`${BASE}/residential/api/en-us/browse/products?q=matchall&filters=type:ResidentialProduct&filters=type:Trim&filters=type:IMA&size=999&start=0&region=`);
  console.log(`  Residential: ${resData?.count || 0} products`);

  // Paginate commercial API
  const comProducts = [];
  let comStart = 0;
  while (true) {
    const page = await fetchJson(`${BASE}/commercial/api/en-us/browse/products?q=matchall&size=999&start=${comStart}`);
    if (!page?.products?.length) break;
    comProducts.push(...page.products);
    console.log(`  Commercial page ${comStart}: ${page.products.length} products (total: ${page.count})`);
    if (comProducts.length >= (page.count || 0)) break;
    comStart += page.products.length;
  }
  console.log(`  Commercial total fetched: ${comProducts.length}`);

  // 2. Build unified itemCode -> imageUrl map
  const imageMap = new Map();

  // Residential: line1 = "CollectionName | ItemCode"
  if (resData?.products) {
    for (const p of resData.products) {
      const match = p.line1 && p.line1.match(/\|\s*([A-Za-z0-9]+)$/);
      if (match && p.image) {
        imageMap.set(match[1].toUpperCase(), BASE + p.image + '?size=detail');
      }
    }
  }
  const resCount = imageMap.size;

  // Commercial: line2 = itemCode directly
  for (const p of comProducts) {
    const code = (p.line2 || '').trim().toUpperCase();
    if (code && p.image && !imageMap.has(code)) {
      imageMap.set(code, BASE + p.image + '?size=detail');
    }
  }
  console.log(`  Image map: ${imageMap.size} unique codes (${resCount} residential, ${imageMap.size - resCount} commercial-only)`);

  // 3. Load Armstrong SKUs without primary images (non-accessory)
  const { rows: skus } = await pool.query(`
    SELECT s.id, s.vendor_sku, s.product_id
    FROM skus s
    JOIN products p ON p.id = s.product_id
    LEFT JOIN media_assets ma ON ma.sku_id = s.id AND ma.asset_type = 'primary'
    WHERE p.collection LIKE 'Armstrong -%'
      AND ma.id IS NULL
      AND (s.variant_type IS NULL OR s.variant_type != 'accessory')
  `);
  console.log(`  SKUs without images: ${skus.length}`);

  // 4. Match SKUs to API items
  const toInsert = [];
  let unmatched = 0;
  const unmatchedByProduct = {};

  for (const sku of skus) {
    const vs = sku.vendor_sku;
    let found = false;
    // Try extracting item codes of various lengths after the "ARM" prefix
    for (const len of [5, 6, 7, 8, 9, 10]) {
      if (3 + len > vs.length) continue;
      const code = vs.slice(3, 3 + len).toUpperCase();
      if (imageMap.has(code)) {
        toInsert.push({ skuId: sku.id, productId: sku.product_id, url: imageMap.get(code) });
        found = true;
        break;
      }
    }
    if (!found) {
      unmatched++;
    }
  }

  console.log(`\n  Matched: ${toInsert.length} SKUs`);
  console.log(`  Unmatched: ${unmatched} SKUs`);

  if (dryRun) {
    console.log('\nDry run complete. Use without --dry-run to insert.');
    await pool.end();
    return;
  }

  // 5. Insert images
  let inserted = 0;
  let skipped = 0;
  for (const item of toInsert) {
    try {
      const { rowCount } = await pool.query(
        `INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
         VALUES ($1, $2, 'primary', $3, $3, 0)
         ON CONFLICT DO NOTHING`,
        [item.productId, item.skuId, item.url]
      );
      if (rowCount > 0) inserted++;
      else skipped++;
    } catch (e) {
      skipped++;
    }
  }

  console.log(`\n  Inserted: ${inserted} images`);
  console.log(`  Skipped (conflicts): ${skipped}`);

  // 6. Final count
  const { rows: [{ count }] } = await pool.query(`
    SELECT COUNT(*) as count
    FROM media_assets ma
    JOIN skus s ON s.id = ma.sku_id
    JOIN products p ON p.id = s.product_id
    WHERE p.collection LIKE 'Armstrong -%' AND ma.asset_type = 'primary'
  `);
  console.log(`  Total Armstrong SKU images now: ${count}`);

  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
