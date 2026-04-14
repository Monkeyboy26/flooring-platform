#!/usr/bin/env node
/**
 * AHF Product Data Cleanup
 *
 * Regroups ~1000 chaotic AHF SKUs (imported from Tri-West 832 EDI) into
 * ~35-40 proper products organized by product line (Coastal Comfort, Everest,
 * Denali, etc.). The 832 import fell back to TRN (trade name) which contains
 * dimension strings like `3/4"X5"XRL 9"-84"` instead of real collection names.
 *
 * What this script does:
 *   1. Deletes fee/charge products (pallet fees, storage fees, outbound charges)
 *   2. Extracts product line from TRN/product name using known patterns
 *   3. Detects accessories (reducer, t-mold, quarter round, etc.)
 *   4. Regroups SKUs under new properly-named products
 *   5. Cleans placeholder descriptions
 *   6. Archives or deletes orphaned old products
 *
 * Usage:
 *   node backend/scripts/cleanup-ahf.cjs --dry-run   # Preview changes
 *   node backend/scripts/cleanup-ahf.cjs              # Execute cleanup
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
// Known AHF Product Lines — regex patterns for extraction
// ---------------------------------------------------------------------------
// Order matters: multi-word patterns first, then single-word.
// These cover AHF's real product lines (Bruce, Hartco, Armstrong sub-brands).
const PRODUCT_LINE_PATTERNS = [
  // Multi-word product lines — most specific first
  { name: 'Coastal Comfort', pattern: /\bCOASTAL\s*COMFORT\b/i },
  { name: 'Coastal Highway', pattern: /\bCOASTAL\s*HIGHWAY\b/i },
  { name: 'American Scrape', pattern: /\bAMERICAN\s*SCRAPE\b/i },
  { name: 'Prime Harvest', pattern: /\bPRIME\s*HARVEST\b/i },
  { name: 'Dogwood Pro', pattern: /\bDOGWOOD\s*PRO\b/i },
  { name: 'Rural Living', pattern: /\bRURAL\s*LIVING\b/i },
  { name: 'Solid Color Welding', pattern: /\bSOLID\s*COLOR\s*WELD/i },
  { name: 'Appalachian Ridge', pattern: /\bAPPALACHIAN\s*RIDGE\b/i },
  { name: 'Sugar Creek', pattern: /\bSUGAR\s*CREEK\b/i },
  { name: 'Lock & Fold', pattern: /\bLOCK\s*(?:&|AND)\s*FOLD\b/i },
  { name: 'Next Frontier', pattern: /\bNEXT\s*FRONTIER\b/i },
  { name: 'White Mountain', pattern: /\bWHITE\s*MOUNTAIN\b/i },
  { name: 'Woodland Relics', pattern: /\bWOODLAND\s*RELICS\b/i },
  { name: 'Heritage Classics', pattern: /\bHERITAGE\s*CLASSICS?\b/i },
  { name: 'Mountain Retreat', pattern: /\bMOUNTAIN\s*RETREAT\b/i },
  { name: 'Paragon Diamond', pattern: /\bPARAGON\s*(?:DIAMOND|D\s*10)\b/i },
  { name: 'Turlington Signature', pattern: /\bTURLINGTON\s*SIGNATURE\b/i },
  { name: 'Turlington Lock & Fold', pattern: /\bTURLINGTON\s*LOCK/i },
  { name: 'Westmoreland Strip', pattern: /\bWESTMORELAND\s*STRIP\b/i },
  { name: 'Performance Plus', pattern: /\bPERFORMANCE\s*PLUS\b/i },
  { name: 'Mystic Taupe', pattern: /\bMYSTIC\s*TAUPE\b/i },
  { name: 'Oak Pointe', pattern: /\bOAK\s*POINTE\b/i },
  { name: 'Highland Trail', pattern: /\bHIGHLAND\s*TRAIL\b/i },
  { name: 'Camden Hills', pattern: /\bCAMDEN\s*HILLS?\b/i },
  { name: 'Legacy Manor', pattern: /\bLEGACY\s*MANOR\b/i },
  { name: 'Barnwood Living', pattern: /\bBARNWOOD\s*LIVING\b/i },
  // Product lines from actual data
  { name: 'Concepts of Landscape', pattern: /\bCONCEPTS?\s*(?:OF\s*)?LANDSCAPE\b/i },
  { name: 'Nod to Nature', pattern: /\bNOD\s*(?:TO\s*|2\s*)NATURE\b/i },
  { name: 'Expressive Ideas', pattern: /\bEXPRESSIVE\s*IDEAS?\b/i },
  { name: 'Mixed and Variegated', pattern: /\bMIXED\s*(?:AND|&)\s*VARIEGATED\b/i },
  { name: 'Mizunara Wood', pattern: /\bMIZUNARA\s*(?:WOOD)?\b/i },
  { name: 'Woodland Traditionalist', pattern: /\bWOODLAND\s*TRAD(?:ITIONALIST|ITIONST|ITION|\.?)?\b/i },
  { name: 'Preserving Craft', pattern: /\bP(?:ER|RE)S(?:ER|RE)VING\s*(?:CRAFT)?\b/i },
  { name: 'Hartwood Natureworx', pattern: /\bHART(?:WOOD|WD)?\s*NATURE\s*WOR(?:X|KS)\b/i },
  { name: 'Pikes Peak', pattern: /\bPIKES?\s*PEAK\b/i },
  { name: 'Timberbrushed Gold', pattern: /\b(?:TIMBER\s*BRUSH(?:ED)?|TB)\s*GOLD\b/i },
  { name: 'Timberbrushed Silver', pattern: /\b(?:TIMBER\s*BRUSH(?:ED)?|TB|HAR\s*TIMBER\s*BRUSH(?:ED)?)\s*SILVER\b/i },
  { name: 'Timberbrushed Platinum', pattern: /\b(?:TIMBER\s*BRUSH(?:ED)?|TB)\s*PLAT(?:INUM)?\b/i },
  { name: 'AHF Contract', pattern: /\bAHF\s*CONTRACT\b/i },
  { name: 'Vinyl Weld Rod', pattern: /\bVINYL\s*WELD(?:ING)?\s*ROD\b/i },
  // Commercial flooring lines
  { name: 'Medinpure', pattern: /\bMEDINPURE\b/i },
  { name: 'Medintone', pattern: /\bMEDINTONE\b/i },
  { name: 'Natralis', pattern: /\bNATRALIS\b/i },
  { name: 'Highlights', pattern: /\bHIGHLIGHTS?\b/i },
  { name: 'Iliad', pattern: /\bILIAD\b/i },
  { name: 'Necessity', pattern: /\bNECESSITY\b/i },
  { name: 'Inscription', pattern: /\bINSCRIPTION\b/i },
  { name: 'Hydroblok', pattern: /\bHYDRO\s*BLO[CK]+\b/i },
  { name: 'Ingrained', pattern: /\bINGRAINED\b/i },
  { name: 'Distinct', pattern: /\bDISTINCT\b/i },
  // Single-word product lines
  { name: 'Paragon', pattern: /\bPARAGON\b/i },
  { name: 'Turlington', pattern: /\bTURLINGTON\b/i },
  { name: 'Westmoreland', pattern: /\bWESTMORELAND\b/i },
  { name: 'Everest', pattern: /\bEVEREST\b/i },
  { name: 'Denali', pattern: /\bDENALI\b/i },
  { name: 'Dutton', pattern: /\bDUTTON\b/i },
  { name: 'Artisan', pattern: /\bARTISAN\b/i },
  { name: 'Beckford', pattern: /\bBECKFORD\b/i },
  { name: 'Somerset', pattern: /\bSOMERSET\b/i },
  { name: 'Dakota', pattern: /\bDAKOTA\b/i },
  { name: 'Dogwood', pattern: /\bDOGWOOD\b/i },
  { name: 'Kennedale', pattern: /\bKENNEDALE\b/i },
  { name: 'Gatehouse', pattern: /\bGATEHOUSE\b/i },
  { name: 'Pioneered', pattern: /\bPIONEERED\b/i },
  { name: 'Springdale', pattern: /\bSPRINGDALE\b/i },
  { name: 'Manchester', pattern: /\bMANCHESTER\b/i },
  { name: 'Waltham', pattern: /\bWALTHAM\b/i },
  { name: 'Downing', pattern: /\bDOWNING\b/i },
  { name: 'Robbins', pattern: /\bROBBINS\b/i },
  { name: 'Rockingham', pattern: /\bROCKINGHAM\b/i },
  { name: 'Dundee', pattern: /\bDUNDEE\b/i },
  { name: 'Laurel', pattern: /\bLAUREL\b/i },
  { name: 'Kingsford', pattern: /\bKINGSFORD\b/i },
  { name: 'Ascot', pattern: /\bASCOT\b/i },
  { name: 'Bristol', pattern: /\bBRISTOL\b/i },
  { name: 'Yorkshire', pattern: /\bYORKSHIRE\b/i },
  { name: 'Beaumont', pattern: /\bBEAUMONT\b/i },
  { name: 'Hartco', pattern: /\bHARTCO\b/i },
  { name: 'Bruce', pattern: /\bBRUCE\b/i },
  { name: 'Armstrong', pattern: /\bARMSTRONG\b/i },
  { name: 'Hydropel', pattern: /\bHYDROPEL\b/i },
  { name: 'Timbercuts', pattern: /\bTIMBERCUTS?\b/i },
  { name: 'Smokehouse', pattern: /\bSMOKEHOUSE\b/i },
  { name: 'Blackwater', pattern: /\bBLACKWATER\b/i },
  { name: 'Frontier', pattern: /\bFRONTIER\b/i },
  { name: 'Legacy', pattern: /\bLEGACY\b/i },
  { name: 'Timber Brush', pattern: /\bTIMBER\s*BRUSH\b/i },
];

// Fee/charge patterns — these are not real products
const FEE_PATTERNS = [
  /\$[\d.]+\s*FOR\s*OUTBOUND/i,
  /OUTBOUND\s*CHARGE/i,
  /PALLET\s*(?:SHIPPED\s*)?FEE/i,
  /STORAGE\s*FEE/i,
  /HANDLING\s*FEE/i,
  /DELIVERY\s*FEE/i,
  /FREIGHT\s*CHARGE/i,
  /SURCHARGE/i,
  /RESTOCKING/i,
  /MINIMUM\s*ORDER/i,
  /FUEL\s*CHARGE/i,
  /RETURN\s*(?:FEE|CHARGE)/i,
  /CORE\s*CHARGE/i,
  /\bPALLET\b.*\bFEE\b.*\$\d+/i,
  /\$\d+.*\bPALLET\b.*\bFEE\b/i,
];

// Accessory patterns
const ACCESSORY_PATTERNS = [
  /\bREDUCER\b/i,
  /\bT[\s-]?MOLD(?:ING)?\b/i,
  /\bQUARTER\s*ROUND\b/i,
  /\bTHRESHOLD\b/i,
  /\bSTAIR\s*(?:NOSE|NS)\b/i,
  /\bEND\s*CAP\b/i,
  /\bFLUSH\s*(?:MOUNT|STAIR|STR)\b/i,
  /\bMOLDING\b/i,
  /\bTRANSITION\b/i,
  /\bBASE\s*SHOE\b/i,
  /\bOVERLAP\b/i,
  /\bBULL\s*NOSE\b/i,
  /\bSCOTIA\b/i,
  /\bWELDING\s*ROD\b/i,
  /\bWELD\s*ROD\b/i,
];

// Words to strip before pattern matching (accessory types, dimensions, packaging, junk)
const STRIP_BEFORE_MATCH = [
  // Accessory type words
  /\bREDUCER\b/gi,
  /\bT[\s-]?MOLD(?:ING)?\b/gi,
  /\bQUARTER\s*ROUND\b/gi,
  /\bTHRESHOLD\b/gi,
  /\bSTAIR\s*(?:NOSE|NS)\b/gi,
  /\bFLUSH\s*(?:MOUNT|STAIR|STR)\s*(?:NOSE|NS)?\b/gi,
  /\bEND\s*CAP\b/gi,
  /\bMOLDING\b/gi,
  /\bOVERLAP\b/gi,
  /\bBASE\s*SHOE\b/gi,
  /\bWELDING\s*ROD\b/gi,
  /\bWELD\s*ROD\b/gi,
  // "COLL" / "COLL." / "COLLECTION"
  /\bCOLL(?:ECTION)?\.?\b/gi,
  // Dimension patterns
  /\b\d+\/\d+"?\s*[xX×]\s*\d+[\/\d]*"?\s*(?:[xX×]\s*(?:RL|[A-Z]+))?\s*(?:\d+[."'\-]*\d*[."'\-]*\d*)*/g,
  /\s*(?:XRL|XRG|XR)\s*\d+.*$/gi,
  // Packaging info like "78" 5/CT", "94"XXX", "10/CT"
  /\b\d+\/CT\b/gi,
  /\b\d+"?\s*(?:XXX|XX)\b/gi,
  /\b\d+(?:\.\d+)?"\b/g,
  // Material words
  /\b(?:OAK|MAPLE|HICKORY|WALNUT|CHERRY|ASH|BIRCH|BEECH|PINE|ACACIA|TEAK|MAHOGANY|ELM|BAMBOO|PECAN)\b/gi,
  // Specifications
  /\b\d+\s*(?:MIL|MM|OZ)\b/gi,
  /\bW\/(?:PAD|NO\s*PAD)\b/gi,
  /\bENG\.?\b/gi,
  /\b(?:PVC\s*FREE|VINYL|SOLID)\b/gi,
  /\bDB\b/gi,
  /\bVBT\b/gi,
  /\bLG\s*RED\b/gi,
  /\bPLK\b/gi,
  /\bSTRIP\b/gi,
  /\bR\.?O\.?\/?W\.?O\.?\b/gi,
  // Color words that leak into product names
  /\b(?:WHITE|SAND\s*MOUNTAIN|SERENE\s*TAUPE|HALF\s*MOON\s*BAY)\b/gi,
];

