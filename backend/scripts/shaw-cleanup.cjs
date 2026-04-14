#!/usr/bin/env node
/**
 * Shaw data cleanup script.
 *
 * Phases:
 *   1. Dedup 195 duplicate SKUs (caused by re-scrape with different vendor_sku formatting:
 *      "VV48802093" vs "VV488 02093"). Keep the older no-space version (more complete data).
 *   2. Deactivate products that end up with 0 active SKUs after dedup.
 *   3. Normalize product naming (double spaces, trailing chars, etc.)
 *   4. Fix accessory product display_names (remove hardcoded per-SKU color).
 *   5. Rebuild display_names for carpet/LVT/hardwood products.
 *
 * Usage:
 *   node backend/scripts/shaw-cleanup.cjs --dry-run      # preview changes
 *   node backend/scripts/shaw-cleanup.cjs                # execute
 */

const { Pool } = require('pg');

const DRY_RUN = process.argv.includes('--dry-run');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

async function log(label, result) {
  console.log(`  ${label.padEnd(40)} ${result}`);
}

async function phase1_dedupSkus(client) {
  console.log('\n=== Phase 1: Deduplicate 195 duplicate SKUs ===');

  // Identify SKUs to delete: the "newer" (March 5) set with spaces in vendor_sku,
  // that have a no-space twin in the "older" set.
  const { rows: dupGroups } = await client.query(`
    WITH normalized AS (
      SELECT s.id, s.vendor_sku, REPLACE(s.vendor_sku, ' ', '') AS nsku, s.created_at
      FROM skus s
      JOIN products p ON p.id = s.product_id
      JOIN vendors v ON v.id = p.vendor_id
      WHERE v.code = 'SHAW' AND s.status = 'active'
    ),
    dups AS (
      SELECT nsku FROM normalized GROUP BY nsku HAVING COUNT(*) > 1
    )
    SELECT n.id AS delete_sku_id, n.vendor_sku AS delete_vsku,
      (SELECT id FROM normalized n2 WHERE n2.nsku = n.nsku AND n2.vendor_sku NOT LIKE '% %' LIMIT 1) AS keep_sku_id
    FROM normalized n
    WHERE n.nsku IN (SELECT nsku FROM dups) AND n.vendor_sku LIKE '% %'
  `);

  // Filter out any where keep_sku_id is null (shouldn't happen but safety check)
  const pairs = dupGroups.filter(r => r.keep_sku_id);
  const deleteIds = pairs.map(p => p.delete_sku_id);
  log('Duplicate pairs identified:', pairs.length);

  if (deleteIds.length === 0) {
    log('Nothing to delete.', '');
    return 0;
  }

  // Count dependent records that will be deleted
  const deps = await client.query(`
    SELECT
      (SELECT COUNT(*) FROM media_assets WHERE sku_id = ANY($1::uuid[])) AS media,
      (SELECT COUNT(*) FROM sku_attributes WHERE sku_id = ANY($1::uuid[])) AS attrs,
      (SELECT COUNT(*) FROM packaging WHERE sku_id = ANY($1::uuid[])) AS pkg,
      (SELECT COUNT(*) FROM pricing WHERE sku_id = ANY($1::uuid[])) AS pricing,
      (SELECT COUNT(*) FROM inventory_snapshots WHERE sku_id = ANY($1::uuid[])) AS inventory,
      (SELECT COUNT(*) FROM cart_items WHERE sku_id = ANY($1::uuid[])) AS cart,
      (SELECT COUNT(*) FROM order_items WHERE sku_id = ANY($1::uuid[])) AS orders,
      (SELECT COUNT(*) FROM trade_favorite_items WHERE sku_id = ANY($1::uuid[])) AS favorites
  `, [deleteIds]);
  const d = deps.rows[0];
  log('  → media_assets to delete:', d.media);
  log('  → sku_attributes to delete:', d.attrs);
  log('  → packaging to delete:', d.pkg);
  log('  → pricing to delete:', d.pricing);
  log('  → inventory to delete:', d.inventory);
  log('  → cart_items (MUST be 0):', d.cart);
  log('  → order_items (MUST be 0):', d.orders);
  log('  → favorites (MUST be 0):', d.favorites);

  if (d.cart > 0 || d.orders > 0 || d.favorites > 0) {
    throw new Error('Cannot delete SKUs with cart/order/favorite references!');
  }

  // Apply deletes in both modes; transaction will rollback in dry-run.
  await client.query('DELETE FROM sku_attributes WHERE sku_id = ANY($1::uuid[])', [deleteIds]);
  await client.query('DELETE FROM media_assets WHERE sku_id = ANY($1::uuid[])', [deleteIds]);
  await client.query('DELETE FROM packaging WHERE sku_id = ANY($1::uuid[])', [deleteIds]);
  await client.query('DELETE FROM pricing WHERE sku_id = ANY($1::uuid[])', [deleteIds]);
  await client.query('DELETE FROM inventory_snapshots WHERE sku_id = ANY($1::uuid[])', [deleteIds]);
  const delRes = await client.query('DELETE FROM skus WHERE id = ANY($1::uuid[])', [deleteIds]);
  log('Deleted SKUs:', delRes.rowCount);
  return delRes.rowCount;
}

