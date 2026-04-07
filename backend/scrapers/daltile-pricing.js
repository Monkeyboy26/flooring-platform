import { execSync } from 'child_process';
import fs from 'fs';
import {
  upsertProduct, upsertSku, upsertPricing, upsertPackaging, upsertSkuAttribute,
  appendLog, addJobError
} from './base.js';

/**
 * Daltile / American Olean / Marazzi TradePro Price Book PDF scraper.
 *
 * Parses TradePro-generated PDF price books (identical format across all three
 * brands). Each section in the PDF has:
 *   1. A COLLECTION / SERIES / COLOR PRICE GROUP header
 *   2. Product-type sub-headings (Floor Tile, Wall Tile Trim, Mosaic, etc.)
 *   3. Item data rows: NOMINAL SIZE | ITEM CODE | DESCRIPTION | COLOR REF# | $PRICE | U/M | U/CTN
 *   4. A COLOR REF table mapping color codes to ref column numbers
 *
 * Key insight: Each item row has a COLOR REF number that maps to a column in
 * the COLOR REF table at the end of the section. Colors with a "P" mark under
 * that column are available for that item. We expand each item × its valid
 * colors to create color-specific SKUs with vendor_sku = colorCode + itemCode
 * (e.g., AC11PLK848MT) which matches the Coveo catalog SKU format.
 *
 * The PRICE GROUP (GROUP 1, GROUP 2, etc.) is separate from the COLOR REF —
 * it comes from the collection header and defines pricing tiers.
 */

const BRAND_MAP = {
  'DALTILE US':        { code: 'DAL', name: 'Daltile' },
  'AMERICAN OLEAN US': { code: 'AO',  name: 'American Olean' },
  'MARAZZI US':        { code: 'MZ',  name: 'Marazzi' },
};

export async function run(pool, job, source) {
  const pdfPath = source.config && source.config.pdf_path;
  if (!pdfPath) throw new Error('No file configured. Upload a TradePro price book PDF first.');
  if (!fs.existsSync(pdfPath)) throw new Error(`File not found: ${pdfPath}`);

  await appendLog(pool, job.id, `Parsing PDF: ${pdfPath}`);

  const rawText = extractPdfText(pdfPath);
  await appendLog(pool, job.id, `Extracted ${rawText.length} characters from PDF`);

  const brand = detectBrand(rawText);
  if (!brand) throw new Error('Could not detect brand (Daltile/American Olean/Marazzi) from PDF header.');
  await appendLog(pool, job.id, `Detected brand: ${brand.name} (${brand.code})`);

  const sections = parsePriceBook(rawText);
  const totalItems = sections.reduce((sum, s) => sum + s.items.length, 0);
  const totalColors = sections.reduce((sum, s) => sum + s.colorRefTable.length, 0);
  await appendLog(pool, job.id,
    `Parsed ${sections.length} sections, ${totalItems} item rows, ${totalColors} color refs`
  );

  if (totalItems === 0) throw new Error('No item rows found in PDF. Check format.');

  // Log first few sections as samples
  for (const sec of sections.slice(0, 3)) {
    await appendLog(pool, job.id,
      `  ${sec.name}${sec.priceGroup ? ' (Group ' + sec.priceGroup + ')' : ''}: ` +
      `${sec.items.length} items, ${sec.colorRefTable.length} colors`
    );
    for (const item of sec.items.slice(0, 2)) {
      await appendLog(pool, job.id,
        `    ${item.size} ${item.itemCode} | ${item.description} | ref=${item.colorRef} $${item.price}/${item.unit} | ${item.unitsCtn}/ctn`
      );
    }
    for (const cr of sec.colorRefTable.slice(0, 3)) {
      await appendLog(pool, job.id,
        `    Color: ${cr.code} ${cr.name} → refs [${cr.refs.join(',')}]`
      );
    }
  }

  const vendorId = source.vendor_id;

  // Load category lookup for auto-categorization
  const catMap = await loadCategoryMap(pool);

  let stats = {
    productsCreated: 0, productsUpdated: 0,
    skusCreated: 0, pricingSet: 0, packagingSet: 0, colorsSet: 0,
    errors: 0
  };

  for (let ci = 0; ci < sections.length; ci++) {
    const sec = sections[ci];
    try {
      // Build color ref lookup: refNumber → [{code, name}]
      const colorsByRef = new Map();
      for (const cr of sec.colorRefTable) {
        for (const refNum of cr.refs) {
          if (!colorsByRef.has(refNum)) colorsByRef.set(refNum, []);
          colorsByRef.get(refNum).push({ code: cr.code, name: cr.name });
        }
      }

      // Create SKUs: expand each item by its matching colors
      // Product creation happens inside createItemSku — one product per (series + color)
      for (const item of sec.items) {
        try {
          const colors = colorsByRef.get(item.colorRef) || [];

          if (colors.length === 0) {
            // No color ref data — create a single SKU under section-level product
            await createItemSku(pool, vendorId, brand, sec, item, null, null, stats, catMap);
          } else {
            // One SKU per (item, color) combination — product per color
            for (const color of colors) {
              await createItemSku(pool, vendorId, brand, sec, item, color.code, color.name, stats, catMap);
            }
          }
        } catch (err) {
          stats.errors++;
          if (stats.errors <= 30) {
            await addJobError(pool, job.id, `Item ${item.itemCode} in ${sec.name}: ${err.message}`);
          }
        }
      }
    } catch (err) {
      stats.errors++;
      if (stats.errors <= 20) {
        await addJobError(pool, job.id, `Section ${sec.name}: ${err.message}`);
      }
    }

    if ((ci + 1) % 30 === 0) {
      await appendLog(pool, job.id,
        `Progress: ${ci + 1}/${sections.length} sections, SKUs: ${stats.skusCreated}`,
        { products_found: ci + 1, products_created: stats.productsCreated, skus_created: stats.skusCreated }
      );
    }
  }

  await appendLog(pool, job.id,
    `Complete. Sections: ${sections.length}, Products: ${stats.productsUpdated} updated, ` +
    `SKUs: ${stats.skusCreated}, Pricing: ${stats.pricingSet}, Packaging: ${stats.packagingSet}, ` +
    `Colors: ${stats.colorsSet}, Skipped (not in catalog): ${stats.skipped || 0}, Errors: ${stats.errors}`,
    {
      products_found: totalItems,
      products_created: stats.productsCreated,
      products_updated: stats.pricingSet,
      skus_created: stats.skusCreated
    }
  );
}

