#!/usr/bin/env node
/**
 * restructure-daltile-products.cjs
 *
 * Restructures Daltile's ~941 active products into a clean hierarchy:
 *   - One "main" product per collection contains all color/size variants
 *   - Trim (bullnose, cove base, jolly, etc.) and transition (stair nose,
 *     quarter round, end cap, etc.) products are merged as accessory SKUs
 *   - Single-color orphans (<=2 SKUs duplicating colors on the main) are merged
 *   - PTS Professional products merge into their collection
 *   - Mosaics, direct-mount, and paver products stay separate
 *   - Categories corrected based on dominant variant_type
 *
 * Expected: ~941 → ~550 products. Zero SKUs lost.
 *
 * Usage:
 *   node backend/scripts/restructure-daltile-products.cjs --dry-run
 *   node backend/scripts/restructure-daltile-products.cjs
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

// ─────────────────────────────────────────────────────────────────────────────
// Classification patterns
// ─────────────────────────────────────────────────────────────────────────────

const MAIN_VARIANT_TYPES = new Set([
  'floor_tile', 'wall_tile', 'stone_tile', 'quarry_tile', 'lvt',
]);

// Patterns that indicate TRIM products — order matters (longer matches first)
const TRIM_PATTERNS = [
  { re: /cv\s*base\s*out\s*c(?:o)?rn/i, label: 'Cove Base Corner' },
  { re: /sntry\s*cv/i, label: 'Sanitary Cove' },
  { re: /cv\s*b(?:as)?e|cv\s*bc/i, label: 'Cove Base' },
  { re: /pencil\s*liner/i, label: 'Pencil Liner' },
  { re: /bullnose|(?:^|\s)bn\s/i, label: 'Bullnose' },
  { re: /jolly/i, label: 'Jolly' },
  { re: /chair\s*rail/i, label: 'Chair Rail' },
  { re: /shelf\s*rail/i, label: 'Shelf Rail' },
  { re: /sink\s*rail/i, label: 'Sink Rail' },
  { re: /liner/i, label: 'Liner' },
  { re: /ogee/i, label: 'Ogee' },
  { re: /rope/i, label: 'Rope' },
];

// Patterns that indicate TRANSITION products
const TRANSITION_PATTERNS = [
  { re: /overlap\s*stair\s*nose|stp\s*ns/i, label: 'Stair Nose' },
  { re: /round\s*stair\s*tread/i, label: 'Stair Tread' },
  { re: /stair\s*cap|vscap/i, label: 'Stair Cap' },
  { re: /end\s*cap|vslcap/i, label: 'End Cap' },
  { re: /qrtr\s*round|vqrnd/i, label: 'Quarter Round' },
  { re: /4-in-1|slimt/i, label: '4-In-1 Transition' },
  { re: /(?:^|\s)cop\s|coping/i, label: 'Coping' },
  { re: /accessor/i, label: 'Accessory' },
];

// Products to keep separate (not merged)
const MOSAIC_RE = /(?:^|\s)mm(?:\s|$)|mosaic|herringbone|hexagon|basketweave/i;
const DIRECT_MOUNT_RE = /(?:^|\s)dm(?:\s|$)|direct\s*mount/i;
const PAVER_RE = /xterior|paver|(?:^|\s)tread(?:\s|$)/i;
const PTS_RE = /^pts\s/i;
const LVF_RE = /^lvf\s/i;

// Category mapping by dominant variant_type
const CATEGORY_MAP = {
  floor_tile: 'Porcelain Tile',
  wall_tile: 'Backsplash Tile',
  mosaic: 'Mosaic Tile',
  lvt: 'LVP (Plank)',
  stone_tile: 'Natural Stone',
  quarry_tile: 'Porcelain Tile',
  floor_deco: 'Mosaic Tile',
  wall_deco: 'Mosaic Tile',
  bath_accessory: 'Bath Accessories',
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Classify a product name into TRIM, TRANSITION, MOSAIC, DIRECT_MOUNT, PAVER, or PTS.
 * Returns { class, label } or null if it's a main/standard product.
 */
