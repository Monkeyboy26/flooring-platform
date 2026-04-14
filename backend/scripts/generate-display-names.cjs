#!/usr/bin/env node
/**
 * generate-display-names.cjs — Populate display_name for products missing one.
 *
 * The API uses COALESCE(p.display_name, p.name) everywhere, so setting a clean
 * display_name immediately improves every product card, detail page, and search.
 *
 * Tiered logic:
 *   Tier 1 (Clean Copy)     — name looks human-readable and != collection → copy as-is
 *   Tier 2 (Redundant Name) — name == collection → derive "Collection Color"
 *   Tier 3 (SKU-Code)       — name looks like a SKU code → derive from collection + color
 *
 * Usage:
 *   node backend/scripts/generate-display-names.cjs --dry-run          # Preview only
 *   node backend/scripts/generate-display-names.cjs                    # Execute updates
 *   node backend/scripts/generate-display-names.cjs --vendor SHAW      # Single vendor
 *   node backend/scripts/generate-display-names.cjs --limit 50         # Cap update count
 *   node backend/scripts/generate-display-names.cjs --dry-run --vendor MSI
 */

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/flooring_pim',
});

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const vendorIdx = args.indexOf('--vendor');
const VENDOR_FILTER = vendorIdx !== -1 ? args[vendorIdx + 1] : null;
const limitIdx = args.indexOf('--limit');
const LIMIT = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : null;
const BATCH_SIZE = 100;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns true if `name` looks like a raw SKU/part code (no spaces, has digits). */
function looksLikeSkuCode(name) {
  if (!name) return false;
  const trimmed = name.trim();
  // No spaces, contains digits, mostly alphanumeric/dashes/dots
  if (/\s/.test(trimmed)) return false;
  if (!/\d/.test(trimmed)) return false;
  if (/^[A-Za-z0-9._-]+$/.test(trimmed)) return true;
  return false;
}

/** Title Case a string, preserving Roman numerals (II, III, IV, etc.) */
function titleCase(str) {
  if (!str) return '';
  const romanNumerals = /^(I{1,3}|IV|VI{0,3}|IX|XI{0,3}|XIV|XV|XVI{0,3})$/i;
  const smallWords = new Set(['a', 'an', 'the', 'and', 'but', 'or', 'for', 'nor', 'of', 'in', 'on', 'at', 'to', 'by', 'up', 'as', 'is', 'it']);
  return str.replace(/\w+/g, (word, offset) => {
    if (romanNumerals.test(word)) return word.toUpperCase();
    if (offset > 0 && smallWords.has(word.toLowerCase())) return word.toLowerCase();
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  });
}

