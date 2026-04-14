#!/usr/bin/env node
/**
 * Fix MSI product naming issues:
 * 1. Comma in name: "Ivoritaj Beige,cream" → "Ivoritaj"
 * 2. Doubled-color in name: "Carrara White White" → "Carrara White"
 * 3. display_name = name where name has variant appended: fix display_name
 * 4. name = collection + variant: clean up name to match display_name
 */

const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres'
});

const COLORS = [
  'Beige', 'White', 'Gray', 'Grey', 'Black', 'Brown', 'Blue', 'Green', 'Red',
  'Ivory', 'Cream', 'Charcoal', 'Gold', 'Silver', 'Tan', 'Peach', 'Pink',
  'Orange', 'Yellow', 'Purple', 'Olive', 'Multicolor', 'Multi', 'Taupe'
];
const COLOR_SET = new Set(COLORS.map(c => c.toLowerCase()));

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  const client = await pool.connect();

  try {
    if (DRY_RUN) console.log('=== DRY RUN MODE ===\n');

    const msiVendor = await client.query("SELECT id FROM vendors WHERE code = 'MSI'");
    const msiId = msiVendor.rows[0].id;

    // ═══════════════════════════════════════════════════
    // Fix 1: Comma-separated variants in name/display_name
    // "Ivoritaj Beige,cream" → name: "Ivoritaj", display_name: "Ivoritaj"
    // ═══════════════════════════════════════════════════
    console.log('=== Fix 1: Comma-separated variants ===');
    const { rows: commaProducts } = await client.query(`
      SELECT id, name, display_name, collection
      FROM products
      WHERE vendor_id = $1
        AND (name LIKE '%,%' OR display_name LIKE '%,%')
        AND name NOT LIKE '%Grout%'
        AND name NOT LIKE '%Screw%'
        AND name NOT LIKE '%Bowl%'
        AND name NOT LIKE '%Bwl%'
        AND name NOT LIKE '%Tread%'
    `, [msiId]);

    for (const p of commaProducts) {
      // Strip everything from the comma onwards, then strip trailing color words
      let cleanName = p.collection || p.name.split(',')[0].trim();
      // If collection is available, use it
      if (p.collection && p.collection.length > 1) {
        cleanName = p.collection;
      }
      console.log(`  "${p.name}" → name: "${cleanName}", display_name: "${cleanName}"`);
      if (!DRY_RUN) {
        await client.query(
          'UPDATE products SET name = $1, display_name = $2 WHERE id = $3',
          [cleanName, cleanName, p.id]
        );
      }
    }
    console.log(`  Fixed: ${commaProducts.length}\n`);

    // ═══════════════════════════════════════════════════
    // Fix 2: Doubled-color in name
    // "Carrara White White" → "Carrara White"
    // "Brickstone Charcoal Charcoal" → "Brickstone Charcoal"
    // ═══════════════════════════════════════════════════
    console.log('=== Fix 2: Doubled-color in name ===');
    const colorPattern = COLORS.join('|');
    const { rows: doubledColorProducts } = await client.query(`
      SELECT id, name, display_name, collection
      FROM products
      WHERE vendor_id = $1
        AND name ~ $2
    `, [msiId, `\\s(${colorPattern})\\s+(${colorPattern})$`]);

    let fixed2 = 0;
    let skipped2 = 0;
    for (const p of doubledColorProducts) {
      const words = p.name.split(' ');
      const lastWord = words[words.length - 1];
      if (COLOR_SET.has(lastWord.toLowerCase())) {
        const withoutLast = words.slice(0, -1).join(' ');
        const newName = withoutLast;
        if (newName.length > 1) {
          // Check for unique constraint conflict before updating
          const { rows: conflicts } = await client.query(
            'SELECT id FROM products WHERE vendor_id = $1 AND collection = $2 AND name = $3 AND id <> $4',
            [msiId, p.collection, newName, p.id]
          );
          if (conflicts.length > 0) {
            console.log(`  SKIP "${p.name}" → "${newName}" (would conflict)`);
            skipped2++;
            continue;
          }
          console.log(`  "${p.name}" → "${newName}"`);
          if (!DRY_RUN) {
            await client.query('UPDATE products SET name = $1 WHERE id = $2', [newName, p.id]);
          }
          fixed2++;
        }
      }
    }
    console.log(`  Fixed: ${fixed2}, Skipped: ${skipped2}\n`);

    // ═══════════════════════════════════════════════════
    // Fix 3: display_name still equals bad name (after fix 2)
    // Set display_name = collection where appropriate
    // ═══════════════════════════════════════════════════
    console.log('=== Fix 3: Uncleaned display_name ===');
    const { rows: badDisplayNames } = await client.query(`
      SELECT id, name, display_name, collection
      FROM products
      WHERE vendor_id = $1
        AND display_name = name
        AND collection IS NOT NULL AND collection <> ''
        AND name <> collection
        AND EXISTS (SELECT 1 FROM skus s WHERE s.product_id = products.id)
        AND name NOT LIKE '%Grout%'
        AND name NOT LIKE '%Prism%'
        AND name NOT LIKE '%Sika%'
        AND name NOT LIKE '%Caulk%'
    `, [msiId]);

    let fixed3 = 0;
    for (const p of badDisplayNames) {
      // Only fix if the name looks like collection + something (variant appended)
      if (p.name.toLowerCase().startsWith(p.collection.toLowerCase())) {
        const suffix = p.name.substring(p.collection.length).trim();
        // Check if the suffix is a color word or variant-like
        const suffixWords = suffix.split(/[\s,]+/);
        const allColors = suffixWords.every(w => COLOR_SET.has(w.toLowerCase()) || w.length <= 1);
        if (allColors && suffix.length > 0) {
          console.log(`  "${p.display_name}" → "${p.collection}"`);
          if (!DRY_RUN) {
            await client.query('UPDATE products SET display_name = $1 WHERE id = $2', [p.collection, p.id]);
          }
          fixed3++;
        }
      }
    }
    console.log(`  Fixed: ${fixed3}\n`);

    // ═══════════════════════════════════════════════════
    // Summary
    // ═══════════════════════════════════════════════════
    console.log('=== Summary ===');
    console.log(`Fix 1 (comma in name/display_name): ${commaProducts.length}`);
    console.log(`Fix 2 (doubled color in name): ${fixed2}`);
    console.log(`Fix 3 (uncleaned display_name): ${fixed3}`);
    console.log(`Total: ${commaProducts.length + fixed2 + fixed3}`);

  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
