#!/usr/bin/env node

/**
 * Engineered Floors — API-Based Image Import
 *
 * Fetches product data from the EF WordPress REST API (engineeredfloors.com)
 * and matches to DB products to fill missing images.
 *
 * Covers DreamWeaver (consumer carpet) and PureGrain (hard-surface) products.
 * No Puppeteer needed — uses JSON APIs with Cloudinary image URLs.
 *
 * API endpoints:
 *   /wp-json/product-api/v1/all-products   — Full catalog (251 products with variants/scenes/boards)
 *   /wp-json/product-api/v1/products-all   — Grouped by category (carpet/hardSurface subcategories)
 *
 * Usage:
 *   docker compose exec api node scripts/import-ef-api-images.js
 */

import pg from 'pg';

const BASE_URL = 'https://www.engineeredfloors.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

async function fetchJson(url) {
  const resp = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(30000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} from ${url}`);
  return resp.json();
}

/**
 * Normalize a product name for matching.
 * "Affinity I" → "affinity i", "Titan II" → "titan ii"
 */
function normalizeName(name) {
  return (name || '').toLowerCase().trim()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ');
}

async function main() {
  console.log('Engineered Floors — API Image Import\n');

  // Get EF vendor
  const vendorRes = await pool.query("SELECT id FROM vendors WHERE code = 'EF'");
  if (!vendorRes.rows.length) {
    console.error('EF vendor not found');
    process.exit(1);
  }
  const vendorId = vendorRes.rows[0].id;

  // Get EF products missing primary images
  const dbRes = await pool.query(`
    SELECT p.id, p.name, p.collection
    FROM products p
    WHERE p.vendor_id = $1 AND p.is_active = true
      AND NOT EXISTS (
        SELECT 1 FROM media_assets ma
        WHERE ma.product_id = p.id AND ma.asset_type = 'primary'
      )
    ORDER BY p.name
  `, [vendorId]);

  console.log(`DB products missing images: ${dbRes.rows.length}`);

  if (dbRes.rows.length === 0) {
    console.log('All EF products have images — done');
    await pool.end();
    return;
  }

  // Build a lookup map: normalized name → [products]
  const dbLookup = new Map();
  for (const row of dbRes.rows) {
    const key = normalizeName(row.name);
    if (!dbLookup.has(key)) dbLookup.set(key, []);
    dbLookup.get(key).push(row);
  }

  // Also build a lookup by collection name (for products where name != collection)
  const dbByCollection = new Map();
  for (const row of dbRes.rows) {
    const key = normalizeName(row.collection);
    if (!dbByCollection.has(key)) dbByCollection.set(key, []);
    dbByCollection.get(key).push(row);
  }

  // ── Fetch API products ──
  // Primary: /all-products returns array with full variant/scene/board data
  console.log('\nFetching full EF catalog (all-products)...');
  let allProductsRaw = [];
  try {
    allProductsRaw = await fetchJson(`${BASE_URL}/wp-json/product-api/v1/all-products`);
    console.log(`  all-products: ${allProductsRaw.length} products`);
  } catch (e) {
    console.error(`  all-products fetch failed: ${e.message}`);
  }

  // Normalize to unified format: { name, variants, scenes, boards, images }
  const allApiProducts = [];
  const seenApiNames = new Set();

  for (const item of allProductsRaw) {
    const name = item.product?.product_name || '';
    const key = normalizeName(name);
    if (!key || seenApiNames.has(key)) continue;
    seenApiNames.add(key);
    allApiProducts.push({
      name,
      variants: item.variants || [],
      scenes: item.scenes || [],
      boards: item.boards || [],
    });
  }

  // Fallback: /products-all returns grouped data with simpler image format
  // Use this for any products not in the all-products response
  console.log('Fetching grouped catalog (products-all)...');
  try {
    const grouped = await fetchJson(`${BASE_URL}/wp-json/product-api/v1/products-all`);
    const categories = grouped?.data || {};
    let added = 0;
    for (const type of Object.values(categories)) {
      for (const subcategory of Object.values(type)) {
        if (!Array.isArray(subcategory)) continue;
        for (const item of subcategory) {
          const name = item.name || '';
          const key = normalizeName(name);
          if (!key || seenApiNames.has(key)) continue;
          seenApiNames.add(key);
          // Convert images array to variants format for uniform handling
          const images = item.images || [];
          allApiProducts.push({
            name,
            variants: images.map(img => ({ image_url: img.url_thumbnail })),
            scenes: [],
            boards: [],
          });
          added++;
        }
      }
    }
    console.log(`  products-all: ${added} additional products`);
  } catch (e) {
    console.error(`  products-all fetch failed: ${e.message}`);
  }

  console.log(`\nTotal unique API products: ${allApiProducts.length}`);

  // ── Match and import images ──
  let matched = 0;
  let imagesAdded = 0;
  let lifestyleAdded = 0;
  let skipped = 0;

  for (const apiProduct of allApiProducts) {
    const apiName = normalizeName(apiProduct.name);
    if (!apiName) continue;

    // Try matching by name, then by collection
    let dbProducts = dbLookup.get(apiName);
    if (!dbProducts) {
      // Try partial match: API "Aberdeen II" matches DB "Aberdeen II"
      // Also try without roman numerals: "Aberdeen" matches "Aberdeen II"
      for (const [key, products] of dbLookup) {
        if (key.includes(apiName) || apiName.includes(key)) {
          dbProducts = products;
          break;
        }
      }
    }
    if (!dbProducts) {
      dbProducts = dbByCollection.get(apiName);
    }

    if (!dbProducts || dbProducts.length === 0) {
      skipped++;
      continue;
    }

    // Extract images from API product
    const variants = apiProduct.variants || [];
    const scenes = apiProduct.scenes || [];
    const boards = apiProduct.boards || [];

    // Get the best primary image: first variant swatch or first board
    let primaryUrl = null;
    if (variants.length > 0 && variants[0].image_url) {
      primaryUrl = ensureHiRes(variants[0].image_url);
    } else if (boards.length > 0 && boards[0].image_url) {
      primaryUrl = ensureHiRes(boards[0].image_url);
    }

    // Get lifestyle images from scenes
    const lifestyleUrls = [];
    for (const scene of scenes) {
      if (scene.image_url) {
        lifestyleUrls.push(ensureHiRes(scene.image_url));
      }
    }

    // Get additional variant swatches
    const alternateUrls = [];
    for (let i = 1; i < Math.min(variants.length, 4); i++) {
      if (variants[i].image_url) {
        alternateUrls.push(ensureHiRes(variants[i].image_url));
      }
    }

    if (!primaryUrl && lifestyleUrls.length === 0) {
      skipped++;
      continue;
    }

    // Apply to all matching DB products
    for (const dbProduct of dbProducts) {
      let sortOrder = 0;

      if (primaryUrl) {
        await upsertMediaAsset(pool, {
          product_id: dbProduct.id,
          sku_id: null,
          asset_type: 'primary',
          url: primaryUrl,
          original_url: primaryUrl,
          sort_order: sortOrder++,
        });
        imagesAdded++;
      }

      // Add alternate variant swatches
      for (const url of alternateUrls) {
        await upsertMediaAsset(pool, {
          product_id: dbProduct.id,
          sku_id: null,
          asset_type: 'alternate',
          url,
          original_url: url,
          sort_order: sortOrder++,
        });
        imagesAdded++;
      }

      // Add lifestyle/room scenes (max 3)
      for (let i = 0; i < Math.min(lifestyleUrls.length, 3); i++) {
        await upsertMediaAsset(pool, {
          product_id: dbProduct.id,
          sku_id: null,
          asset_type: 'lifestyle',
          url: lifestyleUrls[i],
          original_url: lifestyleUrls[i],
          sort_order: sortOrder++,
        });
        lifestyleAdded++;
      }
    }

    matched++;
    if (matched % 20 === 0) {
      console.log(`  Progress: ${matched} matched, ${imagesAdded} images, ${lifestyleAdded} lifestyle`);
    }
  }

  // ── Summary ──
  console.log('\n═══════════════════════════════════════════');
  console.log('  EF API Image Import Summary');
  console.log('═══════════════════════════════════════════');
  console.log(`API products fetched: ${allApiProducts.length}`);
  console.log(`Matched to DB:       ${matched}`);
  console.log(`Skipped (no match):  ${skipped}`);
  console.log(`Images added:        ${imagesAdded}`);
  console.log(`Lifestyle added:     ${lifestyleAdded}`);
  console.log('═══════════════════════════════════════════\n');

  // Verify
  const verify = await pool.query(`
    SELECT
      COUNT(*) as total,
      COUNT(CASE WHEN EXISTS (SELECT 1 FROM media_assets ma WHERE ma.product_id = p.id AND ma.asset_type = 'primary') THEN 1 END) as with_images
    FROM products p
    WHERE p.vendor_id = $1 AND p.is_active = true
  `, [vendorId]);
  const v = verify.rows[0];
  console.log(`Image coverage: ${v.with_images}/${v.total} products (${(v.with_images / v.total * 100).toFixed(1)}%)`);

  await pool.end();
}

function ensureHiRes(url) {
  if (!url) return url;
  // Cloudinary URLs: add/replace transform for high-res
  if (url.includes('cloudinary.com') && url.includes('/upload/')) {
    return url.replace(/\/upload\/[^/]*\//, '/upload/c_scale,w_1200/');
  }
  return url;
}

async function upsertMediaAsset(pool, asset) {
  await pool.query(`
    INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (product_id, asset_type, sort_order) WHERE sku_id IS NULL
    DO UPDATE SET url = EXCLUDED.url, original_url = EXCLUDED.original_url
  `, [asset.product_id, asset.sku_id, asset.asset_type, asset.url, asset.original_url, asset.sort_order]);
}

main().catch(err => {
  console.error('Script failed:', err);
  process.exit(1);
});
