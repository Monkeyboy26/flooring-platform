#!/usr/bin/env node
/**
 * fix-adex-naming.cjs
 *
 * Fixes ADEX product/SKU naming issues:
 * 1. Expands abbreviations (Sge → Single Glazed Edge, etc.)
 * 2. Strips trailing dimensions from product names (comes from size attribute instead)
 * 3. Fixes casing (ALL CAPS → Title Case, "(glazed Top Edge)" → "(Glazed Top Edge)")
 * 4. Fixes RECTANGLE mosaic product names, variant names, and color attributes
 * 5. Merges products that collide after dimension stripping (same collection + name)
 * 6. Clears display_name (let fullProductName handle suffix from category)
 * 7. Refreshes search vectors
 *
 * Usage: node backend/scripts/fix-adex-naming.cjs [--dry-run]
 */

const { Pool } = require('pg');

const DRY_RUN = process.argv.includes('--dry-run');
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASS || 'postgres',
});

// ── abbreviation expansions ──
const ABBREVIATIONS = [
  [/\bFramed Sge\b/g,   'Framed Single Glazed Edge'],
  [/\bFramed Dge\b/g,   'Framed Double Glazed Edge'],
  [/\bBeveled Sge\b/g,  'Beveled Single Glazed Edge'],
  [/\bBeveled Dge\b/g,  'Beveled Double Glazed Edge'],
  [/\bSge\b/g,          'Single Glazed Edge'],
  [/\bDge\b/g,          'Double Glazed Edge'],
  [/\bSbn\b/g,          'Single Bullnose'],
  [/\bDbn\b/g,          'Double Bullnose'],
];

// ── casing fixes ──
const CASING_FIXES = [
  [/\(glazed Top Edge\)/g, '(Glazed Top Edge)'],
  [/\(one Overglazed Edge\)/g, '(One Overglazed Edge)'],
  [/\bBase Board end Cap\b/g, 'Base Board End Cap'],
];

// Matches " 3 x 6", " 5.8 x 5.8", " 11.02 x 11.14", " 5.8x5.8" at end of string
const TRAILING_DIMS = /\s+\d+(?:\.\d+)?\s*[xX]\s*\d+(?:\.\d+)?$/i;

function toTitleCase(str) {
  return str.toLowerCase().replace(/(?:^|\s)\S/g, c => c.toUpperCase());
}

function isAllCaps(str) {
  const alpha = str.replace(/[^a-zA-Z]/g, '');
  if (alpha.length < 4) return false;
  const upper = alpha.replace(/[^A-Z]/g, '').length;
  return upper / alpha.length > 0.8;
}

// RECTANGLE HERRINGBONE 11"X11.1" DENIM 11.02 x 11.14
// RECTANGLE OFFSET 10.4"X11.8" BLACK
function extractRectangleInfo(name) {
  const herringMatch = name.match(/^RECTANGLE\s+HERRINGBONE\s+\d+(?:\.\d+)?"\s*X\s*\d+(?:\.\d+)?"\s+(.+?)(?:\s+\d+(?:\.\d+)?\s*x\s*\d+(?:\.\d+)?)?$/i);
  if (herringMatch) {
    return { baseName: 'Rectangle Herringbone', color: toTitleCase(herringMatch[1].trim()) };
  }
  const offsetMatch = name.match(/^RECTANGLE\s+OFFSET\s+\d+(?:\.\d+)?"\s*X\s*\d+(?:\.\d+)?"\s+(.+?)(?:\s+\d+(?:\.\d+)?\s*x\s*\d+(?:\.\d+)?)?$/i);
  if (offsetMatch) {
    return { baseName: 'Rectangle Offset', color: toTitleCase(offsetMatch[1].trim()) };
  }
  return null;
}

function fixProductName(name) {
  let fixed = name;
  for (const [pattern, replacement] of ABBREVIATIONS) {
    fixed = fixed.replace(pattern, replacement);
  }
  for (const [pattern, replacement] of CASING_FIXES) {
    fixed = fixed.replace(pattern, replacement);
  }
  fixed = fixed.replace(TRAILING_DIMS, '');
  fixed = fixed.replace(/\s{2,}/g, ' ').trim();
  if (isAllCaps(fixed)) {
    fixed = toTitleCase(fixed);
  }
  return fixed;
}

