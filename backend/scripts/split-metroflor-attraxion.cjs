#!/usr/bin/env node
/**
 * Split Attraxion + OTT SKUs out of base Deja New products into standalone products.
 * These are flooring products sold per sqft/box — NOT accessories.
 *
 * Steps:
 *  1. For each base product with ATX accessories, create a new Attraxion product
 *  2. Move ATX SKUs to the new product, restore variant_type=NULL, restore color names
 *  3. Same for OTT SKUs
 *  4. Copy descriptions from base product
 */
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.PGHOST || 'db',
  port: process.env.PGPORT || 5432,
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'postgres',
  database: process.env.PGDATABASE || 'flooring_pim'
});

// ATX product naming: base display_name → Attraxion display_name
const ATX_NAMES = {
  'Deja New Belgium Weave': 'Deja New Belgium Weave Attraxion',
  'Deja New Oak Framing 7x48': 'Deja New Oak Framing 7x48 Attraxion',
  'Deja New Oak Framing 9x60': 'Deja New Oak Framing 9x60 Attraxion',
  'Deja New Smooth Concrete': 'Deja New Smooth Concrete Attraxion',
};

const OTT_NAMES = {
  'Deja New Oak Framing 7x48': 'Deja New Oak Framing Over The Top',
  'Deja New Smooth Concrete': 'Deja New Smooth Concrete Over The Top',
};