/**
 * Create a single color-level SKU from an item row + optional color.
 * Also upserts the product — one product per (series + color).
 * vendor_sku = colorCode + itemCode (e.g., "AC11PLK848MT") — matches Coveo SKU format.
 */
async function createItemSku(pool, vendorId, brand, section, item, colorCode, colorName, stats, catMap) {
  // Product = Color only (e.g., "Palomino"); collection holds the series
  const productName = colorName || section.name;
  const productCollection = section.collection || section.series || '';

  // Only add pricing to products that already exist (from catalog scraper).
  // Products only in the price book but not in the public catalog are likely discontinued.
  const existing = await pool.query(
    'SELECT id FROM products WHERE vendor_id = $1 AND collection = $2 AND name = $3',
    [vendorId, productCollection, productName]
  );
  if (!existing.rows.length) {
    stats.skipped = (stats.skipped || 0) + 1;
    return;
  }
  const product = existing.rows[0];
  stats.productsUpdated++;

  const vendorSku = colorCode ? `${colorCode}${item.itemCode}` : item.itemCode;
  const internalSku = `${brand.code}-${vendorSku}`;

  const isSqft = item.unit === 'SF';
  const sellBy = isSqft ? 'sqft' : 'unit';
  const priceBasis = isSqft ? 'per_sqft' : 'per_unit';

  // variant_name drops color (it's in the product name now) — just size + description
  const variantParts = [item.size, item.description].filter(Boolean);
  const variantName = variantParts.join(' ') || null;

  const sku = await upsertSku(pool, {
    product_id: product.id,
    vendor_sku: vendorSku,
    internal_sku: internalSku,
    variant_name: variantName,
    sell_by: sellBy,
    variant_type: item.productType || null
  });
  if (sku.is_new) stats.skusCreated++;

  const dalCost = parseFloat(item.price) || 0;
  await upsertPricing(pool, sku.id, {
    cost: dalCost,
    retail_price: retailFromCost(dalCost),
    price_basis: priceBasis
  });
  stats.pricingSet++;

  if (item.unitsCtn > 0) {
    const pkgData = isSqft
      ? { sqft_per_box: item.unitsCtn }
      : { pieces_per_box: item.unitsCtn };
    await upsertPackaging(pool, sku.id, pkgData);
    stats.packagingSet++;
  }

  if (colorName) {
    await upsertSkuAttribute(pool, sku.id, 'color', colorName);
    stats.colorsSet++;
  }
}

