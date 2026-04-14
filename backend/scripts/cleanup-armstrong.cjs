#!/usr/bin/env node
/**
 * cleanup-armstrong.cjs
 *
 * Legacy cleanup script for old EDI 832 imports where each Armstrong color
 * was imported as a separate product (e.g., 99 products instead of 5).
 *
 * Merges per-color Armstrong "products" into proper product lines with
 * multiple color SKUs. Cleans up junk in collection names ({KK}, packaging
 * codes) and variant names, deletes wrong media_assets.
 *
 * NOTE: The 832 importer has been improved and now groups Armstrong products
 * correctly. This script is kept as a safety net for cleaning up old data.
 *
 * Run: docker exec flooring-api node scripts/cleanup-armstrong.cjs
 *   or: node backend/scripts/cleanup-armstrong.cjs
 *
 * Safe to run multiple times (idempotent — checks current state).
 */

const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || process.env.PGHOST || 'localhost',
  port: process.env.DB_PORT || process.env.PGPORT || 5432,
  database: process.env.DB_NAME || process.env.PGDATABASE || 'flooring_pim',
  user: process.env.DB_USER || process.env.PGUSER || 'postgres',
  password: process.env.DB_PASS || process.env.PGPASSWORD || 'postgres',
});

/**
 * Clean a raw Armstrong collection field into a color name.
 * Input examples:
 *   "Armstrong - ABSINTHE BLUE"
 *   "Armstrong - AGATE GRAY    KK"
 *   "Armstrong - BEIGE   {KK}"
 *   "Armstrong - BLUE ASH-M13 GAL S-693  4/CTN"
 *   "Armstrong - COCOA-G7 QT S-693      12/CTN"
 *   "Armstrong - GOLDEN GLAZE    {KK}"
 *   "Armstrong - TOPAZ"
 * Output: title-cased color name like "Absinthe Blue", "Agate Gray", etc.
 */
function extractColorName(collection) {
  let color = collection;

  // Strip "Armstrong - " prefix
  color = color.replace(/^Armstrong\s*[-–—]\s*/i, '');

  // Strip packaging info: GAL S-693 4/CTN, QTS/S-693 12/CTN, QT S-693 12/CTN, GAL S693, S-693 12/CTN, etc.
  color = color.replace(/\s+(GAL|QTS?|QT)\s*\/?S-?\d+.*$/i, '');
  color = color.replace(/\s+S-?\d{3}\s+\d+\/CTN.*$/i, '');

  // Strip {KK}, KK suffixes (sometimes with leading whitespace)
  color = color.replace(/\s*\{?KK\}?\s*$/i, '');

  // Strip grout code suffixes like -M13, -G7, -F6, -A1, -B2, -E5, -H8, -I9, -J10, -K11, -L12, -C3, -D4
  // These are single-letter + 1-2 digit codes at end (for grout products)
  color = color.replace(/\s*-\s*[A-Z]\d{1,2}\s*$/i, '');

  // Collapse whitespace
  color = color.replace(/\s+/g, ' ').trim();

  // Title case
  color = color
    .toLowerCase()
    .replace(/\b\w/g, c => c.toUpperCase());

  return color;
}

/**
 * Clean a product name:
 *   "ALTERNA" → "Alterna"
 *   "ALTERNA PREMIX ACRYLIC GROUT" → "Alterna Premix Acrylic Grout"
 *   "AMERICAN CHARM 12MIL" → "American Charm 12mil"
 *   "ABODE 12'                 48\"M" → "Abode 12' 48\"M"
 */