// ---------------------------------------------------------------------------
// Product line extraction
// ---------------------------------------------------------------------------
function preClean(text) {
  if (!text) return null;
  // Strip "Zz" prefix (discontinued/internal items in EDI)
  let cleaned = text.replace(/^ZZ\s*/i, '');
  return cleaned.trim() || null;
}

function extractProductLine(text) {
  if (!text) return null;
  const cleaned = preClean(text);
  if (!cleaned) return null;

  // Check known patterns against the cleaned text
  for (const { name, pattern } of PRODUCT_LINE_PATTERNS) {
    if (pattern.test(cleaned)) return name;
  }

  return null;
}

function extractWithStripping(text) {
  if (!text) return null;
  let cleaned = preClean(text);
  if (!cleaned) return null;

  // Strip accessory words, dimensions, packaging, etc. then re-try patterns
  for (const re of STRIP_BEFORE_MATCH) {
    cleaned = cleaned.replace(re, '');
  }
  cleaned = cleaned.replace(/\s{2,}/g, ' ').trim();

  if (!cleaned || cleaned.length < 3) return null;

  // Try patterns again on stripped text
  for (const { name, pattern } of PRODUCT_LINE_PATTERNS) {
    if (pattern.test(cleaned)) return name;
  }

  return null;
}

