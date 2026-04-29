/**
 * MSI Merge Size Variants
 *
 * Consolidates products that differ only by size (e.g., "Adella Calacatta 12x24"
 * and "Adella Calacatta 18x18") into a single product with size as variant_name.
 */

const { Pool } = require('pg');
const VENDOR_ID = '550e8400-e29b-41d4-a716-446655440001';

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

const DRY_RUN = process.argv.includes('--dry-run');

// Strip size suffix from product name to get the base name
function getBaseName(name) {
  return name
    // Strip "12x24", "18x18", "3x18", etc. at end
    .replace(/\s+\d+\.?\d*\s*[xX×]\s*\d+\.?\d*\s*$/g, '')
    // Strip size with extra context like "12x24 Classic" or "12x24 Matte"
    .replace(/\s+\d+\.?\d*\s*[xX×]\s*\d+\.?\d*\s+(Classic|Gauged|Premium|Select|Matte|Polished|Honed)\s*$/gi, '')
    .trim();
}

// Extract size from product name
function extractSize(name) {
  const m = name.match(/(\d+\.?\d*\s*[xX×]\s*\d+\.?\d*)/);
  return m ? m[1].replace(/\s+/g, '').replace(/[×X]/gi, 'x') : null;
}

// Extract suffix after size (e.g., "Bullnose", "Classic")
function extractSuffix(name) {
  const m = name.match(/\d+\.?\d*\s*[xX×]\s*\d+\.?\d*\s+(.+)$/);
  return m ? m[1].trim() : null;
}

async function main() {
  const log = (msg) => console.log(msg);
  log(`MSI Merge Size Variants${DRY_RUN ? ' (DRY RUN)' : ''}`);
  log('═'.repeat(60));

  // Load all MSI products
  const { rows: products } = await pool.query(`
    SELECT p.id, p.name, p.collection, p.category_id, p.description_short, p.description_long,
           COUNT(s.id) AS sku_count
    FROM products p
    LEFT JOIN skus s ON s.product_id = p.id
    WHERE p.vendor_id = $1
    GROUP BY p.id
    ORDER BY p.collection, p.name
  `, [VENDOR_ID]);

  log(`  Loaded ${products.length} MSI products`);

  // Group by base name + collection
  const groups = new Map();
  for (const p of products) {
    const baseName = getBaseName(p.name);
    const key = `${p.collection || ''}\0${baseName}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }

  // Find groups with >1 product (these need merging)
  const mergeGroups = [...groups.entries()].filter(([, prods]) => prods.length > 1);
  log(`  Found ${mergeGroups.length} groups to merge (${mergeGroups.reduce((s, [, p]) => s + p.length, 0)} products → ${mergeGroups.length} products)`);

  let totalMerged = 0, totalSkusMoved = 0;

  for (const [key, prods] of mergeGroups) {
    const [collection, baseName] = key.split('\0');

    // Pick the "primary" product: prefer the one with images, then most SKUs, then shortest name
    prods.sort((a, b) => {
      // Prefer base name (no size) products
      const aHasSize = extractSize(a.name) !== null;
      const bHasSize = extractSize(b.name) !== null;
      if (!aHasSize && bHasSize) return -1;
      if (aHasSize && !bHasSize) return 1;
      // Then by SKU count desc
      if (b.sku_count !== a.sku_count) return b.sku_count - a.sku_count;
      // Then by name length (shorter = more general)
      return a.name.length - b.name.length;
    });

    const primary = prods[0];
    const secondaries = prods.slice(1);

    // Rename primary to base name if it has a size suffix
    if (primary.name !== baseName && !DRY_RUN) {
      await pool.query(`UPDATE products SET name = $1, updated_at = NOW() WHERE id = $2`, [baseName, primary.id]);
      // Also keep best description
      const bestDesc = prods.find(p => p.description_long && p.description_long.length > 50);
      if (bestDesc && bestDesc.id !== primary.id) {
        await pool.query(`
          UPDATE products SET
            description_short = COALESCE(NULLIF(description_short, ''), $2),
            description_long = COALESCE(NULLIF(description_long, ''), $3)
          WHERE id = $1
        `, [primary.id, bestDesc.description_short, bestDesc.description_long]);
      }
    }

    for (const sec of secondaries) {
      // Move all SKUs from secondary → primary, update variant_name with size
      const { rows: skus } = await pool.query(
        `SELECT id, vendor_sku, variant_name FROM skus WHERE product_id = $1`,
        [sec.id]
      );

      for (const sku of skus) {
        const size = extractSize(sec.name);
        const suffix = extractSuffix(sec.name);
        let newVariantName = sku.variant_name;
        if (!newVariantName && size) {
          newVariantName = suffix ? `${size} ${suffix}` : size;
        }

        if (!DRY_RUN) {
          await pool.query(`
            UPDATE skus SET product_id = $1, variant_name = COALESCE($3, variant_name), updated_at = NOW()
            WHERE id = $2
          `, [primary.id, sku.id, newVariantName]);
        }
        totalSkusMoved++;
      }

      // Move media_assets from secondary → primary
      if (!DRY_RUN) {
        await pool.query(`
          UPDATE media_assets SET product_id = $1 WHERE product_id = $2
        `, [primary.id, sec.id]);
      }

      // Delete the now-empty secondary product
      if (!DRY_RUN) {
        await pool.query(`DELETE FROM products WHERE id = $1`, [sec.id]);
      }

      totalMerged++;
    }
  }

  // Also ensure variant_name is set on SKUs that had size in their original product name
  if (!DRY_RUN) {
    // For SKUs where variant_name is still null but the product had size variants,
    // set variant_name from the size attribute
    const { rowCount } = await pool.query(`
      UPDATE skus s SET variant_name = sa.value
      FROM sku_attributes sa
      JOIN attributes a ON a.id = sa.attribute_id
      WHERE sa.sku_id = s.id AND a.slug = 'size'
        AND s.variant_name IS NULL
        AND s.product_id IN (
          SELECT product_id FROM skus
          WHERE product_id IN (SELECT id FROM products WHERE vendor_id = $1)
          GROUP BY product_id HAVING COUNT(*) > 1
        )
    `, [VENDOR_ID]);
    log(`  Set variant_name from size attribute for ${rowCount} SKUs`);
  }

  // Final stats
  const { rows: [stats] } = await pool.query(`
    SELECT COUNT(DISTINCT p.id) AS products, COUNT(s.id) AS skus
    FROM products p
    LEFT JOIN skus s ON s.product_id = p.id
    WHERE p.vendor_id = $1
  `, [VENDOR_ID]);

  log('');
  log('═'.repeat(60));
  log(`  Products merged:   ${totalMerged}`);
  log(`  SKUs moved:        ${totalSkusMoved}`);
  log(`  Final products:    ${stats.products}`);
  log(`  Final SKUs:        ${stats.skus}`);
  log('═'.repeat(60));

  await pool.end();
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
