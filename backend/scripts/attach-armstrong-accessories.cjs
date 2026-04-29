#!/usr/bin/env node
/**
 * attach-armstrong-accessories.cjs
 *
 * Moves Armstrong accessory SKUs (transitions, moldings, stairnose, etc.)
 * from standalone products into the correct Armstrong flooring products.
 *
 * Matching strategy:
 *   1. Color-matched transitions (T-Mold, Reducer, Threshold, Quarter Round,
 *      Stairnose, End Cap, Flush Stairnose): match by color name to parent
 *      flooring product's SKU variant_names
 *   2. Universal accessories (adhesives, grout, tools, underlayment): stay as
 *      standalone products — they serve multiple product lines
 *
 * Usage:
 *   node backend/scripts/attach-armstrong-accessories.cjs --dry-run
 *   node backend/scripts/attach-armstrong-accessories.cjs
 */

const { Pool } = require('pg');
const pool = new Pool({
  host: process.env.DB_HOST || process.env.PGHOST || 'localhost',
  port: process.env.DB_PORT || process.env.PGPORT || 5432,
  database: process.env.DB_NAME || process.env.PGDATABASE || 'flooring_pim',
  user: process.env.DB_USER || process.env.PGUSER || 'postgres',
  password: process.env.DB_PASS || process.env.PGPASSWORD || 'postgres',
});

const DRY_RUN = process.argv.includes('--dry-run');

// ── Accessory type detection ──────────────────────────────────────────────────
const COLOR_MATCHED_TYPES = [
  'stairnose', 'stair nose', 'flush stairnose', 'flush stair nose',
  't-mold', 't mold', 'tmold', 't-molding', 't molding',
  'reducer', 'threshold', 'end cap', 'endcap', 'end-cap',
  'quarter round', 'quarter-round',
  'overlap reducer', 'multi-purpose', 'multipurpose',
  'nosing', 'transition',
];

const UNIVERSAL_TYPES = [
  'adhesive', 'grout', 'sealer', 'sealant', 'primer', 'underlayment',
  'tool', 'trowel', 'roller', 'tape', 'caulk', 'weld rod', 'welding rod',
  'cleaner', 'stripper', 'finish', 'polish', 'patch', 'leveler',
  'once n done', 'new beginning', 'clear thin spread',
];

const COLOR_MATCHED_PATTERN = new RegExp(COLOR_MATCHED_TYPES.join('|'), 'i');
const UNIVERSAL_PATTERN = new RegExp(UNIVERSAL_TYPES.join('|'), 'i');

// ── Flooring categories (where parent products live) ─────────────────────────
const FLOORING_CATEGORIES = [
  'luxury-vinyl', 'lvp-plank', 'lvt-tile', 'vinyl-plank', 'vinyl-tile',
  'hardwood', 'engineered-hardwood', 'laminate', 'rubber-flooring',
  'vinyl-composition-tile', 'sheet-vinyl', 'linoleum',
];

// ── Accessory categories (where accessories were imported) ───────────────────
const ACCESSORY_CATEGORIES = [
  'transitions-moldings', 'stair-treads-nosing', 'moulding', 'moldings',
];

// ── Color normalization helpers ──────────────────────────────────────────────

/**
 * Normalize a color/variant name for fuzzy matching.
 */
