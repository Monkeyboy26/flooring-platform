#!/usr/bin/env node
/**
 * shaw-recover-images.cjs
 *
 * Recover images for the 240 Shaw products with zero images.
 *
 * The Shaw Data API credentials stopped working between March 5 and March 26,
 * 2026, so we can't fetch fresh enrichment data. However, Shaw's public
 * sitemaps (https://shawfloors.com/en-us/sitemap/images/sampletype/7-11.xml)
 * list every style/color image on the Widen CDN.
 *
 * Strategy:
 *   1. Download all 5 image sitemaps
 *   2. Parse out all "{styleCode}_{colorCode}_{variant}" URLs
 *   3. Build lookup by lowercase "{style}_{color}" key
 *   4. For each uncovered Shaw SKU, parse vendor_sku into style (5 chars) +
 *      color (5 chars) and look it up
 *   5. Insert matching _main as primary, _room as lifestyle
 *   6. If all SKUs of a product get matched, promote first primary to
 *      product-level
 *
 * Usage:
 *   node backend/scripts/shaw-recover-images.cjs --dry-run
 *   node backend/scripts/shaw-recover-images.cjs
 */

const { Pool } = require('pg');
const https = require('https');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

const DRY_RUN = process.argv.includes('--dry-run');

const SITEMAP_INDEX = 'https://shawfloors.com/en-us/sitemap/images.xml';

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/xml,application/xml,*/*',
      },
    }, res => {
      if (res.statusCode !== 200) return reject(new Error(`${url}: HTTP ${res.statusCode}`));
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
  });
}

// Add query string for width/quality optimization
function optimizeUrl(url) {
  if (!url.includes('widen.net')) return url;
  return url + (url.includes('?') ? '&' : '?') + 'w=800&quality=80';
}

async function main() {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  SHAW IMAGE RECOVERY ${DRY_RUN ? '(DRY RUN)' : '(LIVE)'}`);
  console.log(`${'='.repeat(60)}\n`);

  // Phase 1: Download all sitemaps (recursively) and build style_color lookup
  console.log('Phase 1: Downloading sitemaps...');
  const lookup = new Map(); // "style_color" -> { main, room, angled, swatch }

  // Parse pattern: /content/HASH/jpeg/STYLE_COLOR_VARIANT
  // e.g. sl119_01049_main, cc73b_00743_room
  const widenRe = /<loc>(https:\/\/shawfloors\.widen\.net\/content\/[a-z0-9]+\/(?:jpeg|webp|jpg|png)\/([a-z0-9]+)_(\d+)_(\w+))<\/loc>/g;
  const indexRe = /<sitemap><loc>([^<]+)<\/loc>/g;

  async function processSitemap(url) {
    const xml = await fetchUrl(url);
    // Is this a sitemap index?
    if (xml.includes('<sitemapindex')) {
      let im;
      const subs = [];
      while ((im = indexRe.exec(xml)) !== null) subs.push(im[1]);
      console.log(`  [index] ${url.split('/').slice(-2).join('/')} -> ${subs.length} sub-sitemaps`);
      for (const s of subs) await processSitemap(s);
      return;
    }
    // It's a urlset
    let count = 0;
    let m;
    while ((m = widenRe.exec(xml)) !== null) {
      const [, fullUrl, style, color, variant] = m;
      const key = `${style.toLowerCase()}_${color}`;
      if (!lookup.has(key)) lookup.set(key, {});
      if (!lookup.get(key)[variant]) lookup.get(key)[variant] = fullUrl;
      count++;
    }
    console.log(`  ${url.split('/').slice(-2).join('/')}: ${count} Widen URLs (${lookup.size} total pairs)`);
  }

  await processSitemap(SITEMAP_INDEX);
  console.log(`  Total unique style_color pairs: ${lookup.size}\n`);

  // Phase 2: Find uncovered Shaw SKUs
  console.log('Phase 2: Finding uncovered Shaw SKUs...');
  const vendorRes = await pool.query("SELECT id FROM vendors WHERE code='SHAW'");
  const vendorId = vendorRes.rows[0].id;

  // Uncovered = product has no product-level primary AND SKU has no SKU-level primary
  const { rows: uncoveredSkus } = await pool.query(`
    SELECT s.id AS sku_id, s.vendor_sku, s.product_id, p.name AS product_name
    FROM skus s
    JOIN products p ON p.id = s.product_id
    WHERE p.vendor_id = $1
      AND s.status = 'active'
      AND s.vendor_sku IS NOT NULL
      AND p.id NOT IN (
        SELECT DISTINCT product_id FROM media_assets
        WHERE asset_type='primary' AND sku_id IS NULL
      )
      AND s.id NOT IN (
        SELECT DISTINCT sku_id FROM media_assets
        WHERE asset_type='primary' AND sku_id IS NOT NULL
      )
  `, [vendorId]);

  console.log(`  Found ${uncoveredSkus.length} uncovered Shaw SKUs\n`);

  // Phase 3: Match vendor_sku to sitemap lookup
  console.log('Phase 3: Matching SKUs to sitemap lookup...');
  const toInsertSkuPrimary = [];
  const toInsertSkuLifestyle = [];
  let matched = 0;
  let unmatched = 0;
  const unmatchedSamples = [];

  for (const sku of uncoveredSkus) {
    const raw = sku.vendor_sku.trim().toLowerCase();
    // Shaw vendor_sku format: "{style5}{color5}" or "{style5} {color5}"
    // Style can be 5 chars (e.g. sns13, 5e901, cc73b) or shorter (e.g. vv492)
    const nosp = raw.replace(/\s+/g, '');
    if (nosp.length < 8) { unmatched++; continue; }

    // Try variations: split at 5 chars, 4 chars, 6 chars
    let hit = null;
    let hitKey = null;
    for (const styleLen of [5, 4, 6]) {
      if (nosp.length <= styleLen) continue;
      const style = nosp.slice(0, styleLen);
      const color = nosp.slice(styleLen);
      const key = `${style}_${color}`;
      if (lookup.has(key)) {
        hit = lookup.get(key);
        hitKey = key;
        break;
      }
    }

    if (!hit) {
      unmatched++;
      if (unmatchedSamples.length < 10) unmatchedSamples.push(sku.vendor_sku);
      continue;
    }

    matched++;
    if (hit.main) {
      toInsertSkuPrimary.push({
        sku_id: sku.sku_id,
        product_id: sku.product_id,
        url: optimizeUrl(hit.main),
        original_url: hit.main,
      });
    }
    if (hit.room) {
      toInsertSkuLifestyle.push({
        sku_id: sku.sku_id,
        product_id: sku.product_id,
        url: optimizeUrl(hit.room),
        original_url: hit.room,
      });
    }
  }

  console.log(`  Matched: ${matched} SKUs`);
  console.log(`  Unmatched: ${unmatched} SKUs`);
  if (unmatchedSamples.length) {
    console.log(`  Sample unmatched vendor_skus: ${unmatchedSamples.join(', ')}`);
  }
  console.log(`  Primary images to insert: ${toInsertSkuPrimary.length}`);
  console.log(`  Lifestyle images to insert: ${toInsertSkuLifestyle.length}\n`);

  // Phase 4: Determine product-level primary promotions
  // For each product, pick the first SKU's primary to promote as product-level primary
  console.log('Phase 4: Building product-level primary promotions...');
  const productPrimary = new Map();
  for (const img of toInsertSkuPrimary) {
    if (!productPrimary.has(img.product_id)) {
      productPrimary.set(img.product_id, { url: img.url, original_url: img.original_url });
    }
  }
  console.log(`  Products getting promoted primary: ${productPrimary.size}\n`);

  // Summary
  console.log('='.repeat(60));
  console.log('Summary:');
  console.log(`  SKU primaries: ${toInsertSkuPrimary.length}`);
  console.log(`  SKU lifestyles: ${toInsertSkuLifestyle.length}`);
  console.log(`  Product primaries (promoted): ${productPrimary.size}`);
  console.log('='.repeat(60) + '\n');

  if (DRY_RUN) {
    console.log('Sample SKU primaries:');
    for (const p of toInsertSkuPrimary.slice(0, 5)) {
      console.log(`  sku=${p.sku_id.substring(0,8)} url=${p.url.substring(0, 90)}`);
    }
    console.log('\nDry run — no changes applied.');
    await pool.end();
    return;
  }

  console.log('Applying changes...');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Insert SKU-level primaries
    for (const img of toInsertSkuPrimary) {
      await client.query(`
        INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
        VALUES ($1, $2, 'primary', $3, $4, 0)
        ON CONFLICT DO NOTHING
      `, [img.product_id, img.sku_id, img.url, img.original_url]);
    }
    console.log(`  Inserted ${toInsertSkuPrimary.length} SKU-level primaries`);

    // Insert SKU-level lifestyles
    for (const img of toInsertSkuLifestyle) {
      await client.query(`
        INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
        VALUES ($1, $2, 'lifestyle', $3, $4, 0)
        ON CONFLICT DO NOTHING
      `, [img.product_id, img.sku_id, img.url, img.original_url]);
    }
    console.log(`  Inserted ${toInsertSkuLifestyle.length} SKU-level lifestyles`);

    // Insert product-level primaries
    for (const [productId, imgData] of productPrimary) {
      await client.query(`
        INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
        VALUES ($1, NULL, 'primary', $2, $3, 0)
        ON CONFLICT DO NOTHING
      `, [productId, imgData.url, imgData.original_url]);
    }
    console.log(`  Inserted ${productPrimary.size} product-level primaries`);

    await client.query('COMMIT');
    console.log('Done.');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  await pool.end();
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
