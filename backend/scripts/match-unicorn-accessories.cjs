/**
 * Match Unicorn Tile accessories to the correct parent SKUs.
 *
 * Matching logic (per-SKU):
 *   1. Color match + finish match — accessory color matches main SKU color AND finish matches
 *   2. Color match only — accessory color matches (no finish on accessory, or finish-neutral items like mosaics)
 *   3. Finish match only — for products where all accessories share the product color (single-color products)
 *   4. Fallback — assign to all main SKUs (universal accessories like Bullnose with no finish variant)
 *
 * Multi-color accessories (e.g., "Jolly Crema Latte Silver"):
 *   Matches ANY main SKU whose color is one of the words in the accessory's color.
 *
 * Run: docker compose exec api node scripts/match-unicorn-accessories.cjs [--dry-run]
 */
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: 5432, database: 'flooring_pim', user: 'postgres', password: 'postgres',
});

const DRY_RUN = process.argv.includes('--dry-run');

function extractFinish(variantName) {
  if (!variantName) return null;
  // "Polished/Matte" or "Glossy & Matte" means finish-neutral
  if (/\b(polished|glossy)\s*[\/&]\s*matte\b/i.test(variantName)) return null;
  if (/\bmatte\s*[\/&]\s*(polished|glossy)\b/i.test(variantName)) return null;
  const m = variantName.match(/\b(glossy|matte|polished|lappato|satin|honed)\b/i);
  return m ? m[1].toLowerCase() : null;
}

// Colors that aren't useful for matching (product names used as color fallback)
const PRODUCT_NAME_COLORS = new Set([
  'aldo', 'andaz', 'ayer', 'aspen', 'athena', 'moda', 'nebula', 'nextar',
  'nimbus', 'nomad', 'nova', 'creative concrete', 'ellum stone', 'ice white',
  'impressions', 'longo', 'magnum', 'merc', 'nano', 'shades', 'spectrum',
  'statuarietto', 'vinson', 'jolly', 'sapporo',
]);

// Shape/pattern "colors" that aren't real colors
const SHAPE_COLORS = new Set([
  'flat', 'picket', 'undulated', 'herringbone', 'penny', 'covebase',
  'etoile', 'leaf', 'renze', 'wave', 'bullnose',
]);

function isRealColor(color) {
  if (!color) return false;
  const low = color.toLowerCase().trim();
  return !PRODUCT_NAME_COLORS.has(low) && !SHAPE_COLORS.has(low);
}