/**
 * Cost-based sliding retail markup. Higher-cost items get a lower multiplier
 * since Daltile TradePro PDFs only provide wholesale costs, not retail/MAP prices.
 */
function retailFromCost(cost) {
  if (!cost || cost <= 0) return 0;
  const multiplier = cost < 5 ? 2.5
    : cost < 15 ? 2.2
    : cost < 30 ? 2.0
    : cost < 50 ? 1.8
    : 1.6;
  return Math.round(cost * multiplier * 100) / 100;
}

// ─── PDF Extraction ──────────────────────────────────────────────────────────

function extractPdfText(pdfPath) {
  try {
    return execSync(`pdftotext -layout "${pdfPath}" -`, {
      maxBuffer: 100 * 1024 * 1024,
      encoding: 'utf-8'
    });
  } catch (err) {
    throw new Error(`pdftotext failed: ${err.message}. Is poppler-utils installed?`);
  }
}

function detectBrand(text) {
  const header = text.slice(0, 500).toUpperCase();
  for (const [pattern, brand] of Object.entries(BRAND_MAP)) {
    if (header.includes(pattern)) return brand;
  }
  return null;
}

// ─── Price Book Parser ───────────────────────────────────────────────────────

/**
 * Parse the full price book text into structured sections.
 *
 * Returns: [{
 *   name,           — product name (Collection Series or just Series)
 *   series,         — series name
 *   collection,     — collection name (or same as series)
 *   priceGroup,     — price group from header ("1", "2", or null)
 *   items: [{
 *     size,         — nominal size (e.g., "8X48")
 *     itemCode,     — base item code (e.g., "PLK848MT")
 *     description,  — item description (e.g., "Plank, Matte")
 *     colorRef,     — color ref column number (1, 2, 3, etc.)
 *     price,        — unit price (float)
 *     unit,         — unit of measure (SF, PC, SH, LF, EA)
 *     unitsCtn,     — units per carton (float, 0 if N/A)
 *     productType   — product type slug (floor_tile, wall_trim, etc.)
 *   }],
 *   colorRefTable: [{
 *     code,   — color code (e.g., "AC11")
 *     name,   — color name (e.g., "Palomino")
 *     refs    — array of ref column numbers this color belongs to [1, 2]
 *   }]
 * }]
 */
