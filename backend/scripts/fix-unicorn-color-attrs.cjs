/**
 * Fix mangled color attributes for Unicorn Tile Corp SKUs.
 *
 * Issues fixed:
 *   1. Size values leaked into color (e.g., "Jolly White 5 5" → "Jolly White")
 *   2. Ampersand remnants from Glossy & Matte split (e.g., "Covebase &" → "Covebase")
 *   3. Finish stored as color for single-color products (e.g., "Matte" → product's actual color)
 *   4. Wrong image on Sage Grey (has Grey Mix image) — delete so re-scrape assigns correctly
 *   5. Wrong image on Nox Undulated SE Matte (has Covebase image) — delete
 *
 * Run: docker compose exec api node scripts/fix-unicorn-color-attrs.cjs [--dry-run]
 * Then re-run: docker compose exec api node scrapers/unicorn.js --force
 */
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: 5432, database: 'flooring_pim', user: 'postgres', password: 'postgres',
});

const DRY_RUN = process.argv.includes('--dry-run');

// Color attribute fixes: { variant_name pattern → correct color value }
// null means "delete the color attribute" (for garbage values)
const COLOR_FIXES = [
  // === Size leaked into Jolly colors ===
  // Arte
  { product: 'Unicorn Tile Arte', variant: 'Jolly Latte & Silver', color: 'Latte Silver' },
  { product: 'Unicorn Tile Arte', variant: 'Jolly White', color: 'White' },
  // Coastal
  { product: 'Unicorn Tile Coastal', variant: 'Jolly', color: 'Jolly' },
  // Cortina
  { product: 'Unicorn Tile Cortina', variant: 'Jolly Glossy', color: 'Jolly' },
  { product: 'Unicorn Tile Cortina', variant: 'Jolly Matte', color: 'Jolly' },
  // Eclipse Beveled
  { product: 'Unicorn Tile Eclipse Beveled', variant: 'Jolly Glossy', color: 'Jolly' },
  { product: 'Unicorn Tile Eclipse Beveled', variant: 'Jolly Matte', color: 'Jolly' },
  // Nox
  { product: 'Unicorn Tile Nox', variant: 'Jolly Glossy', color: 'Jolly' },
  { product: 'Unicorn Tile Nox', variant: 'Jolly Matte', color: 'Jolly' },
  // Shades
  { product: 'Unicorn Tile Shades', variant: 'Jolly Crema Latte Silver', color: 'Crema Latte Silver' },
  { product: 'Unicorn Tile Shades', variant: 'Jolly White 5/8x12', color: 'White' },
  { product: 'Unicorn Tile Shades', variant: 'Jolly White 5/8x8', color: 'White' },

  // === Garbage size-only values ===
  { product: 'Unicorn Tile Longo', variant: '3" Hex Mosaic%', color: 'White' },
  { product: 'Unicorn Tile Longo', variant: 'Chevron Mesh Mounted%', color: 'White' },
  { product: 'Unicorn Tile Nox', variant: '3" Hex Mosaic%', color: 'Black' },
  { product: 'Unicorn Tile GL Series', variant: 'GL4007%', color: 'GL4007' },

  // === Ampersand remnants from Glossy & Matte split ===
  { product: 'Unicorn Tile Nox', variant: 'Covebase Glossy', color: 'Covebase' },
  { product: 'Unicorn Tile Nox', variant: 'Covebase Matte', color: 'Covebase' },
  { product: 'Unicorn Tile Silom', variant: 'White Bullnose Glossy', color: 'White' },
  { product: 'Unicorn Tile Silom', variant: 'White Bullnose Matte', color: 'White' },

  // === Finish stored as color for single-color products ===
  // Montana White — the color IS White
  { product: 'Unicorn Tile Montana White', variant: 'Glossy%', color: 'White' },
  { product: 'Unicorn Tile Montana White', variant: 'Matte%', color: 'White' },
  // Ellum Stone — single stone color
  { product: 'Unicorn Tile Ellum Stone', variant: 'Matte%', color: 'Ellum Stone' },
  { product: 'Unicorn Tile Ellum Stone', variant: 'Polished%', color: 'Ellum Stone' },
  // Deer Tile Aspen — single color
  { product: 'Deer Tile Aspen', variant: 'Polished%', color: 'Aspen' },
  // Deer Tile Athena — single color
  { product: 'Deer Tile Athena', variant: 'Matte%', color: 'Athena' },
  { product: 'Deer Tile Athena', variant: 'Polished%', color: 'Athena' },
  // Deer Tile Ayer
  { product: 'Deer Tile Ayer', variant: 'Bullnose Matte Only', color: 'Ayer' },
  { product: 'Deer Tile Ayer', variant: 'Matte 12x24', color: 'Ayer' },
  { product: 'Deer Tile Ayer', variant: 'Polished 24x24', color: 'Ayer' },
  { product: 'Deer Tile Ayer', variant: 'Polished 24x48', color: 'Ayer' },
];

