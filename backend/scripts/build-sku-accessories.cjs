#!/usr/bin/env node
/**
 * build-sku-accessories.cjs
 *
 * Populates the `sku_accessories` junction table and `accessory_label` column.
 * Links each accessory SKU to its matching parent (main flooring) SKU(s) within
 * the same product, replacing the fragile client-side matching logic.
 *
 * Also handles Shaw's cross-product `companion_skus` attribute.
 *
 * Usage:
 *   node backend/scripts/build-sku-accessories.cjs --dry-run
 *   node backend/scripts/build-sku-accessories.cjs
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

// ── Accessory label derivation ─────────────────────────────────────────────

/** Recognized accessory type keywords and their canonical labels */
const TYPE_KEYWORDS = [
  // Order matters — more specific patterns first
  [/flush\s*stair\s*nos[ei]/i, 'Flush Stairnose'],
  [/overlap(?:ping)?\s*stair\s*nos[ei]/i, 'Overlap Stairnose'],
  [/stair\s*nos[ei]/i, 'Stairnose'],
  [/stair\s*tread/i, 'Stair Tread'],
  [/step\s*nos[ei]/i, 'Stairnose'],
  [/overlap\s*nosing/i, 'Overlap Stairnose'],
  [/nosing/i, 'Stairnose'],
  [/t[-\s]?mold(?:ing)?/i, 'T-Mold'],
  [/multi[-\s]?purpose\s*(?:reducer)?/i, 'Multi-Purpose'],
  [/overlap\s*reducer/i, 'Overlap Reducer'],
  [/reducer/i, 'Reducer'],
  [/threshold/i, 'Threshold'],
  [/end\s*cap/i, 'End Cap'],
  [/quarter\s*round/i, 'Quarter Round'],
  [/wall\s*base/i, 'Wall Base'],
  [/versa\s*edge/i, 'Versa Edge'],
  [/top\s*step/i, 'Topstep'],
  [/simple\s*st(?:air)?\b/i, 'SimpleStair'],
  [/seam[-\s]?weld(?:ing)?\s*rod/i, 'Seam-Weld Rod'],
  [/weld(?:ing)?\s*rod/i, 'Welding Rod'],
  [/trim\s*strip/i, 'Trim Strip'],
  [/3[-\s]?in[-\s]?1\s*mold/i, '3-in-1 Molding'],
  [/left\s*cove/i, 'Left Cove'],
  [/right\s*cove/i, 'Right Cove'],
  [/cove(?:\s*[-–]\s*flat\s*top)/i, 'Cove Base'],
  [/v[-\s]?cap/i, 'V-Cap'],
  [/radius\s*(?:bullnos[ei])?/i, 'Radius Bullnose'],
  [/mud\s*cap/i, 'Mud Cap'],
  [/surface\s*cap/i, 'Surface Cap'],
  [/contour/i, 'Contour Trim'],
  [/bullnos[ei]/i, 'Bullnose'],
  [/pencil(?:\s*liner)?/i, 'Pencil Liner'],
  [/chair\s*rail/i, 'Chair Rail'],
  [/flat\s*top/i, 'Cove Base'],
  [/cove\s*(?:base|quarry)/i, 'Cove Base'],
  [/jolly\s*trim/i, 'Jolly Trim'],
  [/schluter/i, 'Edge Trim'],
  [/adhesive/i, 'Adhesive'],
  [/grout(?:\s*caulk)?/i, 'Grout'],
  [/sealant|sealer|caulk/i, 'Sealant'],
  [/underlayment/i, 'Underlayment'],
];

/** SLCC vendor_sku suffix → label */
const SLCC_SUFFIX_MAP = {
  'EC': 'End Cap', 'FSN': 'Flush Stairnose', 'OSN': 'Overlap Stairnose',
  'QR': 'Quarter Round', 'RD': 'Reducer', 'TM': 'T-Mold', 'TH': 'Threshold',
  'SN': 'Stairnose',
};

/** Hartco/AHF vendor_sku prefix → label */
const HARTCO_PREFIX_MAP = {
  'TR': 'Reducer', 'TS': 'Flush Stairnose', 'TH': 'Threshold',
  'TM': 'T-Mold', 'TQ': 'Quarter Round', 'TP': 'Multi-Purpose',
};

/** Armstrong vendor_sku suffix → label */
const ARMSTRONG_SUFFIX_MAP = {
  'TRM': 'Trim Strip', 'STR': 'Stair Tread',
};

