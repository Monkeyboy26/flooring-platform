/**
 * MSI Product Grouping & Cleanup Script
 *
 * 1. Strip packaging suffix from 832 product names
 * 2. Extract collection from LVP product names
 * 3. Fix non-LVP 832 product names
 * 4. Transfer images from no-SKU shells to matching 832 products
 * 5. Deactivate empty shell products
 * 6. Merge remaining same-name duplicates within categories
 */

const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'db',
  port: 5432, database: 'flooring_pim', user: 'postgres', password: 'postgres',
});

// Known MSI LVP collection names (ordered longest-first for greedy matching)
const LVP_COLLECTIONS = [
  'Wayne Parc Reserve', 'Laurel Reserve', 'Nove Reserve',
  'Wayne Parc', 'Nove Plus', 'XL Prescott', 'XL Trecento',
  'XL Cyrus', 'XL Ashton', 'XL Studio', 'Cyrus 2.0', 'Ashton 2.0',
  'Mc. Reserve',
  'Prescott', 'Trecento', 'Glenridge', 'Andover', 'Mccarran',
  'Kallum', 'Acclima', 'Katavia', 'Wilmont', 'Shorecliffs',
  'Cyrus', 'Laurel', 'Ladson', 'Kelmore', 'Woodhills',
  'Smithcliffs', 'Lofterra', 'Studio', 'Ashton', 'Nove',
  'Chilcott', 'Harvested', 'Mountains',
];

