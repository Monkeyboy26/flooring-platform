#!/usr/bin/env node
/**
 * fix-roca-naming.cjs
 *
 * Fixes Roca product/SKU naming issues from portal scrape:
 * 1. Strip ALL-CAPS echo suffixes from variant_name
 * 2. Strip stray quotation marks from variant_name (and product name)
 * 3. Expand abbreviations (Bg → Bright, Mg → Matte, Wh → White, etc.)
 * 4. Strip redundant trim-type abbreviation codes (Qr, Rc, Lc, Pen)
 * 5. Normalize dimension casing (X → x)
 * 6. Fix Nolita field tiles miscategorized as accessories
 * 7. Final whitespace cleanup
 * 8. Refresh search vectors
 *
 * Usage: node backend/scripts/fix-roca-naming.cjs [--dry-run]
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

// ── Phase 3: Abbreviation expansions ──
// Multi-word patterns first, then single-word
const ABBREVIATIONS = [
  [/\bSnow Wh\b/g,         'Snow White'],
  [/\bWh Ice\b/g,          'White Ice'],
  [/\bDark Gr\b/g,         'Dark Gray'],
  [/\bT\.\s*[Gg]ray\b/g,  'Tender Gray'],
  [/\bAt\.\s*[Bb]lue\b/g,  'Atoll Blue'],
  [/\bP\.\s*[Gg]reen\b/g,  'Peacock Green'],
  [/\bVel\.\s*[Pp]ink\b/g, 'Velvet Pink'],
  [/\bBg\b/g,              'Bright'],
  [/\bMg\b/g,              'Matte'],
  [/\bWh\b/g,              'White'],
  [/\bGr\b/g,              'Gray'],
];

// ── Phase 4: Redundant trim-type codes ──
const TRIM_CODES = [
  [/\bQr\s+(?=Quarter)/g,  ''],
  [/\bRc\s+(?=Right)/g,    ''],
  [/\bLc\s+(?=Left)/g,     ''],
  [/\bPen\s+(?=Pencil)/g,  ''],
];

/**
 * Phase 1: Strip trailing ALL-CAPS echo suffix.
 * The Roca portal appends a redundant uppercase description after the
 * human-readable portion, like:
 *   "Accents Black 3/4x6 Liner 3/4X6 LINER"  (repeated dimension echo)
 *   "Bg Biscuit 3X6 BEVELED"                  (trailing caps label only)
 *   "24" Bone Towel Bar Set 24" TOWEL BAR SET" (repeated linear measurement)
 *
 * Two strategies:
 *   1. If a dimension (AxB) or linear measurement (N") appears twice, strip
 *      from the second occurrence to end of string.
 *   2. If no repeated dimension, strip only trailing ALL-CAPS words (≥3 alpha
 *      chars each), preserving the dimension in the name.
 */
function stripEchoSuffix(name) {
  // Preserve (A)/(B)/(C)/etc. suffixes — these differentiate real variants
  const suffixMatch = name.match(/\s*(\([A-Z]\))\s*$/);
  let workName = name;
  let suffix = '';
  if (suffixMatch) {
    suffix = ' ' + suffixMatch[1];
    workName = name.slice(0, suffixMatch.index).trim();
  }

  const stripped = _stripEchoCore(workName);
  return (stripped + suffix).trim();
}

