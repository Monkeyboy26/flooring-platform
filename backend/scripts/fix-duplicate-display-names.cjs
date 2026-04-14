#!/usr/bin/env node
/**
 * Fix Duplicate Words in Product Display Names & SKU Variant Names
 *
 * Phase 1: Fix consecutively repeated words in products.display_name
 *   e.g. "Performance Accessory Cleaner Cleaner" → "Performance Accessory Cleaner"
 *        "Black Black" → "Black"
 *
 * Phase 2: Fix SKU variant_name that redundantly starts with the product name
 *   e.g. product.name="Alof", variant_name="Alof, 12x24" → variant_name="12x24"
 *
 * Usage:
 *   node backend/scripts/fix-duplicate-display-names.cjs --dry-run   # Preview changes
 *   node backend/scripts/fix-duplicate-display-names.cjs              # Execute cleanup
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

/**
 * Remove consecutively repeated words (case-insensitive, 3+ char words).
 * "Performance Accessory Cleaner Cleaner" → "Performance Accessory Cleaner"
 * "Black Black" → "Black"
 */
function dedupeConsecutiveWords(str) {
  if (!str) return str;
  const words = str.split(/\s+/);
  const result = [words[0]];
  for (let i = 1; i < words.length; i++) {
    if (words[i].toLowerCase() !== words[i - 1].toLowerCase() || words[i].length < 3) {
      result.push(words[i]);
    }
  }
  return result.join(' ');
}

async function phase1_fixDisplayNames(client) {
  console.log('\n=== Phase 1: Fix doubled words in products.display_name ===');

  // Find products with consecutively repeated words (3+ chars)
  const { rows } = await client.query(`
    SELECT id, display_name FROM products
    WHERE display_name ~* '(\\y\\w{3,})\\s+\\1\\y'
    ORDER BY id
  `);

  console.log(`Found ${rows.length} products with repeated words in display_name`);

  let updated = 0;
  for (const row of rows) {
    const fixed = dedupeConsecutiveWords(row.display_name);
    if (fixed !== row.display_name) {
      console.log(`  [${row.id}] "${row.display_name}" → "${fixed}"`);
      if (!DRY_RUN) {
        await client.query('UPDATE products SET display_name = $1 WHERE id = $2', [fixed, row.id]);
      }
      updated++;
    }
  }

  console.log(`Phase 1: ${updated} display names ${DRY_RUN ? 'would be' : ''} fixed`);
  return updated;
}

async function phase2_fixVariantNames(client) {
  console.log('\n=== Phase 2: Fix SKU variant_name that redundantly includes product name ===');

  // Find SKUs where variant_name starts with the product name followed by a separator
  const { rows } = await client.query(`
    SELECT s.id AS sku_id, s.variant_name, p.name AS product_name
    FROM skus s
    JOIN products p ON p.id = s.product_id
    WHERE s.variant_name IS NOT NULL
      AND s.variant_name != ''
      AND (
        LOWER(s.variant_name) LIKE LOWER(p.name) || ', %'
        OR LOWER(s.variant_name) LIKE LOWER(p.name) || ' - %'
        OR LOWER(s.variant_name) LIKE LOWER(p.name) || '-%'
      )
    ORDER BY s.id
  `);

  console.log(`Found ${rows.length} SKUs with redundant product name prefix in variant_name`);

  let updated = 0;
  for (const row of rows) {
    const productName = row.product_name;
    // Strip the product name prefix + separator
    const regex = new RegExp(
      '^' + productName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\s,\\-]+',
      'i'
    );
    const fixed = row.variant_name.replace(regex, '').trim();

    if (fixed && fixed !== row.variant_name) {
      console.log(`  [SKU ${row.sku_id}] "${row.variant_name}" → "${fixed}" (product: "${productName}")`);
      if (!DRY_RUN) {
        await client.query('UPDATE skus SET variant_name = $1 WHERE id = $2', [fixed, row.sku_id]);
      }
      updated++;
    }
  }

  console.log(`Phase 2: ${updated} variant names ${DRY_RUN ? 'would be' : ''} fixed`);
  return updated;
}

async function main() {
  console.log(`=== Fix Duplicate Display Names ${DRY_RUN ? '(DRY RUN)' : '(LIVE)'} ===`);

  const client = await pool.connect();
  try {
    if (!DRY_RUN) await client.query('BEGIN');

    const p1 = await phase1_fixDisplayNames(client);
    const p2 = await phase2_fixVariantNames(client);

    if (!DRY_RUN) await client.query('COMMIT');

    console.log(`\n=== Summary ${DRY_RUN ? '(DRY RUN)' : ''} ===`);
    console.log(`  Phase 1 (display_name dedup): ${p1} products`);
    console.log(`  Phase 2 (variant_name prefix): ${p2} SKUs`);
    console.log(`  Total: ${p1 + p2} rows ${DRY_RUN ? 'would be' : ''} updated`);
  } catch (err) {
    if (!DRY_RUN) await client.query('ROLLBACK');
    console.error('Error:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
