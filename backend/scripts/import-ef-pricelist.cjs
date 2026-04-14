#!/usr/bin/env node

/**
 * Import Engineered Floors — PRTPRC.pdf Customer Price List
 *
 * Source: PRTPRC.pdf from EF (Engineered Floors LLC, Dalton GA)
 * Effective: 3/20/26, Customer: Roma Flooring (018110-0000)
 *
 * Columns: STYLE CODE, STYLE DESCRIPTION, SIZE, BACK, STD ROLL, FIBER, BRAND, ROLL PRICE, CUT PRICE, UM
 *
 * Matching logic:
 *   - Each PDF row = one style+size+back combo; price applies to ALL colors of that style
 *   - Match to DB SKUs by: vendor_sku LIKE '1-{styleCode}-%' AND size+back codes
 *   - For carpet (UM=SY): ROLL PRICE = dealer cost/sy, CUT PRICE = retail/sy
 *   - For sqft items (UM=SF): prices already per sqft
 *   - For each items (UM=EA): prices per unit
 *
 * Usage:
 *   node backend/scripts/import-ef-pricelist.cjs [--dry-run]
 *   docker compose exec api node scripts/import-ef-pricelist.cjs [--dry-run]
 */

const fs = require('fs');
const path = require('path');
const pg = require('pg');

const DRY_RUN = process.argv.includes('--dry-run');

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