function parsePriceBook(text) {
  const lines = text.split('\n');
  const sections = [];

  let sectionObj = null;
  let currentProductType = null;
  let inColorRef = false;
  let colorRefColPositions = []; // [{num, charPos}] from COLOR REF header

  // Item data row regex — matches the trailing portion:
  //   COLOR_REF_NUM  $PRICE  U/M  U/CTN
  const itemTailRegex = /(\d+)\s+\$([\d,]+\.?\d{0,2})\s+(SF|PC|SH|LF|EA)\s+([\d.]+|-)\s*$/;

  // Known product-type section headings (order: longest first to avoid partial matches)
  const PRODUCT_TYPES = [
    'Floor Tile Trim', 'Floor Tile Deco', 'Floor Tile',
    'Wall Tile Trim', 'Wall Tile Deco', 'Wall Tile',
    'Wall Bathroom Accessories', 'Bathroom Accessories',
    'Mosaic Tile Trim', 'Mosaic Natural Stone Tile',
    'Stone Tile Trim', 'Stone Tile',
    'Quarry Tile Trim', 'Quarry Tile',
    'Porcelain Slab', 'Quartz Slab', 'Natural Stone Slab',
    'Luxury Vinyl Tile',
    'LVT Trim', 'LVT Plank', 'LVT',
  ];

  // Mosaic headings with variable sheet sizes: "Mosaic Tile 12x24 Sheet"
  const mosaicRegex = /^Mosaic(?:\s+Natural\s+Stone)?\s+Tile(?:\s+\d+x\d+\s+Sheet)?(?:\s+Trim)?$/i;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) continue;
    if (isNoiseLine(trimmed)) continue;

    // ── Section header: COLLECTION / SERIES / COLOR PRICE GROUP ──
    if (/^\s*COLLECTION\s+SERIES\s+COLOR PRICE GROUP/.test(line)) {
      let priceGroup = null;
      let collName = null;
      let seriesName = null;

      // Values are on the next non-empty line (1-4 lines below the header)
      for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
        const nextLine = lines[j].trim();
        if (!nextLine) continue;
        // Stop if we hit column headers or other structure
        if (/^COLOR$/i.test(nextLine) || /^REF$/i.test(nextLine) || /^NOMINAL SIZE/.test(nextLine)) break;

        // Split by large gaps (4+ spaces) or pipe characters to separate columns
        const parts = nextLine.split(/\s{4,}|\|/).map(p => p.trim()).filter(Boolean);

        // Check for GROUP N at the end
        if (parts.length > 0) {
          const last = parts[parts.length - 1];
          if (/^GROUP\s+\d+$/i.test(last)) {
            priceGroup = last.match(/\d+/)[0];
            parts.pop();
          }
        }

        // Deduplicate: if splitting on pipe created duplicate entries, collapse them
        // e.g., "Natural Stone|natural Stone" → ["Natural Stone", "natural Stone"] → just "Natural Stone"
        const uniqueParts = [];
        for (const p of parts) {
          const normalized = p.toLowerCase().replace(/\s+/g, ' ');
          if (!uniqueParts.some(u => u.toLowerCase().replace(/\s+/g, ' ') === normalized)) {
            uniqueParts.push(p);
          }
        }

        if (uniqueParts.length >= 2) {
          collName = titleCase(uniqueParts[0]);
          seriesName = titleCase(uniqueParts[1]);
        } else if (uniqueParts.length === 1) {
          seriesName = titleCase(uniqueParts[0]);
          collName = null;
        }
        break;
      }

      // Build section name: "Collection Series" unless series already contains the collection name
      let productName;
      if (collName && collName !== seriesName && !seriesName?.startsWith(collName)) {
        productName = `${collName} ${seriesName}`;
      } else {
        productName = seriesName || 'Unknown';
      }

      // Check for multi-page continuation of the same section
      if (sectionObj && sectionObj.name === productName &&
          (priceGroup || null) === (sectionObj.priceGroup || null)) {
        // Same section continuing on next page — keep adding to it
      } else {
        // New section
        sectionObj = {
          name: productName,
          series: seriesName,
          collection: collName || seriesName,
          priceGroup: priceGroup || null,
          items: [],
          colorRefTable: []
        };
        sections.push(sectionObj);
      }

      inColorRef = false;
      currentProductType = null;
      colorRefColPositions = [];
      continue;
    }

    if (!sectionObj) continue;

    // ── Product type headings ──
    const matchedType = PRODUCT_TYPES.find(t => trimmed === t);
    if (matchedType) {
      currentProductType = normalizeProductType(matchedType);
      inColorRef = false;
      continue;
    }
    if (mosaicRegex.test(trimmed)) {
      currentProductType = 'mosaic';
      inColorRef = false;
      continue;
    }

    // ── COLOR REF section header ──
    if (/^\s*COLOR\s+REF\b/.test(trimmed) && !inColorRef) {
      inColorRef = true;
      colorRefColPositions = extractColorRefColumnPositions(line);

      // If no column numbers on this line, check the next line
      if (colorRefColPositions.length === 0 && i + 1 < lines.length) {
        const nextLine = lines[i + 1];
        const nums = nextLine.trim().match(/^\d+(\s+\d+)*$/);
        if (nums) {
          colorRefColPositions = extractColorRefColumnPositions(nextLine);
          i++; // skip the number line
        }
      }

      // Default to single column if none found
      if (colorRefColPositions.length === 0) {
        colorRefColPositions = [{ num: 1, charPos: 70 }];
      }
      continue;
    }

    // ── Skip column header lines ──
    if (/^NOMINAL SIZE/.test(trimmed) || /^COLOR$/i.test(trimmed) || /^REF$/i.test(trimmed)) continue;

    // ── Item data rows ──
    if (!inColorRef) {
      const tailMatch = trimmed.match(itemTailRegex);
      if (tailMatch) {
        const colorRef = parseInt(tailMatch[1], 10);
        const price = parseFloat(tailMatch[2].replace(/,/g, ''));
        const unit = tailMatch[3];
        const unitsCtn = tailMatch[4] === '-' ? 0 : parseFloat(tailMatch[4]);

        if (price <= 0 || isNaN(price)) continue;

        // Everything before the matched tail = SIZE + ITEM CODE + DESCRIPTION
        const beforeTail = trimmed.slice(0, trimmed.length - tailMatch[0].length).trim();
        const parts = beforeTail.split(/\s{2,}/).map(p => p.trim()).filter(Boolean);

        let size = '', itemCode = '', description = '';

        if (parts.length >= 3) {
          size = parts[0];
          itemCode = parts[1];
          description = parts.slice(2).join(', ');
        } else if (parts.length === 2) {
          if (looksLikeItemCode(parts[1])) {
            size = parts[0];
            itemCode = parts[1];
          } else if (looksLikeItemCode(parts[0])) {
            itemCode = parts[0];
            description = parts[1];
          } else {
            size = parts[0];
            itemCode = parts[1];
          }
        } else if (parts.length === 1) {
          itemCode = parts[0];
        }

        if (!itemCode) continue;

        sectionObj.items.push({
          size,
          itemCode,
          description,
          colorRef,
          price,
          unit,
          unitsCtn,
          productType: currentProductType
        });
        continue;
      }
    }

    // ── COLOR REF data rows ──
    if (inColorRef) {
      // Pattern: CODE  COLOR_NAME  [P marks at column positions]
      // Code is 2-8 alphanumeric chars at the start, followed by 2+ spaces, then name
      const colorLineMatch = trimmed.match(/^([A-Z0-9]{2,8})\s{2,}(.+)/i);
      if (colorLineMatch) {
        const code = colorLineMatch[1];

        // Extract color name: everything between code and the P-marks region.
        // The P marks appear at the same char positions as the column numbers.
        const fullAfterCode = colorLineMatch[2];
        // Strip trailing P marks to get just the name
        const name = fullAfterCode.replace(/\s+P(\s+P)*\s*$/, '').replace(/\s+P\s*$/, '').trim();

        // Determine which ref columns this color belongs to.
        // Find all P character positions in the original line (after the name region),
        // then assign each P to its nearest column header.
        const refs = [];
        if (colorRefColPositions.length > 0) {
          // Find where the P-mark region starts (roughly after the name ends)
          const firstColPos = colorRefColPositions[0].charPos;
          const pPositions = [];
          for (let pos = Math.max(0, firstColPos - 5); pos < line.length; pos++) {
            if (line[pos] === 'P') pPositions.push(pos);
          }

          // Assign each P to its nearest column
          const assignedCols = new Set();
          for (const pPos of pPositions) {
            let closestCol = null;
            let closestDist = Infinity;
            for (const col of colorRefColPositions) {
              const dist = Math.abs(pPos - col.charPos);
              if (dist < closestDist) {
                closestDist = dist;
                closestCol = col.num;
              }
            }
            // Max distance threshold: half the gap between adjacent columns, or 10
            const maxDist = colorRefColPositions.length >= 2
              ? Math.max(5, Math.ceil((colorRefColPositions[1].charPos - colorRefColPositions[0].charPos) / 2) + 2)
              : 10;
            if (closestCol !== null && closestDist <= maxDist) {
              assignedCols.add(closestCol);
            }
          }
          refs.push(...assignedCols);
        }

        // Fallback: if no refs found, default to column 1
        if (refs.length === 0) refs.push(1);

        sectionObj.colorRefTable.push({ code, name, refs });
      }
      continue;
    }
  }

  return sections;
}

