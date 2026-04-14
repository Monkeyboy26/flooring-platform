#!/usr/bin/env node
/**
 * shaw-fix-images.cjs
 *
 * Shaw image data is massively cross-contaminated at the product level:
 *   - 0 of 56,801 product-level images match their own product's SKU style code
 *   - Product primaries often show unrelated product (e.g. "Tranquil Waters"
 *     had a "NaturesMark-5E576" primary)
 *   - Product alternates are full of room scenes from unrelated styles
 *
 * SKU-level images (5957 primary + 4839 alternate) are correct — they match
 * vendor SKU style codes cleanly.
 *
 * Shaw Widen URLs follow a style-code pattern:
 *   https://shawfloors.widen.net/content/<hash>/<format>/<STYLE>_<COLOR>_<variant>
 *   e.g. MC673_00101.jpg, sw707_05091_room, MC718_00531.jpg
 *
 * Strategy:
 *   1. For each Shaw product, determine its dominant SKU style code from
 *      SKU-level primary image URLs.
 *   2. Delete all product-level images (primary + alternate + lifestyle)
 *      whose URL style code doesn't match the product's SKU style code.
 *   3. For products with no remaining product-level primary but with
 *      SKU-level primaries, copy the first SKU-level primary image to
 *      create a product-level primary.
 *
 * Spec PDFs are left alone.
 *
 * Usage:
 *   node backend/scripts/shaw-fix-images.cjs --dry-run
 *   node backend/scripts/shaw-fix-images.cjs
 */

const { Pool } = require('pg');
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

const DRY_RUN = process.argv.includes('--dry-run');

// Extract the style code from a Shaw Widen URL. The style code is the first
// alphanumeric token after the last "/jpeg/|/webp/|/jpg/|/png/" path segment.
// Returns lowercased code or null.
function extractStyleCode(url) {
  if (!url) return null;
  const m = url.match(/\/(?:jpeg|webp|jpg|png)\/([A-Za-z0-9]+)[_.-]/i);
  return m ? m[1].toLowerCase() : null;
}