// ──────────────────────────────────────────────
// PDF SIZE → DB size_code mapping
// ──────────────────────────────────────────────
function normalizeSizeCode(pdfSize) {
  if (!pdfSize) return null;
  const s = pdfSize.trim().toUpperCase();

  // "12'" → "1200" (broadloom 12-foot width)
  if (/^12'$/.test(s)) return '1200';

  // "12' 20OZ" → "120020", "12' 26OZ" → "120026"
  if (/^12'\s*20OZ$/i.test(s)) return '120020';
  if (/^12'\s*26OZ$/i.test(s)) return '120026';

  // "1200" → "1200" (direct)
  if (/^1200$/.test(s)) return '1200';

  // Dimension formats: "7\" X 48\"" → "7X48", "7" X 48"" → "7X48"
  const dimMatch = s.match(/^(\d+)"?\s*X\s*(\d+)"?$/);
  if (dimMatch) return `${dimMatch[1]}X${dimMatch[2]}`;

  // "2X94", "4X94", "1X94", etc. — already in correct format
  if (/^\d+X\d+$/.test(s)) return s;

  // "24X24" etc.
  if (/^\d+X\d+$/.test(s.replace(/\s/g, ''))) return s.replace(/\s/g, '');

  // "6X48", "12X48", "12X50"
  if (/^\d+X\d+$/i.test(s)) return s;

  // "18X18 TL" → "18X18" (tile suffix)
  const tileMatch = s.match(/^(\d+X\d+)\s*TL$/i);
  if (tileMatch) return tileMatch[1];

  // "9X60"
  if (/^\d+X\d+$/.test(s)) return s;

  // "1 GALLON", "4 GAL", "QUARTS", "1 ROLL", "LVT" — special items
  // These are IND ITEM / PAD types, return raw for special handling
  return s;
}

// ──────────────────────────────────────────────
// PDF BACK → DB back_code mapping
// ──────────────────────────────────────────────
// Maps PDF BACK value to an array of possible DB back codes
// (some styles use different codes for the same accessory type)
const BACK_TO_CODE = {
  // Main products
  'ACTION':    ['A', 'AB'],
  'ILOC':      ['IL'],
  'FLOATING':  ['FL', 'CL'],
  'DRY BACK':  ['DB'],
  'LUX VNYL':  ['LV'],
  'LUX VINYL': ['LV'],
  'NEXUS':     ['NX'],
  'MOD TILE':  ['6M', 'NX'],   // some mod tiles are NX, some 6M
  'RGDFLR':    ['RF'],
  'RDGDFLR':   ['RF'],
  'RGD LNG':   ['RL'],
  '20MILFLT':  ['20'],
  'KANGAHYD':  ['K'],
  'PRMRBCPL':  ['HP'],
  'DIRECT 5':  ['K5'],
  'DIRECT 6':  ['K6'],
  'LAMINATE':  ['CL'],
  // Accessories
  'END CAP':   ['EN', 'EC'],
  'FLSHSTNS':  ['FN', 'FS'],
  'FLUSHSTR':  ['FN', 'FS'],
  'OVRLPSTN':  ['OS'],
  'QUARTER':   ['QU', 'QR'],
  'REDUCER':   ['RE', 'RD'],
  'T MOLD':    ['TM', 'TH'],
  'TMOLDING':  ['TM', 'TH'],
  '2STRTRDS':  ['T2', 'TS'],
  '2STRTRD':   ['T2', 'TS'],
  'TPSTRTRD':  ['T2', 'TS'],
  'USSTRNSA':  ['SN'],
  // Special items
  'IND ITEM':  ['IND'],
  'PAD':       ['PAD'],
  'SMART SQUARES': ['SS'],
  // Inferred: LVT with no explicit BACK — try all LVT back codes
  '_LVT_INFER': ['FL', 'DB', 'LV', 'RF', 'CL', '20', 'RL'],
};

// Accessory BACK types
const ACCESSORY_BACKS = new Set([
  'END CAP', 'FLSHSTNS', 'FLUSHSTR', 'OVRLPSTN', 'QUARTER',
  'REDUCER', 'T MOLD', 'TMOLDING', '2STRTRDS', '2STRTRD', 'TPSTRTRD', 'USSTRNSA',
]);

// ──────────────────────────────────────────────
// PDF parsing
// ──────────────────────────────────────────────
async function parsePdf(filePath) {
  const { PDFParse } = require('pdf-parse');
  const dataBuffer = fs.readFileSync(filePath);
  const uint8 = new Uint8Array(dataBuffer);
  const parser = new PDFParse(uint8);
  const result = await parser.getText();
  return result.text;
}

/**
 * Parse PDF text into structured rows.
 * Each row: { styleCode, styleName, size, back, stdRoll, fiber, brand, rollPrice, cutPrice, um }
 */
function parseRows(text) {
  const lines = text.split('\n');
  const rows = [];

  // Skip header/footer lines — data rows start with a style code (alphanumeric)
  // Format: STYLE_CODE  STYLE_DESCRIPTION  SIZE  BACK  STD_ROLL  FIBER  BRAND  ROLL_PRICE  CUT_PRICE  UM
  // But text extraction can be messy, so we use the known column structure

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Skip known header/footer/boilerplate lines
    if (trimmed.startsWith('STYLE')) continue;
    if (trimmed.startsWith('CODE')) continue;
    if (trimmed.startsWith('PAGE')) continue;
    if (trimmed.startsWith('ENGINEERED FLOORS')) continue;
    if (trimmed.startsWith('PO BOX')) continue;
    if (trimmed.startsWith('DALTON')) continue;
    if (trimmed.startsWith('FAX')) continue;
    if (trimmed.startsWith('PHONE')) continue;
    if (trimmed.startsWith('CUSTOMER PRICE')) continue;
    if (trimmed.startsWith('ROMA FLOORING')) continue;
    if (trimmed.startsWith('1440 S ST')) continue;
    if (trimmed.startsWith('ANAHEIM')) continue;
    if (trimmed.startsWith('This price list')) continue;
    if (trimmed.startsWith('CONDITIONS OF SALE')) continue;
    if (trimmed.startsWith('TERMS')) continue;
    if (trimmed.startsWith('ALL COMPLAINTS')) continue;
    if (trimmed.startsWith('FOR CREDIT')) continue;
    if (trimmed.startsWith('Thank you for')) continue;
    if (trimmed.startsWith('CUST NO')) continue;
    if (trimmed.startsWith('SALES REP')) continue;
    if (trimmed.startsWith('EFFECTIVE')) continue;
    if (trimmed.startsWith('F.O.B')) continue;
    if (trimmed.includes('Innovation Reinvented')) continue;
    if (trimmed.includes('RESIDENTIAL')) continue;
    if (trimmed.includes('CARPET')) continue;
    if (/^CA \d{5}/.test(trimmed)) continue;
    if (/^\d{3}-\d{3}-\d{4}/.test(trimmed)) continue;
    if (/^018110/.test(trimmed)) continue;
    if (/^60-244/.test(trimmed)) continue;
    if (/^714-/.test(trimmed)) continue;
    if (/^3\/20\/26/.test(trimmed)) continue;
    if (/^M-MILL/.test(trimmed)) continue;
    if (/^NET CBD/.test(trimmed)) continue;
    if (/^STD$/.test(trimmed)) continue;
    if (/^ROLL$/.test(trimmed)) continue;
    if (/^CUT$/.test(trimmed)) continue;
    if (/^PRICE$/.test(trimmed)) continue;
    if (/^UM$/.test(trimmed)) continue;

    // Data rows start with a style code: alphanumeric (e.g., "8746", "W020", "D2026", "EH006", etc.)
    const rowMatch = trimmed.match(/^([A-Z0-9]{1,6}[A-Z]?)\s+(.+)$/);
    if (!rowMatch) continue;

    const styleCode = rowMatch[1];
    const rest = rowMatch[2];

    // Parse the rest of the line — this is tricky because it's not strictly fixed-width
    // We need to identify: STYLE DESCRIPTION, SIZE, BACK, STD ROLL, FIBER, BRAND, ROLL PRICE, CUT PRICE, UM
    // Strategy: parse from right to left since UM, prices, and BRAND are more predictable

    // UM is always at the end: SY, SF, or EA
    const umMatch = rest.match(/\s+(SY|SF|EA)\s*$/);
    if (!umMatch) continue;
    const um = umMatch[1];
    let remaining = rest.slice(0, umMatch.index).trim();

    // Extract ALL prices from the end (there may be 1 or 2)
    // Prices are formatted as $X.XX, $XX.XX, $XXX.XX, or $.XX (sub-dollar)
    const prices = [];
    let priceRemaining = remaining;
    for (let attempt = 0; attempt < 2; attempt++) {
      const pm = priceRemaining.match(/\s+\$(\d*\.?\d{2})\s*$/);
      if (!pm) break;
      prices.unshift(parseFloat(pm[1])); // prepend — we're reading right-to-left
      priceRemaining = priceRemaining.slice(0, pm.index).trim();
    }

    if (prices.length === 0) continue; // No prices at all — skip

    let rollPrice, cutPrice;
    if (prices.length === 2) {
      rollPrice = prices[0];  // ROLL PRICE (first/left = dealer cost)
      cutPrice = prices[1];   // CUT PRICE (second/right = retail)
    } else {
      rollPrice = prices[0];  // Only one price — it's the ROLL PRICE
      cutPrice = null;
    }

    remaining = priceRemaining;

    // BRAND: 2-4 char code at end (DW, DWS, HS, EHS, PHS, DVT, PNZ, EF, DW)
    const brandMatch = remaining.match(/\s+(DW|DWS|HS|EHS|PHS|DVT|PNZ|EF)\s*$/);
    let brand = null;
    if (brandMatch) {
      brand = brandMatch[1];
      remaining = remaining.slice(0, brandMatch.index).trim();
    }

    // FIBER: varies (e.g., "PURECOLOR POLYESTER", "TWISTX", "LVT", "TRIM/ACCESS", etc.)
    // We need to find it between BACK and BRAND. FIBER is always present.
    // Known fiber values: PURECOLOR POLYESTER, PURECOLOR SOFT POLY, PURECOLOR HIDEF,
    //   PURECOLOR NYLON, TWISTX, LVT, LAMINATE, TRIM/ACCESS, ADHESIVE,
    //   MAIN STREET TILE PLY, MAIN STREET TILE NYL, MAIN STREET BL POLY,
    //   MAIN STREET BL NYL, SMART SQUARES
    const FIBER_PATTERNS = [
      'PURECOLOR SOFT POLY', 'PURECOLOR POLYESTER', 'PURECOLOR HIDEF',
      'PURECOLOR NYLON', 'MAIN STREET TILE PLY', 'MAIN STREET TILE NYL',
      'MAIN STREET BL POLY', 'MAIN STREET BL NYL', 'SMART SQUARES',
      'TWISTX', 'LVT', 'LAMINATE', 'TRIM/ACCESS', 'ADHESIVE',
    ];

    let fiber = null;
    for (const fp of FIBER_PATTERNS) {
      const idx = remaining.lastIndexOf(fp);
      if (idx >= 0) {
        fiber = fp;
        remaining = remaining.slice(0, idx).trim();
        break;
      }
    }
    if (!fiber) continue; // Can't parse fiber — skip

    // STD ROLL: optional numeric (e.g., "150.00", "50.00")
    let stdRoll = null;
    const stdRollMatch = remaining.match(/\s+(\d+\.\d{2})\s*$/);
    if (stdRollMatch) {
      stdRoll = parseFloat(stdRollMatch[1]);
      remaining = remaining.slice(0, stdRollMatch.index).trim();
    }

    // BACK: keyword at end
    // Known BACK values: ACTION, FLOATING, DRY BACK, LUX VNYL, NEXUS, MOD TILE,
    //   ILOC, KANGAHYD, PRMRBCPL, RGDFLR, RDGDFLR, RGD LNG, 20MILFLT,
    //   END CAP, FLSHSTNS, FLUSHSTR, OVRLPSTN, QUARTER, REDUCER, T MOLD, TMOLDING,
    //   2STRTRDS, 2STRTRD, TPSTRTRD, USSTRNSA, IND ITEM, PAD, DIRECT 5, DIRECT 6
    const BACK_PATTERNS = [
      'DRY BACK', 'LUX VNYL', 'LUX VINYL', 'MOD TILE', 'RGD LNG', 'IND ITEM',
      'END CAP', 'T MOLD', 'DIRECT 5', 'DIRECT 6', 'SMART SQUARES',
      'ACTION', 'FLOATING', 'NEXUS', 'ILOC', 'KANGAHYD', 'PRMRBCPL',
      'RGDFLR', 'RDGDFLR', '20MILFLT', 'FLSHSTNS', 'FLUSHSTR',
      'OVRLPSTN', 'QUARTER', 'REDUCER', 'TMOLDING', '2STRTRDS', '2STRTRD',
      'TPSTRTRD', 'USSTRNSA', 'PAD', 'LAMINATE',
    ];

    let back = null;
    for (const bp of BACK_PATTERNS) {
      if (remaining.toUpperCase().endsWith(bp)) {
        back = bp;
        remaining = remaining.slice(0, remaining.length - bp.length).trim();
        break;
      }
    }
    // 4 PDF rows have no BACK (e.g., "EH006 ANDES 6X48 50.00 LVT $3.55 $3.65 SF")
    // These are LVT products — infer BACK from fiber+UM
    if (!back && fiber === 'LVT' && um === 'SF') {
      back = '_LVT_INFER'; // special sentinel — will try all LVT back codes
    }
    if (!back) continue;

    // SIZE: what remains after style description
    // The remaining text is: "STYLE_DESCRIPTION  SIZE"
    // SIZE is at the end, often "12'", "7\" X 48\"", "2X94", "24X24", etc.
    const SIZE_PATTERNS = [
      /\s+(12'\s*26OZ)\s*$/i,         // "12' 26OZ"
      /\s+(12'\s*20OZ)\s*$/i,         // "12' 20OZ"
      /\s+(7"\s*X\s*48")\s*$/i,       // 7" X 48"
      /\s+(12"\s*X\s*24")\s*$/i,      // 12" X 24"
      /\s+(18X18\s*TL)\s*$/i,         // 18X18 TL (tile)
      /\s+(\d+"\s*X\s*\d+")\s*$/i,    // NxM with quotes
      /\s+(\d+'\s*X\s*\d+')\s*$/i,    // N'XM' (e.g., 6'X75')
      /\s+(\d+\s+X\s+\d+)\s*$/,       // N X M (with spaces)
      /\s+(\d+X\d+)\s*$/,             // NXM (no spaces)
      /\s+(\d+X\d+'\d*"?)\s*$/,       // 3X33'4" special
      /\s+(12')\s*$/,                  // 12' broadloom
      /\s+(1200)\s*$/,                 // 1200 (broadloom alt)
      /\s+(\d+\s*GALLON)\s*$/i,       // N GALLON
      /\s+(\d+\s*GAL)\s*$/i,          // N GAL
      /\s+(QUARTS)\s*$/i,             // QUARTS
      /\s+(1\s*ROLL)\s*$/i,           // 1 ROLL
      /\s+(LVT)\s*$/,                 // LVT (standalone)
    ];

    let size = null;
    for (const sp of SIZE_PATTERNS) {
      const m = remaining.match(sp);
      if (m) {
        size = m[1].trim();
        remaining = remaining.slice(0, m.index).trim();
        break;
      }
    }

    const styleName = remaining.trim();
    if (!styleName) continue;

    rows.push({
      styleCode,
      styleName,
      size: size || '',
      back,
      stdRoll,
      fiber,
      brand,
      rollPrice,
      cutPrice,
      um,
    });
  }

  return rows;
}

// ──────────────────────────────────────────────
// Main import logic
// ──────────────────────────────────────────────
async function main() {
  const pdfPath = process.argv.find(a => a.endsWith('.pdf')) ||
    path.join(__dirname, '..', 'data', 'PRTPRC.pdf');

  if (!fs.existsSync(pdfPath)) {
    console.error(`PDF not found: ${pdfPath}`);
    console.error('Copy PRTPRC.pdf to backend/data/PRTPRC.pdf');
    process.exit(1);
  }

  console.log(`Parsing PDF: ${pdfPath}`);
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN (no DB writes)' : 'LIVE'}\n`);

  const text = await parsePdf(pdfPath);
  const rows = parseRows(text);
  console.log(`Parsed ${rows.length} price rows from PDF\n`);

  if (rows.length === 0) {
    console.error('No rows parsed — check PDF format');
    process.exit(1);
  }

  // ── Get EF vendor ──
  const vendorRes = await pool.query("SELECT id FROM vendors WHERE code = 'EF'");
  if (!vendorRes.rows.length) {
    console.error('EF vendor not found in DB');
    process.exit(1);
  }
  const vendorId = vendorRes.rows[0].id;

  // ── Load all EF SKUs ──
  const skuRes = await pool.query(`
    SELECT s.id, s.vendor_sku, s.internal_sku, s.variant_name, s.sell_by, s.variant_type,
           s.product_id, p.name AS product_name
    FROM skus s
    JOIN products p ON s.product_id = p.id
    WHERE p.vendor_id = $1 AND s.status = 'active'
  `, [vendorId]);

  console.log(`Loaded ${skuRes.rows.length} active EF SKUs from DB\n`);

  // ── Build lookup index: styleCode → { sizeCode+backCode → [skuRows] } ──
  // vendor_sku format: 1-{styleCode}-{colorCode}-{sizeCode}-{backCode}
  const skuIndex = {};
  for (const sku of skuRes.rows) {
    const parts = sku.vendor_sku.split('-');
    if (parts.length < 5) continue;
    const style = parts[1];      // e.g., "W020", "1324"
    const sizeCode = parts[3];   // e.g., "7X48", "1200"
    const backCode = parts[parts.length - 1]; // last part, e.g., "FL", "A", "EN"

    if (!skuIndex[style]) skuIndex[style] = {};
    const key = `${sizeCode}|${backCode}`;
    if (!skuIndex[style][key]) skuIndex[style][key] = [];
    skuIndex[style][key].push(sku);
  }

  // ── Load categories for auto-creating products ──
  const catRes = await pool.query('SELECT id, slug FROM categories');
  const catMap = {};
  for (const r of catRes.rows) catMap[r.slug] = r.id;

  // ── Process each PDF row ──
  let matched = 0, unmatched = 0, skusUpdated = 0;
  let autoCreatedProducts = 0, autoCreatedSkus = 0;
  const unmatchedStyles = new Map();

  for (const row of rows) {
    const { styleCode, styleName, size, back, rollPrice, cutPrice, um } = row;

    // Skip Pentz items — handled by PC vendor
    if (row.brand === 'PNZ') continue;

    // Normalize size
    const sizeCode = normalizeSizeCode(size);

    // Get possible back codes
    const possibleBacks = BACK_TO_CODE[back.toUpperCase()] || [];
    if (!possibleBacks.length) {
      if (!unmatchedStyles.has(`BACK:${back}`)) {
        unmatchedStyles.set(`BACK:${back}`, { style: styleCode, name: styleName, size, back });
      }
      unmatched++;
      continue;
    }

    // Look up style in index
    const styleIndex = skuIndex[styleCode];

    if (!styleIndex) {
      // Style not found in DB — check if it's one of the auto-create styles
      const result = await handleMissingStyle(vendorId, catMap, row);
      if (result === 'created') {
        autoCreatedProducts++;
        matched++;
      } else {
        if (!unmatchedStyles.has(styleCode)) {
          unmatchedStyles.set(styleCode, { style: styleCode, name: styleName, size, back });
        }
        unmatched++;
      }
      continue;
    }

    // Try each possible back code
    let found = false;
    for (const backCode of possibleBacks) {
      const key = `${sizeCode}|${backCode}`;
      const matchedSkus = styleIndex[key];
      if (!matchedSkus || !matchedSkus.length) continue;

      // Update pricing for all matching SKUs (all colors of this style+size+back)
      for (const sku of matchedSkus) {
        if (!DRY_RUN) {
          await updatePricing(sku, rollPrice, cutPrice, um, back);
        }
        skusUpdated++;
      }
      found = true;
      break; // Found match, stop trying other back codes
    }

    // Fallback 1: fuzzy size matching (handles loose size formats)
    if (!found && sizeCode) {
      for (const backCode of possibleBacks) {
        for (const [key, matchedSkus] of Object.entries(styleIndex)) {
          const [skuSize, skuBack] = key.split('|');
          if (skuBack !== backCode) continue;
          if (sizesMatchLoose(sizeCode, skuSize)) {
            for (const sku of matchedSkus) {
              if (!DRY_RUN) {
                await updatePricing(sku, rollPrice, cutPrice, um, back);
              }
              skusUpdated++;
            }
            found = true;
            break;
          }
        }
        if (found) break;
      }
    }

    // Fallback 2: if size is non-numeric (e.g., "LVT"), match any size for this style+back
    if (!found && sizeCode && !/^\d/.test(sizeCode)) {
      for (const backCode of possibleBacks) {
        for (const [key, matchedSkus] of Object.entries(styleIndex)) {
          const [, skuBack] = key.split('|');
          if (skuBack !== backCode) continue;
          for (const sku of matchedSkus) {
            if (!DRY_RUN) {
              await updatePricing(sku, rollPrice, cutPrice, um, back);
            }
            skusUpdated++;
          }
          found = true;
          break;
        }
        if (found) break;
      }
    }

    if (found) {
      matched++;
    } else {
      if (!unmatchedStyles.has(`${styleCode}|${sizeCode}|${back}`)) {
        unmatchedStyles.set(`${styleCode}|${sizeCode}|${back}`, {
          style: styleCode, name: styleName, size, back, sizeCode
        });
      }
      unmatched++;
    }
  }

  // ── Summary ──
  console.log('\n═══════════════════════════════════════════');
  console.log('  EF Price List Import Summary');
  console.log('═══════════════════════════════════════════');
  console.log(`PDF rows parsed:      ${rows.length}`);
  console.log(`Pentz rows skipped:   ${rows.filter(r => r.brand === 'PNZ').length}`);
  console.log(`Rows matched:         ${matched}`);
  console.log(`Rows unmatched:       ${unmatched}`);
  console.log(`SKUs updated:         ${skusUpdated}`);
  console.log(`Auto-created prods:   ${autoCreatedProducts}`);
  console.log(`Mode:                 ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  console.log('═══════════════════════════════════════════\n');

  if (unmatchedStyles.size > 0) {
    console.log('Unmatched rows:');
    for (const [key, info] of unmatchedStyles) {
      console.log(`  ${info.style} ${info.name} | size=${info.size} back=${info.back} sizeCode=${info.sizeCode || '?'}`);
    }
  }

  // ── Verify results ──
  if (!DRY_RUN) {
    const verify = await pool.query(`
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE pr.retail_price > 0) AS has_retail,
        COUNT(*) FILTER (WHERE pr.cost > 0) AS has_cost
      FROM skus s
      JOIN products p ON s.product_id = p.id
      LEFT JOIN pricing pr ON pr.sku_id = s.id
      WHERE p.vendor_id = $1 AND s.status = 'active'
    `, [vendorId]);
    const v = verify.rows[0];
    console.log(`\nPost-import EF pricing coverage:`);
    console.log(`  Total active SKUs: ${v.total}`);
    console.log(`  With retail price: ${v.has_retail} (${(v.has_retail / v.total * 100).toFixed(1)}%)`);
    console.log(`  With cost:         ${v.has_cost} (${(v.has_cost / v.total * 100).toFixed(1)}%)`);
  }

  await pool.end();
}

// ──────────────────────────────────────────────
// Pricing update
// ──────────────────────────────────────────────
async function updatePricing(sku, rollPriceRaw, cutPriceRaw, um, back) {
  const isAccessory = ACCESSORY_BACKS.has(back.toUpperCase());
  let cost, retailPrice, priceBasis;
  let cutPrice = null, rollPriceSy = null, cutCost = null, rollCost = null;

  if (um === 'SY') {
    // Carpet: prices are per square yard
    // ROLL PRICE = our dealer cost per SY
    // CUT PRICE = retail/cut price per SY
    // Convert to per-sqft for base cost/retail (1 SY = 9 SF)
    cost = rollPriceRaw / 9;          // cost per sqft
    retailPrice = cutPriceRaw ? cutPriceRaw / 9 : cost;  // retail per sqft
    priceBasis = 'per_sqft';

    // Also store the per-SY values for carpet-specific pricing
    rollCost = rollPriceRaw;        // dealer cost per SY
    rollPriceSy = rollPriceRaw;     // roll price per SY
    cutPrice = cutPriceRaw || null;  // cut price per SY
    cutCost = rollPriceRaw;          // cut cost same as roll for this price list
  } else if (um === 'SF') {
    // Hard surface: already per sqft
    cost = rollPriceRaw;
    retailPrice = cutPriceRaw || rollPriceRaw;
    priceBasis = 'per_sqft';
  } else if (um === 'EA') {
    // Accessories: per unit
    cost = rollPriceRaw;
    retailPrice = cutPriceRaw || rollPriceRaw;
    priceBasis = 'per_unit';
  } else {
    return; // Unknown UM
  }

  // Upsert pricing
  await pool.query(`
    INSERT INTO pricing (sku_id, cost, retail_price, price_basis, cut_price, roll_price, cut_cost, roll_cost)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT (sku_id) DO UPDATE SET
      cost = $2,
      retail_price = $3,
      price_basis = $4,
      cut_price = COALESCE($5, pricing.cut_price),
      roll_price = COALESCE($6, pricing.roll_price),
      cut_cost = COALESCE($7, pricing.cut_cost),
      roll_cost = COALESCE($8, pricing.roll_cost)
  `, [sku.id, cost, retailPrice, priceBasis, cutPrice, rollPriceSy, cutCost, rollCost]);

  // Update sell_by if needed
  if (um === 'EA' && sku.sell_by !== 'unit') {
    await pool.query('UPDATE skus SET sell_by = $1 WHERE id = $2', ['unit', sku.id]);
  } else if (um === 'SY' && sku.sell_by !== 'sqyd') {
    await pool.query('UPDATE skus SET sell_by = $1 WHERE id = $2', ['sqyd', sku.id]);
  } else if (um === 'SF' && sku.sell_by !== 'sqft') {
    await pool.query('UPDATE skus SET sell_by = $1 WHERE id = $2', ['sqft', sku.id]);
  }
}

// ──────────────────────────────────────────────
// Fuzzy size matching
// ──────────────────────────────────────────────
function sizesMatchLoose(pdfSize, dbSize) {
  if (!pdfSize || !dbSize) return false;
  if (pdfSize === dbSize) return true;

  // Normalize both
  const norm = s => s.replace(/['"X\s]/gi, '').toUpperCase();
  if (norm(pdfSize) === norm(dbSize)) return true;

  // "1200" ↔ "12'" type matches
  if ((pdfSize === '1200' && dbSize === '1200') ||
      (pdfSize === "12'" && dbSize === '1200')) return true;

  return false;
}

// ──────────────────────────────────────────────
// Auto-create missing styles
// ──────────────────────────────────────────────
// These are styles in the PDF but not in the DB (mostly adhesives/accessories)
// Non-Pentz styles that may not exist in DB yet
// (PNZ-brand items like A557, A601, A1331, E167, NTAB, SC450 get skipped earlier)
const AUTO_CREATE_STYLES = {
  'E168':  { name: 'LVT Adhesive 1 Gallon',   sellBy: 'unit', category: 'installation-sundries', collection: 'EF Adhesives' },
  'SC100': { name: 'Soundcheck Underlayment',  sellBy: 'unit', category: 'installation-sundries', collection: 'EF Underlayment' },
};

async function handleMissingStyle(vendorId, catMap, row) {
  const config = AUTO_CREATE_STYLES[row.styleCode];
  if (!config) return 'skip';

  // Only auto-create for IND ITEM, PAD, and accessory backs
  const categoryId = catMap[config.category] || null;

  if (DRY_RUN) {
    console.log(`  [DRY RUN] Would auto-create: ${config.name} (${row.styleCode})`);
    return 'created';
  }

  // Upsert product
  const prodRes = await pool.query(`
    INSERT INTO products (vendor_id, name, collection, category_id, status)
    VALUES ($1, $2, $3, $4, 'active')
    ON CONFLICT ON CONSTRAINT products_vendor_collection_name_unique DO UPDATE SET
      updated_at = CURRENT_TIMESTAMP
    RETURNING id
  `, [vendorId, config.name, config.collection, categoryId]);
  const productId = prodRes.rows[0].id;

  // Create a single SKU for this item
  const internalSku = `EF-${row.styleCode}`;
  const variantName = row.size || config.name;
  const skuRes = await pool.query(`
    INSERT INTO skus (product_id, vendor_sku, internal_sku, variant_name, sell_by)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (internal_sku) DO UPDATE SET
      updated_at = CURRENT_TIMESTAMP
    RETURNING id
  `, [productId, row.styleCode, internalSku, variantName, config.sellBy]);
  const skuId = skuRes.rows[0].id;

  // Set pricing
  const cost = row.rollPrice;
  const retail = row.cutPrice || row.rollPrice;
  const priceBasis = config.sellBy === 'unit' ? 'per_unit' : 'per_sqft';

  await pool.query(`
    INSERT INTO pricing (sku_id, cost, retail_price, price_basis)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (sku_id) DO UPDATE SET
      cost = $2, retail_price = $3, price_basis = $4
  `, [skuId, cost, retail, priceBasis]);

  console.log(`  + Auto-created: ${config.name} (${row.styleCode}) — $${cost} / $${retail}`);
  return 'created';
}

main().catch(err => {
  console.error('Import failed:', err);
  process.exit(1);
});
