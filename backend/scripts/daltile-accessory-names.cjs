#!/usr/bin/env node
/**
 * Daltile accessory display_name fix.
 *
 * Many Daltile products in "Transitions & Moldings" have display_name = collection name
 * (e.g., "Adventuro") with no indication of what the accessory is. This script adds
 * the trim type (Stair Nose, Bullnose, Cove Base, etc.) to the display_name.
 *
 * Usage:
 *   node backend/scripts/daltile-accessory-names.cjs --dry-run
 *   node backend/scripts/daltile-accessory-names.cjs
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

function log(label, result) {
  console.log(`  ${String(label).padEnd(50)} ${result}`);
}

async function main() {
  console.log(`Daltile Accessory Name Fix ${DRY_RUN ? '[DRY RUN]' : '[EXECUTING]'}`);
  console.log('='.repeat(60));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Get vendor ID
    const { rows: [vendor] } = await client.query(`SELECT id FROM vendors WHERE code = 'DAL'`);
    if (!vendor) throw new Error('DAL vendor not found');
    const vid = vendor.id;

    // Get T&M category ID
    const { rows: [tmCat] } = await client.query(
      `SELECT id FROM categories WHERE name = 'Transitions & Moldings' LIMIT 1`
    );
    if (!tmCat) throw new Error('T&M category not found');

    // ─── Phase 1: Stair Nose products (vendor_sku contains VRDSNST/VRDSNSX/VSNPSX) ───
    console.log('\n=== Phase 1: Stair Nose products ===');
    const { rows: stairNoseProducts } = await client.query(`
      SELECT DISTINCT p.id, p.display_name, p.collection
      FROM products p
      JOIN skus s ON s.product_id = p.id AND s.status = 'active'
      WHERE p.vendor_id = $1 AND p.status = 'active' AND p.category_id = $2
        AND p.display_name NOT LIKE '%Trim & Accessories%'
        AND p.display_name NOT LIKE '%Stair Nose%'
        AND s.vendor_sku ~ 'VRDSNST|VRDSNSX|VSNPSX'
      ORDER BY p.display_name
    `, [vid, tmCat.id]);

    let stairCount = 0;
    for (const p of stairNoseProducts) {
      const newName = p.display_name + ' Stair Nose';
      await client.query(`UPDATE products SET display_name = $2 WHERE id = $1`, [p.id, newName]);
      stairCount++;
    }
    if (stairNoseProducts.length > 0) {
      const collections = [...new Set(stairNoseProducts.map(p => p.collection))];
      collections.forEach(c => log(`"${c}" → "${c} Stair Nose"`,
        stairNoseProducts.filter(p => p.collection === c).length + ' products'));
    }
    log('Total Stair Nose products:', stairCount);

    // ─── Phase 2: Products with trim type in variant_name ───
    console.log('\n=== Phase 2: Products with type in variant_name ===');
    // Find products where ALL variant_names contain a known trim type keyword
    const TYPE_KEYWORDS = [
      { pattern: 'Bullnose', label: 'Bullnose' },
      { pattern: 'Cove Base', label: 'Cove Base' },
      { pattern: 'Step Nose', label: 'Step Nose' },
      { pattern: 'Jolly', label: 'Jolly' },
      { pattern: 'Sanitary', label: 'Sanitary Cove Base' },
      { pattern: 'Radius', label: 'Radius Bullnose' },
    ];

    let phase2Count = 0;
    for (const { pattern, label } of TYPE_KEYWORDS) {
      const { rows: products } = await client.query(`
        SELECT p.id, p.display_name, p.collection
        FROM products p
        WHERE p.vendor_id = $1 AND p.status = 'active' AND p.category_id = $2
          AND p.display_name NOT LIKE '%Trim & Accessories%'
          AND p.display_name NOT LIKE '%Stair Nose%'
          AND p.display_name NOT LIKE '%${label}%'
          AND p.display_name = p.collection
          AND (
            SELECT bool_and(s.variant_name ~ $3)
            FROM skus s WHERE s.product_id = p.id AND s.status = 'active'
          ) = true
        ORDER BY p.display_name
      `, [vid, tmCat.id, pattern]);

      for (const p of products) {
        const newName = p.display_name + ' ' + label;
        await client.query(`UPDATE products SET display_name = $2 WHERE id = $1`, [p.id, newName]);
        log(`"${p.display_name}" → "${newName}"`, '');
        phase2Count++;
      }
    }
    log('Total type-from-variant products:', phase2Count);

    // ─── Phase 3: Products with type detectable from vendor_sku ───
    console.log('\n=== Phase 3: Products with type from vendor_sku ===');
    // Bullnose: vendor_sku contains F9 pattern (P43F9, S44F9, etc.)
    // Cove Base: vendor_sku contains C9 pattern (P43C9, P36C9, etc.)
    // But only where display_name still = collection (not already fixed)
    let phase3Count = 0;

    // Bullnose from vendor_sku (F9 pattern, like Emergent P43F9LP)
    const { rows: f9Products } = await client.query(`
      SELECT DISTINCT p.id, p.display_name
      FROM products p
      JOIN skus s ON s.product_id = p.id AND s.status = 'active'
      WHERE p.vendor_id = $1 AND p.status = 'active' AND p.category_id = $2
        AND p.display_name = p.collection
        AND p.display_name NOT LIKE '%Trim & Accessories%'
        AND p.display_name NOT LIKE '%Bullnose%'
        AND p.display_name NOT LIKE '%Stair Nose%'
        AND s.vendor_sku ~ 'F9[^0-9]'
        AND NOT EXISTS (SELECT 1 FROM skus s2 WHERE s2.product_id = p.id AND s2.status = 'active'
          AND s2.vendor_sku !~ 'F9[^0-9]')
      ORDER BY p.display_name
    `, [vid, tmCat.id]);
    for (const p of f9Products) {
      const newName = p.display_name + ' Bullnose';
      await client.query(`UPDATE products SET display_name = $2 WHERE id = $1`, [p.id, newName]);
      log(`"${p.display_name}" → "${newName}"`, '(vendor_sku F9)');
      phase3Count++;
    }

    // Cove Base from vendor_sku (C9 pattern, like Portfolio P43C91P1)
    // But exclude products that also have F9/bullnose SKUs
    const { rows: c9Products } = await client.query(`
      SELECT DISTINCT p.id, p.display_name
      FROM products p
      JOIN skus s ON s.product_id = p.id AND s.status = 'active'
      WHERE p.vendor_id = $1 AND p.status = 'active' AND p.category_id = $2
        AND p.display_name = p.collection
        AND p.display_name NOT LIKE '%Trim & Accessories%'
        AND p.display_name NOT LIKE '%Cove Base%'
        AND p.display_name NOT LIKE '%Bullnose%'
        AND p.display_name NOT LIKE '%Stair Nose%'
        AND s.vendor_sku ~ 'C9[^0-9]'
        AND NOT EXISTS (SELECT 1 FROM skus s2 WHERE s2.product_id = p.id AND s2.status = 'active'
          AND s2.vendor_sku ~ 'F9[^0-9]')
        AND NOT EXISTS (SELECT 1 FROM skus s2 WHERE s2.product_id = p.id AND s2.status = 'active'
          AND s2.vendor_sku !~ 'C9[^0-9]')
      ORDER BY p.display_name
    `, [vid, tmCat.id]);
    for (const p of c9Products) {
      const newName = p.display_name + ' Cove Base';
      await client.query(`UPDATE products SET display_name = $2 WHERE id = $1`, [p.id, newName]);
      log(`"${p.display_name}" → "${newName}"`, '(vendor_sku C9)');
      phase3Count++;
    }
    log('Total vendor_sku-detected products:', phase3Count);

    // ─── Phase 4: Specific BC / Cove Base fixes ───
    console.log('\n=== Phase 4: Cove Base products (BC variant) ===');
    let phase4Count = 0;
    const { rows: bcProducts } = await client.query(`
      SELECT DISTINCT p.id, p.display_name
      FROM products p
      JOIN skus s ON s.product_id = p.id AND s.status = 'active'
      WHERE p.vendor_id = $1 AND p.status = 'active' AND p.category_id = $2
        AND p.display_name = p.collection
        AND p.display_name NOT LIKE '%Trim & Accessories%'
        AND p.display_name NOT LIKE '%Cove Base%'
        AND (s.variant_name LIKE 'BC%' OR s.variant_name LIKE '%Cove Base%')
        AND NOT EXISTS (
          SELECT 1 FROM skus s2 WHERE s2.product_id = p.id AND s2.status = 'active'
            AND s2.variant_name NOT LIKE 'BC%' AND s2.variant_name NOT LIKE '%Cove Base%'
        )
      ORDER BY p.display_name
    `, [vid, tmCat.id]);
    for (const p of bcProducts) {
      const newName = p.display_name + ' Cove Base';
      await client.query(`UPDATE products SET display_name = $2 WHERE id = $1`, [p.id, newName]);
      log(`"${p.display_name}" → "${newName}"`, '');
      phase4Count++;
    }
    log('Total Cove Base products:', phase4Count);

    // ─── Phase 5: Remaining ambiguous products → "Trim" ───
    console.log('\n=== Phase 5: Remaining mixed-type products → "Trim" ===');
    // Products still in T&M with display_name = collection and no type indicator
    // Skip: Bath Accessories (already descriptive), Outlander per-color (mostly tiles)
    let phase5Count = 0;
    const { rows: remaining } = await client.query(`
      SELECT p.id, p.display_name, p.collection,
        string_agg(DISTINCT s.variant_name, ' | ' ORDER BY s.variant_name) as variants
      FROM products p
      JOIN skus s ON s.product_id = p.id AND s.status = 'active'
      WHERE p.vendor_id = $1 AND p.status = 'active' AND p.category_id = $2
        AND p.display_name NOT LIKE '%Trim & Accessories%'
        AND p.display_name = p.collection
        AND p.collection NOT IN ('Bath Accessories')
      GROUP BY p.id, p.display_name, p.collection
      ORDER BY p.display_name
    `, [vid, tmCat.id]);

    for (const p of remaining) {
      // Detect type from variant_names
      const variants = p.variants;
      let suffix;
      if (variants.match(/Rope/)) {
        suffix = 'Rope Liner';
      } else if (variants.match(/Anthology/)) {
        suffix = 'Decorative Accent';
      } else if (variants.match(/Mosaic|SQ\d/)) {
        suffix = 'Mosaic';
      } else if (variants.match(/Abrasive/)) {
        suffix = 'Anti-Slip';
      } else {
        // Products with color-only variants that are in T&M — add "Trim"
        // But skip Outlander per-color products (mostly field tiles)
        const { rows: skuCheck } = await client.query(`
          SELECT COUNT(*) as cnt FROM skus s
          WHERE s.product_id = $1 AND s.status = 'active'
            AND s.vendor_sku ~ '(1224|2424|2448)(GRD|MED|PAL)'
        `, [p.id]);
        if (parseInt(skuCheck[0].cnt) > 3) {
          // Mostly field tiles (Outlander pattern) — skip
          continue;
        }
        suffix = 'Trim';
      }

      const newName = p.display_name + ' ' + suffix;
      await client.query(`UPDATE products SET display_name = $2 WHERE id = $1`, [p.id, newName]);
      log(`"${p.display_name}" → "${newName}"`, `(${variants.substring(0, 40)})`);
      phase5Count++;
    }
    log('Total remaining products fixed:', phase5Count);

    // ─── Phase 6: Rebuild search vectors ───
    console.log('\n=== Phase 6: Rebuild search vectors ===');
    const { rows: colCheck } = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name='products' AND column_name='search_vector'
    `);
    let svCount = 0;
    if (colCheck.length > 0) {
      const res = await client.query(`
        UPDATE products p
        SET search_vector = to_tsvector('english',
          COALESCE(p.name, '') || ' ' || COALESCE(p.display_name, '') || ' ' || COALESCE(p.collection, '')
        )
        FROM vendors v
        WHERE v.id = p.vendor_id AND v.code = 'DAL'
      `);
      svCount = res.rowCount;
      log('Rebuilt search vectors:', svCount);
    }

    if (DRY_RUN) {
      await client.query('ROLLBACK');
      console.log('\n[DRY RUN] Rolled back.');
    } else {
      await client.query('COMMIT');
      console.log('\n✓ Committed.');
    }

    console.log('\n=== Summary ===');
    log('Stair Nose:', stairCount);
    log('Type-from-variant:', phase2Count);
    log('Vendor_sku-detected:', phase3Count);
    log('Cove Base (BC):', phase4Count);
    log('Remaining (Trim/other):', phase5Count);
    log('Search vectors:', svCount);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('\n✗ Error:', err.message);
    console.error(err.stack);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
