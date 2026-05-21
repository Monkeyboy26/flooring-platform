#!/usr/bin/env node
/**
 * attach-elysium-accessories.cjs
 *
 * Activates Elysium Tile accessory SKUs and creates sku_accessories links.
 *
 * Elysium accessories (variant_type='accessory') are currently inactive/draft.
 * This script:
 *   1. Activates all Elysium accessory SKUs
 *   2. Links accessories to their parent main (sqft) SKUs within the same product
 *   3. For accessory-only products, matches cross-product within the same collection
 *   4. Derives and sets accessory_label values
 *
 * Usage:
 *   node backend/scripts/attach-elysium-accessories.cjs --dry-run
 *   node backend/scripts/attach-elysium-accessories.cjs
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
const VENDOR_ID = '550e8400-e29b-41d4-a716-446655440006'; // Elysium Tile

// ── Label derivation ─────────────────────────────────────────────────────────

const TYPE_KEYWORDS = [
  [/stair\s*nos[ei]\s*round/i, 'Stairnose'],
  [/flush\s*stair\s*nos[ei]/i, 'Flush Stairnose'],
  [/stair\s*nos[ei]/i, 'Stairnose'],
  [/t[-\s]?mold(?:ing)?/i, 'T-Mold'],
  [/reducer/i, 'Reducer'],
  [/threshold/i, 'Threshold'],
  [/quarter\s*round/i, 'Quarter Round'],
  [/bullnos[ei]/i, 'Bullnose'],
  [/pencil\s*liner/i, 'Pencil Liner'],
  [/chair\s*rail/i, 'Chair Rail'],
  [/cove\s*base/i, 'Cove Base'],
  [/jolly/i, 'Jolly Trim'],
  [/liner/i, 'Pencil Liner'],
  [/cane/i, 'Pencil Liner'],
  [/book\s*match\s*deco/i, 'Book Match Deco'],
];

function deriveLabel(variantName, productName) {
  const vn = variantName || '';
  const pn = productName || '';

  // Check variant_name
  for (const [re, label] of TYPE_KEYWORDS) {
    if (re.test(vn)) return label;
  }
  // Check product name
  for (const [re, label] of TYPE_KEYWORDS) {
    if (re.test(pn)) return label;
  }

  // Detect mosaic patterns
  if (/mosaic/i.test(vn) || /mosaic/i.test(pn)) return 'Mosaic';
  // Detect trim patterns
  if (/trim/i.test(vn)) return 'Trim';

  // Fallback: clean up variant_name
  const cleaned = vn
    .replace(/,?\s*\d[\d.\-\/]*\s*x\s*\d[\d.\-\/]*/gi, '')
    .replace(/\s*\(.*?\)\s*/g, '')
    .trim();
  return cleaned || 'Accessory';
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`attach-elysium-accessories.cjs — ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  console.log('─'.repeat(60));

  // Step 1: Activate all Elysium accessory SKUs
  const accSkusResult = await pool.query(`
    SELECT s.id, s.status
    FROM skus s
    JOIN products p ON s.product_id = p.id
    WHERE p.vendor_id = $1
      AND s.variant_type = 'accessory'
      AND s.status != 'active'
  `, [VENDOR_ID]);

  console.log(`Found ${accSkusResult.rows.length} inactive/draft Elysium accessory SKUs to activate`);

  if (!DRY_RUN && accSkusResult.rows.length > 0) {
    const ids = accSkusResult.rows.map(r => r.id);
    await pool.query(`
      UPDATE skus SET status = 'active', updated_at = CURRENT_TIMESTAMP
      WHERE id = ANY($1)
    `, [ids]);
    console.log(`  Activated ${ids.length} accessory SKUs`);
  }

  // Step 2: Load all Elysium products and their SKUs
  const allSkus = await pool.query(`
    SELECT s.id, s.product_id, s.vendor_sku, s.variant_name, s.variant_type,
      s.sell_by, s.accessory_label, p.name AS product_name, p.collection
    FROM skus s
    JOIN products p ON s.product_id = p.id
    WHERE p.vendor_id = $1
      AND (s.status = 'active' OR s.variant_type = 'accessory')
      AND s.is_sample = false
    ORDER BY p.collection, p.name, s.variant_type, s.vendor_sku
  `, [VENDOR_ID]);

  // Group by product
  const byProduct = {};
  for (const s of allSkus.rows) {
    if (!byProduct[s.product_id]) byProduct[s.product_id] = [];
    byProduct[s.product_id].push(s);
  }

  // Group by collection
  const byCollection = {};
  for (const s of allSkus.rows) {
    if (!byCollection[s.collection]) byCollection[s.collection] = [];
    byCollection[s.collection].push(s);
  }

  const linkBatch = []; // [parent_sku_id, accessory_sku_id, sort_order]
  const labelBatch = []; // [sku_id, label]

  // Step 3: Within-product matching
  console.log('\n── Within-product matching ──');
  let withinCount = 0;

  for (const [productId, skus] of Object.entries(byProduct)) {
    const mainSkus = skus.filter(s => s.variant_type !== 'accessory' && s.sell_by === 'box');
    const accSkus = skus.filter(s => s.variant_type === 'accessory');

    if (mainSkus.length === 0 || accSkus.length === 0) continue;

    const productName = skus[0].product_name;
    const collection = skus[0].collection;

    // Derive labels
    for (const acc of accSkus) {
      const label = deriveLabel(acc.variant_name, productName);
      if (label) {
        labelBatch.push([acc.id, label]);
      }
    }

    // All accessories go to all main SKUs within the same product
    // (Elysium products are per-color, so accessories match all size variants)
    for (const main of mainSkus) {
      let sortOrder = 0;
      for (const acc of accSkus) {
        linkBatch.push([main.id, acc.id, sortOrder++]);
        withinCount++;
      }
    }

    if (DRY_RUN) {
      console.log(`  ${collection} / ${productName}: ${mainSkus.length} main × ${accSkus.length} acc = ${mainSkus.length * accSkus.length} links`);
    }
  }

  console.log(`  Total within-product links: ${withinCount}`);

  // Step 4: Cross-product matching (accessory-only products → main products in same collection)
  console.log('\n── Cross-product matching ──');
  let crossCount = 0;

  // Find accessory-only products
  const accOnlyProducts = {};
  for (const [productId, skus] of Object.entries(byProduct)) {
    const mainSkus = skus.filter(s => s.variant_type !== 'accessory' && s.sell_by === 'box');
    const accSkus = skus.filter(s => s.variant_type === 'accessory');
    if (mainSkus.length === 0 && accSkus.length > 0) {
      accOnlyProducts[productId] = { skus: accSkus, name: skus[0].product_name, collection: skus[0].collection };
    }
  }

  for (const [productId, { skus: accSkus, name: accProductName, collection }] of Object.entries(accOnlyProducts)) {
    // Find main products in the same collection
    const collectionSkus = (byCollection[collection] || [])
      .filter(s => s.variant_type !== 'accessory' && s.sell_by === 'box' && s.product_id !== productId);

    if (collectionSkus.length === 0) {
      console.log(`  SKIP ${collection} / ${accProductName}: no main products in collection`);
      // Still derive labels
      for (const acc of accSkus) {
        const label = deriveLabel(acc.variant_name, accProductName);
        if (label) labelBatch.push([acc.id, label]);
      }
      continue;
    }

    // Derive labels
    for (const acc of accSkus) {
      const label = deriveLabel(acc.variant_name, accProductName);
      if (label) labelBatch.push([acc.id, label]);
    }

    // Try to match by product/color name
    // Group main SKUs by product_id for efficient matching
    const mainByProduct = {};
    for (const ms of collectionSkus) {
      if (!mainByProduct[ms.product_id]) {
        mainByProduct[ms.product_id] = { name: ms.product_name, skus: [] };
      }
      mainByProduct[ms.product_id].skus.push(ms);
    }

    // Normalize for matching
    const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

    // Strategy 1: Exact product name match (e.g., acc product "Grey" → main product "Grey" in same collection)
    const accNameNorm = norm(accProductName);
    let matched = false;

    for (const [mainProdId, { name: mainName, skus: mainSkus }] of Object.entries(mainByProduct)) {
      if (norm(mainName) === accNameNorm) {
        for (const main of mainSkus) {
          let sortOrder = 0;
          for (const acc of accSkus) {
            linkBatch.push([main.id, acc.id, sortOrder++]);
            crossCount++;
          }
        }
        matched = true;
        if (DRY_RUN) {
          console.log(`  ${collection} / ${accProductName} → ${mainName} (exact): ${mainSkus.length} main × ${accSkus.length} acc`);
        }
        break;
      }
    }

    if (matched) continue;

    // Strategy 2: Partial name match (e.g., "Country Marfil" acc → "Country Marfil Wall" main)
    for (const [mainProdId, { name: mainName, skus: mainSkus }] of Object.entries(mainByProduct)) {
      const mainNorm = norm(mainName);
      if (mainNorm.includes(accNameNorm) || accNameNorm.includes(mainNorm)) {
        for (const main of mainSkus) {
          let sortOrder = 0;
          for (const acc of accSkus) {
            linkBatch.push([main.id, acc.id, sortOrder++]);
            crossCount++;
          }
        }
        matched = true;
        if (DRY_RUN) {
          console.log(`  ${collection} / ${accProductName} → ${mainName} (partial): ${mainSkus.length} main × ${accSkus.length} acc`);
        }
        break;
      }
    }

    if (matched) continue;

    // Strategy 3: For "Book Match Deco" / "Jolly" / generic trim products,
    // link to ALL main products in the collection (shared accessories)
    const isGenericTrim = /book\s*match\s*deco|jolly|bullnose|quarter\s*round/i.test(accProductName);
    if (isGenericTrim) {
      // Extract color from acc product name to match specific main product
      const accColor = accProductName
        .replace(/book\s*match\s*deco/i, '')
        .replace(/jolly/i, '')
        .replace(/bullnose/i, '')
        .replace(/quarter\s*round/i, '')
        .trim();
      const accColorNorm = norm(accColor);

      if (accColorNorm) {
        // Try to match color to a specific main product
        let colorMatched = false;
        for (const [mainProdId, { name: mainName, skus: mainSkus }] of Object.entries(mainByProduct)) {
          if (norm(mainName).includes(accColorNorm) || accColorNorm.includes(norm(mainName))) {
            for (const main of mainSkus) {
              let sortOrder = 0;
              for (const acc of accSkus) {
                linkBatch.push([main.id, acc.id, sortOrder++]);
                crossCount++;
              }
            }
            colorMatched = true;
            if (DRY_RUN) {
              console.log(`  ${collection} / ${accProductName} → ${mainName} (color match): ${mainSkus.length} main × ${accSkus.length} acc`);
            }
            break;
          }
        }
        if (colorMatched) continue;
      }
    }

    // Strategy 4: Collection-wide shared accessory — link to all main products
    // Only if there's a small number of distinct main PRODUCTS (avoids flooding
    // color-specific accessories across unrelated products like SPC Diamond)
    const uniqueMainProducts = new Set(collectionSkus.map(s => s.product_id));
    if (uniqueMainProducts.size <= 4) {
      for (const main of collectionSkus) {
        let sortOrder = 0;
        for (const acc of accSkus) {
          linkBatch.push([main.id, acc.id, sortOrder++]);
          crossCount++;
        }
      }
      if (DRY_RUN) {
        console.log(`  ${collection} / ${accProductName} → ALL (${collectionSkus.length} main SKUs across ${uniqueMainProducts.size} products, shared)`);
      }
    } else {
      console.log(`  UNMATCHED ${collection} / ${accProductName}: ${accSkus.length} accessories, ${uniqueMainProducts.size} products in collection (too many for blanket match)`);
    }
  }

  console.log(`  Total cross-product links: ${crossCount}`);

  // Step 5: Handle SPC Diamond — each accessory product has accessories only, but
  // these share the same product_id as their main SKU (already handled in within-product)
  // Check if any SPC Diamond cross-product matches are needed
  const spcDiamondAccOnly = Object.entries(accOnlyProducts)
    .filter(([, v]) => v.collection === 'SPC Diamond');
  if (spcDiamondAccOnly.length > 0) {
    console.log(`\n── SPC Diamond cross-product ──`);
    for (const [productId, { skus: accSkus, name }] of spcDiamondAccOnly) {
      // Find the matching main product by name
      const mainSkus = (byCollection['SPC Diamond'] || [])
        .filter(s => s.variant_type !== 'accessory' && s.sell_by === 'box' && s.product_name === name && s.product_id !== productId);
      if (mainSkus.length > 0) {
        for (const main of mainSkus) {
          let sortOrder = 0;
          for (const acc of accSkus) {
            linkBatch.push([main.id, acc.id, sortOrder++]);
            crossCount++;
          }
        }
        console.log(`  ${name}: ${mainSkus.length} main × ${accSkus.length} acc = ${mainSkus.length * accSkus.length} links`);
      } else {
        console.log(`  ${name}: no matching main product found`);
      }
    }
  }

  // Deduplicate links
  const linkSet = new Set();
  const dedupedLinks = [];
  for (const [parent, acc, sort] of linkBatch) {
    const key = `${parent}|${acc}`;
    if (!linkSet.has(key)) {
      linkSet.add(key);
      dedupedLinks.push([parent, acc, sort]);
    }
  }

  // Deduplicate labels
  const labelMap = new Map();
  for (const [skuId, label] of labelBatch) {
    labelMap.set(skuId, label);
  }
  const dedupedLabels = Array.from(labelMap.entries());

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Total links to write: ${dedupedLinks.length} (deduped from ${linkBatch.length})`);
  console.log(`Total labels to write: ${dedupedLabels.length}`);

  if (DRY_RUN) {
    console.log('\nSample links (first 30):');
    for (const [parent, acc, sort] of dedupedLinks.slice(0, 30)) {
      console.log(`  ${parent} → ${acc} (sort: ${sort})`);
    }
    console.log('\nSample labels (first 20):');
    for (const [skuId, label] of dedupedLabels.slice(0, 20)) {
      console.log(`  ${skuId} → "${label}"`);
    }
  } else {
    // Step 6: Clear existing Elysium links
    const delResult = await pool.query(`
      DELETE FROM sku_accessories
      WHERE parent_sku_id IN (
        SELECT s.id FROM skus s
        JOIN products p ON p.id = s.product_id
        WHERE p.vendor_id = $1
      )
    `, [VENDOR_ID]);
    console.log(`\nCleared ${delResult.rowCount} existing Elysium sku_accessories links`);

    // Step 7: Write links in batches
    console.log('Writing sku_accessories links...');
    const BATCH_SIZE = 500;
    let written = 0;
    for (let i = 0; i < dedupedLinks.length; i += BATCH_SIZE) {
      const batch = dedupedLinks.slice(i, i + BATCH_SIZE);
      const values = [];
      const params = [];
      for (let j = 0; j < batch.length; j++) {
        const offset = j * 3;
        values.push(`($${offset + 1}, $${offset + 2}, $${offset + 3})`);
        params.push(batch[j][0], batch[j][1], batch[j][2]);
      }
      await pool.query(`
        INSERT INTO sku_accessories (parent_sku_id, accessory_sku_id, sort_order)
        VALUES ${values.join(', ')}
        ON CONFLICT (parent_sku_id, accessory_sku_id) DO UPDATE SET sort_order = EXCLUDED.sort_order
      `, params);
      written += batch.length;
      if (written % 2000 === 0 || written === dedupedLinks.length) {
        console.log(`  ${written}/${dedupedLinks.length} links written`);
      }
    }

    // Step 8: Write labels
    console.log('Writing accessory_label values...');
    for (let i = 0; i < dedupedLabels.length; i += BATCH_SIZE) {
      const batch = dedupedLabels.slice(i, i + BATCH_SIZE);
      const ids = batch.map(b => b[0]);
      const caseLines = batch.map((b, j) => `WHEN id = $${j * 2 + 1} THEN $${j * 2 + 2}`).join(' ');
      const params = [];
      for (const [skuId, label] of batch) {
        params.push(skuId, label);
      }
      await pool.query(`
        UPDATE skus SET accessory_label = CASE ${caseLines} END, updated_at = CURRENT_TIMESTAMP
        WHERE id = ANY($${params.length + 1})
      `, [...params, ids]);
    }
    console.log(`  ${dedupedLabels.length} labels written`);

    // Step 9: Summary
    const linkCount = await pool.query(`
      SELECT COUNT(*) FROM sku_accessories sa
      JOIN skus s ON sa.parent_sku_id = s.id
      JOIN products p ON s.product_id = p.id
      WHERE p.vendor_id = $1
    `, [VENDOR_ID]);
    const labelCount = await pool.query(`
      SELECT accessory_label, COUNT(*) FROM skus s
      JOIN products p ON s.product_id = p.id
      WHERE p.vendor_id = $1 AND s.accessory_label IS NOT NULL
      GROUP BY accessory_label ORDER BY accessory_label
    `, [VENDOR_ID]);

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`Elysium sku_accessories links: ${linkCount.rows[0].count}`);
    console.log('Labels:');
    for (const r of labelCount.rows) {
      console.log(`  ${r.accessory_label}: ${r.count}`);
    }
  }

  console.log('\nDone!');
  await pool.end();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
