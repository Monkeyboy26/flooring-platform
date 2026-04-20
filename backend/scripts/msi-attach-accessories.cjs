#!/usr/bin/env node
/**
 * MSI Attach Accessories
 *
 * Redistributes accessory SKUs from catch-all "Trim & Accessories" products
 * to their correct individual main products across all categories.
 *
 * Strategy by category:
 *   - LVP / Engineered Hardwood: color-code matching via vendor_sku prefix
 *     (VTT<color>-<trim> → VTR/VTW/QUTR/QUPO<color>... main SKUs)
 *   - All others (tile, stone, hardscaping, mosaic, etc.): collection-level
 *     matching — find the main product in the same collection, with
 *     vendor_sku prefix matching as a tiebreaker when multiple exist
 *
 * Also sets proper variant_name from the trim code in the vendor_sku
 * and deactivates empty catch-all product shells afterward.
 *
 * Usage:
 *   node backend/scripts/msi-attach-accessories.cjs --dry-run   # Preview
 *   node backend/scripts/msi-attach-accessories.cjs              # Execute
 */

const { Pool } = require('pg');

const DRY_RUN = process.argv.includes('--dry-run');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

// ---------------------------------------------------------------------------
// Trim-code → human-readable variant name mapping
// ---------------------------------------------------------------------------
const TRIM_NAMES = {
  'FSNL-EE': 'Flush Stair Nose Long',
  'FSN-EE':  'Flush Stair Nose',
  'ST-EE':   'Stair Tread',
  'T-SR':    'T-Molding Reducer',
  '4-IN-1':  '4-in-1 Transition',
  'FSNL':    'Flush Stair Nose Long',
  'FSN':     'Flush Stair Nose',
  'OSN':     'Overlapping Stair Nose',
  'SRL':     'Reducer Long',
  'ECL':     'End Cap Long',
  'EC':      'End Cap',
  'QR':      'Quarter Round',
  'SR':      'Reducer',
  'ST':      'Stair Tread',
  'RT':      'Riser Tread',
  'T':       'T-Molding',
};

// Build regex: match longest first
const trimCodeAlt = Object.keys(TRIM_NAMES)
  .sort((a, b) => b.length - a.length)
  .map(c => c.replace(/-/g, '\\-'))
  .join('|');
const TRIM_CODE_REGEX = new RegExp(`-(${trimCodeAlt})$`, 'i');

// Non-VTT suffix patterns for tile/stone accessories
const SUFFIX_NAMES = {
  'COR':  'Corner Piece',
  '3DH':  'Corner Piece',
  'BN':   'Bullnose',
  'BNG':  'Bullnose',
  'BNP':  'Bullnose Polished',
  'SB':   'Stair Bullnose',
  'SB3':  'Stair Bullnose',
};

// ---------------------------------------------------------------------------
// Color-code extraction helpers
// ---------------------------------------------------------------------------

/** Extract color code from VTT-prefix accessory SKUs */
function extractAccColorCode(sku) {
  let m;
  // P-VTT or P-VTTHD prefix
  m = sku.match(/^P-VTT(?:HD)?([A-Z]+)-/i);
  if (m) return m[1].toUpperCase();
  // VTTHD prefix (hybrid density)
  m = sku.match(/^VTTHD([A-Z]+)-/i);
  if (m) return m[1].toUpperCase();
  // VTT prefix
  m = sku.match(/^VTT([A-Z]+)-/i);
  if (m) return m[1].toUpperCase();
  // TT prefix
  m = sku.match(/^TT([A-Z]+)-/i);
  if (m) return m[1].toUpperCase();
  return null;
}

/** Extract color code from main (non-accessory) SKUs.
 *  Returns an array of candidate codes (original + XL-stripped). */
