#!/usr/bin/env node
/**
 * Split Melange Tile images by color.
 *
 * Problem: The scraper scraped collection pages that show ALL colors together,
 * then assigned the full set of images to every color product. E.g. "Avana"
 * got images of Canapa, Lino, Moro too.
 *
 * Fix: Parse image filenames for color hints and reassign each image to only
 * the matching color product. Generic/unmatched images become lifestyle
 * fallbacks on all products in the collection.
 *
 * Usage:
 *   node backend/scripts/split-melange-images-by-color.cjs --dry-run
 *   node backend/scripts/split-melange-images-by-color.cjs
 */

const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: 5432,
  database: 'flooring_pim',
  user: 'postgres',
  password: 'postgres',
});

const DRY_RUN = process.argv.includes('--dry-run');

/**
 * Normalize a string for fuzzy matching: lowercase, strip hyphens,
 * underscores, spaces, URL-encoded chars, and common suffixes.
 */
function normalize(str) {
  return decodeURIComponent(str)
    .toLowerCase()
    .replace(/[-_\s]+/g, '')
    .replace(/%[0-9a-f]{2}/gi, '');
}

/**
 * Extract just the filename (last path segment) from a URL,
 * stripping query params.
 */
function getFilename(url) {
  try {
    const path = new URL(url).pathname;
    return path.split('/').pop() || '';
  } catch {
    return url.split('/').pop().split('?')[0] || '';
  }
}

/**
 * Try to match an image URL to one of the color names.
 * Returns the matched color name or null if generic.
 */
function matchColor(imageUrl, colorNames) {
  const filename = normalize(getFilename(imageUrl));
  for (const color of colorNames) {
    const normColor = normalize(color);
    // Skip very short color names (<=2 chars) to avoid false positives
    if (normColor.length <= 2) continue;
    if (filename.includes(normColor)) {
      return color;
    }
  }
  return null;
}

async function run() {
  console.log(DRY_RUN ? '=== DRY RUN — no changes will be made ===\n' : '=== LIVE RUN ===\n');

  // 1. Find the Melange vendor
  const vendorRes = await pool.query("SELECT id FROM vendors WHERE code = 'MELANGE'");
  if (!vendorRes.rows.length) {
    console.error('Melange vendor not found.');
    process.exit(1);
  }
  const vendorId = vendorRes.rows[0].id;

  // 2. Get all Melange products grouped by collection
  const prodRes = await pool.query(`
    SELECT id, name, collection
    FROM products
    WHERE vendor_id = $1
    ORDER BY collection, name
  `, [vendorId]);

  // Group products by collection
  const collections = new Map(); // collection → [{id, name}]
  for (const row of prodRes.rows) {
    if (!collections.has(row.collection)) {
      collections.set(row.collection, []);
    }
    collections.get(row.collection).push({ id: row.id, name: row.name });
  }

  console.log(`Found ${prodRes.rowCount} products across ${collections.size} collections\n`);

  // 3. Get all existing media_assets for Melange products
  const productIds = prodRes.rows.map(r => r.id);
  const mediaRes = await pool.query(`
    SELECT ma.id, ma.product_id, ma.url, ma.original_url, ma.asset_type, ma.sort_order
    FROM media_assets ma
    WHERE ma.product_id = ANY($1)
    ORDER BY ma.product_id, ma.sort_order
  `, [productIds]);

  // Group media by product_id
  const mediaByProduct = new Map();
  for (const row of mediaRes.rows) {
    if (!mediaByProduct.has(row.product_id)) {
      mediaByProduct.set(row.product_id, []);
    }
    mediaByProduct.get(row.product_id).push(row);
  }

  let totalDeleted = 0;
  let totalInserted = 0;

  // 4. Process each collection
  for (const [collectionName, products] of collections) {
    const colorNames = products.map(p => p.name);

    // Collect all unique image URLs across all products in this collection
    const allUrls = new Set();
    for (const product of products) {
      const media = mediaByProduct.get(product.id) || [];
      for (const m of media) {
        allUrls.add(m.url);
      }
    }

    if (allUrls.size === 0) {
      console.log(`[${collectionName}] No images — skipping`);
      continue;
    }

    // Match each image URL to a color
    const colorImages = new Map();  // color name → [url]
    const genericImages = [];       // unmatched urls

    for (const url of allUrls) {
      const matchedColor = matchColor(url, colorNames);
      if (matchedColor) {
        if (!colorImages.has(matchedColor)) {
          colorImages.set(matchedColor, []);
        }
        colorImages.get(matchedColor).push(url);
      } else {
        genericImages.push(url);
      }
    }

    console.log(`[${collectionName}] ${allUrls.size} unique images, ${colorImages.size} colors matched, ${genericImages.length} generic`);
    for (const [color, urls] of colorImages) {
      console.log(`  ${color}: ${urls.map(u => getFilename(u)).join(', ')}`);
    }
    if (genericImages.length) {
      console.log(`  Generic: ${genericImages.map(u => getFilename(u)).join(', ')}`);
    }

    if (DRY_RUN) {
      // Show what would happen
      for (const product of products) {
        const ownImages = colorImages.get(product.name) || [];
        const total = ownImages.length + genericImages.length;
        console.log(`  → ${product.name} would get ${ownImages.length} color-specific + ${genericImages.length} generic = ${total} images`);
      }
      console.log();
      continue;
    }

    // --- LIVE: Delete old and re-insert ---
    const collectionProductIds = products.map(p => p.id);

    // Delete all existing media_assets for this collection's products
    const delRes = await pool.query(
      'DELETE FROM media_assets WHERE product_id = ANY($1)',
      [collectionProductIds]
    );
    totalDeleted += delRes.rowCount;

    // Re-insert with correct assignments
    for (const product of products) {
      const ownImages = colorImages.get(product.name) || [];
      // Build ordered list: own color images first, then generics as lifestyle
      const finalImages = [];

      for (const url of ownImages) {
        finalImages.push({ url, isColorSpecific: true });
      }
      for (const url of genericImages) {
        finalImages.push({ url, isColorSpecific: false });
      }

      // Cap at 6 images per product
      const toInsert = finalImages.slice(0, 6);

      for (let i = 0; i < toInsert.length; i++) {
        const { url, isColorSpecific } = toInsert[i];
        let assetType;
        if (!isColorSpecific) {
          assetType = 'lifestyle';
        } else if (i === 0) {
          assetType = 'primary';
        } else if (i <= 2) {
          assetType = 'alternate';
        } else {
          assetType = 'lifestyle';
        }

        await pool.query(`
          INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
          VALUES ($1, NULL, $2, $3, $3, $4)
        `, [product.id, assetType, url, i]);
        totalInserted++;
      }

      console.log(`  ✓ ${product.name}: ${toInsert.length} images assigned`);
    }
    console.log();
  }

  if (!DRY_RUN) {
    console.log(`\n=== Done ===`);
    console.log(`Deleted: ${totalDeleted} old media_assets`);
    console.log(`Inserted: ${totalInserted} new media_assets`);
  }
}

run()
  .catch(err => { console.error(err); process.exit(1); })
  .finally(() => pool.end());