async function main() {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  SHAW IMAGE FIX ${DRY_RUN ? '(DRY RUN)' : '(LIVE)'}`);
  console.log(`${'='.repeat(60)}\n`);

  const vendorRes = await pool.query("SELECT id FROM vendors WHERE code='SHAW'");
  const vendorId = vendorRes.rows[0].id;

  // Phase 1: Determine each product's dominant SKU style code
  console.log('Phase 1: Determining dominant SKU style codes...');
  const { rows: skuStyleRows } = await pool.query(`
    SELECT s.product_id, ma.url
    FROM skus s
    JOIN products p ON p.id = s.product_id
    JOIN media_assets ma ON ma.sku_id = s.id AND ma.asset_type = 'primary'
    WHERE p.vendor_id = $1 AND s.status = 'active'
  `, [vendorId]);

  const styleCountsByProduct = new Map();
  for (const r of skuStyleRows) {
    const code = extractStyleCode(r.url);
    if (!code) continue;
    if (!styleCountsByProduct.has(r.product_id)) styleCountsByProduct.set(r.product_id, new Map());
    const counts = styleCountsByProduct.get(r.product_id);
    counts.set(code, (counts.get(code) || 0) + 1);
  }

  const productStyle = new Map();
  for (const [pid, counts] of styleCountsByProduct) {
    let best = null, bestCount = 0;
    for (const [code, c] of counts) {
      if (c > bestCount) { best = code; bestCount = c; }
    }
    if (best) productStyle.set(pid, best);
  }
  console.log(`  ${productStyle.size} products have a dominant SKU style code\n`);

  // Phase 2: Identify mismatched product-level images (excluding spec_pdf)
  console.log('Phase 2: Identifying mismatched product-level images...');
  const { rows: productImages } = await pool.query(`
    SELECT ma.id, ma.product_id, ma.asset_type, ma.url
    FROM media_assets ma
    JOIN products p ON p.id = ma.product_id
    WHERE p.vendor_id = $1
      AND ma.sku_id IS NULL
      AND ma.asset_type != 'spec_pdf'
  `, [vendorId]);

  const toDelete = [];
  let stats = { matches: 0, mismatches: 0, unknownProduct: 0 };
  for (const img of productImages) {
    const productCode = productStyle.get(img.product_id);
    if (!productCode) { stats.unknownProduct++; toDelete.push(img); continue; }
    const urlCode = extractStyleCode(img.url);
    if (urlCode && urlCode === productCode) { stats.matches++; continue; }
    stats.mismatches++;
    toDelete.push(img);
  }

  console.log(`  Product-level images reviewed: ${productImages.length}`);
  console.log(`    Match product's SKU style: ${stats.matches}`);
  console.log(`    Mismatch (will delete): ${stats.mismatches}`);
  console.log(`    Product has no SKU style (will delete): ${stats.unknownProduct}`);
  console.log(`  Total to delete: ${toDelete.length}\n`);

  // Phase 3: Identify products needing a promoted primary
  console.log('Phase 3: Identifying products needing a promoted primary...');
  const { rows: skuPrimaries } = await pool.query(`
    SELECT DISTINCT ON (s.product_id)
      s.product_id, ma.url, ma.original_url
    FROM skus s
    JOIN products p ON p.id = s.product_id
    JOIN media_assets ma ON ma.sku_id = s.id AND ma.asset_type = 'primary'
    WHERE p.vendor_id = $1 AND s.status = 'active'
    ORDER BY s.product_id, ma.sort_order, s.created_at
  `, [vendorId]);
  const skuPrimaryByProduct = new Map(skuPrimaries.map(r => [r.product_id, { url: r.url, original_url: r.original_url }]));

  // After Phase 2 deletes mismatched primaries, which products need a new primary?
  // Every product whose primary is being deleted or who has none.
  const productsWithSurvivingPrimary = new Set();
  for (const img of productImages) {
    if (img.asset_type !== 'primary') continue;
    if (toDelete.find(d => d.id === img.id)) continue;
    productsWithSurvivingPrimary.add(img.product_id);
  }

  const toPromote = [];
  for (const [pid, imgData] of skuPrimaryByProduct) {
    if (!productsWithSurvivingPrimary.has(pid)) {
      toPromote.push({ product_id: pid, ...imgData });
    }
  }
  console.log(`  Products needing promoted primary: ${toPromote.length}\n`);

  // Final summary
  console.log('='.repeat(60));
  console.log('Summary:');
  console.log(`  Deletions: ${toDelete.length}`);
  console.log(`  Promotions (SKU primary -> product primary): ${toPromote.length}`);
  console.log('='.repeat(60));
  console.log();

  if (DRY_RUN) {
    console.log('Sample deletions (first 5):');
    for (const d of toDelete.slice(0, 5)) {
      console.log(`  [${d.asset_type}] ${d.url.substring(0, 100)}`);
    }
    console.log('\nSample promotions (first 5):');
    for (const p of toPromote.slice(0, 5)) {
      console.log(`  product=${p.product_id.substring(0,8)} url=${p.url.substring(0, 90)}`);
    }
    console.log('\nDry run — no changes applied.');
    await pool.end();
    return;
  }

  console.log('Applying changes...');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Delete mismatched images in batches
    const DELETE_BATCH = 1000;
    for (let i = 0; i < toDelete.length; i += DELETE_BATCH) {
      const ids = toDelete.slice(i, i + DELETE_BATCH).map(d => d.id);
      await client.query('DELETE FROM media_assets WHERE id = ANY($1::uuid[])', [ids]);
    }
    console.log(`  Deleted ${toDelete.length} mismatched product-level images`);

    // Promote SKU primaries to product primaries
    for (const p of toPromote) {
      await client.query(`
        INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
        VALUES ($1, NULL, 'primary', $2, $3, 0)
      `, [p.product_id, p.url, p.original_url]);
    }
    console.log(`  Promoted ${toPromote.length} SKU primary images to product-level primaries`);

    await client.query('COMMIT');
    console.log('Done.');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  await pool.end();
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