function isFeeProduct(productName, variantName) {
  const combined = `${productName || ''} ${variantName || ''}`;
  return FEE_PATTERNS.some(p => p.test(combined));
}

function isAccessory(productName, variantName) {
  const combined = `${productName || ''} ${variantName || ''}`;
  return ACCESSORY_PATTERNS.some(p => p.test(combined));
}

// ---------------------------------------------------------------------------
// Title case helper (matches import script convention)
// ---------------------------------------------------------------------------
const KEEP_UPPER = new Set(['SPC', 'WPC', 'LVP', 'LVT', 'PVC', 'HD', 'II', 'III', 'IV', 'AHF']);
const KEEP_LOWER = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'in', 'at', 'to', 'for', 'by', 'on', 'with']);

function titleCase(text) {
  if (!text) return '';
  return text.split(/\s+/).map((w, i) => {
    const upper = w.toUpperCase();
    if (KEEP_UPPER.has(upper)) return upper;
    if (i > 0 && KEEP_LOWER.has(w.toLowerCase())) return w.toLowerCase();
    if (w.length <= 1) return w.toUpperCase();
    return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  }).join(' ');
}

// ---------------------------------------------------------------------------
// Main cleanup
// ---------------------------------------------------------------------------
async function main() {
  console.log(`=== AHF Product Data Cleanup ===${DRY_RUN ? ' [DRY RUN]' : ''}\n`);

  const client = await pool.connect();

  try {
    // -----------------------------------------------------------------------
    // Step 0: Find AHF vendor_id
    // -----------------------------------------------------------------------
    const vendorResult = await client.query(
      `SELECT id FROM vendors WHERE code = 'TW'`
    );
    if (vendorResult.rows.length === 0) {
      console.error('Tri-West vendor not found. Run import-triwest-832 first.');
      return;
    }
    const vendorId = vendorResult.rows[0].id;
    console.log(`Vendor ID: ${vendorId}\n`);

    // -----------------------------------------------------------------------
    // Step 1: Load all AHF products + SKUs + color attributes
    // -----------------------------------------------------------------------
    const allData = await client.query(`
      SELECT
        p.id AS product_id, p.name AS product_name, p.collection,
        p.description_long, p.description_short, p.status AS product_status,
        s.id AS sku_id, s.vendor_sku, s.internal_sku, s.variant_name,
        s.sell_by, s.variant_type,
        sa_color.value AS color
      FROM products p
      JOIN skus s ON s.product_id = p.id
      LEFT JOIN sku_attributes sa_color ON sa_color.sku_id = s.id
        AND sa_color.attribute_id = (SELECT id FROM attributes WHERE slug = 'color' LIMIT 1)
      WHERE p.vendor_id = $1
        AND (p.collection LIKE 'AHF%'
             OR EXISTS (
               SELECT 1 FROM sku_attributes sa
               JOIN attributes a ON a.id = sa.attribute_id
               WHERE sa.sku_id = s.id AND a.slug = 'brand' AND UPPER(sa.value) = 'AHF'
             ))
      ORDER BY p.collection, s.vendor_sku
    `, [vendorId]);

    const totalSkus = allData.rows.length;
    const uniqueProducts = new Set(allData.rows.map(r => r.product_id));
    const uniqueCollections = new Set(allData.rows.map(r => r.collection));

    console.log(`Current state:`);
    console.log(`  Products:    ${uniqueProducts.size}`);
    console.log(`  SKUs:        ${totalSkus}`);
    console.log(`  Collections: ${uniqueCollections.size}\n`);

    if (totalSkus === 0) {
      console.log('No AHF data found. Nothing to clean up.');
      return;
    }

    // -----------------------------------------------------------------------
    // Step 2: Identify fee/charge SKUs to delete
    // -----------------------------------------------------------------------
    const feeSkus = [];
    const feeProductIds = new Set();
    for (const row of allData.rows) {
      if (isFeeProduct(row.product_name, row.variant_name)) {
        feeSkus.push(row);
        feeProductIds.add(row.product_id);
      }
    }
    console.log(`Fee/charge items to delete: ${feeSkus.length} SKUs across ${feeProductIds.size} products`);
    if (feeSkus.length > 0) {
      console.log(`  Examples: ${feeSkus.slice(0, 5).map(s => s.variant_name || s.product_name).join(', ')}`);
    }

    // -----------------------------------------------------------------------
    // Step 3: Extract product lines and build regrouping map
    // -----------------------------------------------------------------------
    const productLineMap = new Map();
    const unmatchedSkus = [];
    let accessoryCount = 0;

    for (const row of allData.rows) {
      // Skip fees — they'll be deleted
      if (isFeeProduct(row.product_name, row.variant_name)) continue;

      // Try extracting product line from various fields
      const searchTexts = [
        row.product_name,
        row.variant_name,
        row.collection,
        row.vendor_sku,
      ];

      let productLine = null;

      // Pass 1: direct pattern matching
      for (const text of searchTexts) {
        productLine = extractProductLine(text);
        if (productLine) break;
      }

      // Pass 2: strip accessory/dimension words, then re-try patterns
      if (!productLine) {
        for (const text of searchTexts) {
          productLine = extractWithStripping(text);
          if (productLine) break;
        }
      }

      // Detect accessory
      const acc = isAccessory(row.product_name, row.variant_name);
      if (acc) accessoryCount++;

      // Determine color for variant_name — clean up Zz prefix and junk
      let color = row.color || row.variant_name || null;
      if (color) {
        // Strip "Zz" prefix (discontinued/internal marker in EDI data)
        color = color.replace(/^ZZ\s*/i, '').trim();
        // Strip dimension junk that leaks into color names
        color = color
          .replace(/\b\d+\/\d+"?\s*[xX×]\s*\d+[\/\d]*"?/g, '')
          .replace(/\s*(?:XRL|XRG|XR)\s*\d+.*$/i, '')
          .replace(/\b\d+"?\s*(?:XXX|XX)\b/gi, '')
          .replace(/\s{2,}/g, ' ')
          .trim();
        color = titleCase(color);
      }

      const entry = {
        sku_id: row.sku_id,
        vendor_sku: row.vendor_sku,
        internal_sku: row.internal_sku,
        old_product_id: row.product_id,
        color,
        sell_by: row.sell_by,
        is_accessory: acc,
        variant_type: acc ? 'accessory' : (row.variant_type === 'accessory' ? 'accessory' : null),
        raw_name: row.product_name,
      };

      if (productLine) {
        // Accessories get their own sub-group within the product line
        const groupKey = acc ? `${productLine} - Accessories` : productLine;
        if (!productLineMap.has(groupKey)) {
          productLineMap.set(groupKey, {
            displayName: acc ? `${productLine} Accessories` : productLine,
            collection: `AHF - ${productLine}`,
            isAccessoryGroup: acc,
            skus: [],
          });
        }
        productLineMap.get(groupKey).skus.push(entry);
      } else {
        unmatchedSkus.push(entry);
      }
    }

    // Group unmatched under "Uncategorized"
    if (unmatchedSkus.length > 0) {
      productLineMap.set('Uncategorized', {
        displayName: 'Uncategorized',
        collection: 'AHF - Uncategorized',
        isAccessoryGroup: false,
        skus: unmatchedSkus,
      });
    }

    console.log(`\nProduct line extraction:`);
    console.log(`  Product lines found: ${productLineMap.size}`);
    console.log(`  Accessories detected: ${accessoryCount}`);
    console.log(`  Unmatched SKUs:       ${unmatchedSkus.length}`);

    console.log(`\nProduct line breakdown:`);
    const sortedLines = [...productLineMap.entries()].sort((a, b) => b[1].skus.length - a[1].skus.length);
    for (const [key, group] of sortedLines) {
      const accLabel = group.isAccessoryGroup ? ' [accessories]' : '';
      console.log(`  ${group.collection}: ${group.skus.length} SKUs${accLabel}`);
    }

    if (unmatchedSkus.length > 0) {
      console.log(`\n  Unmatched SKU details (for adding patterns):`);
      for (const sku of unmatchedSkus.slice(0, 20)) {
        console.log(`    ${sku.vendor_sku} | name: "${sku.raw_name}" | color: "${sku.color}"`);
      }
    }

    // -----------------------------------------------------------------------
    // Step 4: Handle duplicate colors within a product line
    // -----------------------------------------------------------------------
    for (const [, group] of productLineMap) {
      const colorCounts = new Map();
      for (const sku of group.skus) {
        const c = sku.color || '';
        colorCounts.set(c, (colorCounts.get(c) || 0) + 1);
      }
      // Disambiguate duplicates
      const colorSeen = new Map();
      for (const sku of group.skus) {
        const c = sku.color || '';
        if (colorCounts.get(c) > 1) {
          const count = (colorSeen.get(c) || 0) + 1;
          colorSeen.set(c, count);
          if (c) {
            sku.color = `${c} (${sku.vendor_sku || count})`;
          } else {
            sku.color = sku.vendor_sku || `Variant ${count}`;
          }
        } else if (!c) {
          sku.color = sku.vendor_sku || 'Default';
        }
      }
    }

    if (DRY_RUN) {
      console.log('\n[DRY RUN] No database changes made. Remove --dry-run to execute.\n');

      // Show a preview of what would happen
      console.log('=== Preview of changes ===\n');
      console.log(`Would DELETE: ${feeSkus.length} fee/charge SKUs`);
      console.log(`Would CREATE: ${productLineMap.size} new products`);
      console.log(`Would REASSIGN: ${totalSkus - feeSkus.length} SKUs`);
      console.log(`Would DELETE/ARCHIVE: up to ${uniqueProducts.size} old products\n`);

      // Show sample product lines
      console.log('Sample products (top 5):');
      for (const [, group] of sortedLines.slice(0, 5)) {
        console.log(`\n  "${group.collection}" / "${group.displayName}" (${group.skus.length} SKUs)`);
        for (const sku of group.skus.slice(0, 3)) {
          console.log(`    ${sku.vendor_sku} → color: "${sku.color}", accessory: ${sku.is_accessory}`);
        }
        if (group.skus.length > 3) console.log(`    ... and ${group.skus.length - 3} more`);
      }

      await pool.end();
      return;
    }

    // -----------------------------------------------------------------------
    // Step 5: Execute in a transaction
    // -----------------------------------------------------------------------
    console.log('\n── Executing cleanup ──\n');

    await client.query('BEGIN');

    try {
      // 5a. Delete fee/charge products (FK-safe order)
      if (feeSkus.length > 0) {
        const feeSkuIds = feeSkus.map(s => s.sku_id);

        // Delete from child tables first
        await client.query(`DELETE FROM sku_attributes WHERE sku_id = ANY($1)`, [feeSkuIds]);
        await client.query(`DELETE FROM pricing WHERE sku_id = ANY($1)`, [feeSkuIds]);
        await client.query(`DELETE FROM packaging WHERE sku_id = ANY($1)`, [feeSkuIds]);
        await client.query(`DELETE FROM inventory_snapshots WHERE sku_id = ANY($1)`, [feeSkuIds]);
        await client.query(`DELETE FROM media_assets WHERE sku_id = ANY($1)`, [feeSkuIds]);

        // SET NULL on cart_items and order_items referencing these SKUs
        await client.query(`UPDATE cart_items SET sku_id = NULL WHERE sku_id = ANY($1)`, [feeSkuIds]);
        await client.query(`UPDATE order_items SET sku_id = NULL WHERE sku_id = ANY($1)`, [feeSkuIds]);

        // Delete SKUs
        await client.query(`DELETE FROM skus WHERE id = ANY($1)`, [feeSkuIds]);

        // Delete fee products that have no remaining SKUs
        const feeProductIdArr = [...feeProductIds];
        await client.query(`
          DELETE FROM media_assets WHERE product_id = ANY($1)
            AND product_id NOT IN (SELECT DISTINCT product_id FROM skus WHERE product_id = ANY($1))
        `, [feeProductIdArr]);
        await client.query(`
          DELETE FROM products WHERE id = ANY($1)
            AND id NOT IN (SELECT DISTINCT product_id FROM skus WHERE product_id = ANY($1))
        `, [feeProductIdArr]);

        console.log(`Deleted ${feeSkus.length} fee/charge SKUs`);
      }

      // 5b. Create new products and reassign SKUs
      let productsCreated = 0;
      let skusReassigned = 0;
      const oldProductIds = new Set();

      for (const [, group] of productLineMap) {
        // Create the new product
        const productResult = await client.query(`
          INSERT INTO products (vendor_id, name, collection, status)
          VALUES ($1, $2, $3, 'active')
          ON CONFLICT (vendor_id, collection, name) DO UPDATE SET
            status = 'active', updated_at = NOW()
          RETURNING id
        `, [vendorId, group.displayName, group.collection]);
        const newProductId = productResult.rows[0].id;
        productsCreated++;

        // Reassign each SKU
        for (const sku of group.skus) {
          oldProductIds.add(sku.old_product_id);

          await client.query(`
            UPDATE skus SET
              product_id = $1,
              variant_name = $2,
              variant_type = $3,
              updated_at = NOW()
            WHERE id = $4
          `, [newProductId, sku.color, sku.variant_type, sku.sku_id]);
          skusReassigned++;
        }

        // Migrate media_assets from old products to new product
        // Use INSERT ... ON CONFLICT to avoid unique constraint violations
        // when multiple old products merge into one new product
        const oldPids = [...new Set(group.skus.map(s => s.old_product_id))];
        for (const oldPid of oldPids) {
          const remaining = await client.query(
            `SELECT COUNT(*) FROM skus WHERE product_id = $1`, [oldPid]
          );
          if (parseInt(remaining.rows[0].count) === 0) {
            // Move SKU-level assets (no conflict since sku_id is unique)
            await client.query(`
              UPDATE media_assets SET product_id = $1
              WHERE product_id = $2 AND sku_id IS NOT NULL
            `, [newProductId, oldPid]);
            // For product-level assets, delete any that would conflict
            await client.query(`
              DELETE FROM media_assets WHERE product_id = $2 AND sku_id IS NULL
                AND EXISTS (
                  SELECT 1 FROM media_assets ma2
                  WHERE ma2.product_id = $1 AND ma2.sku_id IS NULL
                    AND ma2.asset_type = media_assets.asset_type
                    AND ma2.sort_order = media_assets.sort_order
                )
            `, [newProductId, oldPid]);
            // Move remaining product-level assets
            await client.query(`
              UPDATE media_assets SET product_id = $1
              WHERE product_id = $2 AND sku_id IS NULL
            `, [newProductId, oldPid]);
          }
        }
      }

      // 5c. Clean placeholder descriptions on new products
      await client.query(`
        UPDATE products SET
          description_long = NULL,
          description_short = NULL
        WHERE vendor_id = $1
          AND collection LIKE 'AHF%'
          AND (
            description_long ~ '^(Engineered Hardwood|Solid Hardwood|Hardwood Transition)?\\s*(flooring\\s+)?by AHF'
            OR description_long IS NOT NULL AND LENGTH(TRIM(description_long)) < 20
          )
      `, [vendorId]);
      console.log(`Cleaned placeholder descriptions`);

      // 5d. Delete or archive orphaned old products
      const oldPidArr = [...oldProductIds];
      let archived = 0;
      let deleted = 0;

      for (const oldPid of oldPidArr) {
        // Check if product still has SKUs
        const remaining = await client.query(
          `SELECT COUNT(*) FROM skus WHERE product_id = $1`, [oldPid]
        );
        if (parseInt(remaining.rows[0].count) > 0) continue;

        // Check if this is one of the new products (from ON CONFLICT)
        const isNewProduct = await client.query(
          `SELECT 1 FROM products WHERE id = $1 AND collection LIKE 'AHF - %'`, [oldPid]
        );
        if (isNewProduct.rows.length > 0) continue;

        // Check if referenced by orders → archive instead of delete
        const orderRefs = await client.query(
          `SELECT COUNT(*) FROM order_items WHERE product_id = $1`, [oldPid]
        );
        const quoteRefs = await client.query(
          `SELECT COUNT(*) FROM quote_items WHERE product_id = $1`, [oldPid]
        );
        const hasRefs = parseInt(orderRefs.rows[0].count) > 0 || parseInt(quoteRefs.rows[0].count) > 0;

        if (hasRefs) {
          await client.query(
            `UPDATE products SET status = 'archived', is_active = false, updated_at = NOW() WHERE id = $1`,
            [oldPid]
          );
          archived++;
        } else {
          // Safe to delete — remove child records first
          await client.query(`DELETE FROM media_assets WHERE product_id = $1`, [oldPid]);
          await client.query(`DELETE FROM wishlists WHERE product_id = $1`, [oldPid]);
          await client.query(`DELETE FROM product_reviews WHERE product_id = $1`, [oldPid]);
          await client.query(`DELETE FROM installation_inquiries WHERE product_id = $1`, [oldPid]);
          await client.query(`DELETE FROM products WHERE id = $1`, [oldPid]);
          deleted++;
        }
      }

      await client.query('COMMIT');

      console.log(`\n=== Cleanup Complete ===`);
      console.log(`  Products created:     ${productsCreated}`);
      console.log(`  SKUs reassigned:      ${skusReassigned}`);
      console.log(`  Fee SKUs deleted:     ${feeSkus.length}`);
      console.log(`  Old products deleted: ${deleted}`);
      console.log(`  Old products archived: ${archived}`);

    } catch (err) {
      await client.query('ROLLBACK');
      console.error('\nTransaction rolled back due to error:', err.message);
      throw err;
    }

    // -----------------------------------------------------------------------
    // Step 6: Verification query
    // -----------------------------------------------------------------------
    console.log('\n── Verification ──\n');
    const verification = await client.query(`
      SELECT p.collection, p.name, COUNT(s.id) AS sku_count
      FROM products p
      JOIN skus s ON s.product_id = p.id
      WHERE p.vendor_id = $1 AND p.collection LIKE 'AHF%'
      GROUP BY p.collection, p.name
      ORDER BY sku_count DESC
    `, [vendorId]);

    console.log(`New product count: ${verification.rows.length}`);
    console.log(`\nCollection | Product Name | SKUs`);
    console.log(`${'─'.repeat(60)}`);
    for (const row of verification.rows) {
      console.log(`  ${row.collection} | ${row.name} | ${row.sku_count}`);
    }

    const totalAfter = verification.rows.reduce((sum, r) => sum + parseInt(r.sku_count), 0);
    console.log(`\nTotal SKUs after cleanup: ${totalAfter}`);

  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
