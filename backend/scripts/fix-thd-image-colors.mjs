/**
 * Fix THD image-color matching (v2)
 *
 * Handles both single-color and multi-color scene filenames.
 *
 * Filename patterns:
 *   Single-color: {Collection}{Product}{Color}.jpg  or {Collection}{Color}.jpg
 *   Multi-color:  {DisplayName1}{Color1}and{DisplayName2}{Color2}.jpg
 *
 * For multi-color scenes, we parse which segment belongs to THIS product
 * by checking if the segment starts with the product's display name prefix.
 * This prevents false matches (e.g., "OctoberMist" in the Flat segment
 * being incorrectly assigned to the Stripes product).
 *
 * Steps:
 * 1. Delete all existing alternates for THD products (clean slate)
 * 2. Match ALL product-level lifestyle images to SKUs by color
 *    - Single-color: match color anywhere in filename (existing logic)
 *    - Multi-color: match color only in the segment belonging to this product
 * 3. Delete unmatched product-level lifestyle images (they show wrong colors)
 * 4. Create per-SKU alternates from first matching lifestyle image
 */

import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

const VENDOR_ID = 'a1642099-226a-42eb-bc4f-a77a8e9a675f';

function extractFilename(url) {
  const match = url.match(/\/([^/?]+?)(?:\?|$)/);
  return match ? match[1] : url;
}

function normalize(str) {
  return str.replace(/[\s\-_]/g, '').toLowerCase();
}

function cleanFilename(filename) {
  return filename
    .replace(/\.jpe?g$|\.png$|\.webp$/i, '')
    .replace(/_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, '');
}

/**
 * Split a multi-color scene filename on "and" boundaries.
 * Uses original case to split on "and" followed by uppercase letter,
 * which distinguishes the separator "and" from colors like "Redend".
 */
function splitMultiColorSegments(originalCaseFilename) {
  // Split on "and" that's preceded by lowercase and followed by uppercase
  // e.g., "GlenbrookFlatOctoberMistandGlenbrookStripesPolarWhite"
  //   → ["GlenbrookFlatOctoberMist", "GlenbrookStripesPolarWhite"]
  return originalCaseFilename.split(/(?<=[a-z\d])and(?=[A-Z])/);
}

function isMultiColorScene(originalCaseFilename) {
  return /(?<=[a-z\d])and(?=[A-Z])/.test(originalCaseFilename);
}

/**
 * For a multi-color scene, find the color belonging to THIS product.
 *
 * @param {string} originalFilename - Original-case filename (no extension/uuid)
 * @param {string} displayName - Product display name (e.g., "Glenbrook Stripes")
 * @param {string} collection - Collection name (e.g., "Glenbrook")
 * @param {string} productName - Raw product name (e.g., "Stripes")
 * @param {Object} colorToSkus - Normalized color → [sku_ids]
 * @returns {string|null} - Matched normalized color, or null
 */
function matchMultiColorScene(originalFilename, displayName, collection, productName, colorToSkus) {
  const segments = splitMultiColorSegments(originalFilename);
  const colorKeys = Object.keys(colorToSkus).sort((a, b) => b.length - a.length);

  // Build possible product prefixes to look for in each segment
  // Priority order (most specific first):
  const prefixes = [];
  const normDisplay = normalize(displayName);
  const normCollection = normalize(collection);
  const normName = normalize(productName);

  if (normCollection !== normName) {
    // e.g., "glenbrookstripes" for Glenbrook Stripes
    prefixes.push(normDisplay);
  }
  // e.g., "glenbrook" or "candy" (when collection == name)
  prefixes.push(normCollection);

  // Phase 1: Try to match a segment starting with a known product prefix
  for (const segment of segments) {
    const normSegment = normalize(segment);

    for (const prefix of prefixes) {
      if (!normSegment.startsWith(prefix)) continue;

      let colorPart = normSegment.substring(prefix.length);
      // Strip trailing digits (scene variants like "2", "3")
      colorPart = colorPart.replace(/\d+$/, '');

      if (!colorPart) continue;

      // Check if the remaining text after prefix is a different product name
      // (e.g., "glenbrookflat..." — "flat" is NOT "stripes", so this segment
      //  belongs to a different product even though it starts with collection prefix)
      if (prefix === normCollection && normCollection !== normName) {
        // After stripping collection, does it start with THIS product's name?
        const afterCollection = normSegment.substring(normCollection.length);
        if (!afterCollection.startsWith(normName)) {
          // This segment starts with the collection but continues with a different
          // product name → skip this segment for this product
          continue;
        }
        // Strip the product name too
        colorPart = afterCollection.substring(normName.length).replace(/\d+$/, '');
        if (!colorPart) continue;
      }

      for (const normColor of colorKeys) {
        if (colorPart === normColor || colorPart.startsWith(normColor)) {
          return normColor;
        }
      }
    }
  }

  // Phase 2: Check if any segment is a bare color without prefix
  // (some multi-color scenes of the same product drop the prefix on the 2nd color)
  for (const segment of segments) {
    let normSegment = normalize(segment).replace(/\d+$/, '');
    for (const normColor of colorKeys) {
      if (normSegment === normColor) {
        return normColor;
      }
    }
  }

  return null;
}