function classifyProduct(name) {
  if (!name) return null;

  // Check keep-separate types first
  if (MOSAIC_RE.test(name)) return { class: 'MOSAIC', label: null };
  if (DIRECT_MOUNT_RE.test(name)) return { class: 'DIRECT_MOUNT', label: null };
  if (PAVER_RE.test(name)) return { class: 'PAVER', label: null };

  // Check PTS
  if (PTS_RE.test(name)) return { class: 'PTS', label: null };

  // Check LVF (these are per-color accessory products)
  if (LVF_RE.test(name)) return { class: 'LVF', label: null };

  // Check trim patterns
  for (const { re, label } of TRIM_PATTERNS) {
    if (re.test(name)) return { class: 'TRIM', label };
  }

  // Check transition patterns
  for (const { re, label } of TRANSITION_PATTERNS) {
    if (re.test(name)) return { class: 'TRANSITION', label };
  }

  return null; // Standard product (potential main or single-color orphan)
}

/**
 * Extract a trim/transition type label from a product name.
 * Used for building descriptive variant_name values.
 */
function extractTrimLabel(name) {
  // Try trim patterns first (order matters)
  for (const { re, label } of TRIM_PATTERNS) {
    if (re.test(name)) return label;
  }
  for (const { re, label } of TRANSITION_PATTERNS) {
    if (re.test(name)) return label;
  }
  return 'Accessory';
}

/**
 * Build a descriptive variant_name for an accessory SKU.
 * Format: "{Color} {TrimType}" — e.g., "Taupe Bullnose"
 */
