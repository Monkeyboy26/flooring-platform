#!/usr/bin/env node
/**
 * Fix MSI product grouping: Separate SMOT (mosaic) SKUs from slab/tile/countertop SKUs
 *
 * Problem: Many MSI products have completely different product types grouped together
 * because they share a stone name (e.g., "Azul" groups mosaic tiles with quartzite slabs).
 *
 * Fix: Create separate "Mosaic" products for SMOT SKUs in mixed-type products.
 */

const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres'
});

const MOSAIC_CATEGORY_ID = '650e8400-e29b-41d4-a716-446655440014';
const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  const client = await pool.connect();

  try {
    if (DRY_RUN) console.log('=== DRY RUN MODE ===\n');

    // Step 1: Find all MSI products that have BOTH SMOT and non-SMOT SKUs
    const { rows: mixedProducts } = await client.query(`
      WITH msi_vendor AS (SELECT id FROM vendors WHERE code = 'MSI'),
      smot_products AS (
        SELECT DISTINCT s.product_id
        FROM skus s JOIN products p ON s.product_id = p.id
        WHERE p.vendor_id = (SELECT id FROM msi_vendor)
          AND s.vendor_sku LIKE 'SMOT%'
      ),
      non_smot_products AS (
        SELECT DISTINCT s.product_id
        FROM skus s JOIN products p ON s.product_id = p.id
        WHERE p.vendor_id = (SELECT id FROM msi_vendor)
          AND s.vendor_sku NOT LIKE 'SMOT%'
      )
      SELECT p.id as product_id, p.name, p.collection, p.display_name, p.vendor_id, p.slug,
             c.name as category_name, c.id as category_id
      FROM products p
      JOIN categories c ON p.category_id = c.id
      WHERE p.id IN (SELECT product_id FROM smot_products INTERSECT SELECT product_id FROM non_smot_products)
      ORDER BY p.name;
    `);

    console.log(`Found ${mixedProducts.length} products with mixed SMOT + non-SMOT SKUs\n`);

    let totalMoved = 0;
    let productsCreated = 0;

    for (const prod of mixedProducts) {
      // Get all SMOT SKUs for this product
      const { rows: smotSkus } = await client.query(`
        SELECT s.id as sku_id, s.vendor_sku, s.variant_name, s.sell_by, s.variant_type
        FROM skus s WHERE s.product_id = $1 AND s.vendor_sku LIKE 'SMOT%'
        ORDER BY s.vendor_sku
      `, [prod.product_id]);

      // Get non-SMOT SKU count to make sure we're not emptying the product
      const { rows: [{ count: nonSmotCount }] } = await client.query(`
        SELECT count(*) FROM skus WHERE product_id = $1 AND vendor_sku NOT LIKE 'SMOT%'
      `, [prod.product_id]);

      if (parseInt(nonSmotCount) === 0) {
        console.log(`  SKIP ${prod.name}: no non-SMOT SKUs would remain`);
        continue;
      }

      console.log(`\n--- ${prod.name} (${prod.category_name}) ---`);
      console.log(`  SMOT SKUs to separate: ${smotSkus.length}`);
      console.log(`  Non-SMOT SKUs remaining: ${nonSmotCount}`);
      smotSkus.forEach(s => console.log(`    ${s.vendor_sku}`));

      // Determine new product name
      // Use the display_name or collection, clean it up, add "Mosaic"
      let baseName = prod.display_name || prod.collection || prod.name;
      // Clean up names like "Carrara White White" → "Carrara White"
      const words = baseName.split(' ');
      if (words.length >= 2 && words[words.length - 1] === words[words.length - 2]) {
        baseName = words.slice(0, -1).join(' ');
      }
      // Fix edge case: "Black and" → "Black and White", "White and" → "White"
      if (baseName.endsWith(' and')) {
        baseName = baseName.replace(/ and$/, '');
      }
      const mosaicProductName = baseName + ' Mosaic';
      const mosaicSlug = mosaicProductName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

      console.log(`  → New product: "${mosaicProductName}" (slug: ${mosaicSlug})`);

      if (!DRY_RUN) {
        await client.query('BEGIN');

        try {
          // Create new mosaic product
          const newProductId = uuidv4();
          await client.query(`
            INSERT INTO products (id, vendor_id, name, collection, category_id, status, display_name, slug, is_active)
            VALUES ($1, $2, $3, $4, $5, 'active', $6, $7, true)
          `, [newProductId, prod.vendor_id, mosaicProductName, baseName, MOSAIC_CATEGORY_ID, baseName + ' Mosaic', mosaicSlug]);

          // Move SMOT SKUs to new product
          const skuIds = smotSkus.map(s => s.sku_id);
          await client.query(`
            UPDATE skus SET product_id = $1 WHERE id = ANY($2::uuid[])
          `, [newProductId, skuIds]);

          // Move any SKU-specific media to new product
          await client.query(`
            UPDATE media_assets SET product_id = $1 WHERE sku_id = ANY($2::uuid[])
          `, [newProductId, skuIds]);

          // Copy lifestyle images from CDN that are clearly mosaic images
          const { rows: lifestyleMedia } = await client.query(`
            SELECT id, url, asset_type, sort_order FROM media_assets
            WHERE product_id = $1 AND sku_id IS NULL
              AND (url LIKE '%mosaic%' OR url LIKE '%penny%' OR url LIKE '%hexagon%'
                   OR url LIKE '%herringbone%' OR url LIKE '%basketweave%' OR url LIKE '%scallop%')
          `, [prod.product_id]);

          for (const media of lifestyleMedia) {
            // Move mosaic-related images to new product (not copy)
            await client.query(`
              UPDATE media_assets SET product_id = $1 WHERE id = $2
            `, [newProductId, media.id]);
            console.log(`  → Moved mosaic image: ${media.url.substring(media.url.lastIndexOf('/') + 1)}`);
          }

          await client.query('COMMIT');
          productsCreated++;
          totalMoved += smotSkus.length;
          console.log(`  ✓ Created product ${newProductId}, moved ${smotSkus.length} SKUs`);
        } catch (err) {
          await client.query('ROLLBACK');
          console.error(`  ✗ Error: ${err.message}`);
        }
      } else {
        totalMoved += smotSkus.length;
        productsCreated++;
      }
    }

    console.log(`\n=== Summary ===`);
    console.log(`Products created: ${productsCreated}`);
    console.log(`SKUs moved: ${totalMoved}`);

    // Step 2: Fix the Azul product specifically — RSL SKUs from different stones
    console.log(`\n\n=== Step 2: Fix Azul product RSL grouping ===`);

    const azulProductId = 'e459f3d8-d861-470c-b0c0-4183cede49ef';
    const { rows: azulSkus } = await client.query(`
      SELECT s.id as sku_id, s.vendor_sku, s.variant_name
      FROM skus s WHERE s.product_id = $1
      ORDER BY s.vendor_sku
    `, [azulProductId]);

    console.log(`Remaining Azul SKUs after SMOT separation:`);
    azulSkus.forEach(s => console.log(`  ${s.vendor_sku}`));

    // Group RSL SKUs by stone name
    const stoneGroups = {};
    for (const sku of azulSkus) {
      let stoneName;
      const match = sku.vendor_sku.match(/RSL-([A-Z]+?)(-\d|$)/);
      if (match) {
        stoneName = match[1];
      } else {
        stoneName = '__current__'; // Keep in current product
      }
      if (!stoneGroups[stoneName]) stoneGroups[stoneName] = [];
      stoneGroups[stoneName].push(sku);
    }

    console.log(`\nStone groups found:`);
    for (const [stone, skus] of Object.entries(stoneGroups)) {
      console.log(`  ${stone}: ${skus.length} SKUs`);
    }

    // If there are multiple RSL stone names, separate them
    const stoneNames = Object.keys(stoneGroups).filter(k => k !== '__current__');
    if (stoneNames.length > 1) {
      // Keep the largest group in the current product, move the rest
      const sortedGroups = stoneNames.sort((a, b) => stoneGroups[b].length - stoneGroups[a].length);
      const keepStone = sortedGroups[0]; // Largest group stays

      // Rename current product to match the kept stone
      const keepClean = keepStone.replace(/^AZUL/i, '');
      const keepPretty = keepClean.charAt(0).toUpperCase() + keepClean.slice(1).toLowerCase();
      const keepDisplayName = 'Azul ' + keepPretty;
      console.log(`\n  Keeping "${keepDisplayName}" in current product (${stoneGroups[keepStone].length} SKUs)`);

      if (!DRY_RUN) {
        // Rename existing product
        const cleanName = keepDisplayName;
        await client.query(`
          UPDATE products SET name = $1, display_name = $2, collection = 'Azul'
          WHERE id = $3
        `, [cleanName, cleanName, azulProductId]);
        console.log(`  → Renamed current product to "${cleanName}"`);
      }

      for (let i = 1; i < sortedGroups.length; i++) {
        const stone = sortedGroups[i];
        const skus = stoneGroups[stone];
        // Convert AZULIMPERIALE → Imperiale, AZULTREASURE → Treasure
        const stoneClean = stone.replace(/^AZUL/i, '');
        const stonePretty = stoneClean.charAt(0).toUpperCase() + stoneClean.slice(1).toLowerCase();
        const displayName = 'Azul ' + stonePretty;
        const cleanName = displayName.replace(/\s+/g, ' ').trim();
        const slug = cleanName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

        console.log(`\n  Creating product "${cleanName}" for ${skus.length} RSL SKUs:`);
        skus.forEach(s => console.log(`    ${s.vendor_sku}`));

        if (!DRY_RUN) {
          await client.query('BEGIN');
          try {
            const newProductId = uuidv4();
            // Get vendor_id from original product
            const { rows: [origProd] } = await client.query(
              'SELECT vendor_id, category_id FROM products WHERE id = $1', [azulProductId]
            );

            await client.query(`
              INSERT INTO products (id, vendor_id, name, collection, category_id, status, display_name, slug, is_active)
              VALUES ($1, $2, $3, 'Azul', $4, 'active', $5, $6, true)
            `, [newProductId, origProd.vendor_id, cleanName, origProd.category_id, cleanName, slug]);

            const skuIds = skus.map(s => s.sku_id);
            await client.query(`
              UPDATE skus SET product_id = $1 WHERE id = ANY($2::uuid[])
            `, [newProductId, skuIds]);

            await client.query('COMMIT');
            console.log(`  ✓ Created product ${newProductId}`);
          } catch (err) {
            await client.query('ROLLBACK');
            console.error(`  ✗ Error: ${err.message}`);
          }
        }
      }
    }

    // Step 3: Check for other products with similar RSL stone mismatches
    console.log(`\n\n=== Step 3: Check broader RSL grouping issues ===`);
    const { rows: rslMixedProducts } = await client.query(`
      WITH rsl_stones AS (
        SELECT s.product_id,
          regexp_replace(s.vendor_sku, '^RSL-([A-Z]+)(-.*)?$', '\\1') as stone_name,
          count(*) as cnt
        FROM skus s
        JOIN products p ON s.product_id = p.id
        WHERE p.vendor_id = (SELECT id FROM vendors WHERE code = 'MSI')
          AND s.vendor_sku LIKE 'RSL-%'
        GROUP BY s.product_id, regexp_replace(s.vendor_sku, '^RSL-([A-Z]+)(-.*)?$', '\\1')
      )
      SELECT rs.product_id, p.name,
        array_agg(DISTINCT rs.stone_name) as stones,
        count(DISTINCT rs.stone_name) as stone_count,
        sum(rs.cnt) as total_skus
      FROM rsl_stones rs
      JOIN products p ON rs.product_id = p.id
      GROUP BY rs.product_id, p.name
      HAVING count(DISTINCT rs.stone_name) > 1
      ORDER BY stone_count DESC, total_skus DESC;
    `);

    if (rslMixedProducts.length > 0) {
      console.log(`Found ${rslMixedProducts.length} products with mixed RSL stone names:`);
      for (const p of rslMixedProducts) {
        console.log(`  ${p.name}: ${p.stones.join(', ')} (${p.total_skus} SKUs)`);
      }
    } else {
      console.log('No other products with mixed RSL stone names found.');
    }

  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