async function main() {
  const client = await pool.connect();
  try {
    // Phase 0: Delete ALL existing alternates for THD products (clean slate)
    const delAltRes = await client.query(`
      DELETE FROM media_assets
      WHERE asset_type = 'alternate'
        AND product_id IN (SELECT id FROM products WHERE vendor_id = $1)
      RETURNING id
    `, [VENDOR_ID]);
    console.log(`Deleted ${delAltRes.rowCount} existing alternates (clean slate)`);

    // Get all THD products that have product-level lifestyle images
    const productsRes = await client.query(`
      SELECT DISTINCT p.id, p.name, COALESCE(p.display_name, p.name) as display_name, p.collection
      FROM products p
      JOIN media_assets ma ON ma.product_id = p.id AND ma.asset_type = 'lifestyle' AND ma.sku_id IS NULL
      WHERE p.vendor_id = $1
      ORDER BY display_name
    `, [VENDOR_ID]);

    let singleMatched = 0;
    let multiMatched = 0;
    let unmatched = 0;
    let deleted = 0;
    let alternatesCreated = 0;

    await client.query('BEGIN');

    for (const product of productsRes.rows) {
      // Get SKUs with their color attributes
      const skusRes = await client.query(`
        SELECT s.id as sku_id, sa.value as color
        FROM skus s
        JOIN sku_attributes sa ON sa.sku_id = s.id
        JOIN attributes a ON sa.attribute_id = a.id AND a.slug = 'color'
        WHERE s.product_id = $1
      `, [product.id]);

      if (skusRes.rows.length === 0) continue;

      // Build color → SKU mapping
      const colorToSkus = {};
      for (const sku of skusRes.rows) {
        const normColor = normalize(sku.color);
        if (!colorToSkus[normColor]) colorToSkus[normColor] = [];
        colorToSkus[normColor].push(sku.sku_id);
      }
      const colorKeys = Object.keys(colorToSkus).sort((a, b) => b.length - a.length);

      // Get product-level lifestyle images
      const imagesRes = await client.query(`
        SELECT id, url, sort_order
        FROM media_assets
        WHERE product_id = $1 AND asset_type = 'lifestyle' AND sku_id IS NULL
        ORDER BY sort_order
      `, [product.id]);

      const skuFirstLifestyleUrl = {}; // sku_id → first matching lifestyle url

      for (const img of imagesRes.rows) {
        const rawFilename = extractFilename(img.url);
        const cleanedOriginal = cleanFilename(rawFilename);
        const cleanedLower = cleanedOriginal.toLowerCase();
        const isMulti = isMultiColorScene(cleanedOriginal);

        let matchedColor = null;

        if (isMulti) {
          // Use product-aware parsing for multi-color scenes
          matchedColor = matchMultiColorScene(
            cleanedOriginal,
            product.display_name,
            product.collection,
            product.name,
            colorToSkus
          );
          if (matchedColor) multiMatched++;
        } else {
          // Simple color matching for single-color images
          const fnNorm = normalize(cleanedOriginal);
          for (const normColor of colorKeys) {
            if (fnNorm.includes(normColor)) {
              matchedColor = normColor;
              break;
            }
          }
          if (matchedColor) singleMatched++;
        }

        if (matchedColor) {
          const matchedSkuIds = colorToSkus[matchedColor];
          const firstSku = matchedSkuIds[0];

          // Move to SKU-level
          await client.query(
            `UPDATE media_assets SET sku_id = $1 WHERE id = $2`,
            [firstSku, img.id]
          );

          // Track first lifestyle per SKU for alternate creation
          for (const skuId of matchedSkuIds) {
            if (!skuFirstLifestyleUrl[skuId]) {
              skuFirstLifestyleUrl[skuId] = img.url;
            }
          }
        } else {
          // No match — delete to prevent wrong-color images showing
          await client.query(`DELETE FROM media_assets WHERE id = $1`, [img.id]);
          deleted++;
          unmatched++;
        }
      }

      // Create per-SKU alternates from first matching lifestyle image
      for (const [skuId, url] of Object.entries(skuFirstLifestyleUrl)) {
        await client.query(`
          INSERT INTO media_assets (id, product_id, sku_id, asset_type, url, original_url, sort_order)
          VALUES (gen_random_uuid(), $1, $2, 'alternate', $3, $3, 0)
        `, [product.id, skuId, url]);
        alternatesCreated++;
      }
    }

    await client.query('COMMIT');

    console.log('\n=== THD Image Color Matching Results (v2) ===');
    console.log(`Products processed: ${productsRes.rows.length}`);
    console.log(`Single-color images matched: ${singleMatched}`);
    console.log(`Multi-color scenes matched: ${multiMatched}`);
    console.log(`Unmatched images deleted: ${deleted}`);
    console.log(`Per-SKU alternates created: ${alternatesCreated}`);

    // Show remaining product-level lifestyle count
    const remainRes = await client.query(`
      SELECT count(*) as cnt FROM media_assets ma
      JOIN products p ON p.id = ma.product_id
      WHERE p.vendor_id = $1 AND ma.asset_type = 'lifestyle' AND ma.sku_id IS NULL
    `, [VENDOR_ID]);
    console.log(`Remaining product-level lifestyle images: ${remainRes.rows[0].cnt}`);

    // Show SKU coverage
    const coverageRes = await client.query(`
      SELECT
        count(DISTINCT s.id) FILTER (WHERE ma.id IS NOT NULL) as skus_with_alt,
        count(DISTINCT s.id) as total_skus
      FROM skus s
      JOIN products p ON p.id = s.product_id
      LEFT JOIN media_assets ma ON ma.sku_id = s.id AND ma.asset_type = 'alternate'
      WHERE p.vendor_id = $1
    `, [VENDOR_ID]);
    const c = coverageRes.rows[0];
    console.log(`SKU alternate coverage: ${c.skus_with_alt}/${c.total_skus}`);

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error:', err);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