function extractMainColorCodes(sku) {
  let m;
  // VTR, VTW, QUTR, QUPO prefixes (with optional HD)
  m = sku.match(/^(?:P-)?(?:VTR|VTW|QUTR|QUPO)(?:HD)?([A-Z]+)/i);
  if (m && m[1].length >= 3) {
    const code = m[1].toUpperCase();
    const codes = [code];
    // XL collections have XL prefix in main color codes but not in accessories
    // e.g. main VTRXLBERH → acc VTTBERHIL; strip XL to get BERH for matching
    if (code.startsWith('XL') && code.length > 4) {
      codes.push(code.slice(2));
    }
    return codes;
  }
  return [];
}

/** Parse trim code from VTT-style vendor_sku to get variant_name */
function parseTrimVariantName(vendorSku) {
  const m = vendorSku.match(TRIM_CODE_REGEX);
  if (m) return TRIM_NAMES[m[1].toUpperCase()] || m[1];
  return null;
}

/** Parse suffix for tile/stone accessories */
function parseSuffixVariantName(accSku, mainSkus) {
  // Try to find which suffix the accessory adds
  for (const [suffix, name] of Object.entries(SUFFIX_NAMES)) {
    const re = new RegExp(suffix + '(?:[\\-_]|$)', 'i');
    if (re.test(accSku)) return name;
  }
  // Check for -COR suffix (corners in stacked stone / hardscaping)
  if (/-COR\b/i.test(accSku)) return 'Corner Piece';
  if (/COR$/i.test(accSku)) return 'Corner Piece';
  // Bullnose detection: BN in SKU
  if (/\dBN[GPK]?[-\d]?/i.test(accSku)) return 'Bullnose';
  // Stair bullnose
  if (/SB\d?$/i.test(accSku)) return 'Stair Bullnose';
  // HF suffix (honed/filled)
  if (/HF\d?$/i.test(accSku)) return 'Trim';
  return 'Trim';
}

