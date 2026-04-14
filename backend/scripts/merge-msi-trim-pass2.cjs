/**
 * Pass 2: Merge remaining MSI "Trim & Accessories" products.
 *
 * These are trim products whose collection has NO non-trim products.
 * Strategy: match by base name to find the real plank product (which may be
 * in a different collection like "Mccarran", "XL Cyrus", etc.)
 *
 * Also catches standalone trim products that aren't named "Trim & Accessories"
 * but are really accessory SKUs (e.g., "Adriel Srl 78").
 */
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres'
});

async function run() {
  const client = await pool.connect();
  try {
    const { rows: [vendor] } = await client.query(
      "SELECT id FROM vendors WHERE name = 'MSI Surfaces'"
    );
    const vendorId = vendor.id;

    // Get all remaining trim products
    const { rows: trimProducts } = await client.query(`
      SELECT p.id, p.name, p.collection
      FROM products p
      WHERE p.vendor_id = $1
        AND (p.name ILIKE '%trim%accessor%' OR p.name ILIKE '%accessor%trim%')
      ORDER BY p.name
    `, [vendorId]);

    console.log(`${trimProducts.length} remaining trim products\n`);

    // Build index: all products with their main (VTR) SKU count
    const { rows: allProducts } = await client.query(`
      SELECT p.id, p.name, p.collection,
             COUNT(s.id) FILTER (WHERE s.vendor_sku LIKE 'VTR%') as plank_count,
             COUNT(s.id) as total_skus
      FROM products p
      JOIN skus s ON s.product_id = p.id
      WHERE p.vendor_id = $1
        AND p.name NOT ILIKE '%trim%accessor%'
        AND p.name NOT ILIKE '%accessor%trim%'
      GROUP BY p.id, p.name, p.collection
    `, [vendorId]);

    // Filter to products that have actual planks (VTR* SKUs)
    const plankProducts = allProducts.filter(p => p.plank_count > 0);

    await client.query('BEGIN');

    let moved = 0, deleted = 0, skipped = 0;

    for (const tp of trimProducts) {
      // Extract base name from collection, stripping trim type suffixes
      let baseName = (tp.collection || tp.name)
        .replace(/\s*[\/]?\s*trim\s*&?\s*accessories?\s*/i, '')
        .replace(/\s*(Tl|Stairnose|Endcap|Bullnose[d]?|Bull|End|Flush|Quarter|Reducer|Stair|T-molding|Srl|Fsnl?-?Ee|Fsnl?)\s*$/i, '')
        .trim();

      if (!baseName || baseName.length < 3) {
        console.log(`  SKIP (short name): ${tp.name}`);
        skipped++;
        continue;
      }

      // Find plank product whose name contains baseName
      // Prefer exact prefix match, then contains
      let parent = plankProducts.find(p =>
        p.name.toLowerCase().startsWith(baseName.toLowerCase() + ' ') ||
        p.name.toLowerCase() === baseName.toLowerCase()
      );

      if (!parent) {
        // Try with just the first word(s) if baseName has multiple words
        const words = baseName.split(/\s+/);
        if (words.length >= 2) {
          // Try first two words
          const shortName = words.slice(0, 2).join(' ');
          parent = plankProducts.find(p =>
            p.name.toLowerCase().startsWith(shortName.toLowerCase() + ' ') ||
            p.name.toLowerCase() === shortName.toLowerCase()
          );
        }
        if (!parent && words.length >= 1) {
          // Try first word only (must be 5+ chars to avoid false matches)
          if (words[0].length >= 5) {
            const candidates = plankProducts.filter(p =>
              p.name.toLowerCase().startsWith(words[0].toLowerCase() + ' ') ||
              p.name.toLowerCase() === words[0].toLowerCase()
            );
            if (candidates.length === 1) parent = candidates[0];
          }
        }
      }

      if (!parent) {
        // Also search all products (not just plank ones) for the base name
        // This catches cases where the parent exists but has no VTR SKUs
        const fallback = allProducts.find(p =>
          (p.name.toLowerCase().startsWith(baseName.toLowerCase() + ' ') ||
           p.name.toLowerCase() === baseName.toLowerCase()) &&
          p.total_skus > 0
        );
        if (fallback) parent = fallback;
      }

      if (!parent) {
        console.log(`  NO PARENT: ${tp.name} (base="${baseName}")`);
        skipped++;
        continue;
      }

      // Move all trim SKUs to parent
      const { rowCount } = await client.query(
        'UPDATE skus SET product_id = $1 WHERE product_id = $2',
        [parent.id, tp.id]
      );

      // Delete the now-empty trim product
      await client.query('DELETE FROM media_assets WHERE product_id = $1', [tp.id]);
      await client.query('DELETE FROM products WHERE id = $1', [tp.id]);

      moved += rowCount;
      deleted++;
      console.log(`  OK: ${tp.name} → ${parent.name} (${parent.collection}) [${rowCount} SKUs]`);
    }

    await client.query('COMMIT');

    console.log(`\n=== Pass 2 Summary ===`);
    console.log(`SKUs moved: ${moved}`);
    console.log(`Trim products deleted: ${deleted}`);
    console.log(`Skipped (no parent found): ${skipped}`);

    // Check if any remain
    const { rows: [{ count }] } = await client.query(`
      SELECT COUNT(*) as count FROM products p
      WHERE p.vendor_id = $1
        AND (p.name ILIKE '%trim%accessor%' OR p.name ILIKE '%accessor%trim%')
    `, [vendorId]);
    console.log(`\nRemaining trim products: ${count}`);

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error:', err);
  } finally {
    client.release();
    pool.end();
  }
}

run();
