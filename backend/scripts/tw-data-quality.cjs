#!/usr/bin/env node
/**
 * Tri-West Data Quality Enhancement
 *
 * Multi-phase cleanup script for the largest vendor (TW — ~12K products, ~16K SKUs).
 * Fixes the most impactful data quality issues from the bulk EDI 832 import:
 *
 *   Phase 1: Fix retail pricing (2,014 SKUs with cost but $0 retail → invisible)
 *   Phase 2: Title-case ALL CAPS product/SKU names
 *   Phase 3: Assign categories to uncategorized products via keyword matching
 *   Phase 4: Improve template descriptions
 *   Phase 5: Propagate images from collection siblings
 *   Phase 6: Propagate packaging from collection siblings
 *   Phase 7: Refresh search vectors for all modified TW products
 *
 * Each phase runs independently — partial failures don't block others.
 *
 * Usage:
 *   node backend/scripts/tw-data-quality.cjs --dry-run   # Preview changes
 *   node backend/scripts/tw-data-quality.cjs              # Execute cleanup
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

// ---------------------------------------------------------------------------
// Title-Case Helpers (shared with fix-product-data-quality.cjs / import-triwest-832.cjs)
// ---------------------------------------------------------------------------
const KEEP_UPPER = new Set([
  'SPC', 'WPC', 'LVP', 'LVT', 'PVC', 'HD', 'II', 'III', 'IV', 'AHF',
  'USA', 'UK', 'EU', 'XL', 'XX', 'CT', 'SF', 'SY',
]);
const KEEP_LOWER = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'in', 'at', 'to', 'for', 'by', 'on', 'with',
]);

function titleCaseEdi(text) {
  if (!text) return '';
  return text
    .split(/\s+/)
    .map((w, i) => {
      const upper = w.toUpperCase();
      if (KEEP_UPPER.has(upper)) return upper;
      if (i > 0 && KEEP_LOWER.has(w.toLowerCase())) return w.toLowerCase();
      if (w.length <= 1) return w.toUpperCase();
      return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    })
    .join(' ');
}

// ---------------------------------------------------------------------------
// Vendor ID helper
// ---------------------------------------------------------------------------
let _vendorId = null;
async function getVendorId() {
  if (_vendorId) return _vendorId;
  const res = await pool.query("SELECT id FROM vendors WHERE code = 'TW'");
  if (res.rows.length === 0) throw new Error('Vendor TW not found');
  _vendorId = res.rows[0].id;
  return _vendorId;
}

// ---------------------------------------------------------------------------
// Category cache
// ---------------------------------------------------------------------------
let _catCache = null;
async function getCategoryCache() {
  if (_catCache) return _catCache;
  const res = await pool.query('SELECT id, slug, name FROM categories WHERE is_active = true');
  _catCache = {};
  for (const row of res.rows) {
    _catCache[row.slug] = row.id;
    _catCache[row.name.toLowerCase()] = row.id;
  }
  return _catCache;
}

function resolveCategoryId(catCache, slugOrName) {
  if (!slugOrName) return null;
  return catCache[slugOrName] || catCache[slugOrName.toLowerCase()] || null;
}

// ---------------------------------------------------------------------------
// Phase 1: Fix Retail Pricing
// ---------------------------------------------------------------------------
async function phase1_fixRetailPricing() {
  console.log('\n=== Phase 1: Fix Retail Pricing (cost > 0, retail_price = 0) ===');

  const vendorId = await getVendorId();

  // Find SKUs with cost but zero retail
  const countRes = await pool.query(`
    SELECT COUNT(*) as cnt
    FROM pricing pr
    JOIN skus s ON s.id = pr.sku_id
    JOIN products p ON p.id = s.product_id
    WHERE p.vendor_id = $1
      AND p.is_active = true
      AND s.status = 'active'
      AND pr.cost > 0
      AND (pr.retail_price = 0 OR pr.retail_price IS NULL)
  `, [vendorId]);
  const count = parseInt(countRes.rows[0].cnt, 10);
  console.log(`  Found ${count} SKUs with cost > 0 but retail_price = 0`);

  if (count === 0) return 0;

  // Show breakdown by brand (collection)
  const brandBreakdown = await pool.query(`
    SELECT p.collection, COUNT(*) as cnt
    FROM pricing pr
    JOIN skus s ON s.id = pr.sku_id
    JOIN products p ON p.id = s.product_id
    WHERE p.vendor_id = $1
      AND p.is_active = true
      AND s.status = 'active'
      AND pr.cost > 0
      AND (pr.retail_price = 0 OR pr.retail_price IS NULL)
    GROUP BY p.collection
    ORDER BY cnt DESC
    LIMIT 10
  `, [vendorId]);
  console.log('  Top brands affected:');
  for (const row of brandBreakdown.rows) {
    console.log(`    ${row.collection || '(no collection)'}: ${row.cnt}`);
  }

  if (!DRY_RUN) {
    // Apply 2x cost markup (same as import-triwest-832.cjs)
    const result = await pool.query(`
      UPDATE pricing SET
        retail_price = ROUND(cost * 2, 2)
      WHERE sku_id IN (
        SELECT s.id FROM skus s
        JOIN products p ON p.id = s.product_id
        WHERE p.vendor_id = $1
          AND p.is_active = true
          AND s.status = 'active'
      )
      AND cost > 0
      AND (retail_price = 0 OR retail_price IS NULL)
    `, [vendorId]);
    console.log(`  ✓ Fixed ${result.rowCount} SKU prices (retail_price = cost × 2)`);
    return result.rowCount;
  } else {
    console.log(`  [DRY RUN] Would fix ${count} SKU prices (retail_price = cost × 2)`);
    return count;
  }
}

// ---------------------------------------------------------------------------
// Phase 2: Title-Case ALL CAPS Names
// ---------------------------------------------------------------------------
async function phase2_titleCaseNames() {
  console.log('\n=== Phase 2: Title-Case ALL CAPS Names ===');

  const vendorId = await getVendorId();

  // Find ALL CAPS products for this vendor
  const products = await pool.query(`
    SELECT id, name, collection FROM products
    WHERE vendor_id = $1
      AND is_active = true
      AND name = UPPER(name)
      AND LENGTH(name) > 2
  `, [vendorId]);
  console.log(`  Found ${products.rows.length} ALL CAPS products`);

  if (products.rows.length === 0 && !(await hasAllCapsSkus(vendorId))) {
    return { products: 0, collections: 0, skus: 0 };
  }

  let productCount = 0;
  let collectionCount = 0;
  const modifiedProductIds = [];

  for (const row of products.rows) {
    const newName = titleCaseEdi(row.name);
    const newCollection = (row.collection && row.collection === row.collection.toUpperCase() && row.collection.length > 2)
      ? titleCaseEdi(row.collection)
      : row.collection;

    if (newName === row.name && newCollection === row.collection) continue;

    if (!DRY_RUN) {
      await pool.query(
        `UPDATE products SET name = $1, collection = $2, updated_at = NOW() WHERE id = $3`,
        [newName, newCollection, row.id]
      );
    }
    productCount++;
    if (newCollection !== row.collection) collectionCount++;
    modifiedProductIds.push(row.id);

    if (productCount <= 5) {
      console.log(`  Example: "${row.name}" → "${newName}"`);
    }
  }

  // Title-case variant_name on ALL CAPS SKUs
  const skuRes = await pool.query(`
    SELECT s.id, s.variant_name, s.product_id FROM skus s
    JOIN products p ON p.id = s.product_id
    WHERE p.vendor_id = $1
      AND s.status = 'active'
      AND s.variant_name IS NOT NULL
      AND s.variant_name = UPPER(s.variant_name)
      AND LENGTH(s.variant_name) > 2
  `, [vendorId]);

  let skuCount = 0;
  for (const sku of skuRes.rows) {
    const newVariant = titleCaseEdi(sku.variant_name);
    if (newVariant === sku.variant_name) continue;

    if (!DRY_RUN) {
      await pool.query(
        `UPDATE skus SET variant_name = $1, updated_at = NOW() WHERE id = $2`,
        [newVariant, sku.id]
      );
    }
    skuCount++;
    if (!modifiedProductIds.includes(sku.product_id)) {
      modifiedProductIds.push(sku.product_id);
    }
  }

  const label = DRY_RUN ? '[DRY RUN] Would title-case' : '✓ Title-cased';
  console.log(`  ${label} ${productCount} products (${collectionCount} collections) + ${skuCount} SKU variant names`);
  return { products: productCount, collections: collectionCount, skus: skuCount };
}

async function hasAllCapsSkus(vendorId) {
  const res = await pool.query(`
    SELECT COUNT(*) as cnt FROM skus s
    JOIN products p ON p.id = s.product_id
    WHERE p.vendor_id = $1
      AND s.status = 'active'
      AND s.variant_name IS NOT NULL
      AND s.variant_name = UPPER(s.variant_name)
      AND LENGTH(s.variant_name) > 2
  `, [vendorId]);
  return parseInt(res.rows[0].cnt, 10) > 0;
}

// ---------------------------------------------------------------------------
// Phase 3: Fix Missing Categories
// ---------------------------------------------------------------------------

// Keyword patterns → category slug
// Order matters: more specific patterns should come first
const CATEGORY_KEYWORD_RULES = [
  // Stair & Treads — dedicated category exists
  // "Trd" is a common EDI abbreviation for "Tread"
  { pattern: /\b(?:stair|tread|nosing|stairnose|\btrd\b|grit\s*strip|safety\s*(?:rib|trd))\b/i, slug: 'stair-treads-nosing' },
  // Wall Base
  { pattern: /\b(?:wall\s*base|cove\s*base|rwb)\b/i, slug: 'wall-base' },
  // Rubber Flooring (Flexco-specific)
  { pattern: /\b(?:rubber\s*(?:floor|tile|sheet)|rrd|hammered)\b/i, slug: 'rubber-flooring' },
  // Transitions & Moldings
  { pattern: /\b(?:transition|t-mould?|t\s*mould?|reducer|end\s*cap|threshold|quarter\s*round|overlap|flush\s*stair)\b/i, slug: 'transitions-moldings' },
  // Adhesives & Sealants
  { pattern: /\b(?:adhesive|sealant|sika\b|tec\s|caulk|grout|mortar)\b/i, slug: 'adhesives-sealants' },
  // Surface Prep & Levelers
  { pattern: /\b(?:underlayment|moisture|leveler|self\s*level|primer|membrane)\b/i, slug: 'surface-prep-levelers' },
  // Carpet Tile
  { pattern: /\b(?:carpet\s*tile|nylon\s*tile|modular\s*tile)\b/i, slug: 'carpet-tile' },
  // Carpet (broadloom)
  { pattern: /\b(?:carpet|broadloom)\b/i, slug: 'carpet' },
  // Solid Hardwood (must check for 'solid' + wood species)
  { pattern: /\b(?:solid\s*(?:hardwood|oak|maple|birch|hickory|walnut|cherry|ash|beech))\b/i, slug: 'solid-hardwood' },
  // Engineered Hardwood (wood species + 'eng' or 'engineered')
  { pattern: /\b(?:(?:oak|maple|birch|hickory|walnut|cherry|ash|beech|acacia|teak)\s*.*\beng(?:ineered)?)\b/i, slug: 'engineered-hardwood' },
  { pattern: /\b(?:eng(?:ineered)?\s*(?:hardwood|oak|maple|birch|hickory|walnut|cherry|ash|beech))\b/i, slug: 'engineered-hardwood' },
  // LVP / Vinyl
  { pattern: /\b(?:vinyl|lvp|spc|wpc|luxury\s*vinyl)\b/i, slug: 'luxury-vinyl' },
  // Laminate
  { pattern: /\b(?:laminate)\b/i, slug: 'laminate' },
  // Tile
  { pattern: /\b(?:porcelain|ceramic)\b/i, slug: 'tile' },
];

// Brand → default category (from MFGR_CATEGORY in triwest-search.js)
const BRAND_DEFAULT_CATEGORY = {
  'provenza': 'engineered-hardwood',
  'bravada': 'engineered-hardwood',
  'mirage': 'engineered-hardwood',
  'paradigm': 'luxury-vinyl',
  'hardwoods specialty': 'engineered-hardwood',
  'true touch': 'engineered-hardwood',
  'bruce': 'engineered-hardwood',
  'forester': 'engineered-hardwood',
  'armstrong': 'luxury-vinyl',
  'metroflor': 'luxury-vinyl',
  'congoleum': 'luxury-vinyl',
  'ahf': 'luxury-vinyl',
  'babool': 'luxury-vinyl',
  'summit': 'luxury-vinyl',
  'kraus': 'luxury-vinyl',
  'quick-step': 'laminate',
  'quickstep': 'laminate',
  'stanton': 'carpet-tile',
  'sika': 'adhesives-sealants',
  'tec': 'adhesives-sealants',
  'flexco': 'wall-base',
  'jm cork': 'hardwood',
  'rc global': 'luxury-vinyl',
  'elysium': 'tile',
  'bosphorus': 'natural-stone',
  'hartco': 'engineered-hardwood',
  'shaw': 'engineered-hardwood',
  'grand pacific': 'engineered-hardwood',
};

async function phase3_fixCategories() {
  console.log('\n=== Phase 3: Fix Missing Categories ===');

  const vendorId = await getVendorId();
  const catCache = await getCategoryCache();

  // Find uncategorized TW products
  const uncategorized = await pool.query(`
    SELECT p.id, p.name, p.collection, p.description_short
    FROM products p
    WHERE p.vendor_id = $1
      AND p.is_active = true
      AND p.category_id IS NULL
  `, [vendorId]);
  console.log(`  Found ${uncategorized.rows.length} uncategorized products`);

  if (uncategorized.rows.length === 0) return { keyword: 0, sibling: 0 };

  let keywordCount = 0;
  let siblingCount = 0;
  const assigned = new Map(); // product_id → category_id

  // Pass 1: Keyword matching on name + collection
  for (const row of uncategorized.rows) {
    const searchText = `${row.name || ''} ${row.collection || ''} ${row.description_short || ''}`;

    for (const rule of CATEGORY_KEYWORD_RULES) {
      if (rule.pattern.test(searchText)) {
        const catId = resolveCategoryId(catCache, rule.slug);
        if (catId) {
          assigned.set(row.id, catId);
          keywordCount++;
          break;
        }
      }
    }

    // If no keyword match, try brand-based default
    if (!assigned.has(row.id) && row.collection) {
      const collLower = row.collection.toLowerCase().trim();
      for (const [brand, slug] of Object.entries(BRAND_DEFAULT_CATEGORY)) {
        if (collLower === brand || collLower.startsWith(brand + ' ') || collLower.startsWith(brand + '-')) {
          const catId = resolveCategoryId(catCache, slug);
          if (catId) {
            assigned.set(row.id, catId);
            keywordCount++;
            break;
          }
        }
      }
    }
  }

  // Pass 2: Sibling propagation — if another product in same collection has a category, use it
  const stillUncategorized = uncategorized.rows.filter(r => !assigned.has(r.id));
  if (stillUncategorized.length > 0) {
    const collections = [...new Set(stillUncategorized.map(r => r.collection).filter(Boolean))];

    for (const collection of collections) {
      // Find a categorized sibling
      const siblingRes = await pool.query(`
        SELECT DISTINCT category_id FROM products
        WHERE vendor_id = $1
          AND collection = $2
          AND category_id IS NOT NULL
          AND is_active = true
        LIMIT 1
      `, [vendorId, collection]);

      if (siblingRes.rows.length > 0) {
        const catId = siblingRes.rows[0].category_id;
        for (const row of stillUncategorized) {
          if (row.collection === collection && !assigned.has(row.id)) {
            assigned.set(row.id, catId);
            siblingCount++;
          }
        }
      }
    }
  }

  console.log(`  Matched: ${keywordCount} by keyword, ${siblingCount} by sibling`);
  console.log(`  Remaining uncategorized: ${uncategorized.rows.length - assigned.size}`);

  // Apply updates
  if (!DRY_RUN && assigned.size > 0) {
    for (const [productId, categoryId] of assigned) {
      await pool.query(
        `UPDATE products SET category_id = $1, updated_at = NOW() WHERE id = $2`,
        [categoryId, productId]
      );
    }
    console.log(`  ✓ Assigned categories to ${assigned.size} products`);
  } else if (DRY_RUN && assigned.size > 0) {
    console.log(`  [DRY RUN] Would assign categories to ${assigned.size} products`);

    // Show examples
    const examples = [...assigned.entries()].slice(0, 5);
    for (const [pid] of examples) {
      const row = uncategorized.rows.find(r => r.id === pid);
      if (row) {
        console.log(`    "${row.name}" (${row.collection}) → category assigned`);
      }
    }
  }

  return { keyword: keywordCount, sibling: siblingCount };
}

// ---------------------------------------------------------------------------
// Phase 4: Improve Descriptions
// ---------------------------------------------------------------------------
async function phase4_improveDescriptions() {
  console.log('\n=== Phase 4: Improve Descriptions ===');

  const vendorId = await getVendorId();

  // Find products with template-quality descriptions (the auto-generated ones
  // from the 832 import have the pattern: "NAME\n COLLECTION" or just construction|brand|sqft)
  // We update description_short to a slightly better template using brand/collection/name.
  const products = await pool.query(`
    SELECT p.id, p.name, p.collection, p.description_short
    FROM products p
    WHERE p.vendor_id = $1
      AND p.is_active = true
      AND p.description_short IS NOT NULL
      AND (
        p.description_short LIKE '%|%'
        OR p.description_short LIKE E'%\n%'
      )
  `, [vendorId]);
  console.log(`  Found ${products.rows.length} products with template descriptions`);

  if (products.rows.length === 0) return 0;

  // Identify which are truly template-quality (EDI auto-generated)
  // Pattern: "Construction | by Brand | SF/Box" or "NAME\n COLLECTION"
  const templatePattern = /^[^.!?]{3,}\s*\|/; // starts with text + pipe
  const newlinePattern = /\n/;

  let updateCount = 0;

  for (const row of products.rows) {
    const desc = row.description_short || '';
    const isTemplate = templatePattern.test(desc) || newlinePattern.test(desc);
    if (!isTemplate) continue;

    // Use title-cased name (Phase 2 runs first in real execution; for safety, re-apply)
    const name = titleCaseEdi(row.name || '');
    const collection = titleCaseEdi(row.collection || '');

    // Build a better description: "{name} by {brand}."
    // TW stores brand as collection field
    let newDesc;
    if (collection && collection !== name) {
      newDesc = `${name} by ${collection}.`;
    } else {
      newDesc = `${name}.`;
    }

    // Don't "improve" if it would be shorter/worse
    if (newDesc.length < 10) continue;

    if (!DRY_RUN) {
      await pool.query(
        `UPDATE products SET description_short = $1, updated_at = NOW() WHERE id = $2`,
        [newDesc, row.id]
      );
    }
    updateCount++;

    if (updateCount <= 5) {
      console.log(`  Example: "${desc.substring(0, 60)}..." → "${newDesc}"`);
    }
  }

  const label = DRY_RUN ? '[DRY RUN] Would improve' : '✓ Improved';
  console.log(`  ${label} ${updateCount} descriptions`);
  return updateCount;
}

// ---------------------------------------------------------------------------
// Phase 5: Propagate Images from Collection Siblings
// ---------------------------------------------------------------------------
async function phase5_propagateImages() {
  console.log('\n=== Phase 5: Propagate Images from Collection Siblings ===');

  const vendorId = await getVendorId();

  // Find products missing a primary image that have a sibling in the same
  // collection with a primary image
  const candidates = await pool.query(`
    SELECT target.id AS target_id, target.name, target.collection,
           source.id AS source_id, ma.url, ma.original_url
    FROM products target
    JOIN products source
      ON source.collection = target.collection
      AND source.vendor_id = target.vendor_id
      AND source.id != target.id
      AND source.is_active = true
    JOIN media_assets ma
      ON ma.product_id = source.id
      AND ma.asset_type = 'primary'
    WHERE target.vendor_id = $1
      AND target.is_active = true
      AND NOT EXISTS (
        SELECT 1 FROM media_assets ex
        WHERE ex.product_id = target.id AND ex.asset_type = 'primary'
      )
    ORDER BY target.id
  `, [vendorId]);

  // Deduplicate — only one image per target product (use the first source found)
  const seen = new Set();
  const toInsert = [];
  for (const row of candidates.rows) {
    if (seen.has(row.target_id)) continue;
    seen.add(row.target_id);
    toInsert.push(row);
  }

  console.log(`  Found ${toInsert.length} products that can inherit images from siblings`);

  if (toInsert.length === 0) return 0;

  if (!DRY_RUN) {
    let insertCount = 0;
    for (const row of toInsert) {
      try {
        await pool.query(`
          INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
          VALUES ($1, NULL, 'primary', $2, $3, 0)
        `, [row.target_id, row.url, row.original_url]);
        insertCount++;
      } catch (err) {
        // Skip unique constraint violations (race condition or duplicate)
        if (err.code !== '23505') throw err;
      }
    }
    console.log(`  ✓ Propagated images to ${insertCount} products`);
    return insertCount;
  } else {
    console.log(`  [DRY RUN] Would propagate images to ${toInsert.length} products`);
    if (toInsert.length > 0) {
      const examples = toInsert.slice(0, 3);
      for (const row of examples) {
        console.log(`    "${row.name}" (${row.collection}) ← image from sibling`);
      }
    }
    return toInsert.length;
  }
}

// ---------------------------------------------------------------------------
// Phase 6: Propagate Packaging from Collection Siblings
// ---------------------------------------------------------------------------
async function phase6_propagatePackaging() {
  console.log('\n=== Phase 6: Propagate Packaging from Collection Siblings ===');

  const vendorId = await getVendorId();

  // Find sqft SKUs missing packaging data that have a sibling in the same
  // collection with packaging
  const candidates = await pool.query(`
    SELECT target_sku.id AS target_sku_id,
           target_p.name AS product_name,
           target_p.collection,
           source_pkg.sqft_per_box,
           source_pkg.pieces_per_box,
           source_pkg.weight_per_box_lbs
    FROM skus target_sku
    JOIN products target_p ON target_p.id = target_sku.product_id
    LEFT JOIN packaging target_pkg ON target_pkg.sku_id = target_sku.id
    -- Find a sibling SKU in same collection with packaging
    CROSS JOIN LATERAL (
      SELECT pkg.sqft_per_box, pkg.pieces_per_box, pkg.weight_per_box_lbs
      FROM skus sib_sku
      JOIN products sib_p ON sib_p.id = sib_sku.product_id
      JOIN packaging pkg ON pkg.sku_id = sib_sku.id
      WHERE sib_p.vendor_id = $1
        AND sib_p.collection = target_p.collection
        AND sib_p.is_active = true
        AND sib_sku.status = 'active'
        AND sib_sku.sell_by = 'sqft'
        AND pkg.sqft_per_box IS NOT NULL
        AND pkg.sqft_per_box > 0
      LIMIT 1
    ) source_pkg
    WHERE target_p.vendor_id = $1
      AND target_p.is_active = true
      AND target_sku.status = 'active'
      AND target_sku.sell_by = 'sqft'
      AND (target_pkg.sku_id IS NULL OR target_pkg.sqft_per_box IS NULL OR target_pkg.sqft_per_box = 0)
  `, [vendorId]);

  console.log(`  Found ${candidates.rows.length} SKUs that can inherit packaging from siblings`);

  if (candidates.rows.length === 0) return 0;

  if (!DRY_RUN) {
    let upsertCount = 0;
    for (const row of candidates.rows) {
      await pool.query(`
        INSERT INTO packaging (sku_id, sqft_per_box, pieces_per_box, weight_per_box_lbs)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (sku_id) DO UPDATE SET
          sqft_per_box = COALESCE(NULLIF(packaging.sqft_per_box, 0), $2),
          pieces_per_box = COALESCE(packaging.pieces_per_box, $3),
          weight_per_box_lbs = COALESCE(packaging.weight_per_box_lbs, $4)
      `, [row.target_sku_id, row.sqft_per_box, row.pieces_per_box, row.weight_per_box_lbs]);
      upsertCount++;
    }
    console.log(`  ✓ Propagated packaging to ${upsertCount} SKUs`);
    return upsertCount;
  } else {
    console.log(`  [DRY RUN] Would propagate packaging to ${candidates.rows.length} SKUs`);
    // Show collection breakdown
    const collectionCounts = {};
    for (const row of candidates.rows) {
      collectionCounts[row.collection] = (collectionCounts[row.collection] || 0) + 1;
    }
    const topCollections = Object.entries(collectionCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
    for (const [coll, cnt] of topCollections) {
      console.log(`    ${coll}: ${cnt} SKUs`);
    }
    return candidates.rows.length;
  }
}

// ---------------------------------------------------------------------------
// Phase 7: Refresh Search Vectors
// ---------------------------------------------------------------------------
async function phase7_refreshSearchVectors() {
  console.log('\n=== Phase 7: Refresh Search Vectors ===');

  const vendorId = await getVendorId();

  if (DRY_RUN) {
    const countRes = await pool.query(`
      SELECT COUNT(*) as cnt FROM products
      WHERE vendor_id = $1 AND is_active = true
    `, [vendorId]);
    console.log(`  [DRY RUN] Would refresh search vectors for ${countRes.rows[0].cnt} TW products`);
    return parseInt(countRes.rows[0].cnt, 10);
  }

  // For a large vendor like TW, use the bulk refresh (no target_product_id)
  // but scope it to only TW products by calling the function with each product
  // Actually, the refresh_search_vectors function with NULL refreshes ALL products.
  // For TW-only, we do a direct UPDATE:
  console.log('  Refreshing search vectors for all TW products...');
  const result = await pool.query(`
    UPDATE products p SET search_vector =
      setweight(to_tsvector('english', unaccent(coalesce(p.name, ''))), 'A') ||
      setweight(to_tsvector('english', unaccent(coalesce(p.collection, ''))), 'A') ||
      setweight(to_tsvector('english', unaccent(coalesce(v.name, ''))), 'B') ||
      setweight(to_tsvector('english', unaccent(coalesce(
        (SELECT c.name FROM categories c WHERE c.id = p.category_id), ''))), 'B') ||
      setweight(to_tsvector('english', unaccent(coalesce(p.description_short, ''))), 'C') ||
      setweight(to_tsvector('english', unaccent(coalesce(
        (SELECT string_agg(DISTINCT sa.value, ' ')
         FROM skus s JOIN sku_attributes sa ON sa.sku_id = s.id
         WHERE s.product_id = p.id AND s.status = 'active'), ''))), 'D')
    FROM vendors v
    WHERE v.id = p.vendor_id
      AND p.vendor_id = $1
      AND p.is_active = true
  `, [vendorId]);

  console.log(`  ✓ Refreshed search vectors for ${result.rowCount} products`);
  return result.rowCount;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Tri-West Data Quality Enhancement${DRY_RUN ? ' (DRY RUN)' : ''}`);
  console.log(`${'='.repeat(60)}`);

  // Quick vendor check
  try {
    await getVendorId();
  } catch (err) {
    console.error('ERROR: Vendor TW not found in database. Aborting.');
    return;
  }

  // Show current state
  const vendorId = await getVendorId();
  const snapshot = await pool.query(`
    SELECT
      COUNT(*) AS total_products,
      COUNT(CASE WHEN category_id IS NOT NULL THEN 1 END) AS categorized,
      COUNT(CASE WHEN name = UPPER(name) AND LENGTH(name) > 2 THEN 1 END) AS all_caps
    FROM products
    WHERE vendor_id = $1 AND is_active = true
  `, [vendorId]);
  const s = snapshot.rows[0];
  console.log(`\nCurrent TW state: ${s.total_products} products, ${s.categorized} categorized, ${s.all_caps} ALL CAPS`);

  const stats = {};

  try {
    stats.phase1 = await phase1_fixRetailPricing();
  } catch (err) {
    console.error('Phase 1 failed:', err.message);
    stats.phase1 = 'FAILED';
  }

  try {
    stats.phase2 = await phase2_titleCaseNames();
  } catch (err) {
    console.error('Phase 2 failed:', err.message);
    stats.phase2 = 'FAILED';
  }

  try {
    stats.phase3 = await phase3_fixCategories();
  } catch (err) {
    console.error('Phase 3 failed:', err.message);
    stats.phase3 = 'FAILED';
  }

  try {
    stats.phase4 = await phase4_improveDescriptions();
  } catch (err) {
    console.error('Phase 4 failed:', err.message);
    stats.phase4 = 'FAILED';
  }

  try {
    stats.phase5 = await phase5_propagateImages();
  } catch (err) {
    console.error('Phase 5 failed:', err.message);
    stats.phase5 = 'FAILED';
  }

  try {
    stats.phase6 = await phase6_propagatePackaging();
  } catch (err) {
    console.error('Phase 6 failed:', err.message);
    stats.phase6 = 'FAILED';
  }

  try {
    stats.phase7 = await phase7_refreshSearchVectors();
  } catch (err) {
    console.error('Phase 7 failed:', err.message);
    stats.phase7 = 'FAILED';
  }

  // Summary
  console.log(`\n${'='.repeat(60)}`);
  console.log('Summary:');
  console.log(`  Phase 1 (Retail Pricing): ${typeof stats.phase1 === 'number' ? stats.phase1 + ' SKUs fixed' : stats.phase1}`);
  console.log(`  Phase 2 (Title-Case):     ${stats.phase2?.products !== undefined ? stats.phase2.products + ' products, ' + stats.phase2.skus + ' SKUs' : stats.phase2}`);
  console.log(`  Phase 3 (Categories):     ${stats.phase3?.keyword !== undefined ? stats.phase3.keyword + ' keyword + ' + stats.phase3.sibling + ' sibling' : stats.phase3}`);
  console.log(`  Phase 4 (Descriptions):   ${typeof stats.phase4 === 'number' ? stats.phase4 + ' improved' : stats.phase4}`);
  console.log(`  Phase 5 (Images):         ${typeof stats.phase5 === 'number' ? stats.phase5 + ' propagated' : stats.phase5}`);
  console.log(`  Phase 6 (Packaging):      ${typeof stats.phase6 === 'number' ? stats.phase6 + ' propagated' : stats.phase6}`);
  console.log(`  Phase 7 (Search Vectors): ${typeof stats.phase7 === 'number' ? stats.phase7 + ' refreshed' : stats.phase7}`);
  console.log(`${'='.repeat(60)}\n`);
}

main()
  .catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  })
  .finally(() => pool.end());
