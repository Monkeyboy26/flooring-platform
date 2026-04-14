/**
 * MSI Product Grouping — Phase 4-7 (continuation after phases 1-3 completed)
 */
const { Pool } = require('pg');
const pool = new Pool({
  host: process.env.DB_HOST || 'db',
  port: 5432, database: 'flooring_pim', user: 'postgres', password: 'postgres',
});

async function run() {
  const client = await pool.connect();
  try {
    const vendorRes = await client.query("SELECT id FROM vendors WHERE code = 'MSI'");
    const vendorId = vendorRes.rows[0].id;

    // ═══════════════════════════════════════════════════════════
    // PHASE 4: Transfer images from no-SKU shells to 832 products
    // ═══════════════════════════════════════════════════════════
    console.log('\n=== PHASE 4: Transfer images from no-SKU products ===');

    const shellProducts = await client.query(`
      SELECT p.id, p.name, p.collection, p.category_id, c.name as category_name
      FROM products p
      JOIN categories c ON c.id = p.category_id
      WHERE p.vendor_id = $1 AND p.is_active = true
        AND NOT EXISTS (SELECT 1 FROM skus s WHERE s.product_id = p.id)
        AND EXISTS (SELECT 1 FROM media_assets ma WHERE ma.product_id = p.id)
      ORDER BY p.name
    `, [vendorId]);
    console.log(`  No-SKU products with images: ${shellProducts.rowCount}`);

    let transferred = 0, noMatch = 0;

    for (const shell of shellProducts.rows) {
      let targetProduct = null;

      // Try exact name + collection match
      if (shell.collection) {
        const exactMatch = await client.query(`
          SELECT p.id, p.name, p.collection,
            EXISTS(SELECT 1 FROM media_assets ma WHERE ma.product_id = p.id) as has_images
          FROM products p
          WHERE p.vendor_id = $1 AND p.is_active = true AND p.id != $2
            AND p.category_id = $3
            AND LOWER(p.name) = LOWER($4)
            AND LOWER(COALESCE(p.collection, '')) = LOWER($5)
            AND EXISTS (SELECT 1 FROM skus s WHERE s.product_id = p.id)
          LIMIT 1
        `, [vendorId, shell.id, shell.category_id, shell.name, shell.collection]);
        if (exactMatch.rows.length) targetProduct = exactMatch.rows[0];
      }

      // Fallback: name-only match in same category
      if (!targetProduct) {
        const nameMatch = await client.query(`
          SELECT p.id, p.name, p.collection,
            EXISTS(SELECT 1 FROM media_assets ma WHERE ma.product_id = p.id) as has_images
          FROM products p
          WHERE p.vendor_id = $1 AND p.is_active = true AND p.id != $2
            AND p.category_id = $3
            AND LOWER(p.name) = LOWER($4)
            AND EXISTS (SELECT 1 FROM skus s WHERE s.product_id = p.id)
          ORDER BY
            CASE WHEN EXISTS(SELECT 1 FROM media_assets ma WHERE ma.product_id = p.id) THEN 1 ELSE 0 END
          LIMIT 1
        `, [vendorId, shell.id, shell.category_id, shell.name]);
        if (nameMatch.rows.length) targetProduct = nameMatch.rows[0];
      }

      if (targetProduct) {
        if (!targetProduct.has_images) {
          await client.query('UPDATE media_assets SET product_id = $1 WHERE product_id = $2',
            [targetProduct.id, shell.id]);
        }
        // Try to update collection (ignore unique constraint errors)
        if (shell.collection && shell.collection !== 'M S International Inc.') {
          try {
            await client.query(`
              UPDATE products SET collection = $1 WHERE id = $2
                AND (collection IS NULL OR collection = '' OR collection = 'M S International Inc.')
            `, [shell.collection, targetProduct.id]);
          } catch (err) {
            if (err.code !== '23505') throw err;
          }
        }
        transferred++;
      } else {
        noMatch++;
        if (noMatch <= 20) {
          console.log(`    No match: "${shell.name}" [${shell.collection || '?'}] (${shell.category_name})`);
        }
      }
    }
    console.log(`  Images transferred: ${transferred}`);
    console.log(`  No match found: ${noMatch}`);

    // ═══════════════════════════════════════════════════════════
    // PHASE 5: Deactivate empty shell products (no SKUs)
    // ═══════════════════════════════════════════════════════════
    console.log('\n=== PHASE 5: Deactivate no-SKU shell products ===');

    const deactivateResult = await client.query(`
      UPDATE products SET is_active = false
      WHERE vendor_id = $1 AND is_active = true
        AND NOT EXISTS (SELECT 1 FROM skus s WHERE s.product_id = id)
      RETURNING id
    `, [vendorId]);
    console.log(`  Deactivated ${deactivateResult.rowCount} no-SKU shell products`);

    // ═══════════════════════════════════════════════════════════
    // PHASE 6: Merge remaining same-name duplicates
    // ═══════════════════════════════════════════════════════════
    console.log('\n=== PHASE 6: Merge same-name duplicates within category+collection ===');

    const dupes = await client.query(`
      SELECT p.name, p.collection, p.category_id, c.name as category_name,
             array_agg(p.id ORDER BY
               CASE WHEN EXISTS(SELECT 1 FROM media_assets ma WHERE ma.product_id = p.id) THEN 0 ELSE 1 END,
               p.created_at
             ) as product_ids,
             COUNT(*) as cnt
      FROM products p
      JOIN categories c ON c.id = p.category_id
      WHERE p.vendor_id = $1 AND p.is_active = true
      GROUP BY p.name, p.collection, p.category_id, c.name
      HAVING COUNT(*) > 1
      ORDER BY COUNT(*) DESC
    `, [vendorId]);

    let merged = 0;
    for (const dupe of dupes.rows) {
      const keepId = dupe.product_ids[0];
      const mergeIds = dupe.product_ids.slice(1);

      for (const mergeId of mergeIds) {
        await client.query('UPDATE skus SET product_id = $1 WHERE product_id = $2', [keepId, mergeId]);
        const keeperHasImages = await client.query('SELECT 1 FROM media_assets WHERE product_id = $1 LIMIT 1', [keepId]);
        if (!keeperHasImages.rows.length) {
          await client.query('UPDATE media_assets SET product_id = $1 WHERE product_id = $2', [keepId, mergeId]);
        } else {
          await client.query('DELETE FROM media_assets WHERE product_id = $1', [mergeId]);
        }
        await client.query('UPDATE products SET is_active = false WHERE id = $1', [mergeId]);
        merged++;
      }
    }
    console.log(`  Merged ${merged} duplicate products (${dupes.rowCount} groups)`);

    // ═══════════════════════════════════════════════════════════
    // PHASE 7: Clean Transitions naming
    // ═══════════════════════════════════════════════════════════
    console.log('\n=== PHASE 7: Clean Transitions & Moldings names ===');

    const transCategory = await client.query("SELECT id FROM categories WHERE name = 'Transitions & Moldings'");
    if (transCategory.rows.length) {
      const transCandidates = await client.query(`
        SELECT id, name FROM products
        WHERE vendor_id = $1 AND is_active = true
          AND category_id = $2 AND name ~* '^Vtt\\s+'
      `, [vendorId, transCategory.rows[0].id]);
      let transFix = 0;
      for (const row of transCandidates.rows) {
        const cleanName = row.name.replace(/^Vtt\s+/i, '');
        try {
          await client.query('UPDATE products SET name = $1 WHERE id = $2', [cleanName, row.id]);
          transFix++;
        } catch (err) {
          if (err.code !== '23505') throw err;
        }
      }
      console.log(`  Stripped VTT prefix from ${transFix} transitions`);
    }

    // ═══════════════════════════════════════════════════════════
    // SUMMARY
    // ═══════════════════════════════════════════════════════════
    console.log('\n=== SUMMARY ===');

    const finalCount = await client.query(`
      SELECT c.name as category, COUNT(DISTINCT p.id) as products,
             COUNT(DISTINCT p.name) as unique_names,
             SUM(CASE WHEN EXISTS(SELECT 1 FROM media_assets ma WHERE ma.product_id = p.id) THEN 1 ELSE 0 END) as with_images
      FROM products p
      JOIN categories c ON c.id = p.category_id
      WHERE p.vendor_id = $1 AND p.is_active = true
      GROUP BY c.name
      ORDER BY COUNT(DISTINCT p.id) DESC
    `, [vendorId]);

    let totalProducts = 0, totalWithImages = 0;
    for (const row of finalCount.rows) {
      console.log(`  ${row.category}: ${row.products} products (${row.unique_names} unique names, ${row.with_images} with images)`);
      totalProducts += parseInt(row.products);
      totalWithImages += parseInt(row.with_images);
    }
    console.log(`\n  Total: ${totalProducts} products, ${totalWithImages} with images`);

    // Check for any remaining same-name dupes (across different collections, same category)
    const crossCollDupes = await client.query(`
      SELECT p.name, c.name as category, COUNT(*) as cnt,
             array_agg(DISTINCT p.collection) as collections
      FROM products p
      JOIN categories c ON c.id = p.category_id
      WHERE p.vendor_id = $1 AND p.is_active = true
      GROUP BY p.name, c.name
      HAVING COUNT(*) > 1
      ORDER BY COUNT(*) DESC
      LIMIT 10
    `, [vendorId]);
    if (crossCollDupes.rowCount > 0) {
      console.log(`\n  Cross-collection same-name products (${crossCollDupes.rowCount} groups):`);
      for (const r of crossCollDupes.rows) {
        console.log(`    "${r.name}" in ${r.category}: ${r.cnt}x across [${r.collections.join(', ')}]`);
      }
    }

    await client.query('REFRESH MATERIALIZED VIEW CONCURRENTLY product_popularity');
    console.log('\n  Refreshed product_popularity view');

  } finally {
    client.release();
    await pool.end();
  }
}

run().catch(err => { console.error(err); process.exit(1); });
