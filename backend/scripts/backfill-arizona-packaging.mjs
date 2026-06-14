/**
 * Backfill empty Arizona Tile packaging rows.
 *
 * Finds box-sold SKUs with empty packaging stubs (all fields NULL)
 * and attempts to match them against the tile price list using
 * product name + variant attributes to build lookup keys.
 *
 * Also cleans up empty stubs for products that genuinely have no
 * packaging data available.
 *
 * Usage:
 *   node backend/scripts/backfill-arizona-packaging.mjs [--dry-run]
 */

import pg from 'pg';
import { loadAllPriceLists, buildLookupKey } from '../scrapers/arizona-prices.js';

const DRY_RUN = process.argv.includes('--dry-run');

const pool = new pg.Pool({
  host: process.env.PGHOST || 'localhost',
  port: parseInt(process.env.PGPORT || '5432'),
  database: process.env.PGDATABASE || 'flooring_pim',
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'postgres',
});

/**
 * Try multiple key variations against the price list to find a match with sfPerBox.
 * Returns the matched entry or null.
 */
function tryMatch(allMaps, keys) {
  for (const key of keys) {
    if (!key) continue;
    const entry = allMaps.get(key);
    if (entry && entry.sfPerBox) return entry;
  }
  return null;
}

/**
 * Build alternative lookup keys to handle known normalization gaps
 * between our product names and the tile price list format.
 */
