#!/usr/bin/env node
/**
 * MSI Accessory Linking Script
 *
 * Re-parents standalone MSI trim/accessory products (e.g., "Aaron Ec 78"")
 * under their matching main products (e.g., "Aaron") so they appear in the
 * storefront's "Matching Accessories" section via same_product_siblings.
 *
 * The 832 importer historically grouped accessories into separate products
 * using key `collection|||baseName|||acc`. This script finds those standalone
 * accessory products, moves their SKUs to the parent main product, sets
 * variant_type = 'accessory', and deactivates the now-empty product shells.
 *
 * Usage:
 *   node backend/scripts/msi-link-accessories.cjs --dry-run   # Preview only
 *   node backend/scripts/msi-link-accessories.cjs             # Execute
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

// ---------------------------------------------------------------------------
// Trim-code detection
// ---------------------------------------------------------------------------

// Trim codes used by MSI — ordered longest-first for regex alternation
const TRIM_CODES = [
  'fsnl', 'ecl', 't-sr', '4-in-1',
  'fsn', 'osn', 'srl', 'ec', 'qr', 'sr', 'st', 'rt', 't',
];

const codeAlt = TRIM_CODES.map(c => c.replace(/-/g, '\\-')).join('|');

// Matches product names like "Aaron Ec 78"", "Abingdale Fsn-Ee 94""
// Group 1 = base name, Group 2 = trim code, Group 3 = optional suffix
const TRIM_REGEX = new RegExp(
  `^(.+?)\\s+(${codeAlt})(-ee|-sr|-w)?\\s+[\\d.]+"?\\s*$`,
  'i'
);

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`\nMSI Accessory Linking${DRY_RUN ? ' (DRY RUN)' : ''}`);
  console.log('='.repeat(50) + '\n');

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. Get MSI vendor ID
    const vendorResult = await client.query(
      `SELECT id FROM vendors WHERE code = 'MSI'`
    );
    if (!vendorResult.rows.length) {
      console.log('ERROR: MSI vendor not found');
      return;
    }
    const vendorId = vendorResult.rows[0].id;

    // 2. Fetch all MSI products with SKU counts
    const productsResult = await client.query(`
      SELECT
        p.id, p.name, p.display_name, p.collection, p.status,
        COUNT(s.id) as sku_count,
        COUNT(s.id) FILTER (WHERE s.variant_type IS DISTINCT FROM 'accessory') as main_sku_count
      FROM products p
      LEFT JOIN skus s ON s.product_id = p.id AND s.status = 'active'
      WHERE p.vendor_id = $1
      GROUP BY p.id
      ORDER BY p.name
    `, [vendorId]);

    const allProducts = productsResult.rows;
    console.log(`Total MSI products: ${allProducts.length}\n`);

    // 3. Classify: main products vs trim-code accessory products
    const mainProductMap = new Map(); // lowercase name → product row
    const trimProducts = [];

    for (const p of allProducts) {
      const match = TRIM_REGEX.exec(p.name);
      if (match) {
        trimProducts.push({
          ...p,
          baseName: match[1].trim(),
          trimCode: match[2],
          suffix: match[3] || '',
        });
      } else if (parseInt(p.main_sku_count) > 0) {
        // Main product — index by (collection, lowercase name) for collection-scoped lookup
        const collKey = `${p.collection}\0${p.name.toLowerCase().trim()}`;
        const nameKey = p.name.toLowerCase().trim();

        // Collection-scoped entry (preferred)
        if (!mainProductMap.has(collKey) || parseInt(p.sku_count) > parseInt(mainProductMap.get(collKey).sku_count)) {
          mainProductMap.set(collKey, p);
        }
        // Global fallback entry (any collection)
        if (!mainProductMap.has(nameKey) || parseInt(p.sku_count) > parseInt(mainProductMap.get(nameKey).sku_count)) {
          mainProductMap.set(nameKey, p);
        }
      }
    }

    console.log(`Main products (potential parents): ${new Set([...mainProductMap.values()].map(p => p.id)).size}`);
    console.log(`Trim/accessory products to link: ${trimProducts.length}\n`);

    if (trimProducts.length === 0) {
      console.log('Nothing to do.');
      await client.query('ROLLBACK');
      return;
    }

    // 4. Match and re-parent
    let matched = 0, unmatched = 0, skusMoved = 0, productsDeactivated = 0;
    const unmatchedList = [];
    const affectedParentIds = new Set();

    for (const tp of trimProducts) {
      const parentNameKey = tp.baseName.toLowerCase().trim();
      const collKey = `${tp.collection}\0${parentNameKey}`;

      // Prefer same-collection parent, fall back to any-collection
      const parent = mainProductMap.get(collKey) || mainProductMap.get(parentNameKey);

      if (!parent) {
        unmatched++;
        unmatchedList.push(`  ${tp.name} (collection: "${tp.collection}", base: "${tp.baseName}")`);
        continue;
      }

      matched++;
      affectedParentIds.add(parent.id);

      // Derive variant_name from display_name (expanded by name-cleanup) or raw name
      const displayName = tp.display_name || tp.name;
      const parentName = parent.name;
      let variantName;

      // Strip parent name prefix from display_name to get trim description
      if (displayName.toLowerCase().startsWith(parentName.toLowerCase())) {
        variantName = displayName.slice(parentName.length).trim();
      } else if (displayName.toLowerCase().startsWith(tp.baseName.toLowerCase())) {
        variantName = displayName.slice(tp.baseName.length).trim();
      } else {
        // Last resort: full display_name
        variantName = displayName;
      }

      if (!variantName) {
        variantName = tp.name.replace(new RegExp(`^${tp.baseName}\\s*`, 'i'), '').trim() || tp.name;
      }

      console.log(`  ${tp.name} -> parent "${parent.name}" [variant: "${variantName}"]`);

      // Move all active SKUs to the parent product
      const moveResult = await client.query(`
        UPDATE skus
        SET product_id = $1,
            variant_type = 'accessory',
            variant_name = $3,
            updated_at = NOW()
        WHERE product_id = $2 AND status = 'active'
        RETURNING id
      `, [parent.id, tp.id, variantName]);

      skusMoved += moveResult.rowCount;

      // Deactivate the now-empty product shell
      const remaining = await client.query(
        `SELECT COUNT(*) as cnt FROM skus WHERE product_id = $1 AND status = 'active'`,
        [tp.id]
      );

      if (parseInt(remaining.rows[0].cnt) === 0) {
        await client.query(
          `UPDATE products SET status = 'discontinued', is_active = false, updated_at = NOW() WHERE id = $1`,
          [tp.id]
        );
        productsDeactivated++;
      }
    }

    // 5. Rebuild search vectors for affected parent products
    if (!DRY_RUN && affectedParentIds.size > 0) {
      console.log(`\nRebuilding search vectors for ${affectedParentIds.size} parent products...`);
      for (const pid of affectedParentIds) {
        try {
          await client.query('SELECT refresh_search_vectors($1)', [pid]);
        } catch {
          // Ignore if function doesn't exist
        }
      }
    }

    // 6. Summary
    console.log(`\n${'='.repeat(50)}`);
    console.log(`SUMMARY${DRY_RUN ? ' (DRY RUN - no changes committed)' : ''}:`);
    console.log(`  Matched & linked:       ${matched}`);
    console.log(`  SKUs moved:             ${skusMoved}`);
    console.log(`  Products deactivated:   ${productsDeactivated}`);
    console.log(`  Unmatched:              ${unmatched}`);

    if (unmatchedList.length > 0) {
      const show = unmatchedList.slice(0, 50);
      console.log(`\nUnmatched products (no parent found)${unmatchedList.length > 50 ? ` — showing 50 of ${unmatchedList.length}` : ''}:`);
      for (const line of show) console.log(line);
    }

    if (DRY_RUN) {
      await client.query('ROLLBACK');
      console.log('\nDry run complete - all changes rolled back.');
    } else {
      await client.query('COMMIT');
      console.log('\nAll changes committed successfully.');
    }

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('\nError:', err.message);
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