/**
 * Extract column number positions from a COLOR REF header line.
 * e.g., "  COLOR REF   1    2    3    4" → [{num:1, charPos:30}, {num:2, charPos:35}, ...]
 */
function extractColorRefColumnPositions(line) {
  const positions = [];
  // Find where "COLOR REF" ends (or use start of line if not present)
  const crMatch = line.match(/COLOR\s+REF/i);
  const searchStart = crMatch ? crMatch.index + crMatch[0].length : 0;
  const searchPart = line.slice(searchStart);

  const numRegex = /\b(\d+)\b/g;
  let m;
  while ((m = numRegex.exec(searchPart)) !== null) {
    const num = parseInt(m[1], 10);
    // Reasonable column numbers are 1-20
    if (num >= 1 && num <= 20) {
      positions.push({
        num,
        charPos: searchStart + m.index
      });
    }
  }
  return positions;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isNoiseLine(trimmed) {
  return (
    trimmed.startsWith('IMPORTANT NOTICE:') ||
    trimmed.startsWith('Variation in shade') ||
    trimmed.startsWith('company reserves') ||
    trimmed.startsWith('Effective Date:') ||
    trimmed.startsWith('PRICE LIST') ||
    trimmed.startsWith('Table of Contents') ||
    trimmed.startsWith('(Click on the') ||
    /^https?:\/\//.test(trimmed) ||
    /Customer Class:\s*\w+/.test(trimmed) ||
    /^\w+\s*\.{5,}/.test(trimmed) // TOC lines with dots
  );
}

function looksLikeItemCode(s) {
  return /^[A-Z0-9][A-Z0-9\-\/]+$/i.test(s) && s.length >= 4;
}

function normalizeProductType(header) {
  const map = {
    'Floor Tile': 'floor_tile',
    'Floor Tile Trim': 'floor_trim',
    'Floor Tile Deco': 'floor_deco',
    'Wall Tile': 'wall_tile',
    'Wall Tile Trim': 'wall_trim',
    'Wall Tile Deco': 'wall_deco',
    'Wall Bathroom Accessories': 'bath_accessory',
    'Bathroom Accessories': 'bath_accessory',
    'Mosaic Tile Trim': 'mosaic_trim',
    'Mosaic Natural Stone Tile': 'mosaic_stone',
    'Stone Tile': 'stone_tile',
    'Stone Tile Trim': 'stone_trim',
    'Quarry Tile': 'quarry_tile',
    'Quarry Tile Trim': 'quarry_trim',
    'Porcelain Slab': 'porcelain_slab',
    'Quartz Slab': 'quartz_slab',
    'Natural Stone Slab': 'natural_stone_slab',
    'Luxury Vinyl Tile': 'lvt',
    'LVT Trim': 'lvt_trim',
    'LVT Plank': 'lvt_plank',
    'LVT': 'lvt',
  };
  return map[header] || header.toLowerCase().replace(/\s+/g, '_');
}

function titleCase(s) {
  if (!s) return s;
  return s
    .split(/\s+/)
    .map(w => {
      if (w.length <= 2) return w.toUpperCase(); // Keep "II", "IV", "LF", etc.
      return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    })
    .join(' ');
}

// ─── Category Resolution ──────────────────────────────────────────────────────

async function loadCategoryMap(pool) {
  const result = await pool.query('SELECT id, slug FROM categories');
  const map = {};
  for (const row of result.rows) map[row.slug] = row.id;
  return map;
}

const VARIANT_TYPE_TO_CATEGORY = {
  'floor_tile':      'porcelain-tile',
  'floor_trim':      'porcelain-tile',
  'floor_deco':      'porcelain-tile',
  'wall_tile':       'backsplash-tile',
  'wall_trim':       'backsplash-tile',
  'wall_deco':       'backsplash-tile',
  'bath_accessory':  'backsplash-tile',
  'stone_tile':      'natural-stone',
  'stone_trim':      'natural-stone',
  'mosaic':          'mosaic-tile',
  'mosaic_trim':     'mosaic-tile',
  'mosaic_stone':    'mosaic-tile',
  'lvt':             'lvp-plank',
  'lvt_trim':        'lvp-plank',
  'lvt_plank':       'lvp-plank',
  'quarry_tile':     'ceramic-tile',
  'quarry_trim':     'ceramic-tile',
  'quartz_slab':     'quartz-countertops',
  'porcelain_slab':  'porcelain-slabs',
  'windowsills_thresholds': 'natural-stone',
};

function resolveCategory(variantType, collection, catMap) {
  // Special handling for natural_stone_slab — disambiguate by collection name
  if (variantType === 'natural_stone_slab') {
    const cLower = (collection || '').toLowerCase();
    if (cLower.includes('granite'))    return catMap['granite-countertops'] || null;
    if (cLower.includes('quartzite'))  return catMap['quartzite-countertops'] || null;
    if (cLower.includes('soapstone'))  return catMap['soapstone-countertops'] || null;
    if (cLower.includes('marble'))     return catMap['marble-countertops'] || null;
    return catMap['natural-stone'] || null;
  }

  const slug = VARIANT_TYPE_TO_CATEGORY[variantType];
  if (slug && catMap[slug]) return catMap[slug];

  // Fallback: try collection name
  if (collection) {
    const cLower = collection.toLowerCase();
    if (cLower.includes('quartz'))  return catMap['quartz-countertops'] || null;
    if (cLower.includes('granite')) return catMap['granite-countertops'] || null;
    if (cLower.includes('marble'))  return catMap['marble-countertops'] || null;
    if (cLower.includes('stone'))   return catMap['natural-stone'] || null;
    if (cLower.includes('mosaic'))  return catMap['mosaic-tile'] || null;
    if (cLower.includes('vinyl') || cLower.includes('lvt')) return catMap['lvp-plank'] || null;
  }

  return catMap['porcelain-tile'] || null; // default for tile products
}