function buildAltKeys(productName, variantName, collection) {
  const keys = [];
  const name = productName.toUpperCase().trim();

  // Parse variant_name
  let sizePart = '', finishPart = '';
  if (variantName) {
    const parts = variantName.split(',').map(s => s.trim());
    sizePart = (parts[0] || '').toUpperCase();
    finishPart = (parts[1] || '').toUpperCase();
  }

  // Normalize size: "12X24" stays, add thickness suffix "X3/8" for natural stone
  const sizeNorm = sizePart.replace(/\s+/g, '').replace(/(\d)\s*X\s*(\d)/g, '$1X$2');
  const FINISH_ABBR = { POLISHED: 'POL', HONED: 'HON', MATTE: 'MAT', BRUSHED: 'BRUSHED',
    TUMBLED: 'TUMBLED', 'FILLED HONED': 'FILLED HONED', FLAMED: 'FLAMED',
    'SANDBLASTED BRUSHED': 'SANDBLASTED', DISTRESSED: 'DISTRESSED' };

  // Deduplicate product name: "ABSOLUTE BLACK ABSOLUTE BLACK" → "ABSOLUTE BLACK"
  // Many AZ natural stone products have collection = color = product name
  const words = name.split(' ');
  const half = Math.floor(words.length / 2);
  let dedupedName = name;
  if (half >= 2 && words.slice(0, half).join(' ') === words.slice(half, half * 2).join(' ')) {
    dedupedName = words.slice(0, half).join(' ');
  }

  // Deduplicate collection prefix: "ANTIGO ANTIGO LAGOS BLUE" → "ANTIGO LAGOS BLUE"
  const collUp = (collection || '').toUpperCase().trim();
  let nameWithoutCollDup = name;
  if (collUp && name.startsWith(collUp + ' ' + collUp)) {
    nameWithoutCollDup = collUp + name.slice(collUp.length + 1 + collUp.length);
  }

  // Strip "Honed" from name when it's a finish, not part of the product name
  // "Chelsea Grey Honed Chelsea Grey" → "Chelsea Grey"
  let nameStrippedFinish = dedupedName;
  for (const f of Object.keys(FINISH_ABBR)) {
    if (dedupedName.endsWith(' ' + f)) {
      nameStrippedFinish = dedupedName.slice(0, -(f.length + 1));
      break;
    }
  }

  // === Key variations ===

  // 1. Deduped name + finish + size (standard tile format)
  //    "ABSOLUTE BLACK HONED 12X24X3/8"
  if (finishPart && sizeNorm) {
    keys.push(`${dedupedName} ${finishPart} ${sizeNorm}`);
    keys.push(`${dedupedName} ${finishPart} ${sizeNorm}X3/8`);
    keys.push(`${dedupedName} ${finishPart} ${sizeNorm}X1/2`);
    keys.push(`${nameStrippedFinish} ${finishPart} ${sizeNorm}`);
    keys.push(`${nameStrippedFinish} ${finishPart} ${sizeNorm}X3/8`);
    keys.push(`${nameStrippedFinish} ${finishPart} ${sizeNorm}X1/2`);
    // Abbreviated finish
    const abbr = FINISH_ABBR[finishPart];
    if (abbr && abbr !== finishPart) {
      keys.push(`${dedupedName} ${abbr} ${sizeNorm}`);
      keys.push(`${dedupedName} ${abbr} ${sizeNorm}X3/8`);
      keys.push(`${nameStrippedFinish} ${abbr} ${sizeNorm}`);
      keys.push(`${nameStrippedFinish} ${abbr} ${sizeNorm}X3/8`);
    }
  }

  // 2. Deduped name + size only (some price list entries don't have finish)
  if (sizeNorm) {
    keys.push(`${dedupedName} ${sizeNorm}`);
    keys.push(`${dedupedName} ${sizeNorm}X3/8`);
    keys.push(`${nameStrippedFinish} ${sizeNorm}`);
    keys.push(`${nameStrippedFinish} ${sizeNorm}X3/8`);
  }

  // 3. Collection-deduped name
  if (nameWithoutCollDup !== name) {
    if (finishPart && sizeNorm) {
      keys.push(`${nameWithoutCollDup} ${finishPart} ${sizeNorm}`);
      keys.push(`${nameWithoutCollDup} ${finishPart} ${sizeNorm}X3/8`);
    }
    if (sizeNorm) {
      keys.push(`${nameWithoutCollDup} ${sizeNorm}`);
      keys.push(`${nameWithoutCollDup} ${sizeNorm}X3/8`);
    }
  }

  // 4. Cementine "BLACK AND WHITE BW X" → "B&W X"
  //    Product name: "Cementine Black And White Bw 1" → PL key: "CEMENTINE B&W 1 8X8"
  if (name.includes('BLACK AND WHITE BW')) {
    const suffix = name.replace(/.*BLACK AND WHITE BW\s*/, '').trim(); // "1", "2", "MIX", etc.
    if (sizeNorm) {
      keys.push(`CEMENTINE B&W ${suffix} ${sizeNorm}`);
    }
  } else if (name.includes('BLACK AND WHITE')) {
    const suffix = name.replace(/.*BLACK AND WHITE\s*/, '').trim();
    if (sizeNorm) {
      keys.push(`CEMENTINE B&W ${suffix} ${sizeNorm}`);
    }
  }

  // 5. Geo 2: "GEO 2 COLOR SIZE" → "GEO 2-COLOR SIZE" (hyphen between collection and color)
  if (name.startsWith('GEO 2 ')) {
    const rest = name.slice(6); // after "GEO 2 "
    const restWords = rest.split(' ');
    // Try "GEO 2-REST SIZE"
    if (sizeNorm) {
      keys.push(`GEO 2-${rest} ${sizeNorm}`);
      keys.push(`GEO 2-${rest} ${sizeNorm} HEX MESH`);
      // Also try without last word of rest as size: "GEO 2-BISOU DAWN 13X13 HEX MESH"
      if (restWords.length >= 2) {
        const colorPart = restWords.slice(0, -1).join(' ');
        keys.push(`GEO 2-${rest} ${sizeNorm} HEX`);
      }
    }
  }

  // 6. "LARGE CHEVRON" → "LG CHEVRON"
  if (sizePart.includes('LARGE CHEVRON')) {
    const lcName = dedupedName;
    keys.push(`${lcName} ${finishPart} LG CHEVRON`.trim());
    keys.push(`${lcName} ${FINISH_ABBR[finishPart] || finishPart} LG CHEVRON`.trim());
    keys.push(`${nameStrippedFinish} ${finishPart} LG CHEVRON`.trim());
    keys.push(`${nameStrippedFinish} ${FINISH_ABBR[finishPart] || finishPart} LG CHEVRON`.trim());
    // CS- prefix for Countertop Stone series
    keys.push(`CS-${lcName} ${finishPart} LG CHEVRON`.trim());
    keys.push(`CS-${nameStrippedFinish} ${finishPart} LG CHEVRON`.trim());
    keys.push(`CS-${nameStrippedFinish} ${FINISH_ABBR[finishPart] || finishPart} LG CHEVRON`.trim());
  }

  // 7. "VERSAILLES PATTERN" → "LYON PATTERN" or "VERSAILLES"
  if (sizePart.includes('VERSAILLES PATTERN')) {
    keys.push(`${dedupedName} ${finishPart} VERSAILLES`.trim());
    keys.push(`${dedupedName} VERSAILLES`);
    keys.push(`${nameStrippedFinish} ${finishPart} VERSAILLES`.trim());
  }

  // 8. "LYON PATTERN" as size
  if (sizePart.includes('LYON PATTERN')) {
    keys.push(`${dedupedName} ${finishPart} LYON PATTERN`.trim());
    keys.push(`${dedupedName} LYON PATTERN`);
    keys.push(`${nameStrippedFinish} ${finishPart} LYON PATTERN`.trim());
    keys.push(`${nameStrippedFinish} LYON PATTERN`);
    keys.push(`${nameStrippedFinish} ${FINISH_ABBR[finishPart] || finishPart} LYON PATTERN`.trim());
  }

  // 9. Spark Bars: simple product, try with common finishes
  if (!sizeNorm && name.startsWith('SPARK BARS')) {
    keys.push(`${name} MATTE 5X10`);
  }

  // 9b. "VEIN CUT" products: finish goes BEFORE "VEIN CUT" in price list
  //     "SILVER BEIGE VEIN CUT" + "Honed" → "SILVER BEIGE HONED VEIN CUT 16X24X3/8"
  if (name.includes('VEIN CUT') && finishPart && sizeNorm) {
    const beforeVC = name.split('VEIN CUT')[0].trim();
    const afterVC = name.split('VEIN CUT')[1]?.trim() || '';
    const vcBase = `${beforeVC} ${finishPart} VEIN CUT ${afterVC}`.replace(/\s+/g, ' ').trim();
    keys.push(`${vcBase} ${sizeNorm}`);
    keys.push(`${vcBase} ${sizeNorm}X3/8`);
    const abbr = FINISH_ABBR[finishPart];
    if (abbr && abbr !== finishPart) {
      const vcAbbr = `${beforeVC} ${abbr} VEIN CUT ${afterVC}`.replace(/\s+/g, ' ').trim();
      keys.push(`${vcAbbr} ${sizeNorm}`);
      keys.push(`${vcAbbr} ${sizeNorm}X3/8`);
    }
    // Deduped version
    const dBeforeVC = nameStrippedFinish.includes('VEIN CUT')
      ? nameStrippedFinish.split('VEIN CUT')[0].trim()
      : beforeVC;
    if (dBeforeVC !== beforeVC) {
      keys.push(`${dBeforeVC} ${finishPart} VEIN CUT ${sizeNorm}X3/8`);
    }
  }

  // 10. "SPLIT" prefix products: "SPLIT JADE 4X16 SPLIT" → strip trailing SPLIT
  if (name.startsWith('SPLIT ') && sizeNorm) {
    const baseName = name.slice(6); // e.g. "JADE"
    keys.push(`${baseName} SPLIT ${sizeNorm}`);
    keys.push(`${baseName} SPLIT 3D ${sizeNorm}`);
    keys.push(`${baseName} SPLIT ${sizeNorm}X3/8`);
    // CS- prefix
    keys.push(`CS-${baseName} SPLIT ${sizeNorm}`);
  }

  // 11. Haisa Blue special format: "SPLIT HONED LEDGER 6X24" → "SPLIT 3D STACK 7-3/16X19-5/8"
  if (sizePart.includes('SPLIT') && sizePart.includes('LEDGER')) {
    keys.push(`${dedupedName} SPLIT 3D STACK 7-3/16X19-5/8`);
    keys.push(`${dedupedName} ${finishPart} 3D STACK 7-3/16X19-5/8`.trim());
  }

  // 12. "BEVEL 3X6" → "BEVEL 3X6X3/8"
  if (sizePart.includes('BEVEL')) {
    keys.push(`${dedupedName} ${finishPart} ${sizeNorm}`.trim());
    keys.push(`${dedupedName} ${finishPart} ${sizeNorm}X3/8`.trim());
    keys.push(`${nameStrippedFinish} ${finishPart} ${sizeNorm}`.trim());
  }

  // 13. For non-standard sizes (fractional), try without thickness
  if (sizeNorm.includes('/') && !sizeNorm.includes('X3/8')) {
    keys.push(`${dedupedName} ${finishPart} ${sizeNorm}`.trim());
    keys.push(`${nameStrippedFinish} ${finishPart} ${sizeNorm}`.trim());
  }

  // Clean up: remove double spaces, trim
  return keys.map(k => k.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

async function main() {
  const priceList = loadAllPriceLists();
  console.log(`Price list loaded: ${priceList.stats.total} entries (tile: ${priceList.stats.tile})`);

  // Find all box-sold Arizona SKUs with empty or missing packaging
  const { rows } = await pool.query(`
    SELECT
      s.id AS sku_id,
      s.vendor_sku,
      s.variant_name,
      s.sell_by,
      p.name AS product_name,
      p.collection,
      p.slug AS product_slug,
      c.name AS category,
      c.slug AS cat_slug,
      EXISTS(SELECT 1 FROM packaging pk2 WHERE pk2.sku_id = s.id) AS has_stub
    FROM skus s
    JOIN products p ON s.product_id = p.id
    JOIN categories c ON p.category_id = c.id
    LEFT JOIN packaging pk ON s.id = pk.sku_id
      AND (pk.sqft_per_box IS NOT NULL OR pk.pieces_per_box IS NOT NULL)
    WHERE p.vendor_id = '550e8400-e29b-41d4-a716-446655440007'
      AND s.sell_by = 'box'
      AND pk.sku_id IS NULL
    ORDER BY c.name, p.name, s.variant_name
  `);

  console.log(`Found ${rows.length} box-sold SKUs missing packaging data\n`);

  let matched = 0;
  let unmatched = 0;
  let stubsCleaned = 0;
  const unmatchedProducts = new Map();

  for (const row of rows) {
    const collection = row.collection || row.product_name;

    // Build alternative keys for fuzzy matching
    const altKeys = buildAltKeys(row.product_name, row.variant_name, collection);

    // Try all alternative keys against the full price list map
    let plEntry = tryMatch(priceList.allMaps, altKeys);

    // Also try the standard lookup paths
    if (!plEntry) {
      // Parse variant_name
      let sizeSlug = null, finishSlug = null;
      if (row.variant_name) {
        const parts = row.variant_name.split(',').map(s => s.trim());
        if (parts[0]) sizeSlug = parts[0].toLowerCase().replace(/\s+/g, '-');
        if (parts[1]) finishSlug = parts[1].toLowerCase().replace(/\s+/g, '-');
      }
      plEntry = priceList.lookup(collection, null, sizeSlug, finishSlug);
      if (plEntry && !plEntry.sfPerBox) plEntry = null;
    }

    if (plEntry && plEntry.sfPerBox) {
      matched++;
      const pkg = {
        sqft_per_box: plEntry.sfPerBox,
        pieces_per_box: plEntry.pcsPerBox || null,
        boxes_per_pallet: plEntry.boxesPerPallet || null,
        sqft_per_pallet: plEntry.sfPerPallet || null,
      };
      console.log(`  ✓ ${row.product_name} [${row.variant_name || 'default'}] → ${plEntry.itemId} (${pkg.sqft_per_box} sf/box, ${pkg.pieces_per_box} pcs, ${pkg.boxes_per_pallet} bpp)`);

      if (!DRY_RUN) {
        const existing = await pool.query('SELECT 1 FROM packaging WHERE sku_id = $1', [row.sku_id]);
        if (existing.rows.length > 0) {
          await pool.query(`
            UPDATE packaging SET sqft_per_box = $2, pieces_per_box = $3,
              boxes_per_pallet = $4, sqft_per_pallet = $5
            WHERE sku_id = $1
          `, [row.sku_id, pkg.sqft_per_box, pkg.pieces_per_box, pkg.boxes_per_pallet, pkg.sqft_per_pallet]);
        } else {
          await pool.query(`
            INSERT INTO packaging (sku_id, sqft_per_box, pieces_per_box, boxes_per_pallet, sqft_per_pallet)
            VALUES ($1, $2, $3, $4, $5)
          `, [row.sku_id, pkg.sqft_per_box, pkg.pieces_per_box, pkg.boxes_per_pallet, pkg.sqft_per_pallet]);
        }
      }
    } else {
      unmatched++;
      const key = buildLookupKey(collection, null,
        row.variant_name?.split(',')[0]?.trim()?.toLowerCase()?.replace(/\s+/g, '-') || null,
        row.variant_name?.split(',')[1]?.trim()?.toLowerCase()?.replace(/\s+/g, '-') || null);
      if (!unmatchedProducts.has(row.product_name)) unmatchedProducts.set(row.product_name, []);
      unmatchedProducts.get(row.product_name).push({
        variant: row.variant_name,
        key,
        category: row.category,
      });

      // Clean up empty stubs (packaging rows with all NULL values)
      if (row.has_stub && !DRY_RUN) {
        await pool.query(`
          DELETE FROM packaging WHERE sku_id = $1
            AND sqft_per_box IS NULL AND pieces_per_box IS NULL
            AND boxes_per_pallet IS NULL AND sqft_per_pallet IS NULL
            AND weight_per_box_lbs IS NULL AND weight_per_pallet_lbs IS NULL
        `, [row.sku_id]);
        stubsCleaned++;
      } else if (row.has_stub) {
        stubsCleaned++;
      }
    }
  }

  console.log(`\n=== SUMMARY ===`);
  console.log(`Matched & ${DRY_RUN ? 'would update' : 'updated'}: ${matched}`);
  console.log(`Unmatched: ${unmatched}`);
  console.log(`Empty stubs ${DRY_RUN ? 'would clean' : 'cleaned'}: ${stubsCleaned}`);

  if (unmatchedProducts.size > 0) {
    console.log(`\n=== STILL UNMATCHED (${unmatchedProducts.size} products, ${unmatched} SKUs) ===\n`);
    for (const [name, variants] of unmatchedProducts) {
      console.log(`  ${name} [${variants[0].category}] (${variants.length} SKUs)`);
    }
  }

  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