function cleanProductName(name) {
  // Collapse whitespace first
  let clean = name.replace(/\s+/g, ' ').trim();

  // Title case, but preserve measurements like 12MIL, 6MIL, 12', 48"M
  clean = clean
    .toLowerCase()
    .replace(/\b\w/g, c => c.toUpperCase())
    // Restore common measurement patterns
    .replace(/(\d+)Mil\b/g, '$1mil')
    .replace(/(\d+)'/g, "$1'");

  return clean;
}

/**
 * Build the clean collection value: "Armstrong - {ProductLine}"
 */
function buildCollection(cleanProductName) {
  return `Armstrong - ${cleanProductName}`;
}

async function main() {
  const client = await pool.connect();

  try {
    // Find Armstrong vendor_id
    const vendorRes = await client.query(`
      SELECT DISTINCT p.vendor_id
      FROM products p
      WHERE p.collection LIKE 'Armstrong%'
      LIMIT 1
    `);
    if (vendorRes.rows.length === 0) {
      console.log('No Armstrong products found. Nothing to do.');
      return;
    }
    const vendorId = vendorRes.rows[0].vendor_id;
    console.log(`Armstrong vendor_id: ${vendorId}`);

    // Load all Armstrong products with their SKUs
    const allRows = await client.query(`
      SELECT p.id AS product_id, p.name AS product_name, p.collection,
             s.id AS sku_id, s.vendor_sku, s.internal_sku, s.variant_name
      FROM products p
      JOIN skus s ON s.product_id = p.id
      WHERE p.vendor_id = $1 AND p.collection LIKE 'Armstrong%'
      ORDER BY p.name, p.collection
    `, [vendorId]);

    console.log(`Found ${allRows.rows.length} Armstrong SKUs across products`);

    // Group by product name (the real product line)
    const groups = new Map();
    for (const row of allRows.rows) {
      const key = row.product_name.trim();
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }

    console.log(`\nProduct lines found: ${groups.size}`);
    for (const [name, rows] of groups) {
      console.log(`  ${name}: ${rows.length} SKUs across ${new Set(rows.map(r => r.product_id)).size} products`);
    }

    // Begin transaction
    await client.query('BEGIN');

    let productsKept = 0;
    let productsDeleted = 0;
    let skusMoved = 0;
    let mediaDeleted = 0;

    for (const [rawName, rows] of groups) {
      const cleanName = cleanProductName(rawName);
      const collection = buildCollection(cleanName);

      // Get unique product IDs in this group
      const productIds = [...new Set(rows.map(r => r.product_id))];

      // Pick the keeper (lowest-created, i.e. first in the set — they're UUIDs but we'll pick the first from query order)
      const keeperId = productIds[0];
      const otherIds = productIds.slice(1);

      console.log(`\n--- ${rawName} → "${cleanName}" ---`);
      console.log(`  Keeper product: ${keeperId}`);
      console.log(`  Products to merge: ${otherIds.length}`);

      // Update variant_name on each SKU based on its old product's collection.
      // Only do this when we have per-color collection data (multiple product rows per group),
      // not when collection is already the shared product-line value.
      const hasPerColorData = productIds.length > 1;
      if (hasPerColorData) {
        for (const row of rows) {
          const colorName = extractColorName(row.collection);
          if (colorName && colorName !== cleanName) {
            await client.query(
              'UPDATE skus SET variant_name = $1 WHERE id = $2',
              [colorName, row.sku_id]
            );
          }
        }
      }

      // Move SKUs from other products to the keeper
      if (otherIds.length > 0) {
        const moveRes = await client.query(`
          UPDATE skus SET product_id = $1 WHERE product_id = ANY($2::uuid[])
        `, [keeperId, otherIds]);
        skusMoved += moveRes.rowCount;
        console.log(`  Moved ${moveRes.rowCount} SKUs to keeper`);
      }

      // Update keeper product: clean name + collection
      // Check for uniqueness constraint first — there might be a conflict
      // since we're changing the collection to a shared value
      await client.query(`
        UPDATE products SET
          name = $1,
          collection = $2,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = $3
      `, [cleanName, collection, keeperId]);
      productsKept++;

      // Delete ALL media_assets for Armstrong products (all wrong/duplicate)
      const delMedia = await client.query(`
        DELETE FROM media_assets WHERE product_id = ANY($1::uuid[])
      `, [[keeperId, ...otherIds]]);
      mediaDeleted += delMedia.rowCount;

      // Delete orphaned products (no SKUs left)
      if (otherIds.length > 0) {
        const delRes = await client.query(`
          DELETE FROM products WHERE id = ANY($1::uuid[])
        `, [otherIds]);
        productsDeleted += delRes.rowCount;
        console.log(`  Deleted ${delRes.rowCount} orphaned products`);
      }
    }

    await client.query('COMMIT');

    console.log('\n========== SUMMARY ==========');
    console.log(`Products kept:    ${productsKept}`);
    console.log(`Products deleted: ${productsDeleted}`);
    console.log(`SKUs moved:       ${skusMoved}`);
    console.log(`Media deleted:    ${mediaDeleted}`);

    // Verify
    const verify = await client.query(`
      SELECT p.name, p.collection, COUNT(s.id) as skus
      FROM products p
      JOIN skus s ON s.product_id = p.id
      WHERE p.vendor_id = $1 AND p.collection LIKE 'Armstrong%'
      GROUP BY p.id, p.name, p.collection
      ORDER BY p.name
    `, [vendorId]);
    console.log('\nVerification — final product state:');
    for (const row of verify.rows) {
      console.log(`  ${row.name} (${row.collection}): ${row.skus} SKUs`);
    }

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('ERROR — rolled back:', err.message);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