(async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Find all base products that have ATX accessories
    const { rows: baseProducts } = await client.query(`
      SELECT DISTINCT pr.id, pr.display_name, pr.vendor_id, pr.collection,
             pr.category_id, pr.description_long, pr.description_short
      FROM products pr
      JOIN skus s ON s.product_id = pr.id
      WHERE s.variant_type = 'accessory'
        AND (s.vendor_sku LIKE 'MET%ATX' OR s.vendor_sku LIKE 'METOTT%')
        AND pr.status = 'active'
    `);

    let atxMoved = 0, ottMoved = 0, productsCreated = 0;

    for (const base of baseProducts) {
      // --- Handle ATX SKUs ---
      const atxName = ATX_NAMES[base.display_name];
      if (atxName) {
        const { rows: atxSkus } = await client.query(`
          SELECT s.id, s.vendor_sku FROM skus s
          WHERE s.product_id = $1 AND s.variant_type = 'accessory' AND s.vendor_sku LIKE 'MET%ATX'
        `, [base.id]);

        if (atxSkus.length > 0) {
          // Create new Attraxion product
          const { rows: [newProd] } = await client.query(`
            INSERT INTO products (id, vendor_id, name, display_name, collection, status, is_active,
                                  category_id, description_long, description_short)
            VALUES (gen_random_uuid(), $1, $2, $3, $4, 'active', true, $5,
                    REPLACE($6, $7, $3), REPLACE($8, $7, $3))
            RETURNING id
          `, [base.vendor_id, atxName, atxName, base.collection, base.category_id,
              base.description_long || '', base.display_name || '',
              base.description_short || '']);

          // Move SKUs: restore color name from matching_color, clear accessory type
          for (const sku of atxSkus) {
            // Get original color from matching_color attribute
            const { rows: colorRows } = await client.query(`
              SELECT sa.value FROM sku_attributes sa
              WHERE sa.sku_id = $1 AND sa.attribute_id = '51f36f8a-e21e-4dff-bfbb-b016c8e9abbf'
            `, [sku.id]);
            const originalColor = colorRows.length ? colorRows[0].value : null;

            await client.query(`
              UPDATE skus SET product_id = $1, variant_type = NULL,
                variant_name = COALESCE($3, variant_name)
              WHERE id = $2
            `, [newProd.id, sku.id, originalColor]);

            // Move media assets
            await client.query(`UPDATE media_assets SET product_id = $1 WHERE sku_id = $2`, [newProd.id, sku.id]);
            atxMoved++;
          }

          // Remove matching_color attributes (no longer needed)
          await client.query(`
            DELETE FROM sku_attributes
            WHERE attribute_id = '51f36f8a-e21e-4dff-bfbb-b016c8e9abbf'
              AND sku_id IN (SELECT id FROM skus WHERE product_id = $1)
          `, [newProd.id]);

          productsCreated++;
          console.log(`Created: ${atxName} (${atxSkus.length} colors)`);
        }
      }

      // --- Handle OTT SKUs ---
      const ottName = OTT_NAMES[base.display_name];
      if (ottName) {
        const { rows: ottSkus } = await client.query(`
          SELECT s.id, s.vendor_sku FROM skus s
          WHERE s.product_id = $1 AND s.variant_type = 'accessory' AND s.vendor_sku LIKE 'METOTT%'
        `, [base.id]);

        if (ottSkus.length > 0) {
          const { rows: [newProd] } = await client.query(`
            INSERT INTO products (id, vendor_id, name, display_name, collection, status, is_active,
                                  category_id, description_long, description_short)
            VALUES (gen_random_uuid(), $1, $2, $3, $4, 'active', true, $5,
                    REPLACE($6, $7, $3), REPLACE($8, $7, $3))
            RETURNING id
          `, [base.vendor_id, ottName, ottName, base.collection, base.category_id,
              base.description_long || '', base.display_name || '',
              base.description_short || '']);

          for (const sku of ottSkus) {
            const { rows: colorRows } = await client.query(`
              SELECT sa.value FROM sku_attributes sa
              WHERE sa.sku_id = $1 AND sa.attribute_id = '51f36f8a-e21e-4dff-bfbb-b016c8e9abbf'
            `, [sku.id]);
            const originalColor = colorRows.length ? colorRows[0].value : null;

            await client.query(`
              UPDATE skus SET product_id = $1, variant_type = NULL,
                variant_name = COALESCE($3, variant_name)
              WHERE id = $2
            `, [newProd.id, sku.id, originalColor]);

            await client.query(`UPDATE media_assets SET product_id = $1 WHERE sku_id = $2`, [newProd.id, sku.id]);
            ottMoved++;
          }

          await client.query(`
            DELETE FROM sku_attributes
            WHERE attribute_id = '51f36f8a-e21e-4dff-bfbb-b016c8e9abbf'
              AND sku_id IN (SELECT id FROM skus WHERE product_id = $1)
          `, [newProd.id]);

          productsCreated++;
          console.log(`Created: ${ottName} (${ottSkus.length} colors)`);
        }
      }
    }

    // Clean up matching_color attributes from base products too (no longer needed)
    await client.query(`
      DELETE FROM sku_attributes
      WHERE attribute_id = '51f36f8a-e21e-4dff-bfbb-b016c8e9abbf'
    `);

    await client.query('COMMIT');

    console.log(`\nDone:`);
    console.log(`  Products created: ${productsCreated}`);
    console.log(`  ATX SKUs moved: ${atxMoved}`);
    console.log(`  OTT SKUs moved: ${ottMoved}`);

    // Final summary
    const { rows: summary } = await client.query(`
      SELECT pr.display_name, pr.collection,
        COUNT(s.id) as skus,
        MIN(p.cost) as cost,
        MIN(p.retail_price) as retail
      FROM products pr
      JOIN skus s ON s.product_id = pr.id
      JOIN pricing p ON p.sku_id = s.id
      WHERE pr.status = 'active' AND s.vendor_sku LIKE 'MET%'
        AND (pr.display_name LIKE '%Attraxion%' OR pr.display_name LIKE '%Over The Top%')
      GROUP BY pr.id, pr.display_name, pr.collection
      ORDER BY pr.display_name
    `);
    console.log(`\nNew products:`);
    for (const r of summary) {
      console.log(`  ${r.display_name} — ${r.skus} colors, $${r.cost}/sqft cost, $${r.retail}/sqft retail`);
    }

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error:', err.message);
    console.error(err.stack);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
})();