function buildAccessoryVariantName(existingVariantName, trimLabel) {
  const color = (existingVariantName || '').trim();
  if (color) return `${color} ${trimLabel}`;
  return trimLabel;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n=== Restructure Daltile Products ${DRY_RUN ? '(DRY RUN)' : '(LIVE)'} ===\n`);

  // 1. Find Daltile vendor
  const vendorRes = await pool.query("SELECT id, name FROM vendors WHERE code = 'DAL'");
  if (vendorRes.rows.length === 0) {
    console.error('Vendor DAL not found');
    process.exit(1);
  }
  const vendorId = vendorRes.rows[0].id;
  console.log(`Vendor: ${vendorRes.rows[0].name} (${vendorId})`);

  // 2. Load all active Daltile products with SKU details
  const productsRes = await pool.query(`
    SELECT p.id, p.name, p.collection, p.category_id, p.status,
      (SELECT COUNT(*) FROM skus WHERE product_id = p.id AND status = 'active') as sku_count,
      (SELECT COUNT(*) FROM media_assets WHERE product_id = p.id) as image_count
    FROM products p
    WHERE p.vendor_id = $1 AND p.status = 'active'
    ORDER BY p.collection, p.name
  `, [vendorId]);

  const products = productsRes.rows;
  console.log(`Active Daltile products: ${products.length}\n`);

  // Load all SKUs with their variant info
  const skusRes = await pool.query(`
    SELECT s.id, s.product_id, s.vendor_sku, s.variant_name, s.variant_type,
           s.sell_by, s.status
    FROM skus s
    JOIN products p ON p.id = s.product_id
    WHERE p.vendor_id = $1 AND p.status = 'active' AND s.status = 'active'
    ORDER BY s.vendor_sku
  `, [vendorId]);

  // Build product → SKUs map
  const skusByProduct = new Map();
  for (const s of skusRes.rows) {
    if (!skusByProduct.has(s.product_id)) skusByProduct.set(s.product_id, []);
    skusByProduct.get(s.product_id).push(s);
  }

  console.log(`Active SKUs: ${skusRes.rows.length}\n`);

  // 3. Group products by collection
  const collections = new Map(); // collection → product[]
  for (const p of products) {
    const coll = (p.collection || '').trim();
    if (!coll) continue;
    if (!collections.has(coll)) collections.set(coll, []);
    collections.get(coll).push(p);
  }

  console.log(`Collections: ${collections.size}\n`);

  // 4. Build merge plan per collection
  const mergePlan = []; // { source, target, skus, class, trimLabel }
  const skipSeparate = []; // Products kept separate (MOSAIC, DM, PAVER)
  const collectionsProcessed = [];

  for (const [collName, collProducts] of collections) {
    // Classify each product
    const classified = collProducts.map(p => ({
      ...p,
      classification: classifyProduct(p.name),
      skus: skusByProduct.get(p.id) || [],
      skuCount: parseInt(p.sku_count) || 0,
    }));

    // Step 1: Identify the "main" product
    // Prefer the product with the most SKUs that has a main variant_type
    const mainCandidates = classified
      .filter(p => !p.classification) // unclassified = potential main
      .sort((a, b) => {
        // Prefer products with main variant_types
        const aHasMain = a.skus.some(s => MAIN_VARIANT_TYPES.has(s.variant_type));
        const bHasMain = b.skus.some(s => MAIN_VARIANT_TYPES.has(s.variant_type));
        if (aHasMain !== bHasMain) return bHasMain ? 1 : -1;
        // Then by SKU count
        return b.skuCount - a.skuCount;
      });

    // If no unclassified products, fall back to any product with most SKUs
    let mainProduct = mainCandidates[0] || classified
      .filter(p => !p.classification || p.classification.class === 'PTS')
      .sort((a, b) => b.skuCount - a.skuCount)[0];

    // If still no main (entire collection is trim/transitions), pick the one with most SKUs
    if (!mainProduct) {
      mainProduct = classified.sort((a, b) => b.skuCount - a.skuCount)[0];
      if (!mainProduct) continue;
    }

    const collResult = {
      collection: collName,
      mainProduct: mainProduct.name,
      mainSkuCount: mainProduct.skuCount,
      merges: [],
      kept: [],
    };

    // Step 2: Classify and plan merges for other products
    for (const p of classified) {
      if (p.id === mainProduct.id) continue;
      if (p.skuCount === 0) continue; // Skip empty products

      const cls = p.classification;

      if (!cls) {
        // Unclassified: check if it's a SINGLE_COLOR orphan
        if (p.skuCount <= 2) {
          // Check if color code prefix exists in main product
          const pSkuCodes = new Set(p.skus.map(s => (s.vendor_sku || '').toUpperCase().slice(0, 4)));
          const mainSkus = skusByProduct.get(mainProduct.id) || [];
          const mainCodes = new Set(mainSkus.map(s => (s.vendor_sku || '').toUpperCase().slice(0, 4)));
          const codesOverlap = [...pSkuCodes].some(c => mainCodes.has(c));

          if (codesOverlap) {
            // Single-color orphan — merge, keep existing variant_type
            mergePlan.push({
              source: p,
              target: mainProduct,
              collection: collName,
              class: 'SINGLE_COLOR',
              trimLabel: null,
              skus: p.skus,
            });
            collResult.merges.push({ name: p.name, class: 'SINGLE_COLOR', skuCount: p.skuCount });
            continue;
          }
        }
        // Not an orphan — keep separate
        collResult.kept.push({ name: p.name, reason: 'distinct product' });
        continue;
      }

      switch (cls.class) {
        case 'TRIM':
        case 'TRANSITION':
          mergePlan.push({
            source: p,
            target: mainProduct,
            collection: collName,
            class: cls.class,
            trimLabel: cls.label,
            skus: p.skus,
          });
          collResult.merges.push({ name: p.name, class: cls.class, label: cls.label, skuCount: p.skuCount });
          break;

        case 'PTS':
          mergePlan.push({
            source: p,
            target: mainProduct,
            collection: collName,
            class: 'PTS',
            trimLabel: null,
            skus: p.skus,
          });
          collResult.merges.push({ name: p.name, class: 'PTS', skuCount: p.skuCount });
          break;

        case 'LVF':
          // LVF products are per-color accessory breakouts — merge as accessories
          // Determine trim label from SKU codes
          for (const sku of p.skus) {
            const u = (sku.vendor_sku || '').toUpperCase();
            let label = 'Accessory';
            if (/RNDSTRD/i.test(u)) label = 'Stair Tread';
            else if (/SLIMT/i.test(u)) label = '4-In-1 Transition';
            else if (/VSLCAP/i.test(u)) label = 'End Cap';
            else if (/VQRND/i.test(u)) label = 'Quarter Round';
            else if (/VRDSN|VSNP/i.test(u)) label = 'Stair Nose';
            else if (/EXTSN/i.test(u)) label = 'Stair Nose';
            else if (/VSCAP/i.test(u)) label = 'Stair Cap';
            else if (/4IN1/i.test(u)) label = '4-In-1 Transition';
            // Each LVF SKU gets its own label based on SKU code
            sku._trimLabel = label;
          }
          mergePlan.push({
            source: p,
            target: mainProduct,
            collection: collName,
            class: 'LVF',
            trimLabel: null, // Per-SKU labels stored on sku._trimLabel
            skus: p.skus,
          });
          collResult.merges.push({ name: p.name, class: 'LVF', skuCount: p.skuCount });
          break;

        case 'MOSAIC':
        case 'DIRECT_MOUNT':
        case 'PAVER':
          skipSeparate.push({ product: p, reason: cls.class });
          collResult.kept.push({ name: p.name, reason: cls.class });
          break;
      }
    }

    collectionsProcessed.push(collResult);
  }

  // ─── Report ─────────────────────────────────────────────────────────────────

  // Count by class
  const classCounts = {};
  for (const m of mergePlan) {
    classCounts[m.class] = (classCounts[m.class] || 0) + 1;
  }

  const totalSkusToMove = mergePlan.reduce((sum, m) => sum + m.skus.length, 0);
  const sourceProductIds = new Set(mergePlan.map(m => m.source.id));

  console.log('=== Merge Plan Summary ===');
  console.log(`  Products to merge:     ${sourceProductIds.size}`);
  console.log(`  SKUs to move:          ${totalSkusToMove}`);
  console.log(`  By class:`);
  for (const [cls, cnt] of Object.entries(classCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${cls.padEnd(15)} ${cnt}`);
  }
  console.log(`  Products kept separate: ${skipSeparate.length} (mosaic/dm/paver)`);
  console.log(`  Expected result:       ~${products.length - sourceProductIds.size} products\n`);

  // Show per-collection detail (top 20)
  const collectionsWithMerges = collectionsProcessed.filter(c => c.merges.length > 0);
  console.log(`Collections with merges: ${collectionsWithMerges.length}\n`);

  if (DRY_RUN) {
    console.log('--- Per-collection merge plan (showing all) ---\n');
    for (const c of collectionsWithMerges.sort((a, b) => b.merges.length - a.merges.length)) {
      const mergeSkus = c.merges.reduce((s, m) => s + m.skuCount, 0);
      console.log(`  ${c.collection}:`);
      console.log(`    Main: "${c.mainProduct}" (${c.mainSkuCount} SKUs)`);
      console.log(`    Merging ${c.merges.length} products (${mergeSkus} SKUs):`);
      for (const m of c.merges) {
        console.log(`      ${(m.class).padEnd(14)} "${m.name}" (${m.skuCount} SKUs)${m.label ? ` → ${m.label}` : ''}`);
      }
      if (c.kept.length > 0) {
        console.log(`    Kept separate: ${c.kept.map(k => `"${k.name}" (${k.reason})`).join(', ')}`);
      }
    }
    console.log('\n[DRY RUN] No database changes made. Remove --dry-run to execute.\n');
    await pool.end();
    return;
  }

  // ─── Execute ────────────────────────────────────────────────────────────────

  console.log('-- Executing merges --\n');

  const stats = {
    skus_moved: 0,
    skus_set_accessory: 0,
    variant_names_updated: 0,
    media_reparented: 0,
    cart_items_updated: 0,
    quote_items_updated: 0,
    sample_items_updated: 0,
    visit_items_updated: 0,
    trade_favorites_updated: 0,
    estimate_items_updated: 0,
    install_inquiries_updated: 0,
    product_tags_merged: 0,
    wishlists_merged: 0,
    reviews_merged: 0,
    products_deactivated: 0,
    categories_fixed: 0,
    search_vectors_refreshed: 0,
    errors: 0,
  };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Track which target products received merges (for search vector refresh + category fix)
    const targetProductIds = new Set();

    // Process each merge
    for (const merge of mergePlan) {
      try {
        await client.query('SAVEPOINT merge_op');

        const { source, target, skus } = merge;
        targetProductIds.add(target.id);

        // Move each SKU to the target product
        for (const sku of skus) {
          // Determine new variant_type and variant_name
          let newVariantType = sku.variant_type;
          let newVariantName = sku.variant_name;
          let newSellBy = sku.sell_by;

          if (merge.class === 'TRIM' || merge.class === 'TRANSITION') {
            newVariantType = 'accessory';
            newSellBy = 'unit';
            const label = merge.trimLabel || extractTrimLabel(source.name);
            newVariantName = buildAccessoryVariantName(sku.variant_name, label);
            stats.skus_set_accessory++;
          } else if (merge.class === 'LVF') {
            newVariantType = 'accessory';
            newSellBy = 'unit';
            const label = sku._trimLabel || 'Accessory';
            newVariantName = buildAccessoryVariantName(sku.variant_name, label);
            stats.skus_set_accessory++;
          }
          // PTS and SINGLE_COLOR keep their existing variant_type

          if (newVariantName !== sku.variant_name) {
            stats.variant_names_updated++;
          }

          await client.query(`
            UPDATE skus
            SET product_id = $1,
                variant_type = $2,
                variant_name = $3,
                sell_by = $4,
                updated_at = NOW()
            WHERE id = $5
          `, [target.id, newVariantType, newVariantName, newSellBy, sku.id]);
          stats.skus_moved++;
        }

        // Re-parent SKU-level media assets
        const skuIds = skus.map(s => s.id);
        if (skuIds.length > 0) {
          await client.query(`
            UPDATE media_assets SET product_id = $1
            WHERE sku_id = ANY($2)
          `, [target.id, skuIds]);
        }

        // Handle product-level media: delete conflicts, then move rest
        await client.query(`
          DELETE FROM media_assets m
          WHERE m.product_id = $2 AND m.sku_id IS NULL
            AND EXISTS (
              SELECT 1 FROM media_assets e
              WHERE e.product_id = $1 AND e.sku_id IS NULL
                AND e.asset_type = m.asset_type AND e.sort_order = m.sort_order
            )
        `, [target.id, source.id]);

        const maxSortRes = await client.query(`
          SELECT COALESCE(MAX(sort_order), -1) + 1 as next_sort
          FROM media_assets WHERE product_id = $1 AND sku_id IS NULL
        `, [target.id]);
        let nextSort = parseInt(maxSortRes.rows[0].next_sort) || 0;

        const remainingMedia = await client.query(`
          SELECT id FROM media_assets WHERE product_id = $1 AND sku_id IS NULL ORDER BY sort_order
        `, [source.id]);

        for (const row of remainingMedia.rows) {
          await client.query(
            `UPDATE media_assets SET product_id = $1, sort_order = $2 WHERE id = $3`,
            [target.id, nextSort++, row.id]
          );
          stats.media_reparented++;
        }

        // Update FK references on live tables
        let res;

        // cart_items
        res = await client.query(
          `UPDATE cart_items SET product_id = $1 WHERE product_id = $2`,
          [target.id, source.id]
        );
        stats.cart_items_updated += res.rowCount;

        // quote_items (active quotes only)
        res = await client.query(`
          UPDATE quote_items qi SET product_id = $1
          FROM quotes q
          WHERE qi.quote_id = q.id AND qi.product_id = $2
            AND q.status NOT IN ('cancelled', 'expired')
        `, [target.id, source.id]);
        stats.quote_items_updated += res.rowCount;

        // sample_request_items
        res = await client.query(
          `UPDATE sample_request_items SET product_id = $1 WHERE product_id = $2`,
          [target.id, source.id]
        );
        stats.sample_items_updated += res.rowCount;

        // showroom_visit_items
        res = await client.query(
          `UPDATE showroom_visit_items SET product_id = $1 WHERE product_id = $2`,
          [target.id, source.id]
        );
        stats.visit_items_updated += res.rowCount;

        // trade_favorite_items
        res = await client.query(
          `UPDATE trade_favorite_items SET product_id = $1 WHERE product_id = $2`,
          [target.id, source.id]
        );
        stats.trade_favorites_updated += res.rowCount;

        // estimate_items
        res = await client.query(
          `UPDATE estimate_items SET product_id = $1 WHERE product_id = $2`,
          [target.id, source.id]
        );
        stats.estimate_items_updated += res.rowCount;

        // installation_inquiries
        res = await client.query(
          `UPDATE installation_inquiries SET product_id = $1 WHERE product_id = $2`,
          [target.id, source.id]
        );
        stats.install_inquiries_updated += res.rowCount;

        // product_tags — merge then delete source's tags
        res = await client.query(`
          INSERT INTO product_tags (product_id, tag_id)
          SELECT $1, pt.tag_id FROM product_tags pt
          WHERE pt.product_id = $2
          ON CONFLICT (product_id, tag_id) DO NOTHING
        `, [target.id, source.id]);
        stats.product_tags_merged += res.rowCount;
        await client.query(
          `DELETE FROM product_tags WHERE product_id = $1`,
          [source.id]
        );

        // wishlists — merge then delete
        res = await client.query(`
          INSERT INTO wishlists (customer_id, product_id, created_at)
          SELECT w.customer_id, $1, w.created_at FROM wishlists w
          WHERE w.product_id = $2
          ON CONFLICT (customer_id, product_id) DO NOTHING
        `, [target.id, source.id]);
        stats.wishlists_merged += res.rowCount;
        await client.query(
          `DELETE FROM wishlists WHERE product_id = $1`,
          [source.id]
        );

        // product_reviews — merge then delete
        res = await client.query(`
          INSERT INTO product_reviews (product_id, customer_id, rating, title, body, created_at)
          SELECT $1, r.customer_id, r.rating, r.title, r.body, r.created_at
          FROM product_reviews r
          WHERE r.product_id = $2
          ON CONFLICT (product_id, customer_id) DO NOTHING
        `, [target.id, source.id]);
        stats.reviews_merged += res.rowCount;
        await client.query(
          `DELETE FROM product_reviews WHERE product_id = $1`,
          [source.id]
        );

        await client.query('RELEASE SAVEPOINT merge_op');
      } catch (err) {
        await client.query('ROLLBACK TO SAVEPOINT merge_op');
        console.error(`  Error merging "${merge.source.name}" → "${merge.target.name}":`, err.message);
        stats.errors++;
      }
    }

    // ── Deactivate empty source products ──────────────────────────────────────

    const processedSources = new Set(mergePlan.map(m => m.source.id));
    for (const sourceId of processedSources) {
      try {
        await client.query('SAVEPOINT deactivate_op');

        // Verify no active SKUs remain
        const remaining = await client.query(
          `SELECT COUNT(*) as cnt FROM skus WHERE product_id = $1 AND status = 'active'`,
          [sourceId]
        );

        if (parseInt(remaining.rows[0].cnt) === 0) {
          // Check for historical order references
          const orderRefs = await client.query(
            `SELECT COUNT(*) FROM order_items WHERE product_id = $1`,
            [sourceId]
          );
          const hasOrderRefs = parseInt(orderRefs.rows[0].count) > 0;

          if (hasOrderRefs) {
            // Archive instead of deleting to preserve order history
            await client.query(`
              UPDATE products SET status = 'archived', is_active = false,
                name = name || ' [merged]', updated_at = NOW()
              WHERE id = $1
            `, [sourceId]);
          } else {
            // Safe to fully deactivate
            await client.query(`
              UPDATE products SET status = 'inactive',
                name = name || ' [merged]', updated_at = NOW()
              WHERE id = $1
            `, [sourceId]);
          }
          stats.products_deactivated++;
        } else {
          console.log(`  Warning: source product ${sourceId} still has ${remaining.rows[0].cnt} active SKUs`);
        }

        await client.query('RELEASE SAVEPOINT deactivate_op');
      } catch (err) {
        await client.query('ROLLBACK TO SAVEPOINT deactivate_op');
        console.error(`  Error deactivating source ${sourceId}:`, err.message);
        stats.errors++;
      }
    }

    // ── Fix categories on remaining active products ───────────────────────────

    // Load category lookup
    const catRes = await client.query(`SELECT id, name FROM categories WHERE is_active = true`);
    const categoryByName = new Map();
    for (const c of catRes.rows) {
      categoryByName.set(c.name, c.id);
    }

    // Get all active Daltile products (including those that just received merges)
    const activeProducts = await client.query(`
      SELECT p.id, p.category_id
      FROM products p
      WHERE p.vendor_id = $1 AND p.status = 'active'
    `, [vendorId]);

    for (const p of activeProducts.rows) {
      try {
        // Get dominant variant_type for this product
        const vtRes = await client.query(`
          SELECT variant_type, COUNT(*) as cnt
          FROM skus
          WHERE product_id = $1 AND status = 'active' AND variant_type != 'accessory'
          GROUP BY variant_type
          ORDER BY cnt DESC
          LIMIT 1
        `, [p.id]);

        if (vtRes.rows.length === 0) continue;

        const dominantType = vtRes.rows[0].variant_type;
        const targetCatName = CATEGORY_MAP[dominantType];
        if (!targetCatName) continue;

        const targetCatId = categoryByName.get(targetCatName);
        if (!targetCatId) continue;

        if (p.category_id !== targetCatId) {
          await client.query(
            `UPDATE products SET category_id = $1, updated_at = NOW() WHERE id = $2`,
            [targetCatId, p.id]
          );
          stats.categories_fixed++;
        }
      } catch (err) {
        // Non-fatal — category fix is best-effort
        console.error(`  Error fixing category for product ${p.id}:`, err.message);
      }
    }

    // ── Refresh search vectors on target products ─────────────────────────────

    for (const pid of targetProductIds) {
      try {
        await client.query(`SELECT refresh_search_vectors($1)`, [pid]);
        stats.search_vectors_refreshed++;
      } catch (e) {
        // Function may not exist — non-fatal
      }
    }

    await client.query('COMMIT');
    console.log('Transaction committed successfully.\n');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Transaction rolled back:', err.message);
    process.exit(1);
  } finally {
    client.release();
  }

  // ── Results ─────────────────────────────────────────────────────────────────

  console.log('=== Results ===');
  console.log(`SKUs moved:               ${stats.skus_moved}`);
  console.log(`SKUs set to accessory:    ${stats.skus_set_accessory}`);
  console.log(`Variant names updated:    ${stats.variant_names_updated}`);
  console.log(`Media assets reparented:  ${stats.media_reparented}`);
  console.log(`Products deactivated:     ${stats.products_deactivated}`);
  console.log(`Categories fixed:         ${stats.categories_fixed}`);
  console.log(`Search vectors refreshed: ${stats.search_vectors_refreshed}`);
  if (stats.cart_items_updated) console.log(`Cart items updated:       ${stats.cart_items_updated}`);
  if (stats.quote_items_updated) console.log(`Quote items updated:      ${stats.quote_items_updated}`);
  if (stats.sample_items_updated) console.log(`Sample items updated:     ${stats.sample_items_updated}`);
  if (stats.visit_items_updated) console.log(`Visit items updated:      ${stats.visit_items_updated}`);
  if (stats.trade_favorites_updated) console.log(`Trade favorites updated:  ${stats.trade_favorites_updated}`);
  if (stats.estimate_items_updated) console.log(`Estimate items updated:   ${stats.estimate_items_updated}`);
  if (stats.install_inquiries_updated) console.log(`Install inquiries updated:${stats.install_inquiries_updated}`);
  if (stats.product_tags_merged) console.log(`Product tags merged:      ${stats.product_tags_merged}`);
  if (stats.wishlists_merged) console.log(`Wishlists merged:         ${stats.wishlists_merged}`);
  if (stats.reviews_merged) console.log(`Reviews merged:           ${stats.reviews_merged}`);
  if (stats.errors > 0) console.log(`Errors:                   ${stats.errors}`);
  console.log('');

  // ── Verification ────────────────────────────────────────────────────────────

  console.log('=== Verification ===');

  const activeCount = await pool.query(
    `SELECT COUNT(*) FROM products WHERE vendor_id = $1 AND status = 'active'`,
    [vendorId]
  );
  console.log(`Active Daltile products: ${activeCount.rows[0].count} (was ${products.length})`);

  const totalSkuCount = await pool.query(`
    SELECT COUNT(*) FROM skus s
    JOIN products p ON p.id = s.product_id
    WHERE p.vendor_id = $1 AND s.status = 'active'
  `, [vendorId]);
  console.log(`Total active SKUs: ${totalSkuCount.rows[0].count} (was ${skusRes.rows.length})`);

  const accessoryCount = await pool.query(`
    SELECT COUNT(*) FROM skus s
    JOIN products p ON p.id = s.product_id
    WHERE p.vendor_id = $1 AND s.variant_type = 'accessory' AND s.status = 'active'
  `, [vendorId]);
  console.log(`Accessory SKUs: ${accessoryCount.rows[0].count}`);

  const deactivatedCount = await pool.query(
    `SELECT COUNT(*) FROM products WHERE vendor_id = $1 AND status IN ('inactive', 'archived') AND name LIKE '%[merged]%'`,
    [vendorId]
  );
  console.log(`Deactivated (merged) products: ${deactivatedCount.rows[0].count}`);

  // Spot-check collections
  console.log('\n--- Spot-check collections ---\n');
  const spotChecks = ['Synchronic', 'Affinity', 'Adventuro'];
  for (const coll of spotChecks) {
    const collProds = await pool.query(`
      SELECT p.name, p.status,
        (SELECT COUNT(*) FROM skus WHERE product_id = p.id AND status = 'active') as sku_count,
        (SELECT COUNT(*) FROM skus WHERE product_id = p.id AND status = 'active' AND variant_type = 'accessory') as acc_count
      FROM products p
      WHERE p.vendor_id = $1 AND p.collection = $2 AND p.status = 'active'
      ORDER BY p.name
    `, [vendorId, coll]);

    if (collProds.rows.length > 0) {
      console.log(`  ${coll}: ${collProds.rows.length} active products`);
      for (const r of collProds.rows) {
        console.log(`    "${r.name}" — ${r.sku_count} SKUs (${r.acc_count} accessories)`);
      }
    } else {
      console.log(`  ${coll}: no active products found`);
    }
  }

  // Category distribution
  console.log('\n--- Category distribution ---\n');
  const catDist = await pool.query(`
    SELECT c.name as category, COUNT(*) as cnt
    FROM products p
    JOIN categories c ON c.id = p.category_id
    WHERE p.vendor_id = $1 AND p.status = 'active'
    GROUP BY c.name
    ORDER BY cnt DESC
  `, [vendorId]);
  for (const r of catDist.rows) {
    console.log(`  ${r.category}: ${r.cnt}`);
  }

  console.log('');
  await pool.end();
}

main().catch(err => {
  console.error('Fatal error:', err);
  pool.end().finally(() => process.exit(1));
});