// Wrong image deletions
const WRONG_IMAGES = [
  // Sage Grey Hex SKUs have Grey Mix image — delete so scraper can reassign
  // (Grey Square has correct Gray-3.jpg, only Hex ones have wrong Gray-Mix-1.jpg)
  {
    product: 'Unicorn Tile Sage',
    variant_like: 'Grey %',
    variant_not_like: 'Grey Mix%',
    url_contains: 'Gray-Mix',
    reason: 'Grey Hex SKUs have Grey Mix image (Gray-Mix-1.jpg)',
  },
  // Nox Undulated SE Matte has Covebase image
  {
    product: 'Unicorn Tile Nox',
    variant_like: 'Undulated Straight Edge Matte%',
    url_contains: 'Covebase',
    reason: 'Undulated Matte has wrong Covebase image',
  },
];

async function run() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const colorAttrId = (await client.query(
      `SELECT id FROM attributes WHERE slug = 'color'`
    )).rows[0]?.id;

    if (!colorAttrId) {
      console.error('No "color" attribute found!');
      return;
    }

    console.log('=== Fixing Unicorn Tile Color Attributes ===\n');

    // 1. Fix color attribute values
    let colorFixed = 0;
    for (const fix of COLOR_FIXES) {
      const variantMatch = fix.variant.includes('%') ? 'LIKE' : '=';
      const { rows } = await client.query(`
        SELECT s.id, s.variant_name, sa.value as old_color
        FROM skus s
        JOIN products p ON p.id = s.product_id
        JOIN sku_attributes sa ON sa.sku_id = s.id AND sa.attribute_id = $1
        WHERE p.name = $2 AND s.variant_name ${variantMatch} $3
      `, [colorAttrId, fix.product, fix.variant]);

      for (const row of rows) {
        if (row.old_color === fix.color) continue; // Already correct
        console.log(`  FIX: ${fix.product} / ${row.variant_name}`);
        console.log(`       "${row.old_color}" → "${fix.color}"`);
        if (!DRY_RUN) {
          await client.query(`
            UPDATE sku_attributes SET value = $1
            WHERE sku_id = $2 AND attribute_id = $3
          `, [fix.color, row.id, colorAttrId]);
        }
        colorFixed++;
      }
    }

    console.log(`\nFixed ${colorFixed} color attributes\n`);

    // 2. Delete wrong images
    console.log('=== Fixing Wrong Image Assignments ===\n');
    let imagesDeleted = 0;
    for (const fix of WRONG_IMAGES) {
      let query = `
        SELECT ma.id, s.variant_name, ma.url
        FROM media_assets ma
        JOIN skus s ON s.id = ma.sku_id
        JOIN products p ON p.id = s.product_id
        WHERE p.name = $1
          AND s.variant_name LIKE $2
          AND ma.asset_type = 'primary'
      `;
      const params = [fix.product, fix.variant_like];

      if (fix.variant_not_like) {
        query += ` AND s.variant_name NOT LIKE $3`;
        params.push(fix.variant_not_like);
      }

      if (fix.url_contains) {
        query += ` AND ma.url LIKE $${params.length + 1}`;
        params.push(`%${fix.url_contains}%`);
      }

      const { rows } = await client.query(query, params);
      for (const row of rows) {
        console.log(`  DELETE: ${row.variant_name} — ${row.url}`);
        console.log(`         Reason: ${fix.reason}`);
        if (!DRY_RUN) {
          await client.query(`DELETE FROM media_assets WHERE id = $1`, [row.id]);
        }
        imagesDeleted++;
      }
    }

    console.log(`\nDeleted ${imagesDeleted} wrong images\n`);

    if (DRY_RUN) {
      console.log('[DRY RUN] No changes made. Remove --dry-run to apply.');
      await client.query('ROLLBACK');
    } else {
      await client.query('COMMIT');
      console.log('Done! Now re-run: docker compose exec api node scrapers/unicorn.js --force');
    }
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error:', err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch(err => { console.error(err); process.exit(1); });
