/**
 * Roca USA — Data Cleanup Script
 *
 * Fixes:
 * 1. Delete 11 orphan products with no SKUs
 * 2. Fix doubled words in variant names (e.g., "Bullnose Bullnose")
 * 3. Deduplicate variant names (310 SKUs share names with siblings under same product)
 *    - Color Collection 081/281 pattern → Bright/Matte finish
 *    - All others → letter suffix (A, B, C...)
 * 4. Add Color/Size/Material attributes to 317 accessory SKUs
 * 5. Fix cryptic short product names (Po→Polished, Up→Unpolished, Bl→Blanco, Gr→Gris)
 * 6. Fix accessory product names that duplicate "Bullnose" in the name
 *
 * Usage: node backend/scripts/roca-cleanup.js
 *   (run from host — uses localhost DB)
 */
import pg from 'pg';

const pool = new pg.Pool({
  host: 'localhost', port: 5432, database: 'flooring_pim',
  user: 'postgres', password: 'postgres',
});

const ATTR = {
  color:    'd50e8400-e29b-41d4-a716-446655440001',
  size:     'd50e8400-e29b-41d4-a716-446655440004',
  material: 'd50e8400-e29b-41d4-a716-446655440002',
};

async function run() {
  const client = await pool.connect();
  const vendorRes = await client.query("SELECT id FROM vendors WHERE code = 'ROCA'");
  if (!vendorRes.rows.length) { console.error('ROCA vendor not found'); return; }
  const vendorId = vendorRes.rows[0].id;

  try {
    await client.query('BEGIN');

    // ═══════════════════════════════════════════════════════════
    // 1. Delete orphan products (no SKUs)
    // ═══════════════════════════════════════════════════════════
    const orphans = await client.query(`
      DELETE FROM products p
      USING vendors v
      WHERE p.vendor_id = v.id AND v.code = 'ROCA'
        AND NOT EXISTS (SELECT 1 FROM skus s WHERE s.product_id = p.id)
      RETURNING p.id, p.collection, p.name
    `);
    console.log(`\n1. Deleted ${orphans.rowCount} orphan products (no SKUs):`);
    for (const r of orphans.rows) console.log(`   ${r.collection} / ${r.name}`);

    // ═══════════════════════════════════════════════════════════
    // 2. Fix doubled words in variant names
    // ═══════════════════════════════════════════════════════════
    // "3"x12" Bullnose Bullnose 3X12" → "3"x12" Bullnose 3X12"
    // "Azul 2.5x5 Bullnose 2.5x5 Bullnose 2.5X5" → "Azul Bullnose 2.5X5"

    // Fix St. Tropez pattern: "{Color} 2.5x5 Bullnose 2.5x5 Bullnose 2.5X5"
    // → "{Color} Bullnose 2.5X5"
    const stTropezFix = await client.query(
      `UPDATE skus SET variant_name = regexp_replace(
        variant_name,
        E'(\\\\w+)\\\\s+[\\\\d.]+x[\\\\d.]+\\\\s+Bullnose\\\\s+[\\\\d.]+x[\\\\d.]+\\\\s+Bullnose\\\\s+[\\\\d.]+X[\\\\d.]+',
        E'\\\\1 Bullnose 2.5X5'
      )
      WHERE id IN (
        SELECT s.id FROM skus s
        JOIN products p ON s.product_id = p.id
        JOIN vendors v ON p.vendor_id = v.id
        WHERE v.code = 'ROCA' AND s.variant_name LIKE '%Bullnose%Bullnose%'
        AND p.collection = 'St. Tropez'
      )
      AND variant_name LIKE '%Bullnose%Bullnose%'
      RETURNING id, variant_name`
    );

    // Fix Calacata Gold pattern: '3"x12" Bullnose Bullnose 3X12' → 'Bullnose 3X12'
    const calacataFix = await client.query(
      `UPDATE skus SET variant_name = regexp_replace(
        variant_name,
        E'^[\\\\d\\\\"x]+\\\\s+Bullnose\\\\s+Bullnose\\\\s+',
        'Bullnose '
      )
      WHERE id IN (
        SELECT s.id FROM skus s
        JOIN products p ON s.product_id = p.id
        JOIN vendors v ON p.vendor_id = v.id
        WHERE v.code = 'ROCA' AND s.variant_name LIKE '%Bullnose%Bullnose%'
        AND p.collection = 'Calacata Gold'
      )
      AND variant_name LIKE '%Bullnose%Bullnose%'
      RETURNING id, variant_name`
    );

    console.log(`\n2. Fixed doubled Bullnose: ${stTropezFix.rowCount + calacataFix.rowCount} variant names`);

    // ═══════════════════════════════════════════════════════════
    // 3. Fix bad product names that have size prefix before type
    // ═══════════════════════════════════════════════════════════
    // '3"x12" Bullnose' → 'Bullnose 3x12' (move size to end, strip quotes)
    // '6"x18" Bullnose' → 'Bullnose 6x18'
    const badNameProducts = await client.query(`
      SELECT id, name FROM products
      WHERE vendor_id = $1
        AND name ~ '^\\d+"?x\\d+"?\\s+'
    `, [vendorId]);

    let nameFixCount3 = 0;
    for (const p of badNameProducts.rows) {
      const match = p.name.match(/^([\d"x]+)\s+(.+)$/);
      if (match) {
        const size = match[1].replace(/"/g, '');
        const type = match[2];
        const newName = `${type} ${size}`;
        await client.query('UPDATE products SET name = $1 WHERE id = $2', [newName, p.id]);
        // Also fix variant names for SKUs under this product
        await client.query(`
          UPDATE skus SET variant_name = regexp_replace(variant_name, $1, $2)
          WHERE product_id = $3 AND variant_name LIKE $4
        `, [p.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), newName, p.id, `%${p.name}%`]);
        nameFixCount3++;
      }
    }
    console.log(`\n3. Fixed ${nameFixCount3} products with size-prefixed names`);

    // ═══════════════════════════════════════════════════════════
    // 4. Expand cryptic short product names
    // ═══════════════════════════════════════════════════════════
    const nameExpansions = [
      // Finish abbreviations (Po/Up are always finishes)
      ['Po', 'Polished'],
      ['Up', 'Unpolished'],
      // Short color abbreviations in specific collections
    ];

    let nameFixCount = 0;
    for (const [abbr, full] of nameExpansions) {
      const res = await client.query(`
        UPDATE products SET name = $2
        WHERE vendor_id = $1 AND name = $3
        RETURNING id, collection, name
      `, [vendorId, full, abbr]);
      nameFixCount += res.rowCount;
      for (const r of res.rows) console.log(`   ${r.collection}: "${abbr}" → "${full}"`);
    }

    // Also fix variant names that reference these products
    // Update variant_names starting with "Po " or "Up "
    const varNamePoFix = await client.query(`
      UPDATE skus SET variant_name = 'Polished' || substring(variant_name from 3)
      WHERE product_id IN (
        SELECT p.id FROM products p WHERE p.vendor_id = $1 AND p.name = 'Polished'
      ) AND variant_name LIKE 'Po %'
    `, [vendorId]);
    const varNameUpFix = await client.query(`
      UPDATE skus SET variant_name = 'Unpolished' || substring(variant_name from 3)
      WHERE product_id IN (
        SELECT p.id FROM products p WHERE p.vendor_id = $1 AND p.name = 'Unpolished'
      ) AND variant_name LIKE 'Up %'
    `, [vendorId]);

    console.log(`\n4. Expanded ${nameFixCount} short product names, updated ${varNamePoFix.rowCount + varNameUpFix.rowCount} variant names`);

    // ═══════════════════════════════════════════════════════════
    // 5. Deduplicate variant names within same product
    // ═══════════════════════════════════════════════════════════
    // Find all duplicate groups
    const dupeGroups = await client.query(`
      SELECT p.id as product_id, p.collection, p.name as product_name,
             s.variant_name, count(*) as cnt,
             array_agg(s.id ORDER BY s.vendor_sku) as sku_ids,
             array_agg(s.vendor_sku ORDER BY s.vendor_sku) as vendor_skus,
             array_agg(pr.cost ORDER BY s.vendor_sku) as costs
      FROM skus s
      JOIN products p ON s.product_id = p.id
      JOIN vendors v ON p.vendor_id = v.id
      JOIN pricing pr ON pr.sku_id = s.id
      WHERE v.code = 'ROCA'
      GROUP BY p.id, p.collection, p.name, s.variant_name
      HAVING count(*) > 1
      ORDER BY p.collection, p.name, s.variant_name
    `);

    let deduped = 0;
    for (const group of dupeGroups.rows) {
      const skuIds = group.sku_ids;
      const vendorSkus = group.vendor_skus;
      const costs = group.costs.map(c => parseFloat(c));

      // Strategy: detect if this is a Bright/Matte pair (081/281 pattern)
      const isBrightMatte = vendorSkus.length === 2 &&
        vendorSkus.some(v => /^U?0\d{2}/.test(v)) &&
        vendorSkus.some(v => /^U?2\d{2}/.test(v)) &&
        costs[0] === costs[1];

      if (isBrightMatte) {
        // Label as Bright/Matte based on vendor_sku prefix
        for (let i = 0; i < skuIds.length; i++) {
          const finish = /^U?0\d{2}/.test(vendorSkus[i]) ? 'Bright' : 'Matte';
          const newName = group.variant_name.replace(/^(\S+)/, `$1 (${finish})`);
          await client.query('UPDATE skus SET variant_name = $1 WHERE id = $2', [newName, skuIds[i]]);
          deduped++;
        }
      } else {
        // General case: append letter suffix (A, B, C...)
        for (let i = 0; i < skuIds.length; i++) {
          const suffix = String.fromCharCode(65 + i); // A, B, C...
          const newName = `${group.variant_name} (${suffix})`;
          await client.query('UPDATE skus SET variant_name = $1 WHERE id = $2', [newName, skuIds[i]]);
          deduped++;
        }
      }
    }
    console.log(`\n5. Deduplicated ${deduped} variant names across ${dupeGroups.rowCount} groups`);

    // ═══════════════════════════════════════════════════════════
    // 6. Add attributes to accessory SKUs that are missing them
    // ═══════════════════════════════════════════════════════════
    const accessorySkus = await client.query(`
      SELECT s.id as sku_id, p.name as product_name, p.collection,
             s.variant_name, p.category_id
      FROM skus s
      JOIN products p ON s.product_id = p.id
      JOIN vendors v ON p.vendor_id = v.id
      LEFT JOIN sku_attributes sa ON sa.sku_id = s.id
      WHERE v.code = 'ROCA' AND sa.sku_id IS NULL
      ORDER BY p.collection, p.name
    `);

    // Get the material for each collection (from a sibling SKU that has it)
    const materialMap = new Map();
    const matRes = await client.query(`
      SELECT DISTINCT p.collection, sa.value
      FROM sku_attributes sa
      JOIN skus s ON sa.sku_id = s.id
      JOIN products p ON s.product_id = p.id
      JOIN vendors v ON p.vendor_id = v.id
      WHERE v.code = 'ROCA' AND sa.attribute_id = $1
    `, [ATTR.material]);
    for (const r of matRes.rows) materialMap.set(r.collection, r.value);

    let attrCount = 0;
    for (const sku of accessorySkus.rows) {
      // Color = product name (e.g., "White Ice", "Blanco")
      const color = sku.product_name;
      if (color) {
        await client.query(`
          INSERT INTO sku_attributes (sku_id, attribute_id, value)
          VALUES ($1, $2, $3)
          ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value = EXCLUDED.value
        `, [sku.sku_id, ATTR.color, color]);
        attrCount++;
      }

      // Size = extract from variant_name (e.g., "White Ice Bullnose 3X12" → "3X12")
      const sizeMatch = sku.variant_name.match(/(\d[\d\s\/]*[xX][\d\s\/]+)/);
      if (sizeMatch) {
        await client.query(`
          INSERT INTO sku_attributes (sku_id, attribute_id, value)
          VALUES ($1, $2, $3)
          ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value = EXCLUDED.value
        `, [sku.sku_id, ATTR.size, sizeMatch[1].trim()]);
        attrCount++;
      }

      // Material = from sibling in same collection
      const material = materialMap.get(sku.collection);
      if (material) {
        await client.query(`
          INSERT INTO sku_attributes (sku_id, attribute_id, value)
          VALUES ($1, $2, $3)
          ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value = EXCLUDED.value
        `, [sku.sku_id, ATTR.material, material]);
        attrCount++;
      }
    }
    console.log(`\n6. Added ${attrCount} attributes to ${accessorySkus.rowCount} accessory SKUs`);

    await client.query('COMMIT');

    // ═══════════════════════════════════════════════════════════
    // Post-cleanup verification
    // ═══════════════════════════════════════════════════════════
    console.log('\n═══ Post-cleanup verification ═══');

    const verify = await client.query(`
      SELECT
        (SELECT count(*) FROM products p JOIN vendors v ON p.vendor_id = v.id WHERE v.code = 'ROCA') as products,
        (SELECT count(*) FROM skus s JOIN products p ON s.product_id = p.id JOIN vendors v ON p.vendor_id = v.id WHERE v.code = 'ROCA') as skus,
        (SELECT count(*) FROM products p JOIN vendors v ON p.vendor_id = v.id LEFT JOIN skus s ON s.product_id = p.id WHERE v.code = 'ROCA' AND s.id IS NULL) as orphan_products,
        (SELECT count(*) FROM (
          SELECT p.id, s.variant_name FROM skus s JOIN products p ON s.product_id = p.id JOIN vendors v ON p.vendor_id = v.id
          WHERE v.code = 'ROCA' GROUP BY p.id, s.variant_name HAVING count(*) > 1
        ) x) as duplicate_variant_groups,
        (SELECT count(*) FROM skus s JOIN products p ON s.product_id = p.id JOIN vendors v ON p.vendor_id = v.id
         LEFT JOIN sku_attributes sa ON sa.sku_id = s.id WHERE v.code = 'ROCA' AND sa.sku_id IS NULL) as skus_no_attrs,
        (SELECT count(*) FROM skus s JOIN products p ON s.product_id = p.id JOIN vendors v ON p.vendor_id = v.id
         WHERE v.code = 'ROCA' AND s.variant_name LIKE '%Bullnose%Bullnose%') as doubled_bullnose,
        (SELECT count(*) FROM products p JOIN vendors v ON p.vendor_id = v.id WHERE v.code = 'ROCA' AND length(p.name) <= 2) as short_names
    `);
    const v = verify.rows[0];
    console.log(`Products:              ${v.products}`);
    console.log(`SKUs:                  ${v.skus}`);
    console.log(`Orphan products:       ${v.orphan_products} (should be 0)`);
    console.log(`Duplicate var groups:  ${v.duplicate_variant_groups} (should be 0)`);
    console.log(`SKUs without attrs:    ${v.skus_no_attrs} (should be 0)`);
    console.log(`Doubled Bullnose:      ${v.doubled_bullnose} (should be 0)`);
    console.log(`Short names (<=2):     ${v.short_names} (should be 0)`);

  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch(err => { console.error(err); process.exit(1); });