function norm(s) {
  return (s || '')
    .toLowerCase()
    .replace(/\s*\(.*?\)\s*/g, '')           // strip parenthetical codes
    .replace(/\s*#\d+\s*/g, '')              // strip # references
    .replace(/\s*-\s*(?:78|94|96)(?:\s*"?)?\s*$/i, '') // strip molding lengths (78", 94")
    .replace(/\bflush\s*/i, '')              // strip "flush" prefix
    .replace(/\bstairnose\b/gi, '')
    .replace(/\bstair\s*nose\b/gi, '')
    .replace(/\bt[-\s]?mold(?:ing)?\b/gi, '')
    .replace(/\breducer\b/gi, '')
    .replace(/\bthreshold\b/gi, '')
    .replace(/\bend\s*cap\b/gi, '')
    .replace(/\bquarter\s*round\b/gi, '')
    .replace(/\boverlap\b/gi, '')
    .replace(/\bmulti[-\s]?purpose\b/gi, '')
    .replace(/\bnosing\b/gi, '')
    .replace(/\btransition\b/gi, '')
    .replace(/[\/]/g, '-')
    .replace(/\s*-\s*/g, '-')
    .replace(/^[-\s]+|[-\s]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extract the base color (first segment before slash/hyphen).
 */
function baseColor(s) {
  const n = norm(s);
  return n.split('-')[0].trim();
}

/**
 * Determine if a product/SKU is a color-matched accessory vs universal.
 */
function isUniversalAccessory(productName, variantName) {
  const combined = `${productName || ''} ${variantName || ''}`;
  return UNIVERSAL_PATTERN.test(combined);
}

function isColorMatchedAccessory(productName, variantName) {
  const combined = `${productName || ''} ${variantName || ''}`;
  return COLOR_MATCHED_PATTERN.test(combined);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n=== Attach Armstrong Accessories ===`);
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}\n`);

  const client = await pool.connect();

  try {
    // Find Tri-West vendor
    const { rows: [tw] } = await client.query(`SELECT id FROM vendors WHERE code = 'TW'`);
    if (!tw) { console.error('Tri-West vendor not found'); process.exit(1); }
    const vendorId = tw.id;

    // ── Load Armstrong flooring products (targets for attachment) ──────────
    // Exclude products in accessory categories and products whose names
    // indicate they are accessories (transitions, moldings, etc.)
    const { rows: floorProducts } = await client.query(`
      SELECT p.id, p.name, p.collection, c.slug AS category_slug
      FROM products p
      LEFT JOIN categories c ON c.id = p.category_id
      WHERE p.vendor_id = $1
        AND p.collection LIKE 'Armstrong -%'
        AND p.status != 'archived'
        AND (c.slug IS NULL OR c.slug NOT IN (
          'transitions-moldings', 'stair-treads-nosing', 'moulding',
          'adhesives-sealants', 'installation-sundries'
        ))
        AND p.name !~* '(stairnose|stair nose|t-mold|t mold|reducer|threshold|end cap|quarter round|flush stair|weld rod|seam-weld|wallbase|multi-purpose trim|multi-purpose reducer|overlap)'
    `, [vendorId]);

    console.log(`Flooring products: ${floorProducts.length}`);
    for (const p of floorProducts) {
      console.log(`  ${p.collection} / ${p.name} [${p.category_slug || 'no-cat'}]`);
    }

    // Build collection → product lookup
    const collectionToProduct = new Map();
    for (const p of floorProducts) {
      collectionToProduct.set(p.collection, p.id);
    }

    // ── Load flooring SKU colors for color-based matching ─────────────────
    const floorProductIds = floorProducts.map(p => p.id);
    const floorProductIdSet = new Set(floorProductIds);
    const { rows: floorSkus } = floorProductIds.length > 0 ? await client.query(`
      SELECT s.variant_name, s.product_id, p.collection, p.name AS product_name
      FROM skus s
      JOIN products p ON p.id = s.product_id
      WHERE s.product_id = ANY($1::uuid[])
        AND s.variant_type IS DISTINCT FROM 'accessory'
    `, [floorProductIds]) : { rows: [] };

    // Build color index: normalized color → { product_id, collection, product_name }
    const colorToProduct = new Map();
    const baseColorToProduct = new Map();

    for (const s of floorSkus) {
      const n = norm(s.variant_name);
      const b = baseColor(s.variant_name);
      const info = { product_id: s.product_id, collection: s.collection, product_name: s.product_name };

      if (n && !colorToProduct.has(n)) colorToProduct.set(n, info);
      if (b && !baseColorToProduct.has(b)) baseColorToProduct.set(b, info);
    }

    console.log(`\nColor index: ${colorToProduct.size} exact, ${baseColorToProduct.size} base`);

    // ── Load accessory candidate SKUs ─────────────────────────────────────
    // These are Armstrong SKUs that are already flagged as accessory or are in
    // accessory categories, but sitting in their own orphaned products
    const { rows: accSkus } = await client.query(`
      SELECT s.id AS sku_id, s.vendor_sku, s.variant_name, s.variant_type,
             s.sell_by, s.product_id, p.name AS product_name, p.collection,
             c.slug AS category_slug
      FROM skus s
      JOIN products p ON p.id = s.product_id
      LEFT JOIN categories c ON c.id = p.category_id
      WHERE p.vendor_id = $1
        AND (
          p.collection LIKE 'Armstrong -%'
          OR p.collection ILIKE 'Armstrong Flooring%'
        )
        AND (
          s.variant_type = 'accessory'
          OR c.slug IN ('transitions-moldings', 'stair-treads-nosing', 'moulding',
                        'adhesives-sealants', 'installation-sundries')
          OR p.name ~* '(stairnose|t-mold|reducer|threshold|end cap|quarter round|nosing|transition|molding|adhesive|grout|sealer)'
        )
      ORDER BY p.collection, s.vendor_sku
    `, [vendorId]);

    console.log(`\nAccessory candidate SKUs found: ${accSkus.length}`);

    // ── Classify and match accessories ─────────────────────────────────────
    let attached = 0;
    let skippedUniversal = 0;
    let skippedNoMatch = 0;
    let alreadyCorrect = 0;
    const moves = [];

    for (const acc of accSkus) {
      // Skip universal accessories — they stay as standalone products
      if (isUniversalAccessory(acc.product_name, acc.variant_name)) {
        skippedUniversal++;
        continue;
      }

      // Only process color-matched accessories
      if (!isColorMatchedAccessory(acc.product_name, acc.variant_name) &&
          acc.variant_type !== 'accessory') {
        skippedUniversal++;
        continue;
      }

      // Try to match by color name
      let target = null;
      let reason = '';

      const accColor = norm(acc.variant_name);
      const accBase = baseColor(acc.variant_name);

      // Strategy 1: Collection-based routing
      // If the accessory is already in an "Armstrong - X" collection,
      // check if there's a flooring product in the same collection
      if (acc.collection && acc.collection.startsWith('Armstrong - ')) {
        const targetId = collectionToProduct.get(acc.collection);
        if (targetId) {
          // Check this isn't the same product we'd move to
          const isFloorProduct = floorProductIds.includes(targetId) &&
                                 targetId !== acc.product_id;
          if (isFloorProduct) {
            target = { product_id: targetId, collection: acc.collection };
            reason = `same-collection: ${acc.collection}`;
          }
        }
      }

      // Strategy 2: Exact normalized color match
      if (!target && accColor) {
        const match = colorToProduct.get(accColor);
        if (match) {
          target = match;
          reason = `color-exact: "${accColor}"`;
        }
      }

      // Strategy 3: Base color match
      if (!target && accBase) {
        const match = baseColorToProduct.get(accBase);
        if (match) {
          target = match;
          reason = `color-base: "${accBase}"`;
        }
      }

      // Strategy 4: Compound color names (slash/comma separated)
      if (!target && /[,\/]/.test(acc.variant_name || '')) {
        const parts = (acc.variant_name || '').split(/[,\/]/).map(p => p.trim());
        for (const part of parts) {
          const pn = norm(part);
          const pb = baseColor(part);
          if (pn && colorToProduct.has(pn)) {
            target = colorToProduct.get(pn);
            reason = `color-compound: "${pn}"`;
            break;
          }
          if (pb && baseColorToProduct.has(pb)) {
            target = baseColorToProduct.get(pb);
            reason = `color-compound-base: "${pb}"`;
            break;
          }
        }
      }

      if (!target) {
        console.log(`  SKIP: ${acc.vendor_sku} / "${acc.variant_name}" [${acc.product_name}] — no match`);
        skippedNoMatch++;
        continue;
      }

      // Already in the right product and marked as accessory?
      if (acc.product_id === target.product_id && acc.variant_type === 'accessory') {
        alreadyCorrect++;
        continue;
      }

      moves.push({
        sku_id: acc.sku_id,
        old_product_id: acc.product_id,
        new_product_id: target.product_id,
        collection: target.collection,
        color: acc.variant_name,
        reason,
      });

      console.log(`  ${acc.vendor_sku} "${acc.variant_name}" → ${target.collection} (${reason})`);
      attached++;
    }

    // ── Summary before execution ──────────────────────────────────────────
    console.log(`\n--- Match Summary ---`);
    console.log(`Color-matched to attach: ${attached}`);
    console.log(`Already correct:         ${alreadyCorrect}`);
    console.log(`Skipped (universal):     ${skippedUniversal}`);
    console.log(`Skipped (no match):      ${skippedNoMatch}`);
    console.log(`Total candidates:        ${accSkus.length}`);

    // Show distribution by target product
    const byProduct = {};
    for (const m of moves) {
      byProduct[m.collection] = (byProduct[m.collection] || 0) + 1;
    }
    if (Object.keys(byProduct).length > 0) {
      console.log(`\nAccessories per target collection:`);
      for (const [coll, count] of Object.entries(byProduct).sort()) {
        console.log(`  ${coll}: ${count}`);
      }
    }

    if (DRY_RUN) {
      console.log('\n[DRY RUN] No database changes made. Remove --dry-run to execute.\n');
      await pool.end();
      return;
    }

    if (moves.length === 0) {
      console.log('\nNo accessories to move.');
      await pool.end();
      return;
    }

    // ── Execute moves in a transaction ────────────────────────────────────
    console.log('\n-- Executing moves --\n');
    await client.query('BEGIN');

    for (const m of moves) {
      // Move SKU to target product and mark as accessory
      await client.query(`
        UPDATE skus SET product_id = $1, variant_type = 'accessory', sell_by = 'unit'
        WHERE id = $2
      `, [m.new_product_id, m.sku_id]);

      // Move any media for this SKU
      await client.query(`
        UPDATE media_assets SET product_id = $1 WHERE sku_id = $2
      `, [m.new_product_id, m.sku_id]);
    }

    await client.query('COMMIT');
    console.log(`Moved ${moves.length} accessory SKUs.`);

    // ── Clean up orphaned products ────────────────────────────────────────
    // Products that had all their SKUs moved out and now have zero SKUs
    const { rows: orphans } = await client.query(`
      SELECT p.id, p.name, p.collection
      FROM products p
      LEFT JOIN skus s ON s.product_id = p.id
      WHERE p.vendor_id = $1
        AND (p.collection LIKE 'Armstrong -%' OR p.collection ILIKE 'Armstrong Flooring%')
        AND s.id IS NULL
    `, [vendorId]);

    if (orphans.length > 0) {
      console.log(`\nOrphaned products to clean up: ${orphans.length}`);
      for (const o of orphans) {
        // Check for order/quote references before deleting
        const { rows: [{ count: orderCount }] } = await client.query(
          `SELECT COUNT(*) FROM order_items WHERE product_id = $1`, [o.id]
        );
        const { rows: [{ count: quoteCount }] } = await client.query(
          `SELECT COUNT(*) FROM quote_items WHERE product_id = $1`, [o.id]
        );

        if (parseInt(orderCount) > 0 || parseInt(quoteCount) > 0) {
          console.log(`  Archive: ${o.name} [${o.collection}] (has order/quote refs)`);
          await client.query(
            `UPDATE products SET status = 'archived', is_active = false WHERE id = $1`,
            [o.id]
          );
        } else {
          console.log(`  Delete: ${o.name} [${o.collection}]`);
          await client.query(`DELETE FROM media_assets WHERE product_id = $1`, [o.id]);
          await client.query(`DELETE FROM wishlists WHERE product_id = $1`, [o.id]);
          await client.query(`DELETE FROM products WHERE id = $1`, [o.id]);
        }
      }
    }

    // ── Final verification ────────────────────────────────────────────────
    const { rows: [verify] } = await client.query(`
      SELECT COUNT(*) AS total
      FROM skus s
      JOIN products p ON p.id = s.product_id
      WHERE p.collection LIKE 'Armstrong -%'
        AND s.variant_type = 'accessory'
    `);
    console.log(`\nFinal: ${verify.total} Armstrong accessories attached to flooring products`);

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('ERROR — transaction rolled back:', err.message);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
