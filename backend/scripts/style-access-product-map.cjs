/**
 * Style Access Product Map — Diagnostic Audit Tool
 *
 * Outputs a tree view of the Style Access product structure showing
 * collections, products (colors), and SKUs with their attribute values.
 *
 * Highlights:
 *   - Products where color still contains finish modifiers (pre-migration)
 *   - Products missing finish attribute
 *   - Single-SKU products
 *
 * Usage: docker compose exec api node scripts/style-access-product-map.cjs
 */
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: 5432, database: 'flooring_pim', user: 'postgres', password: 'postgres',
});

// Tokens that should NOT appear in a corrected color value
const FINISH_TOKENS = /\b(Flat|Dixie|Charleston|Swing|Gloss|Satin|Matte|Deco|Flower Deco|Brick Joint|Cross Hatch)\b/i;

async function run() {
  const { rows } = await pool.query(`
    SELECT p.collection, p.name AS product_name,
           s.id AS sku_id, s.variant_name, s.variant_type,
           sa_color.value AS color,
           sa_finish.value AS finish,
           sa_size.value AS size,
           sa_width.value AS width,
           sa_material.value AS material
    FROM skus s
    JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id
    LEFT JOIN sku_attributes sa_color ON sa_color.sku_id = s.id
      AND sa_color.attribute_id = (SELECT id FROM attributes WHERE slug = 'color')
    LEFT JOIN sku_attributes sa_finish ON sa_finish.sku_id = s.id
      AND sa_finish.attribute_id = (SELECT id FROM attributes WHERE slug = 'finish')
    LEFT JOIN sku_attributes sa_size ON sa_size.sku_id = s.id
      AND sa_size.attribute_id = (SELECT id FROM attributes WHERE slug = 'size')
    LEFT JOIN sku_attributes sa_width ON sa_width.sku_id = s.id
      AND sa_width.attribute_id = (SELECT id FROM attributes WHERE slug = 'width')
    LEFT JOIN sku_attributes sa_material ON sa_material.sku_id = s.id
      AND sa_material.attribute_id = (SELECT id FROM attributes WHERE slug = 'material')
    WHERE v.code = 'STYLEACCESS'
    ORDER BY p.collection, p.name, s.variant_name
  `);

  // Group: collection → product → SKUs
  const collections = new Map();
  for (const row of rows) {
    if (!collections.has(row.collection)) collections.set(row.collection, new Map());
    const products = collections.get(row.collection);
    if (!products.has(row.product_name)) products.set(row.product_name, []);
    products.get(row.product_name).push(row);
  }

  let totalCollections = 0, totalProducts = 0, totalSkus = 0;
  let issueColorHasFinish = 0, issueMissingFinish = 0, singleSkuProducts = 0;
  const issues = [];

  console.log('=== Style Access Product Map ===\n');

  for (const [collection, products] of collections) {
    totalCollections++;
    const collectionSkuCount = [...products.values()].reduce((sum, skus) => sum + skus.length, 0);
    console.log(`${collection} (${products.size} products, ${collectionSkuCount} SKUs)`);

    const productEntries = [...products.entries()];
    for (let pi = 0; pi < productEntries.length; pi++) {
      const [productName, skus] = productEntries[pi];
      totalProducts++;
      totalSkus += skus.length;

      const isLast = pi === productEntries.length - 1;
      const branch = isLast ? '\u2514\u2500' : '\u251c\u2500';
      const prefix = isLast ? '   ' : '\u2502  ';

      const flags = [];
      if (skus.length === 1) { flags.push('SINGLE-SKU'); singleSkuProducts++; }

      // Check for issues
      const hasFinishInColor = skus.some(s => s.color && FINISH_TOKENS.test(s.color));
      const missingFinish = skus.some(s => !s.finish && !s.variant_type);

      if (hasFinishInColor) { flags.push('COLOR-HAS-FINISH'); issueColorHasFinish++; }
      if (missingFinish) { flags.push('MISSING-FINISH'); issueMissingFinish++; }

      const flagStr = flags.length ? `  *** ${flags.join(', ')} ***` : '';
      console.log(`  ${branch} ${productName} (${skus.length} SKUs)${flagStr}`);

      for (let si = 0; si < skus.length; si++) {
        const sku = skus[si];
        const skuIsLast = si === skus.length - 1;
        const skuBranch = skuIsLast ? '\u2514\u2500' : '\u251c\u2500';

        const attrs = [];
        if (sku.color) attrs.push(`color: ${sku.color}`);
        if (sku.finish) attrs.push(`finish: ${sku.finish}`);
        if (sku.size) attrs.push(`size: ${sku.size}`);
        if (sku.variant_type) attrs.push(`type: ${sku.variant_type}`);

        const attrStr = attrs.length ? ` \u2014 ${attrs.join(', ')}` : '';
        console.log(`  ${prefix}${skuBranch} ${sku.variant_name}${attrStr}`);

        if (sku.color && FINISH_TOKENS.test(sku.color)) {
          issues.push(`${collection} / ${productName} / ${sku.variant_name}: color="${sku.color}"`);
        }
      }
    }
    console.log('');
  }

  // Summary
  console.log('=== Summary ===');
  console.log(`Collections: ${totalCollections}`);
  console.log(`Products: ${totalProducts}`);
  console.log(`SKUs: ${totalSkus}`);
  console.log(`Single-SKU products: ${singleSkuProducts}`);
  console.log('');

  if (issueColorHasFinish > 0) {
    console.log(`WARNING: ${issueColorHasFinish} products have finish tokens in color attribute`);
    console.log('  Run fix-style-access-attrs.cjs to correct these.');
    console.log('  Affected:');
    for (const issue of issues) {
      console.log(`    - ${issue}`);
    }
    console.log('');
  }

  if (issueMissingFinish > 0) {
    console.log(`NOTE: ${issueMissingFinish} products have SKUs missing finish attribute`);
    console.log('  (This is normal for plain/unfished tiles with no surface pattern or finish qualifier)');
    console.log('');
  }

  if (issueColorHasFinish === 0) {
    console.log('All color attributes are clean (no finish tokens detected).');
  }

  await pool.end();
}

run().catch(err => { console.error(err); process.exit(1); });