/**
 * Derive the accessory label for a given SKU.
 * Tries multiple strategies in priority order.
 */
function deriveLabel(acc, productName) {
  const vn = acc.variant_name || '';
  const vsku = acc.vendor_sku || '';
  const pname = productName || '';

  // Strategy 1: "Color - Type" format (Tri-West/AHF, True Touch)
  const dashIdx = vn.indexOf(' - ');
  if (dashIdx >= 0) {
    const typePart = vn.substring(dashIdx + 3).trim();
    // Check if the type part contains recognized keywords
    for (const [re, label] of TYPE_KEYWORDS) {
      if (re.test(typePart)) return label;
    }
    // If it's a meaningful string (not just a color), use it
    if (typePart.length > 2) return typePart;
  }

  // Strategy 2: Hartco/Armstrong vendor_sku prefix (AHFTR..., ARMTH..., etc.)
  const prefixMatch = vsku.match(/^(AHF|ARM)/i);
  if (prefixMatch) {
    const bare = vsku.substring(prefixMatch[1].length);
    if (bare.length >= 2) {
      const p2 = bare.substring(0, 2).toUpperCase();
      if (HARTCO_PREFIX_MAP[p2]) return HARTCO_PREFIX_MAP[p2];
    }
  }

  // Strategy 3: Armstrong vendor_sku suffix (ends with TRM, STR)
  for (const [suffix, label] of Object.entries(ARMSTRONG_SUFFIX_MAP)) {
    if (vsku.toUpperCase().endsWith(suffix)) return label;
  }

  // Strategy 4: SLCC vendor_sku suffix (-EC, -FSN, -QR, etc.)
  const slccMatch = vsku.match(/-([A-Z]{2,3})$/i);
  if (slccMatch) {
    const sfx = slccMatch[1].toUpperCase();
    if (SLCC_SUFFIX_MAP[sfx]) return SLCC_SUFFIX_MAP[sfx];
  }

  // Strategy 5: Check variant_name for type keywords
  for (const [re, label] of TYPE_KEYWORDS) {
    if (re.test(vn)) return label;
  }

  // Strategy 6: Check product name for type keywords
  for (const [re, label] of TYPE_KEYWORDS) {
    if (re.test(pname)) return label;
  }

  // Strategy 7: Johnson Hardwood vendor_sku contains type
  const johnsonTypes = ['FLUSHSN', 'STAIRNOSE', 'TMOLD', 'REDUCER', 'THRESHOLD', 'QUARTERROUND', 'QR', 'VERSAEDGE', 'ENDCAP'];
  const vskuUp = vsku.toUpperCase();
  for (const jt of johnsonTypes) {
    if (vskuUp.includes(jt)) {
      const jtMap = {
        'FLUSHSN': 'Flush Stairnose', 'STAIRNOSE': 'Stairnose', 'TMOLD': 'T-Mold',
        'REDUCER': 'Reducer', 'THRESHOLD': 'Threshold', 'QUARTERROUND': 'Quarter Round',
        'QR': 'Quarter Round', 'VERSAEDGE': 'Versa Edge', 'ENDCAP': 'End Cap',
      };
      if (jtMap[jt]) return jtMap[jt];
    }
  }

  // Strategy 8: MSI vendor_sku patterns (VTT...-FSN, VTT...-TM, etc.)
  const msiMatch = vsku.match(/-(FSN|TM|RD|QR|TH|EC|OSN|SNS|ST)$/i);
  if (msiMatch) {
    const msiMap = {
      'FSN': 'Flush Stairnose', 'TM': 'T-Mold', 'RD': 'Reducer',
      'QR': 'Quarter Round', 'TH': 'Threshold', 'EC': 'End Cap',
      'OSN': 'Overlap Stairnose', 'SNS': 'Stairnose', 'ST': 'Stair Tread',
    };
    return msiMap[msiMatch[1].toUpperCase()] || null;
  }

  // Strategy 9: Gaia "Color Type" pattern — extract type after last known color word
  // Gaia naming: "Apollo Endcap", "Atlas Quarter Round", etc.
  const gaiaTypes = ['Endcap', 'End Cap', 'Overlap Nosing', 'Stair Nose', 'Quarter Round', 'Reducer', 'T-Molding', 'T-Mold', 'Threshold'];
  for (const gt of gaiaTypes) {
    if (vn.toLowerCase().includes(gt.toLowerCase())) {
      // Map to canonical
      for (const [re, label] of TYPE_KEYWORDS) {
        if (re.test(gt)) return label;
      }
      return gt;
    }
  }

  // Fallback: clean up variant_name (strip dimensions, return as-is)
  const cleaned = vn
    .replace(/,?\s*\d+(?:'?\d*)?(?:"|in|inch(?:es)?)?$/i, '')  // strip trailing dimensions
    .replace(/\s*\(.*?\)\s*/g, '')  // strip parentheticals
    .trim();
  return cleaned || 'Accessory';
}

// ── Color matching helpers ──────────────────────────────────────────────────

/**
 * Normalize a color name for comparison.
 * Strips species names, trims whitespace, lowercases.
 */
function normColor(s) {
  return (s || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    // Strip common species suffixes
    .replace(/[-\s]*(white\s*oak|hickory|red\s*oak|maple|walnut|birch|ash|cherry|acacia|teak|bamboo)\s*$/i, '')
    .trim();
}

/**
 * Extract color from an accessory variant_name.
 * Handles "Color - Type" format and strips type keywords.
 */
function extractAccessoryColor(vn) {
  // "Color - Type" format
  const dashIdx = (vn || '').indexOf(' - ');
  if (dashIdx >= 0) {
    return normColor(vn.substring(0, dashIdx));
  }
  // Strip known type keywords from variant_name to isolate color
  let color = (vn || '');
  for (const [re] of TYPE_KEYWORDS) {
    color = color.replace(re, '');
  }
  // Strip tile/mosaic description patterns (Goton: "Porcelain Mosaic 2x2 Hexagon 12x12")
  color = color.replace(/\bPorcelain(?:\s*\/?\s*Glass)?\b/gi, '');
  color = color.replace(/\bMosaic\b/gi, '');
  color = color.replace(/\bHexag(?:on)?\b/gi, '');
  color = color.replace(/\bChevron\b/gi, '');
  color = color.replace(/\bOpus\s+Pattern\b/gi, '');
  color = color.replace(/\bBasketweave\b/gi, '');
  color = color.replace(/\bHerringbone\b/gi, '');
  color = color.replace(/\bLineal\s+Random\b/gi, '');
  color = color.replace(/\bMix\b/gi, '');
  color = color.replace(/\bFloor\b/gi, '');
  color = color.replace(/\bDouble\s+Side\b/gi, '');
  color = color.replace(/\bSingle\s+Side\b/gi, '');
  // Strip NxN dimension patterns (2x2, 12x12, 3-1/4x18, 9.5x11-3/4, 13.4x11, etc.)
  color = color.replace(/\d[\d.\-\/]*x\d[\d.\-\/]*/gi, '');
  // Strip trailing dimensions (72", 6', etc.)
  color = color.replace(/,?\s*\d+(?:'?\d*)?(?:"|in|inch(?:es)?)?$/i, '').trim();
  return normColor(color);
}

/**
 * Extract color from a main (flooring) SKU's variant_name.
 */
function extractMainColor(vn) {
  // Strip trailing NxN dimensions from main tile variant names
  // e.g. "Grigio 163 12x24" → "Grigio 163", "210 6x24" → "210"
  let color = (vn || '');
  color = color.replace(/\s+\d[\d.\-\/]*x\d[\d.\-\/]*\s*$/i, '');
  return normColor(color);
}

// ── Matching strategies ─────────────────────────────────────────────────────

/**
 * Try to match accessories to main SKUs using multiple strategies.
 * Returns a Map<mainSkuId, accessorySkuId[]>
 */
function matchAccessories(mainSkus, accSkus) {
  const result = new Map(); // mainSkuId → Set<accSkuId>
  for (const m of mainSkus) result.set(m.id, new Set());

  const matched = new Set(); // track which accessories got matched

  // Strategy A: matching_color attribute
  const hasMatchingColor = accSkus.some(a => (a.attributes || []).some(at => at.slug === 'matching_color'));
  if (hasMatchingColor) {
    for (const acc of accSkus) {
      const mc = (acc.attributes || []).find(at => at.slug === 'matching_color');
      if (!mc) continue;
      const accColor = normColor(mc.value);
      for (const m of mainSkus) {
        const mainColor = extractMainColor(m.variant_name);
        if (accColor && mainColor && accColor === mainColor) {
          result.get(m.id).add(acc.id);
          matched.add(acc.id);
        }
      }
    }
    if (matched.size > 0) return result;
  }

  // Strategy B: Vendor SKU prefix match
  const prefixMatched = new Set();
  for (const acc of accSkus) {
    const asku = (acc.vendor_sku || '').toUpperCase();
    if (asku.length < 4) continue;
    for (const m of mainSkus) {
      const msku = (m.vendor_sku || '').toUpperCase();
      if (msku.length < 4) continue;
      if (asku.startsWith(msku + '-') || (msku.length >= 6 && asku.startsWith(msku))) {
        result.get(m.id).add(acc.id);
        prefixMatched.add(acc.id);
      }
    }
  }
  if (prefixMatched.size > 0 && prefixMatched.size === accSkus.length) {
    return result; // All matched by prefix
  }

  // Strategy C: MSI/Shaw vendor_sku color-code matching
  const msiColorMatched = new Set();
  for (const m of mainSkus) {
    const msku = (m.vendor_sku || '').toUpperCase();
    const mainMatch = msku.match(/^(?:P-)?(?:VTR|VTG|VTW|QUTR|QUPO)(?:XL)?(?:HD)?([A-Z]+)/);
    if (!mainMatch || !mainMatch[1] || mainMatch[1].length < 3) continue;
    const mainColorCode = mainMatch[1];
    for (const acc of accSkus) {
      if (prefixMatched.has(acc.id)) continue; // already matched
      const asku = (acc.vendor_sku || '').toUpperCase();
      const accMatch = asku.match(/^(?:P-|MSI-)?(?:P-)?VTT(?:HD)?([A-Z]+)-/) || asku.match(/^(?:P-|MSI-)?TT([A-Z]+)-/);
      if (!accMatch || !accMatch[1]) {
        // No color code extraction possible — keep for all
        continue;
      }
      const accColorCode = accMatch[1];
      if (accColorCode.includes(mainColorCode) || mainColorCode.includes(accColorCode)) {
        result.get(m.id).add(acc.id);
        msiColorMatched.add(acc.id);
      }
    }
  }
  if (msiColorMatched.size > 0 && (msiColorMatched.size + prefixMatched.size) === accSkus.length) {
    return result;
  }

  // Strategy D: Color-name matching
  const colorNameMatched = new Set();
  for (const acc of accSkus) {
    if (prefixMatched.has(acc.id) || msiColorMatched.has(acc.id)) continue;
    const accColor = extractAccessoryColor(acc.variant_name);
    if (!accColor) continue;

    for (const m of mainSkus) {
      const mainColor = extractMainColor(m.variant_name);
      if (!mainColor) continue;

      // Strip "Bright"/"Matte" prefixes for comparison (Roca Maiolica pattern)
      const mainColorBare = mainColor.replace(/^(?:bright|matte)\s+/i, '');
      const accColorBare = accColor.replace(/^(?:bright|matte)\s+/i, '');

      // Exact match (with or without prefix)
      if (accColor === mainColor || accColorBare === mainColorBare) {
        result.get(m.id).add(acc.id);
        colorNameMatched.add(acc.id);
        continue;
      }

      // Check if accessory has compound name (comma/slash separated)
      const segments = (acc.variant_name || '').split(/[,\/]/).map(seg => normColor(seg)).filter(Boolean);
      for (const seg of segments) {
        // Strip type keywords from segment too
        let cleanSeg = seg;
        for (const [re] of TYPE_KEYWORDS) {
          cleanSeg = cleanSeg.replace(re, '').trim();
        }
        cleanSeg = normColor(cleanSeg);
        const cleanSegBare = cleanSeg.replace(/^(?:bright|matte)\s+/i, '');
        if (cleanSeg && (cleanSeg === mainColor || cleanSegBare === mainColorBare ||
            cleanSeg.startsWith(mainColor) || mainColor.startsWith(cleanSeg) ||
            cleanSegBare.startsWith(mainColorBare) || mainColorBare.startsWith(cleanSegBare))) {
          result.get(m.id).add(acc.id);
          colorNameMatched.add(acc.id);
          break;
        }
      }
    }
  }

  const totalMatched = prefixMatched.size + msiColorMatched.size + colorNameMatched.size;
  if (totalMatched === accSkus.length) {
    return result;
  }

  // Strategy E: Position-based dedup
  // Group accessories by their "type" (label). If each type group has exactly
  // N items (matching main SKU count), assign by sorted position.
  const unmatched = accSkus.filter(a => !prefixMatched.has(a.id) && !msiColorMatched.has(a.id) && !colorNameMatched.has(a.id));
  if (unmatched.length > 0 && mainSkus.length > 1) {
    // Group unmatched by derived label
    const typeGroups = {};
    for (const acc of unmatched) {
      const label = deriveLabel(acc, acc.product_name);
      if (!typeGroups[label]) typeGroups[label] = [];
      typeGroups[label].push(acc);
    }

    // Sort main SKUs by vendor_sku for consistent position
    const sortedMain = [...mainSkus].sort((a, b) => (a.vendor_sku || '').localeCompare(b.vendor_sku || ''));

    let positionWorked = false;
    for (const [, group] of Object.entries(typeGroups)) {
      if (group.length === sortedMain.length) {
        // Sort accessories by vendor_sku to align with main
        group.sort((a, b) => (a.vendor_sku || '').localeCompare(b.vendor_sku || ''));
        for (let i = 0; i < group.length; i++) {
          result.get(sortedMain[i].id).add(group[i].id);
        }
        positionWorked = true;
      } else if (group.length === 1) {
        // Single accessory of this type — goes to all main SKUs
        for (const m of mainSkus) {
          result.get(m.id).add(group[0].id);
        }
        positionWorked = true;
      }
    }

    // If position matching didn't resolve everything, fall through to all-to-all for remaining
    if (!positionWorked) {
      for (const acc of unmatched) {
        for (const m of mainSkus) {
          result.get(m.id).add(acc.id);
        }
      }
    }
  } else if (unmatched.length > 0) {
    // Single main SKU — all accessories go to it
    for (const acc of unmatched) {
      for (const m of mainSkus) {
        result.get(m.id).add(acc.id);
      }
    }
  }

  return result;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`build-sku-accessories.cjs — ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  console.log('─'.repeat(60));

  // Step 1: Clear existing data (preserve JMV links — managed by create-jmv-accessories.cjs)
  if (!DRY_RUN) {
    const delResult = await pool.query(`
      DELETE FROM sku_accessories
      WHERE parent_sku_id NOT IN (
        SELECT s.id FROM skus s
        JOIN products p ON p.id = s.product_id
        JOIN vendors v ON v.id = p.vendor_id
        WHERE v.code = 'JMV'
      )
    `);
    // Note: we do NOT clear accessory_label here — labels may have been manually set
    // for accessories where deriveLabel can't determine the type (e.g., EDI-coded products).
    // The label update below will only overwrite when deriveLabel returns a recognized type.
    console.log(`Cleared ${delResult.rowCount} existing sku_accessories links (preserved JMV)`);
  }

  // Step 2: Load all products with both accessory and non-accessory active SKUs
  const productsResult = await pool.query(`
    SELECT p.id, p.name, p.collection, v.name as vendor_name, v.code as vendor_code,
      SUM(CASE WHEN s.variant_type = 'accessory' THEN 1 ELSE 0 END) as acc_count,
      SUM(CASE WHEN COALESCE(s.variant_type, '') != 'accessory' THEN 1 ELSE 0 END) as main_count
    FROM skus s
    JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id
    WHERE s.status = 'active' AND s.is_sample = false
    GROUP BY p.id, p.name, p.collection, v.name, v.code
    HAVING SUM(CASE WHEN s.variant_type = 'accessory' THEN 1 ELSE 0 END) > 0
    AND SUM(CASE WHEN COALESCE(s.variant_type, '') != 'accessory' THEN 1 ELSE 0 END) > 0
    ORDER BY v.name, p.name
  `);

  console.log(`Found ${productsResult.rows.length} products with mixed accessory/main SKUs`);

  // Step 3: Load all SKUs for these products in batch
  const productIds = productsResult.rows.map(p => p.id);

  const skusResult = await pool.query(`
    SELECT s.id, s.product_id, s.vendor_sku, s.variant_name, s.variant_type,
      s.sell_by, s.internal_sku, p.name as product_name
    FROM skus s
    JOIN products p ON p.id = s.product_id
    WHERE s.product_id = ANY($1) AND s.status = 'active' AND s.is_sample = false
    ORDER BY s.product_id, s.variant_type, s.vendor_sku
  `, [productIds]);

  // Load attributes for accessories (matching_color, etc.)
  const accSkuIds = skusResult.rows.filter(s => s.variant_type === 'accessory').map(s => s.id);
  let accAttrMap = {};
  if (accSkuIds.length > 0) {
    // Batch in chunks to avoid parameter limit
    const chunkSize = 5000;
    for (let i = 0; i < accSkuIds.length; i += chunkSize) {
      const chunk = accSkuIds.slice(i, i + chunkSize);
      const attrRes = await pool.query(`
        SELECT sa.sku_id, a.slug, sa.value
        FROM sku_attributes sa
        JOIN attributes a ON a.id = sa.attribute_id
        WHERE sa.sku_id = ANY($1)
      `, [chunk]);
      for (const row of attrRes.rows) {
        if (!accAttrMap[row.sku_id]) accAttrMap[row.sku_id] = [];
        accAttrMap[row.sku_id].push({ slug: row.slug, value: row.value });
      }
    }
  }

  // Group SKUs by product
  const skusByProduct = {};
  for (const s of skusResult.rows) {
    if (!skusByProduct[s.product_id]) skusByProduct[s.product_id] = [];
    s.attributes = accAttrMap[s.id] || [];
    skusByProduct[s.product_id].push(s);
  }

  // Step 4: Process each product
  let totalLinks = 0;
  let totalLabels = 0;
  const linkBatch = []; // [parent_sku_id, accessory_sku_id, sort_order]
  const labelBatch = []; // [sku_id, label]

  for (const product of productsResult.rows) {
    const allSkus = skusByProduct[product.id] || [];
    const mainSkus = allSkus.filter(s => s.variant_type !== 'accessory');
    const accSkus = allSkus.filter(s => s.variant_type === 'accessory');

    if (mainSkus.length === 0 || accSkus.length === 0) continue;

    // Derive labels for accessories
    for (const acc of accSkus) {
      const label = deriveLabel(acc, product.name);
      if (label && label !== acc.accessory_label) {
        labelBatch.push([acc.id, label]);
        totalLabels++;
      }
    }

    // Match accessories to main SKUs
    const matches = matchAccessories(mainSkus, accSkus);

    for (const [mainId, accIds] of matches) {
      let sortOrder = 0;
      for (const accId of accIds) {
        linkBatch.push([mainId, accId, sortOrder++]);
        totalLinks++;
      }
    }
  }

  // Step 5: Handle Shaw companion_skus (cross-product accessories)
  console.log('\nProcessing Shaw companion_skus...');
  const companionResult = await pool.query(`
    SELECT s.id as main_sku_id, sa.value as companion_skus, p.vendor_id
    FROM sku_attributes sa
    JOIN attributes a ON a.id = sa.attribute_id AND a.slug = 'companion_skus'
    JOIN skus s ON s.id = sa.sku_id AND s.status = 'active'
    JOIN products p ON p.id = s.product_id AND p.status = 'active'
    WHERE COALESCE(s.variant_type, '') != 'accessory'
  `);

  if (companionResult.rows.length > 0) {
    // Collect all companion vendor_skus
    const allCompanionVskus = new Set();
    for (const row of companionResult.rows) {
      const vskus = row.companion_skus.split(',').map(s => s.trim()).filter(Boolean);
      vskus.forEach(v => allCompanionVskus.add(v));
    }

    // Look up companion SKUs by vendor_sku
    const companionSkuResult = await pool.query(`
      SELECT s.id, s.vendor_sku, s.variant_name, p.name as product_name,
        s.variant_type, s.sell_by
      FROM skus s
      JOIN products p ON p.id = s.product_id AND p.status = 'active'
      WHERE s.vendor_sku = ANY($1) AND s.status = 'active'
    `, [Array.from(allCompanionVskus)]);

    // Also look up by product name (Shaw EDI accessory products are named after their EDI code)
    // Scope to same vendor(s) that own the companion_skus attribute to prevent cross-vendor name collisions
    const companionVendorIds = [...new Set(companionResult.rows.map(r => r.vendor_id))];
    const companionNameResult = await pool.query(`
      SELECT s.id, s.vendor_sku, s.variant_name, p.name as product_name,
        s.variant_type, s.sell_by, upper(p.name) as match_key
      FROM skus s
      JOIN products p ON p.id = s.product_id AND p.status = 'active'
      WHERE upper(p.name) = ANY($1) AND s.status = 'active'
        AND s.vendor_sku != ALL($1)
        AND p.vendor_id = ANY($2)
    `, [Array.from(allCompanionVskus), companionVendorIds]);

    const companionMap = {};
    for (const r of companionSkuResult.rows) {
      companionMap[r.vendor_sku] = r;
    }
    // For product name matches, use the first SKU per product name as the representative
    for (const r of companionNameResult.rows) {
      if (!companionMap[r.match_key]) {
        companionMap[r.match_key] = r;
      }
    }

    let crossLinks = 0;
    for (const row of companionResult.rows) {
      const vskus = row.companion_skus.split(',').map(s => s.trim()).filter(Boolean);
      let sortOrder = 0;
      for (const vsku of vskus) {
        const comp = companionMap[vsku] || companionMap[vsku.toUpperCase()];
        if (comp) {
          linkBatch.push([row.main_sku_id, comp.id, sortOrder++]);
          crossLinks++;
          totalLinks++;

          // Also derive label for companion accessories
          if (comp.variant_type === 'accessory' || true) {
            const label = deriveLabel(comp, comp.product_name);
            if (label) {
              labelBatch.push([comp.id, label]);
              totalLabels++;
            }
          }
        }
      }
    }
    console.log(`  Found ${companionResult.rows.length} main SKUs with companion_skus → ${crossLinks} cross-product links`);
  }

  console.log(`\nTotal: ${totalLinks} links, ${totalLabels} labels to write`);

  if (DRY_RUN) {
    // Show sample
    console.log('\nSample links (first 20):');
    for (const [parent, acc, sort] of linkBatch.slice(0, 20)) {
      console.log(`  ${parent} → ${acc} (sort: ${sort})`);
    }
    console.log('\nSample labels (first 20):');
    for (const [skuId, label] of labelBatch.slice(0, 20)) {
      console.log(`  ${skuId} → "${label}"`);
    }
  } else {
    // Step 6: Write links in batches
    console.log('\nWriting sku_accessories links...');
    const BATCH_SIZE = 500;
    let written = 0;
    for (let i = 0; i < linkBatch.length; i += BATCH_SIZE) {
      const batch = linkBatch.slice(i, i + BATCH_SIZE);
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
      if (written % 5000 === 0 || written === linkBatch.length) {
        console.log(`  ${written}/${linkBatch.length} links written`);
      }
    }

    // Step 7: Write labels in batches
    console.log('Writing accessory_label values...');
    // Deduplicate labels (keep last per sku_id)
    const labelMap = new Map();
    for (const [skuId, label] of labelBatch) {
      labelMap.set(skuId, label);
    }
    const dedupedLabels = Array.from(labelMap.entries());

    for (let i = 0; i < dedupedLabels.length; i += BATCH_SIZE) {
      const batch = dedupedLabels.slice(i, i + BATCH_SIZE);
      // Use a single UPDATE with CASE
      const ids = batch.map(b => b[0]);
      const caseLines = batch.map((b, j) => `WHEN id = $${j * 2 + 1} THEN $${j * 2 + 2}`).join(' ');
      const params = [];
      for (const [skuId, label] of batch) {
        params.push(skuId, label);
      }
      // Only update labels for SKUs that don't already have a manually-set label
      await pool.query(`
        UPDATE skus SET accessory_label = CASE ${caseLines} END, updated_at = CURRENT_TIMESTAMP
        WHERE id = ANY($${params.length + 1}) AND accessory_label IS NULL
      `, [...params, ids]);
    }
    console.log(`  ${dedupedLabels.length} labels written`);
  }

  // Step 8: Summary stats
  if (!DRY_RUN) {
    const countResult = await pool.query('SELECT COUNT(*) FROM sku_accessories');
    const labelCount = await pool.query('SELECT COUNT(*) FROM skus WHERE accessory_label IS NOT NULL');
    const distinctLabels = await pool.query('SELECT DISTINCT accessory_label FROM skus WHERE accessory_label IS NOT NULL ORDER BY 1');

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`Total links in sku_accessories: ${countResult.rows[0].count}`);
    console.log(`Total SKUs with accessory_label: ${labelCount.rows[0].count}`);
    console.log(`Distinct labels: ${distinctLabels.rows.map(r => r.accessory_label).join(', ')}`);
  }

  console.log('\nDone!');
  await pool.end();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
