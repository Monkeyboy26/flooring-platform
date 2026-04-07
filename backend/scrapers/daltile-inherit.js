import { upsertMediaAsset, appendLog } from './base.js';

/**
 * Daltile image inheritance scraper.
 *
 * Many products in the generic 'daltile' collection have names that start with
 * a known series/collection name (e.g., "Acreage Plank Mt", "Color Wheel Classic
 * Bn Mt"). The named collection versions already have images from the Coveo
 * catalog or DAM scrapers.
 *
 * This scraper copies primary/lifestyle images from the named collection to
 * matching products in the generic 'daltile' collection.
 *
 * Strategy:
 *   1. Load all generic 'daltile' products without images
 *   2. For each, extract the series name from the product name
 *   3. Look up the named collection's images
 *   4. Copy the primary (and lifestyle if available) image to the generic product
 */

export async function run(pool, job) {
  await appendLog(pool, job.id, 'Starting Daltile image inheritance scraper');

  // Step 1: Load generic 'daltile' products without images
  const products = await pool.query(`
    SELECT p.id AS product_id, p.name
    FROM products p
    JOIN vendors v ON v.id = p.vendor_id
    LEFT JOIN media_assets ma ON ma.product_id = p.id
    WHERE v.code = 'DAL'
      AND p.collection = 'daltile'
      AND ma.id IS NULL
    ORDER BY p.name
  `);

  await appendLog(pool, job.id, `Found ${products.rows.length} generic daltile products without images`);

  if (products.rows.length === 0) {
    await appendLog(pool, job.id, 'Nothing to do — done');
    return;
  }

  // Step 2: Build named collection → images map
  const collectionImages = await buildCollectionImageMap(pool);
  await appendLog(pool, job.id, `Built image map for ${collectionImages.size} named collections`);

  // Step 3: Match and copy
  let stats = { matched: 0, unmatched: 0, imagesSet: 0 };

  for (const prod of products.rows) {
    const collName = extractCollectionName(prod.name, collectionImages);

    if (collName && collectionImages.has(collName)) {
      const images = collectionImages.get(collName);

      // Copy primary image
      if (images.primary) {
        await upsertMediaAsset(pool, {
          product_id: prod.product_id,
          sku_id: null,
          asset_type: 'primary',
          url: images.primary,
          original_url: images.primary,
          sort_order: 0,
        });
        stats.imagesSet++;
      }

      // Copy lifestyle image if available
      if (images.lifestyle) {
        await upsertMediaAsset(pool, {
          product_id: prod.product_id,
          sku_id: null,
          asset_type: 'lifestyle',
          url: images.lifestyle,
          original_url: images.lifestyle,
          sort_order: 1,
        });
        stats.imagesSet++;
      }

      stats.matched++;
    } else {
      stats.unmatched++;
    }

    if ((stats.matched + stats.unmatched) % 200 === 0) {
      await appendLog(pool, job.id,
        `Progress: ${stats.matched + stats.unmatched}/${products.rows.length} — ` +
        `${stats.matched} matched, ${stats.imagesSet} images`,
        { products_found: products.rows.length, products_updated: stats.matched }
      );
    }
  }

  await appendLog(pool, job.id,
    `Complete. Products matched: ${stats.matched}, Images saved: ${stats.imagesSet}, ` +
    `Unmatched: ${stats.unmatched}`,
    { products_found: products.rows.length, products_updated: stats.matched }
  );
}

// ─── Collection Image Map ───────────────────────────────────────────────────

async function buildCollectionImageMap(pool) {
  // Get one primary and one lifestyle image per named collection
  const result = await pool.query(`
    SELECT DISTINCT ON (p.collection, ma.asset_type)
      p.collection,
      ma.asset_type,
      ma.url
    FROM products p
    JOIN vendors v ON v.id = p.vendor_id
    JOIN media_assets ma ON ma.product_id = p.id
    WHERE v.code = 'DAL'
      AND p.collection <> 'daltile'
      AND ma.asset_type IN ('primary', 'lifestyle')
    ORDER BY p.collection, ma.asset_type, ma.sort_order
  `);

  const map = new Map(); // lowercase collection name → { primary, lifestyle }

  for (const row of result.rows) {
    const key = row.collection.toLowerCase();
    if (!map.has(key)) map.set(key, {});
    map.get(key)[row.asset_type] = row.url;
  }

  return map;
}

// ─── Name Extraction ────────────────────────────────────────────────────────

/**
 * Extract the collection/series name from a generic daltile product name.
 * Tries progressively shorter word prefixes until a match is found.
 *
 * "Color Wheel Classic Bn Mt" → "color wheel classic"
 * "Acreage Plank Mt" → "acreage"
 * "Marble Attache Lavish Mm Mt" → "marble attache lavish"
 */
function extractCollectionName(productName, collectionImages) {
  const words = productName.split(/\s+/);

  // Try 3-word, 2-word, then 1-word prefixes
  for (let len = Math.min(4, words.length); len >= 1; len--) {
    const guess = words.slice(0, len).join(' ').toLowerCase();
    if (collectionImages.has(guess)) return guess;
  }

  // Special cases: "Stone A La Mod" → "stone a la mod"
  // Try 4-word prefix
  if (words.length >= 4) {
    const guess4 = words.slice(0, 4).join(' ').toLowerCase();
    if (collectionImages.has(guess4)) return guess4;
  }

  return null;
}
