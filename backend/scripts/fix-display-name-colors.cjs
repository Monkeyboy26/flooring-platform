#!/usr/bin/env node
/**
 * fix-display-name-colors.cjs — Fix display_names that lost color words.
 *
 * Problem: For products where name == collection (e.g. "Engineered White"),
 * the display_name generator stripped the color → "Engineered" then appended
 * the category suffix → "Engineered Mosaic Tile". The storefront then shows
 * "Engineered White Engineered Mosaic Tile" (duplication).
 *
 * Fix: For products where name == collection AND display_name is missing part
 * of the collection, reconstruct display_name = collection + " " + category_suffix.
 *
 * Usage:
 *   node backend/scripts/fix-display-name-colors.cjs --dry-run          # Preview only
 *   node backend/scripts/fix-display-name-colors.cjs                    # Execute updates
 *   node backend/scripts/fix-display-name-colors.cjs --vendor MSI       # Single vendor
 *   node backend/scripts/fix-display-name-colors.cjs --limit 50         # Cap updates
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

// ---------------------------------------------------------------------------
// Category suffix map (same as fix-product-display-names.cjs)
// ---------------------------------------------------------------------------

const CATEGORY_SUFFIX_MAP = {
  'engineered hardwood': 'Engineered Hardwood',
  'solid hardwood': 'Solid Hardwood',
  'hardwood': 'Hardwood',
  'waterproof wood': 'Waterproof Wood',
  'porcelain tile': 'Porcelain Tile',
  'ceramic tile': 'Ceramic Tile',
  'mosaic tile': 'Mosaic Tile',
  'natural stone': 'Natural Stone Tile',
  'backsplash tile': 'Backsplash Tile',
  'backsplash & wall tile': 'Wall Tile',
  'decorative tile': 'Decorative Tile',
  'pool tile': 'Pool Tile',
  'wood look tile': 'Wood Look Tile',
  'large format tile': 'Large Format Tile',
  'fluted tile': 'Fluted Tile',
  'commercial tile': 'Commercial Tile',
  'porcelain slabs': 'Porcelain Slab',
  'quartz countertops': 'Quartz Countertop',
  'quartz': 'Quartz Countertop',
  'granite countertops': 'Granite Countertop',
  'quartzite countertops': 'Quartzite Countertop',
  'marble countertops': 'Marble Countertop',
  'soapstone countertops': 'Soapstone Countertop',
  'prefabricated countertops': 'Prefabricated Countertop',
  'countertops': 'Countertop',
  'lvp (plank)': 'Luxury Vinyl Plank',
  'lvp': 'Luxury Vinyl Plank',
  'lvt (tile)': 'Luxury Vinyl Tile',
  'lvt': 'Luxury Vinyl Tile',
  'luxury vinyl': 'Luxury Vinyl',
  'spc': 'SPC Vinyl',
  'wpc': 'WPC Vinyl',
  'laminate': 'Laminate',
  'laminate flooring': 'Laminate',
  'carpet': 'Carpet',
  'carpet tile': 'Carpet Tile',
  'rubber flooring': 'Rubber Flooring',
  'artificial turf': 'Artificial Turf',
  'vanity': 'Vanity',
  'vanity tops': 'Vanity Top',
  'vanities': 'Vanity',
  'faucets': 'Faucet',
  'bathroom faucets': 'Faucet',
  'kitchen faucets': 'Faucet',
  'mirrors': 'Mirror',
  'sinks': 'Sink',
  'kitchen sinks': 'Sink',
  'bathroom sinks': 'Sink',
  'shower systems': 'Shower System',
  'transitions & moldings': 'Molding',
  'transitions': 'Molding',
  'moldings': 'Molding',
  'moulding': 'Molding',
  'wall base': 'Wall Base',
  'underlayment': 'Underlayment',
  'stair treads & nosing': 'Stair Tread',
  'hardscaping': 'Paver',
  'pavers': 'Paver',
  'stacked stone': 'Stacked Stone',
};

/** Get the category suffix for a given category name */
function getCategorySuffix(categoryName) {
  if (!categoryName) return null;
  return CATEGORY_SUFFIX_MAP[categoryName.toLowerCase()] || null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('='.repeat(70));
  console.log('  FIX DISPLAY NAME COLORS');
  console.log(`  Mode: ${DRY_RUN ? 'DRY RUN (no changes)' : 'LIVE (will update DB)'}`);
  if (VENDOR_FILTER) console.log(`  Vendor filter: ${VENDOR_FILTER}`);
  if (LIMIT) console.log(`  Limit: ${LIMIT}`);
  console.log('='.repeat(70));
  console.log();

  // -----------------------------------------------------------------------
  // 1. Find products where name == collection and display_name exists
  //    but display_name is missing part of the collection name
  // -----------------------------------------------------------------------
  let query = `
    SELECT p.id, p.name, p.collection, p.display_name,
           c.name AS category_name, v.name AS vendor_name, v.code AS vendor_code
    FROM products p
    JOIN vendors v ON v.id = p.vendor_id
    LEFT JOIN categories c ON c.id = p.category_id
    WHERE p.status = 'active'
      AND p.display_name IS NOT NULL
      AND p.collection IS NOT NULL
      AND LOWER(TRIM(p.name)) = LOWER(TRIM(p.collection))
  `;
  const params = [];
  if (VENDOR_FILTER) {
    params.push(VENDOR_FILTER.toUpperCase());
    query += ` AND UPPER(v.code) = $${params.length}`;
  }
  query += ' ORDER BY v.name, p.collection, p.name';

  const { rows: products } = await pool.query(query, params);
  console.log(`Found ${products.length} products where name == collection.\n`);

  // -----------------------------------------------------------------------
  // 2. Filter to those whose display_name doesn't contain the full collection
  // -----------------------------------------------------------------------
  const updates = [];
  const skipped = [];

  for (const p of products) {
    if (LIMIT && updates.length >= LIMIT) break;

    const collection = (p.collection || '').trim();
    const displayName = (p.display_name || '').trim();
    const collLower = collection.toLowerCase();
    const dispLower = displayName.toLowerCase();

    // Skip if display_name already contains the full collection
    if (dispLower.startsWith(collLower + ' ') || dispLower === collLower) {
      skipped.push({ id: p.id, reason: 'already correct', displayName, collection });
      continue;
    }

    // Check if display_name starts with a prefix of the collection
    // e.g. display_name="Engineered Mosaic Tile", collection="Engineered White"
    // The stripped name "Engineered" is a prefix of the collection
    const categorySuffix = getCategorySuffix(p.category_name);

    // Try to find the category suffix in the display_name
    let newDisplayName = null;

    if (categorySuffix) {
      const suffixLower = categorySuffix.toLowerCase();
      if (dispLower.endsWith(suffixLower)) {
        // display_name ends with category suffix
        // Extract the name part (before the suffix)
        const namePartEnd = displayName.length - categorySuffix.length;
        const namePart = displayName.substring(0, namePartEnd).trim();
        const namePartLower = namePart.toLowerCase();

        // Check if the name part is a prefix or suffix of the collection
        if (namePartLower !== collLower && (collLower.startsWith(namePartLower + ' ') || collLower.endsWith(' ' + namePartLower))) {
          // The name part is a truncated version of the collection
          // Reconstruct: full collection + category suffix
          newDisplayName = collection + ' ' + categorySuffix;
        }
      }
    }

    // Also handle case where display_name doesn't end with a known suffix
    // but collection is clearly not fully represented
    // e.g. display_name="Gold Natural Stone Tile", collection="Gold Green"
    if (!newDisplayName) {
      // Check if collection words are partially present
      const collWords = collection.split(/\s+/);
      const dispWords = displayName.split(/\s+/);

      if (collWords.length > 1) {
        // Check if display_name starts with first word(s) of collection but not all
        let matchedWords = 0;
        for (let i = 0; i < collWords.length && i < dispWords.length; i++) {
          if (collWords[i].toLowerCase() === dispWords[i].toLowerCase()) {
            matchedWords++;
          } else {
            break;
          }
        }

        if (matchedWords > 0 && matchedWords < collWords.length) {
          // Partial match — the display_name has some collection words but not all
          // Reconstruct by replacing the matched prefix with the full collection
          const remainder = dispWords.slice(matchedWords).join(' ');
          const candidateNew = collection + (remainder ? ' ' + remainder : '');
          // Avoid if the remainder already contains the missing collection words
          const missingWords = collWords.slice(matchedWords).map(w => w.toLowerCase());
          const remainderLower = remainder.toLowerCase();
          const alreadyPresent = missingWords.every(w => remainderLower.includes(w));
          if (!alreadyPresent) {
            newDisplayName = candidateNew;
          }
        }
      }
    }

    if (!newDisplayName) {
      skipped.push({ id: p.id, reason: 'no fix pattern matched', displayName, collection, category: p.category_name });
      continue;
    }

    // Don't "fix" if it would be unchanged
    if (newDisplayName === displayName) {
      skipped.push({ id: p.id, reason: 'no change needed', displayName, collection });
      continue;
    }

    updates.push({
      id: p.id,
      oldDisplayName: displayName,
      newDisplayName,
      collection,
      category: p.category_name,
      vendor: p.vendor_name,
    });
  }

  // -----------------------------------------------------------------------
  // 3. Report
  // -----------------------------------------------------------------------
  console.log(`\n${'='.repeat(70)}`);
  console.log(`  RESULTS: ${updates.length} products to fix, ${skipped.length} skipped`);
  console.log('='.repeat(70));

  // Group by vendor for clearer output
  const byVendor = {};
  for (const u of updates) {
    if (!byVendor[u.vendor]) byVendor[u.vendor] = [];
    byVendor[u.vendor].push(u);
  }

  for (const [vendor, items] of Object.entries(byVendor).sort()) {
    console.log(`\n--- ${vendor} (${items.length} products) ---`);
    for (const u of items) {
      console.log(`  [${u.id}] "${u.oldDisplayName}" → "${u.newDisplayName}"  (col: ${u.collection}, cat: ${u.category})`);
    }
  }

  // Show skip reasons summary
  const skipReasons = {};
  for (const s of skipped) {
    skipReasons[s.reason] = (skipReasons[s.reason] || 0) + 1;
  }
  if (Object.keys(skipReasons).length > 0) {
    console.log(`\nSkip reasons:`);
    for (const [reason, count] of Object.entries(skipReasons)) {
      console.log(`  ${reason}: ${count}`);
    }
  }

  // -----------------------------------------------------------------------
  // 4. Apply updates
  // -----------------------------------------------------------------------
  if (DRY_RUN) {
    console.log(`\n[DRY RUN] No changes made. Run without --dry-run to apply.`);
  } else if (updates.length > 0) {
    console.log(`\nApplying ${updates.length} updates...`);
    let applied = 0;
    for (const u of updates) {
      await pool.query('UPDATE products SET display_name = $1 WHERE id = $2', [u.newDisplayName, u.id]);
      applied++;
    }
    console.log(`Done. Updated ${applied} products.`);
  } else {
    console.log('\nNo updates needed.');
  }

  await pool.end();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