async function phase1b_normalizeOrphanVendorSkus(client) {
  console.log('\n=== Phase 1b: Normalize orphan space-containing vendor_skus ===');

  // After dedup, a few space-containing SKUs may remain with no no-space twin.
  // Strip spaces to match Shaw's canonical format and prevent future re-scrape dupes.
  const { rows: preview } = await client.query(`
    SELECT s.id, s.vendor_sku AS old_vsku, REPLACE(s.vendor_sku, ' ', '') AS new_vsku
    FROM skus s
    JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id
    WHERE v.code = 'SHAW' AND s.status = 'active' AND s.vendor_sku LIKE '% %'
  `);
  log('Orphan space-containing SKUs:', preview.length);
  preview.forEach(r => log('  →', `"${r.old_vsku}" → "${r.new_vsku}"`));

  if (preview.length === 0) return 0;

  const res = await client.query(`
    UPDATE skus
    SET vendor_sku = REPLACE(vendor_sku, ' ', '')
    WHERE id IN (
      SELECT s.id FROM skus s
      JOIN products p ON p.id = s.product_id
      JOIN vendors v ON v.id = p.vendor_id
      WHERE v.code = 'SHAW' AND s.status = 'active' AND s.vendor_sku LIKE '% %'
    )
  `);
  log('Normalized vendor_skus:', res.rowCount);
  return res.rowCount;
}

async function phase2_deactivateEmptyProducts(client) {
  console.log('\n=== Phase 2: Deactivate empty Shaw products ===');

  const { rows } = await client.query(`
    SELECT p.id, p.name
    FROM products p
    JOIN vendors v ON v.id = p.vendor_id
    WHERE v.code = 'SHAW' AND p.status = 'active'
      AND NOT EXISTS (SELECT 1 FROM skus s WHERE s.product_id = p.id AND s.status = 'active')
  `);
  log('Empty products found:', rows.length);
  if (rows.length === 0) return 0;

  rows.slice(0, 10).forEach(r => log('  →', r.name));
  if (rows.length > 10) log('  →', `...and ${rows.length - 10} more`);

  const ids = rows.map(r => r.id);
  const res = await client.query(
    `UPDATE products SET status = 'inactive' WHERE id = ANY($1::uuid[])`, [ids]
  );
  log('Deactivated:', res.rowCount);
  return res.rowCount;
}