// Categories that use VTT color-code matching
const COLOR_CODE_CATEGORIES = new Set([
  'lvp-plank', 'engineered-hardwood', 'waterproof-wood',
]);

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`\nMSI Attach Accessories${DRY_RUN ? ' (DRY RUN)' : ''}`);
  console.log('='.repeat(60) + '\n');

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. Get MSI vendor ID
    const { rows: [vendor] } = await client.query(
      `SELECT id FROM vendors WHERE code = 'MSI'`
    );
    if (!vendor) {
      console.log('ERROR: MSI vendor not found');
      return;
    }
    const vendorId = vendor.id;

    // 2. Find all catch-all "Trim & Accessories" products (products with ONLY accessory SKUs)
    const { rows: catchAllProducts } = await client.query(`
      SELECT p.id, p.name, p.collection, c.slug as category_slug, c.name as category_name,
        COUNT(s.id) FILTER (WHERE s.variant_type = 'accessory') as acc_count,
        COUNT(s.id) FILTER (WHERE s.variant_type IS DISTINCT FROM 'accessory') as main_count
      FROM products p
      JOIN vendors v ON v.id = p.vendor_id AND v.code = 'MSI'
      LEFT JOIN categories c ON c.id = p.category_id
      LEFT JOIN skus s ON s.product_id = p.id AND s.status = 'active'
      WHERE p.status = 'active'
      GROUP BY p.id, p.name, p.collection, c.slug, c.name
      HAVING COUNT(s.id) FILTER (WHERE s.variant_type = 'accessory') > 0
         AND COUNT(s.id) FILTER (WHERE s.variant_type IS DISTINCT FROM 'accessory') = 0
      ORDER BY c.slug, p.collection
    `);

    console.log(`Found ${catchAllProducts.length} catch-all accessory products\n`);

    let totalMoved = 0, totalUnmatched = 0, totalDeactivated = 0;
    const unmatchedDetails = [];
    const affectedParentIds = new Set();

    // Group by collection for efficient processing
    const byCollection = new Map();
    for (const p of catchAllProducts) {
      const key = `${p.category_slug}\0${p.collection}`;
      if (!byCollection.has(key)) byCollection.set(key, []);
      byCollection.get(key).push(p);
    }

    for (const [key, catchAlls] of byCollection) {
      const [categorySlug, collection] = key.split('\0');
      const useColorCode = COLOR_CODE_CATEGORIES.has(categorySlug);

      // 3. Get all main (non-catch-all) products in this collection with their main SKUs
      const { rows: mainProducts } = await client.query(`
        SELECT p.id, p.name, p.collection
        FROM products p
        JOIN vendors v ON v.id = p.vendor_id AND v.code = 'MSI'
        WHERE p.status = 'active'
          AND p.collection = $1
          AND p.id NOT IN (${catchAlls.map((_, i) => `$${i + 2}`).join(',')})
        ORDER BY p.name
      `, [collection, ...catchAlls.map(p => p.id)]);

      if (mainProducts.length === 0) {
        // No main products in this collection — can't link
        for (const ca of catchAlls) {
          const { rows: accSkus } = await client.query(
            `SELECT id, vendor_sku FROM skus WHERE product_id = $1 AND status = 'active'`,
            [ca.id]
          );
          for (const s of accSkus) {
            unmatchedDetails.push(`  [${categorySlug}] ${ca.collection}: ${s.vendor_sku} — no main product in collection`);
          }
          totalUnmatched += accSkus.length;
        }
        continue;
      }

      // 4. Build color-code → product_id mapping (for VTT categories)
      const colorToProductId = {};
      // Also build a flat list of all main SKU prefixes for fuzzy matching
      const mainSkuPrefixes = []; // { prefix, productId }

      for (const mp of mainProducts) {
        const { rows: mainSkus } = await client.query(`
          SELECT vendor_sku FROM skus
          WHERE product_id = $1 AND status = 'active'
            AND (variant_type IS NULL OR variant_type <> 'accessory')
        `, [mp.id]);

        for (const ms of mainSkus) {
          if (useColorCode) {
            const codes = extractMainColorCodes(ms.vendor_sku);
            for (const code of codes) {
              colorToProductId[code] = mp.id;
            }
          }
          // Store prefixes for non-color-code matching
          mainSkuPrefixes.push({ sku: ms.vendor_sku, productId: mp.id });
        }
      }

      // 5. Process each catch-all product's accessory SKUs
      for (const ca of catchAlls) {
        const { rows: accSkus } = await client.query(`
          SELECT id, vendor_sku, variant_name FROM skus
          WHERE product_id = $1 AND status = 'active' AND variant_type = 'accessory'
        `, [ca.id]);

        let movedFromThis = 0;

        for (const acc of accSkus) {
          let targetProductId = null;
          let variantName = null;

          if (useColorCode) {
            // --- Color-code matching (LVP, Hardwood, Waterproof Wood) ---
            const accColor = extractAccColorCode(acc.vendor_sku);
            if (accColor) {
              targetProductId = colorToProductId[accColor];
              // Fuzzy fallback: partial match
              if (!targetProductId) {
                for (const [code, pid] of Object.entries(colorToProductId)) {
                  if (code.includes(accColor) || accColor.includes(code)) {
                    targetProductId = pid;
                    break;
                  }
                }
              }
            }
            variantName = parseTrimVariantName(acc.vendor_sku);
          } else {
            // --- Collection/prefix matching (tile, stone, etc.) ---
            if (mainProducts.length === 1) {
              // Only one main product — all accessories go there
              targetProductId = mainProducts[0].id;
            } else {
              // Multiple main products — try prefix matching
              // Strip known suffixes from accessory SKU and find best match
              const accBase = acc.vendor_sku
                .replace(/[-_]?COR[-_]?/gi, '')
                .replace(/[-_]?\d*BN[GPK]?[-_]?.*$/i, '')
                .replace(/[-_]?SB\d?$/i, '')
                .replace(/[-_]?HF\d?$/i, '')
                .replace(/[-_](EE|DB)$/i, '');

              let bestMatch = null;
              let bestLen = 0;
              for (const { sku, productId } of mainSkuPrefixes) {
                // Find longest common prefix
                let len = 0;
                const minLen = Math.min(accBase.length, sku.length);
                while (len < minLen && accBase[len].toUpperCase() === sku[len].toUpperCase()) len++;
                if (len > bestLen && len >= 6) {
                  bestLen = len;
                  bestMatch = productId;
                }
              }
              // Substring fallback: find a main SKU sharing a ≥7-char substring with the accessory
              if (!bestMatch) {
                const accUpper = acc.vendor_sku.toUpperCase();
                for (const { sku, productId } of mainSkuPrefixes) {
                  const skuUpper = sku.toUpperCase();
                  // Extract alphanumeric tokens ≥7 chars from accessory and check if they appear in main SKU
                  const tokens = accUpper.match(/[A-Z]{7,}/g) || [];
                  for (const tok of tokens) {
                    if (skuUpper.includes(tok)) {
                      bestMatch = productId;
                      break;
                    }
                  }
                  if (bestMatch) break;
                }
              }
              targetProductId = bestMatch;
            }
            variantName = parseSuffixVariantName(acc.vendor_sku, mainSkuPrefixes.map(m => m.sku));
          }

          if (!variantName) variantName = 'Trim';

          if (targetProductId) {
            if (!DRY_RUN) {
              await client.query(`
                UPDATE skus
                SET product_id = $1, variant_name = $2, updated_at = NOW()
                WHERE id = $3
              `, [targetProductId, variantName, acc.id]);
            }
            affectedParentIds.add(targetProductId);
            movedFromThis++;
            totalMoved++;
          } else {
            totalUnmatched++;
            unmatchedDetails.push(
              `  [${categorySlug}] ${ca.collection}: ${acc.vendor_sku} — no matching main product`
            );
          }
        }

        console.log(`  ${ca.name} (${ca.category_name}): ${movedFromThis}/${accSkus.length} linked`);

        // 6. Deactivate empty catch-all if all SKUs moved
        if (!DRY_RUN && movedFromThis === accSkus.length && movedFromThis > 0) {
          await client.query(`
            UPDATE products
            SET status = 'discontinued', is_active = false, updated_at = NOW()
            WHERE id = $1
          `, [ca.id]);
          totalDeactivated++;
        }
      }
    }

    // 7. Rebuild search vectors for affected parent products
    if (!DRY_RUN && affectedParentIds.size > 0) {
      console.log(`\nRebuilding search vectors for ${affectedParentIds.size} parent products...`);
      for (const pid of affectedParentIds) {
        try {
          await client.query('SELECT refresh_search_vectors($1)', [pid]);
        } catch {
          // Ignore if function doesn't exist
        }
      }
    }

    // 8. Summary
    console.log(`\n${'='.repeat(60)}`);
    console.log(`SUMMARY${DRY_RUN ? ' (DRY RUN — no changes committed)' : ''}:`);
    console.log(`  Accessory SKUs linked:       ${totalMoved}`);
    console.log(`  Catch-all products removed:  ${totalDeactivated}`);
    console.log(`  Unmatched:                   ${totalUnmatched}`);

    if (unmatchedDetails.length > 0) {
      const show = unmatchedDetails.slice(0, 40);
      console.log(`\nUnmatched accessories${unmatchedDetails.length > 40 ? ` (showing 40 of ${unmatchedDetails.length})` : ''}:`);
      for (const line of show) console.log(line);
    }

    if (DRY_RUN) {
      await client.query('ROLLBACK');
      console.log('\nDry run complete — all changes rolled back.');
    } else {
      await client.query('COMMIT');
      console.log('\nAll changes committed successfully.');
    }

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('\nError:', err.message);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