function _stripEchoCore(name) {
  // Don't strip from names that are entirely uppercase
  const alpha = name.replace(/[^a-zA-Z]/g, '');
  if (alpha.length > 0 && alpha === alpha.toUpperCase()) return name;

  // Strategy 1a: Find repeated AxB dimension patterns
  // Supports decimals (2.5x16), fractions (4 1/4x10), inch marks (3"x12", 3\u201Dx12\u201D)
  // Uses lookahead (?=\/) on fraction digit to prevent greedy consumption of adjacent dims
  const dimRegex = /(\d+(?:\.\d+)?(?:\s+\d+(?=\/))?(?:\/\d+)?)\s*["\u201C\u201D]?\s*[xX]\s*(\d+(?:\.\d+)?(?:\s+\d+(?=\/))?(?:\/\d+)?)\s*["\u201C\u201D]?/g;
  const dims = [];
  let m;
  while ((m = dimRegex.exec(name)) !== null) {
    const normalized = (m[1] + 'x' + m[2]).replace(/\s+/g, '').toLowerCase();
    // Fuzzy: strip fraction suffixes (e.g. "4 1/4" → "4") for approximate matching
    const d1 = m[1].replace(/\s+\d+\/\d+/g, '').trim();
    const d2 = m[2].replace(/\s+\d+\/\d+/g, '').trim();
    const fuzzy = (d1 + 'x' + d2).toLowerCase();
    dims.push({ normalized, fuzzy, index: m.index, length: m[0].length });
  }
  for (let i = dims.length - 1; i >= 1; i--) {
    for (let j = 0; j < i; j++) {
      if (dims[i].normalized === dims[j].normalized || dims[i].fuzzy === dims[j].fuzzy) {
        // Repeated dimension — verify remainder is all-caps or empty
        const afterDim = name.slice(dims[i].index + dims[i].length).trim();
        const afterAlpha = afterDim.replace(/[^a-zA-Z]/g, '');
        if (afterAlpha.length === 0 || afterAlpha === afterAlpha.toUpperCase()) {
          const stripped = name.slice(0, dims[i].index).trim();
          if (stripped.length > 0) return stripped;
        }
      }
    }
  }

  // Strategy 1b: Find repeated linear measurements (e.g. 24" ... 24")
  const linearRegex = /(\d+)\s*["\u201C\u201D]/g;
  const linears = [];
  while ((m = linearRegex.exec(name)) !== null) {
    linears.push({ value: m[1], index: m.index, length: m[0].length });
  }
  for (let i = linears.length - 1; i >= 1; i--) {
    for (let j = 0; j < i; j++) {
      if (linears[i].value === linears[j].value) {
        const afterLinear = name.slice(linears[i].index + linears[i].length).trim();
        const afterAlpha = afterLinear.replace(/[^a-zA-Z]/g, '');
        if (afterAlpha.length === 0 || afterAlpha === afterAlpha.toUpperCase()) {
          const stripped = name.slice(0, linears[i].index).trim();
          if (stripped.length > 0) return stripped;
        }
      }
    }
  }

  // Strategy 2: Strip trailing ALL-CAPS words only (not the dimension)
  // Each word must be ≥3 uppercase-alpha/dot/slash characters
  const trailingCaps = /\s+((?:[A-Z][A-Z ./]{2,}\s+)*[A-Z][A-Z ./]{2,})$/;
  const capsMatch = name.match(trailingCaps);
  if (capsMatch) {
    const before = name.slice(0, capsMatch.index);
    // Only strip if there's mixed-case content before (not all-caps)
    if (/[a-z]/.test(before) && before.trim().length > 0) {
      return before.trim();
    }
  }

  return name;
}

/**
 * Strip product-name echo from variant_name.
 * Handles: "24x36r 20mm Serena Crosscut Moka" where product is "20mm Serena Crosscut Moka"
 * → result: "24x36r"
 */
function stripProductNameEcho(variantName, productName) {
  if (!productName || productName.length < 4) return variantName;
  if (variantName === productName) return variantName; // exact dup is not an echo prefix
  if (variantName.endsWith(' ' + productName)) {
    const prefix = variantName.slice(0, -(productName.length + 1)).trim();
    if (prefix.length > 0) return prefix;
  }
  return variantName;
}

/**
 * Phase 2: Strip stray quotation marks (inch-mark artifacts).
 * Handles both ASCII " and Unicode curly quotes (\u201C, \u201D).
 */
function stripQuotes(name) {
  return name.replace(/["\u201C\u201D]/g, '').replace(/\s{2,}/g, ' ').trim();
}

/**
 * Phase 3: Expand abbreviations.
 */
function expandAbbreviations(name) {
  let result = name;
  for (const [pattern, replacement] of ABBREVIATIONS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

/**
 * Phase 4: Strip redundant trim-type abbreviation codes.
 */
function stripTrimCodes(name) {
  let result = name;
  for (const [pattern, replacement] of TRIM_CODES) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

/**
 * Phase 5: Normalize dimension casing (X → x between digits).
 */
function normalizeDimensions(name) {
  return name.replace(/(\d)X(\d)/g, '$1x$2');
}

/**
 * Phase 7: Final whitespace cleanup.
 */
function cleanWhitespace(name) {
  return name.replace(/\s{2,}/g, ' ').trim();
}

/**
 * Apply all variant_name fixes in sequence.
 */
function fixVariantName(name) {
  let fixed = name;
  fixed = stripEchoSuffix(fixed);    // Phase 1
  fixed = stripQuotes(fixed);         // Phase 2
  fixed = expandAbbreviations(fixed); // Phase 3
  fixed = stripTrimCodes(fixed);      // Phase 4
  fixed = normalizeDimensions(fixed); // Phase 5
  fixed = cleanWhitespace(fixed);     // Phase 7
  return fixed;
}

/**
 * Apply product name fixes (quotes, abbreviations, dimensions, whitespace).
 */
function fixProductName(name) {
  let fixed = name;
  fixed = stripQuotes(fixed);
  fixed = expandAbbreviations(fixed);
  fixed = normalizeDimensions(fixed);
  fixed = cleanWhitespace(fixed);
  return fixed;
}

async function main() {
  const client = await pool.connect();
  try {
    console.log(`\n=== Roca Naming Fix ${DRY_RUN ? '(DRY RUN)' : ''} ===\n`);

    // Find vendor
    const vendorRes = await client.query(`SELECT id FROM vendors WHERE code = 'ROCA'`);
    if (!vendorRes.rows.length) { console.log('No ROCA vendor found'); return; }
    const vendorId = vendorRes.rows[0].id;

    // Load all active Roca SKUs with product info
    const skuRes = await client.query(`
      SELECT s.id as sku_id, s.variant_name, s.variant_type, s.accessory_label,
             p.id as product_id, p.name as product_name, p.collection
      FROM skus s
      JOIN products p ON p.id = s.product_id
      WHERE p.vendor_id = $1
        AND p.status = 'active'
        AND s.status = 'active'
      ORDER BY p.collection, p.name, s.variant_name
    `, [vendorId]);

    console.log(`Loaded ${skuRes.rows.length} active Roca SKUs\n`);

    if (!DRY_RUN) {
      await client.query('BEGIN');
    }

    // ── Phases 1-5, 7: Fix variant names ──
    console.log('── Phases 1-5, 7: Fix variant names ──');
    let echoCount = 0, quoteCount = 0, abbrCount = 0, trimCount = 0, dimCount = 0;
    let prodEchoCount = 0;
    let totalVariantUpdates = 0;

    const skuUpdates = []; // { skuId, newName }

    for (const row of skuRes.rows) {
      if (!row.variant_name) continue;

      const original = row.variant_name;
      let fixed = original;

      // Phase 1a: echo suffix (first pass — before quote stripping)
      const afterEcho = stripEchoSuffix(fixed);
      if (afterEcho !== fixed) echoCount++;
      fixed = afterEcho;

      // Phase 2: quotes
      const afterQuotes = stripQuotes(fixed);
      if (afterQuotes !== fixed) quoteCount++;
      fixed = afterQuotes;

      // Phase 1b: echo suffix (second pass — after quote stripping, catches
      // cases like Crackled 3"x12" Aqua 3x12 where quotes hid the repeat)
      const afterEcho2 = stripEchoSuffix(fixed);
      if (afterEcho2 !== fixed) echoCount++;
      fixed = afterEcho2;

      // Phase 3: abbreviations
      const afterAbbr = expandAbbreviations(fixed);
      if (afterAbbr !== fixed) abbrCount++;
      fixed = afterAbbr;

      // Phase 4: trim codes
      const afterTrim = stripTrimCodes(fixed);
      if (afterTrim !== fixed) trimCount++;
      fixed = afterTrim;

      // Phase 5: dimension casing
      const afterDim = normalizeDimensions(fixed);
      if (afterDim !== fixed) dimCount++;
      fixed = afterDim;

      // Phase 5b: product-name echo (e.g. "24x36r 20mm Serena..." where product is "20mm Serena...")
      const afterProdEcho = stripProductNameEcho(fixed, row.product_name);
      if (afterProdEcho !== fixed) prodEchoCount++;
      fixed = afterProdEcho;

      // Phase 7: whitespace
      fixed = cleanWhitespace(fixed);

      if (fixed !== original) {
        skuUpdates.push({ skuId: row.sku_id, newName: fixed });
        console.log(`  "${original}" → "${fixed}"`);
        totalVariantUpdates++;
      }
    }

    if (!DRY_RUN) {
      for (const { skuId, newName } of skuUpdates) {
        await client.query(`UPDATE skus SET variant_name = $1 WHERE id = $2`, [newName, skuId]);
      }
    }

    console.log(`\n  Echo suffixes stripped: ${echoCount}`);
    console.log(`  Quotes stripped:       ${quoteCount}`);
    console.log(`  Product name echoes:   ${prodEchoCount}`);
    console.log(`  Abbreviations expanded: ${abbrCount}`);
    console.log(`  Trim codes stripped:   ${trimCount}`);
    console.log(`  Dimensions normalized: ${dimCount}`);
    console.log(`  Total variant updates: ${totalVariantUpdates}\n`);

    // ── Phases 2-3, 5, 7: Fix product names ──
    console.log('── Phases 2-3, 5, 7: Fix product names ──');
    const prodRes = await client.query(`
      SELECT id, name FROM products
      WHERE vendor_id = $1 AND status = 'active'
      ORDER BY name
    `, [vendorId]);

    let productUpdates = 0;
    for (const prod of prodRes.rows) {
      const fixed = fixProductName(prod.name);
      if (fixed !== prod.name) {
        console.log(`  "${prod.name}" → "${fixed}"`);
        if (!DRY_RUN) {
          await client.query(`UPDATE products SET name = $1 WHERE id = $2`, [fixed, prod.id]);
        }
        productUpdates++;
      }
    }
    console.log(`  Product names updated: ${productUpdates}\n`);

    // ── Phase 6: Fix Nolita field tiles miscategorized as accessories ──
    console.log('── Phase 6: Fix Nolita field tile categorization ──');
    let nolitaFieldCount = 0;
    let nolitaMosaicCount = 0;

    for (const row of skuRes.rows) {
      if (!row.collection || !row.collection.toLowerCase().includes('nolita')) continue;
      if (row.variant_type !== 'accessory') continue;
      if (!row.variant_name) continue;

      const name = row.variant_name;
      let newType = null;

      if (/\bField\b/i.test(name)) {
        newType = 'floor_tile';
        nolitaFieldCount++;
      } else if (/\bMosaic\b/i.test(name)) {
        newType = 'mosaic';
        nolitaMosaicCount++;
      }

      if (newType) {
        console.log(`  "${name}" (${row.variant_type}) → ${newType}, clear accessory_label`);
        if (!DRY_RUN) {
          await client.query(
            `UPDATE skus SET variant_type = $1, accessory_label = NULL WHERE id = $2`,
            [newType, row.sku_id]
          );
        }
      }
    }
    console.log(`  Nolita field tiles fixed:  ${nolitaFieldCount}`);
    console.log(`  Nolita mosaics fixed:      ${nolitaMosaicCount}\n`);

    // ── Phase 8: Refresh search vectors ──
    if (!DRY_RUN) {
      console.log('── Phase 8: Refreshing search vectors ──');
      await client.query(`SELECT refresh_search_vectors(id) FROM products WHERE vendor_id = $1 AND status = 'active'`, [vendorId]);
      console.log('  Done\n');
    }

    // ── Commit transaction ──
    if (!DRY_RUN) {
      await client.query('COMMIT');
    }

    // ── Summary ──
    console.log('=== Summary ===');
    console.log(`Variant names updated:  ${totalVariantUpdates}`);
    console.log(`  - Echo suffixes:      ${echoCount}`);
    console.log(`  - Quotes stripped:    ${quoteCount}`);
    console.log(`  - Product echoes:    ${prodEchoCount}`);
    console.log(`  - Abbreviations:     ${abbrCount}`);
    console.log(`  - Trim codes:        ${trimCount}`);
    console.log(`  - Dimensions:        ${dimCount}`);
    console.log(`Product names updated:  ${productUpdates}`);
    console.log(`Nolita reclassified:    ${nolitaFieldCount + nolitaMosaicCount}`);
    if (DRY_RUN) console.log('\n(DRY RUN — no changes written)');

  } catch (err) {
    if (!DRY_RUN) {
      await client.query('ROLLBACK').catch(() => {});
    }
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
