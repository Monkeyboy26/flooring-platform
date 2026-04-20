#!/usr/bin/env node
/**
 * Fix Daltile Product Info
 *
 * 1. Clean Color attribute values — strip embedded finish names
 * 2. Backfill category_id from collection siblings
 * 3. Generate display_name for all products missing one
 * 4. Insert color into existing display_names that lack it
 * 5. Deactivate empty product shells (0 SKUs)
 *
 * Usage:
 *   node backend/scripts/fix-daltile-product-info.cjs --dry-run   # Preview
 *   node backend/scripts/fix-daltile-product-info.cjs              # Execute
 */

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/flooring_pim',
});

const DRY_RUN = process.argv.includes('--dry-run');

// Finish terms to strip from color values
const FINISH_TERMS = [
  'Matte', 'Glossy', 'Polished', 'Honed', 'Textured', 'Tumbled',
  'Lappato', 'Structured', 'Satin Polished', 'Light Polished',
  'Superguardx Technology', 'Superguard Technology',
  'Enhanced Urethane',
];

const finishPattern = FINISH_TERMS.map(t => t.replace(/\s+/g, '\\s+')).join('|');
const leadingFinishRe = new RegExp(`^(${finishPattern})\\s+`, 'i');
const trailingFinishRe = new RegExp(`\\s+(${finishPattern})$`, 'i');
const wrappedFinishRe = new RegExp(`^(${finishPattern})\\s+(.+?)\\s+(${finishPattern})$`, 'i');
const trailingSkuCodeRe = /\s+[A-Z0-9]{8,}$/;

function cleanColorValue(raw) {
  if (!raw) return null;
  let v = raw.trim();
  const wrapped = v.match(wrappedFinishRe);
  if (wrapped) {
    v = wrapped[2].trim();
  } else {
    v = v.replace(trailingSkuCodeRe, '').trim();
    v = v.replace(trailingFinishRe, '').trim();
    v = v.replace(leadingFinishRe, '').trim();
  }
  if (!v || v.length <= 1) return null;
  return v;
}

// Category slug → display-friendly suffix for display_name
const CATEGORY_DISPLAY = {
  'porcelain-tile': 'Porcelain Tile',
  'ceramic-tile': 'Ceramic Tile',
  'backsplash-tile': 'Backsplash Tile',
  'mosaic-tile': 'Mosaic Tile',
  'natural-stone': 'Natural Stone',
  'lvp-plank': 'Luxury Vinyl Plank',
  'transitions-moldings': 'Molding',
  'quartz-countertops': 'Quartz Slab',
  'porcelain-slabs': 'Porcelain Slab',
  'granite-countertops': 'Granite Countertop',
  'marble-countertops': 'Marble Countertop',
  'quartzite-countertops': 'Quartzite Countertop',
  'tile': 'Tile',
  'hardscaping': 'Hardscaping',
  'pool-tile': 'Pool Tile',
  'large-format-tile': 'Large Format Tile',
  'stacked-stone': 'Stacked Stone',
  'wood-look-tile': 'Wood Look Tile',
  'fluted-tile': 'Fluted Tile',
  'commercial-tile': 'Commercial Tile',
};

