/**
 * Gaia Flooring — Ungroup (Split) Products
 *
 * Reverses the grouping: splits 8 collection-level products back into
 * per-color products. Each flooring SKU becomes its own product,
 * with its matching accessories following.
 *
 * Usage: docker compose exec api node scripts/ungroup-gaia-products.cjs [--dry-run]
 */
const pg = require('pg');

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: 5432, database: 'flooring_pim', user: 'postgres', password: 'postgres',
});

const DRY_RUN = process.argv.includes('--dry-run');

async function run() {
  const client = await pool.connect();
  try {
    const { rows: [vendor] } = await client.query(
      "SELECT id FROM vendors WHERE code = 'GAIA'"
    );
    if (!vendor) { console.error('GAIA vendor not found.'); return; }
    const vendorId = vendor.id;

    // Get all collection-level products that have multiple main SKUs
    const { rows: products } = await client.query(`
      SELECT p.id, p.name, p.collection, p.category_id,
             (SELECT count(*) FROM skus WHERE product_id = p.id AND variant_type IS NULL) as color_count
      FROM products p
      WHERE p.vendor_id = $1 AND p.is_active = true
      ORDER BY p.collection
    `, [vendorId]);

    let totalCreated = 0;

    for (const prod of products) {
      if (prod.color_count <= 1) {
        console.log(`  ${prod.name}: single color, skipping`);
        continue;
      }

      // Get all main (non-accessory) SKUs for this product
      const { rows: mainSkus } = await client.query(`
        SELECT s.id, s.vendor_sku, s.variant_name, s.internal_sku
        FROM skus s
        WHERE s.product_id = $1 AND s.variant_type IS NULL
        ORDER BY s.variant_name
      `, [prod.id]);

      console.log(`  ${prod.name} (${prod.collection}): ${mainSkus.length} colors`);

      // Keep the first SKU on the original product, split the rest
      const keepSku = mainSkus[0];
      const splitSkus = mainSkus.slice(1);

      // Extract color name from variant_name (e.g. "Grey Fox 6.5mm x 7.2\" x 48\"" → "Grey Fox")
      const extractColor = (variantName) => {
        if (!variantName) return 'Unknown';
        // Strip size suffix: everything after first digit preceded by space
        return variantName.replace(/\s+\d+\.?\d*mm\b.*$/, '').trim();
      };

      // Rename the keeper product to the first color name
      const keeperColor = extractColor(keepSku.variant_name);

      if (DRY_RUN) {
        console.log(`    [DRY RUN] Keep "${keeperColor}" on original, split ${splitSkus.length} colors`);
        for (const sku of splitSkus) {
          console.log(`      → ${extractColor(sku.variant_name)} (${sku.vendor_sku})`);
        }
        totalCreated += splitSkus.length;
        continue;
      }

      await client.query('BEGIN');
      try {
        // Rename keeper product to color name
        await client.query(
          'UPDATE products SET name = $1 WHERE id = $2',
          [keeperColor, prod.id]
        );

        // For each split SKU, create a new product and move the SKU + its accessories
        for (const sku of splitSkus) {
          const colorName = extractColor(sku.variant_name);

          // Create new product for this color
          const { rows: [newProd] } = await client.query(`
            INSERT INTO products (id, vendor_id, name, collection, category_id, status, is_active)
            VALUES (gen_random_uuid(), $1, $2, $3, $4, 'active', true)
            ON CONFLICT ON CONSTRAINT products_vendor_collection_name_unique
            DO UPDATE SET category_id = EXCLUDED.category_id, status = 'active', is_active = true
            RETURNING id
          `, [vendorId, colorName, prod.collection, prod.category_id]);

          // Move the main flooring SKU to the new product
          await client.query(
            'UPDATE skus SET product_id = $1 WHERE id = $2',
            [newProd.id, sku.id]
          );

          // Move matching accessories (same vendor_sku prefix)
          // Accessories have vendor_sku like "GA652310-EC", main SKU is "GA652310"
          await client.query(`
            UPDATE skus SET product_id = $1
            WHERE product_id = $2 AND variant_type = 'accessory'
              AND vendor_sku LIKE $3 || '-%'
          `, [newProd.id, prod.id, sku.vendor_sku]);

          // Move SKU-level media_assets
          await client.query(
            'UPDATE media_assets SET product_id = $1 WHERE sku_id = $2',
            [newProd.id, sku.id]
          );

          // Update cart_items
          await client.query(
            'UPDATE cart_items SET product_id = $1 WHERE sku_id = $2',
            [newProd.id, sku.id]
          );

          totalCreated++;
          console.log(`    → ${colorName} (${sku.vendor_sku})`);
        }

        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`    ✗ FAILED: ${err.message}`);
      }
    }

    // Final counts
    const { rows: [final] } = await client.query(`
      SELECT count(*) as products,
             (SELECT count(*) FROM skus s JOIN products p ON p.id = s.product_id
              WHERE p.vendor_id = $1 AND s.variant_type IS NULL) as main_skus,
             (SELECT count(*) FROM skus s JOIN products p ON p.id = s.product_id
              WHERE p.vendor_id = $1 AND s.variant_type = 'accessory') as acc_skus,
             (SELECT count(*) FROM media_assets ma JOIN skus s ON s.id = ma.sku_id
              JOIN products p ON p.id = s.product_id WHERE p.vendor_id = $1) as images
      FROM products WHERE vendor_id = $1
    `, [vendorId]);

    console.log(`\n=== Ungroup Complete ===`);
    console.log(`Products: ${final.products} (was 8)`);
    console.log(`Main SKUs: ${final.main_skus}`);
    console.log(`Accessory SKUs: ${final.acc_skus}`);
    console.log(`Images: ${final.images}`);
    console.log(`New products created: ${totalCreated}`);
    if (DRY_RUN) console.log('\n[DRY RUN] No changes were made.');

  } finally {
    client.release();
    await pool.end();
  }
}

run().catch(err => { console.error(err); process.exit(1); });
