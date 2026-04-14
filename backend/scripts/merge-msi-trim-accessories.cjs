/**
 * Merge MSI "Trim & Accessories" standalone products into their parent products.
 *
 * MSI trim/accessory SKUs follow the pattern VTT[COLOR]-[TRIM_TYPE]
 * (e.g., VTTABINGD-FSN). The color code matches the main plank SKU
 * pattern VTR[COLOR]... (e.g., VTRABINGD7X48-5MM-20MIL).
 *
 * This script:
 * 1. Finds all MSI "Trim & Accessories" products
 * 2. Extracts color codes from trim SKU vendor_skus
 * 3. Matches them to parent products by finding main SKUs with the same color code
 * 4. Moves trim SKUs to the parent product
 * 5. Deletes the now-empty trim products
 */
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres'
});

/**
 * Extract color code from a trim/accessory vendor_sku.
 * Patterns:
 *   VTT[COLOR]-xxx     → COLOR
 *   P-VTT[COLOR]-xxx   → COLOR  (some have P- prefix)
 *   TT[COLOR]-xxx      → COLOR  (older pattern)
 *   SMOT-..., HDP-...  → null (non-standard, skip)
 */
function extractColorCode(sku) {
  // P-VTT prefix
  let m = sku.match(/^P-VTT([A-Z]+)-/i);
  if (m) return m[1].toUpperCase();
  // VTT prefix (most common)
  m = sku.match(/^VTT([A-Z]+)-/i);
  if (m) return m[1].toUpperCase();
  // TT prefix
  m = sku.match(/^TT([A-Z]+)-/i);
  if (m) return m[1].toUpperCase();
  return null;
}