async function main() {
  const client = await pool.connect();
  console.log(`\n=== Daltile Product Info Fix (${DRY_RUN ? 'DRY RUN' : 'LIVE'}) ===\n`);

  try {
    await client.query('BEGIN');

    // ─── Step 1: Clean Color attribute values ────────────────────────────

    console.log('--- Step 1: Clean Color attribute values ---');

    const colorAttrId = await client.query(`SELECT id FROM attributes WHERE slug = 'color'`);
    if (colorAttrId.rows.length === 0) { console.log('ERROR: Color attribute not found'); return; }
    const colorId = colorAttrId.rows[0].id;

    const dirtyColors = await client.query(`
      SELECT sa.sku_id, sa.attribute_id, sa.value
      FROM sku_attributes sa
      JOIN skus s ON s.id = sa.sku_id
      JOIN products p ON p.id = s.product_id
      JOIN vendors v ON v.id = p.vendor_id
      WHERE v.code = 'DAL'
        AND sa.attribute_id = $1
        AND (sa.value ~* '^(Matte|Glossy|Polished|Honed|Textured)\\s+'
          OR sa.value ~* '\\s+(Matte|Glossy|Polished|Honed|Textured|Superguardx Technology)$')
    `, [colorId]);

    let colorsCleaned = 0;
    for (const row of dirtyColors.rows) {
      const cleaned = cleanColorValue(row.value);
      if (!cleaned || cleaned === row.value) continue;
      if (!DRY_RUN) {
        await client.query(`UPDATE sku_attributes SET value = $1 WHERE sku_id = $2 AND attribute_id = $3`,
          [cleaned, row.sku_id, row.attribute_id]);
      }
      colorsCleaned++;
    }
    console.log(`Colors cleaned: ${colorsCleaned}\n`);

    // ─── Step 2: Backfill category from collection siblings ──────────────

    console.log('--- Step 2: Backfill category from collection siblings ---');

    // For each collection, find the most common non-trim category from siblings
    const collectionCats = await client.query(`
      SELECT p2.collection, p2.category_id as cat_id, COUNT(*) as cnt
      FROM products p2
      JOIN vendors v2 ON v2.id = p2.vendor_id
      JOIN categories c2 ON c2.id = p2.category_id
      WHERE v2.code = 'DAL' AND p2.status = 'active' AND p2.category_id IS NOT NULL
        AND p2.name NOT LIKE '%Trim%' AND c2.slug != 'transitions-moldings'
      GROUP BY p2.collection, p2.category_id
      ORDER BY p2.collection, cnt DESC
    `);

    // Build map: collection → most common category_id
    const collCatMap = {};
    for (const row of collectionCats.rows) {
      if (!collCatMap[row.collection]) collCatMap[row.collection] = row.cat_id;
    }

    const needCat = await client.query(`
      SELECT p.id, p.name, p.collection
      FROM products p JOIN vendors v ON v.id = p.vendor_id
      WHERE v.code = 'DAL' AND p.status = 'active' AND p.category_id IS NULL
        AND p.name NOT LIKE '%Trim%'
    `);

    let catBackfilled = 0;
    for (const row of needCat.rows) {
      const catId = collCatMap[row.collection];
      if (!catId) continue;
      if (!DRY_RUN) {
        await client.query(`UPDATE products SET category_id = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`, [catId, row.id]);
      }
      catBackfilled++;
    }
    const categoryBackfill = { rowCount: catBackfilled };

    // Also set category for Trim & Accessories products
    const trimBackfill = await client.query(`
      UPDATE products p
      SET category_id = (SELECT id FROM categories WHERE slug = 'transitions-moldings'),
          updated_at = CURRENT_TIMESTAMP
      WHERE p.vendor_id = (SELECT id FROM vendors WHERE code = 'DAL')
        AND p.status = 'active' AND p.category_id IS NULL
        AND p.name LIKE '%Trim%'
      RETURNING p.id
    `);

    if (DRY_RUN) {
      await client.query('ROLLBACK');
      await client.query('BEGIN');
    }

    console.log(`Categories backfilled: ${categoryBackfill.rowCount} products + ${trimBackfill.rowCount} trim\n`);

    // ─── Step 3: Generate display_name for products missing one ──────────

    console.log('--- Step 3: Generate display_name ---');

    // Load category map for display suffixes
    const catMap = {};
    const cats = await client.query('SELECT id, slug, name FROM categories');
    for (const c of cats.rows) { catMap[c.id] = c; }

    const missingDisplay = await client.query(`
      SELECT p.id, p.name, p.collection, p.category_id
      FROM products p
      JOIN vendors v ON v.id = p.vendor_id
      WHERE v.code = 'DAL' AND p.status = 'active'
        AND (p.display_name IS NULL OR p.display_name = '')
    `);

    console.log(`Found ${missingDisplay.rows.length} products missing display_name`);

    let displaySet = 0;
    for (const row of missingDisplay.rows) {
      // Build: "Collection Color CategoryType"
      // Product name = "Collection Color" (e.g., "Advantage Aged Grey")
      // Or for bare-name products: "Collection" (e.g., "Calgary")
      const parts = [row.name]; // Start with full product name

      // Append category suffix
      const cat = row.category_id ? catMap[row.category_id] : null;
      const suffix = cat ? (CATEGORY_DISPLAY[cat.slug] || cat.name) : null;

      // Don't duplicate if name already ends with category
      if (suffix && !row.name.includes(suffix)) {
        parts.push(suffix);
      }

      // Special: Trim products get "Molding" suffix
      if (row.name.includes('Trim & Accessories') && !parts.some(p => p.includes('Molding'))) {
        parts.push('Molding');
      }

      const displayName = parts.join(' ').replace(/\s{2,}/g, ' ').trim();

      if (!DRY_RUN) {
        await client.query(`UPDATE products SET display_name = $1 WHERE id = $2`, [displayName, row.id]);
      } else if (displaySet < 20) {
        console.log(`  "${row.name}" → "${displayName}"`);
      }
      displaySet++;
    }

    console.log(`Display names generated: ${displaySet}\n`);

    // ─── Step 4: Insert color into existing display_names ────────────────

    console.log('--- Step 4: Insert color into existing display_names ---');

    const existingToFix = await client.query(`
      SELECT DISTINCT p.id, p.name, p.collection, p.display_name,
        TRIM(SUBSTRING(p.name FROM LENGTH(p.collection) + 1)) AS color_suffix
      FROM products p
      JOIN vendors v ON v.id = p.vendor_id
      WHERE v.code = 'DAL' AND p.status = 'active'
        AND p.name LIKE p.collection || ' %'
        AND p.display_name IS NOT NULL AND p.display_name != ''
        AND p.display_name NOT LIKE '%Trim%' AND p.display_name NOT LIKE '%Accessories%'
    `);

    let displayFixed = 0;
    for (const row of existingToFix.rows) {
      const colorSuffix = row.color_suffix?.trim();
      if (!colorSuffix || row.display_name.includes(colorSuffix)) continue;

      const insertIdx = row.display_name.indexOf(row.collection);
      if (insertIdx === -1) continue;

      const afterCollection = insertIdx + row.collection.length;
      const newDisplayName = row.display_name.slice(0, afterCollection) +
        ' ' + colorSuffix + row.display_name.slice(afterCollection);

      if (!DRY_RUN) {
        await client.query(`UPDATE products SET display_name = $1 WHERE id = $2`, [newDisplayName, row.id]);
      }
      displayFixed++;
    }

    console.log(`Display names color-fixed: ${displayFixed}\n`);

    // ─── Step 5: Deactivate empty product shells ────────────────────────

    console.log('--- Step 5: Deactivate empty product shells ---');

    const emptyProducts = await client.query(`
      SELECT p.id, p.name FROM products p
      JOIN vendors v ON v.id = p.vendor_id
      WHERE v.code = 'DAL' AND p.status = 'active'
        AND NOT EXISTS (SELECT 1 FROM skus s WHERE s.product_id = p.id)
    `);

    for (const row of emptyProducts.rows) {
      if (!DRY_RUN) {
        await client.query(`UPDATE products SET status = 'inactive' WHERE id = $1`, [row.id]);
      }
    }

    console.log(`Deactivated: ${emptyProducts.rows.length}\n`);

    // ─── Summary ────────────────────────────────────────────────────────

    if (DRY_RUN) {
      console.log('=== DRY RUN — No changes committed ===');
      await client.query('ROLLBACK');
    } else {
      await client.query('COMMIT');
      console.log('=== Changes committed ===');
    }

    console.log(`\nSummary:`);
    console.log(`  Color values cleaned: ${colorsCleaned}`);
    console.log(`  Categories backfilled: ${categoryBackfill.rowCount} + ${trimBackfill.rowCount} trim`);
    console.log(`  Display names generated: ${displaySet}`);
    console.log(`  Display names color-fixed: ${displayFixed}`);
    console.log(`  Empty products deactivated: ${emptyProducts.rows.length}`);

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error:', err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