async function phase3_normalizeProductNames(client) {
  console.log('\n=== Phase 3: Normalize Shaw product names ===');

  // Collapse double-spaces, trim whitespace
  const { rows: preview } = await client.query(`
    SELECT p.id, p.name AS old_name, regexp_replace(TRIM(p.name), '\\s+', ' ', 'g') AS new_name
    FROM products p
    JOIN vendors v ON v.id = p.vendor_id
    WHERE v.code = 'SHAW' AND p.status = 'active'
      AND p.name <> regexp_replace(TRIM(p.name), '\\s+', ' ', 'g')
  `);
  log('Products with extra whitespace:', preview.length);
  preview.slice(0, 5).forEach(r => log('  →', `"${r.old_name}" → "${r.new_name}"`));

  // Normalize name+collection together to avoid (vendor_id, collection, name) unique conflicts.
  // Skip rows that would collide with an existing active product.
  const res = await client.query(`
    UPDATE products p
    SET
      name = regexp_replace(TRIM(p.name), '\\s+', ' ', 'g'),
      collection = CASE WHEN p.collection IS NULL THEN NULL
                        ELSE regexp_replace(TRIM(p.collection), '\\s+', ' ', 'g') END,
      display_name = CASE WHEN p.display_name IS NULL THEN NULL
                          ELSE regexp_replace(TRIM(p.display_name), '\\s+', ' ', 'g') END
    FROM vendors v
    WHERE v.id = p.vendor_id AND v.code = 'SHAW'
      AND (
        p.name <> regexp_replace(TRIM(p.name), '\\s+', ' ', 'g')
        OR (p.collection IS NOT NULL AND p.collection <> regexp_replace(TRIM(p.collection), '\\s+', ' ', 'g'))
        OR (p.display_name IS NOT NULL AND p.display_name <> regexp_replace(TRIM(p.display_name), '\\s+', ' ', 'g'))
      )
      -- Avoid collisions with other active products
      AND NOT EXISTS (
        SELECT 1 FROM products p2
        WHERE p2.id <> p.id AND p2.vendor_id = p.vendor_id
          AND p2.collection IS NOT DISTINCT FROM regexp_replace(TRIM(p.collection), '\\s+', ' ', 'g')
          AND p2.name = regexp_replace(TRIM(p.name), '\\s+', ' ', 'g')
      )
  `);
  log('Updated (name/collection/display_name):', res.rowCount);
  return res.rowCount;
}

async function phase4_fixAccessoryDisplayNames(client) {
  console.log('\n=== Phase 4: Fix accessory product display_names ===');

  // Accessory products have display_names like "T Molding Gunstock" that hardcode
  // one random color even though the product contains 435 SKUs of different colors.
  // Set display_name = product name for these.
  const { rows: preview } = await client.query(`
    SELECT p.id, p.name, p.display_name,
      (SELECT COUNT(*) FROM skus s WHERE s.product_id = p.id AND s.status = 'active') AS sku_count
    FROM products p
    JOIN vendors v ON v.id = p.vendor_id
    LEFT JOIN categories c ON c.id = p.category_id
    WHERE v.code = 'SHAW' AND p.status = 'active'
      AND c.name IN ('Transitions & Moldings', 'Wall Base', 'Installation & Sundries', 'Adhesives & Sealants', 'Underlayment')
      AND (SELECT COUNT(DISTINCT sa.value) FROM skus s2
           JOIN sku_attributes sa ON sa.sku_id = s2.id
           JOIN attributes a ON a.id = sa.attribute_id
           WHERE s2.product_id = p.id AND s2.status='active' AND a.slug='color') > 1
      AND p.display_name <> p.name
  `);
  log('Accessory products with hardcoded color in display_name:', preview.length);
  preview.slice(0, 8).forEach(r => log('  →', `${r.sku_count} SKUs | "${r.display_name}" → "${r.name}"`));
  if (preview.length > 8) log('  →', `...and ${preview.length - 8} more`);

  const ids = preview.map(r => r.id);
  if (ids.length === 0) return 0;
  const res = await client.query(
    `UPDATE products SET display_name = name WHERE id = ANY($1::uuid[])`, [ids]
  );
  log('Updated display_names:', res.rowCount);
  return res.rowCount;
}