async function run() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Get vendor ID
    const { rows: [vendor] } = await client.query(
      `SELECT id FROM vendors WHERE name = 'Unicorn Tile Corp'`
    );
    if (!vendor) { console.error('Vendor not found'); return; }

    // Get color attribute ID
    const { rows: [colorAttr] } = await client.query(
      `SELECT id FROM attributes WHERE slug = 'color'`
    );
    const colorAttrId = colorAttr?.id;

    // Load all Unicorn products with their SKUs
    const { rows: allSkus } = await client.query(`
      SELECT p.id as product_id, p.name as product_name,
             s.id as sku_id, s.variant_name, s.variant_type, s.vendor_sku,
             sa.value as color_attr
      FROM products p
      JOIN skus s ON s.product_id = p.id
      LEFT JOIN sku_attributes sa ON sa.sku_id = s.id AND sa.attribute_id = $1
      WHERE p.vendor_id = $2 AND s.status = 'active'
      ORDER BY p.name, s.variant_type NULLS FIRST, s.variant_name
    `, [colorAttrId, vendor.id]);

    // Group by product
    const products = new Map();
    for (const row of allSkus) {
      if (!products.has(row.product_id)) {
        products.set(row.product_id, { name: row.product_name, mains: [], accessories: [] });
      }
      const entry = {
        sku_id: row.sku_id,
        variant_name: row.variant_name,
        vendor_sku: row.vendor_sku,
        color: row.color_attr,
        finish: extractFinish(row.variant_name),
      };
      if (row.variant_type === 'accessory') {
        products.get(row.product_id).accessories.push(entry);
      } else {
        products.get(row.product_id).mains.push(entry);
      }
    }

    // Clear existing Unicorn accessory links
    const { rowCount: cleared } = await client.query(`
      DELETE FROM sku_accessories
      WHERE parent_sku_id IN (
        SELECT s.id FROM skus s
        JOIN products p ON p.id = s.product_id
        WHERE p.vendor_id = $1
      )
    `, [vendor.id]);
    console.log(`Cleared ${cleared} existing accessory links\n`);

    let totalLinks = 0;
    let totalAccessories = 0;

    for (const [productId, prod] of products) {
      if (!prod.accessories.length || !prod.mains.length) continue;

      console.log(`${prod.name}: ${prod.mains.length} main, ${prod.accessories.length} accessories`);

      for (const acc of prod.accessories) {
        totalAccessories++;
        const accFinish = acc.finish;
        const accColor = acc.color;
        const accColorReal = isRealColor(accColor);

        // Build list of color words for multi-color accessories
        // e.g., "Crema Latte Silver" → ["crema", "latte", "silver"]
        // e.g., "Latte Silver" → ["latte", "silver"]
        const accColorWords = accColorReal && accColor
          ? accColor.toLowerCase().split(/\s+/).filter(w => w.length >= 3)
          : [];

        let matched = [];

        // Strategy 1: Color + Finish match
        if (accColorReal && accFinish) {
          matched = prod.mains.filter(main => {
            const mainColor = (main.color || '').toLowerCase().trim();
            const mainFinish = main.finish;
            const colorMatch = accColorWords.length > 1
              ? accColorWords.some(w => mainColor === w)
              : mainColor === accColor.toLowerCase().trim();
            return colorMatch && mainFinish === accFinish;
          });
        }

        // Strategy 2: Color match only (no finish on accessory, or mosaic accessories)
        if (!matched.length && accColorReal) {
          matched = prod.mains.filter(main => {
            const mainColor = (main.color || '').toLowerCase().trim();
            const colorMatch = accColorWords.length > 1
              ? accColorWords.some(w => mainColor === w)
              : mainColor === accColor.toLowerCase().trim();
            return colorMatch;
          });
        }

        // Strategy 3: Finish match only (for products where accessories don't have meaningful color)
        if (!matched.length && accFinish) {
          matched = prod.mains.filter(main => main.finish === accFinish);
        }

        // Strategy 4: Fallback — assign to all main SKUs
        if (!matched.length) {
          matched = prod.mains;
        }

        const matchType = matched.length === prod.mains.length ? 'ALL'
          : accColorReal && accFinish ? 'color+finish'
          : accColorReal ? 'color'
          : accFinish ? 'finish'
          : 'fallback';

        console.log(`  ${acc.variant_name} (color: ${accColor || '-'}, finish: ${accFinish || '-'}) → ${matched.length} matches [${matchType}]`);
        for (const main of matched) {
          console.log(`    → ${main.variant_name}`);
        }

        if (!DRY_RUN) {
          for (let i = 0; i < matched.length; i++) {
            await client.query(`
              INSERT INTO sku_accessories (parent_sku_id, accessory_sku_id, sort_order)
              VALUES ($1, $2, $3)
              ON CONFLICT (parent_sku_id, accessory_sku_id) DO UPDATE SET sort_order = EXCLUDED.sort_order
            `, [matched[i].sku_id, acc.sku_id, i]);
          }
        }
        totalLinks += matched.length;
      }
      console.log('');
    }

    if (DRY_RUN) {
      console.log(`[DRY RUN] Would create ${totalLinks} links for ${totalAccessories} accessories`);
      await client.query('ROLLBACK');
    } else {
      await client.query('COMMIT');
      console.log(`Done: ${totalLinks} links for ${totalAccessories} accessories`);
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
