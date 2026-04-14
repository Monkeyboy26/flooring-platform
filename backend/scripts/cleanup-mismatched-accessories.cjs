/**
 * Remove accessories that don't belong to any existing product.
 *
 * For each MSI product: get its main SKU color codes, then delete any
 * accessory whose color code doesn't match ANY product in the same collection.
 * If it matches a sibling product, move it there instead.
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
  m = sku.match(/^(?:P-)?VTT(?:HD)?([A-Z]+)-/i);
  if (m) return m[1].toUpperCase();
  m = sku.match(/^TT([A-Z]{4,})-/i);
  if (m) return m[1].toUpperCase();
  return null;
}

function extractMainColorCode(sku) {
  let m;
  m = sku.match(/^(?:P-)?(?:VTR|VTW|QUTR|QUPO)(?:XL)?(?:HD)?([A-Z]+)/i);
  if (m && m[1].length >= 3) return m[1].toUpperCase();
  return null;
}

async function run() {
  const client = await pool.connect();
  try {
    const { rows: [vendor] } = await client.query(
      "SELECT id FROM vendors WHERE name = 'MSI Surfaces'"
    );
    const vendorId = vendor.id;

    // Find all products with accessories
    const { rows: products } = await client.query(`
      SELECT DISTINCT p.id, p.name, p.collection
      FROM products p JOIN skus s ON s.product_id = p.id
      WHERE p.vendor_id = $1 AND s.variant_type = 'accessory'
    `, [vendorId]);

    console.log(`${products.length} products with accessories\n`);

    // For each collection, build color code → product_id from main SKUs
    const collectionMaps = {};
    for (const prod of products) {
      if (collectionMaps[prod.collection]) continue;
      const { rows: collProds } = await client.query(`
        SELECT p.id, p.name FROM products p
        WHERE p.vendor_id = $1 AND p.collection = $2
      `, [vendorId, prod.collection]);

      const cmap = {};
      for (const cp of collProds) {
        const { rows: mainSkus } = await client.query(`
          SELECT vendor_sku FROM skus
          WHERE product_id = $1 AND (variant_type IS NULL OR variant_type <> 'accessory')
        `, [cp.id]);
        for (const ms of mainSkus) {
          const code = extractMainColorCode(ms.vendor_sku);
          if (code) cmap[code] = cp.id;
        }
      }
      collectionMaps[prod.collection] = cmap;
    }

    await client.query('BEGIN');
    let movedCount = 0, deletedCount = 0, keptCount = 0;

    for (const prod of products) {
      const cmap = collectionMaps[prod.collection] || {};

      // Get main color codes for THIS product
      const { rows: mainSkus } = await client.query(`
        SELECT vendor_sku FROM skus
        WHERE product_id = $1 AND (variant_type IS NULL OR variant_type <> 'accessory')
      `, [prod.id]);
      const myColors = new Set();
      for (const ms of mainSkus) {
        const code = extractMainColorCode(ms.vendor_sku);
        if (code) myColors.add(code);
      }

      // Get accessories
      const { rows: accessories } = await client.query(`
        SELECT id, vendor_sku FROM skus
        WHERE product_id = $1 AND variant_type = 'accessory'
      `, [prod.id]);

      const toDelete = [];
      for (const acc of accessories) {
        const accColor = extractColorCode(acc.vendor_sku);
        if (!accColor) {
          // Can't determine color — keep it
          keptCount++;
          continue;
        }

        // Does this color match this product's main SKUs?
        if (myColors.has(accColor)) {
          keptCount++;
          continue;
        }

        // Try fuzzy match to this product
        let matchesThisProduct = false;
        for (const mc of myColors) {
          if (mc.includes(accColor) || accColor.includes(mc)) {
            matchesThisProduct = true;
            break;
          }
        }
        if (matchesThisProduct) {
          keptCount++;
          continue;
        }

        // Does it match a sibling product in the collection?
        let siblingId = cmap[accColor];
        if (!siblingId) {
          // Fuzzy match across collection
          for (const [code, pid] of Object.entries(cmap)) {
            if (code.includes(accColor) || accColor.includes(code)) {
              siblingId = pid;
              break;
            }
          }
        }

        if (siblingId && siblingId !== prod.id) {
          await client.query('UPDATE skus SET product_id = $1 WHERE id = $2', [siblingId, acc.id]);
          movedCount++;
        } else {
          toDelete.push(acc.id);
        }
      }

      if (toDelete.length > 0) {
        // Delete orphaned accessories
        await client.query(`DELETE FROM sku_attributes WHERE sku_id = ANY($1)`, [toDelete]);
        await client.query(`DELETE FROM media_assets WHERE sku_id = ANY($1)`, [toDelete]);
        await client.query(`DELETE FROM pricing WHERE sku_id = ANY($1)`, [toDelete]);
        await client.query(`DELETE FROM packaging WHERE sku_id = ANY($1)`, [toDelete]);
        await client.query(`DELETE FROM skus WHERE id = ANY($1)`, [toDelete]);
        deletedCount += toDelete.length;
        console.log(`  ${prod.name}: kept ${accessories.length - toDelete.length}, deleted ${toDelete.length} orphans`);
      }
    }

    await client.query('COMMIT');

    console.log(`\n=== Summary ===`);
    console.log(`Accessories kept (correct product): ${keptCount}`);
    console.log(`Accessories moved to sibling: ${movedCount}`);
    console.log(`Orphan accessories deleted: ${deletedCount}`);

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