// Normalize collection name for comparison
function normCollection(name) {
  return name.replace(/\./g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

async function run() {
  const client = await pool.connect();

  try {
    // Get MSI vendor ID
    const vendorRes = await client.query("SELECT id FROM vendors WHERE code = 'MSI'");
    if (!vendorRes.rows.length) { console.error('MSI vendor not found'); return; }
    const vendorId = vendorRes.rows[0].id;

    // ═══════════════════════════════════════════════════════════
    // PHASE 1: Clean 832 product names (strip packaging suffix)
    // ═══════════════════════════════════════════════════════════
    console.log('\n=== PHASE 1: Strip packaging suffix from 832 product names ===');

    // First find products that would collide after stripping suffix
    const candidates = await client.query(`
      SELECT id, name, collection, category_id,
             RTRIM(regexp_replace(name, '\\s*\\(\\s*[\\d.]+\\s*Sf\\s*Per\\s*Box\\s*\\)', '', 'i')) as clean_name
      FROM products
      WHERE vendor_id = $1 AND is_active = true
        AND name ~ '\\(\\s*[\\d.]+\\s*Sf\\s*Per\\s*Box\\s*\\)'
      ORDER BY name
    `, [vendorId]);

    // Group by (vendor_id, collection, clean_name) to detect collisions
    const groups = new Map();
    for (const row of candidates.rows) {
      const key = `${row.collection}|||${row.clean_name}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }

    // Also check for collision with existing products that already have the clean name
    let stripped = 0, mergedInP1 = 0;
    for (const [key, rows] of groups) {
      const cleanName = rows[0].clean_name;
      const collection = rows[0].collection;

      // Check if a product with the clean name already exists
      const existing = await client.query(`
        SELECT id FROM products
        WHERE vendor_id = $1 AND collection = $2 AND name = $3 AND is_active = true
      `, [vendorId, collection, cleanName]);

      if (existing.rows.length > 0 || rows.length > 1) {
        // Collision: merge all into the existing one (or first row)
        const keepId = existing.rows.length > 0 ? existing.rows[0].id : rows[0].id;
        const mergeRows = rows.filter(r => r.id !== keepId);

        // If keeper is from our candidates list, rename it first
        if (!existing.rows.length) {
          await client.query('UPDATE products SET name = $1 WHERE id = $2', [cleanName, keepId]);
          stripped++;
        }

        for (const mr of mergeRows) {
          await client.query('UPDATE skus SET product_id = $1 WHERE product_id = $2', [keepId, mr.id]);
          await client.query('DELETE FROM media_assets WHERE product_id = $1', [mr.id]);
          await client.query('UPDATE products SET is_active = false WHERE id = $1', [mr.id]);
          mergedInP1++;
        }
      } else {
        // No collision, safe to rename
        await client.query('UPDATE products SET name = $1 WHERE id = $2', [cleanName, rows[0].id]);
        stripped++;
      }
    }
    console.log(`  Stripped packaging suffix from ${stripped} products`);
    console.log(`  Merged ${mergedInP1} collision products`);

    // Also strip trailing whitespace from remaining products
    await client.query(`
      UPDATE products SET name = RTRIM(name)
      WHERE vendor_id = $1 AND is_active = true AND name != RTRIM(name)
    `, [vendorId]);

    // ═══════════════════════════════════════════════════════════
    // PHASE 2: Extract collection from LVP 832 product names
    // ═══════════════════════════════════════════════════════════
    console.log('\n=== PHASE 2: Extract collection from LVP 832 names ===');

    const lvpCategory = await client.query("SELECT id FROM categories WHERE name = 'LVP (Plank)'");
    if (!lvpCategory.rows.length) { console.log('  LVP category not found, skipping'); }
    const lvpCatId = lvpCategory.rows[0]?.id;

    if (lvpCatId) {
      const lvpProducts = await client.query(`
        SELECT id, name, collection FROM products
        WHERE vendor_id = $1 AND is_active = true
          AND collection = 'M S International Inc.'
          AND category_id = $2
        ORDER BY name
      `, [vendorId, lvpCatId]);

      let extracted = 0, mergedInP2 = 0;
      for (const prod of lvpProducts.rows) {
        let matched = false;
        for (const coll of LVP_COLLECTIONS) {
          // Case-insensitive prefix match (handle dots, case differences)
          const prefixLower = coll.toLowerCase().replace(/\./g, '');
          const nameLower = prod.name.toLowerCase().replace(/\./g, '');

          if (nameLower.startsWith(prefixLower + ' ') || nameLower.startsWith(prefixLower + '-')) {
            // Handle varying prefix lengths (e.g., "Xl Cyrus" is 9 chars, "XL Cyrus" is 8)
            // Find actual prefix length in original name
            let actualPrefixLen = coll.length;
            // If original has "Xl " but coll is "XL " (same letters, different case)
            const origLower = prod.name.toLowerCase();
            const collLower = coll.toLowerCase();
            // Find where the color starts after the prefix
            for (let i = coll.length - 2; i <= coll.length + 2; i++) {
              if (i >= 0 && i < prod.name.length && /[\s-]/.test(prod.name[i])) {
                const prefix = prod.name.substring(0, i).toLowerCase().replace(/\./g, '');
                if (prefix === prefixLower) {
                  actualPrefixLen = i;
                  break;
                }
              }
            }
            const colorName = prod.name.substring(actualPrefixLen).replace(/^[\s-]+/, '').trim();

            let fixedColl = coll;
            if (/^Xl\s/i.test(prod.name)) fixedColl = 'XL' + coll.substring(2);
            if (coll === 'Mc. Reserve') fixedColl = 'Mccarran Reserve';

            if (colorName.length > 0) {
              // Check if target (name, collection) already exists
              const existing = await client.query(`
                SELECT id FROM products
                WHERE vendor_id = $1 AND collection = $2 AND LOWER(name) = LOWER($3) AND is_active = true AND id != $4
              `, [vendorId, fixedColl, colorName, prod.id]);

              if (existing.rows.length > 0) {
                // Merge into existing
                const keepId = existing.rows[0].id;
                await client.query('UPDATE skus SET product_id = $1 WHERE product_id = $2', [keepId, prod.id]);
                const keeperHas = await client.query('SELECT 1 FROM media_assets WHERE product_id = $1 LIMIT 1', [keepId]);
                if (!keeperHas.rows.length) {
                  await client.query('UPDATE media_assets SET product_id = $1 WHERE product_id = $2', [keepId, prod.id]);
                } else {
                  await client.query('DELETE FROM media_assets WHERE product_id = $1', [prod.id]);
                }
                await client.query('UPDATE products SET is_active = false WHERE id = $1', [prod.id]);
                mergedInP2++;
              } else {
                await client.query(
                  'UPDATE products SET name = $1, collection = $2 WHERE id = $3',
                  [colorName, fixedColl, prod.id]
                );
              }
              extracted++;
              matched = true;
              break;
            }
          }
        }
      }
      console.log(`  Extracted collection from ${extracted} / ${lvpProducts.rowCount} LVP products`);
      console.log(`  Merged ${mergedInP2} into existing products`);

      // Show unmatched
      const unmatched = await client.query(`
        SELECT name FROM products
        WHERE vendor_id = $1 AND is_active = true
          AND collection = 'M S International Inc.' AND category_id = $2
        ORDER BY name LIMIT 20
      `, [vendorId, lvpCatId]);
      if (unmatched.rowCount > 0) {
        console.log(`  Unmatched LVP products (${unmatched.rowCount}):`);
        for (const r of unmatched.rows) console.log(`    ${r.name}`);
      }
    }

    // ═══════════════════════════════════════════════════════════
    // PHASE 3: Clean non-LVP 832 product names
    // ═══════════════════════════════════════════════════════════
    console.log('\n=== PHASE 3: Clean non-LVP 832 product names ===');

    // Fix joined words one-by-one to avoid unique constraint issues
    const joinedCandidates = await client.query(`
      SELECT id, name, collection FROM products
      WHERE vendor_id = $1 AND is_active = true
        AND name ~ '[a-z][A-Z]'
        AND collection = 'M S International Inc.'
    `, [vendorId]);
    let joinedFixed = 0;
    for (const row of joinedCandidates.rows) {
      const fixed = row.name.replace(/([a-z])([A-Z])/g, '$1 $2');
      if (fixed === row.name) continue;
      try {
        await client.query('UPDATE products SET name = $1 WHERE id = $2', [fixed, row.id]);
        joinedFixed++;
      } catch (err) {
        if (err.code === '23505') { /* unique collision - skip */ } else throw err;
      }
    }
    console.log(`  Fixed joined words in ${joinedFixed} products`);

    // Fix "Arterra" prefix in hardscaping, one-by-one to handle collisions
    const arterraCandidates = await client.query(`
      SELECT id, name, collection FROM products
      WHERE vendor_id = $1 AND is_active = true
        AND name ~* '^Arterra\\s+'
        AND category_id IN (SELECT id FROM categories WHERE name IN ('Hardscaping', 'Pavers'))
    `, [vendorId]);
    let arterraFixed = 0;
    for (const row of arterraCandidates.rows) {
      const cleanName = row.name.replace(/^Arterra\s+/i, '');
      const newColl = row.collection === 'M S International Inc.' ? 'Arterra' : row.collection;
      try {
        await client.query('UPDATE products SET name = $1, collection = $2 WHERE id = $3', [cleanName, newColl, row.id]);
        arterraFixed++;
      } catch (err) {
        if (err.code === '23505') { /* unique collision - skip */ } else throw err;
      }
    }
    console.log(`  Extracted 'Arterra' collection from ${arterraFixed} hardscaping products`);

    // ═══════════════════════════════════════════════════════════
    // PHASE 4: Transfer images from no-SKU shells to 832 products
    // ═══════════════════════════════════════════════════════════
    console.log('\n=== PHASE 4: Transfer images from no-SKU products ===');

    // Get all no-SKU products with images
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

    let transferred = 0;
    let noMatch = 0;
    const deactivateIds = [];

    for (const shell of shellProducts.rows) {
      // Find matching 832 product: same category, matching name
      // The 832 product's name might be just the color (after Phase 2 extraction)
      // or still have the full name if it wasn't LVP

      // Strategy: look for product in same category where:
      // 1. Same name and same collection (exact match after Phase 2)
      // 2. Same name, any collection (for non-LVP or mismatched collections)
      // Prefer products that have SKUs but no images

      let targetProduct = null;

      // Try exact name + collection match first
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

      // If no exact match, try name-only match (prefer no-images target)
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
            CASE WHEN EXISTS(SELECT 1 FROM media_assets ma WHERE ma.product_id = p.id) THEN 1 ELSE 0 END,
            p.name
          LIMIT 1
        `, [vendorId, shell.id, shell.category_id, shell.name]);

        if (nameMatch.rows.length) targetProduct = nameMatch.rows[0];
      }

      if (targetProduct) {
        // Transfer images if target doesn't have them
        if (!targetProduct.has_images) {
          await client.query(`
            UPDATE media_assets SET product_id = $1 WHERE product_id = $2
          `, [targetProduct.id, shell.id]);
        }
        // Also copy collection from shell to target if target has generic collection
        if (shell.collection && shell.collection !== 'M S International Inc.') {
          try {
            await client.query(`
              UPDATE products SET collection = $1 WHERE id = $2
                AND (collection IS NULL OR collection = '' OR collection = 'M S International Inc.')
            `, [shell.collection, targetProduct.id]);
          } catch (err) {
            if (err.code !== '23505') throw err;
            // Collision — skip collection update
          }
        }
        deactivateIds.push(shell.id);
        transferred++;
      } else {
        noMatch++;
      }
    }
    console.log(`  Images transferred: ${transferred}`);
    console.log(`  No match found: ${noMatch}`);

    // ═══════════════════════════════════════════════════════════
    // PHASE 5: Deactivate empty shell products (no SKUs)
    // ═══════════════════════════════════════════════════════════
    console.log('\n=== PHASE 5: Deactivate no-SKU shell products ===');

    // Deactivate all products with no SKUs (including those where images were transferred
    // and those with no images at all)
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
    console.log('\n=== PHASE 6: Merge same-name duplicates within categories ===');

    // Find remaining duplicates (same name + same category + same collection)
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
      const keepId = dupe.product_ids[0]; // First = has images + oldest
      const mergeIds = dupe.product_ids.slice(1);

      // Move SKUs from duplicates to keeper
      for (const mergeId of mergeIds) {
        await client.query('UPDATE skus SET product_id = $1 WHERE product_id = $2', [keepId, mergeId]);
        // Transfer images if keeper has none
        const keeperHasImages = await client.query(
          'SELECT 1 FROM media_assets WHERE product_id = $1 LIMIT 1', [keepId]
        );
        if (!keeperHasImages.rows.length) {
          await client.query('UPDATE media_assets SET product_id = $1 WHERE product_id = $2', [keepId, mergeId]);
        } else {
          // Delete duplicate images
          await client.query('DELETE FROM media_assets WHERE product_id = $1', [mergeId]);
        }
        // Deactivate the duplicate
        await client.query('UPDATE products SET is_active = false WHERE id = $1', [mergeId]);
        merged++;
      }
    }
    console.log(`  Merged ${merged} duplicate products (${dupes.rowCount} groups)`);

    // ═══════════════════════════════════════════════════════════
    // PHASE 7: Fix Transitions naming
    // ═══════════════════════════════════════════════════════════
    console.log('\n=== PHASE 7: Clean Transitions & Moldings names ===');

    const transCategory = await client.query("SELECT id FROM categories WHERE name = 'Transitions & Moldings'");
    if (transCategory.rows.length) {
      const transCandidates = await client.query(`
        SELECT id, name, collection FROM products
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
          if (err.code === '23505') { /* collision - skip */ } else throw err;
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

    // Check remaining duplicates
    const remainingDupes = await client.query(`
      SELECT COUNT(*) as cnt FROM (
        SELECT p.name, p.category_id, p.collection
        FROM products p WHERE p.vendor_id = $1 AND p.is_active = true
        GROUP BY p.name, p.category_id, p.collection
        HAVING COUNT(*) > 1
      ) x
    `, [vendorId]);
    console.log(`  Remaining duplicate groups: ${remainingDupes.rows[0].cnt}`);

    // Refresh materialized view
    await client.query('REFRESH MATERIALIZED VIEW CONCURRENTLY product_popularity');
    console.log('  Refreshed product_popularity view');

  } finally {
    client.release();
    await pool.end();
  }
}

run().catch(err => { console.error(err); process.exit(1); });
