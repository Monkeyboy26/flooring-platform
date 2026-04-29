#!/usr/bin/env node
/**
 * attach-hartco-accessories.cjs
 *
 * Moves accessory SKUs from 832-imported AHF products into the correct
 * canonical Hartco floor products (same product_id, variant_type='accessory').
 *
 * After the 832 re-import, accessories live under their own collections
 * (e.g. "Necessity Collection Quarter Round 78", "Tb Gold Reducer 78",
 *  "Quarter Round 94", etc.) rather than "AHF Products".
 *
 * Matching strategy:
 *   1. Collection-based routing (accessory product/collection name → target Hartco product)
 *   2. Color-name matching (exact normalized, base color, compound splits)
 *   3. Forced collection fallback for unmatched colors
 *
 * Usage:
 *   node backend/scripts/attach-hartco-accessories.cjs --dry-run
 *   node backend/scripts/attach-hartco-accessories.cjs
 */

const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@db:5432/flooring_pim' });

const DRY_RUN = process.argv.includes('--dry-run');

/* ── helpers ─────────────────────────────────────────────────────── */

/** Normalize a color name for fuzzy matching */
function norm(s) {
  return s
    .toLowerCase()
    .replace(/\s*\(.*?\)\s*/g, '')          // strip parenthetical (ovl), (eir), SKU refs
    .replace(/[\/]/g, '-')                   // slash → hyphen
    .replace(/\s*-\s*/g, '-')               // normalize spacing around hyphens
    .replace(/lover\ss\s/g, 'lovers ')       // fix "Lover S Cove" → "Lovers Cove"
    .replace(/goleat/g, 'goleta')            // fix typo
    .replace(/barbra/g, 'barbara')           // fix typo
    .replace(/santabarbra/g, 'santa barbara')
    .replace(/bare4ly/g, 'barely')           // fix typo
    .replace(/untimate/g, 'ultimate')        // fix typo
    .replace(/enening/g, 'evening')          // fix "enening Star" → "evening Star"
    .replace(/urbanit(?!e)/g, 'urbanite')    // fix "Urbanit" → "Urbanite"
    .replace(/-white\s*oak$/i, '')           // strip species
    .replace(/-hickory$/i, '')
    .replace(/-hckory$/i, '')
    .replace(/-red\s*oak$/i, '')
    .replace(/-white$/i, '')
    .replace(/-hartco$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Extract just the base color (first part before hyphen/species) */
function baseColor(s) {
  return norm(s).split('-')[0].trim();
}

/* ── collection routing ──────────────────────────────────────────── */

/**
 * Map accessory collection name to the Hartco flooring product it belongs to.
 * Returns null if no direct routing (fall through to color matching).
 */
function routeByCollection(collectionName) {
  const c = collectionName.toLowerCase();

  // Coastal Highway
  if (c.includes('coastal highway'))       return 'Hartco Coastal Highway Engineered Hardwood';

  // Necessity
  if (c.includes('necessity'))             return 'Hartco Necessity Engineered Hardwood';

  // TimberBrushed Gold (hickory species → HydroBlok, white oak → TB Gold)
  if (c.includes('tb gold') && c.includes('hickory'))
    return 'Hartco HydroBlok Engineered Hardwood';
  if (c.includes('tb gold'))               return 'Hartco TimberBrushed Gold Engineered Hardwood';

  // TimberBrushed Silver
  if (c.includes('tb silver'))             return 'Hartco TimberBrushed Silver Engineered Hardwood';

  // TimberBrushed Platinum = base TimberBrushed
  if (c.includes('tb platinum'))           return 'Hartco TimberBrushed Engineered Hardwood';

  // HydroBlok
  if (c.includes('hydroblock') || c.includes('hydroblok'))
    return 'Hartco HydroBlok Engineered Hardwood';

  // Perserving Craft → route to Perserving Craft SPC product (not Pikes Peak)
  if (c.includes('perserving'))            return null; // handled specially below

  // Generic 94" accessories — no collection routing, use color matching
  return null;
}

async function main() {
  const client = await pool.connect();

  try {
    // 1. Get vendor ID
    const { rows: [tw] } = await client.query(`SELECT id FROM vendors WHERE code = 'TW'`);
    if (!tw) { console.error('Tri-West vendor not found'); return; }
    const vendorId = tw.id;

    // 2. Load all Hartco floor SKUs (target products)
    //    After 832 re-import, collections are "Hartco <Name>" and "Perserving Craft SPC..."
    const { rows: floorSkus } = await client.query(`
      SELECT s.id as sku_id, s.variant_name, s.product_id, p.name as product_name, p.collection
      FROM skus s
      JOIN products p ON p.id = s.product_id
      WHERE (p.collection LIKE 'Hartco%' OR p.collection LIKE 'Perserving%')
        AND s.variant_type IS DISTINCT FROM 'accessory'
    `);

    console.log(`Loaded ${floorSkus.length} Hartco/Perserving flooring SKUs`);

    // Build color → product_id lookup (multiple indexes for fuzzy matching)
    const colorToProduct = new Map();  // normalized color → { product_id, product_name }
    const baseToProduct = new Map();   // base color → { product_id, product_name }

    for (const f of floorSkus) {
      const n = norm(f.variant_name);
      const b = baseColor(f.variant_name);
      if (n && !colorToProduct.has(n)) {
        colorToProduct.set(n, { product_id: f.product_id, product_name: f.product_name });
      }
      if (b && !baseToProduct.has(b)) {
        baseToProduct.set(b, { product_id: f.product_id, product_name: f.product_name });
      }
    }

    console.log(`Color index: ${colorToProduct.size} exact, ${baseToProduct.size} base`);

    // Product name → product_id for collection-based overrides
    const nameToProductId = new Map();
    for (const f of floorSkus) {
      if (!nameToProductId.has(f.product_name)) {
        nameToProductId.set(f.product_name, f.product_id);
      }
    }

    // Also index by collection for Perserving
    const collToProductId = new Map();
    for (const f of floorSkus) {
      if (!collToProductId.has(f.collection)) {
        collToProductId.set(f.collection, { product_id: f.product_id, product_name: f.product_name });
      }
    }

    // 3. Load accessory SKUs from 832-imported AHF/Hartco accessory products
    //    After the re-import, these live under their own collections with descriptive names
    const { rows: accSkus } = await client.query(`
      SELECT s.id as sku_id, s.variant_name, s.product_id as old_product_id,
             p.name as old_product_name, p.collection as old_collection, s.variant_type
      FROM skus s
      JOIN products p ON p.id = s.product_id
      WHERE p.vendor_id = $1
        AND (
          -- Collection-specific accessories
          p.collection ILIKE 'Coastal Highway%'
          OR p.collection ILIKE 'Necessity%'
          OR p.collection ILIKE 'Tb Gold%'
          OR p.collection ILIKE 'Tb Silver%'
          OR p.collection ILIKE 'Tb Platinum%'
          OR p.collection ILIKE 'Hydroblock%'
          OR p.collection ILIKE 'Perserving%'
          -- Generic 94" accessories (shared across AHF collections)
          OR p.collection IN (
            'Quarter Round 94', 'Reducer 94', 'T-molding 94',
            'Threshold 94', 'Flush Stairnose 94', 'Flush Stair Nose 94',
            'Multipurpose Reducer 94'
          )
        )
        AND NOT (p.collection LIKE 'Hartco%')
      ORDER BY p.collection, p.name, s.variant_name
    `, [vendorId]);

    console.log(`Found ${accSkus.length} accessory SKUs to process`);

    // 4. Match each accessory to a floor product
    let matched = 0, unmatched = 0;
    const moves = [];
    const nomatch = [];

    for (const acc of accSkus) {
      const color = acc.variant_name;
      const oldColl = acc.old_collection;
      let target = null;
      let reason = '';

      // Strategy 1: Route by collection name
      const routed = routeByCollection(oldColl);
      if (routed && nameToProductId.has(routed)) {
        target = { product_id: nameToProductId.get(routed), product_name: routed };
        reason = `collection-route: ${oldColl}`;
      }

      // Strategy 1b: Perserving → find by collection prefix
      if (!target && oldColl.toLowerCase().includes('perserving')) {
        for (const [coll, info] of collToProductId.entries()) {
          if (coll.toLowerCase().startsWith('perserving')) {
            target = info;
            reason = `collection-route: Perserving→${coll}`;
            break;
          }
        }
      }

      // Strategy 2: Color-name matching (only for generic 94" or if collection route didn't work)
      if (!target) {
        const n = norm(color);
        const b = baseColor(color);

        if (colorToProduct.has(n)) {
          target = colorToProduct.get(n);
          reason = `color-exact: "${n}"`;
        } else if (baseToProduct.has(b)) {
          target = baseToProduct.get(b);
          reason = `color-base: "${b}"`;
        }

        // Strategy 3: Try each part of compound color names (comma/slash separated)
        if (!target && /[,\/]/.test(color)) {
          const parts = color.split(/[,\/]/).map(p => p.trim());
          for (const part of parts) {
            const pn = norm(part);
            const pb = baseColor(part);
            if (colorToProduct.has(pn)) {
              target = colorToProduct.get(pn);
              reason = `color-compound: "${pn}"`;
              break;
            }
            if (baseToProduct.has(pb)) {
              target = baseToProduct.get(pb);
              reason = `color-compound-base: "${pb}"`;
              break;
            }
          }
        }
      }

      if (target && target.product_id) {
        moves.push({
          sku_id: acc.sku_id,
          old_product_id: acc.old_product_id,
          new_product_id: target.product_id,
          new_product_name: target.product_name,
          color,
          reason
        });
        matched++;
      } else {
        nomatch.push({ sku_id: acc.sku_id, color, old_product_name: acc.old_product_name, old_collection: oldColl });
        unmatched++;
      }
    }

    console.log(`\nMatched: ${matched}, Unmatched: ${unmatched}`);

    // Show matches by target product
    const byProduct = {};
    for (const m of moves) {
      byProduct[m.new_product_name] = (byProduct[m.new_product_name] || 0) + 1;
    }
    console.log('\nAccessories per target product:');
    for (const [name, count] of Object.entries(byProduct).sort()) {
      console.log(`  ${name}: ${count}`);
    }

    if (nomatch.length > 0) {
      console.log(`\nUnmatched accessories (${nomatch.length}):`);
      for (const n of nomatch.slice(0, 30)) {
        console.log(`  "${n.color}" from "${n.old_product_name}" [${n.old_collection}]`);
      }
      if (nomatch.length > 30) console.log(`  ... and ${nomatch.length - 30} more`);
    }

    if (DRY_RUN) {
      console.log('\n[DRY RUN] No changes made.');
      return;
    }

    // 5. Execute moves in a transaction
    await client.query('BEGIN');

    for (const m of moves) {
      await client.query(`
        UPDATE skus SET product_id = $1, variant_type = 'accessory', sell_by = 'unit'
        WHERE id = $2
      `, [m.new_product_id, m.sku_id]);

      await client.query(`
        UPDATE media_assets SET product_id = $1
        WHERE sku_id = $2
      `, [m.new_product_id, m.sku_id]);
    }

    await client.query('COMMIT');
    console.log(`\nMoved ${moves.length} accessory SKUs to Hartco products.`);

    // 6. Clean up empty products (any collection that had accessories moved out)
    const { rows: orphans } = await client.query(`
      SELECT p.id, p.name, p.collection
      FROM products p
      LEFT JOIN skus s ON s.product_id = p.id
      WHERE p.vendor_id = $1
        AND (
          p.collection ILIKE 'Coastal Highway%'
          OR p.collection ILIKE 'Necessity%'
          OR p.collection ILIKE 'Tb Gold%'
          OR p.collection ILIKE 'Tb Silver%'
          OR p.collection ILIKE 'Tb Platinum%'
          OR p.collection ILIKE 'Hydroblock%'
          OR p.collection ILIKE 'Perserving%'
          OR p.collection IN ('Quarter Round 94','Reducer 94','T-molding 94','Threshold 94','Flush Stairnose 94','Flush Stair Nose 94','Multipurpose Reducer 94')
        )
        AND s.id IS NULL
    `, [vendorId]);

    if (orphans.length > 0) {
      console.log(`\nOrphaned products to clean up: ${orphans.length}`);
      for (const o of orphans) {
        console.log(`  Deleting: ${o.name} [${o.collection}]`);
        await client.query(`DELETE FROM media_assets WHERE product_id = $1`, [o.id]);
        await client.query(`DELETE FROM products WHERE id = $1`, [o.id]);
      }
    }

  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
