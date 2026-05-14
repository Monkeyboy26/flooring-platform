#!/usr/bin/env node
/**
 * shaw-cdn-images.cjs
 *
 * Use Shaw's predictable img.shawinc.com CDN to add images for ALL uncovered
 * Shaw SKUs. URLs are deterministic: no scraping or API key needed.
 *
 * CDN URL pattern:
 *   Main:  https://img.shawinc.com/v1/{STYLE}_{COLOR}/MAIN?w=800&h=800&fmt=webp&q=80
 *   Room:  https://img.shawinc.com/v1/{STYLE}_{COLOR}/ROOM/SF%20Desk%2002052025%20SS%20Z?w=500&h=500&fmt=web&q=80
 *
 * Strategy:
 *   1. Find all uncovered Shaw SKUs with style_code + color_code
 *   2. Construct CDN URL and verify it returns 200 (with concurrency)
 *   3. Insert verified primary images
 *   4. Promote product-level primaries for products without one
 *
 * Usage:
 *   node backend/scripts/shaw-cdn-images.cjs --dry-run
 *   node backend/scripts/shaw-cdn-images.cjs
 *   node backend/scripts/shaw-cdn-images.cjs --skip-verify    # skip HTTP checks, assume all exist
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
const SKIP_VERIFY = process.argv.includes('--skip-verify');
const CONCURRENCY = 20;

const CDN_BASE = 'https://img.shawinc.com/v1';

function buildMainUrl(style, color) {
  return `${CDN_BASE}/${style}_${color}/MAIN?w=800&h=800&fmt=webp&q=80`;
}

function buildRoomUrl(style, color) {
  return `${CDN_BASE}/${style}_${color}/ROOM/SF%20Desk%2002052025%20SS%20Z?w=500&h=500&fmt=web&q=80`;
}

// GET request with Range header to verify URL exists without downloading full image
function checkUrl(url) {
  return new Promise(resolve => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Range': 'bytes=0-0',
      },
      timeout: 10000,
    }, res => {
      res.resume();
      // 200 or 206 (partial content) both mean the image exists
      resolve(res.statusCode === 200 || res.statusCode === 206);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

// Process items in batches with concurrency
async function processBatch(items, fn, concurrency) {
  const results = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map(fn));
    results.push(...batchResults);
  }
  return results;
}

async function main() {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  SHAW CDN IMAGE RECOVERY ${DRY_RUN ? '(DRY RUN)' : '(LIVE)'}${SKIP_VERIFY ? ' [SKIP VERIFY]' : ''}`);
  console.log(`${'='.repeat(60)}\n`);

  // Phase 1: Find uncovered Shaw SKUs with style_code + color_code
  console.log('Phase 1: Finding uncovered Shaw SKUs...');
  const vendorRes = await pool.query("SELECT id FROM vendors WHERE code='SHAW'");
  const vendorId = vendorRes.rows[0].id;

  const { rows: uncoveredSkus } = await pool.query(`
    SELECT s.id AS sku_id, s.vendor_sku, s.product_id, p.name AS product_name,
           EXISTS (
             SELECT 1 FROM media_assets ma
             WHERE ma.sku_id = s.id AND ma.asset_type = 'lifestyle'
           ) AS has_lifestyle,
           (SELECT sa.value FROM sku_attributes sa JOIN attributes a ON a.id = sa.attribute_id
            WHERE sa.sku_id = s.id AND a.slug = 'style_code' LIMIT 1) AS style_code,
           (SELECT sa.value FROM sku_attributes sa JOIN attributes a ON a.id = sa.attribute_id
            WHERE sa.sku_id = s.id AND a.slug = 'color_code' LIMIT 1) AS color_code
    FROM skus s
    JOIN products p ON p.id = s.product_id
    WHERE p.vendor_id = $1
      AND s.status = 'active'
      AND s.vendor_sku IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM media_assets ma
        WHERE ma.sku_id = s.id AND ma.asset_type = 'primary'
      )
  `, [vendorId]);

  console.log(`  Total uncovered SKUs: ${uncoveredSkus.length}`);

  // Resolve style_code + color_code for each SKU
  const skusWithCodes = [];
  let noCodeCount = 0;

  for (const sku of uncoveredSkus) {
    let style = sku.style_code ? sku.style_code.trim() : null;
    let color = sku.color_code ? sku.color_code.trim() : null;

    // Fallback: parse from vendor_sku if no attributes
    if (!style || !color) {
      const raw = sku.vendor_sku.trim();
      const nosp = raw.replace(/\s+/g, '');
      if (nosp.length >= 10 && /^[A-Za-z0-9]+$/.test(nosp)) {
        style = nosp.slice(0, 5).toUpperCase();
        color = nosp.slice(5);
      }
    }

    if (style && color) {
      skusWithCodes.push({ ...sku, style: style.toUpperCase(), color });
    } else {
      noCodeCount++;
    }
  }

  console.log(`  SKUs with style+color codes: ${skusWithCodes.length}`);
  console.log(`  SKUs without codes (skipped): ${noCodeCount}\n`);

  // Phase 2: Verify URLs and collect inserts
  console.log(`Phase 2: ${SKIP_VERIFY ? 'Building' : 'Verifying'} CDN URLs (concurrency: ${CONCURRENCY})...`);

  const toInsertPrimary = [];
  const toInsertLifestyle = [];
  let verified = 0;
  let failed = 0;

  // Deduplicate by style_color to reduce HTTP requests
  const uniqueStyleColors = new Map(); // "STYLE_COLOR" -> [skus]
  for (const sku of skusWithCodes) {
    const key = `${sku.style}_${sku.color}`;
    if (!uniqueStyleColors.has(key)) uniqueStyleColors.set(key, []);
    uniqueStyleColors.get(key).push(sku);
  }

  console.log(`  Unique style_color combinations: ${uniqueStyleColors.size}`);

  const entries = [...uniqueStyleColors.entries()];
  let processed = 0;

  for (let i = 0; i < entries.length; i += CONCURRENCY) {
    const batch = entries.slice(i, i + CONCURRENCY);

    await Promise.all(batch.map(async ([key, skus]) => {
      const [style, color] = key.split('_');
      const mainUrl = buildMainUrl(style, color);

      let exists = true;
      if (!SKIP_VERIFY) {
        exists = await checkUrl(mainUrl);
      }

      if (exists) {
        verified++;
        for (const sku of skus) {
          toInsertPrimary.push({
            sku_id: sku.sku_id,
            product_id: sku.product_id,
            url: mainUrl,
            original_url: mainUrl,
          });
        }

        // Check room scene too
        const roomUrl = buildRoomUrl(style, color);
        let roomExists = true;
        if (!SKIP_VERIFY) {
          roomExists = await checkUrl(roomUrl);
        }
        if (roomExists) {
          for (const sku of skus) {
            if (!sku.has_lifestyle) {
              toInsertLifestyle.push({
                sku_id: sku.sku_id,
                product_id: sku.product_id,
                url: roomUrl,
                original_url: roomUrl,
              });
            }
          }
        }
      } else {
        failed++;
      }

      processed++;
    }));

    if (processed % 100 === 0 || processed === entries.length) {
      console.log(`  [${processed}/${entries.length}] verified: ${verified}, failed: ${failed}`);
    }
  }

  console.log(`\n  URLs verified: ${verified} style_color pairs`);
  console.log(`  URLs failed: ${failed} style_color pairs`);
  console.log(`  Primary images to insert: ${toInsertPrimary.length}`);
  console.log(`  Lifestyle images to insert: ${toInsertLifestyle.length}\n`);

  // Phase 3: Product-level primary promotions
  console.log('Phase 3: Building product-level primary promotions...');
  const { rows: existingProductPrimaries } = await pool.query(`
    SELECT DISTINCT product_id FROM media_assets
    WHERE asset_type = 'primary' AND sku_id IS NULL
      AND product_id IN (SELECT id FROM products WHERE vendor_id = $1)
  `, [vendorId]);
  const hasProductPrimary = new Set(existingProductPrimaries.map(r => r.product_id));

  const productPrimary = new Map();
  for (const img of toInsertPrimary) {
    if (!hasProductPrimary.has(img.product_id) && !productPrimary.has(img.product_id)) {
      productPrimary.set(img.product_id, { url: img.url, original_url: img.original_url });
    }
  }
  console.log(`  Products already with primary: ${hasProductPrimary.size}`);
  console.log(`  Products getting new primary: ${productPrimary.size}\n`);

  // Summary
  console.log('='.repeat(60));
  console.log('Summary:');
  console.log(`  SKU primaries: ${toInsertPrimary.length}`);
  console.log(`  SKU lifestyles: ${toInsertLifestyle.length}`);
  console.log(`  Product primaries (promoted): ${productPrimary.size}`);
  console.log('='.repeat(60) + '\n');

  if (DRY_RUN) {
    console.log('Sample SKU primaries:');
    for (const p of toInsertPrimary.slice(0, 5)) {
      console.log(`  sku=${p.sku_id.substring(0, 8)} url=${p.url.substring(0, 90)}`);
    }
    console.log('\nDry run — no changes applied.');
    await pool.end();
    return;
  }

  console.log('Applying changes...');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let inserted = 0;
    for (const img of toInsertPrimary) {
      const res = await client.query(`
        INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
        VALUES ($1, $2, 'primary', $3, $4, 0)
        ON CONFLICT DO NOTHING
      `, [img.product_id, img.sku_id, img.url, img.original_url]);
      inserted += res.rowCount;
    }
    console.log(`  Inserted ${inserted} SKU-level primaries (${toInsertPrimary.length - inserted} skipped as duplicates)`);

    inserted = 0;
    for (const img of toInsertLifestyle) {
      const res = await client.query(`
        INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
        VALUES ($1, $2, 'lifestyle', $3, $4, 0)
        ON CONFLICT DO NOTHING
      `, [img.product_id, img.sku_id, img.url, img.original_url]);
      inserted += res.rowCount;
    }
    console.log(`  Inserted ${inserted} SKU-level lifestyles`);

    inserted = 0;
    for (const [productId, imgData] of productPrimary) {
      const res = await client.query(`
        INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
        VALUES ($1, NULL, 'primary', $2, $3, 0)
        ON CONFLICT DO NOTHING
      `, [productId, imgData.url, imgData.original_url]);
      inserted += res.rowCount;
    }
    console.log(`  Inserted ${inserted} product-level primaries`);

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