async function main() {
  const client = await pool.connect();
  try {
    console.log(`\n=== ADEX Naming Fix ${DRY_RUN ? '(DRY RUN)' : ''} ===\n`);

    const vendorRes = await client.query(`SELECT id FROM vendors WHERE code = 'ADEX'`);
    if (!vendorRes.rows.length) { console.log('No ADEX vendor found'); return; }
    const vendorId = vendorRes.rows[0].id;

    // Get attribute IDs
    const colorAttrId = (await client.query(`SELECT id FROM attributes WHERE slug = 'color'`)).rows[0]?.id;
    const sizeAttrId = (await client.query(`SELECT id FROM attributes WHERE slug = 'size'`)).rows[0]?.id;

    // ── Load all ADEX products ──
    const prodRes = await client.query(`
      SELECT id, name, display_name, collection, category_id
      FROM products
      WHERE vendor_id = $1 AND status = 'active'
      ORDER BY name
    `, [vendorId]);

    // ── Step 1: Compute new names and detect collisions ──
    console.log('── Step 1: Compute new names ──');

    // Build rename plan: for each product, compute new name + RECTANGLE info
    const renamePlan = [];
    const rectangleProducts = [];

    for (const prod of prodRes.rows) {
      const rectInfo = extractRectangleInfo(prod.name);
      if (rectInfo) {
        rectangleProducts.push({ ...prod, ...rectInfo });
        renamePlan.push({ ...prod, newName: rectInfo.baseName, isRect: true, rectColor: rectInfo.color });
      } else {
        const newName = fixProductName(prod.name);
        renamePlan.push({ ...prod, newName, isRect: false });
      }
    }

    // Group by (collection, newName) to find collisions
    const groups = {};
    for (const p of renamePlan) {
      const key = `${p.collection || ''}|||${p.newName}`;
      if (!groups[key]) groups[key] = [];
      groups[key].push(p);
    }

    // ── Step 2: Merge colliding products ──
    console.log('── Step 2: Merge colliding products ──');
    let mergeCount = 0;

    for (const [key, prods] of Object.entries(groups)) {
      if (prods.length <= 1) continue;

      // Pick the winner: product with the most active SKUs, or earliest created
      const skuCounts = await Promise.all(prods.map(async p => {
        const r = await client.query(`SELECT COUNT(*) as cnt FROM skus WHERE product_id = $1 AND status = 'active'`, [p.id]);
        return { ...p, skuCount: parseInt(r.rows[0].cnt) };
      }));
      skuCounts.sort((a, b) => b.skuCount - a.skuCount);
      const winner = skuCounts[0];
      const losers = skuCounts.slice(1);

      const [col, newName] = key.split('|||');
      console.log(`  Merging ${prods.length} products → "${newName}" (${col})`);
      console.log(`    Winner: "${winner.name}" (${winner.skuCount} SKUs)`);

      for (const loser of losers) {
        console.log(`    Merging: "${loser.name}" (${loser.skuCount} SKUs) → winner`);

        if (!DRY_RUN) {
          // Move SKUs to winner product
          await client.query(`UPDATE skus SET product_id = $1 WHERE product_id = $2`, [winner.id, loser.id]);

          // Move SKU-level media_assets (sku_id IS NOT NULL) to winner product
          await client.query(`
            UPDATE media_assets SET product_id = $1
            WHERE product_id = $2 AND sku_id IS NOT NULL
          `, [winner.id, loser.id]);

          // For product-level media_assets (sku_id IS NULL), offset sort_order to avoid conflicts
          const maxSortRes = await client.query(`
            SELECT asset_type, COALESCE(MAX(sort_order), -1) as max_sort
            FROM media_assets
            WHERE product_id = $1 AND sku_id IS NULL
            GROUP BY asset_type
          `, [winner.id]);
          const maxSorts = {};
          for (const r of maxSortRes.rows) maxSorts[r.asset_type] = parseInt(r.max_sort);

          const loserAssets = await client.query(`
            SELECT id, asset_type, sort_order FROM media_assets
            WHERE product_id = $1 AND sku_id IS NULL
            ORDER BY asset_type, sort_order
          `, [loser.id]);

          for (const asset of loserAssets.rows) {
            // Skip duplicate spec_pdf — winner already has one
            if (asset.asset_type === 'spec_pdf' && maxSorts['spec_pdf'] !== undefined) {
              await client.query(`DELETE FROM media_assets WHERE id = $1`, [asset.id]);
              continue;
            }
            const nextSort = (maxSorts[asset.asset_type] ?? -1) + 1;
            maxSorts[asset.asset_type] = nextSort;
            await client.query(`
              UPDATE media_assets SET product_id = $1, sort_order = $2 WHERE id = $3
            `, [winner.id, nextSort, asset.id]);
          }

          // Deactivate loser product
          await client.query(`UPDATE products SET status = 'draft', display_name = NULL WHERE id = $1`, [loser.id]);
        }
        mergeCount++;
      }
    }
    console.log(`  Merged ${mergeCount} products\n`);

    // ── Step 3: Rename products ──
    console.log('── Step 3: Rename products ──');
    let renameCount = 0;

    // Re-fetch active products after merges (losers are now draft)
    const activeProdRes = await client.query(`
      SELECT id, name, display_name FROM products
      WHERE vendor_id = $1 AND status = 'active'
      ORDER BY name
    `, [vendorId]);

    for (const prod of activeProdRes.rows) {
      const rectInfo = extractRectangleInfo(prod.name);
      let newName;
      if (rectInfo) {
        newName = rectInfo.baseName;
      } else {
        newName = fixProductName(prod.name);
      }

      if (newName !== prod.name || prod.display_name !== null) {
        if (newName !== prod.name) {
          console.log(`  "${prod.name}" → "${newName}"`);
        }
        if (!DRY_RUN) {
          await client.query(`UPDATE products SET name = $1, display_name = NULL WHERE id = $2`, [newName, prod.id]);
        }
        renameCount++;
      }
    }
    console.log(`  Renamed ${renameCount} products\n`);

    // ── Step 4: Fix RECTANGLE variant names + color attributes ──
    console.log('── Step 4: Fix RECTANGLE variants + colors ──');
    let variantUpdates = 0;
    let colorAttrUpdates = 0;

    for (const rect of rectangleProducts) {
      const skuRes = await client.query(`
        SELECT id, variant_name FROM skus WHERE product_id = $1 AND status = 'active'
      `, [rect.id]);

      for (const sku of skuRes.rows) {
        if (sku.variant_name !== rect.color) {
          console.log(`  variant: "${sku.variant_name}" → "${rect.color}"`);
          if (!DRY_RUN) {
            await client.query(`UPDATE skus SET variant_name = $1 WHERE id = $2`, [rect.color, sku.id]);
          }
          variantUpdates++;
        }

        if (colorAttrId) {
          const existing = await client.query(`
            SELECT value FROM sku_attributes WHERE sku_id = $1 AND attribute_id = $2
          `, [sku.id, colorAttrId]);
          if (existing.rows.length && existing.rows[0].value !== rect.color) {
            if (!DRY_RUN) {
              await client.query(`
                UPDATE sku_attributes SET value = $1 WHERE sku_id = $2 AND attribute_id = $3
              `, [rect.color, sku.id, colorAttrId]);
            }
            colorAttrUpdates++;
          }
        }
      }
    }
    console.log(`  Updated ${variantUpdates} variant names, ${colorAttrUpdates} color attrs\n`);

    // ── Step 5: Refresh search vectors ──
    if (!DRY_RUN) {
      console.log('── Step 5: Refreshing search vectors ──');
      await client.query(`
        UPDATE products SET search_vector = (
          setweight(to_tsvector('english', coalesce(name, '')), 'A') ||
          setweight(to_tsvector('english', coalesce(collection, '')), 'B') ||
          setweight(to_tsvector('english', coalesce(description_short, '')), 'C') ||
          setweight(to_tsvector('english', coalesce(description_long, '')), 'D')
        )
        WHERE vendor_id = $1 AND status = 'active'
      `, [vendorId]);
      console.log('  Done\n');
    }

    // ── Summary ──
    console.log('=== Summary ===');
    console.log(`Products merged:   ${mergeCount}`);
    console.log(`Products renamed:  ${renameCount}`);
    console.log(`Variants updated:  ${variantUpdates}`);
    console.log(`Color attrs fixed: ${colorAttrUpdates}`);
    if (DRY_RUN) console.log('\n(DRY RUN — no changes written)');

  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
