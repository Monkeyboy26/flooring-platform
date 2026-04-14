#!/usr/bin/env node
/**
 * merge-daltile-shapes.cjs
 *
 * Merges Daltile products that were split by tile shape (Rectangle, Hexagon,
 * Pillow, Four Square, etc.) into single products with shape as a SKU-level
 * attribute. ~56 merge groups / ~121 absorbed products.
 *
 * Usage:
 *   node backend/scripts/merge-daltile-shapes.cjs --dry-run
 *   node backend/scripts/merge-daltile-shapes.cjs
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

// Must match the list in daltile-832.js — compound phrases first
const SHAPE_WORDS = [
  'Four Square', 'Pillow', 'Pyramid', 'Star', 'Rectangle', 'Dot', 'Insert',
  'Hexagon', 'Herringbone', 'Penny', 'Chevron', 'Arabesque', 'Picket',
  'Basketweave', 'Oval', 'Trapezoid', 'Elongated', 'Fan', 'Diamond',
  'Lantern', 'Round',
];
const SHAPE_RE = new RegExp(
  '\\b(' + SHAPE_WORDS.map(w => w.replace(/\s+/g, '\\s+')).join('|') + ')\\b', 'i'
);

function stripShape(name) {
  const match = name.match(SHAPE_RE);
  const shape = match ? match[1].replace(/\s+/g, ' ') : null;
  const baseName = name.replace(SHAPE_RE, '').replace(/\s{2,}/g, ' ').trim();
  return { baseName, shape };
}

async function main() {
  console.log(`\n=== Merge Daltile Shape Variants ${DRY_RUN ? '(DRY RUN)' : '(LIVE)'} ===\n`);

  // 1. Find the Daltile vendor
  const vendorRes = await pool.query("SELECT id, name FROM vendors WHERE code = 'DAL'");
  if (vendorRes.rows.length === 0) {
    console.error('Vendor DAL not found');
    process.exit(1);
  }
  const vendorId = vendorRes.rows[0].id;
  console.log(`Vendor: ${vendorRes.rows[0].name} (${vendorId})`);

  // 2. Ensure 'shape' attribute exists
  await pool.query(`
    INSERT INTO attributes (name, slug, display_order, is_filterable)
    VALUES ('Shape', 'shape', 5, true)
    ON CONFLICT (slug) DO NOTHING
  `);

  // 3. Load all active Daltile products with metadata
  const productsRes = await pool.query(`
    SELECT p.id, p.name, p.collection, p.category_id,
      (SELECT COUNT(*) FROM skus WHERE product_id = p.id AND status = 'active') as sku_count,
      (SELECT COUNT(*) FROM media_assets WHERE product_id = p.id) as image_count
    FROM products p
    WHERE p.vendor_id = $1 AND p.status = 'active'
    ORDER BY p.name
  `, [vendorId]);

  console.log(`Active Daltile products: ${productsRes.rows.length}`);

  // 4. Group by collection|||baseName (after stripping shape)
  const groups = new Map();
  for (const p of productsRes.rows) {
    const { baseName, shape } = stripShape(p.name);
    const key = `${(p.collection || '').trim()}|||${baseName}`;

    if (!groups.has(key)) {
      groups.set(key, { baseName, collection: p.collection || '', products: [] });
    }
    groups.get(key).products.push({ ...p, _baseName: baseName, _shape: shape });
  }

  // 5. Filter to groups with 2+ products (merge candidates)
  const mergeGroups = [];
  let totalAffectedProducts = 0;
  for (const [, group] of groups) {
    if (group.products.length > 1) {
      mergeGroups.push(group);
      totalAffectedProducts += group.products.length;
    }
  }

  const totalAbsorbed = totalAffectedProducts - mergeGroups.length;
  console.log(`Merge groups: ${mergeGroups.length}`);
  console.log(`Products affected: ${totalAffectedProducts}`);
  console.log(`Products to absorb: ${totalAbsorbed}`);
  console.log(`Products remaining after merge: ${totalAffectedProducts - totalAbsorbed}\n`);

  // Show top examples
  const topExamples = [...mergeGroups].sort((a, b) => b.products.length - a.products.length).slice(0, 10);
  console.log('Top merge groups:');
  for (const g of topExamples) {
    const names = g.products.map(p => `${p.name}${p._shape ? ` [${p._shape}]` : ' [no shape]'}`).join(', ');
    console.log(`  "${g.baseName}" (${g.collection}): ${g.products.length} products — ${names}`);
  }
  console.log('');

  if (DRY_RUN) {
    console.log('DRY RUN — no changes made. Remove --dry-run to execute.\n');

    let totalSkus = 0;
    for (const group of mergeGroups) {
      const survivor = pickSurvivor(group);
      for (const p of group.products) {
        if (p.id !== survivor.id) {
          totalSkus += parseInt(p.sku_count) || 0;
        }
      }
    }
    console.log(`Would re-parent ~${totalSkus} SKUs`);
    console.log(`Would absorb ~${totalAbsorbed} products`);
    console.log(`Would set shape attribute on all affected SKUs`);

    await pool.end();
    return;
  }

  // 6. Execute merges in a single transaction with per-group SAVEPOINTs
  const stats = {
    groups_merged: 0,
    skus_reparented: 0,
    media_reparented: 0,
    shape_attrs_set: 0,
    variant_names_fixed: 0,
    cart_items_updated: 0,
    quote_items_updated: 0,
    sample_items_updated: 0,
    visit_items_updated: 0,
    trade_favorites_updated: 0,
    estimate_items_updated: 0,
    install_inquiries_updated: 0,
    product_tags_merged: 0,
    wishlists_merged: 0,
    reviews_merged: 0,
    products_absorbed: 0,
    survivors_renamed: 0,
    search_vectors_refreshed: 0,
    errors: 0,
  };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Get shape attribute id
    const attrRes = await client.query("SELECT id FROM attributes WHERE slug = 'shape'");
    const shapeAttrId = attrRes.rows[0].id;

    for (const group of mergeGroups) {
      try {
        await client.query('SAVEPOINT merge_group');

        const survivor = pickSurvivor(group);
        const others = group.products.filter(p => p.id !== survivor.id);
        const otherIds = others.map(p => p.id);
        const allProducts = group.products;
        const allProductIds = allProducts.map(p => p.id);

        // ── Set shape attribute on ALL SKUs in the group ──
        for (const p of allProducts) {
          const shapeVal = p._shape || 'Standard';
          const res = await client.query(`
            INSERT INTO sku_attributes (sku_id, attribute_id, value)
            SELECT s.id, $1, $2
            FROM skus s WHERE s.product_id = $3 AND s.status = 'active'
            ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value = EXCLUDED.value
          `, [shapeAttrId, shapeVal, p.id]);
          stats.shape_attrs_set += res.rowCount;
        }

        // ── Disambiguate variant_name collisions by appending shape ──
        // Find SKUs that would collide on variant_name after merge
        for (const p of others) {
          if (p._shape) {
            const res = await client.query(`
              UPDATE skus SET variant_name =
                CASE WHEN variant_name IS NOT NULL AND variant_name != ''
                  THEN variant_name || ', ' || $1
                  ELSE $1
                END,
                updated_at = NOW()
              WHERE product_id = $2 AND status = 'active'
                AND EXISTS (
                  SELECT 1 FROM skus s2
                  WHERE s2.product_id = $3 AND s2.status = 'active'
                    AND s2.variant_name = skus.variant_name
                )
            `, [p._shape, p.id, survivor.id]);
            stats.variant_names_fixed += res.rowCount;
          }
        }
        // Also disambiguate survivor SKUs if survivor has a shape word
        if (survivor._shape) {
          const res = await client.query(`
            UPDATE skus SET variant_name =
              CASE WHEN variant_name IS NOT NULL AND variant_name != ''
                THEN variant_name || ', ' || $1
                ELSE $1
              END,
              updated_at = NOW()
            WHERE product_id = $2 AND status = 'active'
              AND EXISTS (
                SELECT 1 FROM skus s2
                WHERE s2.product_id = ANY($3) AND s2.status = 'active'
                  AND s2.variant_name = skus.variant_name
                  AND s2.product_id != $2
              )
          `, [survivor._shape, survivor.id, allProductIds]);
          stats.variant_names_fixed += res.rowCount;
        }

        // ── Re-parent SKUs from absorbed products to survivor ──
        const skuResult = await client.query(
          `UPDATE skus SET product_id = $1, updated_at = NOW() WHERE product_id = ANY($2)`,
          [survivor.id, otherIds]
        );
        stats.skus_reparented += skuResult.rowCount;

        // ── Update FK references on active/current tables ──
        // cart_items
        let res = await client.query(
          `UPDATE cart_items SET product_id = $1 WHERE product_id = ANY($2)`,
          [survivor.id, otherIds]
        );
        stats.cart_items_updated += res.rowCount;

        // media_assets: SKU-level (already re-parented via skus), product-level needs move
        await client.query(`
          DELETE FROM media_assets m
          WHERE m.product_id = ANY($2) AND m.sku_id IS NULL
            AND EXISTS (
              SELECT 1 FROM media_assets e
              WHERE e.product_id = $1 AND e.sku_id IS NULL
                AND e.asset_type = m.asset_type AND e.sort_order = m.sort_order
            )
        `, [survivor.id, otherIds]);
        res = await client.query(
          `UPDATE media_assets SET product_id = $1 WHERE product_id = ANY($2) AND sku_id IS NULL`,
          [survivor.id, otherIds]
        );
        stats.media_reparented += res.rowCount;

        // quote_items (active quotes only — skip completed/cancelled)
        res = await client.query(`
          UPDATE quote_items qi SET product_id = $1
          FROM quotes q
          WHERE qi.quote_id = q.id AND qi.product_id = ANY($2)
            AND q.status NOT IN ('cancelled', 'expired')
        `, [survivor.id, otherIds]);
        stats.quote_items_updated += res.rowCount;

        // sample_request_items
        res = await client.query(
          `UPDATE sample_request_items SET product_id = $1 WHERE product_id = ANY($2)`,
          [survivor.id, otherIds]
        );
        stats.sample_items_updated += res.rowCount;

        // showroom_visit_items
        res = await client.query(
          `UPDATE showroom_visit_items SET product_id = $1 WHERE product_id = ANY($2)`,
          [survivor.id, otherIds]
        );
        stats.visit_items_updated += res.rowCount;

        // trade_favorite_items
        res = await client.query(
          `UPDATE trade_favorite_items SET product_id = $1 WHERE product_id = ANY($2)`,
          [survivor.id, otherIds]
        );
        stats.trade_favorites_updated += res.rowCount;

        // estimate_items
        res = await client.query(
          `UPDATE estimate_items SET product_id = $1 WHERE product_id = ANY($2)`,
          [survivor.id, otherIds]
        );
        stats.estimate_items_updated += res.rowCount;

        // installation_inquiries
        res = await client.query(
          `UPDATE installation_inquiries SET product_id = $1 WHERE product_id = ANY($2)`,
          [survivor.id, otherIds]
        );
        stats.install_inquiries_updated += res.rowCount;

        // ── Merge product_tags (move, skip dupes, then delete originals) ──
        res = await client.query(`
          INSERT INTO product_tags (product_id, tag_id)
          SELECT $1, pt.tag_id FROM product_tags pt
          WHERE pt.product_id = ANY($2)
          ON CONFLICT (product_id, tag_id) DO NOTHING
        `, [survivor.id, otherIds]);
        stats.product_tags_merged += res.rowCount;
        await client.query(
          `DELETE FROM product_tags WHERE product_id = ANY($1)`,
          [otherIds]
        );

        // ── Merge wishlists (move, skip dupes via ON CONFLICT) ──
        // wishlists has UNIQUE(customer_id, product_id), so we need careful handling
        res = await client.query(`
          INSERT INTO wishlists (customer_id, product_id, created_at)
          SELECT w.customer_id, $1, w.created_at FROM wishlists w
          WHERE w.product_id = ANY($2)
          ON CONFLICT (customer_id, product_id) DO NOTHING
        `, [survivor.id, otherIds]);
        stats.wishlists_merged += res.rowCount;
        await client.query(
          `DELETE FROM wishlists WHERE product_id = ANY($1)`,
          [otherIds]
        );

        // ── Merge product_reviews (move, skip dupes) ──
        // product_reviews has UNIQUE(product_id, customer_id)
        res = await client.query(`
          INSERT INTO product_reviews (product_id, customer_id, rating, title, body, created_at)
          SELECT $1, r.customer_id, r.rating, r.title, r.body, r.created_at
          FROM product_reviews r
          WHERE r.product_id = ANY($2)
          ON CONFLICT (product_id, customer_id) DO NOTHING
        `, [survivor.id, otherIds]);
        stats.reviews_merged += res.rowCount;
        await client.query(
          `DELETE FROM product_reviews WHERE product_id = ANY($1)`,
          [otherIds]
        );

        // DO NOT update historical: order_items, invoice_items, bill_items

        // ── Rename absorbed products with [merged] suffix, deactivate ──
        for (const p of others) {
          await client.query(
            `UPDATE products SET name = $1, status = 'inactive', updated_at = NOW() WHERE id = $2`,
            [p.name + ' [merged]', p.id]
          );
          stats.products_absorbed++;
        }

        // ── Rename survivor to baseName if it differs and no collision ──
        if (survivor.name !== group.baseName) {
          const collision = await client.query(
            `SELECT id FROM products WHERE vendor_id = $1 AND name = $2 AND id != $3 AND status = 'active'`,
            [vendorId, group.baseName, survivor.id]
          );
          if (collision.rows.length === 0) {
            await client.query(
              `UPDATE products SET name = $1, updated_at = NOW() WHERE id = $2`,
              [group.baseName, survivor.id]
            );
            stats.survivors_renamed++;
          }
        }

        // ── Refresh search vectors for survivor ──
        await client.query(`SELECT refresh_search_vectors($1)`, [survivor.id]);
        stats.search_vectors_refreshed++;

        await client.query('RELEASE SAVEPOINT merge_group');
        stats.groups_merged++;
      } catch (err) {
        await client.query('ROLLBACK TO SAVEPOINT merge_group');
        console.error(`Error merging group "${group.baseName}" (${group.collection}):`, err.message);
        stats.errors++;
      }
    }

    await client.query('COMMIT');
    console.log('\nTransaction committed successfully.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Transaction rolled back:', err.message);
    process.exit(1);
  } finally {
    client.release();
  }

  // 7. Print results
  console.log('\n=== Results ===');
  console.log(`Groups merged:            ${stats.groups_merged}`);
  console.log(`SKUs re-parented:         ${stats.skus_reparented}`);
  console.log(`Media assets moved:       ${stats.media_reparented}`);
  console.log(`Shape attributes set:     ${stats.shape_attrs_set}`);
  console.log(`Variant names fixed:      ${stats.variant_names_fixed}`);
  console.log(`Products absorbed:        ${stats.products_absorbed}`);
  console.log(`Survivors renamed:        ${stats.survivors_renamed}`);
  console.log(`Search vectors refreshed: ${stats.search_vectors_refreshed}`);
  if (stats.cart_items_updated) console.log(`Cart items updated:       ${stats.cart_items_updated}`);
  if (stats.quote_items_updated) console.log(`Quote items updated:      ${stats.quote_items_updated}`);
  if (stats.sample_items_updated) console.log(`Sample items updated:     ${stats.sample_items_updated}`);
  if (stats.visit_items_updated) console.log(`Visit items updated:      ${stats.visit_items_updated}`);
  if (stats.trade_favorites_updated) console.log(`Trade favorites updated:  ${stats.trade_favorites_updated}`);
  if (stats.estimate_items_updated) console.log(`Estimate items updated:   ${stats.estimate_items_updated}`);
  if (stats.install_inquiries_updated) console.log(`Install inquiries updated:${stats.install_inquiries_updated}`);
  if (stats.product_tags_merged) console.log(`Product tags merged:      ${stats.product_tags_merged}`);
  if (stats.wishlists_merged) console.log(`Wishlists merged:         ${stats.wishlists_merged}`);
  if (stats.reviews_merged) console.log(`Reviews merged:           ${stats.reviews_merged}`);
  if (stats.errors > 0) console.log(`Errors:                   ${stats.errors}`);
  console.log('');

  // 8. Verification queries
  console.log('=== Verification ===');
  const activeCount = await pool.query(
    `SELECT COUNT(*) FROM products WHERE vendor_id = $1 AND status = 'active'`,
    [vendorId]
  );
  console.log(`Active Daltile products: ${activeCount.rows[0].count}`);

  const mergedCount = await pool.query(
    `SELECT COUNT(*) FROM products WHERE vendor_id = $1 AND status = 'inactive' AND name LIKE '%[merged]%'`,
    [vendorId]
  );
  console.log(`Merged (inactive) products: ${mergedCount.rows[0].count}`);

  const shapeAttrCount = await pool.query(`
    SELECT COUNT(*) FROM sku_attributes sa
    JOIN attributes a ON a.id = sa.attribute_id
    WHERE a.slug = 'shape'
  `);
  console.log(`SKUs with shape attribute: ${shapeAttrCount.rows[0].count}`);
  console.log('');

  await pool.end();
}

/**
 * Pick the survivor product from a merge group.
 * Prefer: name matches baseName (catalog parent, no shape word) >
 *         most SKUs > most images > lowest UUID (stable tiebreaker).
 */
function pickSurvivor(group) {
  return group.products.slice().sort((a, b) => {
    // Prefer product whose name already matches the baseName (no shape word)
    const aClean = a._shape === null ? 0 : 1;
    const bClean = b._shape === null ? 0 : 1;
    if (aClean !== bClean) return aClean - bClean;

    // Then most SKUs
    const skuDiff = (parseInt(b.sku_count) || 0) - (parseInt(a.sku_count) || 0);
    if (skuDiff !== 0) return skuDiff;

    // Then most images
    const imgDiff = (parseInt(b.image_count) || 0) - (parseInt(a.image_count) || 0);
    if (imgDiff !== 0) return imgDiff;

    // Lowest UUID as stable tiebreaker
    return a.id.localeCompare(b.id);
  })[0];
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