async function phase5_rebuildDisplayNames(client) {
  console.log('\n=== Phase 5: Rebuild display_names for main Shaw products ===');

  // For multi-color carpet/LVT/hardwood products, the display_name should be just
  // the product name (the storefront fullProductName() appends color at render time).
  // Products with a hardcoded color in display_name like "Finery Alabaster" should
  // become just "Finery".
  const { rows: preview } = await client.query(`
    SELECT p.id, p.name, p.display_name,
      (SELECT COUNT(*) FROM skus s WHERE s.product_id = p.id AND s.status = 'active') AS sku_count
    FROM products p
    JOIN vendors v ON v.id = p.vendor_id
    LEFT JOIN categories c ON c.id = p.category_id
    WHERE v.code = 'SHAW' AND p.status = 'active'
      AND c.name IN ('Carpet', 'Carpet Tile', 'Luxury Vinyl', 'Engineered Hardwood', 'Tile')
      AND (SELECT COUNT(*) FROM skus s WHERE s.product_id=p.id AND s.status='active') > 1
      AND p.display_name <> p.name
      AND p.display_name LIKE p.name || ' %'
  `);
  log('Multi-SKU main products with hardcoded color:', preview.length);
  preview.slice(0, 8).forEach(r => log('  →', `${r.sku_count} SKUs | "${r.display_name}" → "${r.name}"`));
  if (preview.length > 8) log('  →', `...and ${preview.length - 8} more`);

  const ids = preview.map(r => r.id);
  if (ids.length === 0) return 0;
  const res = await client.query(
    `UPDATE products SET display_name = name WHERE id = ANY($1::uuid[])`, [ids]
  );
  log('Updated display_names:', res.rowCount);
  return res.rowCount;
}

async function phase6_rebuildSearchVectors(client) {
  console.log('\n=== Phase 6: Rebuild search vectors for affected Shaw products ===');
  // Only do this if the products table has a search_vector column
  const { rows: colCheck } = await client.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name='products' AND column_name='search_vector'
  `);
  if (colCheck.length === 0) {
    log('No search_vector column.', 'skipping');
    return 0;
  }

  const res = await client.query(`
    UPDATE products p
    SET search_vector = to_tsvector('english',
      COALESCE(p.name, '') || ' ' || COALESCE(p.display_name, '') || ' ' || COALESCE(p.collection, '')
    )
    FROM vendors v
    WHERE v.id = p.vendor_id AND v.code = 'SHAW'
  `);
  log('Rebuilt search vectors:', res.rowCount);
  return res.rowCount;
}

async function main() {
  console.log(`Shaw Data Cleanup ${DRY_RUN ? '[DRY RUN]' : '[EXECUTING]'}`);
  console.log('='.repeat(60));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const r1 = await phase1_dedupSkus(client);
    const r1b = await phase1b_normalizeOrphanVendorSkus(client);
    const r2 = await phase2_deactivateEmptyProducts(client);
    const r3 = await phase3_normalizeProductNames(client);
    const r4 = await phase4_fixAccessoryDisplayNames(client);
    const r5 = await phase5_rebuildDisplayNames(client);
    const r6 = await phase6_rebuildSearchVectors(client);

    if (DRY_RUN) {
      await client.query('ROLLBACK');
      console.log('\n[DRY RUN] Rolled back. Run without --dry-run to execute.');
    } else {
      await client.query('COMMIT');
      console.log('\n✓ Cleanup committed.');
    }

    console.log('\n=== Summary ===');
    log('SKUs removed:', r1);
    log('Products deactivated:', r2);
    log('Names normalized:', r3);
    log('Accessory display_names fixed:', r4);
    log('Main display_names fixed:', r5);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('\n✗ Error:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
