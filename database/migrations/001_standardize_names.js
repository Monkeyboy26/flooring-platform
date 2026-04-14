/**
 * Migration: Standardize product naming convention
 *
 * Changes:
 *   1. Schema: collection NOT NULL DEFAULT '', new unique constraint
 *   2. Daltile/AO/Marazzi: Strip collection prefix from name
 *   3. Elysium: Strip collection prefix + trailing finish from name, prepend finish to variant
 *   4. Arizona Tile: Set collection = current name, set name = color from sku_attributes
 *   5. Bedrosians: Parse color from verbose name, enrich variant
 *   6. MSI: Strip material suffix from name
 *
 * Usage:
 *   DRY_RUN=1 node database/migrations/001_standardize_names.js   # preview changes
 *   node database/migrations/001_standardize_names.js              # apply changes
 *
 * Requires DATABASE_URL env var or runs against default local PG.
 */

import pg from 'pg';
const { Pool } = pg;

const DRY_RUN = process.env.DRY_RUN === '1';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/flooring_pim',
});

// ─── Helpers ──────────────────────────────────────────────────────────────

function deslugify(slug) {
  if (!slug) return '';
  return slug
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())
    .trim();
}

function normalizeSize(raw) {
  if (!raw) return '';
  return raw
    .replace(/["″'']/g, '')
    .replace(/\s*[xX×]\s*/g, 'x')
    .trim();
}

function buildVariantName(size, ...qualifiers) {
  const parts = [normalizeSize(size), ...qualifiers].filter(Boolean);
  return parts.join(', ') || null;
}

const FINISH_WORDS = ['Matte', 'Polished', 'Honed', 'Glossy', 'Satin', 'Textured', 'Natural', 'Lappato', 'Brushed', 'Tumbled', 'Grip', 'Soft', 'Structured', 'Lux'];
const FINISH_SUFFIX_RE = new RegExp(`\\s+(${FINISH_WORDS.join('|')})\\s*$`, 'i');

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─── Schema Migration ──────────────────────────────────────────────────

async function migrateSchema(client) {
  console.log('\n=== Schema Migration ===');

  // 1. Fill NULLs
  const nullCount = await client.query(
    `SELECT COUNT(*) FROM products WHERE collection IS NULL`
  );
  console.log(`Products with NULL collection: ${nullCount.rows[0].count}`);

  if (!DRY_RUN) {
    await client.query(`UPDATE products SET collection = '' WHERE collection IS NULL`);
  }

  // 2. ALTER column
  if (!DRY_RUN) {
    await client.query(`ALTER TABLE products ALTER COLUMN collection SET NOT NULL`);
    await client.query(`ALTER TABLE products ALTER COLUMN collection SET DEFAULT ''`);
  }
  console.log('Set collection NOT NULL DEFAULT \'\'');

  // 3. Check for uniqueness violations before swapping constraint
  const violations = await client.query(`
    SELECT vendor_id, collection, name, COUNT(*) as cnt
    FROM products
    GROUP BY vendor_id, collection, name
    HAVING COUNT(*) > 1
  `);
  if (violations.rows.length > 0) {
    console.log(`WARNING: ${violations.rows.length} uniqueness violations on (vendor_id, collection, name):`);
    for (const row of violations.rows.slice(0, 10)) {
      console.log(`  vendor=${row.vendor_id}, collection="${row.collection}", name="${row.name}" (${row.cnt} rows)`);
    }
    if (!DRY_RUN) {
      console.log('Aborting constraint swap due to violations. Fix data first.');
      return false;
    }
  }

  // 4. Swap constraint
  if (!DRY_RUN) {
    await client.query(`ALTER TABLE products DROP CONSTRAINT IF EXISTS products_vendor_name_unique`);
    await client.query(`
      ALTER TABLE products ADD CONSTRAINT products_vendor_collection_name_unique
      UNIQUE (vendor_id, collection, name)
    `);
    console.log('Constraint swapped: products_vendor_name_unique → products_vendor_collection_name_unique');
  }

  return true;
}

// ─── Daltile / AO / Marazzi ──────────────────────────────────────────────

async function migrateDaltile(client) {
  console.log('\n=== Daltile / AO / Marazzi ===');

  // Find vendor IDs
  const vendors = await client.query(
    `SELECT id, name FROM vendors WHERE code IN ('DAL', 'AO', 'MZ')`
  );
  if (vendors.rows.length === 0) {
    console.log('No Daltile/AO/Marazzi vendors found, skipping.');
    return;
  }
  const vendorIds = vendors.rows.map(r => r.id);
  console.log(`Vendors: ${vendors.rows.map(r => `${r.name} (${r.id})`).join(', ')}`);

  // Strip collection prefix from name where name starts with collection + space
  const candidates = await client.query(`
    SELECT id, name, collection
    FROM products
    WHERE vendor_id = ANY($1)
      AND collection IS NOT NULL
      AND collection != ''
      AND name LIKE collection || ' %'
  `, [vendorIds]);

  console.log(`Products with collection prefix in name: ${candidates.rows.length}`);

  let updated = 0;
  for (const row of candidates.rows) {
    const newName = row.name.slice(row.collection.length + 1).trim();
    if (!newName) continue;

    // Check for collision: would new name + collection conflict with existing product?
    const conflict = await client.query(`
      SELECT id FROM products
      WHERE vendor_id = (SELECT vendor_id FROM products WHERE id = $1)
        AND collection = $2 AND name = $3 AND id != $1
    `, [row.id, row.collection, newName]);

    if (conflict.rows.length > 0) {
      console.log(`  SKIP collision: "${row.name}" → "${newName}" (collection="${row.collection}")`);
      continue;
    }

    if (DRY_RUN) {
      if (updated < 5) console.log(`  "${row.name}" → "${newName}" (collection="${row.collection}")`);
    } else {
      await client.query(`UPDATE products SET name = $2 WHERE id = $1`, [row.id, newName]);
    }
    updated++;
  }
  console.log(`${DRY_RUN ? 'Would update' : 'Updated'}: ${updated} products`);
}

// ─── Elysium ──────────────────────────────────────────────────────────────

async function migrateElysium(client) {
  console.log('\n=== Elysium ===');

  const vendor = await client.query(`SELECT id FROM vendors WHERE code = 'ELY'`);
  if (vendor.rows.length === 0) {
    console.log('No Elysium vendor found, skipping.');
    return;
  }
  const vendorId = vendor.rows[0].id;

  const products = await client.query(`
    SELECT id, name, collection FROM products WHERE vendor_id = $1
  `, [vendorId]);

  console.log(`Total Elysium products: ${products.rows.length}`);

  let updated = 0;
  for (const row of products.rows) {
    let name = row.name;
    const collection = row.collection || '';

    // Strip collection prefix (case-insensitive)
    if (collection) {
      const re = new RegExp(`^${escapeRegex(collection)}\\s+`, 'i');
      name = name.replace(re, '');
    }

    // Extract trailing finish
    let extractedFinish = null;
    const finishMatch = name.match(FINISH_SUFFIX_RE);
    if (finishMatch) {
      extractedFinish = finishMatch[1].charAt(0).toUpperCase() + finishMatch[1].slice(1).toLowerCase();
      name = name.slice(0, name.length - finishMatch[0].length).trim();
    }

    if (name === row.name && !extractedFinish) continue; // No change

    // Check for collision
    const conflict = await client.query(`
      SELECT id FROM products
      WHERE vendor_id = $1 AND collection = $2 AND name = $3 AND id != $4
    `, [vendorId, collection, name, row.id]);

    if (conflict.rows.length > 0) {
      console.log(`  SKIP collision: "${row.name}" → "${name}" (collection="${collection}")`);
      continue;
    }

    if (DRY_RUN) {
      if (updated < 5) console.log(`  "${row.name}" → "${name}" (collection="${collection}", finish="${extractedFinish}")`);
    } else {
      await client.query(`UPDATE products SET name = $2 WHERE id = $1`, [row.id, name]);
    }

    // Prepend finish to variant_name for all SKUs of this product
    if (extractedFinish) {
      const skus = await client.query(
        `SELECT id, variant_name FROM skus WHERE product_id = $1`,
        [row.id]
      );
      for (const sku of skus.rows) {
        const newVariant = buildVariantName(sku.variant_name, extractedFinish);
        if (newVariant && newVariant !== sku.variant_name) {
          if (!DRY_RUN) {
            await client.query(`UPDATE skus SET variant_name = $2 WHERE id = $1`, [sku.id, newVariant]);
          }
        }
      }
    }

    updated++;
  }
  console.log(`${DRY_RUN ? 'Would update' : 'Updated'}: ${updated} products`);
}

// ─── Arizona Tile ──────────────────────────────────────────────────────────

async function migrateArizona(client) {
  console.log('\n=== Arizona Tile ===');

  const vendor = await client.query(`SELECT id FROM vendors WHERE code = 'AZT'`);
  if (vendor.rows.length === 0) {
    console.log('No Arizona Tile vendor found, skipping.');
    return;
  }
  const vendorId = vendor.rows[0].id;

  // Get color attribute ID
  const colorAttr = await client.query(`SELECT id FROM attributes WHERE slug = 'color'`);
  if (colorAttr.rows.length === 0) {
    console.log('No color attribute found, skipping.');
    return;
  }
  const colorAttrId = colorAttr.rows[0].id;

  const products = await client.query(`
    SELECT p.id, p.name, p.collection
    FROM products p
    WHERE p.vendor_id = $1
  `, [vendorId]);

  console.log(`Total Arizona Tile products: ${products.rows.length}`);

  let updated = 0;
  for (const row of products.rows) {
    // Current name IS the collection (e.g., "3D")
    const newCollection = row.name;

    // Get color from first SKU's color attribute
    const colorResult = await client.query(`
      SELECT sa.value FROM sku_attributes sa
      JOIN skus s ON s.id = sa.sku_id
      WHERE s.product_id = $1 AND sa.attribute_id = $2
      LIMIT 1
    `, [row.id, colorAttrId]);

    if (colorResult.rows.length === 0) continue; // No color attribute, skip

    const newName = deslugify(colorResult.rows[0].value);
    if (!newName) continue;

    // Check collision
    const conflict = await client.query(`
      SELECT id FROM products
      WHERE vendor_id = $1 AND collection = $2 AND name = $3 AND id != $4
    `, [vendorId, newCollection, newName, row.id]);

    if (conflict.rows.length > 0) {
      console.log(`  SKIP collision: "${row.name}" → name="${newName}", collection="${newCollection}"`);
      continue;
    }

    if (DRY_RUN) {
      if (updated < 5) console.log(`  "${row.name}" → name="${newName}", collection="${newCollection}"`);
    } else {
      await client.query(
        `UPDATE products SET name = $2, collection = $3 WHERE id = $1`,
        [row.id, newName, newCollection]
      );
    }

    // Clean variant names: strip color prefix, deslugify
    const skus = await client.query(`SELECT id, variant_name FROM skus WHERE product_id = $1`, [row.id]);
    for (const sku of skus.rows) {
      if (!sku.variant_name) continue;
      let cleaned = sku.variant_name;
      // Strip color prefix (e.g., "white-ribbon / 12-x-22" → "12-x-22")
      const colorSlug = colorResult.rows[0].value.toLowerCase();
      cleaned = cleaned.replace(new RegExp(`^${escapeRegex(colorSlug)}\\s*/\\s*`, 'i'), '');
      // Deslugify remainder
      cleaned = deslugify(cleaned);
      // Normalize size
      cleaned = cleaned.replace(/(\d+)\s*[xX]\s*(\d+)/g, '$1x$2');
      if (cleaned !== sku.variant_name) {
        if (!DRY_RUN) {
          await client.query(`UPDATE skus SET variant_name = $2 WHERE id = $1`, [sku.id, cleaned]);
        }
      }
    }

    updated++;
  }
  console.log(`${DRY_RUN ? 'Would update' : 'Updated'}: ${updated} products`);
}

// ─── Bedrosians ──────────────────────────────────────────────────────────

async function migrateBedrosians(client) {
  console.log('\n=== Bedrosians ===');

  const vendor = await client.query(`SELECT id FROM vendors WHERE code = 'BED'`);
  if (vendor.rows.length === 0) {
    console.log('No Bedrosians vendor found, skipping.');
    return;
  }
  const vendorId = vendor.rows[0].id;

  const products = await client.query(`
    SELECT id, name, collection FROM products WHERE vendor_id = $1
  `, [vendorId]);

  console.log(`Total Bedrosians products: ${products.rows.length}`);

  let updated = 0;
  for (const row of products.rows) {
    const rawName = row.name;

    // Extract color from "... in {Color}" at the end
    const colorMatch = rawName.match(/\bin\s+([A-Z][^"]*?)$/i);
    if (!colorMatch) continue; // Can't parse — leave as-is

    const newName = colorMatch[1].trim();
    if (!newName || newName === rawName) continue;

    // Check collision
    const conflict = await client.query(`
      SELECT id FROM products
      WHERE vendor_id = $1 AND collection = $2 AND name = $3 AND id != $4
    `, [vendorId, row.collection || '', newName, row.id]);

    if (conflict.rows.length > 0) {
      console.log(`  SKIP collision: "${rawName}" → "${newName}" (collection="${row.collection}")`);
      continue;
    }

    if (DRY_RUN) {
      if (updated < 5) console.log(`  "${rawName}" → "${newName}" (collection="${row.collection}")`);
    } else {
      await client.query(`UPDATE products SET name = $2 WHERE id = $1`, [row.id, newName]);
    }

    // Enrich variant_name with size + finish + shape from the verbose name
    const sizeMatch = rawName.match(/(\d+\.?\d*)\s*"?\s*[xX×]\s*(\d+\.?\d*)\s*"?/);
    const finishMatch = rawName.match(/\b(Matte|Polished|Honed|Glossy|Satin|Textured|Natural|Lappato|Brushed|Tumbled)\b/i);
    const shapeMatch = rawName.match(/\b(Field Tile|Mosaic|Bullnose|Quarter Round|Pencil Liner|Wall Tile|Floor Tile|Subway Tile|Hexagon|Herringbone|Deco(?:rative)?|Listello|Chair Rail|Trim|Cove Base)\b/i);

    const size = sizeMatch ? normalizeSize(sizeMatch[0]) : null;
    const finish = finishMatch ? finishMatch[1].charAt(0).toUpperCase() + finishMatch[1].slice(1).toLowerCase() : null;
    const shape = shapeMatch ? shapeMatch[1] : null;
    const enrichedVariant = buildVariantName(size, finish, shape);

    if (enrichedVariant) {
      const skus = await client.query(`SELECT id, variant_name FROM skus WHERE product_id = $1`, [row.id]);
      for (const sku of skus.rows) {
        // Only update if current variant is less descriptive (size-only or null)
        if (!sku.variant_name || /^\d+[x×]\d+$/i.test(sku.variant_name) || /^\d+"\s*[x×]\s*\d+"?$/.test(sku.variant_name)) {
          if (!DRY_RUN) {
            await client.query(`UPDATE skus SET variant_name = $2 WHERE id = $1`, [sku.id, enrichedVariant]);
          }
        }
      }
    }

    updated++;
  }
  console.log(`${DRY_RUN ? 'Would update' : 'Updated'}: ${updated} products`);
}

// ─── MSI ──────────────────────────────────────────────────────────────────

async function migrateMSI(client) {
  console.log('\n=== MSI ===');

  const vendor = await client.query(`SELECT id FROM vendors WHERE code = 'MSI'`);
  if (vendor.rows.length === 0) {
    console.log('No MSI vendor found, skipping.');
    return;
  }
  const vendorId = vendor.rows[0].id;

  const MATERIAL_SUFFIX_RE = /\s+(Porcelain|Ceramic|Marble|Granite|Travertine|Quartzite|Limestone|Slate|Sandstone|Onyx|Basalt)\s+(Tile|Plank|Flooring|Slab|Stone)s?\s*$/i;
  const MATERIAL_ONLY_RE = /\s+(Porcelain|Ceramic|Marble|Granite|Travertine|Quartzite|Limestone|Slate|Sandstone|Onyx|Basalt)\s*$/i;
  const VINYL_SUFFIX_RE = /\s+(Luxury Vinyl Plank|Luxury Vinyl Tile|Luxury Vinyl|Vinyl Plank|Vinyl Tile|Vinyl Flooring|Wood Look Tile)\s*$/i;
  const COLLECTION_SUFFIX_RE = /\s+(Collection|Series)\s*$/i;

  const products = await client.query(`
    SELECT id, name, collection FROM products WHERE vendor_id = $1
  `, [vendorId]);

  console.log(`Total MSI products: ${products.rows.length}`);

  let updated = 0;
  for (const row of products.rows) {
    let newName = row.name
      .replace(MATERIAL_SUFFIX_RE, '')
      .replace(MATERIAL_ONLY_RE, '')
      .replace(VINYL_SUFFIX_RE, '')
      .replace(COLLECTION_SUFFIX_RE, '')
      .trim();

    if (newName === row.name) continue;

    const conflict = await client.query(`
      SELECT id FROM products
      WHERE vendor_id = $1 AND collection = $2 AND name = $3 AND id != $4
    `, [vendorId, row.collection || '', newName, row.id]);

    if (conflict.rows.length > 0) {
      console.log(`  SKIP collision: "${row.name}" → "${newName}"`);
      continue;
    }

    if (DRY_RUN) {
      if (updated < 5) console.log(`  "${row.name}" → "${newName}"`);
    } else {
      await client.query(`UPDATE products SET name = $2 WHERE id = $1`, [row.id, newName]);
    }
    updated++;
  }
  console.log(`${DRY_RUN ? 'Would update' : 'Updated'}: ${updated} products`);
}

// ─── Verification ──────────────────────────────────────────────────────────

async function verify(client) {
  console.log('\n=== Verification ===');

  // Product counts per vendor
  const counts = await client.query(`
    SELECT v.name, COUNT(p.id) as product_count, COUNT(DISTINCT s.id) as sku_count
    FROM vendors v
    LEFT JOIN products p ON p.vendor_id = v.id
    LEFT JOIN skus s ON s.product_id = p.id
    GROUP BY v.name
    ORDER BY product_count DESC
  `);
  console.log('\nProduct/SKU counts by vendor:');
  for (const row of counts.rows) {
    if (row.product_count > 0) {
      console.log(`  ${row.name}: ${row.product_count} products, ${row.sku_count} SKUs`);
    }
  }

  // Check for orphaned SKUs (product_id references a non-existent product)
  const orphans = await client.query(`
    SELECT COUNT(*) FROM skus s
    LEFT JOIN products p ON p.id = s.product_id
    WHERE p.id IS NULL
  `);
  console.log(`\nOrphaned SKUs: ${orphans.rows[0].count}`);

  // Check uniqueness on new constraint
  const dupes = await client.query(`
    SELECT vendor_id, collection, name, COUNT(*) as cnt
    FROM products
    GROUP BY vendor_id, collection, name
    HAVING COUNT(*) > 1
  `);
  console.log(`Duplicate (vendor_id, collection, name) groups: ${dupes.rows.length}`);
  for (const row of dupes.rows.slice(0, 5)) {
    console.log(`  vendor=${row.vendor_id}, collection="${row.collection}", name="${row.name}" (${row.cnt})`);
  }
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN (no changes)' : 'LIVE (applying changes)'}`);

  const client = await pool.connect();
  try {
    if (!DRY_RUN) await client.query('BEGIN');

    // Step 1: Data transforms (before schema change to avoid constraint issues)
    await migrateDaltile(client);
    await migrateElysium(client);
    await migrateArizona(client);
    await migrateBedrosians(client);
    await migrateMSI(client);

    // Step 2: Schema migration (constraint swap)
    const schemaOk = await migrateSchema(client);
    if (!schemaOk && !DRY_RUN) {
      await client.query('ROLLBACK');
      console.log('\nMigration ROLLED BACK due to schema issues.');
      return;
    }

    // Step 3: Verify
    await verify(client);

    if (!DRY_RUN) {
      await client.query('COMMIT');
      console.log('\nMigration COMMITTED successfully.');
    } else {
      console.log('\nDry run complete. No changes made.');
    }
  } catch (err) {
    if (!DRY_RUN) await client.query('ROLLBACK');
    console.error('\nMigration FAILED:', err.message);
    console.error(err.stack);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