async function run() {
  const client = await pool.connect();
  try {
    // Get MSI vendor id
    const { rows: [vendor] } = await client.query(
      "SELECT id FROM vendors WHERE name = 'MSI Surfaces'"
    );
    if (!vendor) { console.error('MSI Surfaces vendor not found'); return; }
    const vendorId = vendor.id;

    // Get all trim products
    const { rows: trimProducts } = await client.query(`
      SELECT p.id, p.name, p.collection
      FROM products p
      WHERE p.vendor_id = $1
        AND (p.name ILIKE '%trim%accessor%' OR p.name ILIKE '%accessor%trim%')
      ORDER BY p.name
    `, [vendorId]);

    console.log(`Found ${trimProducts.length} trim products to process\n`);

    // Build a lookup: for each collection, get all non-trim products and their main SKUs
    const { rows: mainSkus } = await client.query(`
      SELECT s.vendor_sku, s.product_id, p.name as product_name, p.collection
      FROM skus s
      JOIN products p ON p.id = s.product_id
      WHERE p.vendor_id = $1
        AND p.name NOT ILIKE '%trim%accessor%'
        AND p.name NOT ILIKE '%accessor%trim%'
        AND s.variant_type IS DISTINCT FROM 'accessory'
    `, [vendorId]);

    // Index main SKUs by collection → color_code → product_id
    // Extract color codes from main SKUs too (VTR[COLOR]...)
    const collectionMap = {};  // collection → { colorCode → { productId, productName } }
    for (const ms of mainSkus) {
      const coll = ms.collection || '';
      if (!collectionMap[coll]) collectionMap[coll] = {};
      // Try to extract color code from main SKU
      let m = ms.vendor_sku.match(/^(?:P-)?VTR([A-Z]+)/i);
      if (!m) m = ms.vendor_sku.match(/^(?:P-)?QUTR([A-Z]+)/i);  // quartz trim
      if (!m) m = ms.vendor_sku.match(/^(?:P-)?QUPO([A-Z]+)/i);
      if (!m) m = ms.vendor_sku.match(/^(?:P-)?T([A-Z]{4,})/i);  // T prefix (tiles)
      if (m) {
        const code = m[1].toUpperCase();
        if (code.length >= 4) {  // avoid short false matches
          collectionMap[coll][code] = {
            productId: ms.product_id,
            productName: ms.product_name
          };
        }
      }
    }

    let moved = 0, skipped = 0, noMatch = 0, deleted = 0;

    await client.query('BEGIN');

    for (const tp of trimProducts) {
      // Get trim SKUs
      const { rows: trimSkus } = await client.query(
        'SELECT id, vendor_sku FROM skus WHERE product_id = $1', [tp.id]
      );

      if (trimSkus.length === 0) {
        // Already empty, just delete
        await client.query('DELETE FROM media_assets WHERE product_id = $1', [tp.id]);
        await client.query('DELETE FROM products WHERE id = $1', [tp.id]);
        deleted++;
        continue;
      }

      const coll = tp.collection || '';
      const collLookup = collectionMap[coll] || {};

      let movedThisProduct = 0;
      const unmatchedSkus = [];

      for (const ts of trimSkus) {
        const colorCode = extractColorCode(ts.vendor_sku);
        if (!colorCode) {
          unmatchedSkus.push(ts.vendor_sku);
          continue;
        }

        // Find matching parent product
        const parent = collLookup[colorCode];
        if (!parent) {
          // Try fuzzy: find any main SKU in same collection containing the color code
          let found = null;
          for (const [code, p] of Object.entries(collLookup)) {
            if (code.includes(colorCode) || colorCode.includes(code)) {
              found = p;
              break;
            }
          }
          if (found) {
            await client.query(
              'UPDATE skus SET product_id = $1 WHERE id = $2',
              [found.productId, ts.id]
            );
            movedThisProduct++;
            moved++;
          } else {
            unmatchedSkus.push(ts.vendor_sku);
          }
          continue;
        }

        await client.query(
          'UPDATE skus SET product_id = $1 WHERE id = $2',
          [parent.productId, ts.id]
        );
        movedThisProduct++;
        moved++;
      }

      if (unmatchedSkus.length > 0) {
        // Try to find parent by product name matching
        // e.g., "Adriel Trim & Accessories" → look for "Adriel" product
        const baseName = tp.name
          .replace(/\s*[\/]?\s*trim\s*&?\s*accessories?\s*/i, '')
          .replace(/\s*(end|flush|quarter|reducer|stair|stairnose|t-molding|endcap|bullnose[d]?|bull)\s*$/i, '')
          .trim();

        if (baseName) {
          const { rows: parentProducts } = await client.query(`
            SELECT p.id, p.name FROM products p
            WHERE p.vendor_id = $1
              AND p.name NOT ILIKE '%trim%accessor%'
              AND p.name ILIKE $2
              AND p.collection = $3
            LIMIT 1
          `, [vendorId, baseName + '%', coll]);

          if (parentProducts.length > 0) {
            for (const us of unmatchedSkus) {
              const skuRow = trimSkus.find(t => t.vendor_sku === us);
              if (skuRow) {
                await client.query(
                  'UPDATE skus SET product_id = $1 WHERE id = $2',
                  [parentProducts[0].id, skuRow.id]
                );
                movedThisProduct++;
                moved++;
              }
            }
            unmatchedSkus.length = 0;
          }
        }
      }

      if (unmatchedSkus.length > 0) {
        noMatch += unmatchedSkus.length;
        skipped++;
        console.log(`  SKIP: ${tp.name} — ${unmatchedSkus.length} unmatched: ${unmatchedSkus.slice(0, 3).join(', ')}${unmatchedSkus.length > 3 ? '...' : ''}`);
      }

      // Check if trim product is now empty
      const { rows: [{ count }] } = await client.query(
        'SELECT COUNT(*) as count FROM skus WHERE product_id = $1', [tp.id]
      );

      if (parseInt(count) === 0) {
        await client.query('DELETE FROM media_assets WHERE product_id = $1', [tp.id]);
        await client.query('DELETE FROM products WHERE id = $1', [tp.id]);
        deleted++;
        if (movedThisProduct > 0) {
          console.log(`  OK: ${tp.name} — ${movedThisProduct} SKUs moved, product deleted`);
        }
      } else {
        console.log(`  PARTIAL: ${tp.name} — ${movedThisProduct} moved, ${count} remaining`);
      }
    }

    await client.query('COMMIT');

    console.log(`\n=== Summary ===`);
    console.log(`Trim products processed: ${trimProducts.length}`);
    console.log(`SKUs moved to parent products: ${moved}`);
    console.log(`Empty trim products deleted: ${deleted}`);
    console.log(`Trim products with unmatched SKUs: ${skipped}`);
    console.log(`Unmatched SKUs total: ${noMatch}`);

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error:', err);
  } finally {
    client.release();
    pool.end();
  }
}

run();