/** Strip common size/dimension patterns from a string. */
function stripSizeDimensions(str) {
  if (!str) return '';
  return str
    // patterns like "12x24", "4x12x24", "6 x 24"
    .replace(/\b\d+\s*[xX×]\s*\d+(?:\s*[xX×]\s*\d+)?\s*(?:mm|cm|in|ft|"|')?\b/g, '')
    // patterns like "24x24mm", "12"x24""
    .replace(/\b\d+["']?\s*[xX×]\s*\d+["']?\b/g, '')
    // standalone size mentions like "12mm", "3/8"
    .replace(/\b\d+(?:\/\d+)?\s*(?:mm|cm|in|ft|"|')\b/g, '')
    // clean up leftover punctuation: leading/trailing commas, dashes, pipes
    .replace(/^[\s,\-|]+/, '')
    .replace(/[\s,\-|]+$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('='.repeat(70));
  console.log('  GENERATE DISPLAY NAMES');
  console.log(`  Mode: ${DRY_RUN ? 'DRY RUN (no changes)' : 'LIVE (will update DB)'}`);
  if (VENDOR_FILTER) console.log(`  Vendor filter: ${VENDOR_FILTER}`);
  if (LIMIT) console.log(`  Limit: ${LIMIT}`);
  console.log('='.repeat(70));
  console.log();

  // -----------------------------------------------------------------------
  // 1. Fetch products missing display_name
  // -----------------------------------------------------------------------
  let query = `
    SELECT p.id, p.name, p.collection, v.name AS vendor_name, v.code AS vendor_code
    FROM products p
    JOIN vendors v ON v.id = p.vendor_id
    WHERE p.status = 'active'
      AND p.display_name IS NULL
  `;
  const params = [];
  if (VENDOR_FILTER) {
    params.push(VENDOR_FILTER.toUpperCase());
    query += ` AND UPPER(v.code) = $${params.length}`;
  }
  query += ' ORDER BY v.name, p.collection, p.name';

  const { rows: products } = await pool.query(query, params);
  console.log(`Found ${products.length} products missing display_name.\n`);

  if (!products.length) {
    console.log('Nothing to do.');
    return;
  }

  // -----------------------------------------------------------------------
  // 2. Fetch most common color attribute per product (batch)
  //    For Tier 2 & 3 we need color info.
  // -----------------------------------------------------------------------
  const colorQuery = `
    SELECT
      s.product_id,
      sa.value AS color,
      COUNT(*) AS cnt
    FROM skus s
    JOIN sku_attributes sa ON sa.sku_id = s.id
    JOIN attributes a ON a.id = sa.attribute_id
    WHERE a.slug = 'color'
      AND s.status = 'active'
      AND s.is_sample = false
    GROUP BY s.product_id, sa.value
    ORDER BY s.product_id, cnt DESC, sa.value ASC
  `;
  const { rows: colorRows } = await pool.query(colorQuery);

  // Build map: product_id → most common color (first row per product wins due to ORDER BY)
  // Some vendors store comma-separated color lists — take only the first value.
  const productColorMap = new Map();
  for (const row of colorRows) {
    if (!productColorMap.has(row.product_id)) {
      let color = row.color;
      if (color && color.includes(',')) {
        color = color.split(',')[0].trim();
      }
      productColorMap.set(row.product_id, color);
    }
  }

  // -----------------------------------------------------------------------
  // 3. Fetch first variant_name per product (fallback for Tier 2)
  // -----------------------------------------------------------------------
  const variantQuery = `
    SELECT DISTINCT ON (s.product_id)
      s.product_id, s.variant_name
    FROM skus s
    WHERE s.status = 'active'
      AND s.is_sample = false
      AND s.variant_name IS NOT NULL
      AND s.variant_name != ''
    ORDER BY s.product_id, s.created_at ASC
  `;
  const { rows: variantRows } = await pool.query(variantQuery);
  const productVariantMap = new Map();
  for (const row of variantRows) {
    productVariantMap.set(row.product_id, row.variant_name);
  }

  // -----------------------------------------------------------------------
  // 4. Classify and generate display_name for each product
  // -----------------------------------------------------------------------
  const updates = []; // { id, display_name, tier, oldName, collection, vendor }
  const stats = { tier1: 0, tier2: 0, tier3: 0, skipped: 0 };
  const vendorStats = {};

  for (const p of products) {
    if (LIMIT && updates.length >= LIMIT) break;

    const name = (p.name || '').trim();
    const collection = (p.collection || '').trim();
    const nameIsRedundant = collection && name.toLowerCase() === collection.toLowerCase();
    const nameIsSkuCode = looksLikeSkuCode(name);

    let displayName = null;
    let tier = null;

    const nameIsTooShort = name.length < 3;

    if (!nameIsRedundant && !nameIsSkuCode && !nameIsTooShort) {
      // Tier 1: Clean copy — name looks human-readable
      displayName = name;
      tier = 1;
      stats.tier1++;
    } else if (nameIsRedundant) {
      // Tier 2: name == collection — derive "Collection Color"
      const color = productColorMap.get(p.id);
      if (color && color.toLowerCase() !== collection.toLowerCase()) {
        displayName = `${collection} ${titleCase(color)}`;
      } else {
        // No color, or color == collection — try variant_name stripped of sizes
        const variant = productVariantMap.get(p.id);
        if (variant) {
          const cleaned = stripSizeDimensions(variant).trim();
          if (cleaned && cleaned.toLowerCase() !== collection.toLowerCase()) {
            displayName = `${collection} ${titleCase(cleaned)}`;
          } else {
            displayName = collection; // last resort: just collection
          }
        } else {
          displayName = collection;
        }
      }
      tier = 2;
      stats.tier2++;
    } else if (nameIsSkuCode) {
      // Tier 3: SKU-code name — try collection + color
      const color = productColorMap.get(p.id);
      if (collection && color && color.toLowerCase() !== collection.toLowerCase()) {
        displayName = `${collection} ${titleCase(color)}`;
      } else if (collection) {
        const variant = productVariantMap.get(p.id);
        if (variant) {
          const cleaned = stripSizeDimensions(variant).trim();
          if (cleaned && cleaned.toLowerCase() !== collection.toLowerCase()) {
            displayName = `${collection} ${titleCase(cleaned)}`;
          } else {
            displayName = collection;
          }
        } else {
          displayName = collection;
        }
      } else {
        // No collection either — skip, can't improve
        stats.skipped++;
        continue;
      }
      tier = 3;
      stats.tier3++;
    } else if (nameIsTooShort) {
      // Tier 3b: Name is a stub (1-2 chars) — treat like SKU code
      const color = productColorMap.get(p.id);
      if (collection && color && color.toLowerCase() !== collection.toLowerCase()) {
        displayName = `${collection} ${titleCase(color)}`;
      } else if (collection) {
        const variant = productVariantMap.get(p.id);
        if (variant) {
          const cleaned = stripSizeDimensions(variant).trim();
          if (cleaned && cleaned.toLowerCase() !== collection.toLowerCase()) {
            displayName = `${collection} ${titleCase(cleaned)}`;
          } else {
            displayName = collection;
          }
        } else {
          displayName = collection;
        }
      } else {
        stats.skipped++;
        continue;
      }
      tier = 3;
      stats.tier3++;
    } else {
      // Uncategorized — skip
      stats.skipped++;
      continue;
    }

    // Avoid setting display_name identical to name (no-op)
    if (displayName && displayName !== name) {
      updates.push({
        id: p.id,
        display_name: displayName,
        tier,
        oldName: name,
        collection,
        vendor: p.vendor_name,
      });
    } else if (displayName) {
      // Even if same as name, set it so audit counts it
      updates.push({
        id: p.id,
        display_name: displayName,
        tier,
        oldName: name,
        collection,
        vendor: p.vendor_name,
      });
    }

    // Track per-vendor stats
    const vk = p.vendor_name;
    if (!vendorStats[vk]) vendorStats[vk] = { tier1: 0, tier2: 0, tier3: 0 };
    vendorStats[vk][`tier${tier}`]++;
  }

  // -----------------------------------------------------------------------
  // 5. Print summary
  // -----------------------------------------------------------------------
  console.log('-'.repeat(70));
  console.log('  TIER BREAKDOWN');
  console.log('-'.repeat(70));
  console.log(`  Tier 1 (Clean Copy):       ${stats.tier1}`);
  console.log(`  Tier 2 (Redundant → Derived): ${stats.tier2}`);
  console.log(`  Tier 3 (SKU-Code → Derived):  ${stats.tier3}`);
  console.log(`  Skipped:                    ${stats.skipped}`);
  console.log(`  Total updates to apply:     ${updates.length}`);
  console.log();

  // Per-vendor breakdown
  console.log('-'.repeat(70));
  console.log('  PER-VENDOR BREAKDOWN');
  console.log('-'.repeat(70));
  const vendorEntries = Object.entries(vendorStats).sort((a, b) => {
    const totalA = a[1].tier1 + a[1].tier2 + a[1].tier3;
    const totalB = b[1].tier1 + b[1].tier2 + b[1].tier3;
    return totalB - totalA;
  });
  for (const [vendor, s] of vendorEntries) {
    const total = s.tier1 + s.tier2 + s.tier3;
    console.log(`  ${vendor.padEnd(30)} T1:${String(s.tier1).padStart(5)}  T2:${String(s.tier2).padStart(5)}  T3:${String(s.tier3).padStart(5)}  Total:${String(total).padStart(5)}`);
  }
  console.log();

  // Show sample transformations (up to 5 per tier)
  console.log('-'.repeat(70));
  console.log('  SAMPLE TRANSFORMATIONS');
  console.log('-'.repeat(70));
  for (const tierNum of [1, 2, 3]) {
    const samples = updates.filter(u => u.tier === tierNum).slice(0, 5);
    if (!samples.length) continue;
    console.log(`\n  --- Tier ${tierNum} ---`);
    for (const s of samples) {
      console.log(`  [${s.vendor}] "${s.oldName}" → "${s.display_name}"${s.collection ? ` (collection: ${s.collection})` : ''}`);
    }
  }
  console.log();

  // -----------------------------------------------------------------------
  // 6. Apply updates (unless dry-run)
  // -----------------------------------------------------------------------
  if (DRY_RUN) {
    console.log('='.repeat(70));
    console.log('  DRY RUN — no changes made. Remove --dry-run to apply.');
    console.log('='.repeat(70));
    return;
  }

  console.log('-'.repeat(70));
  console.log('  APPLYING UPDATES...');
  console.log('-'.repeat(70));

  let applied = 0;
  for (let i = 0; i < updates.length; i += BATCH_SIZE) {
    const batch = updates.slice(i, i + BATCH_SIZE);

    // Build a batch UPDATE using unnest
    const ids = batch.map(u => u.id);
    const names = batch.map(u => u.display_name);

    await pool.query(`
      UPDATE products
      SET display_name = batch.display_name,
          updated_at = NOW()
      FROM (SELECT unnest($1::uuid[]) AS id, unnest($2::text[]) AS display_name) AS batch
      WHERE products.id = batch.id
    `, [ids, names]);

    applied += batch.length;
    if (applied % 500 === 0 || applied === updates.length) {
      console.log(`  Updated ${applied} / ${updates.length} products...`);
    }
  }

  console.log();
  console.log('='.repeat(70));
  console.log(`  DONE — ${applied} products updated.`);
  console.log('='.repeat(70));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Failed:', err);
    process.exit(1);
  })
  .finally(() => pool.end());
