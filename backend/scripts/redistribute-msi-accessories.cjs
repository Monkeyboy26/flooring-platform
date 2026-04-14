/**
 * Redistribute MSI accessories that were dumped into a single product.
 *
 * Problem: Pass 1 moved ALL accessories from a collection-level trim product
 * into one parent (e.g., all 144 Mccarran accessories → Mccarran Blonde).
 * Each accessory has a color code (VTT[COLOR]-...) that should match
 * a main SKU's color code in the correct product.
 *
 * Fix: For each product that has duplicate accessory types, match each
 * accessory's color code to the correct product's main SKU color codes.
 */
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres'
});

function extractColorCode(sku) {
  let m;
  // P-VTT prefix
  m = sku.match(/^P-VTT(?:HD)?([A-Z]+)-/i);
  if (m) return m[1].toUpperCase();
  // VTTHD prefix (hybrid density)
  m = sku.match(/^VTTHD([A-Z]+)-/i);
  if (m) return m[1].toUpperCase();
  // VTT prefix
  m = sku.match(/^VTT([A-Z]+)-/i);
  if (m) return m[1].toUpperCase();
  // TT prefix
  m = sku.match(/^TT([A-Z]+)-/i);
  if (m) return m[1].toUpperCase();
  return null;
}

function extractMainColorCode(sku) {
  let m;
  // VTR, VTW, QUTR, etc.
  m = sku.match(/^(?:P-)?(?:VTR|VTW|QUTR|QUPO)(?:HD)?([A-Z]+)/i);
  if (m && m[1].length >= 3) return m[1].toUpperCase();
  // TT prefix for non-trim
  m = sku.match(/^TT([A-Z]{4,})/i);
  if (m) return m[1].toUpperCase();
  return null;
}

async function run() {
  const client = await pool.connect();
  try {
    const { rows: [vendor] } = await client.query(
      "SELECT id FROM vendors WHERE name = 'MSI Surfaces'"
    );
    const vendorId = vendor.id;

    // Find products with duplicate accessory types
    const { rows: dupeProducts } = await client.query(`
      SELECT DISTINCT p.id, p.name, p.collection
      FROM products p
      JOIN skus s ON s.product_id = p.id
      WHERE p.vendor_id = $1 AND s.variant_type = 'accessory'
      GROUP BY p.id, p.name, p.collection, s.variant_name
      HAVING COUNT(*) > 1
    `, [vendorId]);

    const uniqueProducts = [...new Map(dupeProducts.map(p => [p.id, p])).values()];
    console.log(`${uniqueProducts.length} products with duplicate accessories\n`);

    // For each product, build a color code → product mapping from sibling products
    await client.query('BEGIN');
    let moved = 0, kept = 0, noMatch = 0;

    for (const prod of uniqueProducts) {
      // Get all products in same collection
      const { rows: collectionProducts } = await client.query(`
        SELECT p.id, p.name FROM products p
        WHERE p.vendor_id = $1 AND p.collection = $2
        ORDER BY p.name
      `, [vendorId, prod.collection]);

      // Build color code → product_id map from main (non-accessory) SKUs
      const colorToProduct = {};
      for (const cp of collectionProducts) {
        const { rows: mainSkus } = await client.query(`
          SELECT vendor_sku FROM skus
          WHERE product_id = $1 AND (variant_type IS NULL OR variant_type <> 'accessory')
        `, [cp.id]);

        for (const ms of mainSkus) {
          const code = extractMainColorCode(ms.vendor_sku);
          if (code) colorToProduct[code] = cp.id;
        }
      }

      // Get all accessories on this product
      const { rows: accessories } = await client.query(`
        SELECT id, vendor_sku, variant_name FROM skus
        WHERE product_id = $1 AND variant_type = 'accessory'
      `, [prod.id]);

      for (const acc of accessories) {
        const accColor = extractColorCode(acc.vendor_sku);
        if (!accColor) { kept++; continue; }

        const correctProduct = colorToProduct[accColor];
        if (!correctProduct) {
          // Try fuzzy: find a main color code that contains or is contained by the acc color
          let found = null;
          for (const [code, pid] of Object.entries(colorToProduct)) {
            if (code === accColor || code.includes(accColor) || accColor.includes(code)) {
              found = pid;
              break;
            }
          }
          if (found && found !== prod.id) {
            await client.query('UPDATE skus SET product_id = $1 WHERE id = $2', [found, acc.id]);
            moved++;
          } else {
            noMatch++;
          }
          continue;
        }

        if (correctProduct !== prod.id) {
          await client.query('UPDATE skus SET product_id = $1 WHERE id = $2', [correctProduct, acc.id]);
          moved++;
        } else {
          kept++;
        }
      }

      console.log(`  ${prod.name}: processed ${accessories.length} accessories`);
    }

    await client.query('COMMIT');

    console.log(`\n=== Summary ===`);
    console.log(`Accessories moved to correct product: ${moved}`);
    console.log(`Already correct: ${kept}`);
    console.log(`No match found: ${noMatch}`);

    // Check remaining duplicates
    const { rows: remaining } = await client.query(`
      SELECT p.name, s.variant_name, COUNT(*) as dupes
      FROM skus s JOIN products p ON p.id = s.product_id
      WHERE p.vendor_id = $1 AND s.variant_type = 'accessory'
      GROUP BY p.name, s.variant_name
      HAVING COUNT(*) > 1
      ORDER BY COUNT(*) DESC LIMIT 10
    `, [vendorId]);

    if (remaining.length > 0) {
      console.log(`\nRemaining duplicates:`);
      remaining.forEach(r => console.log(`  ${r.name}: ${r.dupes}x ${r.variant_name}`));
    } else {
      console.log(`\nNo remaining duplicates!`);
    }

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error:', err);
  } finally {
    client.release();
    pool.end();
  }
}

run();
